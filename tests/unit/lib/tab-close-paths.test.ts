import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData } from '@/types/terminal';

// ADR-0016 / story 16 review r1 finding 2: every close path hands the tab id
// to killSession, so the tab's processes are reaped whichever way it closes.

const mockHome = vi.hoisted(() => ({ value: '' }));
const REAP = { reaper: 'linux', envMarker: 'present', killed: [{ pid: 4242, comm: 'sleep', args: 'sleep 600' }], survivors: [] };
const tmux = vi.hoisted(() => ({ killSession: vi.fn(), assertRemoteHostsAnswer: vi.fn(async (_names: readonly string[]) => {}) }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: tmux.killSession,
  assertRemoteHostsAnswer: tmux.assertRemoteHostsAnswer,
  listSessions: vi.fn(async () => []),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/claude', () => ({ claudeProvider: {} }));

const WS = 'ws-close';

const layout = (): ILayoutData => ({
  root: {
    type: 'split',
    orientation: 'horizontal',
    ratio: 50,
    children: [
      {
        type: 'pane',
        id: 'pane-a',
        activeTabId: 'tab-a1',
        tabs: [
          { id: 'tab-a1', sessionName: 's-a1', name: 'a1', order: 0 },
          { id: 'tab-a2', sessionName: 's-a2', name: 'a2', order: 1, panelType: 'claude-code' },
          { id: 'tab-web', sessionName: 's-web', name: 'web', order: 2, panelType: 'web-browser' },
        ],
      },
      { type: 'pane', id: 'pane-b', activeTabId: 'tab-b1', tabs: [{ id: 'tab-b1', sessionName: 's-b1', name: 'b1', order: 0 }] },
    ],
  },
  activePaneId: 'pane-a',
  updatedAt: '2026-09-26T00:00:00.000Z',
});

describe('every close path reaps by tab id (ADR-0016)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tmux.killSession.mockResolvedValue(REAP);
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-close-paths-'));
    const store = await import('@/lib/layout-store');
    await store.writeLayoutFile(layout(), store.resolveLayoutFile(WS));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('closeTab (CLI `tab close`) passes the tab id and returns the reap', async () => {
    const store = await import('@/lib/layout-store');
    expect(await store.closeTab(WS, 'pane-a', 'tab-a2')).toEqual({ ok: true, reap: REAP });
    expect(tmux.killSession).toHaveBeenCalledWith('s-a2', { tabId: 'tab-a2', keepProcesses: undefined });
  });

  it('closeTab --keep-processes passes keepProcesses', async () => {
    const store = await import('@/lib/layout-store');
    await store.closeTab(WS, 'pane-a', 'tab-a2', { keepProcesses: true });
    expect(tmux.killSession).toHaveBeenCalledWith('s-a2', { tabId: 'tab-a2', keepProcesses: true });
  });

  it('removeTabFromPane (the UI close, including the auto-close after the shell exits) passes the tab id', async () => {
    const store = await import('@/lib/layout-store');
    expect(await store.removeTabFromPane(WS, 'pane-a', 'tab-a1')).toBe(true);
    expect(tmux.killSession).toHaveBeenCalledWith('s-a1', { tabId: 'tab-a1', keepProcesses: undefined });
  });

  it('a browser tab has no session and no processes to reap', async () => {
    const store = await import('@/lib/layout-store');
    expect(await store.closeTab(WS, 'pane-a', 'tab-web')).toEqual({ ok: true, reap: null });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it('closePaneInLayout passes each non-browser tab its own id', async () => {
    const store = await import('@/lib/layout-store');
    await store.closePaneInLayout(WS, 'pane-a');
    expect(tmux.killSession.mock.calls).toEqual(expect.arrayContaining([
      ['s-a1', { tabId: 'tab-a1' }],
      ['s-a2', { tabId: 'tab-a2' }],
    ]));
    expect(tmux.killSession).toHaveBeenCalledTimes(2);
  });

  it('deleteWorkspace passes every tab its own id', async () => {
    const workspaces = await import('@/lib/workspace-store');
    const dir = path.join(mockHome.value, 'proj');
    await fs.mkdir(dir);
    const ws = await workspaces.createWorkspace(dir);
    const store = await import('@/lib/layout-store');
    await store.writeLayoutFile(layout(), store.resolveLayoutFile(ws.id));
    tmux.killSession.mockClear();
    expect(await workspaces.deleteWorkspace(ws.id)).toBe(true);
    expect(tmux.killSession.mock.calls).toEqual(expect.arrayContaining([
      ['s-a1', { tabId: 'tab-a1' }],
      ['s-a2', { tabId: 'tab-a2' }],
      ['s-b1', { tabId: 'tab-b1' }],
    ]));
  });

  describe('a workspace with a remote tab (ADR-0022, review r1 B3)', () => {
    const withRemote = (): ILayoutData => {
      const l = layout();
      const paneB = (l.root as unknown as { children: Array<{ tabs: ILayoutData['root'] extends never ? never : Array<Record<string, unknown>> }> }).children[1];
      paneB.tabs.push({ id: 'tab-r', sessionName: 's-r', name: 'r', order: 1, host: 'ai-server' });
      return l;
    };
    const create = async () => {
      const workspaces = await import('@/lib/workspace-store');
      const dir = path.join(mockHome.value, `proj-${Math.random().toString(36).slice(2)}`);
      await fs.mkdir(dir);
      const ws = await workspaces.createWorkspace(dir);
      const store = await import('@/lib/layout-store');
      await store.writeLayoutFile(withRemote(), store.resolveLayoutFile(ws.id));
      tmux.killSession.mockClear();
      return { workspaces, ws, store };
    };

    it('a host that does not answer refuses the delete before any tab is reaped or any file changes', async () => {
      const { workspaces, ws, store } = await create();
      const { RemoteHostError } = await import('@/lib/remote-host');
      tmux.assertRemoteHostsAnswer.mockRejectedValueOnce(new RemoteHostError('ai-server', 'did not answer'));
      await expect(workspaces.deleteWorkspace(ws.id)).rejects.toMatchObject({ name: 'RemoteHostError', host: 'ai-server' });
      expect(tmux.killSession).not.toHaveBeenCalled();
      expect((await workspaces.getWorkspaces()).workspaces.map((w) => w.id)).toContain(ws.id);
      expect(await store.readLayoutFile(store.resolveLayoutFile(ws.id))).not.toBeNull();
    });

    it('a remote kill that fails after the check stops the delete with every local tab untouched', async () => {
      const { workspaces, ws } = await create();
      const { RemoteHostError } = await import('@/lib/remote-host');
      tmux.killSession.mockImplementation(async (name: string) => {
        if (name === 's-r') throw new RemoteHostError('ai-server', 'could not close');
        return REAP;
      });
      await expect(workspaces.deleteWorkspace(ws.id)).rejects.toMatchObject({ name: 'RemoteHostError' });
      expect(tmux.killSession.mock.calls.map((c) => c[0])).toEqual(['s-r']);
      expect((await workspaces.getWorkspaces()).workspaces.map((w) => w.id)).toContain(ws.id);
    });

    it('closes the remote tab first, then the local ones, then deletes', async () => {
      const { workspaces, ws } = await create();
      expect(await workspaces.deleteWorkspace(ws.id)).toBe(true);
      expect(tmux.killSession.mock.calls[0]).toEqual(['s-r', { tabId: 'tab-r' }]);
      const names = tmux.killSession.mock.calls.map((c) => c[0]);
      expect(names).toEqual(expect.arrayContaining(['s-a1', 's-a2', 's-b1']));
      expect(names.filter((n) => n === 's-r')).toHaveLength(1);
    });
  });

  // L38: a deliberate close announces itself BEFORE the reap, so the watchdog never reads it as a death.
  describe('tab-closing is announced before the reap (L38)', () => {
    const record = async () => {
      const { onTabClosing } = await import('@/lib/tab-lifecycle');
      const events: string[] = [];
      tmux.killSession.mockImplementation(async (session: string) => {
        events.push(`kill:${session}`);
        return REAP;
      });
      const off = onTabClosing((e) => events.push(`${e.phase}:${e.tabId}:${e.sessionName}:${e.workspaceId}`));
      return { events, off };
    };

    it('closeTab announces closing, then reaps; no abort on success', async () => {
      const { events, off } = await record();
      const store = await import('@/lib/layout-store');
      try {
        expect((await store.closeTab(WS, 'pane-a', 'tab-a2')).ok).toBe(true);
        expect(events).toEqual([`closing:tab-a2:s-a2:${WS}`, 'kill:s-a2']);
      } finally {
        off();
      }
    });

    it('closeTab announces aborted when the reap throws, and rethrows', async () => {
      const { events, off } = await record();
      tmux.killSession.mockRejectedValueOnce(new Error('tmux unreachable'));
      const store = await import('@/lib/layout-store');
      try {
        await expect(store.closeTab(WS, 'pane-a', 'tab-a2')).rejects.toThrow('tmux unreachable');
        expect(events).toEqual([`closing:tab-a2:s-a2:${WS}`, `aborted:tab-a2:s-a2:${WS}`]);
      } finally {
        off();
      }
    });

    it('closeTab announces nothing for a tab it cannot find', async () => {
      const { events, off } = await record();
      const store = await import('@/lib/layout-store');
      try {
        expect((await store.closeTab(WS, 'pane-a', 'tab-nope')).ok).toBe(false);
        expect(events).toEqual([]);
      } finally {
        off();
      }
    });

    it('deleteWorkspace announces each tab before its reap', async () => {
      const workspaces = await import('@/lib/workspace-store');
      const dir = path.join(mockHome.value, 'proj2');
      await fs.mkdir(dir);
      const ws = await workspaces.createWorkspace(dir);
      const store = await import('@/lib/layout-store');
      await store.writeLayoutFile(layout(), store.resolveLayoutFile(ws.id));
      const { events, off } = await record();
      try {
        expect(await workspaces.deleteWorkspace(ws.id)).toBe(true);
        const closingA1 = events.indexOf(`closing:tab-a1:s-a1:${ws.id}`);
        expect(closingA1).toBeGreaterThanOrEqual(0);
        expect(events.indexOf('kill:s-a1')).toBeGreaterThan(closingA1);
      } finally {
        off();
      }
    });
  });
});
