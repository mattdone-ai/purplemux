import fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILeaseHolder } from '@/types/lease';
import type { ITabAgentState } from '@/lib/lease-sweeper';
import { drainLeaseLocks, makeHome, readAudit, resetLeaseGlobals } from './lease-test-home';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const tabA: ILeaseHolder = { workspaceId: 'ws1', tabId: 'tab-a', tabName: 'A', verified: true, admin: false };
const admin: ILeaseHolder = { workspaceId: null, tabId: null, tabName: null, verified: false, admin: true };
const MIN = 60_000;

let now: number;
let live: Set<string>;
let uncertain: Set<string>;
let agents: Map<string, ITabAgentState>;
const authority = { now: () => now, isWorkspaceOrchestrator: async () => false };

const setup = async () => {
  const store = await import('@/lib/lease-store');
  const { LeaseSweeper } = await import('@/lib/lease-sweeper');
  const sweeper = new LeaseSweeper({
    now: () => now,
    listLiveTabs: async () => ({ liveTabIds: live, uncertainWorkspaceIds: uncertain }),
    getAgentState: (id) => agents.get(id) ?? null,
  });
  return { ...store, sweeper };
};

const names = async () => (await (await import('@/lib/lease-store')).listLeases()).map((l) => l.name);

describe('lease death', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetLeaseGlobals();
    mockHome.value = await makeHome();
    now = Date.now();
    live = new Set(['tab-a']);
    uncertain = new Set();
    agents = new Map([['tab-a', { cliState: 'busy', isAgent: true }]]);
  });

  afterEach(async () => {
    await drainLeaseLocks();
    resetLeaseGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('releases a tab-bound lease on tab-closed and audits holder-tab-closed; a num claim survives', async () => {
    const { acquireLease, getLeaseSweeper } = { ...(await setup()), ...(await import('@/lib/lease-sweeper')) };
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    getLeaseSweeper();
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    await acquireLease({ name: 'num:acme/acme-ledger-api:adr:0373', epic: 'p4' }, tabA, authority);

    emitTabClosed({ workspaceId: 'ws1', tabId: 'tab-a', sessionName: 's', reason: 'layout-removed' });
    await drainLeaseLocks();
    await drainLeaseLocks();

    expect(await names()).toEqual(['num:acme/acme-ledger-api:adr:0373']);
    const audit = await readAudit(mockHome.value);
    expect(audit.filter((e) => e.reason === 'holder-tab-closed').map((e) => e.name)).toEqual(['merge:x/y']);
  });

  it('releases an epic lease with no TTL after 10 min of inactive agent, and keeps it if the agent returns first', async () => {
    const { acquireLease, sweeper } = await setup();
    await acquireLease({ name: 'epic:x', ttlSeconds: null }, tabA, authority);

    agents.set('tab-a', { cliState: 'inactive', isAgent: true });
    await sweeper.sweep();
    now += 9 * MIN;
    await sweeper.sweep();
    agents.set('tab-a', { cliState: 'idle', isAgent: true });
    now += 1 * MIN;
    await sweeper.sweep();
    expect(await names()).toEqual(['epic:x']);

    agents.set('tab-a', { cliState: 'inactive', isAgent: true });
    await sweeper.sweep();
    now += 10 * MIN;
    const released = await sweeper.sweep();
    expect(released.map((r) => [r.lease.name, r.reason])).toEqual([['epic:x', 'holder-agent-gone']]);
    expect(await names()).toEqual([]);
  });

  it('never calls an agent gone for a non-agent tab or a tab the StatusManager does not know', async () => {
    const { acquireLease, sweeper } = await setup();
    live = new Set(['tab-a', 'tab-t', 'tab-u']);
    agents.set('tab-t', { cliState: 'inactive', isAgent: false });
    await acquireLease({ name: 'smoke:t' }, { ...tabA, tabId: 'tab-t' }, authority);
    await acquireLease({ name: 'smoke:u' }, { ...tabA, tabId: 'tab-u' }, authority);

    await sweeper.sweep();
    now += 20 * MIN;
    expect(await sweeper.sweep()).toEqual([]);
  });

  it('expires a lease past its TTL', async () => {
    const { acquireLease, sweeper } = await setup();
    await acquireLease({ name: 'smoke:ttl', ttlSeconds: 2 }, tabA, authority);
    now += 1000;
    expect(await sweeper.sweep()).toEqual([]);
    now += 1000;
    const released = await sweeper.sweep();
    expect(released.map((r) => r.reason)).toEqual(['expired']);
    await drainLeaseLocks();
    expect((await readAudit(mockHome.value)).at(-1)).toMatchObject({ name: 'smoke:ttl', reason: 'expired', sweep: true });
  });

  it('after a restart keeps the leases of a live holder and releases those of a vanished one with holder-tab-gone', async () => {
    const first = await setup();
    const tabGone: ILeaseHolder = { ...tabA, tabId: 'tab-gone' };
    await first.acquireLease({ name: 'epic:alive', ttlSeconds: null }, tabA, authority);
    await first.acquireLease({ name: 'merge:x/alive' }, tabA, authority);
    await first.acquireLease({ name: 'merge:x/gone' }, tabGone, authority);
    await first.acquireLease({ name: 'num:x/y:adr:0001', epic: 'p4' }, tabGone, authority);
    await drainLeaseLocks();

    // A new process: new module graph, empty in-memory state, file on disk.
    vi.resetModules();
    resetLeaseGlobals();
    agents = new Map();
    const { sweeper } = await setup();
    const released = await sweeper.sweep();

    expect(released.map((r) => [r.lease.name, r.reason])).toEqual([['merge:x/gone', 'holder-tab-gone']]);
    expect(await names()).toEqual(['epic:alive', 'merge:x/alive', 'num:x/y:adr:0001']);
  });

  it('never calls a tab gone when its workspace layout could not be read', async () => {
    const { acquireLease, sweeper } = await setup();
    await acquireLease({ name: 'epic:owned', ttlSeconds: null }, tabA, authority);
    live = new Set();
    uncertain = new Set(['ws1']);
    now += 1000;
    expect(await sweeper.sweep()).toEqual([]);
    uncertain = new Set();
    expect((await sweeper.sweep()).map((r) => r.reason)).toEqual(['holder-tab-gone']);
  });

  it('leaves a lease renewed after the tab facts were taken to the next sweep', async () => {
    const { acquireLease } = await setup();
    let facts: () => void = () => {};
    const gate = new Promise<void>((resolve) => { facts = resolve; });
    const slow = new (await import('@/lib/lease-sweeper')).LeaseSweeper({
      now: () => now,
      listLiveTabs: async () => { await gate; return { liveTabIds: new Set(), uncertainWorkspaceIds: new Set() }; },
      getAgentState: () => null,
    });
    const sweeping = slow.sweep();
    now += 1000;
    await acquireLease({ name: 'merge:x/new' }, { ...tabA, tabId: 'tab-new' }, authority);
    facts();
    expect(await sweeping).toEqual([]);
  });

  it('ends an admin lease only by TTL', async () => {
    const { acquireLease, sweeper } = await setup();
    await acquireLease({ name: 'smoke:admin', ttlSeconds: 60 }, admin, authority);
    live = new Set();
    expect(await sweeper.sweep()).toEqual([]);
    now += 60_000;
    expect((await sweeper.sweep()).map((r) => r.reason)).toEqual(['expired']);
  });

  it('does not overlap sweeps', async () => {
    const { acquireLease, sweeper } = await setup();
    await acquireLease({ name: 'smoke:x', ttlSeconds: 1 }, tabA, authority);
    now += 1000;
    const [a, b] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    expect(a.length + b.length).toBe(1);
  });

  it('reports the current inactive state for views without the grace', async () => {
    const { sweeper } = await setup();
    expect(sweeper.isAgentInactive('tab-a')).toBe(false);
    agents.set('tab-a', { cliState: 'inactive', isAgent: true });
    expect(sweeper.isAgentInactive('tab-a')).toBe(true);
    expect(sweeper.isAgentInactive('tab-unknown')).toBe(false);
  });
});

