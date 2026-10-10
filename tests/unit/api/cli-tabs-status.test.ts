import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cliUtils = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(),
  findTab: vi.fn(),
}));
const tmux = vi.hoisted(() => ({
  hasSession: vi.fn(),
  getPaneCurrentCommand: vi.fn(),
}));
const modelObservation = vi.hoisted(() => ({ getCodexModelStatus: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn() }));
const statusManager = vi.hoisted(() => ({ getAllForClient: vi.fn() }));

vi.mock('@/lib/cli-utils', () => cliUtils);
vi.mock('@/lib/tmux', () => Object.assign(tmux, { hasSessionOrUnreachable: tmux.hasSession }));
vi.mock('@/lib/providers/codex/model-observation', () => modelObservation);
vi.mock('@/lib/providers', () => ({
  getProviderByPanelType: () => ({
    id: 'codex',
    readSessionId: () => '11111111-1111-4111-8111-111111111111',
  }),
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => statusManager }));
vi.mock('@/lib/tab-token', () => ({ tabIdentityOf: vi.fn(() => 'hook') }));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const response = (): IFakeResponse => {
  const state = { statusCode: 0, body: undefined, res: undefined } as unknown as IFakeResponse;
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

const tab = {
  id: 'tab-1',
  sessionName: 'pmux-tab-1',
  name: 'worker',
  order: 0,
  panelType: 'codex-cli',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
};

describe('GET /api/cli/tabs/[tabId]/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliUtils.authorizeWorkspace.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-1' });
    cliUtils.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-1', tab });
    tmux.hasSession.mockResolvedValue(true);
    tmux.getPaneCurrentCommand.mockResolvedValue('codex');
    modelObservation.getCodexModelStatus.mockResolvedValue({
      expected: { model: 'gpt-6-astra', effort: 'high' },
      observed: {
        model: 'gpt-5.6-luna',
        effort: 'medium',
        source: 'thread_settings_applied',
        timestamp: '2026-09-10T10:00:00.000Z',
        sessionId: '11111111-1111-4111-8111-111111111111',
      },
      latestTurn: null,
      latestSettings: null,
      status: 'mismatch',
    });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
    statusManager.getAllForClient.mockReturnValue({});
  });

  const get = async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/status');
    const res = response();
    await handler({ method: 'GET', query: { workspaceId: 'ws-1', tabId: 'tab-1' } } as unknown as NextApiRequest, res.res);
    return res;
  };

  it('reports the live cliState that `tab send` reads, not the layout copy (L8)', async () => {
    const { resolveTabCliState } = await import('@/lib/tab-send');
    const layoutTab = { ...tab, cliState: 'inactive' as const };
    const live = { cliState: 'idle' as const, agentSessionId: null };
    cliUtils.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-1', tab: layoutTab });
    statusManager.getAllForClient.mockReturnValue({ 'tab-1': live });
    const res = await get();
    expect(res.body).toMatchObject({ cliState: 'idle' });
    expect((res.body as { cliState: unknown }).cliState).toBe(resolveTabCliState(layoutTab as never, live));
  });

  it('falls back to the layout copy when the tab has no live entry', async () => {
    cliUtils.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-1', tab: { ...tab, cliState: 'inactive' } });
    const res = await get();
    expect(res.body).toMatchObject({ cliState: 'inactive', agentSessionId: '11111111-1111-4111-8111-111111111111' });
  });

  it('reports how the watchdog classified the last stop (story 37), and null without a live entry', async () => {
    expect((await get()).body).toMatchObject({ turnEnd: null });
    const turnEnd = { kind: 'ready-for-review', at: 1, seq: 3, transcript: true, openBackgroundTasks: 0, liveRegisteredJobs: 0 };
    statusManager.getAllForClient.mockReturnValue({ 'tab-1': { cliState: 'ready-for-review', agentSessionId: null, turnEnd } });
    expect((await get()).body).toMatchObject({ turnEnd });
    tmux.hasSession.mockResolvedValue(false);
    expect((await get()).body).toMatchObject({ alive: false, turnEnd });
  });

  it('reports the tab\'s identity (story 36)', async () => {
    expect((await get()).body).toMatchObject({ identity: 'hook' });
  });

  it('reports the live session id when the poll bound one the layout does not have yet', async () => {
    statusManager.getAllForClient.mockReturnValue({ 'tab-1': { cliState: 'idle', agentSessionId: '22222222-2222-4222-8222-222222222222' } });
    const res = await get();
    expect(res.body).toMatchObject({
      agentSessionId: '22222222-2222-4222-8222-222222222222',
      claudeSessionId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('authorizes and locates the tab before exposing its model observation', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/status');
    const res = response();

    await handler({
      method: 'GET',
      query: { workspaceId: 'ws-1', tabId: 'tab-1' },
    } as unknown as NextApiRequest, res.res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      tabId: 'tab-1',
      alive: true,
      modelStatus: {
        expected: { model: 'gpt-6-astra', effort: 'high' },
        observed: { model: 'gpt-5.6-luna', effort: 'medium' },
        status: 'mismatch',
      },
    });
    expect(cliUtils.authorizeWorkspace.mock.invocationCallOrder[0])
      .toBeLessThan(cliUtils.findTab.mock.invocationCallOrder[0]);
    expect(cliUtils.findTab.mock.invocationCallOrder[0])
      .toBeLessThan(modelObservation.getCodexModelStatus.mock.invocationCallOrder[0]);
    expect(JSON.stringify(res.body)).not.toContain('.jsonl');
  });

  it('does not inspect the tab or its session when authorization fails', async () => {
    cliUtils.authorizeWorkspace.mockResolvedValue(null);
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/status');
    const res = response();

    await handler({
      method: 'GET',
      query: { workspaceId: 'ws-1', tabId: 'tab-1' },
    } as unknown as NextApiRequest, res.res);

    expect(cliUtils.findTab).not.toHaveBeenCalled();
    expect(modelObservation.getCodexModelStatus).not.toHaveBeenCalled();
  });

  it('marks a dead tab unavailable instead of reusing historical model evidence', async () => {
    tmux.hasSession.mockResolvedValue(false);
    modelObservation.getCodexModelStatus.mockResolvedValue({
      expected: { model: 'gpt-6-astra', effort: 'high' },
      observed: null,
      latestTurn: null,
      latestSettings: null,
      scanState: 'unavailable',
      hasActivity: false,
      status: 'unknown',
      reason: 'runtime-unavailable',
    });
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/status');
    const res = response();

    await handler({
      method: 'GET',
      query: { workspaceId: 'ws-1', tabId: 'tab-1' },
    } as unknown as NextApiRequest, res.res);

    expect(modelObservation.getCodexModelStatus).toHaveBeenCalledWith(tab, { runtimeAlive: false });
    expect(res.body).toMatchObject({
      alive: false,
      modelStatus: { status: 'unknown', reason: 'runtime-unavailable' },
    });
  });
});
