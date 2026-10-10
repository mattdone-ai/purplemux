import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData } from '@/types/terminal';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const writeLayout = async (wsId: string, tabs: Array<{ id: string; host?: string }>) => {
  const layout: ILayoutData = {
    root: {
      type: 'pane', id: 'pane-1', activeTabId: tabs[0]?.id ?? null,
      tabs: tabs.map((t, order) => ({ id: t.id, sessionName: `pt-${wsId}-pane-1-${t.id}`, name: '', order, ...(t.host ? { host: t.host } : {}) })),
    },
    activePaneId: 'pane-1',
    updatedAt: '2026-10-10T00:00:00.000Z',
  };
  const dir = path.join(mockHome.value, '.purplemux', 'workspaces', wsId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'layout.json'), JSON.stringify(layout));
};

describe('session → host map (ADR-0022 §3)', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__ptSessionHosts;
    delete (globalThis as Record<string, unknown>).__ptLayoutContentCache;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-session-host-'));
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__ptSessionHosts;
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads the host from the layout and keeps the answer', async () => {
    await writeLayout('ws-a', [{ id: 'tab-r', host: 'ai-server' }, { id: 'tab-l' }]);
    const { sessionHostOf, knownRemoteHosts } = await import('@/lib/session-host');
    expect(await sessionHostOf('pt-ws-a-pane-1-tab-r')).toBe('ai-server');
    expect(await sessionHostOf('pt-ws-a-pane-1-tab-l')).toBeNull();
    expect(knownRemoteHosts()).toEqual(['ai-server']);
    await fs.rm(path.join(mockHome.value, '.purplemux'), { recursive: true });
    expect(await sessionHostOf('pt-ws-a-pane-1-tab-r')).toBe('ai-server');
  });

  it('answers local for a session no layout names yet, without keeping it', async () => {
    const { sessionHostOf } = await import('@/lib/session-host');
    expect(await sessionHostOf('pt-ws-b-pane-1-tab-new')).toBeNull();
    await writeLayout('ws-b', [{ id: 'tab-new', host: 'ai-server' }]);
    expect(await sessionHostOf('pt-ws-b-pane-1-tab-new')).toBe('ai-server');
  });

  it('a registered session answers before its layout exists; a forgotten one is read again', async () => {
    const { forgetSessionHost, registerSessionHost, sessionHostOf } = await import('@/lib/session-host');
    registerSessionHost('pt-ws-c-pane-1-tab-x', 'ai-server');
    expect(await sessionHostOf('pt-ws-c-pane-1-tab-x')).toBe('ai-server');
    forgetSessionHost('pt-ws-c-pane-1-tab-x');
    expect(await sessionHostOf('pt-ws-c-pane-1-tab-x')).toBeNull();
  });

  it('a name outside the workspace pattern is local', async () => {
    const { sessionHostOf } = await import('@/lib/session-host');
    expect(await sessionHostOf('pt-abc-def-ghi')).toBeNull();
  });
});
