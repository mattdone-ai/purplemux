import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioStore } from '@/lib/portfolio-store';
import type { TCliScope } from '@/lib/workspace-token';

const state = vi.hoisted(() => ({
  scope: null as TCliScope | null,
  currentTab: 'tab-root',
  live: true,
  identity: 'launch',
  layoutSessionName: 'session-ws-root',
  tokenSessionName: 'session-ws-root',
  tokenWorkspaceId: 'ws-root',
  grantTarget: null as string | null,
  portfolioError: false,
}));

vi.mock('@/lib/portfolio-store', async (original) => {
  const actual = await original<typeof import('@/lib/portfolio-store')>();
  return { ...actual, getPortfolioStore: () => {
    if (state.portfolioError) throw new Error('portfolio storage unavailable');
    return actual.getPortfolioStore();
  } };
});
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => state.scope }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: async (id: string) => ({ id, orchestration: {
    enabled: true, orchestratorTabId: id === 'ws-root' ? state.currentTab : `tab-${id}`,
  }, allowedPeers: [] }),
  getWorkspaces: async () => ({ workspaces: ['ws-root', 'ws-a', 'ws-b'].map((id) => ({ id, name: id,
    directories: ['/repo'], orchestration: { enabled: true, orchestratorTabId: id === 'ws-root' ? state.currentTab : `tab-${id}` } })) }),
}));
vi.mock('@/lib/layout-store', () => ({
  resolveLayoutFile: (id: string) => id,
  readLayoutFile: async (id: string) => ({ root: { id } }),
  collectAllTabs: (root: { id: string }) => [{ id: root.id === 'ws-root' ? state.currentTab : `tab-${root.id}`,
    sessionName: root.id === 'ws-root' ? state.layoutSessionName : `session-${root.id}` }],
  getLayout: vi.fn(),
}));
vi.mock('@/lib/tab-token', () => ({ tabIdentityOf: () => state.identity,
  getTabTokenRecord: () => ({ workspaceId: state.tokenWorkspaceId, sessionName: state.tokenSessionName }) }));
vi.mock('@/lib/tmux', () => ({ hasSession: async () => state.live }));
const audit = vi.hoisted(() => ({ entries: [] as Record<string, unknown>[] }));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: async (entry: Record<string, unknown>) => {
  audit.entries.push(entry);
  return true;
} }));
vi.mock('@/lib/grant-store', () => ({ grantsSnapshot: () => ({ grants: [] }),
  findActiveDriveGrant: (_grants: unknown, grantee: { tabId: string }, target: string) =>
    state.grantTarget === target && grantee.tabId === 'tab-grantee' ? { id: 'g-legacy' } : null,
  findActiveOwnerGrant: () => null }));
vi.mock('@/lib/portfolio-service', () => ({ getPortfolioSnapshotForSelection: vi.fn(async (selection: unknown) => ({ selection })) }));
vi.mock('@/lib/mission-control-runtime', () => ({ getMissionSnapshot: async () => ({ schemaVersion: 1, cursor: 0 }) }));
vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => ({ humanInboxPolicy: () => ({ version: 1 }) }) }));
vi.mock('@/lib/caller', () => ({ resolveCaller: async () => state.scope && state.scope.type === 'workspace'
  ? { scope: state.scope, workspaceId: state.scope.workspaceId, tabId: state.scope.tabId ?? null,
    verified: state.scope.tabVerified === true } : null }));

const manager: TCliScope = { type: 'workspace', workspaceId: 'ws-root', tabId: 'tab-root', tabVerified: true };
const response = () => {
  const out = { status: 0, body: null as unknown };
  const res = { setHeader() { return this; }, status(value: number) { out.status = value; return this; },
    json(value: unknown) { out.body = value; return this; } } as unknown as NextApiResponse;
  return { out, res };
};

