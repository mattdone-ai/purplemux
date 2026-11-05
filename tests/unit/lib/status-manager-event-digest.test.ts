import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { TLivenessEvent } from '@/types/liveness';
import type { ITabStatusEntry } from '@/types/status';
import type { TabEventsTable } from '@/lib/tab-events-store';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables, memoryTabEvents } from './tab-events-harness';

const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });
const entry = (id: string, extra: Partial<ITabStatusEntry> = {}): ITabStatusEntry => ({
  cliState: 'idle', workspaceId: 'ws-1', tabName: id, tmuxSession: `tmux-${id}`, panelType: 'claude-code', ...extra,
});

const setup = async (opts: {
  beforePaste?: () => void;
  /** Held inside the dispatch lock: the paste is in flight until it resolves. */
  pasteGate?: () => Promise<void>;
  tabEvents?: ReturnType<typeof memoryTabEvents>;
} = {}) => {
  const ws = { id: 'ws-1', name: 'ws', directories: ['/tmp'], orchestration: { enabled: true, orchestratorTabId: 'o' } };
  workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
  workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => {
      opts.beforePaste?.();
      await opts.pasteGate?.();
      return deliver(async () => ({ ok: true }));
    }) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  const tabEvents = opts.tabEvents ?? memoryTabEvents();
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), tabEvents, memoryLedgerTables()[1]);
  const internals = manager as unknown as {
    nudgeOrchestrator: (tabId: string, e: ITabStatusEntry, kind: string, detail?: string, episode?: string) => Promise<boolean>;
    tabEvents: { tick: () => Promise<void> };
    runOrchestratorKeeper: () => Promise<void>;
    orchKeeper: Map<string, { idleSince: number | null; beats: number; lastBeatAt: number; stallAlerted: boolean }>;
    handleLivenessEvent: (event: TLivenessEvent) => Promise<void>;
    dispatchAlert: (params: { kind: string; detail?: string | null }) => Promise<void>;
    broadcast: (message: unknown) => void;
  };
  const orch = entry('o');
  manager.registerTab('o', orch);
  const w = entry('w', { cliState: 'ready-for-review' });
  manager.registerTab('w', w);
  const marker = (line: string, episode: string) => internals.nudgeOrchestrator('w', w, 'turn-marker', line, episode);
  const typed = () => paste.mock.calls.map(([, message]) => message);
  return { manager, internals, orch, marker, typed, tabEvents, paste };
};

