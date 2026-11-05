export type TSpendProvider = 'claude' | 'codex' | 'grok';
export type TSpendBy = 'tab' | 'day' | 'model' | 'role' | 'workspace' | 'seat' | 'phase' | 'item';
export type TSpendPeriod = 'today' | '7d' | '30d';
/** harness-flow-loop 04: the phase of the ledger item a tab holds at the message's time; `other` = it held none. */
export type TSpendPhase = 'plan' | 'build' | 'review' | 'evaluate' | 'land' | 'coordinate' | 'other';
/** Why usage has no row under the view's `by`; `unattributedReasons` names each part of `unattributed`. */
export type TSpendUnattributedReason = 'no-binding' | 'no-workspace' | 'no-message-time' | 'ledger-unreadable' | 'no-ledger-history' | 'no-held-item';

/** Contract: architecture.md §4.5 (ADR-0030). */
export interface ISpendRow { key: string; label: string; providerId: 'claude' | 'codex' | 'grok' | null;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; totalTokens: number;
  sidechainTokens: number; costUsd: number | null; unpricedTokens: number;
  /** Est. cost of the cache reads inside costUsd; null when nothing is priced or a priced Codex/Grok session cost cannot be split. */
  cacheReadCostUsd: number | null;
  /** `spend phases` only: distinct 5-min slots with usage in the row x 5 min; null when the usage has no message time. */
  wallMs?: number | null }
export interface ISpendView { workspaceId: string | 'all'; from: string; to: string; by: TSpendBy;
  generatedAt: number; totals: ISpendRow; rows: ISpendRow[]; unattributed: ISpendRow | null;
  roleBasis?: 'current-orchestrator';
  /** `by=phase|item`: the parts of `unattributed`, one row per reason (they sum to it). */
  unattributedReasons?: ISpendRow[];
  /**
   * `by=phase|item`: usage is placed at its 5-min slot's midpoint; before `ledgerHorizon` the ledger holds no history
   * (null: no item for the workspace). `ledgerReadable` false: ledger.sqlite could not be read, so no phase is known.
   */
  phaseBasis?: { slotMs: number; ledgerHorizon: number | null; ledgerReadable: boolean };
  dayBasis: { claude: 'message'; codex: 'session-start'; grok: 'session-start' };
  index: { state: 'ready' | 'indexing' | 'unavailable'; filesIndexed: number; filesTotal: number;
           indexedThrough: number | null; error?: string } }

export type ISpendIndexStatus = ISpendView['index'];

/** One burndown day's tokens for the burndown's workspace (`GET /api/mission-control/burndown`). */
export interface ISpendTokensByDay {
  day: string;
  totalTokens: number;
  sidechainTokens: number;
  cacheReadTokens: number;
}

/**
 * One indexed usage figure: a Claude bucket (day, model, session, file kind) or a
 * Codex or Grok session. `workspaceId` is `global` for `~/.claude`, and null when
 * only a binding can name the workspace.
 */
export interface ISpendUsage {
  providerId: TSpendProvider;
  workspaceId: string | null;
  sessionId: string;
  day: string;
  /** UTC 5-minute slot start in ms; absent when the message time is not known (Codex, Grok, gone pre-slot entries). */
  slot?: number;
  model: string;
  sidechain: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  /** Codex and Grok carry their own reader's cost; Claude's comes from `calculateCost`. null = no known price. */
  costUsd?: number | null;
}

/** `cache_read_tokens_per_landed_item` over one window (harness-flow-loop 04 AC 4); null value = not measured, with the reason. */
export interface ISpendLandingMetric {
  metric: 'cache_read_tokens_per_landed_item';
  window: 'day' | '7d';
  from: string;
  to: string;
  cacheReadTokens: number;
  /** Ranges closed `landed` in the window (close events); null when the ledger could not be read or holds no item. */
  landedItems: number | null;
  value: number | null;
  reason: string | null;
}

/** `GET /api/cli/spend/phases`: the per-phase table of one UTC day, with wall time per row. */
export interface ISpendPhasesView extends ISpendView {
  day: string;
  cacheReadPerLandedItem: { day: ISpendLandingMetric; '7d': ISpendLandingMetric };
}
