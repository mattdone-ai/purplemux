import fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPoolHostTabs } from '@/lib/pool';
import type { ILeaseHolder } from '@/types/lease';
import type { IPoolAcquireResult, IPoolMetrics, IPoolQueuedResult, TPoolHostRead } from '@/types/pool';
import { drainLeaseLocks, makeHome, readAudit, resetLeaseGlobals } from './lease-test-home';

// ADR-0039 §2 and vel-D4: pool slots and queue tickets on the ADR-0011 lease store, in a temporary HOME.
// The hosts are fakes: nothing here is placed on host-b.

const mockHome = vi.hoisted(() => ({ value: '' }));
const warnings = vi.hoisted(() => [] as string[]);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: (m: string) => { warnings.push(m); }, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const GIB = 1024 ** 3;
const tab = (id: string): ILeaseHolder => ({ workspaceId: 'ws1', tabId: id, tabName: id, verified: true, admin: false });
const tabA = tab('tab-a');
const tabB = tab('tab-b');
const tabC = tab('tab-c');
const noTab: ILeaseHolder = { workspaceId: 'ws1', tabId: null, tabName: null, verified: false, admin: false };

let now = Date.parse('2026-11-03T07:00:00Z');
const orchestratorTab = vi.hoisted(() => ({ id: 'tab-o' }));
const authority = { now: () => now, isWorkspaceOrchestrator: async (_ws: string, tabId: string) => tabId === orchestratorTab.id };

const metrics = (over: Partial<IPoolMetrics>): IPoolMetrics => ({
  threads: 32, load1: 16, load5: 16, memTotalBytes: 91 * GIB, memAvailableBytes: 40 * GIB,
  disks: [{ path: '/', usedPct: 50, freeBytes: 1 }], gpus: null, sccacheSweep: null, ...over,
});

let reads: TPoolHostRead[];
let config: Record<string, string>;
let tabs: Map<string, IPoolHostTabs>;

const service = () => import('@/lib/pool-service');
const deps = async () => {
  const { listLeases } = await import('@/lib/lease-store');
  return {
    reads: async () => reads,
    config: async () => (key: string) => config[key] ?? null,
    agentTabs: async () => tabs,
    leases: async () => [...await listLeases('pool:', now), ...await listLeases('pool-queue:', now)],
    now: () => now,
  };
};

const admitted = (r: IPoolAcquireResult | IPoolQueuedResult): IPoolAcquireResult => {
  if ('queued' in r) throw new Error(`expected an admission, got ${r.reason}`);
  return r;
};
const queued = (r: IPoolAcquireResult | IPoolQueuedResult): IPoolQueuedResult => {
  if (!('queued' in r)) throw new Error(`expected a queued answer, got ${r.host}`);
  return r;
};

const md = { host: 'host-a', local: true, state: 'known' as const, via: null };
const aiRead = (over: Partial<IPoolMetrics> = {}): TPoolHostRead =>
  ({ host: 'host-b-lan', local: false, state: 'known', readAt: now, via: 'host-b-lan', metrics: metrics({ threads: 64, load1: 16, memTotalBytes: 373 * GIB, memAvailableBytes: 250 * GIB, ...over }) });

beforeEach(async () => {
  vi.resetModules();
  resetLeaseGlobals();
  warnings.length = 0;
  mockHome.value = await makeHome();
  now = Date.parse('2026-11-03T07:00:00Z');
  reads = [{ ...md, readAt: now, metrics: metrics({}) }, aiRead()];
  config = { 'pool.mode': 'enforce' };
  delete (globalThis as Record<string, unknown>).__ptPoolRuntime;
  tabs = new Map();
});

afterEach(async () => {
  await drainLeaseLocks();
  resetLeaseGlobals();
  await fs.rm(mockHome.value, { recursive: true, force: true });
});

