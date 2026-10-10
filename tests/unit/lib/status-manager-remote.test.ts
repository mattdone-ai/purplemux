import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ADR-0022 §11: a remote terminal pane has no local pid. Its status is its foreground command
// alone (shell idle, anything else running); no port scan, no process walk runs on its pid.

const state = vi.hoisted(() => ({ command: 'bash', tab: null as ITab | null }));
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
  getAllPanesInfo: vi.fn(async () => new Map([['pt-ws-1-pane-a-tab-r', { pid: 0, command: state.command, path: '/home/mdone', windowActivity: 0, host: 'ai-server' }]])),
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

describe('status of a remote terminal tab (ADR-0022 §11)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.tab = { id: 'tab-r', name: 'r', order: 0, sessionName: 'pt-ws-1-pane-a-tab-r', panelType: 'terminal', host: 'ai-server' };
  });
  afterEach(() => { state.command = 'bash'; });

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
});
