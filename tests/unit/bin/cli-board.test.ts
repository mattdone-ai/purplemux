import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// The installed CLI's `board show` against the real board route, token checks and ledger store.

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

describe('purplemux board show (AC 5)', () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let orchA: Record<string, string>;
  let orchE: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-board-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-board-home-'));
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    (await import('@/lib/constraint-tick')).resetConstraintFinderForTests();
    delete (globalThis as Record<string, unknown>).__ptMissionControlStore;
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-e', name: 'empty', tabs: [{ id: 'tab-e1', name: 'orchestrator e' }], orchestratorTabId: 'tab-e1' },
    ]);
    type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;
    const handler = (await import('@/pages/api/cli/workspaces/[workspaceId]/board')).default as THandler;
    server = await serveLeaseRoutes({
      '/api/cli/workspaces/ws-a/board': (req, res) => {
        req.query = { ...req.query, workspaceId: 'ws-a' };
        return handler(req, res);
      },
      '/api/cli/workspaces/ws-e/board': (req, res) => {
        req.query = { ...req.query, workspaceId: 'ws-e' };
        return handler(req, res);
      },
    });
    const { ensureTabToken } = await import('@/lib/tab-token');
    orchA = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') };
    orchE = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-e', tabId: 'tab-e1' }, 'pt-ws-e-pane-1-tab-e1') };
    const now = Date.now();
    const event = (id: string, at: number, key: string, kind: string, extra: Record<string, unknown> = {}) => ({
      event_id: id, at, item_type: key.slice(0, key.indexOf(':')), item_key: key, kind, ...extra,
    });
    (await import('@/lib/ledger-store')).getLedgerStore().append('ws-a', 'v2', [
      event('o1', now - 3 * HOUR, 'range:a:1', 'open'),
      event('w1', now - 3 * HOUR, 'range:a:1', 'wait', { wait_reason: 'not-armed', holder: 'orchestrator a', clear_input: 'arm it' }),
      event('o2', now - 2 * HOUR, 'range:b:1', 'open'),
      event('w2', now - 2 * HOUR, 'range:b:1', 'wait', { wait_reason: 'lock-wait', holder: 'lane-b' }),
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

  it('--line prints one line: goal, items left, constraint, trend', async () => {
    const res = await cli(['board', 'show', '-w', 'ws-a', '--line'], orchA);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toBe('no goal set · items left — · constraint: not armed to land, 3.0 h in 24 h · trend not measured\n');
  });

  it('--json prints the board; --mine keeps the calling tab\'s items', async () => {
    const json = await cli(['board', 'show', '-w', 'ws-a', '--json'], orchA);
    expect(json.code, json.stderr).toBe(0);
    const board = JSON.parse(json.stdout);
    expect(board.constraint.reason).toBe('not-armed');
    expect(board.stuck).toHaveLength(2);
    const mine = JSON.parse((await cli(['board', 'show', '-w', 'ws-a', '--json', '--mine'], orchA)).stdout);
    expect(mine.stuck.map((s: { key: string }) => s.key)).toEqual(['range:a:1']);
  });

  it('prints the board as text, each input with its state', async () => {
    const res = await cli(['board', 'show', '-w', 'ws-a'], orchA);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('constraint: not armed to land (landing), 3.0 h in 24 h on 1 item(s), all items, trend not measured; owner orchestrator a; clears: arm it');
    expect(res.stdout).toContain('needs you: 0 open in Mission Control');
    expect(res.stdout).toMatch(/stuck, oldest first: 2\nITEM +REASON +AGE +HOLDER +CLEARS\nrange:a:1 +not armed to land +3h00m +orchestrator a +arm it\n/);
    expect(res.stdout).toContain('inputs: ledger ok · flow unknown (no flow record published) · spend');
    expect(res.stdout).toContain('pool unknown (no pool published)');
  });

  it('--line says "stale since <time>" when the finder answer is older than 120 s', async () => {
    const { readFinderResult } = await import('@/lib/constraint-tick');
    const cached = await readFinderResult('ws-a', Date.now());
    cached.generatedAt = Date.UTC(2026, 10, 3, 6, 35);
    const res = await cli(['board', 'show', '-w', 'ws-a', '--line'], orchA);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toBe(`${cached.line} · stale since 2026-11-03 17:35 AEDT\n`);
    const json = JSON.parse((await cli(['board', 'show', '-w', 'ws-a', '--json'], orchA)).stdout);
    expect(json.staleSince).toBe(Date.UTC(2026, 10, 3, 6, 35));
  });

  it('says "curator down" with the reason when the tunnel is down, on the text board and the one line (ADR-0038 §6)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11435') }); }));
    try {
      await (await import('@/lib/curator-service')).getCuratorClient().probe();
      const text = await cli(['board', 'show', '-w', 'ws-a'], orchA);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toMatch(/^curator: curator down \(tunnel down \(fetch failed: connect ECONNREFUSED 127\.0\.0\.1:11435\)\); the rules route · classify-owner-message shadow, no labels in 72 h · /m);
      const line = await cli(['board', 'show', '-w', 'ws-a', '--line'], orchA);
      expect(line.stdout).toBe('no goal set · items left — · constraint: not armed to land, 3.0 h in 24 h · trend not measured · curator down\n');
    } finally {
      vi.unstubAllGlobals();
      delete (globalThis as Record<string, unknown>).__ptCuratorClient;
    }
  });

  it('says "50 of N" when the stuck list is capped', async () => {
    const now = Date.now();
    const events = Array.from({ length: 51 }, (_, i) => [
      { event_id: `ox${i}`, at: now - HOUR, item_type: 'range', item_key: `range:c:${i}`, kind: 'open' },
      { event_id: `wx${i}`, at: now - HOUR, item_type: 'range', item_key: `range:c:${i}`, kind: 'wait', wait_reason: 'gate-slot', holder: 'lane-c' },
    ]).flat();
    (await import('@/lib/ledger-store')).getLedgerStore().append('ws-a', 'v2', events as never, now);
    (await import('@/lib/constraint-tick')).resetConstraintFinderForTests();
    const res = await cli(['board', 'show', '-w', 'ws-a'], orchA);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('stuck, oldest first: 50 of 53\n');
  });

  it('prints stuck and anomalies as unknown, never 0, when the ledger holds no event for the workspace', async () => {
    const res = await cli(['board', 'show', '-w', 'ws-e'], orchE);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('constraint: unknown\n');
    expect(res.stdout).toContain('stuck: unknown (the ledger holds no event for this workspace)\n');
    expect(res.stdout).toContain('anomalies: unknown (the ledger holds no event for this workspace)\n');
    expect(res.stdout).not.toMatch(/stuck, oldest first|anomalies over threshold/);
  });

  it('refuses a missing workspace, an unknown subcommand and --json with --line', async () => {
    expect((await cli(['board', 'show'], orchA)).code).not.toBe(0);
    expect((await cli(['board', 'list', '-w', 'ws-a'], orchA)).stderr).toContain('usage: board show');
    expect((await cli(['board', 'show', '-w', 'ws-a', '--json', '--line'], orchA)).stderr).toContain('exclusive');
  });
});
