import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBoardOnTrack } from '@/types/constraint';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';

// The goal route (ADR-0034 §10) against the real goal file, ledger store and token checks.

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

const HOUR = 3_600_000;
type THandler = Parameters<typeof callRoute>[0];

describe('board goal route', () => {
  let tabA: string;
  let tabC: string;
  let admin: string;
  let route: THandler;
  let boardRoute: THandler;

  const call = (workspaceId: string, token: string, method = 'GET', body?: unknown) =>
    callRoute(route, { method, headers: { 'x-pmux-token': token }, query: { workspaceId }, body });

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-goal-route-'));
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    (await import('@/lib/constraint-tick')).resetConstraintFinderForTests();
    delete (globalThis as Record<string, unknown>).__ptMissionControlStore;
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-c', name: 'gamma', tabs: [{ id: 'tab-c1', name: 'orchestrator c' }], orchestratorTabId: 'tab-c1' },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    tabA = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    tabC = await ensureTabToken({ workspaceId: 'ws-c', tabId: 'tab-c1' }, 'pt-ws-c-pane-1-tab-c1');
    admin = (await import('@/lib/cli-token')).getCliToken();
    route = (await import('@/pages/api/cli/workspaces/[workspaceId]/board-goal')).default as THandler;
    boardRoute = (await import('@/pages/api/cli/workspaces/[workspaceId]/board')).default as THandler;
    const now = Date.now();
    const event = (id: string, at: number, key: string, kind: string, state: string | null = null) => ({
      event_id: id, at, item_type: key.slice(0, key.indexOf(':')), item_key: key, kind, state, wait_reason: null, holder: null,
      clear_input: null, parent_key: null, attrs: null,
    });
    (await import('@/lib/ledger-store')).getLedgerStore().append('ws-a', 'v2', [
      event('o1', now - 30 * HOUR, 'range:a:1', 'open'), event('c1', now - 20 * HOUR, 'range:a:1', 'close', 'landed'),
      event('o2', now - 10 * HOUR, 'range:a:2', 'open'), event('c2', now - 5 * HOUR, 'range:a:2', 'close', 'landed'),
      event('o3', now - 2 * HOUR, 'range:a:3', 'open'),
    ] as never, now);
  });

  afterEach(async () => {
    await drainRouteLocks();
    resetRouteGlobals();
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    delete (globalThis as Record<string, unknown>).__ptMissionControlStore;
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('sets the goal from its own tab and the board forecasts it at once; clear says no goal set', async () => {
    // Prime the finder's cache with no goal: the set must not wait for the next tick.
    await callRoute(boardRoute, { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { workspaceId: 'ws-a' } });
    const set = await call('ws-a', tabA, 'PUT', { label: 'Walking skeleton', items: ['range:a:1', 'range:a:2', 'range:a:3', 'range:a:4'] });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ goal: { label: 'Walking skeleton', setBy: 'orchestrator a' } });
    const onTrack = set.body.onTrack as unknown as IBoardOnTrack;
    expect(onTrack).toMatchObject({ state: 'on-track', goal: 'Walking skeleton', itemsLeft: 2, reason: null });
    expect(onTrack.p50At).toBeGreaterThan(Date.now());
    expect(onTrack.p90At).toBeGreaterThanOrEqual(onTrack.p50At!);
    const board = await callRoute(boardRoute, { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { workspaceId: 'ws-a' } });
    expect((board.body as { line: string }).line).toMatch(/^Walking skeleton · 2 items left · /);
    expect((await call('ws-a', admin)).body).toMatchObject({ goal: { items: ['range:a:1', 'range:a:2', 'range:a:3', 'range:a:4'] } });
    const cleared = await call('ws-a', tabA, 'DELETE');
    expect(cleared.body).toMatchObject({ cleared: true, onTrack: { goal: null, state: 'at-risk', reason: 'no goal set' } });
  });

  it('refuses an invalid body with every defect, another workspace, an admin write and an unknown method', async () => {
    const bad = await call('ws-a', tabA, 'PUT', { label: '', items: ['story-3'] });
    expect(bad.status).toBe(400);
    expect(bad.body.defects).toHaveLength(2);
    expect((await call('ws-a', tabC, 'PUT', { label: 'x', items: ['range:a:1'] })).status).toBe(403);
    expect((await call('ws-a', admin, 'PUT', { label: 'x', items: ['range:a:1'] })).status).toBe(403);
    expect((await call('ws-a', tabC)).status).toBe(403);
    expect((await call('ws-zz', admin)).status).toBe(404);
    expect((await call('ws-a', tabA, 'POST')).status).toBe(405);
  });
});
