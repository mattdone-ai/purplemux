import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspacesCached: vi.fn(),
}));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));

// The file logger writes under the temp HOME, which each test removes; a write
// still pending at removal surfaced as an unhandled ENOENT (gate 26-r1).
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
  getAllPanesInfo: vi.fn(async () => new Map()),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));

const FIXTURES = path.join(__dirname, '../../fixtures');
const BLOCKED = 'BLOCKED: gate red — needs X';

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const managerWithPaste = async () => {
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
  manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
  return { manager, paste };
};

const worker = (panelType: TPanelType, jsonlPath: string | null): ITabStatusEntry => ({
  cliState: 'busy',
  workspaceId: 'ws-1',
  tabName: 'w1',
  tmuxSession: 'tmux-worker',
  panelType,
  agentProviderId: panelType === 'codex-cli' ? 'codex' : panelType === 'grok-cli' ? 'grok' : 'claude',
  jsonlPath,
  lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 },
  eventSeq: 1,
});

const writeLines = async (name: string, lines: unknown[]): Promise<string> => {
  const file = path.join(mockHome.value, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  return file;
};

const claudeEnd = (text: string) => ({
  type: 'assistant',
  timestamp: '2026-09-26T05:00:00.000Z',
  message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

// Gate lanes run four vitest workers on a loaded host; 1 s (the default) flaked there.
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const MIN = 60 * 1000;

/** A `purplemux watch` record the tab owns, in the watch store (ADR-0015). */
const armWatch = async (tabId: string) => {
  const file = path.join(mockHome.value, '.purplemux', 'watches.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ watches: [{
    id: 'w-accwatch01', workspaceId: 'ws-1', tabId, kind: 'pr', target: 'acme/repo#12', until: 'merged', baseline: 'abc1234',
    intervalS: 120, createdAt: 0, expiresAt: Date.now() + 24 * 60 * MIN, lastCheckedAt: null, failures: 0, failingNotified: false,
    lastError: null, label: null, verified: true,
  }] }));
};

