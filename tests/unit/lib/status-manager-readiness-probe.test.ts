import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab, TPanelType } from '@/types/terminal';

// Story 17 (L8): a Claude or Grok tab whose SessionStart hook never fires stays
// `inactive` with its prompt up. After 8 s with the agent running, the poll
// looks at the pane; an empty composer is a synthetic session start. And a
// session id the poll detects is persisted, so `tab status` shows it after a
// restart.

const FIXTURES = path.join(__dirname, '../../fixtures/panes');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf-8');

const SESSION_ID = '0f6c3b1e-8a8f-4a57-9d0e-3f0f2b3c4d5e';
const OTHER_SESSION_ID = '7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

const state = vi.hoisted(() => ({
  tab: null as ITab | null,
  running: true,
  pane: '' as string | null,
  jsonlPath: null as string | null,
  captures: 0,
  captureOpts: [] as unknown[],
  duringCapture: null as null | (() => Promise<void> | void),
}));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-1', name: 'w', directories: ['/tmp'] }] })),
  getWorkspaceByIdCached: vi.fn(async () => undefined),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  resolveLayoutFile: () => '/nonexistent/layout.json',
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  collectAllTabs: () => (state.tab ? [state.tab] : []),
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ tick: vi.fn(async () => {}), removeTab: vi.fn(), statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })) }),
}));
vi.mock('@/lib/lease-sweeper', () => ({ getLeaseSweeper: () => ({ sweep: vi.fn(async () => []) }), setLeaseAgentStateSource: vi.fn() }));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getAllPanesInfo: vi.fn(async () => new Map([['tmux-tab-a', { pid: 4242, command: 'claude', path: '/tmp' }]])),
  getChildPids: vi.fn(async () => [4243]),
  getPaneTitle: vi.fn(async () => ''),
  getSessionPanePid: vi.fn(async () => null),
  getSessionCwd: vi.fn(async () => null),
  capturePaneContent: vi.fn(async (_session: string, opts?: { escapes?: boolean }) => {
    state.captures += 1;
    state.captureOpts.push(opts);
    await state.duringCapture?.();
    return state.pane;
  }),
}));
vi.mock('@/lib/providers/claude/session-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/providers/claude/session-detection')>()),
  isClaudeRunning: vi.fn(async () => state.running),
  detectActiveSession: vi.fn(async () => (state.jsonlPath
    ? { status: 'running', sessionId: path.basename(state.jsonlPath, '.jsonl'), jsonlPath: state.jsonlPath, pid: 4243, startedAt: null, cwd: '/tmp' }
    : { status: 'not-running', sessionId: null, jsonlPath: null, pid: null, startedAt: null, cwd: null })),
  watchSessionsDir: vi.fn(() => ({ stop: () => {} })),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));

const T0 = new Date('2026-09-26T01:06:00Z').getTime();

const setup = async (panelType: TPanelType = 'claude-code', agentState?: ITab['agentState']) => {
  state.tab = { id: 'tab-a', name: 'a', order: 0, sessionName: 'tmux-tab-a', panelType, cliState: 'inactive', ...(agentState ? { agentState } : {}) };
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async () => state.tab),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const updateAgentState = vi.fn(async () => {});
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), updateAgentState);
  // As `tab create` registers a fresh agent tab.
  manager.registerTab('tab-a', {
    cliState: 'inactive', workspaceId: 'ws-1', tabName: 'a', tmuxSession: 'tmux-tab-a', panelType, lastEvent: null, eventSeq: 0,
  });
  const entry = (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-a')!;
  const pollAt = async (offsetMs: number) => {
    vi.setSystemTime(T0 + offsetMs);
    await manager.poll();
  };
  return { manager, entry, pollAt, updateAgentState, paste };
};

