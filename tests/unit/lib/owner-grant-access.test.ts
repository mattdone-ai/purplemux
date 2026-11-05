import fs from 'fs';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TCliScope } from '@/lib/workspace-token';

// ADR-0029 §3 and §5: the owner's verified tab reads every workspace (one audit
// line per grant, workspace and hour), never mutates another one, and loses the
// reads when the grant is revoked, expires or its tab closes.

const scopeHolder = vi.hoisted(() => ({ scope: null as TCliScope | null }));
const audit = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => {}));

vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => scopeHolder.scope,
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn(async (id: string) => ({ id, allowedPeers: [] })) }));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));
vi.mock('@/lib/scrum-master-access', () => ({ selectedScrumMasterCanRead: async () => false }));
vi.mock('@/lib/caller', () => ({
  resolveCaller: vi.fn(async () => (scopeHolder.scope ? {
    scope: scopeHolder.scope, workspaceId: 'ws-1', tabId: 'tab-o', tabName: 'owner', verified: true, identity: 'launch', admin: false,
  } : null)),
}));

// The first load of this module graph costs about 1 s alone and passed the 5 s test budget on a loaded gate
// (story hfl2-53). Load it once here, at collection, outside every test's budget; the tests' own imports
// resolve to this instance.
await Promise.all([
  import('@/lib/grant-store'),
  import('@/lib/grant-service'),
  import('@/lib/cli-utils'),
  import('@/pages/api/cli/inbox/index'),
  import('@/pages/api/cli/mission-control/events'),
  import('@/pages/api/cli/workspaces/[workspaceId]/standup'),
]);

const HOUR = 60 * 60 * 1000;
const OWNER: TCliScope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-o', tabVerified: true, tabIdentity: 'launch' };
const OWNER_HOOK: TCliScope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-o', tabIdentity: 'hook' };
const SIBLING: TCliScope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-b', tabVerified: true, tabIdentity: 'launch' };
const WS1: TCliScope = { type: 'workspace', workspaceId: 'ws-1' };

const ownerGrant = async (createdAt = Date.now(), hours = 24) => {
  const { createGrantInState, mutateGrants } = await import('@/lib/grant-store');
  return mutateGrants((s) => {
    const r = createGrantInState(s, {
      granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-o', workspaces: ['*'], reason: 'r', expiresInHours: hours, createdBy: 'human', capability: 'owner',
    }, createdAt, 'g-owner1');
    return { state: r.state, value: r.grant };
  }, 'owner');
};

const access = async (scope: TCliScope, method: string, ws: string) => {
  scopeHolder.scope = scope;
  const { authorizeWorkspace } = await import('@/lib/cli-utils');
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; } } as unknown as NextApiResponse;
  const result = await authorizeWorkspace({ method, url: '/x', query: {}, headers: {} } as unknown as NextApiRequest, res, ws);
  return { result, ...state } as { result: TCliScope | null; status: number; body: { code?: string; error?: string } };
};

const ownerReads = () => audit.mock.calls.map(([e]) => e).filter((e) => e.event === 'owner-read');

