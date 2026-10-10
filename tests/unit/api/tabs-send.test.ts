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
  deliverPromptText: vi.fn(async () => {}),
}));
const cliUtils = vi.hoisted(() => ({ findTab: vi.fn() }));

const live = vi.hoisted(() => ({ entries: {} as Record<string, { cliState: TCliState }> }));

const GLOBAL_TOKEN = 'global-cli-token';
const WORKSPACE_TOKEN = 'workspace-scoped-token';
const VALID_COOKIE = 'valid-session-jwt';

vi.mock('@/lib/tmux', () => Object.assign(tmux, { hasSessionOrUnreachable: tmux.hasSession }));
vi.mock('@/lib/agent-prompt-delivery', () => delivery);
vi.mock('@/lib/cli-utils', () => ({ findTab: cliUtils.findTab }));
vi.mock('@/lib/cli-token', () => ({
  verifyTokenValue: (value: string | null | undefined) => value === GLOBAL_TOKEN,
}));
vi.mock('@/lib/auth', () => ({
  SESSION_COOKIE: 'session-token',
  extractCookie: (cookie: string) => cookie.split('=')[1],
  MAX_AGE: 7 * 86400,
  verifySessionToken: async (token: string) =>
    (token === VALID_COOKIE ? { sub: 'human', exp: Math.floor(Date.now() / 1000) + 7 * 86400 } : null),
  signSessionToken: async () => 'fresh-jwt',
  buildCookieHeader: (token: string) => `session-token=${token}`,
}));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ getAllForClient: () => live.entries }),
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

const tabWith = (cliState?: TCliState): ITab => ({
  id: TAB_ID,
  sessionName: SESSION_NAME,
  name: 'worker',
  order: 0,
  panelType: 'claude-code',
  cliState,
});

interface ISendBody {
  status: string;
  submitted: boolean;
  cliState: TCliState | null;
}

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

