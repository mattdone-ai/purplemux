vi.mock('@/lib/orchestration-activity', () => ({ recordOrchestrationLaunch: vi.fn(async () => {}) }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IAgentProvider } from '@/lib/providers/types';

const tmux = vi.hoisted(() => ({
  checkTerminalProcess: vi.fn(async () => ({ isSafe: true, processName: 'bash' })),
  getSessionCwd: vi.fn(async () => null),
  sendKeys: vi.fn(async () => {}),
}));
const launchPolicy = vi.hoisted(() => ({
  resolveAgentLaunchPolicyForSession: vi.fn(),
}));
const layout = vi.hoisted(() => ({ updateTabAgentState: vi.fn(async () => {}) }));
const status = vi.hoisted(() => ({ markAgentLaunch: vi.fn() }));
const managed = vi.hoisted(() => ({
  prepareCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));

vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tmux')>(),
  ...tmux,
}));
vi.mock('@/lib/agent-launch-policy', () => launchPolicy);
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/layout-store')>(),
  updateTabAgentSessionId: vi.fn(async () => {}),
  updateTabAgentState: layout.updateTabAgentState,
}));
vi.mock('@/lib/providers/codex/session-detection', () => ({ findCodexSessionById: vi.fn(async () => null) }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => status,
}));
vi.mock('@/lib/providers/codex/managed-launch', () => managed);
const hosts = vi.hoisted(() => ({ remote: new Set<string>() }));
vi.mock('@/lib/session-host', () => ({ sessionHostOf: async (s: string) => (hosts.remote.has(s) ? 'ai-server' : null) }));

describe('timeline resume agent launch config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    launchPolicy.resolveAgentLaunchPolicyForSession.mockResolvedValue({
      workspaceId: 'ws-pins',
      tabId: 'tab-pins',
      sessionName: 'pt-ws-pins-pane-one-tab-pins',
      options: { model: 'gpt-5.6-sol', effort: 'high' },
    });
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

  it('refuses to resume a remote tab: it would type this host\'s launch command there (ADR-0022)', async () => {
    const sessionName = 'pt-ws-pins-pane-one-tab-r';
    hosts.remote.add(sessionName);
    const buildResumeCommand = vi.fn(async () => 'resume-command');
    const sent: string[] = [];
    const ws = { readyState: 1, bufferedAmount: 0, send: (payload: string) => sent.push(payload) };
    const { handleResumeMessage } = await import('@/lib/timeline-server');
    await handleResumeMessage(ws as never, { sessionName, provider: { id: 'claude', buildResumeCommand }, currentJsonlPath: null } as never, {
      sessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      tmuxSession: sessionName,
    });
    hosts.remote.clear();
    expect(sent.map((payload) => JSON.parse(payload).type)).toEqual(['timeline:resume-error']);
    expect(buildResumeCommand).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(status.markAgentLaunch).not.toHaveBeenCalled();
  });

  it('forwards the connected tab persisted pins to the provider resume command', async () => {
    const buildResumeCommand = vi.fn(async () => 'resume-command');
    const provider = {
      id: 'codex',
      buildResumeCommand,
    } as unknown as IAgentProvider;
    const sent: string[] = [];
    const ws = { readyState: 1, bufferedAmount: 0, send: (payload: string) => sent.push(payload) };
    const sessionName = 'pt-ws-pins-pane-one-tab-pins';
    const { handleResumeMessage } = await import('@/lib/timeline-server');

    await handleResumeMessage(ws as never, {
      sessionName,
      provider,
      currentJsonlPath: null,
    } as never, {
      sessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      tmuxSession: sessionName,
    });

    expect(launchPolicy.resolveAgentLaunchPolicyForSession).toHaveBeenCalledWith(sessionName);
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
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(layout.updateTabAgentState).not.toHaveBeenCalled();
    expect(status.markAgentLaunch).not.toHaveBeenCalled();
    expect(sent.map((payload) => JSON.parse(payload).type)).toContain('timeline:resume-started');
  });
});
