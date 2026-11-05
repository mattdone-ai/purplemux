import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';
import type { IBackgroundJob, TLivenessEvent } from '@/types/liveness';
import { memoryLedgerTables, memoryTabEvents } from './tab-events-harness';

// Watchdog noise (h-selfimprove item 3; L38, L49, L37):
//  - L38: a tab closed through the API raises no INACTIVE; a tab whose agent dies unclosed still does.
//  - L49: identical nudges within 60 s are dropped and counted; a dead registered job reports its exit
//    before its tab's stall is judged (orchestrator, tab-peo88o, 27 Sep ~11:41Z).

const state = vi.hoisted(() => ({
  tabs: [] as ITab[],
  running: false,
  home: '',
}));
const liveness = vi.hoisted(() => ({
  tick: vi.fn(async () => {}),
  removeTab: vi.fn(),
  takeJobs: vi.fn(async (_workspaceId: string, _tabId: string): Promise<IBackgroundJob[]> => []),
  registerJob: vi.fn(async (_job: IBackgroundJob) => {}),
  isJobAlive: vi.fn((_job: IBackgroundJob) => true),
  statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] as Array<{ pid: number; alive: boolean }> })),
  reconcileJobs: vi.fn(async (_tabId: string, _emit: (e: TLivenessEvent) => void) => ({ reported: 0, pendingDead: 0 })),
}));
const WS = { id: 'ws-1', name: 'w', directories: ['/tmp'], orchestration: { enabled: true, orchestratorTabId: 'root' } };

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => state.home }, homedir: () => state.home };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [WS] })),
  getWorkspaceByIdCached: vi.fn(async () => WS),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [WS] })),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  resolveLayoutFile: () => '/nonexistent/layout.json',
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  collectAllTabs: () => state.tabs,
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
  updateTabWatchdogTurnEnd: vi.fn(async () => {}),
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));
vi.mock('@/lib/lease-sweeper', () => ({ getLeaseSweeper: () => ({ sweep: vi.fn(async () => []) }), setLeaseAgentStateSource: vi.fn() }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getAllPanesInfo: vi.fn(async () => new Map([['tmux-w', { pid: 4242, command: 'claude', path: '/tmp' }]])),
  getChildPids: vi.fn(async () => [4243]),
  getPaneTitle: vi.fn(async () => ''),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
  capturePaneContent: vi.fn(async () => null),
}));
vi.mock('@/lib/providers/claude/session-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/claude/session-detection')>()),
  isClaudeRunning: vi.fn(async () => state.running),
  detectActiveSession: vi.fn(async () => ({ status: 'not-running', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null })),
  watchSessionsDir: vi.fn(() => ({ stop: () => {} })),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const MIN = 60 * 1000;

const timers = (manager: unknown, now: number) =>
  (manager as { runWatchdogTimers: (n: number) => Promise<void> }).runWatchdogTimers(now);

const routed = (tabEvents: ReturnType<typeof memoryTabEvents>) => tabEvents().list('ws-1', { since: 0, limit: 100 })
  .filter((row) => row.class !== 'log').map((row) => ({ to: row.tabId, message: row.text }));

const setup = async (worker: Partial<ITabStatusEntry> = {}) => {
  state.tabs = [tab('w')];
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const tabEvents = memoryTabEvents();
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), tabEvents, memoryLedgerTables()[1]);
  const alerts = vi.fn(async (_params: { kind: string }) => {});
  (manager as unknown as { dispatchAlert: typeof alerts }).dispatchAlert = alerts;
  manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
  const entry: ITabStatusEntry = {
    cliState: 'ready-for-review', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code',
    agentProviderId: 'claude', jsonlPath: null, lastEvent: { name: 'stop', at: Date.now(), seq: 1 }, eventSeq: 1, paneTitle: '',
    ...worker,
  };
  manager.registerTab('w', entry);
  const internals = manager as unknown as {
    tabs: Map<string, ITabStatusEntry>;
    handleLivenessEvent: (e: TLivenessEvent) => Promise<void>;
  };
  // What each tab was sent, typed now or held for its digest (ADR-0035): the watchdog's decision, not the paste.
  const sent = () => routed(tabEvents);
  return { manager, entry, paste, alerts, internals, sent };
};

