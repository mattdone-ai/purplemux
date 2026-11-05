import { describe, expect, it } from 'vitest';
import { buildSpendView, cacheReadCostShare, cacheReadShare, formatCacheReads, isUtcDay, landingMetric, rangeDays, addUtcDays, tokensByDay } from '@/lib/spend/spend-model';
import type { ISpendModelInput } from '@/lib/spend/spend-model';
import type { ISpendHoldings } from '@/lib/spend/spend-phase';
import type { ISpendRow, ISpendUsage, TSpendBy } from '@/types/spend';

const OPUS = 'claude-opus-4-6';

const usage = (overrides: Partial<ISpendUsage>): ISpendUsage => ({
  providerId: 'claude', workspaceId: 'ws-a', sessionId: 's-1', day: '2026-10-20', model: OPUS, sidechain: false,
  input: 100, output: 10, cacheRead: 1000, cacheCreation: 50, cacheCreation5m: 50, cacheCreation1h: 0, ...overrides,
});

const INDEX = { state: 'ready' as const, filesIndexed: 3, filesTotal: 3, indexedThrough: 1 };

const input = (overrides: Partial<ISpendModelInput> = {}): ISpendModelInput => ({
  usage: [
    usage({}),
    usage({ sessionId: 's-1', sidechain: true, input: 7, output: 3, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0 }),
    usage({ sessionId: 's-2', day: '2026-10-21', model: 'claude-sonnet-4-5' }),
    usage({ sessionId: 's-unbound', day: '2026-10-21' }),
    usage({ providerId: 'codex', workspaceId: null, sessionId: 'c-1', model: 'gpt-5-codex', cacheCreation: 0, cacheCreation5m: 0, costUsd: 0.5 }),
    usage({ providerId: 'codex', workspaceId: null, sessionId: 'c-unbound', model: 'gpt-5-codex', costUsd: null }),
    usage({ workspaceId: 'global', sessionId: 'g-1' }),
    usage({ workspaceId: 'ws-b', sessionId: 'b-1' }),
  ],
  bindings: {
    'claude:s-1': { workspaceId: 'ws-a', tabId: 'tab-orch' },
    'claude:s-2': { workspaceId: 'ws-a', tabId: 'tab-worker' },
    'codex:c-1': { workspaceId: 'ws-a', tabId: 'tab-codex' },
    'claude:b-1': { workspaceId: 'ws-b', tabId: 'tab-b' },
  },
  workspaces: [
    { id: 'ws-a', name: 'Alpha', orchestratorTabId: 'tab-orch', tabs: { 'tab-orch': 'orchestrator', 'tab-worker': 'worker one' } },
    { id: 'ws-b', name: 'Beta', orchestratorTabId: null, tabs: { 'tab-b': 'beta tab' } },
  ],
  workspaceId: 'ws-a', from: '2026-10-20', to: '2026-10-26', by: 'tab', generatedAt: 42, index: INDEX,
  ...overrides,
});

const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'totalTokens', 'sidechainTokens', 'unpricedTokens'] as const;

const expectSumInvariant = (view: ReturnType<typeof buildSpendView>) => {
  for (const field of FIELDS) {
    const sum = view.rows.reduce((total, row) => total + row[field], 0) + (view.unattributed?.[field] ?? 0);
    expect(sum, field).toBe(view.totals[field]);
  }
  const costs = [...view.rows, ...(view.unattributed ? [view.unattributed] : [])].map((row) => row.costUsd ?? 0);
  expect(costs.reduce((a, b) => a + b, 0)).toBeCloseTo(view.totals.costUsd ?? 0, 9);
};

const row = (rows: ISpendRow[], key: string) => rows.find((candidate) => candidate.key === key);

