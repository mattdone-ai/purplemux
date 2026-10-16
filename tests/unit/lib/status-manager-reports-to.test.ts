import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { TLivenessEvent } from '@/types/liveness';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

const workspaceStore = vi.hoisted(() => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspacesCached: vi.fn(),
}));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));
const layout = vi.hoisted(() => ({ clearReportsTo: vi.fn(async () => [] as string[]) }));
// The alert policy's switch, pinned per test: the worker's shared temp HOME may hold another file's config.
const alertConfig = vi.hoisted(() => ({ orchestratorOnly: true }));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));
vi.mock('@/lib/config-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config-store')>();
  return { ...actual, getConfig: async () => ({ ...(await actual.getConfig()), alertsOrchestratorOnly: alertConfig.orchestratorOnly }) };
});
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  clearReportsTo: layout.clearReportsTo,
}));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const entry = (id: string, extra: Partial<ITabStatusEntry> = {}): ITabStatusEntry => ({
  cliState: 'idle',
  workspaceId: 'ws-1',
  tabName: id,
  tmuxSession: `tmux-${id}`,
  panelType: 'claude-code',
  ...extra,
});

const setup = async (orchestration: { enabled: boolean; orchestratorTabId: string | null }) => {
  const ws = { id: 'ws-1', name: 'ws', directories: ['/tmp'], orchestration };
  workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
  workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}));
  const internals = manager as unknown as {
    nudgeOrchestrator: (tabId: string, e: ITabStatusEntry, kind: 'stuck', detail?: string) => Promise<void>;
    handleLivenessEvent: (event: TLivenessEvent) => Promise<void>;
    stuckNudgedTabs: Map<string, number>;
  };
  const targets = () => paste.mock.calls.map(([session]) => session.replace('tmux-', ''));
  return { manager, internals, paste, targets };
};

const bgFailed = (notify?: 'self' | 'orchestrator', tabId = 'w'): TLivenessEvent => ({
  kind: 'bg-failed',
  job: { workspaceId: 'ws-1', tabId, pid: 42, label: 'gate', registeredAt: 0, ...(notify ? { notify } : {}) },
  exitCode: 1,
  stderrTail: null,
});

const bgUnknown = (notify?: 'self' | 'orchestrator'): TLivenessEvent => ({
  kind: 'bg-exited-unknown',
  job: { workspaceId: 'ws-1', tabId: 'w', pid: 42, label: 'gate', registeredAt: 0, ...(notify ? { notify } : {}) },
  stderrTail: null,
});

const bgCompleted = (notify?: 'self' | 'orchestrator'): TLivenessEvent => ({
  kind: 'bg-completed',
  job: { workspaceId: 'ws-1', tabId: 'w', pid: 42, label: 'gate', registeredAt: 0, ...(notify ? { notify } : {}) },
  exitCode: 0,
  stderrTail: null,
});

