// The constraint finder (ADR-0034, ADR-HFL-02 decision 1). One pure function: no Node import, no
// I/O, no clock. The tick (`constraint-tick.ts`) reads the inputs and caches the answer.
import { onTrackFor } from '@/lib/board-forecast';
import { rangeParts } from '@/lib/chain-down-quiet';
import { reasonLabel, stageLabel, trendLabel } from '@/lib/constraint-labels';
import { isFlowStale } from '@/lib/flow';
import { LEDGER_UNKNOWN_ITEM_TYPES, UNKNOWN_REASON, clippedMs, percentile, stageOfReason } from '@/lib/ledger';
import type {
  IBoardBlocked,
  IBoardConstraint,
  IBoardGoal,
  IBoardOnTrack,
  IBoardStuckItem,
  IFinderAnomaly,
  IFinderInputStatus,
  IFinderLedgerInput,
  IFinderPoolInput,
  IFinderResult,
  IFinderRow,
  IFinderSpendInput,
  IFinderWindowView,
  TFinderAnomalyId,
  TFinderStage,
  TFinderTrend,
  TFinderWindow,
} from '@/types/constraint';
import type { IFlowRecord } from '@/types/flow';
import type { ILedgerItem, TLedgerIntervalReason, TLedgerItemType } from '@/types/ledger';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const FINDER_WINDOWS: ReadonlyArray<{ window: TFinderWindow; ms: number }> = [
  { window: '6h', ms: 6 * HOUR_MS },
  { window: '24h', ms: DAY_MS },
  { window: '7d', ms: 7 * DAY_MS },
];

/** The finder reads twice its widest window: the 7 d window and the one before it, for the trend. */
export const FINDER_LOOKBACK_MS = 14 * DAY_MS;
export const FINDER_WAKES_WINDOW_MS = 6 * HOUR_MS;

/** A change within this share of the previous window is `flat` (architect ruling, story 03 consult). */
export const TREND_FLAT_SHARE = 0.2;
export const STUCK_LIMIT = 50;

/** ADR-HFL-04: fleet config `context.rotate-at-tokens` defaults to 300,000; a seat item may carry its own. */
export const DEFAULT_ROTATE_AT_TOKENS = 300_000;

export const ANOMALY_THRESHOLDS = {
  reGates: 0,
  reworkRate: 0.1,
  reworkMinClosed: 10,
  wakesPerHour: 6,
  unknownShare: 0.05,
  silenceFloorMs: 10 * MINUTE_MS,
  silenceP90Factor: 2,
  silenceMinClosed: 20,
  /** ADR-0036 §3: any compaction since the last rotation. */
  seatCompactions: 0,
  /** ADR-0036 §2: the second failed handoff check of one rotation. */
  rotationFailures: 1,
  /** ADR-0036 §2: a rotated seat whose first message was dropped never read its handoff. */
  handoffUndelivered: 0,
} as const;

/** Open items of these types with no wait are mid-work: their silence is a producer's, not a wait (ADR-0033 §3.3). */
const SILENCE_ITEM_TYPES: readonly TLedgerItemType[] = ['slice', 'gate', 'review', 'landing'];

/** One wait counted in a window: a finished interval, or an open item's elapsed wait up to `now`. */
interface IWaitSpan {
  itemKey: string;
  itemType: TLedgerItemType;
  reason: TLedgerIntervalReason;
  holder: string | null;
  start: number;
  end: number;
  open: boolean;
  clearInput: string | null;
}

const hours = (ms: number): number => Math.round((ms / HOUR_MS) * 100) / 100;

/**
 * The trend of a window against the one before: `unknown` when the ledger's history starts after
 * the previous window began, `new` when that window measured no wait, else up or down beyond 20%.
 */
export const trendOf = (current: number, previous: number, previousSince: number, firstEventAt: number | null): TFinderTrend | null => {
  if (current === 0 && previous === 0) return null;
  if (firstEventAt === null || firstEventAt > previousSince) return 'unknown';
  if (previous === 0) return 'new';
  const change = (current - previous) / previous;
  if (change > TREND_FLAT_SHARE) return 'up';
  if (change < -TREND_FLAT_SHARE) return 'down';
  return 'flat';
};

const isTruthyAttr = (value: unknown): boolean => value === true || value === 1 || value === 'true';

/** The slice a range's own key names: `range:<lane>:<key12>` -> `slice:<lane>`; null for any other key. */
export const ownSliceKey = (itemKey: string): string | null => {
  const [type, lane] = itemKey.split(':');
  return type === 'range' && lane ? `slice:${lane}` : null;
};

/**
 * The critical items among `items` and the extra keys (waits whose item the read did not carry): an
 * item is critical when it, its parent, or the slice its own key names carries `attrs.critical`
 * (v2 `.v2/critical-path`; a fold member's parent is its fold, its own lane may be critical).
 */
export const criticalKeys = (items: readonly ILedgerItem[], extraKeys: Iterable<string> = []): Set<string> => {
  const byKey = new Map(items.map((item) => [item.itemKey, item]));
  const marked = (key: string | null): boolean => {
    const item = key ? byKey.get(key) : undefined;
    return item !== undefined && isTruthyAttr(item.attrs.critical);
  };
  const critical = new Set<string>();
  for (const key of new Set([...byKey.keys(), ...extraKeys])) {
    if (marked(key) || marked(byKey.get(key)?.parentKey ?? null) || marked(ownSliceKey(key))) critical.add(key);
  }
  return critical;
};

