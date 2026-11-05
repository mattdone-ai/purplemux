import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { translateClaudeHookEvent } from '@/lib/providers/claude/hook-handler';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables } from './tab-events-harness';

const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })), removeTab: vi.fn() }) }));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));

describe('SessionStart source (L30)', () => {
  it('carries a known source and drops anything else', () => {
    expect(translateClaudeHookEvent('session-start', undefined, 'compact')).toEqual({ kind: 'session-start', source: 'compact' });
    expect(translateClaudeHookEvent('session-start', undefined, 'startup')).toEqual({ kind: 'session-start', source: 'startup' });
    expect(translateClaudeHookEvent('session-start', undefined, 'compact; rm -rf')).toEqual({ kind: 'session-start' });
    expect(translateClaudeHookEvent('session-start')).toEqual({ kind: 'session-start' });
    expect(translateClaudeHookEvent('stop', undefined, 'compact')).toEqual({ kind: 'stop' });
  });

  describe('the status hook script', () => {
    let dir: string;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-hook-script-')); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    const run = async (event: string, stdin: string): Promise<unknown> => {
      const { HOOK_SCRIPT_CONTENT } = await import('@/lib/hook-settings');
      const home = path.join(dir, 'home');
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(path.join(home, '.purplemux'), { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(home, '.purplemux', 'port'), '8022');
      fs.writeFileSync(path.join(home, '.purplemux', 'cli-token'), 'tok');
      const script = path.join(dir, 'status-hook.sh');
      fs.writeFileSync(script, HOOK_SCRIPT_CONTENT);
      const captured = path.join(dir, 'payload');
      // The hook POSTs its payload on stdin (ADR-0020).
      fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh\ncase "$*" in *api/status/hook*) cat > '${captured}' ;; esac\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\necho pt-ws-1-pane-a-tab-w\n', { mode: 0o755 });
      const r = spawnSync('sh', [script, event], { input: stdin, env: { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf-8' });
      expect(r.status).toBe(0);
      return JSON.parse(fs.readFileSync(captured, 'utf-8'));
    };

    it('forwards SessionStart\'s source', async () => {
      expect(await run('session-start', JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'compact' })))
        .toEqual({ event: 'session-start', session: 'pt-ws-1-pane-a-tab-w', source: 'compact' });
    });

    it('forwards no source a plain word would not match, and none for other events', async () => {
      expect(await run('session-start', '{"source":"comp\\"act"}')).toEqual({ event: 'session-start', session: 'pt-ws-1-pane-a-tab-w' });
      expect(await run('stop', JSON.stringify({ source: 'compact' }))).toEqual({ event: 'stop', session: 'pt-ws-1-pane-a-tab-w' });
    });
  });
});

describe('a compaction is not a turn end (L30)', () => {
  const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

  const setup = async () => {
    const ws = { id: 'ws-1', name: 'ws', directories: ['/tmp'], orchestration: { enabled: true, orchestratorTabId: 'tab-o' } };
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
    const paste = vi.fn(async (_session: string, _message: string) => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_ws, id) => tab(id)),
      withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
      hasSession: vi.fn(async () => true),
      paste,
    });
    await import('@/lib/providers');
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), ...memoryLedgerTables());
    manager.registerTab('tab-o', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'o', tmuxSession: 'tmux-tab-o', panelType: 'claude-code' });
    const entry: ITabStatusEntry = {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-tab-w', panelType: 'claude-code', agentProviderId: 'claude',
      lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 }, eventSeq: 1,
    };
    manager.registerTab('tab-w', entry);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
    return { manager, entry, paste, settle };
  };

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('keeps a busy tab busy and nudges no one on SessionStart source=compact (the W4 08:29Z case)', async () => {
    const { manager, entry, paste, settle } = await setup();
    manager.handleProviderEvent('claude', 'tmux-tab-w', { kind: 'pre-compact' });
    expect(entry.compactingSince).toEqual(expect.any(Number));
    manager.handleProviderEvent('claude', 'tmux-tab-w', { kind: 'session-start', source: 'compact' });
    await settle();
    expect(entry.cliState).toBe('busy');
    expect(entry.turnEnd).toMatchObject({ kind: 'compacting' });
    expect(entry.compactingSince).toBeNull();
    expect(entry.lastEvent).toMatchObject({ name: 'prompt-submit', seq: 1 });
    expect(paste).not.toHaveBeenCalled();
  });

  it.each([
    ['during a compaction (compactingSince set)', ['pre-compact'] as const],
    ['after a compaction', ['pre-compact', 'post-compact'] as const],
  ])('has no fallback without a source: a sourceless session start %s is today\'s session start (Grok sends none)', async (_label, before) => {
    const { manager, entry, paste } = await setup();
    for (const kind of before) manager.handleProviderEvent('claude', 'tmux-tab-w', { kind });
    if (before.length === 1) expect(entry.compactingSince).toEqual(expect.any(Number));
    manager.handleProviderEvent('claude', 'tmux-tab-w', { kind: 'session-start' });
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(entry.cliState).toBe('idle');
    expect(paste.mock.calls[0][1]).toContain('finished its turn');
  });

  it.each(['startup', 'resume', 'clear'] as const)('keeps today\'s behaviour for source=%s: idle and a turn-ended nudge', async (source) => {
    const { manager, entry, paste } = await setup();
    manager.handleProviderEvent('claude', 'tmux-tab-w', { kind: 'pre-compact' });
    manager.handleProviderEvent('claude', 'tmux-tab-w', { kind: 'session-start', source });
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(entry.cliState).toBe('idle');
    expect(paste.mock.calls[0][1]).toContain('finished its turn');
  });

  it('treats a plain session start with no compaction around it as today (idle, turn-ended)', async () => {
    const { manager, entry, paste } = await setup();
    manager.handleProviderEvent('claude', 'tmux-tab-w', { kind: 'session-start' });
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(entry.cliState).toBe('idle');
  });
});
