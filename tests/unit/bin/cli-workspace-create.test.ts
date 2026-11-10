import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// `purplemux workspace create` end to end: the installed CLI (`bin/purplemux.js`)
// against the real route, the real workspace store and the real token scopes.
// Only tmux, the status manager and the sync broadcast are stand-ins.

const mockHome = vi.hoisted(() => ({ value: '' }));
const status = vi.hoisted(() => ({ registerTab: vi.fn() }));

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
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ registerTab: status.registerTab }) }));

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IResult { code: number; stdout: string; stderr: string }

let server: { port: number; close: () => Promise<void> };
let cliHome: string;
let dirs: { primary: string; other: string };
let env: { outside: Record<string, string>; tab: Record<string, string>; workspace: Record<string, string>; bogus: Record<string, string> };

const cli = async (args: string[], extra: Record<string, string>, cwd?: string): Promise<IResult> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
      cwd,
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', ...extra },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

const storedWorkspaces = async (): Promise<Array<{ id: string; name: string; directories: string[] }>> =>
  JSON.parse(await fs.readFile(path.join(mockHome.value, '.purplemux', 'workspaces.json'), 'utf-8')).workspaces;

describe('purplemux workspace create — the installed CLI against the real route (ADR-0024)', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    status.registerTab.mockClear();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-wscreate-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-wscreate-home-'));
    dirs = { primary: path.join(mockHome.value, 'repo'), other: path.join(mockHome.value, 'docs') };
    await fs.mkdir(dirs.primary);
    await fs.mkdir(dirs.other);
    await writeFixture(mockHome.value, [{ id: 'ws-a', name: 'Alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator' }] }]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const { getCliToken } = await import('@/lib/cli-token');
    const { getWorkspaceToken } = await import('@/lib/workspace-token');
    server = await serveLeaseRoutes({ '/api/cli/workspaces': (await import('@/pages/api/cli/workspaces')).default });
    const port = String(server.port);
    await fs.mkdir(path.join(cliHome, '.purplemux'));
    await fs.writeFile(path.join(cliHome, '.purplemux', 'cli-token'), getCliToken());
    env = {
      outside: { PMUX_PORT: port },
      tab: { PMUX_PORT: port, PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') },
      workspace: { PMUX_PORT: port, PMUX_TOKEN: getWorkspaceToken('ws-a') },
      bogus: { PMUX_PORT: port, PMUX_TOKEN: 'not-a-token' },
    };
  });

  afterEach(async () => {
    await server.close();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('creates the workspace from a shell outside every tab and prints only the new id', async () => {
    const r = await cli(['workspace', 'create', '-n', 'Acme-ledger v2', '-d', dirs.primary, '-d', dirs.other], env.outside);

    expect(r.code, r.stderr).toBe(0);
    const id = r.stdout.trim();
    expect(id).toMatch(/^ws-[\w-]{6}$/);
    const created = (await storedWorkspaces()).find((w) => w.id === id);
    expect(created).toEqual({ id, name: 'Acme-ledger v2', directories: [dirs.primary, dirs.other] });
    const layout = JSON.parse(await fs.readFile(path.join(mockHome.value, '.purplemux', 'workspaces', id, 'layout.json'), 'utf-8'));
    const firstTab = layout.root.tabs[0];
    expect(status.registerTab).toHaveBeenCalledWith(firstTab.id, expect.objectContaining({ workspaceId: id, cliState: 'inactive' }));
    const audit = await fs.readFile(path.join(mockHome.value, '.purplemux', 'audit', 'coordination.jsonl'), 'utf-8');
    expect(JSON.parse(audit.trim())).toMatchObject({ event: 'workspace-create', workspaceId: id, name: 'Acme-ledger v2', by: 'admin' });
  });

  it('--json prints the created workspace with its first tab id', async () => {
    const r = await cli(['workspace', 'create', '--name', 'Json', '--dir', dirs.primary, '--json'], env.outside);
    expect(r.code, r.stderr).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({ name: 'Json', directories: [dirs.primary] });
    expect(body.defaultTabId).toMatch(/^tab-/);
    expect(await cli(['workspaces'], env.outside)).toMatchObject({ code: 0, stdout: expect.stringContaining(body.id) });
  });

  it('resolves relative DIRs against the caller cwd', async () => {
    const r = await cli(['workspace', 'create', '-n', 'Rel', '-d', 'repo', '-d', './docs'], env.outside, mockHome.value);
    expect(r.code, r.stderr).toBe(0);
    expect((await storedWorkspaces()).find((w) => w.name === 'Rel')?.directories).toEqual([dirs.primary, dirs.other]);
  });

  it('refuses a duplicate name, ignoring case, with exit 3 conflict and creates nothing', async () => {
    const r = await cli(['workspace', 'create', '-n', 'alpha', '-d', dirs.primary], env.outside);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('error: conflict');
    expect(r.stderr).toContain('a workspace named "Alpha" already exists (ws-a)');
    expect(r.stdout).toBe('');
    expect((await storedWorkspaces()).map((w) => w.id)).toEqual(['ws-a']);
  });

  it('refuses a primary DIR that does not exist with exit 2 and creates nothing', async () => {
    const missing = path.join(mockHome.value, 'not-there');
    const r = await cli(['workspace', 'create', '-n', 'New', '-d', missing], env.outside);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`primary directory ${missing}: Directory does not exist`);
    expect(await fs.stat(missing).then(() => true, () => false)).toBe(false);
    expect((await storedWorkspaces()).map((w) => w.id)).toEqual(['ws-a']);
  });

  it.each([
    ['a tab token', 'tab'],
    ['a workspace token', 'workspace'],
    ['an unknown token', 'bogus'],
  ] as const)('refuses a caller holding %s with exit 3 forbidden', async (_label, key) => {
    const r = await cli(['workspace', 'create', '-n', 'New', '-d', dirs.primary], env[key]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('error: forbidden');
    expect(r.stderr).toContain('admin token');
    expect((await storedWorkspaces()).map((w) => w.id)).toEqual(['ws-a']);
  });

  it.each([
    ['no -n', ['-d', '/tmp'], '-n NAME is required'],
    ['a blank -n', ['-n', ' ', '-d', '/tmp'], '-n NAME is required'],
    ['-n given twice', ['-n', 'a', '-n', 'b', '-d', '/tmp'], '-n given more than once'],
    ['-n without a value', ['-d', '/tmp', '-n'], '-n needs a value'],
    ['no -d', ['-n', 'a'], 'at least one -d DIR is required'],
    ['-d without a value', ['-n', 'a', '-d'], '-d needs a value'],
    ['an empty -d', ['-n', 'a', '-d', ''], '-d needs a non-empty path'],
    ['a positional argument', ['-n', 'a', '-d', '/tmp', 'extra'], 'unexpected argument: extra'],
    ['an unknown flag', ['-n', 'a', '-d', '/tmp', '-w', 'ws-a'], 'unexpected argument: -w'],
  ])('exits 2 on %s without sending a request', async (_label, args, message) => {
    const r = await cli(['workspace', 'create', ...args], { PMUX_PORT: '1' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(message);
    expect(r.stderr).toContain('usage error');
  });

  it('lists the command in help', async () => {
    const r = await cli(['help'], {});
    expect(r.stdout).toContain('workspace create -n NAME -d DIR [-d DIR...] [--json]');
  });
});
