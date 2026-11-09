import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ITab, TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

const panes = vi.hoisted(() => {
  const rule = '─'.repeat(60);
  const claude = (composer: string): string => ['● Earlier output', '', rule, `❯ ${composer}`, rule, '  ⏵⏵ bypass permissions on'].join('\n');
  return { claude, empty: claude('') };
});

const tmux = vi.hoisted(() => ({
  hasSession: vi.fn(async () => true),
  isContentPendingInComposer: vi.fn(async () => false),
  capturePaneContent: vi.fn(async (_session: string, _opts?: unknown): Promise<string | null> => panes.empty),
  isPaneShowingPendingLine: (pane: string, content: string): boolean => pane.includes(`❯ ${content.split('\n')[0]}`),
  pressEnter: vi.fn(async (_session: string) => {}),
}));

const delivery = vi.hoisted(() => ({
  deliverPrompt: vi.fn(async (_session: string, _content: string) => {}),
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

const live = vi.hoisted(() => ({
  entries: {} as Record<string, { cliState: TCliState; startupPrompt?: { kind: 'folder-trust' | 'external-imports'; since: number } | null }>,
  waiting: new Set<string>(),
  evidence: {} as Record<string, import('@/types/status').ISubmitEvidence>,
  /** The agent's prompt-submit hook fires when the typing ends (vel-RETRO-R3); false: no turn starts. */
  hookOnSubmit: true,
}));
const tabEvents = vi.hoisted(() => ({
  route: vi.fn(async (_event: unknown) => ({ class: 'digest', delivered: false, seq: 1, duplicate: false })),
}));
const ledger = vi.hoisted(() => ({ store: null as unknown as import('@/lib/ledger-store').LedgerStore }));
vi.mock('@/lib/ledger-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ledger-store')>();
  return { ...actual, getLedgerStore: () => ledger.store };
});
const dispatchPolicy = vi.hoisted(() => vi.fn<
  (workspaceId: string, target: ITab, options?: unknown) => Promise<{ ok: boolean; error?: string }>
>(async () => ({ ok: true })));
vi.mock('@/lib/agent-dispatch-policy', () => ({
  withAgentDispatchLock: async (
    workspaceId: string,
    target: ITab,
    work: (checkPolicy: (options?: unknown) => Promise<unknown>) => Promise<unknown>,
  ) => work((options) => dispatchPolicy(workspaceId, target, options)),
  withAgentDispatchThen: async (
    workspaceId: string,
    target: ITab,
    work: (checkPolicy: (options?: unknown) => Promise<unknown>) => Promise<unknown>,
    after: (typed: unknown) => Promise<unknown>,
  ) => after(await work((options) => dispatchPolicy(workspaceId, target, options))),
}));

const fleet = vi.hoisted(() => ({ values: {} as Record<string, string>, unreadable: false }));
// The host's budget is vel-D61's reader (`remote-timeouts.ts`, its own tests cover the store); here it reads these
// values through the same key rules.
vi.mock('@/lib/remote-timeouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/remote-timeouts')>();
  return {
    ...actual,
    remoteTimeoutMs: async (host: string) => {
      if (fleet.unreadable) return actual.REMOTE_TIMEOUT_DEFAULT_MS;
      const values = Object.fromEntries(Object.entries(fleet.values).map(([k, value]) => [k, { value, version: 1, setBy: { tabId: 't', workspaceId: 'w' } }]));
      return actual.remoteTimeoutMsIn({ values, versions: {}, history: [] } as never, host);
    },
  };
});

