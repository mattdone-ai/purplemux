import fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILeaseHolder } from '@/types/lease';
import type { IPoolMetrics, TPoolHostRead } from '@/types/pool';
import { drainLeaseLocks, makeHome, readAudit, resetLeaseGlobals } from './lease-test-home';

// ADR-0039 §2: pool slots on the ADR-0011 lease store, in a temporary HOME.
// The hosts are fakes: nothing here is placed on ai-server.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const GIB = 1024 ** 3;
const tabA: ILeaseHolder = { workspaceId: 'ws1', tabId: 'tab-a', tabName: 'A', verified: true, admin: false };
const tabB: ILeaseHolder = { workspaceId: 'ws1', tabId: 'tab-b', tabName: 'B', verified: true, admin: false };
const noTab: ILeaseHolder = { workspaceId: 'ws1', tabId: null, tabName: null, verified: false, admin: false };

let now = Date.parse('2026-11-03T07:00:00Z');
const authority = { now: () => now, isWorkspaceOrchestrator: async () => false };

const metrics = (over: Partial<IPoolMetrics>): IPoolMetrics => ({
  threads: 32, load1: 16, load5: 16, memTotalBytes: 91 * GIB, memAvailableBytes: 40 * GIB,
  disks: [{ path: '/', usedPct: 50, freeBytes: 1 }], gpus: null, sccacheSweep: null, ...over,
});

let reads: TPoolHostRead[];
let config: Record<string, string>;
let tabs: Map<string, number>;

const service = () => import('@/lib/pool-service');
const deps = async () => {
  const { listLeases } = await import('@/lib/lease-store');
  return {
    reads: async () => reads,
    config: async () => (key: string) => config[key] ?? null,
    agentTabs: async () => tabs,
    leases: () => listLeases('pool:', now),
    now: () => now,
  };
};

beforeEach(async () => {
  vi.resetModules();
  resetLeaseGlobals();
  mockHome.value = await makeHome();
  now = Date.parse('2026-11-03T07:00:00Z');
  reads = [
    { host: 'mdserver1', local: true, state: 'known', readAt: now, via: null, metrics: metrics({ load1: 32 }) },
    { host: 'ai-lan', local: false, state: 'known', readAt: now, via: 'ai-lan', metrics: metrics({ threads: 64, load1: 16, memTotalBytes: 373 * GIB, memAvailableBytes: 250 * GIB }) },
  ];
  config = {};
  tabs = new Map();
});

afterEach(async () => {
  await drainLeaseLocks();
  resetLeaseGlobals();
  await fs.rm(mockHome.value, { recursive: true, force: true });
});

