import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// The installed CLI's `board pulse` and `board goal` against the real routes, token checks and stores.

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
      'tab-a2': { workspaceId: 'ws-a', tabName: 'hfl-12', panelType: 'claude-code', cliState: 'busy', busySince: Date.now() - 5 * 3_600_000 },
    }),
  }),
}));

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);
const HOUR = 3_600_000;

interface IResult { code: number; stdout: string; stderr: string }
let cliHome: string;

const cli = async (args: string[], env: Record<string, string>): Promise<IResult> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

describe('purplemux board pulse and board goal (AC 5, AC 10)', () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let orchA: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-pulse-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-pulse-home-'));
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    (await import('@/lib/constraint-tick')).resetConstraintFinderForTests();
    (await import('@/lib/pulse-service')).resetPulseForTests();
    delete (globalThis as Record<string, unknown>).__ptMissionControlStore;
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' },
    ]);
    type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;
    const routed = (handler: THandler): THandler => (req, res) => {
      req.query = { ...req.query, workspaceId: 'ws-a' };
      return handler(req, res);
    };
    server = await serveLeaseRoutes({
      '/api/cli/workspaces/ws-a/board': routed((await import('@/pages/api/cli/workspaces/[workspaceId]/board')).default as THandler),
      '/api/cli/workspaces/ws-a/pulse': routed((await import('@/pages/api/cli/workspaces/[workspaceId]/pulse')).default as THandler),
      '/api/cli/workspaces/ws-a/board-goal': routed((await import('@/pages/api/cli/workspaces/[workspaceId]/board-goal')).default as THandler),
    });
    const { ensureTabToken } = await import('@/lib/tab-token');
    orchA = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') };
    const now = Date.now();
    const event = (id: string, at: number, key: string, kind: string, extra: Record<string, unknown> = {}) => ({
      event_id: id, at, item_type: key.slice(0, key.indexOf(':')), item_key: key, kind, ...extra,
    });
    (await import('@/lib/ledger-store')).getLedgerStore().append('ws-a', 'v2', [
      event('o1', now - 30 * HOUR, 'range:a:1', 'open'),
      event('c1', now - 20 * HOUR, 'range:a:1', 'close', { state: 'landed' }),
      event('o2', now - 4 * HOUR, 'range:b:1', 'open'),
      event('w2', now - 4 * HOUR, 'range:b:1', 'wait', { wait_reason: 'lock-wait', holder: 'lane-b', clear_input: 'lock free' }),
    ] as never, now);
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    delete (globalThis as Record<string, unknown>).__ptMissionControlStore;
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('board pulse prints the 48-hour strip, the stall, priority now and each source with its own state', async () => {
    const res = await cli(['board', 'pulse', '-w', 'ws-a'], orchA);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/^last 48 h, one mark per hour, oldest left: [·▁▂▃▄▅▆▇█]{48}$/m);
    // No file-born source in a scratch HOME: the ledger alone never decides a stall (round 2, F4).
    expect(res.stdout).toMatch(/^not measured: no file-born source \(commits, gates, review rounds, landings\) could be read · not measured: commits, /m);
    expect(res.stdout).toContain('pulse ws-a (counts its own directories)');
    expect(res.stdout).toContain('priority now: waiting for the landing lock: owner lane-b, clears when lock free · needs you: 0');
    expect(res.stdout).toContain('work in progress: 1 open ledger item');
    expect(res.stdout).toMatch(/Ledger changes +3 /);
    expect(res.stdout).toMatch(/Commits +not measured \(no git repository in this workspace's scope\)/);
    const json = JSON.parse((await cli(['board', 'pulse', '-w', 'ws-a', '--json'], orchA)).stdout);
    expect(json.hours).toHaveLength(48);
    expect(json.stall.state).toBe('not-measured');
    expect(json.scope).toEqual({ basis: 'directories', epics: [] });
  });

  it('board goal set forecasts p50 and p90 in AEDT; show and clear; no goal says so', async () => {
    const set = await cli(['board', 'goal', 'set', '-w', 'ws-a', '--items', 'range:a:1,range:b:1,range:c:1', '--label', 'Walking skeleton'], orchA);
    expect(set.code, set.stderr).toBe(0);
    expect(set.stdout).toMatch(/^goal: Walking skeleton · 2 items left · p50 \d{4}-\d{2}-\d{2} \d{2}:\d{2} AE[DS]T, p90 \d{4}-\d{2}-\d{2} \d{2}:\d{2} AE[DS]T · closed per day, last 3 days: 0, 0, 1 · on-track\n$/);
    const show = await cli(['board', 'goal', 'show', '-w', 'ws-a'], orchA);
    expect(show.stdout).toContain('items: range:a:1, range:b:1, range:c:1\nset by orchestrator a at ');
    const board = await cli(['board', 'show', '-w', 'ws-a', '--line'], orchA);
    expect(board.stdout).toMatch(/^Walking skeleton · 2 items left · /);
    expect((await cli(['board', 'goal', 'clear', '-w', 'ws-a'], orchA)).stdout).toBe('goal cleared\n');
    expect((await cli(['board', 'goal', 'show', '-w', 'ws-a'], orchA)).stdout).toBe('goal: no goal set\n');
  });

  it('board goal set refuses a missing flag and a bad key with the server\'s defect', async () => {
    expect((await cli(['board', 'goal', 'set', '-w', 'ws-a', '--label', 'x'], orchA)).stderr).toContain('--items is required');
    const bad = await cli(['board', 'goal', 'set', '-w', 'ws-a', '--items', 'story-3', '--label', 'x'], orchA);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('items[0]: saw "story-3"');
  });
});