const waitSpans = (ledger: IFinderLedgerInput, now: number): IWaitSpan[] => {
  const spans: IWaitSpan[] = ledger.intervals.map((row) => ({ ...row, open: false, clearInput: null }));
  for (const item of ledger.items) {
    if (item.closedAt !== null || item.waitReason === null || item.waitSince === null || item.waitSince >= now) continue;
    spans.push({
      itemKey: item.itemKey, itemType: item.itemType, reason: item.waitReason, holder: item.holder,
      start: item.waitSince, end: now, open: true, clearInput: item.clearInput,
    });
  }
  return spans;
};

interface IAccumulator {
  wip: number;
  waitedMs: number;
  durations: number[];
}

const accumulate = (
  spans: readonly IWaitSpan[], keyOf: (span: IWaitSpan) => string | null, since: number, until: number,
): Map<string, IAccumulator> => {
  const groups = new Map<string, IAccumulator>();
  for (const span of spans) {
    const inside = clippedMs(span.start, span.end, since, until);
    const finishedInside = !span.open && span.end > since && span.end <= until;
    const openNow = span.open && span.end === until;
    const key = keyOf(span);
    if (key === null || (inside === 0 && !finishedInside && !openNow)) continue;
    let acc = groups.get(key);
    if (!acc) {
      acc = { wip: 0, waitedMs: 0, durations: [] };
      groups.set(key, acc);
    }
    acc.waitedMs += inside;
    if (finishedInside) acc.durations.push(span.end - span.start);
    if (openNow) acc.wip += 1;
  }
  return groups;
};

/** The key with the most waited time; ties go to the name first in order. */
const heaviest = (groups: Map<string, IAccumulator>): string | null => {
  let best: string | null = null;
  for (const [key, acc] of groups) {
    if (acc.waitedMs === 0) continue;
    const top = best === null ? -1 : groups.get(best)!.waitedMs;
    if (acc.waitedMs > top || (acc.waitedMs === top && key < best!)) best = key;
  }
  return best;
};

/** A window's spans before it began: an open wait counts there only for the part before `since`. */
const beforeWindow = (spans: readonly IWaitSpan[], since: number): IWaitSpan[] =>
  spans.filter((span) => span.start < since).map((span) => (span.open ? { ...span, open: false, end: Math.min(span.end, since) } : span));

const rows = (
  spans: readonly IWaitSpan[], keyOf: (span: IWaitSpan) => string, since: number, until: number, firstEventAt: number | null,
): IFinderRow[] => {
  const previousSince = since - (until - since);
  const current = accumulate(spans, keyOf, since, until);
  const previous = accumulate(beforeWindow(spans, since), keyOf, previousSince, since);
  return [...new Set([...current.keys(), ...previous.keys()])].map((key) => {
    const acc = current.get(key) ?? { wip: 0, waitedMs: 0, durations: [] };
    const prevMs = previous.get(key)?.waitedMs ?? 0;
    const sorted = [...acc.durations].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p90 = percentile(sorted, 0.9);
    return {
      key,
      wip: acc.wip,
      waitingHours: hours(acc.waitedMs),
      p50Hours: p50 === null ? null : hours(p50),
      p90Hours: p90 === null ? null : hours(p90),
      throughput: sorted.length,
      trend: trendOf(acc.waitedMs, prevMs, previousSince, firstEventAt),
      previousWaitingHours: hours(prevMs),
    };
  }).sort((a, b) => b.waitingHours - a.waitingHours || a.key.localeCompare(b.key));
};

const stageKey = (span: IWaitSpan): TFinderStage => stageOfReason(span.reason);

const windowView = (spans: readonly IWaitSpan[], ledger: IFinderLedgerInput, window: TFinderWindow, ms: number, now: number): IFinderWindowView => {
  const since = now - ms;
  const closed: Partial<Record<TLedgerItemType, number>> = {};
  for (const item of ledger.items) {
    if (item.closedAt !== null && item.closedAt > since && item.closedAt <= now) closed[item.itemType] = (closed[item.itemType] ?? 0) + 1;
  }
  return {
    window, since, until: now,
    byReason: rows(spans, (span) => span.reason, since, now, ledger.firstEventAt),
    byStage: rows(spans, stageKey, since, now, ledger.firstEventAt),
    closed,
  };
};

/**
 * The reason with the largest summed waiting hours in the last 24 h, on critical items when any
 * critical item waited, else on all items. Owner and clear input are weighted by the open waiting
 * hours under it; with nothing open, the owner is the holder that waited longest in the 24 h.
 */
