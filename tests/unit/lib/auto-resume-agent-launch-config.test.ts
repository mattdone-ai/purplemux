vi.mock('@/lib/orchestration-activity', () => ({ recordOrchestrationLaunch: vi.fn(async () => {}) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import type { IAgentProvider } from '@/lib/providers/types';
import type { ITab } from '@/types/terminal';

const tmux = vi.hoisted(() => ({
  createSession: vi.fn(async () => {}),
  getPaneCurrentCommand: vi.fn(async () => 'bash'),
  getSessionPanePid: vi.fn(),
  hasSession: vi.fn(async () => true),
  sendKeysSeparated: vi.fn(async () => {}),
}));
const markAgentLaunch = vi.hoisted(() => vi.fn());
const managed = vi.hoisted(() => ({
  prepareCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));

vi.mock('@/lib/tmux', () => tmux);
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ markAgentLaunch }) }));
const workspaces = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaces: vi.fn(async () => ({ workspaces: workspaces.ids.map((id) => ({ id })) })) }));
// Preflight answers "installed" so the resume runs where no claude CLI is (CI); the command builder stays real.
vi.mock('@/lib/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers')>();
  return {
    ...actual,
    getProviderByPanelType: (type: Parameters<typeof actual.getProviderByPanelType>[0]) => {
      const provider = actual.getProviderByPanelType(type);
      return provider ? { ...provider, preflight: async () => ({ installed: true }) } : provider;
    },
  };
});
vi.mock('@/lib/process-utils', () => ({ getChildPids: vi.fn(), getProcessArgs: vi.fn() }));
vi.mock('@/lib/providers/codex/managed-launch', () => managed);

describe('auto resume agent launch config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managed.prepareCodexManagedLaunch.mockResolvedValue({
      ok: true,
      launch: { generation: 'codex-generation' },
    });
    managed.submitCodexManagedLaunch.mockResolvedValue({
      ok: true,
      generation: 'codex-generation',
      phase: 'submitted',
    });
    managed.waitForCodexManagedLaunch.mockResolvedValue({
      ok: true,
      generation: 'codex-generation',
      phase: 'active',
    });
  });

  it('forwards the persisted tab pins to the provider resume command', async () => {
    const buildResumeCommand = vi.fn(async () => 'resume-command');
    const provider = {
      id: 'codex',
      displayName: 'Codex',
      buildResumeCommand,
    } as unknown as IAgentProvider;
    const { executeAutoResume } = await import('@/lib/auto-resume');

    await executeAutoResume([{
      workspaceId: 'ws-pins',
      tabId: 'tab-pins',
      tmuxSession: 'pt-ws-pins-pane-one-tab-pins',
      sessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      provider,
      launchOptions: { model: 'gpt-5.6-sol', effort: 'high' },
    }]);

    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', '01a008c1-bb96-71d1-9769-b63ff478fd9f',
    );
    expect(managed.submitCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', 'codex-generation',
    );
    expect(managed.waitForCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', 'codex-generation',
    );
    expect(buildResumeCommand).not.toHaveBeenCalled();
    expect(tmux.sendKeysSeparated).not.toHaveBeenCalled();
  });

  it('resumes an evaluator tab found in a layout with its role: dontAsk, the four built-ins, the preview allow-list and no bypass (ADR-0040)', async () => {
    await (await import('@/lib/config-store')).updateConfig({ dangerouslySkipPermissions: true });
    const { resolveLayoutFile } = await import('@/lib/layout-store');
    const evaluator: ITab = {
      id: 'tab-eval', name: 'evaluator', order: 0, sessionName: 'pt-ws-eval-pane-one-tab-eval', panelType: 'claude-code',
      agentLaunchConfig: { model: 'claude-opus-5-5', effort: 'xhigh' }, role: 'evaluator', previewOrigin: 'http://localhost:3100', pgService: 'preview_42',
      agentState: { providerId: 'claude', sessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f', jsonlPath: null, summary: null },
    };
    const file = resolveLayoutFile('ws-eval');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ root: { type: 'pane', id: 'pane-one', tabs: [evaluator], activeTabId: 'tab-eval' }, activePaneId: 'pane-one', updatedAt: '2026-11-03T00:00:00.000Z' }));
    workspaces.ids = ['ws-eval'];
    const { autoResumeOnStartup } = await import('@/lib/auto-resume');

    await autoResumeOnStartup(true);

    expect(tmux.sendKeysSeparated).toHaveBeenCalledTimes(1);
    const [session, command] = tmux.sendKeysSeparated.mock.calls[0] as unknown as [string, string];
    expect(session).toBe('pt-ws-eval-pane-one-tab-eval');
    expect(command).toMatch(/^PGSERVICE=preview_42 claude --resume 01a008c1-bb96-71d1-9769-b63ff478fd9f /);
    expect(command).toContain('--model claude-opus-5-5');
    expect(command).toContain('--permission-mode dontAsk');
    expect(command).toContain('--tools Read,Grep,Glob,Bash');
    expect(command).toContain('http://localhost:3100/*');
    expect(command).not.toContain('--dangerously-skip-permissions');
  });
});
