import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { ILayoutData, ITab } from '@/types/terminal';

// Review r2 nit 4: one real round trip of the watchdog's stop record through the
// layout file. No mocks on this path: the real layout store writes and reads
// under the test process's own HOME, which the story 31 setup points at a
// temporary root (tests/setup/isolated-home.ts), never the live ~/.purplemux.

const wsId = `ws-persist${Math.random().toString(36).slice(2, 8)}`;
const paneId = 'pane-p1';
const tabId = 'tab-t1';
const sessionName = `pt-${wsId}-${paneId}-${tabId}`;

const resetStores = () => {
  vi.resetModules();
  const g = globalThis as Record<string, unknown>;
  delete g.__ptLayoutContentCache;
  delete g.__ptLayoutLock;
  delete g.__ptTabLifecycle;
};

const readTab = async (): Promise<ITab> => {
  resetStores();
  const store = await import('@/lib/layout-store');
  const layout = await store.readLayoutFile(store.resolveLayoutFile(wsId));
  return store.collectAllTabs(layout!.root).find((t) => t.id === tabId)!;
};

const entryFor = (agentSessionId: string | null): ITabStatusEntry => ({
  cliState: 'ready-for-review', workspaceId: wsId, tabName: 'w', tmuxSession: sessionName, panelType: 'claude-code',
  agentSessionId, lastEvent: null, eventSeq: 0,
});