export const pickConstraint = (
  spans: readonly IWaitSpan[], critical: ReadonlySet<string>, now: number, firstEventAt: number | null,
): IBoardConstraint | null => {
  const since = now - DAY_MS;
  const criticalSpans = spans.filter((span) => critical.has(span.itemKey));
  const basis = criticalSpans.some((span) => clippedMs(span.start, span.end, since, now) > 0) ? 'critical' : 'all';
  const pool = basis === 'critical' ? criticalSpans : spans;
  const byReason = accumulate(pool, (span) => span.reason, since, now);
  const reason = heaviest(byReason) as TLedgerIntervalReason | null;
  if (reason === null) return null;
  const mine = pool.filter((span) => span.reason === reason);
  const waitedMs = byReason.get(reason)!.waitedMs;
  const previousMs = accumulate(beforeWindow(mine, since), () => reason, since - DAY_MS, since).get(reason)?.waitedMs ?? 0;
  const open = mine.filter((span) => span.open);
  const ownerFrom = open.length ? open : mine;
  const stage = stageOfReason(reason);
  const trend = trendOf(waitedMs, previousMs, since - DAY_MS, firstEventAt) ?? 'flat';
  return {
    reason,
    stage,
    waitingHours: hours(waitedMs),
    trend,
    ownerSeat: heaviest(accumulate(ownerFrom, (span) => span.holder, since, now)),
    clearInput: heaviest(accumulate(open, (span) => span.clearInput, since, now)),
    basis,
    items: new Set(mine.filter((span) => clippedMs(span.start, span.end, since, now) > 0).map((span) => span.itemKey)).size,
    labels: { reason: reasonLabel(reason), stage: stageLabel(stage), trend: trendLabel(trend) },
  };
};

/** Items waiting now, oldest wait first; the board caps the list after any holder filter. */
/**
 * Per lane, the latest-opened `range:<lane>:<key>` item the ledger holds (open, or closed in the last 14 days). A
 * range that a later range of its lane follows is superseded: the lane's chain moved on (vel-WATCHDOG-F6-NOISE).
 */
const latestRangeByLane = (items: readonly ILedgerItem[]): Map<string, ILedgerItem> => {
  const latest = new Map<string, ILedgerItem>();
  for (const item of items) {
    const parts = item.itemType === 'range' ? rangeParts(item.itemKey) : null;
    if (!parts) continue;
    const seen = latest.get(parts.lane);
    if (!seen || item.openedAt > seen.openedAt || (item.openedAt === seen.openedAt && item.itemKey > seen.itemKey)) latest.set(parts.lane, item);
  }
  return latest;
};

export const stuckItems = (ledger: IFinderLedgerInput, critical: ReadonlySet<string>): IBoardStuckItem[] => {
  const latest = latestRangeByLane(ledger.items);
  return ledger.items
    .filter((item) => item.closedAt === null && item.waitReason !== null && item.waitSince !== null)
    .map((item) => {
      const parts = item.itemType === 'range' ? rangeParts(item.itemKey) : null;
      const later = parts ? latest.get(parts.lane) : undefined;
      return {
        key: item.itemKey, itemType: item.itemType, holder: item.holder, reason: item.waitReason!, since: item.waitSince!,
        clearInput: item.clearInput, critical: critical.has(item.itemKey), reasonLabel: reasonLabel(item.waitReason!),
        ...(later && later.itemKey !== item.itemKey && later.openedAt > item.openedAt ? { supersededBy: later.itemKey } : {}),
      };
    })
    .sort((a, b) => a.since - b.since || a.key.localeCompare(b.key));
};

const MC_ITEM_PREFIX = 'mc-item:';

/**
 * What each open Mission Control item blocks (ADR-HFL-11 §1): the open items waiting `owner` whose
 * link names `mc-item:<id>`, their summed waiting hours and whether any is critical. An MC item
 * that no ledger item links to has no entry: "not measured", never 0.
 */
export const ownerBlocks = (ledger: IFinderLedgerInput, critical: ReadonlySet<string>, now: number): Record<string, IBoardBlocked> => {
  const waited = new Map<string, { items: number; ms: number; critical: boolean }>();
  for (const item of ledger.items) {
    if (item.closedAt !== null || item.waitReason !== 'owner' || item.waitSince === null) continue;
    if (!item.parentKey?.startsWith(MC_ITEM_PREFIX)) continue;
    const id = item.parentKey.slice(MC_ITEM_PREFIX.length);
    const entry = waited.get(id) ?? { items: 0, ms: 0, critical: false };
    waited.set(id, { items: entry.items + 1, ms: entry.ms + Math.max(0, now - item.waitSince), critical: entry.critical || critical.has(item.itemKey) });
  }
  return Object.fromEntries([...waited].map(([id, entry]) => [id, { items: entry.items, hours: hours(entry.ms), critical: entry.critical }]));
};

/** `unknown` waiting time over all waiting time on the wait-life types, last 24 h; null when nothing waited. */
export const unknownShareOf = (spans: readonly IWaitSpan[], now: number): number | null => {
  const since = now - DAY_MS;
  let all = 0;
  let unknown = 0;
  for (const span of spans) {
    if (!LEDGER_UNKNOWN_ITEM_TYPES.includes(span.itemType)) continue;
    const inside = clippedMs(span.start, span.end, since, now);
    all += inside;
    if (span.reason === UNKNOWN_REASON) unknown += inside;
  }
  return all === 0 ? null : unknown / all;
};

interface IAnomalyContext {
  ledger: IFinderLedgerInput;
  spans: readonly IWaitSpan[];
  spend: IFinderSpendInput | null;
  unknownShare: number | null;
  now: number;
}

