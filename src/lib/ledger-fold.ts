// One event onto one item's projection (ADR-0033 §3, the consult ruling recorded there). Pure: the
// store applies it inside the append transaction and writes what it returns; the spend view's phase
// replay applies the same fold to rebuild what an item looked like at a past time.
import { DAY_MS, LAND_QUEUE_HEAD_BLOCKED, LAND_QUEUE_LOCK_BUSY, LEDGER_SILENT_MS, LEDGER_UNKNOWN_ITEM_TYPES, UNKNOWN_REASON } from '@/lib/ledger';
import type { ILedgerEventInput, TLedgerAttrValue, TLedgerIntervalReason, TLedgerItemType } from '@/types/ledger';

const MAX_ITEM_ATTR_KEYS = 64;

/** How far before a window the spend view's phase replay starts folding events (harness-flow-loop 04 consult ruling). */
export const PHASE_REPLAY_LOOKBACK_MS = 7 * DAY_MS;

/** A row of the `items` table. */
export interface ILedgerItemRow {
  workspace_id: string;
  item_key: string;
  item_type: TLedgerItemType;
  opened_at: number;
  closed_at: number | null;
  state: string | null;
  state_since: number | null;
  wait_reason: TLedgerIntervalReason | null;
  wait_since: number | null;
  holder: string | null;
  clear_input: string | null;
  parent_key: string | null;
  attrs_json: string | null;
  last_seq: number;
  last_event_at: number;
}

/** A finished wait the event ends, with the holder the item had while it waited. */
export interface ILedgerFoldInterval {
  reason: string;
  holder: string | null;
  start: number;
  end: number;
}

export type TLedgerFold =
  | { applied: false; orphan: boolean; closedItem: boolean }
  | { applied: true; item: ILedgerItemRow; intervals: ILedgerFoldInterval[]; reopened: boolean; closing: boolean; at: number };

/**
 * The store's one landing rule (04-C1): an applied `close` with state `landed` that closes a `range`. A
 * close the projection refused (a repeat, an item never opened, a late re-sent open's close) is none.
 */
export const isLanding = (fold: TLedgerFold, event: Pick<ILedgerEventInput, 'state'>): boolean =>
  fold.applied && fold.closing && fold.item.item_type === 'range' && event.state === 'landed';

export const isLandQueue = (reason: string | null): boolean =>
  reason === LAND_QUEUE_LOCK_BUSY || reason === LAND_QUEUE_HEAD_BLOCKED;

export const parseAttrs = (json: string | null): Record<string, TLedgerAttrValue> =>
  json ? JSON.parse(json) as Record<string, TLedgerAttrValue> : {};

const mergeAttrs = (json: string | null, next: Record<string, TLedgerAttrValue> | null | undefined): string | null => {
  if (!next || !Object.keys(next).length) return json;
  const merged = { ...parseAttrs(json), ...next };
  // A producer that cycles keys must not grow one row without bound: the newest event's attrs win.
  return JSON.stringify(Object.keys(merged).length > MAX_ITEM_ATTR_KEYS ? next : merged);
};

/** The one `unknown` predicate the write path and every read share (ADR-0033 §3.3). */
export const silentFor = (row: Pick<ILedgerItemRow, 'item_type' | 'closed_at' | 'wait_reason'>, gapMs: number): boolean =>
  row.closed_at === null && row.wait_reason === null && gapMs > LEDGER_SILENT_MS && LEDGER_UNKNOWN_ITEM_TYPES.includes(row.item_type);

/**
 * `landQueueReason` names the half of the land-queue split a new land-queue wait starts in; only the
 * store knows whether a landing is open, so it is asked only when a land-queue wait opens.
 */
export const foldLedgerEvent = (
  workspaceId: string,
  existing: ILedgerItemRow | undefined,
  event: ILedgerEventInput,
  seq: number,
  landQueueReason: () => TLedgerIntervalReason,
): TLedgerFold => {
  // Only an open creates an item: a late event for an item never seen, or one retention deleted, is a record only.
  if (!existing && event.kind !== 'open') return { applied: false, orphan: true, closedItem: false };
  // Only an open after the close reopens the item; anything else, or a late open, leaves the closed item alone.
  if (existing && existing.closed_at !== null && !(event.kind === 'open' && event.at > existing.closed_at)) {
    return { applied: false, orphan: false, closedItem: true };
  }
  const reopened = !existing || existing.closed_at !== null;
  // Time never runs backwards for one item: no interval can be negative or overlap another of the item.
  const at = existing && !reopened ? Math.max(event.at, existing.last_event_at, existing.wait_since ?? 0) : event.at;
  const item: ILedgerItemRow = existing && !reopened ? { ...existing } : {
    workspace_id: workspaceId, item_key: event.item_key, item_type: event.item_type, opened_at: at, closed_at: null,
    state: existing?.state ?? null, state_since: existing?.state_since ?? null, wait_reason: null, wait_since: null,
    holder: existing?.holder ?? null, clear_input: null, parent_key: existing?.parent_key ?? null,
    attrs_json: existing?.attrs_json ?? null, last_seq: seq, last_event_at: at,
  };
  const intervals: ILedgerFoldInterval[] = [];
  const holder = event.holder ?? item.holder;
  const moves = event.kind !== 'link';
  if (moves && !reopened && silentFor(item, at - item.last_event_at)) {
    intervals.push({ reason: UNKNOWN_REASON, holder: item.holder, start: item.last_event_at, end: at });
  }
  const continues = event.kind === 'wait' && item.wait_reason !== null && holder === item.holder
    && (event.wait_reason === 'land-queue' ? isLandQueue(item.wait_reason) : event.wait_reason === item.wait_reason);
  if (item.wait_reason !== null && ['wait', 'state', 'clear', 'close'].includes(event.kind) && !continues) {
    intervals.push({ reason: item.wait_reason, holder: item.holder, start: item.wait_since ?? at, end: at });
    item.wait_reason = null;
    item.wait_since = null;
    item.clear_input = null;
  }
  item.holder = holder;
  item.parent_key = event.parent_key ?? item.parent_key;
  item.attrs_json = mergeAttrs(item.attrs_json, event.attrs);
  item.last_seq = seq;
  if (moves) item.last_event_at = at;
  if (event.kind === 'state' || (event.kind === 'close' && event.state)) {
    item.state = event.state ?? item.state;
    item.state_since = at;
  }
  if (event.kind === 'wait') {
    if (!continues) {
      item.wait_reason = event.wait_reason === 'land-queue' ? landQueueReason() : event.wait_reason as TLedgerIntervalReason;
      item.wait_since = at;
    }
    item.clear_input = event.clear_input ?? item.clear_input;
  }
  const closing = event.kind === 'close';
  if (closing) item.closed_at = at;
  return { applied: true, item, intervals, reopened, closing, at };
};