describe('readiness pane-probe fallback (story 17)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    state.running = true;
    state.pane = fixture('claude-empty-composer.ansi');
    state.jsonlPath = null;
    state.captures = 0;
    state.captureOpts = [];
    state.duringCapture = null;
  });
  afterEach(() => vi.useRealTimers());

  it('marks an inactive claude tab idle once its pane shows an empty composer after 8 s (W1 01:06Z), and `tab send` then accepts it', async () => {
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(5_000);
    expect(entry.cliState).toBe('inactive');
    expect(state.captures).toBe(0);
    await pollAt(8_500);
    expect(entry.cliState).toBe('idle');
    expect(state.captures).toBe(1);
    expect(state.captureOpts).toEqual([{ escapes: true }]);
    const { isComposerReadyCliState } = await import('@/lib/tab-send');
    expect(isComposerReadyCliState(entry.cliState)).toBe(true);
  });

  it('marks a fresh Claude (dim placeholder, 80x24) idle', async () => {
    state.pane = fixture('claude-fresh-80x24.ansi');
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('idle');
  });

  it('starts the clock only while the agent runs: a relaunch after a long idle shell waits 8 s again (review r1 finding 1)', async () => {
    state.running = false;
    const { manager, entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(30_000);
    await pollAt(60_000);
    state.running = true;
    manager.markAgentLaunch('tab-a');
    await pollAt(60_700);
    await pollAt(61_500);
    await pollAt(66_000);
    expect(state.captures).toBe(0);
    expect(entry.cliState).toBe('inactive');
    await pollAt(69_500);
    expect(entry.cliState).toBe('idle');
  });

  it('waits 8 s from the last launch stamp even when the clock is older', async () => {
    const { manager, entry, pollAt } = await setup();
    await pollAt(0);
    vi.setSystemTime(T0 + 7_000);
    manager.markAgentLaunch('tab-a');
    await pollAt(7_000);
    await pollAt(14_000);
    expect(state.captures).toBe(0);
    await pollAt(15_500);
    expect(entry.cliState).toBe('idle');
  });

  it('does not overwrite an event that arrived during the probe (review r1 finding 2: no false turn end)', async () => {
    const { manager, entry, pollAt } = await setup();
    await pollAt(0);
    state.duringCapture = () => { manager.updateTabFromHook('tmux-tab-a', 'prompt-submit'); };
    await pollAt(9_000);
    // Busy with the prompt's own event: the synthetic session start never landed.
    expect(entry.cliState).toBe('busy');
    expect(entry.lastEvent?.name).toBe('prompt-submit');
  });

  it('a manual relaunch (claude typed at the shell, no markAgentLaunch) still waits 8 s from the first running poll', async () => {
    state.running = false;
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(60_000);
    state.running = true;
    await pollAt(61_000);
    await pollAt(68_000);
    expect(state.captures).toBe(0);
    await pollAt(69_500);
    expect(entry.cliState).toBe('idle');
  });

  it('waits 8 s past a launch stamp newer than the clock (a stamp from a path that does not clear it)', async () => {
    const { entry, pollAt } = await setup();
    await pollAt(0);
    entry.lastResumeOrStartedAt = T0 + 7_000;
    await pollAt(9_000);
    await pollAt(14_000);
    expect(state.captures).toBe(0);
    await pollAt(15_500);
    expect(entry.cliState).toBe('idle');
  });

  it('launch polls reach past the probe threshold without the interval poll', async () => {
    const { LAUNCH_READY_POLL_DELAYS_MS: delays, READINESS_PROBE_AFTER_MS: after } = await import('@/lib/status-manager');
    expect(delays[delays.length - 1] - delays[0]).toBeGreaterThan(after);
  });

  it('reads a dim prompt suggestion on the composer as an empty composer', async () => {
    state.pane = fixture('claude-dim-suggestion.ansi');
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('idle');
  });

  it('leaves grok-cli tabs alone until a real grok pane is pinned (review r1 finding 6, story 30 F8)', async () => {
    state.pane = '\n  > \n';
    const { entry, pollAt } = await setup('grok-cli');
    const providers = await import('@/lib/providers');
    vi.spyOn(providers.getProviderByPanelType('grok-cli')!, 'isAgentRunning').mockResolvedValue(true);
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('inactive');
    expect(state.captures).toBe(0);
  });

  it('does not mark the first-run theme picker ready', async () => {
    state.pane = fixture('claude-onboarding-theme.ansi');
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    await pollAt(20_000);
    expect(entry.cliState).toBe('inactive');
    expect(entry.startupPrompt ?? null).toBeNull();
    expect(state.captures).toBe(2);
  });

  it('never probes without a running agent process (a persisted idle is not proof)', async () => {
    state.running = false;
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    await pollAt(40_000);
    expect(entry.cliState).toBe('inactive');
    expect(state.captures).toBe(0);
  });

  it('leaves codex tabs to their own TUI detector', async () => {
    const { entry, pollAt } = await setup('codex-cli');
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('inactive');
  });

  it('restarts the 8 s clock when the tab leaves inactive', async () => {
    state.pane = fixture('claude-trust-prompt.ansi');
    const { manager, entry, pollAt } = await setup();
    await pollAt(0);
    manager.updateTabFromHook('tmux-tab-a', 'session-start');
    await pollAt(4_000);
    expect(entry.cliState).toBe('idle');
    entry.cliState = 'inactive';
    state.pane = fixture('claude-empty-composer.ansi');
    await pollAt(9_000);
    expect(entry.cliState).toBe('inactive');
    await pollAt(17_500);
    expect(entry.cliState).toBe('idle');
  });
});

