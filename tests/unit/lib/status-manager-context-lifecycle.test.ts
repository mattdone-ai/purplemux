import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { LedgerStore } from '@/lib/ledger-store';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ADR-0036 wired into the StatusManager: a statusline reading, the stop hook, PreCompact and the restart service,
// with the real router, the real tab event log and the real ledger store (in memory).

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn(), takeJobs: vi.fn(async () => []) }));
const restart = vi.hoisted(() => ({ restartTab: vi.fn() }));
const ledger = vi.hoisted(() => ({ store: null as LedgerStore | null }));

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
vi.mock('@/lib/tab-restart', () => restart);
vi.mock('@/lib/ledger-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ledger-store')>();
  return { ...actual, getLedgerStore: () => ledger.store! };
});

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });
const waitFor = (check: () => void) => vi.waitFor(check, { timeout: 5000 });

const handoffText = (stamp: string) => [
  `# Handoff: kit · updated ${stamp}`, '',
  '## Role', '/v2-lane kit', '',
  '## In flight', 'none', '',
  '## Open questions', 'none', '',
  '## Standing rules', '- Land through tools/land.sh only. (source: DEC-58)', '',
  '## Decisions in the last 24 h', 'none', '## Do not', '- nothing', '',
  '## Resume command', '/v2-lane kit', '',
].join('\n');

const claudeEnd = (text: string) => JSON.stringify({
  type: 'assistant', timestamp: new Date().toISOString(), message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] },
});

const setup = async () => {
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const { LedgerStore: Store } = await import('@/lib/ledger-store');
  ledger.store = new Store(':memory:');
  const store = ledger.store;
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), () => store.tabEvents);
  const handoffPath = path.join(mockHome.value, 'seats', 'kit', 'handoff.md');
  const transcript = path.join(mockHome.value, 'claude', 'kit.jsonl');
  await fs.mkdir(path.dirname(handoffPath), { recursive: true });
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  await fs.writeFile(transcript, `${claudeEnd('Working.')}\n`);
  const seat: ITabStatusEntry = {
    cliState: 'idle', workspaceId: 'ws-1', tabName: 'kit', tmuxSession: 'tmux-seat', panelType: 'claude-code',
    agentProviderId: 'claude', agentSessionId: 'sess-kit', jsonlPath: transcript, handoffPath, rotateAt: null, host: null,
    lastEvent: { name: 'stop', at: Date.now(), seq: 1 }, eventSeq: 1,
  };
  manager.registerTab('seat', seat);
  manager.registerTab('lane', {
    cliState: 'idle', workspaceId: 'ws-1', tabName: 'lane', tmuxSession: 'tmux-lane', panelType: 'claude-code', agentSessionId: 'sess-lane',
  });
  const typed = (session = 'tmux-seat') => paste.mock.calls.filter(([s]) => s === session).map(([, message]) => message);
  const seatItem = () => store.items('ws-1', { type: 'seat' }, Date.now()).items.find((item) => item.itemKey === 'seat:ws-1:kit');
  const internals = manager as unknown as {
    pendingKickoffs: Map<string, unknown>;
    pendingFirstMessages: Map<string, { text: string }>;
  };
  return { manager, paste, typed, store, seat, handoffPath, transcript, seatItem, internals };
};