describe('pool acquire / release (AC 2)', () => {
  it('returns {host, slot, lease}; the lease is a pool lease held by the caller with its TTL and memory', async () => {
    const { acquirePoolSlot } = await service();
    const got = await acquirePoolSlot({ kind: 'gate', memGb: 8, ttlSeconds: 2700 }, tabA, authority, await deps());
    expect(got).toEqual({
      host: 'ai-lan', local: false, slot: 'gate-1', lease: 'pool:ai-lan/gate-1',
      expiresAt: new Date(now + 2700_000).toISOString(), reason: expect.stringContaining('lowest load per thread'), gateHost: null,
    });
    const { findLease } = await import('@/lib/lease-store');
    expect(await findLease('pool:ai-lan/gate-1', now)).toMatchObject({ kind: 'pool', holder: { tabId: 'tab-a' }, note: 'pool mem=8', ttlSeconds: 2700, survivesTab: false });
    await drainLeaseLocks();
    expect((await readAudit(mockHome.value)).map((e) => e.event)).toEqual(['lease-acquire']);
  });

  it('the default TTL is 60 minutes; more than 24 h is refused', async () => {
    const { acquirePoolSlot } = await service();
    expect((await acquirePoolSlot({ kind: 'build' }, tabA, authority, await deps())).expiresAt).toBe(new Date(now + 3600_000).toISOString());
    await expect(acquirePoolSlot({ kind: 'build', ttlSeconds: 25 * 3600 }, tabA, authority, await deps())).rejects.toMatchObject({ code: 'lease-policy' });
  });

  it('two acquires take two slots, never one; the lowest free number first', async () => {
    const { acquirePoolSlot } = await service();
    const d = await deps();
    const [a, b] = await Promise.all([
      acquirePoolSlot({ kind: 'gate' }, tabA, authority, d),
      acquirePoolSlot({ kind: 'gate' }, tabB, authority, d),
    ]);
    expect(new Set([a.lease, b.lease])).toEqual(new Set(['pool:ai-lan/gate-1', 'pool:ai-lan/gate-2']));
  });

  it('a held slot counts; when every slot is held the answer is pool-full with the counts', async () => {
    const { acquirePoolSlot } = await service();
    config = { 'pool.slots.ai-lan.gate': '1', 'pool.slots.mdserver1.gate': '1' };
    const d = await deps();
    expect((await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d)).host).toBe('ai-lan');
    expect((await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d)).host).toBe('mdserver1');
    await expect(acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).rejects.toMatchObject({
      code: 'pool-full', refusal: 'no-free-slot', message: expect.stringContaining('mdserver1 1/1, ai-lan 1/1'),
    });
  });

  it('an expired lease frees its slot', async () => {
    const { acquirePoolSlot } = await service();
    config = { 'pool.slots.ai-lan.gate': '1', 'pool.slots.mdserver1.gate': '0' };
    const d = await deps();
    await acquirePoolSlot({ kind: 'gate', ttlSeconds: 60 }, tabA, authority, d);
    await expect(acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).rejects.toMatchObject({ code: 'pool-full' });
    now += 61_000;
    reads = reads.map((r) => ({ ...r, readAt: now }));
    expect(await acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).toMatchObject({ lease: 'pool:ai-lan/gate-1' });
  });

  it('release frees the slot for the next caller; only the holder releases; a non-pool name is refused', async () => {
    const { acquirePoolSlot, releasePoolSlot } = await service();
    config = { 'pool.slots.ai-lan.gate': '1', 'pool.slots.mdserver1.gate': '0' };
    const d = await deps();
    const { lease } = await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d);
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
    expect((await acquirePoolSlot({ kind: 'gate' }, tabA, authority, d)).host).toBe('ai-lan');
    reads = [reads[0], { host: 'ai-lan', local: false, state: 'unknown', readAt: now, via: null, reason: 'read failed', retryAt: now + 30_000 }];
    expect((await acquirePoolSlot({ kind: 'gate' }, tabB, authority, d)).host).toBe('mdserver1');
    const { findLease } = await import('@/lib/lease-store');
    expect(await findLease('pool:ai-lan/gate-1', now)).not.toBeNull();
    const view = await readPoolView(d);
    expect(view.hosts[1]).toMatchObject({ state: 'unknown', metrics: null, slots: { gate: { used: 1, cap: 0, free: 0 } } });
  });

  it('a remote gate names the gate-host container mapped from gate.remote-hosts (pool.gate-host.<host>)', async () => {
    const { acquirePoolSlot } = await service();
    config = { 'pool.gate-host.ai-lan': 'gatehost-replica' };
    expect(await acquirePoolSlot({ kind: 'gate' }, tabA, authority, await deps())).toMatchObject({ host: 'ai-lan', gateHost: 'gatehost-replica' });
    expect(await acquirePoolSlot({ kind: 'build' }, tabA, authority, await deps())).toMatchObject({ host: 'ai-lan', gateHost: null });
  });

  it.each([
    [{ kind: 'review' }, 'kind must be gate, build or tab'],
    [{ kind: 'gate', memGb: -1 }, 'memGb must be'],
    [{ kind: 'gate', memGb: '8' }, 'memGb must be'],
    [{ kind: 'gate', memGb: 2000 }, 'memGb must be'],
    [{ kind: 'gate', panelType: 'claude-code' }, 'kind tab only'],
    [{ kind: 'tab', panelType: 'Claude Code' }, 'panelType must be'],
  ])('%j is pool-invalid', async (input, message) => {
    const { acquirePoolSlot } = await service();
    await expect(acquirePoolSlot(input, tabA, authority, await deps())).rejects.toMatchObject({ code: 'pool-invalid', message: expect.stringContaining(message) });
  });
});

describe('tab placement (AC 3, AC 4)', () => {
  it('a claude-code tab goes to the most free memory; codex-cli and any role stay here; nothing is leased', async () => {
    const { placeOnPool } = await service();
    const d = await deps();
    expect(await placeOnPool({ kind: 'tab', memGb: 0, panelType: 'claude-code' }, d)).toMatchObject({ ok: true, host: 'ai-lan', local: false });
    expect(await placeOnPool({ kind: 'tab', memGb: 0, panelType: 'codex-cli' }, d)).toMatchObject({ ok: true, host: 'mdserver1', local: true });
    expect(await placeOnPool({ kind: 'tab', memGb: 0, panelType: 'claude-code', role: 'evaluator' }, d)).toMatchObject({ ok: true, host: 'mdserver1' });
    expect(await d.leases()).toEqual([]);
  });

  it('agent tabs on a host fill its tab slots', async () => {
    const { placeOnPool, readPoolView } = await service();
    tabs = new Map([['ai-lan', 46], ['mdserver1', 3]]);
    const d = await deps();
    expect(await placeOnPool({ kind: 'tab', memGb: 0, panelType: 'claude-code' }, d)).toMatchObject({ host: 'mdserver1' });
    expect((await readPoolView(d)).hosts.map((h) => h.agentTabs)).toEqual([3, 46]);
  });
});

describe('the pool view (AC 7)', () => {
  it('totals threads, memory and slots over known hosts with per-host detail', async () => {
    const { acquirePoolSlot, readPoolView } = await service();
    await acquirePoolSlot({ kind: 'gate', memGb: 4 }, tabA, authority, await deps());
    const view = await readPoolView(await deps());
    expect(view.at).toBe('2026-11-03T07:00:00.000Z');
    expect(view.totals).toMatchObject({ threads: 96, memTotalBytes: 464 * GIB, memAvailableBytes: 290 * GIB, knownHosts: 2, unknownHosts: 0 });
    expect(view.totals.slots.gate).toEqual({ used: 1, cap: 12, free: 11 });
    expect(view.hosts.map((h) => [h.host, h.slots.gate.used])).toEqual([['mdserver1', 0], ['ai-lan', 1]]);
  });
});