describe('watchdogTurnEnd persists through the real layout file (review r2 nit 4)', () => {
  afterEach(async () => {
    const store = await import('@/lib/layout-store');
    await fs.rm(store.resolveLayoutDir(wsId), { recursive: true, force: true });
  });

  it('writes the record through layout-store, and a rebuilt manager reads it back and restores the stop; another session\'s record is dropped from disk', async () => {
    const real = process.env.PMUX_TEST_REAL_HOME;
    expect(os.homedir()).not.toBe(real);

    const store = await import('@/lib/layout-store');
    expect(store.resolveLayoutFile(wsId).startsWith(os.homedir())).toBe(true);
    const layout: ILayoutData = {
      root: { type: 'pane', id: paneId, activeTabId: tabId, tabs: [{ id: tabId, sessionName, name: 'w', order: 0, panelType: 'claude-code', cliState: 'ready-for-review' }] },
      activePaneId: paneId,
      updatedAt: new Date().toISOString(),
    };
    await store.writeLayoutFile(layout, store.resolveLayoutFile(wsId));

    // Write: the manager records a markerless stop of session sess-1.
    const { StatusManager } = await import('@/lib/status-manager');
    const writer = new StatusManager();
    const entry = { ...entryFor('sess-1'), lastEvent: { name: 'stop' as const, at: 1_790_000_000_000, seq: 7 }, eventSeq: 7 };
    entry.turnEnd = { kind: 'ready-for-review', at: 1_790_000_000_000, seq: 7, transcript: true, idleNudgeSentSeq: 6 };
    writer.registerTab(tabId, entry);
    (writer as unknown as { persistTurnEnd: (e: ITabStatusEntry) => void }).persistTurnEnd(entry);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await fs.readFile(store.resolveLayoutFile(wsId), 'utf-8')) as ILayoutData;
      expect(raw.root.type === 'pane' && raw.root.tabs[0].watchdogTurnEnd?.seq).toBe(7);
    });
    writer.shutdown();

    // Read back with fresh modules, as after a restart.
    const persisted = await readTab();
    expect(persisted.cliState).toBe('ready-for-review');
    expect(persisted.watchdogTurnEnd).toEqual({
      kind: 'ready-for-review', at: 1_790_000_000_000, seq: 7, transcript: true, idleNudgeSentSeq: 6, agentSessionId: 'sess-1',
    });

    const { StatusManager: Rebuilt } = await import('@/lib/status-manager');
    const restore = (manager: unknown, tab: ITab, e: ITabStatusEntry) =>
      (manager as { applyRestoredStop: (t: ITab, x: ITabStatusEntry) => void }).applyRestoredStop(tab, e);
    const same = entryFor('sess-1');
    restore(new Rebuilt(), persisted, same);
    expect(same.lastEvent).toEqual({ name: 'stop', at: 1_790_000_000_000, seq: 7 });
    expect(same.eventSeq).toBe(7);
    expect(same.turnEnd).toMatchObject({ kind: 'ready-for-review', seq: 7, idleNudgeSentSeq: 6 });

    // The agent was relaunched while the server was down: the record is dropped, on disk too.
    const other = entryFor('sess-2');
    restore(new Rebuilt(), persisted, other);
    expect(other.lastEvent).toBeNull();
    expect(other.turnEnd ?? null).toBeNull();
    await vi.waitFor(async () => {
      const raw = JSON.parse(await fs.readFile(path.join(os.homedir(), '.purplemux', 'workspaces', wsId, 'layout.json'), 'utf-8')) as ILayoutData;
      expect(raw.root.type === 'pane' && raw.root.tabs[0].watchdogTurnEnd).toBeUndefined();
    });
  });

  it('an end-line stop survives a restart too (ADR-0023): restored to a ready-for-review tab or one dismissed to idle after it, dropped otherwise', async () => {
    // The first test's layout content cache would skip this identical write.
    resetStores();
    const store = await import('@/lib/layout-store');
    const layout: ILayoutData = {
      root: { type: 'pane', id: paneId, activeTabId: tabId, tabs: [{ id: tabId, sessionName, name: 'w', order: 0, panelType: 'claude-code', cliState: 'ready-for-review' }] },
      activePaneId: paneId,
      updatedAt: new Date().toISOString(),
    };
    await store.writeLayoutFile(layout, store.resolveLayoutFile(wsId));
    const { StatusManager } = await import('@/lib/status-manager');
    const writer = new StatusManager();
    const entry = { ...entryFor('sess-1'), lastEvent: { name: 'stop' as const, at: 1_790_000_000_000, seq: 9 }, eventSeq: 9 };
    entry.turnEnd = { kind: 'turn-marker', at: 1_790_000_000_000, seq: 9, marker: ['NEEDS-DECISION: q-1'] };
    writer.registerTab(tabId, entry);
    (writer as unknown as { persistTurnEnd: (e: ITabStatusEntry) => void }).persistTurnEnd(entry);
    await vi.waitFor(async () => {
      const raw = JSON.parse(await fs.readFile(store.resolveLayoutFile(wsId), 'utf-8')) as ILayoutData;
      expect(raw.root.type === 'pane' && raw.root.tabs[0].watchdogTurnEnd?.kind).toBe('turn-marker');
    });
    writer.shutdown();

    const persisted = await readTab();
    const { StatusManager: Rebuilt } = await import('@/lib/status-manager');
    const restore = (tab: ITab, e: ITabStatusEntry) =>
      (new Rebuilt() as unknown as { applyRestoredStop: (t: ITab, x: ITabStatusEntry) => void }).applyRestoredStop(tab, e);
    const rfr = { ...entryFor('sess-1'), cliState: 'ready-for-review' as const };
    restore(persisted, rfr);
    expect(rfr.turnEnd).toMatchObject({ kind: 'turn-marker', seq: 9, marker: ['NEEDS-DECISION: q-1'] });
    expect(rfr.lastEvent).toEqual({ name: 'stop', at: 1_790_000_000_000, seq: 9 });
    // Idle and dismissed after the stop: the line still stands.
    const dismissed = { ...entryFor('sess-1'), cliState: 'idle' as const };
    restore({ ...persisted, dismissedAt: 1_790_000_060_000 }, dismissed);
    expect(dismissed.turnEnd).toMatchObject({ kind: 'turn-marker', seq: 9 });
    // Idle with no dismiss since the stop: prompted then interrupted, so the line is stale.
    const interrupted = { ...entryFor('sess-1'), cliState: 'idle' as const };
    restore({ ...persisted, dismissedAt: null }, interrupted);
    expect(interrupted.turnEnd ?? null).toBeNull();
    expect(interrupted.lastEvent).toBeNull();
    const busy = { ...entryFor('sess-1'), cliState: 'unknown' as const };
    restore(persisted, busy);
    expect(busy.turnEnd ?? null).toBeNull();
  });
});
