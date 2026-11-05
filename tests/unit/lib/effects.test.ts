import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_MIN_OBSERVED, EFFECTS_SOURCE, NEXT_TURN_BOUND_MS, PASTE_SLACK_MS, componentOf, computeEffects, effectCatalog, outcomeOf,
} from '@/lib/effects';
import { FINDER_ANOMALY_IDS } from '@/lib/constraint';
import { LEDGER_WAIT_REASONS } from '@/lib/ledger';
import { WAKE_CLASS_TABLE } from '@/lib/wake-class';
import type { IEffectRow, ITabTurn } from '@/types/effects';
import type { ITabDelivery, ITabEventCount } from '@/types/tab-events';

const WS = 'ws-e';
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 0, 0, 0);
const UNTIL = T0 + 600 * MIN;

let seq = 0;
const delivery = (over: Partial<ITabDelivery> & Pick<ITabDelivery, 'kind' | 'deliveredAt'>): ITabDelivery =>
  ({ seq: ++seq, tabId: 'tab-o', rule: null, digestId: null, ...over });
const turn = (startedAt: number | null, endedAt: number, toolCalls: number | null, tabId = 'tab-o'): ITabTurn =>
  ({ workspaceId: WS, tabId, provider: 'claude', startedAt, endedAt, toolCalls });

interface IRunOptions {
  measuredSince?: number | null;
  exists?: (tab: string) => boolean;
  fired?: ITabEventCount[];
  open?: Array<[string, number | null]>;
  until?: number;
}
const run = (deliveries: ITabDelivery[], turns: ITabTurn[], over: IRunOptions = {}) =>
  computeEffects({
    workspaceId: WS, requestedSince: T0, until: over.until ?? UNTIL, measuredSince: over.measuredSince === undefined ? T0 : over.measuredSince,
    fired: over.fired ?? [], deliveries, turns: [...turns].sort((a, b) => a.endedAt - b.endedAt), openTurns: new Map(over.open ?? []),
    tabExists: over.exists ?? (() => true),
  });
const row = (rows: IEffectRow[], component: string): IEffectRow => rows.find((r) => r.component === component)!;

