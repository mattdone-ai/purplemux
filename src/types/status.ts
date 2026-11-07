import type { TWakeClass } from '@/types/tab-events';
import type { TCliState, TStartupPrompt, TToolName } from '@/types/timeline';
import type { TPanelType } from '@/types/terminal';
import type { ISessionHistoryEntry } from '@/types/session-history';
import type { IPermissionRequest } from '@/types/codex-permission';
import type { TMissionAnswerType } from '@/types/mission-control';

export type TTerminalStatus = 'idle' | 'running' | 'server';

export type TEventName = 'session-start' | 'prompt-submit' | 'notification' | 'stop' | 'interrupt';

export interface ILastEvent {
  name: TEventName;
  at: number;
  seq: number;
}

export interface ICurrentAction {
  toolName: TToolName | null;
  summary: string;
}

export interface ITabStatusEntry {
  cliState: TCliState;
  workspaceId: string;
  tabName: string;
  currentProcess?: string;
  paneTitle?: string;
  tmuxSession: string;
  panelType?: TPanelType;
  terminalStatus?: TTerminalStatus;
  listeningPorts?: number[];
  agentProviderId?: string;
  agentSessionId?: string | null;
  agentSummary?: string | null;
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
  currentAction?: ICurrentAction | null;
  readyForReviewAt?: number | null;
  busySince?: number | null;
  dismissedAt?: number | null;
  compactingSince?: number | null;
  permissionRequest?: IPermissionRequest | null;
  /** The startup dialog a `startup-prompt` tab waits at, and since when (D14); null in every other state. */
  startupPrompt?: IStartupPromptReading | null;
  processRetries?: number;
  jsonlPath?: string | null;
  lastEvent?: ILastEvent | null;
  eventSeq?: number;
  lastInterruptTs?: number;
  // Wall-clock timestamp of the most recent agent launch/resume signal
  // (auto-resume sendKeys, session-start hook, synthetic interrupt).
  // Drives the F1 grace window that suppresses spurious inactive transitions
  // during the agent's boot-up. Runtime only — not persisted to layout.
  lastResumeOrStartedAt?: number;
  /** Live same-workspace tab that receives this tab's nudges (ADR-0018); mirrors ITab.reportsTo. */
  reportsTo?: string | null;
  /** The markers whose end lines are forwarded (ADR-0025); mirrors ITab.reportOn. Null: every marker. */
  reportOn?: import('@/lib/turn-end').TTurnMarkerName[] | null;
  /** The seat's handoff file (ADR-0036); mirrors ITab.handoffPath. Null: not a seat. */
  handoffPath?: string | null;
  /** Mirrors ITab.rotateAt. */
  rotateAt?: import('@/types/context-lifecycle').TRotateAt | null;
  /** How the watchdog classified the last `stop` (ADR-0018). Runtime only. */
  turnEnd?: ITurnEndRecord | null;
  /** The provider-error episode this tab is in; a clean stop ends it (story 26). Runtime only. */
  turnError?: ITurnErrorEpisode | null;
}

export interface IStartupPromptReading {
  kind: TStartupPrompt;
  since: number;
}

export interface ITurnErrorEpisode {
  class: 'api-error' | 'usage-limit';
  code: string;
  text: string;
  startedAt: number;
  /** The one automatic resume of this episode (an inbox item id). */
  resumeItemId: string | null;
  /** The orchestrator was told; nothing more is sent this episode. */
  escalated: boolean;
  /** The failed turn this episode last saw; a repeated stop of the same turn is no second failure (review r2 nit 1). */
  turnId?: string;
}

