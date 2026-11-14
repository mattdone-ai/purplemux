import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioStore } from '@/lib/portfolio-store';
import type { TCliScope } from '@/lib/workspace-token';

// ADR-0047 at route level (owner order, PMUX-PSM-RIGHTS): lease break, inbox retry and note show, with the real
// Portfolio Scrum Master predicate (scrum-master-access and a real PortfolioStore selection) in front of each route.
// The selected Scrum Master is tab-sm in ws-pm; its selection is ws-a. tab-orch-a is ws-a's orchestrator and tab-w a
// worker there: neither is the Scrum Master.

const state = vi.hoisted(() => ({ scope: null as TCliScope | null, home: '' }));
const audit = vi.hoisted(() => ({ entries: [] as Record<string, unknown>[] }));
const notes = vi.hoisted(() => ({ show: vi.fn(async (_caller: unknown, _id: unknown, selection: readonly string[] = []) => ({ note: {}, body: 'b', selection })) }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => state.home }, homedir: () => state.home };
});
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => state.scope }));
vi.mock('@/lib/caller', () => ({ resolveCaller: async () => {
  const scope = state.scope;
  if (!scope) return null;
  if (scope.type === 'admin') return { scope, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
  return { scope, workspaceId: scope.workspaceId, tabId: scope.tabId ?? null, tabName: scope.tabId ?? null,
    verified: scope.tabVerified === true, identity: scope.tabVerified ? 'launch' : 'session', admin: false };
} }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: async (id: string) => ({ id, name: id, directories: ['/repo'], allowedPeers: [],
    orchestration: { enabled: true, orchestratorTabId: id === 'ws-pm' ? 'tab-sm' : `tab-orch-${id.slice(3)}` } }),
  getWorkspaces: async () => ({ workspaces: [] }),
}));
vi.mock('@/lib/layout-store', () => ({
  resolveLayoutFile: (id: string) => id,
  readLayoutFile: async (id: string) => ({ root: { id } }),
  collectAllTabs: (root: { id: string }) => (root.id === 'ws-pm' ? [{ id: 'tab-sm', sessionName: 'session-pm' }] : []),
}));
vi.mock('@/lib/tab-token', async (original) => ({ ...await original<typeof import('@/lib/tab-token')>(),
  tabIdentityOf: () => 'launch', getTabTokenRecord: () => ({ workspaceId: 'ws-pm', sessionName: 'session-pm' }) }));
vi.mock('@/lib/tmux', async (original) => ({ ...await original<typeof import('@/lib/tmux')>(), hasSession: async () => true }));
vi.mock('@/lib/tab-lifecycle', async (original) => ({ ...await original<typeof import('@/lib/tab-lifecycle')>(),
  readLiveTabs: async () => ({ tabs: [], uncertainWorkspaceIds: new Set<string>() }) }));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: async (entry: Record<string, unknown>) => {
  audit.entries.push(entry);
  return true;
} }));
vi.mock('@/lib/notes-service', () => ({ getNotesService: async () => ({ show: notes.show }) }));

const SM: TCliScope = { type: 'workspace', workspaceId: 'ws-pm', tabId: 'tab-sm', tabVerified: true };
const ORCH: TCliScope = { type: 'workspace', workspaceId: 'ws-b', tabId: 'tab-orch-b', tabVerified: true };
const WORKER: TCliScope = { type: 'workspace', workspaceId: 'ws-b', tabId: 'tab-w', tabVerified: true };
const UNVERIFIED: TCliScope = { type: 'workspace', workspaceId: 'ws-pm', tabId: 'tab-sm' };
const ADMIN: TCliScope = { type: 'admin' } as TCliScope;
const REFUSED = [['an orchestrator tab', ORCH], ['a worker tab', WORKER], ['the Scrum Master\'s tab unverified', UNVERIFIED]] as const;

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const call = async (load: () => Promise<{ default: THandler }>, method: string, query: Record<string, string>, body: unknown = {}) => {
  const out = { status: 0, body: undefined as unknown };
  const res = { headersSent: false, setHeader() { return this; }, status(code: number) { out.status = code; return this; },
    json(value: unknown) { out.body = value; return this; }, end() { return this; } } as unknown as NextApiResponse;
  await (await load()).default({ method, headers: {}, query, body } as unknown as NextApiRequest, res);
  return out;
};
const breakRoute = () => import('@/pages/api/cli/leases/break');
const retryRoute = () => import('@/pages/api/cli/inbox/[id]/retry');
const showRoute = () => import('@/pages/api/cli/notes/[id]/index');

