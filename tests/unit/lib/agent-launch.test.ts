import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentProvider } from '@/lib/providers/types';

// ADR-0028 §8: one launcher for tab create, auto-resume and tab restart.

const claude = vi.hoisted(() => ({
  buildClaudeFlags: vi.fn(async () => '--settings hooks.json'),
  buildRemoteClaudeLaunch: vi.fn(async () => 'remote-claude-launch'),
}));
const grok = vi.hoisted(() => ({ buildLaunchCommand: vi.fn(async () => 'grok --model g') }));
const managed = vi.hoisted(() => ({
  prepareCodexManagedLaunch: vi.fn(),
  prepareCodexManagedLaunchLocked: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunchLocked: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));
const tmux = vi.hoisted(() => ({ sendKeysSeparated: vi.fn(async () => {}) }));
const activity = vi.hoisted(() => ({ recordOrchestrationLaunch: vi.fn(async () => {}) }));
const markAgentLaunch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/claude-command', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/claude-command')>()), ...claude }));
vi.mock('@/lib/providers/grok', () => ({ grokProvider: grok }));
vi.mock('@/lib/providers/codex', () => ({ CODEX_PROVIDER_ID: 'codex' }));
vi.mock('@/lib/providers/codex/managed-launch', () => managed);
vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/orchestration-activity', () => activity);
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ markAgentLaunch }) }));

const PINS = { model: 'm-1', effort: 'high' };
const target = { workspaceId: 'ws-a', tabId: 'tab-a', sessionName: 'pt-ws-a-pane-1-tab-a', panelType: 'claude-code' as const, agentLaunchConfig: PINS };
const claudeProvider = { id: 'claude', buildResumeCommand: vi.fn(async () => 'claude --resume s-1') } as unknown as IAgentProvider;
const codexProvider = { id: 'codex', buildResumeCommand: vi.fn() } as unknown as IAgentProvider;

describe('buildFreshLaunchCommand', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds the local claude command with the pinned model and effort', async () => {
    const { buildFreshLaunchCommand } = await import('@/lib/agent-launch');
    expect(await buildFreshLaunchCommand('ws-a', { panelType: 'claude-code', agentLaunchConfig: PINS })).toBe('claude --settings hooks.json');
    expect(claude.buildClaudeFlags).toHaveBeenCalledWith('ws-a', PINS);
  });

  it('builds the remote claude launch for a remote tab', async () => {
    const { buildFreshLaunchCommand } = await import('@/lib/agent-launch');
    expect(await buildFreshLaunchCommand('ws-a', { panelType: 'claude-code', host: 'host-b', agentLaunchConfig: PINS })).toBe('remote-claude-launch');
    expect(claude.buildRemoteClaudeLaunch).toHaveBeenCalledWith('ws-a', PINS);
  });

  it('builds the grok command, never codex in a grok tab', async () => {
    const { buildFreshLaunchCommand } = await import('@/lib/agent-launch');
    expect(await buildFreshLaunchCommand('ws-a', { panelType: 'grok-cli', agentLaunchConfig: PINS })).toBe('grok --model g');
    expect(grok.buildLaunchCommand).toHaveBeenCalledWith({ workspaceId: 'ws-a', ...PINS });
  });

  it.each(['codex-cli', 'terminal', undefined] as const)('has no typed command for %s', async (panelType) => {
    const { buildFreshLaunchCommand } = await import('@/lib/agent-launch');
    expect(await buildFreshLaunchCommand('ws-a', { panelType })).toBeUndefined();
  });
});

