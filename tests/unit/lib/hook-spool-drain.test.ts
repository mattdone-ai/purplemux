import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { IHookDelivery } from '@/lib/hook-dispatch';
import type { IHookSpoolDrainResult } from '@/lib/hook-spool';
import type { StatusManager } from '@/lib/status-manager';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ADR-0020: the server replays what hooks spooled while no server answered —
// once it listens and on every poll, oldest first, through the hook route's own
// dispatcher, with each event's original time.

const state = vi.hoisted(() => ({ tabs: [] as ITab[], home: '' }));
const layoutWrites = vi.hoisted(() => ({
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
  updateTabAgentState: vi.fn(async () => {}),
  updateTabWatchdogTurnEnd: vi.fn(async () => {}),
}));
const sync = vi.hoisted(() => ({ broadcastSync: vi.fn((_message: { type: string }) => {}) }));
const WS = { id: 'ws-1', name: 'w', directories: ['/tmp'], orchestration: { enabled: true, orchestratorTabId: 'root' } };

const logs = vi.hoisted(() => ({ lines: [] as { level: string; fields: unknown; msg: string }[] }));
vi.mock('@/lib/logger', () => {
  const record = (level: string) => (fields: unknown, msg?: string) => {
    logs.lines.push({ level, fields, msg: msg ?? (typeof fields === 'string' ? fields : '') });
  };
  const logger = {
    trace: () => {}, debug: () => {}, info: record('info'), warn: record('warn'), error: record('error'), fatal: () => {},
    child: () => logger,
  };
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
  ...layoutWrites,
}));
vi.mock('@/lib/sync-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sync-server')>()),
  broadcastSync: sync.broadcastSync,
}));
// The generation gates are the launch lifecycle's own test; here a Codex hook of the active generation applies.
vi.mock('@/lib/providers/codex/launch-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/codex/launch-lifecycle')>()),
  withValidatedCodexHookGeneration: vi.fn(async (_session: string, generation: string, work: (identity: unknown) => unknown) =>
    ({ ok: true, value: await work({ workspaceId: 'ws-1', tabId: 'c', generation }) })),
  withReplayedCodexHookGeneration: vi.fn(async (_session: string, generation: string, work: (identity: unknown) => unknown, _tracked: unknown) =>
    ({ ok: true, value: work({ workspaceId: 'ws-1', tabId: 'c', generation }) })),
  withValidatedLegacyCodexHook: vi.fn(async () => ({ ok: false, reason: 'legacy-model-unverified' })),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({
    tick: vi.fn(async () => {}),
    removeTab: vi.fn(),
    statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })),
    reconcileJobs: vi.fn(async () => ({ reported: 0, pendingDead: 0 })),
  }),
}));
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
  isClaudeRunning: vi.fn(async () => true),
  detectActiveSession: vi.fn(async () => ({ status: 'not-running', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null })),
  watchSessionsDir: vi.fn(() => ({ stop: () => {} })),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));
vi.mock('@/lib/claude-usage-poller', () => ({ createClaudeUsagePoller: () => ({ start: () => {}, stop: () => {} }) }));
vi.mock('@/lib/rate-limits-watcher', () => ({ createRateLimitsWatcher: () => ({ start: () => {}, stop: () => {} }) }));

const g = globalThis as unknown as { __ptStatusManager?: StatusManager };

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const spoolDir = () => path.join(state.home, '.purplemux', 'hook-spool');

let serial = 0;
/** One file as `spool_hook` writes it: `<at>-<pid>-<rand>.json`. */
const spoolEvent = async (at: number, body: unknown, query = '', session = 'tmux-w'): Promise<string> => {
  await fs.mkdir(spoolDir(), { recursive: true });
  serial += 1;
  const name = `${at}-${1000 + serial}-${serial.toString(16).padStart(8, '0')}.json`;
  await fs.writeFile(path.join(spoolDir(), name), `${JSON.stringify({ v: 1, at, session, query, body })}\n`);
  return name;
};

const claudeStop = (session = 'tmux-w') => ({ event: 'stop', session });
const claudePrompt = (session = 'tmux-w') => ({ event: 'prompt-submit', session });

const managerWithPaste = async (afterReplay?: () => Promise<void>) => {
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}));
  // The route's dispatcher reaches the manager through the singleton.
  g.__ptStatusManager = manager;
  const { dispatchHook } = await import('@/lib/hook-dispatch');
  const { drainHookSpool } = await import('@/lib/hook-spool');
  const applied: IHookDelivery[] = [];
  manager.setHookSpoolDrain(() => drainHookSpool(async (delivery) => {
    applied.push(delivery);
    const result = await dispatchHook(delivery);
    await afterReplay?.();
    return result;
  }, { dir: spoolDir() }));
  return { manager, paste, applied };
};

const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-hook-spool-drain-'));
  state.tabs = [];
  logs.lines = [];
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await g.__ptStatusManager?.shutdown();
  delete g.__ptStatusManager;
  await fs.rm(state.home, { recursive: true, force: true });
});

const internalsOf = (manager: StatusManager) => manager as unknown as { tabs: Map<string, ITabStatusEntry> };

