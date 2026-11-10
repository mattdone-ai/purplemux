import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));
const alerts = vi.hoisted(() => ({ dispatch: vi.fn(async () => {}) }));

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
  getNotificationDispatcher: () => ({ dispatch: alerts.dispatch, register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));

const FIXTURES = path.join(__dirname, '../../fixtures/turn-errors');
const waitFor = (check: () => unknown) => vi.waitFor(check, { timeout: 5000 });
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const setup = async () => {
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
  // F6's coordinator window is pinned in coordinator-window.test.ts and status-manager-event-digest.test.ts; these
  // tests pin worker turn-error episodes, with the orchestrator as the nudge target only, so they turn the window off.
  (await import('@/lib/coordinator-window')).configureCoordinatorWindow({
    now: () => Date.now(), isCoordinator: async () => false, lastGoverned: () => null, oldestDigestAt: () => null,
  });
  manager.registerTab('tab-o', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'o', tmuxSession: 'tmux-tab-o', panelType: 'claude-code' });
  const store = await import('@/lib/inbox-store');
  const nudges = () => paste.mock.calls.map(([, message]) => message);
  const resumes = async () => (await store.readInboxState()).items.filter((i) => i.kind === 'resume');
  // Past the 60 s duplicate filter (L49), so a "once per episode" guard is what keeps a repeat quiet.
  const { NudgeDeduper } = await import('@/lib/nudge-dedupe');
  const clearDebounce = () => {
    (manager as unknown as { nudgeDedupe: InstanceType<typeof NudgeDeduper> }).nudgeDedupe = new NudgeDeduper();
  };
  return { manager, paste, nudges, resumes, store, clearDebounce };
};

