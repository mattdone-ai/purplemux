import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InboxDispatcher, type IInboxDispatcherDeps } from '@/lib/inbox-dispatcher';
import { enqueueInState } from '@/lib/inbox-store';
import type { IInboxState } from '@/types/inbox';
import type { ITabStatusEntry } from '@/types/status';
import { memoryLedgerTables } from './tab-events-harness';

// The inbox asks the REAL StatusManager whether a busy tab is WAITING at its
// prompt (architect ruling A′-inbox), so a relaunch since the stop closes it.

const workspaceStore = vi.hoisted(() => ({ getWorkspaceByIdCached: vi.fn(), getWorkspacesCached: vi.fn() }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: workspaceStore.getWorkspaceByIdCached,
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: workspaceStore.getWorkspacesCached,
}));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })), removeTab: vi.fn() }) }));

const EMPTY = 'out\n────────\n❯ \n────────\n';

describe('inbox × StatusManager.isWaitingAtPrompt', () => {
  beforeEach(() => {
    vi.resetModules();
    workspaceStore.getWorkspaceByIdCached.mockResolvedValue(undefined);
    workspaceStore.getWorkspacesCached.mockResolvedValue({ workspaces: [] });
  });

  it('delivers to a WAITING tab, and types nothing after markAgentLaunch', async () => {
    const { StatusManager } = await import('@/lib/status-manager');
    const manager = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {}), ...memoryLedgerTables());
    const stopAt = Date.now() - 1_000;
    const entry: ITabStatusEntry = {
      cliState: 'busy', workspaceId: 'ws-1', tabName: 'w', tmuxSession: 'pt-ws-1-pane-a-tab-w', panelType: 'claude-code',
      lastEvent: { name: 'stop', at: stopAt, seq: 3 }, eventSeq: 3,
      turnEnd: { kind: 'waiting', at: stopAt, seq: 3, openBackgroundTasks: 1, liveRegisteredJobs: 0 },
    };
    manager.registerTab('tab-w', entry);

    let state: IInboxState = { items: [] };
    const deliver = vi.fn(async () => {});
    const deps: IInboxDispatcherDeps = {
      now: () => Date.now(),
      mutate: async (fn) => { const r = fn(state); state = r.state; return r.value; },
      findTab: async () => ({ id: 'tab-w', name: 'w', order: 0, sessionName: 'pt-ws-1-pane-a-tab-w', panelType: 'claude-code' }),
      tabGone: async () => false,
      hasSession: async () => true,
      status: (tabId) => manager.getAllForClient()[tabId],
      waitingAtPrompt: (tabId) => manager.isWaitingAtPrompt(tabId),
      halted: (tabId) => manager.isHaltedByUsageLimit(tabId),
      capture: async () => EMPTY,
      withDispatchLock: async (_ws, _tab, work) => work(async () => ({ ok: true }) as never),
      deliver,
      isPending: async () => false,
    };
    const dispatcher = new InboxDispatcher(deps);
    const enqueue = (key: string, id: string) => {
      state = enqueueInState(state, { kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-w', dedupeKey: key, fields: { resumeId: id } }, Date.now(), () => `i-${key}`).state;
    };

    enqueue('k1', 'r-first1');
    await dispatcher.tick();
    expect(deliver).toHaveBeenCalledTimes(1);

    manager.markAgentLaunch('tab-w');
    enqueue('k2', 'r-second');
    await dispatcher.tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(state.items.find((i) => i.id === 'i-k2')).toMatchObject({ state: 'queued', lastRefusal: 'composer-not-ready:busy' });
  });
});
