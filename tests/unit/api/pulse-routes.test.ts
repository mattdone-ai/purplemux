import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMissionPulseListResponse, IPulse } from '@/types/pulse';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';

// The pulse routes (ADR-0034 §9) against the real ledger and Mission Control stores, token checks and a signed session.

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
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    getAllForClient: () => ({
      'tab-a1': { workspaceId: 'ws-a', tabName: 'orchestrator a', panelType: 'claude-code', cliState: 'busy', busySince: 1 },
      'tab-a2': { workspaceId: 'ws-a', tabName: 'worker', panelType: 'claude-code', cliState: 'busy', busySince: 2 },
      'tab-a3': { workspaceId: 'ws-a', tabName: 'idle lane', panelType: 'codex-cli', cliState: 'idle', busySince: null },
      'tab-a4': { workspaceId: 'ws-a', tabName: 'shell', panelType: 'terminal', cliState: 'busy', busySince: 3 },
    }),
  }),
}));

const HOUR = 3_600_000;
type THandler = Parameters<typeof callRoute>[0];

describe('pulse routes', () => {
  let tabA: string;
  let tabC: string;
  let admin: string;
  let cookie: string;
  let cliRoute: THandler;
  let missionRoute: THandler;

  const cli = (workspaceId: string, token: string, method = 'GET') =>
    callRoute(cliRoute, { method, headers: { 'x-pmux-token': token }, query: { workspaceId } });
  const mission = (query: Record<string, string> = {}, headers: Record<string, string> = { cookie: `session-token=${cookie}` }) =>
    callRoute(missionRoute, { method: 'GET', headers, query });

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-pulse-routes-'));
    process.env.NEXTAUTH_SECRET = 'pulse-route-test-secret-at-least-32-bytes';
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    (await import('@/lib/constraint-tick')).resetConstraintFinderForTests();
    (await import('@/lib/pulse-service')).resetPulseForTests();
    delete (globalThis as Record<string, unknown>).__ptMissionControlStore;
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-c', name: 'gamma', tabs: [{ id: 'tab-c1', name: 'orchestrator c' }], orchestratorTabId: 'tab-c1' },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    tabA = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    tabC = await ensureTabToken({ workspaceId: 'ws-c', tabId: 'tab-c1' }, 'pt-ws-c-pane-1-tab-c1');
    admin = (await import('@/lib/cli-token')).getCliToken();
    cookie = await (await import('@/lib/auth')).signSessionToken();
    cliRoute = (await import('@/pages/api/cli/workspaces/[workspaceId]/pulse')).default as THandler;
    missionRoute = (await import('@/pages/api/mission-control/pulse')).default as THandler;
    const now = Date.now();
    (await import('@/lib/ledger-store')).getLedgerStore().append('ws-c', 'v2', [{
      event_id: 'o1', at: now - HOUR, item_type: 'range', item_key: 'range:c:1', kind: 'open', state: null, wait_reason: null,
      holder: null, clear_input: null, parent_key: null, attrs: null,
    }] as never, now);
  });

  afterEach(async () => {
    await drainRouteLocks();
    resetRouteGlobals();
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    delete (globalThis as Record<string, unknown>).__ptMissionControlStore;
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('GET /api/cli/workspaces/{ws}/pulse: 48 bars, each source with its own state, busy non-orchestrator agent tabs as WIP', async () => {
    const res = await cli('ws-a', tabA);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    const pulse = res.body as unknown as IPulse;
    expect(pulse.workspaceId).toBe('ws-a');
    expect(pulse.hours).toHaveLength(48);
    expect(pulse.sources.map((s) => [s.id, s.state])).toEqual([
      ['ledger', 'unknown'], ['commits', 'unknown'], ['gates', 'unknown'], ['reviews', 'unknown'], ['landed', 'unknown'], ['answers', 'ok'],
    ]);
    expect(pulse.wip).toMatchObject({ count: 1, basis: 'agent-tabs' });
    // The scratch workspace has no file-born source, so no stall is judged (round 2, F4).
    expect(pulse.stall.state).toBe('not-measured');
    expect(pulse.scope).toEqual({ basis: 'directories', epics: [] });
    expect(pulse.priority.needsYou).toBe(0);
  });

  it('refuses another workspace without read scope, an unknown workspace and a method other than GET', async () => {
    expect((await cli('ws-a', tabC)).status).toBe(403);
    expect((await cli('ws-zz', admin)).status).toBe(404);
    expect((await cli('ws-a', tabA, 'POST')).status).toBe(405);
  });

  it('GET /api/mission-control/pulse answers every workspace or one, for the human session only', async () => {
    const all = await mission();
    expect(all.status).toBe(200);
    const { pulses } = all.body as unknown as IMissionPulseListResponse;
    expect(pulses.map((p) => p.workspaceId)).toEqual(['ws-a', 'ws-c']);
    expect(pulses[1]).toMatchObject({ wip: { count: 1, basis: 'ledger' }, sources: expect.arrayContaining([expect.objectContaining({ id: 'ledger', state: 'ok', count: 1 })]) });
    expect((await mission({ workspaceId: 'ws-a' })).status).toBe(200);
    expect((await mission({ workspaceId: 'ws-zz' })).status).toBe(404);
    expect((await mission({}, { cookie: 'session-token=forged' })).status).toBe(401);
    expect((await mission({}, { 'x-pmux-token': admin })).status).toBe(401);
  });
});
