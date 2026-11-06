import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';

const sweeper = vi.hoisted(() => ({ sweep: vi.fn(async () => []) }));
const agentSource = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock('@/lib/lease-sweeper', () => ({
  getLeaseSweeper: () => sweeper,
  setLeaseAgentStateSource: agentSource.set,
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspaceByIdCached: vi.fn(async () => undefined),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ tick: vi.fn(async () => {}), removeTab: vi.fn(), statusForTab: vi.fn() }),
}));
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/tmux')>()),
  getAllPanesInfo: vi.fn(async () => new Map()),
}));

// The first load of this module graph costs about 1 s alone and passed the 5 s test budget on a loaded gate
// (story hfl2-53). Load it once here, at collection, outside every test's budget; the tests' own imports
// resolve to this instance.
await import('@/lib/status-manager');

const entry = (cliState: ITabStatusEntry['cliState'], panelType: ITabStatusEntry['panelType']): ITabStatusEntry => ({
  cliState, workspaceId: 'ws-1', tabName: 't', tmuxSession: 's', panelType,
});

describe('StatusManager ↔ lease sweeper wiring', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports agent state for a known tab and null for an unknown one', async () => {
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager();
    const tabs = (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs;
    tabs.set('tab-agent', entry('inactive', 'claude-code'));
    tabs.set('tab-term', entry('inactive', 'terminal'));

    expect(manager.getTabAgentState('tab-agent')).toEqual({ cliState: 'inactive', isAgent: true });
    expect(manager.getTabAgentState('tab-term')).toEqual({ cliState: 'inactive', isAgent: false });
    expect(manager.getTabAgentState('tab-none')).toBeNull();
  });

  it('sweeps leases on every poll', async () => {
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager();
    await manager.poll();
    expect(sweeper.sweep).toHaveBeenCalledTimes(1);
  });

  it('registers itself as the sweeper\'s agent-state source when the singleton is created', async () => {
    const { getStatusManager } = await import('@/lib/status-manager');
    const manager = getStatusManager();
    expect(agentSource.set).toHaveBeenCalledTimes(1);
    const source = agentSource.set.mock.calls[0][0] as (tabId: string) => unknown;
    (manager as unknown as { tabs: Map<string, ITabStatusEntry> }).tabs.set('tab-x', entry('busy', 'codex-cli'));
    expect(source('tab-x')).toEqual({ cliState: 'busy', isAgent: true });
  });
});

describe('server boot order', () => {
  it('runs the boot lease sweep after the StatusManager init and before the server listens', () => {
    const server = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'server.ts'), 'utf-8');
    const init = server.indexOf('await getStatusManager().init();');
    const leases = server.indexOf('await initLeases();');
    const tokens = server.indexOf('await initTabTokens();');
    // initAccessFilter precedes the bind inside start(); the .listen( helpers are defined above it.
    const bind = server.indexOf('initAccessFilter(envHost');
    expect(init).toBeGreaterThan(0);
    expect(tokens).toBeGreaterThan(0);
    expect(bind).toBeGreaterThan(0);
    expect(leases).toBeGreaterThan(init);
    expect(tokens).toBeLessThan(init);
    expect(leases).toBeLessThan(bind);
  });
});
