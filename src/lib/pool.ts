import type { ILease } from '@/types/lease';
import {
  POOL_KINDS,
  type IPoolHostView,
  type IPoolPlacementRequest,
  type IPoolSlotUse,
  type IPoolTotals,
  type IPoolView,
  type TPoolHostRead,
  type TPoolKind,
  type TPoolPlacement,
} from '@/types/pool';

// The pool model and its placement (ADR-0039 §2-§3). Pure: the reads, the
// lease state and the fleet values come in, so every rule is table-tested.

const GIB = 1024 ** 3;

/** Threads one gate or build is assumed to keep busy until the next read shows it. */
export const SLOT_THREADS = 8;
/** Memory a placement leaves free on a host after the work's own `--mem`. */
export const MEM_RESERVE_BYTES = 4 * GIB;
/** The engineering gate refuses new build targets at 85 % (story 11): no gate or build lands on a fuller root. */
export const DISK_REFUSE_PCT = 85;
/** load1 is a one-minute average: work leased within a minute of the read is not in it yet. */
export const LOAD_LAG_MS = 60_000;
export const SLOT_CAP_MAX = 64;

export const POOL_LEASE_KIND = 'pool';
export const POOL_SLOTS_KEY_PREFIX = 'pool.slots.';
export const POOL_GATE_HOST_KEY_PREFIX = 'pool.gate-host.';

export const isPoolKind = (value: unknown): value is TPoolKind => typeof value === 'string' && (POOL_KINDS as readonly string[]).includes(value);

export const poolHostId = (host: string): string => host.toLowerCase();

export const poolLeaseName = (host: string, kind: TPoolKind, n: number): string => `${POOL_LEASE_KIND}:${poolHostId(host)}/${kind}-${n}`;

const LEASE_RE = /^pool:([a-z0-9._-]+)\/(gate|build|tab)-([0-9]{1,3})$/;

export const parsePoolLeaseName = (name: string): { host: string; kind: TPoolKind; n: number } | null => {
  const m = LEASE_RE.exec(name);
  return m ? { host: m[1], kind: m[2] as TPoolKind, n: Number(m[3]) } : null;
};

/** The note a slot lease carries, so later placements count its memory before a read shows it. */
export const poolLeaseNote = (memGb: number): string => `pool mem=${memGb}`;

export const memOfLease = (lease: ILease): number => {
  const gb = Number(/(?:^|\s)mem=([0-9.]+)/.exec(lease.note ?? '')?.[1]);
  return Number.isFinite(gb) && gb > 0 ? gb * GIB : 0;
};

export type TConfigValue = (key: string) => string | null;

/** `pool.slots.<host>.<kind>`: a whole number 0..64; anything else keeps the default. */
export const slotCapOf = (host: string, kind: TPoolKind, read: TPoolHostRead, config: TConfigValue): number => {
  const raw = config(`${POOL_SLOTS_KEY_PREFIX}${poolHostId(host)}.${kind}`)?.trim();
  if (raw && /^\d{1,2}$/.test(raw) && Number(raw) <= SLOT_CAP_MAX) return Number(raw);
  if (read.state !== 'known') return 0;
  const { threads, memTotalBytes } = read.metrics;
  return Math.max(1, kind === 'tab' ? Math.floor(memTotalBytes / (8 * GIB)) : Math.floor(threads / SLOT_THREADS));
};

const leasesOn = (leases: readonly ILease[], host: string) =>
  leases.flatMap((lease) => {
    const parsed = parsePoolLeaseName(lease.name);
    return parsed && parsed.host === poolHostId(host) ? [{ lease, ...parsed }] : [];
  });

/** Leases a read cannot show yet: taken after, or within a minute before, the read. */
const unseen = (leases: readonly ILease[], read: TPoolHostRead) =>
  read.readAt === null ? leases : leases.filter((l) => Date.parse(l.acquiredAt) > read.readAt! - LOAD_LAG_MS);

export interface IPoolHostState {
  view: IPoolHostView;
  /** Memory still free after the leases the read cannot show; null when unknown. */
  memFreeBytes: number | null;
  /** Load per thread with the unseen gates and builds added; null when unknown. */
  projectedLoadPerThread: number | null;
  usedSlots: Record<TPoolKind, Set<number>>;
}

