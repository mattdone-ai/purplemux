import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022 §1, §2, §12: `tab create --host` against the registry, terminal tabs only.

const layout = vi.hoisted(() => ({ addTabToPane: vi.fn() }));
const registry = vi.hoisted(() => ({ hosts: ['host-b'] as string[] | Error }));
const registerTab = vi.hoisted(() => vi.fn());
const registerSeat = vi.hoisted(() => vi.fn());
const pool = vi.hoisted(() => ({ start: vi.fn(), release: vi.fn(), plain: vi.fn(), advice: vi.fn() }));
vi.mock('@/lib/pool-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pool-service')>()), startTabOnPool: pool.start, releaseTabStart: pool.release,
  startPlainTab: pool.plain, readTabAdvice: pool.advice,
}));
const placeMode = vi.hoisted(() => ({ value: 'advise' as 'here' | 'advise' | 'place' }));
vi.mock('@/lib/tab-place', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tab-place')>()), readTabPlaceMode: vi.fn(async () => placeMode.value),
}));
vi.mock('@/lib/caller', () => ({
  resolveCaller: vi.fn(async () => ({ scope: { type: 'workspace', workspaceId: 'ws-a' }, workspaceId: 'ws-a', tabId: 'tab-o', tabName: 'o', verified: true, identity: 'launch', admin: false })),
}));

