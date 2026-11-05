import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import { KICKOFF_FALLBACK_DELAY_MS, ORCH_IDLE_HEARTBEAT_MS } from '@/lib/orchestration';
import type { TLivenessEvent } from '@/types/liveness';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables } from './tab-events-harness';

const workspaceStore = vi.hoisted(() => ({
  getWorkspaceByIdCached: vi.fn(),
  getWorkspacesCached: vi.fn(),
}));

const liveness = vi.hoisted(() => ({
  statusForTab: vi.fn(),
}));

const layoutStore = vi.hoisted(() => ({
  updateTabAgentState: vi.fn(async () => {}),
}));

const codexRateLimits = {
  cacheFromJsonl: vi.fn(async () => true),
};

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));

vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => liveness,
}));

const policyLock = (
  checkPolicy: (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>,
): IAutomatedPromptDispatcherDeps['withPolicyLock'] =>
  async (workspaceId, target, deliver) => deliver((options) => checkPolicy(workspaceId, target, options));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const tab = (id: string): ITab => ({
  id,
  name: id,
  order: 0,
  sessionName: `tmux-${id}`,
  panelType: 'codex-cli',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'medium' },
});

const entry = (id: string): ITabStatusEntry => ({
  cliState: 'idle',
  workspaceId: 'ws-1',
  tabName: id,
  tmuxSession: `tmux-${id}`,
  panelType: 'codex-cli',
  agentProviderId: 'codex',
});

const completed = (pid: number, notify?: 'self'): TLivenessEvent => ({
  kind: 'bg-completed',
  job: {
    workspaceId: 'ws-1',
    tabId: 'worker',
    pid,
    label: `job-${pid}`,
    registeredAt: 0,
    ...(notify ? { notify } : {}),
  },
  exitCode: 0,
  stderrTail: null,
});