// D14 (story 05): a Claude tab that waits at a startup dialog reads `startup-prompt`, never `inactive`,
// and leaves it when the dialog goes. Runtime only: the layout keeps `inactive`.
describe('startup-prompt state (story 05, D14)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    state.running = true;
    state.pane = fixture('claude-trust-prompt.ansi');
    state.jsonlPath = null;
    state.captures = 0;
    state.captureOpts = [];
    state.duringCapture = null;
  });
  afterEach(() => vi.useRealTimers());

  const nudgeSpy = (manager: unknown) => vi.spyOn(manager as { nudgeOrchestrator: (...args: unknown[]) => Promise<void> }, 'nudgeOrchestrator')
    .mockResolvedValue(undefined);

  it.each([
    ['the folder-trust dialog', 'claude-trust-prompt.ansi', 'folder-trust'],
    ['the folder-trust dialog (2.1.318)', 'claude-trust-prompt-120x40.ansi', 'folder-trust'],
    ['the external-imports dialog', 'claude-external-imports-prompt.ansi', 'external-imports'],
  ])('reads %s as startup-prompt, silently, and keeps inactive in the layout', async (_label, name, kind) => {
    state.pane = fixture(name);
    const { manager, entry, pollAt } = await setup();
    const nudge = nudgeSpy(manager);
    const { updateTabCliStatus } = await import('@/lib/layout-store');
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('startup-prompt');
    expect(entry.startupPrompt).toEqual({ kind, since: T0 + 9_000 });
    expect(manager.getAllForClient()['tab-a'].startupPrompt).toEqual({ kind, since: T0 + 9_000 });
    expect(updateTabCliStatus).toHaveBeenLastCalledWith('tmux-tab-a', 'inactive', undefined);
    expect(nudge).not.toHaveBeenCalled();
    // Still there: no new transition, the first stamp holds.
    await pollAt(15_000);
    expect(entry.startupPrompt).toEqual({ kind, since: T0 + 9_000 });
  });

  it('follows the trust dialog to the imports dialog, then to the composer', async () => {
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.startupPrompt?.kind).toBe('folder-trust');
    state.pane = fixture('claude-external-imports-prompt.ansi');
    await pollAt(10_000);
    expect(entry.cliState).toBe('startup-prompt');
    expect(entry.startupPrompt).toEqual({ kind: 'external-imports', since: T0 + 10_000 });
    state.pane = fixture('claude-external-imports-accepted.ansi');
    await pollAt(11_000);
    expect(entry.cliState).toBe('idle');
    expect(entry.startupPrompt).toBeNull();
    const { isComposerReadyCliState } = await import('@/lib/tab-send');
    expect(isComposerReadyCliState(entry.cliState)).toBe(true);
  });

  it('leaves startup-prompt on the SessionStart hook once the dialog is answered', async () => {
    const { manager, entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('startup-prompt');
    manager.updateTabFromHook('tmux-tab-a', 'session-start');
    expect(entry.cliState).toBe('idle');
    expect(entry.startupPrompt).toBeNull();
  });

  it('goes back to inactive with no nudge when another screen replaces the dialog', async () => {
    const { manager, entry, pollAt } = await setup();
    const nudge = nudgeSpy(manager);
    await pollAt(0);
    await pollAt(9_000);
    state.pane = fixture('claude-onboarding-theme.ansi');
    await pollAt(10_000);
    expect(entry.cliState).toBe('inactive');
    expect(entry.startupPrompt).toBeNull();
    expect(nudge).not.toHaveBeenCalled();
  });

  it('reads an agent that exited at the dialog (No, exit) as inactive', async () => {
    const { entry, pollAt } = await setup();
    await pollAt(0);
    await pollAt(9_000);
    expect(entry.cliState).toBe('startup-prompt');
    state.running = false;
    await pollAt(20_000);
    expect(entry.cliState).toBe('inactive');
    expect(entry.startupPrompt).toBeNull();
  });

  it('a prompt-submit during the probe wins over the dialog reading', async () => {
    const { manager, entry, pollAt } = await setup();
    await pollAt(0);
    state.duringCapture = () => { manager.updateTabFromHook('tmux-tab-a', 'prompt-submit'); };
    await pollAt(9_000);
    expect(entry.cliState).toBe('busy');
    expect(entry.startupPrompt ?? null).toBeNull();
  });

  it('restores a persisted startup-prompt as inactive (a layout written before this rule, or by hand)', async () => {
    const { manager } = await setup();
    state.tab = { ...state.tab!, cliState: 'startup-prompt' };
    await (manager as unknown as { scanAllTabs: () => Promise<void> }).scanAllTabs();
    const restored = (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-a');
    expect(restored?.cliState).toBe('inactive');
  });
});