export interface ITurnEndRecord {
  kind: 'turn-marker' | 'waiting' | 'ready-for-review' | 'api-error' | 'usage-limit' | 'compacting';
  at: number;
  /** `lastEvent.seq` of the stop this classifies; a newer event makes it stale. */
  seq?: number;
  /** The marker line(s) of a `turn-marker` stop. */
  marker?: string[];
  /** null on a `ready-for-review` stop whose background ledger could not be read. */
  openBackgroundTasks?: number | null;
  liveRegisteredJobs?: number;
  /** `purplemux watch` records the tab owned at the stop (a `waiting` or `ready-for-review` stop). */
  armedWatches?: number;
  /** A `ready-for-review` stop: false when no transcript could be read (the fallback). */
  transcript?: boolean;
  /** The stop seq whose `idle-no-end-line` nudge went out (or was skipped); persisted with the record. */
  idleNudgeSentSeq?: number;
  /** The stop seq whose `long-wait` nudge went out. */
  longWaitSentSeq?: number;
  /** The agent session the stop belongs to; a restored record of another session is dropped (review r2 nit 2). */
  agentSessionId?: string | null;
}

export type TTabDisplayStatus = 'busy' | 'ready-for-review' | 'needs-input' | 'idle' | 'unknown';

export type IClientTabStatusEntry = Omit<ITabStatusEntry, 'tmuxSession' | 'jsonlPath' | 'processRetries'>;

export interface IStatusSyncMessage {
  type: 'status:sync';
  tabs: Record<string, IClientTabStatusEntry>;
  standups?: Record<string, IWorkspaceStandup>;
}

export interface IStatusUpdateMessage {
  type: 'status:update';
  tabId: string;
  cliState: TCliState | null;
  workspaceId: string;
  tabName: string;
  currentProcess?: string;
  paneTitle?: string;
  panelType?: TPanelType;
  terminalStatus?: TTerminalStatus;
  listeningPorts?: number[];
  agentProviderId?: string;
  agentSessionId?: string | null;
  agentSummary?: string | null;
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
  currentAction?: ICurrentAction | null;
  readyForReviewAt?: number | null;
  busySince?: number | null;
  dismissedAt?: number | null;
  compactingSince?: number | null;
  permissionRequest?: IPermissionRequest | null;
  startupPrompt?: IStartupPromptReading | null;
  lastEvent?: ILastEvent | null;
  eventSeq?: number;
}

export interface IRateLimitWindow {
  used_percentage: number;
  resets_at: number;
}

/**
 * A weekly limit scoped to one model (e.g. Fable). Claude Code's statusline
 * payload only carries the account-wide windows; these come from the OAuth
 * usage endpoint, which reports scoped weekly limits separately.
 */
export interface IScopedRateLimitWindow extends IRateLimitWindow {
  label: string;
}

export interface IRateLimitsData {
  ts: number;
  five_hour: IRateLimitWindow | null;
  seven_day: IRateLimitWindow | null;
  scoped?: IScopedRateLimitWindow[];
}

export type TRateLimitsProvider = 'claude' | 'codex';

export interface IRateLimitsCache {
  ts: number;
  claude?: IRateLimitsData | null;
  codex?: IRateLimitsData | null;
}

export interface IRateLimitsUpdateMessage {
  type: 'rate-limits:update';
  data: IRateLimitsCache;
}

export interface ISessionHistorySyncMessage {
  type: 'session-history:sync';
  entries: ISessionHistoryEntry[];
}

export interface ISessionHistoryUpdateMessage {
  type: 'session-history:update';
  entry: ISessionHistoryEntry;
}

export interface IStatusHookEventMessage {
  type: 'status:hook-event';
  tabId: string;
  event: ILastEvent;
}

export type TStandupState = 'on-track' | 'at-risk' | 'blocked' | 'awaiting-human' | 'done';

export type TStandupItemStatus = 'done' | 'active' | 'blocked' | 'todo';

export interface IStandupItem {
  label: string;
  status: TStandupItemStatus;
  note?: string;
}

export interface IStandupBlocker {
  what: string;
  needs: string;
}

export interface IWorkspaceStandup {
  workspaceId: string;
  at: number;
  state: TStandupState;
  headline: string;
  items: IStandupItem[];
  blockers: IStandupBlocker[];
  needsHuman: boolean;
  next: string[];
}

