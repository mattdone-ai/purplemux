import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import grantsMessages from '../../../messages/en/grants.json';
import type { TCliScope } from '@/lib/workspace-token';
import type { IGrant, IGrantRefusal } from '@/types/grant';

// Story 05 round 1, consult RULING A: each grant file fails alone in the listings
// too. Over the four file states and both GET routes: the list holds exactly the
// grants the predicates enforce, `refused` names every unreadable file, each
// listed grant can be revoked, `grant list` exits 1 on a partial refusal, and the
// dialog never shows a refused kind as "none".

const audit = vi.hoisted(() => vi.fn(async (_e: Record<string, unknown>) => true));
const scopeHolder = vi.hoisted(() => ({ scope: null as TCliScope | null }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  verifySessionToken: vi.fn(async (token: string) => (token === 'good-session' ? { sub: 'human' } : null)),
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async (id: string) => ({ id, allowedPeers: [] })),
  getWorkspaces: vi.fn(async () => ({ workspaces: [] })),
  readWorkspaceIdsStrict: vi.fn(async () => []),
}));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));
vi.mock('@/lib/scrum-master-access', () => ({ selectedScrumMasterCanRead: async () => false }));
vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => scopeHolder.scope,
}));

// The first load of this module graph costs about 1 s alone and passed the 5 s test budget on a loaded gate
// (story hfl2-53). Load it once here, at collection, outside every test's budget; the tests' own imports
// resolve to this instance.
await Promise.all([
  import('@/pages/api/grants'),
  import('@/pages/api/cli/grants'),
  import('@/lib/grant-store'),
  import('@/lib/cli-utils'),
  import('@/components/features/workspace/portfolio-grants-panel'),
]);

const TAB_A: TCliScope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-a', tabVerified: true, tabIdentity: 'launch' };
const TAB_O: TCliScope = { type: 'workspace', workspaceId: 'ws-1', tabId: 'tab-o', tabVerified: true, tabIdentity: 'launch' };
const STATES = ['both readable', 'drive refused', 'owner refused', 'both refused'] as const;
type TState = (typeof STATES)[number];
const refusedOf = (state: TState): Array<'drive' | 'owner'> =>
  ({ 'both readable': [], 'drive refused': ['drive'], 'owner refused': ['owner'], 'both refused': ['drive', 'owner'] } as const)[state].slice();

type TBody = { grants: IGrant[]; refused: IGrantRefusal[]; code?: string; error?: string };

