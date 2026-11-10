import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry, IWorkspaceStandup } from '@/types/status';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables } from './tab-events-harness';

// F6 change 2 (deletes story hfl2-10's due line): no timer wakes a coordinator to write a standup. The coordinator
// posts it from its status file at the end of a turn it takes anyway (standup_draft.py --post).

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

describe('no standup due line (F6 change 2)', () => {
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

  it('an orchestrator with a busy worker and a stale standup gets nothing from the keeper, for 6 hours', async () => {
    await setDueMin('45');
    const { internals, typed, dueLines, keeperAt, tabEvents } = await setup();
    internals.standups.set(WS, standupAt(T0));
    for (let minute = 1; minute <= 360; minute += 5) {
      await keeperAt(T0 + minute * MIN);
      await internals.tabEvents.tick();
    }
    expect(typed()).toEqual([]);
    expect(dueLines()).toEqual([]);
    expect(tabEvents().list(WS, { since: 0, limit: 50 }).filter((row) => row.kind === 'standup-due')).toEqual([]);
  });

  it('a workspace that never posted a standup gets no line either; the idle heartbeat carries no due line', async () => {
    const { typed, dueLines, keeperAt } = await setup({ worker: null });
    for (let minute = 1; minute <= 120; minute += 5) await keeperAt(T0 + minute * MIN);
    expect(dueLines()).toEqual([]);
    expect(typed().every((message) => !message.includes('standup due'))).toBe(true);
  });
});