describe('pool acquire / release (AC 2)', () => {
  it('returns {host, slot, lease, envelope}; the lease is a pool lease held by the caller with its TTL and envelope', async () => {
    const { acquirePoolSlot } = await service();
    const got = await acquirePoolSlot({ kind: 'gate', memGb: 12, ttlSeconds: 2700 }, tabA, authority, await deps());
    expect(got).toEqual({
      host: 'host-b-lan', local: false, slot: 'gate-1', lease: 'pool:host-b-lan/gate-1', class: 'product', envelope: { threads: 8, memGb: 12 },
      expiresAt: new Date(now + 2700_000).toISOString(), reason: expect.stringContaining('lowest load per thread'), gateHost: null,
      ask: null, pin: null,
    });
    const { findLease } = await import('@/lib/lease-store');
    expect(await findLease('pool:host-b-lan/gate-1', now)).toMatchObject({ kind: 'pool', holder: { tabId: 'tab-a' }, note: 'pool mem=12 threads=8 class=product', ttlSeconds: 2700, survivesTab: false });
    await drainLeaseLocks();
    expect((await readAudit(mockHome.value)).map((e) => e.event)).toEqual(['lease-acquire']);
  });

  it('the default TTL is 60 minutes; more than 24 h is refused', async () => {
    const { acquirePoolSlot } = await service();
    expect(admitted(await acquirePoolSlot({ kind: 'build' }, tabA, authority, await deps())).expiresAt).toBe(new Date(now + 3600_000).toISOString());
    await expect(acquirePoolSlot({ kind: 'build', ttlSeconds: 25 * 3600 }, tabA, authority, await deps())).rejects.toMatchObject({ code: 'lease-policy' });
  });

  it('two acquires take two slots, never one; the lowest free number first', async () => {
    const { acquirePoolSlot } = await service();
    const d = await deps();
    const [a, b] = await Promise.all([
      acquirePoolSlot({ kind: 'gate' }, tabA, authority, d),
      acquirePoolSlot({ kind: 'gate' }, tabB, authority, d),
    ]);
    expect(new Set([admitted(a).lease, admitted(b).lease])).toEqual(new Set(['pool:host-b-lan/gate-1', 'pool:host-b-lan/gate-2']));
  });

  it('a held slot counts; when every count cap is held the answer is pool-full with the counts', async () => {
    const { acquirePoolSlot } = await service();
    config = { 'pool.mode': 'enforce', 'pool.slots.host-b-lan.gate': '1', 'pool.slots.host-a.gate': '1' };
    const d = await deps();
    expect(admitted(await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d)).host).toBe('host-b-lan');
    expect(admitted(await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d)).host).toBe('host-a');
    await expect(acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).rejects.toMatchObject({
      code: 'pool-full', refusal: 'no-free-slot', message: expect.stringContaining('host-a: gate 1/1 (pool.slots); host-b-lan: gate 1/1 (pool.slots)'),
    });
  });

  it('an expired lease frees its slot', async () => {
    const { acquirePoolSlot } = await service();
    config = { 'pool.mode': 'enforce', 'pool.slots.host-b-lan.gate': '1', 'pool.slots.host-a.gate': '0' };
    const d = await deps();
    await acquirePoolSlot({ kind: 'gate', ttlSeconds: 60 }, tabA, authority, d);
    await expect(acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).rejects.toMatchObject({ code: 'pool-full' });
    now += 61_000;
    reads = reads.map((r) => ({ ...r, readAt: now }));
    expect(await acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).toMatchObject({ lease: 'pool:host-b-lan/gate-1' });
  });

  it('release frees the slot for the next caller; only the holder releases; a non-pool name is refused', async () => {
    const { acquirePoolSlot, releasePoolSlot } = await service();
    config = { 'pool.mode': 'enforce', 'pool.slots.host-b-lan.gate': '1', 'pool.slots.host-a.gate': '0' };
    const d = await deps();
    const { lease } = admitted(await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d));
    await expect(releasePoolSlot(lease, tabB, authority)).rejects.toMatchObject({ code: 'lease-held-by-other' });
    await expect(releasePoolSlot('merge:a/b', tabA, authority)).rejects.toMatchObject({ code: 'pool-invalid' });
    expect(await releasePoolSlot(lease, tabA, authority)).toMatchObject({ name: lease });
    expect(await acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).toMatchObject({ lease });
  });

  it('a caller with no tab is refused: nothing could ever release its slot', async () => {
    const { acquirePoolSlot } = await service();
    await expect(acquirePoolSlot({ kind: 'gate' }, noTab, authority, await deps())).rejects.toMatchObject({ code: 'caller-unresolved' });
  });

  it('an unknown host keeps its leases and takes nothing new; work goes to this host', async () => {
    const { acquirePoolSlot, readPoolView } = await service();
    const d = await deps();
    expect(admitted(await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d)).host).toBe('host-b-lan');
    reads = [reads[0], { host: 'host-b-lan', local: false, state: 'unknown', readAt: now, via: null, reason: 'read failed', retryAt: now + 30_000 }];
    expect(admitted(await acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).host).toBe('host-a');
    const { findLease } = await import('@/lib/lease-store');
    expect(await findLease('pool:host-b-lan/gate-1', now)).not.toBeNull();
    const view = await readPoolView(d);
    expect(view.hosts[1]).toMatchObject({ state: 'unknown', metrics: null, budget: null, slots: { gate: { used: 1, cap: 0, free: 0 } } });
  });

  it('a remote gate names the gate-host container mapped from gate.remote-hosts (pool.gate-host.<host>)', async () => {
    const { acquirePoolSlot } = await service();
    config = { 'pool.mode': 'enforce', 'pool.gate-host.host-b-lan': 'gatehost-replica' };
    expect(await acquirePoolSlot({ kind: 'gate' }, tabA, authority, await deps())).toMatchObject({ host: 'host-b-lan', gateHost: 'gatehost-replica' });
    expect(await acquirePoolSlot({ kind: 'build' }, tabA, authority, await deps())).toMatchObject({ host: 'host-b-lan', gateHost: null });
  });

  it.each([
    [{ kind: 'review' }, 'kind must be gate, build, mutation, browser, test-service or tab'],
    [{ kind: 'gate', memGb: -1 }, 'memGb must be'],
    [{ kind: 'gate', memGb: '8' }, 'memGb must be'],
    [{ kind: 'gate', memGb: 2000 }, 'memGb must be'],
    [{ kind: 'gate', threads: 0 }, 'threads must be'],
    [{ kind: 'gate', threads: 2.5 }, 'threads must be'],
    [{ kind: 'gate', class: 'urgent' }, 'class must be'],
    [{ kind: 'gate', class: 'control-plane' }, 'kind tab only'],
    [{ kind: 'gate', panelType: 'claude-code' }, 'kind tab only'],
    [{ kind: 'tab', panelType: 'Claude Code' }, 'panelType must be'],
    [{ kind: 'tab', panelType: 'terminal' }, 'has no envelope'],
    [{ kind: 'gate', ticket: 'pool:host-b-lan/gate-1' }, 'ticket must be a pool queue ticket'],
  ])('%j is pool-invalid', async (input, message) => {
    const { acquirePoolSlot } = await service();
    await expect(acquirePoolSlot(input, tabA, authority, await deps())).rejects.toMatchObject({ code: 'pool-invalid', message: expect.stringContaining(message) });
  });
});

