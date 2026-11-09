import { describe, expect, it } from 'vitest';
import {
  budgetOf, buildPoolView, freeSlotNumber, hostState, leaseClass, leaseEnvelope, memOfLease, orderQueue, parsePoolLeaseName, parsePoolQueueName,
  parseTicket, placeWork, POOL_FEATURES, poolGateHostOf, poolLeaseName, poolLeaseNote, poolModeOf, poolNumberRefusal, poolQueueName, poolQueueNote,
  requestEnvelope, slotCountCapOf,
  tabLocalOnly, wouldRefuseLine, type IPoolHostTabs, type IPoolTicket, type TConfigValue,
} from '@/lib/pool';
import type { ILease } from '@/types/lease';
import type { IPoolMetrics, IPoolPlacementRequest, IPoolWouldRefuse, TPoolHostRead, TPoolKind } from '@/types/pool';

// ADR-0039 §2-§3 and vel-D4: the pool model and its admission, table-driven.
// No test here places work anywhere: hosts are fakes.

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

const holder = { workspaceId: 'ws-a', tabId: 'tab-a', tabName: null, verified: true, identity: 'launch' as const, admin: false };

const leaseWith = (name: string, note: string | null, acquiredAt = NOW - 10 * 60_000): ILease => ({
  name, kind: name.slice(0, name.indexOf(':')), resource: name.slice(name.indexOf(':') + 1), holder,
  epic: null, note, acquiredAt: new Date(acquiredAt).toISOString(),
  renewedAt: new Date(acquiredAt).toISOString(), ttlSeconds: 3600, expiresAt: new Date(NOW + 3_600_000).toISOString(), survivesTab: false,
});

/** A slot lease with a note written before vel-D4 (`pool mem=<GB>`), or none. */
const lease = (name: string, acquiredAt = NOW - 10 * 60_000, memGb = 0): ILease => leaseWith(name, memGb ? `pool mem=${memGb}` : null, acquiredAt);

const ticket = (kind: TPoolKind, n: number, req: Partial<IPoolPlacementRequest>, acquiredAt: number): IPoolTicket =>
  parseTicket(leaseWith(poolQueueName(kind, n), poolQueueNote({ kind, memGb: 0, ...req }), acquiredAt))!;

const noConfig: TConfigValue = () => null;
/** The refusal tests run in enforce mode; shadow mode, the default, has its own tests (review r1 F1). */
const enforce: TConfigValue = (key) => (key === 'pool.mode' ? 'enforce' : null);
const cfg = (values: Record<string, string>): TConfigValue => (key) => ({ 'pool.mode': 'enforce', ...values } as Record<string, string>)[key] ?? null;

const tabsOf = (worker: number, controlPlane = 0): IPoolHostTabs => ({ worker, controlPlane });

const states = (reads: TPoolHostRead[], leases: ILease[] = [], tabs: Record<string, number | IPoolHostTabs> = {}, config: TConfigValue = enforce) =>
  reads.map((r) => {
    const t = tabs[r.host] ?? 0;
    return hostState(r, leases, typeof t === 'number' ? tabsOf(t) : t, config);
  });

const place = (reads: TPoolHostRead[], req: IPoolPlacementRequest, leases: ILease[] = [], tabs: Record<string, number | IPoolHostTabs> = {}, config: TConfigValue = enforce) =>
  placeWork(states(reads, leases, tabs, config), req);

/** The measured hosts (vel-D4): mdserver1 32 threads / 91 GiB; ai-server 64 threads / 373 GiB. Quiet unless told. */
const md = (m: Partial<IPoolMetrics> = {}) => known('mdserver1', true, m);
const ai = (m: Partial<IPoolMetrics> = {}) => known('ai-lan', false, { threads: 64, memTotalBytes: 373 * GIB, ...m });
const viaFallback = (m: Partial<IPoolMetrics> = {}): TPoolHostRead => ({
  host: 'ai-lan', local: false, state: 'known', readAt: NOW, via: 'ai-server', primaryFailure: 'ai-lan: exit 255: Permission denied (publickey).',
  metrics: metrics({ threads: 64, memTotalBytes: 373 * GIB, memAvailableBytes: 300 * GIB, load1: 1, ...m }),
});

describe('slot and ticket names', () => {
  it('round-trips host, kind and number; the host is lower-cased', () => {
    expect(poolLeaseName('AI-lan', 'gate', 3)).toBe('pool:ai-lan/gate-3');
    expect(parsePoolLeaseName('pool:ai-lan/gate-3')).toEqual({ host: 'ai-lan', kind: 'gate', n: 3 });
    expect(parsePoolLeaseName('pool:ai-lan/test-service-2')).toEqual({ host: 'ai-lan', kind: 'test-service', n: 2 });
    expect(parsePoolLeaseName('pool:ai-lan/review-3')).toBeNull();
    expect(parsePoolLeaseName('merge:a/b')).toBeNull();
    expect(parsePoolQueueName(poolQueueName('mutation', 4))).toEqual({ kind: 'mutation', n: 4 });
    expect(parsePoolQueueName('pool:ai-lan/gate-3')).toBeNull();
  });

  it('a lease note carries its memory; no note is no memory', () => {
    expect(memOfLease(lease('pool:x/gate-1', NOW, 12))).toBe(12 * GIB);
    expect(memOfLease(lease('pool:x/gate-1'))).toBe(0);
  });

  it('a note written before vel-D4 reads as the kind envelope, product class; a new note keeps what it reserved', () => {
    expect(leaseEnvelope(lease('pool:x/gate-1', NOW, 2), 'gate', noConfig)).toEqual({ threads: 8, memBytes: 8 * GIB });
    expect(leaseEnvelope(lease('pool:x/gate-1', NOW, 30), 'gate', noConfig)).toEqual({ threads: 8, memBytes: 30 * GIB });
    expect(leaseClass(lease('pool:x/gate-1'))).toBe('product');
    const fresh = leaseWith('pool:x/build-1', poolLeaseNote({ threads: 12, memBytes: 20 * GIB }, 'harness'));
    expect(fresh.note).toBe('pool mem=20 threads=12 class=harness');
    expect(leaseEnvelope(fresh, 'build', noConfig)).toEqual({ threads: 12, memBytes: 20 * GIB });
    expect(leaseClass(fresh)).toBe('harness');
  });

  it('a ticket note round-trips the request', () => {
    const req: IPoolPlacementRequest = { kind: 'tab', memGb: 2, threads: 3, class: 'harness', panelType: 'codex-cli', role: 'evaluator', localOnly: true };
    expect(parseTicket(leaseWith('pool-queue:tab-1', poolQueueNote(req)))?.req).toEqual(req);
    expect(parseTicket(leaseWith('pool:x/tab-1', null))).toBeNull();
  });
});

