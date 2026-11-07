// Liveness watch: registered probes and background jobs the watchdog polls so
// that delegated work whose tab looks healthy cannot die silently. Born from a
// 7-hour stall where every watcher watched milestones or idleness — nothing
// watched progress freshness.

export interface ILivenessProbe {
  workspaceId: string;
  tabId: string;
  /** Distinguishes multiple probes on one tab; defaults to "default". */
  label: string;
  /** Shell command; its stdout's last non-empty line must be seconds-since-last-progress. */
  command: string;
  /** Reported age above this is a stall. */
  stalenessThresholdS: number;
  /** Minimum seconds between probe runs. */
  intervalS: number;
  registeredAt: number;
}

export interface IBackgroundJob {
  workspaceId: string;
  tabId: string;
  pid: number;
  /**
   * The ssh alias of the host the pid lives on: the registering tab's host
   * (ADR-0022). The pid and both files are read there, never here (D63).
   * `null`: registered on this server's host. Absent in a saved record: written
   * before jobs named their host, so the host is read from the layout.
   */
  host?: string | null;
  label?: string;
  /** File the job's stderr was redirected to; its tail is included in the death notification. */
  stderrFile?: string;
  /** File the launcher writes the exit code to (`cmd; echo $? > file`); read on death. */
  exitCodeFile?: string;
  /**
   * Who is woken when the job exits: `orchestrator` (default — the tab's
   * `reportsTo`, else the workspace orchestrator, else the tab itself) or
   * `self` (the registering tab, so a worker wakes on its own gate).
   */
  notify?: TBackgroundJobNotify;
  registeredAt: number;
}

export type TBackgroundJobNotify = 'self' | 'orchestrator';

export interface IProbeStatus {
  label: string;
  command: string;
  stalenessThresholdS: number;
  intervalS: number;
  lastRunAt: number | null;
  lastAgeS: number | null;
  stale: boolean;
  consecutiveFailures: number;
  lastError: string | null;
}

/**
 * `unknown`: a remote job whose host has not answered yet, or does not answer;
 * it is not known to have exited. A local job is always `alive` or `exited`.
 */
export type TBackgroundJobState = 'alive' | 'exited' | 'unknown';

export interface IBackgroundJobStatus {
  pid: number;
  label?: string;
  host?: string;
  /** True only when the job is attested alive. */
  alive: boolean;
  state: TBackgroundJobState;
  registeredAt: number;
  ageS: number;
}

export type TLivenessEvent =
  | { kind: 'stalled'; probe: ILivenessProbe; ageS: number }
  | { kind: 'probe-failed'; probe: ILivenessProbe; error: string; failures: number }
  | { kind: 'bg-completed'; job: IBackgroundJob; exitCode: 0; stderrTail: string | null }
  | { kind: 'bg-failed'; job: IBackgroundJob; exitCode: number; stderrTail: string | null }
  | { kind: 'bg-exited-unknown'; job: IBackgroundJob; stderrTail: string | null }
  /** The job's host failed the bounded number of probes: its state is unknown, it is not known to have exited. */
  | { kind: 'bg-host-unreachable'; job: IBackgroundJob; host: string; failures: number; error: string };