describe('spend model', () => {
  it.each<[string | 'all', TSpendBy]>([
    ['ws-a', 'tab'], ['ws-a', 'day'], ['ws-a', 'model'], ['ws-a', 'role'],
    ['all', 'tab'], ['all', 'day'], ['all', 'model'], ['all', 'role'], ['all', 'workspace'],
    ['ws-a', 'seat'], ['all', 'seat'],
  ])('keeps sum(rows) + unattributed = totals for %s by %s', (workspaceId, by) => {
    expectSumInvariant(buildSpendView(input({ workspaceId, by })));
  });

  it('attributes a bound session to its tab, subagents under the parent session', () => {
    const view = buildSpendView(input());
    const orchestrator = row(view.rows, 'tab-orch')!;
    expect(orchestrator.label).toBe('orchestrator');
    expect(orchestrator.inputTokens).toBe(107);
    expect(orchestrator.sidechainTokens).toBe(10);
    expect(orchestrator.totalTokens).toBe(1160 + 10);
    expect(row(view.rows, 'tab-codex')).toMatchObject({ label: 'tab-codex (closed)', providerId: 'codex', costUsd: 0.5 });
  });

  it('counts a session no binding names as unattributed in its workspace, never dropped and never 0', () => {
    const view = buildSpendView(input());
    expect(view.unattributed).toMatchObject({ key: 'unattributed', label: 'Not bound to a tab', totalTokens: 1160 });
    expect(view.rows.some((candidate) => candidate.key === 'unattributed')).toBe(false);
  });

  it('keeps unbound Codex usage out of a workspace and in the fleet total as unattributed', () => {
    const scoped = buildSpendView(input({ by: 'workspace', workspaceId: 'all' }));
    expect(scoped.unattributed).toMatchObject({ label: 'Workspace not known', providerId: 'codex', totalTokens: 1160 });
    expect(row(scoped.rows, 'global')).toMatchObject({ label: 'Outside every workspace' });
    expect(row(scoped.rows, 'ws-a')?.label).toBe('Alpha');
    const workspace = buildSpendView(input());
    expect(workspace.totals.totalTokens).toBe(1160 + 10 + 1160 + 1160 + 1110);
  });

  it('never attributes a tab whose binding names another workspace', () => {
    const view = buildSpendView(input({ bindings: { 'claude:g-1': { workspaceId: 'ws-a', tabId: 'tab-orch' } }, workspaceId: 'all' }));
    expect(row(view.rows, 'tab-orch')).toBeUndefined();
  });

  it('splits role into the current orchestrator and other tabs, and says the basis', () => {
    const view = buildSpendView(input({ by: 'role' }));
    expect(view.roleBasis).toBe('current-orchestrator');
    expect(row(view.rows, 'orchestrator')).toMatchObject({ label: 'Orchestrator', totalTokens: 1170 });
    expect(row(view.rows, 'other')).toMatchObject({ label: 'Other tabs' });
    expect(view.unattributed?.totalTokens).toBe(1160);
    expect(buildSpendView(input({ by: 'tab' })).roleBasis).toBeUndefined();
  });

  it('orders days ascending and other keys by tokens', () => {
    const days = buildSpendView(input({ by: 'day' }));
    expect(days.rows.map((candidate) => candidate.key)).toEqual(['2026-10-20', '2026-10-21']);
    expect(days.unattributed).toBeNull();
    expect(tokensByDay(days)).toEqual(days.rows.map((candidate) => ({
      day: candidate.key, totalTokens: candidate.totalTokens, sidechainTokens: candidate.sidechainTokens, cacheReadTokens: candidate.cacheReadTokens,
    })));
    const models = buildSpendView(input({ by: 'model' }));
    expect(models.rows[0].totalTokens).toBeGreaterThanOrEqual(models.rows[1].totalTokens);
    expect(row(models.rows, OPUS)?.label).toBe('Opus 4.6');
    expect(row(models.rows, 'gpt-5-codex')?.label).toBe('gpt-5-codex');
  });

  it('prices known models, puts unknown models in unpricedTokens, and leaves an unpriced row at null', () => {
    const view = buildSpendView(input({
      usage: [usage({ model: 'claude-mythos-1', sessionId: 's-1' }), usage({ sessionId: 's-2' })],
    }));
    expect(row(view.rows, 'tab-orch')).toMatchObject({ costUsd: null, unpricedTokens: 1160 });
    const priced = row(view.rows, 'tab-worker')!;
    expect(priced.unpricedTokens).toBe(0);
    expect(priced.costUsd).toBeCloseTo((100 * 5 + 50 * 6.25 + 1000 * 0.5 + 10 * 25) / 1_000_000, 12);
    expect(view.totals.costUsd).toBeCloseTo(priced.costUsd!, 12);
    expect(view.totals.unpricedTokens).toBe(1160);
  });

  it('answers an empty period with zero totals, no rows and a null cost', () => {
    const view = buildSpendView(input({ from: '2026-01-01', to: '2026-01-02' }));
    expect(view.rows).toEqual([]);
    expect(view.unattributed).toBeNull();
    expect(view.totals).toMatchObject({ totalTokens: 0, costUsd: null });
    expect(view.dayBasis).toEqual({ claude: 'message', codex: 'session-start', grok: 'session-start' });
    expect(view.index).toBe(INDEX);
    expect(view.generatedAt).toBe(42);
  });

  it('names a removed workspace by id and a provider mix as null', () => {
    const view = buildSpendView(input({ workspaceId: 'all', by: 'workspace', workspaces: [] }));
    expect(row(view.rows, 'ws-a')).toMatchObject({ label: 'ws-a (removed)', providerId: null });
  });

  it('reads UTC days strictly', () => {
    expect(isUtcDay('2026-10-26')).toBe(true);
    expect(isUtcDay('2026-02-30')).toBe(false);
    expect(isUtcDay('2026-10-26T00:00')).toBe(false);
    expect(rangeDays('2026-10-20', '2026-10-26')).toBe(7);
    expect(addUtcDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('groups by seat: the tab name of the bound session, merging tabs that share a name', () => {
    const view = buildSpendView(input({
      by: 'seat',
      bindings: {
        'claude:s-1': { workspaceId: 'ws-a', tabId: 'tab-orch' },
        'claude:s-2': { workspaceId: 'ws-a', tabId: 'tab-old-orch', tabName: 'orchestrator' },
        'codex:c-1': { workspaceId: 'ws-a', tabId: 'tab-codex' },
      },
    }));
    expect(row(view.rows, 'orchestrator')).toMatchObject({ label: 'orchestrator', totalTokens: 1170 + 1160 });
    expect(row(view.rows, 'tab:tab-codex')).toMatchObject({ label: 'tab-codex (closed, name not recorded)', providerId: 'codex' });
    expect(view.unattributed).toMatchObject({ label: 'Not bound to a tab', totalTokens: 1160 });
  });

  it('prefers the open tab\'s name to the one recorded at binding time', () => {
    const view = buildSpendView(input({ by: 'seat', bindings: { 'claude:s-2': { workspaceId: 'ws-a', tabId: 'tab-worker', tabName: 'renamed' } } }));
    expect(row(view.rows, 'worker one')).toMatchObject({ totalTokens: 1160 });
    expect(row(view.rows, 'renamed')).toBeUndefined();
  });

  it('keeps one workspace\'s seat apart from another\'s of the same name across all workspaces', () => {
    const view = buildSpendView(input({
      by: 'seat', workspaceId: 'all',
      workspaces: [
        { id: 'ws-a', name: 'Alpha', orchestratorTabId: null, tabs: { 'tab-orch': 'orchestrator' } },
        { id: 'ws-b', name: 'Beta', orchestratorTabId: null, tabs: { 'tab-b': 'orchestrator' } },
      ],
    }));
    expect(row(view.rows, 'ws-a/orchestrator')).toMatchObject({ label: 'orchestrator · Alpha' });
    expect(row(view.rows, 'ws-b/orchestrator')).toMatchObject({ label: 'orchestrator · Beta' });
  });

  it('splits out the cache reads\' est. cost when every priced usage is Claude, and not when a session cost cannot be split', () => {
    const claude = buildSpendView(input({ usage: [usage({ sessionId: 's-1' }), usage({ sessionId: 's-1', model: 'claude-mythos-1' })] }));
    const orchestrator = row(claude.rows, 'tab-orch')!;
    expect(orchestrator.cacheReadCostUsd).toBeCloseTo(1000 * 0.5 / 1_000_000, 12);
    expect(cacheReadCostShare(orchestrator)).toBeCloseTo((1000 * 0.5) / (100 * 5 + 50 * 6.25 + 1000 * 0.5 + 10 * 25), 12);
    expect(formatCacheReads(orchestrator)).toBe('2.0K cache reads (86% of tokens, est. 32% of cost)');
    const mixed = buildSpendView(input());
    expect(row(mixed.rows, 'tab-codex')!.cacheReadCostUsd).toBeNull();
    expect(mixed.totals.cacheReadCostUsd).toBeNull();
    expect(cacheReadCostShare(mixed.totals)).toBeNull();
    expect(buildSpendView(input({ usage: [usage({ model: 'claude-mythos-1' })] })).totals.cacheReadCostUsd).toBeNull();
  });

  it('states the cache-read share of a row, and no share for a row with no tokens', () => {
    const view = buildSpendView(input());
    expect(cacheReadShare(view.totals)).toBeCloseTo(view.totals.cacheReadTokens / view.totals.totalTokens, 12);
    expect(cacheReadShare(buildSpendView(input({ from: '2026-01-01', to: '2026-01-02' })).totals)).toBeNull();
  });

  describe('by phase and by item (harness-flow-loop 04)', () => {
    const SLOT = Date.parse('2026-10-20T10:00:00Z');
    const FIVE = 300_000;
    const calls: Array<[string, string | null, number]> = [];
    const holdings: ISpendHoldings = {
      horizon: SLOT - FIVE,
      heldBy: (tabId, tabName, at) => {
        calls.push([tabId, tabName, at]);
        if (tabId === 'tab-orch' && at < SLOT + 2 * FIVE) return { itemKey: 'slice:a', phase: 'build' };
        if (tabName === 'worker one') return { itemKey: 'range:w:1', phase: 'land' };
        return null;
      },
    };
    const phased = (overrides: Partial<ISpendModelInput> = {}) => input({
      usage: [
        usage({ sessionId: 's-1', slot: SLOT }),
        usage({ sessionId: 's-1', slot: SLOT, sidechain: true }),
        usage({ sessionId: 's-1', slot: SLOT + FIVE }),
        usage({ sessionId: 's-1', slot: SLOT + 3 * FIVE }),
        usage({ sessionId: 's-2', slot: SLOT }),
        usage({ sessionId: 's-1', slot: SLOT - 2 * FIVE }),
        usage({ sessionId: 's-1' }),
        usage({ sessionId: 's-unbound', slot: SLOT }),
        usage({ providerId: 'codex', workspaceId: null, sessionId: 'c-1', model: 'gpt-5-codex', costUsd: 0.5 }),
      ],
      holdings: { 'ws-a': holdings },
      ...overrides,
    });

    it.each<TSpendBy>(['phase', 'item'])('keeps sum(rows) + unattributed = totals by %s, and the reasons sum to unattributed', (by) => {
      const view = buildSpendView(phased({ by }));
      expectSumInvariant(view);
      for (const field of FIELDS) {
        expect(view.unattributedReasons!.reduce((sum, reason) => sum + reason[field], 0), field).toBe(view.unattributed![field]);
      }
      expectSumInvariant(buildSpendView(phased({ by, holdings: undefined })));
    });

    it('attributes each slot to the phase of the item its tab held at the slot midpoint, named reasons for the rest', () => {
      calls.length = 0;
      const view = buildSpendView(phased({ by: 'phase' }));
      expect(calls).toContainEqual(['tab-orch', 'orchestrator', SLOT + 150_000]);
      expect(calls).toContainEqual(['tab-worker', 'worker one', SLOT + 150_000]);
      expect(view.rows.map((r) => [r.key, r.label, r.totalTokens])).toEqual([
        ['build', 'Build', 3 * 1160], ['land', 'Land', 1160], ['other', 'Other (held no ledger item)', 1160],
      ]);
      expect(view.unattributed).toMatchObject({ label: 'Not attributed', totalTokens: 4 * 1160 });
      expect(view.unattributedReasons!.map((r) => [r.key, r.label, r.totalTokens])).toEqual([
        ['no-binding', 'Not bound to a tab', 1160],
        ['no-message-time', 'No message time (Codex, Grok, or indexed before 5-min slots)', 2 * 1160],
        ['no-ledger-history', 'Before the ledger\'s history', 1160],
      ]);
      expect(view.phaseBasis).toEqual({ slotMs: FIVE, ledgerHorizon: SLOT - FIVE, ledgerReadable: true });
    });

    it('puts every slotted bound usage before the ledger\'s history when the workspace has none', () => {
      const view = buildSpendView(phased({ by: 'phase', holdings: { 'ws-a': { horizon: null, heldBy: () => ({ itemKey: 'x:1', phase: 'plan' }) } } }));
      expect(view.rows).toEqual([]);
      expect(view.unattributedReasons!.map((r) => r.key)).toEqual(['no-binding', 'no-message-time', 'no-ledger-history']);
      expect(view.phaseBasis).toEqual({ slotMs: FIVE, ledgerHorizon: null, ledgerReadable: true });
    });

    it('names slotted bound usage ledger-unreadable when the ledger could not be read, not before its history (04-F4)', () => {
      const view = buildSpendView(phased({ by: 'phase', holdings: {}, ledgerUnreadable: true }));
      expect(view.rows).toEqual([]);
      expect(view.unattributedReasons!.map((r) => [r.key, r.label])).toEqual([
        ['no-binding', 'Not bound to a tab'], ['no-message-time', 'No message time (Codex, Grok, or indexed before 5-min slots)'],
        ['ledger-unreadable', 'The ledger could not be read'],
      ]);
      expect(view.phaseBasis).toEqual({ slotMs: FIVE, ledgerHorizon: null, ledgerReadable: false });
      expectSumInvariant(view);
    });

    it('rows by the held item, and names usage whose tab held none', () => {
      const view = buildSpendView(phased({ by: 'item' }));
      expect(view.rows.map((r) => [r.key, r.label])).toEqual([['slice:a', 'slice:a'], ['range:w:1', 'range:w:1']]);
      expect(view.unattributedReasons!.map((r) => [r.key, r.label])).toContainEqual(['no-held-item', 'Held no ledger item']);
    });

    it('leaves the views of the other by values without reasons or a phase basis', () => {
      const view = buildSpendView(phased({ by: 'tab' }));
      expect(view.unattributedReasons).toBeUndefined();
      expect(view.phaseBasis).toBeUndefined();
      expect(view.rows.every((r) => r.wallMs === undefined)).toBe(true);
    });

    it('measures wall time as distinct 5-min slots per row and their union for the total; no message time is null', () => {
      const view = buildSpendView(phased({ by: 'phase', wall: true }));
      expect(view.rows.map((r) => [r.key, r.wallMs])).toEqual([['build', 2 * FIVE], ['land', FIVE], ['other', FIVE]]);
      expect(view.totals.wallMs).toBe(4 * FIVE);
      const reasons = Object.fromEntries(view.unattributedReasons!.map((r) => [r.key, r.wallMs]));
      expect(reasons).toEqual({ 'no-binding': FIVE, 'no-message-time': null, 'no-ledger-history': FIVE });
      expect(view.unattributed!.wallMs).toBe(2 * FIVE);
    });
  });

  describe('cache_read_tokens_per_landed_item (AC 4)', () => {
    it('divides the window\'s cache reads by the items closed landed in it', () => {
      expect(landingMetric('7d', '2026-10-20', '2026-10-26', 69_000_000, { state: 'read', landed: 3 }, 'ready')).toEqual({
        metric: 'cache_read_tokens_per_landed_item', window: '7d', from: '2026-10-20', to: '2026-10-26',
        cacheReadTokens: 69_000_000, landedItems: 3, value: 23_000_000, reason: null,
      });
    });

    it('is not measured, with the reason, when nothing landed or the index is not ready: never 0', () => {
      const read = (landed: number) => ({ state: 'read' as const, landed });
      expect(landingMetric('day', '2026-10-26', '2026-10-26', 5, read(0), 'ready')).toMatchObject({ value: null, landedItems: 0, reason: 'no range closed landed in the window' });
      expect(landingMetric('day', '2026-10-26', '2026-10-26', 5, read(2), 'indexing')).toMatchObject({ value: null, reason: 'spend index indexing: cache reads are partial' });
      expect(landingMetric('day', '2026-10-26', '2026-10-26', 5, { state: 'unreadable' }, 'ready')).toMatchObject({ value: null, landedItems: null, reason: 'the ledger could not be read' });
      expect(landingMetric('day', '2026-10-26', '2026-10-26', 5, { state: 'empty' }, 'indexing')).toMatchObject({ value: null, landedItems: null, reason: 'the ledger holds no items for this workspace yet' });
      expect(landingMetric('day', '2026-10-26', '2026-10-26', 0, read(2), 'ready')).toMatchObject({ value: 0, reason: null });
    });
  });
});
