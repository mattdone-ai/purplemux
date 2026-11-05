import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// The installed CLI against the real spend route, workspace token checks and index.

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
const TODAY = new Date().toISOString().slice(0, 10);

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

const assistant = (id: string, session: string, model: string, input: number, cacheRead = 0) => JSON.stringify({
  type: 'assistant', timestamp: `${TODAY}T00:00:01.000Z`, sessionId: session,
  message: { id, model, usage: { input_tokens: input, output_tokens: 10, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 } },
});

describe('purplemux spend show — the installed CLI against the real route', () => {
  let server: { port: number; close: () => Promise<void> };
  let orchA: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    for (const key of ['__ptSpendIndexer', '__ptSpendIndexWriteLock', '__ptSessionTabsSeen']) delete (globalThis as Record<string, unknown>)[key];
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-spend-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-spend-home-'));
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }, { id: 'tab-a2', name: 'worker a' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b1', name: 'orchestrator b' }], orchestratorTabId: 'tab-b1' },
    ]);
    const projects = path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a', 'claude-home', 'projects', '-p');
    await fs.mkdir(projects, { recursive: true });
    await fs.writeFile(path.join(projects, 's-1.jsonl'), `${assistant('m1', 's-1', 'claude-opus-4-6', 1000, 3040)}\n`);
    await fs.writeFile(path.join(projects, 's-2.jsonl'), `${assistant('m2', 's-2', 'claude-mythos-1', 500)}\n`);
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'session-tabs.json'), JSON.stringify({ version: 1, bindings: {
      'claude:s-1': { workspaceId: 'ws-a', tabId: 'tab-a1', firstSeenAt: 1, lastSeenAt: Date.now() },
    } }));
    await (await import('@/lib/spend/spend-index')).runSpendIndexPass();
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { default: spend } = await import('@/pages/api/cli/spend');
    const { default: phases } = await import('@/pages/api/cli/spend/phases');
    server = await serveLeaseRoutes({ '/api/cli/spend': spend, '/api/cli/spend/phases': phases });
    orchA = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') };
  });

  afterEach(async () => {
    const g = globalThis as Record<string, unknown>;
    (g.__ptLedgerStore as { close?: () => void } | undefined)?.close?.();
    delete g.__ptLedgerStore;
    await server.close();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('prints one row per tab, the unattributed row and the total, with an estimated cost', async () => {
    const shown = await cli(['spend', 'show', '-w', 'ws-a'], orchA);
    expect(shown.code, shown.stderr).toBe(0);
    const lines = shown.stdout.split('\n');
    expect(lines[0]).toMatch(/^spend ws-a \d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2} UTC by tab \(cost is an estimate\)$/);
    expect(lines[1]).toMatch(/^KEY\s+LABEL\s+INPUT\s+OUTPUT\s+CACHE-READ\s+CACHE-CREATE\s+TOTAL\s+CACHE-READ-SHARE\s+SUBAGENTS\s+COST\s+CACHE-READ-COST-SHARE$/);
    expect(lines.find((line) => line.startsWith('tab-a1'))).toMatch(/orchestrator a\s+1000\s+10\s+3040\s+0\s+4050\s+75%\s+0\s+est\. \$0\.0068\s+est\. 22%$/);
    expect(lines.find((line) => line.startsWith('unattributed'))).toMatch(/Not bound to a tab\s+500\s+10\s+0\s+0\s+510\s+0%\s+0\s+—\s+—$/);
    expect(lines.find((line) => line.startsWith('total'))).toMatch(/4560\s+67%\s+0\s+est\. \$0\.0068 \(\+510 unpriced\)\s+est\. 22%$/);
    expect(shown.stdout).toContain('cache reads: 3040 of 4560 tokens (67%); est. 22% of the est. cost');
    expect(shown.stdout).toContain('note: Codex and Grok usage counts on the session start day');
  });

  it('says the role uses the current mapping', async () => {
    const shown = await cli(['spend', 'show', '-w', 'ws-a', '--by', 'role'], orchA);
    expect(shown.stdout).toMatch(/^orchestrator\s+Orchestrator\s+1000/m);
    expect(shown.stdout).toContain('note: role uses the current orchestrator mapping');
  });

  it('prints the ISpendView with --json', async () => {
    const shown = await cli(['spend', 'show', '-w', 'ws-a', '--by', 'model', '--since', TODAY, '--json'], orchA);
    expect(shown.code, shown.stderr).toBe(0);
    const view = JSON.parse(shown.stdout);
    expect(view).toMatchObject({ workspaceId: 'ws-a', from: TODAY, to: TODAY, by: 'model', unattributed: null });
    expect(view.rows.map((row: { key: string; costUsd: number | null }) => [row.key, row.costUsd === null])).toEqual([
      ['claude-opus-4-6', false], ['claude-mythos-1', true],
    ]);
  });

  it('exits 2 on a bad date, a range over 92 days or a bad by, and on a usage error', async () => {
    for (const args of [['--since', '2026-13-01'], ['--since', '2026-01-01', '--until', '2026-06-01'], ['--by', 'workspace']]) {
      const refused = await cli(['spend', 'show', '-w', 'ws-a', ...args], orchA);
      expect(refused.code, args.join(' ')).toBe(2);
      expect(refused.stderr).toContain('invalid-request');
    }
    expect((await cli(['spend', 'show'], orchA)).code).toBe(2);
    expect((await cli(['spend', 'list', '-w', 'ws-a'], orchA)).stderr).toContain('usage: spend show -w WS');
    expect((await cli(['spend', 'list', '-w', 'ws-a'], orchA)).stderr).toContain('spend phases -w WS');
    expect((await cli(['spend', 'show', '-w', 'ws-a', 'extra'], orchA)).stderr).toContain('unexpected argument: extra');
  });

  it('refuses with the served error and exits 1 when the index is unavailable, never printing zeros', async () => {
    await server.close();
    vi.resetModules();
    for (const key of ['__ptSpendIndexer', '__ptSpendIndexWriteLock']) delete (globalThis as Record<string, unknown>)[key];
    const indexPath = path.join(mockHome.value, '.purplemux', 'stats', 'spend-index.json');
    await fs.rm(indexPath, { force: true });
    await fs.mkdir(indexPath, { recursive: true });
    server = await serveLeaseRoutes({ '/api/cli/spend': (await import('@/pages/api/cli/spend')).default,
      '/api/cli/spend/phases': (await import('@/pages/api/cli/spend/phases')).default });
    orchA = { ...orchA, PMUX_PORT: String(server.port) };
    const refused = await cli(['spend', 'show', '-w', 'ws-a'], orchA);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toMatch(/^error: spend not available: spend-index\.json unreadable: .+ \(unexpected — investigate\)\n$/);
    const json = await cli(['spend', 'show', '-w', 'ws-a', '--json'], orchA);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout).index.state).toBe('unavailable');
  });

  it('groups by seat, and by phase names why usage has no phase while the ledger holds no history', async () => {
    const seats = await cli(['spend', 'show', '-w', 'ws-a', '--by', 'seat'], orchA);
    expect(seats.code, seats.stderr).toBe(0);
    expect(seats.stdout).toMatch(/^orchestrator a\s+orchestrator a\s+1000/m);
    const phases = await cli(['spend', 'show', '-w', 'ws-a', '--by', 'phase'], orchA);
    expect(phases.code, phases.stderr).toBe(0);
    expect(phases.stdout).toMatch(/^unattributed\s+Not attributed\s+1500/m);
    expect(phases.stdout).toMatch(/^ {2}no-binding\s+Not bound to a tab\s+500/m);
    expect(phases.stdout).toMatch(/^ {2}no-ledger-history\s+Before the ledger's history\s+1000/m);
    expect(phases.stdout).toContain('note: phase is the ledger item the tab held at each message\'s 5-min slot; the ledger holds no items for this workspace yet');
  });

  it('prints the per-phase table of a day: wall time, tokens by kind, est. cost, and cache reads per landed item', async () => {
    const shown = await cli(['spend', 'phases', '-w', 'ws-a', '--day', TODAY], orchA);
    expect(shown.code, shown.stderr).toBe(0);
    const lines = shown.stdout.split('\n');
    expect(lines[0]).toBe(`spend phases ws-a ${TODAY} UTC (cost is an estimate)`);
    expect(lines[1]).toMatch(/^PHASE\s+LABEL\s+WALL\s+INPUT\s+OUTPUT\s+CACHE-READ\s+CACHE-CREATE\s+TOTAL\s+CACHE-READ-SHARE\s+COST\s+CACHE-READ-COST-SHARE$/);
    expect(lines.find((line) => line.startsWith('unattributed'))).toMatch(/^unattributed\s+Not attributed\s+5m\s+1500\s+20\s+3040\s+0\s+4560\s+67%/);
    expect(lines.find((line) => line.startsWith('  no-ledger-history'))).toMatch(/^ {2}no-ledger-history\s+Before the ledger's history\s+5m\s+1000/);
    expect(lines.find((line) => line.startsWith('total'))).toMatch(/^total\s+Total\s+5m\s+1500/);
    expect(shown.stdout).toContain('cache_read_tokens_per_landed_item day: — (the ledger holds no items for this workspace yet; 3040 cache reads)');
    expect(shown.stdout).toMatch(/cache_read_tokens_per_landed_item 7d \(\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}\): — \(the ledger holds no items for this workspace yet; 3040 cache reads\)/);
    const json = await cli(['spend', 'phases', '-w', 'ws-a', '--json'], orchA);
    expect(JSON.parse(json.stdout)).toMatchObject({ day: TODAY, by: 'phase', cacheReadPerLandedItem: { day: { metric: 'cache_read_tokens_per_landed_item' } } });
    expect((await cli(['spend', 'phases', '-w', 'ws-a', '--day', '2026-13-01'], orchA)).code).toBe(2);
    expect((await cli(['spend', 'phases'], orchA)).stderr).toContain('--workspace is required');
  });

  it('says the ledger could not be read when it cannot, not that it holds no items (04-F4)', async () => {
    await fs.mkdir(path.join(mockHome.value, '.purplemux', 'ledger.sqlite'), { recursive: true });
    const phases = await cli(['spend', 'show', '-w', 'ws-a', '--by', 'phase'], orchA);
    expect(phases.code, phases.stderr).toBe(0);
    expect(phases.stdout).toMatch(/^ {2}ledger-unreadable\s+The ledger could not be read\s+1000/m);
    expect(phases.stdout).toContain('the ledger could not be read, so no phase is known (see the error note)');
    expect(phases.stdout).toContain('note: ledger.sqlite unreadable');
  });

  it('exits 3 forbidden for a workspace out of read scope', async () => {
    const refused = await cli(['spend', 'show', '-w', 'ws-b'], orchA);
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain('forbidden');
  });
});