const LABELS: Record<TFinderAnomalyId, string> = {
  're-gates': 're-gates',
  'rework-rate': 'rework rate',
  'context-per-call': 'context per call',
  'wakes-per-hour': 'wakes per hour',
  'unknown-share': 'unknown share',
  'producer-silence': 'producer silence',
  'cost-per-landed-item': 'cost per landed item',
  'cache-read-per-landed-item': 'cache reads per landed item',
  'seat-compactions': 'seat compactions',
  'rotation-alarm': 'rotation alarm',
  'handoff-undelivered': 'handoff not delivered',
  'owner-found-defects': 'defects you found',
};

export const FINDER_ANOMALY_IDS = Object.keys(LABELS) as readonly TFinderAnomalyId[];

const WORKSPACE_SUBJECT = 'workspace';

const ANOMALY_WINDOWS: Record<TFinderAnomalyId, IFinderAnomaly['window']> = {
  're-gates': '24h', 'rework-rate': '24h', 'context-per-call': 'now', 'wakes-per-hour': '6h',
  'unknown-share': '24h', 'producer-silence': 'now', 'cost-per-landed-item': '7d', 'cache-read-per-landed-item': '7d',
  'seat-compactions': 'now', 'rotation-alarm': 'now', 'handoff-undelivered': 'now', 'owner-found-defects': '7d',
};

const ANOMALY_UNITS: Record<TFinderAnomalyId, string> = {
  're-gates': 'gates', 'rework-rate': 'share', 'context-per-call': 'tokens', 'wakes-per-hour': 'per hour',
  'unknown-share': 'share', 'producer-silence': 'min', 'cost-per-landed-item': 'USD', 'cache-read-per-landed-item': 'tokens',
  'seat-compactions': 'compactions', 'rotation-alarm': 'failed checks', 'handoff-undelivered': 'rotations',
  'owner-found-defects': 'a day',
};

const formatValue = (value: number, unit: string): string => {
  if (unit === 'share') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'USD') return `$${value.toFixed(2)}`;
  if (unit === 'min') return `${Math.round(value)} min`;
  if (unit === 'tokens') return `${Math.round(value).toLocaleString('en-US')} tokens`;
  if (unit === 'per hour') return `${value.toFixed(1)}/h`;
  if (unit === 'a day') return `${value.toFixed(1)} a day`;
  return `${value} ${unit}`;
};

const anomaly = (
  id: TFinderAnomalyId, window: IFinderAnomaly['window'], unit: string,
  measure: {
    subject?: string; value: number | null; threshold: number | null; reason?: string | null; flaggable?: boolean; detail?: string;
    /** Replaces the generic sentence after the label when the value is known. */
    sentence?: string;
  },
): IFinderAnomaly => {
  const { subject = WORKSPACE_SUBJECT, value, threshold, reason = null, flaggable = true, detail, sentence } = measure;
  const judged = flaggable && value !== null && threshold !== null;
  const breached = judged && value > threshold;
  const who = subject === WORKSPACE_SUBJECT ? '' : ` ${subject}`;
  const limit = threshold === null ? 'no threshold' : `threshold ${formatValue(threshold, unit)}`;
  const span = window === 'now' ? '' : ` in ${window}`;
  const measured = value === null ? `unknown (${reason})` : `${formatValue(value, unit)}${detail ? ` ${detail}` : ''}`;
  const note = value !== null && reason ? `; ${reason}` : '';
  const text = value !== null && sentence ? `${LABELS[id]}${who}: ${sentence}` : `${LABELS[id]}${who}: ${measured}${span}, ${limit}${note}`;
  return { id, subject, value, unit, threshold, judged, breached, window, text, reason };
};

const PASS = 'pass';
const MODE_RANK: Record<string, number> = { affected: 1, full: 2 };

/** A passed gate covers a new one on the same tree when its mode is the same or wider, or either has no mode. */
const covers = (passed: string | null, next: string | null): boolean => {
  if (passed === null || next === null) return true;
  if (passed === next) return true;
  return (MODE_RANK[passed] ?? 0) > (MODE_RANK[next] ?? Number.POSITIVE_INFINITY);
};

const gateMode = (item: ILedgerItem): string | null => (typeof item.attrs.mode === 'string' ? item.attrs.mode : null);
const gateTree = (item: ILedgerItem): string => item.itemKey.split(':')[1] ?? '';

const reGates = ({ ledger, now }: IAnomalyContext): IFinderAnomaly[] => {
  const gates = ledger.items.filter((item) => item.itemType === 'gate');
  if (!gates.length) return [anomaly('re-gates', '24h', 'gates', { value: null, threshold: ANOMALY_THRESHOLDS.reGates, reason: 'no gate item in the ledger' })];
  const since = now - DAY_MS;
  const passed = new Map<string, ILedgerItem[]>();
  for (const gate of gates) {
    if (gate.state !== PASS || gate.closedAt === null) continue;
    const tree = gateTree(gate);
    const list = passed.get(tree) ?? [];
    list.push(gate);
    passed.set(tree, list);
  }
  const recent = gates.filter((gate) => gate.openedAt > since && gate.openedAt <= now && gateMode(gate) !== 'reused');
  const count = recent.filter((gate) => (passed.get(gateTree(gate)) ?? []).some((earlier) => earlier !== gate
    && earlier.closedAt! <= gate.openedAt && covers(gateMode(earlier), gateMode(gate)))).length;
  const share = recent.length ? ` (${Math.round((count / recent.length) * 100)}% of ${recent.length} gates)` : '';
  return [anomaly('re-gates', '24h', 'gates', { value: count, threshold: ANOMALY_THRESHOLDS.reGates, detail: share.trim() || undefined })];
};

