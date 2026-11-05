import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
const tmuxCalls = vi.hoisted(() => ({ args: [] as string[][] }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out: unknown) => void) => {
    tmuxCalls.args.push(args);
    cb(null, { stdout: '', stderr: '' });
  };
  return { ...actual, default: { ...actual, execFile }, execFile };
});
vi.mock('@/lib/grok-home', () => ({ ensureWorkspaceGrokHome: vi.fn(async () => '/fake/grok-home') }));
vi.mock('@/lib/providers/grok/hook-config', () => ({ writeGrokHookFile: vi.fn(async () => {}) }));
vi.mock('@/lib/workspace-home', () => ({
  ensureWorkspaceClaudeHome: vi.fn(async () => '/fake/claude-home'),
  workspaceDirectories: vi.fn(async () => []),
  workspaceIdFromSessionName: (name: string) => name.match(/^pt-(ws-.+?)-pane-/)?.[1] ?? null,
}));

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled', '__ptWorkspaceTokens']) {
    delete g[key];
  }
};

/**
 * Runs the exact command tmux would run for the pane, with the login shell
 * swapped for `env`: what it prints is what every process in the tab inherits.
 */
const paneEnvironment = async (): Promise<Record<string, string>> => {
  const newSession = tmuxCalls.args.find((a) => a.includes('new-session'));
  if (!newSession) throw new Error('createSession never called tmux new-session');
  const shellCmd = newSession[newSession.length - 1];
  const probe = shellCmd.replace(/'[^']*' -l$/, '/usr/bin/env');
  expect(probe).not.toBe(shellCmd);
  const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
  const output = execFileSync('/bin/sh', ['-c', probe], { encoding: 'utf8', env: {} as NodeJS.ProcessEnv });
  return Object.fromEntries(output.trim().split('\n').map((line) => {
    const i = line.indexOf('=');
    return [line.slice(0, i), line.slice(i + 1)];
  }));
};

const SESSION = 'pt-ws-a-pane-p1-tab-t1';

describe('a tab created after this change carries its identity', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    tmuxCalls.args = [];
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-env-'));
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    delete process.env.PMUX_TAB_TOKEN;
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('sets PMUX_TAB_TOKEN, PMUX_TAB_ID (the layout id) and PMUX_WORKSPACE_ID beside PMUX_TOKEN', async () => {
    const { createSession } = await import('@/lib/tmux');
    const { resolveTabToken } = await import('@/lib/tab-token');
    const { getWorkspaceToken } = await import('@/lib/workspace-token');

    await createSession(SESSION, 80, 24, undefined, { workspaceId: 'ws-a', tabId: 'tab-t1' });
    const env = await paneEnvironment();

    expect(env.PMUX_TAB_ID).toBe('tab-t1');
    expect(env.PMUX_WORKSPACE_ID).toBe('ws-a');
    expect(env.PMUX_TAB_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveTabToken(env.PMUX_TAB_TOKEN)).toMatchObject({ tabId: 'tab-t1', record: { workspaceId: 'ws-a', sessionName: SESSION } });
    expect(env.PMUX_TOKEN).toBe(getWorkspaceToken('ws-a'));
  });

  it('hands the tab cwd to the claude home, which pre-trusts it inside the workspace (story 05, D14)', async () => {
    const { createSession } = await import('@/lib/tmux');
    const { ensureWorkspaceClaudeHome } = await import('@/lib/workspace-home');
    vi.mocked(ensureWorkspaceClaudeHome).mockClear();
    await createSession(SESSION, 80, 24, mockHome.value, { workspaceId: 'ws-a', tabId: 'tab-t1' });
    await createSession(SESSION, 80, 24, undefined, { workspaceId: 'ws-a', tabId: 'tab-t1' });
    expect(vi.mocked(ensureWorkspaceClaudeHome).mock.calls).toEqual([['ws-a', mockHome.value], ['ws-a', undefined]]);
  });

  it('gives a recreated session of the same tab the same token', async () => {
    const { createSession } = await import('@/lib/tmux');
    await createSession(SESSION, 80, 24, undefined, { workspaceId: 'ws-a', tabId: 'tab-t1' });
    const first = (await paneEnvironment()).PMUX_TAB_TOKEN;

    tmuxCalls.args = [];
    await createSession(SESSION, 80, 24, undefined, { workspaceId: 'ws-a', tabId: 'tab-t1' });
    expect((await paneEnvironment()).PMUX_TAB_TOKEN).toBe(first);
  });

  it('sets no tab identity for a session created without one; the server drops its own at boot', async () => {
    const savedSnapshot = process.env.__PMUX_PRISTINE_ENV;
    delete process.env.__PMUX_PRISTINE_ENV;
    process.env.PMUX_TAB_TOKEN = 'server-own-token';
    const { PRISTINE_ENV } = await import('@/lib/pristine-env');
    const { createSession } = await import('@/lib/tmux');
    if (savedSnapshot === undefined) delete process.env.__PMUX_PRISTINE_ENV;
    else process.env.__PMUX_PRISTINE_ENV = savedSnapshot;
    // A server started from inside a tab drops that tab's identity at boot (story 16 review r1).
    expect(PRISTINE_ENV.PMUX_TAB_TOKEN).toBeUndefined();
    expect(process.env.PMUX_TAB_TOKEN).toBeUndefined();

    await createSession(SESSION, 80, 24);
    const env = await paneEnvironment();

    expect(env.PMUX_TAB_TOKEN).toBeUndefined();
    expect(env.PMUX_TAB_ID).toBeUndefined();
    expect(env.PMUX_WORKSPACE_ID).toBeUndefined();
    expect(env.PMUX_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the workspace scope when the tab token cannot be saved', async () => {
    // A directory where the temp file must go makes the real write fail.
    await fs.mkdir(path.join(mockHome.value, '.purplemux', 'tab-tokens.json.tmp'), { recursive: true });
    const { createSession } = await import('@/lib/tmux');
    const { getTabTokenRecord } = await import('@/lib/tab-token');

    await createSession(SESSION, 80, 24, undefined, { workspaceId: 'ws-a', tabId: 'tab-t1' });
    const env = await paneEnvironment();

    expect(env.PMUX_TAB_TOKEN).toBeUndefined();
    expect(env.PMUX_TAB_ID).toBeUndefined();
    expect(env.PMUX_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/fake/claude-home');
    expect(getTabTokenRecord('tab-t1')).toBeNull();
  });
});