const clean = async () => {
  const { grantsFile, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
  fs.rmSync(grantsFile(), { force: true });
  fs.rmSync(ownerGrantsFile(), { force: true });
  reloadGrants();
  (await import('@/lib/grant-service')).resetOwnerReadAudit();
};

describe('the owner grant in the predicates (ADR-0029)', () => {
  beforeEach(async () => {
    await clean();
    audit.mockClear();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await clean();
  });

  it('reads every workspace, including one created after the grant, only for the verified grantee tab', async () => {
    await ownerGrant();
    const { accessDecision, canAccessWorkspace } = await import('@/lib/cli-utils');
    expect(await accessDecision(OWNER, 'ws-2')).toMatchObject({ ok: true, grant: { id: 'g-owner1', capability: 'owner' } });
    expect(await canAccessWorkspace(OWNER, 'ws-created-later')).toBe(true);
    for (const scope of [OWNER_HOOK, SIBLING, WS1]) expect(await canAccessWorkspace(scope, 'ws-2')).toBe(false);
    expect((await access(OWNER, 'GET', 'ws-9')).result).toBe(OWNER);
    expect((await access(SIBLING, 'GET', 'ws-9'))).toMatchObject({ status: 403, body: { code: 'forbidden' } });
  });

  it('reads another workspace through its CLI routes (inbox list, standup show), and is refused a standup report there', async () => {
    await ownerGrant();
    scopeHolder.scope = OWNER;
    const route = async (mod: string, method: string, query: Record<string, string>, body?: unknown) => {
      const { default: handler } = await import(mod);
      const state = { status: 0, body: undefined as unknown };
      const res = {
        status(c: number) { state.status = c; return this; },
        json(b: unknown) { state.body = b; return this; },
        setHeader() { return this; },
      } as unknown as NextApiResponse;
      await handler({ method, headers: {}, query, body, url: '/x' } as unknown as NextApiRequest, res);
      return state as { status: number; body: { code?: string; error?: string; items?: unknown[] } };
    };
    expect(await route('@/pages/api/cli/inbox/index', 'GET', { workspaceId: 'ws-2' })).toMatchObject({ status: 200, body: { items: [] } });
    expect((await route('@/pages/api/cli/workspaces/[workspaceId]/standup', 'GET', { workspaceId: 'ws-2' })).status).toBe(200);
    const report = await route('@/pages/api/cli/workspaces/[workspaceId]/standup', 'POST', { workspaceId: 'ws-2' }, { state: 'on-track', headline: 'x' });
    expect(report).toMatchObject({ status: 403, body: { code: 'forbidden', error: expect.stringContaining('send a note as owner') } });
    scopeHolder.scope = SIBLING;
    expect(await route('@/pages/api/cli/inbox/index', 'GET', { workspaceId: 'ws-2' })).toMatchObject({ status: 403, body: { code: 'forbidden' } });
  });

  it('never permits a foreign mutation; the denial names "send a note as owner"', async () => {
    await ownerGrant();
    const { canDriveWorkspace, driveDecision } = await import('@/lib/cli-utils');
    expect(canDriveWorkspace(OWNER, 'ws-2')).toBe(false);
    expect(driveDecision(OWNER, 'ws-2')).toEqual({ ok: false, grant: null });
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
      const r = await access(OWNER, method, 'ws-2');
      expect(r).toMatchObject({ result: null, status: 403, body: { code: 'forbidden' } });
      expect(r.body.error).toContain('send a note as owner');
    }
    expect((await access(OWNER, 'POST', 'ws-1')).result).toBe(OWNER);
  });

  it('refuses a foreign Mission Control event batch from the owner tab, naming the note path', async () => {
    await ownerGrant();
    scopeHolder.scope = OWNER;
    const { default: handler } = await import('@/pages/api/cli/mission-control/events');
    const state = { status: 0, body: undefined as unknown };
    const res = {
      status(c: number) { state.status = c; return this; },
      json(b: unknown) { state.body = b; return this; },
      setHeader() { return this; },
    } as unknown as NextApiResponse;
    await handler({ method: 'POST', headers: {}, query: { workspaceId: 'ws-2' }, body: { events: [] } } as unknown as NextApiRequest, res);
    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ code: 'forbidden', error: expect.stringContaining('send a note as owner') });
  });

  it('audits at most one owner-read per (grant, workspace) per hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-10-26T10:00:00Z'));
    await ownerGrant();
    const { canAccessWorkspace } = await import('@/lib/cli-utils');
    for (let i = 0; i < 5; i += 1) await canAccessWorkspace(OWNER, 'ws-2');
    await canAccessWorkspace(OWNER, 'ws-3');
    await canAccessWorkspace(OWNER, 'ws-1');
    expect(ownerReads()).toEqual([
      { event: 'owner-read', grantId: 'g-owner1', grantee: { workspaceId: 'ws-1', tabId: 'tab-o' }, workspaceId: 'ws-2' },
      { event: 'owner-read', grantId: 'g-owner1', grantee: { workspaceId: 'ws-1', tabId: 'tab-o' }, workspaceId: 'ws-3' },
    ]);
    vi.setSystemTime(Date.parse('2026-10-26T10:59:59Z'));
    await canAccessWorkspace(OWNER, 'ws-2');
    expect(ownerReads()).toHaveLength(2);
    vi.setSystemTime(Date.parse('2026-10-26T11:00:00Z'));
    await canAccessWorkspace(OWNER, 'ws-2');
    expect(ownerReads()).toHaveLength(3);
  });

  it('an owner-read line the append could not write never refuses the read and is written again on the next read', async () => {
    await ownerGrant();
    audit.mockResolvedValueOnce(false as never);
    const { canAccessWorkspace } = await import('@/lib/cli-utils');
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(true);
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(true);
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(true);
    expect(ownerReads()).toHaveLength(2);
  });

  it('an owner-read audit that throws never refuses the read and is written again on the next read', async () => {
    await ownerGrant();
    audit.mockRejectedValueOnce(new Error('disk gone') as never);
    const { canAccessWorkspace } = await import('@/lib/cli-utils');
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(true);
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(true);
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(true);
    expect(ownerReads()).toHaveLength(2);
  });

  it('the real coordination append answers false on a failed write, so the owner-read line is retried', async () => {
    const actual = await vi.importActual<typeof import('@/lib/coordination-audit')>('@/lib/coordination-audit');
    const { auditOwnerRead } = await import('@/lib/grant-service');
    const grant = await ownerGrant();
    const file = actual.auditFile();
    const dir = path.dirname(file);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // A plain file where the audit directory belongs: mkdir and append both fail.
    fs.writeFileSync(dir, 'not a directory');
    try {
      expect(await actual.appendCoordinationAudit({ event: 'probe' })).toBe(false);
      await auditOwnerRead(grant, 'ws-2', 1_000, actual.appendCoordinationAudit);
    } finally {
      fs.rmSync(dir, { force: true });
    }
    await auditOwnerRead(grant, 'ws-2', 2_000, actual.appendCoordinationAudit);
    await auditOwnerRead(grant, 'ws-2', 3_000, actual.appendCoordinationAudit);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.event === 'owner-read')).toEqual([
      expect.objectContaining({ event: 'owner-read', grantId: 'g-owner1', workspaceId: 'ws-2' }),
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ends with a revoke, the expiry or the close of the grantee tab: reads are out of scope again', async () => {
    const { canAccessWorkspace } = await import('@/lib/cli-utils');
    const { revokeForClosedTab, revokeGrant, sweepGrants } = await import('@/lib/grant-service');
    const deps = {
      now: () => Date.now(), audit, passwordHash: async () => null, verifyPassword: async () => false,
      workspaceExists: async () => true, tabExists: async () => true, tabIdentity: () => 'launch' as const,
    };

    await ownerGrant();
    await revokeGrant(deps, 'human', 'g-owner1');
    expect(await access(OWNER, 'GET', 'ws-2')).toMatchObject({ status: 403, body: { error: expect.stringContaining('out of scope') } });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-revoked', grantId: 'g-owner1', reason: 'revoked' }));

    await clean();
    await ownerGrant(Date.now() - 2 * HOUR, 1);
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(false);
    expect((await sweepGrants(deps)).map((g) => g.id)).toEqual(['g-owner1']);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'grant-expired', grantId: 'g-owner1' }));

    await clean();
    await ownerGrant();
    expect((await revokeForClosedTab(deps, { workspaceId: 'ws-1', tabId: 'tab-o' })).map((g) => g.revokeReason)).toEqual(['grantee-tab-closed']);
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(false);
  });

  it('an unreadable owner file honours no owner grant and leaves drive grants working', async () => {
    const { createGrantInState, mutateGrants, ownerGrantsFile, reloadGrants } = await import('@/lib/grant-store');
    await mutateGrants((s) => ({
      state: createGrantInState(s, { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-o', workspaces: ['ws-2'], reason: 'r', expiresInHours: 1, createdBy: 'human' }, Date.now(), 'g-drive1').state,
      value: null,
    }));
    fs.mkdirSync(path.dirname(ownerGrantsFile()), { recursive: true });
    fs.writeFileSync(ownerGrantsFile(), '{nope');
    reloadGrants();
    const { canAccessWorkspace } = await import('@/lib/cli-utils');
    expect(await canAccessWorkspace(OWNER, 'ws-2')).toBe(true);
    expect(await canAccessWorkspace(OWNER, 'ws-3')).toBe(false);
  });
});