describe('launchCodexManaged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const prepare of [managed.prepareCodexManagedLaunch, managed.prepareCodexManagedLaunchLocked]) {
      prepare.mockResolvedValue({ ok: true, launch: { generation: 'g-1' } });
    }
    for (const submit of [managed.submitCodexManagedLaunch, managed.submitCodexManagedLaunchLocked]) {
      submit.mockResolvedValue({ ok: true, generation: 'g-1', phase: 'submitted' });
    }
    managed.waitForCodexManagedLaunch.mockResolvedValue({ ok: true, generation: 'g-1', phase: 'active' });
  });

  it('prepares, submits and confirms without the target lock (tab create)', async () => {
    const { launchCodexManaged } = await import('@/lib/agent-launch');
    expect(await launchCodexManaged('ws-a', 'tab-a')).toEqual({ ok: true, generation: 'g-1', phase: 'active' });
    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith('ws-a', 'tab-a');
    expect(managed.submitCodexManagedLaunch).toHaveBeenCalledWith('ws-a', 'tab-a', 'g-1');
    expect(managed.waitForCodexManagedLaunch).toHaveBeenCalledWith('ws-a', 'tab-a', 'g-1');
    expect(managed.prepareCodexManagedLaunchLocked).not.toHaveBeenCalled();
  });

  it('under a held target lock uses the locked steps and leaves the confirmation to the caller', async () => {
    const { launchCodexManaged } = await import('@/lib/agent-launch');
    expect(await launchCodexManaged('ws-a', 'tab-a', { resumeSessionId: null, targetLockHeld: true })).toEqual({ ok: true, generation: 'g-1', phase: 'submitted' });
    expect(managed.prepareCodexManagedLaunchLocked).toHaveBeenCalledWith('ws-a', 'tab-a', null);
    expect(managed.submitCodexManagedLaunchLocked).toHaveBeenCalledWith('ws-a', 'tab-a', 'g-1');
    expect(managed.prepareCodexManagedLaunch).not.toHaveBeenCalled();
    expect(managed.submitCodexManagedLaunch).not.toHaveBeenCalled();
    expect(managed.waitForCodexManagedLaunch).not.toHaveBeenCalled();
  });

  it('names the step that failed', async () => {
    const { launchCodexManaged } = await import('@/lib/agent-launch');
    managed.prepareCodexManagedLaunch.mockResolvedValueOnce({ ok: false, reason: 'not-codex-tab' });
    expect(await launchCodexManaged('ws-a', 'tab-a')).toEqual({ ok: false, step: 'prepare', reason: 'not-codex-tab' });
    managed.submitCodexManagedLaunch.mockResolvedValueOnce({ ok: false, generation: 'g-1', phase: 'held', reason: 'terminal-not-ready:tmux' });
    expect(await launchCodexManaged('ws-a', 'tab-a')).toEqual({ ok: false, step: 'submit', reason: 'terminal-not-ready:tmux', generation: 'g-1', phase: 'held' });
    managed.waitForCodexManagedLaunch.mockResolvedValueOnce({ ok: false, generation: 'g-1', phase: 'submitted', reason: 'launch-confirmation-pending' });
    expect(await launchCodexManaged('ws-a', 'tab-a')).toEqual({ ok: false, step: 'activate', reason: 'launch-confirmation-pending', generation: 'g-1', phase: 'submitted' });
  });
});

describe('launchAgentInTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managed.prepareCodexManagedLaunch.mockResolvedValue({ ok: true, launch: { generation: 'g-1' } });
    managed.submitCodexManagedLaunch.mockResolvedValue({ ok: true, generation: 'g-1', phase: 'submitted' });
    managed.waitForCodexManagedLaunch.mockResolvedValue({ ok: true, generation: 'g-1', phase: 'active' });
  });

  it('resumes with the provider command and the persisted pins, then records the launch before typing it', async () => {
    const { launchAgentInTab } = await import('@/lib/agent-launch');
    const order: string[] = [];
    activity.recordOrchestrationLaunch.mockImplementationOnce(async () => { order.push('record'); });
    tmux.sendKeysSeparated.mockImplementationOnce(async () => { order.push('type'); });

    expect(await launchAgentInTab(target, { provider: claudeProvider, resumeSessionId: 's-1' })).toEqual({ kind: 'command', resumed: true });

    expect(claudeProvider.buildResumeCommand).toHaveBeenCalledWith('s-1', { workspaceId: 'ws-a', ...PINS });
    expect(activity.recordOrchestrationLaunch).toHaveBeenCalledWith('ws-a', 'tab-a', 'pt-ws-a-pane-1-tab-a');
    expect(markAgentLaunch).toHaveBeenCalledWith('tab-a');
    expect(tmux.sendKeysSeparated).toHaveBeenCalledWith('pt-ws-a-pane-1-tab-a', 'claude --resume s-1');
    expect(order).toEqual(['record', 'type']);
  });

  it('a fresh launch that replaces the session resets the tab\'s agent session', async () => {
    const { launchAgentInTab } = await import('@/lib/agent-launch');
    expect(await launchAgentInTab(target, { provider: claudeProvider, resumeSessionId: null, resetAgentSession: true })).toEqual({ kind: 'command', resumed: false });
    expect(claudeProvider.buildResumeCommand).not.toHaveBeenCalled();
    expect(markAgentLaunch).toHaveBeenCalledWith('tab-a', { resetAgentSession: true });
    expect(tmux.sendKeysSeparated).toHaveBeenCalledWith('pt-ws-a-pane-1-tab-a', 'claude --settings hooks.json');
  });

  it('launches Codex through its managed path, never a typed command', async () => {
    const { launchAgentInTab } = await import('@/lib/agent-launch');
    const result = await launchAgentInTab({ ...target, panelType: 'codex-cli' }, { provider: codexProvider, resumeSessionId: 'c-1' });
    expect(result).toEqual({ kind: 'codex', resumed: true, outcome: { ok: true, generation: 'g-1', phase: 'active' } });
    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith('ws-a', 'tab-a', 'c-1');
    expect(tmux.sendKeysSeparated).not.toHaveBeenCalled();
    expect(activity.recordOrchestrationLaunch).not.toHaveBeenCalled();
  });

  it('refuses a tab with no launch command, typing nothing', async () => {
    const { launchAgentInTab } = await import('@/lib/agent-launch');
    await expect(launchAgentInTab({ ...target, panelType: 'terminal' }, { provider: claudeProvider })).rejects.toThrow('no launch command for a terminal tab');
    expect(tmux.sendKeysSeparated).not.toHaveBeenCalled();
  });
});
