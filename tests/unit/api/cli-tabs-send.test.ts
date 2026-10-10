import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ITab, TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

const tmux = vi.hoisted(() => ({
  hasSession: vi.fn(async () => true),
  isContentPendingInComposer: vi.fn(async () => false),
}));

const delivery = vi.hoisted(() => ({
  deliverPrompt: vi.fn(async () => {}),
}));
const cliUtils = vi.hoisted(() => ({
  findTab: vi.fn(),
  authorizeWorkspaceInput: vi.fn(
    async (): Promise<{ type: string; workspaceId: string } | null> => ({
      type: 'workspace',
      workspaceId: 'ws-send',
    }),
  ),
}));

const live = vi.hoisted(() => ({ entries: {} as Record<string, { cliState: TCliState }>, waiting: new Set<string>() }));
const dispatchPolicy = vi.hoisted(() => vi.fn<
  (workspaceId: string, target: ITab, options?: unknown) => Promise<{ ok: boolean; error?: string }>
>(async () => ({ ok: true })));
vi.mock('@/lib/agent-dispatch-policy', () => ({
  withAgentDispatchLock: async (
    workspaceId: string,
    target: ITab,
    work: (checkPolicy: (options?: unknown) => Promise<unknown>) => Promise<unknown>,
  ) => work((options) => dispatchPolicy(workspaceId, target, options)),
}));

vi.mock('@/lib/tmux', () => Object.assign(tmux, { hasSessionOrUnreachable: tmux.hasSession }));
vi.mock('@/lib/agent-prompt-delivery', () => delivery);
vi.mock('@/lib/cli-utils', () => cliUtils);
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ getAllForClient: () => live.entries, isWaitingAtPrompt: (id: string) => live.waiting.has(id) }),
}));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
    res: undefined as unknown as NextApiResponse,
  };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

const WORKSPACE_ID = 'ws-send';
const TAB_ID = 'tab-1';
const SESSION_NAME = 'pmux-ws-send-pane-1-tab-1';

const tabWith = (cliState?: TCliState, panelType: TPanelType = 'claude-code'): ITab => ({
  id: TAB_ID,
  sessionName: SESSION_NAME,
  name: 'worker',
  order: 0,
  panelType,
  cliState,
});

const locate = (tab: ITab) => ({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab });

interface ISendBody {
  status: string;
  submitted: boolean;
  cliState: TCliState | null;
}

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