export const hostState = (
  read: TPoolHostRead,
  leases: readonly ILease[],
  agentTabs: number,
  config: TConfigValue,
): IPoolHostState => {
  const mine = leasesOn(leases, read.host);
  const usedSlots = { gate: new Set<number>(), build: new Set<number>(), tab: new Set<number>() };
  for (const l of mine) usedSlots[l.kind].add(l.n);
  const slots = Object.fromEntries(POOL_KINDS.map((kind) => {
    const cap = slotCapOf(read.host, kind, read, config);
    const used = usedSlots[kind].size + (kind === 'tab' ? agentTabs : 0);
    return [kind, { used, cap, free: Math.max(0, cap - used) }];
  })) as Record<TPoolKind, IPoolSlotUse>;
  const known = read.state === 'known' ? read.metrics : null;
  // A host whose own alias failed is shown through its fallback but takes nothing new (review r2 F2):
  // the remote tabs and gates it would get are driven through that alias.
  const fallbackOnly = read.state === 'known' && read.primaryFailure !== undefined
    ? `answers only through ${read.via}; ${read.host} failed (${read.primaryFailure})`
    : null;
  const pending = unseen(mine.map((l) => l.lease), read);
  const pendingCpu = pending.filter((l) => parsePoolLeaseName(l.name)?.kind !== 'tab').length;
  const loadPerThread = known ? Math.round((known.load1 / known.threads) * 1000) / 1000 : null;
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
      loadPerThread,
      slots,
      agentTabs,
    },
    memFreeBytes: known ? known.memAvailableBytes - pending.reduce((sum, l) => sum + memOfLease(l), 0) : null,
    projectedLoadPerThread: known ? (known.load1 + pendingCpu * SLOT_THREADS) / known.threads : null,
    usedSlots,
  };
};

const emptySlots = (): Record<TPoolKind, IPoolSlotUse> =>
  ({ gate: { used: 0, cap: 0, free: 0 }, build: { used: 0, cap: 0, free: 0 }, tab: { used: 0, cap: 0, free: 0 } });

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

export const buildPoolView = (states: readonly IPoolHostState[], now: number): IPoolView => {
  const hosts = states.map((s) => s.view);
  return { at: new Date(now).toISOString(), hosts, totals: poolTotals(hosts) };
};

const fmtGb = (bytes: number): string => `${Math.round((bytes / GIB) * 10) / 10} GiB`;

/**
 * Where a tab may run (consult ruling, story 17): a remote host only for a
 * claude-code tab with no role. codex-cli and grok-cli cannot run remote
 * (ADR-0022 §13), and a coordinator is never a remote tab (§20): a tab created
 * to coordinate is created without `--host`, and designation refuses a remote one.
 */
export const tabLocalOnly = (req: IPoolPlacementRequest): string | null => {
  if (req.kind !== 'tab') return null;
  if (req.role) return `role-local-only: a ${req.role} tab runs on this host`;
  const type = req.panelType ?? 'claude-code';
  return type === 'claude-code' ? null : `type-local-only: a ${type} tab runs on this host (ADR-0022 §13)`;
};

const rootDiskPct = (s: IPoolHostState): number | null =>
  s.view.metrics?.disks.find((d) => d.path === '/')?.usedPct ?? null;

const byMem = (a: IPoolHostState, b: IPoolHostState) => (b.memFreeBytes ?? 0) - (a.memFreeBytes ?? 0);
const byLoad = (a: IPoolHostState, b: IPoolHostState) => (a.projectedLoadPerThread ?? Infinity) - (b.projectedLoadPerThread ?? Infinity);
const localFirst = (a: IPoolHostState, b: IPoolHostState) => Number(b.view.local) - Number(a.view.local);
const notPlaceable = (states: readonly IPoolHostState[]) =>
  states.filter((s) => !s.view.placeable).map((s) => `${s.view.host}: ${s.view.reason}`);

/**
 * A tab (review r2 F3 ruling). The pool never refuses a tab: tab admission is
 * the per-workspace WIP cap (ADR-0027). A local-only tab is placed here
 * whatever this host reads. A claude-code tab goes to the placeable host with a
 * free tab slot and its memory plus the reserve free, the most free memory
 * first; this host is a candidate only while it has a free tab slot. With
 * this host over its tab slots (21 of 11 measured on mdserver1, 2026-11-03),
 * such a tab goes to the remote host whenever that host has the memory floor
 * free. With no candidate it is placed here.
 */
