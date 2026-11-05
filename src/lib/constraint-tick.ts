import { FINDER_LOOKBACK_MS, FINDER_WAKES_WINDOW_MS, deriveConstraint } from '@/lib/constraint';
import { createLogger } from '@/lib/logger';
import type { IBoardGoal, IFinderLedgerInput, IFinderPoolInput, IFinderResult, IFinderSpendAll, IFinderSpendInput } from '@/types/constraint';
import type { IFlowRecord } from '@/types/flow';

// The finder's tick (ADR-0034, the ADR-0032 pattern): every 60 s, per process, derive each
// workspace's constraint and cache it. A tick over 5 s logs its duration; the next is skipped while
// one runs. Each input is read on its own: a failed read is an unknown input, never a skipped tick.

const log = createLogger('constraint-finder');

export const FINDER_TICK_MS = 60_000;
export const FINDER_SLOW_TICK_MS = 5_000;
export const FINDER_SLOW_WORKSPACE_MS = 1_000;
/** An answer older than two ticks is stale: the tick that should have replaced it did not run. */
export const FINDER_STALE_MS = 2 * FINDER_TICK_MS;

export interface IFinderDeps {
  workspaces: () => Promise<Array<{ id: string }>>;
  /** Throws when the ledger cannot be read. */
  ledger: (workspaceId: string, now: number) => Promise<IFinderLedgerInput>;
  flow: (workspaceId: string) => Promise<IFlowRecord | null>;
  /** Read once per tick for the tick's workspaces, not once per workspace. */
  spend: (workspaceIds: readonly string[], now: number) => Promise<IFinderSpendAll | null>;
  /** No pool scheduler yet (ADR-HFL-09, story 17): null is an unknown pool. */
  pool: () => Promise<IFinderPoolInput | null>;
  /** The workspace's goal (`board goal set`); absent or null is no goal. */
  goal?: (workspaceId: string) => Promise<IBoardGoal | null>;
}

interface IFinderTimer {
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<void> | null;
}

const g = globalThis as unknown as {
  __ptConstraintCache?: Map<string, IFinderResult>;
  __ptConstraintTick?: IFinderTimer;
  __ptConstraintInflight?: Map<string, Promise<IFinderResult>>;
};
if (!g.__ptConstraintCache) g.__ptConstraintCache = new Map();
if (!g.__ptConstraintTick) g.__ptConstraintTick = { timer: null, running: null };
if (!g.__ptConstraintInflight) g.__ptConstraintInflight = new Map();

const cache = (): Map<string, IFinderResult> => g.__ptConstraintCache!;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const orNull = async <T>(read: () => Promise<T | null>, what: string, workspaceId: string): Promise<T | null> => {
  try {
    return await read();
  } catch (err) {
    log.warn({ workspaceId }, `constraint finder: ${what} unreadable (${errorText(err)})`);
    return null;
  }
};

/** The workspace's part of the tick's spend read; unknown (null) for a workspace the read did not cover. */
export const spendFor = (all: IFinderSpendAll | null, workspaceId: string): IFinderSpendInput | null => {
  const own = all?.byWorkspace.get(workspaceId);
  return all && own ? { index: all.index, since: all.since, ...own } : null;
};

interface IShared {
  spend: IFinderSpendAll | null;
  pool: IFinderPoolInput | null;
}

const readShared = async (deps: IFinderDeps, workspaceIds: readonly string[], now: number): Promise<IShared> => {
  const [spend, pool] = await Promise.all([
    orNull(() => deps.spend(workspaceIds, now), 'spend', 'all'), orNull(() => deps.pool(), 'pool', 'all'),
  ]);
  return { spend, pool };
};

/** Derive one workspace's answer from fresh reads and cache it; a derive over 1 s logs its duration. */
const deriveForWorkspace = async (
  deps: IFinderDeps, workspaceId: string, now: number, shared: IShared, clock: () => number,
): Promise<IFinderResult> => {
  const started = clock();
  const [ledger, flow, goal] = await Promise.all([
    orNull(() => deps.ledger(workspaceId, now), 'ledger', workspaceId),
    orNull(() => deps.flow(workspaceId), 'flow', workspaceId),
    // An unreadable goal is "goal not measured", never "no goal set" (round 2, F7).
    (async () => (deps.goal ? deps.goal(workspaceId) : null))().then(
      (value) => ({ value, error: null }),
      (err: unknown) => {
        log.warn({ workspaceId }, `constraint finder: goal unreadable (${errorText(err)})`);
        return { value: null, error: errorText(err) };
      },
    ),
  ]);
  const result = deriveConstraint(ledger, flow, spendFor(shared.spend, workspaceId), shared.pool, now, goal.value, goal.error);
  cache().set(workspaceId, result);
  const durationMs = clock() - started;
  if (durationMs > FINDER_SLOW_WORKSPACE_MS) log.warn({ workspaceId, durationMs }, `constraint finder: ${workspaceId} took ${durationMs} ms`);
  return result;
};

