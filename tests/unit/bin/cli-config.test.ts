import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// Story 24 end to end: the installed CLI (`bin/purplemux.js`) against the real
// fleet-config routes and store in a temp HOME (ADR-0019).

const mockHome = vi.hoisted(() => ({ value: '' }));
const tmux = vi.hoisted(() => ({ sendKeys: vi.fn(async () => {}) }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: tmux.sendKeys,
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

// Each case spawns the CLI up to ten times: vitest's 5 s default fails them on a loaded host (story 13
// gate r6 at load average 105), as the other installed-CLI files already allow for.
describe('purplemux config — the installed CLI against the real fleet-config routes (ADR-0019)', { timeout: 60_000 }, () => {
  let server: { port: number; close: () => Promise<void> };
  let orch: Record<string, string>;
  let worker: Record<string, string>;
  let other: Record<string, string>;
  let admin: Record<string, string>;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
    tmux.sendKeys.mockClear();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-config-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-config-home-'));
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'portfolio', tabs: [{ id: 'tab-o', name: 'orchestrator' }, { id: 'tab-w', name: 'worker' }], orchestratorTabId: 'tab-o' },
      { id: 'ws-b', name: 'other', tabs: [{ id: 'tab-b', name: 'other orchestrator-less' }] },
      { id: 'ws-c', name: 'disabled', tabs: [{ id: 'tab-d', name: 'was the orchestrator' }] },
    ]);
    // ws-c names an orchestrator tab but has orchestration turned off.
    const wsFile = path.join(mockHome.value, '.purplemux', 'workspaces.json');
    const doc = JSON.parse(await fs.readFile(wsFile, 'utf-8'));
    doc.workspaces.find((w: { id: string }) => w.id === 'ws-c').orchestration = { enabled: false, orchestratorTabId: 'tab-d' };
    await fs.writeFile(wsFile, JSON.stringify(doc));
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { getCliToken } = await import('@/lib/cli-token');
    server = await serveLeaseRoutes({
      '/api/cli/fleet-config': (await import('@/pages/api/cli/fleet-config/index')).default,
      '/api/cli/fleet-config/gate.slots': async (req, res) => {
        req.query.key = 'gate.slots';
        return (await import('@/pages/api/cli/fleet-config/[key]')).default(req, res);
      },
      '/api/cli/fleet-config/remote.hosts': async (req, res) => {
        req.query.key = 'remote.hosts';
        return (await import('@/pages/api/cli/fleet-config/[key]')).default(req, res);
      },
      '/api/cli/fleet-config/remote.callback-url': async (req, res) => {
        req.query.key = 'remote.callback-url';
        return (await import('@/pages/api/cli/fleet-config/[key]')).default(req, res);
      },
      '/api/cli/fleet-config/remote.callback-allow-hosts': async (req, res) => {
        req.query.key = 'remote.callback-allow-hosts';
        return (await import('@/pages/api/cli/fleet-config/[key]')).default(req, res);
      },
      '/api/cli/fleet-config/constructor': async (req, res) => {
        req.query.key = 'constructor';
        return (await import('@/pages/api/cli/fleet-config/[key]')).default(req, res);
      },
      ...Object.fromEntries(['flow.window-minutes', 'flow.lock-busy-percent', 'flow.queue-length', 'flow.oldest-minutes',
        'alerts.flags', 'alerts.flag-repeat-minutes'].map((key) => [
        `/api/cli/fleet-config/${key}`,
        async (req: NextApiRequest, res: NextApiResponse) => {
          req.query.key = key;
          return (await import('@/pages/api/cli/fleet-config/[key]')).default(req, res);
        },
      ])),
    });
    const port = String(server.port);
    orch = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-o' }, 'pt-ws-a-pane-1-tab-o') };
    worker = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-w' }, 'pt-ws-a-pane-1-tab-w') };
    other = { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b' }, 'pt-ws-b-pane-1-tab-b') };
    admin = { PMUX_PORT: port, PMUX_TOKEN: getCliToken() };
  });

  afterEach(async () => {
    await server.close();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  const auditLines = async () => {
    const raw = await fs.readFile(path.join(mockHome.value, '.purplemux', 'audit', 'coordination.jsonl'), 'utf-8').catch(() => '');
    return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it('the orchestrator sets gate.slots; every tab reads the bare value; the version increments', async () => {
    const first = await cli(['config', 'set', 'gate.slots', '4'], orch);
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ key: 'gate.slots', changed: true, value: { value: '4', version: 1 } });
    const second = await cli(['config', 'set', 'gate.slots', '6'], orch);
    expect(JSON.parse(second.stdout).value).toMatchObject({ value: '6', version: 2, setBy: { workspaceId: 'ws-a', tabId: 'tab-o', admin: false } });
    for (const env of [orch, worker, other, admin]) {
      expect(await cli(['config', 'get', 'gate.slots'], env)).toEqual({ code: 0, stdout: '6\n', stderr: '' });
    }
  });

  it('the flow.* thresholds keep the ADR-0019 writer rule: the orchestrator or the admin token (purplemux-flow story 02)', async () => {
    for (const key of ['flow.window-minutes', 'flow.lock-busy-percent', 'flow.queue-length', 'flow.oldest-minutes']) {
      const byOrch = await cli(['config', 'set', key, '30'], orch);
      expect(byOrch.code, byOrch.stderr).toBe(0);
      expect((await cli(['config', 'set', key, '40'], admin)).code).toBe(0);
      const byWorker = await cli(['config', 'set', key, '50'], worker);
      expect(byWorker.code).toBe(3);
      expect(byWorker.stderr).toContain('forbidden');
      expect((await cli(['config', 'get', key], worker)).stdout).toBe('40\n');
    }
  });

  it('alerts.* keys are the admin token\'s only (ADR-0032, ruling R2)', async () => {
    for (const [key, value] of [['alerts.flags', 'off'], ['alerts.flag-repeat-minutes', '30']]) {
      for (const env of [orch, worker]) {
        const refused = await cli(['config', 'set', key, value], env);
        expect(refused.code, key).toBe(3);
        expect(refused.stderr).toContain('admin token only');
      }
      expect((await cli(['config', 'set', key, value], admin)).code, key).toBe(0);
      expect((await cli(['config', 'get', key], worker)).stdout).toBe(`${value}\n`);
      expect((await cli(['config', 'unset', key], orch)).code, key).toBe(3);
    }
  });

  it('remote.* keys are the admin token\'s only, and their values are checked at write time (ADR-0022, review r3 nit 4)', async () => {
    const byOrch = await cli(['config', 'set', 'remote.hosts', 'host-b'], orch);
    expect(byOrch.code).toBe(3);
    expect(byOrch.stderr).toContain('admin token only');
    expect((await cli(['config', 'set', 'remote.hosts', 'host-b'], admin)).code).toBe(0);
    expect((await cli(['config', 'set', 'remote.hosts', 'host-b,-oProxyCommand=x'], admin)).code).toBe(2);
    const plain = await cli(['config', 'set', 'remote.callback-url', 'http://example.com:8022'], admin);
    expect(plain.code).toBe(2);
    expect(plain.stderr).toContain('use https otherwise');
    for (const ok of ['http://100.64.0.114:8022', 'http://host-a.example.ts.net:8022', 'https://pmux.example.com']) {
      expect((await cli(['config', 'set', 'remote.callback-url', ok], admin)).code, ok).toBe(0);
    }
    expect((await cli(['config', 'set', 'remote.callback-url', 'http://2130706433:8022'], admin)).code).toBe(2);
    expect((await cli(['config', 'set', 'remote.callback-url', 'http://host-a:8022'], admin)).code).toBe(2);
    expect((await cli(['config', 'set', 'remote.callback-allow-hosts', 'host-a'], orch)).code).toBe(3);
    expect((await cli(['config', 'set', 'remote.callback-allow-hosts', '0x7f000001'], admin)).code).toBe(2);
    expect((await cli(['config', 'set', 'remote.callback-allow-hosts', 'host-a'], admin)).code).toBe(0);
    expect((await cli(['config', 'set', 'remote.callback-url', 'http://host-a:8022'], admin)).code).toBe(0);
    expect((await cli(['config', 'unset', 'remote.callback-url'], orch)).code).toBe(3);
  });

  it('a worker tab, a tab of an orchestrator-less workspace and a workspace token with no tab are refused with exit 3', async () => {
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    const wsToken = { PMUX_PORT: orch.PMUX_PORT, PMUX_TOKEN: getWorkspaceToken('ws-a') };
    for (const env of [worker, other, wsToken]) {
      const r = await cli(['config', 'set', 'gate.slots', '6'], env);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain('forbidden');
    }
    expect((await cli(['config', 'get', 'gate.slots'], worker)).code).toBe(7);
    expect((await cli(['config', 'set', 'gate.slots', '6'], admin)).code).toBe(0);
    expect((await cli(['config', 'unset', 'gate.slots'], worker)).code).toBe(3);
  });

  it('an orchestrator tab of a workspace with orchestration off is refused', async () => {
    const { ensureTabToken } = await import('@/lib/tab-token');
    const disabled = { PMUX_PORT: orch.PMUX_PORT, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-c', tabId: 'tab-d' }, 'pt-ws-c-pane-1-tab-d') };
    const r = await cli(['config', 'set', 'gate.slots', '6'], disabled);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('forbidden');
  });

  it('a legacy tab (workspace token + X-Pmux-Session) writes only as the orchestrator, audited unverified', async () => {
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    const handler = (await import('@/pages/api/cli/fleet-config/[key]')).default;
    const put = (session: string) => callRoute(handler, {
      method: 'PUT',
      headers: { 'x-pmux-token': getWorkspaceToken('ws-a'), 'x-pmux-session': session },
      query: { key: 'gate.slots' },
      body: { value: '6' },
    });
    expect(await put('pt-ws-a-pane-1-tab-w')).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(await put('pt-ws-a-pane-1-tab-o')).toMatchObject({ status: 200, body: { key: 'gate.slots', version: 1, changed: true } });
    await drainRouteLocks();
    expect(await auditLines()).toMatchObject([{ event: 'fleet-config-set', by: { workspaceId: 'ws-a', tabId: 'tab-o', admin: false, verified: false, identity: 'session' } }]);
  });

  // ADR-0027 maps config-store-unreadable to exit 3 (refused by state) in the one table.
  it('a malformed store exits 3 with nothing on stdout, never 7 (unset) and never read as empty', async () => {
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'fleet-config.json'), '{"values":');
    const r = await cli(['config', 'get', 'gate.slots'], worker);
    expect(r).toMatchObject({ code: 3, stdout: '' });
    expect(r.stderr).toContain('config-store-unreadable');
    expect((await cli(['config', 'set', 'gate.slots', '6'], orch)).code).toBe(3);
  });

  it('a stale --expect-version exits 3 config-version-conflict and leaves the value', async () => {
    for (const v of ['1', '2', '3', '4']) await cli(['config', 'set', 'gate.slots', v], orch);
    const stale = await cli(['config', 'set', 'gate.slots', '6', '--expect-version', '3'], orch);
    expect(stale.code).toBe(3);
    expect(stale.stderr).toContain('config-version-conflict');
    expect(stale.stderr).toContain('gate.slots is at version 4; expected 3');
    expect((await cli(['config', 'get', 'gate.slots'], worker)).stdout).toBe('4\n');
    expect((await cli(['config', 'set', 'gate.slots', '6', '--expect-version', '4'], orch)).code).toBe(0);
  });

  it('an unset key exits 7 with nothing on stdout; unset of an unset key exits 7', async () => {
    const r = await cli(['config', 'get', 'gate.slots'], worker);
    expect(r).toMatchObject({ code: 7, stdout: '' });
    expect(r.stderr).toContain('config-not-found');
    expect((await cli(['config', 'unset', 'gate.slots'], orch)).code).toBe(7);
    await cli(['config', 'set', 'gate.slots', '6'], orch);
    expect((await cli(['config', 'unset', 'gate.slots'], orch)).code).toBe(0);
    expect((await cli(['config', 'get', 'gate.slots'], worker)).code).toBe(7);
  });

  it('a change messages nobody: no keys typed, no inbox item; the audit file gains one line per change', async () => {
    await cli(['config', 'set', 'gate.slots', '6'], orch);
    await cli(['config', 'set', 'gate.slots', '6'], orch); // the held value: not a change
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    await expect(fs.access(path.join(mockHome.value, '.purplemux', 'inbox.json'))).rejects.toThrow();
    const lines = await auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: 'fleet-config-set', key: 'gate.slots', oldValue: null, newValue: '6', version: 1,
      by: { workspaceId: 'ws-a', tabId: 'tab-o', admin: false, verified: true },
    });
  });

  it('history lists each change with when, who, old and new value; list shows the current values', async () => {
    await cli(['config', 'set', 'gate.slots', '4'], orch);
    await cli(['config', 'set', 'gate.slots', '6'], admin);
    await cli(['config', 'unset', 'gate.slots'], orch);
    const h = await cli(['config', 'history', 'gate.slots'], worker);
    expect(h.code, h.stderr).toBe(0);
    const rows = h.stdout.trim().split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^\d{4}-\d\d-\d\dT\S+Z {2}gate\.slots {2}\(unset\) -> 4 {2}v1 {2}by ws-a\/tab-o$/);
    expect(rows[1]).toMatch(/ {2}gate\.slots {2}4 -> 6 {2}v2 {2}by admin$/);
    expect(rows[2]).toMatch(/ {2}gate\.slots {2}6 -> \(unset\) {2}v3 {2}by ws-a\/tab-o$/);
    expect(JSON.parse((await cli(['config', 'history', '--json'], worker)).stdout).history).toHaveLength(3);
    expect((await cli(['config', 'list'], worker)).stdout).toBe('no fleet config set\n');
    await cli(['config', 'set', 'gate.slots', '6'], orch);
    expect((await cli(['config', 'list'], worker)).stdout).toMatch(/^gate\.slots=6 {2}v4 {2}set \S+Z by ws-a\/tab-o\n$/);
  });

  it('the key constructor is not the built-in: unset exits 7, and a set, get and unset keep the store readable', async () => {
    expect(await cli(['config', 'get', 'constructor'], worker)).toMatchObject({ code: 7, stdout: '' });
    expect((await cli(['config', 'unset', 'constructor'], orch)).code).toBe(7);
    const set = await cli(['config', 'set', 'constructor', 'x', '--expect-version', '0'], orch);
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ key: 'constructor', version: 1 });
    expect(await cli(['config', 'get', 'constructor'], worker)).toEqual({ code: 0, stdout: 'x\n', stderr: '' });
    expect((await cli(['config', 'unset', 'constructor'], orch)).code).toBe(0);
    expect((await cli(['config', 'set', 'gate.slots', '6'], orch)).code).toBe(0);
    expect((await cli(['config', 'get', 'gate.slots'], worker)).stdout).toBe('6\n');
  });

  it('refuses a malformed command with exit 2 before anything is sent', async () => {
    for (const args of [
      ['config', 'set', 'Gate.Slots', '6'],
      ['config', 'set', 'gate.slots'],
      ['config', 'set', 'gate.slots', '6', '--expect-version', 'four'],
      ['config', 'get'],
      ['config', 'frobnicate'],
    ]) {
      expect((await cli(args, orch)).code, args.join(' ')).toBe(2);
    }
    expect(await auditLines()).toEqual([]);
    // The server refuses this one: a refusal to a launch-verified tab is audited (ADR-0045 review r1), never with the value.
    const bad = await cli(['config', 'set', 'gate.slots', 'x'.repeat(300)], orch);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('config-invalid');
    const lines = await auditLines();
    expect(lines).toEqual([expect.objectContaining({ event: 'fleet-config-refused', action: 'set', key: 'gate.slots', code: 'config-invalid', refusal: 'invalid', reason: null })]);
    expect(JSON.stringify(lines)).not.toContain('x'.repeat(300));
  });
});
