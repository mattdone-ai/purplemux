import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import { LedgerStore } from '@/lib/ledger-store';
import type { ITab, TPanelType } from '@/types/terminal';

// The status manager's turn rows (story 15, ADR-0035 §7): what the hooks show of each turn reaches tab_turns.

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: vi.fn(async () => undefined),
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [] })),
}));
// The curator's turn-end hook is fire-and-forget; its module chain must not load after this file's environment is gone.
vi.mock('@/lib/curator-service', () => ({ curatorOnUnmarkedTurnEnd: vi.fn() }));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ statusForTab: vi.fn(), removeTab: vi.fn() }) }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
  getAllPanesInfo: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

let ledger: LedgerStore;

const manager = async (panelType: TPanelType) => {
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste: vi.fn(async () => {}),
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const m = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), () => ledger.tabEvents, () => ledger.tabTurns);
  m.registerTab('tab-w', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType });
  return m;
};

const turns = () => ledger.tabTurns.endedSince('ws-1', 0).map(({ provider, toolCalls, startedAt }) => ({ provider, toolCalls, started: startedAt !== null }));

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-sm-turns-'));
  ledger = new LedgerStore(':memory:');
});

afterEach(async () => {
  ledger.close();
  await fs.rm(mockHome.value, { recursive: true, force: true });
});

describe('turn rows from the hooks', () => {
  it('writes one row per Claude turn with its acting tool calls', async () => {
    const m = await manager('claude-code');
    m.updateTabFromHook('tmux-w', 'prompt-submit');
    m.handleToolActivity('claude', 'tmux-w', { tool: 'Bash', paths: [], failed: false });
    m.handleToolActivity('claude', 'tmux-w', { tool: 'Edit', paths: ['/x'], failed: false });
    m.updateTabFromHook('tmux-w', 'stop');
    m.updateTabFromHook('tmux-w', 'prompt-submit');
    m.updateTabFromHook('tmux-w', 'interrupt');
    expect(turns()).toEqual([{ provider: 'claude', toolCalls: 2, started: true }, { provider: 'claude', toolCalls: 0, started: true }]);
    expect(ledger.tabTurns.measuredSince()).not.toBeNull();
  });

  it('opens a Codex turn with a start only on UserPromptSubmit; a tool event opens one of unknown start (review R5)', async () => {
    const m = await manager('codex-cli');
    m.handleProviderEvent('codex', 'tmux-w', { kind: 'prompt-submit', fromTool: true });
    m.handleToolCall('codex', 'tmux-w', 'exec_command', Date.now());
    m.handleProviderEvent('codex', 'tmux-w', { kind: 'stop' });
    m.handleProviderEvent('codex', 'tmux-w', { kind: 'prompt-submit' });
    m.handleProviderEvent('codex', 'tmux-w', { kind: 'prompt-submit', fromTool: true });
    m.handleToolCall('codex', 'tmux-w', 'apply_patch', Date.now());
    m.handleProviderEvent('codex', 'tmux-w', { kind: 'stop' });
    expect(turns()).toEqual([{ provider: 'codex', toolCalls: null, started: false }, { provider: 'codex', toolCalls: 1, started: true }]);
  });

  it('ends a running turn at a session start, with no count (review R5)', async () => {
    const m = await manager('claude-code');
    m.updateTabFromHook('tmux-w', 'prompt-submit');
    m.handleToolActivity('claude', 'tmux-w', { tool: 'Bash', paths: [], failed: false });
    m.updateTabFromHook('tmux-w', 'session-start', undefined, 'startup');
    expect(turns()).toEqual([{ provider: 'claude', toolCalls: null, started: true }]);
    expect([...m.openTurns('ws-1')]).toEqual([]);
  });

  it('counts a Codex PostToolUse that acts, and not one that reads', async () => {
    const m = await manager('codex-cli');
    m.updateTabFromHook('tmux-w', 'prompt-submit');
    m.handleToolCall('codex', 'tmux-w', 'exec_command', Date.now());
    m.handleToolCall('codex', 'tmux-w', 'read_file', Date.now());
    m.handleToolCall('claude', 'tmux-w', 'Bash', Date.now());
    m.updateTabFromHook('tmux-w', 'stop');
    expect(turns()).toEqual([{ provider: 'codex', toolCalls: 1, started: true }]);
  });

  it('records a turn already running when the server started as unmeasured', async () => {
    const m = await manager('grok-cli');
    m.handleToolActivity('grok', 'tmux-w', { tool: 'search_replace', paths: ['/x'], failed: false });
    m.updateTabFromHook('tmux-w', 'stop');
    expect(turns()).toEqual([{ provider: 'grok', toolCalls: null, started: false }]);
  });

  it('drops the open turn of a closed tab', async () => {
    const m = await manager('claude-code');
    m.updateTabFromHook('tmux-w', 'prompt-submit');
    m.removeTab('tab-w');
    expect(turns()).toEqual([]);
  });

  it('never fails a hook when the ledger cannot take the turn', async () => {
    const m = await manager('claude-code');
    ledger.close();
    m.updateTabFromHook('tmux-w', 'prompt-submit');
    expect(() => m.updateTabFromHook('tmux-w', 'stop')).not.toThrow();
    ledger = new LedgerStore(':memory:');
  });
});
