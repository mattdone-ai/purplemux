import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab } from '@/types/terminal';
import type { ICodexModelStatus } from '@/lib/providers/codex/model-observation';

const mocks = vi.hoisted(() => ({
  tabs: new Map<string, ITab>(),
  crown: 'm-crown' as string | null,
  tabSessions: { state: 'unknown', reason: 'tmux did not list sessions' } as { state: string; reason?: string },
  events: [] as string[],
  find: vi.fn(),
  workspace: vi.fn(),
  model: vi.fn(),
  paste: vi.fn(),
  escape: vi.fn(),
  hasSession: vi.fn(),
  update: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('@/lib/cli-utils', () => ({
  findTab: mocks.find,
  authorizeWorkspaceInput: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-lock' })),
  authorizeWorkspace: vi.fn(async () => ({ type: 'workspace', workspaceId: 'ws-lock' })),
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: mocks.workspace }));
vi.mock('@/lib/layout-store', () => ({
  updateTabAgentLaunchConfig: mocks.update,
  mutateTabAtomically: mocks.mutate,
  removeTabFromPane: vi.fn(),
}));
vi.mock('@/lib/providers', () => ({
  getProviderByPanelType: (panelType: string) => panelType === 'codex-cli' ? { id: 'codex' } : null,
}));
vi.mock('@/lib/providers/codex', () => ({
  CODEX_LAUNCHER_SCRIPT: '/test/codex-launcher.js',
  codexProvider: { isValidSessionId: () => true },
}));
vi.mock('@/lib/providers/codex/session-detection', () => ({ findCodexSessionById: vi.fn() }));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: mocks.model }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ getAllForClient: () => ({}), isWaitingAtPrompt: () => false }) }));
vi.mock('@/lib/agent-prompt-delivery', () => ({ deliverPrompt: mocks.paste }));
vi.mock('@/lib/tmux', () => ({
  hasSession: mocks.hasSession,
  hasSessionOrUnreachable: (...args: Parameters<typeof mocks.hasSession>) => mocks.hasSession(...args),
  sendEscape: mocks.escape,
  isContentPendingInComposer: vi.fn(async () => false),
  observeTabSessionsStrict: async () => mocks.tabSessions,
}));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn() }) }));

import sendHandler from '@/pages/api/cli/tabs/[tabId]/send';
import steerHandler from '@/pages/api/cli/tabs/[tabId]/steer';
import patchHandler from '@/pages/api/cli/tabs/[tabId]';
import { AutomatedPromptDispatcher } from '@/lib/automated-prompt-dispatcher';
import { beginCodexLaunch, withCodexTargetLock } from '@/lib/providers/codex/launch-lifecycle';
import { checkAgentDispatchPolicy, withAgentDispatchLock } from '@/lib/agent-dispatch-policy';

