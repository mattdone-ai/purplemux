import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITab, IWorkspaceOrchestration, IWorkspacesData } from '@/types/terminal';

const mocks = vi.hoisted(() => ({
  home: '',
  tabs: new Map<string, ITab>(),
  paste: vi.fn(),
  model: vi.fn(),
  escape: vi.fn(),
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mocks.home }, homedir: () => mocks.home };
});
vi.mock('@/lib/cli-utils', () => ({
  findTab: async (workspaceId: string, id: string) => {
    const tab = mocks.tabs.get(id);
    return tab ? { workspaceId, paneId: 'pane', tab: structuredClone(tab) } : null;
  },
  authorizeWorkspace: vi.fn(async () => true),
  authorizeWorkspaceInput: vi.fn(async () => true),
}));
vi.mock('@/lib/agent-prompt-delivery', () => ({ deliverPrompt: mocks.paste }));
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(async () => true),
  hasSessionOrUnreachable: vi.fn(async () => true),
  sendEscape: mocks.escape,
  isContentPendingInComposer: vi.fn(async () => false),
  listSessions: vi.fn(async () => []),
  killSession: vi.fn(),
}));
vi.mock('@/lib/layout-store', () => ({ collectAllTabs: () => [...mocks.tabs.values()], isAgentPanelType: () => true }));
vi.mock('@/lib/workspace-layout-read', () => ({ readWorkspaceLayout: async () => ({ root: {} }) }));
vi.mock('@/lib/orchestration-runtime', () => ({ observeOrchestrationRuntime: async (tab: ITab) => tab.id === 'crown-a' ? { state: 'absent', reason: 'dead' } : { state: 'present', identity: tab.sessionName }, candidateModelUsable: async () => true }));
vi.mock('@/lib/caller', () => ({ resolveCaller: async () => ({ kind: 'workspace', workspaceId: 'ws-map', tabId: null, verified: false }) }));
vi.mock('@/lib/providers/codex', () => ({ CODEX_LAUNCHER_SCRIPT: '/test/codex-launcher.js', codexProvider: {} }));
vi.mock('@/lib/providers/codex/session-detection', () => ({ findCodexSessionById: vi.fn() }));
vi.mock('@/lib/providers/codex/model-observation', () => ({ getCodexModelStatus: mocks.model }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ getAllForClient: () => ({}), isWaitingAtPrompt: () => false }) }));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/registry', () => ({ listProviders: () => [] }));
vi.mock('@/lib/grok-home', () => ({ removeWorkspaceGrokHome: vi.fn() }));
vi.mock('@/lib/workspace-home', () => ({ removeWorkspaceClaudeHome: vi.fn() }));
vi.mock('@/lib/workspace-token', () => ({ revokeWorkspaceToken: vi.fn() }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) }));

const WS = 'ws-map';
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
let send: THandler;
let steer: THandler;
let orchestration: THandler;
let store: typeof import('@/lib/workspace-store');
let mapping: typeof import('@/lib/orchestration-mapping-lock');
let Dispatcher: typeof import('@/lib/automated-prompt-dispatcher').AutomatedPromptDispatcher;
const call = async (handler: THandler, body: unknown, method = 'POST') => {
  const response = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { response.status = code; return this; },
    json(body: unknown) { response.body = body; return this; },
  } as unknown as NextApiResponse;
  await handler({ method, query: { workspaceId: WS, tabId: 'worker' }, body } as unknown as NextApiRequest, res);
  return response;
};
const settings = (enabled: boolean): IWorkspaceOrchestration => ({
  enabled, orchestratorTabId: enabled ? 'crown-a' : null, revision: 0,
});
const seed = async (enabled: boolean) => {
  const data: IWorkspacesData = {
    workspaces: [{ id: WS, name: WS, directories: [], orchestration: settings(enabled) }],
    groups: [], sidebarCollapsed: false, sidebarWidth: 240, updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(mocks.home, '.purplemux', 'workspaces.json'), JSON.stringify(data));
};
const attemptedWriter = () => {
  const attempted = deferred();
  const original = mapping.withOrchestrationMappingWrite;
  vi.spyOn(mapping, 'withOrchestrationMappingWrite').mockImplementation((workspaceId, work) => {
    attempted.resolve();
    return original(workspaceId, work);
  });
  return attempted.promise;
};
const deliver = (kind: 'cli' | 'steer' | 'automated') => kind === 'automated'
  ? new Dispatcher().dispatch({ workspaceId: WS, targetTabId: 'worker', message: 'work' })
  : call(kind === 'steer' ? steer : send, { content: 'work', waitMs: 0, interrupt: false });

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.resetAllMocks();
  mocks.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-mapping-'));
  await fs.mkdir(path.join(mocks.home, '.purplemux'));
  (globalThis as unknown as { __purplemuxWorkspacesContentCache?: string }).__purplemuxWorkspacesContentCache = undefined;
  mocks.tabs = new Map(['worker', 'crown-a', 'crown-b'].map((id) => [id, {
    id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'codex-cli', cliState: 'idle',
    agentLaunchConfig: { model: 'gpt-6-astra', effort: 'high' },
  }]));
  mocks.paste.mockResolvedValue(undefined);
  mocks.escape.mockResolvedValue(undefined);
  mocks.model.mockImplementation(async (tab: ITab) => ({
    expected: { model: 'gpt-6-astra', effort: 'high' }, observed: null,
    latestTurn: null, latestSettings: null, scanState: 'complete', hasActivity: true,
    status: tab.id === 'crown-b' ? 'mismatch' : 'match', reason: null,
  }));
  mapping = await import('@/lib/orchestration-mapping-lock');
  store = await import('@/lib/workspace-store');
  ({ default: send } = await import('@/pages/api/cli/tabs/[tabId]/send'));
  ({ default: steer } = await import('@/pages/api/cli/tabs/[tabId]/steer'));
  ({ default: orchestration } = await import('@/pages/api/cli/workspaces/[workspaceId]/orchestration'));
  ({ AutomatedPromptDispatcher: Dispatcher } = await import('@/lib/automated-prompt-dispatcher'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(mocks.home, { recursive: true, force: true });
});

