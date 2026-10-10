import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab } from '@/types/terminal';

// ADR-0022 slice (b): auto-resume types this host's launch command, so it never touches a remote tab.

const fx = vi.hoisted(() => ({
  tabs: [] as ITab[],
  buildResumeCommand: vi.fn(async () => 'claude --resume x'),
  sendKeysSeparated: vi.fn(async (_session: string, _command: string) => {}),
  createSession: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('@/lib/orchestration-activity', () => ({ recordOrchestrationLaunch: vi.fn(async () => {}) }));
vi.mock('@/lib/orchestration-mapping-lock', () => ({ withOrchestrationMappingsRead: async (_ids: string[], work: () => Promise<unknown>) => work() }));
vi.mock('@/lib/layout-store', () => ({
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  resolveLayoutFile: () => '/nonexistent',
  collectAllTabs: () => fx.tabs,
}));
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(async () => true),
  createSession: fx.createSession,
  getPaneCurrentCommand: vi.fn(async () => 'bash'),
  getSessionPanePid: vi.fn(async () => null),
  sendKeysSeparated: fx.sendKeysSeparated,
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-a' }] })) }));
vi.mock('@/lib/providers', () => ({
  getProviderByPanelType: () => ({ id: 'claude', displayName: 'Claude', preflight: async () => ({ installed: true }), readSessionId: () => '01a008c1-bb96-71d1-9769-b63ff478fd9f', buildResumeCommand: fx.buildResumeCommand }),
  getProviderByProcessName: () => null,
}));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ markAgentLaunch: vi.fn() }) }));
vi.mock('@/lib/process-utils', () => ({ getChildPids: vi.fn(), getProcessArgs: vi.fn() }));
vi.mock('@/lib/providers/codex/managed-launch', () => ({ prepareCodexManagedLaunch: vi.fn(), submitCodexManagedLaunch: vi.fn(), waitForCodexManagedLaunch: vi.fn() }));

describe('auto-resume and remote tabs (ADR-0022)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resumes a local claude tab and skips a remote one', async () => {
    fx.tabs = [
      { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-a-pane-p-tab-r', panelType: 'claude-code', host: 'ai-server' },
      { id: 'tab-l', name: 'l', order: 1, sessionName: 'pt-ws-a-pane-p-tab-l', panelType: 'claude-code' },
    ];
    const { autoResumeOnStartup } = await import('@/lib/auto-resume');
    await autoResumeOnStartup(true);
    expect(fx.sendKeysSeparated.mock.calls.map((c) => c[0])).toEqual(['pt-ws-a-pane-p-tab-l']);
    expect(fx.createSession).not.toHaveBeenCalledWith('pt-ws-a-pane-p-tab-r', expect.anything(), expect.anything(), expect.anything(), expect.anything());
  });
});