describe('one budget per host at the measured sizes (vel-D4 AC 1)', () => {
  it('reserve and worker budget defaults: mdserver1 8 threads / 14 GiB reserved, ai-server 16 / 56', () => {
    expect(budgetOf(md(), noConfig)).toMatchObject({ threads: 32, reserveThreads: 8, workerThreads: 24, reserveMemBytes: 14 * GIB, workerMemBytes: 77 * GIB, maxLoad: 32, harnessSharePct: 25 });
    expect(budgetOf(ai(), noConfig)).toMatchObject({ threads: 64, reserveThreads: 16, workerThreads: 48, reserveMemBytes: 56 * GIB, workerMemBytes: 317 * GIB, maxLoad: 64 });
    expect(budgetOf(unknown('ai-lan'), noConfig)).toBeNull();
  });

  it('fleet config sets threads, memory, reserve and max load; a hand-edited bad value keeps the default', () => {
    const config = cfg({
      'pool.budget.ai-lan.threads': '60', 'pool.budget.ai-lan.mem-gb': '300', 'pool.budget.ai-lan.reserve-threads': '20',
      'pool.budget.ai-lan.reserve-mem-gb': '100', 'pool.budget.ai-lan.max-load': '90', 'pool.harness-share-pct': '10',
    });
    expect(budgetOf(ai(), config)).toMatchObject({ threads: 60, workerThreads: 40, memBytes: 300 * GIB, workerMemBytes: 200 * GIB, maxLoad: 90, harnessSharePct: 10 });
    expect(budgetOf(ai(), cfg({ 'pool.budget.ai-lan.reserve-threads': 'lots' }))).toMatchObject({ reserveThreads: 16 });
    expect(budgetOf(ai(), cfg({ 'pool.budget.ai-lan.reserve-threads': '99' }))).toMatchObject({ reserveThreads: 64, workerThreads: 0 });
  });

  it('envelopes: the kind default, a fleet value, a larger --mem, an explicit --threads', () => {
    expect(requestEnvelope({ kind: 'gate', memGb: 0 }, noConfig)).toEqual({ threads: 8, memBytes: 8 * GIB });
    expect(requestEnvelope({ kind: 'browser', memGb: 1 }, noConfig)).toEqual({ threads: 2, memBytes: 4 * GIB });
    expect(requestEnvelope({ kind: 'gate', memGb: 30, threads: 4 }, noConfig)).toEqual({ threads: 4, memBytes: 30 * GIB });
    expect(requestEnvelope({ kind: 'mutation', memGb: 0 }, cfg({ 'pool.envelope.mutation.threads': '16', 'pool.envelope.mutation.mem-gb': '2.5' })))
      .toEqual({ threads: 16, memBytes: 2.5 * GIB });
  });

  it('gates and builds share one CPU budget: ai-server takes 6 in all, never 8 of each', () => {
    const held: ILease[] = [];
    const kinds: TPoolKind[] = ['gate', 'build'];
    for (let i = 0; i < 16; i += 1) {
      const kind = kinds[i % 2];
      const placed = place([ai()], { kind, memGb: 0 }, held);
      if (!placed.ok) break;
      const [s] = states([ai()], held);
      held.push(leaseWith(poolLeaseName(placed.host, kind, freeSlotNumber(s, kind)), poolLeaseNote({ threads: 8, memBytes: 8 * GIB })));
    }
    expect(held.map((l) => parsePoolLeaseName(l.name)?.kind)).toEqual(['gate', 'build', 'gate', 'build', 'gate', 'build']);
    expect(place([ai()], { kind: 'build', memGb: 0 }, held)).toMatchObject({
      ok: false, refusal: 'no-budget', reason: expect.stringContaining('budget threads 48/48 used, needs 8'),
    });
  });

  it('mdserver1 takes 3 gates or builds in all; mutation, browser and test-service draw on the same budget', () => {
    const held = ['gate-1', 'build-1'].map((s) => lease(`pool:mdserver1/${s}`));
    expect(place([md()], { kind: 'mutation', memGb: 0 }, held)).toMatchObject({ ok: true, host: 'mdserver1' });
    const full = [...held, lease('pool:mdserver1/mutation-1')];
    expect(place([md()], { kind: 'gate', memGb: 0 }, full)).toMatchObject({ ok: false, refusal: 'no-budget' });
    expect(place([md()], { kind: 'browser', memGb: 0 }, full)).toMatchObject({ ok: false, refusal: 'no-budget', reason: expect.stringContaining('budget threads 24/24 used, needs 2') });
    expect(place([md()], { kind: 'test-service', memGb: 0 }, full)).toMatchObject({ ok: false, refusal: 'no-budget' });
  });

  it('memory is budgeted for a job\'s whole life: old leases count against the budget even when the read shows free memory', () => {
    const big = [1, 2, 3].map((n) => lease(`pool:ai-lan/build-${n}`, NOW - 30 * 60_000, 100));
    const placed = place([ai({ memAvailableBytes: 350 * GIB })], { kind: 'gate', memGb: 20 }, big);
    expect(placed).toMatchObject({ ok: false, refusal: 'no-budget', reason: expect.stringContaining('budget memory 300.0 GiB/317.0 GiB used, needs 20.0 GiB') });
  });

  it('no double count: an old lease is in the read already, so the measured check does not subtract it again', () => {
    const old = [lease('pool:ai-lan/gate-1', NOW - 10 * 60_000, 16)];
    expect(place([ai({ memAvailableBytes: 20 * GIB })], { kind: 'gate', memGb: 8 }, old)).toMatchObject({ ok: true, host: 'ai-lan' });
    const recent = [lease('pool:ai-lan/gate-1', NOW - 5_000, 16)];
    expect(place([ai({ memAvailableBytes: 20 * GIB })], { kind: 'gate', memGb: 8 }, recent)).toMatchObject({
      ok: false, refusal: 'no-memory', reason: expect.stringContaining('measured 4.0 GiB free, needs 12.0 GiB'),
    });
  });

  it('a sustained overload refuses new work; a momentary load1 spike does not', () => {
    expect(place([ai({ load1: 147, load5: 140 })], { kind: 'gate', memGb: 0 })).toMatchObject({
      ok: false, refusal: 'overloaded', reason: expect.stringContaining('sustained load 140 + 8 threads > max load 64'),
    });
    expect(place([ai({ load1: 200, load5: 10 })], { kind: 'gate', memGb: 0 })).toMatchObject({ ok: true });
    expect(place([ai({ load1: 147, load5: 140 })], { kind: 'gate', memGb: 0 }, [], {}, cfg({ 'pool.budget.ai-lan.max-load': '160' }))).toMatchObject({ ok: true });
  });

  it('pool.slots.<host>.<kind> is a count cap on top of the budget', () => {
    expect(slotCountCapOf('ai-lan', 'gate', cfg({ 'pool.slots.ai-lan.gate': '6' }))).toBe(6);
    expect(slotCountCapOf('ai-lan', 'gate', cfg({ 'pool.slots.ai-lan.gate': '0' }))).toBe(0);
    expect(slotCountCapOf('ai-lan', 'gate', cfg({ 'pool.slots.ai-lan.gate': '65' }))).toBeNull();
    expect(slotCountCapOf('ai-lan', 'gate', cfg({ 'pool.slots.ai-lan.gate': 'many' }))).toBeNull();
    const one = cfg({ 'pool.slots.ai-lan.gate': '1' });
    expect(place([ai()], { kind: 'gate', memGb: 0 }, [lease('pool:ai-lan/gate-1')], {}, one)).toMatchObject({
      ok: false, refusal: 'no-free-slot', reason: expect.stringContaining('gate 1/1 (pool.slots)'),
    });
    expect(place([ai()], { kind: 'build', memGb: 0 }, [lease('pool:ai-lan/gate-1')], {}, one)).toMatchObject({ ok: true });
  });

  it('an envelope larger than every allowed host is refused at once and is not queueable', () => {
    expect(place([md(), ai()], { kind: 'gate', memGb: 400 })).toMatchObject({ ok: false, refusal: 'too-large', queueable: false });
    expect(place([md(), ai()], { kind: 'gate', memGb: 0, threads: 49 })).toMatchObject({ ok: false, refusal: 'too-large', reason: expect.stringContaining('ai-lan 48 threads') });
    expect(place([md(), unknown('ai-lan')], { kind: 'gate', memGb: 0, threads: 30 })).toMatchObject({ ok: false, refusal: 'too-large' });
    expect(place([unknown('mdserver1', true)], { kind: 'gate', memGb: 0, threads: 30 })).toMatchObject({ ok: false, refusal: 'no-known-host', queueable: true });
  });
});

