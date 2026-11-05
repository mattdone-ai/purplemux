import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FINDER_WINDOWS, boardLine, criticalKeys, deriveConstraint, trendOf } from '@/lib/constraint';
import type { IFinderInterval, IFinderLedgerInput, IFinderOwnerIssueSource, IFinderSpendInput } from '@/types/constraint';
import type { IFlowRecord } from '@/types/flow';
import type { ILedgerItem, TLedgerAttrValue, TLedgerIntervalReason, TLedgerItemType } from '@/types/ledger';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 3, 6, 0, 0);

const interval = (
  itemKey: string, reason: string, start: number, end: number, holder: string | null = null,
): IFinderInterval => ({
  itemKey, itemType: itemKey.slice(0, itemKey.indexOf(':')) as TLedgerItemType, reason: reason as TLedgerIntervalReason, holder, start, end,
});

const item = (itemKey: string, extra: Partial<ILedgerItem> = {}): ILedgerItem => ({
  workspaceId: 'ws-a', itemKey, itemType: itemKey.slice(0, itemKey.indexOf(':')) as TLedgerItemType, openedAt: NOW - 20 * 24 * HOUR,
  closedAt: null, state: null, stateSince: null, waitReason: null, waitSince: null, holder: null, clearInput: null, parentKey: null,
  attrs: {}, lastEventAt: NOW - MIN, lastSeq: 1, ...extra,
});

const ledger = (extra: Partial<IFinderLedgerInput> = {}): IFinderLedgerInput => ({
  intervals: [], items: [], lastProducer: {}, firstEventAt: NOW - 30 * 24 * HOUR, tabWakes: null, ownerIssueSource: null, ...extra,
});

/** The spend view's first UTC day starts 6 days before today's: 2026-10-28T00:00Z. */
const SPEND_SINCE = Date.UTC(2026, 9, 28);

const READY_SPEND: IFinderSpendInput = {
  index: { state: 'ready', filesIndexed: 10, filesTotal: 10, indexedThrough: NOW - MIN }, since: SPEND_SINCE, costUsd: 120, cacheReadTokens: 1_000_000,
  landedRanges: 2,
  cacheReadTokensPerLandedItem: {
    metric: 'cache_read_tokens_per_landed_item', window: '7d', from: '2026-10-28', to: '2026-11-03', cacheReadTokens: 1_000_000,
    landedItems: 2, value: 500_000, reason: null,
  },
};

/** Every module specifier a TypeScript file names: static, multi-line, side-effect, dynamic and require. */
const importSpecifiers = (source: string): string[] => ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);

const resolveAlias = (name: string): string => {
  const base = path.join(process.cwd(), 'src', name.slice('@/'.length));
  const found = [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((file) => fs.existsSync(file));
  if (!found) throw new Error(`cannot resolve ${name}`);
  return found;
};

/** The whole `@/` import graph of a file, and every specifier outside it. */
const importGraph = (entry: string): { files: Set<string>; external: Set<string> } => {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const name of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      if (name.startsWith('@/')) queue.push(resolveAlias(name));
      else external.add(name);
    }
  }
  return { files, external };
};

const flowRecord = (receivedAt: number): IFlowRecord => ({
  workspaceId: 'ws-a', receivedAt, history: [],
  snapshot: { schemaVersion: 1, generatedAt: receivedAt, source: 'v2', queues: [], meters: [], flags: [],
    locks: [{ name: 'landing', heldBy: 'lane-a', since: receivedAt - 5 * MIN }] },
});

/** The lane section of evidence/receipt-to-main-decompose.out as 1 h waits spread evenly over 7 days. */
const decomposeFixture = (): IFinderLedgerInput => {
  const file = path.join(process.cwd(), 'tests/fixtures/constraint/receipt-to-main-lane.json');
  const { hours } = JSON.parse(fs.readFileSync(file, 'utf8')) as { hours: Record<string, number> };
  const intervals: IFinderInterval[] = [];
  const span = 7 * 24 * HOUR;
  for (const [reason, total] of Object.entries(hours)) {
    const count = Math.round(total);
    for (let i = 0; i < count; i += 1) {
      const end = NOW - Math.floor((i * span) / Math.max(count, 1)) - 1;
      intervals.push(interval(`range:lane-${i % 9}:${reason.replace('/', '-')}${i}`, reason, end - HOUR, end, `lane-${i % 9}`));
    }
  }
  return ledger({ intervals });
};

