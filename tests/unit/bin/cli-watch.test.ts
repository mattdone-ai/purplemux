import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, loadLeaseRoutes, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// Story 14 end to end: the installed CLI against the real watch and lease
// routes, the real lease release event, and the real watch and inbox stores.
// No GitHub: pr and ref watches are covered with a fake gh in watch-manager.test.ts.

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
// The file logger writes under the temp HOME, which each test removes (h-15, 39f5edbe).
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);
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

// The first load of this module graph costs about 1 s alone and passed the 5 s test budget on a loaded gate
// (story hfl2-53). Load it once here, at collection, outside every test's budget. vi.resetModules() discards
// this instance; each test's own import evaluates again from the transform cache in milliseconds.
await Promise.all([
  import('@/lib/tab-token'),
  import('@/lib/cli-token'),
  import('@/lib/tab-lifecycle'),
  import('@/lib/watch-manager'),
  import('@/lib/watch-store'),
  import('@/pages/api/cli/watches/index'),
  import('@/pages/api/cli/watches/[id]'),
  loadLeaseRoutes(),
]);

describe('purplemux watch — the installed CLI against the real watch routes (ADR-0015)', { timeout: 60_000 }, () => {
  let server: { port: number; close: () => Promise<void> };
  let tabA: Record<string, string>;
  let tabB: Record<string, string>;
  let routes: Record<string, Parameters<typeof callRoute>[0]>;
  let mountClear: (id: string) => void;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    const g = globalThis as Record<string, unknown>;
    for (const k of ['__ptWatchLock', '__ptWatchManager', '__ptWatchRuntime']) delete g[k];
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-watch-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-watch-home-'));
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a', name: 'holder' }] },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b', name: 'waiter' }] },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const clear = (await import('@/pages/api/cli/watches/[id]')).default;
    routes = { ...(await loadLeaseRoutes()), '/api/cli/watches': (await import('@/pages/api/cli/watches/index')).default };
    // The harness serves exact paths from this same object: `mountClear` adds `/api/cli/watches/<id>`.
    mountClear = (id: string) => {
      routes[`/api/cli/watches/${id}`] = (req, res) => {
        req.query.id = id;
        return clear(req, res);
      };
    };
    server = await serveLeaseRoutes(routes);
    const port = String(server.port);
    tabA = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a' }, 'pt-ws-a-pane-1-tab-a') };
    tabB = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b' }, 'pt-ws-b-pane-1-tab-b') };
  });

  afterEach(async () => {
    const { stopWatches } = await import('@/lib/watch-manager');
    await stopWatches();
    await server.close();
    await drainRouteLocks();
    await (globalThis as unknown as Record<string, Promise<void> | undefined>).__ptWatchLock;
    resetRouteGlobals();
    for (const k of ['__ptWatchLock', '__ptWatchManager', '__ptWatchRuntime']) delete (globalThis as Record<string, unknown>)[k];
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  const inbox = async () => {
    const raw = await fs.readFile(path.join(mockHome.value, '.purplemux', 'inbox.json'), 'utf-8').catch(() => '{"items":[]}');
    return JSON.parse(raw).items as Array<{ targetTabId: string; line: string; kind: string }>;
  };

  it('labels a watch owned through a hook-time identity hook-identity in watch list (story 36)', async () => {
    const { revokeTabToken, mintHookTabToken } = await import('@/lib/tab-token');
    await revokeTabToken('tab-b'); // tab-b as a tab created before tab tokens
    const hook = await mintHookTabToken({ workspaceId: 'ws-b', tabId: 'tab-b' }, 'pt-ws-b-pane-1-tab-b');
    if (!hook.ok) throw new Error(hook.reason);
    const asHook = { PMUX_PORT: tabB.PMUX_PORT, PMUX_TAB_TOKEN: hook.token };
    const made = await cli(['watch', 'lease', 'merge:x/hook', '--until', 'free'], asHook);
    expect(made.code, made.stderr).toBe(0);
    const { watch } = JSON.parse(made.stdout);
    expect(watch).toMatchObject({ verified: false, identity: 'hook' });
    expect((await cli(['watch', 'list'], asHook)).stdout).toMatch(new RegExp(`${watch.id} .* owner=ws-b/tab-b \\([a-z-]+, hook-identity\\)`));
  });

  it('B waits for merge:x/y held by A; when A releases, the release event alone delivers B one notice', async () => {
    const { startWatches } = await import('@/lib/watch-manager');
    // No timer: only the lease release event can deliver the notice.
    await startWatches({ tickMs: 3_600_000 });
    expect((await cli(['lease', 'acquire', 'merge:x/y'], tabA)).code).toBe(0);
    const made = await cli(['watch', 'lease', 'merge:x/y', '--until', 'free', '--label', 'land after A'], tabB);
    expect(made.code, made.stderr).toBe(0);
    const { watch } = JSON.parse(made.stdout);
    expect(watch).toMatchObject({ kind: 'lease', target: 'merge:x/y', workspaceId: 'ws-b', tabId: 'tab-b', label: 'land after A' });

    const listed = await cli(['watch', 'list'], tabB);
    expect(listed.stdout).toContain(`${watch.id}  lease merge:x/y --until free  owner=ws-b/tab-b (live)`);
    expect(listed.stdout).toContain('label="land after A"');

    expect((await cli(['lease', 'release', 'merge:x/y'], tabA)).code).toBe(0);
    let lines: Array<{ targetTabId: string; line: string }> = [];
    // The release event reaches the watch at once; the bound covers CLI spawns on a busy host.
    for (let i = 0; i < 100 && !lines.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      lines = (await inbox()).filter((l) => l.targetTabId === 'tab-b');
    }
    expect(lines.map((l) => l.line)).toEqual([`[purplemux watch ${watch.id}] merge:x/y is free — watch cleared`]);
    // The pass queues the notice inside its watch-store mutation and writes the list without the watch after it:
    // await that mutation (the lock tail) so the list read sees its write (int-pmx r1, 05 r4 read it in between).
    await (globalThis as unknown as Record<string, Promise<void> | undefined>).__ptWatchLock;
    expect(JSON.parse((await cli(['watch', 'list', '--json'], tabB)).stdout).watches).toEqual([]);
  });

  it('a lease held by the admin token is not free: no notice while any record of it remains', async () => {
    const { startWatches } = await import('@/lib/watch-manager');
    await startWatches({ tickMs: 100 });
    const { getCliToken } = await import('@/lib/cli-token');
    const admin = { PMUX_PORT: tabA.PMUX_PORT, PMUX_TOKEN: getCliToken() };
    expect((await cli(['lease', 'acquire', 'merge:x/y'], admin)).code).toBe(0);
    expect((await cli(['watch', 'lease', 'merge:x/y', '--until', 'free'], tabB)).code).toBe(0);
    await new Promise((r) => setTimeout(r, 1000)); // several passes
    expect((await inbox()).filter((l) => l.kind === 'watch')).toEqual([]);
    expect((await cli(['lease', 'release', 'merge:x/y'], admin)).code).toBe(0);
    await vi.waitFor(async () => expect((await inbox()).filter((l) => l.kind === 'watch')).toHaveLength(1), { timeout: 10_000 });
  });

  it('the owner tab closing removes its watches', async () => {
    const { startWatches } = await import('@/lib/watch-manager');
    await startWatches();
    expect((await cli(['watch', 'lease', 'merge:x/y', '--until', 'free'], tabB)).code).toBe(0);
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    emitTabClosed({ workspaceId: 'ws-b', tabId: 'tab-b', sessionName: 'pt-ws-b-pane-1-tab-b', reason: 'layout-removed' });
    const { readWatches } = await import('@/lib/watch-store');
    await vi.waitFor(async () => expect((await readWatches()).watches).toEqual([]));
  });

  it('refuses a bad target or condition with exit 2; clear by the owner only, an unknown id exits 7', async () => {
    for (const args of [
      ['watch', 'pr', 'not-a-pr', '--until', 'merged'],
      ['watch', 'lease', 'merge:x/y', '--until', 'merged'],
      ['watch', 'ref', 'o/r@main'],
      ['watch', 'pr', 'o/r#1', '--until', 'merged', '--interval', '5'],
    ]) {
      expect((await cli(args, tabB)).code, args.join(' ')).toBe(2);
    }
    const { watch } = JSON.parse((await cli(['watch', 'lease', 'merge:x/y', '--until', 'free'], tabB)).stdout);
    mountClear(watch.id);
    const other = await cli(['watch', 'clear', watch.id], tabA);
    expect(other.code).toBe(3);
    expect(other.stderr).toContain('forbidden');
    const mine = await cli(['watch', 'clear', watch.id], tabB);
    expect(mine.code, mine.stderr).toBe(0);
    expect(JSON.parse(mine.stdout).removed).toMatchObject({ id: watch.id });
    expect((await cli(['watch', 'clear', watch.id], tabB)).code).toBe(7);
  });
});