describe('the control-plane reserve (vel-D4 AC 2)', () => {
  const fullWorkers = { mdserver1: tabsOf(12) };

  it('with the worker budget full, a gate and a worker tab are refused; the idle reserve is never given to them', () => {
    expect(place([md()], { kind: 'gate', memGb: 0 }, [], fullWorkers)).toMatchObject({ ok: false, refusal: 'no-budget', queueable: true });
    expect(place([md()], { kind: 'tab', memGb: 0, panelType: 'codex-cli' }, [], fullWorkers)).toMatchObject({
      ok: false, refusal: 'no-budget', reason: expect.stringContaining('budget threads 24/24 used, needs 2'),
    });
  });

  it('a control-plane tab is admitted here on the reserve, never queued, and says so', () => {
    expect(place([md(), ai()], { kind: 'tab', memGb: 0, class: 'control-plane' }, [], fullWorkers)).toMatchObject({
      ok: true, host: 'mdserver1', local: true, reason: 'control-plane reserve on mdserver1: threads 2/8, memory 4.0 GiB/14.0 GiB',
    });
    const reserveFull = { mdserver1: tabsOf(12, 4) };
    expect(place([md()], { kind: 'tab', memGb: 0, class: 'control-plane' }, [], reserveFull)).toMatchObject({
      ok: true, host: 'mdserver1', reason: expect.stringContaining('over the reserve; a coordinator is never queued or refused'),
    });
    expect(place([unknown('mdserver1', true)], { kind: 'tab', memGb: 0, class: 'control-plane' })).toMatchObject({ ok: true, local: true });
  });

  it('control-plane use never shrinks the worker budget: coordinators over the reserve leave the workers their 24 threads', () => {
    const [s] = states([md()], [], { mdserver1: tabsOf(0, 6) });
    expect(s.view.budget).toMatchObject({ used: { 'control-plane': { threads: 12 }, product: { threads: 0 } }, free: { threads: 24 } });
    expect(place([md()], { kind: 'gate', memGb: 0 }, [], { mdserver1: tabsOf(0, 6) })).toMatchObject({ ok: true });
  });
});

describe('priority classes (vel-D4 AC 5)', () => {
  it('harness work holds at most its share (25 % of 48 threads = 12); product work is unaffected', () => {
    const harness = leaseWith('pool:ai-lan/build-1', poolLeaseNote({ threads: 8, memBytes: 8 * GIB }, 'harness'));
    expect(place([ai()], { kind: 'build', memGb: 0, class: 'harness' })).toMatchObject({ ok: true });
    expect(place([ai()], { kind: 'build', memGb: 0, class: 'harness' }, [harness])).toMatchObject({
      ok: false, refusal: 'harness-share', reason: expect.stringContaining('harness holds threads 8/12'),
    });
    expect(place([ai()], { kind: 'build', memGb: 0, class: 'product' }, [harness])).toMatchObject({ ok: true });
    expect(place([ai()], { kind: 'browser', memGb: 0, class: 'harness' }, [harness])).toMatchObject({ ok: true });
  });

  it('a harness envelope larger than the share is too large, not queued for ever', () => {
    expect(place([ai()], { kind: 'mutation', memGb: 0, threads: 16, class: 'harness' })).toMatchObject({ ok: false, refusal: 'too-large', queueable: false });
  });

  it('queue order: product and harness under its share by arrival; harness over its share last', () => {
    const s = states([ai()], [leaseWith('pool:ai-lan/build-1', poolLeaseNote({ threads: 8, memBytes: 8 * GIB }, 'harness'))]);
    const h1 = ticket('gate', 1, { class: 'harness', threads: 4 }, NOW - 50_000);
    const p1 = ticket('gate', 2, {}, NOW - 40_000);
    const hOver = ticket('gate', 3, { class: 'harness' }, NOW - 60_000);
    expect(orderQueue([p1, hOver, h1], s, noConfig).map((t) => t.name)).toEqual(['pool-queue:gate-1', 'pool-queue:gate-2', 'pool-queue:gate-3']);
  });

  it('a waiting harness ticket under its share is admitted before a later product ticket: harness never starves', () => {
    // ai-server: 40 of 48 product threads held; 8 free. A harness gate waits first, then a product gate.
    const held = [1, 2, 3, 4, 5].map((n) => lease(`pool:ai-lan/gate-${n}`));
    const h = ticket('gate', 1, { class: 'harness' }, NOW - 20_000);
    const p = ticket('gate', 2, {}, NOW - 10_000);
    const s = states([ai()], held);
    expect(placeWork(s, p.req, { queue: [h, p], self: p.name })).toMatchObject({ ok: false, refusal: 'queued-ahead', reason: expect.stringContaining('1 earlier ticket(s) wait for it') });
    expect(placeWork(s, { kind: 'gate', memGb: 0 }, { queue: [h, p] })).toMatchObject({ ok: false, refusal: 'queued-ahead' });
    expect(placeWork(s, h.req, { queue: [h, p], self: h.name })).toMatchObject({ ok: true, host: 'ai-lan' });
  });

  it('a product ticket ahead keeps its host; a ticket that may run only elsewhere does not block', () => {
    const codex = ticket('tab', 1, { panelType: 'codex-cli' }, NOW - 20_000);
    const s = states([md(), ai()]);
    expect(placeWork(s, { kind: 'tab', memGb: 0, panelType: 'claude-code' }, { queue: [codex] })).toMatchObject({ ok: true, host: 'ai-lan' });
    expect(placeWork(s, { kind: 'tab', memGb: 0, panelType: 'grok-cli' }, { queue: [codex] })).toMatchObject({ ok: false, refusal: 'queued-ahead' });
    expect(placeWork(s, codex.req, { queue: [codex], self: codex.name })).toMatchObject({ ok: true, host: 'mdserver1' });
  });
});