const placeTab = (states: readonly IPoolHostState[], req: IPoolPlacementRequest, localOnly: string | null): TPoolPlacement => {
  const local = states.find((s) => s.view.local);
  const localHost = local?.view.host ?? '';
  if (localOnly) return { ok: true, host: localHost, local: true, reason: localOnly };
  const need = req.memGb * GIB + MEM_RESERVE_BYTES;
  const fits = states.filter((s) => s.view.placeable && s.view.slots.tab.free > 0 && (s.memFreeBytes ?? 0) >= need);
  const best = [...fits].sort((a, b) => byMem(a, b) || localFirst(a, b))[0];
  if (best) return { ok: true, host: best.view.host, local: best.view.local, reason: `most free memory with a free tab slot: ${fmtGb(best.memFreeBytes ?? 0)}` };
  const skipped = notPlaceable(states);
  return {
    ok: true, host: localHost, local: true,
    reason: `no host has a free tab slot and ${fmtGb(need)} free${skipped.length ? ` (${skipped.join('; ')})` : ''}; tab admission is the WIP cap (ADR-0027)`,
  };
};

/**
 * One placement. Unknown hosts and hosts read only through their fallback
 * take nothing new. Gates and builds go to the lowest projected load per
 * thread, then the most free memory; tabs as `placeTab`. A tie keeps this host.
 */
export const placeWork = (states: readonly IPoolHostState[], req: IPoolPlacementRequest): TPoolPlacement => {
  if (req.kind === 'tab') return placeTab(states, req, tabLocalOnly(req));
  const known = states.filter((s) => s.view.placeable);
  if (known.length === 0) {
    const skipped = notPlaceable(states);
    return { ok: false, refusal: 'no-known-host', reason: `no host can take work${skipped.length ? ` (${skipped.join('; ')})` : ''}` };
  }
  const withSlot = known.filter((s) => s.view.slots[req.kind].free > 0);
  if (withSlot.length === 0) {
    return { ok: false, refusal: 'no-free-slot', reason: `every ${req.kind} slot is in use (${known.map((s) => `${s.view.host} ${s.view.slots[req.kind].used}/${s.view.slots[req.kind].cap}`).join(', ')})` };
  }
  // A root that was not read is not room: absence is never read as an empty disk.
  const roomy = withSlot.filter((s) => (rootDiskPct(s) ?? DISK_REFUSE_PCT) < DISK_REFUSE_PCT);
  if (roomy.length === 0) {
    const pctText = (s: IPoolHostState) => { const pct = rootDiskPct(s); return pct === null ? 'not read' : `${pct}%`; };
    return { ok: false, refusal: 'disk-full', reason: `no host with a free slot has / under ${DISK_REFUSE_PCT}% (${withSlot.map((s) => `${s.view.host} ${pctText(s)}`).join(', ')})` };
  }
  const need = req.memGb * GIB + MEM_RESERVE_BYTES;
  const fits = roomy.filter((s) => (s.memFreeBytes ?? 0) >= need);
  if (fits.length === 0) {
    return { ok: false, refusal: 'no-memory', reason: `no host has ${fmtGb(need)} free (${req.memGb} GiB + ${fmtGb(MEM_RESERVE_BYTES)} reserve): ${roomy.map((s) => `${s.view.host} ${fmtGb(s.memFreeBytes ?? 0)}`).join(', ')}` };
  }
  const best = [...fits].sort((a, b) => byLoad(a, b) || byMem(a, b) || localFirst(a, b))[0];
  return {
    ok: true, host: best.view.host, local: best.view.local,
    reason: `lowest load per thread: ${(best.projectedLoadPerThread ?? 0).toFixed(2)} (projected), ${fmtGb(best.memFreeBytes ?? 0)} free`,
  };
};

/** The lowest slot number on the host for the kind (1-based) that no lease holds. */
export const freeSlotNumber = (state: IPoolHostState, kind: TPoolKind): number => {
  let n = 1;
  while (state.usedSlots[kind].has(n)) n += 1;
  return n;
};
