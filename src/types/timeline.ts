export type TSessionDetectionStatus = 'unknown' | 'starting' | 'running' | 'not-running' | 'not-initialized' | 'not-installed';

/**
 * `startup-prompt`: the agent runs but waits at a Claude Code startup dialog (folder trust, external
 * CLAUDE.md imports) that no hook reports (D14). Runtime only: the layout stores it as `inactive`.
 */
export type TCliState = 'idle' | 'busy' | 'inactive' | 'startup-prompt' | 'ready-for-review' | 'needs-input' | 'cancelled' | 'unknown';

/** The Claude Code startup dialog a `startup-prompt` tab waits at. */
export type TStartupPrompt = 'folder-trust' | 'external-imports';

export type TTimelineConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ISessionInfo {
  status: TSessionDetectionStatus;
  sessionId: string | null;
  jsonlPath: string | null;
  pid: number | null;
  startedAt: number | null;
  cwd: string | null;
}

export type TTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface ITaskItem {
  taskId: string;
  subject: string;
  description?: string;
  status: TTaskStatus;
}

export type TTimelineEntryType =
  | 'user-message'
  | 'assistant-message'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'agent-group'
  | 'task-notification'
  | 'task-progress'
  | 'plan'
  | 'ask-user-question'
  | 'interrupt'
  | 'session-exit'
  | 'turn-end'
  | 'reasoning-summary'
  | 'error-notice'
  | 'approval-request'
  | 'exec-command-stream'
  | 'web-search'
  | 'mcp-tool-call'
  | 'patch-apply'
  | 'context-compacted';

/**
 * Identity shared by every timeline entry.
 *
 * `id` is derived from the source record — the Claude record `uuid`
 * (`<uuid>#<n>` when one record yields several entries) or, when the provider
 * supplies no record id, `sha1(<sessionId>:<byteOffset>:<ordinal>)`. Parsing
 * the same bytes twice therefore yields the same id, which is what lets a
 * client upsert instead of duplicating.
 *
 * `seq` orders entries within a session: the absolute byte offset of the
 * entry's source line plus its ordinal within that record. It starts at 0 for
 * the first entry and increases strictly in file order, and — unlike a dense
 * 0,1,2… ordinal — it can be computed from any chunk of the file without
 * parsing everything before it. Entries nested in an `agent-group` are
 * numbered 0,1,2… within their group; the group entry itself carries the
 * parent-session seq. Optional while clients that predate it are still in use.
 */
export interface ITimelineEntryBase {
  id: string;
  seq?: number;
}

export interface ITimelineUserMessage extends ITimelineEntryBase {
  type: 'user-message';
  timestamp: number;
  text: string;
  images?: string[];
  pending?: boolean;
  attachmentPlaceholder?: boolean;
  fadingOut?: boolean;
}

export interface ITimelineAssistantMessage extends ITimelineEntryBase {
  type: 'assistant-message';
  timestamp: number;
  markdown: string;
  stopReason?: string | null;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    };
    speed?: 'fast' | string;
    server_tool_use?: {
      web_search_requests?: number;
    };
  };
}

export interface ITimelineThinking extends ITimelineEntryBase {
  type: 'thinking';
  timestamp: number;
  thinking: string;
}

export type TToolName = 'Read' | 'Edit' | 'Write' | 'Bash' | 'Grep' | 'Glob' | 'Agent' | string;

export type TToolStatus = 'pending' | 'success' | 'error';

export interface ITimelineDiff {
  filePath: string;
  oldString: string;
  newString: string;
}

export interface ITimelineToolCall extends ITimelineEntryBase {
  type: 'tool-call';
  timestamp: number;
  toolUseId: string;
  toolName: TToolName;
  summary: string;
  filePath?: string;
  diff?: ITimelineDiff;
  status: TToolStatus;
}

export interface ITimelineToolResult extends ITimelineEntryBase {
  type: 'tool-result';
  timestamp: number;
  toolUseId: string;
  isError: boolean;
  summary: string;
}

export interface ITimelineAgentGroup extends ITimelineEntryBase {
  type: 'agent-group';
  timestamp: number;
  agentType: string;
  description: string;
  entryCount: number;
  entries: ITimelineEntry[];
}

