import { isAgentPanelType } from '@/lib/agent-panel-types';
import { DEFAULT_POOL_PATH_SLOW_MS, POOL_PATH_SLOW_KEY, pathView } from '@/lib/tailnet-path';
import type { ILease } from '@/types/lease';
import {
  POOL_CLASSES,
  POOL_JOB_KINDS,
  POOL_KINDS,
  type IPoolBudgetView,
  type IPoolEnvelopeView,
  type IPoolHostView,
  type IPoolPlacementRequest,
  type IPoolQueueEntry,
  type IPoolSlotUse,
  type IPoolTotals,
  type IPoolUse,
  type IPoolView,
  type TPoolClass,
  type TPoolHostRead,
  type TPoolKind,
  type TPoolPlacement,
  type TPoolMode,
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

const noteField = (note: string | null, field: string): string | null =>
  new RegExp(`(?:^|\\s)${field}=([^\\s]+)`).exec(note ?? '')?.[1] ?? null;

const notePositive = (note: string | null, field: string): number | null => {
  const n = Number(noteField(note, field));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** A slot lease's note: what it reserves, so the ledger counts it for its whole life. */
export const poolLeaseNote = (envelope: IPoolEnvelope, cls: TPoolClass = 'product'): string =>
  `pool mem=${gbOf(envelope.memBytes)} threads=${envelope.threads} class=${cls}`;

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
export const poolQueueNote = (req: IPoolPlacementRequest): string => [
  POOL_QUEUE_LEASE_KIND,
  `class=${req.class ?? 'product'}`,
  `mem=${req.memGb}`,
  ...(req.threads !== undefined ? [`threads=${req.threads}`] : []),
  ...(req.panelType ? [`panel=${req.panelType}`] : []),
  ...(req.role ? [`role=${req.role}`] : []),
  ...(req.localOnly ? ['local-only=1'] : []),
].join(' ');

export interface IPoolTicket {
  name: string;
  kind: TPoolKind;
  n: number;
  req: IPoolPlacementRequest;
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
  const req: IPoolPlacementRequest = {
    kind: parsed.kind,
    memGb: Number.isFinite(mem) && mem >= 0 ? mem : 0,
    class: isPoolClass(cls) ? cls : 'product',
    ...(threads !== null ? { threads } : {}),
    ...(panelType ? { panelType } : {}),
    ...(role ? { role } : {}),
    ...(noteField(lease.note, 'local-only') === '1' ? { localOnly: true } : {}),
  };
  return { name: lease.name, kind: parsed.kind, n: parsed.n, req, lease };
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
  ledger: Record<TPoolClass, IPoolUse>;
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

const workerUse = (s: Pick<IPoolHostState, 'ledger'>): IPoolUse => ({
  threads: s.ledger.product.threads + s.ledger.harness.threads,
  memBytes: s.ledger.product.memBytes + s.ledger.harness.memBytes,
});

const fitsCount = (free: IPoolUse, e: IPoolEnvelope): number =>
  Math.max(0, Math.min(e.threads > 0 ? Math.floor(free.threads / e.threads) : Infinity, e.memBytes > 0 ? Math.floor(free.memBytes / e.memBytes) : Infinity));

const finiteOr = (n: number, cap: number): number => (Number.isFinite(n) ? n : cap);

export const hostState = (read: TPoolHostRead, leases: readonly ILease[], tabs: IPoolHostTabs, config: TConfigValue): IPoolHostState => {
  const mine = leasesOn(leases, read.host);
  const usedSlots = Object.fromEntries(POOL_KINDS.map((k) => [k, new Set<number>()])) as Record<TPoolKind, Set<number>>;
  const ledger: Record<TPoolClass, IPoolUse> = { product: zeroUse(), harness: zeroUse(), 'control-plane': zeroUse() };
  for (const l of mine) {
    usedSlots[l.kind].add(l.n);
    addUse(ledger[leaseClass(l.lease)], leaseEnvelope(l.lease, l.kind, config));
  }
  const tabEnvelope = kindEnvelope('tab', config);
  addUse(ledger.product, tabEnvelope, tabs.worker);
  addUse(ledger['control-plane'], tabEnvelope, tabs.controlPlane);
  const budget = budgetOf(read, config);
  const known = read.state === 'known' ? read.metrics : null;
  // A host whose own alias failed is shown through its fallback but takes nothing new (review r2 F2):
  // the remote tabs and gates it would get are driven through that alias.
  const fallbackOnly = read.state === 'known' && read.primaryFailure !== undefined
    ? `answers only through ${read.via}; ${read.host} failed (${read.primaryFailure})`
    : null;
  const pending = unseen(mine, read);
  const starts = (tabs.recentStarts ?? []).filter((t) => read.readAt === null || t.at > read.readAt - LOAD_LAG_MS);
  const pendingThreads = pending.reduce((sum, l) => sum + leaseEnvelope(l.lease, l.kind, config).threads, 0) + starts.reduce((sum, t) => sum + t.threads, 0);
  const pendingMem = pending.reduce((sum, l) => sum + leaseEnvelope(l.lease, l.kind, config).memBytes, 0) + starts.reduce((sum, t) => sum + t.memBytes, 0);
  const counts = Object.fromEntries(POOL_KINDS.map((k) => [k, usedSlots[k].size + (k === 'tab' ? tabs.worker + tabs.controlPlane : 0)])) as Record<TPoolKind, number>;
  const countCaps = Object.fromEntries(POOL_KINDS.map((k) => [k, slotCountCapOf(read.host, k, config)])) as Record<TPoolKind, number | null>;
  const used = workerUse({ ledger });
  const free: IPoolUse = budget
    ? { threads: Math.max(0, budget.workerThreads - used.threads), memBytes: Math.max(0, budget.workerMemBytes - used.memBytes) }
    : zeroUse();
  const slots = Object.fromEntries(POOL_KINDS.map((kind) => {
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
    used: { product: { ...ledger.product }, harness: { ...ledger.harness }, 'control-plane': { ...ledger['control-plane'] } },
    free,
  } : null;
  return {
    view: {
      host: read.host,
      local: read.local,
      state: read.state,
      readAt: read.readAt === null ? null : new Date(read.readAt).toISOString(),
      via: read.via,
      reason: read.state === 'unknown' ? read.reason : fallbackOnly,
      placeable: read.state === 'known' && fallbackOnly === null,
      metrics: known,
      loadPerThread: known ? Math.round((known.load1 / known.threads) * 1000) / 1000 : null,
      slots,
      agentTabs: tabs.worker + tabs.controlPlane,
      budget: budgetView,
      path: read.path ? pathView(read.path, pathSlowMsOf(config)) : null,
    },
    budget,
    ledger,
    memFreeBytes: known ? known.memAvailableBytes - pendingMem : null,
    sustainedLoad: known ? Math.min(known.load1, known.load5) + pendingThreads : null,
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

/** The hosts a request may run on, placeable or not: this host for a local-only tab, else every host. */
const allowedHosts = (states: readonly IPoolHostState[], req: IPoolPlacementRequest): IPoolHostState[] =>
  tabLocalOnly(req) ? states.filter((s) => s.view.local) : [...states];

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

const rootDiskPct = (s: IPoolHostState): number | null =>
  s.view.metrics?.disks.find((d) => d.path === '/')?.usedPct ?? null;

/**
 * The admission checks on one host, in order (vel-D4 §2). The ledger checks compare envelopes with the budget and
 * never read measured use; the measured checks subtract only what the read cannot show yet. A refusal states the
 * measured figure against the expected one. In shadow mode the budget, measured-memory and sustained-load checks
 * do not refuse: they are returned as `shadowed`, and every other check still refuses.
 */
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
  const used = workerUse(s);
  const b = s.budget;
  const shadowed: ICheck[] = [];
  const soft = (check: ICheck): TFit | null => {
    if (mode === 'enforce') return { ok: false, ...check };
    shadowed.push(check);
    return null;
  };
  if (used.threads + e.threads > b.workerThreads || used.memBytes + e.memBytes > b.workerMemBytes) {
    const r = soft({ refusal: 'no-budget', step: 3, detail: `${host}: budget threads ${used.threads}/${b.workerThreads} used, needs ${e.threads}; budget memory ${fmtGb(used.memBytes)}/${fmtGb(b.workerMemBytes)} used, needs ${fmtGb(e.memBytes)}` });
    if (r) return r;
  }
  if ((req.class ?? 'product') === 'harness' && !harnessFits(s, e)) {
    const share = b.harnessSharePct / 100;
    return refuse('harness-share', 4, `${host}: harness holds threads ${s.ledger.harness.threads}/${Math.floor(share * b.workerThreads)} and ${fmtGb(s.ledger.harness.memBytes)}/${fmtGb(share * b.workerMemBytes)} (${b.harnessSharePct}% share), needs ${e.threads} threads and ${fmtGb(e.memBytes)}`);
  }
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
  const u = local.ledger['control-plane'];
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
  workerUsed: workerUse(s),
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
 * that could run there waits for: jobs by the lowest projected load per thread, then the most free memory; tabs by
 * the most free memory. A tie keeps this host. In shadow mode (`pool.mode`, the default) a host that only fails
 * the budget, measured-memory or sustained-load checks still takes the work when no host passes every check, and
 * the answer carries `wouldRefuse`. No fit is a refusal that names, per host, the measured and expected figures;
 * it is queueable unless the envelope can never fit an allowed host.
 */
export const placeWork = (states: readonly IPoolHostState[], req: IPoolPlacementRequest, ctx: IPlaceContext = {}): TPoolPlacement => {
  const config: TConfigValue = states[0]?.config ?? (() => null);
  if (req.kind === 'tab' && !isAgentPanelType(req.panelType ?? 'claude-code')) {
    const local = states.find((s) => s.view.local);
    return { ok: true, host: local?.view.host ?? '', local: true, envelope: null, reason: `not an agent tab: a ${req.panelType} tab has no envelope and runs on this host` };
  }
  const e = requestEnvelope(req, config);
  if (req.kind === 'tab' && req.class === 'control-plane') return controlPlaneTab(states, e);
  const mode = poolModeOf(config);
  const allowed = allowedHosts(states, req);
  const why = tabLocalOnly(req);
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
    const order = req.kind === 'tab' ? (a: IPoolHostState, b: IPoolHostState) => byMem(a, b) || localFirst(a, b) : (a: IPoolHostState, b: IPoolHostState) => byLoad(a, b) || byMem(a, b) || localFirst(a, b);
    const chosen = [...pool].sort((a, b) => order(a.s, b.s))[0];
    const best = chosen.s;
    const head = req.kind === 'tab'
      ? `most free memory: ${fmtGb(best.memFreeBytes ?? 0)} measured`
      : `lowest load per thread: ${(best.projectedLoadPerThread ?? 0).toFixed(2)} (projected), ${fmtGb(best.memFreeBytes ?? 0)} free`;
    const b = best.budget!;
    const used = workerUse(best);
    const shadow = chosen.shadowed.length > 0 ? wouldRefuseOf(best, req, e, chosen.shadowed) : null;
    return {
      ok: true, host: best.view.host, local: best.view.local, envelope: envelopeView(e),
      reason: `${head}; budget threads ${used.threads + e.threads}/${b.workerThreads}, memory ${fmtGb(used.memBytes + e.memBytes)}/${fmtGb(b.workerMemBytes)}${why ? ` (${why})` : ''}`
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

export const buildPoolView = (
  states: readonly IPoolHostState[],
  now: number,
  tickets: readonly IPoolTicket[] = [],
  wouldRefuse: IPoolWouldRefuseView = emptyWouldRefuse(poolModeOf(states[0]?.config ?? (() => null)), now),
): IPoolView => {
  const hosts = states.map((s) => s.view);
  return { at: new Date(now).toISOString(), hosts, totals: poolTotals(hosts), queue: queueView(tickets, states), wouldRefuse };
};