describe('a tab start that fits no host (vel-D4 AC 3)', () => {
  it('a claude-code tab with every budget full is refused and queueable, never placed here', () => {
    expect(place([md(), ai()], { kind: 'tab', memGb: 1 }, [], { mdserver1: 12, 'ai-lan': 24 })).toMatchObject({
      ok: false, refusal: 'no-budget', queueable: true, reason: expect.stringMatching(/mdserver1: budget threads 24\/24 used, needs 2.*ai-lan: budget threads 48\/48 used, needs 2/),
    });
  });

  it('a codex-cli tab with this host unknown waits; it is never sent remote', () => {
    expect(place([unknown('mdserver1', true), ai()], { kind: 'tab', memGb: 1, panelType: 'codex-cli' })).toMatchObject({ ok: false, refusal: 'no-known-host', queueable: true });
  });

  it('this host short of memory and no remote room: refused with the measured figures', () => {
    expect(place([md({ memAvailableBytes: 1 * GIB }), ai({ memAvailableBytes: 1 * GIB })], { kind: 'tab', memGb: 2 })).toMatchObject({
      ok: false, refusal: 'no-memory', reason: expect.stringContaining('mdserver1: measured 1.0 GiB free, needs 8.0 GiB (4.0 GiB envelope + 4.0 GiB floor)'),
    });
  });

  it('a local-only re-ask (the --cwd missing on the first host) is judged on this host alone', () => {
    expect(place([md(), ai()], { kind: 'tab', memGb: 0, localOnly: true })).toMatchObject({ ok: true, host: 'mdserver1', reason: expect.stringContaining('local-only') });
    expect(place([md(), ai()], { kind: 'tab', memGb: 0, localOnly: true }, [], { mdserver1: 12 })).toMatchObject({ ok: false, queueable: true });
  });
});

describe('the read model (AC 1, AC 7)', () => {
  it('a known host shows threads, load, memory, disk, GPU, budget and kind counts; an unknown host shows no metrics, never zero', () => {
    const gpu = [{ index: 0, name: 'RTX 4090', utilPct: 64, memUsedMiB: 23189, memTotalMiB: 24564 }];
    const view = buildPoolView(states(
      [md(), known('ai-lan', false, { threads: 64, load1: 32, memTotalBytes: 373 * GIB, memAvailableBytes: 250 * GIB, gpus: gpu }), unknown('third')],
      [lease('pool:ai-lan/gate-1'), lease('pool:ai-lan/build-2'), lease('pool:mdserver1/tab-1')],
      { mdserver1: 5, 'ai-lan': 1 },
    ), NOW);
    const [mdView, aiView, third] = view.hosts;
    expect(mdView).toMatchObject({ host: 'mdserver1', local: true, state: 'known', loadPerThread: 0.5, agentTabs: 5 });
    expect(mdView.slots).toMatchObject({ gate: { used: 0, cap: 3, free: 1 }, build: { used: 0, cap: 3, free: 1 }, tab: { used: 6, cap: 12, free: 6 } });
    expect(mdView.budget).toMatchObject({ workerThreads: 24, used: { product: { threads: 12, memBytes: 24 * GIB } }, free: { threads: 12, memBytes: 53 * GIB } });
    expect(aiView).toMatchObject({ host: 'ai-lan', local: false, state: 'known', loadPerThread: 0.5 });
    expect(aiView.metrics?.gpus).toEqual(gpu);
    expect(aiView.slots.gate).toEqual({ used: 1, cap: 6, free: 3 });
    expect(aiView.slots.build).toEqual({ used: 1, cap: 6, free: 3 });
    expect(third).toMatchObject({ state: 'unknown', metrics: null, loadPerThread: null, budget: null, reason: expect.stringContaining('timed out') });
    expect(view.totals).toMatchObject({ threads: 96, memTotalBytes: 464 * GIB, knownHosts: 2, unknownHosts: 1 });
    expect(view.totals.slots.gate).toEqual({ used: 1, cap: 9, free: 4 });
    expect(view.queue).toEqual([]);
  });

  it('an unknown host keeps its leases in its counts and has no budget', () => {
    const [s] = states([unknown('ai-lan')], [lease('pool:ai-lan/gate-1')]);
    expect(s.view.slots.gate).toEqual({ used: 1, cap: 0, free: 0 });
    expect(s.ledger.product.threads).toBe(8);
  });

  it('the queue view lists tickets in admission order with their envelopes and hosts', () => {
    const view = buildPoolView(states([md(), ai()]), NOW, [ticket('tab', 2, { panelType: 'codex-cli' }, NOW - 1_000), ticket('gate', 1, { memGb: 20 }, NOW - 5_000)]);
    expect(view.queue).toEqual([
      expect.objectContaining({ ticket: 'pool-queue:gate-1', position: 1, class: 'product', envelope: { threads: 8, memGb: 20 }, hosts: ['mdserver1', 'ai-lan'], holder: 'ws-a/tab-a' }),
      expect.objectContaining({ ticket: 'pool-queue:tab-2', position: 2, envelope: { threads: 2, memGb: 4 }, hosts: ['mdserver1'] }),
    ]);
  });

  it('the lowest free slot number is taken', () => {
    const [s] = states([known('ai-lan', false)], [lease('pool:ai-lan/gate-1'), lease('pool:ai-lan/gate-3')]);
    expect(freeSlotNumber(s, 'gate')).toBe(2);
    expect(freeSlotNumber(s, 'build')).toBe(1);
  });

  it.each([
    ['pool.budget.ai-lan.threads', '64', null],
    ['pool.budget.ai-lan.threads', '0', 'whole threads 1..4096'],
    ['pool.budget.ai-lan.mem-gb', '373.5', null],
    ['pool.budget.ai-lan.reserve-threads', '0', null],
    ['pool.budget.ai-lan.max-load', 'high', 'a load 1..100000'],
    ['pool.envelope.gate.threads', '2.5', 'whole threads'],
    ['pool.envelope.test-service.mem-gb', '2', null],
    ['pool.harness-share-pct', '101', 'a whole percent 0..100'],
  ])('numeric pool key %s=%j', (key, value, message) => {
    const refusal = poolNumberRefusal(key, value);
    if (message === null) expect(refusal).toBeNull();
    else expect(refusal).toContain(message);
  });
});