/** One tick over every workspace; a closed workspace's answer leaves the cache. */
export const runConstraintTick = async (deps: IFinderDeps, now: number, clock: () => number = Date.now): Promise<number> => {
  const workspaces = await deps.workspaces();
  const ids = new Set(workspaces.map((w) => w.id));
  for (const key of cache().keys()) if (!ids.has(key)) cache().delete(key);
  const shared = await readShared(deps, workspaces.map((w) => w.id), now);
  for (const { id } of workspaces) await deriveForWorkspace(deps, id, now, shared, clock);
  return workspaces.length;
};

const realDeps = (): IFinderDeps => ({
  workspaces: async () => (await (await import('@/lib/workspace-store')).getWorkspaces()).workspaces,
  ledger: async (workspaceId, now) => (await import('@/lib/ledger-store')).getLedgerStore()
    .finderSnapshot(workspaceId, { since: now - FINDER_LOOKBACK_MS, wakesSince: now - FINDER_WAKES_WINDOW_MS }, now),
  flow: async (workspaceId) => (await import('@/lib/flow-store')).readFlow(workspaceId),
  spend: async (workspaceIds, now) => (await import('@/lib/spend/spend-service')).getFinderSpend(workspaceIds, now),
  pool: async () => null,
  goal: async (workspaceId) => (await import('@/lib/board-goal-store')).readBoardGoal(workspaceId),
});

/** One scheduled tick: skipped while the previous one still runs, logged when it takes longer than 5 s. */
export const runScheduledConstraintTick = async (deps: IFinderDeps = realDeps(), clock: () => number = Date.now): Promise<number | null> => {
  const tick = g.__ptConstraintTick!;
  if (tick.running) {
    log.warn('constraint finder tick skipped: the previous tick still runs');
    return null;
  }
  const started = clock();
  let count: number | null = null;
  const run = runConstraintTick(deps, started, clock).then((n) => {
    count = n;
  }, (err) => {
    log.warn(`constraint finder tick failed: ${errorText(err)}`);
  });
  tick.running = run;
  try {
    await run;
  } finally {
    tick.running = null;
    const durationMs = clock() - started;
    if (durationMs > FINDER_SLOW_TICK_MS) log.warn({ durationMs }, `constraint finder tick took ${durationMs} ms`);
  }
  return count;
};

/**
 * The cached answer for a workspace. Before the first tick has reached it (just after a start, or a
 * workspace created since), it is derived now and cached; concurrent reads share that one derive.
 */
export const readFinderResult = async (
  workspaceId: string, now: number, deps: IFinderDeps = realDeps(), clock: () => number = Date.now,
): Promise<IFinderResult> => {
  const cached = cache().get(workspaceId);
  if (cached) return cached;
  const inflight = g.__ptConstraintInflight!;
  const running = inflight.get(workspaceId);
  if (running) return running;
  const derive = readShared(deps, [workspaceId], now)
    .then((shared) => deriveForWorkspace(deps, workspaceId, now, shared, clock))
    .finally(() => inflight.delete(workspaceId));
  inflight.set(workspaceId, derive);
  return derive;
};

/** Drop a workspace's cached answer so the next read derives it (a new goal shows at once, not at the next tick). */
export const forgetFinderResult = (workspaceId: string): void => {
  cache().delete(workspaceId);
};

/** Every cached answer, for the flag tick (source `ledger`). */
export const cachedFinderResults = (): ReadonlyMap<string, IFinderResult> => cache();

/** Start the 60 s tick once per process; a read before the first tick derives its workspace on demand. */
export const startConstraintFinder = (options: { intervalMs?: number; deps?: IFinderDeps } = {}): void => {
  const tick = g.__ptConstraintTick!;
  if (tick.timer) return;
  const deps = options.deps ?? realDeps();
  tick.timer = setInterval(() => {
    void runScheduledConstraintTick(deps);
  }, options.intervalMs ?? FINDER_TICK_MS);
  tick.timer.unref?.();
};

/** Stop the tick and wait for one in flight (`shutdownWs`). */
export const stopConstraintFinder = async (): Promise<void> => {
  const tick = g.__ptConstraintTick!;
  if (tick.timer) clearInterval(tick.timer);
  tick.timer = null;
  await tick.running?.catch(() => undefined);
};

/** Tests only. */
export const resetConstraintFinderForTests = (): void => {
  cache().clear();
  g.__ptConstraintInflight!.clear();
};
