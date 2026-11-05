import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({
  addTabToPane: vi.fn(),
  getLayout: vi.fn(),
}));
const codex = vi.hoisted(() => ({ buildLaunchCommand: vi.fn() }));
const dispatch = vi.hoisted(() => ({ checkAgentDispatchPolicy: vi.fn() }));
const managed = vi.hoisted(() => ({
  prepareCodexManagedLaunch: vi.fn(),
  submitCodexManagedLaunch: vi.fn(),
  waitForCodexManagedLaunch: vi.fn(),
}));

vi.mock('@/lib/workspace-layout-read', () => ({ readWorkspaceLayout: layout.getLayout }));
vi.mock('@/lib/layout-store', () => ({
  addTabToPane: layout.addTabToPane,
  getLayout: layout.getLayout,
  isAgentPanelType: (panelType?: string) => panelType === 'codex-cli',
}));
vi.mock('@/lib/layout-tree', () => ({ collectPanes: vi.fn(() => []) }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async () => ({ id: 'ws-pins', directories: ['/repo'] })),
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-pins' })),
  canAccessWorkspace: vi.fn(async () => true),
  resolveFirstPaneId: vi.fn(async () => 'pane-one'),
}));
vi.mock('@/lib/workspace-token', () => ({
  resolveCliScope: vi.fn(() => ({ type: 'workspace', workspaceId: 'ws-pins' })),
}));
vi.mock('@/lib/providers', () => ({ getProviderByPanelType: vi.fn(() => ({ id: 'codex', readSessionId: () => null })) }));
vi.mock('@/lib/agent-availability', () => ({
  checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })),
  toAgentAvailabilityError: vi.fn(),
}));
vi.mock('@/lib/agent-effort', () => ({
  isValidReasoningForPanelType: vi.fn(() => true),
  reasoningErrorForPanelType: vi.fn(() => 'Invalid reasoning'),
}));
vi.mock('@/lib/claude-command', () => ({
  buildClaudeFlags: vi.fn(),
  isValidModelName: vi.fn(() => true),
}));
vi.mock('@/lib/providers/codex', () => ({ codexProvider: codex }));
vi.mock('@/lib/providers/grok', () => ({ grokProvider: { buildLaunchCommand: vi.fn() } }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ registerTab: vi.fn(), markAgentLaunch: vi.fn() }),
}));
vi.mock('@/lib/agent-dispatch-policy', () => dispatch);
vi.mock('@/lib/providers/codex/managed-launch', () => managed);
const browser = vi.hoisted(() => ({ checkEvaluatorBrowser: vi.fn() }));
vi.mock('@/lib/tab-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/tab-role')>()), ...browser }));
const reportsTo = vi.hoisted(() => ({ checkReportsTo: vi.fn() }));
// The pure reportOn helpers (ADR-0025) run for real; only the tmux-backed target check is stubbed.
vi.mock('@/lib/reports-to', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/reports-to')>()), ...reportsTo }));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state = { statusCode: 0, body: undefined, res: undefined } as unknown as IFakeResponse;
  state.res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return state;
};

