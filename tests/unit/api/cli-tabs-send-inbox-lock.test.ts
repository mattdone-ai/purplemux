import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { InboxDispatcher, type IInboxDispatcherDeps } from '@/lib/inbox-dispatcher';
import { enqueueInState } from '@/lib/inbox-store';
import type { IInboxState } from '@/types/inbox';
import type { IClientTabStatusEntry, ISubmitEvidence } from '@/types/status';
import type { ITab } from '@/types/terminal';

/**
 * Review r1 F6: a `prompt-submit` that another dispatch caused must not prove a `tab send`. The send reads its
 * baseline, types and polls for proof inside the tab's dispatch lock, and the inbox dispatcher types inside the
 * same lock. Here both run against the REAL lock (`withAgentDispatchLock` over `withCodexTargetLock`): the inbox
 * notice waits until the send has answered, so its turn cannot land in the send's window.
 */

const WORKSPACE_ID = 'ws-lock';
const TAB_ID = 'tab-1';
const SESSION_NAME = 'pt-ws-lock-pane-1-tab-1';
const RULE = '─'.repeat(60);
const EMPTY = ['● Earlier output', '', RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on'].join('\n');

const tab: ITab = { id: TAB_ID, sessionName: SESSION_NAME, name: 'worker', order: 0, panelType: 'claude-code', cliState: 'idle' };

const world = vi.hoisted(() => ({
  evidence: null as ISubmitEvidence | null,
  typed: [] as string[],
}));

/** A turn starts: the hook the agent would post for whatever was just submitted. */
const promptSubmit = (): void => {
  const before = world.evidence!;
  world.evidence = { ...before, cliState: 'busy', eventSeq: before.eventSeq + 1, lastPromptSubmitSeq: before.eventSeq + 1 };
};

vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: async () => ({ id: 'ws-lock', orchestration: { enabled: false } }) }));
vi.mock('@/lib/cli-utils', () => ({
  findTab: async (_ws: string, id: string) => (id === 'tab-1' ? { workspaceId: 'ws-lock', paneId: 'pane-1', tab: { id: 'tab-1', sessionName: 'pt-ws-lock-pane-1-tab-1', name: 'worker', order: 0, panelType: 'claude-code', cliState: 'idle' } } : null),
  authorizeWorkspaceInput: async () => ({ type: 'workspace', workspaceId: 'ws-lock' }),
}));
vi.mock('@/lib/tmux', () => ({
  hasSession: async () => true,
  hasSessionOrUnreachable: async () => true,
  capturePaneContent: async () => ['● Earlier output', '', '─'.repeat(60), '❯ ', '─'.repeat(60), '  ⏵⏵ bypass permissions on'].join('\n'),
  isContentPendingInComposer: async () => false,
  isPaneShowingPendingLine: () => false,
  pressEnter: async () => {},
  observeTabSessionsStrict: async () => ({ state: 'present', sessions: [] }),
  getSessionPanePid: async () => null,
}));
vi.mock('@/lib/agent-prompt-delivery', () => ({
  // The send's own text never starts a turn here: only a turn from another dispatch could "prove" it.
  deliverPrompt: async (_session: string, content: string) => { world.typed.push(`send:${content}`); },
}));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    getAllForClient: () => ({ 'tab-1': { cliState: world.evidence?.cliState ?? 'idle' } }),
    isWaitingAtPrompt: () => false,
    getSubmitEvidence: () => world.evidence,
    routeTabEvent: async () => ({ class: 'urgent', delivered: true, seq: 1, duplicate: false }),
  }),
}));
vi.mock('@/lib/ledger-store', () => ({ getLedgerStore: () => ({ tabEvents: {} }) }));
vi.mock('@/lib/tab-event-router', () => ({ appendDelivered: () => {} }));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
    end() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const inboxFor = (inboxDelivered: () => void) => {
  let state: IInboxState = { items: [] };
  state = enqueueInState(state, {
    kind: 'resume', targetWorkspaceId: WORKSPACE_ID, targetTabId: TAB_ID, dedupeKey: 'k1', fields: { resumeId: 'r-abcd12' },
  }, Date.now(), () => 'i-k1').state;
  const deps = async (): Promise<IInboxDispatcherDeps> => {
    const { withAgentDispatchLock } = await import('@/lib/agent-dispatch-policy');
    return {
      now: () => Date.now(),
      mutate: async (fn) => {
        const out = fn(state);
        state = out.state;
        return out.value;
      },
      findTab: async () => tab,
      tabGone: async () => false,
      hasSession: async () => true,
      // The inbox gate reads the tab as ready, as it would between the send's typing and the hook.
      status: () => ({ cliState: 'idle', permissionRequest: null } as unknown as IClientTabStatusEntry),
      waitingAtPrompt: () => false,
      halted: () => false,
      capture: async () => EMPTY,
      withDispatchLock: (workspaceId, target, work) => withAgentDispatchLock(workspaceId, target, work),
      deliver: async (_session, line) => {
        world.typed.push(`inbox:${line}`);
        inboxDelivered();
        promptSubmit();
      },
      isPending: async () => false,
    };
  };
  return { deps, items: () => state.items };
};

describe('a tab send and a concurrent inbox submit (review r1 F6)', () => {
  beforeEach(() => {
    vi.resetModules();
    world.evidence = { cliState: 'idle', eventSeq: 4, lastPromptSubmitSeq: 2, lastEventFromTool: false };
    world.typed = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the inbox notice until the send has answered, so its turn never proves the send', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/send');
    let sendAnswered = false;
    let inboxDeliveredWhileSendOpen = false;
    const inbox = inboxFor(() => { inboxDeliveredWhileSendOpen = !sendAnswered; });
    const dispatcher = new InboxDispatcher(await inbox.deps());

    const response = fakeResponse();
    const send = (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      { method: 'POST', query: { tabId: TAB_ID, workspaceId: WORKSPACE_ID }, body: { content: 'run the tests' } } as unknown as NextApiRequest,
      response.res,
    ).finally(() => { sendAnswered = true; });

    // The send has typed and now polls for its proof, inside the lock.
    while (!world.typed.includes('send:run the tests')) await vi.advanceTimersByTimeAsync(10);
    const tick = dispatcher.tick();
    while (!sendAnswered) await vi.advanceTimersByTimeAsync(250);
    await send;
    await vi.advanceTimersByTimeAsync(1_000);
    await tick;

    expect(response.state.body).toMatchObject({ submitted: false, notSubmitted: 'submit-unconfirmed' });
    expect(world.typed).toEqual(['send:run the tests', expect.stringMatching(/^inbox:/)]);
    expect(inboxDeliveredWhileSendOpen).toBe(false);
    expect(inbox.items().map((i) => i.state)).toEqual(['delivered']);
  });

  it('a submit that lands inside the window from outside every dispatch path still counts (the known limit)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/send');
    const response = fakeResponse();
    let done = false;
    const send = (handler as (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>)(
      { method: 'POST', query: { tabId: TAB_ID, workspaceId: WORKSPACE_ID }, body: { content: 'run the tests' } } as unknown as NextApiRequest,
      response.res,
    ).finally(() => { done = true; });

    while (!world.typed.includes('send:run the tests')) await vi.advanceTimersByTimeAsync(10);
    // A person types in the pane itself: no route, no lock. The hook carries no text to tell the two apart.
    promptSubmit();
    while (!done) await vi.advanceTimersByTimeAsync(250);
    await send;

    expect(response.state.body).toMatchObject({ submitted: true, confirmation: 'prompt-submit' });
  });
});