const bg = (kind: 'bg-completed' | 'bg-failed', pid = 42): TLivenessEvent => (kind === 'bg-completed'
  ? { kind, job: { workspaceId: 'ws-1', tabId: 'w', pid, label: 'resilience-gate', registeredAt: 0 }, exitCode: 0, stderrTail: null }
  : { kind, job: { workspaceId: 'ws-1', tabId: 'w', pid, label: 'resilience-gate', registeredAt: 0 }, exitCode: 1, stderrTail: null });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.running = false;
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-watchdog-noise-'));
  liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  liveness.reconcileJobs.mockResolvedValue({ reported: 0, pendingDead: 0 });
  liveness.takeJobs.mockResolvedValue([]);
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(state.home, { recursive: true, force: true });
});

describe('no INACTIVE after tab close (behaviour 3, L38)', () => {
  it('negative: an agent that dies in a tab nobody closed still raises INACTIVE', async () => {
    const { manager, entry, sent } = await setup();
    await manager.poll();
    expect(entry.cliState).toBe('inactive');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ to: 'root' });
    expect(sent()[0].message).toContain('is INACTIVE (agent process gone)');
  });

  it('a tab announced as closing is not judged while its processes are reaped: no INACTIVE, no state change', async () => {
    const { manager, entry, paste } = await setup();
    manager.handleTabClosing('w', 'closing');
    await manager.poll();
    await new Promise((r) => setTimeout(r, 50));
    expect(entry.cliState).toBe('ready-for-review');
    expect(paste).not.toHaveBeenCalled();
  });

  it('an aborted close restores the checks: the dead agent then raises INACTIVE', async () => {
    const { manager, entry, sent } = await setup();
    manager.handleTabClosing('w', 'closing');
    await manager.poll();
    manager.handleTabClosing('w', 'aborted');
    await manager.poll();
    expect(entry.cliState).toBe('inactive');
    await vi.waitFor(() => expect(sent().map((s) => s.message)).toEqual([expect.stringContaining('INACTIVE')]));
  });

  it('a poll that read the layout before the close does not bring the closed tab back', async () => {
    const { manager, internals, paste } = await setup();
    manager.handleTabClosing('w', 'closing');
    manager.removeTab('w');
    // The stale poll still lists the tab (measured: an INACTIVE 38 s after tab-DuHnlf closed).
    await manager.poll();
    expect(internals.tabs.has('w')).toBe(false);
    expect(paste).not.toHaveBeenCalled();
  });

  it('drops a registered job\'s exit event for a closing tab: no nudge, no page', async () => {
    const { manager, internals, paste, alerts } = await setup();
    manager.handleTabClosing('w', 'closing');
    await internals.handleLivenessEvent(bg('bg-failed'));
    expect(paste).not.toHaveBeenCalled();
    expect(alerts).not.toHaveBeenCalled();
  });

  it('a closing tab raises no nudge of any kind, even from a path already in flight', async () => {
    const { manager, entry, paste } = await setup();
    manager.handleTabClosing('w', 'closing');
    await (manager as unknown as { nudgeOrchestrator: (id: string, e: ITabStatusEntry, k: 'stuck') => Promise<boolean> }).nudgeOrchestrator('w', entry, 'stuck');
    expect(paste).not.toHaveBeenCalled();
  });

  it('sends no pending idle nudge for a tab being closed', async () => {
    const { manager, entry, paste } = await setup({ cliState: 'busy', lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 } });
    manager.updateTabFromHook('tmux-w', 'stop');
    await vi.waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
    manager.handleTabClosing('w', 'closing');
    await timers(manager, entry.turnEnd!.at + 20 * MIN);
    expect(paste).not.toHaveBeenCalled();
  });

  it('wires tab-closing into the production StatusManager', async () => {
    const { StatusManager, getStatusManager } = await import('@/lib/status-manager');
    const closing = vi.spyOn(StatusManager.prototype, 'handleTabClosing').mockImplementation(() => {});
    delete (globalThis as { __ptStatusManager?: unknown }).__ptStatusManager;
    getStatusManager();
    const { emitTabClosing } = await import('@/lib/tab-lifecycle');
    emitTabClosing({ workspaceId: 'ws-1', tabId: 'tab-x', sessionName: 's-x', phase: 'closing' });
    emitTabClosing({ workspaceId: 'ws-1', tabId: 'tab-x', sessionName: 's-x', phase: 'aborted' });
    expect(closing.mock.calls).toEqual([['tab-x', 'closing'], ['tab-x', 'aborted']]);
    getStatusManager().shutdown();
    delete (globalThis as { __ptStatusManager?: unknown }).__ptStatusManager;
    closing.mockRestore();
  });
});

