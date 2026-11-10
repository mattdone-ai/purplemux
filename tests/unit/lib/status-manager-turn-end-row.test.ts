import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import { LedgerStore } from '@/lib/ledger-store';
import type { ITurnEndRow } from '@/lib/turn-end-row';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// F6, folding in F10 steps 1 and 2, through the status manager, after the party ruling SIMPLIFY (2026-11-10): no stop
// is held, and ONE precedence order decides between the row and E, the end line the stop applies (cases A1-A12).

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));
const pane = vi.hoisted(() => ({ text: '' as string | null }));
const needsDecision = vi.hoisted(() => ({
  open: vi.fn(async (_deps: unknown, _stop: unknown): Promise<Record<string, unknown>> => ({ opened: true, itemId: 'nd-0123456789abcdef0123456789abcdef', runId: 'run-a' })),
}));
vi.mock('@/lib/needs-decision-opener', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/needs-decision-opener')>()),
  needsDecisionDeps: vi.fn(async () => ({})),
  openNeedsDecisionItem: needsDecision.open,
}));

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
vi.mock('@/lib/curator-service', () => ({ curatorOnUnmarkedTurnEnd: vi.fn() }));
vi.mock('@/lib/capture-at-width', () => ({ capturePaneAtWidth: vi.fn(async () => pane.text) }));
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

const SESSION = 'sess-w';
const EMPTY_CLAUDE = 'output\n────────\n❯ \n────────\n';
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });
const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });

const claudeEnd = (text: string) => ({
  type: 'assistant', timestamp: '2026-11-10T02:00:00.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

const setup = async (opts: { scoped?: boolean; transcriptText?: string } = {}) => {
  const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value], orchestration: { enabled: true, orchestratorTabId: 'root' } };
  workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
  workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
  await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
  await fs.writeFile(path.join(mockHome.value, '.purplemux', 'event-scopes.json'), JSON.stringify({
    scopes: opts.scoped === false ? [] : [{
      workspaceId: 'ws-1', tabId: 'w', epic: 'e', story: 'F6', dependsOn: [], attempt: 1, declaredBy: { workspaceId: 'ws-1', tabId: 'root' }, declaredAt: 0,
    }],
  }));
  const transcript = path.join(mockHome.value, 'claude', 's.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, `${JSON.stringify(claudeEnd(opts.transcriptText ?? 'Gate green.\n\nDONE: shipped'))}\n`);
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const store = new LedgerStore(':memory:');
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}),
    () => store.tabEvents, () => store.tabTurns, () => store.turnEnds);
  // The coordinator window is pinned in coordinator-window.test.ts; here the orchestrator is only the nudge target.
  (await import('@/lib/coordinator-window')).configureCoordinatorWindow({
    now: () => Date.now(), isCoordinator: async () => false, lastGoverned: () => null, oldestDigestAt: () => null,
  });
  manager.registerTab('root', { cliState: 'idle', workspaceId: 'ws-1', tabName: 'root', tmuxSession: 'tmux-root', panelType: 'claude-code' });
  const worker: ITabStatusEntry = {
    cliState: 'idle', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'tmux-w', panelType: 'claude-code', agentProviderId: 'claude',
    jsonlPath: transcript, agentSessionId: SESSION,
  };
  manager.registerTab('w', worker);
  manager.updateTabFromHook('tmux-w', 'prompt-submit');
  const internals = manager as unknown as { turnEndSourceRow: boolean; stopPayloadIsTail: boolean };
  const nudges = () => paste.mock.calls.map(([, message]) => message);
  const stop = (message: string | null) => manager.decideClaudeStop('tmux-w', { hookEvent: 'Stop', sessionId: SESSION, message });
  const row = (over: Partial<ITurnEndRow> = {}): ITurnEndRow => ({
    sessionId: SESSION, turnId: store.turnEnds.currentTurn(SESSION)!.turnId, workspaceId: 'ws-1', tabId: 'w', seatRole: 'builder', story: 'F6',
    attempt: 1, verdict: 'DONE', head: 'c'.repeat(40), gateLog: '/g.log', gateVerdict: 'VALID', reason: 'shipped', source: 'done',
    unreportedReason: null, at: Date.now(), consumedAt: null, ...over,
  });
  return { manager, store, worker, internals, nudges, stop, row };
};

