import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';
import type { TTurnMarkerName } from '@/lib/turn-end';
import type { TabEventsTable } from '@/lib/tab-events-store';
import { memoryLedgerTables } from './tab-events-harness';

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspacesCached: vi.fn(),
}));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));
const curator = vi.hoisted(() => ({ onUnmarkedTurnEnd: vi.fn() }));
const needsDecision = vi.hoisted(() => ({
  open: vi.fn(async (_deps: unknown, _stop: unknown): Promise<Record<string, unknown>> => ({ opened: true, itemId: 'nd-0123456789abcdef0123456789abcdef', runId: 'run-a' })),
}));
const alerts = vi.hoisted(() => ({ dispatch: vi.fn(async (_draft: unknown) => {}) }));
const ndDeps = vi.hoisted(() => ({ make: vi.fn(async (): Promise<unknown> => ({})) }));
vi.mock('@/lib/needs-decision-opener', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/needs-decision-opener')>()),
  needsDecisionDeps: ndDeps.make,
  openNeedsDecisionItem: needsDecision.open,
}));

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
vi.mock('@/lib/curator-service', () => ({ curatorOnUnmarkedTurnEnd: curator.onUnmarkedTurnEnd }));
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
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), ...memoryLedgerTables());
  // F6's coordinator window is pinned in coordinator-window.test.ts and status-manager-event-digest.test.ts; these
  // tests pin the turn-end classifier, with the orchestrator as the nudge target only, so they turn the window off.
  (await import('@/lib/coordinator-window')).configureCoordinatorWindow({
    now: () => Date.now(), isCoordinator: async () => false, lastGoverned: () => null, oldestDigestAt: () => null,
  });
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

/** The messages one tmux session was sent. */
const sentTo = (paste: { mock: { calls: unknown[][] } }, session: string): string[] =>
  paste.mock.calls.filter(([target]) => target === session).map(([, message]) => message as string);

