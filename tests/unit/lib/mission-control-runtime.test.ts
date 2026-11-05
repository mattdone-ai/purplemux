import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IWorkspaceStandup } from '@/types/status';
import type { ILayoutData, IWorkspace } from '@/types/terminal';

const mocks = vi.hoisted(() => ({
  workspaces: [] as IWorkspace[],
  layout: null as ILayoutData | null,
  standups: [] as IWorkspaceStandup[],
  statuses: {} as Record<string, Record<string, unknown>>,
  panes: new Map<string, { command: string; path: string; pid: number; windowActivity: number }>(),
  getWorkspaces: vi.fn(),
  readLayoutFile: vi.fn(),
  readWorkspaceLayout: vi.fn(),
  readStandups: vi.fn(),
  getAllPanesInfo: vi.fn(),
  findTab: vi.fn(),
  capture: vi.fn(),
  deliverPrompt: vi.fn(),
  agentRunning: true,
  halted: new Set<string>(),
}));

const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: logs.warn, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/cli-utils', () => ({ findTab: mocks.findTab }));
vi.mock('@/lib/capture-at-width', () => ({ capturePaneAtWidth: mocks.capture }));
vi.mock('@/lib/agent-prompt-delivery', () => ({ deliverPrompt: mocks.deliverPrompt }));
vi.mock('@/lib/agent-dispatch-policy', () => ({
  withAgentDispatchLock: async (
    _workspaceId: string,
    _tab: unknown,
    work: (check: () => Promise<{ ok: true }>) => Promise<unknown>,
  ) => work(async () => ({ ok: true as const })),
}));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: mocks.getWorkspaces,
}));

vi.mock('@/lib/layout-store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/layout-store')>('@/lib/layout-store');
  return {
    ...actual,
    readLayoutFile: mocks.readLayoutFile,
    resolveLayoutFile: (workspaceId: string) => `/data/${workspaceId}/layout.json`,
  };
});

vi.mock('@/lib/workspace-layout-read', () => ({ readWorkspaceLayout: mocks.readWorkspaceLayout }));
vi.mock('@/lib/standup-store', () => ({ readStandups: mocks.readStandups }));
vi.mock('@/lib/tmux', async () => {
  const actual = await vi.importActual<typeof import('@/lib/tmux')>('@/lib/tmux');
  return { ...actual, getAllPanesInfo: mocks.getAllPanesInfo };
});
vi.mock('@/lib/process-utils', () => ({ getChildPids: vi.fn(async () => []) }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ getAllForClient: () => mocks.statuses, isHaltedByUsageLimit: (tabId: string) => mocks.halted.has(tabId) }),
}));
vi.mock('@/lib/providers/registry', () => ({
  getProviderByPanelType: (panelType: string | undefined) => panelType === 'claude-code'
    ? {
        id: 'claude',
        matchesProcess: (command: string) => command === 'claude',
        isAgentRunning: vi.fn(async () => mocks.agentRunning),
        isValidSessionId: (value: unknown) => typeof value === 'string' && value.length > 0,
      }
    : null,
}));

import {
  discoverMissionControlWorkspaces,
  hasEmptyAgentComposer,
  missionBootstrapKey,
  missionLiveRunSourceKey,
  MissionControlRuntime,
  resolveMissionOrchestratorTarget,
  type IMissionControlRuntimeStore,
  type IMissionRuntimeDeps,
} from '@/lib/mission-control-runtime';
import { renderInboxLine } from '@/lib/inbox-templates';
import type { IMissionBootstrapQueueEntry } from '@/lib/mission-control-store';
import type { IInboxItem } from '@/types/inbox';
import type {
  IMissionBinding,
  IMissionBootstrapEntry,
  IMissionDelivery,
  IMissionSnapshot,
} from '@/types/mission-control';

const NOW = 2_000_000_000_000;

const standup = (overrides: Partial<IWorkspaceStandup> = {}): IWorkspaceStandup => ({
  workspaceId: 'ws-one',
  at: NOW,
  state: 'done',
  headline: 'Implementation reported complete',
  items: [],
  blockers: [],
  needsHuman: false,
  next: ['Run closeout'],
  ...overrides,
});