describe('deriveConstraint (AC 1): pure, per window and per reason and stage', () => {
  it('imports nothing outside src/ across its whole import graph, and reads no clock', () => {
    const entry = path.join(process.cwd(), 'src/lib/constraint.ts');
    const { files, external } = importGraph(entry);
    expect([...files].map((file) => path.relative(process.cwd(), file)).sort()).toContain('src/lib/ledger.ts');
    expect([...external]).toEqual([]);
    expect(fs.readFileSync(entry, 'utf8')).not.toMatch(/fetch\(|Date\.now|new Date\(\)|process\.|setTimeout|setInterval/);
  });

  it('the purity check sees multi-line, side-effect, dynamic and require imports', () => {
    const source = [
      "import {\n  readFileSync,\n  statSync,\n} from 'fs';",
      "import type {\n  IFoo,\n} from '@/types/foo';",
      "import 'os';",
      "const p = import('path');",
      "const c = require('child_process');",
    ].join('\n');
    expect(importSpecifiers(source).sort()).toEqual(['@/types/foo', 'child_process', 'fs', 'os', 'path']);
  });

  it('answers 6 h, 24 h and 7 d windows with WIP, summed hours, p50, p90, throughput and trend', () => {
    const result = deriveConstraint(ledger({
      intervals: [
        interval('range:a:1', 'not-armed', NOW - 3 * HOUR, NOW - 2 * HOUR),
        interval('range:a:2', 'not-armed', NOW - 5 * HOUR, NOW - 2 * HOUR),
        interval('range:a:3', 'not-armed', NOW - 30 * HOUR, NOW - 29 * HOUR),
        interval('range:a:4', 'lock-wait', NOW - 10 * HOUR, NOW - 9 * HOUR),
      ],
      items: [item('range:b:1', { waitReason: 'not-armed', waitSince: NOW - 2 * HOUR })],
    }), null, null, null, NOW);
    expect(result.windows.map((w) => w.window)).toEqual(FINDER_WINDOWS.map((w) => w.window));
    const six = result.windows[0];
    const notArmed = six.byReason.find((row) => row.key === 'not-armed')!;
    expect(notArmed).toEqual({
      key: 'not-armed', wip: 1, waitingHours: 6, p50Hours: 1, p90Hours: 3, throughput: 2, trend: 'new', previousWaitingHours: 0,
    });
    const day = result.windows[1];
    expect(day.byReason.map((row) => [row.key, row.waitingHours])).toEqual([['not-armed', 6], ['lock-wait', 1]]);
    expect(day.byStage).toEqual([expect.objectContaining({ key: 'land', wip: 1, waitingHours: 7, throughput: 3 })]);
    expect(result.windows[2].byReason.find((row) => row.key === 'not-armed')!.waitingHours).toBe(7);
  });

  it('clips a wait to the window and compares it with the window before', () => {
    const result = deriveConstraint(ledger({
      intervals: [
        interval('range:a:1', 'chain-down', NOW - 8 * HOUR, NOW - 4 * HOUR),
        interval('range:a:2', 'chain-down', NOW - 30 * HOUR, NOW - 26 * HOUR),
      ],
    }), null, null, null, NOW);
    const six = result.windows[0].byReason[0];
    expect(six).toMatchObject({ key: 'chain-down', waitingHours: 2, previousWaitingHours: 2, trend: 'flat' });
    const day = result.windows[1].byReason[0];
    expect(day).toMatchObject({ waitingHours: 4, previousWaitingHours: 4, trend: 'flat', throughput: 1 });
  });

  it('counts items closed in each window by type', () => {
    const result = deriveConstraint(ledger({
      items: [item('range:a:1', { closedAt: NOW - HOUR }), item('range:a:2', { closedAt: NOW - 20 * HOUR }), item('gate:t:1', { closedAt: NOW - 3 * 24 * HOUR })],
    }), null, null, null, NOW);
    expect(result.windows.map((w) => w.closed)).toEqual([{ range: 1 }, { range: 2 }, { range: 2, gate: 1 }]);
  });

  it('trend: within 20% is flat, a first wait is new, no history before the previous window is unknown', () => {
    const at = (current: number, previous: number, first: number | null = 0) => trendOf(current, previous, 100, first);
    expect([at(120, 100), at(121, 100), at(80, 100), at(79, 100), at(5, 0), at(0, 0), at(5, 5, 101), at(5, 5, null)])
      .toEqual(['flat', 'up', 'flat', 'down', 'new', null, 'unknown', 'unknown']);
  });

  it('shows a trend unknown when the ledger history starts inside the previous window', () => {
    const result = deriveConstraint(ledger({
      intervals: [interval('range:a:1', 'not-armed', NOW - 3 * HOUR, NOW - 2 * HOUR)], firstEventAt: NOW - 30 * HOUR,
    }), null, null, null, NOW);
    expect(result.windows.map((w) => w.byReason[0].trend)).toEqual(['new', 'unknown', 'unknown']);
    expect(result.constraint!.trend).toBe('unknown');
  });
});

type TTable = Record<string, { critical: number; other: number }>;

const CRITICAL_FIXTURE = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/constraint/receipt-to-main-critical.json'), 'utf8')) as {
  F1: { days: number; hours: TTable }; F2: { hours: TTable };
};

/**
 * One table as waits of at most 1 h. Critical waits sit on lane E2, whose slice carries
 * `attrs.critical` when `flagged`; the rest on lane X1. `spreadMs`: chunk ends spread evenly over
 * that span before NOW (the run), or packed inside the last 24 h when it is DAY.
 */
const tableFixture = (table: TTable, spreadMs: number, flagged: boolean): IFinderLedgerInput => {
  const intervals: IFinderInterval[] = [];
  for (const [reason, split] of Object.entries(table)) {
    for (const [lane, hours] of [['E2', split.critical], ['X1', split.other]] as const) {
      const n = Math.ceil(hours);
      const chunk = (hours * HOUR) / Math.max(n, 1);
      for (let i = 0; i < n; i += 1) {
        const end = NOW - Math.floor((i * (spreadMs - chunk)) / n);
        intervals.push(interval(`range:${lane}:${reason.replace('/', '-')}${i}`, reason, end - chunk, end, `lane-${lane}`));
      }
    }
  }
  return ledger({ intervals, items: flagged ? [item('slice:E2', { attrs: { critical: true } })] : [] });
};

const summed = (input: IFinderLedgerInput, reason: string, lane?: string): number =>
  input.intervals.filter((row) => row.reason === reason && (!lane || row.itemKey.startsWith(`range:${lane}:`)))
    .reduce((sum, row) => sum + (row.end - row.start), 0) / HOUR;

