import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TStrictRuntimeObservation } from '@/lib/process-utils';

// vel-D61: an orchestrator proves a remote tab dead with one process check before it respawns it. `tab status`
// of a live remote agent tab serves that check as `agentProcess`, walked on the tab's host.

const REMOTE_AGENT = { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-a-pane-p-tab-r', panelType: 'claude-code' as const, host: 'host-a' };
const REMOTE_TERMINAL = { ...REMOTE_AGENT, panelType: 'terminal' as const };
const LOCAL_AGENT = { id: 'tab-l', name: 'l', order: 1, sessionName: 'pt-ws-a-pane-p-tab-l', panelType: 'claude-code' as const };

const fx = vi.hoisted(() => ({
  findTab: vi.fn(),
  hasSessionOrUnreachable: vi.fn(async (_name: string) => true),
  observe: vi.fn(async (_tab: unknown): Promise<TStrictRuntimeObservation> => ({ state: 'present', identity: 'remote:host-a:pt:%3:4242:4300:918273:claude' })),
}));

vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-a' })),
  findTab: fx.findTab,
}));
vi.mock('@/lib/tmux', () => ({
  hasSessionOrUnreachable: fx.hasSessionOrUnreachable,
  getPaneCurrentCommand: vi.fn(async () => 'node'),
}));
vi.mock('@/lib/orchestration-runtime', () => ({ observeOrchestrationProcess: fx.observe }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ getAllForClient: () => ({}) }) }));
vi.mock('@/lib/providers', () => ({
  getProviderByPanelType: (panelType: string) => (panelType === 'claude-code' ? { id: 'claude', readSessionId: () => null } : null),
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ statusForTab: async () => ({ probes: [], backgroundJobs: [] }) }) }));
vi.mock('@/lib/tab-token', () => ({ tabIdentityOf: () => 'launch' }));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: vi.fn() }));

const status = async (tabId: string) => {
  const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/status');
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'GET', query: { tabId, workspaceId: 'ws-a' }, headers: {} } as unknown as NextApiRequest, res);
  return state;
};

describe('tab status: agentProcess of a remote agent tab (vel-D61)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.hasSessionOrUnreachable.mockResolvedValue(true);
    fx.findTab.mockResolvedValue({ workspaceId: 'ws-a', paneId: 'pane-p', tab: REMOTE_AGENT });
  });

  it('present: the state alone; the process identity and its pids stay on the host', async () => {
    const res = await status('tab-r');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ host: 'host-a', alive: true, command: 'node', agentProcess: { state: 'present' } });
    expect(JSON.stringify(res.body)).not.toContain('4242');
    expect(fx.observe).toHaveBeenCalledWith(REMOTE_AGENT);
  });

  it.each([
    [{ state: 'absent', reason: 'no claude process in the pane' }],
    [{ state: 'unknown', reason: 'remote host host-a did not answer (timed out)' }],
  ] as const)('%j is served with its reason', async (observed) => {
    fx.observe.mockResolvedValueOnce(observed);
    expect((await status('tab-r')).body).toMatchObject({ alive: true, agentProcess: observed });
  });

  it('a remote terminal tab and a local agent tab carry no agentProcess and run no process walk', async () => {
    fx.findTab.mockResolvedValueOnce({ workspaceId: 'ws-a', paneId: 'pane-p', tab: REMOTE_TERMINAL });
    expect((await status('tab-r')).body).not.toHaveProperty('agentProcess');
    fx.findTab.mockResolvedValueOnce({ workspaceId: 'ws-a', paneId: 'pane-p', tab: LOCAL_AGENT });
    expect((await status('tab-l')).body).not.toHaveProperty('agentProcess');
    expect(fx.observe).not.toHaveBeenCalled();
  });

  it('a session that is gone answers alive false without a process walk', async () => {
    fx.hasSessionOrUnreachable.mockResolvedValueOnce(false);
    const res = await status('tab-r');
    expect(res.body).toMatchObject({ alive: false });
    expect(res.body).not.toHaveProperty('agentProcess');
    expect(fx.observe).not.toHaveBeenCalled();
  });
});