describe('Mission Control runtime discovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mocks.workspaces = [{
      id: 'ws-one',
      name: 'One',
      directories: ['/repo'],
      orchestration: { enabled: false, orchestratorTabId: 'orch' },
    }];
    mocks.layout = {
      root: {
        type: 'pane',
        id: 'pane-one',
        activeTabId: 'orch',
        tabs: [
          { id: 'orch', sessionName: 'pt-ws-one-pane-orch', name: 'orchestrator', order: 0, panelType: 'claude-code' },
          { id: 'worker', sessionName: 'pt-ws-one-pane-worker', name: 'worker', order: 1, panelType: 'claude-code' },
        ],
      },
      activePaneId: 'pane-one',
      updatedAt: new Date(NOW).toISOString(),
    };
    mocks.statuses = {
      orch: { workspaceId: 'ws-one', agentProviderId: 'claude', agentSessionId: 'session-orch', cliState: 'idle' },
      worker: { workspaceId: 'ws-one', agentProviderId: 'claude', agentSessionId: 'session-worker', cliState: 'busy', busySince: NOW - 1_000 },
    };
    mocks.panes = new Map([
      ['pt-ws-one-pane-orch', { command: 'claude', path: '/repo', pid: 10, windowActivity: NOW / 1_000 - 10 }],
      ['pt-ws-one-pane-worker', { command: 'claude', path: '/repo', pid: 11, windowActivity: NOW / 1_000 - 1 }],
    ]);
    mocks.standups = [standup({ blockers: [{ what: 'Old choice', needs: 'Choose A or B' }] })];
    mocks.agentRunning = true;
    mocks.capture.mockResolvedValue('completed\n❯\u00a0');
    mocks.deliverPrompt.mockResolvedValue(undefined);
    mocks.findTab.mockImplementation(async () => ({ tab: mocks.layout?.root.type === 'pane' ? mocks.layout.root.tabs[0] : null }));
    mocks.getWorkspaces.mockResolvedValue({ workspaces: mocks.workspaces, groups: [], sidebarCollapsed: false, sidebarWidth: 220 });
    mocks.readLayoutFile.mockImplementation(async () => mocks.layout);
    mocks.readStandups.mockImplementation(async () => mocks.standups);
    mocks.getAllPanesInfo.mockImplementation(async () => mocks.panes);
  });

  it('keeps a workspace active for a busy worker when its orchestrator is idle and disabled', async () => {
    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.activity).toBe('active');
    expect(workspace.reconciliation?.binding).toMatchObject({
      tabId: 'orch',
      providerId: 'claude',
      sessionId: 'session-orch',
    });
    expect(workspace.run).toMatchObject({ state: 'running', phase: 'done' });
    expect(workspace.candidates).toHaveLength(1);
    expect(workspace.candidates[0].evidence.confidence).toBe('provisional');
  });

  it('does not revive an older question that disappeared from the latest standup', async () => {
    mocks.standups = [
      standup({ at: NOW, headline: 'Decision applied', blockers: [] }),
      standup({ at: NOW - 1_000, headline: 'Waiting', blockers: [{ what: 'Choose', needs: 'A or B' }] }),
    ];

    const [workspace] = await discoverMissionControlWorkspaces();
    expect(workspace.candidates).toEqual([]);
  });

  it('does not count live idle agent tabs as active work', async () => {
    mocks.statuses.worker.cliState = 'idle';
    mocks.standups = [];

    const [workspace] = await discoverMissionControlWorkspaces();
    expect(workspace.activity).toBe('dormant');
    expect(workspace.run?.objective).toBe('Unknown current objective');
  });

  it('does not treat a background agent under a shell foreground as verified live work', async () => {
    mocks.standups = [];
    mocks.panes.set('pt-ws-one-pane-orch', {
      command: 'bash', path: '/repo', pid: 10, windowActivity: NOW / 1_000,
    });
    mocks.panes.set('pt-ws-one-pane-worker', {
      command: 'bash', path: '/repo', pid: 11, windowActivity: NOW / 1_000,
    });

    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.agents.every((agent) => !agent.alive)).toBe(true);
    expect(workspace.run).toBeNull();
  });

  it('keeps a stale standup as provenance without inventing a current running run', async () => {
    mocks.agentRunning = false;
    mocks.standups = [standup({
      at: NOW - 24 * 60 * 60_000,
      state: 'awaiting-human',
      blockers: [{ what: 'Historical choice', needs: 'Confirm whether this is still relevant' }],
    })];

    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.activity).toBe('dormant');
    expect(workspace.run).toBeNull();
    expect(workspace.candidates).toHaveLength(1);
    expect(workspace.candidates[0].evidence).toMatchObject({ source: 'standup', confidence: 'provisional' });
  });

  it('uses unknown current semantics when a live session has only stale standup history', async () => {
    mocks.standups = [standup({
      at: NOW - 24 * 60 * 60_000,
      state: 'awaiting-human',
      headline: 'Old objective must not look current',
      next: ['Old next step'],
      blockers: [{ what: 'Historical choice', needs: 'Confirm whether this is still relevant' }],
    })];

    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.activity).toBe('active');
    expect(workspace.run).toMatchObject({
      objective: 'Unknown current objective',
      phase: null,
      nextStep: null,
      lastProgressAt: null,
      evidence: { source: 'bootstrap', confidence: 'unknown' },
    });
    expect(workspace.run?.sourceKey).not.toContain('standup');
    expect(workspace.candidates).toHaveLength(1);
  });

  it('uses a new live source when a provider session is replaced after an earlier lifecycle', async () => {
    mocks.standups = [];
    const [first] = await discoverMissionControlWorkspaces();

    mocks.statuses.orch.agentSessionId = 'session-orch-two';
    const [second] = await discoverMissionControlWorkspaces();

    expect(first.run?.sourceKey).not.toBe(second.run?.sourceKey);
    expect(first.identities).toContainEqual(expect.objectContaining({
      tabId: 'orch', sessionId: 'session-orch',
    }));
    expect(second.identities).toContainEqual(expect.objectContaining({
      tabId: 'orch', sessionId: 'session-orch-two',
    }));
  });

  it('does not treat a repeated standup heartbeat as recent progress', async () => {
    mocks.agentRunning = false;
    const repeated = {
      state: 'awaiting-human' as const,
      headline: 'Historical choice is still waiting',
      blockers: [{ what: 'Historical choice', needs: 'Confirm whether this is still relevant' }],
    };
    mocks.standups = [
      standup({ ...repeated, at: NOW - 1_000 }),
      standup({ ...repeated, at: NOW - 10 * 60_000 }),
      standup({ ...repeated, at: NOW - 24 * 60 * 60_000 }),
    ];

    const [workspace] = await discoverMissionControlWorkspaces();

    expect(workspace.activity).toBe('dormant');
    expect(workspace.run).toBeNull();
    expect(workspace.lastProgressAt).toBe(NOW - 24 * 60 * 60_000);
    expect(workspace.candidates).toHaveLength(1);
  });
});