describe('the constraint (AC 2, consult 03 A1)', () => {
  const RUN = CRITICAL_FIXTURE.F1.days * DAY;

  it('(a) F1 over the 7.22-day run names not-armed on the critical basis (343.0 h against lock-busy 159.6 h)', () => {
    const input = tableFixture(CRITICAL_FIXTURE.F1.hours, RUN, true);
    expect(summed(input, 'not-armed', 'E2')).toBeCloseTo(343.0, 1);
    expect(summed(input, 'land-queue/lock-busy', 'E2')).toBeCloseTo(159.6, 1);
    expect(deriveConstraint(input, null, null, null, NOW).constraint).toMatchObject({ reason: 'not-armed', basis: 'critical' });
  });

  it('(b) F1 with every critical flag removed names not-armed on all items (3,796.4 h against 1,438.8 h)', () => {
    const input = tableFixture(CRITICAL_FIXTURE.F1.hours, RUN, false);
    expect(summed(input, 'not-armed')).toBeCloseTo(3796.4, 1);
    expect(summed(input, 'land-queue/lock-busy')).toBeCloseTo(1438.8, 1);
    expect(deriveConstraint(input, null, null, null, NOW).constraint).toMatchObject({ reason: 'not-armed', basis: 'all' });
  });

  it('(c) F2 inside one 24 h window names not-armed on both bases', () => {
    const critical = deriveConstraint(tableFixture(CRITICAL_FIXTURE.F2.hours, DAY, true), null, null, null, NOW);
    expect(critical.constraint).toMatchObject({ reason: 'not-armed', basis: 'critical' });
    expect(critical.constraint!.waitingHours).toBeCloseTo(120.6, 1);
    const all = deriveConstraint(tableFixture(CRITICAL_FIXTURE.F2.hours, DAY, false), null, null, null, NOW);
    expect(all.constraint).toMatchObject({ reason: 'not-armed', basis: 'all' });
    expect(all.constraint!.waitingHours).toBeCloseTo(709.3, 1);
    const day = all.windows[1].byReason;
    expect([day[1].key, day[1].waitingHours]).toEqual(['pre-flight-gate', expect.closeTo(94.0, 1)]);
    const criticalOnly = Object.fromEntries(Object.entries(CRITICAL_FIXTURE.F2.hours).map(([reason, split]) => [reason, { critical: split.critical, other: 0 }]));
    const criticalDay = deriveConstraint(tableFixture(criticalOnly, DAY, true), null, null, null, NOW).windows[1].byReason;
    expect(criticalDay.slice(0, 2).map((row) => [row.key, row.waitingHours]))
      .toEqual([['not-armed', expect.closeTo(120.6, 1)], ['pre-flight-gate', expect.closeTo(37.9, 1)]]);
  });

  it('(d) the lane section alone, no critical flag, names land-queue/lock-busy on all items (regression: the section cut)', () => {
    const result = deriveConstraint(decomposeFixture(), null, null, null, NOW);
    expect(result.constraint).toMatchObject({
      reason: 'land-queue/lock-busy', stage: 'land', basis: 'all', labels: { reason: 'landing queue, lock busy', stage: 'landing', trend: 'steady' },
    });
    const day = result.windows[1].byReason;
    expect([day[0].key, day[1].key]).toEqual(['land-queue/lock-busy', 'not-armed']);
  });

  it('(e) critical items leading on lock-busy while all items lead on not-armed names lock-busy, basis critical', () => {
    const result = deriveConstraint(tableFixture({
      'land-queue/lock-busy': { critical: 6, other: 1 }, 'not-armed': { critical: 2, other: 40 },
    }, DAY, true), null, null, null, NOW);
    expect(result.constraint).toMatchObject({ reason: 'land-queue/lock-busy', basis: 'critical', waitingHours: 6 });
    expect(result.windows[1].byReason[0].key).toBe('not-armed');
  });

  it('a range is critical when the slice its own key names is, even when its parent is another slice', () => {
    const items = [
      item('slice:E2', { attrs: { critical: true } }),
      item('slice:fold46'),
      item('range:E2:0123456789ab', { parentKey: 'slice:fold46' }),
      item('range:X1:0123456789ab', { parentKey: 'slice:fold46' }),
    ];
    expect([...criticalKeys(items, ['range:E2:aaaaaaaaaaaa', 'gate:E2:1'])].sort())
      .toEqual(['range:E2:0123456789ab', 'range:E2:aaaaaaaaaaaa', 'slice:E2']);
  });

  it('on critical items when any critical item waited in 24 h, else on all items', () => {
    const intervals = [
      interval('range:a:1', 'not-armed', NOW - 10 * HOUR, NOW - HOUR, 'lane-a'),
      interval('range:b:1', 'lock-wait', NOW - 3 * HOUR, NOW - HOUR, 'lane-b'),
    ];
    const plain = deriveConstraint(ledger({ intervals }), null, null, null, NOW);
    expect(plain.constraint).toMatchObject({ reason: 'not-armed', basis: 'all', waitingHours: 9, ownerSeat: 'lane-a' });
    const items = [
      item('slice:b', { attrs: { critical: true } as Record<string, TLedgerAttrValue> }),
      item('range:b:1', { parentKey: 'slice:b', closedAt: NOW - HOUR }),
      item('range:a:1', { closedAt: NOW - HOUR }),
    ];
    const critical = deriveConstraint(ledger({ intervals, items }), null, null, null, NOW);
    expect(critical.constraint).toMatchObject({ reason: 'lock-wait', basis: 'critical', waitingHours: 2, ownerSeat: 'lane-b', items: 1 });
  });

  it('counts open waits; owner and clear input weighted by open waiting hours, ties by name', () => {
    const result = deriveConstraint(ledger({
      items: [
        item('range:a:1', { waitReason: 'review-findings', waitSince: NOW - 3 * HOUR, holder: 'lane-a', clearInput: 'fix F1' }),
        item('range:a:2', { waitReason: 'review-findings', waitSince: NOW - 2 * HOUR, holder: 'lane-b', clearInput: 'answer the review' }),
        item('range:a:3', { waitReason: 'review-findings', waitSince: NOW - HOUR, holder: 'lane-b', clearInput: 'answer the review' }),
      ],
    }), null, null, null, NOW);
    expect(result.constraint).toMatchObject({
      reason: 'review-findings', stage: 'build-review', waitingHours: 6, trend: 'new', ownerSeat: 'lane-a', clearInput: 'answer the review', items: 3,
    });
    expect(result.stuck.map((s) => s.key)).toEqual(['range:a:1', 'range:a:2', 'range:a:3']);
    expect(result.stuck[0]).toEqual({
      key: 'range:a:1', itemType: 'range', holder: 'lane-a', reason: 'review-findings', since: NOW - 3 * HOUR, clearInput: 'fix F1', critical: false,
      reasonLabel: 'review findings open',
    });
  });

  it('is null when nothing waited in 24 h', () => {
    const result = deriveConstraint(ledger({ intervals: [interval('range:a:1', 'not-armed', NOW - 50 * HOUR, NOW - 40 * HOUR)] }), null, null, null, NOW);
    expect(result.constraint).toBeNull();
    expect(result.line).toBe('no goal set · items left — · no constraint: nothing waited in 24 h');
  });
});

