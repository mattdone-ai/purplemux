// The on-track line's forecast (ADR-0034 §10, story 12 AC 5): pure, computed from the ledger, never
// written by a model. No Node import, no I/O, no clock.
import type { IBoardGoal, IBoardOnTrack } from '@/types/constraint';
import type { ILedgerItem, TLedgerItemType } from '@/types/ledger';

const DAY_MS = 86_400_000;
export const FORECAST_DAYS = 3;
/** A forecast further out than this is no forecast: the rate is too low to name a date. */
export const FORECAST_MAX_DAYS = 365;
/** Closes that are not progress toward a goal. */
const NOT_PROGRESS = new Set(['dropped', 'superseded']);

export const NO_GOAL: IBoardOnTrack = {
  state: 'at-risk', goal: null, goalState: 'none', itemsLeft: null, p50At: null, p90At: null, throughputPerDay: null, reason: 'no goal set',
};

const typeOfKey = (key: string): string => key.slice(0, key.indexOf(':'));

/** Items of the goal's types closed as progress in each of the last 3 days, oldest day first. */
export const dailyThroughput = (items: readonly ILedgerItem[], types: ReadonlySet<string>, now: number): number[] => {
  const days = new Array<number>(FORECAST_DAYS).fill(0);
  for (const item of items) {
    if (item.closedAt === null || !types.has(item.itemType) || NOT_PROGRESS.has(item.state ?? '')) continue;
    const ago = now - item.closedAt;
    if (ago < 0 || ago >= FORECAST_DAYS * DAY_MS) continue;
    days[FORECAST_DAYS - 1 - Math.floor(ago / DAY_MS)] += 1;
  }
  return days;
};

/**
 * The fewest days after which the work is done with probability `p`, each day drawing its
 * throughput uniformly from the observed days (an exact bootstrap, no random draws); null past
 * `FORECAST_MAX_DAYS` or when no day closed anything.
 */
export const daysToFinish = (left: number, perDay: readonly number[], p: number): number | null => {
  if (left <= 0) return 0;
  if (!perDay.some((n) => n > 0)) return null;
  // dist[s]: the probability that s items (capped at `left`) are done after the days so far.
  let dist = new Array<number>(left + 1).fill(0);
  dist[0] = 1;
  for (let day = 1; day <= FORECAST_MAX_DAYS; day += 1) {
    const next = new Array<number>(left + 1).fill(0);
    for (let done = 0; done <= left; done += 1) {
      if (dist[done] === 0) continue;
      for (const n of perDay) next[Math.min(left, done + n)] += dist[done] / perDay.length;
    }
    dist = next;
    if (dist[left] >= p - 1e-12) return day;
  }
  return null;
};

/**
 * On track against the goal: the items left are the goal's keys the ledger does not hold closed
 * (the finder reads items closed in 14 days, so an older close counts as left); p50 and p90 dates
 * from 3-day throughput. On track while the rate gives a forecast at all.
 */
export const onTrackFor = (goal: IBoardGoal | null, items: readonly ILedgerItem[] | null, now: number, goalError: string | null = null): IBoardOnTrack => {
  if (goalError !== null) return { ...NO_GOAL, goalState: 'unknown', reason: `goal not measured: ${goalError}` };
  if (!goal) return NO_GOAL;
  const base = { goal: goal.label, goalState: 'set' as const };
  if (!items) return { ...base, state: 'at-risk', itemsLeft: null, p50At: null, p90At: null, throughputPerDay: null, reason: 'ledger not measured' };
  const closed = new Set(items.filter((item) => item.closedAt !== null && !NOT_PROGRESS.has(item.state ?? '')).map((item) => item.itemKey));
  const itemsLeft = goal.items.filter((key) => !closed.has(key)).length;
  const types = new Set<TLedgerItemType | string>(goal.items.map(typeOfKey));
  const throughputPerDay = dailyThroughput(items, types, now);
  const d50 = daysToFinish(itemsLeft, throughputPerDay, 0.5);
  const d90 = daysToFinish(itemsLeft, throughputPerDay, 0.9);
  const p50At = d50 === null ? null : now + d50 * DAY_MS;
  const p90At = d90 === null ? null : now + d90 * DAY_MS;
  let reason: string | null = null;
  if (p90At === null) {
    reason = throughputPerDay.some((n) => n > 0)
      ? `the 3-day rate finishes in more than ${FORECAST_MAX_DAYS} days`
      : `no ${[...types].join(' or ')} item closed in 3 days`;
  }
  return { ...base, state: reason === null ? 'on-track' : 'at-risk', itemsLeft, p50At, p90At, throughputPerDay, reason };
};