describe('the queue (vel-D4 AC 3, AC 4, AC 6)', () => {
  const fillAi = async (holder: ILeaseHolder) => {
    const { acquirePoolSlot } = await service();
    const d = await deps();
    const got: string[] = [];
    for (let i = 0; i < 6; i += 1) got.push(admitted(await acquirePoolSlot({ kind: 'gate' }, holder, authority, d)).lease);
    return got;
  };

  beforeEach(() => {
    reads = [{ ...md, state: 'unknown', readAt: null, reason: 'not read', retryAt: now }, aiRead()];
  });

  it('a request that fits nowhere queues with its ticket, position and figures, and is admitted when a slot frees', async () => {
    const { acquirePoolSlot, releasePoolSlot } = await service();
    const held = await fillAi(tabA);
    const d = await deps();
    const q = queued(await acquirePoolSlot({ kind: 'gate', queue: true }, tabB, authority, d));
    expect(q).toMatchObject({
      queued: true, ticket: 'pool-queue:gate-1', position: 1, of: 1, refusal: 'no-budget', retryAfterSeconds: 10, envelope: { threads: 8, memGb: 8 },
      reason: expect.stringMatching(/^queued: position 1 of 1; .*host-b-lan: budget threads 48\/48 used, needs 8/),
    });
    expect(warnings.filter((w) => w.includes('pool-queue:gate-1'))).toHaveLength(1);
    expect(queued(await acquirePoolSlot({ kind: 'gate', ticket: q.ticket }, tabB, authority, d)).position).toBe(1);
    expect(warnings.filter((w) => w.includes('pool-queue:gate-1'))).toHaveLength(1);
    await releasePoolSlot(held[2], tabA, authority);
    const got = admitted(await acquirePoolSlot({ kind: 'gate', ticket: q.ticket }, tabB, authority, d));
    expect(got).toMatchObject({ host: 'host-b-lan', lease: 'pool:host-b-lan/gate-3' });
    const { findLease } = await import('@/lib/lease-store');
    expect(await findLease(q.ticket, now)).toBeNull();
  });

  it('without --queue a request that fits nowhere is refused as before, with the figures', async () => {
    const { acquirePoolSlot } = await service();
    await fillAi(tabA);
    await expect(acquirePoolSlot({ kind: 'gate' }, tabB, authority, await deps())).rejects.toMatchObject({
      code: 'pool-full', refusal: 'no-budget', message: expect.stringContaining('budget threads 48/48 used, needs 8'),
    });
  });

  it('tickets are admitted in arrival order; a later ticket and a new request do not jump ahead', async () => {
    const { acquirePoolSlot, releasePoolSlot } = await service();
    const held = await fillAi(tabA);
    const d = await deps();
    const first = queued(await acquirePoolSlot({ kind: 'gate', queue: true }, tabB, authority, d));
    now += 1_000;
    const second = queued(await acquirePoolSlot({ kind: 'build', queue: true }, tabC, authority, d));
    expect(second).toMatchObject({ position: 2, of: 2 });
    await releasePoolSlot(held[0], tabA, authority);
    expect(queued(await acquirePoolSlot({ kind: 'build', ticket: second.ticket }, tabC, authority, d))).toMatchObject({ position: 2, refusal: 'queued-ahead' });
    await expect(acquirePoolSlot({ kind: 'gate' }, tabA, authority, d)).rejects.toMatchObject({ refusal: 'queued-ahead' });
    expect(admitted(await acquirePoolSlot({ kind: 'gate', ticket: first.ticket }, tabB, authority, d)).lease).toBe('pool:host-b-lan/gate-1');
    expect(queued(await acquirePoolSlot({ kind: 'build', ticket: second.ticket }, tabC, authority, d))).toMatchObject({ position: 1, of: 1, refusal: 'no-budget' });
  });

  it('a ticket is renewed at half its TTL, not on every re-ask; one with no re-ask in 120 s is gone', async () => {
    const { acquirePoolSlot } = await service();
    await fillAi(tabA);
    const d = await deps();
    const q = queued(await acquirePoolSlot({ kind: 'gate', queue: true }, tabB, authority, d));
    expect(q.expiresAt).toBe(new Date(now + 120_000).toISOString());
    now += 30_000;
    expect(queued(await acquirePoolSlot({ kind: 'gate', ticket: q.ticket }, tabB, authority, d)).expiresAt).toBe(q.expiresAt);
    now += 40_000;
    expect(queued(await acquirePoolSlot({ kind: 'gate', ticket: q.ticket }, tabB, authority, d)).expiresAt).toBe(new Date(now + 120_000).toISOString());
    await drainLeaseLocks();
    expect((await readAudit(mockHome.value)).filter((e) => e.name === q.ticket).map((e) => e.event)).toEqual(['lease-acquire', 'lease-renew']);
    now += 121_000;
    await expect(acquirePoolSlot({ kind: 'gate', ticket: q.ticket }, tabB, authority, d)).rejects.toMatchObject({ code: 'pool-ticket-gone' });
  });

  it('only its holder re-asks with a ticket, for the same kind; the holder may give it up', async () => {
    const { acquirePoolSlot, releasePoolSlot, readPoolView } = await service();
    await fillAi(tabA);
    const d = await deps();
    const q = queued(await acquirePoolSlot({ kind: 'gate', queue: true }, tabB, authority, d));
    await expect(acquirePoolSlot({ kind: 'gate', ticket: q.ticket }, tabC, authority, d)).rejects.toMatchObject({ code: 'pool-invalid', message: expect.stringContaining('another caller') });
    await expect(acquirePoolSlot({ kind: 'build', ticket: q.ticket }, tabB, authority, d)).rejects.toMatchObject({ code: 'pool-invalid' });
    expect((await readPoolView(d)).queue).toEqual([expect.objectContaining({ ticket: q.ticket, position: 1, holder: 'ws1/tab-b', hosts: ['host-b-lan'] })]);
    await releasePoolSlot(q.ticket, tabB, authority);
    expect((await readPoolView(d)).queue).toEqual([]);
  });

  it('a too-large request is refused even when it asks to queue', async () => {
    const { acquirePoolSlot } = await service();
    await expect(acquirePoolSlot({ kind: 'gate', memGb: 400, queue: true }, tabB, authority, await deps())).rejects.toMatchObject({ code: 'pool-full', refusal: 'too-large' });
  });
});