vi.mock('@/lib/tmux', () => Object.assign(tmux, { hasSessionOrUnreachable: tmux.hasSession }));
vi.mock('@/lib/agent-prompt-delivery', () => delivery);
vi.mock('@/lib/cli-utils', () => cliUtils);
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    getAllForClient: () => live.entries,
    isWaitingAtPrompt: (id: string) => live.waiting.has(id),
    getSubmitEvidence: (id: string) => live.evidence[id] ?? null,
    routeTabEvent: tabEvents.route,
  }),
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
    live.evidence = { [TAB_ID]: { cliState: 'idle', eventSeq: 4, lastPromptSubmitSeq: 2, lastEventFromTool: false } };
    live.hookOnSubmit = true;
    fleet.values = {};
    fleet.unreadable = false;
    delivery.deliverPrompt.mockImplementation(async () => {
      const before = live.evidence[TAB_ID];
      if (!live.hookOnSubmit || !before) return;
      live.evidence[TAB_ID] = { ...before, cliState: 'busy', eventSeq: before.eventSeq + 1, lastPromptSubmitSeq: before.eventSeq + 1 };
    });
    tmux.capturePaneContent.mockReset().mockResolvedValue(panes.empty);
    tmux.pressEnter.mockReset();
    const { LedgerStore } = await import('@/lib/ledger-store');
    ledger.store = new LedgerStore(':memory:');
    tmux.hasSession.mockResolvedValue(true);
    tmux.isContentPendingInComposer.mockResolvedValue(false);
    cliUtils.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: WORKSPACE_ID });
    cliUtils.findTab.mockResolvedValue(locate(tabWith('idle')));
    ({ default: handler } = await import('@/pages/api/cli/tabs/[tabId]/send'));
  });

  it('pastes into a ready agent and reports it submitted', async () => {
    const response = await call({ content: 'run the tests' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'idle', confirmation: 'prompt-submit', resubmitted: false });
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'run the tests');
    expect(ledger.store.tabEvents.list(WORKSPACE_ID, { since: 0, limit: 5 })).toEqual([
      expect.objectContaining({ tabId: TAB_ID, kind: 'tab-send', text: 'run the tests', class: 'urgent', deliveredAt: expect.any(Number) }),
    ]);
    expect(dispatchPolicy).toHaveBeenCalledWith(
      WORKSPACE_ID,
      expect.objectContaining({ id: TAB_ID }),
      { consumeBootstrapForTarget: true },
    );
  });

  it('holds a copy or a no-reply message for the tab\'s digest instead of typing it (ADR-0035)', async () => {
    live.entries = { [TAB_ID]: { cliState: 'busy' } };
    const content = 'SCOPE -> ORCH (cc worker): slice 4 contract filed';
    const response = await call({ content });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'queued', submitted: false, wakeClass: 'digest', duplicate: false });
    expect(tabEvents.route).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, tabId: TAB_ID, kind: 'tab-send', text: content, class: 'digest' });
    expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    expect(ledger.store.tabEvents.list(WORKSPACE_ID, { since: 0, limit: 5 })).toEqual([]);

    tabEvents.route.mockResolvedValueOnce({ class: 'digest', delivered: true, seq: 2, duplicate: false });
    expect((await call({ content: 'kit -> ORCH: done. No reply needed.' })).body).toMatchObject({ status: 'sent', submitted: true });
    tabEvents.route.mockResolvedValueOnce({ class: 'log', delivered: false, seq: 3, duplicate: true });
    expect((await call({ content })).body).toMatchObject({ status: 'logged', submitted: false, wakeClass: 'log', duplicate: true });
  });

  it('types a message addressed to the tab at once even when it carries a cc list (architect ruling 09-C1)', async () => {
    const response = await call({ content: 'kit -> worker (cc SM): please rebase' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'sent', submitted: true });
    expect(tabEvents.route).not.toHaveBeenCalled();
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'kit -> worker (cc SM): please rebase');
  });

  it('404s a no-reply message to a tab that is not in the workspace, and holds nothing', async () => {
    cliUtils.findTab.mockResolvedValue(null);
    const response = await call({ content: 'kit -> ORCH (cc worker): note' });
    expect(response.statusCode).toBe(404);
    expect(tabEvents.route).not.toHaveBeenCalled();
  });

  it('answers 409 session-not-running for a no-reply message to a tab whose session is gone, and holds nothing', async () => {
    tmux.hasSession.mockResolvedValue(false);
    const response = await call({ content: 'kit -> ORCH (cc worker): note' });
    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ error: 'agent-not-ready', code: 'session-not-running', tabId: TAB_ID });
    expect(tabEvents.route).not.toHaveBeenCalled();
  });

  it('types a no-reply message into a terminal tab at once: only an agent tab has a digest', async () => {
    cliUtils.findTab.mockResolvedValue(locate(tabWith(undefined, 'terminal')));
    const response = await call({ content: 'kit -> ORCH (cc worker): note' });
    expect(response.statusCode).toBe(200);
    expect(tabEvents.route).not.toHaveBeenCalled();
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'kit -> ORCH (cc worker): note');
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

  describe('the submission needs proof (vel-RETRO-R3)', () => {
    /** Runs a send whose confirmation polls to its deadline, on fake timers. */
    const callToDeadline = async (body: unknown): Promise<IFakeResponse> => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      try {
        let settled = false;
        const pending = call(body).finally(() => { settled = true; });
        while (!settled) await vi.advanceTimersByTimeAsync(250);
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    };

    it('typed-not-submitted: the text stays in the composer, ONE more Enter is pressed, and the body names it', async () => {
      live.hookOnSubmit = false;
      tmux.capturePaneContent
        .mockResolvedValueOnce(panes.empty)
        .mockResolvedValue(panes.claude('run the tests'));

      const response = await callToDeadline({ content: 'run the tests' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        status: 'sent', submitted: false, cliState: 'idle', confirmation: null, resubmitted: true, notSubmitted: 'typed-not-submitted',
      });
      expect(tmux.pressEnter).toHaveBeenCalledTimes(1);
      expect(tmux.pressEnter).toHaveBeenCalledWith(SESSION_NAME);
      expect(delivery.deliverPrompt).toHaveBeenCalledTimes(1);
    });

    it('confirms when the one extra Enter starts the turn', async () => {
      live.hookOnSubmit = false;
      tmux.capturePaneContent
        .mockResolvedValueOnce(panes.empty)
        .mockResolvedValue(panes.claude('run the tests'));
      tmux.pressEnter.mockImplementationOnce(async () => {
        const before = live.evidence[TAB_ID];
        live.evidence[TAB_ID] = { ...before, cliState: 'busy', eventSeq: before.eventSeq + 1, lastPromptSubmitSeq: before.eventSeq + 1 };
      });

      const response = await callToDeadline({ content: 'run the tests' });

      expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'idle', confirmation: 'prompt-submit', resubmitted: true });
    });

    it('a failed probe is not proof: submit-unconfirmed', async () => {
      live.hookOnSubmit = false;
      tmux.capturePaneContent.mockResolvedValueOnce(panes.empty).mockResolvedValue(null);

      const response = await callToDeadline({ content: 'run the tests' });

      expect(response.body).toMatchObject({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
      expect(tmux.pressEnter).not.toHaveBeenCalled();
    });

    it('an empty composer is not proof on a tab with a prompt-submit hook: submit-unconfirmed', async () => {
      live.hookOnSubmit = false;

      const response = await callToDeadline({ content: 'run the tests' });

      expect(response.body).toMatchObject({ submitted: false, notSubmitted: 'submit-unconfirmed' });
    });

    it('a tab with no status entry cannot prove a turn: refused with submit-unconfirmed, and nothing typed (review r1 F4)', async () => {
      live.evidence = {};

      const response = await call({ content: 'run the tests' });

      expect(response.statusCode).toBe(409);
      expect(response.body).toEqual({ error: 'submit-unconfirmed', code: 'submit-unconfirmed', tabId: TAB_ID, typed: false, detail: 'no-submit-evidence' });
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
      expect(tmux.pressEnter).not.toHaveBeenCalled();
      expect(ledger.store.tabEvents.list(WORKSPACE_ID, { since: 0, limit: 5 })).toEqual([]);
    });

    describe('a remote tab\'s window scales with its host\'s remote.timeout-ms (review r1 F2)', () => {
      const remoteTab = (): ITab => ({ ...tabWith('idle'), host: 'host-a' });

      const windowMs = async (): Promise<{ body: unknown; ms: number }> => {
        live.hookOnSubmit = false;
        cliUtils.findTab.mockResolvedValue(locate(remoteTab()));
        let typedAt = 0;
        delivery.deliverPrompt.mockImplementation(async () => { typedAt = Date.now(); });
        vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
        try {
          let settled = false;
          const pending = call({ content: 'run the tests' }).finally(() => { settled = true; });
          while (!settled) await vi.advanceTimersByTimeAsync(250);
          const response = await pending;
          return { body: response.body, ms: Date.now() - typedAt };
        } finally {
          vi.useRealTimers();
        }
      };

      it('waits 10 s with no key set', async () => {
        const { body, ms } = await windowMs();

        expect(body).toMatchObject({ submitted: false, notSubmitted: 'submit-unconfirmed' });
        expect(ms).toBeGreaterThanOrEqual(10_000);
        expect(ms).toBeLessThan(11_000);
      });

      it('waits 30 s for a 15 s host budget, the host key over the fleet key', async () => {
        fleet.values = { 'remote.timeout-ms': '5000', 'remote.timeout-ms.host-a': '15000' };

        const { ms } = await windowMs();

        expect(ms).toBeGreaterThanOrEqual(30_000);
        expect(ms).toBeLessThan(31_000);
      });

      it('reads an unreadable store or an out-of-range value as the default, never a shorter wait', async () => {
        fleet.values = { 'remote.timeout-ms': '1000' };
        const outOfRange = await windowMs();
        fleet.values = {};
        fleet.unreadable = true;
        const unreadable = await windowMs();

        expect(outOfRange.ms).toBeGreaterThanOrEqual(10_000);
        expect(unreadable.ms).toBeGreaterThanOrEqual(10_000);
        expect(unreadable.ms).toBeLessThan(11_000);
      });
    });

    it('reads the baseline inside the lock before typing, so a turn that started earlier is no proof', async () => {
      live.evidence[TAB_ID] = { ...live.evidence[TAB_ID], lastPromptSubmitSeq: 4 };
      live.hookOnSubmit = false;

      const response = await callToDeadline({ content: 'run the tests' });

      expect(response.body).toMatchObject({ submitted: false });
    });

    it('not ready, then ready: an idle tab with no composer drawn waits, then is typed into once', async () => {
      tmux.capturePaneContent
        .mockResolvedValueOnce('Claude Code v2 starting…')
        .mockResolvedValueOnce('Claude Code v2 starting…')
        .mockResolvedValue(panes.empty);

      const response = await call({ content: 'here is your brief', waitMs: 5_000 });

      expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'idle', confirmation: 'prompt-submit', resubmitted: false });
      expect(delivery.deliverPrompt).toHaveBeenCalledTimes(1);
      expect(tmux.capturePaneContent.mock.calls[0]).toEqual([SESSION_NAME, { escapes: true }]);
    });

    it('refuses a composer that holds text until the deadline, names the screen, and types nothing', async () => {
      tmux.capturePaneContent.mockResolvedValue(panes.claude('half a brief somebody typed'));

      const response = await call({ content: 'here is your brief', waitMs: 0 });

      expect(response.statusCode).toBe(409);
      expect(response.body).toMatchObject({ code: 'readiness-timeout', cliState: 'idle', screen: 'composer-not-empty' });
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    });
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

  it.each(['folder-trust', 'external-imports'] as const)(
    'refuses a tab at the %s startup prompt at once, with the dialog and the fix, and types nothing (story 05, D14)',
    async (kind) => {
      cliUtils.findTab.mockResolvedValue(locate(tabWith('inactive')));
      live.entries = { [TAB_ID]: { cliState: 'startup-prompt', startupPrompt: { kind, since: 1 } } };
      const started = Date.now();

      // The default 60 s budget: the refusal must not wait any of it.
      const response = await call({ content: 'here is your brief' });

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(response.statusCode).toBe(409);
      const label = kind === 'folder-trust' ? 'the folder-trust prompt' : 'the external CLAUDE.md imports prompt';
      expect(response.body).toEqual({
        error: 'agent-not-ready',
        code: 'startup-prompt',
        tabId: TAB_ID,
        cliState: 'startup-prompt',
        startupPrompt: kind,
        startupPromptLabel: label,
        detail: `the agent waits at ${label}: answer it in the tab, or create the tab with --cwd under a workspace directory, which purplemux pre-trusts`,
      });
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    },
  );

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
    expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'idle', confirmation: 'prompt-submit', resubmitted: false });
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
    live.evidence[TAB_ID] = { ...live.evidence[TAB_ID], cliState: 'busy' };

    const response = await call({ content: 'gate r2 is green; merge it', waitMs: 30 });

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: 'busy', confirmation: 'prompt-submit', resubmitted: false });
    expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'gate r2 is green; merge it');
  });

  it.each<TPanelType>(['terminal', 'web-browser', 'diff'])(
    'leaves a %s tab ungated',
    async (panelType) => {
      cliUtils.findTab.mockResolvedValue(locate(tabWith(undefined, panelType)));

      const response = await call({ content: 'ls -la' });

      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({ status: 'sent', submitted: true, cliState: null, confirmation: null, resubmitted: false });
      expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'ls -la');
      expect(tmux.capturePaneContent).not.toHaveBeenCalled();
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

  describe('a terminal tab takes one shell command line (story 14, D30)', () => {
    const brief = 'Watch the v2 QA load.\nReport each failed probe.\nStop at 06:00Z.';

    it('refuses multi-line text with the tab type and the line count, and types nothing', async () => {
      cliUtils.findTab.mockResolvedValue(locate(tabWith(undefined, 'terminal')));
      const response = await call({ content: brief });
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        error: expect.stringContaining(`tab ${TAB_ID} is a terminal tab, whose shell runs each line as a command: saw 3 lines; expected one shell command line. A multi-line command`),
        code: 'terminal-not-command-line',
        tabId: TAB_ID,
        panelType: 'terminal',
        lines: 3,
      });
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
      expect(ledger.store.tabEvents.list(WORKSPACE_ID, { since: 0, limit: 5 })).toEqual([]);
    });

    it('counts a tab without a panel type as a terminal tab', async () => {
      const { panelType: _panelType, ...legacy } = tabWith(undefined, 'terminal');
      cliUtils.findTab.mockResolvedValue(locate(legacy as ITab));
      expect((await call({ content: brief })).body).toMatchObject({ code: 'terminal-not-command-line', panelType: 'terminal' });
    });

    it('types one command line, a trailing line break included', async () => {
      cliUtils.findTab.mockResolvedValue(locate(tabWith(undefined, 'terminal')));
      const response = await call({ content: 'tail -f /tmp/qa-load.log\n' });
      expect(response.statusCode).toBe(200);
      expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, 'tail -f /tmp/qa-load.log\n');
    });

    it('types multi-line text as is with raw: true', async () => {
      cliUtils.findTab.mockResolvedValue(locate(tabWith(undefined, 'terminal')));
      const heredoc = "cat <<'EOF' > /tmp/x\nline\nEOF";
      const response = await call({ content: heredoc, raw: true });
      expect(response.statusCode).toBe(200);
      expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, heredoc);
    });

    it('types multi-line text into an agent tab: the check is for a shell only', async () => {
      const response = await call({ content: brief });
      expect(response.statusCode).toBe(200);
      expect(delivery.deliverPrompt).toHaveBeenCalledWith(SESSION_NAME, brief);
    });

    it('refuses a raw value that is not a boolean', async () => {
      const response = await call({ content: 'ls', raw: 'yes' });
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ error: 'raw: saw the string "yes"; expected true or false', code: 'invalid-request' });
      expect(delivery.deliverPrompt).not.toHaveBeenCalled();
    });
  });
});
