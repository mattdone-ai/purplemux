import { isAgentPanelType } from '@/lib/agent-panel-types';
import { isValidRemoteHostName } from '@/lib/remote-host';
import { DEFAULT_POOL_PATH_SLOW_MS, POOL_PATH_SLOW_KEY, pathView } from '@/lib/tailnet-path';
import type { ILease } from '@/types/lease';
import {
  POOL_CLASSES,
  POOL_JOB_KINDS,
  POOL_KINDS,
  type IPoolBudgetView,
  type IPoolEnvelopeView,
  type IPoolHostView,
  type IPoolPin,
  type IPoolPlacementRequest,
  type IPoolQueueEntry,
  type IPoolHostJob,
  type IPoolRoomAnswer,
  type IPoolSlotUse,
  type IPoolTabPlaceView,
  type IPoolTabRoom,
  type IPoolTotals,
  type IPoolWorkspaceTabs,
  type IPoolUse,
  type IPoolView,
  type TPoolClass,
  type TPoolFeature,
  type TPoolHostRead,
  type TPoolKind,
  type TPoolPlacement,
  type TPoolMode,
  type TPoolTabPlaceMode,
  type TPoolRefusalReason,
  type TPoolShadowedRefusal,
  type IPoolWouldRefuse,
  type IPoolWouldRefuseView,
} from '@/types/pool';

// The pool model and its admission (ADR-0039 §2-§3, vel-D4). Pure: the reads,
// the lease state and the fleet values come in, so every rule is table-tested.

const GIB = 1024 ** 3;

/** Measured memory an admission leaves free after its envelope (the read lags; this is the floor under it). */
export const MEASURED_MEM_FLOOR_BYTES = 4 * GIB;
/** The engineering gate refuses new build targets at 85 % (story 11): no job lands on a fuller root. */
export const DISK_REFUSE_PCT = 85;
/** load1 is a one-minute average: work leased within a minute of the read is not in it yet. */
export const LOAD_LAG_MS = 60_000;
export const SLOT_CAP_MAX = 64;

/** Envelopes per kind (vel-D4 design §5): threads kept busy and memory at the peak. */
export const DEFAULT_ENVELOPES: Readonly<Record<TPoolKind, { threads: number; memGb: number }>> = Object.freeze({
  gate: { threads: 8, memGb: 8 },
  build: { threads: 8, memGb: 8 },
  mutation: { threads: 8, memGb: 8 },
  browser: { threads: 2, memGb: 4 },
  'test-service': { threads: 2, memGb: 4 },
  tab: { threads: 2, memGb: 4 },
});
export const DEFAULT_RESERVE_THREADS_PCT = 25;
export const DEFAULT_RESERVE_MEM_PCT = 15;
export const RESERVE_MIN_THREADS = 2;
export const RESERVE_MIN_MEM_GB = 4;
export const DEFAULT_HARNESS_SHARE_PCT = 25;

export const POOL_LEASE_KIND = 'pool';
export const POOL_QUEUE_LEASE_KIND = 'pool-queue';
/** A waiter re-asks within this, or its place is given up (the ticket is a lease with this TTL). */
export const QUEUE_TTL_SECONDS = 120;
export const QUEUE_RETRY_SECONDS = 10;
/** A tab start's lease: from placement until the tab is in its layout (the route releases it after the create). */
export const TAB_START_TTL_SECONDS = 300;

export const POOL_SLOTS_KEY_PREFIX = 'pool.slots.';
export const POOL_GATE_HOST_KEY_PREFIX = 'pool.gate-host.';
export const POOL_BUDGET_KEY_PREFIX = 'pool.budget.';
export const POOL_ENVELOPE_KEY_PREFIX = 'pool.envelope.';
export const POOL_HARNESS_SHARE_KEY = 'pool.harness-share-pct';
/** `shadow` (the default, and the value a stored bad value reads as) or `enforce` (vel-D4 review r1). */
export const POOL_MODE_KEY = 'pool.mode';

/** What this server honours (vel-POOL-ENF); `pool show --json` lists them, and a client checks before it relies on them. */
export const POOL_FEATURES: readonly TPoolFeature[] = Object.freeze(['ask-token', 'host-pin', 'tab-room', 'item']);

/** `pool.tab-place.<workspaceId>` (ADR-0045): what a `tab create` without `--host` does in that workspace. */
export const POOL_TAB_PLACE_KEY_PREFIX = 'pool.tab-place.';
export const POOL_TAB_PLACE_MODES: readonly TPoolTabPlaceMode[] = ['here', 'advise', 'place'];
export const DEFAULT_TAB_PLACE_MODE: TPoolTabPlaceMode = 'advise';
export const TAB_PLACE_KEY = /^pool\.tab-place\.([A-Za-z0-9_-]+)$/;

export const isTabPlaceMode = (value: unknown): value is TPoolTabPlaceMode =>
  typeof value === 'string' && (POOL_TAB_PLACE_MODES as readonly string[]).includes(value);

/** The workspace's plain-create mode; unset, or a hand-edited bad value, reads as `advise`. */
export const tabPlaceModeOf = (config: TConfigValue, workspaceId: string): TPoolTabPlaceMode => {
  const raw = config(`${POOL_TAB_PLACE_KEY_PREFIX}${workspaceId}`)?.trim();
  return isTabPlaceMode(raw) ? raw : DEFAULT_TAB_PLACE_MODE;
};

/** `pool acquire --item` (ADR-0045): the work item a job runs for, as `pool show` names it. */
export const POOL_ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9._:#/@+-]{0,119}$/;

/** A pool-cancel mark (vel-POOL-ENF): it refuses a late acquire with its ask token, and holds no budget. */
export const POOL_CANCEL_LEASE_KIND = 'pool-cancel';
export const POOL_CANCEL_TTL_SECONDS = 600;
export const POOL_MODES: readonly TPoolMode[] = ['shadow', 'enforce'];
export const DEFAULT_POOL_MODE: TPoolMode = 'shadow';

export const isPoolMode = (value: unknown): value is TPoolMode => typeof value === 'string' && (POOL_MODES as readonly string[]).includes(value);

export const poolModeOf = (config: TConfigValue): TPoolMode => {
  const raw = config(POOL_MODE_KEY)?.trim();
  return isPoolMode(raw) ? raw : DEFAULT_POOL_MODE;
};

export const POOL_BUDGET_FIELDS = ['threads', 'mem-gb', 'reserve-threads', 'reserve-mem-gb', 'max-load'] as const;
export type TPoolBudgetField = (typeof POOL_BUDGET_FIELDS)[number];

const KIND_ALT = POOL_KINDS.join('|');

interface INumberRule { re: RegExp; min: number; max: number; integer: boolean; form: string }

/** Every numeric pool key and its range: checked when written, and a stored bad value keeps the default. */
const NUMBER_RULES: readonly INumberRule[] = [
  { re: /^pool\.budget\.[a-z0-9._-]+\.threads$/, min: 1, max: 4096, integer: true, form: 'whole threads 1..4096' },
  { re: /^pool\.budget\.[a-z0-9._-]+\.reserve-threads$/, min: 0, max: 4096, integer: true, form: 'whole threads 0..4096' },
  { re: /^pool\.budget\.[a-z0-9._-]+\.mem-gb$/, min: 1, max: 65536, integer: false, form: 'GiB 1..65536' },
  { re: /^pool\.budget\.[a-z0-9._-]+\.reserve-mem-gb$/, min: 0, max: 65536, integer: false, form: 'GiB 0..65536' },
  { re: /^pool\.budget\.[a-z0-9._-]+\.max-load$/, min: 1, max: 100000, integer: false, form: 'a load 1..100000' },
  { re: new RegExp(`^pool\\.envelope\\.(${KIND_ALT})\\.threads$`), min: 1, max: 4096, integer: true, form: 'whole threads 1..4096' },
  { re: new RegExp(`^pool\\.envelope\\.(${KIND_ALT})\\.mem-gb$`), min: 0, max: 4096, integer: false, form: 'GiB 0..4096' },
  { re: /^pool\.harness-share-pct$/, min: 0, max: 100, integer: true, form: 'a whole percent 0..100' },
  { re: /^pool\.path\.slow-ms$/, min: 1, max: 60000, integer: true, form: 'whole milliseconds 1..60000' },
];