describe('human-selected Scrum Master read scope', () => {
  let store: PortfolioStore;
  beforeEach(() => {
    store = new PortfolioStore(':memory:');
    (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore = store;
    state.scope = manager;
    state.currentTab = 'tab-root';
    state.live = true;
    state.identity = 'launch';
    state.layoutSessionName = 'session-ws-root';
    state.tokenSessionName = 'session-ws-root';
    state.tokenWorkspaceId = 'ws-root';
    state.grantTarget = null;
    state.portfolioError = false;
    audit.entries.length = 0;
    store.select('human-a', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-a'] });
  });
  afterEach(() => {
    store.close();
    delete (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore;
  });

  it('permits selected workspace reads and writes with zero grants, and nothing outside the selection', async () => {
    const { accessDecision, authorizeWorkspace } = await import('@/lib/cli-utils');
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(true);
    expect((await accessDecision(manager, 'ws-b')).ok).toBe(false);
    const get = response();
    expect(await authorizeWorkspace({ method: 'GET', headers: {} } as NextApiRequest, get.res, 'ws-a')).toEqual(manager);
    const post = response();
    expect(await authorizeWorkspace({ method: 'POST', headers: {}, url: '/api/cli/tabs/tab-x/send?workspaceId=ws-a' } as NextApiRequest,
      post.res, 'ws-a')).toEqual(manager);
    expect(post.out.status).toBe(0);
    expect(audit.entries).toEqual([{ event: 'scrum-master-mutation-admitted', managerWorkspaceId: 'ws-root', managerTabId: 'tab-root',
      workspaceId: 'ws-a', route: '/api/cli/tabs/tab-x/send' }]);
    const outside = response();
    expect(await authorizeWorkspace({ method: 'DELETE', headers: {} } as NextApiRequest, outside.res, 'ws-b')).toBeNull();
    expect(outside.out.status).toBe(403);
    expect(audit.entries).toHaveLength(1);
  });

  it('refuses a foreign write by any tab that is not the exact, live, launch-verified selected manager', async () => {
    const { authorizeWorkspaceMutation } = await import('@/lib/cli-utils');
    const refused = async (scope: TCliScope): Promise<void> => {
      state.scope = scope;
      const out = response();
      expect(await authorizeWorkspaceMutation({ method: 'POST', headers: {} } as NextApiRequest, out.res, 'ws-a')).toBeNull();
      expect(out.out.status).toBe(403);
      state.scope = manager;
    };
    await refused({ ...manager, tabId: 'tab-other' });
    await refused({ ...manager, tabVerified: undefined });
    await refused({ ...manager, workspaceId: 'ws-other' });
    await refused({ type: 'admin' });
    state.identity = 'hook';
    await refused(manager);
    state.identity = 'launch';
    state.live = false;
    await refused(manager);
    state.live = true;
    state.currentTab = 'tab-reassigned';
    await refused(manager);
    state.currentTab = 'tab-root';
    store.select('human-b', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-b'] });
    await refused(manager);
    expect(audit.entries).toEqual([]);
  });

  it('fails closed when the selection store cannot be read', async () => {
    const { authorizeWorkspaceMutation } = await import('@/lib/cli-utils');
    state.portfolioError = true;
    const out = response();
    expect(await authorizeWorkspaceMutation({ method: 'POST', headers: {} } as NextApiRequest, out.res, 'ws-a')).toBeNull();
    expect(out.out.status).toBe(403);
    expect(audit.entries).toEqual([]);
  });

  it('keeps the write when the audit line cannot be written', async () => {
    const { selectedScrumMasterMayMutate } = await import('@/lib/cli-utils');
    expect(await selectedScrumMasterMayMutate(manager, 'ws-a', undefined, async () => { throw new Error('disk full'); })).toBe(true);
    expect(await selectedScrumMasterMayMutate(manager, 'ws-b', undefined, async () => true)).toBe(false);
  });

  it('rejects other, unverified, reassigned and closed manager tabs immediately', async () => {
    const { accessDecision } = await import('@/lib/cli-utils');
    expect((await accessDecision({ ...manager, tabId: 'tab-other' }, 'ws-a')).ok).toBe(false);
    expect((await accessDecision({ ...manager, tabVerified: undefined }, 'ws-a')).ok).toBe(false);
    expect((await accessDecision({ ...manager, workspaceId: 'ws-other' }, 'ws-a')).ok).toBe(false);
    state.identity = 'hook';
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    state.identity = 'launch';
    state.live = false;
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    state.live = true;
    state.currentTab = 'tab-reassigned';
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    state.currentTab = 'tab-root';
    store.select('human-b', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-b'] });
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    expect((await accessDecision(manager, 'ws-b')).ok).toBe(true);
  });

  it('rejects a stale token whose session or workspace differs from the live layout', async () => {
    const { accessDecision } = await import('@/lib/cli-utils');
    state.tokenSessionName = 'session-old';
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    state.tokenSessionName = 'session-ws-root';
    state.tokenWorkspaceId = 'ws-other';
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(false);
    state.tokenWorkspaceId = 'ws-root';
    expect((await accessDecision(manager, 'ws-a')).ok).toBe(true);
  });

  it('honors an independent legacy grant when portfolio storage fails', async () => {
    const { accessDecision } = await import('@/lib/cli-utils');
    state.portfolioError = true;
    state.grantTarget = 'ws-b';
    const grantee: TCliScope = { type: 'workspace', workspaceId: 'ws-other', tabId: 'tab-grantee', tabVerified: true };
    expect(await accessDecision(grantee, 'ws-b')).toMatchObject({ ok: true, grant: { id: 'g-legacy' } });
    state.grantTarget = null;
    await expect(accessDecision(grantee, 'ws-b')).rejects.toThrow('portfolio storage unavailable');
  });

  it('lists only selected workspace reads and refuses CLI portfolio scope expansion', async () => {
    const { default: workspaces } = await import('@/pages/api/cli/workspaces');
    const listing = response();
    await workspaces({ method: 'GET', headers: {} } as NextApiRequest, listing.res);
    expect(listing.out.body).toEqual({ workspaces: [
      { id: 'ws-root', name: 'ws-root', directories: ['/repo'] },
      { id: 'ws-a', name: 'ws-a', directories: ['/repo'] },
    ] });

    const { default: portfolio } = await import('@/pages/api/cli/portfolio');
    const allowed = response();
    await portfolio({ method: 'GET', headers: {}, query: { workspaces: 'ws-a' } } as unknown as NextApiRequest, allowed.res);
    expect(allowed.out.status).toBe(200);
    const denied = response();
    await portfolio({ method: 'GET', headers: {}, query: { workspaces: 'ws-root' } } as unknown as NextApiRequest, denied.res);
    expect(denied.out.status).toBe(403);
    const other = response();
    await portfolio({ method: 'GET', headers: {}, query: { workspaces: 'ws-a,ws-b' } } as unknown as NextApiRequest, other.res);
    expect(other.out.status).toBe(403);
    const mutation = response();
    await portfolio({ method: 'POST', headers: {}, query: { workspaces: 'ws-a' } } as unknown as NextApiRequest, mutation.res);
    expect(mutation.out.status).toBe(405);
  });

  it('applies selection removal to the ordinary Mission Control read route', async () => {
    const { default: mission } = await import('@/pages/api/cli/mission-control');
    const allowed = response();
    await mission({ method: 'GET', headers: {}, query: { workspaceId: 'ws-a' } } as unknown as NextApiRequest, allowed.res);
    expect(allowed.out.status).toBe(200);
    store.select('human-b', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: [] });
    const denied = response();
    await mission({ method: 'GET', headers: {}, query: { workspaceId: 'ws-a' } } as unknown as NextApiRequest, denied.res);
    expect(denied.out.status).toBe(403);
  });
});

describe('sameSelection (ADR-0045)', () => {
  it('is the same actor, time, manager and workspaces; anything else, or null, is not', async () => {
    const { sameSelection } = await import('@/lib/scrum-master-access');
    const a = { actor: 'owner', updatedAt: 1, selection: { managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm', workspaceIds: ['ws-a', 'ws-b'] } };
    expect(sameSelection(a, structuredClone(a))).toBe(true);
    expect(sameSelection(a, { ...a, updatedAt: 2 })).toBe(false);
    expect(sameSelection(a, { ...a, actor: 'other' })).toBe(false);
    expect(sameSelection(a, { ...a, selection: { ...a.selection, managerTabId: 'tab-x' } })).toBe(false);
    expect(sameSelection(a, { ...a, selection: { ...a.selection, workspaceIds: ['ws-a'] } })).toBe(false);
    expect(sameSelection(a, null)).toBe(false);
    expect(sameSelection(null, null)).toBe(false);
  });
});
