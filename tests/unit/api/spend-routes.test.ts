import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISpendPhasesView, ISpendView } from '@/types/spend';
import type { ILedgerEventInput, TLedgerItemType, TLedgerKind } from '@/types/ledger';
import type { IMissionBurndownResponse } from '@/types/burndown';

const mockHome = vi.hoisted(() => ({ value: '' }));
const auth = vi.hoisted(() => ({ allow: true, human: true, asked: [] as string[] }));
const portfolio = vi.hoisted(() => ({ selection: null as null | { managerWorkspaceId: string } }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: async (_req: unknown, res: NextApiResponse, workspaceId: string) => {
    auth.asked.push(workspaceId);
    if (auth.allow) return { type: 'workspace', workspaceId };
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  },
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: async () => ({ workspaces: [
    { id: 'ws-a', name: 'Alpha', orchestration: { enabled: true, orchestratorTabId: 'tab-orch' } },
    { id: 'ws-b', name: 'Beta' },
  ], groups: [] }),
}));
vi.mock('@/lib/auth', async (original) => ({ ...await original<typeof import('@/lib/auth')>(),
  verifySessionToken: vi.fn(async () => (auth.human ? { sub: 'human' } : null)),
}));
vi.mock('@/lib/portfolio-store', () => ({
  getPortfolioStore: () => ({
    currentSelection: () => portfolio.selection && { actor: 'human', updatedAt: 1,
      selection: { ...portfolio.selection, managerTabId: 'tab-orch', workspaceIds: [] } },
  }),
}));

const DAY = 86_400_000;
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const TODAY = utc(Date.now());

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown> };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader(name: string, value: unknown) { state.headers[name] = value; return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const cliCall = async (query: Record<string, string>, method = 'GET') => {
  const { default: handler } = await import('@/pages/api/cli/spend');
  const { state, res } = fakeResponse();
  await handler({ method, query, headers: { 'x-pmux-token': 't' } } as unknown as NextApiRequest, res);
  return state;
};

const missionCall = async (query: Record<string, string>, cookie = true) => {
  const { default: handler } = await import('@/pages/api/mission-control/spend');
  const { state, res } = fakeResponse();
  await handler({ method: 'GET', query, headers: cookie ? { cookie: 'session-token=t' } : { 'x-pmux-token': 't' } } as unknown as NextApiRequest, res);
  return state;
};

const assistant = (id: string, session: string, day: string, input = 10, cacheRead = 0, time = '00:00:01') => JSON.stringify({
  type: 'assistant', timestamp: `${day}T${time}.000Z`, sessionId: session,
  message: { id, model: 'claude-opus-4-6', usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
});

const phasesCall = async (query: Record<string, string>) => {
  const { default: handler } = await import('@/pages/api/cli/spend/phases');
  const { state, res } = fakeResponse();
  await handler({ method: 'GET', query, headers: { 'x-pmux-token': 't' } } as unknown as NextApiRequest, res);
  return state;
};

const ledgerEvent = (id: string, at: number, key: string, kind: TLedgerKind, extra: Partial<ILedgerEventInput> = {}): ILedgerEventInput => ({
  event_id: id, at, item_type: key.slice(0, key.indexOf(':')) as TLedgerItemType, item_key: key, kind, ...extra,
});

const seedTranscripts = async () => {
  const projects = (ws: string) => path.join(mockHome.value, '.purplemux', 'workspaces', ws, 'claude-home', 'projects', '-p');
  await fs.mkdir(projects('ws-a'), { recursive: true });
  await fs.mkdir(projects('ws-b'), { recursive: true });
  await fs.writeFile(path.join(projects('ws-a'), 's-orch.jsonl'), `${assistant('m1', 's-orch', TODAY, 100)}\n${assistant('m2', 's-orch', utc(Date.now() - 10 * DAY), 7)}\n`);
  await fs.writeFile(path.join(projects('ws-a'), 's-free.jsonl'), `${assistant('m3', 's-free', TODAY, 30)}\n`);
  await fs.writeFile(path.join(projects('ws-b'), 's-b.jsonl'), `${assistant('m4', 's-b', TODAY, 5)}\n`);
  await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
  await fs.writeFile(path.join(mockHome.value, '.purplemux', 'session-tabs.json'), JSON.stringify({ version: 1, bindings: {
    'claude:s-orch': { workspaceId: 'ws-a', tabId: 'tab-orch', firstSeenAt: 1, lastSeenAt: Date.now() },
  } }));
  const index = await import('@/lib/spend/spend-index');
  await index.runSpendIndexPass();
  return index;
};

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['__ptSpendIndexer', '__ptSpendIndexWriteLock', '__ptCodexStatsCache', '__ptSessionTabsSeen', '__ptSessionTabsRefusedAt']) delete g[key];
  (g.__ptLedgerStore as { close?: () => void } | undefined)?.close?.();
  delete g.__ptLedgerStore;
};