describe('POST /api/cli/tabs launch config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatch.checkAgentDispatchPolicy.mockResolvedValue({ ok: true });
    browser.checkEvaluatorBrowser.mockResolvedValue({ ok: true, version: 'Google Chrome for Testing 156.0.8078.4' });
    codex.buildLaunchCommand.mockResolvedValue('codex-command');
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
    layout.addTabToPane.mockResolvedValue({
      id: 'tab-new',
      sessionName: 'pt-ws-pins-pane-one-tab-new',
      name: 'worker',
      order: 1,
      panelType: 'codex-cli',
    });
  });

  it('persists only the explicitly requested model and effort on the created tab', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: {
        workspaceId: 'ws-pins',
        panelType: 'codex-cli',
        model: 'gpt-5.6-sol',
        reasoning: 'high',
      },
    } as unknown as NextApiRequest, response.res);

    expect(dispatch.checkAgentDispatchPolicy).toHaveBeenCalledWith('ws-pins');
    expect(layout.addTabToPane).toHaveBeenCalledWith(
      'ws-pins',
      'pane-one',
      undefined,
      '/repo',
      'codex-cli',
      undefined,
      {
        scope: undefined,
        agentLaunchConfig: { model: 'gpt-5.6-sol', effort: 'high' },
        admit: expect.any(Function),
      },
    );
    expect(managed.prepareCodexManagedLaunch).toHaveBeenCalledWith('ws-pins', 'tab-new');
    expect(managed.submitCodexManagedLaunch).toHaveBeenCalledWith(
      'ws-pins', 'tab-new', 'codex-generation',
    );
    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({ launched: true, launchState: 'active' });
  });

  it('does not invent launch config for an unpinned tab', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: { workspaceId: 'ws-pins', panelType: 'codex-cli' },
    } as unknown as NextApiRequest, response.res);

    expect(layout.addTabToPane.mock.calls[0][6]).toEqual({
      scope: undefined,
      agentLaunchConfig: undefined,
      admit: expect.any(Function),
    });
  });

  it('returns the dispatch mismatch before building or creating the tab', async () => {
    dispatch.checkAgentDispatchPolicy.mockResolvedValue({
      ok: false,
      error: 'agent-model-mismatch',
      tabId: 'tab-orchestrator',
    });
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: { workspaceId: 'ws-pins', panelType: 'codex-cli' },
    } as unknown as NextApiRequest, response.res);

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: 'agent-model-mismatch', tabId: 'tab-orchestrator' });
    expect(codex.buildLaunchCommand).not.toHaveBeenCalled();
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('refuses a reportsTo outside the workspace before creating anything (ADR-0018)', async () => {
    reportsTo.checkReportsTo.mockResolvedValue({ error: 'not a tab of workspace ws-pins', code: 'reports-to-invalid', reportsTo: 'tab-other' });
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: { workspaceId: 'ws-pins', panelType: 'codex-cli', reportsTo: 'tab-other' },
    } as unknown as NextApiRequest, response.res);

    expect(reportsTo.checkReportsTo).toHaveBeenCalledWith('ws-pins', 'tab-other');
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'reports-to-invalid' });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('creates an evaluator as a claude-code tab with the role and the preview origin stored (ADR-0040)', async () => {
    layout.addTabToPane.mockResolvedValue({ id: 'tab-eval', sessionName: 'pt-ws-pins-pane-one-tab-eval', name: 'evaluator', order: 1, panelType: 'claude-code', role: 'evaluator', previewOrigin: 'http://localhost:3100' });
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: { workspaceId: 'ws-pins', role: 'evaluator', previewUrl: 'http://localhost:3100/batches', pgService: 'preview_42' },
    } as unknown as NextApiRequest, response.res);

    expect(browser.checkEvaluatorBrowser).toHaveBeenCalledTimes(1);
    expect(layout.addTabToPane).toHaveBeenCalledWith(
      'ws-pins', 'pane-one', undefined, '/repo', 'claude-code', undefined,
      expect.objectContaining({ role: 'evaluator', previewOrigin: 'http://localhost:3100', pgService: 'preview_42' }),
    );
    expect(response.statusCode).toBe(201);
    expect(response.body).toMatchObject({ panelType: 'claude-code', role: 'evaluator', previewOrigin: 'http://localhost:3100' });
  });

  it('refuses an evaluator on another engine, a remote host or an unknown role before creating anything', async () => {
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const preview = 'http://localhost:3100';
    for (const body of [
      { workspaceId: 'ws-pins', panelType: 'codex-cli', role: 'evaluator', previewUrl: preview },
      { workspaceId: 'ws-pins', role: 'evaluator', host: 'ai-server', previewUrl: preview },
      { workspaceId: 'ws-pins', panelType: 'claude-code', role: 'reviewer', previewUrl: preview },
      { workspaceId: 'ws-pins', role: 'evaluator' },
      { workspaceId: 'ws-pins', role: 'evaluator', previewUrl: preview, pgService: 'bad name' },
      { workspaceId: 'ws-pins', pgService: 'preview_42' },
    ]) {
      const response = fakeResponse();
      await handler({ method: 'POST', headers: { 'x-pmux-token': 'workspace-token' }, body } as unknown as NextApiRequest, response.res);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ code: 'invalid-request', role: body.role ?? null });
    }
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('refuses the evaluator role on a headless Chrome under 149, naming the version', async () => {
    browser.checkEvaluatorBrowser.mockResolvedValue({ ok: false, error: 'the evaluator role needs Chrome 149+ for its preview allow-list; /h/.local/bin/headless-chrome is Google Chrome for Testing 147.0.7727.15' });
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();
    await handler({ method: 'POST', headers: { 'x-pmux-token': 'workspace-token' }, body: { workspaceId: 'ws-pins', role: 'evaluator', previewUrl: 'http://localhost:3100' } } as unknown as NextApiRequest, response.res);
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ code: 'invalid-request', role: 'evaluator', error: expect.stringContaining('147.0.7727.15') });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('stores a valid reportsTo on the created tab', async () => {
    reportsTo.checkReportsTo.mockResolvedValue(null);
    const { default: handler } = await import('@/pages/api/cli/tabs');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: { workspaceId: 'ws-pins', panelType: 'terminal', reportsTo: 'tab-o2' },
    } as unknown as NextApiRequest, response.res);

    expect(layout.addTabToPane).toHaveBeenCalledWith(
      'ws-pins', 'pane-one', undefined, '/repo', 'terminal', undefined,
      expect.objectContaining({ reportsTo: 'tab-o2' }),
    );
  });
});