describe('POST /api/tabs/[tabId]/send', () => {
  let handler: THandler;

  const call = async (
    body: unknown,
    query: Record<string, string> = { tabId: TAB_ID, workspaceId: WORKSPACE_ID },
    method = 'POST',
  ): Promise<IFakeResponse> => {
    const response = fakeResponse();
    await handler({ method, query, body, headers: { cookie: `session-token=${VALID_COOKIE}`, host: 'localhost:8022', origin: 'http://localhost:8022' } } as unknown as NextApiRequest, response.res);
    return response;
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    live.entries = {};
    tmux.hasSession.mockResolvedValue(true);
    tmux.isContentPendingInComposer.mockResolvedValue(false);
    cliUtils.findTab.mockResolvedValue({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab: tabWith('idle') });
    ({ default: handler } = await import('@/pages/api/tabs/[tabId]/send'));
  });

  it('a remote host that does not answer is a retryable 503, never a dead session (ADR-0022)', async () => {
    const { RemoteHostError } = await import('@/lib/remote-host');
    tmux.hasSession.mockRejectedValue(new RemoteHostError('ai-server', 'remote host ai-server did not answer over ssh'));
    const response = await call({ content: 'run the tests' });
    expect(response.statusCode).toBe(503);
    expect(response.body).toMatchObject({ code: 'remote-host-unreachable', host: 'ai-server' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('pastes the content and reports it submitted with the tab state', async () => {
    const response = await call({ content: 'run the tests' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'idle' });
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'run the tests');
    expect(delivery.deliverPromptText).not.toHaveBeenCalled();
  });

  it.each<TCliState>(['idle', 'ready-for-review', 'needs-input'])('accepts a send while %s', async (state) => {
    cliUtils.findTab.mockResolvedValue({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab: tabWith(state) });

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(200);
    expect((response.body as ISendBody).cliState).toBe(state);
    expect(delivery.deliverPrompt).toHaveBeenCalledOnce();
  });

  it.each<TCliState>(['busy', 'inactive', 'unknown', 'cancelled'])(
    'delivers a send while %s, exactly as the web client does',
    async (state) => {
      cliUtils.findTab.mockResolvedValue({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab: tabWith(state) });

      const response = await call({ content: 'hello' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: state });
      expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'hello');
    },
  );

  it.each<TPanelType>(['claude-code', 'codex-cli', 'grok-cli'])(
    'delivers to a busy %s tab',
    async (panelType) => {
      cliUtils.findTab.mockResolvedValue({
        workspaceId: WORKSPACE_ID,
        paneId: 'pane-1',
        tab: { ...tabWith('busy'), panelType },
      });

      const response = await call({ content: 'status?' });

      expect(response.statusCode).toBe(200);
      expect(delivery.deliverPrompt).toHaveBeenCalledOnce();
    },
  );

  it('delivers a send to a tab that has no state at all', async () => {
    cliUtils.findTab.mockResolvedValue({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab: tabWith(undefined) });

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'sent', cliState: null });
  });

  it('reports the live status entry rather than the state persisted in the layout', async () => {
    cliUtils.findTab.mockResolvedValue({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab: tabWith('idle') });
    live.entries = { [TAB_ID]: { cliState: 'busy' } };

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'sent', cliState: 'busy' });
  });

  it('never holds the request open waiting for a busy agent to settle', async () => {
    cliUtils.findTab.mockResolvedValue({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab: tabWith('busy') });

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(200);
    expect(cliUtils.findTab).toHaveBeenCalledOnce();
  });

  it('leaves a busy agent content in the composer when submit is false', async () => {
    cliUtils.findTab.mockResolvedValue({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab: tabWith('busy') });

    const response = await call({ content: 'draft', submit: false });

    expect(response.statusCode).toBe(200);
    expect(delivery.deliverPromptText).toHaveBeenCalledWith(SESSION_NAME, 'draft');
  });

  it('leaves the content in the composer when submit is false', async () => {
    const response = await call({ content: 'draft prompt', submit: false });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'sent', submitted: false, cliState: 'idle' });
    expect(delivery.deliverPromptText).toHaveBeenCalledWith(SESSION_NAME, 'draft prompt');
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    expect(tmux.isContentPendingInComposer).not.toHaveBeenCalled();
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

    expect(response.statusCode).toBe(200);
    expect((response.body as ISendBody).submitted).toBe(true);
  });

  it('404s a tab that is not in the workspace', async () => {
    cliUtils.findTab.mockResolvedValue(null);

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'tab-not-found' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('409s when the tab state is sendable but its tmux session is gone', async () => {
    tmux.hasSession.mockResolvedValue(false);

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual({
      error: 'agent-not-ready',
      cliState: 'idle',
      detail: 'session-not-running',
    });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('a dead session is the only refusal left — busy included', async () => {
    tmux.hasSession.mockResolvedValue(false);
    cliUtils.findTab.mockResolvedValue({ workspaceId: WORKSPACE_ID, paneId: 'pane-1', tab: tabWith('busy') });

    const response = await call({ content: 'hello' });

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ cliState: 'busy', detail: 'session-not-running' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it.each([
    ['missing content', {}],
    ['empty content', { content: '' }],
    ['blank content', { content: '   \n ' }],
    ['non-string content', { content: 42 }],
    ['non-boolean submit', { content: 'hi', submit: 'yes' }],
    ['no body at all', undefined],
  ])('400s on %s', async (_label, body) => {
    const response = await call(body);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'bad-request' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
  });

  it('400s without a workspaceId', async () => {
    const response = await call({ content: 'hello' }, { tabId: TAB_ID });

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'bad-request' });
  });

  it('accepts content of exactly 64 KB and rejects one byte more', async () => {
    const { MAX_SEND_CONTENT_BYTES } = await import('@/lib/tab-send');

    const atLimit = await call({ content: 'a'.repeat(MAX_SEND_CONTENT_BYTES) });
    expect(atLimit.statusCode).toBe(200);

    const overLimit = await call({ content: 'a'.repeat(MAX_SEND_CONTENT_BYTES + 1) });
    expect(overLimit.statusCode).toBe(400);
    expect(overLimit.body).toEqual({ error: 'bad-request' });
    expect(delivery.deliverPrompt).toHaveBeenCalledOnce();
  });

  it('measures the size limit in bytes, not code points', async () => {
    const { MAX_SEND_CONTENT_BYTES } = await import('@/lib/tab-send');

    const response = await call({ content: '한'.repeat(MAX_SEND_CONTENT_BYTES / 3 + 1) });

    expect(response.statusCode).toBe(400);
  });

  it('405s a non-POST method', async () => {
    const response = await call({ content: 'hello' }, { tabId: TAB_ID, workspaceId: WORKSPACE_ID }, 'GET');

    expect(response.statusCode).toBe(405);
    expect(response.headers.Allow).toBe('POST');
  });
});

describe('tab-send helpers', () => {
  it('falls back to the persisted state only when there is no live entry', async () => {
    const { resolveTabCliState } = await import('@/lib/tab-send');

    expect(resolveTabCliState(tabWith('idle'), { cliState: 'busy' })).toBe('busy');
    expect(resolveTabCliState(tabWith('idle'), undefined)).toBe('idle');
    expect(resolveTabCliState(tabWith(undefined), undefined)).toBe(null);
  });
});

describe('auth surface of /api/tabs/[tabId]/send', () => {
  const URL = 'http://localhost:8022/api/tabs/tab-1/send';

  const runProxy = async (headers: Record<string, string>) => {
    const { NextRequest } = await import('next/server');
    const { proxy } = await import('@/proxy');
    return proxy(new NextRequest(URL, { method: 'POST', headers }));
  };

  it('sits behind the cookie proxy while /api/cli/** stays token-only', async () => {
    const { config } = await import('@/proxy');
    const guarded = new RegExp(`^${config.matcher[0]}$`);

    expect(guarded.test('/api/tabs/tab-1/send')).toBe(true);
    expect(guarded.test('/api/cli/tabs/tab-1/send')).toBe(false);
  });

  it('lets a session cookie through', async () => {
    const response = await runProxy({ cookie: `session-token=${VALID_COOKIE}` });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('refuses the global CLI token on UI mutations', async () => {
    const response = await runProxy({ 'x-pmux-token': GLOBAL_TOKEN });

    expect(response.status).toBe(401);
    expect(response.headers.get('x-middleware-next')).toBeNull();
  });

  it('401s a workspace-scoped token — this route implements no /api/cli scope rules', async () => {
    const response = await runProxy({ 'x-pmux-token': WORKSPACE_TOKEN });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('401s an unauthenticated call', async () => {
    const response = await runProxy({});

    expect(response.status).toBe(401);
  });
});
