import type { ICuratorBoard } from '@/types/curator';
import type { ILedgerExperiment, ILedgerItem, TLedgerIntervalReason, TLedgerItemType, TLedgerStage } from '@/types/ledger';
import type { IFlowRecord } from '@/types/flow';
import type { ISpendIndexStatus, ISpendLandingMetric } from '@/types/spend';

// The constraint finder (ADR-0034): inputs the 60 s tick reads, and the answer it caches per
// workspace. Every measure that rests on a missing input is `null` with a reason, never 0.

export type TFinderWindow = '6h' | '24h' | '7d';
export type TFinderStage = TLedgerStage | 'unknown';
/** `new`: the previous window measured no wait; `unknown`: the ledger's history starts after the previous window began. */
export type TFinderTrend = 'up' | 'down' | 'flat' | 'new' | 'unknown';

/** One finished wait, as the ledger's `intervals` table holds it. */
export interface IFinderInterval {
  itemKey: string;
  itemType: TLedgerItemType;
  reason: TLedgerIntervalReason;
  holder: string | null;
  start: number;
  end: number;
}

export interface IFinderTabWakes {
  tabId: string;
  wakes: number;
}

/** What the tick reads from `ledger.sqlite` for one workspace. */
export interface IFinderLedgerInput {
  /** Finished waits overlapping the last 14 days (the 7 d window and the one before it). */
  intervals: IFinderInterval[];
  /** Open items, and items closed in the last 14 days. */
  items: ILedgerItem[];
  /** For each open item, the producer of its last event. */
  lastProducer: Record<string, string>;
  /** The earliest `opened_at` the ledger holds for the workspace; null when it holds no item. */
  firstEventAt: number | null;
  /**
   * Wakes per tab in the last 6 h: deliveries (`delivered_at` in the window, class other than `log`),
   * rows sharing a `digest_id` counted once. null when the workspace has no `tab_events` row.
   */
  tabWakes: IFinderTabWakes[] | null;
  /** The `owner-issue` source (story 35); null when the ledger holds no `owner-issue` item. */
  ownerIssueSource: IFinderOwnerIssueSource | null;
}

/**
 * Who feeds `owner-issue` items (story 35). Receipts count events of any item type: a feed that dates
 * rows by when they were raised still speaks now.
 */
export interface IFinderOwnerIssueSource {
  /** The producer of each `owner-issue` item's last event, for the `owner-issue` items in `items`. */
  producerOf: Map<string, string>;
  /** The producer of the last event of the `owner-issue` item opened last: the pick when `items` holds none. */
  newestProducer: string;
  /** First and last event received, for each producer named above. */
  receipts: Map<string, { firstReceivedAt: number; lastReceivedAt: number }>;
  /** The earliest `opened_at` of any `owner-issue` item, open or closed. */
  earliestOpenedAt: number;
  /** Any `owner-issue` item of the workspace, open or closed, of any age, carries an integer `attrs.raisedAt`. */
  anyRaisedAt: boolean;
}

/** The spend the finder joins (story 04 feeds the per-landing metric); null when the spend index cannot answer. */
export interface IFinderSpendInput {
  index: ISpendIndexStatus;
  /** Start of the first UTC day the spend covers; landings are counted from here to now. */
  since: number;
  /** Over the UTC days from `since` to today; null when a model has no known price. */
  costUsd: number | null;
  cacheReadTokens: number;
  /** Ranges closed `landed` from `since` to now (`ledger-store.landedRanges`); null when the ledger cannot say. */
  landedRanges: number | null;
  /** `cache_read_tokens_per_landed_item` over the same days (story 04 AC 4), with its reason when not measured. */
  cacheReadTokensPerLandedItem: ISpendLandingMetric;
}

/** One spend read for every workspace (`getFinderSpend`): the index state, the first UTC day's start, each workspace's input. */
export interface IFinderSpendAll {
  index: IFinderSpendInput['index'];
  since: number;
  byWorkspace: Map<string, Omit<IFinderSpendInput, 'index' | 'since'>>;
}

export interface IFinderPoolHost {
  name: string;
  slotsUsed: number;
  slotsTotal: number;
}

/** The execution pool (ADR-HFL-09); absent until the pool scheduler lands. */
export interface IFinderPoolInput {
  hosts: IFinderPoolHost[];
}

export interface IFinderRow {
  key: string;
  /** Items waiting now under this key. */
  wip: number;
  /** Finished waits clipped to the window plus open waits' elapsed time clipped to it. */
  waitingHours: number;
  /** Of the waits that finished inside the window; null when none did. */
  p50Hours: number | null;
  p90Hours: number | null;
  /** Waits that finished inside the window. */
  throughput: number;
  /** Against the window before; null when neither window waited. */
  trend: TFinderTrend | null;
  previousWaitingHours: number;
}

export interface IFinderWindowView {
  window: TFinderWindow;
  since: number;
  until: number;
  byReason: IFinderRow[];
  byStage: IFinderRow[];
  /** Items closed inside the window, by item type. */
  closed: Partial<Record<TLedgerItemType, number>>;
}

export interface IBoardConstraint {
  reason: TLedgerIntervalReason;
  stage: TFinderStage;
  waitingHours: number;
  trend: TFinderTrend;
  /** Until story 13 routes reasons: the holder with the most waiting hours under the reason. */
  ownerSeat: string | null;
  /** The most frequent clear input among the reason's open waits. */
  clearInput: string | null;
  /** `critical` when items with `attrs.critical` waited in the last 24 h, else `all`. */
  basis: 'critical' | 'all';
  items: number;
  /** The owner's words for `reason`, `stage` and `trend` (`constraint-labels.ts`). */
  labels: { reason: string; stage: string; trend: string };
}

