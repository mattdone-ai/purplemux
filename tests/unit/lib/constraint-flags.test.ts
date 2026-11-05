import { describe, expect, it, vi } from 'vitest';
import type { IFinderLedgerInput } from '@/types/constraint';
import type { ILedgerItem, TLedgerItemType } from '@/types/ledger';

// The architect's probe for CONCERN 03-C1, against the real finder, flag scan and raise-edge step.

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const { deriveConstraint } = await import('@/lib/constraint');
const { createFlagAlertState, ledgerFlagScan, stepFlagAlerts } = await import('@/lib/flag-alerts');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 3, 6, 0, 0);

const item = (itemKey: string, extra: Partial<ILedgerItem> = {}): ILedgerItem => ({
  workspaceId: 'ws', itemKey, itemType: itemKey.slice(0, itemKey.indexOf(':')) as TLedgerItemType, openedAt: T0 - 10 * DAY,
  closedAt: null, state: null, stateSince: null, waitReason: null, waitSince: null, holder: null, clearInput: null, parentKey: null,
  attrs: {}, lastEventAt: T0, lastSeq: 1, ...extra,
});

/** 25 reviews closed in the last day with a 10 min lifetime: the review threshold is max(10, 2 x 10) = 20 min. */
const closedReviews = (now: number) => Array.from({ length: 25 }, (_, i) =>
  item(`review:done${i}`, { openedAt: now - (i + 2) * HOUR, closedAt: now - (i + 2) * HOUR + 10 * MIN }));

/** The same producer last touched a long-lived lane slice: fewer than 20 slices closed, so its threshold is unknown. */
const snapshot = (now: number, open: ILedgerItem[]): IFinderLedgerInput => ({
  intervals: [],
  items: [...closedReviews(now), item('slice:E2', { attrs: { critical: true }, lastEventAt: now - 3 * DAY }), ...open],
  lastProducer: Object.fromEntries(['slice:E2', ...open.map((o) => o.itemKey)].map((key) => [key, 'ledger-feed'])),
  firstEventAt: T0 - 30 * DAY,
  tabWakes: null, ownerIssueSource: null,
});

describe('producer silence is judged per (producer, item type) (CONCERN 03-C1)', () => {
  it('a slice whose threshold is unknown never holds up the review flag: each later review silence alerts', () => {
    const state = createFlagAlertState();
    const reviewKey = 'ledger:ws:producer-silence:ledger-feed/review';
    const sliceKey = 'ledger:ws:producer-silence:ledger-feed/slice';
    const tick = (now: number, open: ILedgerItem[]) => {
      const result = deriveConstraint(snapshot(now, open), null, null, null, now);
      const raises = stepFlagAlerts(state, ledgerFlagScan(new Map([['ws', result]]), [{ id: 'ws' }], now), now, 60 * MIN);
      return { result, alerts: raises.map((flag) => flag.key) };
    };

    let now = T0;
    expect(tick(now, [item('review:r1', { lastEventAt: now - MIN })]).alerts).toEqual([]);
    now += MIN;
    expect(tick(now, [item('review:r1', { lastEventAt: now - 2 * MIN })]).alerts).toEqual([]);

    now += 60 * MIN;
    const t2 = tick(now, [item('review:r1', { lastEventAt: now - 62 * MIN })]);
    expect(t2.alerts).toEqual([reviewKey]);
    const slice = t2.result.anomalies.find((a) => a.subject === 'ledger-feed/slice')!;
    expect(slice).toMatchObject({ judged: false, breached: false, threshold: null });

    now += MIN;
    expect(tick(now, []).alerts).toEqual([]);
    expect(state.entries.get(reviewKey)?.raisedAt ?? null).toBeNull();

    now += 2 * HOUR;
    expect(tick(now, [item('review:r2', { lastEventAt: now - 45 * MIN })]).alerts).toEqual([reviewKey]);

    // The probe goes straight to r3; at the 60 s cadence r2's close is a tick of its own.
    now += 4 * HOUR - MIN;
    expect(tick(now, []).alerts).toEqual([]);
    now += MIN;
    expect(tick(now, [item('review:r3', { lastEventAt: now - 90 * MIN })]).alerts).toEqual([reviewKey]);

    expect(state.entries.get(sliceKey)?.raisedAt ?? null).toBeNull();
  });
});