let store: PortfolioStore;
/**
 * The selection changes after the Scrum Master proof (two reads in scrumMasterSnapshot) and before the store lock's
 * re-check, the window ADR-0047 r2 #5 closes.
 */
const changeAfterProof = () => {
  const original = store.currentSelection;
  let reads = 0;
  vi.spyOn(store, 'currentSelection').mockImplementation(() => {
    reads += 1;
    const now = original();
    return reads <= 2 || !now ? now : { ...now, updatedAt: now.updatedAt + 1 };
  });
};

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-psm-routes-'));
  store = new PortfolioStore(':memory:');
  (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore = store;
  store.select('human-a', { managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm', workspaceIds: ['ws-a'] });
  audit.entries.length = 0;
  notes.show.mockClear();
});
afterEach(() => {
  fs.rmSync(state.home, { recursive: true, force: true });
});

describe('lease break (ADR-0047)', () => {
  const hold = async () => {
    const { acquireLease } = await import('@/lib/lease-store');
    const { leaseAuthority } = await import('@/lib/lease-http');
    await acquireLease({ name: 'merge:acme/x' }, { workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'worker', verified: true, admin: false }, leaseAuthority);
  };
  const held = async () => (await (await import('@/lib/lease-store')).readLeaseState()).leases.some((l) => l.name === 'merge:acme/x');

  it('the Scrum Master breaks a lease with a reason: audited with its role and selection', async () => {
    await hold();
    state.scope = SM;
    expect(await call(breakRoute, 'POST', {}, { name: 'merge:acme/x', reason: 'the holder tab is gone' })).toMatchObject({ status: 200, body: { broken: { name: 'merge:acme/x' } } });
    expect(await held()).toBe(false);
    expect(audit.entries.find((e) => e.event === 'lease-release')).toMatchObject({
      reason: 'broken', breakReason: 'the holder tab is gone',
      by: { workspaceId: 'ws-pm', tabId: 'tab-sm', verified: true, admin: false, role: 'portfolio-scrum-master',
        selection: { actor: 'human-a', managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm' } },
    });
  });

  it('the Scrum Master is refused without a reason, or with one over 500 characters', async () => {
    await hold();
    state.scope = SM;
    expect(await call(breakRoute, 'POST', {}, { name: 'merge:acme/x' })).toMatchObject({ status: 400 });
    expect(await call(breakRoute, 'POST', {}, { name: 'merge:acme/x', reason: 'x'.repeat(501) })).toMatchObject({ status: 400 });
    expect(await held()).toBe(true);
  });

  it('counts the reason in code points after a trim: 500 emoji pass, 501 do not (r2 #3)', async () => {
    await hold();
    state.scope = SM;
    expect(await call(breakRoute, 'POST', {}, { name: 'merge:acme/x', reason: '😀'.repeat(501) })).toMatchObject({ status: 400 });
    expect(await call(breakRoute, 'POST', {}, { name: 'merge:acme/x', reason: ` ${'😀'.repeat(500)} ` })).toMatchObject({ status: 200 });
  });

  it('refuses when the selection changes between the proof and the lock: nothing is broken (r2 #5)', async () => {
    await hold();
    state.scope = SM;
    changeAfterProof();
    expect(await call(breakRoute, 'POST', {}, { name: 'merge:acme/x', reason: 'stuck' })).toMatchObject({
      status: 403, body: { code: 'forbidden', error: expect.stringContaining('selection changed') } });
    expect(await held()).toBe(true);
  });

  it.each(REFUSED)('%s is refused', async (_label, scope) => {
    await hold();
    state.scope = scope;
    expect(await call(breakRoute, 'POST', {}, { name: 'merge:acme/x', reason: 'stuck' })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(await held()).toBe(true);
  });

  it('the admin token still breaks a lease', async () => {
    await hold();
    state.scope = ADMIN;
    expect(await call(breakRoute, 'POST', {}, { name: 'merge:acme/x', reason: 'stuck' })).toMatchObject({ status: 200 });
  });
});

describe('inbox retry (ADR-0047)', () => {
  const seed = async () => {
    const store = await import('@/lib/inbox-store');
    const inside = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-a', targetTabId: 'tab-w', dedupeKey: 'a', fields: { resumeId: 'r-inside1' } });
    const outside = await store.enqueueNotice({ kind: 'resume', targetWorkspaceId: 'ws-z', targetTabId: 'tab-z', dedupeKey: 'z', fields: { resumeId: 'r-outsid1' } });
    for (const id of [inside.item.id, outside.item.id]) {
      await store.mutateInbox((s) => ({ state: store.holdInState(s, id, 'composer-not-empty (30 refusals)', Date.now()), value: null }));
    }
    return { inside: inside.item.id, outside: outside.item.id };
  };
  const stateOf = async (id: string) => (await (await import('@/lib/inbox-store')).readInboxState()).items.find((i) => i.id === id)?.state;

  it('the Scrum Master retries a held notice of a workspace in its selection, with a reason: audited', async () => {
    const { inside } = await seed();
    state.scope = SM;
    expect(await call(retryRoute, 'POST', { id: inside }, { reason: 'the tab is idle again' })).toMatchObject({ status: 200 });
    expect(await stateOf(inside)).toBe('queued');
    expect(audit.entries).toEqual([expect.objectContaining({
      event: 'inbox-retry', itemId: inside, targetWorkspaceId: 'ws-a', reason: 'the tab is idle again',
      by: { workspaceId: 'ws-pm', tabId: 'tab-sm', verified: true, role: 'portfolio-scrum-master' },
      selection: expect.objectContaining({ actor: 'human-a', managerTabId: 'tab-sm' }),
    })]);
  });

  it('the Scrum Master is refused without a reason (400), and outside its selection (404, as a missing item)', async () => {
    const { inside, outside } = await seed();
    state.scope = SM;
    expect(await call(retryRoute, 'POST', { id: inside }, {})).toMatchObject({ status: 400, body: { code: 'reason-missing' } });
    expect(await call(retryRoute, 'POST', { id: inside }, { reason: 'x'.repeat(501) })).toMatchObject({ status: 400 });
    expect(await call(retryRoute, 'POST', { id: outside }, { reason: 'r' })).toMatchObject({ status: 404, body: { code: 'inbox-not-found' } });
    expect(await stateOf(inside)).toBe('held');
    expect(await stateOf(outside)).toBe('held');
  });

  it('counts the reason in code points after a trim: whitespace is no reason, 500 emoji are one (r2 #3)', async () => {
    const { inside } = await seed();
    state.scope = SM;
    expect(await call(retryRoute, 'POST', { id: inside }, { reason: '   ' })).toMatchObject({ status: 400, body: { code: 'reason-missing' } });
    expect(await call(retryRoute, 'POST', { id: inside }, { reason: '😀'.repeat(500) })).toMatchObject({ status: 200 });
    expect(audit.entries[0]).toMatchObject({ reason: '😀'.repeat(500) });
  });

  it('refuses when the selection changes between the proof and the lock: nothing is retried (r2 #5)', async () => {
    const { inside } = await seed();
    state.scope = SM;
    changeAfterProof();
    expect(await call(retryRoute, 'POST', { id: inside }, { reason: 'r' })).toMatchObject({ status: 403, body: { code: 'selection-changed' } });
    expect(await stateOf(inside)).toBe('held');
    expect(audit.entries).toEqual([]);
  });

  it.each(REFUSED)('%s is refused (404, as a missing item)', async (_label, scope) => {
    const { inside } = await seed();
    state.scope = scope;
    expect(await call(retryRoute, 'POST', { id: inside }, { reason: 'r' })).toMatchObject({ status: 404 });
    expect(await stateOf(inside)).toBe('held');
  });

  it('the target workspace and the admin token are unchanged: no reason needed, nothing audited', async () => {
    const { inside, outside } = await seed();
    state.scope = { type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-w', tabVerified: true };
    expect(await call(retryRoute, 'POST', { id: inside }, {})).toMatchObject({ status: 200 });
    state.scope = ADMIN;
    expect(await call(retryRoute, 'POST', { id: outside }, {})).toMatchObject({ status: 200 });
    expect(audit.entries).toEqual([]);
  });
});

describe('note show (ADR-0047)', () => {
  it('the Scrum Master\'s read carries its selection to the notes service', async () => {
    state.scope = SM;
    expect(await call(showRoute, 'GET', { id: 'n-abc123' })).toMatchObject({ status: 200 });
    expect(notes.show).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-pm', tabId: 'tab-sm' }), 'n-abc123', ['ws-a']);
  });

  it.each([...REFUSED, ['the admin token', ADMIN]] as const)('%s carries no selection: the old rule decides', async (_label, scope) => {
    state.scope = scope;
    await call(showRoute, 'GET', { id: 'n-abc123' });
    expect(notes.show).toHaveBeenCalledWith(expect.anything(), 'n-abc123', []);
  });
});