/** The events routed to the asking tab itself: its NEEDS-DECISION notices (story 36). */
const askerEvents = (manager: object) =>
  (manager as unknown as { tabEvents: { deps: { table: () => TabEventsTable } } })
    .tabEvents.deps.table().list('ws-1', { tabId: 'worker', since: 0, limit: 50 })
    .map((row) => ({ kind: row.kind, class: row.class, delivered: row.deliveredAt !== null }));

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
    delete (globalThis as { __ptNeedsDecisionPushes?: unknown }).__ptNeedsDecisionPushes;
    delete (globalThis as { __ptNeedsDecisionAskerNotices?: unknown }).__ptNeedsDecisionAskerNotices;
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

  // ADR-0025: a tab's reportOn narrows which end lines leave it. The stop is still
  // classified and recorded; only the push is withheld, and no idle nudge follows.
  describe('reportOn (ADR-0025)', () => {
    const CHECKPOINT = 'CHECKPOINTED: inc 3 receipted; next is its landing';

    it('withholds a CHECKPOINTED line from a tab set to DONE,BLOCKED and counts it, recording the stop as usual', async () => {
      const { manager, paste } = await managerWithPaste();
      const entry = { ...worker('claude-code', await writeLines('claude/cp.jsonl', [claudeEnd(`Gate green.\n\n${CHECKPOINT}`)])), reportOn: ['DONE', 'BLOCKED'] as TTurnMarkerName[] };
      manager.registerTab('worker', entry );

      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(entry.cliState).toBe('ready-for-review'));
      await settle();

      expect(paste).not.toHaveBeenCalled();
      expect(entry.turnEnd).toMatchObject({ kind: 'turn-marker', marker: [CHECKPOINT] });
      expect(manager.getOrchestrationNudges('ws-1')).toEqual([]);
      expect(manager.getReportOnFilteredCount()).toBe(1);
    });

    it('still forwards a marker inside the list, verbatim', async () => {
      const { manager, paste } = await managerWithPaste();
      const entry = { ...worker('claude-code', await writeLines('claude/bl.jsonl', [claudeEnd(`Gate r2 failed on lint.\n\n${BLOCKED}`)])), reportOn: ['DONE', 'BLOCKED'] as TTurnMarkerName[] };
      manager.registerTab('worker', entry );

      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));

      expect(paste).toHaveBeenCalledWith(
        'tmux-root',
        `[orchestrator-watchdog] worker worker (w1) ended: ${BLOCKED} — read with: purplemux tab result -w ws-1 worker`,
      );
      expect(manager.getReportOnFilteredCount()).toBe(0);
    });

    it('opens a Mission Control item for a NEEDS-DECISION end, even when reportOn withholds the nudge (ADR-0041)', async () => {
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: [scope] Is the export in this epic? (a) yes (b) no';
      const entry = { ...worker('claude-code', await writeLines('claude/nd.jsonl', [claudeEnd(`Built what I can.\n\n${line}`)])), reportOn: ['DONE'] as TTurnMarkerName[], busySince: 1234 };
      manager.registerTab('worker', entry);

      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(needsDecision.open).toHaveBeenCalledTimes(1));
      await settle();

      expect(needsDecision.open.mock.calls[0]).toEqual([{}, {
        workspaceId: 'ws-1', tabId: 'worker', tabName: 'w1', line, lineComplete: true, stopSeq: entry.turnEnd!.seq, stopAt: entry.turnEnd!.at, turnStartedAt: 1234,
      }]);
      // Review r1 finding 4: the marker is held back from root, so the asker itself learns the item.
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      expect(sentTo(paste, 'tmux-root')).toEqual([]);
      expect(sentTo(paste, 'tmux-worker')).toEqual([
        '[needs-decision] [MC item nd-0123456789abcdef0123456789abcdef opened for the owner by the server: do not open another] Name this id while you wait; the owner\'s answer arrives through Mission Control.',
      ]);
      expect(manager.getReportOnFilteredCount()).toBe(1);
    });

    it('the nudge names the Mission Control item, so the orchestrator never copies the question (R1)', async () => {
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Is the export in this epic?';
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/nd2.jsonl', [claudeEnd(`Stuck.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      expect(paste).toHaveBeenCalledWith('tmux-root',
        `[orchestrator-watchdog] worker worker (w1) ended: ${line} [MC item nd-0123456789abcdef0123456789abcdef opened for the owner by the server: do not open another] — read with: purplemux tab result -w ws-1 worker`);
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'already-open', itemId: 'nd-0123456789abcdef0123456789abcdef' });
      const { manager: m2, paste: p2 } = await managerWithPaste();
      m2.registerTab('worker', worker('claude-code', await writeLines('claude/nd3.jsonl', [claudeEnd(`Still stuck.\n\n${line}`)])));
      m2.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(p2).toHaveBeenCalledTimes(1));
      expect(p2.mock.calls[0][1]).toContain(`${line} [MC item nd-0123456789abcdef0123456789abcdef already open for the owner: do not open another] — read with`);
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'asked-this-turn', itemId: 'q-own' });
      const { manager: m3, paste: p3 } = await managerWithPaste();
      m3.registerTab('worker', worker('claude-code', await writeLines('claude/nd3b.jsonl', [claudeEnd(`Asked.\n\n${line}`)])));
      m3.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(p3).toHaveBeenCalledTimes(1));
      expect(p3.mock.calls[0][1]).toContain(`${line} [MC item q-own opened by the tab this turn: handle it as any worker item] — read with`);
      await settle();
      expect([...sentTo(paste, 'tmux-worker'), ...sentTo(p2, 'tmux-worker'), ...sentTo(p3, 'tmux-worker')]).toEqual([]);
    });

    it('a revised item: the nudge names it, and the asker hears what its line replaced even though the nudge went out (PM-2, D50)', async () => {
      const ITEM = 'nd-0123456789abcdef0123456789abcdef';
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'revised', itemId: ITEM, revision: 3, replaced: 'Is the export in scope?' });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Does the export belong to this epic?';
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/pm2-rev.jsonl', [claudeEnd(`Reworded.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(2));
      expect(sentTo(paste, 'tmux-root')).toEqual([
        `[orchestrator-watchdog] worker worker (w1) ended: ${line} [MC item ${ITEM} revised for the owner by the server (revision 3): do not open another] — read with: purplemux tab result -w ws-1 worker`,
      ]);
      expect(sentTo(paste, 'tmux-worker')).toEqual([
        `[needs-decision] [MC item ${ITEM} revised for the owner by the server: do not open another] Your line replaced the question "Is the export in scope?"; the owner no longer sees it. If yours is a different question, ask the replaced one again in its own item: end on NEEDS-DECISION: [new] <the replaced question, in new words>? (its old line stays item ${ITEM}'s).`,
      ]);
    });

    it('an answered item: nothing opens, the nudge says relay the answer, and the asker gets the answer again (PM-2, D51)', async () => {
      const ITEM = 'nd-00112233445566778899aabbccddeeff';
      const answeredAt = Date.UTC(2026, 10, 6, 23, 35, 23);
      needsDecision.open.mockResolvedValueOnce({
        opened: false, reason: 'answered', itemId: ITEM, differs: false, question: 'Keep QA bank lines fixed?',
        answer: { answeredAt, optionIds: ['b'], optionLabels: ['keep'], text: '', delivery: { state: 'acknowledged', reason: null, tabId: 'root' } },
      });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Keep QA bank lines fixed? (a) reload (b) keep';
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/pm2-ans.jsonl', [claudeEnd(`Waiting.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(2));
      expect(sentTo(paste, 'tmux-root')[0]).toContain(`${line} [MC item ${ITEM} already answered by the owner: no new item; relay the answer] — read with`);
      expect(sentTo(paste, 'tmux-worker')).toEqual([
        `[needs-decision] [MC item ${ITEM} answered by the owner at 2026-11-06T23:35:23.000Z: do not open another] The answer: (b) keep. It went to root (delivery acknowledged), which relays it. Act on this answer: this question opens no new item until 2026-11-07T23:35:23.000Z, with or without [new]. If something has changed since the answer, ask a new question that says what changed: end on NEEDS-DECISION: [new] <question>?`,
      ]);
      expect(pushes()).toEqual([]);
      // A held delivery, and a line that differs: the note and the notice say so, and quote the answered question.
      needsDecision.open.mockResolvedValueOnce({
        opened: false, reason: 'answered', itemId: ITEM, differs: true, question: 'Keep QA bank lines fixed?',
        answer: { answeredAt, optionIds: [], optionLabels: [], text: 'x'.repeat(250), delivery: { state: 'held', reason: 'bound-agent-not-live', tabId: 'root' } },
      });
      const { manager: m2, paste: p2 } = await managerWithPaste();
      m2.registerTab('worker', worker('claude-code', await writeLines('claude/pm2-ans2.jsonl', [claudeEnd('Waiting.\n\nNEEDS-DECISION: Freeze QA lines? (a) yes (b) no')])));
      m2.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(p2).toHaveBeenCalledTimes(2));
      expect(sentTo(p2, 'tmux-root')[0]).toContain(`[MC item ${ITEM} already answered by the owner: no new item; delivery held: bound-agent-not-live]`);
      const notice = sentTo(p2, 'tmux-worker')[0];
      expect(notice).toContain('Your line differs from that item\'s question "Keep QA bank lines fixed?"; the owner answered that one.');
      expect(notice).toContain(`(clipped; the whole answer is in item ${ITEM} and your orchestrator's relay). Delivery held: bound-agent-not-live.`);
    });

    it('a held [new] line: the note reaches the orchestrator whatever the reportOn, and the asker hears it too (PM-2 r2, ruling A)', async () => {
      const P = 'nd-ffeeddccbbaa99887766554433221100';
      needsDecision.open.mockResolvedValueOnce({
        opened: false, reason: 'already-open', itemId: P, heldNew: true, newHeldBy: { itemId: P, answered: false, question: 'Pay the vendor today?' },
      });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: [new] Which bank file wins? (a) BC (b) Kyriba';
      manager.registerTab('worker', { ...worker('claude-code', await writeLines('claude/pm2-held.jsonl', [claudeEnd(`Next.\n\n${line}`)])), reportOn: ['DONE'] as TTurnMarkerName[] });
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(2));
      expect(sentTo(paste, 'tmux-root')).toEqual([
        `[orchestrator-watchdog] worker worker (w1) ended: ${line} [MC item ${P} already open for the owner: do not open another; this [new] line is held and is not in Mission Control: the tab's [new] question ${P} is still open] — read with: purplemux tab result -w ws-1 worker`,
      ]);
      expect(sentTo(paste, 'tmux-worker')).toEqual([
        `[needs-decision] [MC item ${P} already open for the owner: do not open another] Your [new] line opened nothing and changed nothing. This tab's [new] question ${P} is still open ("Pay the vendor today?"), and a tab has one [new] question at a time. If your line rewords that question, end on that item's line unchanged. If it is a different question, it is not in Mission Control yet: end on it again with [new] after ${P} is answered and its answer acknowledged.`,
      ]);
      expect(manager.getReportOnFilteredCount()).toBe(0);
      expect(pushes()).toEqual([]);
      // Held until an answer is acknowledged: the answered note says so, and it too reaches the orchestrator.
      const answeredAt = Date.UTC(2026, 10, 7, 1, 0, 0);
      needsDecision.open.mockResolvedValueOnce({
        opened: false, reason: 'answered', itemId: P, differs: true, question: 'Pay the vendor today?', heldNew: true,
        newHeldBy: { itemId: P, answered: true, question: 'Pay the vendor today?' },
        answer: { answeredAt, optionIds: ['a'], optionLabels: ['pay'], text: '', delivery: { state: 'submitted', reason: null, tabId: 'root' } },
      });
      const { manager: m2, paste: p2 } = await managerWithPaste();
      m2.registerTab('worker', { ...worker('claude-code', await writeLines('claude/pm2-held2.jsonl', [claudeEnd(`Next.\n\n${line}`)])), reportOn: ['DONE'] as TTurnMarkerName[] });
      m2.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(p2).toHaveBeenCalledTimes(2));
      expect(sentTo(p2, 'tmux-root')[0]).toContain(`${line} [MC item ${P} already answered by the owner: no new item; this [new] line is held until that answer is acknowledged; relay the answer] — read with`);
      expect(sentTo(p2, 'tmux-worker')).toEqual([
        `[needs-decision] [MC item ${P} answered by the owner at 2026-11-07T01:00:00.000Z: do not open another] Your [new] line opened nothing: the owner answered this tab's [new] question "Pay the vendor today?", and its answer is not yet acknowledged. The answer: (a) pay. It went to root (delivery submitted), which relays it. A different question cannot open yet: the owner answered this tab's [new] question ${P}, and the answer is not yet acknowledged. End on your [new] line again once it is (your orchestrator acknowledges it when it relays it).`,
      ]);
      expect(m2.getReportOnFilteredCount()).toBe(0);
    });

    it('hands the opener the whole last line, not the marker line clipped at 300 chars (R2)', async () => {
      const { manager } = await managerWithPaste();
      const line = `NEEDS-DECISION: ${'which rule do we ship '.repeat(14)}? (a) base currency (b) transaction currency (c) defer`;
      expect(line.length).toBeGreaterThan(300);
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/nd4.jsonl', [claudeEnd(`Done.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(needsDecision.open).toHaveBeenCalledTimes(1));
      expect(needsDecision.open.mock.calls[0][1]).toMatchObject({ line, lineComplete: true });
    });

    const ID = 'nd-0123456789abcdef0123456789abcdef';
    /** What the asker is told when no item opened (story 36, D1). */
    const notOpened = (reason: string, fate: string, extra = '') =>
      `[needs-decision] item-not-opened: ${reason}. Your NEEDS-DECISION line opened no Mission Control item; ${fate}. Its id would be ${ID}.${extra}`;
    const ORCH_TAIL = ` You are the orchestrator: resume or start your Mission Control run, then open item ${ID} from your line with your human review.`;
    const pushes = () => alerts.dispatch.mock.calls.map(([draft]) => draft as { kind: string; title: string; body: string; tabId: string; workspaceId: string })
      .filter((draft) => draft.kind === 'needs-decision');
    /** Workspace ws-1 with no orchestrator. The worker has no reportsTo (D28: a reportsTo tab never opens an owner item), so no nudge goes out and the asker hears the note. */
    const noOrchestrator = () => {
      const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value] };
      workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
      workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
    };

    it('(i): a live orchestrator with no run is told to open item <id>, even when reportOn withholds NEEDS-DECISION; no owner push', async () => {
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'no-orchestrator-run', itemId: ID, detail: 'root' });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      manager.registerTab('worker', { ...worker('claude-code', await writeLines('claude/nd5.jsonl', [claudeEnd(`Ok.\n\n${line}`)])), reportOn: ['DONE'] as TTurnMarkerName[] });
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(2));
      expect(sentTo(paste, 'tmux-worker')).toEqual([notOpened('no-orchestrator-run (root)', 'your orchestrator root was told to open it and holds the line now: do not repeat the line')]);
      expect(sentTo(paste, 'tmux-root')[0]).toBe(`[orchestrator-watchdog] worker worker (w1) ended: ${line} [no MC item (no-orchestrator-run): open it yourself: resume or start your Mission Control run, then open item ${ID} from this line with your human review. The owner has not been told.] — read with: purplemux tab result -w ws-1 worker`);
      expect(pushes()).toEqual([]);
    });

    it('(i): an opener that cannot load still takes the fallback, with reason error (confirm D2)', async () => {
      ndDeps.make.mockRejectedValueOnce(new Error('store unavailable'));
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/nd5e.jsonl', [claudeEnd(`Ok.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(2));
      expect(sentTo(paste, 'tmux-worker')[0]).toMatch(/^\[needs-decision\] item-not-opened: error \(store unavailable\)\. Your NEEDS-DECISION line opened no Mission Control item; your orchestrator root was told to open it and holds the line now: do not repeat the line\. Its id would be nd-[0-9a-f]{32}\.$/);
      expect(sentTo(paste, 'tmux-root')[0]).toMatch(/ \[no MC item \(error\): open it yourself: resume or start your Mission Control run, then open item nd-[0-9a-f]{32} from this line with your human review\. The owner has not been told\.\] — read with/);
      expect(needsDecision.open).not.toHaveBeenCalled();
    });

    it('(ii): no orchestrator: one needs-decision push with the fixed title, a body that starts `<tab> · <workspace>: `, and the note', async () => {
      noOrchestrator();
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'no-orchestrator', itemId: ID });
      const { manager, paste } = await managerWithPaste();
      const line = `NEEDS-DECISION: [money] Pay the vendor the €${'9'.repeat(5)} invoice today or wait for the credit note that ${'x'.repeat(80)}?`;
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/nd6.jsonl', [claudeEnd(`Ok.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      expect(sentTo(paste, 'tmux-worker')).toEqual([notOpened('no-orchestrator', 'owner push dispatched, delivery not confirmed')]);
      expect(sentTo(paste, 'tmux-root')).toEqual([]);
      const [push] = pushes();
      expect(pushes()).toHaveLength(1);
      expect(push).toMatchObject({ title: 'Decision needed: no Mission Control item', tabId: 'worker', workspaceId: 'ws-1' });
      // The push means "no item opened": it never names one, so the phone opens the tab, not an item (story 37 review).
      expect(push).not.toHaveProperty('itemId');
      expect(push.body).toBe(`w1 · ws: Pay the vendor the €99999 invoice today or wait for the credit note that ${'x'.repeat(80)}?`);
    });

    it('(ii): the same line on a later turn sends no second push; the note says `already dispatched at`', async () => {
      noOrchestrator();
      needsDecision.open.mockResolvedValue({ opened: false, reason: 'no-orchestrator', itemId: ID });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      const entry = worker('claude-code', await writeLines('claude/nd7.jsonl', [claudeEnd(`Ok.\n\n${line}`)]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      // The asker's own notice is once a day per line; forget it, so the second stop shows the fate it carries.
      delete (globalThis as { __ptNeedsDecisionAskerNotices?: unknown }).__ptNeedsDecisionAskerNotices;
      manager.updateTabFromHook('tmux-worker', 'prompt-submit');
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(2));
      await settle();
      expect(sentTo(paste, 'tmux-root')).toEqual([]);
      expect(sentTo(paste, 'tmux-worker')[1]).toMatch(/; owner push for this line already dispatched at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\. Its id would be /);
      expect(pushes()).toHaveLength(1);
      needsDecision.open.mockReset();
      needsDecision.open.mockImplementation(async () => ({ opened: true, itemId: ID, runId: 'run-a' }));
    });

    it('(ii): a dispatch that never settles does not hold the stop: the tab reaches ready-for-review and the asker is told', async () => {
      noOrchestrator();
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'no-orchestrator', itemId: ID });
      alerts.dispatch.mockImplementationOnce(() => new Promise(() => {}));
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      const entry = worker('claude-code', await writeLines('claude/nd8.jsonl', [claudeEnd(`Ok.\n\n${line}`)]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(sentTo(paste, 'tmux-worker')).toHaveLength(1));
      expect(entry.cliState).toBe('ready-for-review');
      expect(sentTo(paste, 'tmux-worker')[0]).toContain('owner push dispatched, delivery not confirmed');
    });

    const askerIsOrchestrator = () => {
      const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value], orchestration: { enabled: true, orchestratorTabId: 'worker' } };
      workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
    };

    it('(ii) D1 (a): the asking tab is the orchestrator and it has no run -> push, and the asker hears item-not-opened, urgent', async () => {
      askerIsOrchestrator();
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'no-orchestrator-run', itemId: ID, detail: 'worker' });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      const entry = worker('claude-code', await writeLines('claude/nd9.jsonl', [claudeEnd(`Ok.\n\n${line}`)]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(pushes()).toHaveLength(1));
      expect(pushes()[0]).toMatchObject({ title: 'Decision needed: no Mission Control item', body: 'w1 · ws: Ship it?' });
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      expect(paste).toHaveBeenCalledWith('tmux-worker',
        notOpened('no-orchestrator-run (worker)', 'owner push dispatched, delivery not confirmed', ORCH_TAIL));
      expect(askerEvents(manager)).toEqual([{ kind: 'mission', class: 'urgent', delivered: true }]);
    });

    it('D1 (b): a run is present and the asker has no escalation target: it learns the nd- id', async () => {
      askerIsOrchestrator();
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/nd10.jsonl', [claudeEnd(`Ok.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      expect(paste).toHaveBeenCalledWith('tmux-worker',
        `[needs-decision] [MC item ${ID} opened for the owner by the server: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control.`);
      expect(pushes()).toEqual([]);
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'already-open', itemId: ID });
      const { manager: m2, paste: p2 } = await managerWithPaste();
      delete (globalThis as { __ptNeedsDecisionAskerNotices?: unknown }).__ptNeedsDecisionAskerNotices;
      m2.registerTab('worker', worker('claude-code', await writeLines('claude/nd10b.jsonl', [claudeEnd(`Still.\n\n${line}`)])));
      m2.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(p2).toHaveBeenCalledTimes(1));
      expect(p2.mock.calls[0][1]).toBe(
        `[needs-decision] [MC item ${ID} already open for the owner: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control.`);
    });

    it('D1 (c): no orchestrator and no reportsTo: the push fires and the asker is told', async () => {
      noOrchestrator();
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'no-orchestrator', itemId: ID });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/nd11.jsonl', [claudeEnd(`Ok.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      expect(paste).toHaveBeenCalledWith('tmux-worker', notOpened('no-orchestrator', 'owner push dispatched, delivery not confirmed'));
      expect(pushes()).toHaveLength(1);
    });

    it.each(['refused', 'error'])('D1: reason %s reaches the asker too, with its detail', async (reason) => {
      askerIsOrchestrator();
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason, itemId: ID, detail: 'the store said no' });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      manager.registerTab('worker', worker('claude-code', await writeLines(`claude/nd12-${reason}.jsonl`, [claudeEnd(`Ok.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      expect(paste).toHaveBeenCalledWith('tmux-worker',
        notOpened(`${reason} (the store said no)`, 'owner push dispatched, delivery not confirmed', ORCH_TAIL));
    });

    it.each(['no-orchestrator-run', 'refused', 'error'])('D1 (e): %s, then opened, for one line: both notices go out; a repeat after the open sends nothing new', async (reason) => {
      askerIsOrchestrator();
      needsDecision.open
        .mockResolvedValueOnce({ opened: false, reason, itemId: ID, detail: 'worker' })
        .mockResolvedValueOnce({ opened: true, itemId: ID, runId: 'run-a' })
        .mockResolvedValueOnce({ opened: false, reason: 'already-open', itemId: ID });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      manager.registerTab('worker', worker('claude-code', await writeLines(`claude/nd14-${reason}.jsonl`, [claudeEnd(`Ok.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      for (const count of [2, 3]) {
        manager.updateTabFromHook('tmux-worker', 'prompt-submit');
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(needsDecision.open).toHaveBeenCalledTimes(count));
        await settle();
      }
      const told = sentTo(paste, 'tmux-worker');
      expect(told).toHaveLength(2);
      expect(told[0]).toContain(`item-not-opened: ${reason}`);
      expect(told[0]).toContain(`Its id would be ${ID}.`);
      expect(told[1]).toBe(`[needs-decision] [MC item ${ID} opened for the owner by the server: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control.`);
    });

    // #521 review r1, 1: an already-open outcome (also from a racing open the store refused) means the owner was told.
    it('already-open with no orchestrator: no owner push and no "open it yourself" note; the asker learns the open item', async () => {
      noOrchestrator();
      needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'already-open', itemId: ID });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/nd521b.jsonl', [claudeEnd(`Ok.\n\n${line}`)])));
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      await settle();
      expect(pushes()).toEqual([]);
      expect(sentTo(paste, 'tmux-root')).toEqual([]);
      expect(sentTo(paste, 'tmux-worker')).toEqual([
        `[needs-decision] [MC item ${ID} already open for the owner: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control.`]);
    });

    // #521 AC 3: the repeat filter holds back a second nudge of the same marker, and with it the changed note.
    it('a tab already ready-for-review that ends on the same marker again: the repeat filter holds the nudge, so the asker hears the changed note', async () => {
      needsDecision.open
        .mockResolvedValueOnce({ opened: false, reason: 'no-orchestrator-run', itemId: ID, detail: 'root' })
        .mockResolvedValueOnce({ opened: true, itemId: ID, runId: 'run-a' });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      const entry = worker('claude-code', await writeLines('claude/nd521.jsonl', [claudeEnd(`Ok.\n\n${line}`)]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(sentTo(paste, 'tmux-root')).toHaveLength(1));
      expect(sentTo(paste, 'tmux-root')[0]).toContain(`[no MC item (no-orchestrator-run): open it yourself: resume or start your Mission Control run, then open item ${ID}`);
      await waitFor(() => expect(sentTo(paste, 'tmux-worker')).toHaveLength(1));
      expect(entry.cliState).toBe('ready-for-review');
      // A second stop of the same marker, no prompt between: the item opened now, and the nudge is a repeat.
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(needsDecision.open).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(sentTo(paste, 'tmux-worker')).toHaveLength(2));
      await settle();
      expect(sentTo(paste, 'tmux-root')).toHaveLength(1);
      expect(sentTo(paste, 'tmux-worker')[1]).toBe(
        `[needs-decision] [MC item ${ID} opened for the owner by the server: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control.`);
      needsDecision.open.mockReset();
      needsDecision.open.mockImplementation(async () => ({ opened: true, itemId: ID, runId: 'run-a' }));
    });

    it('D1 (d): the same line again inside 24 h tells the asker nothing new; after 24 h it is told again', async () => {
      askerIsOrchestrator();
      needsDecision.open.mockResolvedValue({ opened: false, reason: 'no-orchestrator-run', itemId: ID, detail: 'worker' });
      const { manager, paste } = await managerWithPaste();
      const line = 'NEEDS-DECISION: Ship it?';
      manager.registerTab('worker', worker('claude-code', await writeLines('claude/nd13.jsonl', [claudeEnd(`Ok.\n\n${line}`)])));
      const stopAgain = async (count: number) => {
        manager.updateTabFromHook('tmux-worker', 'prompt-submit');
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(needsDecision.open).toHaveBeenCalledTimes(count));
        await settle();
      };
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      await stopAgain(2);
      expect(paste).toHaveBeenCalledTimes(1);
      const notices = (globalThis as { __ptNeedsDecisionAskerNotices?: Map<string, number> }).__ptNeedsDecisionAskerNotices!;
      expect(notices.size).toBe(1);
      const [key] = [...notices.keys()];
      notices.set(key, Date.now() - 24 * 60 * MIN - 1);
      await stopAgain(3);
      expect(paste).toHaveBeenCalledTimes(2);
      expect(paste.mock.calls[1][1]).toContain('item-not-opened: no-orchestrator-run (worker)');
      needsDecision.open.mockReset();
      needsDecision.open.mockImplementation(async () => ({ opened: true, itemId: ID, runId: 'run-a' }));
    });

    describe('D28: a reportsTo tab asks its reportsTo; one marker per end line; no question, no item', () => {
      const D28 = 'NEEDS-DECISION: is not mine to send — ORCH holds it. CHECKPOINTED: /home/mdone/.local/share/v2-scope/HANDOFF-SO9-1103.md …';
      const ROUTED = ' [no owner item: this tab reports to root, so its NEEDS-DECISION is answered by you, never sent to the owner (SO-6); answer it, or ask the owner on your own end line]';

      it('a tab with reportsTo: no owner item and no push; the nudge goes to its reportsTo whatever its reportOn', async () => {
        const { manager, paste } = await managerWithPaste();
        const line = 'NEEDS-DECISION: Ship it?';
        manager.registerTab('worker', { ...worker('claude-code', await writeLines('claude/d28a.jsonl', [claudeEnd(`Ok.\n\n${line}`)])), reportsTo: 'root', reportOn: ['DONE'] as TTurnMarkerName[] });
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
        await settle();
        expect(needsDecision.open).not.toHaveBeenCalled();
        expect(pushes()).toEqual([]);
        expect(sentTo(paste, 'tmux-root')).toEqual([`[orchestrator-watchdog] worker worker (w1) ended: ${line}${ROUTED} — read with: purplemux tab result -w ws-1 worker`]);
        expect(sentTo(paste, 'tmux-worker')).toEqual([]);
        expect(manager.getReportOnFilteredCount()).toBe(0);
      });

      it('a tab with no reportsTo still opens the owner item from the same line', async () => {
        askerIsOrchestrator();
        const { manager, paste } = await managerWithPaste();
        manager.registerTab('worker', worker('claude-code', await writeLines('claude/d28b.jsonl', [claudeEnd('Ok.\n\nNEEDS-DECISION: Ship it?')])));
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
        expect(needsDecision.open).toHaveBeenCalledTimes(1);
        expect(sentTo(paste, 'tmux-worker')[0]).toContain(`[MC item ${ID} opened for the owner by the server`);
      });

      it('the D28 line from v2-scope opens nothing: two markers on one line are no end line', async () => {
        const { manager, paste } = await managerWithPaste();
        const entry = { ...worker('claude-code', await writeLines('claude/d28c.jsonl', [claudeEnd(`Scope pass done.\n\n${D28}`)])), tabName: 'v2-scope', reportsTo: 'root' };
        manager.registerTab('worker', entry);
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(entry.cliState).toBe('ready-for-review'));
        await settle();
        expect(needsDecision.open).not.toHaveBeenCalled();
        expect(pushes()).toEqual([]);
        expect(paste).not.toHaveBeenCalled();
        expect(entry.turnEnd).toMatchObject({ kind: 'ready-for-review' });
      });

      // Review r1, finding 1: a question never vanishes. A reportsTo that cannot take it hands it to a live orchestrator,
      // and with none, the owner item opens as before, with the reason in it.
      const lead = (halted: boolean): ITabStatusEntry => ({
        cliState: 'idle', workspaceId: 'ws-1', tabName: 'lead', tmuxSession: 'tmux-lead', panelType: 'claude-code',
        ...(halted ? { turnError: { class: 'usage-limit' as const, code: 'usage_limit_exceeded', text: 'limit', startedAt: 0, resumeItemId: null, escalated: false } } : {}),
      });
      const FALLBACK = (target: string) => `reports-to target unavailable: ${target} is gone or halted, and no live orchestrator can take it`;
      const BY_ORCH = (target: string) => ` [no owner item: this tab reports to ${target}, so its NEEDS-DECISION is answered by you, the orchestrator (${target} cannot take it), never sent to the owner (SO-6); answer it, or ask the owner on your own end line]`;

      it.each([
        ['a dead reportsTo', 'tab-gone', false],
        ['a reportsTo halted by a usage limit', 'lead', true],
      ])('%s with a live orchestrator: the orchestrator gets the question, no owner item', async (_name, target, halted) => {
        const { manager, paste } = await managerWithPaste();
        if (target === 'lead') manager.registerTab('lead', lead(halted));
        const line = 'NEEDS-DECISION: Ship it?';
        manager.registerTab('worker', { ...worker('claude-code', await writeLines(`claude/d28g-${target}.jsonl`, [claudeEnd(`Ok.\n\n${line}`)])), reportsTo: target, reportOn: ['DONE'] as TTurnMarkerName[] });
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
        await settle();
        expect(needsDecision.open).not.toHaveBeenCalled();
        expect(pushes()).toEqual([]);
        expect(sentTo(paste, 'tmux-root')).toEqual([`[orchestrator-watchdog] worker worker (w1) ended: ${line}${BY_ORCH(target)} — read with: purplemux tab result -w ws-1 worker`]);
        expect(sentTo(paste, 'tmux-lead')).toEqual([]);
      });

      it.each([
        ['a dead reportsTo, no orchestrator', 'tab-gone', 'none'],
        ['a halted reportsTo, no orchestrator', 'lead', 'none'],
        ['a dead reportsTo, the configured orchestrator not live', 'tab-gone', 'inactive'],
      ])('%s: today\'s owner item opens, with "reports-to target unavailable" in it', async (_name, target, orchestrator) => {
        if (orchestrator === 'none') noOrchestrator();
        needsDecision.open.mockResolvedValueOnce({ opened: true, itemId: ID, runId: 'run-a' });
        const { manager, paste } = await managerWithPaste();
        if (orchestrator === 'inactive') manager.registerTab('root', { cliState: 'inactive', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
        if (target === 'lead') manager.registerTab('lead', lead(true));
        const line = 'NEEDS-DECISION: Ship it?';
        manager.registerTab('worker', { ...worker('claude-code', await writeLines(`claude/d28h-${target}-${orchestrator}.jsonl`, [claudeEnd(`Ok.\n\n${line}`)])), reportsTo: target });
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(needsDecision.open).toHaveBeenCalledTimes(1));
        expect(needsDecision.open.mock.calls[0][1]).toMatchObject({ line, fallbackReason: FALLBACK(target) });
        // The item note rides the nudge to the configured orchestrator's tab, or reaches the asker when there is none.
        const noteReader = orchestrator === 'none' ? 'tmux-worker' : 'tmux-root';
        await waitFor(() => expect(sentTo(paste, noteReader)).toHaveLength(1));
        expect(sentTo(paste, noteReader)[0]).toContain(`[MC item ${ID} opened for the owner by the server`);
        expect(sentTo(paste, 'tmux-lead')).toEqual([]);
      });

      it('no question mark: the server refuses the item, sends no push and no "open it yourself" note', async () => {
        needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'no-question' });
        const { manager, paste } = await managerWithPaste();
        const line = 'NEEDS-DECISION: is not mine to send — ORCH holds it.';
        manager.registerTab('worker', worker('claude-code', await writeLines('claude/d28e.jsonl', [claudeEnd(`Ok.\n\n${line}`)])));
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
        await settle();
        expect(needsDecision.open.mock.calls[0][1]).toMatchObject({ line });
        expect(pushes()).toEqual([]);
        expect(sentTo(paste, 'tmux-root')).toEqual([`[orchestrator-watchdog] worker worker (w1) ended: ${line} [no MC item: the NEEDS-DECISION line holds no question mark, so the server opened nothing and told no one] — read with: purplemux tab result -w ws-1 worker`]);
        expect(sentTo(paste, 'tmux-worker')).toEqual([]);
      });

      it('no question mark from the orchestrator itself: no push, and it is told why', async () => {
        askerIsOrchestrator();
        needsDecision.open.mockResolvedValueOnce({ opened: false, reason: 'no-question' });
        const { manager, paste } = await managerWithPaste();
        manager.registerTab('worker', worker('claude-code', await writeLines('claude/d28f.jsonl', [claudeEnd('Ok.\n\nNEEDS-DECISION: pick one (a) keep (b) revert')])));
        manager.updateTabFromHook('tmux-worker', 'stop');
        await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
        expect(pushes()).toEqual([]);
        expect(sentTo(paste, 'tmux-worker')[0]).toMatch(/^\[needs-decision\] item-not-opened: no-question\. /);
      });
    });

    it('reads a wrapped DONE line as the end line: the nudge carries it joined (story 09, hfl-36 fixture)', async () => {
      const { manager, paste } = await managerWithPaste();
      const first = 'DONE: story 36 carries done (asker notice, one id per line key, the push body at 400 code points);';
      const second = 'gate 36-r4 VALID TREE_START=4b1c0e9 TREE_END=4b1c0e9; not committed.';
      const entry = worker('claude-code', await writeLines('claude/wrap.jsonl', [claudeEnd(`Gate log read.\n\n${first}\n${second}`)]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      expect(paste).toHaveBeenCalledWith('tmux-root', `[orchestrator-watchdog] worker worker (w1) ended: ${first} ${second} — read with: purplemux tab result -w ws-1 worker`);
      expect(entry.turnEnd).toMatchObject({ kind: 'turn-marker', marker: [`${first} ${second}`] });
    });

    it('opens no item for another end line', async () => {
      const { manager, paste } = await managerWithPaste();
      const entry = worker('claude-code', await writeLines('claude/bl2.jsonl', [claudeEnd(`Gate red.\n\n${BLOCKED}`)]));
      manager.registerTab('worker', entry);
      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
      await settle();
      expect(needsDecision.open).not.toHaveBeenCalled();
    });

    it('sends no idle nudge after a withheld marker: the stop had an end line', async () => {
      const { manager, paste } = await managerWithPaste();
      const entry = { ...worker('claude-code', await writeLines('claude/cp2.jsonl', [claudeEnd(`Gate green.\n\n${CHECKPOINT}`)])), reportOn: ['DONE'] as TTurnMarkerName[] };
      manager.registerTab('worker', entry );

      manager.updateTabFromHook('tmux-worker', 'stop');
      await waitFor(() => expect(entry.cliState).toBe('ready-for-review'));
      await settle();
      const at = entry.turnEnd!.at;
      await (manager as unknown as { runWatchdogTimers: (n: number) => Promise<void> }).runWatchdogTimers(at + 16 * MIN);

      expect(paste).not.toHaveBeenCalled();
      expect(manager.getOrchestrationNudges('ws-1')).toEqual([]);
    });
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

  it('hands a stop with no end line to the curator, in shadow, with its tail; a marker stop never (ADR-0038 §2)', async () => {
    const { manager } = await managerWithPaste();
    const entry = worker('claude-code', await writeLines('claude/s.jsonl', [claudeEnd('Fixed.\nShall I merge it?')]));
    manager.registerTab('worker', entry);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(curator.onUnmarkedTurnEnd).toHaveBeenCalledWith('ws-1', 'worker', 'Fixed.\nShall I merge it?', null));
    const marked = worker('claude-code', await writeLines('claude/m.jsonl', [claudeEnd('Merged.\n\nDONE: shipped')]));
    marked.tmuxSession = 'tmux-marked';
    manager.registerTab('marked', marked);
    manager.updateTabFromHook('tmux-marked', 'stop');
    await waitFor(() => expect(marked.turnEnd?.kind).toBe('turn-marker'));
    await settle();
    expect(curator.onUnmarkedTurnEnd).toHaveBeenCalledTimes(1);
  });

  it("a Claude tab's unmarked stop carries its source id: <ws>/<session>/<assistant uuid> (consult 16-promote-gate)", async () => {
    const { manager } = await managerWithPaste();
    const entry = { ...worker('claude-code', await writeLines('claude/u.jsonl', [{ ...claudeEnd('Shall I merge?'), uuid: 'a-uuid-1' }])), agentSessionId: 'sess-1' };
    manager.registerTab('worker', entry);
    manager.updateTabFromHook('tmux-worker', 'stop');
    await waitFor(() => expect(curator.onUnmarkedTurnEnd).toHaveBeenCalledWith('ws-1', 'worker', 'Shall I merge?', 'ws-1/sess-1/a-uuid-1'));
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
    // A digest-class nudge (ADR-0035): the orchestrator sat at its prompt with no digest yet, so it went at once.
    expect(paste.mock.calls).toEqual([['tmux-root', expect.stringMatching(/^DIGEST 1 since /)]]);
    expect(paste.mock.calls[0][1]).toContain('idle without an end line');
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([expect.objectContaining({
      kind: 'idle-no-end-line', tabId: 'worker', wakeClass: 'digest', delivered: true,
      message: buildNudgeMessage('idle-no-end-line', 'worker', 'w1', 'ws-1', '15 min ago'),
    })]);
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