const WS = 'ws-lock';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const tab = (id: string): ITab => ({
  id, name: id, order: 0, panelType: 'codex-cli', sessionName: `tmux-${id}`, cliState: 'idle',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
});
const status = (value: ITab): ICodexModelStatus => ({
  expected: { model: value.agentLaunchConfig?.model ?? null, effort: value.agentLaunchConfig?.effort ?? null },
  observed: null, latestTurn: null, latestSettings: null, scanState: 'complete', hasActivity: false,
  status: value.codexLaunchRuntime?.pending ? 'unknown'
    : value.agentLaunchConfig?.model === 'gpt-6-astra' ? 'match' : 'mismatch',
  reason: value.codexLaunchRuntime?.pending ? 'launch-pending' : null,
});
const call = async (
  handler: typeof sendHandler,
  tabId = 'a-worker',
  body: unknown = { content: 'work', waitMs: 0 },
  method = 'POST',
) => {
  const response = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { response.status = code; return this; },
    json(body: unknown) { response.body = body; return this; },
  } as unknown as NextApiResponse;
  await handler({ method, query: { workspaceId: WS, tabId }, body } as unknown as NextApiRequest, res);
  return response;
};
const patch = (tabId = 'a-worker') => call(patchHandler, tabId, {
  agentLaunchConfig: { model: 'gpt-5.6-sol', effort: 'high' },
}, 'PATCH');
const automate = (dispatcher: AutomatedPromptDispatcher, targetTabId = 'a-worker', message = 'work') =>
  dispatcher.dispatch({ workspaceId: WS, targetTabId, message });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.crown = 'm-crown';
  mocks.tabSessions = { state: 'unknown', reason: 'tmux did not list sessions' };
  mocks.events = [];
  mocks.tabs = new Map(['a-worker', 'm-crown', 'z-worker', 'new-crown'].map((id) => [id, tab(id)]));
  mocks.find.mockImplementation(async (_ws: string, id: string) => {
    const current = mocks.tabs.get(id);
    return current ? { workspaceId: WS, paneId: 'pane', tab: structuredClone(current) } : null;
  });
  mocks.workspace.mockImplementation(async () => ({
    orchestration: { enabled: !!mocks.crown, orchestratorTabId: mocks.crown },
  }));
  mocks.model.mockImplementation(async (value: ITab) => status(value));
  mocks.hasSession.mockResolvedValue(true);
  mocks.escape.mockResolvedValue(undefined);
  mocks.paste.mockResolvedValue(undefined);
  mocks.update.mockImplementation(async (_ws: string, _pane: string, id: string, config: ITab['agentLaunchConfig']) => {
    const current = mocks.tabs.get(id)!;
    current.agentLaunchConfig = config;
    mocks.events.push(`patch:${id}`);
    return structuredClone(current);
  });
  mocks.mutate.mockImplementation(async (
    _ws: string, id: string, mutate: (current: ITab) => { changed: boolean; value: unknown },
  ) => {
    const current = mocks.tabs.get(id);
    if (!current) return { found: false };
    const result = mutate(current);
    mocks.events.push(`mutate:${id}`);
    return { found: true, value: result.value, tab: structuredClone(current) };
  });
});
afterEach(() => { vi.useRealTimers(); });