describe('missing inputs (AC 7)', () => {
  it('shows no flow record, an indexing spend and no pool as unknown, never 0', () => {
    const indexing: IFinderSpendInput = { ...READY_SPEND, index: { ...READY_SPEND.index, state: 'indexing' } };
    const result = deriveConstraint(ledger(), null, indexing, null, NOW);
    expect(result.inputs.flow).toEqual({ state: 'unknown', reason: 'no flow record published', at: null });
    expect(result.inputs.spend).toEqual({ state: 'unknown', reason: 'spend index indexing', at: NOW - MIN });
    expect(result.inputs.pool).toEqual({ state: 'unknown', reason: 'no pool published', at: null });
    expect(result.flowLocks).toBeNull();
    expect(result.pool).toBeNull();
  });

  it('shows the ledger unreadable as unknown: no constraint, no windows, every anomaly unknown', () => {
    const result = deriveConstraint(null, flowRecord(NOW - MIN), READY_SPEND, { hosts: [{ name: 'mdserver1', slotsUsed: 2, slotsTotal: 8 }] }, NOW);
    expect(result.inputs.ledger).toEqual({ state: 'unknown', reason: 'ledger unreadable', at: null });
    expect(result.constraint).toBeNull();
    expect(result.windows).toEqual([]);
    expect(result.unknownShare).toBeNull();
    expect(result.anomalies).toHaveLength(12);
    for (const a of result.anomalies) expect(a).toMatchObject({ value: null, breached: false, reason: 'ledger unreadable' });
    expect(result.line).toBe('no goal set · items left — · constraint unknown (ledger unreadable)');
    expect(result.inputs.flow.state).toBe('ok');
    expect(result.flowLocks).toEqual([{ name: 'landing', heldBy: 'lane-a', since: NOW - 6 * MIN }]);
    expect(result.pool).toEqual({ hosts: [{ name: 'mdserver1', slotsUsed: 2, slotsTotal: 8 }], slotsUsed: 2, slotsTotal: 8 });
  });

  it('shows a ledger holding no event for the workspace as unknown, not as nothing waited (F1)', () => {
    const result = deriveConstraint(ledger({ firstEventAt: null }), null, null, null, NOW);
    expect(result.inputs.ledger).toEqual({ state: 'unknown', reason: 'the ledger holds no event for this workspace', at: null });
    expect(result.constraint).toBeNull();
    expect(result.stuck).toEqual([]);
    expect(result.line).toBe('no goal set · items left — · constraint unknown (the ledger holds no event for this workspace)');
    expect(result.anomalies.map((a) => [a.id, a.value, a.reason])).toEqual([
      're-gates', 'rework-rate', 'context-per-call', 'wakes-per-hour', 'unknown-share', 'producer-silence', 'cost-per-landed-item', 'cache-read-per-landed-item',
      'seat-compactions', 'rotation-alarm', 'handoff-undelivered', 'owner-found-defects',
    ].map((id) => [id, null, 'the ledger holds no event for this workspace']));
    expect(result.anomalies.map((a) => [a.id, a.threshold, a.judged])).toEqual([
      ['re-gates', 0, false], ['rework-rate', 0.1, false], ['context-per-call', 300_000, false], ['wakes-per-hour', 6, false],
      ['unknown-share', 0.05, false], ['producer-silence', null, false], ['cost-per-landed-item', null, false], ['cache-read-per-landed-item', null, false],
      ['seat-compactions', 0, false], ['rotation-alarm', 1, false], ['handoff-undelivered', 0, false], ['owner-found-defects', null, false],
    ]);
    expect(result.anomalies.find((a) => a.id === 'wakes-per-hour')!.text)
      .toBe('wakes per hour: unknown (the ledger holds no event for this workspace) in 6h, threshold 6.0/h');
    const ok = deriveConstraint(ledger(), null, null, null, NOW);
    expect(ok.inputs.ledger.state).toBe('ok');
    expect(ok.line).toBe('no goal set · items left — · no constraint: nothing waited in 24 h');
  });

  it('shows a spend index that answers with an error as partial, with the reason', () => {
    const partial = { ...READY_SPEND, index: { ...READY_SPEND.index, error: 'session-tabs.json unreadable; no usage is attributed to a tab' } };
    expect(deriveConstraint(ledger(), null, partial, null, NOW).inputs.spend)
      .toEqual({ state: 'partial', reason: 'session-tabs.json unreadable; no usage is attributed to a tab', at: NOW - MIN });
  });

  it('shows a stale flow as stale', () => {
    expect(deriveConstraint(ledger(), flowRecord(NOW - 11 * MIN), null, null, NOW).inputs.flow.state).toBe('stale');
  });

  it('with no goal, the on-track line is at-risk with nothing forecast (story 08 contract)', () => {
    const result = deriveConstraint(ledger(), null, null, null, NOW);
    expect(result.onTrack).toEqual({ state: 'at-risk', goal: null, goalState: 'none', itemsLeft: null, p50At: null, p90At: null, throughputPerDay: null, reason: 'no goal set' });
  });
});

describe('board line (AC 5)', () => {
  it('prints goal, items left, constraint and trend on one line', () => {
    const line = boardLine({ state: 'on-track', goal: 'Walking skeleton', goalState: 'set', itemsLeft: 12, p50At: null, p90At: null, throughputPerDay: null, reason: null }, {
      reason: 'land-queue/lock-busy', stage: 'land', waitingHours: 14.25, trend: 'up', ownerSeat: 'v2-kit', clearInput: null, basis: 'all', items: 3,
      labels: { reason: 'landing queue, lock busy', stage: 'landing', trend: 'rising' },
    }, null);
    expect(line).toBe('Walking skeleton · 12 items left · constraint: landing queue, lock busy, 14.3 h in 24 h · rising');
    expect(line).not.toContain('\n');
  });
});