describe('boot sweep isolation', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetLeaseGlobals();
    mockHome.value = await makeHome();
  });

  afterEach(async () => {
    vi.doUnmock('@/lib/logger');
    vi.doUnmock('@/lib/tab-lifecycle');
    await drainLeaseLocks();
    resetLeaseGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('boots over a corrupt leases.json: initLeases logs and resolves, lease operations stay refused', async () => {
    const errors: string[] = [];
    vi.doMock('@/lib/logger', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: (m: string) => errors.push(m) }),
    }));
    vi.doMock('@/lib/tab-lifecycle', () => ({
      onTabClosed: () => () => {},
      readLiveTabs: async () => ({ tabs: [], uncertainWorkspaceIds: new Set() }),
    }));
    const { leasesFile, listLeases } = await import('@/lib/lease-store');
    await fs.mkdir(leasesFile().replace(/\/[^/]+$/, ''), { recursive: true });
    await fs.writeFile(leasesFile(), '');
    const { initLeases } = await import('@/lib/lease-sweeper');

    await expect(initLeases()).resolves.toBeUndefined();
    expect(errors.some((m) => m.includes('boot lease sweep failed') && m.includes('leases.json'))).toBe(true);
    await expect(listLeases()).rejects.toThrow('not valid JSON');
    await expect(listLeases()).rejects.toMatchObject({ code: 'lease-store-unreadable' });
  });
});

describe('coordination audit', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetLeaseGlobals();
    mockHome.value = await makeHome();
  });

  afterEach(async () => {
    await drainLeaseLocks();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('rotates at the size limit and keeps three generations', async () => {
    const { appendCoordinationAudit, auditFile, AUDIT_ROTATE_BYTES } = await import('@/lib/coordination-audit');
    const file = auditFile();
    for (let gen = 0; gen < 5; gen++) {
      await appendCoordinationAudit({ gen });
      await fs.truncate(file, AUDIT_ROTATE_BYTES);
    }
    await appendCoordinationAudit({ gen: 'last' });

    const dir = await fs.readdir(file.replace(/\/[^/]+$/, ''));
    expect(dir.sort()).toEqual(['coordination.jsonl', 'coordination.jsonl.1', 'coordination.jsonl.2', 'coordination.jsonl.3']);
    expect(JSON.parse((await fs.readFile(file, 'utf-8')).trim())).toMatchObject({ gen: 'last' });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});
