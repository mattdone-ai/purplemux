import type { ISessionInfo } from '@/types/timeline';
import type { ITab, TPanelType, IWorkspace, TTabRole } from '@/types/terminal';
import type { ICurrentAction } from '@/types/status';
import type { IPermissionRequest } from '@/types/codex-permission';

export interface IAgentResumeCommandOptions {
  workspaceId?: string;
  model?: string;
  effort?: string;
  /** Claude only: the tab's role tool configuration and its preview origin (ADR-0040). */
  role?: TTabRole;
  previewOrigin?: string;
  /** An evaluator's libpq service, exported as PGSERVICE (ADR-0040). */
  pgService?: string;
}

export interface IAgentLaunchCommandOptions {
  workspaceId?: string;
  model?: string;
  effort?: string;
  /** Claude only: the tab's role tool configuration and its preview origin (ADR-0040). */
  role?: TTabRole;
  previewOrigin?: string;
  /** An evaluator's libpq service, exported as PGSERVICE (ADR-0040). */
  pgService?: string;
}

export interface IAgentSessionWatchOptions {
  skipInitial?: boolean;
  tmuxSession?: string;
}

export interface IAgentSessionDetectionOptions {
  allowCwdFallback?: boolean;
  /** The pane's tmux session, which names the workspace its agent home belongs to. */
  tmuxSession?: string;
}

export interface ISubscription {
  stop: () => void;
}

export type ISessionWatcher = ISubscription;

export interface IAgentPreflight {
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  loggedIn: boolean;
}

export interface IRuntimeSnapshotOptions {
  force?: boolean;
  /**
   * Background tasks started before this time (the agent process's start) are
   * ignored: a task open when the process died never reports back (ADR-0018).
   */
  tasksSince?: number | null;
  /** Compute `backgroundActivityAt` (file stats); only the stall check needs it. */
  withActivity?: boolean;
  /**
   * Read the background ledger (the main transcript and every subagent
   * transcript). Only the watchdog's stop classification, unknown-state
   * resolution and stall check use it, so the snippet and metadata reads skip it.
   */
  withBackground?: boolean;
}

/**
 * How the current turn ended when it ended on a provider error (ADR-0018,
 * story 26). Read from structured fields only, never from message text: a
 * worker quoting "API Error:" or a pane's usage-warning footer is not an error.
 */
export interface ITurnError {
  class: 'api-error' | 'usage-limit' | 'other';
  /** The provider's error code (`server_error`, `usage_limit_exceeded` …). */
  code: string;
  /** The error message, ≤ 300 characters. */
  text: string;
  /** Identifies the failed turn: the error entry's uuid (Claude) or turn id (Codex). */
  turnId: string;
}

export interface IOpenBackgroundTaskKinds {
  shell: number;
  agent: number;
  monitor: number;
}

export interface IAgentRuntimeSnapshot {
  idle: boolean;
  stale: boolean;
  lastAssistantSnippet: string | null;
  currentAction: ICurrentAction | null;
  reset: boolean;
  lastEntryTs: number | null;
  staleMs: number;
  interrupted: boolean;
  /**
   * Background jobs and async subagents the agent started and has not yet
   * been told finished. An idle turn with any of these open is WAITING, not
   * done: the harness re-invokes the agent when they exit, so reporting the
   * tab as ready for review at that moment is premature. Optional so providers
   * that cannot observe it keep their current behaviour.
   */
  openBackgroundTasks?: number;
  /**
   * Newest sign of life of that background work (task output files, subagent
   * transcripts, Monitor events, the transcript itself); null when nothing is
   * open. The main transcript alone is quiet while a subagent works (L19).
   */
  backgroundActivityAt?: number | null;
  /**
   * False when the provider could not read the transcript at all (the snapshot
   * is empty); absent when the provider cannot tell. `openBackgroundTasks` is
   * absent when the background ledger could not be read.
   */
  transcriptRead?: boolean;
  /** The open background work by kind; judged differently for a stall (ADR-0018). */
  openBackgroundTaskKinds?: IOpenBackgroundTaskKinds;
  /**
   * The final ≤ 600 characters of the current turn's last assistant message.
   * The turn-end marker (`DONE:` …) is its last line, which a head snippet
   * cuts off. Null when the turn has no assistant text; absent when the
   * provider cannot read it.
   */
  lastAssistantTail?: string | null;
  /** The transcript uuid of the entry `lastAssistantTail` was read from (Claude only): the curator's source id. */
  lastAssistantUuid?: string | null;
  /** The current turn's terminal provider error; null for a clean end; absent when the provider cannot tell. */
  lastTurnError?: ITurnError | null;
}