describe('anomalies (AC 3): each names its measured value and threshold', () => {
  const find = (result: ReturnType<typeof deriveConstraint>, id: string, subject = 'workspace') =>
    result.anomalies.find((a) => a.id === id && a.subject === subject)!;

  const gate = (tree: string, started: number, extra: Partial<ILedgerItem> = {}) =>
    item(`gate:${tree}:${started}`, { openedAt: started, ...extra });

  it('re-gates: a gate on a tree a same-or-wider gate already passed; reused gates never count', () => {
    const items = [
      gate('t1', NOW - 30 * HOUR, { closedAt: NOW - 29 * HOUR, state: 'pass', attrs: { mode: 'full' } }),
      gate('t1', NOW - 2 * HOUR, { closedAt: NOW - HOUR, state: 'pass', attrs: { mode: 'affected' } }),
      gate('t1', NOW - 50 * MIN, { attrs: { mode: 'reused' } }),
      gate('t2', NOW - 5 * HOUR, { closedAt: NOW - 4 * HOUR, state: 'pass', attrs: { mode: 'affected' } }),
      gate('t2', NOW - 3 * HOUR, { closedAt: NOW - 2 * HOUR, state: 'pass', attrs: { mode: 'full' } }),
      gate('t3', NOW - 5 * HOUR, { closedAt: NOW - 4 * HOUR, state: 'fail' }),
      gate('t3', NOW - 3 * HOUR, { attrs: { verdict: 'pass' } }),
      gate('t3', NOW - 2 * HOUR),
      gate('t4', NOW - 5 * HOUR, { closedAt: NOW - 4 * HOUR, state: 'pass' }),
      gate('t4', NOW - 3 * HOUR, { attrs: { mode: 'full' } }),
    ];
    const re = find(deriveConstraint(ledger({ items }), null, null, null, NOW), 're-gates');
    expect(re).toMatchObject({ value: 2, threshold: 0, unit: 'gates', breached: true, window: '24h' });
    expect(re.text).toBe('re-gates: 2 gates (25% of 8 gates) in 24h, threshold 0 gates');
  });

  it('re-gates: unknown with no gate item, 0 when no gate repeats', () => {
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 're-gates'))
      .toMatchObject({ value: null, breached: false, reason: 'no gate item in the ledger' });
    const once = find(deriveConstraint(ledger({ items: [gate('t1', NOW - HOUR, { closedAt: NOW - 50 * MIN, state: 'pass' })] }), null, null, null, NOW), 're-gates');
    expect(once).toMatchObject({ value: 0, breached: false });
  });

  it('rework rate: reworked closed ranges over closed ranges; not flagged under 10 closed', () => {
    const closed = (n: number) => Array.from({ length: n }, (_, i) => item(`range:a:${i}`, { closedAt: NOW - HOUR, state: 'landed' }));
    const rework = (keys: string[]) => keys.map((key) => interval(key, 'rework', NOW - 3 * HOUR, NOW - 2 * HOUR));
    const ten = find(deriveConstraint(ledger({ items: closed(10), intervals: rework(['range:a:0', 'range:a:1']) }), null, null, null, NOW), 'rework-rate');
    expect(ten).toMatchObject({ value: 0.2, threshold: 0.1, breached: true, reason: null });
    expect(ten.text).toBe('rework rate: 20.0% of 10 closed ranges in 24h, threshold 10.0%');
    const few = find(deriveConstraint(ledger({ items: closed(4), intervals: rework(['range:a:0', 'range:a:1']) }), null, null, null, NOW), 'rework-rate');
    expect(few).toMatchObject({ value: 0.5, breached: false, reason: 'n<10: not flagged' });
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 'rework-rate')).toMatchObject({ value: null, reason: 'no range closed' });
  });

  it('context per call: a seat above its rotate threshold, default 300,000', () => {
    const items = [
      item('seat:ws-a:orchestrator', { attrs: { contextTokens: 540_000 } }),
      item('seat:ws-a:kit', { attrs: { contextTokens: 250_000, rotateAtTokens: 200_000 } }),
      item('seat:ws-a:sm', { attrs: { contextTokens: 120_000 } }),
      item('seat:ws-a:scope'),
    ];
    const result = deriveConstraint(ledger({ items }), null, null, null, NOW);
    expect(find(result, 'context-per-call', 'seat:ws-a:orchestrator')).toMatchObject({ value: 540_000, threshold: 300_000, breached: true });
    expect(find(result, 'context-per-call', 'seat:ws-a:kit')).toMatchObject({ value: 250_000, threshold: 200_000, breached: true });
    expect(find(result, 'context-per-call', 'seat:ws-a:sm')).toMatchObject({ breached: false });
    expect(find(result, 'context-per-call', 'seat:ws-a:scope')).toMatchObject({ value: null, reason: 'no context reading on the seat' });
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 'context-per-call')).toMatchObject({ value: null, reason: 'no seat item in the ledger' });
  });

  it('seat compactions: a compaction since the last rotation is a missed rotation (ADR-0036 §3)', () => {
    const items = [
      item('seat:ws-a:orchestrator', { attrs: { compactions: 5, compactionsSinceRotation: 2 } }),
      item('seat:ws-a:kit', { attrs: { compactions: 3, compactionsSinceRotation: 0 } }),
      item('seat:ws-a:scope'),
      item('seat:ws-a:old', { closedAt: NOW - HOUR, attrs: { compactionsSinceRotation: 9 } }),
    ];
    const result = deriveConstraint(ledger({ items }), null, null, null, NOW);
    const orch = find(result, 'seat-compactions', 'seat:ws-a:orchestrator');
    expect(orch).toMatchObject({ value: 2, threshold: 0, breached: true });
    expect(orch.text).toBe('seat compactions seat:ws-a:orchestrator: 2 compactions since the last rotation (5 in all), threshold 0 compactions');
    expect(find(result, 'seat-compactions', 'seat:ws-a:kit')).toMatchObject({ value: 0, breached: false });
    expect(find(result, 'seat-compactions', 'seat:ws-a:scope')).toMatchObject({ value: null, reason: 'no compaction count on the seat' });
    expect(result.anomalies.some((a) => a.subject === 'seat:ws-a:old')).toBe(false);
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 'seat-compactions')).toMatchObject({ value: null, reason: 'no seat item in the ledger' });
  });

  it('rotation alarm: a second failed handoff check flags the seat; one does not (ADR-0036 §2)', () => {
    const items = [
      item('seat:ws-a:orchestrator', { state: 'rotation-alarm', attrs: { rotationFailures: 2, rotationAlarm: 'missing heading "## Do not" (expected once)' } }),
      item('seat:ws-a:kit', { state: 'rotate-requested', attrs: { rotationFailures: 1 } }),
      item('seat:ws-a:sm', { attrs: { rotationFailures: 0 } }),
      item('seat:ws-a:scope'),
    ];
    const result = deriveConstraint(ledger({ items }), null, null, null, NOW);
    const orch = find(result, 'rotation-alarm', 'seat:ws-a:orchestrator');
    expect(orch).toMatchObject({ value: 2, threshold: 1, breached: true });
    expect(orch.text).toBe('rotation alarm seat:ws-a:orchestrator: 2 failed handoff checks, the session left as it is: missing heading "## Do not" (expected once)');
    expect(find(result, 'rotation-alarm', 'seat:ws-a:kit')).toMatchObject({ value: 1, breached: false });
    expect(find(result, 'rotation-alarm', 'seat:ws-a:sm')).toMatchObject({ value: 0, breached: false });
    expect(find(result, 'rotation-alarm', 'seat:ws-a:scope')).toMatchObject({ value: null, breached: false, judged: false, reason: 'no rotation record on the seat' });
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 'rotation-alarm')).toMatchObject({ value: null, reason: 'no seat item in the ledger' });
  });

  it('handoff not delivered: a rotated seat whose first message was dropped is flagged until a later one is delivered (ADR-0036)', () => {
    const items = [
      item('seat:ws-a:orchestrator', { attrs: { handoffUndeliveredAt: Date.UTC(2026, 10, 3, 9, 30) } }),
      item('seat:ws-a:kit', { attrs: { handoffUndeliveredAt: null } }),
    ];
    const result = deriveConstraint(ledger({ items }), null, null, null, NOW);
    const orch = find(result, 'handoff-undelivered', 'seat:ws-a:orchestrator');
    expect(orch).toMatchObject({ value: 1, threshold: 0, breached: true });
    expect(orch.text).toBe('handoff not delivered seat:ws-a:orchestrator: rotated but the handoff was not delivered (first message dropped 2026-11-03T09:30:00Z)');
    expect(find(result, 'handoff-undelivered', 'seat:ws-a:kit')).toMatchObject({ value: 0, breached: false });
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 'handoff-undelivered')).toMatchObject({ value: null, reason: 'no seat item in the ledger' });
  });

  it('wakes per hour per seat: deliveries over 6 h against 6/h; unknown with no tab event at all', () => {
    const result = deriveConstraint(ledger({ tabWakes: [{ tabId: 'tab-orch', wakes: 42 }, { tabId: 'tab-kit', wakes: 6 }] }), null, null, null, NOW);
    expect(find(result, 'wakes-per-hour', 'tab-orch')).toMatchObject({ value: 7, threshold: 6, breached: true, window: '6h' });
    expect(find(result, 'wakes-per-hour', 'tab-kit')).toMatchObject({ value: 1, breached: false });
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 'wakes-per-hour')).toMatchObject({ value: null, reason: 'no tab event recorded' });
    expect(find(deriveConstraint(ledger({ tabWakes: [] }), null, null, null, NOW), 'wakes-per-hour')).toMatchObject({ value: 0, breached: false });
  });

  it('unknown share: unknown hours over all waiting hours on range, deploy and owner-issue, above 5%', () => {
    const result = deriveConstraint(ledger({
      intervals: [
        interval('range:a:1', 'not-armed', NOW - 10 * HOUR, NOW - HOUR),
        interval('gate:t:1', 'gate-slot', NOW - 10 * HOUR, NOW - HOUR),
      ],
      items: [item('range:a:2', { waitReason: 'unknown', waitSince: NOW - HOUR })],
    }), null, null, null, NOW);
    expect(result.unknownShare).toBeCloseTo(0.1);
    expect(find(result, 'unknown-share')).toMatchObject({ threshold: 0.05, breached: true, unit: 'share' });
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 'unknown-share')).toMatchObject({ value: null, breached: false });
  });

  it('producer silence: max(10 min, 2 x p90 of the type lifetimes); unknown under 20 closed of the type', () => {
    const closedGates = Array.from({ length: 20 }, (_, i) => gate(`c${i}`, NOW - 2 * DAY - 15 * MIN, { closedAt: NOW - 2 * DAY, state: 'pass' }));
    const items = [
      ...closedGates,
      gate('live', NOW - 40 * MIN, { lastEventAt: NOW - 35 * MIN }),
      gate('fresh', NOW - 20 * MIN, { lastEventAt: NOW - 20 * MIN }),
      item('landing:1', { openedAt: NOW - 3 * HOUR, lastEventAt: NOW - 3 * HOUR }),
      item('range:a:9', { lastEventAt: NOW - 3 * HOUR }),
      item('gate:w:1', { lastEventAt: NOW - 3 * HOUR, waitReason: 'gate-slot', waitSince: NOW - 3 * HOUR }),
    ];
    const result = deriveConstraint(ledger({
      items, lastProducer: { [`gate:live:${NOW - 40 * MIN}`]: 'gate.sh', [`gate:fresh:${NOW - 20 * MIN}`]: 'gate.sh', 'landing:1': 'land.sh' },
    }), null, null, null, NOW);
    const gateSh = find(result, 'producer-silence', 'gate.sh/gate');
    expect(gateSh).toMatchObject({ value: 35, threshold: 30, breached: true, window: 'now' });
    expect(gateSh.text).toBe(`producer silence gate.sh/gate: gate:live:${NOW - 40 * MIN} silent for 35 min (threshold 30 min)`);
    expect(find(result, 'producer-silence', 'land.sh/landing')).toMatchObject({
      value: 180, threshold: null, breached: false, reason: 'fewer than 20 landing items closed in 7 d: not flagged',
    });
    expect(result.anomalies.filter((a) => a.id === 'producer-silence').map((a) => a.subject)).toEqual(['gate.sh/gate', 'land.sh/landing']);
  });

  it('cost per landed item: 7 d spend over the spend input\'s landed ranges; unknown while spend indexes, nothing landed or landings are unknown', () => {
    expect(find(deriveConstraint(ledger(), null, READY_SPEND, null, NOW), 'cost-per-landed-item'))
      .toMatchObject({ value: 60, threshold: null, breached: false, unit: 'USD', reason: null,
        text: 'cost per landed item: $60.00 over 2 landed ranges in 7d, no threshold' });
    const indexing = { ...READY_SPEND, index: { ...READY_SPEND.index, state: 'indexing' as const } };
    expect(find(deriveConstraint(ledger(), null, indexing, null, NOW), 'cost-per-landed-item'))
      .toMatchObject({ value: null, reason: 'spend index indexing' });
    expect(find(deriveConstraint(ledger(), null, { ...READY_SPEND, landedRanges: 0 }, null, NOW), 'cost-per-landed-item'))
      .toMatchObject({ value: null, reason: 'no range landed' });
    expect(find(deriveConstraint(ledger(), null, { ...READY_SPEND, landedRanges: null }, null, NOW), 'cost-per-landed-item'))
      .toMatchObject({ value: null, reason: 'landed ranges not read from the ledger' });
    const partial = { ...READY_SPEND, index: { ...READY_SPEND.index, error: 'session-tabs.json unreadable' } };
    expect(find(deriveConstraint(ledger(), null, partial, null, NOW), 'cost-per-landed-item'))
      .toMatchObject({ value: 60, reason: 'spend partial: session-tabs.json unreadable' });
  });

  it('cache reads per landed item: reads story 04\'s metric, reported and never flagged; its reason when not measured', () => {
    expect(find(deriveConstraint(ledger(), null, READY_SPEND, null, NOW), 'cache-read-per-landed-item'))
      .toMatchObject({ value: 500_000, threshold: null, breached: false, unit: 'tokens', window: '7d', reason: null });
    const none = { ...READY_SPEND, cacheReadTokensPerLandedItem: { ...READY_SPEND.cacheReadTokensPerLandedItem, landedItems: null, value: null,
      reason: 'the ledger holds no items for this workspace yet' } };
    expect(find(deriveConstraint(ledger(), null, none, null, NOW), 'cache-read-per-landed-item'))
      .toMatchObject({ value: null, reason: 'the ledger holds no items for this workspace yet' });
    expect(find(deriveConstraint(ledger(), null, null, null, NOW), 'cache-read-per-landed-item')).toMatchObject({ value: null, reason: 'spend not read' });
  });

  it('every anomaly carries a threshold field and a text naming value and threshold', () => {
    const result = deriveConstraint(ledger(), null, null, null, NOW);
    expect(result.anomalies.map((a) => a.id)).toEqual([
      're-gates', 'rework-rate', 'context-per-call', 'wakes-per-hour', 'unknown-share', 'producer-silence', 'cost-per-landed-item', 'cache-read-per-landed-item',
      'seat-compactions', 'rotation-alarm', 'handoff-undelivered', 'owner-found-defects',
    ]);
    for (const a of result.anomalies) expect(a.text).toMatch(/threshold|no threshold/);
  });
});

