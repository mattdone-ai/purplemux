import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ISubmitEvidence } from '@/types/status';
import type { ITab } from '@/types/terminal';

/**
 * CONFIRM r2 on vel-RETRO-R3: a live Codex hook is applied inside `withCodexTargetLock` for its tab, the lock a
 * dispatch types under. A send that waited for its proof under that lock locked its own proof out, so every
 * submitted send to a local Codex tab answered `submit-unconfirmed`. Here the hook goes through the REAL
 * `dispatchHook` -> `handleCodexHook` -> `withValidatedLegacyCodexHook` -> `withCodexTargetLock` path while the send
 * runs; only the status manager, which records the event, is a stand-in.
 */

const WS = 'ws-codex';
const TARGET = 'tab-cx';
const ORCH = 'tab-orch';
const SESSION_ID: Record<string, string> = {
  [TARGET]: '11111111-1111-4111-8111-111111111111',
  [ORCH]: '22222222-2222-4222-8222-222222222222',
};

const world = vi.hoisted(() => ({
  orchestratorEnabled: false,
  evidence: {} as Record<string, ISubmitEvidence>,
  /** What happened, in order: the typing, each hook applied, the send's answer. */
  log: [] as string[],
  hooks: [] as Promise<unknown>[],
  /** The hooks the agent posts when the typed text is submitted. */
  onSubmit: [] as string[],
}));

const codexTab = (id: string): ITab => ({
  id, name: id, order: 0, sessionName: `pt-ws-codex-pane-1-${id}`, panelType: 'codex-cli', cliState: 'idle',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
  agentState: {
    providerId: 'codex',
    sessionId: id === 'tab-cx' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222',
    jsonlPath: `/sessions/${id}.jsonl`,
  },
} as unknown as ITab);

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: async () => ({ id: 'ws-codex', orchestration: world.orchestratorEnabled ? { enabled: true, orchestratorTabId: 'tab-orch' } : { enabled: false } }),
}));
vi.mock('@/lib/cli-utils', () => ({
  findTab: async (workspaceId: string, id: string) => (id === 'tab-cx' || id === 'tab-orch' ? { workspaceId, paneId: 'pane-1', tab: codexTab(id) } : null),
  authorizeWorkspaceInput: async () => ({ type: 'workspace', workspaceId: 'ws-codex' }),
}));
const modelMatch = vi.hoisted(() => async () => ({
  expected: { model: 'gpt-6-astra', effort: 'high' }, observed: null, latestTurn: null, latestSettings: null,
  scanState: 'complete' as const, hasActivity: true, status: 'match' as const, reason: null,
}));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: modelMatch }));
vi.mock('@/lib/tmux', () => ({
  hasSession: async () => true,
  hasSessionOrUnreachable: async () => true,
  capturePaneContent: async () => 'codex output\n\n› \n',
  isContentPendingInComposer: async () => false,
  isPaneShowingPendingLine: () => false,
  pressEnter: async () => {},
  observeTabSessionsStrict: async () => ({ state: 'present', sessions: ['pt-ws-codex-pane-1-tab-orch'] }),
  getSessionPanePid: async () => null,
}));
vi.mock('@/lib/ledger-store', () => ({ getLedgerStore: () => ({ tabEvents: {} }) }));
vi.mock('@/lib/tab-event-router', () => ({ appendDelivered: () => {} }));

// The legacy hook gate imports the model observation dynamically, and measured here the second such import in a run
// reached the unmocked module. The model check is not under test: the actual module answers `match` too.
const actualModel = await vi.importActual<typeof import('@/lib/providers/codex/model-observation')>('@/lib/providers/codex/model-observation');
vi.spyOn(actualModel, 'getCodexModelStatus').mockImplementation(modelMatch as never);

/** The agent posts its hooks the moment the typed text is submitted: they reach the server while the send runs. */
const postHook = (tabId: string): void => {
  world.hooks.push((async () => {
    const { dispatchHook } = await import('@/lib/hook-dispatch');
    return dispatchHook({
      query: { provider: 'codex', tmuxSession: `pt-ws-codex-pane-1-${tabId}` },
      body: { hook_event_name: 'UserPromptSubmit', session_id: SESSION_ID[tabId], prompt: 'run the tests' },
    });
  })());
};