describe('tab starts (vel-D4 AC 3, design §4 input 3)', () => {
  it('a burst of 20 starts fills the budgets in the lease lock; the rest queue with distinct positions', async () => {
    const { startTabOnPool, releaseTabStart } = await service();
    tabs = new Map([['host-a', { worker: 10, controlPlane: 2 }], ['host-b-lan', { worker: 20, controlPlane: 0 }]]);
    const d = await deps();
    const holders = Array.from({ length: 20 }, (_, i) => tab(`tab-${i + 1}`));
    const started = await Promise.all(holders.map((h) => startTabOnPool({ panelType: 'claude-code' }, h, authority, d)));
    const ok = started.filter((s) => s.state === 'admitted');
    const waiting = started.flatMap((s) => (s.state === 'queued' ? [s.queued] : []));
    expect(ok.map((s) => (s.state === 'admitted' ? s.host : '')).sort()).toEqual(['host-a', 'host-a', 'host-b-lan', 'host-b-lan', 'host-b-lan', 'host-b-lan']);
    expect(waiting.map((q) => q.position).sort((a, b) => a - b)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    expect(waiting.every((q) => q.of >= q.position && q.reason.includes('budget threads'))).toBe(true);
    const freed = ok[0];
    const freedHolder = holders[started.indexOf(freed)];
    await releaseTabStart(freed.state === 'admitted' ? freed.lease : null, freedHolder, authority);
    const head = waiting.find((q) => q.position === 1)!;
    const headHolder = holders[started.findIndex((s) => s.state === 'queued' && s.queued.ticket === head.ticket)];
    expect(await startTabOnPool({ panelType: 'claude-code', ticket: head.ticket }, headHolder, authority, d)).toMatchObject({ state: 'admitted' });
  });

  it('a control-plane start from the workspace orchestrator is admitted here when every worker budget is full', async () => {
    const { startTabOnPool } = await service();
    tabs = new Map([['host-a', { worker: 12, controlPlane: 0 }], ['host-b-lan', { worker: 24, controlPlane: 0 }]]);
    const d = await deps();
    expect(await startTabOnPool({ panelType: 'claude-code' }, tabA, authority, d)).toMatchObject({ state: 'queued' });
    expect(await startTabOnPool({ panelType: 'claude-code', class: 'control-plane' }, tab('tab-o'), authority, d)).toMatchObject({
      state: 'admitted', host: 'host-a', local: true, lease: 'pool:host-a/tab-1', reason: expect.stringContaining('control-plane reserve'),
    });
  });

  it('a worker claiming control-plane is downgraded to product and queued like any worker; the answer says why (r1 F3)', async () => {
    const { startTabOnPool } = await service();
    tabs = new Map([['host-a', { worker: 12, controlPlane: 0 }], ['host-b-lan', { worker: 24, controlPlane: 0 }]]);
    const d = await deps();
    const got = await startTabOnPool({ panelType: 'claude-code', class: 'control-plane' }, tabA, authority, d);
    expect(got).toMatchObject({
      state: 'queued',
      queued: { class: 'product', downgrade: expect.stringContaining('only for the workspace\'s verified, enabled orchestrator tab; ws1/tab-a (tab-a) is not'), reason: expect.stringContaining('runs as product') },
    });
    const admin: ILeaseHolder = { workspaceId: null, tabId: null, tabName: null, verified: false, admin: true };
    expect(await startTabOnPool({ panelType: 'claude-code', class: 'control-plane' }, admin, authority, d)).toMatchObject({ state: 'queued', queued: { class: 'product' } });
    expect(await startTabOnPool({ panelType: 'claude-code', class: 'control-plane' }, noTab, authority, d)).toMatchObject({
      state: 'refused', reason: expect.stringContaining('runs as product'),
    });
  });

  it('an unverified session asserting the orchestrator tab\'s identity is downgraded (r2 N1)', async () => {
    const { acquirePoolSlot } = await service();
    const asserted: ILeaseHolder = { ...tab('tab-o'), verified: false, identity: 'session' };
    expect(await acquirePoolSlot({ kind: 'tab', class: 'control-plane' }, asserted, authority, await deps())).toMatchObject({
      class: 'product', downgrade: expect.stringContaining('ws1/tab-o (tab-o) unverified is not'),
    });
  });

  it('pool acquire downgrades the same claim; the orchestrator keeps it', async () => {
    const { acquirePoolSlot } = await service();
    const d = await deps();
    expect(await acquirePoolSlot({ kind: 'tab', class: 'control-plane' }, tabA, authority, d)).toMatchObject({ class: 'product', host: 'host-b-lan', downgrade: expect.stringContaining('runs as product') });
    const kept = await acquirePoolSlot({ kind: 'tab', class: 'control-plane' }, tab('tab-o'), authority, d);
    expect(kept).toMatchObject({ class: 'control-plane', host: 'host-a' });
    expect(kept).not.toHaveProperty('downgrade');
  });

  it('a non-agent tab is placed here with no lease; a caller with no tab is placed without a lease and cannot queue', async () => {
    const { startTabOnPool } = await service();
    const d = await deps();
    expect(await startTabOnPool({ panelType: 'terminal' }, tabA, authority, d)).toMatchObject({ state: 'admitted', host: 'host-a', lease: null, envelope: null });
    expect(await startTabOnPool({ panelType: 'claude-code' }, noTab, authority, d)).toMatchObject({ state: 'admitted', host: 'host-b-lan', lease: null });
    tabs = new Map([['host-a', { worker: 12, controlPlane: 0 }], ['host-b-lan', { worker: 24, controlPlane: 0 }]]);
    expect(await startTabOnPool({ panelType: 'claude-code' }, noTab, authority, d)).toMatchObject({
      state: 'refused', refusal: 'no-budget', reason: expect.stringContaining('a queued start needs a tab or the admin token'),
    });
  });

  it('a start too large for any host is refused, not queued', async () => {
    const { startTabOnPool } = await service();
    config = { 'pool.mode': 'enforce', 'pool.envelope.tab.threads': '64' };
    expect(await startTabOnPool({ panelType: 'claude-code' }, tabA, authority, await deps())).toMatchObject({ state: 'refused', refusal: 'too-large' });
  });
});

describe('shadow mode, the default (review r1 F1, F2, F7)', () => {
  it('admits what enforce refuses, logs one line with the figures, and counts it on the pool view', async () => {
    const { acquirePoolSlot, readPoolView, readPoolWouldRefuse } = await service();
    config = { 'pool.mode': 'enforce' };
    reads = [{ ...md, state: 'unknown', readAt: null, reason: 'not read', retryAt: now }, aiRead()];
    const d = await deps();
    for (let i = 0; i < 6; i += 1) await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d);
    await expect(acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).rejects.toMatchObject({ code: 'pool-full', refusal: 'no-budget' });
    config = {};
    const got = admitted(await acquirePoolSlot({ kind: 'gate' }, tabB, authority, d));
    expect(got).toMatchObject({ host: 'host-b-lan', wouldRefuse: { refusals: ['no-budget', 'overloaded'] }, reason: expect.stringContaining('shadow mode admitted') });
    const lines = warnings.filter((w) => w.startsWith('pool would-refuse (shadow, admitted):'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('host=host-b-lan kind=gate class=product refusals=no-budget,overloaded min_load=16 pending_threads=48 envelope_threads=8');
    expect(lines[0]).toContain('agent_tabs=worker:0,control-plane:0');
    const view = await readPoolView(d);
    expect(view.wouldRefuse).toMatchObject({ mode: 'shadow', total: 1, byHost: { 'host-b-lan': { total: 1, byRefusal: { 'no-budget': 1, overloaded: 1 } } }, last: { line: lines[0] } });
    expect(await readPoolWouldRefuse(d)).toMatchObject({ mode: 'shadow', total: 1 });
    config = { 'pool.mode': 'enforce' };
    expect((await readPoolView(d)).wouldRefuse).toMatchObject({ mode: 'enforce', total: 1 });
  });

  it('a fleet config that cannot be read reports the counter in shadow, the default', async () => {
    const { readPoolWouldRefuse } = await service();
    expect(await readPoolWouldRefuse({ config: async () => { throw new Error('unreadable'); } })).toMatchObject({ mode: 'shadow', total: 0, last: null });
  });
});

describe('tab starts the read cannot show yet (review r1 F6)', () => {
  it('a tab created since the read counts in the measured memory until the read can show it', async () => {
    const { placeOnPool } = await service();
    const { recordTabStart } = await import('@/lib/pool-runtime');
    reads = [{ ...md, state: 'unknown', readAt: null, reason: 'not read', retryAt: now }, aiRead({ memAvailableBytes: 250 * GIB })];
    const d = await deps();
    expect(await placeOnPool({ kind: 'gate', memGb: 0 }, d)).toMatchObject({ ok: true, host: 'host-b-lan' });
    recordTabStart('host-b-lan', { threads: 2, memGb: 240 }, now - 1_000);
    expect(await placeOnPool({ kind: 'gate', memGb: 0 }, d)).toMatchObject({ ok: false, refusal: 'no-memory', reason: expect.stringContaining('measured 10.0 GiB free') });
    now += 61_000;
    reads = [reads[0], aiRead({ memAvailableBytes: 250 * GIB })];
    expect(await placeOnPool({ kind: 'gate', memGb: 0 }, d)).toMatchObject({ ok: true, host: 'host-b-lan' });
  });
});

describe('tab placement (AC 3, AC 4)', () => {
  it('a claude-code tab goes to the most free memory; codex-cli and any role stay here; placement alone leases nothing', async () => {
    const { placeOnPool } = await service();
    const d = await deps();
    expect(await placeOnPool({ kind: 'tab', memGb: 0, panelType: 'claude-code' }, d)).toMatchObject({ ok: true, host: 'host-b-lan', local: false });
    expect(await placeOnPool({ kind: 'tab', memGb: 0, panelType: 'codex-cli' }, d)).toMatchObject({ ok: true, host: 'host-a', local: true });
    expect(await placeOnPool({ kind: 'tab', memGb: 0, panelType: 'claude-code', role: 'evaluator' }, d)).toMatchObject({ ok: true, host: 'host-a' });
    expect(await d.leases()).toEqual([]);
  });

  it('agent tabs on a host fill its budget', async () => {
    const { placeOnPool, readPoolView } = await service();
    tabs = new Map([['host-b-lan', { worker: 46, controlPlane: 0 }], ['host-a', { worker: 2, controlPlane: 1 }]]);
    const d = await deps();
    expect(await placeOnPool({ kind: 'tab', memGb: 0, panelType: 'claude-code' }, d)).toMatchObject({ host: 'host-a' });
    expect((await readPoolView(d)).hosts.map((h) => h.agentTabs)).toEqual([3, 46]);
  });
});

describe('the pool view (AC 7)', () => {
  it('totals threads, memory and kind counts over known hosts with per-host detail', async () => {
    const { acquirePoolSlot, readPoolView } = await service();
    await acquirePoolSlot({ kind: 'gate', memGb: 4 }, tabA, authority, await deps());
    const view = await readPoolView(await deps());
    expect(view.at).toBe('2026-11-03T07:00:00.000Z');
    expect(view.totals).toMatchObject({ threads: 96, memTotalBytes: 464 * GIB, memAvailableBytes: 290 * GIB, knownHosts: 2, unknownHosts: 0 });
    expect(view.totals.slots.gate).toEqual({ used: 1, cap: 9, free: 8 });
    expect(view.hosts.map((h) => [h.host, h.slots.gate.used])).toEqual([['host-a', 0], ['host-b-lan', 1]]);
    expect(view.hosts[1].budget).toMatchObject({ workerThreads: 48, used: { product: { threads: 8, memBytes: 8 * GIB } } });
  });
});

describe('readPoolPaths (vel-RETRO-R2)', () => {
  const path = (rttMs: number, kind: 'relayed' | 'direct' | 'unknown') => ({
    kind, alias: 'exec-1', address: 'exec-1.tailnet.example', ip: 'fd7a:115c:a1e0::2', peer: 'exec-1', region: kind === 'relayed' ? 'sin' : null,
    rttMs, measuredAt: Date.parse('2026-11-09T05:00:00Z'), reason: kind === 'unknown' ? 'timeout waiting for ping reply' : null,
    relayedReads: kind === 'relayed' ? 2 : 0,
  });
  const remote = (host: string, p: ReturnType<typeof path> | null): TPoolHostRead => ({
    host, local: false, state: 'known', readAt: 1, via: host, metrics: metrics({}), ...(p ? { path: p } : {}),
  });
  const local: TPoolHostRead = { host: 'control-host', local: true, state: 'known', readAt: 1, via: null, metrics: metrics({}) };

  it('serves every remote host with its path and the alert line, and never this host', async () => {
    const { readPoolPaths } = await service();
    const paths = await readPoolPaths({
      reads: async () => [local, remote('exec-1', path(1170, 'relayed')), remote('exec-2', path(300, 'direct')), remote('host-b-lan', null)],
      config: async () => () => null,
    });
    expect(paths.map((p) => [p.host, p.path?.alert ?? null, p.text])).toEqual([
      ['exec-1', 'tailnet-relayed', 'exec-1 tailnet path relayed via DERP(sin), RTT 1170 ms'],
      ['exec-2', 'tailnet-slow', 'exec-2 tailnet path slow: RTT 300 ms (threshold 250 ms)'],
      ['host-b-lan', null, null],
    ]);
  });

  it('judges slowness by the default threshold when the fleet config cannot be read', async () => {
    const { readPoolPaths } = await service();
    const paths = await readPoolPaths({
      reads: async () => [remote('exec-2', path(300, 'direct'))],
      config: async () => { throw new Error('unreadable'); },
    });
    expect(paths[0].path).toMatchObject({ alert: 'tailnet-slow', slowMs: 250 });
  });
});

describe('the ask token and the host pin (vel-POOL-ENF)', () => {
  const T = '0123456789abcdef0123456789abcdef';
  const U = 'fedcba9876543210fedcba9876543210';
  const pinCtl = { hosts: ['control-host'] };
  // Neutral host names in this block (the repository is public): the file's two reads, renamed.
  const ctlRead = (over: Partial<IPoolMetrics> = {}): TPoolHostRead => ({ ...md, host: 'control-host', readAt: now, metrics: metrics(over) });
  const workerRead = (over: Partial<IPoolMetrics> = {}): TPoolHostRead => ({ ...aiRead(over), host: 'worker-host', via: 'worker-host' });
  beforeEach(() => {
    reads = [ctlRead(), workerRead()];
  });

  it('the slot note carries the token, and the admission echoes the token and the normalized pin', async () => {
    const { acquirePoolSlot } = await service();
    const got = admitted(await acquirePoolSlot({ kind: 'gate', ask: T, pin: { hosts: ['CONTROL-HOST', 'control-host'] } }, tabA, authority, await deps()));
    expect(got).toMatchObject({ host: 'control-host', lease: 'pool:control-host/gate-1', ask: T, pin: { hosts: ['control-host'], local: false, gateHosts: [] } });
    const { findLease } = await import('@/lib/lease-store');
    expect((await findLease(got.lease, now))?.note).toBe(`pool mem=8 threads=8 class=product ask=${T}`);
  });

  it('lease first: the cancel releases the late slot and marks the token in one transaction', async () => {
    const { acquirePoolSlot, cancelPoolAsk } = await service();
    const { lease } = admitted(await acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps()));
    const other = admitted(await acquirePoolSlot({ kind: 'gate', ask: U }, tabA, authority, await deps()));
    expect(await cancelPoolAsk(T, tabA, authority)).toEqual({ released: [lease], cancelled: T });
    const { findLease } = await import('@/lib/lease-store');
    expect(await findLease(lease, now)).toBeNull();
    expect(await findLease(other.lease, now)).not.toBeNull();
    expect((await (await import('@/lib/lease-store')).listLeases('pool-cancel:', now))[0]).toMatchObject({ kind: 'pool-cancel', ttlSeconds: 600, note: 'pool-cancel', holder: { tabId: 'tab-a' } });
  });

  it('mark first: an acquire that lands after its cancel is refused pool-ask-cancelled and writes nothing', async () => {
    const { acquirePoolSlot, cancelPoolAsk } = await service();
    expect(await cancelPoolAsk(T, tabA, authority)).toEqual({ released: [], cancelled: T });
    await expect(acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps())).rejects.toMatchObject({ code: 'pool-ask-cancelled' });
    const { listLeases } = await import('@/lib/lease-store');
    expect((await listLeases('pool:', now)).map((l) => l.name)).toEqual([]);
    now += 601_000;
    expect(admitted(await acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps())).lease).toBe('pool:worker-host/gate-1');
  });

  it('the cancel releases a waiting ticket that carries the token; a second cancel renews the mark', async () => {
    const { acquirePoolSlot, cancelPoolAsk } = await service();
    config = { 'pool.mode': 'enforce', 'pool.slots.worker-host.gate': '0', 'pool.slots.control-host.gate': '0' };
    const q = queued(await acquirePoolSlot({ kind: 'gate', ask: T, queue: true, pin: pinCtl }, tabA, authority, await deps()));
    const { findLease } = await import('@/lib/lease-store');
    expect((await findLease(q.ticket, now))?.note).toBe(`pool-queue class=product mem=0 pin-hosts=control-host ask=${T}`);
    expect(await cancelPoolAsk(T, tabA, authority)).toEqual({ released: [q.ticket], cancelled: T });
    now += 300_000;
    await cancelPoolAsk(T, tabA, authority);
    expect(((await (await import('@/lib/lease-store')).listLeases('pool-cancel:', now))[0])?.expiresAt).toBe(new Date(now + 600_000).toISOString());
  });

  it('a re-asked ticket keeps its pin, and its slot carries the token', async () => {
    const { acquirePoolSlot, releasePoolSlot } = await service();
    config = { 'pool.mode': 'enforce', 'pool.slots.control-host.gate': '1' };
    const first = admitted(await acquirePoolSlot({ kind: 'gate', pin: pinCtl }, tabB, authority, await deps()));
    const q = queued(await acquirePoolSlot({ kind: 'gate', ask: T, queue: true, pin: pinCtl }, tabA, authority, await deps()));
    await releasePoolSlot(first.lease, tabB, authority);
    const got = admitted(await acquirePoolSlot({ kind: 'gate', ask: T, ticket: q.ticket }, tabA, authority, await deps()));
    expect(got).toMatchObject({ host: 'control-host', ask: T, pin: { hosts: ['control-host'], local: false, gateHosts: [] } });
  });

  it('a release by name with a token releases only the lease that carries it', async () => {
    const { acquirePoolSlot, releasePoolSlot } = await service();
    const { lease } = admitted(await acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps()));
    await expect(releasePoolSlot(lease, tabA, authority, U)).rejects.toMatchObject({ code: 'pool-ask-mismatch' });
    const { findLease } = await import('@/lib/lease-store');
    expect(await findLease(lease, now)).not.toBeNull();
    expect(await releasePoolSlot(lease, tabA, authority, T)).toMatchObject({ name: lease });
    const plain = admitted(await acquirePoolSlot({ kind: 'gate' }, tabA, authority, await deps()));
    await expect(releasePoolSlot(plain.lease, tabA, authority, T)).rejects.toMatchObject({ code: 'pool-ask-mismatch' });
    await expect(releasePoolSlot(plain.lease, tabB, authority, T)).rejects.toMatchObject({ code: 'lease-held-by-other' });
  });

  it('another holder\'s live token is refused pool-invalid', async () => {
    const { acquirePoolSlot } = await service();
    await acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps());
    await expect(acquirePoolSlot({ kind: 'gate', ask: T }, tabB, authority, await deps())).rejects.toMatchObject({ code: 'pool-invalid', message: expect.stringContaining('another caller') });
  });

  it('the cancel mark holds no budget: the view counts no slot for it', async () => {
    const { cancelPoolAsk, readPoolView } = await service();
    await cancelPoolAsk(T, tabA, authority);
    const { listLeases } = await import('@/lib/lease-store');
    const d = { ...(await deps()), leases: async () => listLeases(undefined, now) };
    const view = await readPoolView(d);
    expect(view.totals.slots.gate.used).toBe(0);
    expect(view.features).toEqual(['ask-token', 'host-pin']);
  });

  it('a pin that matches no pool host is pool-no-pinned-host; pinned hosts that are full are pool-full', async () => {
    const { acquirePoolSlot } = await service();
    config = { 'pool.mode': 'enforce', 'pool.gate-host.worker-host': 'gate-host-b', 'pool.slots.control-host.gate': '0' };
    await expect(acquirePoolSlot({ kind: 'gate', pin: { gateHosts: ['hosta'] } }, tabA, authority, await deps()))
      .rejects.toMatchObject({ code: 'pool-no-pinned-host', refusal: 'no-pinned-host', message: expect.stringContaining('worker-host (gate host gate-host-b)') });
    await expect(acquirePoolSlot({ kind: 'gate', pin: { gateHosts: ['hosta'] }, queue: true }, tabA, authority, await deps()))
      .rejects.toMatchObject({ code: 'pool-no-pinned-host' });
    await expect(acquirePoolSlot({ kind: 'gate', pin: pinCtl }, tabA, authority, await deps())).rejects.toMatchObject({ code: 'pool-full', refusal: 'no-free-slot' });
    expect(await acquirePoolSlot({ kind: 'gate', pin: { gateHosts: ['gate-host-b'] } }, tabA, authority, await deps()))
      .toMatchObject({ host: 'worker-host', gateHost: 'gate-host-b', pin: { hosts: [], local: false, gateHosts: ['gate-host-b'] } });
  });

  it('a gate pinned by gate host and admitted on the LOCAL host gets that host\'s gate host back; unpinned keeps the rule', async () => {
    const { acquirePoolSlot } = await service();
    config = { 'pool.mode': 'enforce', 'pool.gate-host.control-host': 'gate-host-a', 'pool.gate-host.worker-host': 'gate-host-b' };
    reads = [ctlRead({ load1: 0, load5: 0 }), workerRead()];
    expect(await acquirePoolSlot({ kind: 'gate', pin: { gateHosts: ['gate-host-a'] } }, tabA, authority, await deps()))
      .toMatchObject({ host: 'control-host', local: true, gateHost: 'gate-host-a' });
    expect(await acquirePoolSlot({ kind: 'gate', pin: { hosts: ['control-host'] } }, tabA, authority, await deps()))
      .toMatchObject({ host: 'control-host', local: true, gateHost: null });
    expect(await acquirePoolSlot({ kind: 'build', pin: { gateHosts: ['gate-host-a'] } }, tabA, authority, await deps()))
      .toMatchObject({ host: 'control-host', gateHost: 'gate-host-a' });
  });

  it.each([
    [{ kind: 'gate', ask: 'short' }, 'ask must match'],
    [{ kind: 'gate', ask: T.toUpperCase() }, 'ask must match'],
    [{ kind: 'gate', ask: `${T} x` }, 'ask must match'],
    [{ kind: 'gate', ask: 42 }, 'ask must match'],
    [{ kind: 'gate', pin: {} }, 'pin must name'],
    [{ kind: 'gate', pin: { hosts: [], local: false, gateHosts: [] } }, 'pin must name'],
    [{ kind: 'gate', pin: { hosts: ['bad host'] } }, 'pin.hosts'],
    [{ kind: 'gate', pin: { hosts: Array.from({ length: 17 }, (_, i) => `h${i}`) } }, 'at most 16'],
    [{ kind: 'gate', pin: { gateHosts: ['-x'] } }, 'pin.gateHosts'],
    [{ kind: 'gate', pin: { local: 'yes' } }, 'pin.local'],
    [{ kind: 'gate', pin: ['control-host'] }, 'pin must be an object'],
  ])('%j is pool-invalid', async (input, message) => {
    const { acquirePoolSlot } = await service();
    await expect(acquirePoolSlot(input as never, tabA, authority, await deps())).rejects.toMatchObject({ code: 'pool-invalid', message: expect.stringContaining(message) });
  });

  it('a bad token is refused on a cancel and on a release, before the store is touched', async () => {
    const { cancelPoolAsk, releasePoolSlot } = await service();
    await expect(cancelPoolAsk('nope', tabA, authority)).rejects.toMatchObject({ code: 'pool-invalid' });
    await expect(releasePoolSlot('pool:worker-host/gate-1', tabA, authority, 'nope')).rejects.toMatchObject({ code: 'pool-invalid' });
  });
});

