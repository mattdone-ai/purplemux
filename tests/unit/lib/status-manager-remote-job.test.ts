import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyWake } from '@/lib/wake-class';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { IBackgroundJob, TLivenessEvent } from '@/types/liveness';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';
import { memoryLedgerTables, memoryTabEvents } from './tab-events-harness';

const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
const liveness = vi.hoisted(() => ({ statusForTab: vi.fn(), removeTab: vi.fn() }));

vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => liveness }));

const tab = (id: string): ITab => ({ id, name: id, order: 0, sessionName: `tmux-${id}`, panelType: 'claude-code' });
const entry = (id: string, extra: Partial<ITabStatusEntry> = {}): ITabStatusEntry => ({
  cliState: 'idle', workspaceId: 'ws-1', tabName: id, tmuxSession: `tmux-${id}`, panelType: 'claude-code', ...extra,
});

const remoteJob: IBackgroundJob = { workspaceId: 'ws-1', tabId: 'w', pid: 157985, host: 'ai-lan', label: 'gate-r1.log', notify: 'self', registeredAt: 0 };
const unreachable: TLivenessEvent = { kind: 'bg-host-unreachable', job: remoteJob, host: 'ai-lan', failures: 3, error: 'ssh to ai-lan failed (exit 255)' };

const setup = async (orchestration: { enabled: boolean; orchestratorTabId: string | null }, w: Partial<ITabStatusEntry> = {}) => {
  const ws = { id: 'ws-1', name: 'ws', directories: ['/tmp'], orchestration };
  workspaceStore.getWorkspaceByIdCached.mockResolvedValue(ws);
  workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [ws] });
  const paste = vi.fn(async (_session: string, _message: string) => {});
  const dispatcher = new AutomatedPromptDispatcher({
    findTarget: vi.fn(async (_ws, id) => tab(id)),
    withPolicyLock: (async (_ws, _target, deliver) => deliver(async () => ({ ok: true }))) as IAutomatedPromptDispatcherDeps['withPolicyLock'],
    hasSession: vi.fn(async () => true),
    paste,
  });
  const { StatusManager } = await import('@/lib/status-manager');
  const tabEvents = memoryTabEvents();
  const manager = new StatusManager(dispatcher, vi.fn(async () => true), vi.fn(async () => {}), tabEvents, memoryLedgerTables()[1]);
  // F6's coordinator window is pinned in coordinator-window.test.ts and status-manager-event-digest.test.ts; these
  // tests pin remote job reporting, with the orchestrator as the nudge target only, so they turn the window off.
  (await import('@/lib/coordinator-window')).configureCoordinatorWindow({
    now: () => Date.now(), isCoordinator: async () => false, lastGoverned: () => null, oldestDigestAt: () => null,
  });
  const alerts = vi.fn(async (_params: { kind: string; detail?: string }) => {});
  (manager as unknown as { dispatchAlert: typeof alerts }).dispatchAlert = alerts;
  manager.registerTab('o1', entry('o1'));
  manager.registerTab('w', entry('w', w));
  const internals = manager as unknown as {
    handleLivenessEvent: (event: TLivenessEvent) => Promise<void>;
    jobEventAt: Map<string, number>;
  };
  const rows = () => tabEvents().list('ws-1', { since: 0, limit: 100 });
  return { internals, paste, alerts, rows };
};

describe('a remote job whose host does not answer (D63, AC 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveness.statusForTab.mockResolvedValue({ probes: [], backgroundJobs: [] });
  });

  it('says "host unreachable", never "exited", to the orchestrator even for --notify self, and pages', async () => {
    const { internals, paste, alerts, rows } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    await internals.handleLivenessEvent(unreachable);
    expect(rows().map((r) => [r.tabId, r.kind, r.class])).toEqual([['o1', 'bg-host-unreachable', 'urgent']]);
    const message = paste.mock.calls[0][1];
    expect(paste.mock.calls.map(([session]) => session)).toEqual(['tmux-o1']);
    expect(message).toContain('HOST UNREACHABLE');
    expect(message).toContain('pid 157985 on ai-lan');
    expect(message).toContain('NOT known to have exited');
    expect(message).not.toMatch(/exited with/);
    expect(alerts.mock.calls.map(([p]) => p.kind)).toEqual(['bg-host-unreachable']);
    expect(alerts.mock.calls[0][0].detail).toContain('did not answer 3 probes');
    expect(internals.jobEventAt.has('w')).toBe(false);
  });

  it('is urgent wherever it goes: the host it names stops that worker', () => {
    expect(classifyWake('bg-host-unreachable')).toBe('urgent');
    expect(classifyWake('bg-host-unreachable', { toWaitingTab: false })).toBe('urgent');
  });

  it('goes to the reportsTo tab when it is live', async () => {
    const { internals, rows } = await setup({ enabled: true, orchestratorTabId: 'o1' }, { reportsTo: 'o1' });
    await internals.handleLivenessEvent(unreachable);
    expect(rows().map((r) => r.tabId)).toEqual(['o1']);
  });

  it('its episode is not the exit\'s: the real exit reported later still reaches the tab', async () => {
    const { internals, rows } = await setup({ enabled: true, orchestratorTabId: 'o1' });
    await internals.handleLivenessEvent(unreachable);
    await internals.handleLivenessEvent({ kind: 'bg-completed', job: remoteJob, exitCode: 0, stderrTail: null });
    expect(rows().map((r) => [r.tabId, r.kind])).toEqual([['o1', 'bg-host-unreachable'], ['w', 'bg-completed']]);
  });
});
