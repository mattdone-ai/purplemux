import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IBoard, IMissionBoardListResponse } from '@/types/constraint';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';

// The board routes (ADR-0034) against the real ledger store, the real token checks and a signed session.

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
const HOUR = 60 * MIN;
type THandler = Parameters<typeof callRoute>[0];

describe('board routes', () => {
  let tabA: string;
  let tabC: string;
  let admin: string;
  let cookie: string;
  let cliRoute: THandler;
  let missionRoute: THandler;

  const cli = (workspaceId: string, token: string, query: Record<string, string> = {}, method = 'GET') =>
    callRoute(cliRoute, { method, headers: { 'x-pmux-token': token }, query: { workspaceId, ...query } });
  const mission = (query: Record<string, string> = {}, headers: Record<string, string> = { cookie: `session-token=${cookie}` }) =>
    callRoute(missionRoute, { method: 'GET', headers, query });

  const seed = async () => {
    const { getLedgerStore } = await import('@/lib/ledger-store');
    const now = Date.now();
    const event = (id: string, at: number, key: string, kind: string, extra: Record<string, unknown> = {}) => ({
      event_id: id, at, item_type: key.slice(0, key.indexOf(':')), item_key: key, kind, state: null, wait_reason: null, holder: null,
      clear_input: null, parent_key: null, attrs: null, ...extra,
    });
    getLedgerStore().append('ws-a', 'v2', [
      event('o1', now - 3 * HOUR, 'range:a:1', 'open'),
      event('w1', now - 3 * HOUR, 'range:a:1', 'wait', { wait_reason: 'not-armed', holder: 'orchestrator a', clear_input: 'arm it' }),
      event('o2', now - 2 * HOUR, 'range:b:1', 'open'),
      event('w2', now - 2 * HOUR, 'range:b:1', 'wait', { wait_reason: 'lock-wait', holder: 'lane-b' }),
    ] as never, now);
  };

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-board-routes-'));
    process.env.NEXTAUTH_SECRET = 'board-route-test-secret-at-least-32-bytes';
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
    cookie = await (await import('@/lib/auth')).signSessionToken();
    cliRoute = (await import('@/pages/api/cli/workspaces/[workspaceId]/board')).default as THandler;
    missionRoute = (await import('@/pages/api/mission-control/board')).default as THandler;
    await seed();
  });

  afterEach(async () => {
    await drainRouteLocks();
    resetRouteGlobals();
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    delete (globalThis as Record<string, unknown>).__ptMissionControlStore;
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('GET /api/cli/workspaces/{ws}/board answers the board shape story 08 reads', async () => {
    const res = await cli('ws-a', tabA);
    expect(res.status).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    const board = res.body as unknown as IBoard;
    expect(board).toMatchObject({
      workspaceId: 'ws-a',
      onTrack: { state: 'at-risk', goal: null, itemsLeft: null, p50At: null, p90At: null },
      constraint: { reason: 'not-armed', stage: 'land', waitingHours: 3, trend: 'unknown', ownerSeat: 'orchestrator a', clearInput: 'arm it' },
      needsYou: [],
      inputs: { ledger: { state: 'ok', reason: null }, flow: { state: 'unknown' }, spend: { state: expect.any(String) }, pool: { state: 'unknown' } },
    });
    expect(typeof board.generatedAt).toBe('number');
    expect(board.stuck.map((s) => s.key)).toEqual(['range:a:1', 'range:b:1']);
    expect(board.stuckTotal).toBe(2);
    expect(board.stuck[0]).toMatchObject({ holder: 'orchestrator a', reason: 'not-armed', clearInput: 'arm it' });
    expect(board.line).toBe('no goal set · items left — · constraint: not armed to land, 3.0 h in 24 h · trend not measured');
  });

  it('--mine keeps the items the calling tab holds, by name; needs a tab token', async () => {
    const mine = await cli('ws-a', tabA, { mine: '1' });
    expect(mine.status).toBe(200);
    expect((mine.body as unknown as IBoard).stuck.map((s) => s.key)).toEqual(['range:a:1']);
    const noTab = await cli('ws-a', admin, { mine: '1' });
    expect(noTab.status).toBe(400);
    expect(noTab.body.error).toMatch(/calling tab is unknown/);
    expect((await cli('ws-a', tabA, { mine: 'yes' })).status).toBe(400);
  });

  it('refuses another workspace without read scope, an unknown workspace and a method other than GET', async () => {
    expect((await cli('ws-a', tabC)).status).toBe(403);
    expect((await cli('ws-zz', admin)).status).toBe(404);
    expect((await cli('ws-a', tabA, {}, 'POST')).status).toBe(405);
  });

  it('GET /api/mission-control/board answers every workspace or one, for the human session only', async () => {
    const all = await mission();
    expect(all.status).toBe(200);
    const { boards } = all.body as unknown as IMissionBoardListResponse;
    expect(boards.map((b) => b.workspaceId)).toEqual(['ws-a', 'ws-c']);
    expect(boards[1]).toMatchObject({
      constraint: null, stuck: [], stuckTotal: 0,
      inputs: { ledger: { state: 'unknown', reason: 'the ledger holds no event for this workspace' } },
      line: 'no goal set · items left — · constraint unknown (the ledger holds no event for this workspace)',
    });
    const one = await mission({ workspaceId: 'ws-a' });
    expect(one.status).toBe(200);
    expect((one.body as unknown as IBoard).constraint?.reason).toBe('not-armed');
    expect((await mission({ workspaceId: 'ws-zz' })).status).toBe(404);
    expect((await mission({}, { cookie: 'session-token=forged' })).status).toBe(401);
    expect((await mission({}, { 'x-pmux-token': admin })).status).toBe(401);
  });
});
