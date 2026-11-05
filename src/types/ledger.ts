import type { LEDGER_ITEM_TYPES, LEDGER_KINDS, LEDGER_STAGES, LEDGER_WAIT_REASONS, LEDGER_DERIVED_REASONS, LEDGER_WAITS_BY } from '@/lib/ledger';

export type TLedgerItemType = (typeof LEDGER_ITEM_TYPES)[number];
export type TLedgerKind = (typeof LEDGER_KINDS)[number];
export type TLedgerWaitReason = (typeof LEDGER_WAIT_REASONS)[number];
/** A reason only the server writes: the land-queue split and the silent-item `unknown`. */
export type TLedgerDerivedReason = (typeof LEDGER_DERIVED_REASONS)[number];
/** The reason an interval or an open wait is counted under. */
export type TLedgerIntervalReason = Exclude<TLedgerWaitReason, 'land-queue'> | TLedgerDerivedReason;
export type TLedgerStage = (typeof LEDGER_STAGES)[number];
export type TLedgerWaitsBy = (typeof LEDGER_WAITS_BY)[number];

export type TLedgerAttrValue = string | number | boolean | null;

/** One event as a producer sends it (snake_case on the wire, ADR-0033). */
export interface ILedgerEventInput {
  event_id: string;
  at: number;
  item_type: TLedgerItemType;
  item_key: string;
  kind: TLedgerKind;
  state?: string | null;
  wait_reason?: TLedgerWaitReason | null;
  holder?: string | null;
  clear_input?: string | null;
  parent_key?: string | null;
  attrs?: Record<string, TLedgerAttrValue> | null;
}

export interface ILedgerAppendResult {
  ok: true;
  workspaceId: string;
  producer: string;
  receivedAt: number;
  accepted: number;
  /** Events whose event_id this workspace already holds: skipped, never counted twice. */
  duplicates: number;
  /** Events stored for a closed item: kept in `events`, no change to the item. */
  closedItem: number;
  /** Events other than open for an item the ledger does not hold (never opened, or deleted by retention): kept in `events` only. */
  orphan: number;
  intervals: number;
}

export interface ILedgerItem {
  workspaceId: string;
  itemKey: string;
  itemType: TLedgerItemType;
  openedAt: number;
  closedAt: number | null;
  state: string | null;
  stateSince: number | null;
  /** The reason the item is counted under now; `unknown` is derived at read time. */
  waitReason: TLedgerIntervalReason | null;
  waitSince: number | null;
  holder: string | null;
  clearInput: string | null;
  parentKey: string | null;
  attrs: Record<string, TLedgerAttrValue>;
  lastEventAt: number;
  lastSeq: number;
}

export interface ILedgerItemsResponse {
  workspaceId: string;
  now: number;
  items: ILedgerItem[];
  /** True when more items matched than the answer carries. */
  truncated: boolean;
}

export interface ILedgerWaitRow {
  /** The group: a reason, a holder, an item type or a stage; null is a wait with no holder. */
  key: string | null;
  /** Finished waits inside the window, each clipped to it. */
  waitedMs: number;
  /** Finished waits that ended inside the window. */
  finished: number;
  /** Over the full duration of the finished waits; null when none finished. */
  p50Ms: number | null;
  p90Ms: number | null;
  /** Items waiting now under this key (open WIP), counted when the window reaches now. */
  openItems: number;
  /** Their elapsed wait, clipped to the window. Not part of waitedMs. */
  openWaitedMs: number;
}

export interface ILedgerWaitsResponse {
  workspaceId: string;
  since: number;
  until: number;
  now: number;
  by: TLedgerWaitsBy;
  /** The item type the answer is limited to, or null for every type. */
  type: TLedgerItemType | null;
  rows: ILedgerWaitRow[];
  totals: Omit<ILedgerWaitRow, 'key'>;
}

export type TLedgerExperimentVerdict = 'keep' | 'revert';

export interface ILedgerExperimentGuard {
  metric: string;
  limit: number;
}

export interface ILedgerExperimentInput {
  hypothesis: string;
  change_ref: string | null;
  stage: TLedgerStage;
  reason: TLedgerIntervalReason | null;
  metric: string;
  baseline: { value: number; window: string } | null;
  target: number | null;
  guards: ILedgerExperimentGuard[];
  revert_if: string | null;
  min_days: number;
  max_days: number;
}

export interface ILedgerExperiment {
  workspaceId: string;
  id: string;
  itemKey: string;
  hypothesis: string;
  changeRef: string | null;
  stage: TLedgerStage;
  reason: TLedgerIntervalReason | null;
  metric: string;
  baseline: { value: number; window: string } | null;
  target: number | null;
  guards: ILedgerExperimentGuard[];
  revertIf: string | null;
  minDays: number;
  maxDays: number;
  startedAt: number;
  verdict: TLedgerExperimentVerdict | null;
  verdictAt: number | null;
  evidence: string | null;
  /** When the one extension was recorded (ADR-HFL-03 "extend once"); null when never extended. */
  extendedAt: number | null;
  /** The days the extension added to `maxDays` (already included in it). */
  extensionDays: number | null;
  extensionEvidence: string | null;
}

export interface ILedgerExperimentsResponse {
  workspaceId: string;
  experiments: ILedgerExperiment[];
}

export interface ILedgerTokenIssued {
  scope: 'ledger:emit';
  workspaceId: string;
  producer: string;
  token: string;
  issuedAt: number;
}