vi.mock('@/lib/agent-prompt-delivery', () => ({
  deliverPrompt: async () => {
    world.log.push('typed');
    for (const tabId of world.onSubmit) postHook(tabId);
  },
}));

const tabOfSession = (session: string): string => session.replace(/^pt-ws-codex-pane-1-/, '');

vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    getAllForClient: () => ({ 'tab-cx': { cliState: world.evidence['tab-cx']?.cliState ?? 'idle' } }),
    isWaitingAtPrompt: () => false,
    getSubmitEvidence: (tabId: string) => world.evidence[tabId] ?? null,
    agentSessionIdForTmuxSession: (session: string) => SESSION_ID[tabOfSession(session)] ?? null,
    applyAgentHookMeta: (_provider: string, session: string) => ({ tabId: tabOfSession(session), cliState: 'idle', stale: false }),
    handleToolCall: () => {},
    codexLaunchLifecycle: () => null,
    recordSkippedReplay: () => {},
    // What the real status manager does for a turn-starting submit: a new eventSeq, kept as lastPromptSubmit.
    handleProviderEvent: (_provider: string, session: string, event: { kind: string }) => {
      if (event.kind !== 'prompt-submit') return;
      const tabId = tabOfSession(session);
      const before = world.evidence[tabId] ?? { cliState: 'idle', eventSeq: 0, lastPromptSubmitSeq: null, lastEventFromTool: false };
      world.evidence[tabId] = { ...before, cliState: 'busy', eventSeq: before.eventSeq + 1, lastPromptSubmitSeq: before.eventSeq + 1 };
      world.log.push(`hook:${tabId}`);
    },
  }),
}));

const send = async (): Promise<{ statusCode: number; body: unknown }> => {
  const out = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { out.statusCode = code; return this; },
    json(payload: unknown) { out.body = payload; world.log.push('answered'); return this; },
    setHeader() { return this; },
    end() { return this; },
  } as unknown as NextApiResponse;
  const { default: handler } = await import('@/pages/api/cli/tabs/[tabId]/send');
  await handler({ method: 'POST', query: { tabId: TARGET, workspaceId: WS }, body: { content: 'run the tests' } } as unknown as NextApiRequest, res);
  return out;
};

describe('tab send to a local Codex tab, with the real Codex hook path (CONFIRM r2)', () => {
  beforeEach(() => {
    world.orchestratorEnabled = false;
    world.evidence = {
      [TARGET]: { cliState: 'idle', eventSeq: 4, lastPromptSubmitSeq: 2, lastEventFromTool: false },
      [ORCH]: { cliState: 'idle', eventSeq: 9, lastPromptSubmitSeq: 3, lastEventFromTool: false },
    };
    world.log = [];
    world.hooks = [];
    world.onSubmit = [];
  });

  it('takes the Codex prompt-submit hook, applied through the tab lock, as proof: submitted, exit 0', async () => {
    world.onSubmit = [TARGET];

    const response = await send();
    await Promise.all(world.hooks);

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ status: 'sent', submitted: true, confirmation: 'prompt-submit' });
    expect(world.log).toEqual(['typed', `hook:${TARGET}`, 'answered']);
  }, 15_000);

  it('does not hold a Codex orchestrator\'s lock through the proof window: its hook applies before the send answers', async () => {
    world.orchestratorEnabled = true;
    world.onSubmit = [ORCH, TARGET];

    const response = await send();
    await Promise.all(world.hooks);

    expect(response.body).toMatchObject({ submitted: true, confirmation: 'prompt-submit' });
    expect(world.log.indexOf(`hook:${ORCH}`)).toBeGreaterThan(world.log.indexOf('typed'));
    expect(world.log.indexOf(`hook:${ORCH}`)).toBeLessThan(world.log.indexOf('answered'));
  }, 15_000);

  it('answers submit-unconfirmed when no hook comes, so the test above is not passing by default', async () => {
    const response = await send();

    expect(response.body).toMatchObject({ submitted: false, notSubmitted: 'submit-unconfirmed' });
  }, 15_000);
});