const reworkRate = ({ ledger, now }: IAnomalyContext): IFinderAnomaly[] => {
  const since = now - DAY_MS;
  const closed = ledger.items.filter((item) => item.itemType === 'range' && item.closedAt !== null && item.closedAt > since && item.closedAt <= now);
  const threshold = ANOMALY_THRESHOLDS.reworkRate;
  if (!closed.length) return [anomaly('rework-rate', '24h', 'share', { value: null, threshold, reason: 'no range closed' })];
  const reworked = new Set(ledger.intervals.filter((row) => row.reason === 'rework').map((row) => row.itemKey));
  const value = closed.filter((item) => reworked.has(item.itemKey)).length / closed.length;
  const few = closed.length < ANOMALY_THRESHOLDS.reworkMinClosed;
  return [anomaly('rework-rate', '24h', 'share', {
    value, threshold, flaggable: !few, detail: `of ${closed.length} closed ranges`,
    reason: few ? `n<${ANOMALY_THRESHOLDS.reworkMinClosed}: not flagged` : null,
  })];
};

const numberAttr = (item: ILedgerItem, key: string): number | null => {
  const value = item.attrs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const contextPerCall = ({ ledger }: IAnomalyContext): IFinderAnomaly[] => {
  const seats = openSeats(ledger);
  if (!seats.length) {
    return [anomaly('context-per-call', 'now', 'tokens', { value: null, threshold: DEFAULT_ROTATE_AT_TOKENS, reason: 'no seat item in the ledger' })];
  }
  return seats.map((seat) => {
    const value = numberAttr(seat, 'contextTokens');
    return anomaly('context-per-call', 'now', 'tokens', {
      subject: seat.itemKey, value, threshold: numberAttr(seat, 'rotateAtTokens') ?? DEFAULT_ROTATE_AT_TOKENS,
      reason: value === null ? 'no context reading on the seat' : null,
    });
  });
};

const openSeats = (ledger: IFinderLedgerInput): ILedgerItem[] => ledger.items.filter((item) => item.itemType === 'seat' && item.closedAt === null);

/** ADR-0036 §3: a compaction is a missed rotation; the count since the seat's last rotation is flagged above 0. */
const seatCompactions = ({ ledger }: IAnomalyContext): IFinderAnomaly[] => {
  const threshold = ANOMALY_THRESHOLDS.seatCompactions;
  const seats = openSeats(ledger);
  if (!seats.length) return [anomaly('seat-compactions', 'now', 'compactions', { value: null, threshold, reason: 'no seat item in the ledger' })];
  return seats.map((seat) => {
    const value = numberAttr(seat, 'compactionsSinceRotation');
    const total = numberAttr(seat, 'compactions');
    return anomaly('seat-compactions', 'now', 'compactions', {
      subject: seat.itemKey, value, threshold,
      detail: `since the last rotation${total === null ? '' : ` (${total} in all)`}`,
      reason: value === null ? 'no compaction count on the seat' : null,
    });
  });
};

/** ADR-0036 §2: the second failed handoff check of one rotation leaves the session and raises this alarm. */
const rotationAlarm = ({ ledger }: IAnomalyContext): IFinderAnomaly[] => {
  const threshold = ANOMALY_THRESHOLDS.rotationFailures;
  const seats = openSeats(ledger);
  if (!seats.length) return [anomaly('rotation-alarm', 'now', 'failed checks', { value: null, threshold, reason: 'no seat item in the ledger' })];
  return seats.map((seat) => {
    const value = numberAttr(seat, 'rotationFailures');
    const why = typeof seat.attrs.rotationAlarm === 'string' ? seat.attrs.rotationAlarm : null;
    return anomaly('rotation-alarm', 'now', 'failed checks', {
      subject: seat.itemKey, value, threshold,
      reason: value === null ? 'no rotation record on the seat' : null,
      sentence: value !== null && value > threshold ? `${value} failed handoff checks, the session left as it is${why ? `: ${why}` : ''}` : undefined,
    });
  });
};

/** ADR-0036 §2: a seat restarted whose first message was dropped: rotated, but the handoff was not delivered. */
const handoffUndelivered = ({ ledger }: IAnomalyContext): IFinderAnomaly[] => {
  const threshold = ANOMALY_THRESHOLDS.handoffUndelivered;
  const seats = openSeats(ledger);
  if (!seats.length) return [anomaly('handoff-undelivered', 'now', 'rotations', { value: null, threshold, reason: 'no seat item in the ledger' })];
  return seats.map((seat) => {
    const at = numberAttr(seat, 'handoffUndeliveredAt');
    return anomaly('handoff-undelivered', 'now', 'rotations', {
      subject: seat.itemKey, value: at === null ? 0 : 1, threshold,
      sentence: at === null ? undefined : `rotated but the handoff was not delivered (first message dropped ${new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')})`,
    });
  });
};

const wakesPerHour = ({ ledger }: IAnomalyContext): IFinderAnomaly[] => {
  const threshold = ANOMALY_THRESHOLDS.wakesPerHour;
  if (ledger.tabWakes === null) return [anomaly('wakes-per-hour', '6h', 'per hour', { value: null, threshold, reason: 'no tab event recorded' })];
  if (!ledger.tabWakes.length) return [anomaly('wakes-per-hour', '6h', 'per hour', { value: 0, threshold })];
  const hoursInWindow = FINDER_WAKES_WINDOW_MS / HOUR_MS;
  return ledger.tabWakes.map((row) => anomaly('wakes-per-hour', '6h', 'per hour', { subject: row.tabId, value: row.wakes / hoursInWindow, threshold }));
};

const unknownShareAnomaly = ({ unknownShare }: IAnomalyContext): IFinderAnomaly[] => [
  anomaly('unknown-share', '24h', 'share', {
    value: unknownShare, threshold: ANOMALY_THRESHOLDS.unknownShare,
    reason: unknownShare === null ? 'nothing waited on range, deploy or owner-issue' : null,
  }),
];

/** Per item type: max(10 min, 2 x the p90 of lifetimes closed in 7 d), or null under 20 closed items. */
export const silenceThresholds = (items: readonly ILedgerItem[], now: number): Map<TLedgerItemType, number | null> => {
  const thresholds = new Map<TLedgerItemType, number | null>();
  for (const type of SILENCE_ITEM_TYPES) {
    const lifetimes = items
      .filter((item) => item.itemType === type && item.closedAt !== null && item.closedAt > now - 7 * DAY_MS && item.closedAt <= now)
      .map((item) => item.closedAt! - item.openedAt)
      .sort((a, b) => a - b);
    thresholds.set(type, lifetimes.length < ANOMALY_THRESHOLDS.silenceMinClosed
      ? null
      : Math.max(ANOMALY_THRESHOLDS.silenceFloorMs, ANOMALY_THRESHOLDS.silenceP90Factor * percentile(lifetimes, 0.9)!));
  }
  return thresholds;
};

const producerSilence = ({ ledger, now }: IAnomalyContext): IFinderAnomaly[] => {
  const quiet = ledger.items.filter((item) => item.closedAt === null && item.waitReason === null && SILENCE_ITEM_TYPES.includes(item.itemType));
  if (!quiet.length) {
    return [anomaly('producer-silence', 'now', 'min', { value: null, threshold: null, reason: 'no open slice, gate, review or landing item without a wait' })];
  }
  const thresholds = silenceThresholds(ledger.items, now);
  // One anomaly per (producer, item type): thresholds are per type, so a type that cannot be judged
  // (a slice rarely reaches 20 closes in 7 d) never holds up another type's flag (architect CONCERN 03-C1).
  const byPair = new Map<string, ILedgerItem[]>();
  for (const item of quiet) {
    const subject = `${ledger.lastProducer[item.itemKey] ?? 'unknown producer'}/${item.itemType}`;
    const list = byPair.get(subject) ?? [];
    list.push(item);
    byPair.set(subject, list);
  }
  return [...byPair.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([subject, items]) => {
    const threshold = thresholds.get(items[0].itemType) ?? null;
    const pick = items.map((item) => ({ item, silence: now - item.lastEventAt }))
      .sort((a, b) => b.silence - a.silence || a.item.itemKey.localeCompare(b.item.itemKey))[0];
    const silent = `${pick.item.itemKey} silent for ${formatValue(pick.silence / MINUTE_MS, 'min')}`;
    const reason = threshold === null ? `fewer than ${ANOMALY_THRESHOLDS.silenceMinClosed} ${pick.item.itemType} items closed in 7 d: not flagged` : null;
    return anomaly('producer-silence', 'now', 'min', {
      subject,
      value: pick.silence / MINUTE_MS,
      threshold: threshold === null ? null : threshold / MINUTE_MS,
      reason,
      sentence: threshold === null
        ? `${silent} (no threshold: ${reason})`
        : `${silent} (threshold ${formatValue(threshold / MINUTE_MS, 'min')})`,
    });
  });
};

const costPerLandedItem = ({ spend }: IAnomalyContext): IFinderAnomaly[] => {
  const unknown = (reason: string) => [anomaly('cost-per-landed-item', '7d', 'USD', { value: null, threshold: null, reason })];
  if (!spend) return unknown('spend not read');
  if (spend.index.state !== 'ready') return unknown(`spend index ${spend.index.state}`);
  if (spend.costUsd === null) return unknown('a model in the window has no known price');
  // One landed count (ledger-store.landedRanges) over the spend's own UTC days serves this and the cache-read metric.
  const landed = spend.landedRanges;
  if (landed === null) return unknown(spend.cacheReadTokensPerLandedItem.reason ?? 'landed ranges not read from the ledger');
  if (!landed) return unknown('no range landed');
  return [anomaly('cost-per-landed-item', '7d', 'USD', {
    value: spend.costUsd / landed, threshold: null, detail: `over ${landed} landed ranges`,
    reason: spend.index.error ? `spend partial: ${spend.index.error}` : null,
  })];
};

/** Story 04's `cache_read_tokens_per_landed_item` (7 d), reported and never flagged; not measured carries its reason. */
const cacheReadPerLandedItem = ({ spend }: IAnomalyContext): IFinderAnomaly[] => {
  const metric = spend?.cacheReadTokensPerLandedItem;
  return [anomaly('cache-read-per-landed-item', '7d', 'tokens', {
    value: metric ? metric.value : null, threshold: null, flaggable: false,
    reason: metric ? metric.reason : 'spend not read',
    ...(metric && metric.value !== null ? { detail: `over ${metric.landedItems} landed ranges` } : {}),
  })];
};

/**
 * When an owner issue was raised (consult Q2, story 35 round 2): its `attrs.raisedAt` (epoch ms, at most
 * `openedAt`); `missing` when the feed sent none, `unreadable` when it sent one this cannot read.
 */
export const ownerIssueRaisedAt = (item: ILedgerItem): number | 'missing' | 'unreadable' => {
  if (!Object.hasOwn(item.attrs, 'raisedAt')) return 'missing';
  const raised = item.attrs.raisedAt;
  return typeof raised === 'number' && Number.isSafeInteger(raised) && raised > 0 && raised <= item.openedAt ? raised : 'unreadable';
};

/**
 * Story 35: the owner-found defects a day over 7 d, reported and never flagged (the limits live in the
 * improvement seat's candidate table). Null while the source cannot vouch for the whole window
 * (consult Q1): silent for 24 h, or under 7 d old with no item raised before the window; and while
 * an item that could be in the window, or is still open, has no readable raised time.
 */
const ownerFoundDefects = ({ ledger, now }: IAnomalyContext): IFinderAnomaly[] => {
  const unknown = (reason: string) => [anomaly('owner-found-defects', '7d', 'a day', { value: null, threshold: null, flaggable: false, reason })];
  const source = ledger.ownerIssueSource;
  if (!source) return unknown('no owner-issue item in the ledger');
  const since = now - 7 * DAY_MS;
  const issues = ledger.items.filter((item) => item.itemType === 'owner-issue')
    .map((item) => ({ item, raisedAt: ownerIssueRaisedAt(item) }));
  // Without a readable raised time the item orders by `openedAt`: it only picks whose silence is checked, never a count.
  const newest = issues.map(({ item, raisedAt }) => ({ key: item.itemKey, at: typeof raisedAt === 'number' ? raisedAt : item.openedAt }))
    .sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))[0];
  const producer = (newest && source.producerOf.get(newest.key)) ?? source.newestProducer;
  const receipts = source.receipts.get(producer);
  if (!receipts || receipts.lastReceivedAt <= now - DAY_MS) return unknown('owner-issue producer silent');
  const covered = receipts.firstReceivedAt <= since || source.earliestOpenedAt <= since
    || issues.some(({ raisedAt }) => typeof raisedAt === 'number' && raisedAt <= since);
  if (!covered) return unknown('window not covered');
  // A feed that dates no row at all also misses rows raised and closed between its passes: a 0 then is not measured.
  if (!source.anyRaisedAt) return unknown('owner-issue raised time missing');
  // A raised time is never after `openedAt`, so only items opened inside the window can be raised in it. An open
  // item is re-sent on every feed pass, so one without a raised time shows the feed does not date its rows.
  const inReach = issues.filter(({ item }) => item.openedAt > since);
  const judged = issues.filter(({ item }) => item.openedAt > since || item.closedAt === null);
  if (judged.some(({ raisedAt }) => raisedAt === 'missing')) return unknown('owner-issue raised time missing');
  if (judged.some(({ raisedAt }) => raisedAt === 'unreadable')) return unknown('owner-issue raised time unreadable');
  const count = inReach.filter(({ raisedAt }) => typeof raisedAt === 'number' && raisedAt > since && raisedAt <= now).length;
  return [anomaly('owner-found-defects', '7d', 'a day', { value: count / 7, threshold: null, flaggable: false, detail: `(${count} raised)` })];
};

