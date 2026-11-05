import { describe, expect, it } from 'vitest';
import {
  buildPoolView, freeSlotNumber, hostState, memOfLease, parsePoolLeaseName, placeWork, poolLeaseName, poolLeaseNote,
  slotCapOf, tabLocalOnly, type TConfigValue,
} from '@/lib/pool';
import type { ILease } from '@/types/lease';
import type { IPoolMetrics, IPoolPlacementRequest, TPoolHostRead } from '@/types/pool';

// ADR-0039 §2-§3: the pool model and its placement, table-driven. No test
// here places work anywhere: hosts are fakes.

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-03T07:00:00Z');

const metrics = (over: Partial<IPoolMetrics> = {}): IPoolMetrics => ({
  threads: 32, load1: 16, load5: 16, memTotalBytes: 91 * GIB, memAvailableBytes: 40 * GIB,
  disks: [{ path: '/', usedPct: 50, freeBytes: 500 * GIB }], gpus: null, sccacheSweep: null, ...over,
});

const known = (host: string, local: boolean, m: Partial<IPoolMetrics> = {}, readAt = NOW): TPoolHostRead =>
  ({ host, local, state: 'known', readAt, via: local ? null : host, metrics: metrics(m) });

const unknown = (host: string, local = false): TPoolHostRead =>
  ({ host, local, state: 'unknown', readAt: null, via: null, reason: 'read failed (ai-lan: timed out)', retryAt: NOW + 30_000 });

const lease = (name: string, acquiredAt = NOW - 10 * 60_000, memGb = 0): ILease => ({
  name, kind: 'pool', resource: name.slice(5),
  holder: { workspaceId: 'ws-a', tabId: 'tab-a', tabName: null, verified: true, identity: 'launch', admin: false },
  epic: null, note: memGb ? poolLeaseNote(memGb) : null, acquiredAt: new Date(acquiredAt).toISOString(),
  renewedAt: new Date(acquiredAt).toISOString(), ttlSeconds: 3600, expiresAt: new Date(NOW + 3_600_000).toISOString(), survivesTab: false,
});

const noConfig: TConfigValue = () => null;

const states = (reads: TPoolHostRead[], leases: ILease[] = [], tabs: Record<string, number> = {}, config: TConfigValue = noConfig) =>
  reads.map((r) => hostState(r, leases, tabs[r.host] ?? 0, config));

const place = (reads: TPoolHostRead[], req: IPoolPlacementRequest, leases: ILease[] = [], tabs: Record<string, number> = {}, config: TConfigValue = noConfig) =>
  placeWork(states(reads, leases, tabs, config), req);

describe('slot lease names', () => {
  it('round-trips host, kind and number; the host is lower-cased', () => {
    expect(poolLeaseName('AI-lan', 'gate', 3)).toBe('pool:ai-lan/gate-3');
    expect(parsePoolLeaseName('pool:ai-lan/gate-3')).toEqual({ host: 'ai-lan', kind: 'gate', n: 3 });
    expect(parsePoolLeaseName('pool:ai-lan/review-3')).toBeNull();
    expect(parsePoolLeaseName('merge:a/b')).toBeNull();
  });

  it('a lease note carries its memory; no note is no memory', () => {
    expect(memOfLease(lease('pool:x/gate-1', NOW, 12))).toBe(12 * GIB);
    expect(memOfLease(lease('pool:x/gate-1'))).toBe(0);
  });
});