describe('POST /api/cli/tabs/[tabId]/send', () => {
  let handler: THandler;

  const call = async (
    body: unknown,
    query: Record<string, string> = { tabId: TAB_ID, workspaceId: WORKSPACE_ID },
    method = 'POST',
  ): Promise<IFakeResponse> => {
    const response = fakeResponse();
    await handler({ method, query, body } as unknown as NextApiRequest, response.res);
    return response;
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    dispatchPolicy.mockResolvedValue({ ok: true });
    live.entries = {};
    live.waiting = new Set();
    tmux.hasSession.mockResolvedValue(true);
    tmux.isContentPendingInComposer.mockResolvedValue(false);
    cliUtils.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: WORKSPACE_ID });
    cliUtils.findTab.mockResolvedValue(locate(tabWith('idle')));
    ({ default: handler } = await import('@/pages/api/cli/tabs/[tabId]/send'));
  });

  it('pastes into a ready agent and reports it submitted', async () => {
    const response = await call({ content: 'run the tests' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'idle' });
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'run the tests');
    expect(dispatchPolicy).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.objectContaining({ id: TAB_ID }),
      { consumeBootstrapForTarget: true },
    );
  });

  it('a remote host that does not answer is retryable 503 remote-host-unreachable, never session-not-running (ADR-0022)', async () => {
    const { RemoteHostError } = await import('@/lib/remote-host');
    tmux.hasSession.mockRejectedValue(new RemoteHostError('ai-server', 'remote host ai-server did not answer over ssh'));
    const response = await call({ content: 'run the tests' });
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: 'remote-host-unreachable', host: 'ai-server' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('never pastes an automated prompt after a model mismatch', async () => {
    dispatchPolicy.mockResolvedValue({ ok: false, error: 'agent-model-mismatch' });
    const response = await call({ content: 'implement story' });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: 'agent-model-mismatch' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('reports submitted false when the paste is still sitting in the composer', async () => {
    tmux.isContentPendingInComposer.mockResolvedValue(true);

    const response = await call({ content: 'run the tests' });

    expect(response.statusCode).toBe(200);
    expect((response.body as ISendBody).submitted).toBe(false);
  });

  it('reports submitted when the composer probe itself fails', async () => {
    tmux.isContentPendingInComposer.mockRejectedValue(new Error('capture-pane failed'));

    const response = await call({ content: 'run the tests' });

    expect((response.body as ISendBody).submitted).toBe(true);
  });

  it('refuses a booting agent, names the tab and its state, and pastes nothing', async () => {
    cliUtils.findTab.mockResolvedValue(locate(tabWith('busy')));

    const response = await call({ content: 'here is your brief', waitMs: 0 });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'agent-not-ready',
      code: 'readiness-timeout',
      tabId: TAB_ID,
      cliState: 'busy',
      detail: 'readiness-timeout',
      waitedMs: expect.any(Number),
    });
    // A measured elapsed time, so a loaded machine reports 1ms for a zero wait.
    expect((response.body as { waitedMs: number }).waitedMs).toBeLessThan(50);
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it.each<TCliState>(['busy', 'inactive', 'unknown', 'cancelled'])(
    'refuses a send while %s',
    async (state) => {
      cliUtils.findTab.mockResolvedValue(locate(tabWith(state)));

      const response = await call({ content: 'hello', waitMs: 0 });

      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ error: 'agent-not-ready', cliState: state });
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    },
  );

  it('refuses an agent tab that reports no state at all', async () => {
    cliUtils.findTab.mockResolvedValue(locate(tabWith(undefined)));

    const response = await call({ content: 'hello', waitMs: 0 });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: 'agent-not-ready', cliState: null });
  });

  it('prefers the live status entry over the state persisted in the layout', async () => {
    live.entries = { [TAB_ID]: { cliState: 'busy' } };

    const response = await call({ content: 'hello', waitMs: 0 });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ cliState: 'busy' });
  });

  it('waits for a booting agent and pastes once it is ready', async () => {
    cliUtils.findTab
      .mockResolvedValueOnce(locate(tabWith('busy')))
      .mockResolvedValue(locate(tabWith('idle')));

    const response = await call({ content: 'here is your brief', waitMs: 40 });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'idle' });
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'here is your brief');
  });

  it('pastes nothing when the wait times out, so a stray Enter cannot submit it later', async () => {
    cliUtils.findTab.mockResolvedValue(locate(tabWith('busy')));

    const response = await call({ content: 'here is your brief', waitMs: 30 });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ detail: 'readiness-timeout', cliState: 'busy' });
    expect((response.body as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(30);
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('pastes at once into a busy agent that is WAITING at its prompt (ADR-0018, ruling A′)', async () => {
    cliUtils.findTab.mockResolvedValue(locate(tabWith('busy')));
    live.entries = { [TAB_ID]: { cliState: 'busy' } };
    live.waiting.add(TAB_ID);

    const response = await call({ content: 'gate r2 is green; merge it', waitMs: 30 });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'busy' });
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'gate r2 is green; merge it');
  });

  it.each<TPanelType>(['terminal', 'web-browser', 'diff'])(
    'leaves a %s tab ungated',
    async (panelType) => {
      cliUtils.findTab.mockResolvedValue(locate(tabWith(undefined, panelType)));

      const response = await call({ content: 'ls -la' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: null });
      expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'ls -la');
    },
  );

  it('reports a dead tmux session as agent-not-ready/session-not-running', async () => {
    tmux.hasSession.mockResolvedValue(false);

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'agent-not-ready',
      code: 'session-not-running',
      tabId: TAB_ID,
      cliState: 'idle',
      detail: 'session-not-running',
    });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('does not wait out the deadline for a dead session', async () => {
    cliUtils.findTab.mockResolvedValue(locate(tabWith('busy')));
    tmux.hasSession.mockResolvedValue(false);

    const response = await call({ content: 'hello', waitMs: 60_000 });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ detail: 'session-not-running' });
  });

  it('404s a tab that is not in the workspace', async () => {
    cliUtils.findTab.mockResolvedValue(null);

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Tab not found', code: 'tab-not-found' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('reports a tab replaced during the wait as target-changed', async () => {
    const replaced = { ...tabWith('idle'), sessionName: 'pmux-ws-send-pane-1-tab-2' };
    cliUtils.findTab
      .mockResolvedValueOnce(locate(tabWith('idle')))
      .mockResolvedValue(locate(replaced));

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: 'agent-target-changed', code: 'target-changed', tabId: TAB_ID });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('reports a tab replaced inside the dispatch lock as target-changed', async () => {
    cliUtils.findTab
      .mockResolvedValueOnce(locate(tabWith('idle')))
      .mockResolvedValueOnce(locate(tabWith('idle')))
      .mockResolvedValue(null);

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({ error: 'agent-target-changed', code: 'target-changed', tabId: TAB_ID });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('reports a session that died inside the dispatch lock as session-not-running', async () => {
    tmux.hasSession.mockResolvedValueOnce(true).mockResolvedValue(false);

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'agent-not-ready',
      code: 'session-not-running',
      tabId: TAB_ID,
      detail: 'session-not-running',
    });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('400s a missing workspaceId', async () => {
    const response = await call({ content: 'hello' }, { tabId: TAB_ID });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'workspaceId is required' });
  });

  it('400s missing content', async () => {
    const response = await call({});

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'content is required' });
  });

  it.each([-1, 1.5, '30000', 600_001])('400s an unusable waitMs of %s', async (waitMs) => {
    const response = await call({ content: 'hello', waitMs });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: expect.stringContaining('waitMs') });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('403s a caller that may not drive the workspace, before touching the tab', async () => {
    cliUtils.authorizeWorkspaceInput.mockResolvedValue(null);

    const response = await call({ content: 'hello' });

    expect(cliUtils.findTab).not.toHaveBeenCalled();
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(0);
  });

  it('405s a non-POST method', async () => {
    const response = await call({ content: 'hello' }, { tabId: TAB_ID, workspaceId: WORKSPACE_ID }, 'GET');

    expect(response.statusCode).toBe(405);
    expect(response.headers.Allow).toBe('POST');
  });
});