const transcript = async (fixture: string, extra: unknown[] = []): Promise<string> => {
  const file = path.join(mockHome.value, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  await fs.writeFile(file, (await fs.readFile(path.join(FIXTURES, fixture), 'utf-8')) + extra.map((e) => JSON.stringify(e) + '\n').join(''));
  return file;
};

const worker = (panelType: TPanelType, jsonlPath: string): ITabStatusEntry => ({
  cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-tab-w', panelType,
  agentProviderId: panelType === 'codex-cli' ? 'codex' : 'claude', jsonlPath,
  lastEvent: { name: 'prompt-submit', at: Date.now(), seq: 1 }, eventSeq: 1,
});

const stopAgain = async (manager: { updateTabFromHook: (s: string, e: string) => void }, entry: ITabStatusEntry, file: string) => {
  entry.jsonlPath = file;
  manager.updateTabFromHook('tmux-tab-w', 'prompt-submit');
  manager.updateTabFromHook('tmux-tab-w', 'stop');
};

describe('API-error turn ends (story 26, ADR-0018 amendment)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-turn-error-sm-'));
    const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value], orchestration: { enabled: true, orchestratorTabId: 'tab-o' } };
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('queues exactly one resume to the worker and nudges no one (the recorded W4 stop)', async () => {
    const { manager, nudges, resumes } = await setup();
    const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
    manager.registerTab('tab-w', entry);

    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(async () => expect(await resumes()).toHaveLength(1));
    await settle();

    const [resume] = await resumes();
    expect(resume).toMatchObject({ targetWorkspaceId: 'ws-1', targetTabId: 'tab-w', state: 'queued', dedupeKey: 'resume-tab-w-cbb7ecd3-be79-4c44-ac45-0fa53331e1c0' });
    expect(resume.line).toMatch(/^\[purplemux resume r-[A-Za-z0-9_-]{8}\] the last turn ended on an API error — continue from where it was cut off$/);
    expect(nudges()).toEqual([]);
    expect(entry.cliState).toBe('ready-for-review');
    expect(entry.turnError).toMatchObject({ class: 'api-error', code: 'server_error', resumeItemId: resume.id, escalated: false });
  });

  it('ignores a repeated stop of the SAME failed turn: no second failure, the resume stays queued (review r2 nit 1)', async () => {
    const { manager, nudges, resumes } = await setup();
    const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());
    const seq = entry.lastEvent!.seq;

    // The same stop again, with no new prompt: the tab is already ready-for-review.
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnEnd?.seq).toBe(seq + 1));
    await settle();

    expect(nudges()).toEqual([]);
    expect(entry.turnError).toMatchObject({ escalated: false, turnId: 'cbb7ecd3-be79-4c44-ac45-0fa53331e1c0' });
    expect((await resumes()).map((r) => r.state)).toEqual(['queued']);
  });

  it('treats a stop of a DIFFERENT failed turn while ready-for-review as the second failure (today\'s behaviour)', async () => {
    const { manager, nudges, resumes } = await setup();
    const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());

    entry.jsonlPath = await transcript('claude-server-error-2.1.283.jsonl', [
      { type: 'user', timestamp: '2026-09-26T01:31:00.000Z', message: { content: 'resume' } },
      { type: 'assistant', isApiErrorMessage: true, error: 'server_error', uuid: 'other-turn', timestamp: '2026-09-26T01:32:00.000Z', message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: again.' }] } },
      { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-26T01:32:01.000Z' },
    ]);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('API ERROR after its one automatic resume: API Error: again.');
    await waitFor(async () => expect((await resumes())[0].state).toBe('dropped'));
  });

  it('nudges api-error once, with the text, when the resumed turn fails again; no second resume', async () => {
    const { manager, nudges, resumes, clearDebounce } = await setup();
    const file = await transcript('claude-server-error-2.1.283.jsonl');
    const entry = worker('claude-code', file);
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(async () => expect(entry.turnError?.resumeItemId).toBeTruthy());

    const second = await transcript('claude-server-error-2.1.283.jsonl', [
      { type: 'user', timestamp: '2026-09-26T01:31:00.000Z', message: { content: 'resume' } },
      { type: 'assistant', isApiErrorMessage: true, error: 'server_error', uuid: 'second-error', timestamp: '2026-09-26T01:32:00.000Z', message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: Server error mid-response. Again.' }] } },
      { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-09-26T01:32:01.000Z' },
    ]);
    await stopAgain(manager, entry, second);
    await waitFor(() => expect(nudges()).toHaveLength(1));
    clearDebounce();
    await stopAgain(manager, entry, second);
    await settle();

    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('API ERROR after its one automatic resume: API Error: Server error mid-response. Again.');
    expect(await resumes()).toHaveLength(1);
  });

  it('closes the episode on a clean marker stop and sends the normal turn-marker nudge', async () => {
    const { manager, nudges } = await setup();
    const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());

    await stopAgain(manager, entry, await transcript('claude-server-error-2.1.283.jsonl', [
      { type: 'user', timestamp: '2026-09-26T01:31:00.000Z', message: { content: 'resume' } },
      { type: 'assistant', timestamp: '2026-09-26T01:33:00.000Z', uuid: 'ok', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Gate green.\n\nDONE: resumed and finished' }] } },
    ]));
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('ended: DONE: resumed and finished');
    expect(entry.turnError).toBeNull();
  });

  it('never types into a usage-limit halt; nudges usage-limit once per episode', async () => {
    const { manager, nudges, resumes, clearDebounce } = await setup();
    const file = await transcript('codex-usage-limit-exceeded.jsonl');
    const entry = worker('codex-cli', file);
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(nudges()).toHaveLength(1));
    clearDebounce();
    await stopAgain(manager, entry, file);
    await settle();

    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toContain('HALTED by a usage limit');
    expect(nudges()[0]).toContain('Do NOT type into it');
    expect(await resumes()).toEqual([]);
  });

  it('treats a Codex server_overloaded stop like the Claude API error: one resume, no nudge', async () => {
    const { manager, nudges, resumes } = await setup();
    const entry = worker('codex-cli', await transcript('codex-server-overloaded.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(async () => expect(await resumes()).toHaveLength(1));
    await settle();
    expect(nudges()).toEqual([]);
  });

  it.each([
    ['claude-authentication-failed.jsonl', 'claude-code'],
    ['codex-other-401.jsonl', 'codex-cli'],
    ['claude-usage-warning-footer-negative.jsonl', 'claude-code'],
  ] as Array<[string, TPanelType]>)('keeps story 15 classification for %s: a ready stop with no end line (no immediate nudge, L49), no resume', async (fixture, panelType) => {
    const { manager, nudges, resumes } = await setup();
    const entry = worker(panelType, await transcript(fixture));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnEnd?.kind).toBe('ready-for-review'));
    await settle();
    expect(entry.cliState).toBe('ready-for-review');
    expect(nudges()).toEqual([]);
    expect(await resumes()).toEqual([]);
    expect(entry.turnError ?? null).toBeNull();
  });

  it('escalates once when the inbox holds the resume (e.g. a composer that keeps typed text)', async () => {
    const { manager, nudges, resumes, store, clearDebounce } = await setup();
    const off = store.onInboxHeld((item) => manager.handleHeldResume(item));
    try {
      const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
      manager.registerTab('tab-w', entry);
      manager.updateTabFromHook('tmux-tab-w', 'stop');
      await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());
      const [resume] = await resumes();
      await store.mutateInbox((s) => ({ state: store.holdInState(s, resume.id, 'composer-not-empty (30 refusals)', Date.now()), value: null }));
      await waitFor(() => expect(nudges()).toHaveLength(1));
      expect(nudges()[0]).toContain(`resume notice ${resume.id} held: composer-not-empty (30 refusals)`);
      clearDebounce();
      manager.handleHeldResume({ ...resume, state: 'held' });
      await settle();
      expect(nudges()).toHaveLength(1);
    } finally {
      off();
    }
  });

  const codexTurn = (message: string, error?: { message: string; codex_error_info: string }) => [
    { timestamp: '2026-09-16T09:20:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'resume' } },
    { timestamp: '2026-09-16T09:20:30.000Z', type: 'event_msg', payload: { type: 'agent_message', message } },
    { timestamp: '2026-09-16T09:21:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', last_agent_message: message, ...(error ? { error } : {}) } },
  ];

  it('Codex: a second server_overloaded escalates once; a clean marker closes the episode (AC5)', async () => {
    const { manager, nudges, resumes, clearDebounce } = await setup();
    const entry = worker('codex-cli', await transcript('codex-server-overloaded.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());

    const failedAgain = await transcript('codex-server-overloaded.jsonl', codexTurn('retrying', { message: 'Selected model is at capacity. Please try a different model.', codex_error_info: 'server_overloaded' }));
    await stopAgain(manager, entry, failedAgain);
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('API ERROR after its one automatic resume: Selected model is at capacity.');
    clearDebounce();
    await stopAgain(manager, entry, failedAgain);
    await settle();
    expect(nudges()).toHaveLength(1);
    expect(await resumes()).toHaveLength(1);

    await stopAgain(manager, entry, await transcript('codex-server-overloaded.jsonl', codexTurn('Work done.\n\nDONE: recovered')));
    await waitFor(() => expect(nudges()).toHaveLength(2));
    expect(nudges()[1]).toContain('ended: DONE: recovered');
    expect(entry.turnError).toBeNull();
  });

  it('withdraws a resume still queued when the episode closes cleanly, so a stale "continue" is never typed', async () => {
    const { manager, resumes } = await setup();
    const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());

    // The person typed their own prompt; that turn ended cleanly before the resume went out.
    await stopAgain(manager, entry, await transcript('claude-server-error-2.1.283.jsonl', [
      { type: 'user', timestamp: '2026-09-26T01:31:00.000Z', message: { content: 'my own prompt' } },
      { type: 'assistant', timestamp: '2026-09-26T01:33:00.000Z', uuid: 'ok', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good now.' }] } },
    ]));
    await waitFor(async () => expect((await resumes())[0]).toMatchObject({ state: 'dropped', droppedReason: 'episode-closed' }));
  });

  it('withdraws the queued resume when the episode turns into a usage-limit halt, and types nothing into the halt', async () => {
    const { manager, resumes, nudges } = await setup();
    const entry = worker('codex-cli', await transcript('codex-server-overloaded.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(entry.turnError?.resumeItemId).toBeTruthy());

    await stopAgain(manager, entry, await transcript('codex-server-overloaded.jsonl', codexTurn('next', { message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' })));
    await waitFor(async () => expect((await resumes())[0]).toMatchObject({ state: 'dropped', droppedReason: 'episode-closed:usage-limit' }));
    expect(manager.isHaltedByUsageLimit('tab-w')).toBe(true);
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('HALTED by a usage limit');
  });

  it('types no automated prompt into a halted tab, whichever path asks (here a bg --notify self completion)', async () => {
    const { manager, paste } = await setup();
    const entry = worker('codex-cli', await transcript('codex-usage-limit-exceeded.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(manager.isHaltedByUsageLimit('tab-w')).toBe(true));
    await waitFor(() => expect(paste).toHaveBeenCalledTimes(1)); // the usage-limit nudge, to the orchestrator
    const handle = (manager as unknown as { handleLivenessEvent: (e: unknown) => Promise<void> }).handleLivenessEvent.bind(manager);
    await handle({ kind: 'bg-completed', job: { workspaceId: 'ws-1', tabId: 'tab-w', pid: 7, label: 'gate', registeredAt: 0, notify: 'self' }, exitCode: 0, stderrTail: null });
    expect(paste.mock.calls.map(([session]) => session)).toEqual(['tmux-tab-o']);
  });

  it('alerts the human when a halted tab has no one to nudge (it is the orchestrator itself)', async () => {
    const { manager, paste } = await setup();
    const entry: ITabStatusEntry = { ...worker('codex-cli', await transcript('codex-usage-limit-exceeded.jsonl')), tmuxSession: 'tmux-tab-o', tabName: 'o' };
    manager.registerTab('tab-o', entry);
    manager.updateTabFromHook('tmux-tab-o', 'stop');
    await waitFor(() => expect(alerts.dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review', tabId: 'tab-o' }), expect.anything()));
    expect(paste).not.toHaveBeenCalled();
  });

  it('escalates when the resume cannot even be queued', async () => {
    const { manager, nudges, store } = await setup();
    await fs.mkdir(path.dirname(store.inboxFile()), { recursive: true });
    await fs.writeFile(store.inboxFile(), '{ corrupt');
    const entry = worker('claude-code', await transcript('claude-server-error-2.1.283.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain('(the resume could not be queued)');
  });

  it('escalates once for a held resume queued before a restart (no episode in memory)', async () => {
    const { manager, nudges, store, clearDebounce } = await setup();
    manager.registerTab('tab-w', worker('claude-code', await transcript('claude-authentication-failed.jsonl')));
    const { item } = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-w', dedupeKey: 'old', fields: { resumeId: 'r-oldone1' } });
    manager.handleHeldResume({ ...item, state: 'held', heldReason: 'composer-not-empty (30 refusals)' });
    await waitFor(() => expect(nudges()).toHaveLength(1));
    expect(nudges()[0]).toContain(`resume notice ${item.id} held: composer-not-empty (30 refusals)`);
    clearDebounce();
    manager.handleHeldResume({ ...item, state: 'held' });
    await settle();
    expect(nudges()).toHaveLength(1);
  });

  it('wires the production onInboxHeld listener in getStatusManager', async () => {
    const { StatusManager, getStatusManager } = await import('@/lib/status-manager');
    const held = vi.spyOn(StatusManager.prototype, 'handleHeldResume').mockImplementation(() => {});
    getStatusManager();
    const store = await import('@/lib/inbox-store');
    const { item } = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-w', dedupeKey: 'wire', fields: { resumeId: 'r-wire01' } });
    await store.mutateInbox((s) => ({ state: store.holdInState(s, item.id, 'x', Date.now()), value: null }));
    expect(held).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, state: 'held' }));
    held.mockRestore();
  });

  it('falls back to the human alert when the target itself is halted (shared-account halt)', async () => {
    const { manager, paste } = await setup();
    // The orchestrator halts first …
    manager.registerTab('tab-o', { ...worker('codex-cli', await transcript('codex-usage-limit-exceeded.jsonl')), tmuxSession: 'tmux-tab-o', tabName: 'o' });
    manager.updateTabFromHook('tmux-tab-o', 'stop');
    await waitFor(() => expect(manager.isHaltedByUsageLimit('tab-o')).toBe(true));
    alerts.dispatch.mockClear();
    // … then its worker: the nudge would be withheld, so the human is alerted instead.
    const w = worker('codex-cli', await transcript('codex-usage-limit-exceeded.jsonl'));
    manager.registerTab('tab-w', w);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(alerts.dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'review', tabId: 'tab-w' }), expect.anything()));
    expect(paste).not.toHaveBeenCalled();
  });

  it('ends the halt at a new session start and when the agent exits', async () => {
    const { manager } = await setup();
    const entry = worker('codex-cli', await transcript('codex-usage-limit-exceeded.jsonl'));
    manager.registerTab('tab-w', entry);
    manager.updateTabFromHook('tmux-tab-w', 'stop');
    await waitFor(() => expect(manager.isHaltedByUsageLimit('tab-w')).toBe(true));
    manager.updateTabFromHook('tmux-tab-w', 'session-start');
    expect(manager.isHaltedByUsageLimit('tab-w')).toBe(false);

    const again = worker('codex-cli', await transcript('codex-usage-limit-exceeded.jsonl'));
    manager.registerTab('tab-x', { ...again, tmuxSession: 'tmux-tab-x' });
    manager.updateTabFromHook('tmux-tab-x', 'stop');
    await waitFor(() => expect(manager.isHaltedByUsageLimit('tab-x')).toBe(true));
    const x = manager.getAllForClient()['tab-x'];
    expect(x).toBeTruthy();
    (manager as unknown as { applyCliState: (id: string, e: unknown, s: string, o: unknown) => void })
      .applyCliState('tab-x', (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-x'), 'inactive', { silent: true });
    expect(manager.isHaltedByUsageLimit('tab-x')).toBe(false);
  });

  it('sends no heartbeat to, and counts none against, a halted idle orchestrator', async () => {
    const { manager, paste } = await setup();
    const o: ITabStatusEntry = { ...worker('codex-cli', await transcript('codex-usage-limit-exceeded.jsonl')), tmuxSession: 'tmux-tab-o', tabName: 'o' };
    manager.registerTab('tab-o', o);
    manager.updateTabFromHook('tmux-tab-o', 'stop');
    await waitFor(() => expect(manager.isHaltedByUsageLimit('tab-o')).toBe(true));
    const keeper = manager as unknown as { runOrchestratorKeeper: () => Promise<void>; orchKeeper: Map<string, { beats: number }> };
    const realNow = Date.now;
    try {
      for (const minutes of [0, 11, 22, 33, 44]) {
        Date.now = () => realNow() + minutes * 60_000;
        await keeper.runOrchestratorKeeper();
      }
    } finally {
      Date.now = realNow;
    }
    expect(paste).not.toHaveBeenCalled();
    expect(keeper.orchKeeper.get('ws-1')?.beats ?? 0).toBe(0);
  });
});