describe('the ask token is the asker\'s alone (vel-POOL-ENF r2, review r1 of #64)', () => {
  const T = '0123456789abcdef0123456789abcdef';
  const U = 'fedcba9876543210fedcba9876543210';
  // Neutral host names in this block (the repository is public).
  beforeEach(() => {
    reads = [{ ...md, host: 'control-host', readAt: now, metrics: metrics({}) }, { ...aiRead(), host: 'worker-host', via: 'worker-host' }];
  });

  it('a cancel logs a short prefix of the token, never the token', async () => {
    const { acquirePoolSlot, cancelPoolAsk } = await service();
    admitted(await acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps()));
    expect((await cancelPoolAsk(T, tabA, authority)).released).toHaveLength(1);
    expect(warnings.filter((w) => w.includes('cancelled'))).toEqual([expect.stringContaining('ask 01234567...')]);
    expect(warnings.join('\n')).not.toContain(T);
  });

  it('another tab\'s cancel with a copied token neither refuses the asker\'s acquire nor blocks its own cancel', async () => {
    const { acquirePoolSlot, cancelPoolAsk } = await service();
    const { findLease } = await import('@/lib/lease-store');
    expect(await cancelPoolAsk(T, tabB, authority)).toEqual({ released: [], cancelled: T });
    const got = admitted(await acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps()));
    expect(await cancelPoolAsk(T, tabA, authority)).toEqual({ released: [got.lease], cancelled: T });
    expect(await findLease(got.lease, now)).toBeNull();
    // Each holder's mark refuses only that holder's own late ask.
    await expect(acquirePoolSlot({ kind: 'gate', ask: T }, tabB, authority, await deps())).rejects.toMatchObject({ code: 'pool-ask-cancelled' });
    await expect(acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps())).rejects.toMatchObject({ code: 'pool-ask-cancelled' });
  });

  it('no lease name or lease view carries the token in full', async () => {
    const { acquirePoolSlot, cancelPoolAsk } = await service();
    const { listLeases, toLeaseView } = await import('@/lib/lease-store');
    const got = admitted(await acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps()));
    await cancelPoolAsk(U, tabA, authority);
    const all = await listLeases(undefined, now);
    expect(all.map((l) => l.name).join(' ')).not.toContain(U);
    expect(all.filter((l) => l.kind === 'pool-cancel').map((l) => l.name)).toEqual([expect.stringMatching(/^pool-cancel:[0-9a-f]{32}$/)]);
    const facts = { now, liveTabIds: new Set<string>(), agentInactive: () => false, workspaceName: () => null };
    const slot = all.find((l) => l.name === got.lease)!;
    expect(toLeaseView(slot, facts).note).toBe('pool mem=8 threads=8 class=product ask=01234567...');
    expect(JSON.stringify(all.map((l) => toLeaseView(l, facts)))).not.toContain(T);
  });

  it('a release with another token names neither token in full', async () => {
    const { acquirePoolSlot, releasePoolSlot } = await service();
    const got = admitted(await acquirePoolSlot({ kind: 'gate', ask: T }, tabA, authority, await deps()));
    const err = await releasePoolSlot(got.lease, tabA, authority, U).catch((e: unknown) => e as Error);
    expect(err).toMatchObject({ code: 'pool-ask-mismatch' });
    expect((err as Error).message).toContain('01234567...');
    expect((err as Error).message).not.toContain(T);
    expect((err as Error).message).not.toContain(U);
  });

  it('a pin too long for a queue note is refused before anything is written', async () => {
    const { acquirePoolSlot } = await service();
    const hosts = Array.from({ length: 16 }, (_, i) => `h${i}-${'x'.repeat(40)}`);
    await expect(acquirePoolSlot({ kind: 'gate', ask: T, pin: { hosts } }, tabA, authority, await deps()))
      .rejects.toMatchObject({ code: 'pool-invalid', message: expect.stringContaining('at most 500') });
  });
});