const ANOMALY_RULES: ReadonlyArray<(ctx: IAnomalyContext) => IFinderAnomaly[]> = [
  reGates, reworkRate, contextPerCall, wakesPerHour, unknownShareAnomaly, producerSilence, costPerLandedItem, cacheReadPerLandedItem,
  seatCompactions, rotationAlarm, handoffUndelivered, ownerFoundDefects,
];

const status = (state: IFinderInputStatus['state'], reason: string | null, at: number | null): IFinderInputStatus => ({ state, reason, at });

const flowStatus = (flow: IFlowRecord | null, now: number): IFinderInputStatus => {
  if (!flow) return status('unknown', 'no flow record published', null);
  if (isFlowStale(flow.receivedAt, now)) return status('stale', 'no flow publish in 10 min', flow.receivedAt);
  return status('ok', null, flow.receivedAt);
};

const spendStatus = (spend: IFinderSpendInput | null): IFinderInputStatus => {
  if (!spend) return status('unknown', 'spend not read', null);
  if (spend.index.state !== 'ready') return status('unknown', `spend index ${spend.index.state}`, spend.index.indexedThrough);
  if (spend.index.error) return status('partial', spend.index.error, spend.index.indexedThrough);
  return status('ok', null, spend.index.indexedThrough);
};