describe('the read model (AC 1, AC 7)', () => {
  it('a known host shows threads, load, memory, disk, GPU and slots in use; an unknown host shows no metrics, never zero', () => {
    const gpu = [{ index: 0, name: 'RTX 4090', utilPct: 64, memUsedMiB: 23189, memTotalMiB: 24564 }];
    const view = buildPoolView(states(
      [known('mdserver1', true), known('ai-lan', false, { threads: 64, load1: 32, memTotalBytes: 373 * GIB, memAvailableBytes: 250 * GIB, gpus: gpu }), unknown('third')],
      [lease('pool:ai-lan/gate-1'), lease('pool:ai-lan/build-2'), lease('pool:mdserver1/tab-1')],
      { mdserver1: 5, 'ai-lan': 1 },
    ), NOW);
    const [md, ai, third] = view.hosts;
    expect(md).toMatchObject({ host: 'mdserver1', local: true, state: 'known', loadPerThread: 0.5, agentTabs: 5 });
    expect(md.slots).toEqual({ gate: { used: 0, cap: 4, free: 4 }, build: { used: 0, cap: 4, free: 4 }, tab: { used: 6, cap: 11, free: 5 } });
    expect(ai).toMatchObject({ host: 'ai-lan', local: false, state: 'known', loadPerThread: 0.5 });
    expect(ai.metrics?.gpus).toEqual(gpu);
    expect(ai.slots.gate).toEqual({ used: 1, cap: 8, free: 7 });
    expect(ai.slots.build).toEqual({ used: 1, cap: 8, free: 7 });
    expect(third).toMatchObject({ state: 'unknown', metrics: null, loadPerThread: null, reason: expect.stringContaining('timed out') });
    expect(view.totals).toMatchObject({ threads: 96, memTotalBytes: 464 * GIB, knownHosts: 2, unknownHosts: 1 });
    expect(view.totals.slots.gate).toEqual({ used: 1, cap: 12, free: 11 });
  });

  it.each([
    ['a fleet value replaces the default', '6', 6],
    ['0 closes the kind on the host', '0', 0],
    ['a value over 64 keeps the default', '65', 8],
    ['text keeps the default', 'many', 8],
  ])('slot caps: %s', (_name, value, cap) => {
    const config: TConfigValue = (key) => (key === 'pool.slots.ai-lan.gate' ? value : null);
    expect(slotCapOf('ai-lan', 'gate', known('ai-lan', false, { threads: 64 }), config)).toBe(cap);
  });

  it('an unknown host has no default cap', () => {
    expect(slotCapOf('ai-lan', 'gate', unknown('ai-lan'), noConfig)).toBe(0);
  });

  it('the lowest free slot number is taken', () => {
    const [s] = states([known('ai-lan', false)], [lease('pool:ai-lan/gate-1'), lease('pool:ai-lan/gate-3')]);
    expect(freeSlotNumber(s, 'gate')).toBe(2);
    expect(freeSlotNumber(s, 'build')).toBe(1);
  });
});

const viaFallback = (m: Partial<IPoolMetrics> = {}): TPoolHostRead => ({
  host: 'ai-lan', local: false, state: 'known', readAt: NOW, via: 'ai-server', primaryFailure: 'ai-lan: exit 255: Permission denied (publickey).',
  metrics: metrics({ threads: 64, memTotalBytes: 373 * GIB, memAvailableBytes: 300 * GIB, load1: 1, ...m }),
});
const md = (m: Partial<IPoolMetrics> = {}) => known('mdserver1', true, m);
const ai = (m: Partial<IPoolMetrics> = {}) => known('ai-lan', false, { threads: 64, memTotalBytes: 373 * GIB, ...m });

