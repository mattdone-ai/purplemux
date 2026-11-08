import type { IPoolWouldRefuseView } from '@/types/pool';
import type { TPanelType } from '@/types/terminal';
import type { IClientTabStatusEntry } from '@/types/status';

// The Mission Control fleet status read model (ADR-0023): one row per agent tab,
// its state and how long it has been in it, and the flags that say "look here".
// Read only: nothing in this model sends input to a tab.

export type TFleetState =
  | 'working'
  | 'waiting'
  | 'needs-input'
  | 'ended'
  | 'ready-for-review'
  | 'idle'
  | 'unsubmitted'
  | 'inactive'
  | 'startup-prompt'
  | 'unknown';

export type TFleetFlag = 'stall' | 'unanswered' | 'waiting-long';

export interface IFleetFlag {
  flag: TFleetFlag;
  reason: string;
}

export type TFleetWaitKind = 'watch' | 'job' | 'background';

export interface IFleetWait {
  kind: TFleetWaitKind;
  /** A watch's target, a job's label or pid, or the provider's open background task count. */
  label: string;
  /** For a watch: its kind (`pr`, `ref`, `lease`). */
  detail?: string;
}

export interface IFleetInbox {
  /** Open Mission Control items the line holds: candidates, and open items escalated to the human. */
  open: number;
  /** Of those, the items older than the unanswered threshold. */
  unanswered: number;
  oldestAt: number | null;
}

export interface IFleetRow {
  workspaceId: string;
  workspaceName: string;
  tabId: string;
  tabName: string;
  panelType: TPanelType | null;
  providerId: string | null;
  epic: string | null;
  state: TFleetState;
  /** The served cliState; the panel shows it in a tooltip for the `unknown` state. */
  rawCliState: string | null;
  /** When the tab entered `state`; null when no stamp says so. */
  since: number | null;
  lastActivityAt: number | null;
  waits: IFleetWait[];
  lastLine: { text: string; at: number } | null;
  /** At its prompt after a server restart with no persisted stop: whether it ended on a line is unknown. */
  endLineUnknown: boolean;
  /** null when the SM inbox could not be read. */
  inbox: IFleetInbox | null;
  flags: IFleetFlag[];
  /** When `tab restart` last relaunched the tab (ADR-0028); null when it never did. */
  restartedAt?: number | null;
}

export interface IFleetUnattributed {
  workspaceId: string;
  workspaceName: string;
  inbox: IFleetInbox;
  flags: IFleetFlag[];
}

export interface IFleetThresholds {
  stallMinutes: number;
  waitingLongMinutes: number;
  unansweredMinutes: number;
  composerMinutes: number;
}

/** A workspace's agent tabs against the WIP cap (ADR-0027); `overCap := count > cap`. */
export interface IFleetWip {
  count: number;
  cap: number;
  overCap: boolean;
}

export interface IFleetView {
  at: number;
  thresholds: IFleetThresholds;
  rows: IFleetRow[];
  /** SM-inbox items whose posting tab is not known, per workspace (never hidden). */
  unattributed: IFleetUnattributed[];
  /**
   * Read errors by scope (a workspace name, or `watches`, `jobs`, `leases`, `SM inbox`, `WIP cap`); the rest still
   * renders. A workspace's error also names its `workspaceId`, since a workspace may share a name with a scope.
   */
  errors: Array<{ scope: string; error: string; workspaceId?: string }>;
  /** Per workspace id (ADR-0027); absent from a server older than it, or when the cap could not be read. */
  wip?: Record<string, IFleetWip>;
  /** The pool's shadow-mode would-refuse counter (vel-D4 review r1 F1); absent when it could not be read. */
  pool?: IPoolWouldRefuseView;
  /** Rotation coverage (vel-D5): workers that rotate, rotations and refusals, wait-to-rotate; absent when unread. */
  rotation?: import('@/types/rotation-checkpoint').IRotationCoverage;
}

export type TComposerReading = 'empty' | 'text' | 'unreadable';

/** What the server knows about one agent tab, gathered before the pure derivation. */
export interface IFleetTabFacts {
  workspaceId: string;
  workspaceName: string;
  tabId: string;
  tabName: string;
  panelType: TPanelType | null;
  providerId: string | null;
  epic: string | null;
  status: Pick<IClientTabStatusEntry,
    'cliState' | 'lastEvent' | 'busySince' | 'readyForReviewAt' | 'turnEnd' | 'permissionRequest' | 'startupPrompt'> | null;
  /** mtime of the main transcript; null when unknown. */
  transcriptAt: number | null;
  /** When the watchdog sent its `stuck` nudge for the current busy stretch; null when it did not. */
  stallReportedAt: number | null;
  /** When the agent was last seen to stop running (`inactive`); null when not inactive or not observed. */
  inactiveSince: number | null;
  /** Armed watches the tab owns; null when the watch store could not be read. */
  watches: Array<{ kind: string; target: string }> | null;
  /** Live registered `tab bg` jobs; null when the liveness store could not be read. */
  liveJobs: Array<{ pid: number; label?: string }> | null;
  /** The composer, with the time the current text was first seen; null when it was not read. */
  composer: { reading: TComposerReading; since: number | null } | null;
  /** Open SM-inbox items this tab opened; null when the SM inbox could not be read. */
  inbox: Array<{ createdAt: number; reviewed: boolean }> | null;
  /** The layout's `lastRestartAt` (ADR-0028); null when the tab was never restarted. */
  restartedAt?: number | null;
}