vi.mock('@/lib/workspace-layout-read', () => ({ readWorkspaceLayout: vi.fn(async () => ({ root: {} })) }));
vi.mock('@/lib/layout-store', () => ({
  addTabToPane: layout.addTabToPane,
  isAgentPanelType: (panelType?: string) => panelType === 'claude-code' || panelType === 'codex-cli' || panelType === 'grok-cli',
}));
vi.mock('@/lib/layout-tree', () => ({
  collectPanes: vi.fn(() => [{
    tabs: [
      { id: 'tab-r', name: 'remote', sessionName: 'pt-ws-a-p-tab-r', panelType: 'terminal', host: 'host-b' },
      { id: 'tab-l', name: 'local', sessionName: 'pt-ws-a-p-tab-l', panelType: 'terminal' },
    ],
  }]),
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async (id: string) => ({ id, directories: ['/home/user/code/acme'] })),
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
vi.mock('@/lib/claude-command', () => ({
  buildClaudeFlags: vi.fn(async () => '--settings /home/user/.purplemux/hooks.json'),
  buildRemoteClaudeLaunch: vi.fn(async (ws: string, o?: { model?: string; effort?: string }) => `PATH="$HOME/.purplemux-remote/host-a/bin":"$PATH" claude --settings "$HOME/.purplemux-remote/host-a/hooks.json" ws=${ws} model=${o?.model} effort=${o?.effort}`),
  isValidModelName: vi.fn(() => true),
}));
const dirs = vi.hoisted(() => ({ remote: true as boolean | Error }));
vi.mock('@/lib/providers/grok', () => ({ grokProvider: { buildLaunchCommand: vi.fn() } }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ registerTab, registerSeat, markAgentLaunch: vi.fn(), getAllForClient: () => ({}) }),
}));
vi.mock('@/lib/agent-dispatch-policy', () => ({ checkAgentDispatchPolicy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/reports-to', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/reports-to')>()), checkReportsTo: vi.fn(async () => null) }));
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
    remoteDirExists: vi.fn(async () => {
      if (dirs.remote instanceof Error) throw dirs.remote;
      return dirs.remote;
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
    registry.hosts = ['host-b'];
    dirs.remote = true;
    layout.addTabToPane.mockImplementation(async (_ws, _pane, name, cwd, panelType, _cmd, opts) => ({
      id: 'tab-new', sessionName: 'pt-ws-a-pane-one-tab-new', name, order: 0, cwd, panelType, ...(opts?.host ? { host: opts.host } : {}),
      ...(opts?.handoffPath ? { handoffPath: opts.handoffPath } : {}),
    }));
  });

  it('vel-D5: a remote claude-code tab with a handoff is a seat; its path names the remote host\'s file', async () => {
    const state = await call('POST', { workspaceId: 'ws-a', host: 'host-b', panelType: 'claude-code', handoff: '/srv/wt/.v2/seats/kit/handoff.md' });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
    expect(state.body).toMatchObject({ host: 'host-b', handoffPath: '/srv/wt/.v2/seats/kit/handoff.md' });
    expect(layout.addTabToPane.mock.calls[0][6]).toMatchObject({ host: 'host-b', handoffPath: '/srv/wt/.v2/seats/kit/handoff.md' });
    expect(registerTab).toHaveBeenCalledWith('tab-new', expect.objectContaining({ host: 'host-b', handoffPath: '/srv/wt/.v2/seats/kit/handoff.md' }));
    expect(registerSeat).toHaveBeenCalledWith('tab-new');
  });

  it('creates a terminal tab on a registered host and reports the host', async () => {
    const state = await call('POST', { workspaceId: 'ws-a', name: 'w1', host: 'host-b' });
    expect(state.statusCode).toBe(201);
    expect(state.body).toMatchObject({ tabId: 'tab-new', panelType: 'terminal', host: 'host-b', launched: false });
    expect(layout.addTabToPane.mock.calls[0][6]).toMatchObject({ host: 'host-b' });
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
    const state = await call('POST', { workspaceId: 'ws-a', host: 'host-b' });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'remote-host-invalid', registered: [] });
  });

  it.each([
    ['codex-cli', /managed launch proves the Codex process on this host/],
    ['grok-cli', /no remote hook/],
    ['web-browser', /terminal and claude-code/],
    ['diff', /terminal and claude-code/],
    ['agent-sessions', /terminal and claude-code/],
  ])('refuses a remote %s tab with remote-type-unsupported and a reason', async (panelType, reason) => {
    const state = await call('POST', { workspaceId: 'ws-a', host: 'host-b', panelType });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'remote-type-unsupported', error: expect.stringMatching(reason) });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('creates a remote claude-code tab that launches with the kit on the host, model and effort pinned', async () => {
    const state = await call('POST', { workspaceId: 'ws-a', host: 'host-b', panelType: 'claude-code', model: 'opus', reasoning: 'high' });
    expect(state.statusCode).toBe(201);
    expect(state.body).toMatchObject({ panelType: 'claude-code', host: 'host-b', launched: true });
    const [, , , , panelType, command, opts] = layout.addTabToPane.mock.calls[0];
    expect(panelType).toBe('claude-code');
    expect(command).toBe('PATH="$HOME/.purplemux-remote/host-a/bin":"$PATH" claude --settings "$HOME/.purplemux-remote/host-a/hooks.json" ws=ws-a model=opus effort=high');
    expect(command).not.toContain('/home/user/.purplemux/hooks.json');
    expect(opts).toMatchObject({ host: 'host-b' });
  });

  it('a remote --cwd must exist on the host: it is the tab\'s start directory', async () => {
    const ok = await call('POST', { workspaceId: 'ws-a', host: 'host-b', cwd: '/home/user/code/acme/x' });
    expect(ok.statusCode).toBe(201);
    expect(layout.addTabToPane.mock.calls[0][3]).toBe('/home/user/code/acme/x');
    dirs.remote = false;
    const missing = await call('POST', { workspaceId: 'ws-a', host: 'host-b', cwd: '/home/user/nope' });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toMatchObject({ code: 'cwd-missing', error: expect.stringContaining('host-b') });
    const { RemoteHostError } = await import('@/lib/remote-host');
    dirs.remote = new RemoteHostError('host-b', 'did not answer');
    const down = await call('POST', { workspaceId: 'ws-a', host: 'host-b', cwd: '/home/user/code' });
    expect(down.statusCode).toBe(503);
    expect(down.body).toMatchObject({ code: 'remote-host-unreachable' });
    expect(layout.addTabToPane).toHaveBeenCalledTimes(1);
  });

  it('vel-PMX-FU: the creator\'s own --cwd of a remote tab is its trustCwd; a defaulted cwd is not', async () => {
    registry.hosts = ['host-a'];
    const named = await call('POST', { workspaceId: 'ws-a', host: 'host-a', cwd: '/srv/elsewhere/repo' });
    expect(named.statusCode).toBe(201);
    expect(layout.addTabToPane.mock.calls[0][6]).toMatchObject({ host: 'host-a', trustCwd: '/srv/elsewhere/repo' });
    const defaulted = await call('POST', { workspaceId: 'ws-a', host: 'host-a' });
    expect(defaulted.statusCode).toBe(201);
    expect(layout.addTabToPane.mock.calls[1][6]).not.toHaveProperty('trustCwd');
  });

  it.each(['relative/dir', '', '/x\ny', 7])('refuses a --cwd that is not an absolute path: %j', async (cwd) => {
    const state = await call('POST', { workspaceId: 'ws-a', host: 'host-b', cwd });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'cwd-missing' });
  });

  it('a local --cwd must exist on this host', async () => {
    const missing = await call('POST', { workspaceId: 'ws-a', cwd: '/nonexistent/pmux-test-dir' });
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toMatchObject({ code: 'cwd-missing' });
    const ok = await call('POST', { workspaceId: 'ws-a', cwd: '/tmp' });
    expect(ok.statusCode).toBe(201);
    expect(layout.addTabToPane.mock.calls[0][3]).toBe('/tmp');
  });

  it('an unreachable host answers remote-host-unreachable', async () => {
    const { RemoteHostError } = await import('@/lib/remote-host');
    layout.addTabToPane.mockRejectedValueOnce(new RemoteHostError('host-b', 'remote host host-b did not answer over ssh'));
    const state = await call('POST', { workspaceId: 'ws-a', host: 'host-b' });
    expect(state.statusCode).toBe(503);
    expect(state.body).toMatchObject({ code: 'remote-host-unreachable', host: 'host-b' });
  });

  // Story 12 AC 2: the kit's CLI did not run on the host; no agent started. Exit 1 in the CLI (ADR-0016).
  it('a kit whose CLI does not run on the host answers 502 remote-kit-broken with the host and the line', async () => {
    const { RemoteKitBrokenError } = await import('@/lib/remote-kit');
    layout.addTabToPane.mockRejectedValueOnce(new RemoteKitBrokenError('host-b', "Error: Cannot find module './x.js'"));
    const state = await call('POST', { workspaceId: 'ws-a', host: 'host-b' });
    expect(state.statusCode).toBe(502);
    expect(state.body).toEqual({
      error: "the CLI kit does not run on host-b (Error: Cannot find module './x.js'); no agent started and no session was touched. Repair the kit or the host, then try again",
      code: 'remote-kit-broken',
      host: 'host-b',
      line: "Error: Cannot find module './x.js'",
    });
    expect(registerTab).not.toHaveBeenCalled();
  });

  it('an unreadable fleet config refuses, never reads as no hosts', async () => {
    registry.hosts = new Error('fleet-config.json is not { values, versions, history }');
    const state = await call('POST', { workspaceId: 'ws-a', host: 'host-b' });
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
    expect(tabs.find((t) => t.tabId === 'tab-r')?.host).toBe('host-b');
    expect(tabs.find((t) => t.tabId === 'tab-l')).not.toHaveProperty('host');
  });
});

