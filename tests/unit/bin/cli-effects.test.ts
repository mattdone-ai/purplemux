import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// `purplemux effects show` (story 15, AC 1): the installed CLI against the real route and the real ledger file.

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

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);
const MIN = 60_000;

let cliHome: string;

const cli = async (args: string[], env: Record<string, string>) => {
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

describe('purplemux effects show — the installed CLI against the real route', () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let env: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-effects-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-effects-home-'));
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    await writeFixture(mockHome.value, [{ id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' }]);
    type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;
    const effects = (await import('@/pages/api/cli/workspaces/[workspaceId]/effects')).default as THandler;
    server = await serveLeaseRoutes({
      '/api/cli/workspaces/ws-a/effects': (req, res) => {
        req.query = { ...req.query, workspaceId: 'ws-a' };
        return effects(req, res);
      },
    });
    const { ensureTabToken } = await import('@/lib/tab-token');
    env = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') };
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('says nothing is measured before the first turn, and names the source', async () => {
    const shown = await cli(['effects', 'show', '-w', 'ws-a'], env);
    expect(shown.code, shown.stderr).toBe(0);
    const lines = shown.stdout.split('\n');
    expect(lines[0]).toMatch(/^effects ws-a \S+Z\.\.\S+Z: nothing measured: no turn recorded yet$/);
    expect(lines[1]).toMatch(/^source: fired: tab_events/);
    expect(shown.stdout).toMatch(/\nnot measured:\nCOMPONENT\s+FAMILY\s+WHY\n/);
    expect(shown.stdout).not.toMatch(/\bDELIVERED\b/);
  });

  it('prints delivered, followed and the share per component; --json is the route\'s body; WS comes from the tab', async () => {
    const store = (await import('@/lib/ledger-store')).getLedgerStore();
    const now = Date.now();
    store.tabTurns.record({ workspaceId: 'ws-a', tabId: 'tab-a1', provider: 'claude', startedAt: now - 50 * MIN, endedAt: now - 49 * MIN, toolCalls: 0 });
    for (const [at, calls] of [[now - 30 * MIN, 2], [now - 20 * MIN, 0]] as const) {
      store.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at, class: 'urgent', kind: 'needs-input', text: 'x', deliveredAt: at });
      store.tabTurns.record({ workspaceId: 'ws-a', tabId: 'tab-a1', provider: 'claude', startedAt: at + 1_000, endedAt: at + MIN, toolCalls: calls });
    }
    const shown = await cli(['effects', 'show', '--days', '2'], { ...env, PMUX_WORKSPACE_ID: 'ws-a' });
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout.split('\n')[0]).toMatch(/counted from \S+Z, the first recorded turn$/);
    expect(shown.stdout).toMatch(/\nCOMPONENT\s+FAMILY\s+FIRED\s+DELIVERED\s+IN-DIGEST\s+FOLLOWED\s+JUDGED\s+SHARE\s+NO-TURN\s+MID-TURN\s+PENDING\s+CLOSED\s+UNMEASURED\s+CANDIDATE\n/);
    expect(shown.stdout).toMatch(/\nneeds-input\s+nudge\s+2\s+2\s+0\s+1\s+2\s+50%\s+0\s+0\s+0\s+0\s+0\s+—\n/);
    expect(shown.stdout).toMatch(/\nstuck\s+nudge\s+0\s+0\s+0\s+0\s+0\s+—\s/);
    expect(shown.stdout).toContain('Delivered 0 is never a candidate');
    expect(shown.stdout).toMatch(/\nflow:lock-busy\s+phone\s+a phone alert/);
    const json = await cli(['effects', 'show', '-w', 'ws-a', '--json'], env);
    expect(JSON.parse(json.stdout)).toMatchObject({ workspaceId: 'ws-a', measuredSince: now - 50 * MIN });
  });

  it('a bad window is the server\'s refusal; a stray argument or a missing subcommand prints the usage', async () => {
    const bad = await cli(['effects', 'show', '-w', 'ws-a', '--days', '90'], env);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('days: saw "90"');
    for (const args of [['effects'], ['effects', 'show', '-w', 'ws-a', 'extra']]) {
      const usage = await cli(args, env);
      expect(usage.code).not.toBe(0);
      expect(usage.stderr).toContain('effects show [-w WS] [--days N] [--json]');
    }
  });
});