export interface ITimelineTaskNotification extends ITimelineEntryBase {
  type: 'task-notification';
  timestamp: number;
  taskId: string;
  status: 'completed' | 'failed' | string;
  summary: string;
  result?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
}

export interface ITimelineTaskProgress extends ITimelineEntryBase {
  type: 'task-progress';
  timestamp: number;
  action: 'create' | 'update';
  taskId: string;
  toolUseId?: string;
  subject?: string;
  description?: string;
  status: TTaskStatus;
}

export interface IPlanAllowedPrompt {
  tool: string;
  prompt: string;
}

export interface ITimelinePlan extends ITimelineEntryBase {
  type: 'plan';
  timestamp: number;
  toolUseId: string;
  markdown: string;
  filePath?: string;
  allowedPrompts?: IPlanAllowedPrompt[];
  status: TToolStatus;
}

export interface IAskUserQuestionOption {
  label: string;
  description: string;
}

export interface IAskUserQuestionItem {
  question: string;
  header: string;
  options: IAskUserQuestionOption[];
  multiSelect: boolean;
}

export interface ITimelineAskUserQuestion extends ITimelineEntryBase {
  type: 'ask-user-question';
  timestamp: number;
  toolUseId: string;
  questions: IAskUserQuestionItem[];
  status: TToolStatus;
  answer?: string;
}

export interface ITimelineInterrupt extends ITimelineEntryBase {
  type: 'interrupt';
  timestamp: number;
}

export interface ITimelineSessionExit extends ITimelineEntryBase {
  type: 'session-exit';
  timestamp: number;
}

export interface ITimelineTurnEnd extends ITimelineEntryBase {
  type: 'turn-end';
  timestamp: number;
}

export interface ITimelineReasoningSummary extends ITimelineEntryBase {
  type: 'reasoning-summary';
  timestamp: number;
  summary: string[];
  hasEncryptedContent: boolean;
}

export type TErrorSeverity = 'error' | 'warning' | 'stream-error' | 'guardian-warning';

export interface ITimelineErrorNotice extends ITimelineEntryBase {
  type: 'error-notice';
  timestamp: number;
  severity: TErrorSeverity;
  message: string;
  retryStatus?: string;
  errorCode?: string;
}

export type TApprovalKind = 'exec' | 'apply-patch' | 'permissions';

export interface ITimelineApprovalRequest extends ITimelineEntryBase {
  type: 'approval-request';
  timestamp: number;
  approvalKind: TApprovalKind;
  callId: string;
  command?: string;
  cwd?: string;
  patches?: Array<{ path: string; status?: string }>;
  permissions?: string[];
  status: TToolStatus;
}

export interface ITimelineExecCommandStream extends ITimelineEntryBase {
  type: 'exec-command-stream';
  timestamp: number;
  callId: string;
  command: string;
  parsedCommand?: string;
  cwd?: string;
  stdout: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
  status: TToolStatus;
}

export interface ITimelineWebSearch extends ITimelineEntryBase {
  type: 'web-search';
  timestamp: number;
  callId: string;
  query?: string;
  resultsSummary?: string;
  resultCount?: number;
  status: TToolStatus;
}

export interface ITimelineMcpToolCall extends ITimelineEntryBase {
  type: 'mcp-tool-call';
  timestamp: number;
  callId: string;
  server: string;
  tool: string;
  argumentsSummary?: string;
  resultSummary?: string;
  status: TToolStatus;
}

export interface IPatchApplyFile {
  path: string;
  status?: string;
}

export interface ITimelinePatchApply extends ITimelineEntryBase {
  type: 'patch-apply';
  timestamp: number;
  callId: string;
  files: IPatchApplyFile[];
  diff?: string;
  success?: boolean;
  status: TToolStatus;
}

export interface ITimelineContextCompacted extends ITimelineEntryBase {
  type: 'context-compacted';
  timestamp: number;
  beforeTokens?: number;
  afterTokens?: number;
}

