// The phase of a message: the ledger item its tab held at the message's time, mapped by one fixed
// table (harness-flow-loop 04, the consult ruling recorded in ADR-0030's amendment). Pure: the
// service reads the replay from ledger.sqlite and the spend model asks `heldBy` per slot.
import { DAY_MS, LEDGER_RETENTION_DAYS, LEDGER_STAGE_REASONS, LAND_QUEUE_HEAD_BLOCKED, LAND_QUEUE_LOCK_BUSY } from '@/lib/ledger';
import { foldLedgerEvent, PHASE_REPLAY_LOOKBACK_MS } from '@/lib/ledger-fold';
import type { ILedgerItemRow } from '@/lib/ledger-fold';
import type { ILedgerPhaseReplay } from '@/lib/ledger-store';
import type { TLedgerItemType } from '@/types/ledger';
import type { TSpendPhase } from '@/types/spend';

export const SPEND_PHASE_ORDER: readonly TSpendPhase[] = ['plan', 'build', 'review', 'evaluate', 'land', 'coordinate', 'other'];

const REASON_PHASE: Readonly<Record<string, TSpendPhase>> = {
  'review-queue': 'review',
  'review-findings': 'review',
  rework: 'build',
  'receipt-rekey': 'land',
  owner: 'coordinate',
  ...Object.fromEntries([...LEDGER_STAGE_REASONS.land, ...LEDGER_STAGE_REASONS.deploy, LAND_QUEUE_LOCK_BUSY, LAND_QUEUE_HEAD_BLOCKED]
    .map((reason) => [reason, 'land' as const])),
};

const TYPE_PHASE: Readonly<Partial<Record<TLedgerItemType, TSpendPhase>>> = {
  slice: 'build',
  review: 'review',
  gate: 'evaluate',
  experiment: 'evaluate',
  range: 'land',
  landing: 'land',
  deploy: 'land',
  'owner-issue': 'plan',
  'mc-item': 'coordinate',
};

/** The wait reason decides first (agent-idle, host-load and unknown defer to the type); null for a seat item. */
export const phaseOfItem = (itemType: TLedgerItemType, waitReason: string | null): TSpendPhase | null => {
  if (itemType === 'seat') return null;
  if (waitReason !== null && Object.hasOwn(REASON_PHASE, waitReason)) return REASON_PHASE[waitReason];
  return Object.hasOwn(TYPE_PHASE, itemType) ? TYPE_PHASE[itemType]! : 'other';
};

/**
 * The earliest time the ledger can attribute: the later of its retention cutoff plus the replay
 * lookback and the workspace's first item; null when it holds no item at all.
 */
export const ledgerHorizon = (firstOpenedAt: number | null, now: number): number | null =>
  firstOpenedAt === null ? null : Math.max(now - LEDGER_RETENTION_DAYS * DAY_MS + PHASE_REPLAY_LOOKBACK_MS, firstOpenedAt);

interface ISnapshot {
  /** The item's last move (a link takes the time of the move before it): it looks like this until its next snapshot. */
  at: number;
  holder: string | null;
  open: boolean;
  phase: TSpendPhase | null;
}

export interface ISpendHeldItem {
  itemKey: string;
  phase: TSpendPhase;
}

export interface ISpendHoldings {
  horizon: number | null;
  /** The item the tab held at `at` (by id or by name), with its phase; null when it held none. */
  heldBy: (tabId: string, tabName: string | null, at: number) => ISpendHeldItem | null;
}

const snapshotOf = (row: ILedgerItemRow, at: number): ISnapshot => ({
  at, holder: row.holder, open: row.closed_at === null, phase: phaseOfItem(row.item_type, row.wait_reason),
});

