import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData, ITab } from '@/types/terminal';
import type { IAgentProvider } from '@/lib/providers/types';

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
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sendKeys: vi.fn(async () => {}),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/providers/claude', () => ({ claudeProvider: {} }));

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T12:00:00Z');
const storeFile = () => path.join(mockHome.value, '.purplemux', 'session-tabs.json');
const stored = async () => JSON.parse(await fs.readFile(storeFile(), 'utf-8'));
const storeWarnings = () => warn.mock.calls.filter(([message]) => String(message).includes('session-tabs.json'));
const countStoreReads = (fsModule: typeof fs) => {
  const readFile = vi.spyOn(fsModule, 'readFile');
  return () => readFile.mock.calls.filter(([target]) => target === storeFile()).length;
};

const fakeProvider = (id: string): IAgentProvider => ({
  id,
  readSessionId: (tab: ITab) => (tab as ITab & { fakeSession?: string | null }).fakeSession ?? null,
  writeSessionId: (tab: ITab, sessionId: string | null | undefined) => { (tab as ITab & { fakeSession?: string | null }).fakeSession = sessionId ?? null; },
  readJsonlPath: () => null,
  writeJsonlPath: () => {},
  readSummary: () => null,
  writeSummary: () => {},
} as unknown as IAgentProvider);

