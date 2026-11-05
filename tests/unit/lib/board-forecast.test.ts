import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { NO_GOAL, dailyThroughput, daysToFinish, onTrackFor } from '@/lib/board-forecast';
import { deriveConstraint } from '@/lib/constraint';
import type { IBoardGoal } from '@/types/constraint';
import type { ILedgerItem } from '@/types/ledger';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 3, 6, 0, 0);

const item = (key: string, closedAt: number | null, state: string | null = closedAt === null ? null : 'landed'): ILedgerItem => ({
  workspaceId: 'ws-a', itemKey: key, itemType: key.slice(0, key.indexOf(':')) as ILedgerItem['itemType'], openedAt: NOW - 10 * DAY,
  closedAt, state, stateSince: null, waitReason: null, waitSince: null, holder: null, clearInput: null, parentKey: null, attrs: {},
  lastEventAt: closedAt ?? NOW - DAY, lastSeq: 1,
});

const goal = (items: string[]): IBoardGoal => ({ label: 'Walking skeleton', items, setAt: NOW - DAY, setBy: 'orch' });

describe('3-day throughput', () => {
  it('counts closes of the goal types per day, oldest day first; dropped and superseded are not progress', () => {
    const items = [
      item('range:a:1', NOW - HOUR), item('range:a:2', NOW - 2 * HOUR), item('range:a:3', NOW - 30 * HOUR),
      item('range:a:4', NOW - 50 * HOUR), item('range:a:5', NOW - 80 * HOUR), item('range:a:6', NOW - HOUR, 'dropped'),
      item('gate:t:1', NOW - HOUR, 'pass'), item('range:a:7', null),
    ];
    expect(dailyThroughput(items, new Set(['range']), NOW)).toEqual([1, 1, 2]);
  });
});

describe('days to finish (exact bootstrap over the observed days)', () => {
  it('a steady rate finishes on the same day at p50 and p90', () => {
    expect(daysToFinish(6, [2, 2, 2], 0.5)).toBe(3);
    expect(daysToFinish(6, [2, 2, 2], 0.9)).toBe(3);
  });

  it('an uneven rate puts p90 after p50', () => {
    // Days of 0, 1 or 2 closes: 4 items need 4 days at the mean. After 6 days, 78 of the 729 day
    // sequences sum to 3 or less (P(done) = 0.893 < 0.9), so p90 is day 7.
    expect(daysToFinish(4, [0, 1, 2], 0.5)).toBe(4);
    expect(daysToFinish(4, [0, 1, 2], 0.9)).toBe(7);
  });

  it('nothing left is done now; no throughput is no forecast', () => {
    expect(daysToFinish(0, [0, 0, 0], 0.9)).toBe(0);
    expect(daysToFinish(3, [0, 0, 0], 0.5)).toBeNull();
  });
});

describe('on-track line (AC 5)', () => {
  it('an unreadable goal is "goal not measured", never "no goal set" (round 2, F7)', () => {
    expect(onTrackFor(null, [], NOW, 'goal storage unreadable: the file is not JSON')).toMatchObject({
      goal: null, goalState: 'unknown', state: 'at-risk', reason: 'goal not measured: goal storage unreadable: the file is not JSON',
    });
    expect(deriveConstraint(null, null, null, null, NOW, null, 'EACCES').line).toMatch(/^goal not measured: EACCES · /);
  });

  it('no goal: says so, at risk, nothing forecast', () => {
    expect(onTrackFor(null, [], NOW)).toEqual(NO_GOAL);
    expect(NO_GOAL).toMatchObject({ state: 'at-risk', goal: null, reason: 'no goal set' });
  });

  it('items left are the goal keys the ledger does not hold closed; p50 and p90 dates from the rate', () => {
    const items = [item('range:a:1', NOW - HOUR), item('range:a:2', NOW - 30 * HOUR), item('range:a:3', NOW - 54 * HOUR), item('range:b:1', null)];
    const onTrack = onTrackFor(goal(['range:a:1', 'range:b:1', 'range:c:1', 'range:d:1']), items, NOW);
    expect(onTrack).toEqual({
      state: 'on-track', goal: 'Walking skeleton', goalState: 'set', itemsLeft: 3, throughputPerDay: [1, 1, 1],
      p50At: NOW + 3 * DAY, p90At: NOW + 3 * DAY, reason: null,
    });
  });

  it('an uneven rate: p90 later than p50', () => {
    const items = [item('range:a:1', NOW - HOUR), item('range:a:2', NOW - 2 * HOUR), item('range:a:3', NOW - 30 * HOUR)];
    const onTrack = onTrackFor(goal(['range:b:1', 'range:c:1', 'range:d:1', 'range:e:1']), items, NOW);
    expect(onTrack).toMatchObject({ state: 'on-track', itemsLeft: 4, throughputPerDay: [0, 1, 2], p50At: NOW + 4 * DAY, p90At: NOW + 7 * DAY });
  });

  it('no close of the goal types in 3 days is no forecast, never a date', () => {
    expect(onTrackFor(goal(['range:b:1']), [], NOW)).toMatchObject({
      state: 'at-risk', itemsLeft: 1, p50At: null, p90At: null, reason: 'no range item closed in 3 days',
    });
  });

  it('the finder carries the goal into onTrack and the line; an unmeasured ledger leaves items left unknown', () => {
    const ledger = { intervals: [], lastProducer: {}, firstEventAt: NOW - 30 * DAY, tabWakes: null, ownerIssueSource: null, items: [item('range:a:1', NOW - HOUR)] };
    const result = deriveConstraint(ledger, null, null, null, NOW, goal(['range:a:1', 'range:b:1']));
    expect(result.onTrack).toMatchObject({ goal: 'Walking skeleton', itemsLeft: 1, state: 'on-track' });
    expect(result.line).toMatch(/^Walking skeleton · 1 items left · /);
    expect(deriveConstraint(null, null, null, null, NOW, goal(['range:a:1'])).onTrack)
      .toMatchObject({ goal: 'Walking skeleton', itemsLeft: null, state: 'at-risk', reason: 'ledger not measured' });
  });

  it('is pure: no Node import, no clock', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/board-forecast.ts'), 'utf8');
    expect(source).not.toMatch(/from '(fs|path|os|child_process|node:[a-z]+)'/);
    expect(source).not.toMatch(/Date\.now|new Date\(/);
  });
});
