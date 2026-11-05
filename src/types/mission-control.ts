import type { TCliState } from '@/types/timeline';

export type TMissionRunState = 'running' | 'waiting' | 'completed' | 'cancelled';
export type TMissionActivity = 'active' | 'waiting' | 'dormant' | 'unknown';
export type TMissionItemState = 'candidate' | 'open' | 'answered' | 'resolved' | 'cancelled';
export type TMissionDeliveryState = 'queued' | 'dispatching' | 'submitted' | 'acknowledged' | 'held' | 'failed';
export type TMissionConfidence = 'confirmed' | 'provisional' | 'unknown';
export type TMissionCandidateReason = 'workspace-issue' | 'legacy-review' | 'historical-context';
export type TMissionHumanNeed = 'decision' | 'approval' | 'information' | 'external-action';
/** Producer-set attention class (ADR-0031); the server never guesses one. */
export type TAttentionClass = 'money' | 'irreversible' | 'scope' | 'bookkeeping';

export interface IMissionBinding {
  tabId: string;
  providerId: string;
  sessionId: string;
  generation: number;
  runtimeGeneration: string | null;
}

export interface IMissionEvidence {
  source: 'agent' | 'standup' | 'harness' | 'bootstrap';
  sourceId: string;
  observedAt: number;
  confidence: TMissionConfidence;
}

export interface IMissionEpic {
  id: string;
  title: string;
  url: string | null;
}

