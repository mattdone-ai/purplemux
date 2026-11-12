import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
const auth = vi.hoisted(() => ({
  scope: { type: 'workspace', workspaceId: 'ws-1' } as { type: 'admin' } | { type: 'workspace'; workspaceId: string } | null,
  allowRead: true,
}));

// The file logger writes under the temp HOME, which each test removes; a write
// still pending at removal surfaced as an unhandled ENOENT (gate 26-r1).
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => auth.scope }));
vi.mock('@/lib/cli-utils', () => ({
  authorizeWorkspace: async (_req: unknown, res: NextApiResponse) => {
    if (auth.allowRead) return auth.scope;
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  },
}));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

const seed = async () => {
  const store = await import('@/lib/inbox-store');
  const q = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-a', dedupeKey: 'q', fields: { resumeId: 'r-queued' } });
  const h = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-b', dedupeKey: 'h', fields: { resumeId: 'r-heldd1' } });
  const d = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-c', dedupeKey: 'd', fields: { resumeId: 'r-deliv1' } });
  const other = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-2', targetTabId: 'tab-x', dedupeKey: 'o', fields: { resumeId: 'r-other1' } });
  await store.mutateInbox((state) => ({ state: store.holdInState(state, h.item.id, 'composer-not-empty (30 refusals)', Date.now()), value: null }));
  await store.mutateInbox((state) => ({ state: store.deliverInState(state, d.item.id, Date.now()), value: null }));
  return { q: q.item.id, h: h.item.id, d: d.item.id, other: other.item.id };
};

describe('inbox routes (ADR-0012)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-inbox-api-'));
    auth.scope = { type: 'workspace', workspaceId: 'ws-1' };
    auth.allowRead = true;
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  const list = async (query: Record<string, string>) => {
    const { state, res } = fakeResponse();
    const { default: handler } = await import('@/pages/api/cli/inbox');
    await handler({ method: 'GET', query } as unknown as NextApiRequest, res);
    return state;
  };

  const retry = async (id: string) => {
    const { state, res } = fakeResponse();
    const { default: handler } = await import('@/pages/api/cli/inbox/[id]/retry');
    await handler({ method: 'POST', query: { id } } as unknown as NextApiRequest, res);
    return state;
  };

  it('carries counts of every retained item of the workspace, with or without --all (PMUX-NOTE-DELIVERY)', async () => {
    await seed();
    const expected = {
      total: { queued: 1, held: 1, delivered: 1, dropped: 0 },
      heldBy: { 'composer-not-empty': 1 },
      tabs: {
        'tab-a': { queued: 1, held: 0, delivered: 0, dropped: 0 },
        'tab-b': { queued: 0, held: 1, delivered: 0, dropped: 0 },
        'tab-c': { queued: 0, held: 0, delivered: 1, dropped: 0 },
      },
    };
    expect((await list({ workspaceId: 'ws-1' })).body).toMatchObject({ counts: expected });
    expect((await list({ workspaceId: 'ws-1', all: '1' })).body).toMatchObject({ counts: expected });
  });

  it('lists queued and held items of the workspace; --all adds delivered; never another workspace', async () => {
    const ids = await seed();
    const open = await list({ workspaceId: 'ws-1' });
    expect(open.statusCode).toBe(200);
    expect((open.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([ids.q, ids.h]);
    const all = await list({ workspaceId: 'ws-1', all: '1' });
    expect((all.body as { items: Array<{ id: string }> }).items.map((i) => i.id)).toEqual([ids.q, ids.h, ids.d]);
  });

  it('refuses a list outside the caller\'s read scope and a missing workspaceId', async () => {
    auth.allowRead = false;
    expect((await list({ workspaceId: 'ws-2' })).statusCode).toBe(403);
    auth.allowRead = true;
    expect((await list({})).statusCode).toBe(400);
  });

  it('re-queues a held item for the target workspace\'s token and for admin', async () => {
    const ids = await seed();
    const done = await retry(ids.h);
    expect(done.statusCode).toBe(200);
    expect(done.body).toMatchObject({ item: { id: ids.h, state: 'queued', attempts: 0 } });
    const store = await import('@/lib/inbox-store');
    await store.mutateInbox((s) => ({ state: store.holdInState(s, ids.h, 'x', Date.now()), value: null }));
    auth.scope = { type: 'admin' };
    expect((await retry(ids.h)).statusCode).toBe(200);
  });

  it('lets the workspace that sent a note retry its held notice in another workspace, and no third workspace', async () => {
    const store = await import('@/lib/inbox-store');
    const fields = { noteId: 'n-sent0001', fromWorkspaceId: 'ws-2', fromTabId: 'tab-sm', sentAt: Date.now(), event: 'delivered' as const };
    const { item } = await store.enqueueNotice({ kind: 'note', targetWorkspaceId: 'ws-1', targetTabId: 'tab-o', dedupeKey: 'note:n-sent0001:delivered:tab-o', fields });
    await store.mutateInbox((state) => ({ state: store.holdInState(state, item.id, 'composer-not-empty (30 refusals)', Date.now()), value: null }));
    const note = {
      id: 'n-sent0001', from: { workspaceId: 'ws-2', tabId: 'tab-sm', verified: true, epic: null }, to: { epic: null, workspaceId: 'ws-1' },
      subject: 's', body: 'b', createdAt: Date.now(), state: 'delivered', deliveredTo: { workspaceId: 'ws-1', tabId: 'tab-o' },
      routedAt: Date.now(), deliveredAt: null, inboxItemId: item.id, ackedAt: null, ackedBy: null, ackComment: null,
      remindedAt: null, senderNotifiedAt: null, expiredAt: null, transitionAt: Date.now(),
    };
    await fs.mkdir(path.join(mockHome.value, '.purplemux'), { recursive: true });
    await fs.writeFile(path.join(mockHome.value, '.purplemux', 'notes.json'), JSON.stringify({ notes: [note] }));

    auth.scope = { type: 'workspace', workspaceId: 'ws-3' };
    expect(await retry(item.id)).toMatchObject({ statusCode: 404, body: { code: 'inbox-not-found' } });
    auth.scope = { type: 'workspace', workspaceId: 'ws-2' };
    expect(await retry(item.id)).toMatchObject({ statusCode: 200, body: { item: { id: item.id, state: 'queued', attempts: 0 } } });
  });

  it('answers inbox-not-held and inbox-not-found with their codes, and 404s another workspace\'s item', async () => {
    const ids = await seed();
    expect(await retry(ids.q)).toMatchObject({ statusCode: 409, body: { code: 'inbox-not-held' } });
    expect(await retry('i-nothing12')).toMatchObject({ statusCode: 404, body: { code: 'inbox-not-found' } });
    auth.scope = { type: 'workspace', workspaceId: 'ws-2' };
    // Another workspace's item answers like a missing one.
    expect(await retry(ids.h)).toMatchObject({ statusCode: 404, body: { code: 'inbox-not-found' } });
    auth.scope = null;
    expect(await retry(ids.h)).toMatchObject({ statusCode: 403 });
  });
});