const writeDoneTranscript = async (): Promise<string> => {
  const transcript = path.join(state.home, 'claude', 's.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, `${JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-27T15:00:00.000Z',
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Story shipped.\n\nDONE: story 41 merged' }] },
  })}\n`);
  return transcript;
};

describe('the status manager replays the hook spool (ADR-0020)', () => {
  it('init does not drain; the boot drains after listen replay in time order, each event at its own time, and a late drain catches a late file', async () => {
    state.tabs = [tab('w')];
    const { manager, applied } = await managerWithPaste();
    const t0 = Date.now() - 60_000;
    // Written stop first: the drain orders by the event time, not by the order files appeared.
    await spoolEvent(t0 + 2_000, claudeStop());
    await spoolEvent(t0 + 1_000, claudePrompt());
    const startPolling = vi.spyOn(manager, 'startPolling');

    await manager.init();
    expect(startPolling).toHaveBeenCalledTimes(1);
    expect(applied).toEqual([]);
    expect(await fs.readdir(spoolDir())).toHaveLength(2);

    manager.startBootHookSpoolDrains(100);
    await waitFor(() => expect(applied).toHaveLength(2));
    expect(applied.map((d) => [(d.body as { event: string }).event, d.replayedAt])).toEqual([
      ['prompt-submit', t0 + 1_000],
      ['stop', t0 + 2_000],
    ]);
    const entry = internalsOf(manager).tabs.get('w')!;
    expect(entry.lastEvent).toMatchObject({ name: 'stop', at: t0 + 2_000 });
    await waitFor(() => expect(entry.turnEnd).toMatchObject({ kind: 'ready-for-review', at: t0 + 2_000 }));
    expect(manager.getHookHistory('w')).toEqual([
      { event: 'prompt-submit', at: t0 + 1_000, replayed: true, stale: false },
      { event: 'stop', at: t0 + 2_000, replayed: true, stale: false },
    ]);

    // A hook that saw no port file renames its file after the first drain listed the spool.
    await spoolEvent(t0 + 3_000, claudePrompt());
    await waitFor(() => expect(applied).toHaveLength(3));
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('bootHookSpoolDrained settles only once the first boot drain has applied the spool (the inbox waits for it)', async () => {
    state.tabs = [tab('w')];
    const { manager, applied } = await managerWithPaste();
    await spoolEvent(Date.now() - 5_000, claudePrompt());
    await manager.init();
    let settled = false;
    void manager.bootHookSpoolDrained().then(() => { settled = true; });
    await settle();
    expect(settled).toBe(false);

    manager.startBootHookSpoolDrains(60_000);
    await manager.bootHookSpoolDrained();
    expect(applied).toHaveLength(1);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('a boot drain that meets a rescan waits for it and drains; the inbox ticks only after the files are applied', async () => {
    state.tabs = [tab('w')];
    const { manager, applied } = await managerWithPaste();
    await manager.init();
    await spoolEvent(Date.now() - 5_000, claudePrompt());
    const workspaceStore = await import('@/lib/workspace-store');
    let releaseRescan!: () => void;
    const rescanHeld = new Promise<void>((resolve) => { releaseRescan = resolve; });
    vi.mocked(workspaceStore.getWorkspaces).mockImplementationOnce(async () => {
      await rescanHeld;
      return { workspaces: [WS] } as never;
    });
    const rescanning = manager.rescan();
    await settle();

    // The server's wiring: the inbox starts gated on the first boot drain, which starts after listen.
    const inbox = await import('@/lib/inbox-dispatcher');
    await inbox.startInbox({ firstTickAfter: manager.bootHookSpoolDrained() });
    const runtime = (globalThis as unknown as { __ptInboxRuntime: { dispatcher: { tick: () => Promise<void> } } }).__ptInboxRuntime;
    const appliedAtTick: number[] = [];
    vi.spyOn(runtime.dispatcher, 'tick').mockImplementation(async () => { appliedAtTick.push(applied.length); });
    try {
      manager.startBootHookSpoolDrains(60_000);
      await new Promise((resolve) => setTimeout(resolve, inbox.INBOX_TICK_MS + 500));
      expect(applied).toEqual([]);
      expect(appliedAtTick).toEqual([]);

      releaseRescan();
      await rescanning;
      await manager.bootHookSpoolDrained();
      expect(applied).toHaveLength(1);
      await waitFor(() => expect(appliedAtTick.length).toBeGreaterThan(0));
      expect(appliedAtTick[0]).toBe(1);
      expect(internalsOf(manager).tabs.get('w')!.lastEvent).toMatchObject({ name: 'prompt-submit' });
    } finally {
      await inbox.stopInbox();
    }
  }, 15_000);

  it('a drain before init, or while init\'s scan builds the tabs, is a no-op: the files wait for a later drain', async () => {
    state.tabs = [tab('w')];
    const { manager, applied } = await managerWithPaste();
    const name = await spoolEvent(Date.now() - 5_000, claudePrompt());
    await manager.drainHookSpool();
    await manager.poll();
    expect(applied).toEqual([]);

    // Hold init's scan inside getWorkspaces, after init has started it.
    const workspaceStore = await import('@/lib/workspace-store');
    let releaseScan!: () => void;
    const scanHeld = new Promise<void>((resolve) => { releaseScan = resolve; });
    vi.mocked(workspaceStore.getWorkspaces).mockImplementationOnce(async () => {
      await scanHeld;
      return { workspaces: [WS] } as never;
    });
    const initializing = manager.init();
    await settle();
    await manager.drainHookSpool();
    expect(applied).toEqual([]);
    expect(await fs.readdir(spoolDir())).toEqual([name]);

    releaseScan();
    await initializing;
    await manager.drainHookSpool();
    expect(applied).toHaveLength(1);
    expect(internalsOf(manager).tabs.get('w')!.lastEvent).toMatchObject({ name: 'prompt-submit' });
    expect(await fs.readdir(spoolDir())).toEqual([]);

    // A rescan rebuilds the tabs the same way: no drain while it runs.
    let releaseRescan!: () => void;
    const rescanHeld = new Promise<void>((resolve) => { releaseRescan = resolve; });
    vi.mocked(workspaceStore.getWorkspaces).mockImplementationOnce(async () => {
      await rescanHeld;
      return { workspaces: [WS] } as never;
    });
    const rescanning = manager.rescan();
    await settle();
    await spoolEvent(Date.now() - 1_000, claudeStop());
    await manager.drainHookSpool();
    expect(applied).toHaveLength(1);
    releaseRescan();
    await rescanning;
    await manager.drainHookSpool();
    expect(applied).toHaveLength(2);
  });

  it('drains on each available poll and retains files added during an active drain', async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstApplied!: () => void;
    const firstEntered = new Promise<void>((resolve) => { firstApplied = resolve; });
    let holdFirst = true;
    const { manager, applied } = await managerWithPaste(async () => {
      if (!holdFirst) return;
      holdFirst = false;
      firstApplied();
      await firstHeld;
    });
    try {
      await manager.init();
      manager.registerTab('w', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code' });
      state.tabs = [tab('w')];
      await spoolEvent(Date.now() - 5_000, claudePrompt());
      await manager.poll();
      await firstEntered;
      const nextFile = await spoolEvent(Date.now() - 1_000, claudeStop());
      await manager.poll();
      expect(applied).toHaveLength(1);
      expect(await fs.readdir(spoolDir())).toContain(nextFile);
      // Replay entry precedes drain completion. An overlapping poll shares that drain.
      releaseFirst();
      await manager.drainHookSpool();
      expect(applied).toHaveLength(1);
      await manager.poll();
      await manager.drainHookSpool();
      expect(applied).toHaveLength(2);
      expect(await fs.readdir(spoolDir())).not.toContain(nextFile);
    } finally {
      releaseFirst();
      await manager.drainHookSpool();
    }
  });

  it('a poll never waits for a drain: with a drain that hangs the poll completes, and a later poll starts no second drain', async () => {
    const { manager } = await managerWithPaste();
    await manager.init();
    manager.registerTab('w', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code' });
    state.tabs = [tab('w')];
    // 28 Sep: a drain stuck on its replays held every poll for 7 minutes.
    let releaseDrain!: () => void;
    const drain = vi.fn(() => new Promise<IHookSpoolDrainResult>((resolve) => {
      releaseDrain = () => resolve({ applied: 0, bad: 0, timedOut: 0, dropped: 0, metadataOnly: 0, prunedBad: 0, prunedTmp: 0 });
    }));
    manager.setHookSpoolDrain(drain);
    const readLayout = vi.mocked((await import('@/lib/layout-store')).readLayoutFile);
    const layoutReadsBefore = readLayout.mock.calls.length;

    const first = await Promise.race([
      manager.poll().then(() => 'polled'),
      new Promise((resolve) => setTimeout(() => resolve('held by the drain'), 2_000)),
    ]);
    expect(first).toBe('polled');
    // The poll went on to read the layouts, the step the liveness reconcile and the nudges follow.
    expect(readLayout.mock.calls.length).toBeGreaterThan(layoutReadsBefore);
    await manager.poll();
    expect(drain).toHaveBeenCalledTimes(1);

    releaseDrain();
    await manager.drainHookSpool();
    await manager.poll();
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('a spooled legacy Codex hook and a replay racing a relaunch apply nothing: each is history only, counted stale, and its file is deleted', async () => {
    const { manager } = await managerWithPaste();
    await manager.init();
    const entry: ITabStatusEntry = {
      cliState: 'idle', workspaceId: 'ws-1', tabName: 'c', tmuxSession: 'tmux-c', panelType: 'codex-cli',
      agentProviderId: 'codex', agentSessionId: 'sess-c', jsonlPath: '/tmp/c.jsonl', lastEvent: null, eventSeq: 0,
    };
    manager.registerTab('c', entry);
    // A relaunch began: the status manager tracks generation g2 as pending.
    manager.markCodexLaunchPending('c', 'g2');
    expect(manager.codexLaunchLifecycle('c')).toEqual({ generation: 'g2', phase: 'pending' });
    const lifecycle = await import('@/lib/providers/codex/launch-lifecycle');
    vi.mocked(lifecycle.withReplayedCodexHookGeneration).mockImplementationOnce(async (_session, generation, _work, tracked) => {
      const launch = tracked('c');
      return launch && (launch.phase !== 'active' || launch.generation !== generation)
        ? { ok: false, reason: 'launch-changed' }
        : { ok: true, value: _work({ workspaceId: 'ws-1', tabId: 'c', generation: generation! }) };
    });
    const now = Date.now();
    const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 'sess-c', prompt: 'go' };
    await spoolEvent(now - 2_000, prompt, 'provider=codex&tmuxSession=tmux-c&generation=g1', 'tmux-c');
    await spoolEvent(now - 1_000, prompt, 'provider=codex&tmuxSession=tmux-c', 'tmux-c');

    await manager.drainHookSpool();

    expect(entry.cliState).toBe('idle');
    expect(entry.lastEvent).toBeNull();
    expect(lifecycle.withValidatedLegacyCodexHook).not.toHaveBeenCalled();
    expect(manager.getHookHistory('c')).toEqual([
      { event: 'UserPromptSubmit', at: now - 2_000, replayed: true, stale: true },
      { event: 'UserPromptSubmit', at: now - 1_000, replayed: true, stale: true },
    ]);
    expect(logs.lines.filter((line) => line.msg.startsWith('replayed hook event skipped (launch-changed)'))).toHaveLength(1);
    expect(logs.lines.filter((line) => line.msg.startsWith('replayed hook event skipped (legacy-unattributable)'))).toHaveLength(1);
    expect(logs.lines.find((line) => line.msg.startsWith('hook spool drain:')))
      .toMatchObject({ fields: { applied: 2, stale: 2, timedOut: 0, bad: 0 } });
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('logs one line per drain that found files: applied, stale, timed out, bad, and the duration', async () => {
    const { manager } = await managerWithPaste();
    await manager.init();
    manager.registerTab('w', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code' });
    state.tabs = [tab('w')];
    // A live event sets the floor; a replayed event older than it is stale.
    manager.updateTabFromHook('tmux-w', 'prompt-submit');
    const now = Date.now();
    await spoolEvent(now - 60_000, claudeStop());
    await spoolEvent(now + 1_000, claudeStop());
    await manager.drainHookSpool();
    const summary = logs.lines.filter((line) => line.msg.startsWith('hook spool drain:'));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ level: 'info', fields: { applied: 2, stale: 1, timedOut: 0, bad: 0 } });
    expect((summary[0].fields as { durationMs: number }).durationMs).toBeGreaterThanOrEqual(0);

    // An empty spool logs nothing.
    await manager.drainHookSpool();
    expect(logs.lines.filter((line) => line.msg.startsWith('hook spool drain:'))).toHaveLength(1);
  });

  it('an event older than the tab\'s floor updates history only, never the newer state', async () => {
    const { manager } = await managerWithPaste();
    await manager.init();
    const entry: ITabStatusEntry = {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code',
      agentProviderId: 'claude', jsonlPath: null, lastEvent: { name: 'prompt-submit', at: Date.now() - 60_000, seq: 1 }, eventSeq: 1,
    };
    manager.registerTab('w', entry);
    manager.updateTabFromHook('tmux-w', 'stop');
    await waitFor(() => expect(entry.cliState).toBe('ready-for-review'));
    const liveStop = entry.lastEvent!;
    const olderPrompt = liveStop.at - 10_000;
    await spoolEvent(olderPrompt, claudePrompt());

    await manager.drainHookSpool();

    expect(entry.cliState).toBe('ready-for-review');
    expect(entry.lastEvent).toEqual(liveStop);
    expect(manager.getHookHistory('w')).toEqual([
      { event: 'prompt-submit', at: olderPrompt, replayed: true, stale: true },
      { event: 'stop', at: liveStop.at, replayed: false, stale: false },
    ]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('a floor saved in hook-spool/.floors.json by a previous server orders replays after a restart: an older DONE stop is history only, a newer one nudges once', async () => {
    const floor = Date.now() - 60_000;
    await fs.mkdir(spoolDir(), { recursive: true });
    await fs.writeFile(path.join(spoolDir(), '.floors.json'), JSON.stringify({ w: floor, gone: floor }));
    // A layout written by the round-1 build still carries `hookFloorAt`: it is read without error and ignored.
    state.tabs = [tab('root'), { ...tab('w'), hookFloorAt: floor + 60_000 } as ITab];
    const { manager, paste, applied } = await managerWithPaste();
    await manager.init();
    const entry = internalsOf(manager).tabs.get('w')!;
    // The tab is mid-turn on a transcript whose last message carries an end line.
    entry.cliState = 'busy';
    entry.agentProviderId = 'claude';
    entry.jsonlPath = await writeDoneTranscript();

    await spoolEvent(floor - 5_000, claudeStop());
    await manager.drainHookSpool();
    await settle();
    expect(applied).toHaveLength(1);
    expect(paste).not.toHaveBeenCalled();
    expect(entry.cliState).toBe('busy');
    expect(manager.getHookHistory('w')).toEqual([{ event: 'stop', at: floor - 5_000, replayed: true, stale: true }]);

    // Control: the same transcript does nudge for a stop newer than the file's floor (older than
    // the layout's stray value), and only once.
    await spoolEvent(floor + 5_000, claudeStop());
    await spoolEvent(floor + 5_000, claudeStop());
    await manager.drainHookSpool();
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    await settle();
    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith('tmux-root', expect.stringContaining('DONE: story 41 merged'));

    // The shutdown saves the raised floor; the floor of a tab that is gone is not kept.
    await manager.shutdown();
    expect(JSON.parse(await fs.readFile(path.join(spoolDir(), '.floors.json'), 'utf-8'))).toEqual({ w: floor + 5_000 });
  });

  it('only state events raise the floor; the shutdown saves it to the floors file, never the layout', async () => {
    const { manager } = await managerWithPaste();
    await manager.init();
    manager.registerTab('w', {
      cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code',
      agentProviderId: 'claude', lastEvent: null, eventSeq: 0,
    });
    manager.updateTabFromHook('tmux-w', 'prompt-submit');
    const promptAt = manager.getHookHistory('w')[0].at;
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A live metadata patch does not raise the floor: a replayed patch after the prompt still applies.
    manager.applyAgentHookMeta('claude', 'tmux-w', { lastUserMessage: 'newer' });
    expect(manager.applyAgentHookMeta('claude', 'tmux-w', { lastUserMessage: 'replayed' }, promptAt + 1)).toEqual({ tabId: 'w', cliState: 'busy' });
    expect(internalsOf(manager).tabs.get('w')!.lastUserMessage).toBe('replayed');
    // One older than the floor does not.
    expect(manager.applyAgentHookMeta('claude', 'tmux-w', { lastUserMessage: 'older' }, promptAt - 1)).toMatchObject({ stale: true });
    const floorsFile = path.join(spoolDir(), '.floors.json');
    await expect(fs.access(floorsFile)).rejects.toThrow();

    await manager.shutdown();
    expect(JSON.parse(await fs.readFile(floorsFile, 'utf-8'))).toEqual({ w: promptAt });
    expect(sync.broadcastSync.mock.calls.filter(([message]) => message.type === 'layout')).toEqual([]);
  });

  it('a burst of 200 Codex tool hooks sends no layout sync message and writes the floors file at most once per 5 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { manager } = await managerWithPaste();
    await manager.init();
    manager.registerTab('c', {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'c', tmuxSession: 'tmux-c', panelType: 'codex-cli',
      agentProviderId: 'codex', agentSessionId: 'sess-c', jsonlPath: '/tmp/c.jsonl', lastEvent: null, eventSeq: 0,
    });
    const { dispatchHook } = await import('@/lib/hook-dispatch');
    const floorsFile = path.join(spoolDir(), '.floors.json');
    const rename = vi.spyOn(fs, 'rename');
    const floorWrites = () => rename.mock.calls.filter(([, to]) => to === floorsFile).length;
    const burst = async () => {
      for (let i = 0; i < 200; i += 1) {
        await dispatchHook({
          query: { provider: 'codex', tmuxSession: 'tmux-c', generation: 'g1' },
          body: { hook_event_name: i % 2 ? 'PostToolUse' : 'PreToolUse', session_id: 'sess-c', transcript_path: '/tmp/c.jsonl', tool_name: 'shell' },
        });
        await vi.advanceTimersByTimeAsync(10);
      }
    };
    // The write itself is real I/O: yield to the event loop until it has started (bounded).
    const flushed = async (expected: number) => {
      for (let i = 0; i < 5_000 && floorWrites() < expected; i += 1) await new Promise((resolve) => setImmediate(resolve));
    };
    sync.broadcastSync.mockClear();
    for (const writer of Object.values(layoutWrites)) writer.mockClear();

    await burst(); // 0 s to 2 s
    await flushed(1);
    expect(floorWrites()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000); // 5 s
    await flushed(1);
    expect(floorWrites()).toBe(1);
    await burst(); // 5 s to 7 s
    await vi.advanceTimersByTimeAsync(2_900); // 9.9 s
    await flushed(2);
    expect(floorWrites()).toBe(1);
    await vi.advanceTimersByTimeAsync(200); // 10.1 s
    await flushed(2);
    expect(floorWrites()).toBe(2);
    await manager.shutdown(); // the last write has landed

    const entry = internalsOf(manager).tabs.get('c')!;
    expect(entry.cliState).toBe('busy');
    expect(entry.lastEvent).toMatchObject({ name: 'prompt-submit' });
    expect(JSON.parse(await fs.readFile(floorsFile, 'utf-8'))).toEqual({ c: entry.lastEvent!.at });
    expect(sync.broadcastSync.mock.calls.filter(([message]) => message.type === 'layout')).toEqual([]);
    for (const writer of Object.values(layoutWrites)) expect(writer).not.toHaveBeenCalled();
  });

  it('a stale replayed hook meta patch changes nothing and says stale', async () => {
    const { manager } = await managerWithPaste();
    await manager.init();
    manager.registerTab('w', {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code',
      agentProviderId: 'claude', lastUserMessage: 'newer', lastEvent: null, eventSeq: 0,
    });
    manager.updateTabFromHook('tmux-w', 'prompt-submit');
    const latest = manager.getHookHistory('w')[0].at;
    expect(manager.applyAgentHookMeta('claude', 'tmux-w', { lastUserMessage: 'older' }, latest - 1))
      .toEqual({ tabId: 'w', cliState: 'busy', stale: true });
    expect(internalsOf(manager).tabs.get('w')!.lastUserMessage).toBe('newer');
  });

  it('a replayed stop is classified as it would have been, and nudges once, however often the spool is drained', async () => {
    const { manager, paste } = await managerWithPaste();
    await manager.init();
    manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
    const entry: ITabStatusEntry = {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'w1', tmuxSession: 'tmux-w', panelType: 'claude-code',
      agentProviderId: 'claude', jsonlPath: await writeDoneTranscript(), lastEvent: { name: 'prompt-submit', at: Date.now() - 120_000, seq: 1 }, eventSeq: 1,
    };
    manager.registerTab('w', entry);
    const stopAt = Date.now() - 30_000;
    await spoolEvent(stopAt, claudeStop());

    await Promise.all([manager.drainHookSpool(), manager.drainHookSpool()]);
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    await manager.drainHookSpool();
    await settle();

    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith('tmux-root', expect.stringContaining('DONE: story 41 merged'));
    expect(entry.turnEnd).toMatchObject({ kind: 'turn-marker', at: stopAt, marker: ['DONE: story 41 merged'] });
  });

  it('replays a spooled Claude tool event into the signal engine', async () => {
    const { manager } = await managerWithPaste();
    await manager.init();
    manager.registerTab('w', { cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code' });
    const tool = vi.spyOn(manager, 'handleToolActivity');
    await spoolEvent(Date.now() - 1_000, { tool_name: 'Edit', tool_input: { file_path: '/tmp/a.ts' } }, 'kind=tool&session=tmux-w');
    await manager.drainHookSpool();
    expect(tool).toHaveBeenCalledWith('claude', 'tmux-w', expect.objectContaining({ tool: 'Edit' }), expect.any(Number));
  });

  it('a file past the replay window is dropped without dispatch; a direct replay that old changes no state and feeds no signal', async () => {
    const { manager, applied } = await managerWithPaste();
    await manager.init();
    const { HOOK_REPLAY_WINDOW_MS } = await import('@/lib/hook-spool');
    const entry: ITabStatusEntry = { cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code', lastEvent: null, eventSeq: 0 };
    manager.registerTab('w', entry);
    const old = Date.now() - HOOK_REPLAY_WINDOW_MS - 60_000;
    await spoolEvent(old, claudePrompt());

    await manager.drainHookSpool();
    expect(applied).toEqual([]);
    expect(await fs.readdir(spoolDir())).toEqual([]);

    const { getSignalEngine } = await import('@/lib/signal-engine');
    const record = vi.spyOn(getSignalEngine(), 'record');
    manager.handleProviderEvent('claude', 'tmux-w', { kind: 'prompt-submit' }, old);
    manager.handleToolActivity('claude', 'tmux-w', { tool: 'Edit', paths: ['/tmp/a.ts'], failed: false } as never, old);
    expect(entry.cliState).toBe('idle');
    expect(entry.lastEvent).toBeNull();
    expect(manager.getHookHistory('w')).toEqual([{ event: 'prompt-submit', at: old, replayed: true, stale: true }]);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('HookFloorStore (ADR-0020)', () => {
  const store = async (saveMs = 60_000) => {
    const { HookFloorStore } = await import('@/lib/hook-floors');
    return new HookFloorStore({ dir: spoolDir(), saveMs });
  };
  const floorsFile = () => path.join(spoolDir(), '.floors.json');

  it('only raises; flush writes one file by rename and leaves no temporary; load reads it back', async () => {
    const floors = await store();
    floors.raise('a', 200);
    floors.raise('a', 100);
    floors.raise('b', 50);
    expect(floors.get('a')).toBe(200);
    await floors.flush();
    expect(JSON.parse(await fs.readFile(floorsFile(), 'utf-8'))).toEqual({ a: 200, b: 50 });
    expect(await fs.readdir(spoolDir())).toEqual(['.floors.json']);
    expect((await fs.stat(spoolDir())).mode & 0o777).toBe(0o700);

    const reloaded = await store();
    await reloaded.load();
    expect([reloaded.get('a'), reloaded.get('b'), reloaded.get('c')]).toEqual([200, 50, undefined]);
  });

  it('a flush with nothing changed writes nothing; forget and retain drop floors and write on the next flush', async () => {
    const floors = await store();
    floors.raise('a', 1);
    floors.raise('b', 2);
    floors.raise('c', 3);
    await floors.flush();
    const rename = vi.spyOn(fs, 'rename');
    await floors.flush();
    expect(rename).not.toHaveBeenCalled();
    floors.forget('a');
    floors.retain(new Set(['b']));
    await floors.flush();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(floorsFile(), 'utf-8'))).toEqual({ b: 2 });
  });

  it('an absent or corrupt file is no floors, never an error; entries that are not finite numbers are skipped', async () => {
    const absent = await store();
    await absent.load();
    expect(absent.get('a')).toBeUndefined();

    await fs.mkdir(spoolDir(), { recursive: true });
    await fs.writeFile(floorsFile(), '{ not json');
    const corrupt = await store();
    await corrupt.load();
    expect(corrupt.get('a')).toBeUndefined();

    await fs.writeFile(floorsFile(), JSON.stringify({ a: 5, b: 'x', c: null }));
    const mixed = await store();
    await mixed.load();
    expect([mixed.get('a'), mixed.get('b'), mixed.get('c')]).toEqual([5, undefined, undefined]);
  });
});

describe('drainHookSpool (ADR-0020)', () => {
  const drain = async (
    apply: (d: IHookDelivery) => Promise<unknown>,
    options: { now?: number; maxFiles?: number; maxAgeMs?: number; eventTimeoutMs?: number } = {},
  ) => {
    const { drainHookSpool } = await import('@/lib/hook-spool');
    return drainHookSpool(apply, { dir: spoolDir(), ...options });
  };
  const collect = () => {
    const seen: IHookDelivery[] = [];
    return { seen, apply: async (d: IHookDelivery) => { seen.push(d); } };
  };
  const age = async (file: string, ms: number) => {
    const when = new Date(Date.now() - ms);
    await fs.utimes(file, when, when);
  };
  const MIN = 60_000;

  it('parses the query, passes the body as written, and deletes each applied file', async () => {
    const { seen, apply } = collect();
    const now = Date.now();
    await spoolEvent(now - 1_000, { hook_event_name: 'Stop' }, 'provider=codex&tmuxSession=pt-a&generation=g1');
    expect(await drain(apply, { now })).toMatchObject({ applied: 1, bad: 0, dropped: 0 });
    expect(seen).toEqual([{ query: { provider: 'codex', tmuxSession: 'pt-a', generation: 'g1' }, body: { hook_event_name: 'Stop' }, replayedAt: now - 1_000 }]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('moves a file that fails to parse to bad/, and still applies the rest', async () => {
    const { seen, apply } = collect();
    const now = Date.now();
    await fs.mkdir(spoolDir(), { recursive: true });
    await fs.writeFile(path.join(spoolDir(), `${now - 1_500}-1-aa.json`), '{"v":1,"at":1500,"session":"pt-a","query":"","body":{"event":"st');
    await fs.writeFile(path.join(spoolDir(), 'stray.txt'), 'not a spool file');
    await spoolEvent(now - 2_000, claudePrompt());
    await spoolEvent(now - 1_000, claudeStop());
    expect(await drain(apply, { now })).toMatchObject({ applied: 2, bad: 2, dropped: 0 });
    expect(seen.map((d) => d.replayedAt)).toEqual([now - 2_000, now - 1_000]);
    expect((await fs.readdir(path.join(spoolDir(), 'bad'))).sort()).toEqual([`${now - 1_500}-1-aa.json`, 'stray.txt']);
    expect((await fs.readdir(spoolDir())).filter((n) => n !== 'bad')).toEqual([]);
  });

  it('bounds each replay: N replays that never settle finish within N x the bound, each moves to bad/ once, and the rest still apply', async () => {
    const now = Date.now();
    const hung = [
      await spoolEvent(now - 4_000, claudePrompt()),
      await spoolEvent(now - 3_000, claudeStop()),
      await spoolEvent(now - 2_000, claudePrompt()),
    ];
    await spoolEvent(now - 1_000, claudeStop());
    const seen: number[] = [];
    // A dispatch that never settles, as a replay queued behind a busy tab's lock.
    const apply = vi.fn((d: IHookDelivery) => {
      seen.push(d.replayedAt!);
      return d.replayedAt === now - 1_000 ? Promise.resolve() : new Promise<never>(() => {});
    });
    const bound = 100;
    const started = Date.now();
    const result = await drain(apply, { now, eventTimeoutMs: bound });
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ applied: 1, timedOut: 3, bad: 3 });
    expect(elapsed).toBeGreaterThanOrEqual(hung.length * bound - 5);
    expect(elapsed).toBeLessThan(hung.length * bound + 1_000);
    expect(seen).toEqual([now - 4_000, now - 3_000, now - 2_000, now - 1_000]);
    expect((await fs.readdir(path.join(spoolDir(), 'bad'))).sort()).toEqual([...hung].sort());
    expect(await fs.readdir(spoolDir())).toEqual(['bad']);
    expect(logs.lines.filter((line) => line.msg.includes('did not finish within 100 ms'))).toHaveLength(3);

    // Never retried.
    expect(await drain(apply, { now, eventTimeoutMs: bound })).toMatchObject({ applied: 0, timedOut: 0, bad: 0 });
    expect(apply).toHaveBeenCalledTimes(4);
  });

  it('an abandoned replay that settles later logs how and when, with its file name', async () => {
    const now = Date.now();
    const late = await spoolEvent(now - 2_000, claudePrompt());
    const failing = await spoolEvent(now - 1_000, claudeStop());
    const apply = vi.fn((d: IHookDelivery) => new Promise<void>((resolve, reject) => {
      setTimeout(() => (d.replayedAt === now - 2_000 ? resolve() : reject(new Error('late 5xx'))), 150);
    }));
    expect(await drain(apply, { now, eventTimeoutMs: 30 })).toMatchObject({ applied: 0, timedOut: 2, bad: 2 });
    await waitFor(() => {
      const applied = logs.lines.find((line) => line.msg.startsWith(`abandoned replay of ${late} applied at +`));
      expect(applied).toMatchObject({ level: 'warn', fields: { file: late } });
      expect((applied!.fields as { afterMs: number }).afterMs).toBeGreaterThanOrEqual(140);
      expect(logs.lines.find((line) => line.msg.startsWith(`abandoned replay of ${failing} failed at +`)))
        .toMatchObject({ level: 'warn', fields: { file: failing } });
    });
  });

  it('a replay that settles within the bound is applied, and the default bound is 5 s', async () => {
    const { HOOK_REPLAY_EVENT_TIMEOUT_MS } = await import('@/lib/hook-spool');
    expect(HOOK_REPLAY_EVENT_TIMEOUT_MS).toBe(5_000);
    const now = Date.now();
    await spoolEvent(now - 1_000, claudeStop());
    const apply = vi.fn(() => new Promise<void>((resolve) => { setTimeout(resolve, 20); }));
    expect(await drain(apply, { now, eventTimeoutMs: 1_000 })).toMatchObject({ applied: 1, timedOut: 0, bad: 0 });
  });

  it('moves a file whose replay throws (a 5xx event) to bad/ once, and never retries it', async () => {
    const now = Date.now();
    await spoolEvent(now - 1_000, claudeStop());
    const apply = vi.fn(async () => { throw new Error('boom'); });
    expect(await drain(apply, { now })).toMatchObject({ applied: 0, bad: 1 });
    expect(await drain(apply, { now })).toMatchObject({ applied: 0, bad: 0 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(path.join(spoolDir(), 'bad'))).toHaveLength(1);
  });

  it('drops a file past the replay window without dispatching it', async () => {
    const { HOOK_REPLAY_WINDOW_MS } = await import('@/lib/hook-spool');
    const { seen, apply } = collect();
    const now = Date.now();
    await spoolEvent(now - HOOK_REPLAY_WINDOW_MS - 1, claudeStop());
    await spoolEvent(now - HOOK_REPLAY_WINDOW_MS + 1_000, claudePrompt());
    expect(await drain(apply, { now })).toMatchObject({ applied: 1, dropped: 1 });
    expect(seen.map((d) => d.replayedAt)).toEqual([now - HOOK_REPLAY_WINDOW_MS + 1_000]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('bounds the spool: drops the oldest beyond the file limit, unreplayed', async () => {
    const { seen, apply } = collect();
    for (const at of [100, 5_000, 6_000, 7_000, 8_000, 9_000]) await spoolEvent(at, claudeStop());
    expect(await drain(apply, { now: 10_000, maxAgeMs: 6_000, maxFiles: 3 })).toMatchObject({ applied: 3, dropped: 3 });
    expect(seen.map((d) => d.replayedAt)).toEqual([7_000, 8_000, 9_000]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('a file whose body the hook dropped for size is deleted and never dispatched', async () => {
    const { seen, apply } = collect();
    const now = Date.now();
    await fs.mkdir(spoolDir(), { recursive: true });
    await fs.writeFile(path.join(spoolDir(), `${now - 1_000}-1-bb.json`),
      JSON.stringify({ v: 1, at: now - 1_000, session: 'pt-a', query: 'kind=tool&session=pt-a', bodyDropped: true, bodyLength: 300_000, body: null }));
    expect(await drain(apply, { now })).toMatchObject({ applied: 0, metadataOnly: 1, bad: 0 });
    expect(seen).toEqual([]);
    expect(await fs.readdir(spoolDir())).toEqual([]);
  });

  it('prunes bad/ entries older than 7 days and orphaned temporaries older than 10 minutes; keeps younger ones', async () => {
    const { apply } = collect();
    const bad = path.join(spoolDir(), 'bad');
    await fs.mkdir(path.join(bad, 'rollback-20260901T000000Z'), { recursive: true });
    await fs.writeFile(path.join(bad, 'rollback-20260901T000000Z', '1-1-aa.json'), '{}');
    await fs.writeFile(path.join(bad, 'old.json'), '{}');
    await fs.writeFile(path.join(bad, 'young.json'), '{}');
    await fs.writeFile(path.join(spoolDir(), '.1-1-old.json.tmp'), '{"v":1,');
    await fs.writeFile(path.join(spoolDir(), '.2-1-young.json.tmp'), '{"v":1,');
    await age(path.join(bad, 'rollback-20260901T000000Z'), 8 * 24 * 60 * MIN);
    await age(path.join(bad, 'old.json'), 8 * 24 * 60 * MIN);
    await age(path.join(spoolDir(), '.1-1-old.json.tmp'), 11 * MIN);

    expect(await drain(apply)).toMatchObject({ prunedBad: 2, prunedTmp: 1 });
    expect(await fs.readdir(bad)).toEqual(['young.json']);
    expect((await fs.readdir(spoolDir())).sort()).toEqual(['.2-1-young.json.tmp', 'bad']);
  });

  it('never prunes, quarantines or replays the server\'s own .floors.json, however old', async () => {
    const { seen, apply } = collect();
    await fs.mkdir(spoolDir(), { recursive: true });
    const floors = path.join(spoolDir(), '.floors.json');
    await fs.writeFile(floors, '{"w":1}\n');
    await age(floors, 30 * 24 * 60 * MIN);
    expect(await drain(apply)).toEqual({ applied: 0, bad: 0, timedOut: 0, dropped: 0, metadataOnly: 0, prunedBad: 0, prunedTmp: 0 });
    expect(seen).toEqual([]);
    expect(await fs.readdir(spoolDir())).toEqual(['.floors.json']);
  });

  it('dates no event after now', async () => {
    const { seen, apply } = collect();
    const now = Date.now();
    await spoolEvent(now + 9_000, claudeStop());
    await drain(apply, { now });
    expect(seen.map((d) => d.replayedAt)).toEqual([now]);
  });

  it('the health route answers while a large spool drains', async () => {
    const now = Date.now();
    await fs.mkdir(spoolDir(), { recursive: true });
    await Promise.all(Array.from({ length: 400 }, (_, i) => fs.writeFile(
      path.join(spoolDir(), `${now - 10_000 + i}-1-${i.toString(16).padStart(8, '0')}.json`),
      JSON.stringify({ v: 1, at: now - 10_000 + i, session: 'pt-a', query: '', body: claudePrompt() }),
    )));
    // Loaded first: on a busy host the module load alone outlasted the drain (2026-10-16, load 17).
    const { default: health } = await import('@/pages/api/health');
    let applied = 0;
    let done = false;
    const draining = drain(async () => { applied += 1; }, { now }).then(() => { done = true; });
    await new Promise((resolve) => setImmediate(resolve));

    const answer = await new Promise((resolve) => {
      health({} as never, { json: resolve } as never);
    });
    expect(answer).toMatchObject({ app: 'purplemux' });
    expect(done).toBe(false);
    await draining;
    expect(applied).toBe(400);
  });

  it('an absent spool directory is an empty spool', async () => {
    const { seen, apply } = collect();
    expect(await drain(apply)).toEqual({ applied: 0, bad: 0, timedOut: 0, dropped: 0, metadataOnly: 0, prunedBad: 0, prunedTmp: 0 });
    expect(seen).toEqual([]);
  });
});

describe('server boot wiring (ADR-0020)', () => {
  it('sets the drain before the status manager starts, starts the boot drains, unawaited, once the server listens and the port file exists, gates the inbox on them, and awaits the floors at shutdown', async () => {
    const server = await fs.readFile(path.join(__dirname, '..', '..', '..', 'server.ts'), 'utf-8');
    // ADR-0022: the drain pulls remote tabs' spools first, then replays this server's spool.
    const wire = server.indexOf('getStatusManager().setHookSpoolDrain(() => drainHookSpoolsWithRemotePull(dispatchHook));');
    const init = server.indexOf('await getStatusManager().init();');
    const listen = server.indexOf('? await startDev(port, appDir, bindPlan.host)');
    const portFile = server.indexOf('await ensureHookSettings(result.port);');
    const boot = server.indexOf('  getStatusManager().startBootHookSpoolDrains();');
    const notes = server.indexOf('  await startNotes();');
    const inbox = server.indexOf('  await startInbox({ firstTickAfter: getStatusManager().bootHookSpoolDrained() });');
    expect(wire).toBeGreaterThan(0);
    expect(wire).toBeLessThan(init);
    expect(listen).toBeGreaterThan(init);
    expect(portFile).toBeGreaterThan(listen);
    expect(boot).toBeGreaterThan(portFile);
    // The inbox starts before listen but holds its first tick for the first boot drain.
    expect(inbox).toBeGreaterThan(init);
    expect(inbox).toBeLessThan(listen);
    // Notes install their paste-time preflight before the inbox can drain persisted notices.
    expect(notes).toBeGreaterThan(init);
    expect(notes).toBeLessThan(inbox);
    // The graceful shutdown awaits the status manager, which saves the hook floors.
    expect(server).toContain('  await gracefulStatusShutdown();');
    expect(server).not.toContain('await getStatusManager().drainHookSpool()');
    expect(server).not.toContain('await getStatusManager().startBootHookSpoolDrains()');
  });
});
