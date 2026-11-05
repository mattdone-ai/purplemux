import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';

// The tab event routes (ADR-0035) against the real ledger file, the real token checks and a temporary HOME.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(async () => true),
  listSessions: vi.fn(async () => []),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const MIN = 60_000;
type THandler = Parameters<typeof callRoute>[0];

const resetLedger = async () => {
  const { resetLedgerStoreForTests } = await import('@/lib/ledger-store');
  resetLedgerStoreForTests();
};

describe('tab event routes', () => {
  let tabA: string;
  let tabB: string;
  const routes: Record<string, THandler> = {};

  const call = (route: string, workspaceId: string, token: string | null, query: Record<string, string> = {}, method = 'GET') =>
    callRoute(routes[route], { method, headers: token ? { 'x-pmux-token': token } : {}, query: { workspaceId, ...query } });

  const store = async () => (await import('@/lib/ledger-store')).getLedgerStore();

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-events-routes-'));
    await resetLedger();
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }, { id: 'tab-a2', name: 'lane' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b1', name: 'orchestrator b' }], orchestratorTabId: 'tab-b1' },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    tabA = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    tabB = await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b1' }, 'pt-ws-b-pane-1-tab-b1');
    const base = '@/pages/api/cli/workspaces/[workspaceId]/events';
    routes.show = (await import(`${base}/index`)).default as THandler;
    routes.wakes = (await import(`${base}/wakes`)).default as THandler;
  });

  afterEach(async () => {
    await resetLedger();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('lists the events from before a server restart (AC 5)', async () => {
    const now = Date.now();
    const before = await store();
    before.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - 50 * MIN, class: 'urgent', kind: 'turn-marker', text: 'DONE: one', deliveredAt: now - 50 * MIN });
    before.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - 20 * MIN, class: 'digest', kind: 'turn-marker', text: 'CHECKPOINTED: two' });
    before.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - 90 * MIN, class: 'urgent', kind: 'turn-marker', text: 'too old' });
    before.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a2', at: now - 10 * MIN, class: 'log', kind: 'note', text: 'other tab' });
    // The restart: the process's handle goes, the next request opens the file again.
    await resetLedger();
    vi.resetModules();
    routes.show = (await import('@/pages/api/cli/workspaces/[workspaceId]/events/index')).default as THandler;

    const shown = await call('show', 'ws-a', tabA, { tab: 'tab-a1', since: '1h' });
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-a1', truncated: false });
    expect((shown.body.events as Array<{ text: string; class: string; deliveredAt: number | null }>).map((e) => [e.text, e.class, e.deliveredAt !== null]))
      .toEqual([['DONE: one', 'urgent', true], ['CHECKPOINTED: two', 'digest', false]]);
    const all = await call('show', 'ws-a', tabA, { since: '2h' });
    expect((all.body.events as unknown[]).length).toBe(4);
  });

  it('keeps the newest events within the limit and says so', async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      (await store()).tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - (10 - i) * MIN, class: 'log', kind: 'x', text: `e${i}` });
    }
    const shown = await call('show', 'ws-a', tabA, { limit: '2' });
    expect(shown.body).toMatchObject({ truncated: true });
    expect((shown.body.events as Array<{ text: string }>).map((e) => e.text)).toEqual(['e3', 'e4']);
  });

  it('refuses a bad time or limit naming the field, and another workspace\'s tab token', async () => {
    expect(await call('show', 'ws-a', tabA, { since: 'yesterday' })).toMatchObject({ status: 400, body: { code: 'ledger-query-invalid', field: 'since' } });
    expect(await call('show', 'ws-a', tabA, { limit: '0' })).toMatchObject({ status: 400, body: { field: 'limit' } });
    expect((await call('show', 'ws-a', tabB)).status).toBe(403);
    expect((await call('show', 'ws-a', tabA, {}, 'POST')).status).toBe(405);
    expect((await call('show', 'ws-nope', tabA)).status).toBeGreaterThanOrEqual(403);
  });

  it('serves wakes and digests per seat, by window or by day (AC 6)', async () => {
    const now = Date.now();
    const s = await store();
    s.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - 30 * MIN, class: 'urgent', kind: 'turn-marker', text: 'DONE', deliveredAt: now - 30 * MIN });
    const digest = [1, 2].map((i) => s.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - (20 + i) * MIN, class: 'digest', kind: 'turn-marker', text: `CP ${i}` }));
    s.tabEvents.markDelivered(digest, now - 10 * MIN, 'dg-1');

    const empty = await call('wakes', 'ws-b', tabB);
    expect(empty.body).toMatchObject({ hasEvents: false, rows: [] });
    const window = await call('wakes', 'ws-a', tabA, { since: '6h' });
    expect(window.status).toBe(200);
    expect(window.body).toMatchObject({ by: 'window', hasEvents: true, rows: [{ tabId: 'tab-a1', day: null, wakes: 2, digests: 1, urgent: 1, logged: 0 }] });
    const byDay = await call('wakes', 'ws-a', tabA, { since: '6h', by: 'day' });
    expect((byDay.body.rows as Array<{ day: string | null }>).every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.day ?? ''))).toBe(true);
    expect(await call('wakes', 'ws-a', tabA, { by: 'hour' })).toMatchObject({ status: 400, body: { field: 'by', allowed: ['window', 'day'] } });
    expect(await call('wakes', 'ws-a', tabA, { since: String(now), until: String(now - 1) })).toMatchObject({ status: 400, body: { field: 'since' } });
  });
});
