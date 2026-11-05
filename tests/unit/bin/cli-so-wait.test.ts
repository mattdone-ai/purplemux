import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, loadLeaseRoutes, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// Story 14 end to end: the installed CLI against the real standing-order and watch routes and stores.

const mockHome = vi.hoisted(() => ({ value: '' }));
const routed = vi.hoisted(() => [] as Array<{ tabId: string; kind: string; class: string; text: string }>);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
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
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    liveAgentTabs: (ws: string | null) => [{ workspaceId: 'ws-a', tabId: 'tab-a' }, { workspaceId: 'ws-b', tabId: 'tab-b' }]
      .filter((t) => ws === null || t.workspaceId === ws),
    routeTabEvent: async (event: { tabId: string; kind: string; class: string; text: string }) => {
      routed.push({ tabId: event.tabId, kind: event.kind, class: event.class, text: event.text });
      return { class: event.class, delivered: true, seq: routed.length, duplicate: false };
    },
  }),
}));

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

describe('purplemux so and wait — the installed CLI against the real routes (story 14)', { timeout: 60_000 }, () => {
  let server: { port: number; close: () => Promise<void> };
  let tabA: Record<string, string>;
  let tabB: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    routed.length = 0;
    const g = globalThis as Record<string, unknown>;
    for (const k of ['__ptWatchLock', '__ptWatchManager', '__ptWatchRuntime', '__ptStandingOrdersLock']) delete g[k];
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-so-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-so-home-'));
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a', name: 'one' }] },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b', name: 'two' }] },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const strike = (await import('@/pages/api/cli/standing-orders/[id]/strike')).default;
    const routes: Record<string, Parameters<typeof callRoute>[0]> = {
      ...(await loadLeaseRoutes()),
      '/api/cli/watches': (await import('@/pages/api/cli/watches/index')).default,
      '/api/cli/standing-orders': (await import('@/pages/api/cli/standing-orders/index')).default,
    };
    for (const id of ['SO-1', 'SO-8', 'SO-99']) {
      routes[`/api/cli/standing-orders/${id}/strike`] = (req, res) => {
        req.query.id = id;
        return strike(req, res);
      };
    }
    server = await serveLeaseRoutes(routes);
    const port = String(server.port);
    tabA = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a' }, 'pt-ws-a-pane-1-tab-a') };
    tabB = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b' }, 'pt-ws-b-pane-1-tab-b') };
  });

  afterEach(async () => {
    await server.close();
    await drainRouteLocks();
    resetRouteGlobals();
    for (const k of ['__ptWatchLock', '__ptWatchManager', '__ptWatchRuntime', '__ptStandingOrdersLock']) delete (globalThis as Record<string, unknown>)[k];
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('so add writes the order, its workspace prompt and one urgent line per live tab; so list and so strike follow', async () => {
    const added = await cli(['so', 'add', '-w', 'ws-a', '--text', 'Land WIP before new work.', '--source', 'owner message ws-a/x1, 2026-11-03T01:00Z'], tabA);
    expect(added.code, added.stderr).toBe(0);
    expect(added.stdout).toMatch(/^SO-8 added \(ws-a\); its prompt section is \d+ bytes of 8192; 1 prompt file\(s\) rewritten, 1 live tab\(s\) told\n$/);
    expect(routed).toEqual([{ tabId: 'tab-a', kind: 'standing-order', class: 'urgent',
      text: '[purplemux standing order] SO-8 added (ws-a): Land WIP before new work. — it holds until struck; purplemux so list shows every order' }]);
    const prompt = await fs.readFile(path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a', 'claude-prompt.md'), 'utf-8');
    expect(prompt).toContain('- **SO-8** (ws-a; check: prose) Land WIP before new work.');
    expect(prompt).toContain('- **SO-1** (fleet; check: prose)');

    const listed = await cli(['so', 'list'], tabA);
    expect(listed.stdout).toContain('SO-8  [ws-a; scope ws-a; check prose]  Land WIP before new work.\n    source: owner message ws-a/x1, 2026-11-03T01:00Z');
    expect((await cli(['so', 'list'], tabB)).stdout).not.toContain('SO-8');

    const refusedFleet = await cli(['so', 'add', '--fleet', '--text', 't', '--source', 's'], tabA);
    expect(refusedFleet.code).toBe(3);
    expect(refusedFleet.stderr).toMatch(/^error: forbidden .*fleet order is added or struck with the admin token/);
    expect((await cli(['so', 'strike', 'SO-8', '--reason', 'done'], tabB)).code).toBe(3);

    const struck = await cli(['so', 'strike', 'SO-8', '--reason', 'WIP landed'], tabA);
    expect(struck.code, struck.stderr).toBe(0);
    expect(struck.stdout).toBe('SO-8 struck (ws-a); 1 prompt file(s) rewritten, 1 live tab(s) told\n');
    expect((await cli(['so', 'list', '--all'], tabA)).stdout).toMatch(/SO-8 .*\n {4}source: .*  STRUCK 20\d\d-\d\d-\d\dT\d\d:\d\d:\d\dZ — WIP landed/);
    expect((await cli(['so', 'strike', 'SO-99', '--reason', 'x'], tabA)).code).toBe(7);
    // A struck order is refused by state (N10): exit 3, not a usage error.
    const again = await cli(['so', 'strike', 'SO-8', '--reason', 'again'], tabA);
    expect(again.code).toBe(3);
    expect(again.stderr).toMatch(/^error: so-struck \(conflict/);
    // A corrupt id high-water file is refused by state (confirm NIT 3): exit 3, nothing written.
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'standing-orders-seq.json'), '{');
    const corrupt = await cli(['so', 'add', '-w', 'ws-a', '--text', 'next', '--source', 's'], tabA);
    expect(corrupt.code).toBe(3);
    expect(corrupt.stderr).toMatch(/^error: so-unreadable .*standing-orders-seq\.json: not JSON/);
  });

  it('so add over 8 KB exits 2 with the measured size; a bad field exits 2 naming it', async () => {
    let refused: IResult | null = null;
    for (let i = 0; i < 20 && !refused; i++) {
      const r = await cli(['so', 'add', '-w', 'ws-a', '--text', `${i} ${'x'.repeat(560)}`, '--source', 's'], tabA);
      if (r.code !== 0) refused = r;
    }
    expect(refused?.code).toBe(2);
    expect(refused?.stderr).toMatch(/^error: so-too-large \(usage error — fix the command\) — standing orders for ws-a would be \d{4} bytes, at most 8192/);
    const bad = await cli(['so', 'add', '-w', 'ws-a', '--text', 'x'.repeat(601), '--source', 's'], tabA);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('so-invalid');
    expect(bad.stderr).toContain('text: 601 characters, at most 600');
    expect((await cli(['so', 'add', '--text', 't', '--source', 's'], tabA)).code).toBe(2);
  });

  it('wait add --auth registers an auth watch on the profile; a profile that is not SSO exits 2', async () => {
    await fs.mkdir(path.join(mockHome.value, '.aws'), { recursive: true });
    await fs.writeFile(path.join(mockHome.value, '.aws', 'config'), '[profile dev]\nsso_session = corp\n\n[sso-session corp]\nsso_start_url = https://corp.awsapps.com/start\n\n[profile keys]\nregion = ap-southeast-2\n');
    const made = await cli(['wait', 'add', '--auth', 'dev', '--item', 'deploy:dev:abc123def456'], tabA);
    expect(made.code, made.stderr).toBe(0);
    expect(JSON.parse(made.stdout).watch).toMatchObject({
      kind: 'auth', target: 'aws-sso:dev', until: 'signed-in', intervalS: 60, ledgerItem: 'deploy:dev:abc123def456', workspaceId: 'ws-a', tabId: 'tab-a',
    });
    const refused = await cli(['wait', 'add', '--auth', 'keys'], tabA);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('watch-invalid');
    expect(refused.stderr).toContain('profile keys has no sso_session or sso_start_url');
    expect((await cli(['wait', 'add'], tabA)).code).toBe(2);
  });
});
