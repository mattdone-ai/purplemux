// The pulse (ADR-0034 §9, story 12 AC 10): hourly movement per workspace, the last 48 hours at a
// glance. Every source carries its own state; a source that cannot be read is `unknown`, never 0.

export type TPulseSourceId = 'ledger' | 'commits' | 'gates' | 'reviews' | 'landed' | 'answers';

export type TPulseGateOutcome = 'pass' | 'fail';

/** One movement event: when it happened and, for a gate, how it ended. */
export interface IPulseEvent {
  at: number;
  outcome?: TPulseGateOutcome;
}

/** What one reader returns: the events it found since the lookback start, or why it could not read. */
export interface IPulseSourceRead {
  id: TPulseSourceId;
  /** null when the source cannot be read; `reason` says why. */
  events: IPulseEvent[] | null;
  reason: string | null;
  /** Where the reader looked (paths, tables), for the owner's "how is this measured". */
  from: string[];
  /** Read from directories this workspace shares with these workspaces: shown, never counted (round 2, F1). */
  sharedWith?: string[];
}

export interface IPulseSource {
  id: TPulseSourceId;
  label: string;
  state: 'ok' | 'unknown';
  reason: string | null;
  /** Events in the strip's 48 hours; null when the source is not measured. */
  count: number | null;
  lastAt: number | null;
  from: string[];
  /** Shared directories: the workspaces they are shared with; never in the bars or the stall. Null when counted. */
  sharedWith: string[] | null;
}

export interface IPulseHour {
  /** Start of the clock hour (UTC hours align with AEDT/AEST hours). */
  start: number;
  /** Events from the measured sources in this hour. */
  total: number;
  bySource: Partial<Record<TPulseSourceId, number>>;
  gatesPassed: number;
  gatesFailed: number;
}

/**
 * `stalled` red: work in progress and no movement for 2 h; `moving` green: the last hour at or above the
 * 7-day hourly median; `steady`: below it; `idle`: a measured zero in progress; `not-measured`: no basis.
 */
export type TPulseStallState = 'stalled' | 'moving' | 'steady' | 'idle' | 'not-measured';

export type TPulseStuckKind = 'ledger-item' | 'agent-tab' | 'mc-item';

export interface IPulseStuck {
  kind: TPulseStuckKind;
  id: string;
  label: string;
  since: number;
}

export interface IPulseStall {
  state: TPulseStallState;
  /** The owner's sentence: `no movement for 3 h · oldest stuck: ...`, `moving: ...`, `not measured (...)`. */
  reason: string;
  /** The newest movement event among the measured sources in the 7-day lookback; null when none. */
  lastMovementAt: number | null;
  /** Whole hours since `lastMovementAt` (168 when nothing moved in the lookback); null when nothing is measured. */
  hoursSinceMovement: number | null;
  /** Events in the trailing 60 minutes; null when nothing is measured. */
  lastHour: number | null;
  /** Median events per hour over the active hours (any event) of the 168 complete clock hours before the current one; null with none or nothing measured. */
  medianPerHour: number | null;
  /** How many of those 168 hours had an event; null when nothing is measured. */
  activeHours: number | null;
  /** Named on a stall: the counted item with the oldest `since`. */
  oldestStuck: IPulseStuck | null;
}

export type TPulseWipBasis = 'ledger' | 'agent-tabs' | 'none';
export type TPulseWipSourceState = 'measured' | 'no-events' | 'unreadable' | 'not-used';

/** Work in progress (architect consult 12, Q1): the ledger once it holds an event in 7 days, else live agent tabs and MC. */
export interface IPulseWip {
  /** null only when `basis` is `none`, or a source the basis rests on is unreadable. */
  count: number | null;
  basis: TPulseWipBasis;
  sources: {
    ledger: Exclude<TPulseWipSourceState, 'not-used'>;
    agentTabs: Exclude<TPulseWipSourceState, 'no-events'>;
    missionControl: Exclude<TPulseWipSourceState, 'no-events'>;
  };
  basisReason: string;
}

export interface IPulsePriority {
  text: string;
  basis: 'constraint' | 'stuck-critical' | 'none' | 'unknown';
  /** Open Mission Control items; null when Mission Control is unreadable. */
  needsYou: number | null;
}

export interface IPulse {
  workspaceId: string;
  generatedAt: number;
  /** Whose movement this is (round 2, F1): the workspace's epic leases, or its own directories. */
  scope: { basis: 'epic' | 'directories'; epics: string[] };
  /** The 48 clock hours ending with the current one, oldest first; null when no source is measured. */
  hours: IPulseHour[] | null;
  sources: IPulseSource[];
  stall: IPulseStall;
  wip: IPulseWip;
  priority: IPulsePriority;
  /** The finder answer the priority line rests on is older than 120 s: its `generatedAt`; else null. */
  staleSince: number | null;
}

export interface IMissionPulseListResponse {
  pulses: IPulse[];
}
