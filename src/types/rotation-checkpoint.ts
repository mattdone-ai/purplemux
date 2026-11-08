/**
 * What git says about the tab's working directory on the host the tab runs on (vel-D5). Filled by a tool, never by
 * the agent. `ok`: a git worktree; `no-repo`: the directory is not in one; `no-cwd`: no directory is known or it is gone.
 */
export interface IGitFacts {
  kind: 'ok' | 'no-repo' | 'no-cwd';
  /** The ssh alias the facts were read on; null on the control host, absent when the reader did not say. */
  host?: string | null;
  cwd: string | null;
  worktree: string | null;
  /** Null on a detached HEAD. */
  branch: string | null;
  head: string | null;
  /** The ref the base is measured against: `origin/HEAD`'s target, else the upstream. */
  baseRef: string | null;
  base: string | null;
  dirty: number | null;
  /** Asked with an expected head: whether that head is HEAD or one of its ancestors. */
  containsExpected?: boolean | null;
}

/**
 * A checkpoint only moves forward. `written` and read back gates the clear; `cleared` once the restart ran;
 * `delivering` while the first message is typed (the freeze point); `delivered` after it. `abandoned`: the restart was
 * refused; `undelivered`: no fresh session took it in time; `delivery-unknown`: a server stopped mid-delivery.
 */
export type TCheckpointStatus = 'written' | 'cleared' | 'delivering' | 'delivered' | 'abandoned' | 'undelivered' | 'delivery-unknown';

export interface IInFlightRow {
  itemKey: string;
  state: string;
  nextAction: string;
  waitingOn: string;
}

/** The durable rotation checkpoint, keyed `<taskId>#<attempt>`; never by a session or a provider account. */
export interface IRotationCheckpoint {
  id: string;
  /** The seat item key `seat:<ws>:<tab-name>`: stable across restarts, sessions and accounts. */
  taskId: string;
  attempt: number;
  workspaceId: string;
  tabId: string;
  tabName: string;
  /** The ssh alias the tab runs on; null on the control host. */
  host: string | null;
  createdAt: number;
  handoffPath: string;
  handoffDigest: string;
  handoffText: string;
  facts: IGitFacts;
  /** From the agent's handoff: `## Resume command`. */
  intendedNextAction: string;
  inFlight: IInFlightRow[];
  /** `## Open questions`: Mission Control item ids. */
  outstandingDecisionIds: string[];
  /** `## Do not`. */
  failedApproaches: string[];
  /** The standing rules' sources. */
  evidenceRefs: string[];
  /** `## Decisions in the last 24 h`. */
  rationale: string[];
  role: string[];
  /** The agent session the checkpoint was taken from: a resume tells a cleared session from the same one. */
  sessionBefore: string | null;
}

export interface IStoredCheckpoint {
  checkpoint: IRotationCheckpoint;
  status: TCheckpointStatus;
  digest: string;
  updatedAt: number;
}

/** One seat in the fleet view's rotation coverage (vel-D5 AC6). */
export interface IRotationSeatRow {
  workspaceId: string;
  itemKey: string;
  holder: string | null;
  phase: string | null;
  rotations: number | null;
  handoffRefusals: number | null;
  checkpointRefusals: number | null;
  rotationTimeouts: number | null;
  checkpointRefused: string | null;
  checkpointMismatch: string | null;
  lastWaitToRotateMs: number | null;
  /** While a rotation is due and not yet cleared: how long it has waited. */
  waitingMs: number | null;
}

export interface IRotationCoverage {
  /** Agent tabs in every readable layout. The rotation totals below count closed seats too. */
  workers: number;
  /** Agent tabs with a handoff path whose rotation is not off. */
  covered: number;
  /** covered / workers, or null with no worker. */
  coverage: number | null;
  rotations: number | null;
  handoffRefusals: number | null;
  checkpointRefusals: number | null;
  rotationTimeouts: number | null;
  /** Rotation due to the clear, summed over the rotations that recorded it. A null counter was never written: not measured. */
  waitToRotateTotalMs: number | null;
  waitToRotateMeanMs: number | null;
  seats: IRotationSeatRow[];
}
