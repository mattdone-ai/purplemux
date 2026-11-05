import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';
import type { IEffectRow, IEffectsResponse } from '@/types/effects';

// `GET /api/cli/workspaces/{ws}/effects` (story 15, AC 1) against the real ledger file, the real token check and the
// workspace layout, under a temporary HOME.

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
const openTurns = vi.hoisted(() => ({ value: new Map<string, number | null>() }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ openTurns: () => openTurns.value }) }));

const MIN = 60_000;
type THandler = Parameters<typeof callRoute>[0];

describe('effects route', () => {
  let tabA: string;
  let tabB: string;
  let route: THandler;

  const call = (workspaceId: string, token: string | null, query: Record<string, string> = {}, method = 'GET') =>
    callRoute(route, { method, headers: token ? { 'x-pmux-token': token } : {}, query: { workspaceId, ...query } });
  const store = async () => (await import('@/lib/ledger-store')).getLedgerStore();
  const row = (body: IEffectsResponse, component: string): IEffectRow => body.rows.find((r) => r.component === component)!;

  beforeEach(async () => {
    openTurns.value = new Map();
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-effects-route-'));
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }, { id: 'tab-a2', name: 'lane' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b1', name: 'orchestrator b' }], orchestratorTabId: 'tab-b1' },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    tabA = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    tabB = await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b1' }, 'pt-ws-b-pane-1-tab-b1');
    route = (await import('@/pages/api/cli/workspaces/[workspaceId]/effects')).default as THandler;
  });

  afterEach(async () => {
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads every component as not measured before any turn is recorded', async () => {
    const res = await call('ws-a', tabA);
    expect(res.status).toBe(200);
    const body = res.body as unknown as IEffectsResponse;
    expect(body).toMatchObject({ workspaceId: 'ws-a', since: null, measuredSince: null });
    expect(body.until - body.requestedSince).toBe(7 * 24 * 60 * MIN);
    expect(body.source).toMatch(/tab_events.*tab_turns/);
    expect(row(body, 'needs-input')).toMatchObject({ delivered: null, followed: null, notMeasured: 'no turn recorded yet' });
  });

  it('counts deliveries and what followed, from the ledger, with a closed tab apart', async () => {
    const now = Date.now();
    const s = await store();
    s.tabTurns.record({ workspaceId: 'ws-a', tabId: 'tab-a1', provider: 'claude', startedAt: now - 60 * MIN, endedAt: now - 59 * MIN, toolCalls: 0 });
    const sent = (tabId: string, kind: string, at: number, rule: string | null = null) => s.tabEvents.append({
      workspaceId: 'ws-a', tabId, at, class: 'urgent', kind, text: 'x', rule, deliveredAt: at,
    });
    sent('tab-a1', 'turn-marker', now - 30 * MIN);
    s.tabTurns.record({ workspaceId: 'ws-a', tabId: 'tab-a1', provider: 'claude', startedAt: now - 30 * MIN + 1_000, endedAt: now - 25 * MIN, toolCalls: 3 });
    sent('tab-a1', 'alarm', now - 20 * MIN, 'not-armed');
    s.tabTurns.record({ workspaceId: 'ws-a', tabId: 'tab-a1', provider: 'claude', startedAt: now - 20 * MIN + 1_000, endedAt: now - 19 * MIN, toolCalls: 0 });
    sent('tab-gone', 'stalled', now - 10 * MIN);
    sent('tab-a2', 'stalled', now - 10 * MIN);
    sent('tab-a2', 'alarm', now - 5 * MIN, 'land-queue/lock-busy');
    // tab-a2's turn started by that paste is still running in this server: pending, not unanswered.
    openTurns.value = new Map([['tab-a2', now - 5 * MIN + 1_000]]);
    const res = await call('ws-a', tabA, { days: '1' });
    expect(res.status).toBe(200);
    const body = res.body as unknown as IEffectsResponse;
    expect(body.since).toBe(now - 60 * MIN);
    expect(row(body, 'turn-marker')).toMatchObject({ delivered: 1, followed: 1, judged: 1 });
    expect(row(body, 'alarm:not-armed')).toMatchObject({ delivered: 1, followed: 0, judged: 1 });
    // tab-a2's next turn began 5 min after the stall reached it: another input's turn, so the paste started none.
    expect(row(body, 'stalled')).toMatchObject({ family: 'probe', fired: 2, delivered: 2, noTurn: 1, closed: 1, judged: 1, followed: 0 });
    expect(row(body, 'alarm:land-queue')).toMatchObject({ fired: 1, delivered: 1, pending: 1, judged: 0 });
    expect(body).toMatchObject({ nextTurnBoundMs: 30_000, candidateMinObserved: 10 });
    expect(row(body, 'flow:lock-busy').delivered).toBeNull();
  });

  it('refuses a bad window naming the field, another workspace\'s token and another method', async () => {
    expect(await call('ws-a', tabA, { days: '31' })).toMatchObject({ status: 400, body: { code: 'ledger-query-invalid', field: 'days' } });
    expect(await call('ws-a', tabA, { days: 'week' })).toMatchObject({ status: 400, body: { field: 'days' } });
    expect((await call('ws-a', tabB)).status).toBe(403);
    expect((await call('ws-a', tabA, {}, 'POST')).status).toBe(405);
  });
});
