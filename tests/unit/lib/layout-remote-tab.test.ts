import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData } from '@/types/terminal';

// ADR-0022 §2, §3, §7: a remote tab keeps its host in the layout, is registered
// before its session exists, is never recreated locally, and never feeds its
// remote cwd into the workspace directories.

const mockHome = vi.hoisted(() => ({ value: '' }));
const tmux = vi.hoisted(() => ({
  createSession: vi.fn(async (..._args: unknown[]) => {}),
  hasSession: vi.fn(async (_name: string) => false),
  hasSessionOrUnreachable: vi.fn(async (_name: string) => false),
  assertRemoteHostsAnswer: vi.fn(async (_names: readonly string[]) => {}),
  observeSessionStrict: vi.fn(async () => ({ state: 'absent', reason: 'tmux said so' })),
  killSession: vi.fn(async (..._args: unknown[]) => null),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd ?? '/home'),
  sendKeys: vi.fn(async () => {}),
}));
const hostAtCreate = vi.hoisted(() => ({ value: undefined as string | null | undefined }));
const workspaceStore = vi.hoisted(() => ({ updateWorkspaceDirectories: vi.fn(async (_ws: string, _dirs: string[]) => {}) }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({
  ...tmux,
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/claude', () => ({ claudeProvider: {} }));
vi.mock('@/lib/workspace-store', () => workspaceStore);

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled', '__ptLayoutContentCache', '__ptLayoutLock', '__ptSessionHosts']) {
    delete g[key];
  }
};

const layoutFile = (wsId: string) => path.join(mockHome.value, '.purplemux', 'workspaces', wsId, 'layout.json');

const writeLayout = async (wsId: string, layout: ILayoutData) => {
  await fs.mkdir(path.dirname(layoutFile(wsId)), { recursive: true });
  await fs.writeFile(layoutFile(wsId), JSON.stringify(layout));
};

const baseLayout = (tabs: ILayoutData['root'] extends infer _ ? Array<Record<string, unknown>> : never): ILayoutData => ({
  root: { type: 'pane', id: 'pane-1', activeTabId: null, tabs: tabs as never },
  activePaneId: 'pane-1',
  updatedAt: '2026-10-10T00:00:00.000Z',
});

describe('remote tabs in the layout store (ADR-0022)', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetGlobals();
    vi.clearAllMocks();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-layout-remote-'));
    tmux.createSession.mockImplementation(async (...args: unknown[]) => {
      const { sessionHostOf } = await import('@/lib/session-host');
      hostAtCreate.value = await sessionHostOf(args[0] as string);
    });
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('registers the host before the session is created and persists it on the tab', async () => {
    await writeLayout('ws-a', baseLayout([]));
    const { addTabToPane } = await import('@/lib/layout-store');
    const tab = await addTabToPane('ws-a', 'pane-1', 'w1', '/home/mdone/code', 'terminal', undefined, { host: 'ai-server' });
    expect(tab?.host).toBe('ai-server');
    expect(hostAtCreate.value).toBe('ai-server');
    const saved = JSON.parse(await fs.readFile(layoutFile('ws-a'), 'utf-8')) as ILayoutData;
    expect((saved.root as { tabs: Array<{ host?: string }> }).tabs[0].host).toBe('ai-server');
  });

  it('forgets the host of a remote session whose creation failed', async () => {
    await writeLayout('ws-a', baseLayout([]));
    tmux.createSession.mockRejectedValueOnce(new Error('ssh failed'));
    const { addTabToPane } = await import('@/lib/layout-store');
    await expect(addTabToPane('ws-a', 'pane-1', 'w1', '/x', 'terminal', undefined, { host: 'ai-server' })).rejects.toThrow('ssh failed');
    const { knownRemoteHosts } = await import('@/lib/session-host');
    expect(knownRemoteHosts()).toEqual([]);
  });

  it('a local tab carries no host', async () => {
    await writeLayout('ws-a', baseLayout([]));
    const { addTabToPane } = await import('@/lib/layout-store');
    const tab = await addTabToPane('ws-a', 'pane-1', 'l1', '/home', 'terminal');
    expect(tab && 'host' in tab).toBe(false);
  });

  it('the boot cross-check never recreates a remote agent tab on this host', async () => {
    const { crossCheckLayout } = await import('@/lib/layout-store');
    const layout = baseLayout([
      { id: 'tab-r', sessionName: 'pt-ws-a-pane-1-tab-r', name: '', order: 0, panelType: 'claude-code', host: 'ai-server' },
      { id: 'tab-l', sessionName: 'pt-ws-a-pane-1-tab-l', name: '', order: 1, panelType: 'claude-code' },
    ]);
    await crossCheckLayout(layout, [], 'ws-a', '/home');
    expect(tmux.createSession.mock.calls.map((c) => c[0])).toEqual(['pt-ws-a-pane-1-tab-l']);
  });

  it('a remote tab adds no directory to the workspace', async () => {
    await writeLayout('ws-a', baseLayout([]));
    const { addTabToPane } = await import('@/lib/layout-store');
    await addTabToPane('ws-a', 'pane-1', 'w1', '/only/on/ai-server', 'terminal', undefined, { host: 'ai-server' });
    await addTabToPane('ws-a', 'pane-1', 'l1', '/home/local', 'terminal');
    await vi.waitFor(() => expect(workspaceStore.updateWorkspaceDirectories).toHaveBeenCalled());
    expect(workspaceStore.updateWorkspaceDirectories.mock.calls).toEqual([['ws-a', ['/home/local']]]);
  });

  it('restarting a remote tab keeps its cwd: the local filesystem says nothing about the remote one', async () => {
    await writeLayout('ws-a', baseLayout([
      { id: 'tab-r', sessionName: 'pt-ws-a-pane-1-tab-r', name: '', order: 0, panelType: 'terminal', cwd: '/only/on/ai-server', host: 'ai-server' },
    ]));
    const { restartTabSession } = await import('@/lib/layout-store');
    expect(await restartTabSession('ws-a', 'pane-1', 'tab-r')).toBe(true);
    expect(tmux.resolveExistingDir).not.toHaveBeenCalled();
    expect(tmux.createSession).toHaveBeenCalledWith('pt-ws-a-pane-1-tab-r', 80, 24, '/only/on/ai-server', { workspaceId: 'ws-a', tabId: 'tab-r' });
  });

  it('restart never recreates over a host that does not answer (review r1 B2)', async () => {
    await writeLayout('ws-a', baseLayout([
      { id: 'tab-r', sessionName: 'pt-ws-a-pane-1-tab-r', name: '', order: 0, panelType: 'terminal', host: 'ai-server' },
    ]));
    const { RemoteHostError } = await import('@/lib/remote-host');
    tmux.hasSessionOrUnreachable.mockRejectedValueOnce(new RemoteHostError('ai-server', 'did not answer'));
    const { restartTabSession } = await import('@/lib/layout-store');
    await expect(restartTabSession('ws-a', 'pane-1', 'tab-r')).rejects.toMatchObject({ name: 'RemoteHostError' });
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it('a pane close asks the remote hosts first and reaps nothing local when one does not answer (review r1 B3)', async () => {
    const twoPanes: ILayoutData = {
      root: {
        type: 'split', orientation: 'horizontal', ratio: 50,
        children: [
          { type: 'pane', id: 'pane-1', activeTabId: 'tab-l', tabs: [
            { id: 'tab-l', sessionName: 'pt-ws-a-pane-1-tab-l', name: '', order: 0, panelType: 'terminal' },
            { id: 'tab-r', sessionName: 'pt-ws-a-pane-1-tab-r', name: '', order: 1, panelType: 'terminal', host: 'ai-server' },
          ] },
          { type: 'pane', id: 'pane-2', activeTabId: null, tabs: [] },
        ],
      } as never,
      activePaneId: 'pane-1',
      updatedAt: '2026-10-10T00:00:00.000Z',
    };
    await writeLayout('ws-a', twoPanes);
    const { RemoteHostError } = await import('@/lib/remote-host');
    tmux.assertRemoteHostsAnswer.mockRejectedValueOnce(new RemoteHostError('ai-server', 'did not answer'));
    const { closePaneInLayout } = await import('@/lib/layout-store');
    await expect(closePaneInLayout('ws-a', 'pane-1')).rejects.toMatchObject({ name: 'RemoteHostError' });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(layoutFile('ws-a'), 'utf-8'))).toEqual(twoPanes);

    tmux.killSession.mockClear();
    expect(await closePaneInLayout('ws-a', 'pane-1')).not.toBeNull();
    expect(tmux.killSession.mock.calls.map((c) => c[0])).toEqual(['pt-ws-a-pane-1-tab-r', 'pt-ws-a-pane-1-tab-l']);
  });

  it('the legacy pane delete lets a remote refusal through instead of discarding it (review r1 B3)', async () => {
    const { registerSessionHost } = await import('@/lib/session-host');
    registerSessionHost('pt-ws-a-pane-9-tab-r', 'ai-server');
    const { RemoteHostError } = await import('@/lib/remote-host');
    tmux.assertRemoteHostsAnswer.mockRejectedValueOnce(new RemoteHostError('ai-server', 'did not answer'));
    const { deletePane } = await import('@/lib/layout-store');
    await expect(deletePane('pane-9', ['pt-local-x-y', 'pt-ws-a-pane-9-tab-r'])).rejects.toMatchObject({ name: 'RemoteHostError' });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it('a lost attach never rewrites a remote tab\'s cwd from this host\'s filesystem', async () => {
    await writeLayout('ws-a', baseLayout([
      { id: 'tab-r', sessionName: 'pt-ws-a-pane-1-tab-r', name: '', order: 0, panelType: 'terminal', cwd: '/only/on/ai-server', host: 'ai-server' },
    ]));
    tmux.resolveExistingDir.mockResolvedValueOnce('/home');
    const { reconcileTabCwd } = await import('@/lib/layout-store');
    await reconcileTabCwd('pt-ws-a-pane-1-tab-r');
    expect(tmux.resolveExistingDir).not.toHaveBeenCalled();
    expect((JSON.parse(await fs.readFile(layoutFile('ws-a'), 'utf-8')) as { root: { tabs: Array<{ cwd: string }> } }).root.tabs[0].cwd).toBe('/only/on/ai-server');
  });

  it('a remote tab with pending agent work closes on a remote reap with no survivors and tmux-proven absence', async () => {
    await writeLayout('ws-a', baseLayout([
      { id: 'tab-r', sessionName: 'pt-ws-a-pane-1-tab-r', name: '', order: 0, panelType: 'claude-code', host: 'ai-server',
        orchestrationActivity: { sessionName: 'pt-ws-a-pane-1-tab-r', runtimeGeneration: 'g', launch: { at: 1 }, turn: { generation: 't', runtimeGeneration: 'g', at: 2 } } },
    ]));
    tmux.killSession.mockResolvedValueOnce({ reaper: 'remote', envMarker: 'present', killed: [], survivors: [] } as never);
    const { closeTab } = await import('@/lib/layout-store');
    expect((await closeTab('ws-a', 'pane-1', 'tab-r')).ok).toBe(true);
  });

  it('a remote reap with a survivor keeps the pending tab', async () => {
    await writeLayout('ws-a', baseLayout([
      { id: 'tab-r', sessionName: 'pt-ws-a-pane-1-tab-r', name: '', order: 0, panelType: 'claude-code', host: 'ai-server',
        orchestrationActivity: { sessionName: 'pt-ws-a-pane-1-tab-r', runtimeGeneration: 'g', launch: { at: 1 } } },
    ]));
    tmux.killSession.mockResolvedValueOnce({ reaper: 'remote', envMarker: 'present', killed: [], survivors: [{ pid: 9, comm: 'x', args: 'x' }] } as never);
    const { closeTab } = await import('@/lib/layout-store');
    await expect(closeTab('ws-a', 'pane-1', 'tab-r')).rejects.toThrow('Pending work retained');
  });

  it('a pane close forgets the hosts of the tabs it closed', async () => {
    const { registerSessionHost, knownRemoteHosts } = await import('@/lib/session-host');
    const twoPanes: ILayoutData = {
      root: { type: 'split', orientation: 'horizontal', ratio: 50, children: [
        { type: 'pane', id: 'pane-1', activeTabId: 'tab-r', tabs: [{ id: 'tab-r', sessionName: 'pt-ws-a-pane-1-tab-r', name: '', order: 0, panelType: 'terminal', host: 'ai-server' }] },
        { type: 'pane', id: 'pane-2', activeTabId: null, tabs: [] },
      ] } as never,
      activePaneId: 'pane-1',
      updatedAt: '2026-10-10T00:00:00.000Z',
    };
    await writeLayout('ws-a', twoPanes);
    registerSessionHost('pt-ws-a-pane-1-tab-r', 'ai-server');
    const { closePaneInLayout } = await import('@/lib/layout-store');
    await closePaneInLayout('ws-a', 'pane-1');
    expect(knownRemoteHosts()).toEqual([]);
  });

  it('closing a remote tab forgets its host', async () => {
    await writeLayout('ws-a', baseLayout([]));
    const { addTabToPane, closeTab } = await import('@/lib/layout-store');
    const tab = await addTabToPane('ws-a', 'pane-1', 'w1', '/x', 'terminal', undefined, { host: 'ai-server' });
    expect((await closeTab('ws-a', 'pane-1', tab!.id)).ok).toBe(true);
    const { knownRemoteHosts } = await import('@/lib/session-host');
    expect(knownRemoteHosts()).toEqual([]);
  });
});