/** The fleet value `watchdog.idle-nudge-minutes` (ADR-0019). */
const setIdleMinutes = async (value: string) => {
  const file = path.join(mockHome.value, '.purplemux', 'fleet-config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const setBy = { workspaceId: null, tabId: null, admin: true };
  await fs.writeFile(file, JSON.stringify({
    values: { 'watchdog.idle-nudge-minutes': { value, version: 1, setAt: 0, setBy } },
    versions: { 'watchdog.idle-nudge-minutes': 1 },
    history: [],
  }));
};

describe('stop classification (ADR-0018)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-turn-end-'));
    const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value], orchestration: { enabled: true, orchestratorTabId: 'root' } };
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const transcripts: Array<[TPanelType, () => Promise<string>]> = [
    ['claude-code', () => writeLines('claude/s.jsonl', [claudeEnd(`Gate r2 failed on lint.\n\n${BLOCKED}`)])],
    ['codex-cli', () => writeLines('codex/s.jsonl', [
      { timestamp: '2026-09-26T05:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'go' } },
      { timestamp: '2026-09-26T05:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: `Gate r2 failed on lint.\n\n${BLOCKED}` } },
      { timestamp: '2026-09-26T05:01:01.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
    ])],
    ['grok-cli', async () => {
      const raw = await fs.readFile(path.join(FIXTURES, 'grok-session/updates.jsonl'), 'utf-8');
      const replaced = raw.replace('"text":"OK"', `"text":${JSON.stringify(`Gate r2 failed on lint.\n\n${BLOCKED}`)}`);
      expect(replaced).not.toBe(raw);
      return writeLines('grok/updates.jsonl', replaced.trim().split('\n'));
    }],
  ];

  it.each(transcripts)('sends the %s worker\'s BLOCKED line verbatim to the orchestrator', async (panelType, make) => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker(panelType, await make());
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));

    expect(paste).toHaveBeenCalledWith(
      'tmux-root',
      `[orchestrator-watchdog] worker worker (w1) ended: ${BLOCKED} — read with: purplemux tab result -w ws-1 worker`,
    );
    expect(entry.cliState).toBe('ready-for-review');
    expect(entry.turnEnd).toMatchObject({ kind: 'turn-marker', marker: [BLOCKED] });
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([expect.objectContaining({ kind: 'turn-marker', tabId: 'worker' })]);
  });

  it('holds the recorded "Waiting for 1 background agent" stop whose shell started 20 turns earlier', async () => {
    const { manager, paste } = await managerWithPaste();
    const shapes = (await fs.readFile(path.join(FIXTURES, 'claude-background/shapes-2.1.283.jsonl'), 'utf-8')).trim().split('\n');
    const start = shapes.find((l) => l.includes('"backgroundTaskId": "bshell01"'))!;
    const turns = Array.from({ length: 20 }, (_, i) => claudeEnd(`turn ${i}: ${'x'.repeat(3000)}`));
    const file = await writeLines('claude/wait.jsonl', [start, ...turns, claudeEnd('Gate r1 is running.\n\nWaiting for 1 background agent')]);
    const entry = worker('claude-code', file);
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    await settle();

    expect(paste).not.toHaveBeenCalled();
    expect(entry.cliState).toBe('busy');
    expect(entry.turnEnd).toMatchObject({ openBackgroundTasks: 1, liveRegisteredJobs: 0 });
  });

  it('holds a stop while a shell a subagent moved to the background still runs (story 37, tab-dTsAzt)', async () => {
    const { manager, paste } = await managerWithPaste();
    const file = await writeLines('claude/sess.jsonl', [claudeEnd('Still running: the 46-r2 gate.')]);
    await writeLines('claude/sess/subagents/agent-a1.jsonl', [{
      type: 'user', isSidechain: true, agentId: 'a1', timestamp: '2026-09-26T04:59:00.000Z',
      message: { content: [{ type: 'tool_result', content: 'moved to the background (ID: bsub1)' }] },
      toolUseResult: { backgroundTaskId: 'bsub1', timedOutAfterMs: 600000 },
    }]);
    const entry = worker('claude-code', file);
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    await settle();

    expect(paste).not.toHaveBeenCalled();
    expect(entry.turnEnd).toMatchObject({ openBackgroundTasks: 1, liveRegisteredJobs: 0 });
  });

  it('records on a READY stop whether a transcript was read and how much was open', async () => {
    const { manager } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('All set.')]));
    manager.registerTab('worker', entry);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
    expect(entry.turnEnd).toMatchObject({ kind: 'ready-for-review', transcript: true, openBackgroundTasks: 0, liveRegisteredJobs: 0, armedWatches: 0 });
  });

  it('serves turnEnd to clients through the real getAllForClient (the tab status route reads it there)', async () => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('All set.')]));
    manager.registerTab('worker', entry);
    expect(manager.getAllForClient().worker.turnEnd).toBeNull();
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
    expect(paste).not.toHaveBeenCalled();
    expect(manager.getAllForClient().worker.turnEnd).toMatchObject({ kind: 'ready-for-review', transcript: true, openBackgroundTasks: 0 });
  });

  it('records an unreadable transcript as not read and the open count as unknown, never "read, 0 open"', async () => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', path.join(mockHome.value, 'claude/missing.jsonl'));
    manager.registerTab('worker', entry);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
    expect(paste).not.toHaveBeenCalled();
    expect(entry.turnEnd).toMatchObject({ kind: 'ready-for-review', transcript: false, openBackgroundTasks: null });
  });

  it('holds a stop with no marker while a registered tab bg job is alive', async () => {
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true, registeredAt: 0, ageS: 1 }] });
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('Gate running.')]));
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    await settle();

    expect(paste).not.toHaveBeenCalled();
    expect(entry.turnEnd).toMatchObject({ openBackgroundTasks: 0, liveRegisteredJobs: 1 });
  });

  // The poll's derived timers (review r1 finding 2): called with an explicit clock.
  const runTimers = (manager: unknown, now: number) =>
    (manager as { runWatchdogTimers: (n: number) => Promise<void> }).runWatchdogTimers(now);

  const readyStop = async (text = 'All set.') => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd(text)]));
    manager.registerTab('worker', entry);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
    await settle();
    return { manager, paste, entry, at: entry.turnEnd!.at };
  };

  it('sends no immediate nudge for a stop with no end line and nothing live; ONE "idle without an end line" nudge after 15 min (L49)', async () => {
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: false, registeredAt: 0, ageS: 1 }] });
    const { manager, paste, entry, at } = await readyStop();
    expect(entry.cliState).toBe('ready-for-review');
    await runTimers(manager, at + 15 * MIN - 1);
    expect(paste).not.toHaveBeenCalled();
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([]);

    await runTimers(manager, at + 15 * MIN);
    const { buildNudgeMessage } = await import('@/lib/orchestration');
    expect(paste.mock.calls).toEqual([['tmux-root', buildNudgeMessage('idle-no-end-line', 'worker', 'w1', 'ws-1', '15 min ago')]]);
    expect(paste.mock.calls[0][1]).toContain('idle without an end line');
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([expect.objectContaining({ kind: 'idle-no-end-line', tabId: 'worker' })]);
    expect(entry.turnEnd).toMatchObject({ idleNudgeSentSeq: entry.turnEnd!.seq });

    // One nudge per stop, never a stream.
    await runTimers(manager, at + 75 * MIN);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('keeps the idle nudge through Claude\'s own idle_prompt notification 61 s after the stop (review r1 finding 1a)', async () => {
    const { manager, paste, at } = await readyStop();
    manager.updateTabFromHook('tmux-worker', 'notification', 'idle_prompt');
    await runTimers(manager, at + 61_000);
    await runTimers(manager, at + 15 * MIN);
    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste.mock.calls[0][1]).toContain('idle without an end line');
  });

  it('re-arms from a second stop while already ready-for-review: one nudge, 15 min after the SECOND stop (review r1 finding 1b)', async () => {
    const t0 = Date.parse('2026-09-27T12:00:00.000Z');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    const { manager, paste, entry } = await readyStop();
    const firstSeq = entry.turnEnd!.seq;
    vi.setSystemTime(t0 + 5 * MIN);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.seq).toBe(firstSeq! + 1));
    await settle();
    const second = entry.turnEnd!.at;
    expect(entry.turnEnd?.kind).toBe('ready-for-review');
    expect(second).toBeGreaterThanOrEqual(t0 + 5 * MIN);

    // 15 min after the FIRST stop: nothing; 15 min after the second: exactly one.
    await runTimers(manager, t0 + 15 * MIN);
    expect(paste).not.toHaveBeenCalled();
    await runTimers(manager, second + 15 * MIN);
    await runTimers(manager, second + 40 * MIN);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a new prompt', 'prompt-submit', undefined],
    ['a session start', 'session-start', undefined],
    ['a permission request', 'notification', 'permission_prompt'],
  ])('sends no idle nudge after %s inside the window (the stop is no longer the latest event)', async (_what, event, type) => {
    const { manager, paste, at } = await readyStop();
    manager.updateTabFromHook('tmux-worker', event, type);
    await runTimers(manager, at + 16 * MIN);
    expect(paste.mock.calls.filter(([, m]) => m.includes('idle without an end line'))).toEqual([]);
  });

  it('sends no idle nudge after a person dismissed the ready tab', async () => {
    const { manager, paste, at } = await readyStop();
    manager.dismissTab('worker');
    await runTimers(manager, at + 20 * MIN);
    expect(paste).not.toHaveBeenCalled();
  });

  it('drops the idle nudge when the tab registered a job during the window, and does not send it later', async () => {
    const { manager, paste, at } = await readyStop();
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true, registeredAt: 0, ageS: 1 }] });
    await runTimers(manager, at + 15 * MIN);
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
    await runTimers(manager, at + 30 * MIN);
    expect(paste).not.toHaveBeenCalled();
  });

  it('reads the quiet window from fleet config watchdog.idle-nudge-minutes, and ignores a value that is not minutes', async () => {
    await setIdleMinutes('5');
    const first = await readyStop();
    await runTimers(first.manager, first.at + 5 * MIN);
    expect(first.paste).toHaveBeenCalledTimes(1);
    expect(first.paste.mock.calls[0][1]).toContain('stopped 5 min ago');

    await setIdleMinutes('soon');
    const second = await readyStop();
    await runTimers(second.manager, second.at + 14 * MIN);
    expect(second.paste).not.toHaveBeenCalled();
    await runTimers(second.manager, second.at + 15 * MIN);
    expect(second.paste.mock.calls[0][1]).toContain('stopped 15 min ago');
  });

  it('holds a markerless stop as WAITING while the tab owns an armed purplemux watch (L49)', async () => {
    await armWatch('worker');
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('Watching acme/repo#12 until it merges.')]));
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    await runTimers(manager, entry.turnEnd!.at + 60 * MIN);

    expect(paste).not.toHaveBeenCalled();
    expect(entry.cliState).toBe('busy');
    expect(entry.turnEnd).toMatchObject({ openBackgroundTasks: 0, liveRegisteredJobs: 0, armedWatches: 1 });
    expect(manager.isWaitingAtPrompt('worker')).toBe(true);
  });

  it('counts only the tab\'s own watches', async () => {
    await armWatch('someone-else');
    const { entry } = await readyStop();
    expect(entry.turnEnd).toMatchObject({ armedWatches: 0 });
  });

  it('sends the turn-marker nudge at once, and no idle nudge after it', async () => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('Merged.\n\nDONE: shipped')]));
    manager.registerTab('worker', entry);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    expect(paste.mock.calls[0][1]).toContain('ended: DONE: shipped');
    await runTimers(manager, entry.turnEnd!.at + 60 * MIN);
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('delivers a repeated identical end line from a NEW stop (review r1 finding 3), and not a second stop event of the same turn', async () => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('Gate green.\n\nDONE: gate green')]));
    manager.registerTab('worker', entry);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    // A second stop event with no new turn: the same line, not re-sent.
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.seq).toBe(entry.lastEvent?.seq));
    await settle();
    expect(paste).toHaveBeenCalledTimes(1);
    // A fix-up turn that ends on the same line inside 60 s: a new episode, delivered.
    manager.updateTabFromHook('tmux-worker', 'prompt-submit');
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(2));
    expect(paste.mock.calls[1][1]).toContain('ended: DONE: gate green');
  });

  it('sends a new end line from a stop while already ready-for-review', async () => {
    const { manager, paste, entry } = await readyStop();
    await writeLines('claude/s.jsonl', [claudeEnd('Follow-up done.\n\nDONE: follow-up')]);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    expect(paste.mock.calls[0][1]).toContain('ended: DONE: follow-up');
    expect(entry.turnEnd?.kind).toBe('turn-marker');
  });

  it('without a transcript sends no immediate nudge; the idle nudge says the end line is unknown, and the fallback is logged once', async () => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', null);
    manager.registerTab('worker', entry);
    const fallback = (manager as unknown as { transcriptFallbackLogged: Set<string> }).transcriptFallbackLogged;

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
    expect(paste).not.toHaveBeenCalled();
    expect(fallback.has('worker')).toBe(true);
    expect(entry.turnEnd).toMatchObject({ kind: 'ready-for-review', transcript: false });
    await runTimers(manager, entry.turnEnd!.at + 15 * MIN);
    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste.mock.calls[0][1]).toContain('idle without an end line');
    expect(paste.mock.calls[0][1]).toContain('its transcript could not be read');
  });

  describe('long-wait backstop (review r1 finding 4)', () => {
    const waitingOnJob = async () => {
      liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 4711, label: 'gate-ui', alive: true, registeredAt: 0, ageS: 1 }] });
      const { manager, paste } = await managerWithPaste();
      const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('Gate running.')]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
      return { manager, paste, entry };
    };

    it('sends ONE long-wait nudge naming the job after 4 h WAITING, never a stall', async () => {
      const { manager, paste, entry } = await waitingOnJob();
      const at = entry.turnEnd!.at;
      await runTimers(manager, at + 4 * 60 * MIN - 1);
      expect(paste).not.toHaveBeenCalled();
      await runTimers(manager, at + 4 * 60 * MIN);
      await runTimers(manager, at + 9 * 60 * MIN);
      expect(paste).toHaveBeenCalledTimes(1);
      const [[, message]] = paste.mock.calls;
      expect(message).toContain('has been WAITING 4 h on job pid 4711 "gate-ui"');
      expect(message).not.toMatch(/stall/i);
      expect(manager.getOrchestrationNudges('ws-1')).toEqual([expect.objectContaining({ kind: 'long-wait' })]);
    });

    it('starts a new stretch on activity: the next WAITING stop gets its own nudge, 4 h after it', async () => {
      const t0 = Date.parse('2026-09-27T12:00:00.000Z');
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(t0);
      const { manager, paste, entry } = await waitingOnJob();
      const first = entry.turnEnd!.at;
      await runTimers(manager, first + 4 * 60 * MIN);
      expect(paste).toHaveBeenCalledTimes(1);

      vi.setSystemTime(t0 + 5 * 60 * MIN);
      const firstSeq = entry.turnEnd!.seq!;
      manager.updateTabFromHook('tmux-worker', 'prompt-submit');
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(entry.turnEnd).toMatchObject({ kind: 'waiting', seq: firstSeq + 2 }));
      const second = entry.turnEnd!.at;
      expect(second).toBeGreaterThanOrEqual(t0 + 5 * 60 * MIN);
      await runTimers(manager, second + 3 * 60 * MIN);
      expect(paste).toHaveBeenCalledTimes(1);
      await runTimers(manager, second + 4 * 60 * MIN);
      expect(paste).toHaveBeenCalledTimes(2);
    });

    it('names an armed watch, and reads watchdog.wait-backstop-hours', async () => {
      await armWatch('worker');
      const file = path.join(mockHome.value, '.purplemux', 'fleet-config.json');
      const setBy = { workspaceId: null, tabId: null, admin: true };
      await fs.writeFile(file, JSON.stringify({ values: { 'watchdog.wait-backstop-hours': { value: '1', version: 1, setAt: 0, setBy } }, versions: { 'watchdog.wait-backstop-hours': 1 }, history: [] }));
      const { manager, paste } = await managerWithPaste();
      const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('Watching.')]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
      await runTimers(manager, entry.turnEnd!.at + 60 * MIN);
      expect(paste).toHaveBeenCalledTimes(1);
      expect(paste.mock.calls[0][1]).toContain('watch w-accwatch01 on acme/repo#12 until merged');
    });

    it('does not fire for a WAITING tab whose only open work is its own background shells (the stall rules cover those)', async () => {
      const { manager, paste } = await managerWithPaste();
      const shapes = (await fs.readFile(path.join(FIXTURES, 'claude-background/shapes-2.1.283.jsonl'), 'utf-8')).trim().split('\n');
      const start = shapes.find((l) => l.includes('"backgroundTaskId": "bshell01"'))!;
      const entry = worker('claude-code', await writeLines('claude/w.jsonl', [start, claudeEnd('Waiting on the gate.')]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
      await runTimers(manager, entry.turnEnd!.at + 10 * 60 * MIN);
      expect(paste).not.toHaveBeenCalled();
    });
  });

  it('lets only the newest of two quick stops classify the tab (stop → prompt-submit → stop)', async () => {
    const { manager, paste } = await managerWithPaste();
    const { getProviderByPanelType } = await import('@/lib/providers/registry');
    const claude = getProviderByPanelType('claude-code')!;
    const original = claude.readRuntimeSnapshot.bind(claude);
    let releaseFirst!: () => void;
    const firstRead = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reads = 0;
    // Classification reads carry `tasksSince`; the snippet refresh does not. Both
    // stops run the same async chain, so the first classification read is stop 1's.
    const read = vi.spyOn(claude, 'readRuntimeSnapshot').mockImplementation(async (handle, options) => {
      if (!options || !('tasksSince' in options)) return original(handle, options);
      reads += 1;
      if (reads === 1) {
        await firstRead;
        return { ...(await original(handle, options)), lastAssistantTail: 'Waiting on the gate.', openBackgroundTasks: 1 };
      }
      return original(handle, options);
    });
    try {
      const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('All set.')]));
      manager.registerTab('worker', entry);

      manager.updateTabFromHook('tmux-worker', 'stop');
      manager.updateTabFromHook('tmux-worker', 'prompt-submit');
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
      releaseFirst();
      await settle();

      expect(entry.cliState).toBe('ready-for-review');
      expect(entry.turnEnd?.kind).toBe('ready-for-review');
      expect(paste).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });

  it('reports a WAITING tab as at its prompt only for the current stop and until a relaunch (ruling A′)', async () => {
    const { manager } = await managerWithPaste();
    const shapes = (await fs.readFile(path.join(FIXTURES, 'claude-background/shapes-2.1.283.jsonl'), 'utf-8')).trim().split('\n');
    const start = shapes.find((l) => l.includes('"backgroundTaskId": "bshell01"'))!;
    const entry = worker('claude-code', await writeLines('claude/w.jsonl', [start, claudeEnd('Waiting on the gate.')]));
    entry.lastResumeOrStartedAt = Date.now() - 60_000;
    manager.registerTab('worker', entry);
    expect(manager.isWaitingAtPrompt('worker')).toBe(false);

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));
    expect(entry.turnEnd?.seq).toBe(entry.lastEvent?.seq);
    expect(manager.isWaitingAtPrompt('worker')).toBe(true);

    manager.markAgentLaunch('worker');
    expect(manager.isWaitingAtPrompt('worker')).toBe(false);
    entry.lastResumeOrStartedAt = entry.lastEvent!.at - 1;
    expect(manager.isWaitingAtPrompt('worker')).toBe(true);

    manager.updateTabFromHook('tmux-worker', 'prompt-submit');
    expect(manager.isWaitingAtPrompt('worker')).toBe(false);
    expect(manager.isWaitingAtPrompt('nope')).toBe(false);
  });

  it('rebuilds a WAITING tab after a server restart: send access and the stall check both apply', async () => {
    const { manager } = await managerWithPaste();
    const shapes = (await fs.readFile(path.join(FIXTURES, 'claude-background/shapes-2.1.283.jsonl'), 'utf-8')).trim().split('\n');
    const start = shapes.find((l) => l.includes('"backgroundTaskId": "bshell01"'))!;
    const file = await writeLines('claude/r.jsonl', [start, claudeEnd('Waiting on the gate.')]);
    const ended = new Date('2026-09-26T05:00:00.000Z');
    await fs.utimes(file, ended, ended);
    // What the poll restores from a persisted `busy`: unknown, no lastEvent, no turnEnd.
    const entry: ITabStatusEntry = { ...worker('claude-code', file), cliState: 'unknown', lastEvent: null, eventSeq: 0 };
    manager.registerTab('worker', entry);
    const tmux = await import('@/lib/tmux');
    vi.mocked(tmux.getAllPanesInfo).mockResolvedValue(new Map([['tmux-worker', { pid: 999_999_999 }]]) as never);
    const { getProviderByPanelType } = await import('@/lib/providers/registry');
    const running = vi.spyOn(getProviderByPanelType('claude-code')!, 'isAgentRunning').mockResolvedValue(true);
    try {
      await (manager as unknown as { resolveUnknown: (id: string) => Promise<void> }).resolveUnknown('worker');
    } finally {
      running.mockRestore();
      vi.mocked(tmux.getAllPanesInfo).mockResolvedValue(new Map());
    }

    expect(entry.cliState).toBe('busy');
    expect(entry.turnEnd).toMatchObject({ kind: 'waiting', openBackgroundTasks: 1, seq: entry.lastEvent?.seq });
    expect(entry.lastEvent).toMatchObject({ name: 'stop', at: Date.parse('2026-09-26T05:00:00.000Z') });
    expect(manager.isWaitingAtPrompt('worker')).toBe(true);
    const looksStalled = (manager as unknown as { looksStalled: (id: string, e: ITabStatusEntry, n: number) => Promise<boolean> }).looksStalled.bind(manager);
    const at = entry.lastEvent!.at;
    expect(await looksStalled('worker', entry, at + 40 * 60 * 1000)).toBe(false);
    expect(await looksStalled('worker', entry, at + 91 * 60 * 1000)).toBe(true);
  });

  it('applies the process-start cutoff when it rebuilds a tab after a restart', async () => {
    const { manager } = await managerWithPaste();
    const shapes = (await fs.readFile(path.join(FIXTURES, 'claude-background/shapes-2.1.283.jsonl'), 'utf-8')).trim().split('\n');
    const start = shapes.find((l) => l.includes('"backgroundTaskId": "bshell01"'))!;
    const file = await writeLines('claude/o.jsonl', [start, claudeEnd('Waiting on the gate.')]);
    const entry: ITabStatusEntry = { ...worker('claude-code', file), cliState: 'unknown', lastEvent: null, eventSeq: 0 };
    manager.registerTab('worker', entry);
    const tmux = await import('@/lib/tmux');
    vi.mocked(tmux.getAllPanesInfo).mockResolvedValue(new Map([['tmux-worker', { pid: 999_999_999 }]]) as never);
    vi.mocked(tmux.getSessionPanePid).mockResolvedValue(4242);
    const { getProviderByPanelType } = await import('@/lib/providers/registry');
    const claude = getProviderByPanelType('claude-code')!;
    const running = vi.spyOn(claude, 'isAgentRunning').mockResolvedValue(true);
    // The shell (02:00:01Z) started before this Claude process: an orphan.
    const detect = vi.spyOn(claude, 'detectActiveSession').mockResolvedValue({
      status: 'running', sessionId: 's', jsonlPath: file, pid: 4243, startedAt: Date.parse('2026-09-26T03:00:00.000Z'), cwd: '/',
    });
    try {
      await (manager as unknown as { resolveUnknown: (id: string) => Promise<void> }).resolveUnknown('worker');
    } finally {
      running.mockRestore();
      detect.mockRestore();
      vi.mocked(tmux.getAllPanesInfo).mockResolvedValue(new Map());
      vi.mocked(tmux.getSessionPanePid).mockResolvedValue(null);
    }
    expect(entry.cliState).toBe('ready-for-review');
    expect(entry.turnEnd ?? null).toBeNull();
  });

  it('re-arms the stuck nudge on every classified stop, so each wait in a WAITING chain can report a stall', async () => {
    const { manager } = await managerWithPaste();
    const shapes = (await fs.readFile(path.join(FIXTURES, 'claude-background/shapes-2.1.283.jsonl'), 'utf-8')).trim().split('\n');
    const start = shapes.find((l) => l.includes('"backgroundTaskId": "bshell01"'))!;
    const entry = worker('claude-code', await writeLines('claude/c.jsonl', [start, claudeEnd('Waiting on the gate.')]));
    manager.registerTab('worker', entry);
    const latch = (manager as unknown as { stuckNudgedTabs: Map<string, number> }).stuckNudgedTabs;
    latch.set('worker', Date.now()); // a stuck nudge fired during the previous wait

    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('waiting'));

    expect(entry.cliState).toBe('busy');
    expect(latch.has('worker')).toBe(false);
  });

  it('drops a stale classification when a newer event moved the tab on', async () => {
    const { manager, paste } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('DONE: x')]));
    manager.registerTab('worker', entry);

    manager.updateTabFromHook('tmux-worker', 'stop');
    manager.updateTabFromHook('tmux-worker', 'prompt-submit');
    await settle();

    expect(paste).not.toHaveBeenCalled();
    expect(entry.cliState).toBe('busy');
  });
});