describe('placement (AC 3)', () => {
  it.each<[string, TPoolHostRead[], IPoolPlacementRequest, string]>([
    ['gate: the lower load per thread wins', [md({ load1: 32 }), ai({ load1: 32 })], { kind: 'gate', memGb: 8 }, 'ai-lan'],
    ['gate: load before memory', [md({ load1: 8, memAvailableBytes: 20 * GIB }), ai({ load1: 48, memAvailableBytes: 300 * GIB })], { kind: 'gate', memGb: 8 }, 'mdserver1'],
    ['gate: equal load, more memory wins', [md({ load1: 16, memAvailableBytes: 20 * GIB }), ai({ load1: 32, memAvailableBytes: 300 * GIB })], { kind: 'gate', memGb: 8 }, 'ai-lan'],
    ['gate: a full tie keeps this host', [md({ load1: 16 }), ai({ load1: 32, memAvailableBytes: 40 * GIB })], { kind: 'gate', memGb: 8 }, 'mdserver1'],
    ['build: by load as a gate', [md({ load1: 20 }), ai({ load1: 20 })], { kind: 'build', memGb: 4 }, 'ai-lan'],
    ['gate: a host short of memory is skipped', [md({ load1: 20 }), ai({ load1: 10, memAvailableBytes: 10 * GIB })], { kind: 'gate', memGb: 8 }, 'mdserver1'],
    ['gate: a root at 85% is skipped', [md({ load1: 20 }), ai({ load1: 10, disks: [{ path: '/', usedPct: 85, freeBytes: 1 }] })], { kind: 'gate', memGb: 1 }, 'mdserver1'],
    ['tab: most free memory, whatever the load', [md({ load1: 2, memAvailableBytes: 40 * GIB }), ai({ load1: 60, memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2 }, 'ai-lan'],
    ['tab: a tie keeps this host', [md({ memAvailableBytes: 40 * GIB }), ai({ memAvailableBytes: 40 * GIB })], { kind: 'tab', memGb: 2 }, 'mdserver1'],
    ['tab: a full root does not refuse a tab', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB, disks: [{ path: '/', usedPct: 90, freeBytes: 1 }] })], { kind: 'tab', memGb: 2 }, 'ai-lan'],
    ['tab: codex-cli never remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, panelType: 'codex-cli' }, 'mdserver1'],
    ['tab: grok-cli never remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, panelType: 'grok-cli' }, 'mdserver1'],
    ['tab: terminal never remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, panelType: 'terminal' }, 'mdserver1'],
    ['tab: an orchestrator-class (any role) tab never remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, role: 'evaluator' }, 'mdserver1'],
    ['tab: claude-code with no role may go remote', [md({ memAvailableBytes: 10 * GIB }), ai({ memAvailableBytes: 250 * GIB })], { kind: 'tab', memGb: 2, panelType: 'claude-code' }, 'ai-lan'],
    ['an unknown remote host takes nothing new', [md({ load1: 16 }), unknown('ai-lan')], { kind: 'gate', memGb: 8 }, 'mdserver1'],
    ['an unknown host takes nothing, even a tab', [md({ memAvailableBytes: 10 * GIB }), unknown('ai-lan')], { kind: 'tab', memGb: 2 }, 'mdserver1'],
    ['a host read only through its fallback takes no gate (r2 F2)', [md({ load1: 16 }), viaFallback()], { kind: 'gate', memGb: 1 }, 'mdserver1'],
    ['a host read only through its fallback takes no tab (r2 F2)', [md({ memAvailableBytes: 10 * GIB }), viaFallback()], { kind: 'tab', memGb: 2 }, 'mdserver1'],
  ])('%s', (_name, reads, req, host) => {
    expect(place(reads, req)).toMatchObject({ ok: true, host });
  });

  it.each<[string, TPoolHostRead[], IPoolPlacementRequest, ILease[], string]>([
    ['no known host', [unknown('mdserver1', true), unknown('ai-lan')], { kind: 'gate', memGb: 1 }, [], 'no-known-host'],
    ['a host read only through its fallback takes no gate', [unknown('mdserver1', true), viaFallback()], { kind: 'gate', memGb: 1 }, [], 'no-known-host'],
    ['every worker thread reserved by gates', [md(), ai()], { kind: 'gate', memGb: 1 },
      [...[1, 2, 3].map((n) => lease(`pool:mdserver1/gate-${n}`)), ...[1, 2, 3, 4, 5, 6].map((n) => lease(`pool:ai-lan/gate-${n}`))], 'no-budget'],
    ['every root at 85%', [md({ disks: [{ path: '/', usedPct: 86, freeBytes: 1 }] }), ai({ disks: [{ path: '/', usedPct: 85, freeBytes: 1 }] })], { kind: 'build', memGb: 1 }, [], 'disk-full'],
    ['a root that was not read is not room for a gate', [md({ disks: [] }), ai({ disks: [{ path: '/data', usedPct: 10, freeBytes: 1 }] })], { kind: 'gate', memGb: 1 }, [], 'disk-full'],
    ['no host has the envelope plus the measured floor', [md({ memAvailableBytes: 11 * GIB }), ai({ memAvailableBytes: 11 * GIB })], { kind: 'gate', memGb: 8 }, [], 'no-memory'],
    ['the furthest check names the refusal: one host overloaded, one out of disk', [md({ load1: 40, load5: 40 }), ai({ disks: [{ path: '/', usedPct: 90, freeBytes: 1 }] })], { kind: 'gate', memGb: 0 }, [], 'overloaded'],
  ])('refused: %s', (_name, reads, req, leases, refusal) => {
    expect(place(reads, req, leases)).toMatchObject({ ok: false, refusal, queueable: true });
  });

  it('memory leased since the read counts against the host; older leases are in the read already', () => {
    const reads = [md({ memAvailableBytes: 20 * GIB, load1: 2 }), ai({ memAvailableBytes: 30 * GIB, load1: 40, load5: 40 })];
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
    expect(totals.slots.gate).toEqual({ used: 1, cap: 9, free: 3 });
    expect(totals.slots.tab).toEqual({ used: 0, cap: 36, free: 12 });
    expect(buildPoolView(states([md(), ai()]), NOW).totals.slots.gate).toEqual({ used: 0, cap: 9, free: 9 });
  });

  it('a placement names its reason with the budget figures; a local-only tab says why', () => {
    expect(place([md(), ai()], { kind: 'gate', memGb: 1 })).toMatchObject({ reason: expect.stringMatching(/lowest load per thread.*budget threads 8\/48/), envelope: { threads: 8, memGb: 8 } });
    expect(place([md(), ai({ memAvailableBytes: 300 * GIB })], { kind: 'tab', memGb: 1, panelType: 'codex-cli' }))
      .toMatchObject({ host: 'mdserver1', reason: expect.stringContaining('type-local-only') });
    expect(place([md()], { kind: 'tab', memGb: 0, panelType: 'terminal' })).toMatchObject({ envelope: null, reason: expect.stringContaining('not an agent tab') });
  });

  it('tabLocalOnly: only a claude-code product or harness tab with no role may leave this host; gates and builds are not tabs', () => {
    expect(tabLocalOnly({ kind: 'tab', memGb: 0 })).toBeNull();
    expect(tabLocalOnly({ kind: 'tab', memGb: 0, panelType: 'claude-code' })).toBeNull();
    expect(tabLocalOnly({ kind: 'tab', memGb: 0, panelType: 'codex-cli' })).toContain('type-local-only');
    expect(tabLocalOnly({ kind: 'tab', memGb: 0, role: 'evaluator' })).toContain('role-local-only');
    expect(tabLocalOnly({ kind: 'tab', memGb: 0, class: 'control-plane' })).toContain('control-plane');
    expect(tabLocalOnly({ kind: 'tab', memGb: 0, localOnly: true })).toContain('local-only');
    expect(tabLocalOnly({ kind: 'gate', memGb: 0, panelType: 'codex-cli' })).toBeNull();
  });
});

describe('pool.mode: shadow, the default, admits and logs; enforce refuses (review r1 F1, F2, F7)', () => {
  const fullGates = [1, 2, 3, 4, 5, 6].map((n) => lease(`pool:ai-lan/gate-${n}`));

  it('the mode reads shadow unless the fleet value is exactly enforce', () => {
    expect(poolModeOf(noConfig)).toBe('shadow');
    expect(poolModeOf(enforce)).toBe('enforce');
    expect(poolModeOf(cfg({ 'pool.mode': ' enforce ' }))).toBe('enforce');
    expect(poolModeOf(cfg({ 'pool.mode': 'ENFORCE' }))).toBe('shadow');
    expect(poolModeOf(cfg({ 'pool.mode': 'on' }))).toBe('shadow');
  });

  it('shadow admits a budget refusal with the would-refuse figures; enforce refuses the same request', () => {
    const shadow = place([ai()], { kind: 'gate', memGb: 0 }, fullGates, {}, noConfig);
    expect(shadow).toMatchObject({
      ok: true, host: 'ai-lan', reason: expect.stringContaining('shadow mode admitted what enforce would refuse (no-budget)'),
      wouldRefuse: { host: 'ai-lan', kind: 'gate', class: 'product', refusals: ['no-budget'], workerUsed: { threads: 48 }, workerThreads: 48, envelope: { threads: 8, memGb: 8 } },
    });
    expect(place([ai()], { kind: 'gate', memGb: 0 }, fullGates, {}, enforce)).toMatchObject({ ok: false, refusal: 'no-budget' });
  });

  it('shadow admits a sustained overload and a measured-memory refusal; the log line carries the tuning figures', () => {
    const reads = [md({ load1: 60, load5: 55, memAvailableBytes: 9 * GIB })];
    const recent = { mdserver1: { worker: 12, controlPlane: 1, recentStarts: [{ at: NOW - 10_000, threads: 2, memBytes: 4 * GIB }] } };
    const placed = place(reads, { kind: 'tab', memGb: 0, panelType: 'codex-cli' }, [], recent, noConfig);
    expect(placed).toMatchObject({ ok: true, host: 'mdserver1', wouldRefuse: { refusals: ['no-budget', 'no-memory', 'overloaded'], minLoad: 55, pendingThreads: 2 } });
    const line = wouldRefuseLine((placed as { wouldRefuse: IPoolWouldRefuse }).wouldRefuse);
    expect(line).toMatch(/^pool would-refuse \(shadow, admitted\): host=mdserver1 kind=tab class=product refusals=no-budget,no-memory,overloaded /);
    expect(line).toContain('min_load=55 pending_threads=2 envelope_threads=2 envelope_mem_gib=4 max_load=32 mem_free_gib=5');
    expect(line).toContain('worker_threads=24/24');
    expect(line).toContain('agent_tabs=worker:12,control-plane:1');
    expect(line).toContain('sustained load 57 + 2 threads > max load 32');
    expect(place(reads, { kind: 'tab', memGb: 0, panelType: 'codex-cli' }, [], recent, enforce)).toMatchObject({ ok: false, refusal: 'no-budget' });
  });

  it('shadow takes a host that passes every check before one that only shadow admits', () => {
    // ai-server has the lower load per thread, so it would win the sort; its budget is full, so a clean host wins first.
    const placed = place([md({ load1: 16, load5: 16, memAvailableBytes: 80 * GIB }), ai({ load1: 1, load5: 1 })], { kind: 'gate', memGb: 0 }, fullGates, {}, noConfig);
    expect(placed).toMatchObject({ ok: true, host: 'mdserver1' });
    expect(placed).not.toHaveProperty('wouldRefuse');
  });

  it('shadow still refuses every other check: unknown host, disk, count cap, harness share, an earlier ticket, too large', () => {
    expect(place([unknown('ai-lan')], { kind: 'gate', memGb: 0 }, [], {}, noConfig)).toMatchObject({ ok: false, refusal: 'no-known-host' });
    expect(place([ai({ disks: [{ path: '/', usedPct: 90, freeBytes: 1 }] })], { kind: 'gate', memGb: 0 }, [], {}, noConfig)).toMatchObject({ ok: false, refusal: 'disk-full' });
    expect(place([ai()], { kind: 'gate', memGb: 0 }, [lease('pool:ai-lan/gate-1')], {}, (k) => (k === 'pool.slots.ai-lan.gate' ? '1' : null))).toMatchObject({ ok: false, refusal: 'no-free-slot' });
    const harness = leaseWith('pool:ai-lan/build-1', poolLeaseNote({ threads: 8, memBytes: 8 * GIB }, 'harness'));
    expect(place([ai()], { kind: 'build', memGb: 0, class: 'harness' }, [harness], {}, noConfig)).toMatchObject({ ok: false, refusal: 'harness-share' });
    const s = states([ai()], fullGates, {}, noConfig);
    expect(placeWork(s, { kind: 'gate', memGb: 0 }, { queue: [ticket('gate', 1, {}, NOW - 1_000)] })).toMatchObject({ ok: false, refusal: 'queued-ahead' });
    expect(place([ai()], { kind: 'gate', memGb: 400 }, [], {}, noConfig)).toMatchObject({ ok: false, refusal: 'too-large' });
  });
});

describe('a ticket holds back only a host it could run on (review r1 F5)', () => {
  it('a 30-thread ticket does not block mdserver1 (24 worker threads); it still blocks ai-server', () => {
    const big = ticket('gate', 1, { threads: 30 }, NOW - 5_000);
    const s = states([md(), ai()]);
    expect(placeWork(s, { kind: 'gate', memGb: 0 }, { queue: [big] })).toMatchObject({ ok: true, host: 'mdserver1' });
    expect(placeWork(states([ai()]), { kind: 'gate', memGb: 0 }, { queue: [big] })).toMatchObject({ ok: false, refusal: 'queued-ahead' });
  });

  it('a harness ticket larger than a host\'s harness share does not block that host', () => {
    const h = ticket('gate', 1, { class: 'harness', threads: 8 }, NOW - 5_000);
    expect(placeWork(states([md()]), { kind: 'gate', memGb: 0 }, { queue: [h] })).toMatchObject({ ok: true, host: 'mdserver1' });
  });
});

describe('tab starts the read cannot show yet (review r1 F6)', () => {
  const burst = (at: number) => Array.from({ length: 5 }, () => ({ at, threads: 2, memBytes: 4 * GIB }));

  it('a burst of 5 tab starts within LOAD_LAG_MS counts in the measured load and memory; older ones are in the read', () => {
    const [fresh] = states([md({ load1: 16, load5: 16, memAvailableBytes: 40 * GIB })], [], { mdserver1: { worker: 5, controlPlane: 0, recentStarts: burst(NOW - 30_000) } });
    expect(fresh).toMatchObject({ sustainedLoad: 26, pendingThreads: 10, memFreeBytes: 20 * GIB });
    const [old] = states([md({ load1: 16, load5: 16, memAvailableBytes: 40 * GIB })], [], { mdserver1: { worker: 5, controlPlane: 0, recentStarts: burst(NOW - 61_000) } });
    expect(old).toMatchObject({ sustainedLoad: 16, pendingThreads: 0, memFreeBytes: 40 * GIB });
  });

  it('with the burst counted, a gate on this host is refused as overloaded in enforce mode', () => {
    const reads = [md({ load1: 16, load5: 16 })];
    expect(place(reads, { kind: 'gate', memGb: 0 })).toMatchObject({ ok: true });
    expect(place(reads, { kind: 'gate', memGb: 0 }, [], { mdserver1: { worker: 0, controlPlane: 0, recentStarts: burst(NOW - 1_000) } })).toMatchObject({
      ok: false, refusal: 'overloaded', reason: expect.stringContaining('sustained load 26 + 8 threads > max load 32'),
    });
  });
});

describe('the host view serves the tailnet path (vel-RETRO-R2)', () => {
  const relayedRead = (host: string, rttMs: number, kind: 'relayed' | 'direct' = 'relayed'): TPoolHostRead => ({
    ...known(host, false, { threads: 64, memTotalBytes: 373 * GIB }),
    path: { kind, alias: host, address: `${host}.tailnet.example`, ip: 'fd7a:115c:a1e0::2', peer: host, region: kind === 'relayed' ? 'sin' : null, rttMs, measuredAt: NOW, reason: null, relayedReads: kind === 'relayed' ? 2 : 0 },
  });

  it('serves a relayed path with its alert, and this host none', () => {
    const [local, remote] = states([md(), relayedRead('exec-1', 1170)]);
    expect(local.view.path).toBeNull();
    expect(remote.view.path).toMatchObject({ kind: 'relayed', alert: 'tailnet-relayed', region: 'sin', rttMs: 1170, slowMs: 250 });
  });

  it('judges a direct path slow by pool.path.slow-ms, else by the default 250 ms', () => {
    expect(states([relayedRead('exec-1', 300, 'direct')])[0].view.path?.alert).toBe('tailnet-slow');
    expect(states([relayedRead('exec-1', 300, 'direct')], [], {}, cfg({ 'pool.path.slow-ms': '500' }))[0].view.path).toMatchObject({ alert: null, slowMs: 500 });
    expect(states([relayedRead('exec-1', 300, 'direct')], [], {}, cfg({ 'pool.path.slow-ms': 'soon' }))[0].view.path?.slowMs).toBe(250);
  });

  it('never refuses a host for its path: placement reads none of it (the owner keeps the hosts)', () => {
    const quiet = { threads: 64, memTotalBytes: 373 * GIB, load1: 0, load5: 0, memAvailableBytes: 300 * GIB };
    const relayed = { ...relayedRead('host-b-lan', 1170), metrics: metrics(quiet) } as TPoolHostRead;
    const plain = known('host-b-lan', false, quiet);
    const req: IPoolPlacementRequest = { kind: 'gate', memGb: 8 };
    expect(place([md({ load1: 30, load5: 30 }), relayed], req)).toEqual(place([md({ load1: 30, load5: 30 }), plain], req));
    expect(place([md({ load1: 30, load5: 30 }), relayed], req)).toMatchObject({ ok: true, host: 'host-b-lan' });
  });
});

describe('the host pin and the ask token (vel-POOL-ENF)', () => {
  // Neutral host names in this block (the repository is public): the file's two measured hosts, renamed.
  const ctl = (m: Partial<IPoolMetrics> = {}) => known('control-host', true, m);
  const wk = (m: Partial<IPoolMetrics> = {}) => known('worker-host', false, { threads: 64, memTotalBytes: 373 * GIB, ...m });
  const gate = (pin: IPoolPlacementRequest['pin']): IPoolPlacementRequest => ({ kind: 'gate', memGb: 0, pin });
  const replica = cfg({ 'pool.gate-host.worker-host': 'gate-host-b' });

  it('unpinned, the gate goes to the lowest load per thread (worker-host); pinned to a host, it goes there', () => {
    expect(place([ctl(), wk()], { kind: 'gate', memGb: 0 })).toMatchObject({ ok: true, host: 'worker-host' });
    expect(place([ctl(), wk()], gate({ hosts: ['control-host'], local: false, gateHosts: [] }))).toMatchObject({ ok: true, host: 'control-host' });
  });

  it('pin local is the server\'s own host', () => {
    expect(place([ctl(), wk()], gate({ hosts: [], local: true, gateHosts: [] }))).toMatchObject({ ok: true, host: 'control-host', local: true });
  });

  it('pin gate hosts are the hosts whose pool.gate-host names one of them', () => {
    const quietCtl = ctl({ load1: 0, load5: 0 });
    expect(place([quietCtl, wk()], gate({ hosts: [], local: false, gateHosts: ['gate-host-b'] }), [], {}, replica)).toMatchObject({ ok: true, host: 'worker-host' });
    expect(poolGateHostOf(replica, 'WORKER-HOST')).toBe('gate-host-b');
    expect(poolGateHostOf(replica, 'control-host')).toBeNull();
    expect(poolGateHostOf(cfg({ 'pool.gate-host.worker-host': 'not a host!' }), 'worker-host')).toBeNull();
  });

  it('the forms are a union: the usual order chooses among every host the pin allows', () => {
    const both = gate({ hosts: ['control-host'], local: false, gateHosts: ['gate-host-b'] });
    expect(place([ctl(), wk()], both, [], {}, replica)).toMatchObject({ ok: true, host: 'worker-host' });
    expect(place([ctl({ load1: 0, load5: 0 }), wk()], both, [], {}, replica)).toMatchObject({ ok: true, host: 'control-host' });
  });

  it('a pin that names no pool host is no-pinned-host, never queueable; the reason names the pin and the hosts', () => {
    const r = place([ctl(), wk()], gate({ hosts: ['typo-host'], local: false, gateHosts: ['gatehost-x'] }), [], {}, replica);
    expect(r).toMatchObject({ ok: false, refusal: 'no-pinned-host', queueable: false });
    if (r.ok) throw new Error('admitted');
    expect(r.reason).toContain('hosts typo-host');
    expect(r.reason).toContain('gate hosts gatehost-x');
    expect(r.reason).toContain('control-host (gate host none), worker-host (gate host gate-host-b)');
  });

  it('a pinned host that is known but full is the usual queueable refusal, not no-pinned-host', () => {
    const full = cfg({ 'pool.slots.control-host.gate': '0' });
    expect(place([ctl(), wk()], gate({ hosts: ['control-host'], local: false, gateHosts: [] }), [], {}, full)).toMatchObject({ ok: false, refusal: 'no-free-slot', queueable: true });
    expect(place([ctl(), unknown('worker-host')], gate({ hosts: ['worker-host'], local: false, gateHosts: [] }))).toMatchObject({ ok: false, refusal: 'no-known-host', queueable: true });
  });

  it('a tab that must stay here meets the pin: the intersection is empty is no-pinned-host', () => {
    const codex: IPoolPlacementRequest = { kind: 'tab', memGb: 0, panelType: 'codex-cli', pin: { hosts: ['worker-host'], local: false, gateHosts: [] } };
    expect(place([ctl(), wk()], codex)).toMatchObject({ ok: false, refusal: 'no-pinned-host', queueable: false });
    expect(place([ctl(), wk()], { ...codex, pin: { hosts: ['worker-host', 'control-host'], local: false, gateHosts: [] } })).toMatchObject({ ok: true, host: 'control-host' });
  });

  it('the slot note carries the ask token; a ticket note keeps the pin and the token', () => {
    const e = requestEnvelope({ kind: 'gate', memGb: 8 }, noConfig);
    expect(poolLeaseNote(e, 'product', '0123456789abcdef0123456789abcdef')).toBe('pool mem=8 threads=8 class=product ask=0123456789abcdef0123456789abcdef');
    expect(poolLeaseNote(e)).toBe('pool mem=8 threads=8 class=product');
    const req: IPoolPlacementRequest = { kind: 'gate', memGb: 8, pin: { hosts: ['control-host', 'worker-host'], local: true, gateHosts: ['gate-host-b'] } };
    const note = poolQueueNote(req, 'ask-token-0000000001');
    expect(note).toBe('pool-queue class=product mem=8 pin-hosts=control-host,worker-host pin-local=1 pin-gate-hosts=gate-host-b ask=ask-token-0000000001');
    const t = parseTicket(leaseWith(poolQueueName('gate', 1), note))!;
    expect(t.req.pin).toEqual(req.pin);
    expect(t.ask).toBe('ask-token-0000000001');
    const plain = parseTicket(leaseWith(poolQueueName('gate', 2), poolQueueNote({ kind: 'gate', memGb: 0 })))!;
    expect(plain.req.pin).toBeUndefined();
    expect(plain.ask).toBeNull();
  });

  it('a queued ticket holds back only the hosts its pin allows', () => {
    const waiting = ticket('gate', 1, { pin: { hosts: ['control-host'], local: false, gateHosts: [] } }, NOW - 5_000);
    expect(placeWork(states([ctl(), wk()]), { kind: 'gate', memGb: 0 }, { queue: [waiting] })).toMatchObject({ ok: true, host: 'worker-host' });
  });

  it('the view lists the features a client checks before it relies on them', () => {
    expect(POOL_FEATURES).toEqual(['ask-token', 'host-pin']);
    expect(buildPoolView(states([ctl()]), NOW).features).toEqual(['ask-token', 'host-pin']);
  });

  it('a cancel mark is not a slot: it holds no budget and no slot number', () => {
    const [s] = states([ctl()], [leaseWith('pool-cancel:0123456789abcdef0123456789abcdef', 'pool-cancel')]);
    expect(s.view.slots.gate.used).toBe(0);
    expect(s.ledger.product).toEqual({ threads: 0, memBytes: 0 });
  });

  it('a control-plane tab is pinned too: a pin without the server\'s host refuses it (review r1 of #64)', () => {
    const cp = (pin: IPoolPlacementRequest['pin']): IPoolPlacementRequest => ({ kind: 'tab', memGb: 0, class: 'control-plane', pin });
    expect(place([ctl(), wk()], cp({ hosts: ['worker-host'], local: false, gateHosts: [] }))).toMatchObject({ ok: false, refusal: 'no-pinned-host', queueable: false });
    expect(place([ctl(), wk()], cp({ hosts: [], local: true, gateHosts: [] }))).toMatchObject({ ok: true, host: 'control-host', local: true });
  });

  it('a non-agent tab is pinned too: it runs on the server\'s host only when the pin allows it (review r1 of #64)', () => {
    const term = (pin: IPoolPlacementRequest['pin']): IPoolPlacementRequest => ({ kind: 'tab', memGb: 0, panelType: 'terminal', pin });
    expect(place([ctl(), wk()], term({ hosts: ['worker-host'], local: false, gateHosts: [] }))).toMatchObject({ ok: false, refusal: 'no-pinned-host', queueable: false });
    expect(place([ctl(), wk()], term({ hosts: ['control-host'], local: false, gateHosts: [] }))).toMatchObject({ ok: true, host: 'control-host', envelope: null });
    expect(place([ctl(), wk()], { kind: 'tab', memGb: 0, panelType: 'terminal' })).toMatchObject({ ok: true, host: 'control-host' });
  });
});