describe('the context lifecycle in the StatusManager (ADR-0036)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-context-'));
    const ws = { id: 'ws-1', name: 'ws', directories: [mockHome.value], orchestration: { enabled: false, orchestratorTabId: null } };
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
    restart.restartTab.mockResolvedValue({ status: 200, body: { ok: true } });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('a statusline reading over the threshold types ROTATE as an urgent event; the seat item records it (AC 2, AC 5)', async () => {
    const { manager, typed, store, handoffPath, seatItem } = await setup();
    manager.recordContextReading('sess-kit', 320_000);
    await waitFor(() => expect(typed()).toEqual([`ROTATE: bring ${handoffPath} up to date, then end your turn with HANDOFF-READY.`]));
    const [row] = store.tabEvents.list('ws-1', { since: 0, limit: 10 });
    expect(row).toMatchObject({ tabId: 'seat', kind: 'rotate', class: 'urgent' });
    expect(row.deliveredAt).not.toBeNull();
    await waitFor(() => expect(seatItem()).toMatchObject({ state: 'rotate-requested', holder: 'kit' }));
    expect(seatItem()!.attrs).toMatchObject({ contextTokens: 320_000, rotateAtTokens: 300_000, handoffPath });
  });

  it('a tab without a handoff path, a busy seat and a seat with a live registered job get no ROTATE', async () => {
    const { manager, paste, seat, seatItem } = await setup();
    manager.recordContextReading('sess-lane', 800_000);
    seat.cliState = 'busy';
    manager.recordContextReading('sess-kit', 800_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    seat.cliState = 'idle';
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [{ pid: 1, alive: true }] });
    manager.recordContextReading('sess-kit', 810_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(paste).not.toHaveBeenCalled();
    expect(seatItem()?.attrs.contextTokens).toBe(800_000);
  });

  it('review r1 F3: a seat whose host is not known and whose layout cannot say waits; it is never read as local', async () => {
    const { manager, typed, seat, handoffPath, transcript, seatItem } = await setup();
    delete seat.host;
    manager.recordContextReading('sess-kit', 320_000);
    await waitFor(() => expect(typed()).toHaveLength(1));
    await fs.writeFile(handoffPath, handoffText(new Date(Date.now() + 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z')));
    await fs.appendFile(transcript, `${claudeEnd('HANDOFF-READY')}\n`);
    seat.cliState = 'busy';
    seat.lastEvent = { name: 'prompt-submit', at: Date.now(), seq: 2 };
    seat.eventSeq = 2;
    manager.updateTabFromHook('tmux-seat', 'stop');
    await waitFor(() => expect(seatItem()?.attrs.checkpointRefused).toEqual(expect.stringContaining('the host of seat kit is not known')));
    expect(restart.restartTab).not.toHaveBeenCalled();
    expect(seatItem()).toMatchObject({ state: 'handoff-ready', attrs: { rotationFailures: 0, handoffRefusals: 0 } });
    expect(typed()).toHaveLength(1);
  });

  it.each([
    ['answers 503 remote-host-unreachable', () => restart.restartTab.mockResolvedValueOnce({ status: 503, body: { code: 'remote-host-unreachable', error: 'remote host host-b did not answer over ssh (exit 255)' } })],
    ['throws RemoteKitBrokenError', () => restart.restartTab.mockRejectedValueOnce(Object.assign(new Error('the CLI kit does not run on host-b'), { name: 'RemoteKitBrokenError' }))],
  ])('review r1 F2: the restart %s: a wait, no failed check; the next pass clears', async (_label, refuse) => {
    const { manager, typed, seat, handoffPath, transcript, seatItem, store } = await setup();
    refuse();
    manager.recordContextReading('sess-kit', 320_000);
    await waitFor(() => expect(typed()).toHaveLength(1));
    await fs.writeFile(handoffPath, handoffText(new Date(Date.now() + 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z')));
    await fs.appendFile(transcript, `${claudeEnd('HANDOFF-READY')}\n`);
    seat.cliState = 'busy';
    seat.lastEvent = { name: 'prompt-submit', at: Date.now(), seq: 2 };
    seat.eventSeq = 2;
    manager.updateTabFromHook('tmux-seat', 'stop');
    await vi.waitFor(() => expect(restart.restartTab).toHaveBeenCalledTimes(2), { timeout: 12_000 });
    expect(store.checkpoints.latest('ws-1', 'seat:ws-1:kit')).toMatchObject({ status: 'cleared', checkpoint: { attempt: 1 } });
    expect(seatItem()!.attrs).toMatchObject({ rotationFailures: 0, handoffRefusals: 0, checkpointRefusals: 1 });
    expect(typed().some((m) => m.startsWith('HANDOFF CHECK FAILED'))).toBe(false);
  });

  it('HANDOFF-READY at the stop: a passing file restarts the tab --clear and queues "Read <path>, then continue" (AC 3)', async () => {
    const { manager, typed, seat, handoffPath, transcript, seatItem, internals, store } = await setup();
    manager.recordContextReading('sess-kit', 320_000);
    await waitFor(() => expect(typed()).toHaveLength(1));
    await fs.writeFile(handoffPath, handoffText(new Date(Date.now() + 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z')));
    await fs.appendFile(transcript, `${claudeEnd('Brought the handoff up to date.\n\nHANDOFF-READY')}\n`);
    seat.cliState = 'busy';
    seat.lastEvent = { name: 'prompt-submit', at: Date.now(), seq: 2 };
    seat.eventSeq = 2;
    manager.updateTabFromHook('tmux-seat', 'stop');
    await waitFor(() => expect(restart.restartTab).toHaveBeenCalledTimes(1));
    expect(restart.restartTab.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws-1', tabId: 'seat', clear: true, interrupt: false, by: { kind: 'server', reason: 'context-rotation' },
    });
    expect(seatItem()).toMatchObject({ state: 'rotating' });
    expect(seatItem()!.attrs).toMatchObject({ rotations: 1, compactionsSinceRotation: 0, contextTokens: null, sessionBefore: 'sess-kit' });
    const firstLine = `Read ${handoffPath}, then continue: /v2-lane kit`;
    expect(seatItem()!.attrs.firstMessage).toBe(firstLine);
    expect(internals.pendingKickoffs.has('seat')).toBe(false);
    // The tab still shows its pre-restart ready-for-review; that is no gate (F4). Nothing is typed until the
    // fresh session starts, in the order a real launch sends its events.
    (manager as unknown as { contextLifecycle: { onIdle: (id: string) => void } }).contextLifecycle.onIdle('seat');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const isFirst = (m: string) => m.startsWith(`${firstLine} RESTORE NOTICE (checkpoint seat:ws-1:kit#1)`);
    expect(typed().filter(isFirst)).toEqual([]);
    // An urgent event for the rotating seat is held: the fresh session reads its handoff first.
    const urgent = await manager.routeTabEvent({ workspaceId: 'ws-1', tabId: 'seat', kind: 'turn-marker', class: 'urgent', text: 'worker ended: DONE: shipped' });
    expect(urgent.delivered).toBe(false);
    manager.updateTabFromHook('tmux-seat', 'session-start');
    await waitFor(() => expect(typed().filter(isFirst)).toHaveLength(1));
    await waitFor(() => expect(seatItem()).toMatchObject({ state: 'watching' }));
    await waitFor(() => expect(typed().indexOf('worker ended: DONE: shipped')).toBeGreaterThan(typed().findIndex(isFirst)));
    // vel-D5: the durable row went the whole way, and its plain copy sits beside the handoff.
    expect(store.checkpoints.latest('ws-1', 'seat:ws-1:kit')).toMatchObject({ status: 'delivered', checkpoint: { attempt: 1, intendedNextAction: '/v2-lane kit' } });
    expect(JSON.parse(await fs.readFile(`${handoffPath}.checkpoint.json`, 'utf-8'))).toMatchObject({ id: 'seat:ws-1:kit#1' });
  });

  it('the server keeps a BOM in the handoff file and refuses it, as v2 does (F6)', async () => {
    const { manager, typed, seat, handoffPath, transcript } = await setup();
    manager.recordContextReading('sess-kit', 320_000);
    await waitFor(() => expect(typed()).toHaveLength(1));
    await fs.writeFile(handoffPath, `\ufeff${handoffText(new Date(Date.now() + 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z'))}`);
    await fs.appendFile(transcript, `${claudeEnd('HANDOFF-READY')}\n`);
    seat.cliState = 'busy';
    seat.lastEvent = { name: 'prompt-submit', at: Date.now(), seq: 2 };
    seat.eventSeq = 2;
    manager.updateTabFromHook('tmux-seat', 'stop');
    // The failed-check message waits out the 5 s settle window of the ROTATE paste, retried every 3 s.
    await vi.waitFor(() => expect(typed()).toHaveLength(2), { timeout: 12_000 });
    expect(typed()[1]).toMatch(/^HANDOFF CHECK FAILED: .*no title line: the first non-empty line is "\ufeff# Handoff: kit/);
    expect(restart.restartTab).not.toHaveBeenCalled();
  }, 15_000);

  it('a seat WAITING only on an armed watch rotates with interrupt; the watch record stays (consult 10-C1)', async () => {
    const { manager, typed, seat, handoffPath, transcript } = await setup();
    const watches = path.join(mockHome.value, '.purplemux', 'watches.json');
    await fs.mkdir(path.dirname(watches), { recursive: true });
    const watchStore = JSON.stringify({ watches: [{
      id: 'w-seatwatch1', workspaceId: 'ws-1', tabId: 'seat', kind: 'pr', target: 'acme/repo#12', until: 'merged', baseline: 'abc1234',
      intervalS: 120, createdAt: 0, expiresAt: Date.now() + 86_400_000, lastCheckedAt: null, failures: 0, failingNotified: false,
      lastError: null, label: null, verified: true,
    }] });
    await fs.writeFile(watches, watchStore);
    const stop = async (text: string, seq: number) => {
      await fs.appendFile(transcript, `${claudeEnd(text)}\n`);
      seat.cliState = 'busy';
      seat.lastEvent = { name: 'prompt-submit', at: Date.now(), seq };
      seat.eventSeq = seq;
      manager.updateTabFromHook('tmux-seat', 'stop');
      await waitFor(() => expect(seat.turnEnd).toMatchObject({ kind: 'waiting', armedWatches: 1, seq: seq + 1 }));
    };
    await stop('Armed the PR watch.', 2);
    expect(seat.cliState).toBe('busy');
    manager.recordContextReading('sess-kit', 320_000);
    await waitFor(() => expect(typed()).toEqual([`ROTATE: bring ${handoffPath} up to date, then end your turn with HANDOFF-READY.`]));
    await fs.writeFile(handoffPath, handoffText(new Date(Date.now() + 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z')));
    await stop('Updated.\n\nHANDOFF-READY', 4);
    await waitFor(() => expect(restart.restartTab).toHaveBeenCalledTimes(1));
    const call = restart.restartTab.mock.calls[0][0] as { interrupt: boolean; interruptIf: (tab: ITab) => boolean };
    expect(call).toMatchObject({ tabId: 'seat', clear: true, interrupt: false });
    // Decided inside the restart lock (F1): the WAITING stop is the latest event and nothing was submitted after it.
    expect(call.interruptIf(tab('seat'))).toBe(true);
    const stopAt = seat.lastEvent!.at;
    expect(call.interruptIf({ ...tab('seat'), orchestrationActivity: { sessionName: 'tmux-seat', runtimeGeneration: 'g', turn: { generation: 't', runtimeGeneration: 'g', at: stopAt + 1 } } } as ITab)).toBe(false);
    seat.lastEvent = { name: 'prompt-submit', at: Date.now(), seq: 99 };
    expect(call.interruptIf(tab('seat'))).toBe(false);
    expect(await fs.readFile(watches, 'utf-8')).toBe(watchStore);
  }, 20_000);

  it('an unreadable transcript blocks the rotation: an unknown task count is not zero (consult 10-C1)', async () => {
    const { manager, paste, seat } = await setup();
    seat.jsonlPath = path.join(mockHome.value, 'claude', 'gone.jsonl');
    seat.agentSessionId = 'sess-kit';
    manager.recordContextReading('sess-kit', 800_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(paste).not.toHaveBeenCalled();
  });

  it('PreCompact counts on the seat item; after PostCompact ROTATE goes at the next idle (AC 4)', async () => {
    const { manager, typed, seat, seatItem } = await setup();
    seat.cliState = 'busy';
    manager.updateTabFromHook('tmux-seat', 'pre-compact');
    await waitFor(() => expect(seatItem()?.attrs).toMatchObject({ compactions: 1, compactionsSinceRotation: 1 }));
    manager.updateTabFromHook('tmux-seat', 'post-compact');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(typed()).toEqual([]);
    seat.cliState = 'idle';
    (manager as unknown as { contextLifecycle: { onIdle: (id: string) => void } }).contextLifecycle.onIdle('seat');
    await waitFor(() => expect(typed()).toHaveLength(1));
  });

  it('closes the seat item when the tab is removed', async () => {
    const { manager, seatItem } = await setup();
    manager.registerSeat('seat');
    expect(seatItem()?.closedAt).toBeNull();
    manager.removeTab('seat');
    expect(seatItem()?.closedAt).not.toBeNull();
  });
});