export interface IMissionRun {
  id: string;
  workspaceId: string;
  revision: number;
  objective: string;
  epic: IMissionEpic | null;
  phase: string | null;
  state: TMissionRunState;
  nextStep: string | null;
  binding: IMissionBinding | null;
  evidence: IMissionEvidence;
  closeoutPending: boolean;
  storyCounts: { total: number; done: number; blocked: number } | null;
  lastProgressAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** How the owner answers a format-2 question (ADR-0037 §1). A v1 item has none; see `effectiveAnswerType`. */
export type TMissionAnswerType = 'single' | 'multi' | 'confirm' | 'text' | 'action-done';

export interface IMissionOption {
  id: string;
  label: string;
  /** v1 only. */
  description?: string;
  /** v2: one line, what choosing this option does. */
  consequence?: string;
  /** v2: the asking agent's pick; at most one on `single` and `confirm`. */
  recommended?: boolean;
  /** v2: choosing this option requires text. */
  needsText?: boolean;
}

export interface IMissionEvidenceLink {
  label: string;
  url: string;
}

export interface IMissionQuestion {
  /** 2 for the ADR-0037 format; absent on a v1 question. */
  formatVersion?: 2;
  kind: 'question' | 'action';
  title: string;
  context: string;
  storyIds: string[];
  options: IMissionOption[];
  /** v1 free text; a v2 question stores null and states `recommendationWhy` instead. */
  recommendation: string | null;
  blockingScope: 'none' | 'story' | 'run';
  canContinue: boolean;
  decision?: string;
  whyNow?: string;
  answerType?: TMissionAnswerType;
  recommendationWhy?: string;
  evidence?: IMissionEvidenceLink[];
  /** The draft as the agent wrote it, kept when the curator reshaped it (ADR-0037 §3). */
  source?: Record<string, unknown>;
}

/** One rule a question breaks: the field, what was measured, and the limit (ADR-0037 §2). */
export interface IMissionQuestionDefect {
  field: string;
  measured: string;
  limit: string;
  message: string;
}

/**
 * What one `attention.updated` changed (ADR-0037 §4). `compatible` holds when the decision and the
 * answer type are unchanged and no option was removed; only then does an answer made on an older
 * revision still apply.
 */
export interface IMissionQuestionChanges {
  fromRevision: number;
  toRevision: number;
  compatible: boolean;
  decision: { from: string; to: string } | null;
  answerType: { from: TMissionAnswerType; to: TMissionAnswerType } | null;
  options: {
    added: string[];
    removed: string[];
    /** Wording changes of a kept option: its label or consequence, and `needsText` when that flipped. */
    relabelled: Array<{ id: string; from: string; to: string; needsText?: { from: boolean; to: boolean } }>;
  };
  /** The recommended option ids, when they moved. */
  recommended: { from: string[]; to: string[] } | null;
  /** `recommendationWhy` on v2, `recommendation` on v1. */
  recommendation: boolean;
  whyNow: boolean;
  /** The v2 title (on v1 the title is the decision). */
  title: boolean;
  context: boolean;
  evidence: boolean;
  /** Revisions in the range with no stored record (written before ADR-0037, or by the server); each counts as incompatible. */
  unrecorded: number[];
}

/** What waiting on this item costs, from the ledger (ADR-HFL-11 §1); absent until the ledger serves it, never 0. */
export interface IMissionBlockedCost {
  items: number;
  hours: number;
  critical: boolean;
}

/** Optional producer fields of `attention.opened` / `attention.updated` (ADR-0031); stored inside `question_json`. */
export interface IMissionAttentionClassInput {
  class?: TAttentionClass;
  /** One of `options[].id`; refused on an `action` item. */
  defaultOptionId?: string;
}

/** What the bookkeeping rule applied, under which rule version, and when (ADR-0031 §7). */
export interface IMissionAutoAnswer {
  rule: string;
  ruleVersion: number;
  appliedOptionId: string;
  at: number;
  note: string;
}

export type TMissionHumanReviewInput =
  | {
      humanNeed: 'none';
      handling: string;
      reviewerTabId: string;
    }
  | {
      humanNeed: TMissionHumanNeed;
      humanReason: string;
      handling: string;
      reviewerTabId: string;
    };

export type TMissionHumanReview = TMissionHumanReviewInput & {
  binding: IMissionBinding;
  eventId: string;
  reviewedAt: number;
};

export interface IMissionHumanInboxPolicy {
  version: 1;
  legacyReviewPending: number;
  guidance?: string;
}

/** A served item: the question with its evidence links as `evidenceLinks`, since `evidence` is the item's provenance. */
export interface IMissionAttentionItem extends Omit<IMissionQuestion, 'evidence'> {
  id: string;
  workspaceId: string;
  runId: string;
  revision: number;
  state: TMissionItemState;
  evidence: IMissionEvidence;
  answerId: string | null;
  resolution: string | null;
  humanReview: TMissionHumanReview | null;
  candidateReason: TMissionCandidateReason | null;
  class: TAttentionClass | null;
  defaultOptionId: string | null;
  /** The bookkeeping rule's record when the rule answered this item (ADR-0031 §7); null otherwise. */
  autoAnswer: IMissionAutoAnswer | null;
  /** The question's `evidence` links (ADR-0037 §1); empty on a v1 question. */
  evidenceLinks: IMissionEvidenceLink[];
  /** Format-2 findings on a v1 question (ADR-0037 §2); empty on a v2 question. */
  lint: IMissionQuestionDefect[];
  /** The latest `attention.updated` record (ADR-0037 §4); null when the item was never updated since ADR-0037. */
  changes: IMissionQuestionChanges | null;
  blocked?: IMissionBlockedCost;
  /** Owner messages the curator read as an answer to this item (story 23): links, never answers. Absent when none. */
  suggestedAnswers?: IMissionAnswerSuggestion[];
  createdAt: number;
  updatedAt: number;
}

export interface IMissionAnswerSuggestion {
  /** The message-history entry id of the owner's message. */
  entryId: string;
  /** The curator's quote from it; null when it gave none or it was withheld. */
  span: string | null;
  at: number;
}

/** Where an owner answer was made (story 33, the epic's Measure). */
export type TMissionAnswerSource = 'web' | 'phone' | 'notification';

export interface IMissionAnswerRequest {
  submissionId: string;
  expectedRevision: number;
  optionIds: string[];
  text: string;
  actionCompleted: boolean;
  /** Recorded in the stored request, outside its content hash; absent from an older client. */
  source?: TMissionAnswerSource;
}

export interface IMissionAnswer extends Omit<IMissionAnswerRequest, 'source'> {
  /** Null: not recorded (an older client, an auto-answer, or a row from before story 33). */
  source: TMissionAnswerSource | null;
  /** The item revision the answer applied to; above `expectedRevision` when compatible revisions came between (ADR-0037 §4). */
  appliedRevision: number;
  id: string;
  workspaceId: string;
  runId: string;
  itemId: string;
  actor: string;
  createdAt: number;
}

export interface IMissionDelivery {
  id: string;
  answerId: string;
  workspaceId: string;
  runId: string;
  binding: IMissionBinding | null;
  state: TMissionDeliveryState;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
  submittedAt: number | null;
  acknowledgedAt: number | null;
  updatedAt: number;
}

export interface IMissionAgentObservation {
  tabId: string;
  name: string;
  providerId: string;
  sessionId: string | null;
  cliState: TCliState | null;
  alive: boolean;
  lastActivityAt: number | null;
}

export interface IMissionWorkspaceView {
  workspaceId: string;
  name: string;
  orphaned: boolean;
  activity: TMissionActivity;
  agents: IMissionAgentObservation[];
  runIds: string[];
  openItems: number;
  awaitingAcknowledgement: number;
  lastActivityAt: number | null;
  lastProgressAt: number | null;
  stale: boolean;
  evidence: IMissionEvidence;
}

export interface IMissionEvent {
  seq: number;
  id: string;
  schemaVersion: 1;
  workspaceId: string;
  runId: string | null;
  entityId: string;
  revision: number;
  type: string;
  payload: Record<string, unknown>;
  producerAt: number;
  committedAt: number;
}

export type TMissionRebindCause = 'handoff' | 'recover' | 'replace' | 'heal';

/**
 * Payload of the server-authored `run.rebound` event: a change of the workspace orchestrator moved the
 * run binding. Producers cannot send this type.
 */
export interface IMissionRunReboundPayload {
  cause: TMissionRebindCause;
  previousBinding: IMissionBinding;
  binding: IMissionBinding;
  actor: 'system:orchestration';
}

export interface IMissionEventBase {
  eventId: string;
  schemaVersion: 1;
  workspaceId: string;
  runId: string;
  expectedRevision: number;
  producerAt: number;
  bindingGeneration: number;
}

export type TMissionProducerEvent = IMissionEventBase & (
  | { type: 'run.started'; payload: { objective: string; epic?: IMissionEpic | null; tabId: string } }
  | { type: 'run.resumed'; payload: { tabId: string; transferPendingAnswers: boolean } }
  | { type: 'progress.updated'; payload: { objective?: string; epic?: IMissionEpic | null; phase?: string | null; state?: 'running' | 'waiting'; nextStep?: string | null; storyCounts?: IMissionRun['storyCounts']; closeoutPending?: boolean } }
  | { type: 'run.finished'; payload: { state: 'completed' | 'cancelled'; summary: string; closeoutPending: boolean } }
  | { type: 'attention.opened'; payload: IMissionQuestion & IMissionAttentionClassInput & { itemId: string; humanReview?: TMissionHumanReviewInput } }
  | { type: 'attention.updated'; payload: IMissionQuestion & IMissionAttentionClassInput & { itemId: string; humanReview?: TMissionHumanReviewInput } }
  | { type: 'attention.resolved'; payload: { itemId: string; resolution: string } }
  | { type: 'attention.cancelled'; payload: { itemId: string; reason: string } }
  | { type: 'answer.acknowledged'; payload: { answerId: string } }
);

export interface IMissionBootstrapEntry {
  workspaceId: string;
  runId: string;
  binding: IMissionBinding | null;
  state: 'provisional' | 'queued' | 'dispatching' | 'submitted' | 'confirmed' | 'held';
  reason: string | null;
  updatedAt: number;
}

export interface IMissionBootstrap {
  id: string;
  boundarySeq: number;
  createdAt: number;
  entries: IMissionBootstrapEntry[];
}

/** One `answersByClass` row: answers recorded on one UTC day for one class, by a human or by a rule (ADR-0031 §3). */
export interface IMissionAnswerClassCount {
  day: string;
  class: TAttentionClass | 'unclassified';
  by: 'human' | 'rule';
  count: number;
}

/** The most `autoAnswered` rows a snapshot carries (ADR-0031 §7); a list this long may hold more. */
export const AUTO_ANSWERED_LIMIT = 100;

/** One `autoAnswered` row: an item the bookkeeping rule answered in the last 7 days (ADR-0031 §7). */
export interface IMissionAutoAnsweredItem {
  itemId: string;
  workspaceId: string;
  runId: string;
  title: string;
  class: TAttentionClass | null;
  appliedOptionId: string;
  appliedOptionLabel: string;
  at: number;
  note: string;
  itemState: TMissionItemState;
}

export interface IMissionSnapshot {
  schemaVersion: 1;
  cursor: number;
  generatedAt: number;
  workspaces: IMissionWorkspaceView[];
  runs: IMissionRun[];
  items: IMissionAttentionItem[];
  answers: IMissionAnswer[];
  deliveries: IMissionDelivery[];
  recentEvents: IMissionEvent[];
  bootstrap: IMissionBootstrap | null;
  /**
   * Story 12: every bootstrap entry still asking its orchestrator to reconcile (queued, dispatching or
   * submitted), from ANY bootstrap — a notice typed late belongs to its own bootstrap, not the latest.
   */
  pendingBootstrapEntries?: Array<{ bootstrapId: string; entry: IMissionBootstrapEntry }>;
  /** ADR-0031: answers per UTC day, class and actor kind over the last 7 days; absent from an older server. */
  answersByClass?: IMissionAnswerClassCount[];
  /** ADR-0031: the rule's answers of the last 7 days, newest first, at most 100; absent from an older server. */
  autoAnswered?: IMissionAutoAnsweredItem[];
}

export interface IMissionEventsResponse {
  schemaVersion: 1;
  events: IMissionEvent[];
  cursor: number;
  hasMore: boolean;
}

export interface IMissionAnswerResponse {
  answer: IMissionAnswer;
  item: IMissionAttentionItem;
  delivery: IMissionDelivery;
  cursor: number;
  replayed: boolean;
}

export interface IMissionError {
  error: string;
  code: 'invalid-request' | 'question-invalid' | 'unauthorized' | 'forbidden' | 'not-found' | 'conflict' | 'storage-unavailable';
  current?: IMissionAttentionItem | IMissionRun;
  /** On 400 question-invalid: every defect of every refused event. */
  defects?: IMissionEventDefect[];
  /** On a 409 answer conflict: what changed between the answered revision and the current one. */
  changes?: IMissionQuestionChanges;
}

export interface IMissionEventDefect extends IMissionQuestionDefect {
  eventId: string;
  itemId: string;
}

/** The format-2 findings of one accepted attention event (ADR-0037 §2). */
export interface IMissionEventLint {
  eventId: string;
  itemId: string;
  findings: IMissionQuestionDefect[];
}