export type ITimelineEntry =
  | ITimelineUserMessage
  | ITimelineAssistantMessage
  | ITimelineThinking
  | ITimelineToolCall
  | ITimelineToolResult
  | ITimelineAgentGroup
  | ITimelineTaskNotification
  | ITimelineTaskProgress
  | ITimelinePlan
  | ITimelineAskUserQuestion
  | ITimelineInterrupt
  | ITimelineSessionExit
  | ITimelineTurnEnd
  | ITimelineReasoningSummary
  | ITimelineErrorNotice
  | ITimelineApprovalRequest
  | ITimelineExecCommandStream
  | ITimelineWebSearch
  | ITimelineMcpToolCall
  | ITimelinePatchApply
  | ITimelineContextCompacted;

export interface IInitMeta {
  createdAt: string | null;
  updatedAt: string | null;
  lastTimestamp: number;
  fileSize: number;
  userCount: number;
  assistantCount: number;
  customTitle?: string;
}

export interface ISessionStats {
  sessionId: string;
  transcriptPath?: string;

  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cost?: number | null;
  currentContextTokens?: number;
  contextWindowSize?: number;
  usedPercentage?: number | null;
  model?: string | null;
  exceeds200k?: boolean;
  receivedAt?: number;
}

export interface ITimelineInitMessage {
  type: 'timeline:init';
  entries: ITimelineEntry[];
  sessionId: string;
  /** `<provider>:<global|wsId>:<sessionId>` — see `@/lib/session-key`. */
  sessionKey?: string;
  totalEntries: number;
  startByteOffset: number;
  hasMore: boolean;
  jsonlPath?: string | null;
  summary?: string;
  meta?: IInitMeta;
  sessionStats?: ISessionStats | null;
  isClaudeStarting?: boolean;
}

export interface ITimelineStatsUpdateMessage {
  type: 'timeline:stats-update';
  sessionStats: ISessionStats;
}

export interface ITimelineAppendMessage {
  type: 'timeline:append';
  entries: ITimelineEntry[];
}

export interface ITimelineSessionChangedMessage {
  type: 'timeline:session-changed';
  newSessionId: string;
  reason: string;
}

export interface ITimelineErrorMessage {
  type: 'timeline:error';
  code: string;
  message: string;
}

export interface ITimelineResumeStartedMessage {
  type: 'timeline:resume-started';
  sessionId: string;
  jsonlPath: string | null;
}

export interface ITimelineResumeBlockedMessage {
  type: 'timeline:resume-blocked';
  reason: string;
  processName?: string;
}

export interface ITimelineResumeErrorMessage {
  type: 'timeline:resume-error';
  message: string;
}

export type TTimelineServerMessage =
  | ITimelineInitMessage
  | ITimelineAppendMessage
  | ITimelineSessionChangedMessage
  | ITimelineErrorMessage
  | ITimelineResumeStartedMessage
  | ITimelineResumeBlockedMessage
  | ITimelineResumeErrorMessage
  | ITimelineStatsUpdateMessage;

export interface ITimelineSubscribeMessage {
  type: 'timeline:subscribe';
  jsonlPath: string;
}

export interface ITimelineUnsubscribeMessage {
  type: 'timeline:unsubscribe';
}

export interface ITimelineResumeMessage {
  type: 'timeline:resume';
  sessionId: string;
  tmuxSession: string;
}

export type TTimelineClientMessage =
  | ITimelineSubscribeMessage
  | ITimelineUnsubscribeMessage
  | ITimelineResumeMessage;

export interface IChunkReadResult {
  entries: ITimelineEntry[];
  startByteOffset: number;
  fileSize: number;
  hasMore: boolean;
  errorCount: number;
  summary?: string;
  customTitle?: string;
}

export interface IParseResult {
  entries: ITimelineEntry[];
  entryLineOffsets: number[];
  lastOffset: number;
  totalLines: number;
  errorCount: number;
  summary?: string;
  customTitle?: string;
}

export interface IIncrementalResult {
  newEntries: ITimelineEntry[];
  newOffset: number;
  /**
   * Raw bytes of the trailing partial record, carried into the next read. Bytes
   * rather than text: an append can tear a multi-byte character, and decoding
   * the remainder would replace its lead bytes with U+FFFD unrecoverably.
   */
  pendingBuffer: Buffer;
}

export interface ISessionMeta {
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  firstMessage: string;
  turnCount: number;
}