export const isPoolNumberKey = (key: string): boolean => NUMBER_RULES.some((r) => r.re.test(key));

/** The value's refusal for a numeric pool key, or null when it is valid (or the key is not numeric). */
export const poolNumberRefusal = (key: string, value: string): string | null => {
  const rule = NUMBER_RULES.find((r) => r.re.test(key));
  if (!rule) return null;
  const text = value.trim();
  const n = Number(text);
  const shaped = rule.integer ? /^\d{1,6}$/.test(text) : /^\d{1,6}(\.\d{1,2})?$/.test(text);
  return shaped && n >= rule.min && n <= rule.max ? null : `${key} must be ${rule.form}, got ${JSON.stringify(value)}`;
};

export type TConfigValue = (key: string) => string | null;

const configNumber = (config: TConfigValue, key: string): number | null => {
  const raw = config(key);
  if (raw === null || poolNumberRefusal(key, raw) !== null) return null;
  return Number(raw.trim());
};

export const isPoolKind = (value: unknown): value is TPoolKind => typeof value === 'string' && (POOL_KINDS as readonly string[]).includes(value);
export const isPoolClass = (value: unknown): value is TPoolClass => typeof value === 'string' && (POOL_CLASSES as readonly string[]).includes(value);
const isJobKind = (kind: TPoolKind): boolean => (POOL_JOB_KINDS as readonly string[]).includes(kind);

export const poolHostId = (host: string): string => host.toLowerCase();

export const poolLeaseName = (host: string, kind: TPoolKind, n: number): string => `${POOL_LEASE_KIND}:${poolHostId(host)}/${kind}-${n}`;
export const poolQueueName = (kind: TPoolKind, n: number): string => `${POOL_QUEUE_LEASE_KIND}:${kind}-${n}`;
/** The cancel mark of one holder's ask: `key` is a hash of the holder and the token, so the name never carries the token
 * and two holders never share a mark (review r1 of #64). */
export const poolCancelName = (key: string): string => `${POOL_CANCEL_LEASE_KIND}:${key}`;

/** An ask token as logs and messages show it: a short prefix, never the whole token (review r1 of #64). */
export const askLabel = (ask: string): string => `${ask.slice(0, 8)}...`;

/** The gate-host container of a pool host (fleet `pool.gate-host.<host>`), else null: an ssh alias only. */
export const poolGateHostOf = (config: TConfigValue, host: string): string | null => {
  const value = config(`${POOL_GATE_HOST_KEY_PREFIX}${poolHostId(host)}`)?.trim();
  return value && isValidRemoteHostName(value) ? value : null;
};

const LEASE_RE = new RegExp(`^pool:([a-z0-9._-]+)\\/(${KIND_ALT})-([0-9]{1,3})$`);
const QUEUE_RE = new RegExp(`^pool-queue:(${KIND_ALT})-([0-9]{1,3})$`);

export const parsePoolLeaseName = (name: string): { host: string; kind: TPoolKind; n: number } | null => {
  const m = LEASE_RE.exec(name);
  return m ? { host: m[1], kind: m[2] as TPoolKind, n: Number(m[3]) } : null;
};

export const parsePoolQueueName = (name: string): { kind: TPoolKind; n: number } | null => {
  const m = QUEUE_RE.exec(name);
  return m ? { kind: m[1] as TPoolKind, n: Number(m[2]) } : null;
};