export type TFinderAnomalyId =
  | 're-gates'
  | 'rework-rate'
  | 'context-per-call'
  | 'wakes-per-hour'
  | 'unknown-share'
  | 'producer-silence'
  | 'cost-per-landed-item'
  | 'cache-read-per-landed-item'
  | 'seat-compactions'
  | 'rotation-alarm'
  | 'handoff-undelivered'
  | 'owner-found-defects';

export interface IFinderAnomaly {
  id: TFinderAnomalyId;
  /** The workspace, a seat (tab name or id) or a producer. */
  subject: string;
  /** null when an input is missing; `reason` says which. */
  value: number | null;
  unit: string;
  /** null for a measure that is reported but never flagged. */
  threshold: number | null;
  /** A value held against a threshold that may flag it: false when either is unknown or the measure never flags. */
  judged: boolean;
  breached: boolean;
  /** `now` for a reading at the tick (context, silence). */
  window: TFinderWindow | 'now';
  text: string;
  reason: string | null;
}

/** `partial`: read, but the source says part of it is missing (`reason`). */
export type TFinderInputState = 'ok' | 'partial' | 'stale' | 'unknown';

export interface IFinderInputStatus {
  state: TFinderInputState;
  /** Why the input is unknown or stale. */
  reason: string | null;
  at: number | null;
}

export interface IBoardStuckItem {
  key: string;
  itemType: TLedgerItemType;
  holder: string | null;
  reason: TLedgerIntervalReason;
  since: number;
  clearInput: string | null;
  critical: boolean;
  reasonLabel: string;
  /** A `range:<lane>:<key>` item only: the key of the latest range of the same lane opened after it, if any. */
  supersededBy?: string;
}

export interface IBoardOnTrack {
  /** `at-risk` whenever no goal is set: there is nothing to be on track against. */
  state: 'on-track' | 'at-risk';
  goal: string | null;
  /** `none`: no goal set; `unknown`: the goal file could not be read (`reason`), never shown as "no goal set". */
  goalState: 'set' | 'none' | 'unknown';
  itemsLeft: number | null;
  p50At: number | null;
  p90At: number | null;
  /** Items of the goal's types closed in each of the last 3 days, oldest first; null with no goal or no ledger. */
  throughputPerDay: number[] | null;
  /** Why the line is at risk (`no goal set`, `no range item closed in 3 days`, `ledger not measured`); null on track. */
  reason: string | null;
}

/** `purplemux board goal set` (story 12 AC 5): what the workspace works toward. */
export interface IBoardGoal {
  label: string;
  /** Ledger item keys. */
  items: string[];
  setAt: number;
  /** The tab name or id that set it, or `cli` for an admin token. */
  setBy: string;
}

export interface IBoardFlowLock {
  name: string;
  heldBy: string | null;
  since: number | null;
}

export interface IBoardPool {
  hosts: IFinderPoolHost[];
  slotsUsed: number;
  slotsTotal: number;
}

/** What waiting on one Mission Control item costs (ADR-HFL-11 §1): the same shape as the item's `blocked`. */
export interface IBoardBlocked {
  items: number;
  hours: number;
  critical: boolean;
}

/** The finder's answer for one workspace, cached by the tick. */
export interface IFinderResult {
  generatedAt: number;
  onTrack: IBoardOnTrack;
  constraint: IBoardConstraint | null;
  stuck: IBoardStuckItem[];
  /** Per MC item id, what links to it waiting `owner`; null when the ledger is not measured. */
  ownerBlocks: Record<string, IBoardBlocked> | null;
  windows: IFinderWindowView[];
  anomalies: IFinderAnomaly[];
  /** `unknown` waiting hours / all waiting hours on the wait-life types over 24 h; null when nothing waited. */
  unknownShare: number | null;
  inputs: { ledger: IFinderInputStatus; flow: IFinderInputStatus; spend: IFinderInputStatus; pool: IFinderInputStatus };
  flowLocks: IBoardFlowLock[] | null;
  pool: IBoardPool | null;
  /** `goal · items left · constraint · trend`, for `board show --line`. */
  line: string;
}

export interface IBoardNeedsYou {
  id: string;
  title: string;
  createdAt: number;
  /** What waiting on it costs, from the ledger; null when no ledger item links to it ("not measured"). */
  blocked: IBoardBlocked | null;
}

/** `GET .../board`: the finder's cached answer plus Mission Control's open items. */
export interface IBoard extends IFinderResult {
  workspaceId: string;
  /** Stuck items after any holder filter, before the cap of 50 that `stuck` carries. */
  stuckTotal: number;
  needsYou: IBoardNeedsYou[] | null;
  /** Experiments with no verdict yet (ADR-HFL-03); null when the ledger cannot be read. */
  experiments: ILedgerExperiment[] | null;
  /** How long ago the finder computed this answer (`generatedAt`). */
  ageMs: number;
  /** `generatedAt` when the answer is older than two ticks (120 s): a hung tick, not a fresh board. Null when fresh. */
  staleSince: number | null;
  /** The local curator (ADR-0038): up or down, and each task's state; null when its state cannot be read. */
  curator: ICuratorBoard | null;
}

export interface IFinderInputs {
  ledger: IFinderLedgerInput | null;
  flow: IFlowRecord | null;
  spend: IFinderSpendInput | null;
  pool: IFinderPoolInput | null;
}

export interface IMissionBoardListResponse {
  boards: IBoard[];
}