describe('no INACTIVE and no job failure across a restart (ADR-0028)', () => {
  const restart = (phase: 'restarting' | 'restarted' | 'failed', restartId = 'r-1') => ({ workspaceId: 'ws-1', tabId: 'w', restartId, phase });
  const RESTART_JOB = { workspaceId: 'ws-1', tabId: 'w', pid: 42, label: 'resilience-gate', registeredAt: 0 };

  it('a restarting tab is not judged while its processes are reaped, and its entry stays', async () => {
    const { manager, entry, internals, paste } = await setup();
    manager.handleTabRestart(restart('restarting'));
    await manager.poll();
    await new Promise((r) => setTimeout(r, 50));
    expect(entry.cliState).toBe('ready-for-review');
    expect(internals.tabs.get('w')).toBe(entry);
    expect(paste).not.toHaveBeenCalled();
    expect(liveness.removeTab).not.toHaveBeenCalled();
  });

  it('takes the tab\'s registered background jobs with reason tab-restart; their exit raises nothing', async () => {
    const { manager, internals, paste, alerts } = await setup();
    liveness.takeJobs.mockResolvedValueOnce([RESTART_JOB]);
    manager.handleTabRestart(restart('restarting'));
    expect(liveness.takeJobs).toHaveBeenCalledWith('ws-1', 'w');
    await internals.handleLivenessEvent(bg('bg-failed'));
    expect(paste).not.toHaveBeenCalled();
    expect(alerts).not.toHaveBeenCalled();
  });

  it.each(['restarted', 'failed'] as const)('%s restores the checks: a dead agent then raises INACTIVE', async (phase) => {
    const { manager, entry, sent } = await setup();
    manager.handleTabRestart(restart('restarting'));
    await manager.poll();
    manager.handleTabRestart(restart(phase));
    await manager.poll();
    expect(entry.cliState).toBe('inactive');
    await vi.waitFor(() => expect(sent().map((s) => s.message)).toEqual([expect.stringContaining('INACTIVE')]));
  });

  it('failed gives the taken jobs back (a process may have survived); restarted does not', async () => {
    const { manager } = await setup();
    liveness.takeJobs.mockResolvedValueOnce([RESTART_JOB]);
    manager.handleTabRestart(restart('restarting', 'r-fail'));
    manager.handleTabRestart(restart('failed', 'r-fail'));
    await vi.waitFor(() => expect(liveness.registerJob).toHaveBeenCalledWith(RESTART_JOB));

    liveness.takeJobs.mockResolvedValueOnce([RESTART_JOB]);
    liveness.registerJob.mockClear();
    manager.handleTabRestart(restart('restarting', 'r-ok'));
    manager.handleTabRestart(restart('restarted', 'r-ok'));
    await new Promise((r) => setTimeout(r, 10));
    expect(liveness.registerJob).not.toHaveBeenCalled();
  });

  it('a failed restart gives back only the jobs that survived the reap', async () => {
    const { manager } = await setup();
    const killed = { ...RESTART_JOB, pid: RESTART_JOB.pid + 1 };
    liveness.takeJobs.mockResolvedValueOnce([RESTART_JOB, killed]);
    liveness.isJobAlive.mockImplementation((job: IBackgroundJob) => job.pid !== killed.pid);
    manager.handleTabRestart(restart('restarting', 'r-part'));
    manager.handleTabRestart(restart('failed', 'r-part'));
    await vi.waitFor(() => expect(liveness.registerJob).toHaveBeenCalledWith(RESTART_JOB));
    expect(liveness.registerJob).not.toHaveBeenCalledWith(killed);
    liveness.isJobAlive.mockImplementation(() => true);
  });

  it('a failed restart of a tab closed meanwhile gives no job back', async () => {
    const { manager } = await setup();
    liveness.takeJobs.mockResolvedValueOnce([RESTART_JOB]);
    manager.handleTabRestart(restart('restarting'));
    manager.removeTab('w');
    manager.handleTabRestart(restart('failed'));
    await new Promise((r) => setTimeout(r, 10));
    expect(liveness.registerJob).not.toHaveBeenCalled();
  });

  it('restarting → closing → restarted leaves the tab retired', async () => {
    const { manager, entry, paste } = await setup();
    manager.handleTabRestart(restart('restarting'));
    manager.handleTabClosing('w', 'closing');
    manager.handleTabRestart(restart('restarted'));
    await manager.poll();
    await new Promise((r) => setTimeout(r, 50));
    expect(entry.cliState).toBe('ready-for-review');
    expect(paste).not.toHaveBeenCalled();
  });

  it('removeTab → restarted leaves the tab retired: a poll does not bring the closed tab back', async () => {
    const { manager, internals, paste } = await setup();
    manager.handleTabRestart(restart('restarting'));
    manager.removeTab('w');
    manager.handleTabRestart(restart('restarted'));
    await manager.poll();
    expect(internals.tabs.has('w')).toBe(false);
    expect(paste).not.toHaveBeenCalled();
  });

  it('overlapping restarts restore the checks only after the last end', async () => {
    const { manager, entry, sent } = await setup();
    manager.handleTabRestart(restart('restarting', 'r-1'));
    manager.handleTabRestart(restart('restarting', 'r-2'));
    manager.handleTabRestart(restart('restarted', 'r-1'));
    await manager.poll();
    expect(entry.cliState).toBe('ready-for-review');
    manager.handleTabRestart(restart('restarted', 'r-2'));
    await manager.poll();
    expect(entry.cliState).toBe('inactive');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
  });

  it('an aborted close during an open restart keeps the tab retired until the restart ends', async () => {
    const { manager, entry } = await setup();
    manager.handleTabRestart(restart('restarting'));
    manager.handleTabClosing('w', 'closing');
    manager.handleTabClosing('w', 'aborted');
    await manager.poll();
    expect(entry.cliState).toBe('ready-for-review');
    manager.handleTabRestart(restart('restarted'));
    await manager.poll();
    expect(entry.cliState).toBe('inactive');
  });

  it('a job store that refuses the retirement is logged, never thrown', async () => {
    const { manager } = await setup();
    liveness.takeJobs.mockRejectedValueOnce(new Error('store unreadable'));
    expect(() => manager.handleTabRestart(restart('restarting'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('wires tab-restart into the production StatusManager, and never as a close', async () => {
    const { StatusManager, getStatusManager } = await import('@/lib/status-manager');
    const restarted = vi.spyOn(StatusManager.prototype, 'handleTabRestart').mockImplementation(() => {});
    const closing = vi.spyOn(StatusManager.prototype, 'handleTabClosing');
    const removed = vi.spyOn(StatusManager.prototype, 'removeTab');
    delete (globalThis as { __ptStatusManager?: unknown }).__ptStatusManager;
    getStatusManager();
    const { emitTabRestart } = await import('@/lib/tab-lifecycle');
    emitTabRestart({ workspaceId: 'ws-1', tabId: 'tab-x', sessionName: 's-x', restartId: 'r-x', phase: 'restarting' });
    emitTabRestart({ workspaceId: 'ws-1', tabId: 'tab-x', sessionName: 's-x', restartId: 'r-x', phase: 'restarted' });
    expect(restarted.mock.calls.map(([event]) => [event.restartId, event.phase])).toEqual([['r-x', 'restarting'], ['r-x', 'restarted']]);
    expect(closing).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
    getStatusManager().shutdown();
    delete (globalThis as { __ptStatusManager?: unknown }).__ptStatusManager;
    restarted.mockRestore();
    closing.mockRestore();
    removed.mockRestore();
  });
});

describe('identical nudges within 60 s (behaviour 4, L49)', () => {
  it('drops a second report of the same job and counts it; another job still goes out', async () => {
    const { manager, internals, sent } = await setup();
    await internals.handleLivenessEvent(bg('bg-completed'));
    await internals.handleLivenessEvent(bg('bg-completed'));
    expect(sent()).toHaveLength(1);
    expect(manager.getNudgeDedupeCount()).toBe(1);
    expect(manager.getOrchestrationNudges('ws-1')).toHaveLength(1);

    await internals.handleLivenessEvent(bg('bg-completed', 43));
    expect(sent()).toHaveLength(2);
    expect(manager.getNudgeDedupeCount()).toBe(1);
  });

  it('never drops a different class of the same tab to the same recipient', async () => {
    const { manager, entry, sent } = await setup();
    const nudge = (manager as unknown as { nudgeOrchestrator: (id: string, e: ITabStatusEntry, k: string, d?: string) => Promise<boolean> }).nudgeOrchestrator.bind(manager);
    await nudge('w', entry, 'stuck');
    await nudge('w', entry, 'needs-input');
    await nudge('w', entry, 'stuck');
    expect(sent().map((s) => s.message)).toEqual([expect.stringContaining('possibly stalled'), expect.stringContaining('NEEDS INPUT')]);
    expect(manager.getNudgeDedupeCount()).toBe(1);
  });

  it('pins the measured 27 Sep ~11:12Z pair: the same job\'s outcome reported twice at the same moment is delivered once (review r2 nit 5)', async () => {
    const { manager, internals, sent } = await setup();
    // Two reports of one episode (the same resilience-gate pid) racing into the watchdog together.
    await Promise.all([internals.handleLivenessEvent(bg('bg-completed', 2975644)), internals.handleLivenessEvent(bg('bg-completed', 2975644))]);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].message).toContain('pid 2975644');
    expect(manager.getNudgeDedupeCount()).toBe(1);
    expect(manager.getOrchestrationNudges('ws-1')).toHaveLength(1);
  });

  it('delivers two needs-input episodes 30 s apart, and drops a duplicate of the same episode (review r1 finding 3)', async () => {
    const { manager, entry, sent } = await setup({ cliState: 'busy', lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 } });
    manager.updateTabFromHook('tmux-w', 'notification', 'permission_prompt');
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    // The same episode reported again (a second path, the same hook event): dropped and counted.
    const nudge = (manager as unknown as { nudgeOrchestrator: (id: string, e: ITabStatusEntry, k: string) => Promise<boolean> }).nudgeOrchestrator.bind(manager);
    await nudge('w', entry, 'needs-input');
    expect(sent()).toHaveLength(1);
    expect(manager.getNudgeDedupeCount()).toBe(1);
    // The orchestrator answered; 30 s later the worker asks again: a new episode with the same text.
    manager.updateTabFromHook('tmux-w', 'prompt-submit');
    manager.updateTabFromHook('tmux-w', 'notification', 'permission_prompt');
    await vi.waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[0].message).toBe(sent()[1].message);
    expect(manager.getNudgeDedupeCount()).toBe(1);
  });
});

describe('the idle nudge survives a server restart (review r1 finding 2)', () => {
  /** The persisted copy of the tab, as the layout file would hold it; then one stop, recorded. */
  const stopAndPersist = async () => {
    const layout = await import('@/lib/layout-store');
    vi.mocked(layout.updateTabWatchdogTurnEnd).mockImplementation(async (_session, record) => {
      state.tabs[0] = { ...state.tabs[0], watchdogTurnEnd: record ?? undefined };
    });
    vi.mocked(layout.updateTabCliStatus).mockImplementation(async (_session, cliState) => {
      state.tabs[0] = { ...state.tabs[0], cliState };
    });
    const first = await setup({ cliState: 'busy', lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 } });
    first.manager.updateTabFromHook('tmux-w', 'stop');
    await vi.waitFor(() => expect(state.tabs[0].watchdogTurnEnd?.kind).toBe('ready-for-review'));
    await vi.waitFor(() => expect(state.tabs[0].cliState).toBe('ready-for-review'));
    first.manager.shutdown();
    return { layout, stopAt: state.tabs[0].watchdogTurnEnd!.at };
  };

  const rebuild = async () => {
    const { StatusManager } = await import('@/lib/status-manager');
    const paste = vi.fn(async (_session: string, _message: string) => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_ws, id) => tab(id)),
      withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
      hasSession: vi.fn(async () => true),
      paste,
    });
    const tabEvents = memoryTabEvents();
    const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), tabEvents, memoryLedgerTables()[1]);
    manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
    state.running = true;
    await manager.poll();
    return { manager, paste, sent: () => routed(tabEvents).map((row) => row.message) };
  };

  it('a manager rebuilt from the persisted stop sends exactly one nudge once the window passes, and none across a second rebuild', async () => {
    const { stopAt } = await stopAndPersist();
    expect(state.tabs[0].watchdogTurnEnd).toMatchObject({ agentSessionId: null });

    // Restart 1: the pending nudge is rebuilt from disk and fires once, after the window.
    const second = await rebuild();
    const restored = (second.manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('w')!;
    expect(restored.cliState).toBe('ready-for-review');
    expect(restored.lastEvent).toMatchObject({ name: 'stop', at: stopAt });
    await timers(second.manager, stopAt + 15 * MIN - 1);
    expect(second.sent()).toEqual([]);
    await timers(second.manager, stopAt + 15 * MIN);
    await timers(second.manager, stopAt + 30 * MIN);
    expect(second.sent()).toEqual([expect.stringContaining('idle without an end line')]);
    await vi.waitFor(() => expect(state.tabs[0].watchdogTurnEnd?.idleNudgeSentSeq).toBe(state.tabs[0].watchdogTurnEnd?.seq));
    second.manager.shutdown();

    // Restart 2: the sent marker came back from disk, so nothing is sent again.
    const third = await rebuild();
    await timers(third.manager, stopAt + 60 * MIN);
    expect(third.sent()).toEqual([]);
    third.manager.shutdown();
  });

  it('reports the real time since the stop, not the window, when the first pass after a restart is late (review r2 nit 2)', async () => {
    const { stopAt } = await stopAndPersist();
    const later = await rebuild();
    await timers(later.manager, stopAt + 3 * 60 * MIN);
    expect(later.sent()).toHaveLength(1);
    expect(later.sent()[0]).toContain('it stopped 180 min ago');
    later.manager.shutdown();
  });

  it('drops a persisted stop of ANOTHER agent session on restore: no nudge, and the record is cleared on disk (review r2 nit 2)', async () => {
    const { layout, stopAt } = await stopAndPersist();
    // The agent was relaunched while the server was down: the record names the old session.
    state.tabs[0] = { ...state.tabs[0], watchdogTurnEnd: { ...state.tabs[0].watchdogTurnEnd!, agentSessionId: 'old-session' } };
    const next = await rebuild();
    const restored = (next.manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('w')!;
    expect(restored.turnEnd ?? null).toBeNull();
    expect(restored.lastEvent).toBeNull();
    await timers(next.manager, stopAt + 60 * MIN);
    expect(next.sent()).toEqual([]);
    expect(layout.updateTabWatchdogTurnEnd).toHaveBeenLastCalledWith('tmux-w', null);
    expect(state.tabs[0].watchdogTurnEnd).toBeUndefined();
    next.manager.shutdown();
  });
});