describe('placement (AC 3)', () => {
  it.each<[string, TPoolHostRead[], IPoolPlacementRequest, string | null]>([
    ['gate: the lower load per thread wins', [md({ load1: 32 }), ai({ load1: 32 })], { kind: 'gate', memGb: 8 }, 'ai-lan'],
    ['gate: load before memory', [md({ load1: 8, memAvailableBytes: 20 * GIB }), ai({ load1: 48, memAvailableBytes: 300 * GIB })], { kind: 'gate', memGb: 8 }, 'mdserver1'],
    ['gate: equal load, more memory wins', [md({ load1: 16, memAvailableBytes: 20 * GIB }), ai({ load1: 32, memAvailableBytes: 300 * GIB })], { kind: 'gate', memGb: 8 }, 'ai-lan'],
    ['gate: a full tie keeps this host', [md({ load1: 16 }), ai({ load1: 32, memAvailableBytes: 40 * GIB })], { kind: 'gate', memGb: 8 }, 'mdserver1'],
    ['build: by load as a gate', [md({ load1: 40 }), ai({ load1: 20 })], { kind: 'build', memGb: 4 }, 'ai-lan'],
    ['gate: a host short of memory is skipped', [md({ load1: 40 }), ai({ load1: 10, memAvailableBytes: 10 * GIB })], { kind: 'gate', memGb: 8 }, 'mdserver1'],
    ['gate: a root at 85% is skipped', [md({ load1: 40 }), ai({ load1: 10, disks: [{ path: '/', usedPct: 85, freeBytes: 1 }] })], { kind: 'gate', memGb: 1 }, 'mdserver1'],
    ['tab: most free memory, whatever the load', [md({ load1: 2, memAvailableBytes: 40 * GIB }), ai({ load1: 60, memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2 }, 'ai-lan'],
    ['tab: a tie keeps this host', [md({ memAvailableBytes: 40 * GIB }), ai({ memAvailableBytes: 40 * GIB })], { kind: 'tab', memGb: 2 }, 'mdserver1'],
    ['tab: a full root does not refuse a tab', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB, disks: [{ path: '/', usedPct: 90, freeBytes: 1 }] })], { kind: 'tab', memGb: 2 }, 'ai-lan'],
    ['tab: codex-cli never remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, panelType: 'codex-cli' }, 'mdserver1'],
    ['tab: grok-cli never remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, panelType: 'grok-cli' }, 'mdserver1'],
    ['tab: terminal never remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, panelType: 'terminal' }, 'mdserver1'],
    ['tab: an orchestrator-class (any role) tab never remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, role: 'evaluator' }, 'mdserver1'],
    ['tab: claude-code with no role may go remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, panelType: 'claude-code' }, 'ai-lan'],
    ['an unknown remote host takes nothing new', [md({ load1: 31 }), unknown('ai-lan')], { kind: 'gate', memGb: 8 }, 'mdserver1'],
    ['an unknown host takes nothing, even a tab', [md({ memAvailableBytes: 10 * GIB }), unknown('ai-lan')], { kind: 'tab', memGb: 2 }, 'mdserver1'],
    ['a host read only through its fallback takes no gate (r2 F2)', [md({ load1: 31 }), viaFallback()], { kind: 'gate', memGb: 1 }, 'mdserver1'],
    ['a host read only through its fallback takes no tab (r2 F2)', [md({ memAvailableBytes: 10 * GIB }), viaFallback()], { kind: 'tab', memGb: 2 }, 'mdserver1'],
    ['tab: tab slots full everywhere still places here, never refuses (r2 F3)', [md(), ai()], { kind: 'tab', memGb: 1 }, 'mdserver1'],
    ['tab: codex-cli with this host unknown is placed here, never remote (r2 F3)', [unknown('mdserver1', true), ai()], { kind: 'tab', memGb: 1, panelType: 'codex-cli' }, 'mdserver1'],
    ['tab: this host short of memory and no remote room still places here', [md({ memAvailableBytes: 1 * GIB }), ai({ memAvailableBytes: 1 * GIB })], { kind: 'tab', memGb: 2 }, 'mdserver1'],
  ])('%s', (name, reads, req, host) => {
    const placed = place(reads, req, [], name.includes('tab slots full') ? { mdserver1: 11, 'ai-lan': 46 } : {});
    expect(placed).toMatchObject({ ok: true, host });
  });

  it.each<[string, TPoolHostRead[], IPoolPlacementRequest, ILease[], Record<string, number>, string]>([
    ['no known host', [unknown('mdserver1', true), unknown('ai-lan')], { kind: 'gate', memGb: 1 }, [], {}, 'no-known-host'],
    ['a host read only through its fallback takes no gate', [unknown('mdserver1', true), viaFallback()], { kind: 'gate', memGb: 1 }, [], {}, 'no-known-host'],
    ['every gate slot held', [md(), ai()], { kind: 'gate', memGb: 1 },
      [...[1, 2, 3, 4].map((n) => lease(`pool:mdserver1/gate-${n}`)), ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => lease(`pool:ai-lan/gate-${n}`))], {}, 'no-free-slot'],
    ['every root at 85%', [md({ disks: [{ path: '/', usedPct: 86, freeBytes: 1 }] }), ai({ disks: [{ path: '/', usedPct: 85, freeBytes: 1 }] })], { kind: 'build', memGb: 1 }, [], {}, 'disk-full'],
    ['a root that was not read is not room for a gate', [md({ disks: [] }), ai({ disks: [{ path: '/data', usedPct: 10, freeBytes: 1 }] })], { kind: 'gate', memGb: 1 }, [], {}, 'disk-full'],
    ['no host has the memory plus the reserve', [md({ memAvailableBytes: 11 * GIB }), ai({ memAvailableBytes: 11 * GIB })], { kind: 'gate', memGb: 8 }, [], {}, 'no-memory'],
  ])('refused: %s', (_name, reads, req, leases, tabs, refusal) => {
    expect(place(reads, req, leases, tabs)).toMatchObject({ ok: false, refusal });
  });

  it('memory leased since the read counts against the host; older leases are in the read already', () => {
    const reads = [md({ memAvailableBytes: 20 * GIB, load1: 2 }), ai({ memAvailableBytes: 30 * GIB, load1: 60 })];
    expect(place(reads, { kind: 'tab', memGb: 2 })).toMatchObject({ host: 'ai-lan' });
    expect(place(reads, { kind: 'tab', memGb: 2 }, [lease('pool:ai-lan/gate-1', NOW - 5_000, 16)])).toMatchObject({ host: 'mdserver1' });
    expect(place(reads, { kind: 'tab', memGb: 2 }, [lease('pool:ai-lan/gate-1', NOW - 5 * 60_000, 16)])).toMatchObject({ host: 'ai-lan' });
  });

  it('a gate leased since the read adds its threads to the projected load', () => {
    const reads = [md({ load1: 8 }), ai({ load1: 8 })];
    expect(place(reads, { kind: 'gate', memGb: 1 })).toMatchObject({ host: 'ai-lan' });
    const leased = [1, 2, 3, 4, 5].map((n) => lease(`pool:ai-lan/gate-${n}`, NOW - 1_000));
    expect(place(reads, { kind: 'gate', memGb: 1 }, leased)).toMatchObject({ host: 'mdserver1' });
  });

  it('a host read only through its fallback stays in the view with its metrics and the served reason (r2 F2)', () => {
    const [, ai2] = buildPoolView(states([md(), viaFallback()]), NOW).hosts;
    expect(ai2).toMatchObject({
      state: 'known', placeable: false, via: 'ai-server', metrics: { threads: 64 },
      reason: 'answers only through ai-server; ai-lan failed (ai-lan: exit 255: Permission denied (publickey).)',
    });
    expect(buildPoolView(states([md(), ai()]), NOW).hosts.map((h) => h.placeable)).toEqual([true, true]);
  });

  it('totals count a fallback-only host in used and cap, never in free (N2)', () => {
    const totals = buildPoolView(states([md(), viaFallback()], [lease('pool:ai-lan/gate-1')]), NOW).totals;
    expect(totals.slots.gate).toEqual({ used: 1, cap: 12, free: 4 });
    expect(totals.slots.tab).toEqual({ used: 0, cap: 57, free: 11 });
    expect(buildPoolView(states([md(), ai()]), NOW).totals.slots.gate).toEqual({ used: 0, cap: 12, free: 12 });
  });

  it('a tab that finds no room says the WIP cap admits tabs (r2 F3)', () => {
    expect(place([md(), ai()], { kind: 'tab', memGb: 1 }, [], { mdserver1: 11, 'ai-lan': 46 }))
      .toMatchObject({ ok: true, local: true, reason: expect.stringContaining('tab admission is the WIP cap') });
  });

  it('a placement names its reason; a local-only tab says why', () => {
    expect(place([md(), ai()], { kind: 'gate', memGb: 1 })).toMatchObject({ reason: expect.stringContaining('lowest load per thread') });
    expect(place([md(), ai({ memAvailableBytes: 300 * GIB })], { kind: 'tab', memGb: 1, panelType: 'codex-cli' }))
      .toMatchObject({ host: 'mdserver1', reason: expect.stringContaining('type-local-only') });
  });

  it('tabLocalOnly: only a claude-code tab with no role may leave this host; gates and builds are not tabs', () => {
    expect(tabLocalOnly({ kind: 'tab', memGb: 0 })).toBeNull();
    expect(tabLocalOnly({ kind: 'tab', memGb: 0, panelType: 'claude-code' })).toBeNull();
    expect(tabLocalOnly({ kind: 'tab', memGb: 0, panelType: 'codex-cli' })).toContain('type-local-only');
    expect(tabLocalOnly({ kind: 'tab', memGb: 0, role: 'evaluator' })).toContain('role-local-only');
    expect(tabLocalOnly({ kind: 'gate', memGb: 0, panelType: 'codex-cli' })).toBeNull();
  });
});