describe('status manager automated prompt call paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue({
      id: 'ws-1',
      name: 'workspace',
      directories: ['/tmp'],
      orchestration: { enabled: true, orchestratorTabId: 'root' },
    });
    workspaceStore.getWorkspacesCached.mockResolvedValue({
      workspaces: [{
        id: 'ws-1',
        name: 'workspace',
        directories: ['/tmp'],
        orchestration: { enabled: true, orchestratorTabId: 'root' },
      }],
    });
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps Codex session metadata unchanged until a verified launch is applied', async () => {
    vi.useFakeTimers();
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(undefined, undefined, undefined, ...memoryLedgerTables());
    const current = {
      ...entry('worker'),
      agentSessionId: 'session-a',
      jsonlPath: '/tmp/session-a.jsonl',
      lastUserMessage: 'old prompt',
    };
    manager.registerTab('worker', current);

    manager.markAgentLaunch('worker', { resumeSessionId: 'session-b' });
    expect(current).toMatchObject({
      agentSessionId: 'session-a',
      jsonlPath: '/tmp/session-a.jsonl',
      lastUserMessage: 'old prompt',
    });

    manager.applyConfirmedCodexLaunch('worker', 'codex-generation', 'session-b');
    expect(current).toMatchObject({
      agentSessionId: 'session-b',
      jsonlPath: null,
      lastUserMessage: null,
    });
  });

  it('binds, ingests, and rebinds a busy Codex tab when its JSONL path arrives or changes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'purplemux-status-watch-'));
    const firstPath = path.join(dir, 'first.jsonl');
    const secondPath = path.join(dir, 'second.jsonl');
    const thirdPath = path.join(dir, 'third.jsonl');
    await Promise.all([
      fs.writeFile(firstPath, ''),
      fs.writeFile(secondPath, ''),
      fs.writeFile(thirdPath, ''),
    ]);
    await import('@/lib/providers');
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(
      undefined,
      codexRateLimits.cacheFromJsonl,
      layoutStore.updateTabAgentState,
      ...memoryLedgerTables(),
    );
    manager.registerTab('worker', { ...entry('worker'), cliState: 'busy' });

    try {
      const watchers = (manager as unknown as {
        jsonlWatchers: Map<string, { jsonlPath: string }>;
      }).jsonlWatchers;
      expect(manager.applyAgentHookMeta('codex', 'tmux-worker', {
        sessionId: 'session-a',
        jsonlPath: firstPath,
      })).toEqual({ tabId: 'worker', cliState: 'busy' });
      expect(watchers.get('worker')?.jsonlPath).toBe(firstPath);
      await vi.waitFor(() => expect(codexRateLimits.cacheFromJsonl).toHaveBeenCalledWith(firstPath));
      expect(watchers.get('worker')?.jsonlPath).toBe(firstPath);

      manager.applyAgentHookMeta('codex', 'tmux-worker', { sessionId: 'session-b' });
      expect(watchers.has('worker')).toBe(false);
      await vi.waitFor(() => expect(layoutStore.updateTabAgentState).toHaveBeenCalledWith(
        'tmux-worker',
        expect.objectContaining({ id: 'codex' }),
        expect.objectContaining({ sessionId: 'session-b', jsonlPath: null }),
      ));

      manager.applyAgentHookMeta('codex', 'tmux-worker', { sessionId: 'session-b', jsonlPath: secondPath });
      await vi.waitFor(() => expect(codexRateLimits.cacheFromJsonl).toHaveBeenCalledWith(secondPath));
      expect(watchers.get('worker')?.jsonlPath).toBe(secondPath);

      manager.applyAgentHookMeta('codex', 'tmux-worker', { jsonlPath: thirdPath });
      await vi.waitFor(() => expect(codexRateLimits.cacheFromJsonl).toHaveBeenCalledWith(thirdPath));
      expect(watchers.get('worker')?.jsonlPath).toBe(thirdPath);
    } finally {
      manager.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes overlapping liveness outcomes and retains both nudge records', async () => {
    const releaseFirst = deferred<void>();
    const paste = vi.fn(async (_session: string, message: string) => {
      if (message.includes('job-1')) await releaseFirst.promise;
    });
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher, undefined, undefined, ...memoryLedgerTables());
    manager.registerTab('worker', entry('worker'));
    manager.registerTab('root', entry('root'));
    const handle = (manager as unknown as {
      handleLivenessEvent: (event: TLivenessEvent) => Promise<void>;
    }).handleLivenessEvent.bind(manager);

    // Reported to the tab that waits on them, so both are urgent and typed in turn (ADR-0035).
    const first = handle(completed(1, 'self'));
    const second = handle(completed(2, 'self'));
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(paste).toHaveBeenCalledTimes(2);
    expect(paste.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining('job-1'),
      expect.stringContaining('job-2'),
    ]);
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([
      expect.objectContaining({ kind: 'bg-completed', delivered: true }),
      expect.objectContaining({ kind: 'bg-completed', delivered: true }),
    ]);
  });

  it('records model drift for the human while policy blocks terminal delivery', async () => {
    const paste = vi.fn(async () => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: false as const, error: 'agent-model-mismatch' }))),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher, undefined, undefined, ...memoryLedgerTables());
    manager.registerTab('root', entry('root'));
    const nudge = (manager as unknown as {
      nudgeLiveness: (workspaceId: string, tabId: string, tabName: string, kind: 'model-drift', detail: string) => Promise<boolean>;
    }).nudgeLiveness.bind(manager);

    await expect(nudge('ws-1', 'root', 'root', 'model-drift', 'expected astra, observed sol')).resolves.toBe(false);

    expect(paste).not.toHaveBeenCalled();
    expect(manager.getOrchestrationNudges('ws-1')).toEqual([
      expect.objectContaining({ kind: 'model-drift', delivered: false }),
    ]);
  });

  it('guards a kickoff at its final delivery point', async () => {
    vi.useFakeTimers();
    const paste = vi.fn(async () => {});
    const checkPolicy = vi.fn(async () => ({ ok: true as const }));
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(checkPolicy),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher, undefined, undefined, ...memoryLedgerTables());
    manager.registerTab('root', entry('root'));

    manager.queueKickoffPrompt('root', 'start orchestration');
    await vi.advanceTimersByTimeAsync(KICKOFF_FALLBACK_DELAY_MS + 800);

    expect(checkPolicy).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ id: 'root' }),
      { consumeBootstrapForTarget: true },
    );
    expect(paste).toHaveBeenCalledWith('tmux-root', 'start orchestration');
  });

  it.each(['root', 'worker-terminal'])('suppresses heartbeats for a live job on %s and starts a fresh idle episode after it exits', async (jobTabId) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    let jobAlive = true;
    liveness.statusForTab.mockImplementation(async (tabId: string) => ({
      probes: [],
      backgroundJobs: tabId === jobTabId
        ? [{ pid: 878382, label: 'review', alive: jobAlive, registeredAt: Date.now(), ageS: 0 }]
        : [],
    }));
    const paste = vi.fn(async () => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher, undefined, undefined, ...memoryLedgerTables());
    manager.registerTab('root', entry('root'));
    if (jobTabId === 'worker-terminal') {
      manager.registerTab('worker-terminal', { ...entry('worker-terminal'), panelType: 'terminal' });
    }
    const runKeeper = (manager as unknown as {
      runOrchestratorKeeper: () => Promise<void>;
    }).runOrchestratorKeeper.bind(manager);

    await runKeeper();
    await vi.advanceTimersByTimeAsync(ORCH_IDLE_HEARTBEAT_MS + 60_000);
    await runKeeper();
    expect(paste).not.toHaveBeenCalled();

    jobAlive = false;
    await runKeeper();
    expect(paste).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(ORCH_IDLE_HEARTBEAT_MS);
    await runKeeper();
    expect(paste).toHaveBeenCalledTimes(1);
  });

  it('does not let a dead registered job suppress the keeper', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    liveness.statusForTab.mockResolvedValue({
      probes: [],
      backgroundJobs: [{ pid: 878382, label: 'old-review', alive: false, registeredAt: 0, ageS: 900 }],
    });
    const paste = vi.fn(async () => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId, id) => tab(id)),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(dispatcher, undefined, undefined, ...memoryLedgerTables());
    manager.registerTab('root', entry('root'));
    const runKeeper = (manager as unknown as {
      runOrchestratorKeeper: () => Promise<void>;
    }).runOrchestratorKeeper.bind(manager);

    await runKeeper();
    await vi.advanceTimersByTimeAsync(ORCH_IDLE_HEARTBEAT_MS);
    await runKeeper();

    expect(paste).toHaveBeenCalledTimes(1);
  });
});