export interface IStandupUpdateMessage {
  type: 'standup:update';
  standup: IWorkspaceStandup;
}

export type TOrchestrationNudgeKind = 'needs-input' | 'ready-for-review' | 'turn-marker' | 'idle-no-end-line' | 'long-wait' | 'api-error' | 'usage-limit' | 'turn-ended' | 'inactive' | 'stuck' | 'heartbeat' | 'off-scope' | 'thrash' | 'stalled' | 'probe-failed' | 'bg-completed' | 'bg-failed' | 'bg-exited-unknown' | 'bg-host-unreachable' | 'bg-died' | 'model-drift';

export interface IOrchestrationNudge {
  id: string;
  workspaceId: string;
  tabId: string;
  tabName: string;
  kind: TOrchestrationNudgeKind;
  message: string;
  at: number;
  delivered: boolean;
  /** How it reaches the tab (ADR-0035): a digest nudge is undelivered until the tab's next digest. */
  wakeClass?: TWakeClass;
}

export interface IOrchestrationNudgeMessage {
  type: 'orchestration:nudge';
  nudge: IOrchestrationNudge;
}

export type TAlertKind = 'needs-input' | 'review' | 'standup-needs-human' | 'orchestrator-stalled' | 'orchestrator-missing' | 'work-stalled' | 'bg-job-died' | 'bg-job-unknown' | 'bg-host-unreachable' | 'flag' | 'attention-opened' | 'needs-decision';

export type TAlertProviderId = 'claude' | 'codex' | 'grok';

export interface IAlert {
  id: string;
  seq: number;
  kind: TAlertKind;
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  providerId: TAlertProviderId;
  isOrchestrator: boolean;
  title: string;
  body: string;
  at: number;
  /** Kind `flag` only (ADR-0032): the raised fleet or flow flag. */
  flag?: IAlertFlag;
  /** Kind `attention-opened` only: the Mission Control item that was opened for the human. */
  itemId?: string;
  /**
   * Kind `attention-opened` only (story 33, ADR-HFL-11 decision 6): what a notification needs to
   * answer the item in place. Additive (ADR-0004): a client that does not read it opens the item.
   */
  question?: IAlertQuestion;
}

/** The item's question as the alert carries it: the decision, how it is answered, and the revision shown. */
export interface IAlertQuestion {
  /** 2 for the ADR-0037 format, 1 for an item without it. */
  formatVersion: 1 | 2;
  /** `decision` on v2, `title` on v1, trimmed. */
  decision: string;
  /** The type the answer route judges the answer by (`effectiveAnswerType`). */
  answerType: TMissionAnswerType;
  options: IAlertQuestionOption[];
  /** The item revision this summary describes: the `expectedRevision` an answer from it carries. */
  revision: number;
}

export interface IAlertQuestionOption {
  id: string;
  label: string;
  needsText: boolean;
}

export type TAlertFlagSource = 'fleet' | 'flow' | 'ledger';

export interface IAlertFlag {
  source: TAlertFlagSource;
  rule: string;
  subject: string;
  text: string;
}

export interface INotificationAlertMessage {
  type: 'notification:alert';
  alert: IAlert;
}

export type TStatusServerMessage = IStatusSyncMessage | IStatusUpdateMessage | IRateLimitsUpdateMessage | ISessionHistorySyncMessage | ISessionHistoryUpdateMessage | IStatusHookEventMessage | IOrchestrationNudgeMessage | IStandupUpdateMessage | INotificationAlertMessage;

export interface IStatusTabDismissedMessage {
  type: 'status:tab-dismissed';
  tabId: string;
}

export interface IStatusRequestSyncMessage {
  type: 'status:request-sync';
}

export interface IStatusAckNotificationMessage {
  type: 'status:ack-notification';
  tabId: string;
  seq: number;
}

export type TStatusClientMessage =
  | IStatusTabDismissedMessage
  | IStatusRequestSyncMessage
  | IStatusAckNotificationMessage;