describe('owner-found defects (story 35)', () => {
  const SINCE = NOW - 7 * DAY;
  const live = { firstReceivedAt: NOW - 10 * DAY, lastReceivedAt: NOW - MIN };
  /** The fixed feed's shape: every item carries `attrs.raisedAt` (here its open time) unless a test says otherwise. */
  const issue = (id: string, openedAt: number, extra: Partial<ILedgerItem> = {}) =>
    item(`owner-issue:${id}`, { openedAt, attrs: { raisedAt: openedAt }, ...extra });
  const source = (items: ILedgerItem[], extra: Partial<IFinderOwnerIssueSource> = {}, producer = 'v2'): IFinderOwnerIssueSource => ({
    producerOf: new Map(items.map((it) => [it.itemKey, producer])), newestProducer: producer,
    receipts: new Map([[producer, live]]), earliestOpenedAt: Math.min(NOW - 10 * DAY, ...items.map((it) => it.openedAt)), anyRaisedAt: true,
    ...extra,
  });
  const defects = (items: ILedgerItem[], src: IFinderOwnerIssueSource | null = source(items)) =>
    deriveConstraint(ledger({ items, ownerIssueSource: src }), null, null, null, NOW).anomalies.find((a) => a.id === 'owner-found-defects')!;

  it('is null with its reason when the ledger holds no owner-issue item; reported, never flagged', () => {
    expect(defects([], null)).toEqual({
      id: 'owner-found-defects', subject: 'workspace', value: null, unit: 'a day', threshold: null, judged: false, breached: false,
      window: '7d', reason: 'no owner-issue item in the ledger',
      text: 'defects you found: unknown (no owner-issue item in the ledger) in 7d, no threshold',
    });
  });

  it('counts the items raised in the last 7 days, open or closed, divided by 7', () => {
    const items = [
      issue('a', NOW - HOUR), issue('b', NOW - DAY, { closedAt: NOW - HOUR, state: 'closed' }), issue('c', SINCE + 1),
      issue('d', SINCE), issue('e', NOW - 9 * DAY), issue('f', NOW + MIN), item('range:x:1', { openedAt: NOW - HOUR }),
    ];
    const a = defects(items);
    expect(a).toMatchObject({ value: 3 / 7, threshold: null, judged: false, breached: false, reason: null });
    expect(a.text).toBe('defects you found: 0.4 a day (3 raised) in 7d, no threshold');
  });

  it('reports a real 0 when the source is live and covers the window', () => {
    expect(defects([issue('old', NOW - 9 * DAY)])).toMatchObject({ value: 0, reason: null });
  });

  it('dates an item by attrs.raisedAt, not by when the feed first saw it (consult Q2)', () => {
    const items = [
      issue('seen-late', NOW - HOUR, { attrs: { raisedAt: NOW - 9 * DAY } }),
      issue('raised-2d', NOW - HOUR, { attrs: { raisedAt: NOW - 2 * DAY } }),
    ];
    expect(defects(items)).toMatchObject({ value: 1 / 7, reason: null });
  });

  it('is null when the producer of the newest item received no event in 24 h', () => {
    const items = [issue('a', NOW - HOUR)];
    expect(defects(items, source(items, { receipts: new Map([['v2', { ...live, lastReceivedAt: NOW - DAY }]]) })))
      .toMatchObject({ value: null, reason: 'owner-issue producer silent' });
    expect(defects(items, source(items, { receipts: new Map([['v2', { ...live, lastReceivedAt: NOW - DAY + 1 }]]) })))
      .toMatchObject({ value: 1 / 7, reason: null });
  });

  it('picks the newest item by its raised time, else the item opened last in the store', () => {
    const quiet = { firstReceivedAt: NOW - 10 * DAY, lastReceivedAt: NOW - 2 * DAY };
    const items = [issue('late-feed', NOW - HOUR, { attrs: { raisedAt: NOW - 5 * DAY } }), issue('fresh', NOW - 2 * HOUR)];
    const two = (lateFeed: string, fresh: string): IFinderOwnerIssueSource => ({
      producerOf: new Map([['owner-issue:late-feed', lateFeed], ['owner-issue:fresh', fresh]]), newestProducer: lateFeed,
      receipts: new Map([['old-feed', quiet], ['v2', live]]), earliestOpenedAt: NOW - 10 * DAY, anyRaisedAt: true,
    });
    expect(defects(items, two('old-feed', 'v2'))).toMatchObject({ value: 2 / 7, reason: null });
    expect(defects(items, two('v2', 'old-feed'))).toMatchObject({ value: null, reason: 'owner-issue producer silent' });
    const none = { producerOf: new Map(), receipts: new Map([['old-feed', quiet], ['v2', live]]), earliestOpenedAt: NOW - 20 * DAY, anyRaisedAt: true };
    expect(defects([], { ...none, newestProducer: 'old-feed' })).toMatchObject({ value: null, reason: 'owner-issue producer silent' });
    expect(defects([], { ...none, newestProducer: 'v2' })).toMatchObject({ value: 0, reason: null });
  });

  it('is null when the producer is under 7 days old and no item proves the window, unless one does (consult Q1)', () => {
    const young = { firstReceivedAt: NOW - 3 * DAY, lastReceivedAt: NOW - MIN };
    const items = [issue('a', NOW - 3 * DAY), issue('b', NOW - HOUR)];
    const uncovered = source(items, { receipts: new Map([['v2', young]]), earliestOpenedAt: NOW - 3 * DAY });
    expect(defects(items, uncovered)).toMatchObject({ value: null, reason: 'window not covered' });
    expect(defects(items, { ...uncovered, receipts: new Map([['v2', { ...young, firstReceivedAt: SINCE }]]) }))
      .toMatchObject({ value: 2 / 7, reason: null });
    expect(defects(items, { ...uncovered, earliestOpenedAt: SINCE })).toMatchObject({ value: 2 / 7, reason: null });
    const backdated = [...items, issue('c', NOW - HOUR, { attrs: { raisedAt: SINCE } })];
    expect(defects(backdated, { ...uncovered, producerOf: new Map(backdated.map((it) => [it.itemKey, 'v2'])) }))
      .toMatchObject({ value: 2 / 7, reason: null });
  });

  it('is null when an item in reach, or still open, has no raised time; never a count by the feed\'s time (round 2 F1)', () => {
    const missing = { attrs: {} };
    expect(defects([issue('ok', NOW - DAY), issue('seen', NOW - HOUR, missing)]))
      .toMatchObject({ value: null, reason: 'owner-issue raised time missing' });
    expect(defects([issue('ok', NOW - DAY), issue('seen', NOW - HOUR, { ...missing, closedAt: NOW - MIN, state: 'closed' })]))
      .toMatchObject({ value: null, reason: 'owner-issue raised time missing' });
    expect(defects([issue('open-old', NOW - 9 * DAY, missing)])).toMatchObject({ value: null, reason: 'owner-issue raised time missing' });
    expect(defects([issue('closed-old', NOW - 9 * DAY, { ...missing, closedAt: NOW - 8 * DAY, state: 'closed' })]))
      .toMatchObject({ value: 0, reason: null });
    expect(defects([issue('seen', NOW - HOUR, missing), issue('bad', NOW - HOUR, { attrs: { raisedAt: 'x' } })]))
      .toMatchObject({ value: null, reason: 'owner-issue raised time missing' });
    const young = source([issue('seen', NOW - HOUR, missing)], {
      receipts: new Map([['v2', { firstReceivedAt: NOW - 3 * DAY, lastReceivedAt: NOW - MIN }]]), earliestOpenedAt: NOW - 3 * DAY,
    });
    expect(defects([issue('seen', NOW - HOUR, missing)], young)).toMatchObject({ value: null, reason: 'window not covered' });
  });

  it('is null, never 0, when no owner-issue item in the store carries a raised time (architect R1)', () => {
    const undated = [issue('a', NOW - 9 * DAY, { attrs: {}, closedAt: NOW - 8 * DAY, state: 'closed' }),
      issue('b', NOW - 10 * DAY, { attrs: {}, closedAt: NOW - 8 * DAY, state: 'closed' })];
    expect(defects(undated, source(undated, { anyRaisedAt: false }))).toMatchObject({ value: null, reason: 'owner-issue raised time missing' });
    expect(defects(undated, source(undated, { anyRaisedAt: true }))).toMatchObject({ value: 0, reason: null });
  });

  it('is null when an item in reach carries a raised time it cannot read; never a fallback to openedAt', () => {
    for (const raisedAt of ['28 Oct', 1.5, 0, -1, NOW, true]) {
      const items = [issue('ok', NOW - DAY), issue('bad', NOW - HOUR, { attrs: { raisedAt } })];
      expect(defects(items)).toMatchObject({ value: null, reason: 'owner-issue raised time unreadable' });
    }
    const closedLongAgo = { closedAt: NOW - 8 * DAY, state: 'closed', attrs: { raisedAt: 'x' } };
    expect(defects([issue('ok', NOW - DAY), issue('old', NOW - 9 * DAY, closedLongAgo)])).toMatchObject({ value: 1 / 7, reason: null });
    expect(defects([issue('ok', NOW - DAY), issue('old', NOW - 9 * DAY, { attrs: { raisedAt: 'x' } })]))
      .toMatchObject({ value: null, reason: 'owner-issue raised time unreadable' });
    const silentToo = [issue('bad', NOW - HOUR, { attrs: { raisedAt: 'x' } })];
    expect(defects(silentToo, source(silentToo, { receipts: new Map([['v2', { ...live, lastReceivedAt: NOW - 2 * DAY }]]) })))
      .toMatchObject({ value: null, reason: 'owner-issue producer silent' });
  });
});

describe('labels (the owner never reads a token)', () => {
  it('maps every counted reason, stage and trend, and falls back to a neutral word for anything else', async () => {
    const { reasonLabel, stageLabel, trendLabel } = await import('@/lib/constraint-labels');
    const { LEDGER_INTERVAL_REASONS, LEDGER_STAGES } = await import('@/lib/ledger');
    for (const reason of LEDGER_INTERVAL_REASONS) expect(reasonLabel(reason), reason).not.toMatch(/not in the label map/);
    for (const stage of [...LEDGER_STAGES, 'unknown']) expect(stageLabel(stage), stage).not.toMatch(/not in the label map/);
    for (const trend of ['up', 'down', 'flat', 'new', 'unknown']) expect(trendLabel(trend), trend).not.toMatch(/not in the label map/);
    expect(reasonLabel('toString')).toBe('other wait (reason not in the label map)');
    expect(reasonLabel('__proto__')).toBe('other wait (reason not in the label map)');
    expect(stageLabel('constructor')).toBe('other stage (not in the label map)');
  });
});
