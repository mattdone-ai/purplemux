import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry, IWorkspaceStandup } from '@/types/status';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables } from './tab-events-harness';

// Story hfl2-10 and its CARRY: an orchestrator with busy workers is never heartbeaten, so the standup due line must
// reach it as a wake of its own (a digest line typed at its prompt), once per due bucket.

const mockHome = vi.hoisted(() => ({ value: '' }));
const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));

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

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 5, 8, 0, 0);
const WS = 'ws-1';

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });
const entry = (id: string, extra: Partial<ITabStatusEntry> = {}): ITabStatusEntry => ({
  cliState: 'idle', workspaceId: WS, tabName: id, tmuxSession: `tmux-${id}`, panelType: 'claude-code', ...extra,
});
const standupAt = (at: number): IWorkspaceStandup => ({
  workspaceId: WS, at, state: 'on-track', headline: 'h', items: [], blockers: [], needsHuman: false, next: [],
});

/** The fleet value `standup.dueMin` (ADR-0019). */
const setDueMin = async (value: string) => {
  const file = path.join(mockHome.value, '.purplemux', 'fleet-config.json');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const setBy = { workspaceId: null, tabId: null, admin: true };
  await fs.writeFile(file, JSON.stringify({
    values: { 'standup.dueMin': { value, version: 1, setAt: 0, setBy } },
    versions: { 'standup.dueMin': 1 },
    history: [],
  }));
};

const setup = async (opts: { worker?: ITabStatusEntry['cliState'] | null } = {}) => {
  const ws = { id: WS, name: 'ws', directories: [mockHome.value], orchestration: { enabled: true, orchestratorTabId: 'o' } };
  workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
  workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  const [tabEvents, tabTurns] = memoryLedgerTables();
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), tabEvents, tabTurns);
  const internals = manager as unknown as {
    runOrchestratorKeeper: () => Promise<void>;
    orchKeeper: Map<string, { idleSince: number | null; beats: number; lastBeatAt: number; stallAlerted: boolean }>;
    standups: Map<string, IWorkspaceStandup>;
    tabEvents: { tick: () => Promise<void> };
  };
  const orch = entry('o');
  manager.registerTab('o', orch);
  const worker = opts.worker === null ? null : entry('w', { cliState: opts.worker ?? 'busy' });
  if (worker) manager.registerTab('w', worker);
  const typed = () => paste.mock.calls.map(([, message]) => message);
  const dueLines = () => typed().flatMap((message) => message.split('\n').filter((line) => line.includes('standup due:')));
  const keeperAt = async (at: number) => {
    vi.setSystemTime(at);
    await internals.runOrchestratorKeeper();
  };
  return { manager, internals, orch, worker, typed, dueLines, keeperAt, tabEvents };
};