describe('Mission Control orchestrator target (the tab a stale binding may heal to)', () => {
  const layoutWith = (...tabIds: string[]): ILayoutData => ({
    root: {
      type: 'split', orientation: 'horizontal', ratio: 0.5,
      children: [
        { type: 'pane', id: 'pane-one', activeTabId: tabIds[0] ?? null, tabs: tabIds.slice(0, 1).map((id, order) => ({ id, sessionName: `pt-${id}`, name: id, order, panelType: 'claude-code' })) },
        { type: 'pane', id: 'pane-two', activeTabId: tabIds[1] ?? null, tabs: tabIds.slice(1).map((id, order) => ({ id, sessionName: `pt-${id}`, name: id, order, panelType: 'terminal' })) },
      ],
    },
    activePaneId: 'pane-one',
    updatedAt: new Date(NOW).toISOString(),
  });
  const configure = (orchestration: IWorkspace['orchestration']) => mocks.getWorkspaces.mockResolvedValue({
    workspaces: [{ id: 'ws-one', name: 'One', directories: ['/repo'], orchestration }], groups: [], sidebarCollapsed: false, sidebarWidth: 220,
  });

  beforeEach(() => {
    configure({ enabled: true, orchestratorTabId: 'orch' });
    mocks.readWorkspaceLayout.mockReset();
    mocks.readWorkspaceLayout.mockResolvedValue(layoutWith('orch', 'worker', 'shell'));
  });

  it('names the configured orchestrator and every tab of the workspace layout', async () => {
    expect(await resolveMissionOrchestratorTarget('ws-one')).toEqual({ tabId: 'orch', tabIds: ['orch', 'worker', 'shell'] });
    expect(mocks.readWorkspaceLayout).toHaveBeenCalledWith('ws-one');
  });

  it('uses the configured tab the event authority uses, enabled or not', async () => {
    configure({ enabled: false, orchestratorTabId: 'orch' });
    expect(await resolveMissionOrchestratorTarget('ws-one')).toMatchObject({ tabId: 'orch' });
  });

  it.each([
    ['no orchestrator is configured', () => configure({ enabled: false, orchestratorTabId: null })],
    ['the workspace has no orchestration record', () => configure(undefined)],
    ['the workspace is unknown', () => mocks.getWorkspaces.mockResolvedValue({ workspaces: [], groups: [], sidebarCollapsed: false, sidebarWidth: 220 })],
    ['the configured tab left the layout', () => mocks.readWorkspaceLayout.mockResolvedValue(layoutWith('worker', 'shell'))],
    ['the layout file is missing', () => mocks.readWorkspaceLayout.mockResolvedValue(null)],
    ['the layout is unreadable', () => mocks.readWorkspaceLayout.mockRejectedValue(new Error('Invalid workspace layout'))],
  ])('is null when %s', async (_case, arrange) => {
    arrange();
    expect(await resolveMissionOrchestratorTarget('ws-one')).toBeNull();
  });
});

describe('Mission Control live lifecycle identity', () => {
  const orchestrator = {
    tabId: 'orch', providerId: 'claude', sessionId: 'session-orch', runtimeGeneration: null,
  };
  const worker = {
    tabId: 'worker', providerId: 'codex', sessionId: 'session-worker', runtimeGeneration: 'launch-one',
  };

  it('is stable across identity ordering and duplicates', () => {
    const source = missionLiveRunSourceKey('ws-one', [orchestrator, worker]);
    expect(missionLiveRunSourceKey('ws-one', [worker, orchestrator, worker])).toBe(source);
  });

  it.each([
    ['provider', { ...worker, providerId: 'grok' }],
    ['session', { ...worker, sessionId: 'session-two' }],
    ['launch', { ...worker, runtimeGeneration: 'launch-two' }],
  ])('changes when the %s identity changes', (_field, changed) => {
    expect(missionLiveRunSourceKey('ws-one', [orchestrator, changed]))
      .not.toBe(missionLiveRunSourceKey('ws-one', [orchestrator, worker]));
  });
});

describe('Mission Control composer guard', () => {
  it('accepts the latest empty composer', () => {
    expect(hasEmptyAgentComposer('claude-code', 'completed output\n────────\n❯\u00a0\n────────')).toBe(true);
    expect(hasEmptyAgentComposer('codex-cli', 'completed output\n›   ')).toBe(true);
  });

  it('rejects a current draft even when scrollback contains an older empty composer', () => {
    const pane = [
      'old output',
      '❯\u00a0',
      'new output',
      '❯ do not overwrite this draft',
    ].join('\n');
    expect(hasEmptyAgentComposer('claude-code', pane)).toBe(false);
  });

  it('rejects multiline draft content after the current composer boundary', () => {
    const pane = ['› first line of draft', '  second line of draft'].join('\n');
    expect(hasEmptyAgentComposer('codex-cli', pane)).toBe(false);
  });
});

const binding: IMissionBinding = {
  tabId: 'orch',
  providerId: 'claude',
  sessionId: 'session-orch',
  generation: 2,
  runtimeGeneration: null,
};

const delivery = (overrides: Partial<IMissionDelivery> = {}): IMissionDelivery => ({
  id: 'delivery-one',
  answerId: 'answer-one',
  workspaceId: 'ws-one',
  runId: 'run-one',
  binding,
  state: 'queued',
  attempts: 0,
  nextAttemptAt: NOW,
  lastError: null,
  submittedAt: null,
  acknowledgedAt: null,
  updatedAt: 1,
  ...overrides,
});