describe('busy-stuck check for a waiting tab (ADR-0018, L19, L25)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-stuck-'));
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const looksStalled = async (entry: ITabStatusEntry, now: number) => {
    const { manager } = await managerWithPaste();
    return (manager as unknown as { looksStalled: (id: string, e: ITabStatusEntry, n: number) => Promise<boolean> }).looksStalled('worker', entry, now);
  };

  // The busy tab's last event is the stop it waits from, at the test's own clock.
  const stoppedAt = (file: string, at: number): ITabStatusEntry => ({ ...worker('claude-code', file), lastEvent: { name: 'stop', at, seq: 1 } });
  // The same stop, classified WAITING (what `applyStopTurnEnd` records for a live job or watch).
  const waitingAt = (file: string | null, at: number): ITabStatusEntry => ({
    ...worker('claude-code', file),
    lastEvent: { name: 'stop', at, seq: 1 },
    turnEnd: { kind: 'waiting', at, seq: 1, openBackgroundTasks: 0, liveRegisteredJobs: 1 },
  });

  const setMtime = (file: string, at: number) => fs.utimes(file, new Date(at), new Date(at));

  const shellWait = async (startedAt: number) => {
    const out = path.join(mockHome.value, 'tasks', 'bgate.output');
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, '');
    const file = await writeLines('claude/s.jsonl', [
      {
        type: 'user',
        timestamp: new Date(startedAt).toISOString(),
        message: { content: [{ type: 'tool_result', content: `Command running in background with ID: bgate. Output is being written to: ${out}. You will be notified` }] },
        toolUseResult: { backgroundTaskId: 'bgate' },
      },
      { ...claudeEnd('Waiting for the gate.'), timestamp: new Date(startedAt).toISOString() },
    ]);
    await setMtime(file, startedAt);
    await setMtime(out, startedAt);
    return { file, out };
  };

  it('is not STALLED 20 min into a wait, nor past the backstop while the task-output file keeps growing', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const { file, out } = await shellWait(t0);
    await fs.appendFile(out, 'lane 3 passed\n');
    await setMtime(out, t0 + 19 * 60 * 1000);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 20 * 60 * 1000)).toBe(false);
    await setMtime(out, t0 + 94 * 60 * 1000);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 95 * 60 * 1000)).toBe(false);
    await setMtime(out, t0);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 95 * 60 * 1000)).toBe(true);
  });

  it('is never STALLED while a registered tab bg job is alive, even past the 90 min backstop (L49); a dead job holds nothing', async () => {
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true, registeredAt: 0, ageS: 1 }] });
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const file = await writeLines('claude/j.jsonl', [{ ...claudeEnd('Gate launched; waiting.'), timestamp: new Date(t0).toISOString() }]);
    await setMtime(file, t0);
    expect(await looksStalled(waitingAt(file, t0), t0 + 40 * 60 * 1000)).toBe(false);
    expect(await looksStalled(waitingAt(file, t0), t0 + 90 * 60 * 1000)).toBe(false);
    expect(await looksStalled(waitingAt(file, t0), t0 + 10 * 60 * 60 * 1000)).toBe(false);
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: false, registeredAt: 0, ageS: 1 }] });
    expect(await looksStalled(waitingAt(file, t0), t0 + 40 * 60 * 1000)).toBe(true);
  });

  it('keeps the staleness rule for a tab hung MID-TURN next to a live job: its last event is newer than any stop (review r2 nit 3)', async () => {
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true, registeredAt: 0, ageS: 1 }] });
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const file = await writeLines('claude/h.jsonl', [{ ...claudeEnd('Running the build in the foreground.'), timestamp: new Date(t0).toISOString() }]);
    await setMtime(file, t0);
    // An earlier WAITING stop, then a new prompt: the agent is in a turn, hung in a foreground tool.
    const midTurn: ITabStatusEntry = {
      ...waitingAt(file, t0 - 60 * 60 * 1000),
      lastEvent: { name: 'prompt-submit', at: t0, seq: 2 },
    };
    expect(await looksStalled(midTurn, t0 + 9 * 60 * 1000)).toBe(false);
    expect(await looksStalled(midTurn, t0 + 11 * 60 * 1000)).toBe(true);
    // A busy tab that never stopped at all: the same.
    expect(await looksStalled({ ...worker('claude-code', file), lastEvent: { name: 'prompt-submit', at: t0, seq: 1 } }, t0 + 11 * 60 * 1000)).toBe(true);
    // Negative: the WAITING stop that is still the latest event holds off.
    expect(await looksStalled(waitingAt(file, t0), t0 + 11 * 60 * 1000)).toBe(false);
  });

  it('is never STALLED while the tab owns an armed purplemux watch, with or without a transcript (L49)', async () => {
    await armWatch('worker');
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const entry = waitingAt(null, t0);
    expect(await looksStalled(entry, t0 + 40 * 60 * 1000)).toBe(false);
    expect(await looksStalled(entry, t0 + 10 * 60 * 60 * 1000)).toBe(false);
    await fs.rm(path.join(mockHome.value, '.purplemux', 'watches.json'));
    expect(await looksStalled(entry, t0 + 40 * 60 * 1000)).toBe(true);
  });

  it('gives a tab whose job just reported its exit the no-open window before STALLED', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const entry = { ...worker('claude-code', null), lastEvent: { name: 'stop' as const, at: t0, seq: 2 } };
    const { manager } = await managerWithPaste();
    const internals = manager as unknown as {
      looksStalled: (id: string, e: ITabStatusEntry, n: number) => Promise<boolean>;
      jobEventAt: Map<string, number>;
    };
    const now = t0 + 40 * 60 * 1000;
    internals.jobEventAt.set('worker', now - 60_000);
    expect(await internals.looksStalled('worker', entry, now)).toBe(false);
    internals.jobEventAt.set('worker', now - 10 * 60 * 1000);
    expect(await internals.looksStalled('worker', entry, now)).toBe(true);
  });

  it('drops tasks started before the tab\'s Claude process (pid file startedAt flows through)', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const { file } = await shellWait(t0);
    const tmux = await import('@/lib/tmux');
    vi.mocked(tmux.getSessionPanePid).mockResolvedValue(4242);
    await import('@/lib/providers');
    const { getProviderByPanelType } = await import('@/lib/providers/registry');
    const claude = getProviderByPanelType('claude-code')!;
    const detect = vi.spyOn(claude, 'detectActiveSession').mockResolvedValue({
      status: 'running', sessionId: 's', jsonlPath: file, pid: 4243, startedAt: t0 + 60_000, cwd: '/',
    });
    try {
      // The shell started before this process: an orphan, so the tab is judged by the no-open 10 min rule.
      expect(await looksStalled(stoppedAt(file, t0), t0 + 40 * 60 * 1000)).toBe(true);
      expect(detect).toHaveBeenCalledWith(4242, undefined, { tmuxSession: 'tmux-worker' });
    } finally {
      detect.mockRestore();
      vi.mocked(tmux.getSessionPanePid).mockResolvedValue(null);
    }
  });

  it('is not STALLED on a silent gate waiter 40 min in, and is at the 90 min backstop', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const { file } = await shellWait(t0);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 40 * 60 * 1000)).toBe(false);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 90 * 60 * 1000)).toBe(true);
  });

  it('is STALLED when an open subagent\'s transcript has been silent 15 min', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const file = await writeLines('claude/a.jsonl', [
      {
        type: 'user',
        timestamp: new Date(t0).toISOString(),
        message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
        toolUseResult: { isAsync: true, agentId: 'aw1' },
      },
    ]);
    const sub = path.join(mockHome.value, 'claude', 'a', 'subagents', 'agent-aw1.jsonl');
    await fs.mkdir(path.dirname(sub), { recursive: true });
    await fs.writeFile(sub, '{}\n');
    await setMtime(file, t0);
    await setMtime(sub, t0 + 5 * 60 * 1000);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 19 * 60 * 1000)).toBe(false);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 20 * 60 * 1000)).toBe(true);
  });

  it('keeps the 10 min rule for a busy tab with nothing open', async () => {
    const t0 = Date.parse('2026-09-26T05:00:00.000Z');
    const file = await writeLines('claude/b.jsonl', [{ ...claudeEnd('working'), timestamp: new Date(t0).toISOString() }]);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 9 * 60 * 1000)).toBe(false);
    expect(await looksStalled(stoppedAt(file, t0), t0 + 11 * 60 * 1000)).toBe(true);
  });
});