it('awaiting-human keeps ownership but suppresses idle keeper beats without resuming work', async () => {
  const { StatusManager } = await import('@/lib/status-manager');
  const paste = vi.fn(async () => {});
  const manager = new StatusManager(new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)), withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))), hasSession: vi.fn(async () => true), paste,
  }), undefined, undefined, ...memoryLedgerTables());
  manager.registerTab('root', entry('root'));
  workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [{ id: 'ws-1', name: 'workspace', directories: [], orchestration: { enabled: true, orchestratorTabId: 'root', revision: 4 } }] });
  const internals = manager as unknown as { standups: Map<string, unknown>; orchKeeper: Map<string, unknown>; runOrchestratorKeeper: () => Promise<void> };
  internals.standups.set('ws-1', { state: 'awaiting-human' });
  internals.orchKeeper.set('ws-1', { idleSince: 0, beats: 0, lastBeatAt: 0, stallAlerted: false });
  await internals.runOrchestratorKeeper();
  expect(paste).not.toHaveBeenCalled(); expect(internals.orchKeeper.has('ws-1')).toBe(false);
});

it('a replay from before a managed start cannot erase pending-launch uncertainty', async () => {
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(undefined, undefined, undefined, ...memoryLedgerTables());
  manager.registerTab('pending-root', { ...entry('pending-root'), panelType: 'claude-code', agentProviderId: 'claude' });
  const started = Date.now();
  manager.markAgentLaunch('pending-root');
  expect(manager.isOrchestrationLaunchPending('pending-root')).toBe(true);
  manager.updateTabFromHook('tmux-pending-root', 'session-start', undefined, undefined, started - 1000);
  expect(manager.isOrchestrationLaunchPending('pending-root')).toBe(true);
  manager.updateTabFromHook('tmux-pending-root', 'session-start');
  expect(manager.isOrchestrationLaunchPending('pending-root')).toBe(false);
});
