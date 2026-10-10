import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteHostError } from '@/lib/remote-host';

// ADR-0022 review r1: the routes a remote tab reaches. A host that does not answer is a retryable
// 503 remote-host-unreachable, never "the tab is dead" and never a 500; a remote tab cannot be
// switched to an agent from the web UI.

const REMOTE_TAB = { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-a-pane-p-tab-r', panelType: 'terminal' as const, host: 'ai-server' };
const LOCAL_TAB = { id: 'tab-l', name: 'l', order: 1, sessionName: 'pt-ws-a-pane-p-tab-l', panelType: 'terminal' as const };
const unreachable = () => new RemoteHostError('ai-server', 'remote host ai-server did not answer over ssh');

const fx = vi.hoisted(() => ({
  findTab: vi.fn(),
  hasSessionOrUnreachable: vi.fn(async (_name: string) => true),
  patchTab: vi.fn(async () => ({ ok: true })),
  restartTabSession: vi.fn(async () => true),
  removeTabFromPane: vi.fn(async () => true),
  closePaneInLayout: vi.fn(async () => ({ root: {} })),
  deletePane: vi.fn(async () => {}),
  deleteWorkspace: vi.fn(async () => true),
  recordOrchestrationLaunch: vi.fn(async () => {}),
  markAgentLaunch: vi.fn(),
}));

vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-a' })),
  findTab: fx.findTab,
}));
vi.mock('@/lib/tmux', () => ({
  hasSessionOrUnreachable: fx.hasSessionOrUnreachable,
  getPaneCurrentCommand: vi.fn(async () => 'bash'),
  capturePaneContentAnsi: vi.fn(async () => 'pane'),
}));
vi.mock('@/lib/human-mutation', () => ({ authorizeHumanMutation: vi.fn(async () => true) }));
vi.mock('@/lib/layout-store', () => ({
  patchTab: fx.patchTab,
  restartTabSession: fx.restartTabSession,
  removeTabFromPane: fx.removeTabFromPane,
  closePaneInLayout: fx.closePaneInLayout,
  deletePane: fx.deletePane,
}));
vi.mock('@/lib/workspace-store', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-a'),
  deleteWorkspace: fx.deleteWorkspace,
  renameWorkspace: vi.fn(),
  setWorkspaceGroup: vi.fn(),
  updateWorkspaceOrchestration: vi.fn(),
}));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    getAllForClient: () => ({ 'tab-r': { workspaceId: 'ws-a', cliState: 'idle' } }),
    removeTab: vi.fn(),
    markAgentLaunch: fx.markAgentLaunch,
  }),
}));
vi.mock('@/lib/orchestration-activity', () => ({ recordOrchestrationLaunch: fx.recordOrchestrationLaunch }));
vi.mock('@/lib/orchestration-mapping-lock', () => ({ withOrchestrationMappingRead: async (_ws: string, work: () => Promise<unknown>) => work() }));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: () => null }));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ statusForTab: async () => ({ probes: [], backgroundJobs: [] }) }) }));
vi.mock('@/lib/tab-token', () => ({ tabIdentityOf: () => 'launch' }));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: vi.fn() }));

const call = async (route: string, method: string, query: Record<string, string>, body?: unknown) => {
  const { default: handler } = await import(route);
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    end() { return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method, query, body, headers: {} } as unknown as NextApiRequest, res);
  return state;
};

const UNREACHABLE = { code: 'remote-host-unreachable', host: 'ai-server' };

describe('routes a remote tab reaches (ADR-0022, review r1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fx.findTab.mockResolvedValue({ workspaceId: 'ws-a', paneId: 'pane-p', tab: REMOTE_TAB });
    fx.hasSessionOrUnreachable.mockResolvedValue(true);
  });

  it('tab status serves the host of a remote tab and none for a local one', async () => {
    const remote = await call('@/pages/api/cli/tabs/[tabId]/status', 'GET', { tabId: 'tab-r', workspaceId: 'ws-a' });
    expect(remote.body).toMatchObject({ tabId: 'tab-r', host: 'ai-server', alive: true, command: 'bash' });
    fx.findTab.mockResolvedValue({ workspaceId: 'ws-a', paneId: 'pane-p', tab: LOCAL_TAB });
    const local = await call('@/pages/api/cli/tabs/[tabId]/status', 'GET', { tabId: 'tab-l', workspaceId: 'ws-a' });
    expect(local.body).not.toHaveProperty('host');
  });

  it.each([
    ['tab status', '@/pages/api/cli/tabs/[tabId]/status'],
    ['tab result', '@/pages/api/cli/tabs/[tabId]/result'],
  ])('%s answers 503 remote-host-unreachable while the host does not answer, never alive:false or session-not-running', async (_label, route) => {
    fx.hasSessionOrUnreachable.mockRejectedValue(unreachable());
    const state = await call(route, 'GET', { tabId: 'tab-r', workspaceId: 'ws-a' });
    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject(UNREACHABLE);
  });

  it('the web UI cannot switch a remote tab to an agent (409 remote-type-unsupported); renaming it still works', async () => {
    const route = '@/pages/api/layout/pane/[paneId]/tabs/[tabId]';
    const refused = await call(route, 'PATCH', { paneId: 'pane-p', tabId: 'tab-r', workspace: 'ws-a' }, { panelType: 'claude-code' });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatchObject({ code: 'remote-type-unsupported' });
    expect(fx.patchTab).not.toHaveBeenCalled();
    const renamed = await call(route, 'PATCH', { paneId: 'pane-p', tabId: 'tab-r', workspace: 'ws-a' }, { name: 'worker' });
    expect(renamed.statusCode).toBe(200);
  });

  it('the agent launch route refuses a remote tab with 409 and records no launch', async () => {
    const state = await call('@/pages/api/status/agent-launch', 'POST', {}, { tabId: 'tab-r', panelType: 'claude-code' });
    expect(state.statusCode).toBe(409);
    expect(state.body).toMatchObject({ code: 'remote-type-unsupported' });
    expect(fx.recordOrchestrationLaunch).not.toHaveBeenCalled();
    expect(fx.markAgentLaunch).not.toHaveBeenCalled();
  });

  it.each([
    ['UI restart', '@/pages/api/layout/pane/[paneId]/tabs/[tabId]', 'POST', { paneId: 'pane-p', tabId: 'tab-r', workspace: 'ws-a' }, 'restartTabSession'],
    ['UI tab close', '@/pages/api/layout/pane/[paneId]/tabs/[tabId]', 'DELETE', { paneId: 'pane-p', tabId: 'tab-r', workspace: 'ws-a' }, 'removeTabFromPane'],
    ['pane close', '@/pages/api/layout/pane/[paneId]', 'DELETE', { paneId: 'pane-p', workspace: 'ws-a' }, 'closePaneInLayout'],
    ['workspace delete', '@/pages/api/workspace/[workspaceId]', 'DELETE', { workspaceId: 'ws-a' }, 'deleteWorkspace'],
  ] as const)('%s answers 503 remote-host-unreachable when a remote host does not answer', async (_label, route, method, query, fn) => {
    (fx[fn] as unknown as { mockRejectedValueOnce: (e: unknown) => void }).mockRejectedValueOnce(unreachable());
    const state = await call(route, method, query);
    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject(UNREACHABLE);
  });
});