describe('session-tabs store', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as { __ptSessionTabsSeen?: unknown }).__ptSessionTabsSeen;
    delete (globalThis as { __ptSessionTabsRefusedAt?: unknown }).__ptSessionTabsRefusedAt;
    warn.mockClear();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-session-tabs-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads no binding before the first record', async () => {
    const { readSessionTabs } = await import('@/lib/spend/session-tabs-store');
    expect(await readSessionTabs()).toEqual({});
  });

  it('records a binding privately, keyed by provider and session', async () => {
    const { readSessionTabs, recordSessionTab } = await import('@/lib/spend/session-tabs-store');
    await recordSessionTab({ providerId: 'codex', sessionId: 'c-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW);
    expect(await readSessionTabs()).toEqual({ 'codex:c-1': { workspaceId: 'ws-a', tabId: 'tab-1', firstSeenAt: NOW, lastSeenAt: NOW } });
    expect((await fs.stat(storeFile())).mode & 0o777).toBe(0o600);
    await expect(fs.access(`${storeFile()}.tmp`)).rejects.toThrow();
  });

  it('skips the write for a fresh known binding and touches it after an hour', async () => {
    const { recordSessionTab } = await import('@/lib/spend/session-tabs-store');
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW);
    const before = (await fs.stat(storeFile())).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW + 60_000);
    expect((await fs.stat(storeFile())).mtimeMs).toBe(before);
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW + 2 * 3_600_000);
    expect((await stored()).bindings['claude:s-1']).toMatchObject({ firstSeenAt: NOW, lastSeenAt: NOW + 2 * 3_600_000 });
  });

  it('keeps the tab name of the last sighting, and writes a rename inside the touch interval', async () => {
    const { readSessionTabs, recordSessionTab } = await import('@/lib/spend/session-tabs-store');
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1', tabName: 'hfl-04' }, NOW);
    expect((await readSessionTabs())['claude:s-1']).toMatchObject({ tabName: 'hfl-04' });
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1', tabName: 'hfl-04b' }, NOW + 60_000);
    expect((await readSessionTabs())['claude:s-1']).toMatchObject({ tabName: 'hfl-04b', lastSeenAt: NOW + 60_000 });
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW + 2 * 3_600_000);
    expect((await readSessionTabs())['claude:s-1']).toMatchObject({ tabName: 'hfl-04b' });
  });

  it('refuses a binding whose tab name is not a string', async () => {
    const { readSessionTabs } = await import('@/lib/spend/session-tabs-store');
    await fs.mkdir(path.dirname(storeFile()), { recursive: true });
    await fs.writeFile(storeFile(), JSON.stringify({ version: 1, bindings: { 'claude:s-1': { workspaceId: 'ws-a', tabId: 't', tabName: 7, firstSeenAt: 1, lastSeenAt: 1 } } }));
    await expect(readSessionTabs()).rejects.toThrow('binding claude:s-1 is malformed');
  });

  it('moves a session to another tab only on a newer sighting', async () => {
    const { readSessionTabs, recordSessionTab, seedSessionTabs } = await import('@/lib/spend/session-tabs-store');
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-1' }, NOW);
    expect(await seedSessionTabs([{ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-old', seenAt: NOW - DAY }], NOW)).toBe(0);
    await recordSessionTab({ providerId: 'claude', sessionId: 's-1', workspaceId: 'ws-a', tabId: 'tab-2' }, NOW + 1);
    expect((await readSessionTabs())['claude:s-1']).toMatchObject({ tabId: 'tab-2', firstSeenAt: NOW + 1 });
  });

  it('seeds what it does not hold, and prunes bindings last seen before the spend floor', async () => {
    const { readSessionTabs, seedSessionTabs } = await import('@/lib/spend/session-tabs-store');
    expect(await seedSessionTabs([
      { providerId: 'grok', sessionId: 'g-1', workspaceId: 'ws-a', tabId: 'tab-g', seenAt: NOW - DAY },
      { providerId: 'claude', sessionId: 'edge', workspaceId: 'ws-a', tabId: 'tab-e', seenAt: NOW - 91 * DAY },
      { providerId: 'claude', sessionId: 'old', workspaceId: 'ws-a', tabId: 'tab-o', seenAt: NOW - 92 * DAY },
    ], NOW)).toBe(2);
    expect(Object.keys(await readSessionTabs()).sort()).toEqual(['claude:edge', 'grok:g-1']);
    await seedSessionTabs([], NOW + DAY);
    expect(Object.keys(await readSessionTabs())).toEqual(['grok:g-1']);
    await seedSessionTabs([], NOW + 90 * DAY);
    expect(Object.keys(await readSessionTabs())).toEqual(['grok:g-1']);
    await seedSessionTabs([], NOW + 91 * DAY);
    expect(await readSessionTabs()).toEqual({});
  });

  it.each([
    ['not JSON', '{"version":1', 'the file is not JSON'],
    ['a wrong shape', '{"version":2,"bindings":{}}', 'expected {version: 1'],
    ['a malformed binding', '{"version":1,"bindings":{"claude:x":{"workspaceId":"ws"}}}', 'binding claude:x is malformed'],
    // A directory at the path refuses the read as root too, where a mode-000 file would not.
    ['an unreadable path (EISDIR)', null, 'session-tabs.json unreadable: EISDIR'],
  ])('refuses %s instead of reading it as empty, and never overwrites it', async (_name, content, message) => {
    const { readSessionTabs, recordSessionTab, SessionTabsStoreError } = await import('@/lib/spend/session-tabs-store');
    await fs.mkdir(path.dirname(storeFile()), { recursive: true });
    if (content === null) await fs.mkdir(storeFile());
    else await fs.writeFile(storeFile(), content);
    const reads = countStoreReads(fs);
    await expect(recordSessionTab({ providerId: 'claude', sessionId: 's', workspaceId: 'ws', tabId: 't' }, NOW)).resolves.toBeUndefined();
    expect(reads()).toBe(1);
    expect(storeWarnings()).toHaveLength(1);
    expect(storeWarnings()[0][0]).toContain(storeFile());
    expect(storeWarnings()[0][0]).toContain(message);
    await expect(readSessionTabs()).rejects.toBeInstanceOf(SessionTabsStoreError);
    await expect(readSessionTabs()).rejects.toThrow(message);
    if (content === null) expect((await fs.stat(storeFile())).isDirectory()).toBe(true);
    else expect(await fs.readFile(storeFile(), 'utf-8')).toBe(content);
  });

  describe('a refused file backs off for 60 s', () => {
    const sighting = (sessionId: string) => ({ providerId: 'claude' as const, sessionId, workspaceId: 'ws-a', tabId: 'tab-1' });
    const damage = async () => {
      await fs.mkdir(path.dirname(storeFile()), { recursive: true });
      await fs.writeFile(storeFile(), 'not json');
    };
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reads and warns once for many concurrent and later sightings inside the interval', async () => {
      await damage();
      const reads = countStoreReads(fs);
      const { recordSessionTab } = await import('@/lib/spend/session-tabs-store');
      await Promise.all(Array.from({ length: 20 }, (_, i) => recordSessionTab(sighting(`s-${i}`), NOW)));
      await recordSessionTab(sighting('s-late'), NOW + 59_999);
      expect(reads()).toBe(1);
      expect(storeWarnings()).toHaveLength(1);
      expect(storeWarnings()[0][0]).toContain(`${storeFile()}: session-tabs.json unreadable: the file is not JSON`);
      expect(storeWarnings()[0][0]).toContain('60 s');
      expect(await fs.readFile(storeFile(), 'utf-8')).toBe('not json');
    });

    it('never backs off the spend view: a read still names the damaged file', async () => {
      await damage();
      const { readSessionTabs, recordSessionTab } = await import('@/lib/spend/session-tabs-store');
      await recordSessionTab(sighting('s-1'), NOW);
      await expect(readSessionTabs()).rejects.toThrow('session-tabs.json unreadable: the file is not JSON');
    });

    it('reads again once the interval ends and warns again while the file stays damaged', async () => {
      await damage();
      const reads = countStoreReads(fs);
      const { recordSessionTab } = await import('@/lib/spend/session-tabs-store');
      await recordSessionTab(sighting('s-1'), NOW);
      await recordSessionTab(sighting('s-2'), NOW + 60_000);
      await recordSessionTab(sighting('s-3'), NOW + 60_001);
      expect(reads()).toBe(2);
      expect(storeWarnings()).toHaveLength(2);
    });

    it('records bindings again after the interval once the file is repaired, with no restart', async () => {
      await damage();
      const { readSessionTabs, recordSessionTab } = await import('@/lib/spend/session-tabs-store');
      await recordSessionTab(sighting('s-1'), NOW);
      await fs.writeFile(storeFile(), JSON.stringify({ version: 1, bindings: {} }));
      await recordSessionTab(sighting('s-early'), NOW + 30_000);
      expect(await readSessionTabs()).toEqual({});
      await recordSessionTab(sighting('s-2'), NOW + 60_000);
      await recordSessionTab(sighting('s-3'), NOW + 60_001);
      expect(Object.keys(await readSessionTabs()).sort()).toEqual(['claude:s-2', 'claude:s-3']);
      expect(storeWarnings()).toHaveLength(1);
    });

    it('records bindings again after the interval once the file is moved aside', async () => {
      await damage();
      const { readSessionTabs, recordSessionTab } = await import('@/lib/spend/session-tabs-store');
      await recordSessionTab(sighting('s-1'), NOW);
      await fs.rename(storeFile(), `${storeFile()}.damaged`);
      await recordSessionTab(sighting('s-2'), NOW + 60_000);
      expect(Object.keys(await readSessionTabs())).toEqual(['claude:s-2']);
      expect((await fs.stat(storeFile())).mode & 0o777).toBe(0o600);
    });

    it('reads again when the clock moves back before the refusal, and a good read ends the back-off', async () => {
      await damage();
      const reads = countStoreReads(fs);
      const { readSessionTabs, recordSessionTab } = await import('@/lib/spend/session-tabs-store');
      await recordSessionTab(sighting('s-1'), NOW);
      await fs.writeFile(storeFile(), JSON.stringify({ version: 1, bindings: {} }));
      await recordSessionTab(sighting('s-2'), NOW - 1);
      await recordSessionTab(sighting('s-3'), NOW + 1);
      expect(reads()).toBe(3);
      expect(Object.keys(await readSessionTabs()).sort()).toEqual(['claude:s-2', 'claude:s-3']);
    });

    it('never backs off a healthy store: each new session is read and written at once', async () => {
      const reads = countStoreReads(fs);
      const { readSessionTabs, recordSessionTab } = await import('@/lib/spend/session-tabs-store');
      await recordSessionTab(sighting('s-1'), NOW);
      await recordSessionTab(sighting('s-2'), NOW + 1);
      expect(reads()).toBe(2);
      expect(Object.keys(await readSessionTabs()).sort()).toEqual(['claude:s-1', 'claude:s-2']);
      expect(storeWarnings()).toHaveLength(0);
    });

    it('still fails a write to the caller, without a back-off', async () => {
      const { recordSessionTab } = await import('@/lib/spend/session-tabs-store');
      const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }));
      await expect(recordSessionTab(sighting('s-1'), NOW)).rejects.toThrow('EIO');
      rename.mockRestore();
      await recordSessionTab(sighting('s-2'), NOW + 1);
      expect((await stored()).bindings['claude:s-2']).toMatchObject({ tabId: 'tab-1' });
      await expect(fs.access(`${storeFile()}.tmp`)).rejects.toThrow();
    });
  });
});

