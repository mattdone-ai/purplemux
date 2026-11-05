import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionControlStore } from '@/lib/mission-control-store';
import type { IOrchestrationChange } from '@/lib/orchestration-recovery';
import type { ITab, IWorkspaceOrchestration } from '@/types/terminal';

// The whole path of an orchestrator change: the REAL changeOrchestration commits workspaces.json, reaches
// the REAL Mission Control runtime through its process singleton, and that writes the REAL store.
// Only the harness observations are supplied: tmux, the provider process and the live agent identity.

const fixture = vi.hoisted(() => ({ home: '', runtime: vi.fn(), sessions: vi.fn() }));
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fixture.home }, homedir: () => fixture.home };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/orchestration-runtime', () => ({ observeOrchestrationRuntime: fixture.runtime, candidateModelUsable: vi.fn(async () => true) }));
vi.mock('@/lib/orchestration-work-state', () => ({ readOrchestrationWorkState: vi.fn(async () => ({ state: 'complete', evidence: [], incomplete: false })) }));
vi.mock('@/lib/tmux', async (original) => ({ ...await original<typeof import('@/lib/tmux')>(), observeTabSessionsStrict: fixture.sessions }));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

// The first load of this module graph costs about 1 s alone and passed the 5 s test budget on a loaded gate
// (story hfl2-53). Load it once here, at collection, outside every test's budget. vi.resetModules() discards
// this instance; each test's own import evaluates again from the transform cache in milliseconds.
await Promise.all([
  import('@/lib/mission-control-runtime'),
  import('@/lib/mission-control-store'),
  import('@/lib/orchestration-recovery'),
]);

const globals = globalThis as unknown as Record<string, unknown>;
const file = () => path.join(fixture.home, '.purplemux/workspaces.json');
const layoutFile = () => path.join(fixture.home, '.purplemux/workspaces/ws-a/layout.json');
const tab = (id: string): ITab => ({ id, name: id, sessionName: `session-${id}`, panelType: 'claude-code', order: 0 });
const write = (orchestration: IWorkspaceOrchestration) => fs.writeFileSync(file(), JSON.stringify({ workspaces: [{ id: 'ws-a', name: 'A', directories: ['/tmp'], orchestration }], groups: [] }));
const configured = (): string => JSON.parse(fs.readFileSync(file(), 'utf8')).workspaces[0].orchestration.orchestratorTabId;
const identityOf = (tabId: string) => ({ tabId, providerId: 'claude', sessionId: `mission-${tabId}`, runtimeGeneration: null });
const authorityOf = (tabId: string) => ({ resolvedIdentity: identityOf(tabId), configuredOrchestratorTabId: configured() });
const verified = (tabId: string) => ({ kind: 'workspace' as const, workspaceId: 'ws-a', tabId, verified: true });
const options = (over: Partial<IOrchestrationChange> = {}): IOrchestrationChange => ({ expectedRevision: 0, mode: 'recover', actor: { kind: 'workspace', workspaceId: 'ws-a', tabId: 'tab-worker', verified: false }, ...over });
const review = (bindingGeneration: number, reviewerTabId: string) => ({
  eventId: `event-review-${reviewerTabId}-${bindingGeneration}`, schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0,
  producerAt: 1_800_000_000_100, bindingGeneration, type: 'attention.opened' as const,
  payload: {
    itemId: `item-${reviewerTabId}-${bindingGeneration}`, kind: 'question' as const, title: 'Approve the cutover', context: 'Go or no-go.',
    storyIds: [], options: [], recommendation: null, blockingScope: 'run' as const, canContinue: false,
    humanReview: { humanNeed: 'approval' as const, humanReason: 'Only the owner approves production.', handling: 'Checked the runbook.', reviewerTabId },
  },
});

const stores: MissionControlStore[] = [];
const mission = async (boundTabId: string, resolvable: string[]) => {
  const { MissionControlRuntime } = await import('@/lib/mission-control-runtime');
  const { MissionControlStore: Store } = await import('@/lib/mission-control-store');
  const store = new Store(path.join(fixture.home, 'mission-control.sqlite'));
  stores.push(store);
  globals.__ptMissionControlRuntime = new MissionControlRuntime({
    getStore: () => store,
    now: () => Date.now(),
    discover: vi.fn(),
    workspaceViews: async () => [],
    resolveIdentity: async (_workspaceId, tabId) => resolvable.includes(tabId) ? identityOf(tabId) : null,
    orchestratorTarget: async () => null,
    withMappingRead: (_workspaceId, work) => work(),
    inbox: { enqueue: vi.fn(), items: async () => [], withdraw: async () => true, registerPreflight: () => () => {} },
    setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: vi.fn(),
  });
  const start = {
    eventId: 'event-start', schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 1_800_000_000_000,
    bindingGeneration: 0, type: 'run.started' as const, payload: { objective: 'Safeguard the production cutover', tabId: boundTabId },
  };
  store.applyEvents([start], new Map([[start.eventId, identityOf(boundTabId)]]));
  return {
    store,
    run: () => store.snapshot().runs.find((candidate) => candidate.id === 'run-a')!,
    rebounds: () => store.eventsAfter(0, 200).events.filter((event) => event.type === 'run.rebound'),
  };
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-mission-rebind-'));
  fs.mkdirSync(path.dirname(layoutFile()), { recursive: true });
  fs.writeFileSync(layoutFile(), JSON.stringify({ root: { type: 'pane', id: 'pane-a', tabs: [tab('tab-old'), tab('tab-next')], activeTabId: 'tab-old' }, activePaneId: 'pane-a', updatedAt: '2026-10-08' }));
  fixture.runtime.mockImplementation(async (target: ITab) => ({ state: 'present', identity: target.sessionName }));
  fixture.sessions.mockResolvedValue({ state: 'absent', reason: 'no tmux session of the tab survives' });
  for (const key of ['__purplemuxWorkspacesContentCache', '__ptWorkspacesMemo', '__ptTabTokens', '__ptWorkspaceTokens', '__ptMissionControlRuntime', '__ptMissionControlStore']) delete globals[key];
});
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  delete globals.__ptMissionControlRuntime;
  fs.rmSync(fixture.home, { recursive: true, force: true });
});

