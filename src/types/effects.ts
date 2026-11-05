// Effect counts per component (story 15; ADR-0035 §7): how often a tab acted after a nudge, probe or flag reached it.

/**
 * What a component is: a watchdog nudge, a liveness probe, a ledger flag or alarm typed into a tab, a notice or send,
 * a flag rule that only reaches the phone (fleet ADR-0023, flow ADR-0032), or a kind the catalog does not name.
 */
export type TEffectFamily = 'nudge' | 'probe' | 'flag' | 'notice' | 'phone' | 'other';

/** One finished turn of a tab, as `tab_turns` keeps it. */
export interface ITabTurn {
  workspaceId: string;
  tabId: string;
  provider: string;
  /** Null: the turn's start was not seen by this server (a restart mid-turn). */
  startedAt: number | null;
  endedAt: number;
  /** Acting tool calls (edit, write, shell); null when the turn's start was not seen or the provider feeds none. */
  toolCalls: number | null;
}

/** One component's counts over the window. Every count is null when the component is not measured. */
export interface IEffectRow {
  /** `turn-marker`, `stalled`, `flag:re-gates`, `alarm:not-armed`, `flow:lock-busy`, `fleet:stall`. */
  component: string;
  family: TEffectFamily;
  /**
   * Firings the router recorded in the window, any class: delivered, held, or logged as a duplicate. A firing dropped
   * before the router (the 60 s episode filter) or routed to the board or phone only is not recorded.
   */
  fired: number | null;
  /** Delivery units: one urgent paste, or one digest carrying the component (counted once per digest). 0 = never reached a tab. */
  delivered: number | null;
  /** Of `delivered`, the units that were digests: their outcome is shared with every event they carried. */
  inDigest: number | null;
  /** Units whose recipient's next turn made at least one acting tool call. */
  followed: number | null;
  /** Units with an outcome: delivered less mid-turn, pending, closed and unmeasured. */
  judged: number | null;
  /** Of `judged`, the units the paste started no turn for within the bound: not followed. */
  noTurn: number | null;
  /** The paste landed in a turn that was already running: it cannot be tied to a turn. */
  midTurn: number | null;
  /** No turn of the recipient has ended since the paste; the tab still exists. */
  pending: number | null;
  /** The recipient was closed before a turn ended. */
  closed: number | null;
  /** The next turn's start or tool calls were not recorded. */
  unmeasured: number | null;
  /** A deletion candidate: enough deliveries with an observed turn, none followed. Null when that is not measured. */
  candidate: boolean | null;
  /** Why `candidate` reads as it does (observed turns, or why there are too few); null on a not-measured row. */
  candidateReason: string | null;
  /** Why the whole row is not measured; null when it is. */
  notMeasured: string | null;
}

export interface IEffectsResponse {
  workspaceId: string;
  /** The window asked for. */
  requestedSince: number;
  until: number;
  /** The window counted: `requestedSince` clamped to `measuredSince`; null when nothing of it is measured. */
  since: number | null;
  /** The first turn this ledger recorded; null when none yet. */
  measuredSince: number | null;
  /** A turn that starts later than this after the paste is not the paste's turn. */
  nextTurnBoundMs: number;
  /** The deliveries with an observed turn a component needs before it can be a deletion candidate. */
  candidateMinObserved: number;
  /** The source of each count, for a reader of the JSON. */
  source: string;
  rows: IEffectRow[];
}
