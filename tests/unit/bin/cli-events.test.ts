import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// `purplemux events` (ADR-0035): the installed CLI against the real routes and the real ledger file.

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

describe('purplemux events — the installed CLI against the real routes', () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let env: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-events-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-events-home-'));
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    await writeFixture(mockHome.value, [{ id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' }]);
    type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;
    const base = '@/pages/api/cli/workspaces/[workspaceId]/events';
    const show = (await import(`${base}/index`)).default as THandler;
    const wakes = (await import(`${base}/wakes`)).default as THandler;
    const withWs = (handler: THandler): THandler => (req, res) => {
      req.query = { ...req.query, workspaceId: 'ws-a' };
      return handler(req, res);
    };
    server = await serveLeaseRoutes({ '/api/cli/workspaces/ws-a/events': withWs(show), '/api/cli/workspaces/ws-a/events/wakes': withWs(wakes) });
    const { ensureTabToken } = await import('@/lib/tab-token');
    env = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') };
    const store = (await import('@/lib/ledger-store')).getLedgerStore();
    const now = Date.now();
    store.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - 40 * MIN, class: 'urgent', kind: 'turn-marker', text: 'worker ended: DONE: shipped', deliveredAt: now - 40 * MIN });
    const cp = store.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - 30 * MIN, class: 'digest', kind: 'turn-marker', text: 'ended: CHECKPOINTED: handoff\nsecond line' });
    store.tabEvents.markDelivered([cp], now - 20 * MIN, 'dg-abc');
    store.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: now - 10 * MIN, class: 'digest', kind: 'note', text: '[purplemux note] n-1' });
    store.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a2', at: now - 5 * MIN, class: 'log', kind: 'stuck', text: 'dup' });
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

  it('events show -w WS TAB --since 1h prints each of the tab\'s events whole, with how it was delivered', async () => {
    const shown = await cli(['events', 'show', '-w', 'ws-a', 'tab-a1', '--since', '1h'], env);
    expect(shown.code, shown.stderr).toBe(0);
    const blocks = shown.stdout.trim().split('\n\n');
    expect(blocks[0]).toMatch(/^events ws-a tab-a1 since \S+Z: 3$/);
    expect(blocks[1]).toMatch(/^\S+Z  urgent  turn-marker  \d\d:\d\d:\d\dZ\n  worker ended: DONE: shipped$/);
    expect(blocks[2]).toMatch(/^\S+Z  digest  turn-marker  \d\d:\d\d:\d\dZ dg-abc\n  ended: CHECKPOINTED: handoff\n  second line$/);
    expect(blocks[3]).toMatch(/^\S+Z  digest  note  waiting\n  \[purplemux note\] n-1$/);
  });

  it('the digest\'s pointer command prints a held 1 KB message whole (review r2, F2)', async () => {
    const store = (await import('@/lib/ledger-store')).getLedgerStore();
    const body = `kit -> ORCH (cc SM): ${'x'.repeat(1000)} end-of-body`;
    const seq = store.tabEvents.append({ workspaceId: 'ws-a', tabId: 'tab-a1', at: Date.now() - MIN, class: 'digest', kind: 'tab-send', text: body });
    const { renderDigest } = await import('@/lib/tab-event-router');
    const held = store.tabEvents.pending('ws-a', 'tab-a1').filter((event) => event.seq >= seq);
    const pointer = renderDigest(held, 'ws-a', 'tab-a1').split('\n').at(-1)!;
    const command = pointer.slice(pointer.indexOf('purplemux ') + 'purplemux '.length).split(' ');
    expect(command.slice(0, 5)).toEqual(['events', 'show', '-w', 'ws-a', 'tab-a1']);
    const shown = await cli(command, env);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain(`  ${body}\n`);
  });

  it('events show without a tab lists the workspace; --json is the route\'s body', async () => {
    const all = await cli(['events', 'show', '-w', 'ws-a', '--json'], env);
    const body = JSON.parse(all.stdout) as { tabId: string | null; events: Array<{ tabId: string; class: string }> };
    expect(body.tabId).toBeNull();
    expect(body.events.map((e) => [e.tabId, e.class])).toEqual([['tab-a1', 'urgent'], ['tab-a1', 'digest'], ['tab-a1', 'digest'], ['tab-a2', 'log']]);
    const narrow = await cli(['events', 'show', '-w', 'ws-a', '--since', '15m'], env);
    expect(narrow.stdout.split('\n')[0]).toMatch(/: 2$/);
  });

  it('events wakes counts one wake per delivery and a digest once', async () => {
    const wakes = await cli(['events', 'wakes', '-w', 'ws-a'], env);
    expect(wakes.code, wakes.stderr).toBe(0);
    const lines = wakes.stdout.trim().split('\n');
    expect(lines[1]).toMatch(/^TAB\s+WAKES\s+DIGESTS\s+URGENT\s+LOGGED$/);
    expect(lines.slice(2).map((line) => line.split(/\s+/))).toEqual([['tab-a1', '2', '1', '1', '0'], ['tab-a2', '0', '0', '0', '1']]);
    const byDay = await cli(['events', 'wakes', '-w', 'ws-a', '--by-day', '--json'], env);
    expect(JSON.parse(byDay.stdout)).toMatchObject({ by: 'day', hasEvents: true });
  });

  it('a bad time is the server\'s refusal; a missing subcommand prints the usage', async () => {
    const bad = await cli(['events', 'show', '-w', 'ws-a', '--since', 'soon'], env);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('since: saw "soon"');
    const usage = await cli(['events'], env);
    expect(usage.code).not.toBe(0);
    expect(usage.stderr).toContain('events show -w WS [TAB]');
  });
});