describe('spend routes', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-spend-api-'));
    auth.allow = true;
    auth.human = true;
    auth.asked = [];
    portfolio.selection = null;
    process.env.NEXTAUTH_SECRET = 'spend-route-test-secret-at-least-32-bytes-long';
  });
  afterEach(async () => {
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  describe('GET /api/cli/spend', () => {
    it('answers the last 7 UTC days by tab with the sum invariant and the unattributed row', async () => {
      await seedTranscripts();
      const result = await cliCall({ workspaceId: 'ws-a' });
      expect(result.statusCode).toBe(200);
      expect(result.headers['Cache-Control']).toBe('no-store');
      const view = result.body as ISpendView;
      expect(view).toMatchObject({ workspaceId: 'ws-a', from: utc(Date.now() - 6 * DAY), to: TODAY, by: 'tab' });
      expect(view.rows).toEqual([expect.objectContaining({ key: 'tab-orch', totalTokens: 100 })]);
      expect(view.unattributed).toMatchObject({ totalTokens: 30 });
      expect(view.totals.totalTokens).toBe(130);
      expect(view.index.state).toBe('ready');
      expect(auth.asked).toEqual(['ws-a']);
    });

    it('takes since, until and by', async () => {
      await seedTranscripts();
      const view = (await cliCall({ workspaceId: 'ws-a', since: utc(Date.now() - 30 * DAY), until: TODAY, by: 'role' })).body as ISpendView;
      expect(view.roleBasis).toBe('current-orchestrator');
      expect(view.rows).toEqual([expect.objectContaining({ key: 'orchestrator', totalTokens: 107 })]);
    });

    it.each([
      [{ since: '2026-02-30' }, 'since: saw "2026-02-30", expected a UTC day YYYY-MM-DD'],
      [{ until: 'today' }, 'until: saw "today"'],
      [{ since: '2026-01-01', until: '2026-06-01' }, 'range: saw 152 days, expected at most 92'],
      [{ since: '2026-02-02', until: '2026-02-01' }, 'since 2026-02-02 is after until 2026-02-01'],
      [{ by: 'workspace' }, 'by: saw "workspace", expected one of tab, day, model, role, seat, phase, item'],
      [{ by: 'toString' }, 'by: saw "toString"'],
      [{ by: 'phase', since: utc(Date.now() - 7 * DAY) }, 'range: saw 8 days, expected at most 7 for by=phase (the ledger replay is bounded)'],
      [{ by: 'item', since: utc(Date.now() - 30 * DAY) }, 'range: saw 31 days, expected at most 7 for by=item'],
    ])('refuses %o with invalid-request', async (query, message) => {
      const result = await cliCall({ workspaceId: 'ws-a', ...query });
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ code: 'invalid-request', error: expect.stringContaining(message) });
    });

    it('serves the 92 UTC days from the spend floor and refuses a day before it', async () => {
      expect((await cliCall({ workspaceId: 'ws-a', since: utc(Date.now() - 91 * DAY) })).statusCode).toBe(200);
      const before = utc(Date.now() - 92 * DAY);
      const refused = await cliCall({ workspaceId: 'ws-a', since: before, until: before });
      expect(refused.statusCode).toBe(400);
      expect(refused.body).toEqual({ code: 'invalid-request', error: `Invalid spend request: since: saw ${before}, expected a day on or after ${utc(Date.now() - 91 * DAY)} (spend keeps the last 92 UTC days)` });
    });

    it('needs a workspace in read scope that exists, and GET only', async () => {
      expect((await cliCall({})).body).toMatchObject({ code: 'invalid-request' });
      auth.allow = false;
      expect((await cliCall({ workspaceId: 'ws-b' })).statusCode).toBe(403);
      auth.allow = true;
      expect((await cliCall({ workspaceId: 'ws-gone' })).body).toMatchObject({ code: 'not-found' });
      expect((await cliCall({ workspaceId: 'ws-a' }, 'POST')).statusCode).toBe(405);
    });

    it('parses no transcript on a request (NFR-7)', async () => {
      const index = await seedTranscripts();
      const parsed = index.spendIndexParseCount();
      await cliCall({ workspaceId: 'ws-a' });
      await cliCall({ workspaceId: 'ws-a', by: 'day' });
      expect(index.spendIndexParseCount()).toBe(parsed);
    });

    it('reports a damaged binding store and attributes nothing to a tab', async () => {
      await seedTranscripts();
      await fs.writeFile(path.join(mockHome.value, '.purplemux', 'session-tabs.json'), 'nope');
      const view = (await cliCall({ workspaceId: 'ws-a' })).body as ISpendView;
      expect(view.rows).toEqual([]);
      expect(view.unattributed?.totalTokens).toBe(130);
      expect(view.index.error).toContain('session-tabs.json unreadable');
    });

    it('groups by seat: the tab name the binding recorded for a tab no layout holds now', async () => {
      await seedTranscripts();
      await fs.writeFile(path.join(mockHome.value, '.purplemux', 'session-tabs.json'), JSON.stringify({ version: 1, bindings: {
        'claude:s-orch': { workspaceId: 'ws-a', tabId: 'tab-orch', tabName: 'hfl-orchestrator', firstSeenAt: 1, lastSeenAt: Date.now() },
      } }));
      const view = (await cliCall({ workspaceId: 'ws-a', by: 'seat' })).body as ISpendView;
      expect(view.rows).toEqual([expect.objectContaining({ key: 'hfl-orchestrator', label: 'hfl-orchestrator', totalTokens: 100 })]);
      expect(view.unattributed).toMatchObject({ label: 'Not bound to a tab', totalTokens: 30 });
    });

    it('serves by=phase over exactly 7 UTC days, and by=day over 30 (the cap is the ledger replay\'s only)', async () => {
      expect((await cliCall({ workspaceId: 'ws-a', by: 'phase', since: utc(Date.now() - 6 * DAY) })).statusCode).toBe(200);
      expect((await cliCall({ workspaceId: 'ws-a', by: 'day', since: utc(Date.now() - 29 * DAY) })).statusCode).toBe(200);
      expect((await missionCall({ workspaceId: 'ws-a', by: 'phase', period: '7d' })).statusCode).toBe(200);
    });

    it('says the ledger holds no history instead of a phase while it is empty, never a 0 row', async () => {
      await seedTranscripts();
      const view = (await cliCall({ workspaceId: 'ws-a', by: 'phase' })).body as ISpendView;
      expect(view.rows).toEqual([]);
      expect(view.phaseBasis).toEqual({ slotMs: 300_000, ledgerHorizon: null, ledgerReadable: true });
      expect(view.unattributedReasons!.map((row) => [row.key, row.totalTokens])).toEqual([['no-binding', 30], ['no-ledger-history', 100]]);
      expect(view.totals.totalTokens).toBe(130);
    });

    it('attributes a slot to the phase of the item the bound tab held then', async () => {
      await seedTranscripts();
      const { getLedgerStore } = await import('@/lib/ledger-store');
      const opened = Date.parse(`${utc(Date.now() - DAY)}T00:00:00Z`);
      getLedgerStore().append('ws-a', 'v2', [ledgerEvent('o1', opened, 'slice:lane-a', 'open', { holder: 'tab-orch' })], opened);
      const view = (await cliCall({ workspaceId: 'ws-a', by: 'phase' })).body as ISpendView;
      expect(view.rows).toEqual([expect.objectContaining({ key: 'build', label: 'Build', totalTokens: 100 })]);
      const items = (await cliCall({ workspaceId: 'ws-a', by: 'item' })).body as ISpendView;
      expect(items.rows).toEqual([expect.objectContaining({ key: 'slice:lane-a', totalTokens: 100 })]);
    });

    it('names an unreadable ledger and attributes no phase, never failing the spend answer', async () => {
      await seedTranscripts();
      await fs.mkdir(path.join(mockHome.value, '.purplemux', 'ledger.sqlite'), { recursive: true });
      const result = await cliCall({ workspaceId: 'ws-a', by: 'phase' });
      expect(result.statusCode).toBe(200);
      const view = result.body as ISpendView;
      expect(view.rows).toEqual([]);
      expect(view.index.error).toContain('ledger.sqlite unreadable');
      expect(view.unattributedReasons!.map((row) => [row.key, row.totalTokens])).toEqual([['no-binding', 30], ['ledger-unreadable', 100]]);
      expect(view.phaseBasis).toMatchObject({ ledgerReadable: false });
      const phases = (await phasesCall({ workspaceId: 'ws-a' })).body as ISpendPhasesView;
      expect(phases.cacheReadPerLandedItem.day).toMatchObject({ landedItems: null, value: null, reason: 'the ledger could not be read' });
    });

    it('answers indexing before the first pass', async () => {
      const view = (await cliCall({ workspaceId: 'ws-a' })).body as ISpendView;
      expect(view.index).toMatchObject({ state: 'indexing', filesIndexed: 0 });
      expect(view.totals.costUsd).toBeNull();
    });
  });

  describe('GET /api/mission-control/spend', () => {
    it('refuses a CLI token without a session with 401', async () => {
      auth.human = false;
      const result = await missionCall({ workspaceId: 'ws-a' }, false);
      expect(result.statusCode).toBe(401);
      expect(result.body).toMatchObject({ code: 'unauthorized' });
    });

    it('answers the same view the CLI route answers for the same range', async () => {
      await seedTranscripts();
      const human = (await missionCall({ workspaceId: 'ws-a', period: '7d' })).body as ISpendView;
      const cli = (await cliCall({ workspaceId: 'ws-a' })).body as ISpendView;
      expect({ ...human, generatedAt: 0 }).toEqual({ ...cli, generatedAt: 0 });
    });

    it('answers today, and every workspace by workspace', async () => {
      await seedTranscripts();
      const today = (await missionCall({ workspaceId: 'ws-a', period: 'today' })).body as ISpendView;
      expect(today).toMatchObject({ from: TODAY, to: TODAY });
      const all = await missionCall({ workspaceId: 'all', period: '30d', by: 'workspace' });
      expect(all.headers['Cache-Control']).toBe('no-store');
      const view = all.body as ISpendView;
      expect(view.workspaceId).toBe('all');
      expect(view.rows.map((row) => [row.key, row.label, row.totalTokens])).toEqual([['ws-a', 'Alpha', 137], ['ws-b', 'Beta', 5]]);
    });

    it.each([
      [{ workspaceId: 'ws-a', by: 'workspace' }, 'by=workspace needs workspaceId=all'],
      [{ workspaceId: 'all', by: 'phase' }, 'by=phase needs one workspace'],
      [{ workspaceId: 'all', by: 'item' }, 'by=item needs one workspace'],
      [{ workspaceId: 'ws-a', by: 'phase', period: '30d' }, 'range: saw 30 days, expected at most 7 for by=phase'],
      [{ workspaceId: 'ws-a', period: '90d' }, 'period: saw "90d"'],
      [{ workspaceId: 'ws-gone' }, 'workspace ws-gone does not exist'],
      [{}, 'workspaceId is required'],
    ])('refuses %o with invalid-request', async (query, message) => {
      const result = await missionCall(query);
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ code: 'invalid-request', error: expect.stringContaining(message) });
    });
  });

  describe('GET /api/cli/spend/phases (harness-flow-loop 04 AC 4, AC 5)', () => {
    it('answers the day by phase with wall time, and the per-landing metric as not measured while nothing landed', async () => {
      await seedTranscripts();
      const result = await phasesCall({ workspaceId: 'ws-a' });
      expect(result.statusCode).toBe(200);
      expect(result.headers['Cache-Control']).toBe('no-store');
      const view = result.body as ISpendPhasesView;
      expect(view).toMatchObject({ workspaceId: 'ws-a', day: TODAY, from: TODAY, to: TODAY, by: 'phase' });
      expect(view.totals).toMatchObject({ totalTokens: 130, wallMs: 300_000 });
      expect(view.cacheReadPerLandedItem.day).toMatchObject({ window: 'day', landedItems: null, value: null, reason: 'the ledger holds no items for this workspace yet' });
      expect(view.cacheReadPerLandedItem['7d']).toMatchObject({ window: '7d', from: utc(Date.now() - 6 * DAY), to: TODAY });
      expect(auth.asked).toEqual(['ws-a']);
    });

    it('says no range landed once the ledger holds items for the workspace', async () => {
      await seedTranscripts();
      const { getLedgerStore } = await import('@/lib/ledger-store');
      const at = Date.parse(`${TODAY}T00:00:00Z`);
      getLedgerStore().append('ws-a', 'v2', [ledgerEvent('o1', at, 'range:l:1', 'open')], at);
      const view = (await phasesCall({ workspaceId: 'ws-a' })).body as ISpendPhasesView;
      expect(view.cacheReadPerLandedItem.day).toMatchObject({ landedItems: 0, value: null, reason: 'no range closed landed in the window' });
    });

    it('divides the cache reads by the ranges closed landed in the window', async () => {
      const projects = path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a', 'claude-home', 'projects', '-p');
      await fs.mkdir(projects, { recursive: true });
      await fs.writeFile(path.join(projects, 's-1.jsonl'), `${assistant('m1', 's-1', TODAY, 1, 40_000_000)}\n${assistant('m2', 's-1', utc(Date.now() - 2 * DAY), 1, 20_000_000)}\n`);
      await (await import('@/lib/spend/spend-index')).runSpendIndexPass();
      const { getLedgerStore } = await import('@/lib/ledger-store');
      const at = Date.parse(`${TODAY}T00:00:00Z`);
      getLedgerStore().append('ws-a', 'v2', [
        ledgerEvent('o1', at - 3 * DAY, 'range:l:1', 'open'), ledgerEvent('c1', at - 2 * DAY, 'range:l:1', 'close', { state: 'landed' }),
        ledgerEvent('o2', at, 'range:l:2', 'open'), ledgerEvent('c2', at + 1, 'range:l:2', 'close', { state: 'landed' }),
      ], at + 1);
      const view = (await phasesCall({ workspaceId: 'ws-a', day: TODAY })).body as ISpendPhasesView;
      expect(view.cacheReadPerLandedItem.day).toMatchObject({ cacheReadTokens: 40_000_000, landedItems: 1, value: 40_000_000 });
      expect(view.cacheReadPerLandedItem['7d']).toMatchObject({ cacheReadTokens: 60_000_000, landedItems: 2, value: 30_000_000 });
      const { getFinderSpend } = await import('@/lib/spend/spend-service');
      const finder = await getFinderSpend(['ws-a', 'ws-b']);
      expect(finder).toMatchObject({ index: { state: 'ready' }, since: Date.parse(`${utc(Date.now() - 6 * DAY)}T00:00:00Z`) });
      expect(finder.byWorkspace.get('ws-a')).toMatchObject({
        cacheReadTokens: 60_000_000, landedRanges: 2, cacheReadTokensPerLandedItem: { window: '7d', value: 30_000_000, landedItems: 2 },
      });
      expect(finder.byWorkspace.get('ws-b')).toMatchObject({
        costUsd: 0, cacheReadTokens: 0, landedRanges: null,
        cacheReadTokensPerLandedItem: { value: null, reason: 'the ledger holds no items for this workspace yet' },
      });
    });

    it.each([
      [{ day: '2026-02-30' }, 'day: saw "2026-02-30", expected a UTC day YYYY-MM-DD'],
      [{ day: utc(Date.now() - 92 * DAY) }, `expected a day from ${utc(Date.now() - 91 * DAY)} to ${TODAY}`],
      [{ day: utc(Date.now() + DAY) }, `day: saw ${utc(Date.now() + DAY)}`],
    ])('refuses %o with invalid-request', async (query, message) => {
      const result = await phasesCall({ workspaceId: 'ws-a', ...query });
      expect(result.statusCode).toBe(400);
      expect(result.body).toMatchObject({ code: 'invalid-request', error: expect.stringContaining(message) });
    });

    it('needs a workspace in read scope that exists', async () => {
      expect((await phasesCall({})).body).toMatchObject({ code: 'invalid-request' });
      auth.allow = false;
      expect((await phasesCall({ workspaceId: 'ws-b' })).statusCode).toBe(403);
      auth.allow = true;
      expect((await phasesCall({ workspaceId: 'ws-gone' })).body).toMatchObject({ code: 'not-found' });
    });
  });

  describe('GET /api/mission-control/burndown tokensByDay', () => {
    const missionBurndown = async () => {
      const { default: handler } = await import('@/pages/api/mission-control/burndown');
      const { state, res } = fakeResponse();
      await handler({ method: 'GET', query: {}, headers: { cookie: 'session-token=t' } } as unknown as NextApiRequest, res);
      return state.body as IMissionBurndownResponse;
    };
    const publish = async (firstAt: string) => {
      const { writeBurndown } = await import('@/lib/burndown-store');
      await writeBurndown({ workspaceId: 'ws-a', receivedAt: Date.now(), snapshot: { generated_at: `${TODAY}T00:00:00Z`, epics: [],
        history: [{ at: firstAt, slug: 'e', total: 1, burned: 0, remaining: 1, pct: 0, stories: 1, unpointed: 0 }] } });
    };

    it('adds one tokens figure per day of the chart once the index is ready', async () => {
      portfolio.selection = { managerWorkspaceId: 'ws-a' };
      await seedTranscripts();
      await publish(`${utc(Date.now() - 2 * DAY)}T08:00:00Z`);
      const body = await missionBurndown();
      expect(body.tokensByDay).toEqual([
        { day: utc(Date.now() - 2 * DAY), totalTokens: 0, sidechainTokens: 0, cacheReadTokens: 0 },
        { day: utc(Date.now() - DAY), totalTokens: 0, sidechainTokens: 0, cacheReadTokens: 0 },
        { day: TODAY, totalTokens: 130, sidechainTokens: 0, cacheReadTokens: 0 },
      ]);
    });

    it('leaves the field out while the index is still building, and without a burndown', async () => {
      portfolio.selection = { managerWorkspaceId: 'ws-a' };
      expect(await missionBurndown()).toEqual({ workspaceId: 'ws-a', burndown: null });
      await publish(`${TODAY}T08:00:00Z`);
      expect('tokensByDay' in await missionBurndown()).toBe(false);
    });
  });
});