describe('a dead registered job speaks before a stall (behaviours 6 and 7)', () => {
  const busyLongAgo = () => ({ cliState: 'busy' as const, lastEvent: { name: 'stop' as const, at: Date.now() - 40 * MIN, seq: 1 } });

  it('control: a busy tab silent 40 min with nothing open is STALLED', async () => {
    state.running = true;
    const { manager, sent } = await setup(busyLongAgo());
    await manager.poll();
    await vi.waitFor(() => expect(sent().map((s) => s.message)).toEqual([expect.stringContaining('possibly stalled')]));
  });

  it('reports the dead job first and sends no stall in that pass; the report then gives the tab the no-open window', async () => {
    state.running = true;
    const { manager, sent } = await setup(busyLongAgo());
    liveness.reconcileJobs.mockImplementationOnce(async (_tabId, emit) => {
      emit(bg('bg-completed', 3314233));
      return { reported: 1, pendingDead: 0 };
    });
    await manager.poll();
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0].message).toContain('BACKGROUND JOB COMPLETED');
    expect(liveness.reconcileJobs).toHaveBeenCalledWith('w', expect.any(Function));

    await manager.poll();
    await new Promise((r) => setTimeout(r, 50));
    expect(sent()).toHaveLength(1);
  });

  it('a dead job still inside its exit-file grace neither holds nor triggers the stall: the check waits', async () => {
    state.running = true;
    const { manager, paste } = await setup(busyLongAgo());
    liveness.reconcileJobs.mockResolvedValueOnce({ reported: 0, pendingDead: 1 });
    await manager.poll();
    await new Promise((r) => setTimeout(r, 50));
    expect(paste).not.toHaveBeenCalled();
  });

  it('counts only live registered jobs at a stop: a dead one does not make it WAITING', async () => {
    const { manager, entry } = await setup({ cliState: 'busy', lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 } });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: false }, { pid: 2, alive: true }] });
    manager.updateTabFromHook('tmux-w', 'stop');
    await vi.waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    expect(entry.turnEnd).toMatchObject({ liveRegisteredJobs: 1 });

    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: false }] });
    manager.updateTabFromHook('tmux-w', 'prompt-submit');
    manager.updateTabFromHook('tmux-w', 'stop');
    await vi.waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
    expect(entry.turnEnd).toMatchObject({ liveRegisteredJobs: 0 });
  });
});