describe('watchdog nudges through the wake classes (ADR-0035)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  it('types DONE at once into a busy orchestrator, and never a digest (AC 2, AC 3)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { manager, internals, orch, marker, typed } = await setup();
    orch.cliState = 'busy';
    await marker('CHECKPOINTED: handoff a', 'seq:1');
    await marker('DONE: shipped', 'seq:2');
    await marker('CHECKPOINTED: handoff b', 'seq:3');
    await internals.tabEvents.tick();
    expect(typed()).toEqual([expect.stringContaining('ended: DONE: shipped')]);
    expect(manager.getOrchestrationNudges('ws-1').map((n) => [n.wakeClass, n.delivered])).toEqual([
      ['digest', false], ['urgent', true], ['digest', false],
    ]);

    orch.cliState = 'idle';
    vi.setSystemTime(Date.now() + 5_000);
    await internals.tabEvents.tick();
    expect(typed()).toHaveLength(2);
    expect(typed()[1]).toMatch(/^DIGEST 2 since \S+Z\n- \d\d:\d\dZ turn-marker: worker w \(w\) ended: CHECKPOINTED: handoff a\n/);
    expect(typed()[1]).toContain('CHECKPOINTED: handoff b');
    expect(manager.getOrchestrationNudges('ws-1').map((n) => n.delivered)).toEqual([true, true, true]);
  });

  it('a tab waiting at its prompt on its own background work takes a digest; a halted one does not', async () => {
    const { manager, internals, orch, marker, typed } = await setup();
    orch.cliState = 'busy';
    expect(manager.isAtPrompt('o')).toBe(false);
    await marker('CHECKPOINTED: handoff', 'seq:1');
    // The turn ends waiting on its own job: busy, but at its prompt (ADR-0018 ruling A').
    orch.lastEvent = { name: 'stop', at: Date.now(), seq: 7 };
    orch.turnEnd = { kind: 'waiting', at: Date.now(), seq: 7, openBackgroundTasks: 1, liveRegisteredJobs: 0, armedWatches: 0 };
    expect(manager.isAtPrompt('o')).toBe(true);
    orch.turnError = { class: 'usage-limit' } as ITabStatusEntry['turnError'];
    expect(manager.isAtPrompt('o')).toBe(false);
    await internals.tabEvents.tick();
    expect(typed()).toEqual([]);
    orch.turnError = null;
    await internals.tabEvents.tick();
    expect(typed()).toEqual([expect.stringMatching(/^DIGEST 1 since /)]);
  });

  it('is never at its prompt as a shell, a tab being closed, or a tab it does not know', async () => {
    const { manager } = await setup();
    manager.registerTab('sh', entry('sh', { panelType: 'terminal' }));
    expect(manager.isAtPrompt('sh')).toBe(false);
    expect(manager.isAtPrompt('nope')).toBe(false);
    expect(manager.isAtPrompt('o')).toBe(true);
  });

  it('keeps the nudge history across a restart: a new manager over the same log reads it (AC 5)', async () => {
    const { marker, tabEvents } = await setup();
    await marker('DONE: before the restart', 'seq:1');
    const { StatusManager } = await import('@/lib/status-manager');
    const restarted = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}), tabEvents, memoryLedgerTables()[1]);
    expect(restarted.getOrchestrationNudges('ws-1')).toEqual([expect.objectContaining({
      tabId: 'w', tabName: 'w', kind: 'turn-marker', delivered: true, wakeClass: 'urgent', message: expect.stringContaining('DONE: before the restart'),
    })]);
    expect(restarted.getOrchestrationNudges('ws-2')).toEqual([]);
  });

  it('a digest is never typed when the orchestrator turns busy before the paste (review r2, F4)', async () => {
    let flip = false;
    const { orch, marker, paste, tabEvents } = await setup({ beforePaste: () => { if (flip) orch.cliState = 'busy'; } });
    flip = true;
    await marker('CHECKPOINTED: handoff', 'seq:1');
    expect(paste).not.toHaveBeenCalled();
    expect(tabEvents().pending('ws-1', 'o')).toHaveLength(1);
  });

  it('broadcasts each nudge a digest carried, delivered, under the id the client holds (review r2, F9)', async () => {
    const { internals, orch, marker } = await setup();
    const sent: Array<{ type: string; nudge?: { id: string; delivered: boolean } }> = [];
    internals.broadcast = (message) => { sent.push(message as never); };
    orch.cliState = 'busy';
    await marker('CHECKPOINTED: handoff', 'seq:1');
    orch.cliState = 'idle';
    await internals.tabEvents.tick();
    const nudges = sent.filter((m) => m.type === 'orchestration:nudge').map((m) => m.nudge!);
    expect(nudges.map((n) => [n.id, n.delivered])).toEqual([[nudges[0].id, false], [nudges[0].id, true]]);
  });

  // Release acceptance on accd20c5 (checks self-failure-*): the history showed a `--notify self` bg-* nudge as
  // undelivered while its paste ran, and the checks read it at its first appearance (09-fix).
  describe('a --notify self background job report while its paste runs', () => {
    const job = { workspaceId: 'ws-1', tabId: 'w', pid: 42, label: 'gate', registeredAt: 0, notify: 'self' as const };
    const events: Record<string, TLivenessEvent> = {
      'bg-failed': { kind: 'bg-failed', job, exitCode: 3, stderrTail: null },
      'bg-exited-unknown': { kind: 'bg-exited-unknown', job, stderrTail: null },
      'bg-completed': { kind: 'bg-completed', job, exitCode: 0, stderrTail: null },
    };
    const gated = async (worker: Partial<ITabStatusEntry>, opts: { orchestration?: boolean } = {}) => {
      let release!: () => void;
      let entered = false;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ctx = await setup({ pasteGate: () => { entered = true; return gate; } });
      if (opts.orchestration === false) {
        const ws = { id: 'ws-1', name: 'ws', directories: ['/tmp'] };
        workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
        workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
        ctx.manager.removeTab('o');
      }
      ctx.manager.registerTab('lead', entry('lead', { cliState: 'busy' }));
      ctx.manager.registerTab('w', entry('w', { cliState: 'busy', ...worker }));
      const alerts: string[] = [];
      ctx.internals.dispatchAlert = async (params) => { alerts.push(params.kind); };
      const run = async (event: TLivenessEvent) => {
        const handled = ctx.internals.handleLivenessEvent(event);
        await vi.waitFor(() => expect(entered).toBe(true));
        const inFlight = ctx.manager.getOrchestrationNudges('ws-1').filter((n) => n.tabId === 'w');
        release();
        await handled;
        return { inFlight, settled: ctx.manager.getOrchestrationNudges('ws-1').filter((n) => n.tabId === 'w') };
      };
      return { ...ctx, alerts, run };
    };

    it('heard: a busy agent whose reportsTo is a live agent reads delivered, urgent, and pages no one', async () => {
      const { run, alerts, typed } = await gated({ reportsTo: 'lead' });
      const { inFlight, settled } = await run(events['bg-failed']);
      expect(inFlight.filter((n) => !n.delivered)).toEqual([]);
      expect(settled).toEqual([expect.objectContaining({ kind: 'bg-failed', delivered: true, wakeClass: 'urgent' })]);
      expect(typed()).toEqual([expect.stringContaining('BACKGROUND JOB FAILED')]);
      expect(alerts).toEqual([]);
    });

    it('shell: an inactive shell tab with a live reportsTo reads delivered and still pages the human', async () => {
      const { run, alerts } = await gated({ panelType: 'terminal', cliState: 'inactive', reportsTo: 'lead' });
      const { inFlight, settled } = await run(events['bg-failed']);
      expect(inFlight.filter((n) => !n.delivered)).toEqual([]);
      expect(settled).toEqual([expect.objectContaining({ kind: 'bg-failed', delivered: true, wakeClass: 'urgent' })]);
      expect(alerts).toEqual(['bg-job-died']);
    });

    it('alone: a busy agent with no escalation target reads delivered and still pages the human', async () => {
      const { run, alerts } = await gated({}, { orchestration: false });
      const { inFlight, settled } = await run(events['bg-failed']);
      expect(inFlight.filter((n) => !n.delivered)).toEqual([]);
      expect(settled).toEqual([expect.objectContaining({ kind: 'bg-failed', delivered: true, wakeClass: 'urgent' })]);
      expect(alerts).toEqual(['bg-job-died']);
    });

    it.each(['bg-exited-unknown', 'bg-completed'])('%s to a busy waiting tab is urgent and reads delivered only once typed', async (kind) => {
      const { run, typed } = await gated({ reportsTo: 'lead' });
      const { inFlight, settled } = await run(events[kind]);
      expect(inFlight.filter((n) => !n.delivered)).toEqual([]);
      expect(settled).toEqual([expect.objectContaining({ kind, delivered: true, wakeClass: 'urgent' })]);
      expect(typed()).toHaveLength(1);
    });
  });

  describe('a ledger that cannot be written (review r2, F1)', () => {
    const full = () => {
      const table = memoryTabEvents()();
      const proxy = new Proxy(table, {
        get: (target, key) => (key === 'append' ? () => { throw new Error('SQLITE_FULL: database or disk is full'); } : Reflect.get(target, key)),
      });
      return (() => proxy) as () => TabEventsTable;
    };

    it('the keeper\'s heartbeat is still typed and counted', async () => {
      const { manager, internals, typed } = await setup({ tabEvents: full() });
      // A worker in review keeps the keeper quiet; this orchestrator has none.
      manager.removeTab('w');
      internals.orchKeeper.set('ws-1', { idleSince: 0, beats: 0, lastBeatAt: 0, stallAlerted: false });
      await internals.runOrchestratorKeeper();
      expect(typed()).toEqual([expect.stringContaining('heartbeat')]);
      expect(internals.orchKeeper.get('ws-1')?.beats).toBe(1);
    });

    it('a liveness event still reaches its nudge and the human alert', async () => {
      const { internals, typed } = await setup({ tabEvents: full() });
      const alerts: string[] = [];
      internals.dispatchAlert = async (params) => { alerts.push(params.kind); };
      await internals.handleLivenessEvent({
        kind: 'bg-failed', job: { workspaceId: 'ws-1', tabId: 'w', pid: 42, label: 'gate', registeredAt: 0 }, exitCode: 1, stderrTail: null,
      });
      expect(typed()).toEqual([expect.stringContaining('BACKGROUND JOB FAILED')]);
      expect(alerts).toEqual(['bg-job-died']);
    });

    it('raises the hour-old held backlog to the human once (review r2, F6)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { internals, orch, marker } = await setup();
      const alerts: Array<{ kind: string; detail?: string | null }> = [];
      internals.dispatchAlert = async (params) => { alerts.push(params); };
      orch.cliState = 'busy';
      await marker('CHECKPOINTED: handoff', 'seq:1');
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await internals.tabEvents.tick();
      await internals.tabEvents.tick();
      await vi.waitFor(() => expect(alerts).toHaveLength(1));
      expect(alerts[0]).toMatchObject({ kind: 'flag', detail: expect.stringContaining('1 event(s) held for o\'s digest, the oldest 60 min') });
      expect(alerts[0].detail).toMatch(/Read them: purplemux events show -w ws-1 o --since \d{4}-\d\d-\d\dT\S+Z$/);
    });

    it('a closed tab\'s held events are retired, never reported (post-review F12)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const { manager, internals, orch, marker, tabEvents } = await setup();
      const alerts: string[] = [];
      internals.dispatchAlert = async (params) => { alerts.push(params.kind); };
      orch.cliState = 'busy';
      await marker('CHECKPOINTED: handoff', 'seq:1');
      manager.retireTabEvents('ws-1', 'o');
      manager.removeTab('o');
      vi.setSystemTime(Date.now() + 60 * 60_000);
      await internals.tabEvents.tick();
      expect(alerts).toEqual([]);
      expect(tabEvents().pending('ws-1', 'o')).toEqual([]);
    });
  });
});