describe('the standup due line (story hfl2-10)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-standup-due-'));
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('wakes an orchestrator with a busy worker once per due bucket, at its prompt, as a digest line (CARRY, AC 1, AC 2)', async () => {
    const { internals, typed, dueLines, keeperAt } = await setup();
    internals.standups.set(WS, standupAt(T0));

    await keeperAt(T0 + 44 * MIN);
    expect(typed()).toEqual([]);

    await keeperAt(T0 + 46 * MIN);
    expect(typed()).toHaveLength(1);
    expect(typed()[0]).toMatch(/^DIGEST 1 since /);
    expect(dueLines()).toEqual([`- 08:46Z standup due: last posted 46 min ago (purplemux standup report -w ${WS})`]);

    // Every later pass inside the 45 min bucket is quiet: never once per digest or per poll.
    for (const minute of [47, 60, 75, 89]) await keeperAt(T0 + minute * MIN);
    expect(dueLines()).toHaveLength(1);

    // The 90 min bucket: once more, less than 15 min after no digest rule could have sent it.
    await keeperAt(T0 + 91 * MIN);
    expect(dueLines()).toHaveLength(2);
    expect(dueLines()[1]).toContain('last posted 91 min ago');
    for (const minute of [100, 150, 179]) await keeperAt(T0 + minute * MIN);
    expect(dueLines()).toHaveLength(2);
    await keeperAt(T0 + 180 * MIN);
    expect(dueLines()).toHaveLength(3);
    expect(typed()).toHaveLength(3);
  });

  it('waits for a busy orchestrator\'s prompt: the line is held, then typed once it is at its prompt', async () => {
    const { internals, orch, typed, dueLines, keeperAt, tabEvents } = await setup();
    internals.standups.set(WS, standupAt(T0));
    orch.cliState = 'busy';
    await keeperAt(T0 + 46 * MIN);
    expect(typed()).toEqual([]);
    expect(tabEvents().pending(WS, 'o').map((event) => event.kind)).toEqual(['standup-due']);
    orch.cliState = 'idle';
    await internals.tabEvents.tick();
    expect(dueLines()).toHaveLength(1);
  });

  it('counts from the run\'s start when the workspace has no standup, and says none was posted', async () => {
    const { dueLines, keeperAt } = await setup();
    await keeperAt(T0);
    await keeperAt(T0 + 45 * MIN);
    expect(dueLines()).toEqual([`- 08:45Z standup due: none posted in the 45 min since the run started (purplemux standup report -w ${WS})`]);
  });

  it('a standup posted since starts the count again and retires a line still held', async () => {
    const { manager, internals, orch, typed, dueLines, keeperAt, tabEvents } = await setup();
    internals.standups.set(WS, standupAt(T0));
    orch.cliState = 'busy';
    await keeperAt(T0 + 46 * MIN);
    expect(tabEvents().pending(WS, 'o')).toHaveLength(1);
    await manager.reportStandup(standupAt(T0 + 50 * MIN));
    await vi.waitFor(() => expect(tabEvents().pending(WS, 'o')).toEqual([]));
    orch.cliState = 'idle';
    await keeperAt(T0 + 94 * MIN);
    expect(typed()).toEqual([]);
    await keeperAt(T0 + 95 * MIN);
    expect(dueLines()).toEqual([`- 09:35Z standup due: last posted 45 min ago (purplemux standup report -w ${WS})`]);
  });

  it('standup.dueMin = 0 turns the line off; another value moves the first bucket (AC 3)', async () => {
    await setDueMin('0');
    const off = await setup();
    off.internals.standups.set(WS, standupAt(T0));
    await off.keeperAt(T0 + 600 * MIN);
    expect(off.typed()).toEqual([]);

    vi.resetModules();
    await setDueMin('20');
    const early = await setup();
    early.internals.standups.set(WS, standupAt(T0));
    await early.keeperAt(T0 + 21 * MIN);
    expect(early.dueLines()).toHaveLength(1);
  });

  it('says nothing to an idle orchestrator with no live worker and no heartbeat due', async () => {
    const { internals, typed, keeperAt } = await setup({ worker: null });
    internals.standups.set(WS, standupAt(T0));
    await keeperAt(T0 + 46 * MIN);
    expect(typed()).toEqual([]);
  });

  it('rides the idle heartbeat: the line goes in the same pass as the heartbeat, on its own line (AC 1)', async () => {
    const { internals, typed, dueLines, keeperAt } = await setup({ worker: null });
    internals.standups.set(WS, standupAt(T0));
    internals.orchKeeper.set(WS, { idleSince: T0, beats: 0, lastBeatAt: 0, stallAlerted: false });
    await keeperAt(T0 + 46 * MIN);
    expect(dueLines()).toEqual([`- 08:46Z standup due: last posted 46 min ago (purplemux standup report -w ${WS})`]);
    expect(internals.orchKeeper.get(WS)?.beats).toBe(1);
    // The heartbeat itself waits in the log for the next digest; the due line was the wake.
    await internals.tabEvents.tick();
    expect(typed()).toHaveLength(1);
  });

  it('stops counting when orchestration turns off: re-enabled, a run with no standup counts from the new start', async () => {
    const { dueLines, keeperAt } = await setup();
    await keeperAt(T0);
    const off = { id: WS, name: 'ws', directories: [mockHome.value], orchestration: { enabled: false, orchestratorTabId: 'o' } };
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [off] });
    await keeperAt(T0 + 30 * MIN);
    const on = { ...off, orchestration: { enabled: true, orchestratorTabId: 'o' } };
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [on] });
    await keeperAt(T0 + 40 * MIN);
    await keeperAt(T0 + 84 * MIN);
    expect(dueLines()).toEqual([]);
    await keeperAt(T0 + 85 * MIN);
    expect(dueLines()).toHaveLength(1);
  });
});
