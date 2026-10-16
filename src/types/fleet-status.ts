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

export interface IFleetView {
  at: number;
  thresholds: IFleetThresholds;
  rows: IFleetRow[];
  /** SM-inbox items whose posting tab is not known, per workspace (never hidden). */
  unattributed: IFleetUnattributed[];
  /** Read errors by scope (a workspace name, or `watches`, `jobs`, `leases`, `SM inbox`); the rest still renders. */
  errors: Array<{ scope: string; error: string }>;
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
    'cliState' | 'lastEvent' | 'busySince' | 'readyForReviewAt' | 'turnEnd' | 'permissionRequest'> | null;
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
}
