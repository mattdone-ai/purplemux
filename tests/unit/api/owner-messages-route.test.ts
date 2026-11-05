import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';

// Story 36 (D8): `purplemux owner messages` reads a workspace's owner prompts: id, time, tab and text.

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({ hasSession: vi.fn(async () => true), killSession: vi.fn(async () => {}) }));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

type THandler = Parameters<typeof callRoute>[0];

describe('GET /api/cli/owner/messages (story 36, D8)', () => {
  let tabA = '';
  let admin = '';
  let ws = '';
  let n = 0;
  const route = async () => (await import('@/pages/api/cli/owner/messages')).default as THandler;
  const get = async (token: string, query: Record<string, string>) => callRoute(await route(), { method: 'GET', headers: { 'x-pmux-token': token }, query });

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-owner-messages-'));
    ws = `ws-om${++n}`;
    await writeFixture(mockHome.value, [{ id: ws, name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' }]);
    tabA = await (await import('@/lib/tab-token')).ensureTabToken({ workspaceId: ws, tabId: 'tab-a1' }, `pt-${ws}-pane-1-tab-a1`);
    admin = (await import('@/lib/cli-token')).getCliToken();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const seed = async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { addMessageHistory } = await import('@/lib/message-history-store');
    vi.setSystemTime(new Date('2026-11-04T01:00:00.000Z'));
    const a = await addMessageHistory(ws, 'from now on use AEDT', 'tab-a1');
    vi.setSystemTime(new Date('2026-11-04T02:00:00.000Z'));
    const b = await addMessageHistory(ws, 'ok done');
    vi.setSystemTime(new Date('2026-11-04T03:00:00.000Z'));
    const c = await addMessageHistory(ws, 'use token=ghp_abcdefghijklmnopqrstuvwxyz0123 for the push', 'tab-a1');
    vi.useRealTimers();
    return { a, b, c };
  };

  it('lists the workspace\'s prompts oldest first, with id, time, tab and text; a credential-shaped one is withheld', async () => {
    const { a, b, c } = await seed();
    const res = await get(tabA, { workspaceId: ws });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ workspaceId: ws, since: null, messages: [
      { id: a.id, sentAt: '2026-11-04T01:00:00.000Z', tabId: 'tab-a1', message: 'from now on use AEDT', withheld: false },
      { id: b.id, sentAt: '2026-11-04T02:00:00.000Z', tabId: null, message: 'ok done', withheld: false },
      { id: c.id, sentAt: '2026-11-04T03:00:00.000Z', tabId: 'tab-a1', message: null, withheld: true },
    ] });
    expect(JSON.stringify(res.body)).not.toContain('ghp_');
  });

  it('--since keeps the prompts sent at or after the time; a bad time is refused', async () => {
    const { b } = await seed();
    const res = await get(tabA, { workspaceId: ws, since: '2026-11-04T02:00:00Z' });
    expect((res.body as { since: string }).since).toBe('2026-11-04T02:00:00.000Z');
    expect((res.body as { messages: Array<{ id: string }> }).messages.map((m) => m.id)).toEqual([b.id, expect.any(String)]);
    expect(await get(tabA, { workspaceId: ws, since: 'yesterday' })).toMatchObject({ status: 400, body: { code: 'invalid-request' } });
  });

  it('a tab reads its own workspace only; admin reads any; a workspace is required', async () => {
    await seed();
    expect(await get(tabA, { workspaceId: 'ws-other' })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect((await get(admin, { workspaceId: ws })).status).toBe(200);
    expect(await get(tabA, {})).toMatchObject({ status: 400 });
  });
});