describe('the typed turn end through the status manager (F6; F10 steps 1-2)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-turn-end-row-'));
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
    pane.text = EMPTY_CLAUDE;
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const applied = async (nudgesFn: () => string[], manager: { updateTabFromHook: (s: string, e: string) => void }) => {
    manager.updateTabFromHook('tmux-w', 'stop');
    await waitFor(() => expect(nudgesFn()).toHaveLength(1));
    return nudgesFn()[0];
  };
  const ndLine = () => JSON.stringify(needsDecision.open.mock.calls.at(-1)?.[1] ?? null);

  it('A1: a DONE row under a NEEDS-DECISION end line: the line applies, its item opens, the row is consumed and kept', async () => {
    const { manager, store, nudges, stop, row } = await setup({ transcriptText: 'Options.\n\nNEEDS-DECISION: pick A or B' });
    store.turnEnds.put(row());
    expect(await stop('Options.\n\nNEEDS-DECISION: pick A or B')).toMatchObject({ kind: 'row' });
    expect(await applied(nudges, manager)).toContain('ended: NEEDS-DECISION: pick A or B');
    expect(ndLine()).toContain('NEEDS-DECISION: pick A or B');
    expect(store.turnEnds.list('ws-1', 0)).toEqual([expect.objectContaining({ verdict: 'DONE', consumedAt: expect.any(Number) })]);
  });

  it('A2: a DONE row and no payload message (body over the limit): E is the transcript tail, and its BLOCKED line applies', async () => {
    const { manager, store, nudges, stop, row } = await setup({ transcriptText: 'Stuck.\n\nBLOCKED: no creds' });
    store.turnEnds.put(row());
    expect(await stop(null)).toMatchObject({ kind: 'row' });
    expect(await applied(nudges, manager)).toContain('ended: BLOCKED: no creds');
    expect(store.turnEnds.unconsumed(SESSION, 1)).toBeNull();
  });

  it('A3: hook.stop-payload=off: E is the transcript tail; the payload tail is not consulted', async () => {
    const { manager, store, internals, nudges, stop, row } = await setup({ transcriptText: 'Hmm.\n\nNEEDS-DECISION: y' });
    internals.stopPayloadIsTail = false;
    store.turnEnds.put(row());
    await stop('All done.\n\nDONE: x');
    expect(await applied(nudges, manager)).toContain('ended: NEEDS-DECISION: y');
  });

  it('A4: a NEEDS-DECISION row under a DONE line: the synthesized NEEDS-DECISION line applies and opens the item', async () => {
    const { manager, store, nudges, stop, row } = await setup({ transcriptText: 'Wrapped.\n\nDONE: finished' });
    store.turnEnds.put(row({ verdict: 'NEEDS-DECISION', reason: 'pick A or B', head: null, gateLog: null, gateVerdict: null }));
    await stop('Wrapped.\n\nDONE: finished');
    expect(await applied(nudges, manager)).toContain('ended: NEEDS-DECISION: pick A or B (story F6)');
    expect(ndLine()).toContain('NEEDS-DECISION: pick A or B (story F6)');
  });

  it('A5: a BLOCKED row under a NEEDS-DECISION line: the line applies; a DONE row under a DONE line: the row\'s line', async () => {
    const one = await setup({ transcriptText: 'Q.\n\nNEEDS-DECISION: z' });
    one.store.turnEnds.put(one.row({ verdict: 'BLOCKED', reason: 'red' }));
    await one.stop('Q.\n\nNEEDS-DECISION: z');
    expect(await applied(one.nudges, one.manager)).toContain('ended: NEEDS-DECISION: z');
    const two = await setup({ transcriptText: 'Ok.\n\nDONE: z' });
    two.store.turnEnds.put(two.row());
    await two.stop('Ok.\n\nDONE: z');
    expect(await applied(two.nudges, two.manager)).toContain(`ended: DONE: shipped (story F6, head ${'c'.repeat(12)}, gate VALID)`);
  });

  it('A6: a scoped turn end with no row is never held: its DONE line applies once, with one UNREPORTED no-row row', async () => {
    const { manager, store, nudges, stop } = await setup();
    expect(await stop('Gate green.\n\nDONE: shipped')).toEqual({ kind: 'unreported', reason: 'no-row', turnId: 1 });
    expect(await applied(nudges, manager)).toContain('ended: DONE: shipped');
    expect(store.turnEnds.list('ws-1', 0)).toEqual([expect.objectContaining({ verdict: 'UNREPORTED', unreportedReason: 'no-row' })]);
  });

  it('A7: a markerless stop with a live job is WAITING: no row asked, none consumed; a later stop applies its row once', async () => {
    const { manager, store, nudges, stop, row } = await setup({ transcriptText: 'gate launched' });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true }] });
    expect(await stop('gate launched, waiting on it')).toMatchObject({ kind: 'classifier', why: 'waiting on open work' });
    manager.updateTabFromHook('tmux-w', 'stop');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(nudges()).toEqual([]);
    expect(store.turnEnds.list('ws-1', 0)).toEqual([]);
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
    store.turnEnds.put(row());
    expect(await stop('Gate green.\n\nDONE: shipped')).toMatchObject({ kind: 'row' });
    expect(await applied(nudges, manager)).toContain('ended: DONE: shipped (story F6');
  });

  it('A10: a live idle_prompt, then a live prompt-submit, after an applied stop: no synthetic stop, the turn advances', async () => {
    const { manager, store, nudges, stop } = await setup();
    await stop('DONE: shipped');
    await applied(nudges, manager);
    await new Promise((resolve) => setTimeout(resolve, 5));
    manager.handleProviderEvent('claude', 'tmux-w', { kind: 'notification', notificationType: 'idle_prompt' }, Date.now(), { replayed: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    manager.handleProviderEvent('claude', 'tmux-w', { kind: 'prompt-submit' }, Date.now(), { replayed: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(nudges()).toHaveLength(1);
    expect(store.turnEnds.currentTurn(SESSION)?.turnId).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    manager.handleProviderEvent('claude', 'tmux-w', { kind: 'prompt-submit' }, Date.now(), { replayed: true });
    expect(store.turnEnds.currentTurn(SESSION)?.turnId).toBe(2);
  });

  it('A11: turn-end.source=classifier with a DONE row and a NEEDS-DECISION line: the classifier applies; the row stays', async () => {
    const { manager, store, internals, nudges, stop, row } = await setup({ transcriptText: 'Q.\n\nNEEDS-DECISION: y' });
    internals.turnEndSourceRow = false;
    store.turnEnds.put(row());
    expect(await stop('Q.\n\nNEEDS-DECISION: y')).toMatchObject({ kind: 'classifier', why: 'turn-end.source=classifier' });
    expect(await applied(nudges, manager)).toContain('ended: NEEDS-DECISION: y');
    expect(store.turnEnds.unconsumed(SESSION, 1)).toMatchObject({ verdict: 'DONE' });
  });

  it('A12: a worker that ends DONE with no row leaves busy at that stop: its prompt is ready for the inbox', async () => {
    const { manager, nudges, stop } = await setup();
    await stop('Gate green.\n\nDONE: shipped');
    await applied(nudges, manager);
    expect(manager.getAllForClient().w?.cliState).toBe('ready-for-review');
    expect(manager.isAtPrompt('w')).toBe(true);
  });

  it('a replayed stop is judged against its own turn: with no row it is UNREPORTED no-row:replayed', async () => {
    const { manager } = await setup();
    expect(await manager.decideClaudeStop('tmux-w', { hookEvent: 'Stop', sessionId: SESSION, message: 'DONE: x' }, Date.now()))
      .toEqual({ kind: 'unreported', reason: 'no-row:replayed', turnId: 1 });
    expect(await manager.decideClaudeStop('tmux-w', { hookEvent: 'StopFailure', sessionId: SESSION, message: 'API Error' }))
      .toMatchObject({ kind: 'unreported', reason: 'no-row:stop-failure' });
  });
});
