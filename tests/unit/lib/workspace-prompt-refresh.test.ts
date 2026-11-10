import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// D32: the server's refreshPrompt (the standing-order fan-out) writes the local prompt file and the kit copy on each
// remote host that the workspace's layout names, so a launch there after a strike never loads the struck order.

const state = vi.hoisted(() => ({
  dir: '',
  tabs: [] as Array<{ id: string; host?: string }>,
  pushed: [] as Array<{ host: string; ws: string; prompt: string }>,
  version: 'SO-9 active',
}));

vi.mock('@/lib/claude-prompt', () => ({
  getClaudePromptPath: (ws: string) => path.join(state.dir, ws, 'claude-prompt.md'),
  writeClaudePromptFile: async ({ id }: { id: string }) => {
    await fs.mkdir(path.join(state.dir, id), { recursive: true });
    await fs.writeFile(path.join(state.dir, id, 'claude-prompt.md'), `prompt of ${id}: ${state.version}\n`);
  },
}));
vi.mock('@/lib/layout-store', () => ({
  resolveLayoutFile: (ws: string) => `/layouts/${ws}.json`,
  readLayoutFile: async (file: string) => (file === '/layouts/ws-r.json' ? { root: { type: 'pane' } } : null),
  collectAllTabs: () => state.tabs,
}));
vi.mock('@/lib/tmux', () => ({
  pushRemotePrompt: async (host: string, ws: string, prompt: string) => { state.pushed.push({ host, ws, prompt }); },
}));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({}) }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaces: async () => ({ workspaces: [] }) }));

beforeEach(async () => {
  state.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-prompt-refresh-'));
  state.tabs = [];
  state.pushed = [];
  state.version = 'SO-9 active';
});
afterEach(async () => {
  await fs.rm(state.dir, { recursive: true, force: true });
});

describe('the standing-order fan-out refreshes the local prompt and each remote kit copy (D32)', () => {
  it('pushes the new local text once to each remote host of the workspace, and to no local tab', async () => {
    state.tabs = [{ id: 'tab-1' }, { id: 'tab-2', host: 'host-b' }, { id: 'tab-3', host: 'host-b' }, { id: 'tab-4', host: 'gpu-1' }];
    const { standingOrderDeps } = await import('@/lib/standing-orders-http');
    state.version = 'SO-9 struck';
    await standingOrderDeps().refreshPrompt('ws-r');
    expect(await fs.readFile(path.join(state.dir, 'ws-r', 'claude-prompt.md'), 'utf-8')).toBe('prompt of ws-r: SO-9 struck\n');
    expect(state.pushed).toEqual([
      { host: 'gpu-1', ws: 'ws-r', prompt: 'prompt of ws-r: SO-9 struck\n' },
      { host: 'host-b', ws: 'ws-r', prompt: 'prompt of ws-r: SO-9 struck\n' },
    ]);
  });

  it('a workspace with no layout or no remote tab writes the local file and makes no ssh call', async () => {
    const { standingOrderDeps } = await import('@/lib/standing-orders-http');
    await standingOrderDeps().refreshPrompt('ws-none');
    state.tabs = [{ id: 'tab-1' }];
    await standingOrderDeps().refreshPrompt('ws-r');
    expect(await fs.readFile(path.join(state.dir, 'ws-none', 'claude-prompt.md'), 'utf-8')).toBe('prompt of ws-none: SO-9 active\n');
    expect(state.pushed).toEqual([]);
  });
});