const call = async (route: string, method: string, query: Record<string, string> = {}) => {
  const { default: handler } = await import(route);
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(c: number) { state.status = c; return this; },
    json(b: unknown) { state.body = b; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  const headers = { host: 'localhost:8022', origin: 'http://localhost:8022', cookie: 'session-token=good-session' };
  await handler({ method, headers, body: {}, query, socket: {} } as unknown as NextApiRequest, res);
  return state as { status: number; body: TBody };
};

/** Seed an active drive grant D (tab-a reads ws-2) and an owner grant O (tab-o), then damage the files of `state`. */
const seed = async (state: TState) => {
  const store = await import('@/lib/grant-store');
  for (const f of [store.grantsFile(), store.ownerGrantsFile()]) fs.rmSync(f, { force: true });
  store.reloadGrants();
  const now = Date.now();
  await store.mutateGrants((s) => ({
    state: store.createGrantInState(s, { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-a', workspaces: ['ws-2'], reason: 'r', expiresInHours: 1, createdBy: 'human' }, now, 'g-drive1').state,
    value: null,
  }));
  await store.mutateGrants((s) => ({
    state: store.createGrantInState(s, { granteeWorkspaceId: 'ws-1', granteeTabId: 'tab-o', workspaces: ['*'], reason: 'r', expiresInHours: 1, createdBy: 'human', capability: 'owner' }, now, 'g-owner1').state,
    value: null,
  }), 'owner');
  for (const kind of refusedOf(state)) fs.writeFileSync(store.grantStoreFile(kind), '{nope');
  store.reloadGrants();
};

const enforced = async () => {
  const { canAccessWorkspace } = await import('@/lib/cli-utils');
  return { 'g-drive1': await canAccessWorkspace(TAB_A, 'ws-2'), 'g-owner1': await canAccessWorkspace(TAB_O, 'ws-3') } as Record<string, boolean>;
};

const listings = async () => {
  const human = await call('@/pages/api/grants', 'GET');
  scopeHolder.scope = { type: 'admin' };
  const cli = await call('@/pages/api/cli/grants', 'GET');
  scopeHolder.scope = null;
  return { human, cli };
};

// A stub CLI server that answers `grant list` with a captured route body.
let server: http.Server;
let port = 0;
let reply: { status: number; body: unknown } = { status: 200, body: {} };
const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-grant-refusal-'));
const runCli = async (args: string[]) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.resolve('bin/purplemux.js'), ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TOKEN: 'test-token' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

describe('grant listings when a grant file is refused (ADR-0029 §1, RULING A)', () => {
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(cliHome, { recursive: true, force: true });
  });
  beforeEach(() => { scopeHolder.scope = null; });
  afterEach(async () => {
    const store = await import('@/lib/grant-store');
    for (const f of [store.grantsFile(), store.ownerGrantsFile()]) fs.rmSync(f, { force: true });
    store.reloadGrants();
  });

  it.each(STATES)('%s: 500 only when both refused; refused names each file; the list equals what is enforced', async (state) => {
    await seed(state);
    const { human, cli } = await listings();
    const refusedKinds = refusedOf(state);
    const admitted = await enforced();
    for (const r of [human, cli]) {
      if (refusedKinds.length === 2) {
        expect(r).toMatchObject({ status: 500, body: { code: 'grant-store-unreadable' } });
        expect(r.body.error).toContain('/grants.json');
        expect(r.body.error).toContain('/owner-grants.json');
        continue;
      }
      expect(r.status).toBe(200);
      expect(r.body.refused.map((x) => x.capability)).toEqual(refusedKinds);
      for (const x of r.body.refused) {
        expect(x.file).toBe(x.capability === 'owner' ? 'owner-grants.json' : 'grants.json');
        expect(x.error).toContain(`/${x.file} is malformed`);
        expect(x.code).toBe('grant-store-unreadable');
      }
      const ids = r.body.grants.map((g) => g.id);
      for (const id of ['g-drive1', 'g-owner1']) expect({ id, listed: ids.includes(id) }).toEqual({ id, listed: admitted[id] });
    }
    expect(Object.values(admitted).filter(Boolean)).toHaveLength(2 - refusedKinds.length);
  });

  it.each(STATES)('%s: every listed grant can be revoked, and its predicate denies afterwards', async (state) => {
    await seed(state);
    const { human } = await listings();
    const ids = human.status === 200 ? human.body.grants.map((g) => g.id) : [];
    for (const id of ids) expect((await call('@/pages/api/grants/[id]', 'DELETE', { id })).status).toBe(200);
    const after = await enforced();
    for (const id of ids) expect({ id, enforced: after[id] }).toEqual({ id, enforced: false });
  });

  it.each(['drive refused', 'owner refused'] as const)('%s: grant list prints the readable grant, names the refusal on stderr and exits 1; --json too', async (state) => {
    await seed(state);
    scopeHolder.scope = { type: 'admin' };
    const r = await call('@/pages/api/cli/grants', 'GET');
    reply = { status: r.status, body: r.body };
    const readable = state === 'drive refused' ? 'g-owner1' : 'g-drive1';
    const text = await runCli(['grant', 'list']);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(readable);
    expect(text.stdout).not.toMatch(/^no grants$/m);
    expect(text.stderr).toContain('error: grant-store-unreadable (unexpected — investigate) — ');
    const asJson = await runCli(['grant', 'list', '--json']);
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.stdout).refused).toHaveLength(1);
    expect(asJson.stderr).toContain('error: grant-store-unreadable');
  });

  it('grant list: a readable kind with no grants prints "no <kind> grants", never the bare "no grants"', async () => {
    reply = { status: 200, body: { grants: [], refused: [{ capability: 'owner', file: 'owner-grants.json', error: 'x is malformed', code: 'grant-store-unreadable' }] } };
    const text = await runCli(['grant', 'list']);
    expect(text).toMatchObject({ code: 1, stdout: 'no drive grants\n' });
    reply = { status: 200, body: { grants: [], refused: [] } };
    expect(await runCli(['grant', 'list'])).toMatchObject({ code: 0, stdout: 'no grants\n' });
  });

  it('the dialog with owner grants refused: the drive row with Revoke, the owner refusal, owner Create disabled, no "none" claims', async () => {
    await seed('owner refused');
    const { human } = await listings();
    const { default: Panel } = await import('@/components/features/workspace/portfolio-grants-panel');
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants: grantsMessages }}>
        <Panel
          available
          grantees={[{ workspaceId: 'ws-1', workspaceName: 'Owner', tabId: 'tab-o', name: 'owner', panelType: 'claude-code', identity: 'launch' }]}
          granteesError={null} unreadableWorkspaceIds={[]} grants={human.body.grants} refused={human.body.refused}
          workspaceNames={{ 'ws-1': 'Owner', 'ws-2': 'Billing' }} now={Date.now()} capability="owner" onCapabilityChange={vi.fn()}
          granteeKey="ws-1/tab-o" onGranteeChange={vi.fn()} workspaces={[]} onWorkspacesChange={vi.fn()}
          expiresInHours={24} onExpiryChange={vi.fn()} reason="r" onReasonChange={vi.fn()} password="pw" onPasswordChange={vi.fn()}
          error={null} submitting={false} revokingIds={[]} onSubmit={vi.fn()} onRevoke={vi.fn()}
        />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('data-grant="g-drive1"');
    expect(html).toContain('Revoke');
    expect(html).toContain('data-grant-refused="owner"');
    expect(html).toContain('Owner sessions are not honoured: owner-grants.json cannot be read — ');
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>(<[^>]*>)*Create grant/);
    expect(html).not.toContain(grantsMessages.noActive);
    expect(html).not.toContain('data-owner-active');
  });
});
