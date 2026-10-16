import type { IFleetView } from '@/types/fleet-status';
import type { IGrant } from '@/types/grant';
import type { IInboxItem } from '@/types/inbox';
import type { ILeaseView } from '@/types/lease';
import type { INoteView } from '@/types/note';
import type { IWatchView } from '@/types/watch';
import type { TCliState } from '@/types/timeline';

// The Mission Control coordination panel (story 20): each section is its own
// result, so one unreadable store shows its error and never blanks the others.

export type TSection<T> = { ok: true; items: T[] } | { ok: false; error: string };

export interface INoteRow extends INoteView {
  ageSeconds: number;
}

export interface IDiskUse {
  path: string;
  /** null when the filesystem reports no blocks (unknown, never 0 %). */
  usedPct: number | null;
  freeBytes: number;
  inodesUsedPct: number | null;
}

export type THostMetrics =
  | {
    available: true;
    disks: IDiskUse[];
    /** Inode use of /tmp (a tmpfs on this host holds bulk downloads in RAM). */
    tmpInodesUsedPct: number | null;
    loadAverage: [number, number, number];
    memAvailableBytes: number;
  }
  | { available: false; reason: string };

export interface IHostSignalsValue {
  schemaVersion: number;
  stampedAt: number;
  gateSlots: { total: number; held: number; holders: Array<{ pid: number; log: string }> };
  worktrees: Array<{ repo: string; count: number; byEpic: Record<string, number> }>;
  tmpInodesPct: number;
}

export type THostSignals =
  | { state: 'not-configured' }
  | { state: 'pending' }
  | { state: 'ok'; value: IHostSignalsValue; ranAt: number; stale: boolean }
  | { state: 'error'; error: string; ranAt: number; stale: boolean };

export type TOrchestratorCoverageState = 'missing' | 'uncertain';

export type TOrchestratorPresenceState = 'usable' | 'missing' | 'disabled' | 'dead' | 'unknown';

export type TWorkspaceWorkState = 'remaining' | 'complete' | 'unknown';

export interface IOrchestratorPresenceTab {
  tabId: string;
  tabName: string;
  isAgent: boolean;
  cliState: TCliState | null;
}

export interface IOrchestratorPresenceFacts {
  workspaceId: string;
  workspaceName: string;
  orchestration: { enabled: boolean; orchestratorTabId: string | null } | null;
  /** null means the lease store could not be read. */
  epicLeases: string[] | null;
  /** undefined means the standup store could not be read; null means no standup exists. */
  standupState: 'on-track' | 'at-risk' | 'blocked' | 'awaiting-human' | 'done' | null | undefined;
  /** null means the workspace layout or tab state could not be read. */
  tabs: IOrchestratorPresenceTab[] | null;
  /** null means registered background liveness could not be read. */
  liveBackgroundTabIds: string[] | null;
  /** Some registered jobs could not be assessed even when other live jobs are known. */
  backgroundWorkIncomplete: boolean;
}

export interface IOrchestratorPresenceIssue {
  workspaceId: string;
  workspaceName: string;
  state: TOrchestratorCoverageState;
  workState: TWorkspaceWorkState;
  orchestratorState: TOrchestratorPresenceState;
  designatedTabId: string | null;
  evidence: string[];
  reason: string;
  observedAt: number;
}

export interface ICoordinationSnapshot {
  at: number;
  leases: TSection<ILeaseView>;
  notes: TSection<INoteRow>;
  watches: TSection<IWatchView>;
  grants: TSection<IGrant>;
  inboxHeld: TSection<IInboxItem>;
  orchestrators: TSection<IOrchestratorPresenceIssue>;
  host: THostMetrics;
  signals: THostSignals;
  /** The fleet status panel (ADR-0023). Absent from a server older than it. */
  fleet?: TFleetSection;
}

export type TFleetSection = { ok: true; view: IFleetView } | { ok: false; error: string };
