import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022 §1, §2, §12: `tab create --host` against the registry, terminal tabs only.

const layout = vi.hoisted(() => ({ addTabToPane: vi.fn() }));
const registry = vi.hoisted(() => ({ hosts: ['ai-server'] as string[] | Error }));
const registerTab = vi.hoisted(() => vi.fn());

vi.mock('@/lib/workspace-layout-read', () => ({ readWorkspaceLayout: vi.fn(async () => ({ root: {} })) }));
vi.mock('@/lib/layout-store', () => ({
  addTabToPane: layout.addTabToPane,
  isAgentPanelType: (panelType?: string) => panelType === 'claude-code' || panelType === 'codex-cli' || panelType === 'grok-cli',
}));
vi.mock('@/lib/layout-tree', () => ({
  collectPanes: vi.fn(() => [{
    tabs: [
      { id: 'tab-r', name: 'remote', sessionName: 'pt-ws-a-p-tab-r', panelType: 'terminal', host: 'ai-server' },
      { id: 'tab-l', name: 'local', sessionName: 'pt-ws-a-p-tab-l', panelType: 'terminal' },
    ],
  }]),
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async (id: string) => ({ id, directories: ['/home/mdone/code/nomupay'] })),
  getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-a' }] })),
}));
vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-a' })),
  canAccessWorkspace: vi.fn(async () => true),
  resolveFirstPaneId: vi.fn(async () => 'pane-one'),
}));
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: vi.fn(() => ({ type: 'workspace', workspaceId: 'ws-a' })) }));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: vi.fn(() => null) }));
vi.mock('@/lib/agent-availability', () => ({ checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })), toAgentAvailabilityError: vi.fn() }));
vi.mock('@/lib/agent-effort', () => ({ isValidReasoningForPanelType: vi.fn(() => true), reasoningErrorForPanelType: vi.fn() }));
vi.mock('@/lib/claude-command', () => ({ buildClaudeFlags: vi.fn(async () => ''), isValidModelName: vi.fn(() => true) }));
vi.mock('@/lib/providers/grok', () => ({ grokProvider: { buildLaunchCommand: vi.fn() } }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ registerTab, markAgentLaunch: vi.fn(), getAllForClient: () => ({}) }),
}));
vi.mock('@/lib/agent-dispatch-policy', () => ({ checkAgentDispatchPolicy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/reports-to', () => ({ checkReportsTo: vi.fn(async () => null) }));
vi.mock('@/lib/tab-token', () => ({ tabIdentityOf: vi.fn(() => 'none') }));
vi.mock('@/lib/providers/codex/managed-launch', () => ({
  prepareCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));
vi.mock('@/lib/remote-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/remote-host')>();
  return {
    ...actual,
    readRemoteHosts: vi.fn(async () => {
      if (registry.hosts instanceof Error) throw registry.hosts;
      return registry.hosts;
    }),
  };
});

const call = async (method: 'GET' | 'POST', body?: unknown) => {
  const { default: handler } = await import('@/pages/api/cli/tabs');
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method, headers: {}, query: {}, body } as unknown as NextApiRequest, res);
  return state;
};

describe('POST /api/cli/tabs with a host (ADR-0022)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.hosts = ['ai-server'];
    layout.addTabToPane.mockImplementation(async (_ws, _pane, name, cwd, panelType, _cmd, opts) => ({
      id: 'tab-new', sessionName: 'pt-ws-a-pane-one-tab-new', name, order: 0, cwd, panelType, ...(opts?.host ? { host: opts.host } : {}),
    }));
  });

  it('creates a terminal tab on a registered host and reports the host', async () => {
    const state = await call('POST', { workspaceId: 'ws-a', name: 'w1', host: 'ai-server' });
    expect(state.statusCode).toBe(201);
    expect(state.body).toMatchObject({ tabId: 'tab-new', panelType: 'terminal', host: 'ai-server', launched: false });
    expect(layout.addTabToPane.mock.calls[0][6]).toMatchObject({ host: 'ai-server' });
    expect(registerTab).toHaveBeenCalledWith('tab-new', expect.objectContaining({ tmuxSession: 'pt-ws-a-pane-one-tab-new' }));
  });

  it.each([
    ['a host not in remote.hosts', 'gpu9'],
    ['a name ssh would read as an option', '-oProxyCommand=sh'],
    ['an empty name', ''],
    ['a non-string', 7],
  ])('refuses %s with remote-host-invalid', async (_label, host) => {
    const state = await call('POST', { workspaceId: 'ws-a', host });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'remote-host-invalid' });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('refuses every host while the registry is empty', async () => {
    registry.hosts = [];
    const state = await call('POST', { workspaceId: 'ws-a', host: 'ai-server' });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'remote-host-invalid', registered: [] });
  });

  it.each(['claude-code', 'codex-cli', 'grok-cli', 'web-browser', 'diff', 'agent-sessions'])('refuses a remote %s tab with remote-type-unsupported', async (panelType) => {
    const state = await call('POST', { workspaceId: 'ws-a', host: 'ai-server', panelType });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'remote-type-unsupported' });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('an unreachable host answers remote-host-unreachable', async () => {
    const { RemoteHostError } = await import('@/lib/remote-host');
    layout.addTabToPane.mockRejectedValueOnce(new RemoteHostError('ai-server', 'remote host ai-server did not answer over ssh'));
    const state = await call('POST', { workspaceId: 'ws-a', host: 'ai-server' });
    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({ code: 'remote-host-unreachable', host: 'ai-server' });
  });

  it('an unreadable fleet config refuses, never reads as no hosts', async () => {
    registry.hosts = new Error('fleet-config.json is not { values, versions, history }');
    const state = await call('POST', { workspaceId: 'ws-a', host: 'ai-server' });
    expect(state.statusCode).toBe(500);
    expect(state.body).toMatchObject({ code: 'config-store-unreadable' });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('a create without a host is unchanged and reads no registry', async () => {
    const { readRemoteHosts } = await import('@/lib/remote-host');
    const state = await call('POST', { workspaceId: 'ws-a' });
    expect(state.statusCode).toBe(201);
    expect(readRemoteHosts).not.toHaveBeenCalled();
    expect(layout.addTabToPane.mock.calls[0][6].host).toBeUndefined();
  });

  it('the tab list serves the host of a remote tab and none for a local one', async () => {
    const state = await call('GET');
    const tabs = (state.body as { tabs: Array<Record<string, unknown>> }).tabs;
    expect(tabs.find((t) => t.tabId === 'tab-r')?.host).toBe('ai-server');
    expect(tabs.find((t) => t.tabId === 'tab-l')).not.toHaveProperty('host');
  });
});