const lastAtOrBefore = (snapshots: ISnapshot[], at: number): ISnapshot | null => {
  let low = 0;
  let high = snapshots.length - 1;
  let found: ISnapshot | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (snapshots[mid].at <= at) {
      found = snapshots[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
};

/**
 * Fold the replay with the store's own fold, keeping every state each item passed through. A
 * carried item (open before the scan, first seen mid-life) starts at its first scanned event with
 * the holder it has had since before the scan, when no scanned event names another.
 */
export const buildSpendHoldings = (replay: ILedgerPhaseReplay, horizon: number | null): ISpendHoldings => {
  const rows = new Map<string, ILedgerItemRow>();
  const timeline = new Map<string, ISnapshot[]>();
  const byHolder = new Map<string, Set<string>>();
  const record = (row: ILedgerItemRow, at: number): void => {
    const snapshots = timeline.get(row.item_key) ?? [];
    snapshots.push(snapshotOf(row, at));
    timeline.set(row.item_key, snapshots);
    if (row.holder === null) return;
    const keys = byHolder.get(row.holder) ?? new Set<string>();
    keys.add(row.item_key);
    byHolder.set(row.holder, keys);
  };

  for (const row of replay.seed) {
    rows.set(row.item_key, row);
    record(row, row.last_event_at);
  }
  const renamed = new Set(replay.events.filter((event) => event.holder !== null && event.holder !== undefined).map((event) => event.item_key));
  const lastScannedSeq = new Map<string, number>();
  for (const event of replay.events) lastScannedSeq.set(event.item_key, event.seq);
  const carried = new Map(replay.carried.map((row) => [row.item_key, row]));
  for (const event of replay.events) {
    const known = carried.get(event.item_key);
    if (known && !rows.has(event.item_key)) {
      carried.delete(event.item_key);
      rows.set(event.item_key, {
        ...known, closed_at: null, state: null, state_since: null, wait_reason: null, wait_since: null, clear_input: null,
        // The row's holder is the scan's only if no scanned event named one and no event after the scan moved the row.
        holder: renamed.has(event.item_key) || known.last_seq > (lastScannedSeq.get(event.item_key) ?? 0) ? null : known.holder,
        last_event_at: event.at,
      });
    }
    // The land-queue split needs the workspace's open landing; both halves are the land phase.
    const fold = foldLedgerEvent(replay.workspaceId, rows.get(event.item_key), { ...event, event_id: '' }, event.seq, () => LAND_QUEUE_HEAD_BLOCKED);
    if (!fold.applied) continue;
    rows.set(event.item_key, fold.item);
    // A link does not move the item's clock: recording it at its own later time would unsort the timeline.
    record(fold.item, fold.item.last_event_at);
  }

  // An item can be held at `at` only between its first state and its final close.
  const spans = new Map([...timeline].map(([key, snapshots]) => {
    const last = snapshots[snapshots.length - 1];
    return [key, { from: snapshots[0].at, until: last.open ? Infinity : last.at }];
  }));
  const answers = new Map<string, ISpendHeldItem | null>();

  const heldBy = (tabId: string, tabName: string | null, at: number): ISpendHeldItem | null => {
    const memo = `${tabId}\u0000${tabName ?? ''}\u0000${at}`;
    if (answers.has(memo)) return answers.get(memo)!;
    const holders = tabName && tabName !== tabId ? [tabId, tabName] : [tabId];
    let best: { key: string; at: number; phase: TSpendPhase } | null = null;
    for (const holder of holders) {
      for (const key of byHolder.get(holder) ?? []) {
        const span = spans.get(key)!;
        if (at < span.from || at >= span.until) continue;
        const snapshot = lastAtOrBefore(timeline.get(key)!, at);
        if (!snapshot || !snapshot.open || snapshot.phase === null || !holders.includes(snapshot.holder ?? '')) continue;
        if (!best || snapshot.at > best.at || (snapshot.at === best.at && key < best.key)) best = { key, at: snapshot.at, phase: snapshot.phase };
      }
    }
    const answer = best && { itemKey: best.key, phase: best.phase };
    answers.set(memo, answer);
    return answer;
  };
  return { horizon, heldBy };
};