describe('an orchestrator change rebinds the workspace Mission Control run end to end', () => {
  it('a handoff moves the open run to the new coordinator; the old tab is refused and the new one may ask the human', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' });
    const { store, run, rebounds } = await mission('tab-old', ['tab-old', 'tab-next']);
    const { changeOrchestration } = await import('@/lib/orchestration-recovery');
    const beforeHandoff = review(1, 'tab-next');
    expect(() => store.applyEvents([beforeHandoff], new Map([[beforeHandoff.eventId, { resolvedIdentity: identityOf('tab-next'), configuredOrchestratorTabId: 'tab-next' }]])))
      .toThrowError('human review requires a run bound to the configured orchestrator');

    await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor: verified('tab-old') }));

    expect(configured()).toBe('tab-next');
    expect(run()).toMatchObject({ revision: 2, binding: { ...identityOf('tab-next'), generation: 2 } });
    expect(rebounds()).toHaveLength(1);
    expect(rebounds()[0]).toMatchObject({
      runId: 'run-a', revision: 2,
      payload: { cause: 'handoff', previousBinding: { ...identityOf('tab-old'), generation: 1 }, binding: { ...identityOf('tab-next'), generation: 2 } },
    });
    const oldGeneration = review(1, 'tab-next');
    expect(() => store.applyEvents([oldGeneration], new Map([[oldGeneration.eventId, authorityOf('tab-next')]])))
      .toThrowError('stale or unbound orchestrator generation');
    const oldTab = review(2, 'tab-old');
    expect(() => store.applyEvents([oldTab], new Map([[oldTab.eventId, authorityOf('tab-old')]])))
      .toThrowError('human review requires the configured orchestrator');
    const accepted = review(2, 'tab-next');
    store.applyEvents([accepted], new Map([[accepted.eventId, authorityOf('tab-next')]]));
    expect(store.snapshot().items).toMatchObject([{ id: 'item-tab-next-2', state: 'open' }]);
  });

  it('a repeated handoff to the same tab bumps neither the mapping revision nor the binding generation', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' });
    const { run, rebounds } = await mission('tab-old', ['tab-old', 'tab-next']);
    const { changeOrchestration } = await import('@/lib/orchestration-recovery');
    await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor: verified('tab-old') }));
    const settled = run();

    const repeated = await changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor: verified('tab-next'), expectedRevision: 1 }));

    expect(repeated.orchestration).toMatchObject({ orchestratorTabId: 'tab-next', revision: 1 });
    expect(run()).toEqual(settled);
    expect(rebounds()).toHaveLength(1);
  });

  it('a recovery that names the coordinator already in place heals a run left on a tab that is still open', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-next', revision: 4 });
    const { run, rebounds } = await mission('tab-old', ['tab-old', 'tab-next']);
    const { changeOrchestration } = await import('@/lib/orchestration-recovery');

    const reasserted = await changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options({ expectedRevision: 4 }));

    expect(reasserted.orchestration).toMatchObject({ orchestratorTabId: 'tab-next', revision: 4 });
    expect(run()).toMatchObject({ revision: 2, binding: { ...identityOf('tab-next'), generation: 2 } });
    expect(rebounds().map((event) => event.payload.cause)).toEqual(['recover']);

    await changeOrchestration('ws-a', { enabled: true, orchestratorTabId: 'tab-next' }, options({ expectedRevision: 4 }));
    expect(run()).toMatchObject({ revision: 2, binding: { generation: 2 } });
    expect(rebounds()).toHaveLength(1);
  });

  it('a recovery from a closed coordinator rebinds likewise, with cause recover', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-closed' });
    const { run, rebounds } = await mission('tab-closed', ['tab-next']);
    const { changeOrchestration } = await import('@/lib/orchestration-recovery');

    await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options());

    expect(run()).toMatchObject({ revision: 2, binding: { ...identityOf('tab-next'), generation: 2 } });
    expect(rebounds().map((event) => [event.payload.cause, event.payload.previousBinding]))
      .toEqual([['recover', { ...identityOf('tab-closed'), generation: 1 }]]);
  });

  it('writes no guessed binding while the new coordinator has no resolvable session', async () => {
    write({ enabled: true, orchestratorTabId: 'tab-old' });
    const { run, rebounds } = await mission('tab-old', ['tab-old']);
    const { changeOrchestration } = await import('@/lib/orchestration-recovery');

    const updated = await changeOrchestration('ws-a', { orchestratorTabId: 'tab-next' }, options({ mode: 'handoff', actor: verified('tab-old') }));

    expect(updated.orchestration?.orchestratorTabId).toBe('tab-next');
    expect(run()).toMatchObject({ revision: 1, binding: { ...identityOf('tab-old'), generation: 1 } });
    expect(rebounds()).toEqual([]);
  });
});
