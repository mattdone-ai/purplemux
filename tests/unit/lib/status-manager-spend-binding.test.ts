import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { ILayoutData, ITab } from '@/types/terminal';

// ADR-0030 §3: the status manager saves hook, launch and poll session ids through
// updateTabAgentState; each non-null id it saves binds the session to its tab.

const mockHome = vi.hoisted(() => ({ value: '' }));
const warn = vi.hoisted(() => vi.fn());

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceByIdCached: vi.fn(async () => null),
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })) }),
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

// The first load of this module graph costs about 1 s alone and passed the 5 s test budget on a loaded gate
// (story hfl2-53). Load it once here, at collection, outside every test's budget. vi.resetModules() discards
// this instance; each test's own import evaluates again from the transform cache in milliseconds.
await Promise.all([
  import('@/lib/layout-store'),
  import('@/lib/providers'),
  import('@/lib/status-manager'),
]);

const WS = 'ws-spend';
const session = (tabId: string) => `pt-${WS}-pane-a-${tabId}`;

const writeLayout = async (tabs: ITab[]) => {
  const store = await import('@/lib/layout-store');
  const layout: ILayoutData = {
    root: { type: 'pane', id: 'pane-a', activeTabId: tabs[0].id, tabs },
    activePaneId: 'pane-a',
    updatedAt: '2026-10-26T00:00:00.000Z',
  };
  await store.writeLayoutFile(layout, store.resolveLayoutFile(WS));
};

const bindings = async (): Promise<Record<string, { workspaceId: string; tabId: string }>> => {
  const raw = await fs.readFile(path.join(mockHome.value, '.purplemux', 'session-tabs.json'), 'utf-8').catch(() => null);
  return raw ? (JSON.parse(raw) as { bindings: Record<string, { workspaceId: string; tabId: string }> }).bindings : {};
};

const entry = (tabId: string, panelType: 'codex-cli' | 'claude-code'): ITabStatusEntry => ({
  cliState: 'idle',
  workspaceId: WS,
  tabName: tabId,
  tmuxSession: session(tabId),
  panelType,
  agentProviderId: panelType === 'codex-cli' ? 'codex' : 'claude',
});

const newManager = async () => {
  await import('@/lib/providers');
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(undefined, vi.fn(async () => true));
  (manager as unknown as { poll: () => Promise<void> }).poll = async () => {};
  return manager;
};

describe('status manager session saves record the spend binding (ADR-0030 §3)', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as { __ptSessionTabsSeen?: unknown }).__ptSessionTabsSeen;
    delete (globalThis as { __ptSessionTabsRefusedAt?: unknown }).__ptSessionTabsRefusedAt;
    warn.mockClear();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-status-spend-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('binds the session a SessionStart hook reports for a tab made after boot', async () => {
    await writeLayout([{ id: 'tab-new', sessionName: session('tab-new'), name: 'worker', order: 0, panelType: 'codex-cli' }]);
    const manager = await newManager();
    manager.registerTab('tab-new', entry('tab-new', 'codex-cli'));
    try {
      expect(manager.applyAgentHookMeta('codex', session('tab-new'), { sessionId: 'codex-s1', jsonlPath: null }))
        .toMatchObject({ tabId: 'tab-new' });
      await vi.waitFor(async () => expect((await bindings())['codex:codex-s1']).toMatchObject({ workspaceId: WS, tabId: 'tab-new' }));
    } finally {
      manager.shutdown();
    }
  });

  it('binds the new session after a launch reset (restart --clear) to the same tab id', async () => {
    await writeLayout([{
      id: 'tab-c', sessionName: session('tab-c'), name: 'worker', order: 0, panelType: 'claude-code',
      agentState: { providerId: 'claude', sessionId: 'claude-old', jsonlPath: null, summary: null },
    }]);
    const manager = await newManager();
    manager.registerTab('tab-c', { ...entry('tab-c', 'claude-code'), agentSessionId: 'claude-old' });
    try {
      manager.applyAgentHookMeta('claude', session('tab-c'), { sessionId: 'claude-old', jsonlPath: null });
      manager.markAgentLaunch('tab-c', { resetAgentSession: true });
      const store = await import('@/lib/layout-store');
      await vi.waitFor(async () => {
        const layout = await store.readLayoutFile(store.resolveLayoutFile(WS));
        expect(layout && store.collectAllTabs(layout.root)[0].agentState?.sessionId).toBeNull();
      });
      manager.applyAgentHookMeta('claude', session('tab-c'), { sessionId: 'claude-new', jsonlPath: null });
      await vi.waitFor(async () => expect((await bindings())['claude:claude-new']).toMatchObject({ workspaceId: WS, tabId: 'tab-c' }));
    } finally {
      manager.shutdown();
    }
  });

  it('saves the hook session id when the binding store is damaged', async () => {
    await writeLayout([{ id: 'tab-d', sessionName: session('tab-d'), name: 'worker', order: 0, panelType: 'codex-cli' }]);
    const storeFile = path.join(mockHome.value, '.purplemux', 'session-tabs.json');
    await fs.writeFile(storeFile, 'not json');
    const manager = await newManager();
    manager.registerTab('tab-d', entry('tab-d', 'codex-cli'));
    try {
      manager.applyAgentHookMeta('codex', session('tab-d'), { sessionId: 'codex-d1', jsonlPath: null });
      const store = await import('@/lib/layout-store');
      await vi.waitFor(async () => {
        const layout = await store.readLayoutFile(store.resolveLayoutFile(WS));
        expect(layout && store.collectAllTabs(layout.root)[0].agentState?.sessionId).toBe('codex-d1');
      });
      expect(await fs.readFile(storeFile, 'utf-8')).toBe('not json');
    } finally {
      manager.shutdown();
    }
  });

  it('reads a damaged binding store once and warns once across many hook saves', async () => {
    await writeLayout([{ id: 'tab-n', sessionName: session('tab-n'), name: 'worker', order: 0, panelType: 'codex-cli' }]);
    const storeFile = path.join(mockHome.value, '.purplemux', 'session-tabs.json');
    await fs.writeFile(storeFile, 'not json');
    const readFile = vi.spyOn(fs, 'readFile');
    const manager = await newManager();
    manager.registerTab('tab-n', entry('tab-n', 'codex-cli'));
    try {
      const store = await import('@/lib/layout-store');
      for (let i = 0; i < 10; i += 1) {
        manager.applyAgentHookMeta('codex', session('tab-n'), { sessionId: `codex-n${i}`, jsonlPath: null });
        await vi.waitFor(async () => {
          const layout = await store.readLayoutFile(store.resolveLayoutFile(WS));
          expect(layout && store.collectAllTabs(layout.root)[0].agentState?.sessionId).toBe(`codex-n${i}`);
        });
      }
      await vi.waitFor(() => expect(warn.mock.calls.filter(([message]) => String(message).includes(storeFile))).toHaveLength(1));
      expect(readFile.mock.calls.filter(([target]) => target === storeFile)).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      manager.shutdown();
    }
  });
});