describe('nudge routing — reportsTo and notify self (ADR-0018)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  it('sends W\'s nudge to O2 only while O2 is live, then to O1 after O2 closes', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('o2', entry('o2'));
    const w = entry('w', { reportsTo: 'o2' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o2']);

    manager.removeTab('o2');
    manager.forgetReportsTo('ws-1', 'o2');
    expect(w.reportsTo).toBeNull();
    expect(layout.clearReportsTo).toHaveBeenCalledWith('ws-1', 'o2');

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o2', 'o1']);
  });

  it('falls back to the orchestrator when reportsTo names a tab that is not live', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    const w = entry('w', { reportsTo: 'gone' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o1']);
  });

  it('never routes across workspaces even when an entry names a tab of another one', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('x', entry('x', { workspaceId: 'ws-2' }));
    const w = entry('w', { reportsTo: 'x' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o1']);
  });

  it('delivers to a live reportsTo even when workspace orchestration is off', async () => {
    const { manager, internals, targets } = await setup({ enabled: false, orchestratorTabId: null });
    manager.registerTab('o2', entry('o2'));
    const w = entry('w', { reportsTo: 'o2' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o2']);
  });

  it('never routes to a non-agent tab, even if the layout names one', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('sh', entry('sh', { panelType: 'terminal' }));
    const w = entry('w', { reportsTo: 'sh' });
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(targets()).toEqual(['o1']);
  });

  it('keeps today\'s silence with no reportsTo and orchestration off', async () => {
    const { manager, internals, paste } = await setup({ enabled: false, orchestratorTabId: null });
    const w = entry('w');
    manager.registerTab('w', w);

    await internals.nudgeOrchestrator('w', w, 'stuck');
    expect(paste).not.toHaveBeenCalled();
  });

  it('sends a --notify self COMPLETED nudge to the registering tab', async () => {
    const { manager, internals, paste, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('w', entry('w', { reportsTo: 'o1' }));

    await internals.handleLivenessEvent(bgCompleted('self'));
    expect(targets()).toEqual(['w']);
    expect(paste.mock.calls[0][1]).toContain('BACKGROUND JOB COMPLETED');
  });

  it('routes a default bg outcome to reportsTo, else the orchestrator (today\'s behaviour)', async () => {
    const { manager, internals, targets } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    manager.registerTab('o1', entry('o1'));
    manager.registerTab('o2', entry('o2'));
    manager.registerTab('w', entry('w', { reportsTo: 'o2' }));

    // Two jobs (two pids): an identical repeat within 60 s would be dropped as a duplicate (L49).
    const secondJob: TLivenessEvent = {
      kind: 'bg-completed',
      job: { workspaceId: 'ws-1', tabId: 'w', pid: 43, label: 'gate', registeredAt: 0, notify: 'orchestrator' },
      exitCode: 0,
      stderrTail: null,
    };
    await internals.handleLivenessEvent(bgCompleted());
    await internals.handleLivenessEvent(secondJob);
    manager.removeTab('o2');
    await internals.handleLivenessEvent(bgCompleted());
    expect(targets()).toEqual(['o2', 'o2', 'o1']);
  });
});

describe('human pages for liveness events (story 34, consult ruling A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alertConfig.orchestratorOnly = true;
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  const withAlerts = async (orchestration = { enabled: true, orchestratorTabId: 'o1' as string | null }, w: Partial<ITabStatusEntry> = { reportsTo: 'o1' }) => {
    const env = await setup(orchestration);
    const alerts = vi.fn(async (_params: { kind: string }) => {});
    (env.manager as unknown as { dispatchAlert: typeof alerts }).dispatchAlert = alerts;
    env.manager.registerTab('o1', entry('o1'));
    env.manager.registerTab('w', entry('w', w));
    return { ...env, alerts };
  };
  const kinds = (alerts: { mock: { calls: Array<[{ kind: string }]> } }) => alerts.mock.calls.map(([p]) => p.kind);

  it('a self-notified failure delivered to its tab wakes that tab and pages no one', async () => {
    const { internals, paste, targets, alerts } = await withAlerts();
    await internals.handleLivenessEvent(bgFailed('self'));
    expect(targets()).toEqual(['w']);
    expect(paste.mock.calls[0][1]).toContain('code 1');
    expect(alerts).not.toHaveBeenCalled();
  });

  it('a self-notified failure that could not be delivered still pages the human', async () => {
    const { manager, internals, paste, alerts } = await withAlerts();
    // A tab halted by a usage limit is never typed into (story 26): the self-notice is withheld.
    manager.registerTab('w', entry('w', { reportsTo: 'o1', turnError: { class: 'usage-limit' } as never }));
    await internals.handleLivenessEvent(bgFailed('self'));
    expect(paste).not.toHaveBeenCalled();
    expect(alerts.mock.calls.map(([p]) => p.kind)).toEqual(['bg-job-died']);
  });

  it('a vanished self-notified job, and a failure notified to the orchestrator, still page', async () => {
    const { internals, alerts } = await withAlerts();
    await internals.handleLivenessEvent(bgUnknown('self'));
    await internals.handleLivenessEvent(bgFailed());
    await internals.handleLivenessEvent(bgFailed('orchestrator'));
    expect(alerts.mock.calls.map(([p]) => p.kind)).toEqual(['bg-job-unknown', 'bg-job-died', 'bg-job-died']);
  });

  // Review r1 finding 1: tmux accepts the keys whether or not a live agent reads them.
  it('a self-notified failure typed into a shell or an exited agent still pages', async () => {
    for (const w of [{ panelType: 'terminal' as const }, { cliState: 'inactive' as const }, { cliState: 'unknown' as const }]) {
      const { internals, targets, alerts } = await withAlerts(undefined, { reportsTo: 'o1', ...w });
      await internals.handleLivenessEvent(bgFailed('self'));
      expect(targets()).toEqual(['w']);
      expect(kinds(alerts)).toEqual(['bg-job-died']);
    }
  });

  // Review r1 finding 2: the woken tab's turn end must reach someone, or the page is the only word.
  it('a delivered self-notified failure still pages when the tab has nowhere to escalate', async () => {
    const off = await withAlerts({ enabled: false, orchestratorTabId: null }, {});
    await off.internals.handleLivenessEvent(bgFailed('self'));
    expect(off.targets()).toEqual(['w']);
    expect(kinds(off.alerts)).toEqual(['bg-job-died']);

    // The only target is halted by a usage limit: its nudge would be withheld (story 26).
    const halted = await withAlerts();
    halted.manager.registerTab('o1', entry('o1', { turnError: { class: 'usage-limit' } as never }));
    await halted.internals.handleLivenessEvent(bgFailed('self'));
    expect(halted.targets()).toEqual(['w']);
    expect(kinds(halted.alerts)).toEqual(['bg-job-died']);
  });

  // Review r2 finding 1: an orchestrator id may name a closed tab or an exited agent.
  it('a delivered self-notified failure still pages when the orchestrator is gone or not a live agent', async () => {
    // The last: an orchestrator id that names another workspace's live agent (review r3).
    for (const o1 of [null, { cliState: 'inactive' as const }, { panelType: 'terminal' as const }, { workspaceId: 'ws-2' }]) {
      const env = await withAlerts(undefined, {});
      if (o1 === null) env.manager.removeTab('o1');
      else env.manager.registerTab('o1', entry('o1', o1));
      await env.internals.handleLivenessEvent(bgFailed('self'));
      expect(env.targets()).toEqual(['w']);
      expect(kinds(env.alerts)).toEqual(['bg-job-died']);
    }
  });

  // Review r2 finding 2: the alert policy is no substitute for a live target (no stall alert follows).
  it('a delivered self-notified failure still pages when only the alert policy would hear the tab', async () => {
    // The orchestrator's own gate: its turn end pushes, but nothing covers it if it hangs busy.
    const orch = await withAlerts();
    await orch.internals.handleLivenessEvent(bgFailed('self', 'o1'));
    expect(orch.targets()).toEqual(['o1']);
    expect(kinds(orch.alerts)).toEqual(['bg-job-died']);

    // An un-orchestrated worker when the policy alerts every agent tab.
    alertConfig.orchestratorOnly = false;
    const worker = await withAlerts({ enabled: false, orchestratorTabId: null }, {});
    await worker.internals.handleLivenessEvent(bgFailed('self'));
    expect(worker.targets()).toEqual(['w']);
    expect(kinds(worker.alerts)).toEqual(['bg-job-died']);
  });

  it('a delivered self-notified failure pages no one when the orchestrator is a live agent', async () => {
    const { internals, targets, alerts } = await withAlerts(undefined, {});
    await internals.handleLivenessEvent(bgFailed('self'));
    expect(targets()).toEqual(['w']);
    expect(alerts).not.toHaveBeenCalled();
  });

  // CONFIRM residual: a stuck nudge spent earlier in the same wait must not leave a hang after the
  // wake uncovered, so the skip re-arms it; a page that goes out leaves the latch alone.
  it('a skipped page re-arms the woken tab\'s stuck nudge', async () => {
    const skipped = await withAlerts(undefined, {});
    skipped.internals.stuckNudgedTabs.set('w', Date.now());
    await skipped.internals.handleLivenessEvent(bgFailed('self'));
    expect(skipped.alerts).not.toHaveBeenCalled();
    expect(skipped.internals.stuckNudgedTabs.has('w')).toBe(false);

    const paged = await withAlerts({ enabled: false, orchestratorTabId: null }, {});
    paged.internals.stuckNudgedTabs.set('w', Date.now());
    await paged.internals.handleLivenessEvent(bgFailed('self'));
    expect(kinds(paged.alerts)).toEqual(['bg-job-died']);
    expect(paged.internals.stuckNudgedTabs.has('w')).toBe(true);
  });

  // The ruling's premise, chained: the woken tab's next stop still escalates to its target — at once
  // with an end line, and through the one idle nudge after the quiet window without one (L49).
  it('after a delivered self-notified failure, the tab\'s next stop nudges its target', async () => {
    const { manager, internals, targets, alerts, paste } = await withAlerts(undefined, {
      reportsTo: 'o1', cliState: 'busy', jsonlPath: null, lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 }, eventSeq: 1,
    });
    await internals.handleLivenessEvent(bgFailed('self'));
    expect(alerts).not.toHaveBeenCalled();
    manager.updateTabFromHook('tmux-w', 'stop');
    await vi.waitFor(() => expect(manager.getAllForClient().w.turnEnd?.kind).toBe('ready-for-review'), { timeout: 5000 });
    expect(targets()).toEqual(['w']);
    const at = manager.getAllForClient().w.turnEnd!.at;
    await (manager as unknown as { runWatchdogTimers: (n: number) => Promise<void> }).runWatchdogTimers(at + 15 * 60 * 1000);
    await vi.waitFor(() => expect(targets()).toEqual(['w', 'o1']), { timeout: 5000 });
    expect(paste.mock.calls[1][1]).toContain('idle without an end line');
  });

  it('a completed self-notified job pages no one (unchanged)', async () => {
    const { internals, alerts } = await withAlerts();
    await internals.handleLivenessEvent(bgCompleted('self'));
    expect(alerts).not.toHaveBeenCalled();
  });
});