const snapshot = (runBinding: IMissionBinding | null = binding, runRevision = 4): IMissionSnapshot => ({
  schemaVersion: 1,
  cursor: 3,
  generatedAt: NOW,
  workspaces: [],
  runs: [{
    id: 'run-one',
    workspaceId: 'ws-one',
    revision: runRevision,
    objective: 'Ship it',
    epic: null,
    phase: 'implementation',
    state: 'running',
    nextStep: null,
    binding: runBinding,
    evidence: { source: 'agent', sourceId: 'event-one', observedAt: NOW, confidence: 'confirmed' },
    closeoutPending: false,
    storyCounts: null,
    lastProgressAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  items: [{
    id: 'item-one',
    workspaceId: 'ws-one',
    runId: 'run-one',
    revision: 2,
    state: 'answered',
    kind: 'question',
    title: 'Choose',
    context: 'A or B',
    storyIds: [],
    options: [],
    recommendation: null,
    blockingScope: 'story',
    canContinue: true,
    evidence: { source: 'agent', sourceId: 'event-two', observedAt: NOW, confidence: 'confirmed' },
    answerId: 'answer-one',
    resolution: null,
    humanReview: null,
    candidateReason: null,
    class: null,
    defaultOptionId: null,
    autoAnswer: null,
    evidenceLinks: [],
    lint: [],
    changes: null,
    createdAt: NOW,
    updatedAt: NOW,
  }],
  answers: [{
    id: 'answer-one',
    source: null,
    submissionId: 'submission-one',
    expectedRevision: 1,
    appliedRevision: 1,
    optionIds: [],
    text: 'A',
    actionCompleted: false,
    workspaceId: 'ws-one',
    runId: 'run-one',
    itemId: 'item-one',
    actor: 'human',
    createdAt: NOW,
  }],
  deliveries: [],
  recentEvents: [],
  bootstrap: null,
});

const inboxItem = (overrides: Partial<IInboxItem> = {}): IInboxItem => ({
  id: 'i-one',
  kind: 'mission',
  targetWorkspaceId: 'ws-one',
  targetTabId: 'orch',
  dedupeKey: 'mission:delivery:delivery-one',
  line: '[purplemux mission x] an answer is ready',
  createdAt: NOW,
  notBefore: NOW,
  attempts: 0,
  lastAttemptAt: null,
  lastRefusal: null,
  state: 'queued',
  deliveredAt: null,
  heldReason: null,
  droppedReason: null,
  expiresAt: NOW + 86_400_000,
  staleAt: null,
  transitionAt: NOW,
  ...overrides,
});

const liveIdentity = { tabId: 'orch', providerId: 'claude', sessionId: 'session-orch', runtimeGeneration: null };

const bootstrapEntry = (overrides: Partial<IMissionBootstrapEntry> = {}): IMissionBootstrapEntry => ({
  workspaceId: 'ws-one',
  runId: 'run-one',
  binding: { ...binding, generation: 0 },
  state: 'queued',
  reason: null,
  updatedAt: 1,
  ...overrides,
});

const runtimeHarness = (options: {
  due?: IMissionDelivery[];
  runBinding?: IMissionBinding | null;
  deliveryValidation?: { ok: true } | { ok: false; reason: string };
  bootstrapValidation?: { ok: true } | { ok: false; reason: string };
  bootstrap?: { entry: IMissionBootstrapEntry; attempts: number };
  runRevision?: number;
  handoffs?: { deliveries: IMissionDelivery[]; bootstrapEntries: IMissionBootstrapQueueEntry[] };
  items?: IInboxItem[];
  identity?: Omit<IMissionBinding, 'generation'> | null;
  enqueueError?: Error;
  snapshotDeliveries?: IMissionDelivery[];
} = {}) => {
  const events: string[] = [];
  const claimed = delivery({
    ...(options.due?.[0] ?? {}),
    state: 'dispatching',
    attempts: (options.due?.[0]?.attempts ?? 0) + 1,
    updatedAt: 2,
  });
  const validateDeliveryAttempt = vi.fn(() => {
    events.push('validate-delivery');
    return options.deliveryValidation ?? { ok: true as const };
  });
  const finalizeDeliveryAttempt = vi.fn((..._args: unknown[]) => {
    events.push('complete');
    return claimed;
  });
  const completeBootstrapAttempt = vi.fn((..._args: unknown[]) => {
    events.push('complete-bootstrap');
    return options.bootstrap?.entry ?? null;
  });
  const store = {
    snapshot: vi.fn(() => ({
      ...snapshot(options.runBinding === undefined ? binding : options.runBinding, options.runRevision),
      deliveries: options.snapshotDeliveries ?? [],
    })),
    reconcileDiscovery: vi.fn(),
    listDueDeliveries: vi.fn(() => options.due ?? []),
    claimDelivery: vi.fn(() => {
      events.push('claim');
      return claimed;
    }),
    claimInboxDelivery: vi.fn((_id: string, _marker: string) => {
      events.push('claim-inbox');
      return { ...claimed, updatedAt: 3 };
    }),
    listInboxHandoffs: vi.fn(() => options.handoffs ?? { deliveries: [], bootstrapEntries: [] }),
    validateDeliveryAttempt,
    finalizeDeliveryAttempt,
    recoverDispatching: vi.fn(() => 0),
    listOpenRunBindings: vi.fn(() => []),
    rebindOpenRuns: vi.fn(() => []),
    listQueuedBootstrapEntries: vi.fn(() => options.bootstrap
      ? [{ bootstrapId: 'bootstrap-one', entry: options.bootstrap.entry, attempts: 0, nextAttemptAt: NOW }]
      : []),
    claimBootstrapEntry: vi.fn((bootstrapId: string, _ws: string, _run: string, _updatedAt: number) => {
      events.push('claim-bootstrap');
      const entry = options.bootstrap?.entry ?? options.handoffs?.bootstrapEntries[0]?.entry ?? bootstrapEntry();
      return { bootstrapId, entry: { ...entry, state: 'dispatching', updatedAt: 2 }, attempts: options.bootstrap?.attempts ?? 1, nextAttemptAt: null };
    }),
    validateBootstrapAttempt: vi.fn(() => {
      events.push('validate-bootstrap');
      return options.bootstrapValidation ?? { ok: true as const };
    }),
    completeBootstrapAttempt,
  } as unknown as IMissionControlRuntimeStore;
  const unregister = vi.fn();
  const inbox = {
    enqueue: vi.fn(async (request: Parameters<IMissionRuntimeDeps['inbox']['enqueue']>[0]) => {
      events.push('enqueue');
      if (options.enqueueError) throw options.enqueueError;
      return { item: inboxItem({ id: 'i-new', dedupeKey: request.dedupeKey }), created: true };
    }),
    items: vi.fn(async () => options.items ?? []),
    withdraw: vi.fn(async () => true),
    registerPreflight: vi.fn(() => unregister),
  };
  const deps: IMissionRuntimeDeps = {
    getStore: () => store,
    now: () => NOW,
    discover: vi.fn(),
    workspaceViews: vi.fn(async () => []),
    resolveIdentity: vi.fn(async () => (options.identity === undefined ? liveIdentity : options.identity)),
    orchestratorTarget: vi.fn(async () => null),
    withMappingRead: (_workspaceId, work) => work(),
    inbox,
    setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: vi.fn(),
  };
  return {
    runtime: new MissionControlRuntime(deps),
    store,
    deps,
    inbox,
    unregister,
    validateDeliveryAttempt,
    finalizeDeliveryAttempt,
    completeBootstrapAttempt,
    events,
  };
};

const waitingDelivery = (itemId = 'i-one', overrides: Partial<IMissionDelivery> = {}): IMissionDelivery =>
  delivery({ state: 'queued', nextAttemptAt: null, lastError: `inbox:${itemId}`, updatedAt: 2, ...overrides });

describe('Mission Control durable delivery worker', () => {
  it('contains a rejected fire-and-forget worker pass after bootstrap succeeds', async () => {
    const harness = runtimeHarness();
    const bootstrap = { id: 'bootstrap-one', boundarySeq: 3, createdAt: NOW, entries: [] };
    vi.mocked(harness.store.reconcileDiscovery).mockReturnValue(bootstrap);
    vi.mocked(harness.store.listDueDeliveries).mockImplementation(() => {
      throw new Error('database unavailable after commit');
    });
    harness.deps.discover = vi.fn(async (bootstrapId, reconcile, boundarySeq) => ({
      bootstrapId,
      reconcile,
      boundarySeq,
      observedAt: NOW,
      workspaces: [],
    }));

    await expect(harness.runtime.bootstrap({ bootstrapId: 'bootstrap-one', reconcile: true }))
      .resolves.toEqual(bootstrap);
    await Promise.resolve();
  });

  it('propagates store initialization failure before arming the worker interval', async () => {
    const harness = runtimeHarness();
    let unavailable = true;
    harness.deps.getStore = () => {
      if (unavailable) throw new Error('database unavailable');
      return harness.store;
    };

    await expect(harness.runtime.start()).rejects.toThrow('database unavailable');
    expect(harness.deps.setInterval).not.toHaveBeenCalled();

    unavailable = false;
    await expect(harness.runtime.start()).resolves.toBeUndefined();
    expect(harness.deps.setInterval).toHaveBeenCalledOnce();
    expect(harness.store.recoverDispatching).toHaveBeenCalledWith('server-restarted-during-uncertain-delivery');
  });

  it('contains a worker-pass failure after store initialization and recovers on a later pass', async () => {
    const harness = runtimeHarness();
    let storeReads = 0;
    harness.deps.getStore = () => {
      storeReads += 1;
      if (storeReads === 2) throw new Error('worker pass unavailable');
      return harness.store;
    };

    await expect(harness.runtime.start()).resolves.toBeUndefined();
    expect(harness.deps.setInterval).toHaveBeenCalledOnce();
    expect(harness.store.recoverDispatching).not.toHaveBeenCalled();

    await harness.runtime.tick();
    expect(harness.store.recoverDispatching).toHaveBeenCalledWith('server-restarted-during-uncertain-delivery');
  });

  it('recovers once per process: a failure after recovery does not run it again (ruling A′ §6)', async () => {
    const harness = runtimeHarness();
    vi.mocked(harness.store.listDueDeliveries).mockImplementationOnce(() => {
      throw new Error('one bad pass');
    });

    await expect(harness.runtime.tick()).rejects.toThrow('one bad pass');
    await harness.runtime.tick();
    await harness.runtime.tick();

    expect(harness.store.recoverDispatching).toHaveBeenCalledOnce();
  });

  it('registers the mission preflight once, after recovery, and stop unregisters it', async () => {
    const harness = runtimeHarness();
    const order: string[] = [];
    vi.mocked(harness.store.recoverDispatching).mockImplementation(() => {
      order.push('recover');
      return 0;
    });
    harness.inbox.registerPreflight.mockImplementation(() => {
      order.push('register');
      return harness.unregister;
    });

    await harness.runtime.start();
    await harness.runtime.tick();
    expect(order).toEqual(['recover', 'register']);
    expect(harness.inbox.registerPreflight).toHaveBeenCalledWith('mission', expect.any(Function));

    await harness.runtime.stop();
    expect(harness.unregister).toHaveBeenCalledOnce();
  });

  it('installs one interval when start is called concurrently', async () => {
    const harness = runtimeHarness();

    await Promise.all([harness.runtime.start(), harness.runtime.start()]);

    expect(harness.deps.setInterval).toHaveBeenCalledOnce();
    expect(harness.store.recoverDispatching).toHaveBeenCalledOnce();
  });

  it('does not resurrect the interval when stop runs during the initial worker pass', async () => {
    const harness = runtimeHarness({ due: [delivery()] });
    let finishEnqueue: (() => void) | undefined;
    harness.inbox.enqueue.mockImplementation(() => new Promise((resolve) => {
      finishEnqueue = () => resolve({ item: inboxItem({ id: 'i-new' }), created: true });
    }));

    const starting = harness.runtime.start();
    await vi.waitFor(() => expect(finishEnqueue).toBeDefined());
    const stopping = harness.runtime.stop();
    expect(harness.deps.clearInterval).toHaveBeenCalledOnce();
    finishEnqueue?.();
    await Promise.all([starting, stopping]);

    vi.mocked(harness.store.listDueDeliveries).mockReturnValue([]);
    await harness.runtime.start();
    expect(harness.deps.setInterval).toHaveBeenCalledTimes(2);
  });
});

describe('Mission Control hands deliveries to the inbox (story 12)', () => {
  it('claims, re-validates, enqueues one notice, and leaves the row queued on the item', async () => {
    const harness = runtimeHarness({ due: [delivery()] });

    await harness.runtime.tick();

    expect(harness.events).toEqual(['claim', 'validate-delivery', 'enqueue', 'complete']);
    expect(harness.inbox.enqueue).toHaveBeenCalledWith({
      kind: 'mission',
      targetWorkspaceId: 'ws-one',
      targetTabId: 'orch',
      dedupeKey: 'mission:delivery:delivery-one',
      fields: { answerId: 'answer-one', workspaceId: 'ws-one', readyAt: NOW },
    });
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'queued',
      nextAttemptAt: null,
      lastError: 'inbox:i-new',
    });
  });

  it('holds an answer whose run binding changed and never enqueues it', async () => {
    const harness = runtimeHarness({ due: [delivery()], runBinding: { ...binding, generation: 3 } });

    await harness.runtime.tick();

    expect(harness.inbox.enqueue).not.toHaveBeenCalled();
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'held', nextAttemptAt: null, lastError: 'run-binding-changed',
    });
  });

  it('holds an answer that stopped being eligible after the claim', async () => {
    const harness = runtimeHarness({ due: [delivery()], deliveryValidation: { ok: false, reason: 'attention-no-longer-answered' } });

    await harness.runtime.tick();

    expect(harness.inbox.enqueue).not.toHaveBeenCalled();
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'held', nextAttemptAt: null, lastError: 'dispatch-ineligible:attention-no-longer-answered',
    });
  });

  it('holds an answer the inbox refuses to queue, with the refusal', async () => {
    const harness = runtimeHarness({ due: [delivery()], enqueueError: new Error('inbox field answerId does not match its grammar (missionId)') });

    await harness.runtime.tick();

    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 2, binding, {
      state: 'held',
      nextAttemptAt: null,
      lastError: 'inbox-enqueue-failed:inbox field answerId does not match its grammar (missionId)',
    });
  });

  it('hands a bootstrap entry to the inbox as one line keyed by a server-made id', async () => {
    const harness = runtimeHarness({ bootstrap: { entry: bootstrapEntry(), attempts: 1 }, runRevision: 0 });

    await harness.runtime.tick();

    const key = missionBootstrapKey('bootstrap-one', 'ws-one', 'run-one');
    expect(key).toMatch(/^boot-[0-9a-f]{32}$/);
    expect(harness.events).toEqual(['claim-bootstrap', 'validate-bootstrap', 'enqueue', 'complete-bootstrap']);
    const request = harness.inbox.enqueue.mock.calls[0][0];
    expect(request).toEqual({
      kind: 'mission',
      targetWorkspaceId: 'ws-one',
      targetTabId: 'orch',
      dedupeKey: `mission:bootstrap:${key}`,
      fields: { event: 'bootstrap', bootstrapKey: key, workspaceId: 'ws-one' },
    });
    const { line } = renderInboxLine('mission', request.fields);
    expect(line).not.toContain('\n');
    expect(line).not.toContain('bootstrap-one');
    expect(harness.completeBootstrapAttempt).toHaveBeenCalledWith('bootstrap-one', 'ws-one', 'run-one', 2, {
      state: 'queued', reason: 'inbox:i-new', nextAttemptAt: null,
    });
  });

  it('holds a bootstrap entry without a binding, and one no longer eligible, without enqueueing', async () => {
    const unbound = runtimeHarness({ bootstrap: { entry: bootstrapEntry({ binding: null }), attempts: 1 } });
    await unbound.runtime.tick();
    expect(unbound.inbox.enqueue).not.toHaveBeenCalled();
    expect(unbound.completeBootstrapAttempt).toHaveBeenCalledWith('bootstrap-one', 'ws-one', 'run-one', 2, {
      state: 'held', reason: 'orchestrator-binding-missing',
    });

    const stale = runtimeHarness({ bootstrap: { entry: bootstrapEntry(), attempts: 1 }, bootstrapValidation: { ok: false, reason: 'bootstrap-run-not-current' } });
    await stale.runtime.tick();
    expect(stale.inbox.enqueue).not.toHaveBeenCalled();
    expect(stale.completeBootstrapAttempt).toHaveBeenCalledWith('bootstrap-one', 'ws-one', 'run-one', 2, {
      state: 'held', reason: 'dispatch-ineligible:bootstrap-run-not-current',
    });
  });
});