export interface IPoolEnvelope {
  threads: number;
  memBytes: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const gbOf = (bytes: number): number => round2(bytes / GIB);
export const envelopeView = (e: IPoolEnvelope): IPoolEnvelopeView => ({ threads: e.threads, memGb: gbOf(e.memBytes) });

/** The kind's envelope: `pool.envelope.<kind>.threads|mem-gb`, else the documented default. */
export const kindEnvelope = (kind: TPoolKind, config: TConfigValue): IPoolEnvelope => {
  const d = DEFAULT_ENVELOPES[kind];
  const threads = configNumber(config, `${POOL_ENVELOPE_KEY_PREFIX}${kind}.threads`) ?? d.threads;
  const memGb = configNumber(config, `${POOL_ENVELOPE_KEY_PREFIX}${kind}.mem-gb`) ?? d.memGb;
  return { threads, memBytes: memGb * GIB };
};

/** A request's `--mem` raises the memory envelope; `--threads` sets the thread envelope. */
export const requestEnvelope = (req: Pick<IPoolPlacementRequest, 'kind' | 'memGb' | 'threads'>, config: TConfigValue): IPoolEnvelope => {
  const base = kindEnvelope(req.kind, config);
  return { threads: req.threads ?? base.threads, memBytes: Math.max(base.memBytes, req.memGb * GIB) };
};

export const noteField = (note: string | null, field: string): string | null =>
  new RegExp(`(?:^|\\s)${field}=([^\\s]+)`).exec(note ?? '')?.[1] ?? null;

const notePositive = (note: string | null, field: string): number | null => {
  const n = Number(noteField(note, field));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** A slot lease's note: what it reserves, so the ledger counts it for its whole life, and the ask token (vel-POOL-ENF). */
export const poolLeaseNote = (envelope: IPoolEnvelope, cls: TPoolClass = 'product', ask: string | null = null, item: string | null = null): string =>
  `pool mem=${gbOf(envelope.memBytes)} threads=${envelope.threads} class=${cls}${ask ? ` ask=${ask}` : ''}${item ? ` item=${item}` : ''}`;

export const memOfLease = (lease: ILease): number => {
  const gb = notePositive(lease.note, 'mem');
  return gb === null ? 0 : gb * GIB;
};

/** A lease note written before vel-D4 (`pool mem=<GB>`) reads as the kind's envelope with that memory floor. */
export const leaseEnvelope = (lease: ILease, kind: TPoolKind, config: TConfigValue): IPoolEnvelope => {
  const base = kindEnvelope(kind, config);
  return { threads: notePositive(lease.note, 'threads') ?? base.threads, memBytes: Math.max(base.memBytes, memOfLease(lease)) };
};

export const leaseClass = (lease: ILease): TPoolClass => {
  const cls = noteField(lease.note, 'class');
  return isPoolClass(cls) ? cls : 'product';
};

/** A ticket's note holds the request, so every waiter's position is computed from the store alone. */
export const poolQueueNote = (req: IPoolPlacementRequest, ask: string | null = null): string => [
  POOL_QUEUE_LEASE_KIND,
  `class=${req.class ?? 'product'}`,
  `mem=${req.memGb}`,
  ...(req.threads !== undefined ? [`threads=${req.threads}`] : []),
  ...(req.panelType ? [`panel=${req.panelType}`] : []),
  ...(req.role ? [`role=${req.role}`] : []),
  ...(req.localOnly ? ['local-only=1'] : []),
  ...(req.pin?.hosts.length ? [`pin-hosts=${req.pin.hosts.join(',')}`] : []),
  ...(req.pin?.local ? ['pin-local=1'] : []),
  ...(req.pin?.gateHosts.length ? [`pin-gate-hosts=${req.pin.gateHosts.join(',')}`] : []),
  ...(ask ? [`ask=${ask}`] : []),
].join(' ');

const listField = (note: string | null, field: string): string[] => noteField(note, field)?.split(',').filter(Boolean) ?? [];

/** The pin a ticket's note holds, or undefined when it held none. */
const notePin = (note: string | null): IPoolPin | undefined => {
  const pin = { hosts: listField(note, 'pin-hosts'), local: noteField(note, 'pin-local') === '1', gateHosts: listField(note, 'pin-gate-hosts') };
  return pin.hosts.length || pin.local || pin.gateHosts.length ? pin : undefined;
};

export interface IPoolTicket {
  name: string;
  kind: TPoolKind;
  n: number;
  req: IPoolPlacementRequest;
  /** The ask token the waiter sent (vel-POOL-ENF), else null. */
  ask: string | null;
  lease: ILease;
}

export const parseTicket = (lease: ILease): IPoolTicket | null => {
  const parsed = parsePoolQueueName(lease.name);
  if (!parsed) return null;
  const cls = noteField(lease.note, 'class');
  const mem = Number(noteField(lease.note, 'mem'));
  const threads = notePositive(lease.note, 'threads');
  const panelType = noteField(lease.note, 'panel');
  const role = noteField(lease.note, 'role');
  const pin = notePin(lease.note);
  const req: IPoolPlacementRequest = {
    kind: parsed.kind,
    memGb: Number.isFinite(mem) && mem >= 0 ? mem : 0,
    class: isPoolClass(cls) ? cls : 'product',
    ...(threads !== null ? { threads } : {}),
    ...(panelType ? { panelType } : {}),
    ...(role ? { role } : {}),
    ...(noteField(lease.note, 'local-only') === '1' ? { localOnly: true } : {}),
    ...(pin ? { pin } : {}),
  };
  return { name: lease.name, kind: parsed.kind, n: parsed.n, req, ask: noteField(lease.note, 'ask'), lease };
};

/** `pool.slots.<host>.<kind>`: an optional count cap on top of the budget (a gate host's container slots, ADR-0039 §6). */
export const slotCountCapOf = (host: string, kind: TPoolKind, config: TConfigValue): number | null => {
  const raw = config(`${POOL_SLOTS_KEY_PREFIX}${poolHostId(host)}.${kind}`)?.trim();
  return raw && /^\d{1,2}$/.test(raw) && Number(raw) <= SLOT_CAP_MAX ? Number(raw) : null;
};

export interface IPoolBudget {
  threads: number;
  memBytes: number;
  reserveThreads: number;
  reserveMemBytes: number;
  workerThreads: number;
  workerMemBytes: number;
  maxLoad: number;
  harnessSharePct: number;
}

export const harnessSharePctOf = (config: TConfigValue): number => configNumber(config, POOL_HARNESS_SHARE_KEY) ?? DEFAULT_HARNESS_SHARE_PCT;

/** `pool.path.slow-ms` (vel-RETRO-R2): a tailnet RTT at or above it is slow. */
export const pathSlowMsOf = (config: TConfigValue): number => configNumber(config, POOL_PATH_SLOW_KEY) ?? DEFAULT_POOL_PATH_SLOW_MS;

/**
 * The host's one budget (vel-D4 §5). Threads and memory come from fleet config, else the read; the reserve
 * defaults to max(2, 25 % of threads) and max(4 GiB, 15 % of memory). An unknown host has no budget, never zero.
 */
export const budgetOf = (read: TPoolHostRead, config: TConfigValue): IPoolBudget | null => {
  if (read.state !== 'known') return null;
  const key = (field: TPoolBudgetField) => `${POOL_BUDGET_KEY_PREFIX}${poolHostId(read.host)}.${field}`;
  const threads = configNumber(config, key('threads')) ?? read.metrics.threads;
  const memGb = configNumber(config, key('mem-gb')) ?? read.metrics.memTotalBytes / GIB;
  const reserveThreads = Math.min(threads, configNumber(config, key('reserve-threads'))
    ?? Math.max(RESERVE_MIN_THREADS, Math.ceil((threads * DEFAULT_RESERVE_THREADS_PCT) / 100)));
  const reserveMemGb = Math.min(memGb, configNumber(config, key('reserve-mem-gb'))
    ?? Math.max(RESERVE_MIN_MEM_GB, Math.ceil((memGb * DEFAULT_RESERVE_MEM_PCT) / 100)));
  return {
    threads,
    memBytes: memGb * GIB,
    reserveThreads,
    reserveMemBytes: reserveMemGb * GIB,
    workerThreads: threads - reserveThreads,
    workerMemBytes: (memGb - reserveMemGb) * GIB,
    maxLoad: configNumber(config, key('max-load')) ?? threads,
    harnessSharePct: harnessSharePctOf(config),
  };
};

const leasesOn = (leases: readonly ILease[], host: string) =>
  leases.flatMap((lease) => {
    const parsed = parsePoolLeaseName(lease.name);
    return parsed && parsed.host === poolHostId(host) ? [{ lease, ...parsed }] : [];
  });

/** Leases a read cannot show yet: taken after, or within a minute before, the read. */
const unseen = <T extends { lease: ILease }>(leases: readonly T[], read: TPoolHostRead): T[] =>
  read.readAt === null ? [...leases] : leases.filter((l) => Date.parse(l.lease.acquiredAt) > read.readAt! - LOAD_LAG_MS);

/** A tab start created on a host at `at` (ms): the read cannot show it for LOAD_LAG_MS (review r1 F6). */
export interface IPoolRecentStart {
  at: number;
  threads: number;
  memBytes: number;
}

/** Agent tabs on a host from the layouts: the workspaces' enabled orchestrator tabs run on the reserve. */
export interface IPoolHostTabs {
  worker: number;
  controlPlane: number;
  /** Tabs this server created recently; they are in the layouts (the ledger) but not yet in the read. */
  recentStarts?: readonly IPoolRecentStart[];
  /** The same tabs per workspace id (ADR-0045); absent in callers that do not count by workspace. */
  byWorkspace?: Readonly<Record<string, IPoolWorkspaceTabs>>;
}

export const NO_TABS: IPoolHostTabs = Object.freeze({ worker: 0, controlPlane: 0 });

const zeroUse = (): IPoolUse => ({ threads: 0, memBytes: 0 });
const addUse = (u: IPoolUse, e: IPoolEnvelope, times = 1): void => {
  u.threads += e.threads * times;
  u.memBytes += e.memBytes * times;
};

export interface IPoolHostState {
  view: IPoolHostView;
  budget: IPoolBudget | null;
  /** Every pool lease on the host by class (job and tab-start leases): the harness share reads it. */
  ledger: Record<TPoolClass, IPoolUse>;
  /** Job-kind leases only by class: a job's budget check (step 3) reads it (ADR-0045). */
  jobLedger: Record<TPoolClass, IPoolUse>;
  /** The coordinator tabs' envelopes, on the reserve. */
  controlPlaneUse: IPoolUse;
  /** Measured free memory after the leases the read cannot show; null when unknown. */
  memFreeBytes: number | null;
  /** min(load1, load5) plus the unseen leases' threads: the sustained-overload figure; null when unknown. */
  sustainedLoad: number | null;
  /** load1 per thread with the unseen leases' threads added (ranking); null when unknown. */
  projectedLoadPerThread: number | null;
  /** min(load1, load5) of the read alone; null when unknown. */
  minLoad: number | null;
  /** Threads of the leases and tab starts the read cannot show yet. */
  pendingThreads: number;
  tabs: IPoolHostTabs;
  usedSlots: Record<TPoolKind, Set<number>>;
  counts: Record<TPoolKind, number>;
  countCaps: Record<TPoolKind, number | null>;
  config: TConfigValue;
}

/** The job leases on the worker budget: what a job's step 3 and the view's `budget.free` both read. */
const jobUse = (s: Pick<IPoolHostState, 'jobLedger'>): IPoolUse => ({
  threads: s.jobLedger.product.threads + s.jobLedger.harness.threads,
  memBytes: s.jobLedger.product.memBytes + s.jobLedger.harness.memBytes,
});

const fitsCount = (free: IPoolUse, e: IPoolEnvelope): number =>
  Math.max(0, Math.min(e.threads > 0 ? Math.floor(free.threads / e.threads) : Infinity, e.memBytes > 0 ? Math.floor(free.memBytes / e.memBytes) : Infinity));

const finiteOr = (n: number, cap: number): number => (Number.isFinite(n) ? n : cap);

const rootDiskPctOf = (metrics: IPoolMetricsLike | null): number | null =>
  metrics?.disks.find((d) => d.path === '/')?.usedPct ?? null;

type IPoolMetricsLike = { disks: readonly { path: string; usedPct: number | null }[] };

interface ITabRoomInput {
  budget: IPoolBudget | null;
  placeable: boolean;
  sustainedLoad: number | null;
  memFreeBytes: number | null;
  used: number;
  countCap: number | null;
}

/**
 * The tab room (ADR-0045): free threads are min(threads - reserve, max-load) less the sustained load, free memory is
 * the measured available memory less the unseen work and the reserve; each holds floor(free / envelope) tabs (the
 * 4 GiB floor stays on top of the memory). The ceiling is `pool.slots.<host>.tab`, else floor(worker memory / tab
 * memory): memory cannot be oversubscribed, threads only slow down. One function serves `fitOn` and the view.
 */
const defaultTabCeiling = (b: IPoolBudget, e: IPoolEnvelope): number =>
  Math.min(SLOT_CAP_MAX, e.memBytes > 0 ? Math.floor(b.workerMemBytes / e.memBytes) : SLOT_CAP_MAX);

const tabRoomOf = (input: ITabRoomInput, e: IPoolEnvelope): IPoolTabRoom | null => {
  const b = input.budget;
  if (!b || !input.placeable || input.sustainedLoad === null || input.memFreeBytes === null) return null;
  const freeThreads = Math.min(b.threads - b.reserveThreads, b.maxLoad) - input.sustainedLoad;
  const freeMemBytes = input.memFreeBytes - b.reserveMemBytes;
  const byThreads = e.threads > 0 ? Math.floor(Math.max(0, freeThreads) / e.threads) : SLOT_CAP_MAX;
  const byMem = e.memBytes > 0 ? Math.floor(Math.max(0, freeMemBytes - MEASURED_MEM_FLOOR_BYTES) / e.memBytes) : SLOT_CAP_MAX;
  const room = Math.min(byThreads, byMem, SLOT_CAP_MAX);
  const ceiling = input.countCap ?? defaultTabCeiling(b, e);
  const limit = Math.min(input.used + room, ceiling);
  const free = Math.max(0, limit - input.used);
  return {
    room,
    used: input.used,
    ceiling,
    ceilingSource: input.countCap === null ? 'default' : 'pool.slots',
    limit,
    free,
    binding: ceiling - input.used < room ? 'ceiling' : byThreads <= byMem ? 'threads' : 'memory',
    freeThreads: round2(freeThreads),
    freeMemBytes,
  };
};

const jobView = (lease: ILease, kind: TPoolKind, config: TConfigValue): Omit<IPoolHostJob, 'ageSeconds'> => ({
  kind: kind as IPoolHostJob['kind'],
  lease: lease.name,
  class: leaseClass(lease),
  holder: { workspaceId: lease.holder.workspaceId, tabId: lease.holder.tabId, tabName: lease.holder.tabName, admin: lease.holder.admin },
  item: noteField(lease.note, 'item'),
  epic: lease.epic,
  acquiredAt: lease.acquiredAt,
  envelope: envelopeView(leaseEnvelope(lease, kind, config)),
});

export const hostState = (read: TPoolHostRead, leases: readonly ILease[], tabs: IPoolHostTabs, config: TConfigValue): IPoolHostState => {
  const mine = leasesOn(leases, read.host);
  const usedSlots = Object.fromEntries(POOL_KINDS.map((k) => [k, new Set<number>()])) as Record<TPoolKind, Set<number>>;
  const ledger: Record<TPoolClass, IPoolUse> = { product: zeroUse(), harness: zeroUse(), 'control-plane': zeroUse() };
  const jobLedger: Record<TPoolClass, IPoolUse> = { product: zeroUse(), harness: zeroUse(), 'control-plane': zeroUse() };
  for (const l of mine) {
    usedSlots[l.kind].add(l.n);
    const e = leaseEnvelope(l.lease, l.kind, config);
    addUse(ledger[leaseClass(l.lease)], e);
    if (isJobKind(l.kind)) addUse(jobLedger[leaseClass(l.lease)], e);
  }
  const tabEnvelope = kindEnvelope('tab', config);
  const controlPlaneUse = zeroUse();
  addUse(controlPlaneUse, tabEnvelope, tabs.controlPlane);
  const budget = budgetOf(read, config);
  const known = read.state === 'known' ? read.metrics : null;
  // A host whose own alias failed is shown through its fallback but takes nothing new (review r2 F2):
  // the remote tabs and gates it would get are driven through that alias.
  const fallbackOnly = read.state === 'known' && read.primaryFailure !== undefined
    ? `answers only through ${read.via}; ${read.host} failed (${read.primaryFailure})`
    : null;
  const placeable = read.state === 'known' && fallbackOnly === null;
  const pending = unseen(mine, read);
  const starts = (tabs.recentStarts ?? []).filter((t) => read.readAt === null || t.at > read.readAt - LOAD_LAG_MS);
  const pendingThreads = pending.reduce((sum, l) => sum + leaseEnvelope(l.lease, l.kind, config).threads, 0) + starts.reduce((sum, t) => sum + t.threads, 0);
  const pendingMem = pending.reduce((sum, l) => sum + leaseEnvelope(l.lease, l.kind, config).memBytes, 0) + starts.reduce((sum, t) => sum + t.memBytes, 0);
  // Coordinator tabs run on the reserve: the tab count (and its ceiling) holds worker tabs and live start leases (ADR-0045).
  const counts = Object.fromEntries(POOL_KINDS.map((k) => [k, usedSlots[k].size + (k === 'tab' ? tabs.worker : 0)])) as Record<TPoolKind, number>;
  const countCaps = Object.fromEntries(POOL_KINDS.map((k) => [k, slotCountCapOf(read.host, k, config)])) as Record<TPoolKind, number | null>;
  const memFreeBytes = known ? known.memAvailableBytes - pendingMem : null;
  const sustainedLoad = known ? Math.min(known.load1, known.load5) + pendingThreads : null;
  const tabRoom = tabRoomOf({ budget, placeable, sustainedLoad, memFreeBytes, used: counts.tab, countCap: countCaps.tab }, tabEnvelope);
  const used = jobUse({ jobLedger });
  const free: IPoolUse = budget
    ? { threads: Math.max(0, budget.workerThreads - used.threads), memBytes: Math.max(0, budget.workerMemBytes - used.memBytes) }
    : zeroUse();
  const slots = Object.fromEntries(POOL_KINDS.map((kind) => {
    if (kind === 'tab') {
      // A host that cannot take a tab now still shows its ceiling (totals count it in cap, never in free).
      const cap = tabRoom?.ceiling ?? countCaps.tab ?? (budget ? defaultTabCeiling(budget, tabEnvelope) : 0);
      return [kind, { used: counts.tab, cap, free: tabRoom?.free ?? 0 }];
    }
    const e = kindEnvelope(kind, config);
    const countCap = countCaps[kind];
    const budgetCap = budget ? finiteOr(fitsCount({ threads: budget.workerThreads, memBytes: budget.workerMemBytes }, e), SLOT_CAP_MAX) : 0;
    const cap = countCap ?? budgetCap;
    const freeNow = budget ? Math.min(finiteOr(fitsCount(free, e), SLOT_CAP_MAX), countCap === null ? Infinity : Math.max(0, countCap - counts[kind])) : 0;
    return [kind, { used: counts[kind], cap, free: freeNow }];
  })) as Record<TPoolKind, IPoolSlotUse>;
  const budgetView: IPoolBudgetView | null = budget ? {
    threads: budget.threads,
    memBytes: budget.memBytes,
    reserveThreads: budget.reserveThreads,
    reserveMemBytes: budget.reserveMemBytes,
    workerThreads: budget.workerThreads,
    workerMemBytes: budget.workerMemBytes,
    maxLoad: budget.maxLoad,
    harnessSharePct: budget.harnessSharePct,
    used: { product: { ...jobLedger.product }, harness: { ...jobLedger.harness }, 'control-plane': { ...controlPlaneUse } },
    free,
  } : null;
  const jobs = mine
    .filter((l) => isJobKind(l.kind))
    .sort((a, b) => Date.parse(a.lease.acquiredAt) - Date.parse(b.lease.acquiredAt) || a.lease.name.localeCompare(b.lease.name))
    .map((l) => ({ ...jobView(l.lease, l.kind, config), ageSeconds: 0 }));
  return {
    view: {
      host: read.host,
      local: read.local,
      state: read.state,
      readAt: read.readAt === null ? null : new Date(read.readAt).toISOString(),
      via: read.via,
      reason: read.state === 'unknown' ? read.reason : fallbackOnly,
      placeable,
      metrics: known,
      loadPerThread: known ? Math.round((known.load1 / known.threads) * 1000) / 1000 : null,
      slots,
      agentTabs: tabs.worker + tabs.controlPlane,
      tabsByWorkspace: Object.fromEntries(Object.entries(tabs.byWorkspace ?? {}).map(([ws, t]) => [ws, { ...t }])),
      jobs,
      tabRoom,
      memFreeBytes,
      diskRootUsedPct: rootDiskPctOf(known),
      readAgeSeconds: null,
      budget: budgetView,
      path: read.path ? pathView(read.path, pathSlowMsOf(config)) : null,
    },
    budget,
    ledger,
    jobLedger,
    controlPlaneUse,
    memFreeBytes,
    sustainedLoad,
    projectedLoadPerThread: known ? (known.load1 + pendingThreads) / known.threads : null,
    minLoad: known ? Math.min(known.load1, known.load5) : null,
    pendingThreads,
    tabs,
    usedSlots,
    counts,
    countCaps,
    config,
  };
};

const emptySlots = (): Record<TPoolKind, IPoolSlotUse> =>
  Object.fromEntries(POOL_KINDS.map((k) => [k, { used: 0, cap: 0, free: 0 }])) as Record<TPoolKind, IPoolSlotUse>;

export const poolTotals = (hosts: readonly IPoolHostView[]): IPoolTotals => {
  const totals: IPoolTotals = { threads: 0, memTotalBytes: 0, memAvailableBytes: 0, slots: emptySlots(), knownHosts: 0, unknownHosts: 0 };
  for (const h of hosts) {
    if (!h.metrics) {
      totals.unknownHosts += 1;
      continue;
    }
    totals.knownHosts += 1;
    totals.threads += h.metrics.threads;
    totals.memTotalBytes += h.metrics.memTotalBytes;
    totals.memAvailableBytes += h.metrics.memAvailableBytes;
    for (const kind of POOL_KINDS) {
      totals.slots[kind].used += h.slots[kind].used;
      totals.slots[kind].cap += h.slots[kind].cap;
      if (h.placeable) totals.slots[kind].free += h.slots[kind].free;
    }
  }
  return totals;
};

const fmtGb = (bytes: number): string => `${(Math.round((bytes / GIB) * 10) / 10).toFixed(1)} GiB`;

/**
 * Where a tab may run (consult ruling, story 17): a remote host only for a
 * claude-code tab with no role. codex-cli and grok-cli cannot run remote
 * (ADR-0022 §13), and a coordinator is never a remote tab (§20).
 */
export const tabLocalOnly = (req: IPoolPlacementRequest): string | null => {
  if (req.kind !== 'tab') return null;
  if (req.class === 'control-plane') return 'control-plane: a coordinator runs on this host\'s reserve';
  if (req.localOnly) return 'local-only: the --cwd is missing on the host the pool chose first';
  if (req.role) return `role-local-only: a ${req.role} tab runs on this host`;
  const type = req.panelType ?? 'claude-code';
  return type === 'claude-code' ? null : `type-local-only: a ${type} tab runs on this host (ADR-0022 §13)`;
};

/** The hosts a pin names (vel-POOL-ENF), placeable or not: by name, the server's own host, or by gate-host container. */
const pinnedHosts = (states: readonly IPoolHostState[], pin: IPoolPin): IPoolHostState[] =>
  states.filter((s) => pin.hosts.includes(poolHostId(s.view.host)) || (pin.local && s.view.local)
    || pin.gateHosts.includes(poolGateHostOf(s.config, s.view.host) ?? ''));

/** The hosts a request may run on, placeable or not: this host for a local-only tab, else every host; within its pin. */
const allowedHosts = (states: readonly IPoolHostState[], req: IPoolPlacementRequest): IPoolHostState[] => {
  const hosts = tabLocalOnly(req) ? states.filter((s) => s.view.local) : [...states];
  if (!req.pin) return hosts;
  const pinned = new Set(pinnedHosts(states, req.pin));
  return hosts.filter((s) => pinned.has(s));
};

const pinText = (pin: IPoolPin): string =>
  `hosts ${pin.hosts.join(',') || 'none'}; local ${pin.local ? 'yes' : 'no'}; gate hosts ${pin.gateHosts.join(',') || 'none'}`;

/** A pin that allows no host this request may use (vel-POOL-ENF): a configuration refusal, never queued. */
const noPinnedHost = (states: readonly IPoolHostState[], req: IPoolPlacementRequest & { pin: IPoolPin }, why: string | null): TPoolPlacement => {
  const hosts = states.map((s) => (req.pin.gateHosts.length ? `${s.view.host} (gate host ${poolGateHostOf(s.config, s.view.host) ?? 'none'})` : s.view.host));
  return {
    ok: false, refusal: 'no-pinned-host', queueable: false,
    reason: `no pool host matches the pin (${pinText(req.pin)})${why ? ` that a ${req.kind} may use (${why})` : ''}: the pool hosts are ${hosts.join(', ') || 'none'}`,
  };
};

const harnessFits = (s: IPoolHostState, e: IPoolEnvelope): boolean => {
  if (!s.budget) return false;
  const share = s.budget.harnessSharePct / 100;
  return s.ledger.harness.threads + e.threads <= share * s.budget.workerThreads
    && s.ledger.harness.memBytes + e.memBytes <= share * s.budget.workerMemBytes;
};

/** Order rank: product, and harness work still under its share on an allowed placeable host, come first. */
const rankOf = (states: readonly IPoolHostState[], req: IPoolPlacementRequest, config: TConfigValue): number => {
  if ((req.class ?? 'product') !== 'harness') return 0;
  const e = requestEnvelope(req, config);
  return allowedHosts(states, req).some((s) => s.view.placeable && harnessFits(s, e)) ? 0 : 1;
};

/** The queue in admission order: rank, then arrival, then the ticket number (two tickets of one millisecond). */
export const orderQueue = (tickets: readonly IPoolTicket[], states: readonly IPoolHostState[], config: TConfigValue): IPoolTicket[] =>
  tickets
    .map((t) => ({ t, rank: rankOf(states, t.req, config), at: Date.parse(t.lease.acquiredAt) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at || a.t.n - b.t.n || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t);

interface ICheck {
  refusal: TPoolRefusalReason;
  step: number;
  detail: string;
}

/** `shadowed`: the checks enforce mode would refuse on, which shadow mode admits and logs. */
type TFit = { ok: true; shadowed: ICheck[] } | ({ ok: false } & ICheck);

const refuse = (refusal: TPoolRefusalReason, step: number, detail: string): TFit => ({ ok: false, refusal, step, detail });

const rootDiskPct = (s: IPoolHostState): number | null => rootDiskPctOf(s.view.metrics);

/** The tab room of a host for one request's envelope (ADR-0045): the same function the view shows. */
const tabRoomFor = (s: IPoolHostState, e: IPoolEnvelope): IPoolTabRoom | null =>
  tabRoomOf({ budget: s.budget, placeable: s.view.placeable, sustainedLoad: s.sustainedLoad, memFreeBytes: s.memFreeBytes, used: s.counts.tab, countCap: s.countCaps.tab }, e);

/**
 * The admission checks on one host, in order (vel-D4 §2). For a job the ledger check compares envelopes with the
 * budget, counting job leases only, and never reads measured use; the measured checks subtract only what the read
 * cannot show yet. A worker tab is admitted by its tab room instead (ADR-0045): the measured free threads and memory
 * after the reserve, under the ceiling. A refusal states the measured figure against the expected one. In shadow mode
 * the budget, measured-memory, sustained-load, tab-room and default-ceiling checks do not refuse: they are returned as
 * `shadowed`, and every other check, an explicit `pool.slots` cap included, still refuses.
 */
const harnessShareCheck = (s: IPoolHostState, req: IPoolPlacementRequest, e: IPoolEnvelope): TFit | null => {
  if ((req.class ?? 'product') !== 'harness' || harnessFits(s, e)) return null;
  const b = s.budget!;
  const share = b.harnessSharePct / 100;
  return refuse('harness-share', 4, `${s.view.host}: harness holds threads ${s.ledger.harness.threads}/${Math.floor(share * b.workerThreads)} and ${fmtGb(s.ledger.harness.memBytes)}/${fmtGb(share * b.workerMemBytes)} (${b.harnessSharePct}% share), needs ${e.threads} threads and ${fmtGb(e.memBytes)}`);
};

const roomText = (host: string, r: IPoolTabRoom, b: IPoolBudget, e: IPoolEnvelope): string =>
  `${host}: tab room ${r.room}: free threads ${r.freeThreads} of min(${b.threads} - ${b.reserveThreads} reserve, max load ${b.maxLoad}), `
  + `free memory ${fmtGb(r.freeMemBytes)} after the ${fmtGb(b.reserveMemBytes)} reserve; a tab needs ${e.threads} threads and ${fmtGb(e.memBytes)} + ${fmtGb(MEASURED_MEM_FLOOR_BYTES)} floor`;

/** A worker tab (ADR-0045): the explicit cap refuses; the measured room and the default ceiling are soft in shadow mode. */
const fitTab = (
  s: IPoolHostState, req: IPoolPlacementRequest, e: IPoolEnvelope, blockedBy: number,
  soft: (check: ICheck) => TFit | null, shadowed: ICheck[],
): TFit => {
  const host = s.view.host;
  const b = s.budget!;
  const r = tabRoomFor(s, e);
  if (!r) return refuse('no-known-host', 0, `${host}: ${s.view.reason ?? 'not read'}`);
  if (r.room < 1) {
    const out = soft({ refusal: 'no-room', step: 3, detail: roomText(host, r, b, e) });
    if (out) return out;
  }
  if (r.ceilingSource === 'default' && r.used >= r.ceiling) {
    const out = soft({ refusal: 'tab-ceiling', step: 3, detail: `${host}: tab ${r.used}/${r.ceiling} (default ceiling: worker memory ${fmtGb(b.workerMemBytes)} / ${fmtGb(e.memBytes)})` });
    if (out) return out;
  }
  const share = harnessShareCheck(s, req, e);
  if (share) return share;
  if (blockedBy > 0) return refuse('queued-ahead', 7, `${host}: ${blockedBy} earlier ticket(s) wait for it`);
  return { ok: true, shadowed };
};

const fitOn = (s: IPoolHostState, req: IPoolPlacementRequest, e: IPoolEnvelope, blockedBy: number, mode: TPoolMode): TFit => {
  const host = s.view.host;
  if (!s.view.placeable || !s.budget) return refuse('no-known-host', 0, `${host}: ${s.view.reason ?? 'not read'}`);
  if (isJobKind(req.kind)) {
    const pct = rootDiskPct(s);
    // A root that was not read is not room: absence is never read as an empty disk.
    if ((pct ?? DISK_REFUSE_PCT) >= DISK_REFUSE_PCT) return refuse('disk-full', 1, `${host}: / ${pct === null ? 'not read' : `${pct}%`}, needs under ${DISK_REFUSE_PCT}%`);
  }
  const cap = s.countCaps[req.kind];
  if (cap !== null && s.counts[req.kind] >= cap) return refuse('no-free-slot', 2, `${host}: ${req.kind} ${s.counts[req.kind]}/${cap} (pool.slots)`);
  const used = jobUse(s);
  const b = s.budget;
  const shadowed: ICheck[] = [];
  const soft = (check: ICheck): TFit | null => {
    if (mode === 'enforce') return { ok: false, ...check };
    shadowed.push(check);
    return null;
  };
  if (req.kind === 'tab') return fitTab(s, req, e, blockedBy, soft, shadowed);
  if (used.threads + e.threads > b.workerThreads || used.memBytes + e.memBytes > b.workerMemBytes) {
    const r = soft({ refusal: 'no-budget', step: 3, detail: `${host}: budget threads ${used.threads}/${b.workerThreads} used, needs ${e.threads}; budget memory ${fmtGb(used.memBytes)}/${fmtGb(b.workerMemBytes)} used, needs ${fmtGb(e.memBytes)}` });
    if (r) return r;
  }
  const share = harnessShareCheck(s, req, e);
  if (share) return share;
  const memFree = s.memFreeBytes ?? 0;
  if (memFree - e.memBytes < MEASURED_MEM_FLOOR_BYTES) {
    const r = soft({ refusal: 'no-memory', step: 5, detail: `${host}: measured ${fmtGb(memFree)} free, needs ${fmtGb(e.memBytes + MEASURED_MEM_FLOOR_BYTES)} (${fmtGb(e.memBytes)} envelope + ${fmtGb(MEASURED_MEM_FLOOR_BYTES)} floor)` });
    if (r) return r;
  }
  const load = s.sustainedLoad ?? Infinity;
  if (load + e.threads > b.maxLoad) {
    const r = soft({ refusal: 'overloaded', step: 6, detail: `${host}: sustained load ${round2(load)} + ${e.threads} threads > max load ${b.maxLoad}` });
    if (r) return r;
  }
  if (blockedBy > 0) return refuse('queued-ahead', 7, `${host}: ${blockedBy} earlier ticket(s) wait for it`);
  return { ok: true, shadowed };
};

const byMem = (a: IPoolHostState, b: IPoolHostState) => (b.memFreeBytes ?? 0) - (a.memFreeBytes ?? 0);
const byLoad = (a: IPoolHostState, b: IPoolHostState) => (a.projectedLoadPerThread ?? Infinity) - (b.projectedLoadPerThread ?? Infinity);
const localFirst = (a: IPoolHostState, b: IPoolHostState) => Number(b.view.local) - Number(a.view.local);
const remoteFirst = (a: IPoolHostState, b: IPoolHostState) => Number(a.view.local) - Number(b.view.local);

export interface IPlaceContext {
  /** Waiting tickets (any order; they are ordered here). */
  queue?: readonly IPoolTicket[];
  /** The ticket this request is, when it re-asks. */
  self?: string;
}

/** Tickets ahead of the request: before it in order; a new request comes after every ticket of its rank or better. */
const ticketsAhead = (states: readonly IPoolHostState[], req: IPoolPlacementRequest, config: TConfigValue, ctx: IPlaceContext): IPoolTicket[] => {
  const ordered = orderQueue(ctx.queue ?? [], states, config);
  if (ctx.self) {
    const i = ordered.findIndex((t) => t.name === ctx.self);
    return i === -1 ? ordered : ordered.slice(0, i);
  }
  const rank = rankOf(states, req, config);
  return ordered.filter((t) => rankOf(states, t.req, config) <= rank);
};

/**
 * A ticket holds a host back only if it could ever run there: the host is allowed for it and its envelope fits the
 * host's worker budget (and the harness share for a harness ticket). Capacity cannot accumulate on a host for a
 * ticket larger than the host (review r1 F5).
 */
const ticketCouldRunOn = (states: readonly IPoolHostState[], t: IPoolTicket, s: IPoolHostState, config: TConfigValue): boolean => {
  if (!allowedHosts(states, t.req).some((h) => h.view.host === s.view.host) || !s.budget) return false;
  const e = requestEnvelope(t.req, config);
  const share = (t.req.class ?? 'product') === 'harness' ? s.budget.harnessSharePct / 100 : 1;
  return e.threads <= share * s.budget.workerThreads && e.memBytes <= share * s.budget.workerMemBytes;
};

const controlPlaneTab = (states: readonly IPoolHostState[], e: IPoolEnvelope): TPoolPlacement => {
  const local = states.find((s) => s.view.local);
  const host = local?.view.host ?? '';
  const b = local?.budget;
  if (!local || !b) return { ok: true, host, local: true, envelope: envelopeView(e), reason: 'control-plane: on this host\'s reserve (this host is not read; a coordinator is never queued)' };
  const u = local.controlPlaneUse;
  const over = u.threads + e.threads > b.reserveThreads || u.memBytes + e.memBytes > b.reserveMemBytes;
  return {
    ok: true, host, local: true, envelope: envelopeView(e),
    reason: `control-plane reserve on ${host}: threads ${u.threads + e.threads}/${b.reserveThreads}, memory ${fmtGb(u.memBytes + e.memBytes)}/${fmtGb(b.reserveMemBytes)}`
      + (over ? ' — over the reserve; a coordinator is never queued or refused' : ''),
  };
};

const wouldRefuseOf = (s: IPoolHostState, req: IPoolPlacementRequest, e: IPoolEnvelope, checks: readonly ICheck[]): IPoolWouldRefuse => ({
  host: s.view.host,
  kind: req.kind,
  class: req.class ?? 'product',
  refusals: checks.map((c) => c.refusal as TPoolShadowedRefusal),
  minLoad: s.minLoad ?? 0,
  pendingThreads: s.pendingThreads,
  envelope: envelopeView(e),
  maxLoad: s.budget!.maxLoad,
  memFreeBytes: s.memFreeBytes ?? 0,
  workerUsed: jobUse(s),
  workerThreads: s.budget!.workerThreads,
  workerMemBytes: s.budget!.workerMemBytes,
  agentTabs: { worker: s.tabs.worker, controlPlane: s.tabs.controlPlane },
  detail: checks.map((c) => c.detail).join('; '),
});

/**
 * The one log line of a shadow admission (review r1 F1, F2, F7): key=value fields, so `max-load` can be tuned from
 * the log. `min_load + pending_threads + envelope_threads` is the figure the overload check compared with `max_load`.
 */
export const wouldRefuseLine = (w: IPoolWouldRefuse): string => [
  'pool would-refuse (shadow, admitted):',
  `host=${w.host}`, `kind=${w.kind}`, `class=${w.class}`, `refusals=${w.refusals.join(',')}`,
  `min_load=${round2(w.minLoad)}`, `pending_threads=${w.pendingThreads}`, `envelope_threads=${w.envelope.threads}`,
  `envelope_mem_gib=${w.envelope.memGb}`, `max_load=${w.maxLoad}`, `mem_free_gib=${gbOf(w.memFreeBytes)}`,
  `mem_floor_gib=${gbOf(MEASURED_MEM_FLOOR_BYTES)}`, `worker_threads=${w.workerUsed.threads}/${w.workerThreads}`,
  `worker_mem_gib=${gbOf(w.workerUsed.memBytes)}/${gbOf(w.workerMemBytes)}`,
  `agent_tabs=worker:${w.agentTabs.worker},control-plane:${w.agentTabs.controlPlane}`,
  `| ${w.detail}`,
].join(' ');

/**
 * One admission (vel-D4). A control-plane tab runs here on the reserve. A non-agent tab has no envelope and runs
 * here. Every other request goes to an allowed host that passes every check in `fitOn` and that no earlier ticket
 * that could run there waits for: jobs by the lowest projected load per thread, then the most free memory, a tie
 * keeping this host; tabs by the most tab room, then the most free memory, a tie going to a remote host (ADR-0045). In shadow mode (`pool.mode`, the default) a host that only fails
 * the budget, measured-memory or sustained-load checks still takes the work when no host passes every check, and
 * the answer carries `wouldRefuse`. No fit is a refusal that names, per host, the measured and expected figures;
 * it is queueable unless the envelope can never fit an allowed host.
 */
export const placeWork = (states: readonly IPoolHostState[], req: IPoolPlacementRequest, ctx: IPlaceContext = {}): TPoolPlacement => {
  const config: TConfigValue = states[0]?.config ?? (() => null);
  // The pin is judged first, for every kind and class: a non-agent tab and a control-plane tab run on this host, so a
  // pin that does not allow this host refuses them too (review r1 of #64).
  const why = tabLocalOnly(req);
  const allowed = allowedHosts(states, req);
  if (req.pin && allowed.length === 0) {
    return noPinnedHost(states, { ...req, pin: req.pin }, pinnedHosts(states, req.pin).length > 0 ? why : null);
  }
  if (req.kind === 'tab' && !isAgentPanelType(req.panelType ?? 'claude-code')) {
    const local = states.find((s) => s.view.local);
    return { ok: true, host: local?.view.host ?? '', local: true, envelope: null, reason: `not an agent tab: a ${req.panelType} tab has no envelope and runs on this host` };
  }
  const e = requestEnvelope(req, config);
  if (req.kind === 'tab' && req.class === 'control-plane') return controlPlaneTab(states, e);
  const mode = poolModeOf(config);
  const known = allowed.filter((s) => s.budget);
  const tooLarge = known.length > 0 && known.every((s) => {
    const b = s.budget!;
    const share = (req.class ?? 'product') === 'harness' ? b.harnessSharePct / 100 : 1;
    return e.threads > share * b.workerThreads || e.memBytes > share * b.workerMemBytes;
  });
  if (tooLarge) {
    return {
      ok: false, refusal: 'too-large', queueable: false,
      reason: `the ${req.kind} envelope (${e.threads} threads, ${fmtGb(e.memBytes)}) is larger than the worker budget of every allowed host: ${known.map((s) => `${s.view.host} ${s.budget!.workerThreads} threads, ${fmtGb(s.budget!.workerMemBytes)}`).join('; ')}`,
    };
  }
  const ahead = ticketsAhead(states, req, config, ctx);
  const blockedBy = (s: IPoolHostState) => ahead.filter((t) => ticketCouldRunOn(states, t, s, config)).length;
  const fits = allowed.map((s) => ({ s, fit: fitOn(s, req, e, blockedBy(s), mode) }));
  const passed = fits.flatMap((f) => (f.fit.ok ? [{ s: f.s, shadowed: f.fit.shadowed }] : []));
  const clean = passed.filter((p) => p.shadowed.length === 0);
  const pool = clean.length > 0 ? clean : passed;
  if (pool.length > 0) {
    const roomOf = (s: IPoolHostState) => tabRoomFor(s, e)?.free ?? 0;
    const order = req.kind === 'tab'
      ? (a: IPoolHostState, b: IPoolHostState) => roomOf(b) - roomOf(a) || byMem(a, b) || remoteFirst(a, b)
      : (a: IPoolHostState, b: IPoolHostState) => byLoad(a, b) || byMem(a, b) || localFirst(a, b);
    const chosen = [...pool].sort((a, b) => order(a.s, b.s))[0];
    const best = chosen.s;
    const b = best.budget!;
    const used = jobUse(best);
    const room = req.kind === 'tab' ? tabRoomFor(best, e) : null;
    const tail = room
      ? `most tab room: ${room.free} more (${room.used}/${room.limit}, ${room.binding}), ${fmtGb(best.memFreeBytes ?? 0)} measured free`
      : `lowest load per thread: ${(best.projectedLoadPerThread ?? 0).toFixed(2)} (projected), ${fmtGb(best.memFreeBytes ?? 0)} free; `
        + `budget threads ${used.threads + e.threads}/${b.workerThreads}, memory ${fmtGb(used.memBytes + e.memBytes)}/${fmtGb(b.workerMemBytes)}`;
    const shadow = chosen.shadowed.length > 0 ? wouldRefuseOf(best, req, e, chosen.shadowed) : null;
    return {
      ok: true, host: best.view.host, local: best.view.local, envelope: envelopeView(e),
      reason: `${tail}${why ? ` (${why})` : ''}`
        + (shadow ? `; shadow mode admitted what enforce would refuse (${shadow.refusals.join(', ')}): ${shadow.detail}` : ''),
      ...(shadow ? { wouldRefuse: shadow } : {}),
    };
  }
  const refusals = fits.map((f) => f.fit).filter((f): f is Extract<TFit, { ok: false }> => !f.ok);
  const furthest = refusals.reduce((a, b) => (b.step > a.step ? b : a), refusals[0] ?? { ok: false as const, refusal: 'no-known-host' as const, step: 0, detail: 'no host' });
  const detail = refusals.length ? refusals.map((r) => r.detail).join('; ') : 'no host is in the pool';
  return {
    ok: false, refusal: furthest.refusal, queueable: true,
    reason: `no host can take the ${req.kind} (${e.threads} threads, ${fmtGb(e.memBytes)}${why ? `; ${why}` : ''}): ${detail}`,
  };
};

/** The lowest slot number on the host for the kind (1-based) that no lease holds. */
export const freeSlotNumber = (state: IPoolHostState, kind: TPoolKind): number => {
  let n = 1;
  while (state.usedSlots[kind].has(n)) n += 1;
  return n;
};

export const freeTicketNumber = (tickets: readonly IPoolTicket[], kind: TPoolKind): number => {
  const used = new Set(tickets.filter((t) => t.kind === kind).map((t) => t.n));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
};

const holderText = (lease: ILease): string =>
  lease.holder.admin ? 'admin' : `${lease.holder.workspaceId ?? '?'}/${lease.holder.tabId ?? 'no-tab'}`;

export const queueView = (tickets: readonly IPoolTicket[], states: readonly IPoolHostState[]): IPoolQueueEntry[] => {
  const config: TConfigValue = states[0]?.config ?? (() => null);
  return orderQueue(tickets, states, config).map((t, i) => ({
    ticket: t.name,
    kind: t.kind,
    class: t.req.class ?? 'product',
    position: i + 1,
    envelope: envelopeView(requestEnvelope(t.req, config)),
    hosts: allowedHosts(states, t.req).filter((s) => s.view.placeable).map((s) => s.view.host),
    holder: holderText(t.lease),
    queuedAt: t.lease.acquiredAt,
    expiresAt: t.lease.expiresAt,
  }));
};

/** No would-refuse yet, in the mode the fleet config holds. */
export const emptyWouldRefuse = (mode: TPoolMode, since: number): IPoolWouldRefuseView => ({ mode, total: 0, since: new Date(since).toISOString(), byHost: {}, last: null });

/** The "where is room" answer for one request: a host only when it passes every check cleanly (ADR-0045). */
export const poolRoomAnswer = (states: readonly IPoolHostState[], req: IPoolPlacementRequest, tickets: readonly IPoolTicket[]): IPoolRoomAnswer => {
  const placed = placeWork(states, req, { queue: tickets });
  if (!placed.ok) return { host: null, local: false, reason: placed.reason };
  if (placed.wouldRefuse) return { host: null, local: false, reason: `no host passes every check; shadow mode would admit ${placed.host}: ${placed.wouldRefuse.detail}` };
  const free = req.kind === 'tab' ? states.find((s) => s.view.host === placed.host)?.view.tabRoom?.free : undefined;
  return { host: placed.host, local: placed.local, ...(free !== undefined ? { free } : {}), reason: placed.reason };
};

export const ROOM_TAB_REQUEST: IPoolPlacementRequest = Object.freeze({ kind: 'tab', memGb: 0, panelType: 'claude-code' });
export const ROOM_GATE_REQUEST: IPoolPlacementRequest = Object.freeze({ kind: 'gate', memGb: 0 });

export const emptyTabPlace = (): IPoolTabPlaceView => ({ advised: 0, placedRemote: 0, here: 0, hereAtNoRoom: 0, last: null });

const ageOf = (iso: string | null, now: number): number | null => {
  const at = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
};

export const buildPoolView = (
  states: readonly IPoolHostState[],
  now: number,
  tickets: readonly IPoolTicket[] = [],
  wouldRefuse: IPoolWouldRefuseView = emptyWouldRefuse(poolModeOf(states[0]?.config ?? (() => null)), now),
  tabPlace: IPoolTabPlaceView = emptyTabPlace(),
): IPoolView => {
  const hosts = states.map((s) => ({
    ...s.view,
    readAgeSeconds: ageOf(s.view.readAt, now),
    jobs: s.view.jobs.map((j) => ({ ...j, ageSeconds: ageOf(j.acquiredAt, now) ?? 0 })),
  }));
  return {
    at: new Date(now).toISOString(),
    hosts,
    totals: poolTotals(hosts),
    queue: queueView(tickets, states),
    wouldRefuse,
    room: { tab: poolRoomAnswer(states, ROOM_TAB_REQUEST, tickets), gate: poolRoomAnswer(states, ROOM_GATE_REQUEST, tickets) },
    tabPlace,
    features: POOL_FEATURES,
  };
};

export const OTHER_WORKSPACES = 'other';

/**
 * The view as one caller may see it (ADR-0045, ruling 13): the tabs of a workspace the caller cannot read fold into
 * `other`, and that workspace's jobs keep their kind, class, age and envelope only. The queue's holder is redacted too.
 */
export const redactPoolView = (view: IPoolView, canRead: (workspaceId: string) => boolean): IPoolView => {
  const readable = (ws: string | null): boolean => ws !== null && canRead(ws);
  return {
    ...view,
    hosts: view.hosts.map((h) => {
      const tabsByWorkspace: Record<string, IPoolWorkspaceTabs> = {};
      for (const [ws, t] of Object.entries(h.tabsByWorkspace)) {
        const key = readable(ws) ? ws : OTHER_WORKSPACES;
        const into = tabsByWorkspace[key] ?? { worker: 0, controlPlane: 0 };
        tabsByWorkspace[key] = { worker: into.worker + t.worker, controlPlane: into.controlPlane + t.controlPlane };
      }
      const jobs = h.jobs.map((j) => (j.holder.admin || readable(j.holder.workspaceId)
        ? j
        : { ...j, holder: { workspaceId: null, tabId: null, tabName: null, admin: false }, item: null, epic: null }));
      return { ...h, tabsByWorkspace, jobs };
    }),
    queue: view.queue.map((q) => {
      const ws = q.holder === 'admin' ? null : q.holder.slice(0, q.holder.indexOf('/'));
      return q.holder === 'admin' || readable(ws) ? q : { ...q, holder: OTHER_WORKSPACES };
    }),
  };
};