describe('poll-detected session id persistence (story 17)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    state.running = true;
    state.pane = fixture('claude-trust-prompt.ansi');
    state.captures = 0;
  });
  afterEach(() => vi.useRealTimers());

  const jsonl = (id: string) => `/nonexistent/projects/-tmp/${id}.jsonl`;

  it('persists a session id the poll bound when no hook bound one', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { entry, pollAt, updateAgentState } = await setup();
    await pollAt(0);
    expect(entry.agentSessionId).toBe(SESSION_ID);
    expect(updateAgentState).toHaveBeenCalledWith('tmux-tab-a', expect.objectContaining({ id: 'claude' }), { sessionId: SESSION_ID });
  });

  it('writes once: a layout that already holds the id is left alone', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { pollAt, updateAgentState } = await setup('claude-code', { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null });
    await pollAt(0);
    await pollAt(1_000);
    expect(updateAgentState).not.toHaveBeenCalled();
  });

  it('never overwrites a binding a hook or a launch set', async () => {
    state.jsonlPath = jsonl(OTHER_SESSION_ID);
    const { pollAt, updateAgentState } = await setup('claude-code', { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null });
    await pollAt(0);
    expect(updateAgentState).not.toHaveBeenCalled();
  });

  it('moves its own binding after a hookless /clear', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { pollAt, updateAgentState } = await setup();
    await pollAt(0);
    // The layout now holds what the poll wrote.
    state.tab = { ...state.tab!, agentState: { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null } };
    state.jsonlPath = jsonl(OTHER_SESSION_ID);
    await pollAt(1_000);
    expect(updateAgentState).toHaveBeenLastCalledWith('tmux-tab-a', expect.objectContaining({ id: 'claude' }), { sessionId: OTHER_SESSION_ID });
  });

  it('a hook binding during the poll\'s write keeps ownership with the hook', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { manager, pollAt, updateAgentState } = await setup();
    let land: () => void = () => {};
    updateAgentState.mockImplementationOnce(() => new Promise<void>((resolve) => { land = resolve; }));
    await pollAt(0);
    manager.applyAgentHookMeta('claude', 'tmux-tab-a', { sessionId: SESSION_ID });
    land();
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.tab = { ...state.tab!, agentState: { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null } };
    updateAgentState.mockClear();
    state.jsonlPath = jsonl(OTHER_SESSION_ID);
    await pollAt(1_000);
    expect(updateAgentState).not.toHaveBeenCalledWith('tmux-tab-a', expect.anything(), { sessionId: OTHER_SESSION_ID });
  });

  it('hands the binding back to the hook once the hook reports one', async () => {
    state.jsonlPath = jsonl(SESSION_ID);
    const { manager, pollAt, updateAgentState } = await setup();
    await pollAt(0);
    manager.applyAgentHookMeta('claude', 'tmux-tab-a', { sessionId: SESSION_ID });
    state.tab = { ...state.tab!, agentState: { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null } };
    updateAgentState.mockClear();
    state.jsonlPath = jsonl(OTHER_SESSION_ID);
    await pollAt(1_000);
    expect(updateAgentState).not.toHaveBeenCalledWith('tmux-tab-a', expect.anything(), { sessionId: OTHER_SESSION_ID });
  });
});
