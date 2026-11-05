import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0028 §10: the CLI route (own workspace only) and the cookie route (a human
// session and this server's Origin) call one restart service.

const state = vi.hoisted(() => ({ token: 'local' }));
const service = vi.hoisted(() => ({ restartTab: vi.fn() }));

vi.mock('@/lib/workspace-token', () => ({
  resolveCliScope: () => (state.token === 'global'
    ? { type: 'admin' }
    : state.token === 'none'
      ? null
      : { type: 'workspace', workspaceId: state.token === 'local' ? 'ws-a' : 'ws-other', tabId: 'tab-orch', tabVerified: true }),
}));
vi.mock('@/lib/auth', async (original) => ({
  ...await original<typeof import('@/lib/auth')>(),
  verifySessionToken: vi.fn(async (token: string) => (token === 'human' ? { sub: 'owner' } : null)),
}));
vi.mock('@/lib/caller', () => ({
  resolveCaller: vi.fn(async () => ({ workspaceId: 'ws-a', tabId: 'tab-orch', identity: 'launch' })),
}));
vi.mock('@/lib/tab-restart', async (original) => ({ ...await original<typeof import('@/lib/tab-restart')>(), ...service }));

const ANSWER = { ok: true, workspaceId: 'ws-a', tabId: 'tab-t', resumed: true, identity: 'launch', reaped: { killed: 1, survivors: 0 } };

const response = () => {
  const result = { code: 0, body: undefined as unknown, headers: {} as Record<string, string> };
  const res = {
    status(code: number) { result.code = code; return this; },
    json(body: unknown) { result.body = body; return this; },
    setHeader(name: string, value: string) { result.headers[name] = value; return this; },
  } as unknown as NextApiResponse;
  return { result, res };
};

const request = (opts: { method?: string; cookie?: string; origin?: string | null; body?: unknown; query?: Record<string, string> } = {}) => ({
  method: opts.method ?? 'POST',
  headers: {
    host: 'localhost:8022',
    ...(opts.cookie ? { cookie: `session-token=${opts.cookie}` } : { 'x-pmux-token': 'token' }),
    ...(opts.origin === null ? {} : { origin: opts.origin ?? 'http://localhost:8022' }),
  },
  query: opts.query ?? { workspaceId: 'ws-a', tabId: 'tab-t' },
  body: opts.body ?? {},
  socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const cliRoute = async () => (await import('@/pages/api/cli/tabs/[tabId]/restart')).default;
const cookieRoute = async () => (await import('@/pages/api/tabs/[tabId]/restart')).default;

// The routes' first import loads tab-restart, tmux and the status manager: about 1.4 s alone, and past the
// 5 s test budget under a loaded whole-suite gate (05-r2 and 05-r3, load 38-60 on 64 cores). The import is
// setup, so it gets its own budget and no test pays it.
beforeAll(async () => {
  await cliRoute();
  await cookieRoute();
}, 60_000);

describe('POST /api/cli/tabs/{tabId}/restart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.token = 'local';
    service.restartTab.mockResolvedValue({ status: 200, body: ANSWER });
  });

  it('the own-workspace token restarts the tab, attributed to the calling tab', async () => {
    const { result, res } = response();
    await (await cliRoute())(request({ body: { clear: true, interrupt: true } }), res);
    expect(result).toMatchObject({ code: 200, body: ANSWER, headers: { 'Cache-Control': 'no-store' } });
    expect(service.restartTab).toHaveBeenCalledWith({
      workspaceId: 'ws-a', tabId: 'tab-t', clear: true, interrupt: true,
      by: { kind: 'agent', workspaceId: 'ws-a', tabId: 'tab-orch', identity: 'launch' },
    });
  });

  it.each(['foreign', 'global', 'none'])('the %s token is forbidden and nothing restarts', async (token) => {
    state.token = token;
    const { result, res } = response();
    await (await cliRoute())(request(), res);
    expect(result.code).toBe(403);
    expect(result.body).toMatchObject({ code: 'forbidden' });
    expect(service.restartTab).not.toHaveBeenCalled();
  });

  it('passes the service refusal through with its status and code', async () => {
    service.restartTab.mockResolvedValue({ status: 409, body: { error: 'busy', code: 'tab-busy', tabId: 'tab-t' } });
    const { result, res } = response();
    await (await cliRoute())(request(), res);
    expect(result).toMatchObject({ code: 409, body: { code: 'tab-busy' } });
  });

  it.each([
    [{ workspaceId: 'ws-a', tabId: 'tab-t' }, { clear: 'yes' }, 'clear must be a boolean'],
    [{ tabId: 'tab-t' }, {}, 'workspaceId is required'],
  ])('refuses a malformed request %j %j with 400 invalid-request', async (query, body, error) => {
    const { result, res } = response();
    await (await cliRoute())(request({ query: query as Record<string, string>, body }), res);
    expect(result).toMatchObject({ code: 400, body: { error, code: 'invalid-request' } });
    expect(service.restartTab).not.toHaveBeenCalled();
  });

  it('answers 405 to another method', async () => {
    const { result, res } = response();
    await (await cliRoute())(request({ method: 'GET' }), res);
    expect(result).toMatchObject({ code: 405, headers: { Allow: 'POST' } });
  });
});

describe('POST /api/tabs/{tabId}/restart (cookie)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.token = 'local';
    service.restartTab.mockResolvedValue({ status: 200, body: ANSWER });
  });

  it('a human session with this server\'s Origin restarts the tab as the CLI route does', async () => {
    const { result, res } = response();
    await (await cookieRoute())(request({ cookie: 'human', body: { clear: true } }), res);
    expect(result).toMatchObject({ code: 200, body: ANSWER, headers: { 'Cache-Control': 'no-store' } });
    expect(service.restartTab).toHaveBeenCalledWith({
      workspaceId: 'ws-a', tabId: 'tab-t', clear: true, interrupt: false, by: { kind: 'human', actor: 'owner' },
    });
  });

  it.each(['local', 'global'])('the %s CLI token is not a human: 401', async (token) => {
    state.token = token;
    const { result, res } = response();
    await (await cookieRoute())(request(), res);
    expect(result.code).toBe(401);
    expect(service.restartTab).not.toHaveBeenCalled();
  });

  it('a cookie that does not verify is 401', async () => {
    const { result, res } = response();
    await (await cookieRoute())(request({ cookie: 'forged' }), res);
    expect(result.code).toBe(401);
  });

  it.each([['another Origin', 'http://elsewhere'], ['no Origin', null]] as const)('%s is 403', async (_label, origin) => {
    const { result, res } = response();
    await (await cookieRoute())(request({ cookie: 'human', origin }), res);
    expect(result).toMatchObject({ code: 403, body: { code: 'forbidden' } });
    expect(service.restartTab).not.toHaveBeenCalled();
  });

  it('refuses a malformed body after authentication', async () => {
    const { result, res } = response();
    await (await cookieRoute())(request({ cookie: 'human', body: { interrupt: 'now' } }), res);
    expect(result).toMatchObject({ code: 400, body: { code: 'invalid-request' } });
  });
});
