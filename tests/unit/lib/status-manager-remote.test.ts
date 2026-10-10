import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ADR-0022 §11: a remote terminal pane has no local pid. Its status is its foreground command
// alone (shell idle, anything else running); no port scan, no process walk runs on its pid.

const state = vi.hoisted(() => ({ command: 'bash', tab: null as ITab | null, pane: true, answered: true }));
const tmux = vi.hoisted(() => ({ getListeningPorts: vi.fn(async () => [8080]), getChildPids: vi.fn(async () => []) }));

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
  getAllPanesInfo: vi.fn(async () => Object.assign(
    state.pane
      ? new Map([['pt-ws-1-pane-a-tab-r', { pid: 0, command: state.command, path: '/home/mdone', windowActivity: 0, host: 'ai-server' }]])
      : new Map(),
    { answeredRemoteHosts: new Set(state.answered ? ['ai-server'] : []) },
  )),
  getListeningPorts: tmux.getListeningPorts,
  getChildPids: tmux.getChildPids,
  getPaneTitle: vi.fn(async () => ''),
}));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));
vi.mock('@/lib/session-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-host')>()),
  sessionHostOf: async (s: string) => (s === 'pt-ws-1-pane-a-tab-r' ? 'ai-server' : null),
}));

describe('status of a remote terminal tab (ADR-0022 §11)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.tab = { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-1-pane-a-tab-r', panelType: 'terminal', host: 'ai-server' };
  });
  afterEach(() => { state.command = 'bash'; state.pane = true; state.answered = true; });

  const poll = async () => {
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}));
    manager.registerTab('tab-r', { cliState: 'inactive', workspaceId: 'ws-1', tabName: 'r', tmuxSession: 'pt-ws-1-pane-a-tab-r', panelType: 'terminal', lastEvent: null, eventSeq: 0 });
    await manager.poll();
    return (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-r')!;
  };

  it('a shell in the foreground is idle', async () => {
    expect((await poll()).terminalStatus).toBe('idle');
  });

  it('any other foreground command is running, and its pid is never scanned for ports', async () => {
    state.command = 'vim';
    const entry = await poll();
    expect(entry.terminalStatus).toBe('running');
    expect(entry.listeningPorts).toEqual([]);
    expect(tmux.getListeningPorts).not.toHaveBeenCalled();
  });

  describe('a remote Claude tab whose pane is unread (review r3 B1)', () => {
    const T0 = new Date('2026-10-10T12:00:00Z').getTime();
    const setupAgent = async (cliState: 'busy' | 'ready-for-review' | 'unknown') => {
      state.tab = { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-1-pane-a-tab-r', panelType: 'claude-code', host: 'ai-server' };
      await import('@/lib/providers');
      const { StatusManager } = await import('@/lib/status-manager');
      const manager = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}));
      manager.registerTab('tab-r', {
        cliState, workspaceId: 'ws-1', tabName: 'r', tmuxSession: 'pt-ws-1-pane-a-tab-r', panelType: 'claude-code',
        lastEvent: { name: 'prompt-submit', at: T0 - 30 * 60_000, seq: 1 }, eventSeq: 1,
      });
      const entry = (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.get('tab-r')!;
      entry.paneTitle = 'claude|/home/mdone';
      return { manager, entry };
    };
    beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); });
    afterEach(() => vi.useRealTimers());

    it('a busy tab keeps busy for a missed scan and for the backoff, and the 10 min force never fires', async () => {
      state.pane = false;
      state.answered = false;
      const { manager, entry } = await setupAgent('busy');
      await manager.poll();
      expect(entry.cliState).toBe('busy');
      vi.setSystemTime(T0 + 20_000);
      await manager.poll();
      expect(entry.cliState).toBe('busy');
      expect(entry.paneTitle).toBe('claude|/home/mdone');
    });

    it('a ready-for-review tab is not made inactive while its pane is unread', async () => {
      state.pane = false;
      state.answered = false;
      const { manager, entry } = await setupAgent('ready-for-review');
      vi.setSystemTime(T0 + 60_000);
      await manager.poll();
      expect(entry.cliState).toBe('ready-for-review');
    });

    it('an answered scan without the session is real absence: the busy tab is forced idle as a local one would be', async () => {
      state.pane = false;
      state.answered = true;
      const { manager, entry } = await setupAgent('busy');
      await manager.poll();
      expect(entry.cliState).toBe('idle');
    });

    it('resolveUnknown keeps a remote tab unknown while its host is unread, and resolves it once the pane reads', async () => {
      state.pane = false;
      state.answered = false;
      const { manager, entry } = await setupAgent('unknown');
      await (manager as unknown as { resolveUnknown: (id: string) => Promise<void> }).resolveUnknown('tab-r');
      expect(entry.cliState).toBe('unknown');
      state.answered = true;
      await (manager as unknown as { resolveUnknown: (id: string) => Promise<void> }).resolveUnknown('tab-r');
      expect(entry.cliState).toBe('idle');
    });
  });
});
