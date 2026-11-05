import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFinderDeps } from '@/lib/constraint-tick';
import type { IFinderLedgerInput } from '@/types/constraint';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: logs.info, warn: logs.warn, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const {
  cachedFinderResults, forgetFinderResult, readFinderResult, resetConstraintFinderForTests, runScheduledConstraintTick, spendFor, startConstraintFinder,
  stopConstraintFinder,
} = await import('@/lib/constraint-tick');

const T0 = Date.UTC(2026, 10, 3, 6, 0, 0);
const HOUR = 3_600_000;

const emptyLedger = (): IFinderLedgerInput => ({ intervals: [], items: [], lastProducer: {}, firstEventAt: T0 - 30 * 24 * HOUR, tabWakes: null, ownerIssueSource: null });

const harness = () => {
  const reads = { ledger: 0, spend: 0, spendIds: [] as string[] };
  const deps: IFinderDeps = {
    workspaces: async () => [{ id: 'ws-a' }, { id: 'ws-b' }],
    ledger: async (workspaceId) => {
      reads.ledger += 1;
      if (workspaceId === 'ws-b') throw new Error('database is locked');
      return {
        ...emptyLedger(),
        intervals: [{ itemKey: 'range:a:1', itemType: 'range', reason: 'not-armed', holder: 'lane-a', start: T0 - 3 * HOUR, end: T0 - HOUR }],
      };
    },
    flow: async () => null,
    spend: async (workspaceIds) => {
      reads.spend += 1;
      reads.spendIds = [...workspaceIds];
      return {
        index: { state: 'ready', filesIndexed: 1, filesTotal: 1, indexedThrough: T0 }, since: T0 - 6 * 24 * HOUR,
        byWorkspace: new Map([['ws-a', { costUsd: 12, cacheReadTokens: 5, landedRanges: 1, cacheReadTokensPerLandedItem: {
          metric: 'cache_read_tokens_per_landed_item' as const, window: '7d' as const, from: 'f', to: 't', cacheReadTokens: 5, landedItems: 1,
          value: 5, reason: null } }]]),
      };
    },
    pool: async () => null,
  };
  return { deps, reads };
};

beforeEach(() => {
  resetConstraintFinderForTests();
  logs.warn.mockClear();
});

afterEach(async () => {
  await stopConstraintFinder();
  vi.useRealTimers();
});