/** `ledgerUnknown` is the reason the ledger measures were not taken; null when they were. */
export const boardLine = (onTrack: IBoardOnTrack, constraint: IBoardConstraint | null, ledgerUnknown: string | null): string => {
  const goal = onTrack.goal ?? (onTrack.goalState === 'unknown' ? onTrack.reason ?? 'goal not measured' : 'no goal set');
  const left = onTrack.itemsLeft === null ? 'items left —' : `${onTrack.itemsLeft} items left`;
  if (ledgerUnknown) return `${goal} · ${left} · constraint unknown (${ledgerUnknown})`;
  if (!constraint) return `${goal} · ${left} · no constraint: nothing waited in 24 h`;
  return `${goal} · ${left} · constraint: ${constraint.labels.reason}, ${constraint.waitingHours.toFixed(1)} h in 24 h · ${constraint.labels.trend}`;
};

export const LEDGER_UNREADABLE = 'ledger unreadable';
export const LEDGER_EMPTY = 'the ledger holds no event for this workspace';

/** The thresholds that do not depend on the ledger; producer silence's is derived from it, cost has none. */
const CONSTANT_THRESHOLDS: Record<TFinderAnomalyId, number | null> = {
  're-gates': ANOMALY_THRESHOLDS.reGates,
  'rework-rate': ANOMALY_THRESHOLDS.reworkRate,
  'context-per-call': DEFAULT_ROTATE_AT_TOKENS,
  'wakes-per-hour': ANOMALY_THRESHOLDS.wakesPerHour,
  'unknown-share': ANOMALY_THRESHOLDS.unknownShare,
  'producer-silence': null,
  'cost-per-landed-item': null,
  'cache-read-per-landed-item': null,
  'seat-compactions': ANOMALY_THRESHOLDS.seatCompactions,
  'rotation-alarm': ANOMALY_THRESHOLDS.rotationFailures,
  'handoff-undelivered': ANOMALY_THRESHOLDS.handoffUndelivered,
  'owner-found-defects': null,
};