describe('POST /api/cli/tabs with host auto (ADR-0039 §4; consult ruling, story 17; vel-D4)', () => {
  const remoteStart = { state: 'admitted', host: 'host-b-lan', local: false, reason: 'most free memory: 250 GiB', lease: 'pool:host-b-lan/tab-1', envelope: { threads: 2, memGb: 4 } };
  const localStart = { state: 'admitted', host: 'host-a', local: true, reason: 'type-local-only: a codex-cli tab runs on this host (ADR-0022 §13)', lease: 'pool:host-a/tab-1', envelope: { threads: 2, memGb: 4 } };
  const queuedStart = {
    state: 'queued',
    queued: {
      queued: true, ticket: 'pool-queue:tab-1', kind: 'tab', class: 'product', position: 2, of: 3, refusal: 'no-budget',
      reason: 'queued: position 2 of 3; no host can take the tab (2 threads, 4.0 GiB): host-a: budget threads 24/24 used, needs 2',
      expiresAt: '2026-11-03T07:02:00.000Z', retryAfterSeconds: 10, envelope: { threads: 2, memGb: 4 },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    registry.hosts = ['host-b-lan'];
    dirs.remote = true;
    pool.start.mockImplementation(async (input: { localOnly?: boolean }) => (input.localOnly ? localStart : remoteStart));
    pool.release.mockResolvedValue(undefined);
    layout.addTabToPane.mockImplementation(async (_ws, _pane, name, cwd, panelType, _cmd, opts) => ({
      id: 'tab-new', sessionName: 'pt-ws-a-pane-one-tab-new', name, order: 0, cwd, panelType, ...(opts?.host ? { host: opts.host } : {}),
    }));
  });

  it('a claude-code tab goes where the pool admits it, through the --host checks, says why, and gives the start lease back', async () => {
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code' });
    expect(state.statusCode).toBe(201);
    expect(pool.start).toHaveBeenCalledWith({ panelType: 'claude-code' }, expect.objectContaining({ tabId: 'tab-o', workspaceId: 'ws-a' }), expect.anything());
    expect(state.body).toMatchObject({ host: 'host-b-lan', placement: { host: 'host-b-lan', local: false, reason: 'most free memory: 250 GiB', fallback: false, envelope: { threads: 2, memGb: 4 } } });
    expect(layout.addTabToPane.mock.calls[0][6]).toMatchObject({ host: 'host-b-lan' });
    expect(pool.release).toHaveBeenCalledWith('pool:host-b-lan/tab-1', expect.objectContaining({ tabId: 'tab-o' }), expect.anything());
  });

  it('an admission on this host creates a local tab', async () => {
    pool.start.mockResolvedValue(localStart);
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'codex-cli', launch: false });
    expect(state.statusCode).toBe(201);
    expect(state.body).not.toHaveProperty('host');
    expect(state.body).toMatchObject({ placement: { local: true, fallback: false } });
    expect(layout.addTabToPane.mock.calls[0][6].host).toBeUndefined();
    expect(pool.start).toHaveBeenLastCalledWith({ panelType: 'codex-cli' }, expect.anything(), expect.anything());
  });

  it('a start that fits no host answers 202 pool-queued with its ticket and position; no tab is created, nothing falls back here', async () => {
    pool.start.mockResolvedValue(queuedStart);
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code' });
    expect(state.statusCode).toBe(202);
    expect(state.body).toEqual({ code: 'pool-queued', ...queuedStart.queued });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
    expect(pool.release).not.toHaveBeenCalled();
  });

  it('a pool refusal is 409 pool-full with the figures; no tab is created', async () => {
    pool.start.mockResolvedValue({ state: 'refused', refusal: 'too-large', reason: 'the tab envelope (64 threads, 4.0 GiB) is larger than the worker budget of every allowed host' });
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code' });
    expect(state.statusCode).toBe(409);
    expect(state.body).toMatchObject({ code: 'pool-full', refusal: 'too-large', error: expect.stringContaining('64 threads') });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('the class and the queue ticket go to the pool', async () => {
    await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', poolClass: 'control-plane', queueTicket: 'pool-queue:tab-3' });
    expect(pool.start).toHaveBeenCalledWith({ panelType: 'claude-code', class: 'control-plane', ticket: 'pool-queue:tab-3' }, expect.anything(), expect.anything());
  });

  it('a pool that fails with an error that is not a timeout creates nothing (review r1 F4)', async () => {
    pool.start.mockRejectedValue(new Error('fleet-config.json is malformed'));
    const failed = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', launch: false });
    expect(failed.statusCode).toBe(500);
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it.each([
    ['pool-ticket-gone', 409],
    ['pool-invalid', 400],
    ['pool-full', 409],
  ] as const)('a %s answer is HTTP %i and creates nothing (review r1 F4)', async (code, status) => {
    const { PoolError } = await import('@/lib/pool-service');
    pool.start.mockRejectedValue(new PoolError(code, `${code} from the pool`));
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', queueTicket: 'pool-queue:tab-1', launch: false });
    expect(state.statusCode).toBe(status);
    expect(state.body).toMatchObject({ code, error: `${code} from the pool` });
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('a re-ask the pool does not answer in 2 s is 503 pool-timeout and creates nothing (review r1 F4)', async () => {
    pool.start.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', queueTicket: 'pool-queue:tab-1', launch: false });
      await vi.advanceTimersByTimeAsync(2_000);
      const state = await pending;
      expect(state.statusCode).toBe(503);
      expect(state.body).toMatchObject({ code: 'pool-timeout', error: expect.stringContaining('nothing was created') });
    } finally {
      vi.useRealTimers();
    }
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('a created agent tab is recorded as a tab start the next read cannot show yet (review r1 F6)', async () => {
    const { recentTabStarts } = await import('@/lib/pool-runtime');
    const before = recentTabStarts().get('host-b-lan')?.length ?? 0;
    await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', launch: false });
    expect(recentTabStarts().get('host-b-lan')).toHaveLength(before + 1);
    pool.start.mockResolvedValue(queuedStart);
    await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', launch: false });
    expect(recentTabStarts().get('host-b-lan')).toHaveLength(before + 1);
  });

  it('a --cwd missing on the chosen host gives that start back and creates the tab here on this host\'s budget', async () => {
    dirs.remote = false;
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', cwd: '/tmp', launch: false });
    expect(state.statusCode).toBe(201);
    expect(state.body).toMatchObject({ placement: { local: true, fallback: true, reason: expect.stringContaining('/tmp is not a directory on host-b-lan') } });
    expect(layout.addTabToPane.mock.calls[0][6].host).toBeUndefined();
    expect(pool.release.mock.calls.map((c) => c[0])).toEqual(['pool:host-b-lan/tab-1', 'pool:host-a/tab-1']);
  });

  it('a --cwd missing on the chosen host with this host full is queued', async () => {
    dirs.remote = false;
    pool.start.mockImplementation(async (input: { localOnly?: boolean }) => (input.localOnly ? queuedStart : remoteStart));
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', cwd: '/tmp', launch: false });
    expect(state.statusCode).toBe(202);
    expect(layout.addTabToPane).not.toHaveBeenCalled();
  });

  it('a --cwd the placement proved on the chosen host is probed once, not twice (r2 F4)', async () => {
    const { remoteDirExists } = await import('@/lib/remote-host');
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', cwd: '/home/user/pool/x', launch: false });
    expect(state.statusCode).toBe(201);
    expect(state.body).toMatchObject({ host: 'host-b-lan' });
    expect(remoteDirExists).toHaveBeenCalledTimes(1);
  });

  it('an ssh failure while probing the --cwd names the host, never "not a directory" (r2 F4)', async () => {
    const { RemoteHostError } = await import('@/lib/remote-host');
    dirs.remote = new RemoteHostError('host-b-lan', 'remote host host-b-lan did not answer over ssh');
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', cwd: '/tmp', launch: false });
    expect(state.statusCode).toBe(201);
    expect(state.body).toMatchObject({ placement: { local: true, fallback: true, reason: expect.stringContaining('host-b-lan did not answer') } });
  });

  it.each(['relative/dir', '/x\ny'])('a --cwd that is not an absolute path is refused before the pool is asked: %j', async (cwd) => {
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code', cwd, launch: false });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'cwd-missing' });
    expect(pool.start).not.toHaveBeenCalled();
  });

  it('a chosen host that left remote.hosts is refused by the same check as --host, and the start lease is given back', async () => {
    registry.hosts = [];
    const state = await call('POST', { workspaceId: 'ws-a', host: 'auto', panelType: 'claude-code' });
    expect(state.statusCode).toBe(400);
    expect(state.body).toMatchObject({ code: 'remote-host-invalid' });
    expect(pool.release).toHaveBeenCalledWith('pool:host-b-lan/tab-1', expect.anything(), expect.anything());
  });

  it('a create without --host in mode here never asks the pool', async () => {
    placeMode.value = 'here';
    const state = await call('POST', { workspaceId: 'ws-a', panelType: 'claude-code', launch: false });
    expect(state.statusCode).toBe(201);
    expect(pool.start).not.toHaveBeenCalled();
    expect(pool.plain).not.toHaveBeenCalled();
    expect(pool.advice).not.toHaveBeenCalled();
  });
});

describe('POST /api/cli/tabs without --host: pool.tab-place (ADR-0045)', () => {
  const remotePlain = { state: 'placed', host: 'host-b-lan', local: false, lease: 'pool:host-b-lan/tab-1', envelope: { threads: 2, memGb: 4 }, reason: 'most tab room: 9 more' };
  const advice = { room: { host: 'host-b-lan', local: false, free: 9, reason: 'most tab room: 9 more' }, localFree: 0 };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as Record<string, unknown>).__ptPoolRuntime;
    registry.hosts = ['host-b-lan'];
    dirs.remote = true;
    placeMode.value = 'advise';
    pool.plain.mockResolvedValue(remotePlain);
    pool.advice.mockResolvedValue(advice);
    pool.release.mockResolvedValue(undefined);
    layout.addTabToPane.mockImplementation(async (_ws, _pane, name, cwd, panelType, _cmd, opts) => ({
      id: 'tab-new', sessionName: 'pt-ws-a-pane-one-tab-new', name, order: 0, cwd, panelType, ...(opts?.host ? { host: opts.host } : {}),
    }));
  });

  it('advise (the default): created here at once; the advice is asked but not waited for, then logged and counted', async () => {
    let answer: (v: unknown) => void = () => {};
    pool.advice.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const state = await call('POST', { workspaceId: 'ws-a', panelType: 'claude-code', launch: false });
    expect(state.statusCode).toBe(201);
    expect(state.body).not.toHaveProperty('placement');
    expect(layout.addTabToPane.mock.calls[0][6]).toMatchObject({ host: undefined });
    expect(pool.plain).not.toHaveBeenCalled();
    answer(advice);
    await flush();
    const { tabPlaceView } = await import('@/lib/pool-runtime');
    expect(tabPlaceView()).toMatchObject({ advised: 1, here: 1, hereAtNoRoom: 1, last: { line: expect.stringContaining('mode=advise workspace=ws-a tab=tab-new outcome=here local_free=0 at-no-room | room answer host-b-lan') } });
  });

  it('place: a clean answer on a registered host with the workspace directory there runs the tab there', async () => {
    placeMode.value = 'place';
    const state = await call('POST', { workspaceId: 'ws-a', panelType: 'claude-code', launch: false });
    expect(state.statusCode).toBe(201);
    expect(state.body).toMatchObject({ host: 'host-b-lan', placement: { mode: 'place', host: 'host-b-lan', local: false, applied: true } });
    const { remoteDirExists } = await import('@/lib/remote-host');
    expect(remoteDirExists).toHaveBeenCalledTimes(1);
    expect(remoteDirExists).toHaveBeenCalledWith('host-b-lan', '/home/user/code/acme');
    expect(pool.release).toHaveBeenCalledWith('pool:host-b-lan/tab-1', expect.anything(), expect.anything());
    await flush();
    const { tabPlaceView } = await import('@/lib/pool-runtime');
    expect(tabPlaceView()).toMatchObject({ placedRemote: 1, here: 0 });
  });

  it('place: no --cwd and the workspace directory missing on the chosen host creates the tab here and gives the start back', async () => {
    placeMode.value = 'place';
    dirs.remote = false;
    const state = await call('POST', { workspaceId: 'ws-a', panelType: 'claude-code', launch: false });
    expect(state.statusCode).toBe(201);
    expect(state.body).toMatchObject({ placement: { applied: false, local: true, reason: expect.stringContaining('/home/user/code/acme is not a directory on host-b-lan') } });
    expect(state.body).not.toHaveProperty('host');
    expect(layout.addTabToPane.mock.calls[0][6]).toMatchObject({ host: undefined });
    expect(pool.release).toHaveBeenCalledWith('pool:host-b-lan/tab-1', expect.anything(), expect.anything());
  });

  it('place: an answer that is not clean, or a host not in remote.hosts, creates the tab here: never 202 or 409', async () => {
    placeMode.value = 'place';
    pool.plain.mockResolvedValueOnce({ state: 'here', lease: null, reason: 'no host can take the tab' });
    const refused = await call('POST', { workspaceId: 'ws-a', panelType: 'claude-code', launch: false });
    expect(refused.statusCode).toBe(201);
    expect(refused.body).toMatchObject({ placement: { applied: false, reason: 'fallback: no host can take the tab' } });
    registry.hosts = ['host-c'];
    const unregistered = await call('POST', { workspaceId: 'ws-a', panelType: 'claude-code', launch: false });
    expect(unregistered.statusCode).toBe(201);
    expect(unregistered.body).toMatchObject({ placement: { applied: false, reason: expect.stringContaining('host-b-lan is not in fleet config remote.hosts') } });
  });

  it('--host local, a codex-cli tab, a role and a pool class are never placed, whatever the mode', async () => {
    placeMode.value = 'place';
    for (const body of [
      { host: 'local', panelType: 'claude-code' },
      { panelType: 'codex-cli' },
      { panelType: 'claude-code', poolClass: 'control-plane' },
    ]) {
      const state = await call('POST', { workspaceId: 'ws-a', launch: false, ...body });
      expect(state.statusCode, JSON.stringify(state.body)).toBe(201);
      expect(state.body).not.toHaveProperty('placement');
    }
    expect(pool.plain).not.toHaveBeenCalled();
    expect(pool.start).not.toHaveBeenCalled();
    expect(layout.addTabToPane.mock.calls.every((c) => c[6].host === undefined)).toBe(true);
  });
});