describe('actual orchestration PATCH and dispatch share the mapping lease', () => {
  it.each([
    ['cli', false], ['cli', true], ['steer', false], ['steer', true], ['automated', false], ['automated', true],
  ] as const)('%s retains mapping through paste when previous orchestration enabled=%s', async (kind, enabled) => {
    await seed(enabled);
    const pasted = deferred();
    const release = deferred();
    mocks.paste.mockImplementation(async () => { pasted.resolve(); await release.promise; });
    const delivery = deliver(kind);
    await pasted.promise;
    const attempted = attemptedWriter();
    let updated = false;
    const remapping = call(orchestration, { enabled: true, orchestratorTabId: 'crown-b', expectedRevision: 0, mode: 'recover' }, 'PATCH')
      .then((result) => { updated = true; return result; });
    await attempted;
    const before = await store.getWorkspaceById(WS);
    const waited = !updated;
    release.resolve();
    const delivered = await delivery;
    expect(await remapping).toMatchObject({ status: 200 });
    expect(delivered).toMatchObject(kind === 'automated' ? { delivered: true } : { status: 200 });
    expect(waited).toBe(true);
    expect(before?.orchestration).toEqual(settings(enabled));
    expect((await store.getWorkspaceById(WS))?.orchestration).toMatchObject({ enabled: true, orchestratorTabId: 'crown-b' });
    const following = await deliver(kind);
    expect(following).toMatchObject(kind === 'automated'
      ? { delivered: false, reason: 'model-policy', policy: { tabId: 'crown-b' } }
      : { status: 409, body: { tabId: 'crown-b' } });
    expect(mocks.paste).toHaveBeenCalledOnce();
    expect(mocks.model.mock.calls.some(([tab]) => tab.id === 'crown-b')).toBe(true);
  });

  it('does not acquire the workspace-store lock while a mapping writer waits for a dispatch reader', async () => {
    await seed(false);
    const pasted = deferred();
    const release = deferred();
    mocks.paste.mockImplementation(async () => { pasted.resolve(); await release.promise; });
    const delivery = deliver('cli');
    await pasted.promise;
    const attempted = attemptedWriter();
    const remapping = call(orchestration, { enabled: true, orchestratorTabId: 'crown-b', expectedRevision: 0, mode: 'recover' }, 'PATCH');
    await attempted;
    const changedPeers = await store.updateWorkspaceAllowedPeers(WS, []);
    release.resolve();
    await Promise.all([delivery, remapping]);
    expect(changedPeers?.allowedPeers).toEqual([]);
    expect(changedPeers?.orchestration).toEqual(settings(false));
  });

  it('queues a later dispatch behind an already waiting mapping PATCH and checks the new crown', async () => {
    await seed(false);
    const pasted = deferred();
    const release = deferred();
    mocks.paste.mockImplementation(async () => { pasted.resolve(); await release.promise; });
    const first = deliver('cli');
    await pasted.promise;
    const writerAttempted = attemptedWriter();
    const remapping = call(orchestration, { enabled: true, orchestratorTabId: 'crown-b', expectedRevision: 0, mode: 'recover' }, 'PATCH');
    await writerAttempted;
    const readerAttempted = deferred();
    const read = mapping.withOrchestrationMappingRead;
    vi.spyOn(mapping, 'withOrchestrationMappingRead').mockImplementation((workspaceId, work) => {
      readerAttempted.resolve();
      return read(workspaceId, work);
    });
    const second = deliver('automated');
    await readerAttempted.promise;
    release.resolve();
    expect(await first).toMatchObject({ status: 200 });
    expect(await remapping).toMatchObject({ status: 200 });
    expect(await second).toMatchObject({
      delivered: false, reason: 'model-policy', policy: { tabId: 'crown-b', error: 'agent-model-mismatch' },
    });
    expect(mocks.model.mock.calls.some(([tab]) => tab.id === 'crown-b')).toBe(true);
    expect(mocks.paste).toHaveBeenCalledOnce();
  });

  it('releases the dispatch read lease after paste failure so actual PATCH can complete', async () => {
    await seed(false);
    mocks.paste.mockRejectedValueOnce(new Error('paste failed'));
    expect(await deliver('automated')).toMatchObject({ delivered: false, reason: 'delivery-error' });
    expect(await call(orchestration, { enabled: true, orchestratorTabId: 'crown-b', expectedRevision: 0, mode: 'recover' }, 'PATCH')).toMatchObject({ status: 200 });
    expect(await deliver('automated')).toMatchObject({ delivered: false, reason: 'model-policy' });
  });

  it('releases mapping and workspace write leases after a failed file write', async () => {
    await seed(false);
    const write = vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('write unavailable'));
    expect(await call(orchestration, { enabled: true, orchestratorTabId: 'crown-b', expectedRevision: 0, mode: 'recover' }, 'PATCH')).toMatchObject({ status: 503 });
    write.mockRestore();
    expect(await deliver('automated')).toEqual({ delivered: true });
    expect(await call(orchestration, { enabled: true, orchestratorTabId: 'crown-b', expectedRevision: 0, mode: 'recover' }, 'PATCH')).toMatchObject({ status: 200 });
  });
});