describe('Mission Control paste-time preflight (story 12, ruling A′ §4)', () => {
  it('claims the waiting row for this paste only when every check passes', async () => {
    const harness = runtimeHarness({ handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] } });

    await expect(harness.runtime.preflight(inboxItem())).resolves.toEqual({ ok: true });

    expect(harness.store.claimInboxDelivery).toHaveBeenCalledWith('delivery-one', 'inbox:i-one');
    expect(harness.validateDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 3, binding);
    expect(harness.events).toEqual(['claim-inbox', 'validate-delivery']);
  });

  it.each<[string, Parameters<typeof runtimeHarness>[0], IInboxItem, string]>([
    ['no row waits on this item', { handoffs: { deliveries: [waitingDelivery('i-other')], bootstrapEntries: [] } }, inboxItem(), 'mission-record-not-waiting'],
    ['the row waits for another tab', { handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] } }, inboxItem({ targetTabId: 'tab-else' }), 'binding-tab-changed'],
    ['the bound agent is not live', { handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] }, identity: null }, inboxItem(), 'bound-agent-not-live'],
    ['the provider session was replaced', { handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] }, identity: { ...liveIdentity, sessionId: 'replacement' } }, inboxItem(), 'binding-identity-changed'],
  ])('refuses without claiming when %s', async (_name, options, item, reason) => {
    const harness = runtimeHarness(options);

    await expect(harness.runtime.preflight(item)).resolves.toEqual({ ok: false, reason });

    expect(harness.store.claimInboxDelivery).not.toHaveBeenCalled();
  });

  it('holds the claimed row when the record changed, and refuses the paste', async () => {
    const harness = runtimeHarness({
      handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] },
      deliveryValidation: { ok: false, reason: 'run-binding-changed' },
    });

    await expect(harness.runtime.preflight(inboxItem())).resolves.toEqual({ ok: false, reason: 'run-binding-changed' });

    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 3, binding, {
      state: 'held', nextAttemptAt: null, lastError: 'dispatch-ineligible:run-binding-changed',
    });
  });

  it('claims a waiting bootstrap entry the same way', async () => {
    const entry = bootstrapEntry({ reason: 'inbox:i-one', updatedAt: 2 });
    const harness = runtimeHarness({
      handoffs: { deliveries: [], bootstrapEntries: [{ bootstrapId: 'bootstrap-one', entry, attempts: 1, nextAttemptAt: null }] },
    });

    await expect(harness.runtime.preflight(inboxItem({ dedupeKey: 'mission:bootstrap:x' }))).resolves.toEqual({ ok: true });

    expect(harness.store.claimBootstrapEntry).toHaveBeenCalledWith('bootstrap-one', 'ws-one', 'run-one', 2);
    expect(harness.store.validateBootstrapAttempt).toHaveBeenCalledWith('bootstrap-one', 'ws-one', 'run-one', 2);
  });
});