export interface IAgentSessionHistoryStats {
  toolUsage: Record<string, number>;
  touchedFiles: string[];
  lastAssistantText: string | null;
  lastUserText: string | null;
  firstUserTs: number | null;
  lastAssistantTs: number | null;
  turnDurationMs: number | null;
}

export interface IAgentHookMetaPatch {
  sessionId?: string | null;
  jsonlPath?: string | null;
  lastUserMessage?: string | null;
  agentSummary?: string | null;
  clearMessages?: boolean;
  permissionRequest?: IPermissionRequest | null;
}

export interface IAgentHookTranslation {
  meta?: IAgentHookMetaPatch;
  event?: TAgentWorkStateEvent | null;
  sessionInfo?: ISessionInfo | null;
  clearSession?: boolean;
}

/**
 * Hook-shaped event kinds delivered from the agent CLI's hook protocol.
 * Single source of truth for the Claude hook translator + status-manager dispatcher.
 */
/** Claude Code's SessionStart `source`. */
export type TSessionStartSource = 'startup' | 'resume' | 'clear' | 'compact';
export const SESSION_START_SOURCES: readonly TSessionStartSource[] = ['startup', 'resume', 'clear', 'compact'];

export const HOOK_EVENT_KINDS = [
  'session-start',
  'prompt-submit',
  'notification',
  'stop',
  'interrupt',
  'pre-compact',
  'post-compact',
] as const;
export type THookEventKind = typeof HOOK_EVENT_KINDS[number];

/**
 * Standardized work-state events that providers emit. Maps to TCliState transitions:
 *  - session-start → idle, except a compaction's own SessionStart (`source: compact`), which keeps the state (L30)
 *  - prompt-submit → busy
 *  - notification → needs-input (gated by notificationType)
 *  - stop → ready-for-review
 *  - interrupt → idle
 *  - pre-compact / post-compact → compaction state, no cliState change
 *
 * The non-hook variants (summary-update, last-user-message) originate from runtime
 * sources (pane-title polling, jsonl watcher) and never come through the hook path.
 */
export type TAgentWorkStateEvent =
  | { kind: 'session-start'; source?: TSessionStartSource }
  /** `fromTool`: a Codex PreToolUse or PostToolUse, read as prompt-submit by the work-state machine; it starts no turn. */
  | { kind: 'prompt-submit'; fromTool?: true }
  | { kind: 'notification'; notificationType?: string }
  | { kind: 'stop' }
  | { kind: 'interrupt' }
  | { kind: 'pre-compact' }
  | { kind: 'post-compact' }
  | { kind: 'summary-update'; summary: string | null }
  | { kind: 'last-user-message'; message: string };

export interface IAgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly panelType: TPanelType;

  matchesProcess(commandName: string, args?: string[]): boolean;
  isValidSessionId(id: unknown): id is string;

  detectActiveSession(panePid: number, childPids?: number[], options?: IAgentSessionDetectionOptions): Promise<ISessionInfo>;
  isAgentRunning(panePid: number, childPids?: number[]): Promise<boolean>;
  watchSessions(
    panePid: number,
    onChange: (info: ISessionInfo) => void,
    options?: IAgentSessionWatchOptions,
  ): ISessionWatcher;

  buildResumeCommand(sessionId: string, options: IAgentResumeCommandOptions): Promise<string>;
  buildLaunchCommand(options: IAgentLaunchCommandOptions): Promise<string>;

  readSessionId(tab: ITab): string | null;
  writeSessionId(tab: ITab, sessionId: string | null | undefined): void;
  readJsonlPath(tab: ITab): string | null;
  writeJsonlPath(tab: ITab, jsonlPath: string | null | undefined): void;
  readSummary(tab: ITab): string | null;
  writeSummary(tab: ITab, summary: string | null | undefined): void;

  parsePaneTitle(paneTitle: string | null): string | null;
  sessionIdFromJsonlPath(jsonlPath: string | null | undefined): string | null;
  readRuntimeSnapshot(jsonlPath: string, options?: IRuntimeSnapshotOptions): Promise<IAgentRuntimeSnapshot>;
  readSessionHistoryStats(jsonlPath: string): Promise<IAgentSessionHistoryStats>;
  preflight(): Promise<IAgentPreflight>;
  writeWorkspacePrompt?(ws: IWorkspace): Promise<void>;

}
