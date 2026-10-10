vi.mock('@/lib/orchestration-activity', () => ({ recordOrchestrationLaunch: vi.fn(async () => {}) }));
vi.mock('@/lib/human-mutation', () => ({ authorizeHumanMutation: vi.fn(async () => true) }));
import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const claude = vi.hoisted(() => ({
  panelType: 'claude-code',
  buildLaunchCommand: vi.fn(),
  buildResumeCommand: vi.fn(),
}));
const policy = vi.hoisted(() => ({ resolveAgentLaunchPolicy: vi.fn() }));
const layout = vi.hoisted(() => ({ updateTabAgentState: vi.fn() }));
const cli = vi.hoisted(() => ({ authorizeWorkspaceInput: vi.fn() }));
const status = vi.hoisted(() => ({ markAgentLaunch: vi.fn() }));

vi.mock('@/lib/providers/claude', () => ({ claudeProvider: claude }));
vi.mock('@/lib/agent-launch-policy', () => policy);
vi.mock('@/lib/layout-store', () => layout);
vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));
vi.mock('@/lib/agent-availability', () => ({
  checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })),
  toAgentAvailabilityError: vi.fn(),
}));
vi.mock('@/lib/workspace-store', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-active') }));
const hosts = vi.hoisted(() => ({ remote: new Set<string>() }));
vi.mock('@/lib/session-host', () => ({ sessionHostOf: async (s: string) => (hosts.remote.has(s) ? 'ai-server' : null) }));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

describe('POST /api/claude/launch-command tab policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claude.buildResumeCommand.mockResolvedValue('claude-resume-command');
    policy.resolveAgentLaunchPolicy.mockResolvedValue({
      workspaceId: 'ws-pins',
      tabId: 'tab-pins',
      sessionName: 'pt-ws-pins-pane-one-tab-pins',
      options: { model: 'claude-opus-5', effort: 'high' },
    });
    cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-pins' });
  });

  it('resolves pins and rebinds metadata before returning a browser resume command', async () => {
    const { default: handler } = await import('@/pages/api/claude/launch-command');
    const { state, res } = fakeResponse();
    const sessionId = '01a008c1-bb96-71d1-9769-b63ff478fd9f';

    await handler({
      method: 'POST',
      body: { workspaceId: 'ws-pins', tabId: 'tab-pins', resumeSessionId: sessionId },
    } as NextApiRequest, res);

    expect(claude.buildResumeCommand).toHaveBeenCalledWith(sessionId, {
      workspaceId: 'ws-pins',
      model: 'claude-opus-5',
      effort: 'high',
    });
    expect(layout.updateTabAgentState).toHaveBeenCalledWith(
      'pt-ws-pins-pane-one-tab-pins',
      claude,
      { sessionId, jsonlPath: null, summary: null, lastUserMessage: null },
    );
    expect(status.markAgentLaunch).toHaveBeenCalledWith('tab-pins', { resumeSessionId: sessionId });
    expect(state.statusCode).toBe(200);
  });

  it('refuses a remote tab: its agent is launched by tab create --host, never with this host\'s command (ADR-0022)', async () => {
    hosts.remote.add('pt-ws-pins-pane-one-tab-pins');
    const { default: handler } = await import('@/pages/api/claude/launch-command');
    const { state, res } = fakeResponse();
    await handler({ method: 'POST', body: { workspaceId: 'ws-pins', tabId: 'tab-pins' } } as NextApiRequest, res);
    hosts.remote.clear();
    expect(state.statusCode).toBe(409);
    expect(state.body).toMatchObject({ code: 'remote-type-unsupported' });
    expect(claude.buildLaunchCommand).not.toHaveBeenCalled();
    expect(status.markAgentLaunch).not.toHaveBeenCalled();
  });

  it('refuses a tab absent from the named workspace', async () => {
    policy.resolveAgentLaunchPolicy.mockResolvedValue(null);
    const { default: handler } = await import('@/pages/api/claude/launch-command');
    const { state, res } = fakeResponse();

    await handler({
      method: 'POST',
      body: { workspaceId: 'ws-other', tabId: 'tab-pins', resumeSessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f' },
    } as NextApiRequest, res);

    expect(state.statusCode).toBe(404);
    expect(claude.buildResumeCommand).not.toHaveBeenCalled();
  });

  it('denies a cross-workspace token before command construction or binding mutation', async () => {
    cli.authorizeWorkspaceInput.mockResolvedValue(null);
    const { default: handler } = await import('@/pages/api/claude/launch-command');
    const { res } = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: {
        workspaceId: 'ws-other',
        tabId: 'tab-pins',
        resumeSessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      },
    } as unknown as NextApiRequest, res);

    expect(cli.authorizeWorkspaceInput).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ws-other');
    expect(claude.buildResumeCommand).not.toHaveBeenCalled();
    expect(layout.updateTabAgentState).not.toHaveBeenCalled();
    expect(status.markAgentLaunch).not.toHaveBeenCalled();
  });
});