describe('Mission Control maps inbox outcomes onto its rows (story 12, ruling A′ §5)', () => {
  const pasted = async (item: IInboxItem) => {
    const harness = runtimeHarness({ handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] } });
    await harness.runtime.preflight(inboxItem());
    vi.mocked(harness.store.listInboxHandoffs).mockReturnValue({ deliveries: [waitingDelivery('i-one', { state: 'dispatching', updatedAt: 3 })], bootstrapEntries: [] });
    harness.inbox.items.mockResolvedValue([item]);
    harness.finalizeDeliveryAttempt.mockClear();
    await harness.runtime.tick();
    return harness;
  };

  it('a delivered paste submits the row at the delivery time', async () => {
    const harness = await pasted(inboxItem({ state: 'delivered', deliveredAt: NOW + 500 }));
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 3, binding, {
      state: 'submitted', nextAttemptAt: null, lastError: null, submittedAt: NOW + 500,
    });
  });

  it('an uncertain paste holds the row with the inbox reason', async () => {
    const harness = await pasted(inboxItem({ state: 'held', heldReason: 'stranded-in-composer' }));
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 3, binding, {
      state: 'held', nextAttemptAt: null, lastError: 'stranded-in-composer',
    });
  });

  it('a paste still in flight changes nothing', async () => {
    const harness = await pasted(inboxItem());
    expect(harness.finalizeDeliveryAttempt).not.toHaveBeenCalled();
  });

  it.each([
    [inboxItem({ state: 'held', heldReason: 'composer-not-ready:busy (undelivered after 24 h)' }), 'composer-not-ready:busy (undelivered after 24 h)'],
    [inboxItem({ state: 'dropped', droppedReason: 'target-tab-closed' }), 'inbox-dropped:target-tab-closed'],
    [undefined, 'inbox-item-missing'],
  ])('a waiting row whose item ended unpasted is held (%#)', async (item, reason) => {
    const harness = runtimeHarness({
      handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] },
      items: item ? [item] : [],
    });

    await harness.runtime.tick();

    expect(harness.store.claimInboxDelivery).toHaveBeenCalledWith('delivery-one', 'inbox:i-one');
    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 3, binding, {
      state: 'held', nextAttemptAt: null, lastError: reason,
    });
  });

  it('a waiting row whose item is still queued is left alone', async () => {
    const harness = runtimeHarness({ handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] }, items: [inboxItem()] });
    await harness.runtime.tick();
    expect(harness.store.claimInboxDelivery).not.toHaveBeenCalled();
    expect(harness.inbox.withdraw).not.toHaveBeenCalled();
  });

  it('a waiting bootstrap entry whose item was held is held with the reason', async () => {
    const entry = bootstrapEntry({ reason: 'inbox:i-one', updatedAt: 2 });
    const harness = runtimeHarness({
      handoffs: { deliveries: [], bootstrapEntries: [{ bootstrapId: 'bootstrap-one', entry, attempts: 1, nextAttemptAt: null }] },
      items: [inboxItem({ state: 'held', heldReason: 'target-not-agent' })],
    });

    await harness.runtime.tick();

    expect(harness.completeBootstrapAttempt).toHaveBeenCalledWith('bootstrap-one', 'ws-one', 'run-one', 2, {
      state: 'held', reason: 'target-not-agent',
    });
  });

  it('withdraws a queued item whose row left the waiting state, but not one about to be handed off again', async () => {
    const gone = runtimeHarness({
      handoffs: { deliveries: [], bootstrapEntries: [] },
      items: [inboxItem()],
      snapshotDeliveries: [delivery({ state: 'held', lastError: 'attention item cancelled' })],
    });
    await gone.runtime.tick();
    expect(gone.inbox.withdraw).toHaveBeenCalledWith('i-one', 'mission-record-not-waiting');

    const transferred = runtimeHarness({
      handoffs: { deliveries: [], bootstrapEntries: [] },
      items: [inboxItem()],
      snapshotDeliveries: [delivery({ state: 'queued', lastError: null })],
    });
    await transferred.runtime.tick();
    expect(transferred.inbox.withdraw).not.toHaveBeenCalled();
  });
});