describe('the finder tick (AC 4)', () => {
  it('caches the answer per workspace; a failed ledger read is an unknown ledger, not a skipped workspace', async () => {
    const h = harness();
    expect(await runScheduledConstraintTick(h.deps, () => T0)).toBe(2);
    const a = cachedFinderResults().get('ws-a')!;
    expect(a.constraint).toMatchObject({ reason: 'not-armed', waitingHours: 2, ownerSeat: 'lane-a' });
    const b = cachedFinderResults().get('ws-b')!;
    expect(b.inputs.ledger).toEqual({ state: 'unknown', reason: 'ledger unreadable', at: null });
    expect(logs.warn).toHaveBeenCalledWith({ workspaceId: 'ws-b' }, 'constraint finder: ledger unreadable (database is locked)');
  });

  it('reads the spend once per tick for every workspace; a workspace the read did not cover has an unknown spend', async () => {
    const h = harness();
    await runScheduledConstraintTick(h.deps, () => T0);
    expect(h.reads.spend).toBe(1);
    expect(h.reads.spendIds).toEqual(['ws-a', 'ws-b']);
    expect(spendFor(await h.deps.spend(['ws-a'], T0), 'ws-a')).toMatchObject({
      costUsd: 12, cacheReadTokens: 5, since: T0 - 6 * 24 * HOUR, landedRanges: 1, cacheReadTokensPerLandedItem: { value: 5 },
    });
    expect(spendFor(await h.deps.spend(['ws-a'], T0), 'ws-c')).toBeNull();
    expect(spendFor(null, 'ws-a')).toBeNull();
    expect(cachedFinderResults().get('ws-a')!.anomalies.find((a) => a.id === 'cache-read-per-landed-item')).toMatchObject({ value: 5 });
  });

  it('shares one derive between reads of a workspace the tick has not reached', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ledgerRead = h.deps.ledger;
    h.deps.ledger = async (workspaceId, now) => {
      await gate;
      return ledgerRead(workspaceId, now);
    };
    const first = readFinderResult('ws-a', T0, h.deps);
    const second = readFinderResult('ws-a', T0, h.deps);
    release();
    expect(await second).toBe(await first);
    expect(h.reads.ledger).toBe(1);
  });

  it('logs a workspace whose derive takes over 1 s', async () => {
    let clock = T0;
    const h = harness();
    h.deps.workspaces = async () => [{ id: 'ws-a' }];
    h.deps.flow = async () => {
      clock += 1_001;
      return null;
    };
    await runScheduledConstraintTick(h.deps, () => clock);
    expect(logs.warn).toHaveBeenCalledWith({ workspaceId: 'ws-a', durationMs: 1_001 }, 'constraint finder: ws-a took 1001 ms');
  });

  it('serves a read from the cache, deriving a workspace the tick has not reached yet', async () => {
    const h = harness();
    const first = await readFinderResult('ws-a', T0, h.deps);
    expect(h.reads.ledger).toBe(1);
    expect(await readFinderResult('ws-a', T0 + 1, h.deps)).toBe(first);
    expect(h.reads.ledger).toBe(1);
  });

  it('drops a closed workspace from the cache', async () => {
    const h = harness();
    await runScheduledConstraintTick(h.deps, () => T0);
    h.deps.workspaces = async () => [{ id: 'ws-a' }];
    await runScheduledConstraintTick(h.deps, () => T0);
    expect([...cachedFinderResults().keys()]).toEqual(['ws-a']);
  });

  it('skips a tick while the previous one still runs, and logs a tick over 5 s with its duration', async () => {
    let release!: () => void;
    const h = harness();
    h.deps.workspaces = () => new Promise((resolve) => {
      release = () => resolve([{ id: 'ws-a' }]);
    });
    let clock = T0;
    const first = runScheduledConstraintTick(h.deps, () => clock);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await runScheduledConstraintTick(h.deps, () => clock)).toBeNull();
    expect(logs.warn).toHaveBeenCalledWith('constraint finder tick skipped: the previous tick still runs');
    clock = T0 + 5_001;
    release();
    expect(await first).toBe(1);
    expect(logs.warn).toHaveBeenCalledWith({ durationMs: 5_001 }, 'constraint finder tick took 5001 ms');
  });

  it('does not log a tick of 5 s or less, and logs one that throws', async () => {
    let clock = T0;
    const h = harness();
    h.deps.workspaces = async () => {
      clock += 5_000;
      return [];
    };
    await runScheduledConstraintTick(h.deps, () => clock);
    expect(logs.warn).not.toHaveBeenCalled();
    h.deps.workspaces = async () => {
      throw new Error('workspaces.json unreadable');
    };
    expect(await runScheduledConstraintTick(h.deps, () => clock)).toBeNull();
    expect(logs.warn).toHaveBeenCalledWith('constraint finder tick failed: workspaces.json unreadable');
  });

  it('starts one 60 s interval per process and stops it', async () => {
    vi.useFakeTimers();
    const h = harness();
    startConstraintFinder({ deps: h.deps });
    startConstraintFinder({ deps: h.deps });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.reads.ledger).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reads.ledger).toBe(2);
    await stopConstraintFinder();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.reads.ledger).toBe(2);
  });
});

describe('the goal (story 12 AC 5)', () => {
  it('reads each workspace\'s goal into onTrack; forgetting the answer shows a new goal at the next read', async () => {
    const { deps } = harness();
    let label = 'Walking skeleton';
    deps.goal = async (workspaceId) => (workspaceId === 'ws-a' ? { label, items: ['range:a:1'], setAt: T0, setBy: 'orch' } : null);
    const first = await readFinderResult('ws-a', T0, deps, () => T0);
    expect(first.onTrack).toMatchObject({ goal: 'Walking skeleton', itemsLeft: 1 });
    label = 'Second goal';
    expect((await readFinderResult('ws-a', T0, deps, () => T0)).onTrack.goal).toBe('Walking skeleton');
    forgetFinderResult('ws-a');
    expect((await readFinderResult('ws-a', T0, deps, () => T0)).onTrack.goal).toBe('Second goal');
  });

  it('an unreadable goal is logged and reads "goal not measured", never "no goal set" or a failed tick (round 2, F7)', async () => {
    const { deps } = harness();
    deps.goal = async () => { throw new Error('goal storage unreadable: the file is not JSON'); };
    const result = await readFinderResult('ws-a', T0, deps, () => T0);
    expect(result.onTrack).toMatchObject({ goal: null, goalState: 'unknown', reason: 'goal not measured: goal storage unreadable: the file is not JSON' });
    expect(logs.warn).toHaveBeenCalledWith({ workspaceId: 'ws-a' }, expect.stringContaining('goal unreadable'));
  });
});