describe('real dispatch callers share lifecycle transactions', () => {
  it.each(['patch', 'crown-replacement'] as const)('blocks %s after model inspection but before the paste call', async (mutation) => {
    const inspected = deferred();
    const release = deferred();
    mocks.model.mockImplementation(async (value: ITab) => {
      const result = status(value);
      if (value.id === 'm-crown') {
        inspected.resolve();
        await release.promise;
      }
      return result;
    });
    mocks.paste.mockImplementation(async () => { mocks.events.push('paste'); });
    const delivery = call(sendHandler);
    await inspected.promise;
    const changing = mutation === 'patch' ? patch() : beginCodexLaunch(WS, 'm-crown');
    await flush();
    const waited = mocks.update.mock.calls.length === 0 && mocks.mutate.mock.calls.length === 0;
    const notYetPasted = mocks.paste.mock.calls.length === 0;
    release.resolve();
    expect(await delivery).toMatchObject({ status: 200 });
    await changing;
    expect(waited).toBe(true);
    expect(notYetPasted).toBe(true);
    expect(mocks.events).toEqual(['paste', mutation === 'patch' ? 'patch:a-worker' : 'mutate:m-crown']);
  });

  it.each(['cli', 'automated', 'steer'] as const)('%s holds target PATCH from checked policy through awaited paste', async (kind) => {
    const entered = deferred();
    const release = deferred();
    mocks.paste.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      mocks.events.push('paste');
    });
    const delivery = kind === 'cli' ? call(sendHandler)
      : kind === 'steer' ? call(steerHandler, 'a-worker', { content: 'correct', interrupt: false })
        : automate(new AutomatedPromptDispatcher());
    await entered.promise;
    let patched = false;
    const updating = patch().then((result) => { patched = true; return result; });
    await flush();
    const waited = !patched && mocks.update.mock.calls.length === 0;
    release.resolve();
    const [result, updated] = await Promise.all([delivery, updating]);
    expect(waited).toBe(true);
    expect(result).toMatchObject(kind === 'automated' ? { delivered: true } : { status: 200 });
    expect(updated.status).toBe(200);
    expect(mocks.events).toEqual(['paste', 'patch:a-worker']);
  });

  it.each(['cli', 'automated', 'steer'] as const)('%s holds managed crown replacement through awaited paste', async (kind) => {
    const entered = deferred();
    const release = deferred();
    mocks.paste.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      mocks.events.push('paste');
    });
    const delivery = kind === 'cli' ? call(sendHandler)
      : kind === 'steer' ? call(steerHandler, 'a-worker', { content: 'correct', interrupt: false })
        : automate(new AutomatedPromptDispatcher());
    await entered.promise;
    const replacement = beginCodexLaunch(WS, 'm-crown');
    await flush();
    const waited = mocks.mutate.mock.calls.length === 0;
    release.resolve();
    await delivery;
    expect(await replacement).toMatchObject({ ok: true, state: 'prepared' });
    expect(waited).toBe(true);
    expect(mocks.events).toEqual(['paste', 'mutate:m-crown']);
    expect(await call(sendHandler)).toMatchObject({ status: 409, body: { tabId: 'm-crown' } });
    expect(mocks.paste).toHaveBeenCalledTimes(1);
  });

  it('rereads PATCH pins before checking a delivery queued behind that PATCH', async () => {
    const entered = deferred();
    const release = deferred();
    const update = mocks.update.getMockImplementation()!;
    mocks.update.mockImplementation(async (...args: unknown[]) => {
      entered.resolve();
      await release.promise;
      return update(...args);
    });
    const updating = patch();
    await entered.promise;
    const delivery = call(sendHandler);
    await flush();
    release.resolve();
    await updating;
    expect(await delivery).toMatchObject({ status: 409, body: { error: 'agent-model-mismatch' } });
    expect(mocks.paste).not.toHaveBeenCalled();
  });

  it('serializes two workers sharing a crown without deadlock, including workers on either side of crown sort order', async () => {
    const entered = deferred();
    const release = deferred();
    mocks.paste.mockImplementation(async (session: string) => {
      mocks.events.push(session);
      if (session === 'tmux-a-worker') { entered.resolve(); await release.promise; }
    });
    const first = call(sendHandler);
    await entered.promise;
    const dispatcher = new AutomatedPromptDispatcher();
    const second = automate(dispatcher, 'z-worker');
    const crown = automate(dispatcher, 'm-crown');
    await flush();
    const callsBeforeRelease = mocks.paste.mock.calls.length;
    release.resolve();
    expect(await first).toMatchObject({ status: 200 });
    expect(await second).toEqual({ delivered: true });
    expect(await crown).toEqual({ delivered: true });
    expect(callsBeforeRelease).toBe(1);
    expect(mocks.events).toEqual(['tmux-a-worker', 'tmux-z-worker', 'tmux-m-crown']);
  });

  it('fails closed if crown changes during lock acquisition without inspecting the unlocked new crown', async () => {
    const entered = deferred();
    const release = deferred();
    const held = withCodexTargetLock(WS, 'a-worker', async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const delivery = call(sendHandler);
    await flush();
    mocks.crown = 'new-crown';
    release.resolve();
    await held;
    expect(await delivery).toMatchObject({ status: 409, body: { error: 'agent-model-unverified' } });
    expect(mocks.find.mock.calls.some(([, id]) => id === 'new-crown')).toBe(false);
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.paste).not.toHaveBeenCalled();
  });

  it('does not skip a missing enabled crown', async () => {
    mocks.tabs.delete('m-crown');
    expect(await call(sendHandler)).toMatchObject({ status: 409, body: { tabId: 'm-crown' } });
    expect(mocks.paste).not.toHaveBeenCalled();
  });

  it('delivers past a crown that was closed: gone from the layout, no session of it survives', async () => {
    mocks.tabs.delete('m-crown');
    mocks.tabSessions = { state: 'absent', reason: 'no tmux session of the tab survives' };
    expect(await call(sendHandler)).toMatchObject({ status: 200 });
    expect(mocks.paste).toHaveBeenCalled();
  });

  it.each([false, true])('steer rechecks policy after interrupt (interrupt failure: %s)', async (interruptFailure) => {
    mocks.escape.mockImplementation(async () => {
      mocks.model.mockImplementation(async (value: ITab) => ({ ...status(value), status: 'mismatch' }));
      if (interruptFailure) throw new Error('interrupt unavailable');
    });
    const result = await call(steerHandler);
    expect(result).toMatchObject({ status: 409, body: { error: 'agent-model-mismatch' } });
    expect(mocks.escape).toHaveBeenCalledOnce();
    expect(mocks.model.mock.calls.filter(([value]) => value.id === 'a-worker')).toHaveLength(2);
    expect(mocks.paste).not.toHaveBeenCalled();
  });

  it('steer locks interruption and its final paste against PATCH and crown replacement', async () => {
    const entered = deferred();
    const release = deferred();
    mocks.escape.mockImplementation(async () => { entered.resolve(); await release.promise; });
    const delivery = call(steerHandler);
    await entered.promise;
    const updating = patch();
    const replacing = beginCodexLaunch(WS, 'm-crown');
    await flush();
    const waited = mocks.update.mock.calls.length === 0 && mocks.mutate.mock.calls.length === 0;
    release.resolve();
    expect(await delivery).toMatchObject({ status: 200, body: { interrupted: true } });
    await Promise.all([updating, replacing]);
    expect(waited).toBe(true);
    expect(mocks.paste).toHaveBeenCalledOnce();
    expect(mocks.model.mock.calls.filter(([value]) => value.id === 'a-worker')).toHaveLength(2);
  });

  it('releases both locks after paste failure and preserves the automated queue', async () => {
    mocks.paste.mockRejectedValueOnce(new Error('paste unavailable')).mockResolvedValue(undefined);
    const dispatcher = new AutomatedPromptDispatcher();
    expect(await automate(dispatcher)).toMatchObject({ delivered: false, reason: 'delivery-error' });
    expect(await automate(dispatcher)).toEqual({ delivered: true });
    expect(await patch()).toMatchObject({ status: 200 });
    expect(await beginCodexLaunch(WS, 'm-crown')).toMatchObject({ ok: true });
  });

  it('keeps an actual bootstrap claim consumed after paste failure, PATCH and later observed match', async () => {
    mocks.crown = null;
    const current = mocks.tabs.get('a-worker')!;
    current.codexLaunchRuntime = { active: {
      generation: 'generation', phase: 'active', workspaceId: WS, tabId: current.id,
      sessionName: current.sessionName, launchedConfig: { ...current.agentLaunchConfig },
      resumeSessionId: null, confirmedAt: new Date().toISOString(), observationBoundary: null,
      launcher: { pid: 10, startedAtMs: 100 }, agent: { pid: 20, startedAtMs: 200 }, bootstrap: 'unused',
    } };
    mocks.model.mockImplementation(async (value: ITab) => ({ ...status(value), status: 'unknown', reason: 'awaiting-first-turn' }));
    mocks.paste.mockRejectedValueOnce(new Error('paste unavailable'));
    const dispatcher = new AutomatedPromptDispatcher();
    expect(await automate(dispatcher)).toMatchObject({ delivered: false, reason: 'delivery-error' });
    expect(current.codexLaunchRuntime.active!.bootstrap).toBe('consumed');
    await patch();
    mocks.model.mockImplementation(async (value: ITab) => ({ ...status(value), status: 'match', reason: null }));
    expect(await checkAgentDispatchPolicy(WS, current)).toEqual({ ok: true });
    expect(current.codexLaunchRuntime.active!.bootstrap).toBe('consumed');
    mocks.model.mockImplementation(async (value: ITab) => ({ ...status(value), status: 'unknown', reason: 'awaiting-first-turn' }));
    expect(await automate(dispatcher)).toMatchObject({ delivered: false, reason: 'model-policy' });
    expect(mocks.paste).toHaveBeenCalledOnce();
  });

  it('keeps unrelated targets concurrent when orchestration is disabled', async () => {
    mocks.crown = null;
    const entered = deferred();
    const release = deferred();
    const first = withAgentDispatchLock(WS, mocks.tabs.get('a-worker'), async (check) => {
      expect(await check()).toEqual({ ok: true });
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const second = call(sendHandler, 'z-worker');
    await flush();
    const pasted = mocks.paste.mock.calls.length;
    release.resolve();
    await first;
    expect(await second).toMatchObject({ status: 200 });
    expect(pasted).toBe(1);
  });
});