describe('Mission Control inbox handoff — review r1 fixes (story 12)', () => {
  it('never reuses a still-queued item: it is withdrawn and a fresh one queued (N2)', async () => {
    const harness = runtimeHarness({ due: [delivery()] });
    harness.inbox.enqueue
      .mockResolvedValueOnce({ item: inboxItem({ id: 'i-old' }), created: false })
      .mockResolvedValueOnce({ item: inboxItem({ id: 'i-fresh' }), created: true });

    await harness.runtime.tick();

    expect(harness.inbox.withdraw).toHaveBeenCalledWith('i-old', 'mission-rehanded');
    expect(harness.inbox.enqueue).toHaveBeenCalledTimes(2);
    expect(harness.finalizeDeliveryAttempt).toHaveBeenLastCalledWith('delivery-one', 2, binding, {
      state: 'queued', nextAttemptAt: null, lastError: 'inbox:i-fresh',
    });
  });

  it('holds the row when a reused item cannot be replaced', async () => {
    const harness = runtimeHarness({ due: [delivery()] });
    harness.inbox.enqueue.mockResolvedValue({ item: inboxItem({ id: 'i-stuck' }), created: false });

    await harness.runtime.tick();

    expect(harness.finalizeDeliveryAttempt).toHaveBeenLastCalledWith('delivery-one', 2, binding, {
      state: 'held', nextAttemptAt: null,
      lastError: 'inbox-enqueue-failed:inbox item i-stuck for mission:delivery:delivery-one could not be replaced',
    });
  });

  it('withdraws an item whose row now waits on another item (N4)', async () => {
    const harness = runtimeHarness({
      handoffs: { deliveries: [], bootstrapEntries: [] },
      items: [inboxItem()],
      snapshotDeliveries: [delivery({ state: 'queued', nextAttemptAt: null, lastError: 'inbox:i-other' })],
    });
    await harness.runtime.tick();
    expect(harness.inbox.withdraw).toHaveBeenCalledWith('i-one', 'mission-record-not-waiting');
  });

  it('an unreadable inbox skips the pass without failing it, logged once per cause (N6)', async () => {
    const harness = runtimeHarness({ handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] }, due: [delivery()] });
    harness.inbox.items.mockRejectedValue(new Error('inbox.json is not { items: [...] }'));

    logs.warn.mockClear();
    await expect(harness.runtime.tick()).resolves.toBeUndefined();
    await expect(harness.runtime.tick()).resolves.toBeUndefined();

    expect(harness.store.claimInboxDelivery).not.toHaveBeenCalled();
    expect(harness.inbox.enqueue).not.toHaveBeenCalled();
    const warnings = logs.warn.mock.calls.filter(([message]) => String(message).includes('inbox sync skipped'));
    expect(warnings).toHaveLength(1);
  });

  it('withdraws an orphan only for a row waiting on ANOTHER item, never on its own (R2-1)', async () => {
    const own = runtimeHarness({
      handoffs: { deliveries: [], bootstrapEntries: [] },
      items: [inboxItem()],
      snapshotDeliveries: [delivery({ state: 'queued', nextAttemptAt: null, lastError: 'inbox:i-one' })],
    });
    await own.runtime.tick();
    expect(own.inbox.withdraw).not.toHaveBeenCalled();
  });

  it('starts no pass once stop has begun (R2-1)', async () => {
    const harness = runtimeHarness({ due: [delivery()] });
    await harness.runtime.stop();
    await harness.runtime.tick();
    expect(harness.store.listDueDeliveries).not.toHaveBeenCalled();
    expect(harness.inbox.registerPreflight).not.toHaveBeenCalled();
  });

  it('the server stops the inbox before Mission Control (N5, pinned in server.ts)', async () => {
    const { readFileSync } = await import('fs');
    const server = readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8');
    const shutdown = server.slice(server.indexOf('const shutdownWs = async'));
    expect(shutdown.indexOf('await stopInbox();')).toBeGreaterThan(-1);
    expect(shutdown.indexOf('await stopInbox();')).toBeLessThan(shutdown.indexOf('await getMissionControlRuntime().stop();'));
  });

  it('stop settles a paste the inbox finished before it stopped (N5)', async () => {
    const harness = runtimeHarness({ handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] } });
    await harness.runtime.start();
    await harness.runtime.preflight(inboxItem());
    vi.mocked(harness.store.listInboxHandoffs).mockReturnValue({ deliveries: [waitingDelivery('i-one', { state: 'dispatching', updatedAt: 3 })], bootstrapEntries: [] });
    harness.inbox.items.mockResolvedValue([inboxItem({ state: 'delivered', deliveredAt: NOW + 9 })]);
    harness.finalizeDeliveryAttempt.mockClear();

    await harness.runtime.stop();

    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 3, binding, {
      state: 'submitted', nextAttemptAt: null, lastError: null, submittedAt: NOW + 9,
    });
  });
});

describe('a claimed row is always settled (story 12 CONFIRM minor)', () => {
  it('keeps the claim when the store throws after claiming, and the sync settles the row', async () => {
    const harness = runtimeHarness({ handoffs: { deliveries: [waitingDelivery()], bootstrapEntries: [] } });
    harness.validateDeliveryAttempt.mockImplementation(() => {
      throw new Error('database is locked');
    });
    await expect(harness.runtime.preflight(inboxItem())).rejects.toThrow('database is locked');

    vi.mocked(harness.store.listInboxHandoffs).mockReturnValue({ deliveries: [waitingDelivery('i-one', { state: 'dispatching', updatedAt: 3 })], bootstrapEntries: [] });
    harness.inbox.items.mockResolvedValue([inboxItem({ state: 'dropped', droppedReason: 'preflight:mission-record-not-waiting' })]);
    harness.finalizeDeliveryAttempt.mockClear();
    await harness.runtime.tick();

    expect(harness.finalizeDeliveryAttempt).toHaveBeenCalledWith('delivery-one', 3, binding, {
      state: 'held', nextAttemptAt: null, lastError: 'inbox-dropped:preflight:mission-record-not-waiting',
    });
  });
});