/** Every anomaly, unknown for the one reason the ledger measures were not taken. */
const unknownAnomalies = (reason: string): IFinderAnomaly[] =>
  FINDER_ANOMALY_IDS.map((id) =>
    anomaly(id, ANOMALY_WINDOWS[id], ANOMALY_UNITS[id], { value: null, threshold: CONSTANT_THRESHOLDS[id], reason }));

/**
 * Name the constraint for one workspace. `ledger` null means the ledger could not be read: every
 * ledger measure is then unknown, never 0. `flow`, `spend` and `pool` null are each shown as unknown.
 */
export const deriveConstraint = (
  ledger: IFinderLedgerInput | null,
  flow: IFlowRecord | null,
  spend: IFinderSpendInput | null,
  pool: IFinderPoolInput | null,
  now: number,
  goal: IBoardGoal | null = null,
  goalError: string | null = null,
): IFinderResult => {
  // An empty ledger is not "nothing waited": no producer has spoken for this workspace yet.
  const ledgerUnknown = !ledger ? LEDGER_UNREADABLE : ledger.firstEventAt === null ? LEDGER_EMPTY : null;
  const inputs = {
    ledger: ledgerUnknown ? status('unknown', ledgerUnknown, null) : status('ok', null, now),
    flow: flowStatus(flow, now),
    spend: spendStatus(spend),
    pool: pool ? status('ok', null, now) : status('unknown', 'no pool published', null),
  };
  const flowLocks = flow ? flow.snapshot.locks.map((lock) => ({ name: lock.name, heldBy: lock.heldBy, since: lock.since })) : null;
  const poolView = pool ? {
    hosts: pool.hosts,
    slotsUsed: pool.hosts.reduce((sum, host) => sum + host.slotsUsed, 0),
    slotsTotal: pool.hosts.reduce((sum, host) => sum + host.slotsTotal, 0),
  } : null;
  if (!ledger || ledgerUnknown) {
    const onTrack = onTrackFor(goal, null, now, goalError);
    return {
      generatedAt: now, onTrack, constraint: null, stuck: [], ownerBlocks: null, windows: [], anomalies: unknownAnomalies(ledgerUnknown!),
      unknownShare: null, inputs, flowLocks, pool: poolView, line: boardLine(onTrack, null, ledgerUnknown),
    };
  }
  const spans = waitSpans(ledger, now);
  const critical = criticalKeys(ledger.items, ledger.intervals.map((row) => row.itemKey));
  const constraint = pickConstraint(spans, critical, now, ledger.firstEventAt);
  const unknownShare = unknownShareOf(spans, now);
  const ctx: IAnomalyContext = { ledger, spans, spend, unknownShare, now };
  const onTrack = onTrackFor(goal, ledger.items, now, goalError);
  return {
    generatedAt: now,
    onTrack,
    constraint,
    stuck: stuckItems(ledger, critical),
    ownerBlocks: ownerBlocks(ledger, critical, now),
    windows: FINDER_WINDOWS.map(({ window, ms }) => windowView(spans, ledger, window, ms, now)),
    anomalies: ANOMALY_RULES.flatMap((rule) => rule(ctx)),
    unknownShare,
    inputs,
    flowLocks,
    pool: poolView,
    line: boardLine(onTrack, constraint, null),
  };
};