describe('the effect catalog (AC 1): every component the code can send', () => {
  it('names every routed wake kind, every finder anomaly and every alarm reason, so one that never reached a tab reads 0', () => {
    const catalog = effectCatalog();
    for (const kind of Object.keys(WAKE_CLASS_TABLE).filter((k) => !['flag', 'alarm', 'red-main'].includes(k))) expect(catalog.has(kind), kind).toBe(true);
    for (const id of FINDER_ANOMALY_IDS) expect(catalog.get(`flag:${id}`)?.family).toBe('flag');
    for (const reason of LEDGER_WAIT_REASONS) expect(catalog.get(`alarm:${reason}`)?.family).toBe('flag');
    expect(catalog.get('stalled')?.family).toBe('probe');
    expect(catalog.get('probe-failed')?.family).toBe('probe');

    const { rows } = run([], []);
    expect(row(rows, 'needs-input')).toMatchObject({ fired: 0, delivered: 0, followed: 0, judged: 0, candidate: null, notMeasured: null });
    expect(row(rows, 'alarm:not-armed')).toMatchObject({ delivered: 0, notMeasured: null });
  });

  it('leaves out red-main, a kind nothing routes: a red main reaches a tab as alarm:red-main (review R3)', () => {
    expect(effectCatalog().has('red-main')).toBe(false);
    expect(effectCatalog().get('alarm:red-main')?.family).toBe('flag');
  });

  it('reads a phone-only flag rule as not measured, never 0', () => {
    const { rows } = run([], [], { fired: [{ kind: 'flow', rule: null, count: 3 }] });
    for (const component of ['flow:lock-busy', 'flow:stale', 'fleet:stall', 'fleet:unanswered']) {
      expect(row(rows, component)).toMatchObject({ family: 'phone', fired: null, delivered: null, followed: null, candidate: null });
      expect(row(rows, component).notMeasured).toMatch(/phone/);
    }
  });

  it('names a flag by its rule and an alarm by its reason, a derived reason folded into its parent (review R1)', () => {
    expect(componentOf({ kind: 'alarm', rule: 'not-armed' })).toBe('alarm:not-armed');
    expect(componentOf({ kind: 'alarm', rule: 'land-queue/lock-busy' })).toBe('alarm:land-queue');
    expect(componentOf({ kind: 'alarm', rule: 'land-queue/head-blocked' })).toBe('alarm:land-queue');
    expect(componentOf({ kind: 'flag', rule: 're-gates' })).toBe('flag:re-gates');
    expect(componentOf({ kind: 'flag', rule: null })).toBe('flag');
    expect(componentOf({ kind: 'stalled', rule: 'drain' })).toBe('stalled');
  });

  it('counts a delivery with rule land-queue/lock-busy in the alarm:land-queue row, never in other (review R1)', () => {
    const d = T0 + 30 * MIN;
    const { rows } = run(
      [delivery({ kind: 'alarm', rule: 'land-queue/lock-busy', deliveredAt: d }), delivery({ kind: 'alarm', rule: 'land-queue/head-blocked', deliveredAt: d + 10 * MIN })],
      [turn(d + 1_000, d + MIN, 1), turn(d + 10 * MIN + 1_000, d + 11 * MIN, 0)],
      { fired: [{ kind: 'alarm', rule: 'land-queue/lock-busy', count: 1 }, { kind: 'alarm', rule: 'land-queue/head-blocked', count: 2 }] },
    );
    expect(row(rows, 'alarm:land-queue')).toMatchObject({ fired: 3, delivered: 2, followed: 1, judged: 2 });
    expect(rows.filter((r) => r.family === 'other')).toEqual([]);
  });

  it('states in its source that followed is temporal, delivered 0 is not "never fired", and probes count per kind (R4, R9)', () => {
    expect(EFFECTS_SOURCE).toMatch(/not of what the delivery caused/);
    expect(EFFECTS_SOURCE).toMatch(/0 = never reached a tab, not never fired/);
    expect(EFFECTS_SOURCE).toMatch(/within 30 s/);
    expect(EFFECTS_SOURCE).toMatch(/per-probe effect is not measured, counts are per firing kind/);
    expect(EFFECTS_SOURCE).toMatch(/any class but the curator's call log \(ADR-0038\)/);
    expect(NEXT_TURN_BOUND_MS).toBe(30_000);
  });
});

describe('outcomeOf: the recipient\'s next turn', () => {
  const at = T0 + 10 * MIN;
  const later = UNTIL;
  it.each([
    ['followed: the turn the paste started acted', [turn(at + 1_000, at + MIN, 2)], 'followed'],
    ['a prompt-submit up to the slack before the stamp is the paste\'s turn', [turn(at - PASTE_SLACK_MS, at + MIN, 1)], 'followed'],
    ['a turn starting at the bound is still the paste\'s', [turn(at + NEXT_TURN_BOUND_MS, at + MIN, 1)], 'followed'],
    ['a turn that only read', [turn(at + 1_000, at + MIN, 0)], 'acted-not'],
    ['a turn already running', [turn(at - PASTE_SLACK_MS - 1, at + MIN, 4)], 'mid-turn'],
    ['an hours-later turn is another input\'s: the paste started none', [turn(at + 3 * 60 * MIN, at + 4 * 60 * MIN, 5)], 'no-turn'],
    ['a turn that ended before the paste is not its turn', [turn(at - 2 * MIN, at - 1_000, 3)], 'no-turn'],
    ['a turn whose start was not seen', [turn(null, at + MIN, null)], 'unmeasured'],
    ['a provider that reports no tools', [turn(at + 1_000, at + MIN, null)], 'unmeasured'],
  ] as const)('%s', (_name, turns, expected) => {
    expect(outcomeOf(turns, undefined, at, later, true)).toBe(expected);
  });

  it('reads the turn still open in this server: running is pending, an unseen start unmeasured, an earlier one mid-turn', () => {
    expect(outcomeOf([], at + 2_000, at, later, true)).toBe('pending');
    expect(outcomeOf([], null, at, later, true)).toBe('unmeasured');
    expect(outcomeOf([], at - MIN, at, later, true)).toBe('mid-turn');
    expect(outcomeOf([], at + 10 * MIN, at, later, true)).toBe('no-turn');
  });

  it('waits out the bound before it calls a paste unanswered, and tells a closed tab apart', () => {
    const earlier = [turn(at - 2 * MIN, at - MIN, 1)];
    expect(outcomeOf(earlier, undefined, at, at + NEXT_TURN_BOUND_MS - 1, true)).toBe('pending');
    expect(outcomeOf(earlier, undefined, at, at + NEXT_TURN_BOUND_MS, true)).toBe('no-turn');
    expect(outcomeOf([], undefined, at, later, false)).toBe('closed');
  });

  it('reads a tab with no turn recorded in the window as unmeasured, never as a measured no (post-review F1)', () => {
    expect(outcomeOf([], undefined, at, later, true)).toBe('unmeasured');
  });

  it('takes the first turn to end at or after the paste among many', () => {
    const turns = Array.from({ length: 50 }, (_, i) => turn(T0 + i * MIN, T0 + i * MIN + 30_000, i % 2));
    expect(outcomeOf(turns, undefined, T0 + 21 * MIN - 1_000, later, true)).toBe('followed');
    expect(outcomeOf(turns, undefined, T0 + 22 * MIN - 1_000, later, true)).toBe('acted-not');
  });
});

describe('computeEffects', () => {
  it('counts fired, delivered, followed and the units it cannot judge apart', () => {
    const d = T0 + 30 * MIN;
    const { rows } = run([
      delivery({ kind: 'needs-input', deliveredAt: d }),
      delivery({ kind: 'needs-input', deliveredAt: d + 10 * MIN }),
      delivery({ kind: 'needs-input', deliveredAt: d + 20 * MIN }),
      delivery({ kind: 'needs-input', deliveredAt: d + 40 * MIN, tabId: 'tab-gone' }),
      delivery({ kind: 'needs-input', deliveredAt: d + 50 * MIN, tabId: 'tab-quiet' }),
    ], [turn(d + 1_000, d + MIN, 1), turn(d + 10 * MIN + 1_000, d + 11 * MIN, 0), turn(d + 15 * MIN, d + 25 * MIN, 3)],
    { exists: (tab) => tab !== 'tab-gone', fired: [{ kind: 'needs-input', rule: null, count: 7 }] });
    expect(row(rows, 'needs-input')).toEqual({
      component: 'needs-input', family: 'nudge', fired: 7, delivered: 5, inDigest: 0, followed: 1, judged: 2, noTurn: 0, midTurn: 1,
      pending: 0, closed: 1, unmeasured: 1, candidate: null, candidateReason: '2 deliveries with an observed turn, 10 needed', notMeasured: null,
    });
  });

  it('counts a digest once per component it carried, and gives each the digest\'s outcome', () => {
    const d = T0 + 30 * MIN;
    const { rows } = run([
      delivery({ kind: 'turn-marker', deliveredAt: d, digestId: 'dg1' }),
      delivery({ kind: 'turn-marker', deliveredAt: d, digestId: 'dg1' }),
      delivery({ kind: 'alarm', rule: 'not-armed', deliveredAt: d, digestId: 'dg1' }),
      delivery({ kind: 'turn-marker', deliveredAt: d + 20 * MIN }),
    ], [turn(d + 500, d + MIN, 1), turn(d + 20 * MIN + 500, d + 21 * MIN, 0)]);
    expect(row(rows, 'turn-marker')).toMatchObject({ delivered: 2, inDigest: 1, followed: 1, judged: 2 });
    expect(row(rows, 'alarm:not-armed')).toMatchObject({ delivered: 1, inDigest: 1, followed: 1, judged: 1 });
  });

  it('makes a deletion candidate only of observed turns: 10 observed and none followed (review R4, post-review F1)', () => {
    const d = (i: number) => T0 + (30 + i * 10) * MIN;
    const deliveries = (n: number) => Array.from({ length: n }, (_, i) => delivery({ kind: 'stuck', deliveredAt: d(i) }));
    const observed = (n: number, calls: number) => Array.from({ length: n }, (_, i) => turn(d(i) + 1_000, d(i) + MIN, calls));
    const none = row(run(deliveries(CANDIDATE_MIN_OBSERVED), observed(CANDIDATE_MIN_OBSERVED, 0)).rows, 'stuck');
    expect(none).toMatchObject({ candidate: true, candidateReason: '0 of 10 observed turns acted' });
    expect(row(run(deliveries(CANDIDATE_MIN_OBSERVED), observed(CANDIDATE_MIN_OBSERVED, 1)).rows, 'stuck').candidate).toBe(false);
    const few = row(run(deliveries(CANDIDATE_MIN_OBSERVED - 1), observed(CANDIDATE_MIN_OBSERVED - 1, 0)).rows, 'stuck');
    expect(few).toMatchObject({ candidate: null, candidateReason: '9 deliveries with an observed turn, 10 needed' });
    // 10 pastes the tab answered with no turn (its turns start minutes later): judged, but no observed turn.
    const late = Array.from({ length: CANDIDATE_MIN_OBSERVED }, (_, i) => turn(d(i) + 5 * MIN, d(i) + 6 * MIN, 0));
    const noTurn = row(run(deliveries(CANDIDATE_MIN_OBSERVED), late).rows, 'stuck');
    expect(noTurn).toMatchObject({ judged: 10, noTurn: 10, candidate: null });
    expect(noTurn.candidateReason).toMatch(/no observed turn/);
    // Delivered 0 alone, whatever fired: not measured, never a candidate.
    expect(row(run([], [], { fired: [{ kind: 'stuck', rule: null, count: 40 }] }).rows, 'stuck')).toMatchObject({ fired: 40, delivered: 0, candidate: null });
  });

  it('reads a flag delivered without its rule as not measured, never folded into a rule', () => {
    const { rows } = run([delivery({ kind: 'flag', deliveredAt: T0 + MIN })], [turn(T0 + MIN, T0 + 2 * MIN, 1)]);
    expect(row(rows, 'flag')).toMatchObject({ family: 'flag', delivered: null, followed: null, candidate: null });
    expect(row(rows, 'flag').notMeasured).toMatch(/rule/);
  });

  it('keeps a kind the catalog does not name as other', () => {
    const { rows } = run([delivery({ kind: 'brand-new', deliveredAt: UNTIL - 1_000 })], []);
    expect(row(rows, 'brand-new')).toMatchObject({ family: 'other', delivered: 1, pending: 1 });
  });

  it('clamps the window to the first recorded turn and counts nothing before it', () => {
    const measuredSince = T0 + 100 * MIN;
    const result = run([
      delivery({ kind: 'stuck', deliveredAt: T0 + 50 * MIN }),
      delivery({ kind: 'stuck', deliveredAt: T0 + 150 * MIN }),
    ], [turn(T0 + 150 * MIN + 100, T0 + 151 * MIN, 1)], { measuredSince });
    expect(result).toMatchObject({ since: measuredSince, nextTurnBoundMs: NEXT_TURN_BOUND_MS, candidateMinObserved: CANDIDATE_MIN_OBSERVED });
    expect(row(result.rows, 'stuck')).toMatchObject({ delivered: 1, followed: 1 });
  });

  it('reads every row as not measured when no turn is recorded, or only after the window', () => {
    for (const measuredSince of [null, UNTIL]) {
      const result = run([delivery({ kind: 'stuck', deliveredAt: T0 + MIN })], [], { measuredSince });
      expect(result.since).toBeNull();
      expect(result.rows.every((r) => r.delivered === null && r.fired === null && r.candidate === null && r.notMeasured !== null)).toBe(true);
    }
  });

  it('orders nudges, probes, flags, notices, other, then the phone-only rules', () => {
    const { rows } = run([delivery({ kind: 'brand-new', deliveredAt: T0 + MIN })], []);
    const families = rows.map((r) => r.family);
    expect(families.indexOf('probe')).toBeGreaterThan(families.lastIndexOf('nudge'));
    expect(families.indexOf('phone')).toBeGreaterThan(families.lastIndexOf('other'));
  });
});
