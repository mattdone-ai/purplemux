import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab } from '@/types/terminal';

// Every CLI tab route answers a missing tab, a dead session and a replaced tab
// with a machine `code` beside the unchanged `error` text and HTTP status
// (ADR-0016). bin/cli.js turns those codes into exit 4, which a caller never
// retries.

const cliUtils = vi.hoisted(() => ({
  authorizeWorkspace: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-1' })),
  authorizeWorkspaceInput: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-1' })),
  findTab: vi.fn(),
}));
const tmux = vi.hoisted(() => ({
  hasSession: vi.fn(async () => true),
  capturePaneContent: vi.fn(async () => 'pane'),
  getPaneCurrentCommand: vi.fn(async () => 'bash'),
}));
const steer = vi.hoisted(() => ({
  steerSession: vi.fn(async () => ({ ok: true, interrupted: true }) as { ok: boolean; interrupted: boolean; reason?: string }),
}));
const providers = vi.hoisted(() => ({
  getProviderByPanelType: vi.fn((): { id: string } | null => null),
}));
const layout = vi.hoisted(() => ({
  closeTab: vi.fn(async (): Promise<{ ok: boolean; reap: unknown }> => ({ ok: true, reap: null })),
  updateTabAgentLaunchConfig: vi.fn(),
}));

vi.mock('@/lib/cli-utils', () => cliUtils);
vi.mock('@/lib/tmux', () => Object.assign(tmux, { hasSessionOrUnreachable: tmux.hasSession }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ getAllForClient: () => ({}) }) }));
vi.mock('@/lib/agent-steer', () => steer);
vi.mock('@/lib/layout-store', () => layout);
vi.mock('@/lib/agent-dispatch-policy', () => ({
  withAgentDispatchLock: async (
    _workspaceId: string,
    _target: ITab,
    work: (checkPolicy: () => Promise<{ ok: true }>) => Promise<unknown>,
  ) => work(async () => ({ ok: true })),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ statusForTab: async () => ({ probes: [], backgroundJobs: [] }) }),
}));
vi.mock('@/lib/providers', () => providers);
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: async () => null }));
vi.mock('@/lib/providers/codex/launch-lifecycle', () => ({
  withCodexTargetLock: async (_ws: string, _tab: string, work: () => Promise<unknown>) => work(),
}));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
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
    send(body: unknown) {
      state.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

const TAB: ITab = { id: 'tab-1', sessionName: 'pt-ws-1-pane-1-tab-1', name: 'worker', order: 0, panelType: 'claude-code' };
const QUERY = { tabId: 'tab-1', workspaceId: 'ws-1' };
const TAB_NOT_FOUND = { error: 'Tab not found', code: 'tab-not-found' };

const call = async (route: string, method: string, body: unknown = {}, query: Record<string, string> = QUERY): Promise<IFakeResponse> => {
  const { default: handler } = (await import(route)) as { default: THandler };
  const response = fakeResponse();
  await handler({ method, query, body } as unknown as NextApiRequest, response.res);
  return response;
};

beforeEach(() => {
  vi.clearAllMocks();
  cliUtils.findTab.mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-1', tab: TAB });
  tmux.hasSession.mockResolvedValue(true);
  providers.getProviderByPanelType.mockReturnValue(null);
});

describe('tab-not-found carries its code on every tab route', () => {
  it.each([
    ['@/pages/api/cli/tabs/[tabId]/status', 'GET', {}],
    ['@/pages/api/cli/tabs/[tabId]/result', 'GET', {}],
    ['@/pages/api/cli/tabs/[tabId]/steer', 'POST', { content: 'fix it' }],
    ['@/pages/api/cli/tabs/[tabId]/index', 'GET', {}],
    ['@/pages/api/cli/tabs/[tabId]/index', 'DELETE', {}],
    ['@/pages/api/cli/tabs/[tabId]/index', 'PATCH', { agentLaunchConfig: null }],
    ['@/pages/api/cli/tabs/[tabId]/probe', 'GET', {}],
    ['@/pages/api/cli/tabs/[tabId]/probe', 'POST', {}],
    ['@/pages/api/cli/tabs/[tabId]/bg', 'GET', {}],
    ['@/pages/api/cli/tabs/[tabId]/bg', 'POST', {}],
  ])('%s %s', async (route, method, body) => {
    cliUtils.findTab.mockResolvedValue(null);

    const response = await call(route, method, body);

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual(TAB_NOT_FOUND);
  });

  it('PATCH answers tab-not-found when the layout loses the tab mid-update', async () => {
    providers.getProviderByPanelType.mockReturnValue({ id: 'claude' });
    layout.updateTabAgentLaunchConfig.mockResolvedValue(null);

    const response = await call('@/pages/api/cli/tabs/[tabId]/index', 'PATCH', { agentLaunchConfig: null });

    expect(layout.updateTabAgentLaunchConfig).toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual(TAB_NOT_FOUND);
  });
});

describe('a dead session is session-not-running', () => {
  it('result keeps its error text and adds the code', async () => {
    tmux.hasSession.mockResolvedValue(false);

    const response = await call('@/pages/api/cli/tabs/[tabId]/result', 'GET');

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: 'Tab session is not running', code: 'session-not-running' });
  });

  it('steer keeps its error text and adds the code', async () => {
    steer.steerSession.mockResolvedValue({ ok: false, interrupted: false, reason: 'session not found' });

    const response = await call('@/pages/api/cli/tabs/[tabId]/steer', 'POST', { content: 'fix it' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: 'session not found', code: 'session-not-running' });
  });

  it('steer leaves any other failure a codeless 500', async () => {
    steer.steerSession.mockResolvedValue({ ok: false, interrupted: false, reason: 'interrupt failed' });

    const response = await call('@/pages/api/cli/tabs/[tabId]/steer', 'POST', { content: 'fix it' });

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'interrupt failed' });
  });
});

describe('a replaced tab is target-changed', () => {
  it('steer reports it with the code', async () => {
    cliUtils.findTab
      .mockResolvedValueOnce({ workspaceId: 'ws-1', paneId: 'pane-1', tab: TAB })
      .mockResolvedValue({ workspaceId: 'ws-1', paneId: 'pane-1', tab: { ...TAB, sessionName: 'pt-other' } });

    const response = await call('@/pages/api/cli/tabs/[tabId]/steer', 'POST', { content: 'fix it' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: 'agent-target-changed', code: 'target-changed', tabId: 'tab-1' });
    expect(steer.steerSession).not.toHaveBeenCalled();
  });
});

describe('DELETE reports what the close reaped (ADR-0016)', () => {
  it('passes keepProcesses through and returns the reap result', async () => {
    const reap = { reaper: 'linux', envMarker: 'present', killed: [{ pid: 7, comm: 'sleep', args: 'sleep 600' }], survivors: [] };
    layout.closeTab.mockResolvedValue({ ok: true, reap });
    const response = await call('@/pages/api/cli/tabs/[tabId]/index', 'DELETE', {}, { ...QUERY, keepProcesses: '1' });
    expect(layout.closeTab).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), { keepProcesses: true });
    expect(response.body).toEqual({ ok: true, ...reap });
  });
});

describe('DELETE answers ok as the layout reports it', () => {
  it.each([true, false])('ok: %s', async (ok) => {
    layout.closeTab.mockResolvedValue({ ok, reap: null });

    const response = await call('@/pages/api/cli/tabs/[tabId]/index', 'DELETE');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ ok });
  });
});