describe('updateTabAgentSessionId records the binding', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as { __ptSessionTabsSeen?: unknown }).__ptSessionTabsSeen;
    delete (globalThis as { __ptSessionTabsRefusedAt?: unknown }).__ptSessionTabsRefusedAt;
    warn.mockClear();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-session-tabs-hook-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const seedLayout = async () => {
    const store = await import('@/lib/layout-store');
    const layout: ILayoutData = {
      root: { type: 'pane', id: 'pane-one', activeTabId: 'tab-adopted',
        tabs: [{ id: 'tab-adopted', sessionName: 'pt-ws-a-pane-one-tab-orig', name: 'worker', order: 0, panelType: 'codex-cli' }] },
      activePaneId: 'pane-one',
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    await store.writeLayoutFile(layout, store.resolveLayoutFile('ws-a'));
    return store;
  };

  it('binds the session to the layout tab id, not the id in the session name', async () => {
    const store = await seedLayout();
    await store.updateTabAgentSessionId('pt-ws-a-pane-one-tab-orig', fakeProvider('codex'), 'c-9');
    expect((await stored()).bindings['codex:c-9']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted', tabName: 'worker' });
  });

  it('records nothing for a cleared session or a tab no layout names', async () => {
    const store = await seedLayout();
    await store.updateTabAgentSessionId('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), null);
    await store.updateTabAgentSessionId('pt-ws-a-pane-one-tab-gone', fakeProvider('claude'), 's-1');
    await expect(fs.access(storeFile())).rejects.toThrow();
  });

  it('never fails the hook path when the binding store is damaged', async () => {
    const store = await seedLayout();
    await fs.writeFile(storeFile(), 'not json');
    await expect(store.updateTabAgentSessionId('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), 's-1')).resolves.toBeUndefined();
    const layout = await store.readLayoutFile(store.resolveLayoutFile('ws-a'));
    expect(layout?.root.type === 'pane' && (layout.root.tabs[0] as ITab & { fakeSession?: string }).fakeSession).toBe('s-1');
    expect(await fs.readFile(storeFile(), 'utf-8')).toBe('not json');
  });
});

describe('updateTabAgentState records the binding (the status manager hook, launch and poll writer)', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as { __ptSessionTabsSeen?: unknown }).__ptSessionTabsSeen;
    delete (globalThis as { __ptSessionTabsRefusedAt?: unknown }).__ptSessionTabsRefusedAt;
    warn.mockClear();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-session-tabs-state-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const seedLayout = async () => {
    const store = await import('@/lib/layout-store');
    const layout: ILayoutData = {
      root: { type: 'pane', id: 'pane-one', activeTabId: 'tab-adopted',
        tabs: [{ id: 'tab-adopted', sessionName: 'pt-ws-a-pane-one-tab-orig', name: 'worker', order: 0, panelType: 'codex-cli' }] },
      activePaneId: 'pane-one',
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    await store.writeLayoutFile(layout, store.resolveLayoutFile('ws-a'));
    return store;
  };

  it('binds a saved session id to the layout tab id', async () => {
    const store = await seedLayout();
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('codex'), { sessionId: 'c-hook', jsonlPath: null });
    expect((await stored()).bindings['codex:c-hook']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted', tabName: 'worker' });
  });

  it('records nothing for a reset session, a save without a session id, or a tab no layout names', async () => {
    const store = await seedLayout();
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: null, jsonlPath: null });
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { summary: 'a summary' });
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-gone', fakeProvider('claude'), { sessionId: 's-1' });
    await expect(fs.access(storeFile())).rejects.toThrow();
  });

  it('binds each new session of a cleared tab to the same tab id', async () => {
    const store = await seedLayout();
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: 's-old' });
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: null });
    await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: 's-new' });
    const { bindings } = await stored();
    expect(bindings['claude:s-old']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted' });
    expect(bindings['claude:s-new']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted' });
  });

  it('never fails the hook save when the binding store is damaged', async () => {
    const store = await seedLayout();
    await fs.mkdir(path.dirname(storeFile()), { recursive: true });
    await fs.writeFile(storeFile(), 'not json');
    await expect(store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: 's-1' })).resolves.toBeUndefined();
    const layout = await store.readLayoutFile(store.resolveLayoutFile('ws-a'));
    expect(layout?.root.type === 'pane' && (layout.root.tabs[0] as ITab & { fakeSession?: string }).fakeSession).toBe('s-1');
    expect(await fs.readFile(storeFile(), 'utf-8')).toBe('not json');
  });

  it('re-reads a damaged store and warns at most once a minute across many hook saves', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(NOW);
      const store = await seedLayout();
      await fs.mkdir(path.dirname(storeFile()), { recursive: true });
      await fs.writeFile(storeFile(), 'not json');
      const reads = countStoreReads(fs);
      for (let i = 0; i < 30; i += 1) {
        vi.setSystemTime(NOW + i * 1_000);
        await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: `s-${i}` });
      }
      expect(reads()).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(storeWarnings()[0][0]).toContain(storeFile());
      await fs.writeFile(storeFile(), JSON.stringify({ version: 1, bindings: {} }));
      vi.setSystemTime(NOW + 60_000);
      await store.updateTabAgentState('pt-ws-a-pane-one-tab-orig', fakeProvider('claude'), { sessionId: 's-repaired' });
      expect(reads()).toBe(2);
      expect((await stored()).bindings['claude:s-repaired']).toMatchObject({ workspaceId: 'ws-a', tabId: 'tab-adopted', firstSeenAt: NOW + 60_000 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
