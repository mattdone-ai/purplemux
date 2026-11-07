import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type {
  IMissionAnswer,
  IMissionAnswerClassCount,
  IMissionAnswerRequest,
  IMissionAnswerResponse,
  IMissionAttentionClassInput,
  IMissionAnswerSuggestion,
  IMissionAttentionItem,
  IMissionAutoAnswer,
  IMissionAutoAnsweredItem,
  IMissionBinding,
  IMissionBootstrap,
  IMissionBootstrapEntry,
  IMissionDelivery,
  IMissionEvent,
  IMissionEventsResponse,
  IMissionEvidence,
  IMissionFollowedBy,
  IMissionFollowedUp,
  IMissionFollowsUp,
  IMissionFollowUpRefusal,
  IMissionHumanInboxPolicy,
  IMissionQuestion,
  IMissionQuestionChanges,
  IMissionRun,
  IMissionRunReboundPayload,
  IMissionSnapshot,
  IMissionSoProposalRecord,
  IMissionSoProposalView,
  IMissionWorkspaceView,
  TMissionProducerEvent,
  TMissionCandidateReason,
  TMissionHumanReview,
  TMissionHumanReviewInput,
  TMissionItemState,
  TMissionRebindCause,
  TSoProposalState,
} from '@/types/mission-control';
import { AUTO_ANSWERED_LIMIT } from '@/types/mission-control';
import {
  isMissionControlError,
  MissionControlError,
  invalidMissionRequest,
  missionConflict,
} from '@/lib/mission-control-errors';
import { ATTENTION_CLASS_KEYS, MISSION_AUTO_ANSWER_ACTOR, attentionClassKey } from '@/lib/attention-class';
import {
  answerRefusal,
  defect,
  diffMissionQuestions,
  mergeMissionChanges,
  questionLint,
  selectedOptionLabels,
  type TMissionStoredQuestion,
} from '@/lib/mission-question-format';
import {
  AUTO_ANSWER_KEY,
  autoAnswerNote,
  autoAnswerRefusal,
  autoAnswerSubmissionId,
  type IAutoAnswerRule,
} from '@/lib/mission-control-auto-answer';
import {
  FOLLOW_UP_EVENT_PREFIX, NEEDS_DECISION_EVENT_PREFIX, needsDecisionLinePrefix, SO_PROPOSAL_EVENT_PREFIX, SO_PROPOSAL_ITEM_PREFIX,
} from '@/lib/mission-control-validation';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.purplemux', 'mission-control.sqlite');
const SCHEMA_VERSION = 4;
const DAY_MS = 86_400_000;
const ANSWER_CLASS_WINDOW_DAYS = 7;
const AUTO_ANSWERED_WINDOW_MS = 7 * DAY_MS;
const HUMAN_INBOX_POLICY_GUIDANCE = 'On your next ordinary turn, the configured orchestrator should review legacy candidates: record workspace handling or explicitly identify the human-exclusive need. Reuse item IDs. Do not rerun bootstrap.';

type TMissionIdentity = Omit<IMissionBinding, 'generation'>;
export type TMissionDiscoveryIdentity = TMissionIdentity;

export interface IMissionDiscoveryCandidate {
  sourceKey: string;
  question: IMissionQuestion;
  evidence: IMissionEvidence;
}

export interface IMissionDiscoveryRun {
  sourceKey: string;
  objective: string;
  phase: string | null;
  nextStep: string | null;
  state: 'running' | 'waiting';
  evidence: IMissionEvidence;
  lastProgressAt: number | null;
}

export interface IMissionDiscoveryWorkspace {
  workspaceId: string;
  name: string;
  activity: IMissionWorkspaceView['activity'];
  evidence: IMissionEvidence;
  agents: IMissionWorkspaceView['agents'];
  lastActivityAt: number | null;
  lastProgressAt: number | null;
  stale: boolean;
  identities: TMissionDiscoveryIdentity[];
  run: IMissionDiscoveryRun | null;
  candidates: IMissionDiscoveryCandidate[];
  reconciliation: { sourceKey: string; binding: IMissionBinding } | null;
}

export interface IMissionDiscoveryInput {
  bootstrapId: string;
  reconcile: boolean;
  boundarySeq: number;
  observedAt: number;
  workspaces: IMissionDiscoveryWorkspace[];
}

export interface IMissionApplyEventsResult {
  events: IMissionEvent[];
  cursor: number;
  replayed: boolean;
  /** The answer that the batch's one follow-up acknowledged (ADR-0037 amendment D2, rule 4); absent when none. */
  followedUp?: IMissionFollowedUp;
  /** A batch with two or more follow-ups carries them here instead of `followedUp` (consult ruling, story hfl2-01). */
  followedUps?: IMissionFollowedUp[];
}

/** What a follow-up names and carries, for the store's check (ADR-0037 amendment D2, edge cases). */
export interface IMissionFollowUpInput {
  workspaceId: string;
  runId: string;
  /** The new item's id. */
  itemId: string;
  /** The earlier item's id: the target. */
  followsUp: string;
  humanReview: Pick<TMissionHumanReviewInput, 'humanNeed'> | null | undefined;
}

interface ILinkRow {
  item_id: string;
  follows_up_item_id: string;
  workspace_id: string;
  at: number;
}

export interface IMissionEventAuthority {
  resolvedIdentity: TMissionIdentity | null;
  configuredOrchestratorTabId: string | null;
  /** The server-resolved caller tab of an `attention.opened` (ADR-0023); advisory, never authorization. */
  opener?: IMissionItemOpener | null;
}

export type TMissionOpenerIdentity = 'launch' | 'hook' | 'session';

export interface IMissionItemOpener {
  tabId: string;
  identity: TMissionOpenerIdentity;
}

/** An open workspace item with the tab that opened it, when one is recorded (ADR-0023). */
export interface IMissionOpenItemOpener {
  workspaceId: string;
  itemId: string;
  createdAt: number;
  reviewed: boolean;
  opener: IMissionItemOpener | null;
}

export interface IMissionRebindInput {
  workspaceId: string;
  identity: TMissionIdentity;
  cause: TMissionRebindCause;
  /** Narrows the rebind to the runs whose current binding passes; every open bound run when omitted. */
  eligible?: (binding: IMissionBinding) => boolean;
}

export interface IMissionOpenRunBinding {
  runId: string;
  workspaceId: string;
  binding: IMissionBinding;
}

export interface IMissionDeliveryOutcome {
  state: 'queued' | 'submitted' | 'held' | 'failed';
  nextAttemptAt: number | null;
  lastError: string | null;
  submittedAt?: number | null;
}

export type TMissionDeliveryValidation =
  | { ok: true }
  | { ok: false; reason: string };

export interface IMissionBootstrapQueueEntry {
  bootstrapId: string;
  entry: IMissionBootstrapEntry;
  attempts: number;
  nextAttemptAt: number | null;
}

interface IRunRow {
  id: string;
  workspace_id: string;
  revision: number;
  objective: string;
  epic_json: string | null;
  phase: string | null;
  state: IMissionRun['state'];
  next_step: string | null;
  binding_json: string | null;
  evidence_json: string;
  closeout_pending: number;
  story_counts_json: string | null;
  last_progress_at: number | null;
  created_at: number;
  updated_at: number;
  source_key: string | null;
  observed_identities_json: string;
}

interface IItemRow {
  id: string;
  workspace_id: string;
  run_id: string;
  revision: number;
  state: IMissionAttentionItem['state'];
  question_json: string;
  evidence_json: string;
  answer_id: string | null;
  resolution: string | null;
  created_at: number;
  updated_at: number;
  source_key: string | null;
  human_review_json: string | null;
  candidate_reason: TMissionCandidateReason | null;
}

interface IAnswerRow {
  id: string;
  submission_id: string;
  request_hash: string;
  workspace_id: string;
  run_id: string;
  item_id: string;
  actor: string;
  request_json: string;
  created_at: number;
}

interface IAutoAnswerRow {
  answer_id: string;
  item_id: string;
  workspace_id: string;
  rule: string;
  rule_version: number;
  applied_option_id: string;
  at: number;
  note: string;
}

interface IDeliveryRow {
  id: string;
  answer_id: string;
  workspace_id: string;
  run_id: string;
  binding_json: string | null;
  state: IMissionDelivery['state'];
  attempts: number;
  next_attempt_at: number | null;
  last_error: string | null;
  submitted_at: number | null;
  acknowledged_at: number | null;
  updated_at: number;
}

interface IEventRow {
  seq: number;
  id: string;
  request_hash: string;
  schema_version: 1;
  workspace_id: string;
  run_id: string | null;
  entity_id: string;
  revision: number;
  type: string;
  payload_json: string;
  producer_at: number;
  committed_at: number;
}

interface IBootstrapRow {
  id: string;
  input_hash: string;
  boundary_seq: number;
  created_at: number;
  workspace_views_json: string;
}

interface IBootstrapEntryRow {
  bootstrap_id: string;
  workspace_id: string;
  run_id: string;
  binding_json: string | null;
  state: IMissionBootstrapEntry['state'];
  reason: string | null;
  source_key: string | null;
  attempts: number;
  next_attempt_at: number | null;
  updated_at: number;
}

const parseJson = <T>(value: string | null): T | null => value === null ? null : JSON.parse(value) as T;
const toJson = (value: unknown): string => JSON.stringify(value);

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
};

const contentHash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');

const deterministicId = (prefix: string, sourceKey: string): string =>
  `${prefix}-${createHash('sha256').update(sourceKey).digest('hex').slice(0, 32)}`;

const identityKey = (identity: TMissionDiscoveryIdentity): string => toJson(canonicalize(identity));
const normalizeIdentities = (identities: TMissionDiscoveryIdentity[]): TMissionDiscoveryIdentity[] =>
  [...new Map(identities.map((identity) => [identityKey(identity), identity])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
const unionIdentities = (
  ...sets: TMissionDiscoveryIdentity[][]
): TMissionDiscoveryIdentity[] => normalizeIdentities(sets.flat());

const runFromRow = (row: IRunRow): IMissionRun => ({
  id: row.id,
  workspaceId: row.workspace_id,
  revision: row.revision,
  objective: row.objective,
  epic: parseJson(row.epic_json),
  phase: row.phase,
  state: row.state,
  nextStep: row.next_step,
  binding: parseJson(row.binding_json),
  evidence: JSON.parse(row.evidence_json) as IMissionEvidence,
  closeoutPending: row.closeout_pending === 1,
  storyCounts: parseJson(row.story_counts_json),
  lastProgressAt: row.last_progress_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const autoAnswerFromRow = (row: IAutoAnswerRow): IMissionAutoAnswer => ({
  rule: row.rule,
  ruleVersion: row.rule_version,
  appliedOptionId: row.applied_option_id,
  at: row.at,
  note: row.note,
});

interface IChangesRow {
  item_id: string;
  workspace_id: string;
  revision: number;
  changes_json: string;
  at: number;
}

interface ISuggestionRow {
  item_id: string;
  entry_id: string;
  span: string | null;
  at: number;
}

const suggestionFromRow = (row: ISuggestionRow): IMissionAnswerSuggestion => ({ entryId: row.entry_id, span: row.span, at: row.at });

interface ISoProposalRow {
  item_id: string;
  workspace_id: string;
  proposer_tab_id: string;
  text: string;
  scope: string;
  check_name: string;
  cites: string | null;
  state: TSoProposalState;
  answer_id: string | null;
  order_id: string | null;
  reason: string | null;
  reason_code: string | null;
  created_at: number;
  decided_at: number | null;
}

const soProposalFromRow = (row: ISoProposalRow): IMissionSoProposalRecord => ({
  itemId: row.item_id,
  workspaceId: row.workspace_id,
  proposerTabId: row.proposer_tab_id,
  text: row.text,
  scope: row.scope,
  checkName: row.check_name,
  cites: row.cites,
  state: row.state,
  answerId: row.answer_id,
  orderId: row.order_id,
  reason: row.reason,
  reasonCode: row.reason_code,
  createdAt: row.created_at,
  decidedAt: row.decided_at,
});

const soProposalView = (row: ISoProposalRow | undefined): IMissionSoProposalView | null =>
  (row ? { state: row.state, orderId: row.order_id, reason: row.reason } : null);

/** The record a server proposal item opens with (ADR-0041 §1 amendment D7): written in the item's transaction. */
export type TMissionSoProposalInput = Pick<IMissionSoProposalRecord, 'proposerTabId' | 'text' | 'scope' | 'checkName' | 'cites'>;

/**
 * The line key a server NEEDS-DECISION event gives its item (story PM-2): written in the event's own transaction, so an
 * item never holds a revision without the line that made it. `markedNew`: the line carried `[new]`.
 */
export interface IMissionNeedsDecisionLineInput {
  tabId: string;
  lineKey: string;
  /** The question text's key: no marker, `[new]` or class tag, letter case folded (review r1 finding 2). */
  textKey: string;
  markedNew: boolean;
}

/** One `nd-` item of a tab as the NEEDS-DECISION opener reads it (story PM-2): its state, keys, answer and delivery. */
export interface IMissionNeedsDecisionTabItem {
  id: string;
  state: TMissionItemState;
  revision: number;
  runId: string;
  createdAt: number;
  /** The question's current `decision`, for a notice that quotes what a revision replaced. */
  decision: string;
  /** Every line key the item took: its id's, each revision's, and any reservation or race record. */
  keys: string[];
  /** Every text key the item took (rows written before the column have none). */
  textKeys: string[];
  /** The opening line carried `[new]`: the revision-1 row, else a revision-0 reservation row (consult r2, r3). */
  markedNew: boolean;
  /** The server's NEEDS-DECISION opener opened it for this tab (opener row with a `system:needs-decision:` event). */
  serverOpened: boolean;
  /** The latest answer, or null. */
  answer: {
    id: string;
    createdAt: number;
    optionIds: string[];
    optionLabels: string[];
    text: string;
    delivery: { state: string; reason: string | null; tabId: string | null } | null;
  } | null;
}

/** A closed proposal's outcome: the step that decided it, with the answer and the order it names. */
export interface IMissionSoProposalOutcome {
  state: Exclude<TSoProposalState, 'open'>;
  answerId?: string | null;
  orderId?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  decidedAt: number;
}

interface IMissionItemLinks {
  followsUp: IMissionFollowsUp | null;
  followedBy: IMissionFollowedBy | null;
}

const NO_LINKS: IMissionItemLinks = { followsUp: null, followedBy: null };

const questionTitle = (questionJson: string): string =>
  String((JSON.parse(questionJson) as { title?: unknown }).title ?? '');

/** The labels of the selected options, read from the answered (frozen) question; an id it lacks never reaches a face. */
const optionLabelsOf = (questionJson: string, optionIds: readonly string[]): string[] =>
  selectedOptionLabels((JSON.parse(questionJson) as { options?: Array<{ id: string; label: string }> }).options ?? [], optionIds);

const followsUpView = (target: IItemRow, answer: IAnswerRow | undefined): IMissionFollowsUp => {
  const request = answer ? JSON.parse(answer.request_json) as IMissionAnswerRequest : null;
  return {
    itemId: target.id,
    title: questionTitle(target.question_json),
    answer: answer && request
      ? { optionIds: request.optionIds, optionLabels: optionLabelsOf(target.question_json, request.optionIds), text: request.text, at: answer.created_at }
      : null,
  };
};

const followedByView = (follower: IItemRow): IMissionFollowedBy => ({
  itemId: follower.id,
  title: questionTitle(follower.question_json),
  state: follower.state,
});

const itemFromRow = (
  row: IItemRow,
  autoAnswer: IMissionAutoAnswer | null = null,
  changes: IMissionQuestionChanges | null = null,
  suggestions: IMissionAnswerSuggestion[] = [],
  proposal: IMissionSoProposalView | null = null,
  links: IMissionItemLinks = NO_LINKS,
): IMissionAttentionItem => {
  const { evidence: evidenceLinks, ...question } = JSON.parse(row.question_json) as TMissionStoredQuestion;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    revision: row.revision,
    state: row.state,
    ...question,
    evidenceLinks: evidenceLinks ?? [],
    lint: questionLint(question),
    changes,
    evidence: JSON.parse(row.evidence_json) as IMissionEvidence,
    answerId: row.answer_id,
    resolution: row.resolution,
    humanReview: parseJson<TMissionHumanReview>(row.human_review_json),
    candidateReason: row.candidate_reason,
    ...(suggestions.length ? { suggestedAnswers: suggestions } : {}),
    class: question.class ?? null,
    defaultOptionId: question.defaultOptionId ?? null,
    autoAnswer,
    proposal,
    followsUp: links.followsUp,
    followedBy: links.followedBy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/**
 * An answer's content hash. `source` is metadata (story 33): left out, so every stored hash stays
 * byte-identical and a resend that differs only in source is a replay, not a conflict.
 */
const answerHash = (itemId: string, request: IMissionAnswerRequest): string => {
  const { source: ignored, ...content } = request;
  void ignored;
  return contentHash({ itemId, request: content });
};

const answerFromRow = (row: IAnswerRow): IMissionAnswer => {
  const request = JSON.parse(row.request_json) as IMissionAnswerRequest & { appliedRevision?: number };
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    itemId: row.item_id,
    actor: row.actor,
    ...request,
    source: request.source ?? null,
    // An answer stored before ADR-0037 applied only to the revision it named.
    appliedRevision: request.appliedRevision ?? request.expectedRevision,
    createdAt: row.created_at,
  };
};

const deliveryFromRow = (row: IDeliveryRow): IMissionDelivery => ({
  id: row.id,
  answerId: row.answer_id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  binding: parseJson(row.binding_json),
  state: row.state,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  lastError: row.last_error,
  submittedAt: row.submitted_at,
  acknowledgedAt: row.acknowledged_at,
  updatedAt: row.updated_at,
});

const eventFromRow = (row: IEventRow): IMissionEvent => ({
  seq: row.seq,
  id: row.id,
  schemaVersion: 1,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  entityId: row.entity_id,
  revision: row.revision,
  type: row.type,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  producerAt: row.producer_at,
  committedAt: row.committed_at,
});

const bootstrapEntryFromRow = (row: IBootstrapEntryRow): IMissionBootstrapEntry => ({
  workspaceId: row.workspace_id,
  runId: row.run_id,
  binding: parseJson(row.binding_json),
  state: row.state,
  reason: row.reason,
  updatedAt: row.updated_at,
});

const isSqliteFailure = (error: unknown): boolean =>
  error instanceof Error && (error.name.startsWith('Sqlite') || error.message.startsWith('database'));

export class MissionControlStore {
  private readonly database: Database.Database;

  constructor(databasePath = DEFAULT_DB_PATH) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    if (databasePath !== ':memory:') fs.chmodSync(databasePath, 0o600);
    this.database.pragma('journal_mode = WAL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    this.database.pragma('synchronous = FULL');
    this.migrate();
    this.ensureOpenerTable();
    this.ensureAutoAnswerTable();
    this.ensureChangesTable();
    this.ensureSuggestionTable();
    this.ensureSoProposalTable();
    this.ensureLinkTable();
    this.ensureNeedsDecisionLineTable();
  }

  /**
   * The line keys of NEEDS-DECISION items (story PM-2): an unversioned side table like the openers, so a release from
   * before it still opens the file. One row per item and line key: the opening line (revision 1), each revision's line,
   * and revision 0 for a key the opener recorded outside an event (a reservation for an id it handed the orchestrator,
   * or a line that met the item in a race). `text_key`: the question text's key, which an answered item matches too
   * (PM-2 round 2). No foreign key, as for the openers.
   */
  private ensureNeedsDecisionLineTable = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mission_nd_lines (
        item_id TEXT NOT NULL, line_key TEXT NOT NULL, text_key TEXT, workspace_id TEXT NOT NULL, tab_id TEXT NOT NULL,
        revision INTEGER NOT NULL, marked_new INTEGER NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (item_id, line_key)
      );
      CREATE INDEX IF NOT EXISTS mission_nd_lines_tab_idx ON mission_nd_lines(workspace_id, tab_id, line_key);
    `);
    // A table made before `text_key` (PM-2 round 2) gains it; its old rows keep a null text key and match exactly only.
    const columns = (this.database.prepare('PRAGMA table_info(mission_nd_lines)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes('text_key')) this.database.exec('ALTER TABLE mission_nd_lines ADD COLUMN text_key TEXT');
  };

  /** Record a line key for an item outside an event (revision 0): a reservation, or a race record (story PM-2). */
  recordNeedsDecisionLine = (
    workspaceId: string, tabId: string, lineKey: string, textKey: string, itemId: string, markedNew: boolean, at: number,
  ): void => {
    this.database.prepare(`INSERT OR IGNORE INTO mission_nd_lines (item_id,line_key,text_key,workspace_id,tab_id,revision,marked_new,at)
      VALUES (?,?,?,?,?,0,?,?)`).run(itemId, lineKey, textKey, workspaceId, tabId, Number(markedNew), at);
  };

  /**
   * The tab's `nd-` items for the NEEDS-DECISION opener (story PM-2), oldest first: items with a line row of the tab
   * (an existing item only: a reservation counts once its item exists), items the tab opened with an `nd-` id, and
   * items of any opener whose id has the prefix `nd-<lineKey>`. Only items still candidate or open, or changed at or
   * after `since` (an answer inside the window moves `updated_at` to at least the answer's time).
   */
  needsDecisionItemsOfTab = (workspaceId: string, tabId: string, lineKey: string, since: number): IMissionNeedsDecisionTabItem[] => {
    const prefix = `nd-${lineKey}`;
    const rows = this.database.prepare(`SELECT a.id, a.state, a.revision, a.run_id, a.created_at, a.question_json, a.answer_id
      FROM attention_items a WHERE a.workspace_id = ? AND a.id IN (
        SELECT item_id FROM mission_nd_lines WHERE workspace_id = ? AND tab_id = ?
        UNION SELECT item_id FROM mission_item_openers INDEXED BY mission_item_openers_tab_idx
          WHERE workspace_id = ? AND tab_id = ? AND substr(item_id, 1, 3) = 'nd-'
        UNION SELECT id FROM attention_items WHERE workspace_id = ? AND substr(id, 1, length(?)) = ?)
      AND (a.state IN ('candidate','open') OR a.updated_at >= ?)
      ORDER BY a.created_at, a.id`).all(workspaceId, workspaceId, tabId, workspaceId, tabId, workspaceId, prefix, prefix, since) as Array<{
        id: string; state: TMissionItemState; revision: number; run_id: string; created_at: number; question_json: string; answer_id: string | null;
      }>;
    const lineRows = this.database.prepare('SELECT line_key, text_key, revision, marked_new FROM mission_nd_lines WHERE item_id = ?');
    const opener = this.database.prepare('SELECT tab_id, event_id FROM mission_item_openers WHERE item_id = ?');
    const answerRow = this.database.prepare('SELECT * FROM answers WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    const deliveryRow = this.database.prepare('SELECT * FROM deliveries WHERE answer_id = ?');
    return rows.map((row) => {
      const lines = lineRows.all(row.id) as Array<{ line_key: string; text_key: string | null; revision: number; marked_new: number }>;
      const opening = lines.filter((line) => line.revision === 1);
      const own = needsDecisionLinePrefix(row.id);
      const keys = [...new Set([...(own ? [own.slice(3)] : []), ...lines.map((line) => line.line_key)])];
      const openedBy = opener.get(row.id) as { tab_id: string; event_id: string } | undefined;
      const question = parseJson<{ decision?: unknown; options?: Array<{ id?: unknown; label?: unknown }> }>(row.question_json) ?? {};
      const answer = answerRow.get(row.id) as IAnswerRow | undefined;
      const delivery = answer ? deliveryRow.get(answer.id) as IDeliveryRow | undefined : undefined;
      const parsed = answer ? answerFromRow(answer) : null;
      const labels = new Map((question.options ?? []).map((option) => [String(option.id ?? ''), String(option.label ?? '')]));
      return {
        id: row.id,
        state: row.state,
        revision: row.revision,
        runId: row.run_id,
        createdAt: row.created_at,
        decision: String(question.decision ?? ''),
        keys,
        textKeys: [...new Set(lines.flatMap((line) => (line.text_key ? [line.text_key] : [])))],
        // The opening row says: the revision-1 row, else the revision-0 rows, for an item the orchestrator opened from a
        // handed id (consult r2). A revise row never counts: a `[new]` line never revises (consult r3). The revision-1 row
        // replaces a revision-0 row of its key (writeNeedsDecisionLine), so a stale reservation never speaks for it.
        markedNew: (opening.length ? opening : lines.filter((line) => line.revision === 0)).some((line) => line.marked_new === 1),
        serverOpened: openedBy?.tab_id === tabId && openedBy.event_id.startsWith(NEEDS_DECISION_EVENT_PREFIX),
        answer: parsed ? {
          id: parsed.id,
          createdAt: parsed.createdAt,
          optionIds: parsed.optionIds,
          optionLabels: parsed.optionIds.map((optionId) => labels.get(optionId) ?? optionId),
          text: parsed.text,
          delivery: delivery ? {
            state: delivery.state,
            reason: delivery.last_error,
            tabId: parseJson<IMissionBinding>(delivery.binding_json)?.tabId ?? null,
          } : null,
        } : null,
      };
    });
  };

  /**
   * A fleet standing-order proposal (ADR-0041 §1 amendment D7): an unversioned side table like the openers, written in
   * the item's transaction, so a release from before it still opens the file and ignores the table.
   */
  private ensureSoProposalTable = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mission_so_proposals (
        item_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, proposer_tab_id TEXT NOT NULL, text TEXT NOT NULL,
        scope TEXT NOT NULL, check_name TEXT NOT NULL, cites TEXT, state TEXT NOT NULL, answer_id TEXT, order_id TEXT,
        reason TEXT, reason_code TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS mission_so_proposals_state_idx ON mission_so_proposals(state);
    `);
    // A table made before `reason_code` (story 02 r1) gains it; a column add is all a side table ever needs.
    const columns = (this.database.prepare('PRAGMA table_info(mission_so_proposals)').all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes('reason_code')) this.database.exec('ALTER TABLE mission_so_proposals ADD COLUMN reason_code TEXT');
  };

  /**
   * Follow-up links (ADR-0037 amendment D2): an unversioned side table like the openers, so a release that ignores it
   * still opens the file. The primary key gives an item at most one predecessor; the unique column, at most one follower.
   */
  private ensureLinkTable = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mission_item_links (
        item_id TEXT PRIMARY KEY, follows_up_item_id TEXT UNIQUE NOT NULL, workspace_id TEXT NOT NULL, at INTEGER NOT NULL
      );
    `);
  };

  /**
   * One `changes` record per `attention.updated` revision (ADR-0037 §4): an unversioned side table
   * like the openers, so a release that ignores it still opens the file.
   */
  private ensureChangesTable = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mission_item_changes (
        item_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL,
        changes_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (item_id, revision)
      );
    `);
  };

  /**
   * Opener attribution (ADR-0023) lives in an unversioned side table, so a
   * schema-4 binary rolled back onto this file still opens it. No foreign key:
   * an older writer never trips over a constraint it does not know.
   */
  private ensureOpenerTable = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mission_item_openers (
        item_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, tab_id TEXT NOT NULL,
        identity TEXT NOT NULL, event_id TEXT NOT NULL, opened_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mission_item_openers_tab_idx ON mission_item_openers(workspace_id, tab_id);
    `);
  };

  /**
   * The bookkeeping rule's record (ADR-0031 §7): an unversioned side table like the
   * openers, so the schema-4 release that ignores it still opens the file.
   */
  private ensureAutoAnswerTable = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mission_auto_answers (
        answer_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, workspace_id TEXT NOT NULL, rule TEXT NOT NULL,
        rule_version INTEGER NOT NULL, applied_option_id TEXT NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mission_auto_answers_at_idx ON mission_auto_answers(at DESC);
      CREATE INDEX IF NOT EXISTS mission_auto_answers_item_idx ON mission_auto_answers(item_id);
    `);
  };

  /**
   * An owner message the curator read as an answer (story 23 AC 2): a suggested link on the item it may answer, never
   * an answer. An unversioned side table like the others; the item's revision does not move.
   */
  private ensureSuggestionTable = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS mission_answer_suggestions (
        item_id TEXT NOT NULL, workspace_id TEXT NOT NULL, entry_id TEXT NOT NULL, span TEXT, at INTEGER NOT NULL,
        PRIMARY KEY (item_id, entry_id)
      );
    `);
  };

  close = (): void => {
    this.database.close();
  };

  private migrate = (): void => {
    const current = this.database.pragma('user_version', { simple: true }) as number;
    if (current > SCHEMA_VERSION) throw new Error(`unsupported Mission Control schema ${current}`);
    if (current === 0) {
      this.database.transaction(() => this.database.exec(`
        CREATE TABLE runs (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL,
          objective TEXT NOT NULL, epic_json TEXT, phase TEXT, state TEXT NOT NULL,
          next_step TEXT, binding_json TEXT, evidence_json TEXT NOT NULL,
          closeout_pending INTEGER NOT NULL, story_counts_json TEXT, last_progress_at INTEGER,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source_key TEXT UNIQUE,
          observed_identities_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX runs_workspace_idx ON runs(workspace_id, updated_at DESC);
        CREATE TABLE attention_items (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
          revision INTEGER NOT NULL, state TEXT NOT NULL, question_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL, answer_id TEXT, resolution TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, source_key TEXT UNIQUE,
          human_review_json TEXT, candidate_reason TEXT
        );
        CREATE INDEX attention_workspace_idx ON attention_items(workspace_id, updated_at DESC);
        CREATE TABLE answers (
          id TEXT PRIMARY KEY, submission_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
          workspace_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id),
          item_id TEXT NOT NULL REFERENCES attention_items(id), actor TEXT NOT NULL,
          request_json TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY, answer_id TEXT NOT NULL UNIQUE REFERENCES answers(id),
          workspace_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES runs(id), binding_json TEXT,
          state TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at INTEGER,
          last_error TEXT, submitted_at INTEGER, acknowledged_at INTEGER, updated_at INTEGER NOT NULL
        );
        CREATE INDEX deliveries_due_idx ON deliveries(state, next_attempt_at, updated_at);
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
          schema_version INTEGER NOT NULL, workspace_id TEXT NOT NULL, run_id TEXT,
          entity_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL,
          payload_json TEXT NOT NULL, producer_at INTEGER NOT NULL, committed_at INTEGER NOT NULL
        );
        CREATE INDEX events_workspace_seq_idx ON events(workspace_id, seq);
        CREATE TABLE bootstrap (
          id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, boundary_seq INTEGER NOT NULL,
          created_at INTEGER NOT NULL, workspace_views_json TEXT NOT NULL
        );
        CREATE TABLE bootstrap_entries (
          bootstrap_id TEXT NOT NULL REFERENCES bootstrap(id), workspace_id TEXT NOT NULL,
          run_id TEXT NOT NULL REFERENCES runs(id), binding_json TEXT, state TEXT NOT NULL,
          reason TEXT, source_key TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (bootstrap_id, workspace_id, run_id)
        );
        CREATE INDEX bootstrap_entries_state_idx ON bootstrap_entries(state, updated_at);
        PRAGMA user_version = 4;
      `))();
    }
    if (current === 1) {
      this.database.transaction(() => {
        this.database.exec('ALTER TABLE bootstrap_entries ADD COLUMN source_key TEXT');
        this.database.exec("ALTER TABLE runs ADD COLUMN observed_identities_json TEXT NOT NULL DEFAULT '[]'");
        this.database.pragma('user_version = 3');
      })();
    }
    if (current === 2) {
      this.database.transaction(() => {
        this.database.exec("ALTER TABLE runs ADD COLUMN observed_identities_json TEXT NOT NULL DEFAULT '[]'");
        this.database.pragma('user_version = 3');
      })();
    }
    if (current >= 1 && current <= 3) {
      this.database.transaction(() => {
        this.database.exec('ALTER TABLE attention_items ADD COLUMN human_review_json TEXT');
        this.database.exec('ALTER TABLE attention_items ADD COLUMN candidate_reason TEXT');
        const anomalous = this.database.prepare(`SELECT item.id FROM attention_items item
          WHERE item.state='open' AND (item.answer_id IS NOT NULL OR EXISTS (
            SELECT 1 FROM answers answer WHERE answer.item_id=item.id
          )) LIMIT 1`).get() as { id: string } | undefined;
        if (anomalous) throw new Error(`open Mission Control item ${anomalous.id} already has an answer`);

        const legacyOpen = this.database.prepare(`SELECT * FROM attention_items item
          WHERE item.state='open' AND item.answer_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM answers answer WHERE answer.item_id=item.id
          ) ORDER BY item.id`).all() as IItemRow[];
        const migratedAt = Date.now();
        for (const item of legacyOpen) {
          const revision = item.revision + 1;
          const itemMigratedAt = Math.max(migratedAt, item.updated_at + 1);
          const payload = {
            itemId: item.id,
            fromState: 'open',
            toState: 'candidate',
            previousRevision: item.revision,
            reason: 'legacy-human-review-required',
            policyVersion: 1,
            actor: 'system:migration',
          };
          const eventId = `system:migration:v4:${createHash('sha256').update(item.id).digest('hex')}`;
          this.database.prepare(`UPDATE attention_items SET state='candidate', revision=?,
            candidate_reason='legacy-review', updated_at=? WHERE id=?`)
            .run(revision, itemMigratedAt, item.id);
          this.database.prepare(`INSERT INTO events
            (id,request_hash,schema_version,workspace_id,run_id,entity_id,revision,type,payload_json,producer_at,committed_at)
            VALUES (?,?,1,?,?,?,?,?,?,?,?)`)
            .run(eventId, contentHash(payload), item.workspace_id, item.run_id, item.id, revision,
              'attention.reclassified', toJson(payload), itemMigratedAt, itemMigratedAt);
        }
        this.database.pragma('user_version = 4');
      })();
    }
  };

  private runRow = (runId: string): IRunRow | undefined =>
    this.database.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as IRunRow | undefined;

  private itemRow = (itemId: string): IItemRow | undefined =>
    this.database.prepare('SELECT * FROM attention_items WHERE id = ?').get(itemId) as IItemRow | undefined;

  private autoAnswerOf = (itemId: string): IMissionAutoAnswer | null => {
    const row = this.database.prepare('SELECT * FROM mission_auto_answers WHERE item_id = ? ORDER BY at DESC, answer_id LIMIT 1')
      .get(itemId) as IAutoAnswerRow | undefined;
    return row ? autoAnswerFromRow(row) : null;
  };

  private changesOf = (itemId: string): IMissionQuestionChanges | null => {
    const row = this.database.prepare('SELECT * FROM mission_item_changes WHERE item_id = ? ORDER BY revision DESC LIMIT 1')
      .get(itemId) as IChangesRow | undefined;
    return row ? JSON.parse(row.changes_json) as IMissionQuestionChanges : null;
  };

  private suggestionsOf = (itemId: string): IMissionAnswerSuggestion[] =>
    (this.database.prepare('SELECT * FROM mission_answer_suggestions WHERE item_id = ? ORDER BY at, entry_id').all(itemId) as ISuggestionRow[])
      .map(suggestionFromRow);

  private proposalRow = (itemId: string): ISoProposalRow | undefined =>
    this.database.prepare('SELECT * FROM mission_so_proposals WHERE item_id = ?').get(itemId) as ISoProposalRow | undefined;

  private answerRow = (answerId: string | null): IAnswerRow | undefined =>
    answerId === null ? undefined : this.database.prepare('SELECT * FROM answers WHERE id = ?').get(answerId) as IAnswerRow | undefined;

  /** One step back and one step forward along the item's follow-up chain (ADR-0037 amendment D2, rule 5). */
  private linksOf = (itemId: string): IMissionItemLinks => {
    const back = this.database.prepare('SELECT * FROM mission_item_links WHERE item_id = ?').get(itemId) as ILinkRow | undefined;
    const forward = this.database.prepare('SELECT * FROM mission_item_links WHERE follows_up_item_id = ?').get(itemId) as ILinkRow | undefined;
    const target = back ? this.itemRow(back.follows_up_item_id) : undefined;
    const follower = forward ? this.itemRow(forward.item_id) : undefined;
    return {
      followsUp: target ? followsUpView(target, this.answerRow(target.answer_id)) : null,
      followedBy: follower ? followedByView(follower) : null,
    };
  };

  private item = (row: IItemRow): IMissionAttentionItem =>
    itemFromRow(row, this.autoAnswerOf(row.id), this.changesOf(row.id), this.suggestionsOf(row.id), soProposalView(this.proposalRow(row.id)),
      this.linksOf(row.id));

  private insertEvent = (
    event: TMissionProducerEvent,
    entityId: string,
    revision: number,
    committedAt: number,
    requestHash: string,
    payload: unknown = event.payload,
  ): IMissionEvent => {
    this.database.prepare(`INSERT INTO events
      (id, request_hash, schema_version, workspace_id, run_id, entity_id, revision, type, payload_json, producer_at, committed_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, requestHash, event.workspaceId, event.runId, entityId, revision,
        event.type, toJson(payload), event.producerAt, committedAt);
    return eventFromRow(this.database.prepare('SELECT * FROM events WHERE id = ?').get(event.eventId) as IEventRow);
  };

  private insertServerEvent = (
    event: { id: string; workspaceId: string; runId: string; entityId: string; revision: number; type: string; payload: object },
    committedAt: number,
  ): IMissionEvent => {
    this.database.prepare(`INSERT INTO events
      (id, request_hash, schema_version, workspace_id, run_id, entity_id, revision, type, payload_json, producer_at, committed_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.id, contentHash(event.payload), event.workspaceId, event.runId, event.entityId, event.revision,
        event.type, toJson(event.payload), committedAt, committedAt);
    return eventFromRow(this.database.prepare('SELECT * FROM events WHERE id = ?').get(event.id) as IEventRow);
  };

  snapshot = (workspaces: IMissionWorkspaceView[] = [], workspaceId?: string): IMissionSnapshot => {
    const read = this.database.transaction((): IMissionSnapshot => {
      const where = workspaceId ? ' WHERE workspace_id = ?' : '';
      const args = workspaceId ? [workspaceId] : [];
      const runs = (this.database.prepare(`SELECT * FROM runs${where} ORDER BY updated_at DESC`).all(...args) as IRunRow[]).map(runFromRow);
      const generatedAt = Date.now();
      const autoAnswerByItem = new Map((this.database.prepare(`SELECT * FROM mission_auto_answers${where} ORDER BY at, answer_id`)
        .all(...args) as IAutoAnswerRow[]).map((row) => [row.item_id, autoAnswerFromRow(row)]));
      const changesByItem = new Map((this.database.prepare(`SELECT * FROM mission_item_changes${where} ORDER BY item_id, revision`)
        .all(...args) as IChangesRow[]).map((row) => [row.item_id, JSON.parse(row.changes_json) as IMissionQuestionChanges]));
      const suggestionsByItem = new Map<string, IMissionAnswerSuggestion[]>();
      for (const row of this.database.prepare(`SELECT * FROM mission_answer_suggestions${where} ORDER BY at, entry_id`).all(...args) as ISuggestionRow[]) {
        suggestionsByItem.set(row.item_id, [...(suggestionsByItem.get(row.item_id) ?? []), suggestionFromRow(row)]);
      }
      const proposalByItem = new Map((this.database.prepare(`SELECT * FROM mission_so_proposals${where}`).all(...args) as ISoProposalRow[])
        .map((row) => [row.item_id, soProposalView(row)]));
      const itemRows = this.database.prepare(`SELECT * FROM attention_items${where} ORDER BY updated_at DESC`).all(...args) as IItemRow[];
      const answerRows = this.database.prepare(`SELECT * FROM answers${where} ORDER BY created_at DESC`).all(...args) as IAnswerRow[];
      const linksByItem = this.snapshotLinks(itemRows, answerRows, workspaceId);
      const items = itemRows.map((row) => itemFromRow(row, autoAnswerByItem.get(row.id) ?? null, changesByItem.get(row.id) ?? null,
        suggestionsByItem.get(row.id) ?? [], proposalByItem.get(row.id) ?? null, linksByItem.get(row.id) ?? NO_LINKS));
      const answersByClass = this.answersByClass(generatedAt, workspaceId);
      const autoAnswered = this.autoAnswered(generatedAt, workspaceId);
      const answers = answerRows.map(answerFromRow);
      const deliveries = (this.database.prepare(`SELECT * FROM deliveries${where} ORDER BY updated_at DESC`).all(...args) as IDeliveryRow[]).map(deliveryFromRow);
      const eventWhere = workspaceId ? 'WHERE workspace_id = ?' : '';
      const recentEvents = (this.database.prepare(`SELECT * FROM events ${eventWhere} ORDER BY seq DESC LIMIT 100`).all(...args) as IEventRow[]).reverse().map(eventFromRow);
      const cursor = Number((this.database.prepare(`SELECT COALESCE(MAX(seq), 0) AS cursor FROM events ${eventWhere}`).get(...args) as { cursor: number }).cursor);
      const latestBootstrap = this.database.prepare('SELECT * FROM bootstrap ORDER BY created_at DESC, rowid DESC LIMIT 1').get() as IBootstrapRow | undefined;
      const pendingBootstrapEntries = (this.database.prepare(`SELECT * FROM bootstrap_entries
        WHERE state IN ('queued','dispatching','submitted')${workspaceId ? ' AND workspace_id = ?' : ''}
        ORDER BY updated_at, bootstrap_id, workspace_id, run_id`).all(...args) as IBootstrapEntryRow[])
        .map((row) => ({ bootstrapId: row.bootstrap_id, entry: bootstrapEntryFromRow(row) }));
      const fullBootstrap = latestBootstrap ? this.bootstrapById(latestBootstrap.id) : null;
      const bootstrap = fullBootstrap && workspaceId
        ? { ...fullBootstrap, entries: fullBootstrap.entries.filter((entry) => entry.workspaceId === workspaceId) }
        : fullBootstrap;
      const persistedViews = latestBootstrap
        ? JSON.parse(latestBootstrap.workspace_views_json) as IMissionWorkspaceView[]
        : [];
      const supplied = workspaceId ? workspaces.filter((entry) => entry.workspaceId === workspaceId) : workspaces;
      const persisted = workspaceId ? persistedViews.filter((entry) => entry.workspaceId === workspaceId) : persistedViews;
      const runIdsByWorkspace = new Map<string, string[]>();
      for (const run of runs) {
        const ids = runIdsByWorkspace.get(run.workspaceId) ?? [];
        ids.push(run.id);
        runIdsByWorkspace.set(run.workspaceId, ids);
      }
      const deliveryByAnswer = new Map(deliveries.map((delivery) => [delivery.answerId, delivery]));
      const countsByWorkspace = new Map<string, { open: number; awaiting: number }>();
      for (const item of items) {
        const counts = countsByWorkspace.get(item.workspaceId) ?? { open: 0, awaiting: 0 };
        if (item.state === 'open' && item.humanReview && item.humanReview.humanNeed !== 'none') counts.open += 1;
        if (item.state === 'answered' && item.answerId) {
          const delivery = deliveryByAnswer.get(item.answerId);
          if (delivery && delivery.state !== 'acknowledged') counts.awaiting += 1;
        }
        countsByWorkspace.set(item.workspaceId, counts);
      }
      const persistedById = new Map(persisted.map((view) => [view.workspaceId, view]));
      const merged = supplied.map((view) => {
        const durableRuns = runs.filter((run) => run.workspaceId === view.workspaceId);
        const counts = countsByWorkspace.get(view.workspaceId) ?? { open: 0, awaiting: 0 };
        const durableProgress = durableRuns.reduce<number | null>((latest, run) =>
          run.lastProgressAt !== null && (latest === null || run.lastProgressAt > latest) ? run.lastProgressAt : latest, null);
        return {
          ...view,
          runIds: runIdsByWorkspace.get(view.workspaceId) ?? [],
          openItems: counts.open,
          awaitingAcknowledgement: counts.awaiting,
          lastProgressAt: durableProgress !== null && (view.lastProgressAt === null || durableProgress > view.lastProgressAt)
            ? durableProgress
            : view.lastProgressAt,
        };
      });
      const present = new Set(merged.map((view) => view.workspaceId));
      const durableWorkspaceIds = new Set([
        ...runs.map((run) => run.workspaceId),
        ...items.map((item) => item.workspaceId),
        ...deliveries.map((delivery) => delivery.workspaceId),
        ...persisted.map((view) => view.workspaceId),
      ]);
      for (const durableWorkspaceId of durableWorkspaceIds) {
        if (present.has(durableWorkspaceId)) continue;
        const previous = persistedById.get(durableWorkspaceId);
        const durableRuns = runs.filter((run) => run.workspaceId === durableWorkspaceId);
        const counts = countsByWorkspace.get(durableWorkspaceId) ?? { open: 0, awaiting: 0 };
        const lastProgressAt = durableRuns.reduce<number | null>((latest, run) =>
          run.lastProgressAt !== null && (latest === null || run.lastProgressAt > latest) ? run.lastProgressAt : latest, null);
        const evidence = durableRuns[0]?.evidence ?? previous?.evidence ?? {
          source: 'bootstrap' as const,
          sourceId: `orphan:${durableWorkspaceId}`,
          observedAt: Date.now(),
          confidence: 'unknown' as const,
        };
        merged.push({
          workspaceId: durableWorkspaceId,
          name: previous?.name ?? durableWorkspaceId,
          orphaned: true,
          activity: 'unknown',
          agents: [],
          runIds: runIdsByWorkspace.get(durableWorkspaceId) ?? [],
          openItems: counts.open,
          awaitingAcknowledgement: counts.awaiting,
          lastActivityAt: previous?.lastActivityAt ?? null,
          lastProgressAt,
          stale: previous?.stale ?? true,
          evidence,
        });
      }
      return {
        schemaVersion: 1,
        cursor,
        generatedAt,
        workspaces: merged,
        runs,
        items,
        answers,
        deliveries,
        recentEvents,
        bootstrap,
        pendingBootstrapEntries,
        answersByClass,
        autoAnswered,
      };
    });
    return read();
  };

  /**
   * Every item's links in one read (ADR-0037 amendment D2, rule 5). A link joins two items of one workspace, so the
   * snapshot's own rows hold both ends; a row outside them (a link that an older writer left) reads as no link.
   */
  private snapshotLinks = (itemRows: IItemRow[], answerRows: IAnswerRow[], workspaceId?: string): Map<string, IMissionItemLinks> => {
    const links = this.database.prepare(`SELECT * FROM mission_item_links${workspaceId ? ' WHERE workspace_id = ?' : ''} ORDER BY item_id`)
      .all(...(workspaceId ? [workspaceId] : [])) as ILinkRow[];
    const byItem = new Map<string, IMissionItemLinks>();
    if (!links.length) return byItem;
    const rowById = new Map(itemRows.map((row) => [row.id, row]));
    const answerById = new Map(answerRows.map((row) => [row.id, row]));
    const entry = (itemId: string): IMissionItemLinks => {
      const current = byItem.get(itemId) ?? { ...NO_LINKS };
      byItem.set(itemId, current);
      return current;
    };
    for (const link of links) {
      const follower = rowById.get(link.item_id);
      const target = rowById.get(link.follows_up_item_id);
      if (!follower || !target) continue;
      entry(follower.id).followsUp = followsUpView(target, target.answer_id === null ? undefined : answerById.get(target.answer_id));
      entry(target.id).followedBy = followedByView(follower);
    }
    return byItem;
  };

  /** ADR-0031 §3: answers of the last 7 UTC days (today included) per day, item class and actor kind. */
  private answersByClass = (now: number, workspaceId?: string): IMissionAnswerClassCount[] => {
    const tomorrow = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    const since = tomorrow - ANSWER_CLASS_WINDOW_DAYS * DAY_MS;
    const rows = this.database.prepare(`SELECT strftime('%Y-%m-%d', answer.created_at / 1000, 'unixepoch') AS day,
        json_extract(item.question_json, '$.class') AS class, answer.actor = ? AS rule, COUNT(*) AS count
      FROM answers answer JOIN attention_items item ON item.id = answer.item_id
      WHERE answer.created_at >= ? AND answer.created_at < ?${workspaceId ? ' AND answer.workspace_id = ?' : ''}
      GROUP BY day, class, rule`)
      .all(MISSION_AUTO_ANSWER_ACTOR, since, tomorrow, ...(workspaceId ? [workspaceId] : [])) as Array<{
        day: string; class: unknown; rule: number; count: number;
      }>;
    const counts = new Map<string, IMissionAnswerClassCount>();
    for (const row of rows) {
      const entry: IMissionAnswerClassCount = {
        day: row.day,
        class: attentionClassKey(row.class),
        by: row.rule ? 'rule' : 'human',
        count: 0,
      };
      const key = `${entry.day}|${entry.class}|${entry.by}`;
      const current = counts.get(key) ?? entry;
      current.count += row.count;
      counts.set(key, current);
    }
    return [...counts.values()].sort((left, right) => left.day.localeCompare(right.day)
      || ATTENTION_CLASS_KEYS.indexOf(left.class) - ATTENTION_CLASS_KEYS.indexOf(right.class)
      || (left.by === right.by ? 0 : left.by === 'human' ? -1 : 1));
  };

  /** ADR-0031 §7: the rule's answers of the last 7 days, newest first, at most 100. */
  private autoAnswered = (now: number, workspaceId?: string): IMissionAutoAnsweredItem[] => {
    const rows = this.database.prepare(`SELECT record.*, item.run_id, item.state AS item_state, item.question_json
      FROM mission_auto_answers record JOIN attention_items item ON item.id = record.item_id
      WHERE record.at >= ?${workspaceId ? ' AND record.workspace_id = ?' : ''}
      ORDER BY record.at DESC, record.answer_id LIMIT ?`)
      .all(now - AUTO_ANSWERED_WINDOW_MS, ...(workspaceId ? [workspaceId] : []), AUTO_ANSWERED_LIMIT) as Array<IAutoAnswerRow & {
        run_id: string; item_state: IMissionAttentionItem['state']; question_json: string;
      }>;
    return rows.map((row) => {
      const question = JSON.parse(row.question_json) as IMissionQuestion & IMissionAttentionClassInput;
      return {
        itemId: row.item_id,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        title: question.title,
        class: question.class ?? null,
        appliedOptionId: row.applied_option_id,
        // An answered question is frozen, so its options still name the applied one.
        appliedOptionLabel: question.options.find((option) => option.id === row.applied_option_id)?.label ?? row.applied_option_id,
        at: row.at,
        note: row.note,
        itemState: row.item_state,
      };
    });
  };

  /** Open items a producer classed as bookkeeping: the rule's candidates, before its eligibility check. */
  listAutoAnswerCandidates = (): IMissionAttentionItem[] =>
    (this.database.prepare(`SELECT * FROM attention_items
      WHERE state = 'open' AND json_extract(question_json, '$.class') = 'bookkeeping' ORDER BY updated_at, id`)
      .all() as IItemRow[]).map(this.item);

  eventsAfter = (after: number, limit: number, workspaceId?: string): IMissionEventsResponse => {
    const where = workspaceId ? 'seq > ? AND workspace_id = ?' : 'seq > ?';
    const args = workspaceId ? [after, workspaceId, limit + 1] : [after, limit + 1];
    const rows = this.database.prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq LIMIT ?`).all(...args) as IEventRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(eventFromRow);
    return { schemaVersion: 1, events, cursor: events.at(-1)?.seq ?? after, hasMore };
  };

  /** The current state of each of `itemIds` that exists (story 33: read before a batch applies, for the alert transition rule). */
  itemStates = (itemIds: readonly string[]): Map<string, TMissionItemState> => {
    const ids = [...new Set(itemIds)];
    if (!ids.length) return new Map();
    const rows = this.database.prepare(`SELECT id, state FROM attention_items WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: string; state: TMissionItemState }>;
    return new Map(rows.map((row) => [row.id, row.state]));
  };

  /** The board's "needs you" (ADR-0034): a workspace's open items, oldest first: id, title and when it opened. */
  openItemTitles = (workspaceId: string): Array<{ id: string; title: string; createdAt: number }> =>
    (this.database.prepare(`SELECT id, question_json, created_at FROM attention_items WHERE workspace_id = ? AND state = 'open'
      ORDER BY created_at, id`).all(workspaceId) as Array<{ id: string; question_json: string; created_at: number }>)
      .map((row) => ({
        id: row.id, title: String((JSON.parse(row.question_json) as { title?: unknown }).title ?? ''), createdAt: row.created_at,
      }));

  /** One item's state and question JSON, or null (ADR-0038: the curator's spot check and its shadow match read them). */
  itemQuestion = (workspaceId: string, itemId: string): { state: string; questionJson: string } | null => {
    const row = this.database.prepare('SELECT state, question_json FROM attention_items WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, itemId) as { state: string; question_json: string } | undefined;
    return row ? { state: row.state, questionJson: row.question_json } : null;
  };

  /**
   * The open item an owner message most likely answers (story 23 AC 2): the latest one awaiting the owner, opened or
   * revised at or before the message. Null when none awaits the owner.
   */
  latestOwnerItemBefore = (workspaceId: string, at: number): string | null => {
    const rows = this.database.prepare(`SELECT id, human_review_json FROM attention_items WHERE workspace_id = ? AND state = 'open'
      AND updated_at <= ? ORDER BY updated_at DESC, id DESC LIMIT 50`).all(workspaceId, at) as Array<{ id: string; human_review_json: string | null }>;
    const awaiting = rows.find((row) => {
      const review = parseJson<TMissionHumanReview>(row.human_review_json);
      return review !== null && review.humanNeed !== 'none';
    });
    return awaiting?.id ?? null;
  };

  /** Record a suggested answer link; a repeat of the same message on the same item is a no-op. */
  suggestAnswer = (workspaceId: string, itemId: string, entryId: string, span: string | null, at: number): void => {
    this.database.prepare('INSERT OR IGNORE INTO mission_answer_suggestions (item_id,workspace_id,entry_id,span,at) VALUES (?,?,?,?,?)')
      .run(itemId, workspaceId, entryId, span, at);
  };

  /** The latest answer to one item, or null: the curator's spot check reads the owner's (ADR-0038 §5). */
  latestAnswer = (workspaceId: string, itemId: string): IMissionAnswer | null => {
    const row = this.database.prepare('SELECT * FROM answers WHERE workspace_id = ? AND item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(workspaceId, itemId) as IAnswerRow | undefined;
    return row ? answerFromRow(row) : null;
  };

  /** The pulse (ADR-0034 §9): when each answer to a workspace's items was recorded, since `since`. */
  answerTimes = (workspaceId: string, since: number): number[] =>
    this.database.prepare('SELECT created_at FROM answers WHERE workspace_id = ? AND created_at >= ? ORDER BY created_at')
      .pluck().all(workspaceId, since) as number[];

  /** Items the tab opened at or after `since`, any state: a NEEDS-DECISION turn that already asked opens none (ADR-0041). */
  itemsOpenedByTab = (workspaceId: string, tabId: string, since: number): string[] =>
    (this.database.prepare(`SELECT item_id FROM mission_item_openers INDEXED BY mission_item_openers_tab_idx
      WHERE workspace_id = ? AND tab_id = ? AND opened_at >= ? ORDER BY opened_at, item_id`).all(workspaceId, tabId, since) as Array<{ item_id: string }>)
      .map((row) => row.item_id);

  /** Still-open items (candidate or open) whose id starts with the prefix, whoever opened them (ADR-0041 §2). */
  openItemsWithIdPrefix = (workspaceId: string, prefix: string): string[] =>
    (this.database.prepare(`SELECT id FROM attention_items WHERE workspace_id = ? AND substr(id, 1, length(?)) = ?
      AND state IN ('candidate','open') ORDER BY created_at, id`).all(workspaceId, prefix, prefix) as Array<{ id: string }>)
      .map((row) => row.id);

  /** One served item by id, or null. */
  attentionItem = (itemId: string): IMissionAttentionItem | null => {
    const row = this.itemRow(itemId);
    return row ? this.item(row) : null;
  };

  /** One proposal record, or null (ADR-0041 §1 amendment D7). */
  soProposal = (itemId: string): IMissionSoProposalRecord | null => {
    const row = this.proposalRow(itemId);
    return row ? soProposalFromRow(row) : null;
  };

  /** Every proposal still `open`, oldest first: the 60 s pass settles each, whatever the auto-answer key holds. */
  openSoProposals = (): IMissionSoProposalRecord[] =>
    (this.database.prepare(`SELECT * FROM mission_so_proposals WHERE state = 'open' ORDER BY created_at, item_id`).all() as ISoProposalRow[])
      .map(soProposalFromRow);

  /** One answer by id, or null. */
  answerById = (answerId: string): IMissionAnswer | null => {
    const row = this.database.prepare('SELECT * FROM answers WHERE id = ?').get(answerId) as IAnswerRow | undefined;
    return row ? answerFromRow(row) : null;
  };

  /**
   * Close an open proposal record with its outcome. False when it was not open: another step decided it first, so the
   * caller writes no second audit row and sends no second line.
   */
  settleSoProposal = (itemId: string, outcome: IMissionSoProposalOutcome): boolean =>
    this.database.prepare(`UPDATE mission_so_proposals SET state=?, answer_id=COALESCE(?, answer_id), order_id=?, reason=?, reason_code=?,
      decided_at=? WHERE item_id=? AND state='open'`)
      .run(outcome.state, outcome.answerId ?? null, outcome.orderId ?? null, outcome.reason ?? null, outcome.reasonCode ?? null,
        outcome.decidedAt, itemId).changes === 1;

  /**
   * The 72 h timeout (D7 rule 7): cancel the unanswered item with the server event `system:so-proposal:expire:<itemId>`
   * and close its record as `expired`, in one transaction. False when the item is no longer open or the record is not
   * open: an answer or a withdrawal came first.
   */
  expireSoProposal = (itemId: string, reason: string, now = Date.now()): boolean => {
    const transaction = this.database.transaction((): boolean => {
      const record = this.proposalRow(itemId);
      const row = this.itemRow(itemId);
      if (!record || record.state !== 'open' || !row || row.state !== 'open' || row.answer_id) return false;
      const item = this.item(row);
      const revision = item.revision + 1;
      this.database.prepare(`UPDATE attention_items SET revision=?, state='cancelled', resolution=?, updated_at=? WHERE id=?`)
        .run(revision, reason, now, item.id);
      this.insertServerEvent({
        id: `${SO_PROPOSAL_EVENT_PREFIX}expire:${item.id}`,
        workspaceId: item.workspaceId,
        runId: item.runId,
        entityId: item.id,
        revision,
        type: 'attention.cancelled',
        payload: this.eventPayloadWithRouting({ itemId: item.id, reason }, 'cancelled', item.candidateReason, item.humanReview),
      }, now);
      this.database.prepare(`UPDATE mission_so_proposals SET state='expired', reason=?, decided_at=? WHERE item_id=? AND state='open'`)
        .run(reason, now, item.id);
      return true;
    });
    try {
      return transaction();
    } catch (error) {
      if (isMissionControlError(error)) throw error;
      if (isSqliteFailure(error)) throw new MissionControlError(503, 'storage-unavailable', 'Mission Control storage unavailable');
      throw error;
    }
  };

  /** Every open workspace item (candidate or open) with its recorded opener, if any (ADR-0023). */
  openItemOpeners = (): IMissionOpenItemOpener[] => {
    const rows = this.database.prepare(`SELECT a.id AS item_id, a.workspace_id, a.created_at,
        a.human_review_json IS NOT NULL AS reviewed, o.tab_id, o.identity
      FROM attention_items a LEFT JOIN mission_item_openers o ON o.item_id = a.id
      WHERE a.state IN ('candidate','open') ORDER BY a.created_at, a.id`).all() as Array<{
        item_id: string; workspace_id: string; created_at: number; reviewed: number; tab_id: string | null; identity: string | null;
      }>;
    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      itemId: row.item_id,
      createdAt: row.created_at,
      reviewed: row.reviewed === 1,
      opener: row.tab_id && (row.identity === 'launch' || row.identity === 'hook' || row.identity === 'session')
        ? { tabId: row.tab_id, identity: row.identity }
        : null,
    }));
  };

  humanInboxPolicy = (workspaceId: string): IMissionHumanInboxPolicy => {
    const legacyReviewPending = Number((this.database.prepare(`SELECT COUNT(*) AS count
      FROM attention_items WHERE workspace_id=? AND state='candidate' AND candidate_reason='legacy-review'`)
      .get(workspaceId) as { count: number }).count);
    return {
      version: 1,
      legacyReviewPending,
      ...(legacyReviewPending > 0 ? { guidance: HUMAN_INBOX_POLICY_GUIDANCE } : {}),
    };
  };

  unreplayedEventIds = (events: TMissionProducerEvent[]): Set<string> => {
    const pending = new Set<string>();
    for (const event of events) {
      const row = this.database.prepare('SELECT request_hash FROM events WHERE id=?').get(event.eventId) as { request_hash: string } | undefined;
      if (!row) {
        pending.add(event.eventId);
      } else if (row.request_hash !== contentHash(event)) {
        missionConflict(`event ${event.eventId} was already used with different content`);
      }
    }
    return pending;
  };

  applyEvents = (
    events: TMissionProducerEvent[],
    resolvedBindings: ReadonlyMap<string, TMissionIdentity | IMissionEventAuthority | null> = new Map(),
    options: {
      questionMinVersion?: 1 | 2;
      soProposals?: ReadonlyMap<string, TMissionSoProposalInput>;
      ndLines?: ReadonlyMap<string, IMissionNeedsDecisionLineInput>;
    } = {},
  ): IMissionApplyEventsResult => {
    const transaction = this.database.transaction(() => {
      const committed: IMissionEvent[] = [];
      let allReplayed = true;
      for (const event of events) {
        const requestHash = contentHash(event);
        const existing = this.database.prepare('SELECT * FROM events WHERE id = ?').get(event.eventId) as IEventRow | undefined;
        if (existing) {
          if (existing.request_hash !== requestHash) missionConflict(`event ${event.eventId} was already used with different content`);
          committed.push(eventFromRow(existing));
          continue;
        }
        allReplayed = false;
        const suppliedAuthority = resolvedBindings.get(event.eventId) ?? null;
        const authority: IMissionEventAuthority = suppliedAuthority && 'resolvedIdentity' in suppliedAuthority
          ? suppliedAuthority
          : { resolvedIdentity: suppliedAuthority, configuredOrchestratorTabId: null };
        committed.push(this.applyOneEvent(event, requestHash, authority, options.questionMinVersion ?? 1, options.soProposals?.get(event.eventId) ?? null,
          options.ndLines?.get(event.eventId) ?? null));
      }
      const cursor = Number((this.database.prepare('SELECT COALESCE(MAX(seq), 0) AS cursor FROM events').get() as { cursor: number }).cursor);
      // A replay rebuilds the same answer from the stored link, so the asker reads it either way.
      const followedUps = events.flatMap((event) => (event.type === 'attention.opened' && event.payload.followsUp !== undefined
        ? [this.followedUpOf(event.payload.itemId)].filter((entry): entry is IMissionFollowedUp => entry !== null)
        : []));
      return {
        events: committed,
        cursor,
        replayed: allReplayed,
        ...(followedUps.length === 1 ? { followedUp: followedUps[0] } : followedUps.length > 1 ? { followedUps } : {}),
      };
    });
    try {
      return transaction();
    } catch (error) {
      if (isMissionControlError(error)) throw error;
      if (isSqliteFailure(error)) throw new MissionControlError(503, 'storage-unavailable', 'Mission Control storage unavailable');
      throw error;
    }
  };

  private applyOneEvent = (
    event: TMissionProducerEvent,
    requestHash: string,
    authority: IMissionEventAuthority,
    questionMinVersion: 1 | 2,
    soProposal: TMissionSoProposalInput | null = null,
    ndLine: IMissionNeedsDecisionLineInput | null = null,
  ): IMissionEvent => {
    const now = Date.now();
    const resolvedIdentity = authority.resolvedIdentity;
    const runRow = this.runRow(event.runId);
    if (event.type === 'run.started') {
      if (event.expectedRevision !== 0 || event.bindingGeneration !== 0) invalidMissionRequest('run.started requires revision 0 and generation 0');
      if (!resolvedIdentity) throw new MissionControlError(409, 'conflict', 'target agent binding is not live');
      if (runRow && runRow.workspace_id !== event.workspaceId) {
        missionConflict('run ID is already in use');
      }
      if (runRow && !(runRow.revision === 0 && (JSON.parse(runRow.evidence_json) as IMissionEvidence).confidence !== 'confirmed')) {
        missionConflict('run already exists', runFromRow(runRow));
      }
      const binding: IMissionBinding = { ...resolvedIdentity, generation: 1 };
      const evidence: IMissionEvidence = { source: 'agent', sourceId: event.eventId, observedAt: event.producerAt, confidence: 'confirmed' };
      if (runRow) {
        if (runRow.workspace_id !== event.workspaceId) missionConflict('run belongs to another workspace');
        this.database.prepare(`UPDATE runs SET revision=1, objective=?, epic_json=?, state='running', binding_json=?, evidence_json=?, last_progress_at=?, updated_at=? WHERE id=?`)
          .run(event.payload.objective, event.payload.epic === undefined ? null : toJson(event.payload.epic), toJson(binding), toJson(evidence), event.producerAt, now, event.runId);
      } else {
        this.database.prepare(`INSERT INTO runs
          (id,workspace_id,revision,objective,epic_json,phase,state,next_step,binding_json,evidence_json,closeout_pending,story_counts_json,last_progress_at,created_at,updated_at,source_key)
          VALUES (?,?,1,?,? ,NULL,'running',NULL,?,?,0,NULL,?,?,?,NULL)`)
          .run(event.runId, event.workspaceId, event.payload.objective, event.payload.epic === undefined ? null : toJson(event.payload.epic), toJson(binding), toJson(evidence), event.producerAt, now, now);
      }
      this.confirmBootstrap(event.runId, now);
      return this.insertEvent(event, event.runId, 1, now, requestHash);
    }

    if (!runRow) throw new MissionControlError(404, 'not-found', `run ${event.runId} not found`);
    if (runRow.workspace_id !== event.workspaceId) missionConflict('run belongs to another workspace');
    const run = runFromRow(runRow);

    if (event.type === 'run.resumed') {
      const isUnboundProvisional = run.revision === 0
        && run.binding === null
        && run.evidence.confidence !== 'confirmed';
      if (isUnboundProvisional) {
        if (event.expectedRevision !== 0 || event.bindingGeneration !== 0) {
          missionConflict('provisional run resume requires revision 0 and generation 0', run);
        }
      } else {
        this.requireRunRevisionAndGeneration(event, run);
      }
      if (!resolvedIdentity) throw new MissionControlError(409, 'conflict', 'target agent binding is not live', run);
      if (run.state === 'completed' || run.state === 'cancelled') missionConflict('finished run cannot be resumed', run);
      const binding: IMissionBinding = { ...resolvedIdentity, generation: (run.binding?.generation ?? 0) + 1 };
      const revision = run.revision + 1;
      this.holdDispatchingDeliveries(run.id, 'transport-uncertain:run-resumed-during-dispatch', now);
      this.database.prepare(`UPDATE runs SET revision=?, state='running', binding_json=?, evidence_json=?, last_progress_at=?, updated_at=? WHERE id=?`)
        .run(revision, toJson(binding), toJson({ source: 'agent', sourceId: event.eventId, observedAt: event.producerAt, confidence: 'confirmed' }), event.producerAt, now, run.id);
      if (event.payload.transferPendingAnswers) {
        this.transferPendingDeliveries(run.id, binding, now);
      } else {
        this.database.prepare(`UPDATE deliveries SET state='held', next_attempt_at=NULL, last_error='run resumed without answer transfer', updated_at=MAX(?,updated_at+1)
          WHERE run_id=? AND state='queued'`).run(now, run.id);
      }
      this.confirmBootstrap(run.id, now);
      return this.insertEvent(event, run.id, revision, now, requestHash);
    }

    if (event.type === 'progress.updated' || event.type === 'run.finished') {
      this.requireRunRevisionAndGeneration(event, run);
      if (run.state === 'completed' || run.state === 'cancelled') missionConflict('finished run cannot be changed', run);
      const revision = run.revision + 1;
      if (event.type === 'progress.updated') {
        const payload = event.payload;
        this.database.prepare(`UPDATE runs SET revision=?, objective=?, epic_json=?, phase=?, state=?, next_step=?, story_counts_json=?, closeout_pending=?, last_progress_at=?, updated_at=?, evidence_json=? WHERE id=?`)
          .run(revision, payload.objective ?? run.objective,
            payload.epic === undefined ? toJson(run.epic) : toJson(payload.epic),
            payload.phase === undefined ? run.phase : payload.phase,
            payload.state ?? run.state,
            payload.nextStep === undefined ? run.nextStep : payload.nextStep,
            payload.storyCounts === undefined ? toJson(run.storyCounts) : toJson(payload.storyCounts),
            payload.closeoutPending === undefined ? Number(run.closeoutPending) : Number(payload.closeoutPending),
            event.producerAt, now,
            toJson({ source: 'agent', sourceId: event.eventId, observedAt: event.producerAt, confidence: 'confirmed' }), run.id);
      } else {
        this.database.prepare(`UPDATE runs SET revision=?, state=?, next_step=?, closeout_pending=?, last_progress_at=?, updated_at=?, evidence_json=? WHERE id=?`)
          .run(revision, event.payload.state, event.payload.summary, Number(event.payload.closeoutPending), event.producerAt, now,
            toJson({ source: 'agent', sourceId: event.eventId, observedAt: event.producerAt, confidence: 'confirmed' }), run.id);
      }
      this.confirmBootstrap(run.id, now);
      return this.insertEvent(event, run.id, revision, now, requestHash);
    }

    this.requireBindingGeneration(event, run);
    const itemId = event.type === 'answer.acknowledged'
      ? (this.database.prepare('SELECT item_id FROM answers WHERE id=?').get(event.payload.answerId) as { item_id: string } | undefined)?.item_id
      : event.payload.itemId;
    if (!itemId) throw new MissionControlError(404, 'not-found', `answer ${event.type === 'answer.acknowledged' ? event.payload.answerId : ''} not found`);
    const itemRow = this.itemRow(itemId);

    if (event.type === 'attention.opened') {
      if (event.expectedRevision !== 0) invalidMissionRequest('attention.opened requires revision 0');
      if (itemRow && (itemRow.workspace_id !== event.workspaceId || itemRow.run_id !== event.runId)) {
        missionConflict('attention item ID is already in use');
      }
      if (itemRow) missionConflict('attention item already exists', this.item(itemRow));
      // One open item per NEEDS-DECISION line (#521, R-03): a second id with the same `nd-<lineKey>` is refused, so
      // an open from a note sent before a restart, or a server open that raced it, never makes a second item.
      const linePrefix = needsDecisionLinePrefix(itemId);
      const openForLine = linePrefix ? this.openItemsWithIdPrefix(event.workspaceId, linePrefix).at(-1) : undefined;
      const openForLineRow = openForLine ? this.itemRow(openForLine) : undefined;
      if (openForLineRow) {
        throw new MissionControlError(409, 'already-open',
          `an item for this NEEDS-DECISION line is already open: ${openForLineRow.id}`, this.item(openForLineRow));
      }
      // A proposal item and its record are one write (ADR-0041 §1 amendment D7): neither exists without the other.
      if (itemId.startsWith(SO_PROPOSAL_ITEM_PREFIX) !== (soProposal !== null)) {
        invalidMissionRequest(`a ${SO_PROPOSAL_ITEM_PREFIX} item opens only with its proposal record, and a record only with that item`);
      }
      // `followsUp` is not a question field (ADR-0037 amendment D2, rule 1): it never reaches question_json or the hash.
      const { itemId: ignored, humanReview: reviewInput, followsUp, ...question } = event.payload;
      void ignored;
      const target = followsUp === undefined ? null : this.requireFollowUp({
        workspaceId: event.workspaceId, runId: event.runId, itemId, followsUp, humanReview: reviewInput,
      });
      const humanReview = reviewInput
        ? this.stampHumanReview(event, run, authority, now)
        : null;
      const state = humanReview && humanReview.humanNeed !== 'none' ? 'open' : 'candidate';
      const candidateReason: TMissionCandidateReason | null = state === 'candidate' ? 'workspace-issue' : null;
      this.database.prepare(`INSERT INTO attention_items
        (id,workspace_id,run_id,revision,state,question_json,evidence_json,answer_id,resolution,created_at,updated_at,source_key,human_review_json,candidate_reason)
        VALUES (?,?,?,1,?,?,?,NULL,NULL,?,?,NULL,?,?)`)
        .run(itemId, event.workspaceId, event.runId, state, toJson(question), toJson({ source: 'agent', sourceId: event.eventId, observedAt: event.producerAt, confidence: 'confirmed' }), now, now,
          humanReview ? toJson(humanReview) : null, candidateReason);
      if (authority.opener) {
        this.database.prepare(`INSERT OR IGNORE INTO mission_item_openers
          (item_id,workspace_id,tab_id,identity,event_id,opened_at) VALUES (?,?,?,?,?,?)`)
          .run(itemId, event.workspaceId, authority.opener.tabId, authority.opener.identity, event.eventId, now);
      }
      if (ndLine) this.writeNeedsDecisionLine(event.workspaceId, itemId, 1, ndLine, authority.opener?.tabId ?? null, now);
      if (soProposal) {
        this.database.prepare(`INSERT INTO mission_so_proposals
          (item_id,workspace_id,proposer_tab_id,text,scope,check_name,cites,state,answer_id,order_id,reason,created_at,decided_at)
          VALUES (?,?,?,?,?,?,?,'open',NULL,NULL,NULL,?,NULL)`)
          .run(itemId, event.workspaceId, soProposal.proposerTabId, soProposal.text, soProposal.scope, soProposal.checkName, soProposal.cites, now);
      }
      this.confirmBootstrap(run.id, now);
      const opened = this.insertEvent(event, itemId, 1, now, requestHash,
        this.attentionEventPayload(event.payload, state, candidateReason, humanReview));
      if (target) this.writeFollowUp(target, itemId, now);
      return opened;
    }

    if (!itemRow) throw new MissionControlError(404, 'not-found', `attention item ${itemId} not found`);
    if (itemRow.workspace_id !== event.workspaceId || itemRow.run_id !== event.runId) missionConflict('attention item is outside this run');
    const item = this.item(itemRow);
    if (event.expectedRevision !== item.revision) missionConflict('stale attention revision', item);

    if (event.type === 'attention.updated') {
      if (!['open', 'candidate'].includes(item.state)) missionConflict('only open or candidate items can be updated', item);
      const { itemId: ignored, humanReview: reviewInput, ...question } = event.payload;
      void ignored;
      const previous = JSON.parse(itemRow.question_json) as TMissionStoredQuestion;
      this.requireQuestionFormat(event.eventId, item.id, previous, question, questionMinVersion);
      const changed = contentHash(question) !== contentHash(previous);
      if (item.state === 'open' && changed && !reviewInput) {
        missionConflict('changed human attention requires renewed orchestrator review', item);
      }
      let humanReview = item.humanReview;
      let state: IMissionAttentionItem['state'] = item.state;
      let candidateReason = item.candidateReason;
      if (reviewInput) {
        humanReview = this.stampHumanReview(event, run, authority, now);
        if (humanReview.humanNeed === 'none') {
          state = 'candidate';
          candidateReason = 'workspace-issue';
        } else {
          state = 'open';
          candidateReason = null;
        }
      } else if (item.state === 'candidate' && changed && item.humanReview?.humanNeed === 'none') {
        humanReview = null;
      }
      const revision = item.revision + 1;
      const changes = diffMissionQuestions(previous, question, item.revision, revision);
      this.database.prepare(`UPDATE attention_items SET revision=?, state=?, question_json=?, evidence_json=?,
        human_review_json=?, candidate_reason=?, updated_at=? WHERE id=?`)
        .run(revision, state, toJson(question), toJson({ source: 'agent', sourceId: event.eventId, observedAt: event.producerAt, confidence: 'confirmed' }),
          humanReview ? toJson(humanReview) : null, candidateReason, now, item.id);
      this.database.prepare('INSERT OR REPLACE INTO mission_item_changes (item_id,workspace_id,revision,changes_json,at) VALUES (?,?,?,?,?)')
        .run(item.id, item.workspaceId, revision, toJson(changes), now);
      if (ndLine) this.writeNeedsDecisionLine(event.workspaceId, item.id, revision, ndLine, this.needsDecisionTabOf(item.id), now);
      this.confirmBootstrap(run.id, now);
      return this.insertEvent(event, item.id, revision, now, requestHash,
        { ...this.attentionEventPayload(event.payload, state, candidateReason, humanReview), changes });
    }

    if (event.type === 'attention.cancelled') {
      if (['resolved', 'cancelled'].includes(item.state)) missionConflict('attention item is already closed', item);
      const revision = item.revision + 1;
      this.database.prepare(`UPDATE attention_items SET revision=?, state='cancelled', resolution=?, updated_at=? WHERE id=?`)
        .run(revision, event.payload.reason, now, item.id);
      if (item.answerId) {
        this.database.prepare(`UPDATE deliveries SET state='held', next_attempt_at=NULL, last_error='attention item cancelled', updated_at=? WHERE answer_id=? AND state IN ('queued','dispatching')`)
          .run(now, item.answerId);
      }
      return this.insertEvent(event, item.id, revision, now, requestHash,
        this.eventPayloadWithRouting(event.payload, 'cancelled', item.candidateReason, item.humanReview));
    }

    if (event.type === 'attention.resolved') {
      if (['resolved', 'cancelled'].includes(item.state)) {
        missionConflict('attention item is already closed; do not retry this event unchanged', item);
      }
      if (!item.answerId) {
        missionConflict('attention has no human answer to resolve; if the action completed outside Mission Control, send attention.cancelled with a reason instead; do not retry this event unchanged', item);
      }
      if (item.state !== 'answered') missionConflict('only answered attention can be resolved', item);
      const delivery = this.database.prepare('SELECT * FROM deliveries WHERE answer_id=?').get(item.answerId) as IDeliveryRow | undefined;
      if (!delivery || delivery.state !== 'acknowledged') missionConflict('answer must be acknowledged before resolution', item);
      const revision = item.revision + 1;
      this.database.prepare(`UPDATE attention_items SET revision=?, state='resolved', resolution=?, updated_at=? WHERE id=?`)
        .run(revision, event.payload.resolution, now, item.id);
      return this.insertEvent(event, item.id, revision, now, requestHash,
        this.eventPayloadWithRouting(event.payload, 'resolved', item.candidateReason, item.humanReview));
    }

    if (item.state !== 'answered' || item.answerId !== event.payload.answerId) missionConflict('answer is not current for this attention item', item);
    const delivery = this.database.prepare('SELECT * FROM deliveries WHERE answer_id=?').get(event.payload.answerId) as IDeliveryRow | undefined;
    if (!delivery) throw new MissionControlError(404, 'not-found', `delivery for answer ${event.payload.answerId} not found`);
    if (delivery.state !== 'acknowledged') {
      this.database.prepare(`UPDATE deliveries SET state='acknowledged', next_attempt_at=NULL, acknowledged_at=?, updated_at=? WHERE id=?`)
        .run(now, now, delivery.id);
    }
    return this.insertEvent(event, item.id, item.revision, now, requestHash);
  };

  /**
   * The target of a follow-up, checked against the edge cases of ADR-0037 amendment D2; a refusal throws and writes
   * nothing. The new item must reach the owner: a candidate is not yet a question to the owner.
   */
  private requireFollowUp = (input: IMissionFollowUpInput): IItemRow => {
    if (input.followsUp === input.itemId) {
      invalidMissionRequest(`followsUp names the item itself (${input.itemId}); it must name an earlier, answered item`);
    }
    const target = this.itemRow(input.followsUp);
    if (!target) throw new MissionControlError(404, 'not-found', `follow-up target ${input.followsUp} not found`);
    // ADR-0021: the denial names neither the other workspace nor the target's state.
    if (target.workspace_id !== input.workspaceId) {
      throw new MissionControlError(403, 'forbidden',
        'followsUp names an item outside this workspace: Mission Control writes are confined to the caller workspace (ADR-0021). Use coordinator notes for a cross-workspace request.');
    }
    const refuse = (message: string, detail: IMissionFollowUpRefusal): never => missionConflict(message, undefined, { followsUp: detail });
    if (target.run_id !== input.runId) {
      refuse(`follow-up target ${target.id} is outside this run: an item, its answer and its delivery belong to one run binding`, { reason: 'other-run' });
    }
    if (target.state === 'cancelled') {
      refuse(`follow-up target ${target.id} was cancelled, so it has no owner answer to follow up; open the item without followsUp`, { reason: 'not-answered' });
    }
    if (target.state !== 'answered' && target.state !== 'resolved') {
      refuse(`follow-up target ${target.id} is not answered yet (state ${target.state}): revise it with attention.updated; a compatible revision keeps the owner's draft`,
        { reason: 'not-answered' });
    }
    const follower = this.database.prepare('SELECT item_id FROM mission_item_links WHERE follows_up_item_id = ?').pluck().get(target.id) as string | undefined;
    if (follower !== undefined) {
      const tip = this.chainTip(follower);
      refuse(`follow-up target ${target.id} is already followed up by ${follower}; follow up the tip ${tip} after the owner answers it, or revise ${tip} while it is open`,
        { reason: 'already-followed', followedBy: follower, tip });
    }
    if (!input.humanReview || input.humanReview.humanNeed === 'none') {
      invalidMissionRequest('a follow-up must reach the owner: send humanReview with a humanNeed other than none (a candidate is not yet a question to the owner)');
    }
    return target;
  };

  /** The last item of the chain that starts at `itemId`: links point from newer to older items, so the walk ends. */
  private chainTip = (itemId: string): string =>
    this.database.prepare(`WITH RECURSIVE chain(id, depth) AS (
        SELECT ?, 0
        UNION ALL SELECT link.item_id, chain.depth + 1 FROM mission_item_links link JOIN chain ON link.follows_up_item_id = chain.id
        WHERE chain.depth < 100000
      ) SELECT id FROM chain ORDER BY depth DESC LIMIT 1`).pluck().get(itemId) as string;

  /**
   * The follow-up's writes after its item opened (ADR-0037 amendment D2, rule 3): the link, and for an answered target
   * its delivery acknowledged and the target resolved by a `system:follow-up:` event. A resolved target gets the link only.
   */
  private writeFollowUp = (target: IItemRow, itemId: string, now: number): void => {
    this.database.prepare('INSERT INTO mission_item_links (item_id, follows_up_item_id, workspace_id, at) VALUES (?,?,?,?)')
      .run(itemId, target.id, target.workspace_id, now);
    if (target.state !== 'answered') return;
    if (target.answer_id !== null) {
      // As `answer.acknowledged` does; the version moves, so a claim that read the old row cannot take it.
      this.database.prepare(`UPDATE deliveries SET state='acknowledged', next_attempt_at=NULL, acknowledged_at=?, updated_at=MAX(?,updated_at+1)
        WHERE answer_id=? AND state<>'acknowledged'`).run(now, now, target.answer_id);
    }
    const revision = target.revision + 1;
    const resolution = `Followed up by ${itemId}.`;
    this.database.prepare(`UPDATE attention_items SET revision=?, state='resolved', resolution=?, updated_at=? WHERE id=?`)
      .run(revision, resolution, now, target.id);
    this.insertServerEvent({
      id: `${FOLLOW_UP_EVENT_PREFIX}${itemId}`,
      workspaceId: target.workspace_id,
      runId: target.run_id,
      entityId: target.id,
      revision,
      type: 'attention.resolved',
      payload: this.eventPayloadWithRouting({ itemId: target.id, resolution, followedBy: itemId, actor: 'system:follow-up' },
        'resolved', target.candidate_reason, parseJson<TMissionHumanReview>(target.human_review_json)),
    }, now);
  };

  /** The answer a follow-up acknowledged, for the 200 body (rule 4); null when the item follows nothing up. */
  private followedUpOf = (itemId: string): IMissionFollowedUp | null => {
    const link = this.database.prepare('SELECT * FROM mission_item_links WHERE item_id = ?').get(itemId) as ILinkRow | undefined;
    const target = link ? this.itemRow(link.follows_up_item_id) : undefined;
    if (!target) return null;
    const view = followsUpView(target, this.answerRow(target.answer_id));
    const resolved = this.database.prepare('SELECT 1 FROM events WHERE id = ?').get(`${FOLLOW_UP_EVENT_PREFIX}${itemId}`) !== undefined;
    return {
      itemId: target.id,
      answerId: target.answer_id,
      optionIds: view.answer?.optionIds ?? [],
      optionLabels: view.answer?.optionLabels ?? [],
      text: view.answer?.text ?? '',
      resolved,
    };
  };

  /**
   * The question check's view of a follow-up (ADR-0037 amendment D2, rule 2): the refusal the events route would give,
   * or null. It reads and writes nothing else.
   */
  followUpRefusal = (input: IMissionFollowUpInput): MissionControlError | null => {
    try {
      this.database.transaction(() => this.requireFollowUp(input))();
      return null;
    } catch (error) {
      if (isMissionControlError(error)) return error;
      throw error;
    }
  };

  /** A paste may be in flight to the binding the run is leaving: held as uncertain, never sent again. */
  private holdDispatchingDeliveries = (runId: string, reason: string, now: number): void => {
    this.database.prepare(`UPDATE deliveries SET state='held', next_attempt_at=NULL, last_error=?, updated_at=MAX(?,updated_at+1)
      WHERE run_id=? AND state='dispatching'`).run(reason, now, runId);
  };

  /** Answers not yet delivered, for items still answered, follow the run to its new binding. */
  private transferPendingDeliveries = (runId: string, binding: IMissionBinding, now: number): void => {
    this.database.prepare(`UPDATE deliveries SET binding_json=?, state='queued', next_attempt_at=?, last_error=NULL,
      updated_at=MAX(?,updated_at+1)
      WHERE run_id=? AND state IN ('queued','held','failed')
      AND (last_error IS NULL OR last_error NOT LIKE 'transport-uncertain:%')
      AND EXISTS (SELECT 1 FROM attention_items item
        WHERE item.run_id=deliveries.run_id AND item.answer_id=deliveries.answer_id AND item.state='answered')`)
      .run(toJson(binding), now, now, runId);
  };

  listOpenRunBindings = (workspaceId?: string): IMissionOpenRunBinding[] =>
    (this.database.prepare(`SELECT id, workspace_id, binding_json FROM runs
      WHERE state NOT IN ('completed','cancelled') AND binding_json IS NOT NULL${workspaceId ? ' AND workspace_id=?' : ''}
      ORDER BY workspace_id, id`).all(...(workspaceId ? [workspaceId] : [])) as Array<Pick<IRunRow, 'id' | 'workspace_id' | 'binding_json'>>)
      .map((row) => ({ runId: row.id, workspaceId: row.workspace_id, binding: JSON.parse(row.binding_json as string) as IMissionBinding }));

  /**
   * A change of the workspace orchestrator moves each open bound run to the new orchestrator's
   * identity at the next binding generation, in one transaction with its `run.rebound` audit event.
   * A run already on that identity is left alone, so a repeat is a no-op. An unbound provisional run
   * keeps waiting for the `run.resumed` its bootstrap asks for.
   */
  rebindOpenRuns = (input: IMissionRebindInput): IMissionEvent[] => {
    const transaction = this.database.transaction((): IMissionEvent[] => {
      const now = Date.now();
      const rows = this.database.prepare(`SELECT * FROM runs
        WHERE workspace_id=? AND state NOT IN ('completed','cancelled') AND binding_json IS NOT NULL ORDER BY id`)
        .all(input.workspaceId) as IRunRow[];
      const events: IMissionEvent[] = [];
      for (const row of rows) {
        const previousBinding = JSON.parse(row.binding_json as string) as IMissionBinding;
        if (boundToIdentity(previousBinding, input.identity)) continue;
        if (input.eligible && !input.eligible(previousBinding)) continue;
        const binding: IMissionBinding = {
          tabId: input.identity.tabId,
          providerId: input.identity.providerId,
          sessionId: input.identity.sessionId,
          generation: previousBinding.generation + 1,
          runtimeGeneration: input.identity.runtimeGeneration,
        };
        const revision = row.revision + 1;
        this.holdDispatchingDeliveries(row.id, 'transport-uncertain:run-rebound-during-dispatch', now);
        this.database.prepare('UPDATE runs SET revision=?, binding_json=?, updated_at=? WHERE id=?')
          .run(revision, toJson(binding), now, row.id);
        this.transferPendingDeliveries(row.id, binding, now);
        const payload: IMissionRunReboundPayload = { cause: input.cause, previousBinding, binding, actor: 'system:orchestration' };
        events.push(this.insertServerEvent({
          id: `system:rebind:${createHash('sha256').update(row.id).digest('hex').slice(0, 32)}:${binding.generation}`,
          workspaceId: row.workspace_id,
          runId: row.id,
          entityId: row.id,
          revision,
          type: 'run.rebound',
          payload,
        }, now));
      }
      return events;
    });
    try {
      return transaction();
    } catch (error) {
      if (isMissionControlError(error)) throw error;
      if (isSqliteFailure(error)) throw new MissionControlError(503, 'storage-unavailable', 'Mission Control storage unavailable');
      throw error;
    }
  };

  private confirmBootstrap = (runId: string, now: number): void => {
    this.database.prepare(`UPDATE bootstrap_entries SET state='confirmed', reason=NULL, next_attempt_at=NULL,
      updated_at=MAX(?,updated_at+1)
      WHERE run_id=? AND state IN ('queued','dispatching','submitted','held')`).run(now, runId);
  };

  /**
   * ADR-0037 §2: at min-version 2 an update may keep a v1 item v1 (it is not a new question), but
   * never turns a format-2 item back into v1.
   */
  private requireQuestionFormat = (
    eventId: string,
    itemId: string,
    stored: TMissionStoredQuestion,
    next: TMissionStoredQuestion,
    minVersion: 1 | 2,
  ): void => {
    if (minVersion < 2 || next.formatVersion === 2 || stored.formatVersion !== 2) return;
    const refusal = defect('formatVersion', 'absent (v1) on an item stored as formatVersion 2',
      'at least 2 (fleet config mission.question-format.min-version)');
    throw new MissionControlError(400, 'question-invalid', `1 question defect in 1 event: ${refusal.message}`, undefined,
      { defects: [{ eventId, itemId, ...refusal }] });
  };

  /**
   * The line row of a server NEEDS-DECISION event, in its transaction (story PM-2). Only an `nd-` item, and only for the
   * tab that owns it: the opener of an open, the tab of the item's lines (or its opener) for a revision.
   */
  private writeNeedsDecisionLine = (
    workspaceId: string, itemId: string, revision: number, line: IMissionNeedsDecisionLineInput, owner: string | null, now: number,
  ): void => {
    if (!needsDecisionLinePrefix(itemId)) invalidMissionRequest(`a NEEDS-DECISION line record needs an nd- item, not ${itemId}`);
    if (owner !== line.tabId) invalidMissionRequest(`the NEEDS-DECISION line of ${line.tabId} cannot be recorded on ${itemId}: that item is not its own`);
    // An event row replaces a revision-0 row of the same key (a reservation or a race record), so the row the item opens
    // with carries the event line's `marked_new` (review r2 nit). A row of an earlier event (revision 1 or later) stays.
    this.database.prepare(`INSERT INTO mission_nd_lines (item_id,line_key,text_key,workspace_id,tab_id,revision,marked_new,at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT (item_id, line_key) DO UPDATE SET text_key = excluded.text_key, tab_id = excluded.tab_id,
        revision = excluded.revision, marked_new = excluded.marked_new, at = excluded.at
      WHERE mission_nd_lines.revision = 0`).run(itemId, line.lineKey, line.textKey, workspaceId, line.tabId, revision, Number(line.markedNew), now);
  };

  /** The tab an `nd-` item belongs to: the tab of its line rows, else its opener; null when neither is recorded. */
  private needsDecisionTabOf = (itemId: string): string | null =>
    (this.database.prepare('SELECT tab_id FROM mission_nd_lines WHERE item_id = ? ORDER BY revision DESC LIMIT 1').pluck().get(itemId) as string | undefined)
      ?? (this.database.prepare('SELECT tab_id FROM mission_item_openers WHERE item_id = ?').pluck().get(itemId) as string | undefined)
      ?? null;

  private stampHumanReview = (
    event: Extract<TMissionProducerEvent, { type: 'attention.opened' | 'attention.updated' }>,
    run: IMissionRun,
    authority: IMissionEventAuthority,
    reviewedAt: number,
  ): TMissionHumanReview => {
    const review = event.payload.humanReview;
    if (!review) throw new Error('human review is required');
    if (!authority.configuredOrchestratorTabId
      || review.reviewerTabId !== authority.configuredOrchestratorTabId) {
      missionConflict('human review requires the configured orchestrator');
    }
    const binding = run.binding;
    if (!binding) {
      throw new MissionControlError(409, 'conflict', 'human review requires a bound run', run);
    }
    if (binding.tabId !== authority.configuredOrchestratorTabId) {
      missionConflict('human review requires a run bound to the configured orchestrator', run);
    }
    const identity = authority.resolvedIdentity;
    if (!identity
      || identity.tabId !== binding.tabId
      || identity.providerId !== binding.providerId
      || identity.sessionId !== binding.sessionId
      || identity.runtimeGeneration !== binding.runtimeGeneration) {
      missionConflict('human review requires the current orchestrator session binding', run);
    }
    return { ...review, binding, eventId: event.eventId, reviewedAt };
  };

  private attentionEventPayload = (
    payload: Extract<TMissionProducerEvent, { type: 'attention.opened' | 'attention.updated' }>['payload'],
    state: IMissionAttentionItem['state'],
    candidateReason: TMissionCandidateReason | null,
    humanReview: TMissionHumanReview | null,
  ): Record<string, unknown> => this.eventPayloadWithRouting(payload, state, candidateReason, humanReview);

  private eventPayloadWithRouting = (
    payload: object,
    state: IMissionAttentionItem['state'],
    candidateReason: TMissionCandidateReason | null,
    humanReview: TMissionHumanReview | null,
  ): Record<string, unknown> => ({
    ...payload,
    routing: {
      state,
      candidateReason,
      review: humanReview ? {
        binding: humanReview.binding,
        eventId: humanReview.eventId,
        reviewedAt: humanReview.reviewedAt,
      } : null,
    },
  });

  private requireBindingGeneration = (event: TMissionProducerEvent, run: IMissionRun): void => {
    if (!run.binding || event.bindingGeneration !== run.binding.generation) missionConflict('stale or unbound orchestrator generation', run);
  };

  private requireRunRevisionAndGeneration = (event: TMissionProducerEvent, run: IMissionRun): void => {
    if (event.expectedRevision !== run.revision) missionConflict('stale run revision', run);
    this.requireBindingGeneration(event, run);
  };

  submitAnswer = (
    itemId: string,
    request: IMissionAnswerRequest,
    actor: string,
  ): IMissionAnswerResponse => this.answerTransaction(() => {
    // ADR-0031 §8: only the rule's tick answers as a system actor; a session subject never does.
    if (actor.startsWith('system:')) throw new MissionControlError(403, 'forbidden', 'a system actor cannot submit a human answer');
    const requestHash = answerHash(itemId, request);
    const existing = this.database.prepare('SELECT * FROM answers WHERE submission_id=?').get(request.submissionId) as IAnswerRow | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) missionConflict(`submission ${request.submissionId} was already used with different content`);
      return this.answerResponse(existing, true);
    }
    const row = this.itemRow(itemId);
    if (!row) throw new MissionControlError(404, 'not-found', `attention item ${itemId} not found`);
    const item = this.item(row);
    if (item.state !== 'open') missionConflict('attention item is no longer open', item);
    if (!item.humanReview || item.humanReview.humanNeed === 'none') {
      missionConflict('attention item is not eligible for a human answer', item);
    }
    this.requireAnswerableRevision(item, request.expectedRevision);
    const refusal = answerRefusal(item, request);
    if (refusal) invalidMissionRequest(refusal);
    const answerId = this.recordAnswer(item, request, requestHash, actor, Date.now(), {});
    return this.answerResponse(this.database.prepare('SELECT * FROM answers WHERE id=?').get(answerId) as IAnswerRow, false);
  });

  /**
   * The bookkeeping rule's answer (ADR-0031 §6): the stated default, as `system:auto-answer`, at the
   * revision the tick read. The deterministic submission ID makes a repeat a replay, and the revision
   * check lets a human answer or a cancel that came first win. Only the tick calls this.
   */
  submitSystemAnswer = (
    itemId: string,
    expectedRevision: number,
    rule: IAutoAnswerRule,
    now = Date.now(),
  ): IMissionAnswerResponse => this.answerTransaction(() => {
    const submissionId = autoAnswerSubmissionId(itemId, expectedRevision);
    const existing = this.database.prepare('SELECT * FROM answers WHERE submission_id=?').get(submissionId) as IAnswerRow | undefined;
    if (existing) {
      if (existing.actor !== MISSION_AUTO_ANSWER_ACTOR || existing.item_id !== itemId) {
        missionConflict(`submission ${submissionId} was already used by another answer`);
      }
      return this.answerResponse(existing, true);
    }
    const row = this.itemRow(itemId);
    if (!row) throw new MissionControlError(404, 'not-found', `attention item ${itemId} not found`);
    const item = this.item(row);
    if (item.state === 'open' && item.revision !== expectedRevision) missionConflict('stale attention revision', item);
    const refusal = autoAnswerRefusal(item, rule, now);
    if (refusal) missionConflict(refusal, item);
    const optionId = item.defaultOptionId as string;
    const optionLabel = item.options.find((option) => option.id === optionId)?.label as string;
    const note = autoAnswerNote(rule, now, optionLabel);
    const request: IMissionAnswerRequest = { submissionId, expectedRevision, optionIds: [optionId], text: note, actionCompleted: false };
    const answerId = this.recordAnswer(item, request, answerHash(itemId, request), MISSION_AUTO_ANSWER_ACTOR, now,
      { actor: MISSION_AUTO_ANSWER_ACTOR });
    this.database.prepare(`INSERT INTO mission_auto_answers
      (answer_id,item_id,workspace_id,rule,rule_version,applied_option_id,at,note) VALUES (?,?,?,?,?,?,?,?)`)
      .run(answerId, item.id, item.workspaceId, AUTO_ANSWER_KEY, rule.version, optionId, now, note);
    return this.answerResponse(this.database.prepare('SELECT * FROM answers WHERE id=?').get(answerId) as IAnswerRow, false);
  });

  /**
   * ADR-0037 §4: an answer made on revision r still applies to the current revision r' when every
   * revision between them was compatible; otherwise 409 with what changed.
   */
  private requireAnswerableRevision = (item: IMissionAttentionItem, expectedRevision: number): void => {
    if (expectedRevision === item.revision) return;
    if (expectedRevision > item.revision) missionConflict('stale attention revision', item);
    const records = new Map((this.database.prepare(`SELECT * FROM mission_item_changes
      WHERE item_id = ? AND revision > ? AND revision <= ? ORDER BY revision`)
      .all(item.id, expectedRevision, item.revision) as IChangesRow[])
      .map((row) => [row.revision, JSON.parse(row.changes_json) as IMissionQuestionChanges]));
    const changes = mergeMissionChanges(expectedRevision, item.revision, records);
    if (!changes.compatible) {
      missionConflict(`the question changed incompatibly since revision ${expectedRevision}; answer revision ${item.revision}`, item, { changes });
    }
  };

  private answerTransaction = (work: () => IMissionAnswerResponse): IMissionAnswerResponse => {
    try {
      return this.database.transaction(work)();
    } catch (error) {
      if (isMissionControlError(error)) throw error;
      if (isSqliteFailure(error)) throw new MissionControlError(503, 'storage-unavailable', 'Mission Control storage unavailable');
      throw error;
    }
  };

  /** Answer, item, delivery and `answer.recorded` event of one checked answer; inside the caller's transaction. */
  private recordAnswer = (
    item: IMissionAttentionItem,
    request: IMissionAnswerRequest,
    requestHash: string,
    actor: string,
    now: number,
    eventDetail: Record<string, unknown>,
  ): string => {
    const answerId = randomUUID();
    const deliveryId = randomUUID();
    this.database.prepare(`INSERT INTO answers
      (id,submission_id,request_hash,workspace_id,run_id,item_id,actor,request_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(answerId, request.submissionId, requestHash, item.workspaceId, item.runId, item.id, actor,
        toJson({ ...request, appliedRevision: item.revision }), now);
    const revision = item.revision + 1;
    this.database.prepare(`UPDATE attention_items SET revision=?, state='answered', answer_id=?, updated_at=? WHERE id=?`)
      .run(revision, answerId, now, item.id);
    const run = this.runRow(item.runId);
    if (!run) throw new MissionControlError(404, 'not-found', `run ${item.runId} not found`);
    const binding = parseJson<IMissionBinding>(run.binding_json);
    this.database.prepare(`INSERT INTO deliveries
      (id,answer_id,workspace_id,run_id,binding_json,state,attempts,next_attempt_at,last_error,submitted_at,acknowledged_at,updated_at)
      VALUES (?,?,?,?,?,'queued',0,?,NULL,NULL,NULL,?)`)
      .run(deliveryId, answerId, item.workspaceId, item.runId, binding ? toJson(binding) : null, now, now);
    this.database.prepare(`INSERT INTO events
      (id,request_hash,schema_version,workspace_id,run_id,entity_id,revision,type,payload_json,producer_at,committed_at)
      VALUES (?,?,1,?,?,?,?, 'answer.recorded',?,?,?)`)
      .run(`answer:${request.submissionId}`, requestHash, item.workspaceId, item.runId, item.id, revision,
        toJson({ answerId, submissionId: request.submissionId, expectedRevision: request.expectedRevision,
          appliedRevision: item.revision, ...eventDetail }), now, now);
    return answerId;
  };

  private answerResponse = (answerRow: IAnswerRow, replayed: boolean): IMissionAnswerResponse => {
    const item = this.itemRow(answerRow.item_id);
    const delivery = this.database.prepare('SELECT * FROM deliveries WHERE answer_id=?').get(answerRow.id) as IDeliveryRow | undefined;
    if (!item || !delivery) throw new Error('stored answer is incomplete');
    const cursor = Number((this.database.prepare('SELECT COALESCE(MAX(seq), 0) AS cursor FROM events').get() as { cursor: number }).cursor);
    return { answer: answerFromRow(answerRow), item: this.item(item), delivery: deliveryFromRow(delivery), cursor, replayed };
  };

  listDueDeliveries = (now: number, limit: number): IMissionDelivery[] =>
    (this.database.prepare(`SELECT * FROM deliveries WHERE state='queued' AND next_attempt_at IS NOT NULL AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT ?`)
      .all(now, limit) as IDeliveryRow[]).map(deliveryFromRow);

  claimDelivery = (id: string, expectedUpdatedAt: number): IMissionDelivery | null => {
    const now = Date.now();
    const result = this.database.prepare(`UPDATE deliveries SET state='dispatching', attempts=attempts+1,
      updated_at=MAX(?,updated_at+1)
      WHERE id=? AND updated_at=? AND state='queued' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?
      AND EXISTS (SELECT 1 FROM attention_items item JOIN runs run ON run.id=item.run_id
        WHERE item.answer_id=deliveries.answer_id AND item.state='answered'
          AND run.id=deliveries.run_id AND run.binding_json=deliveries.binding_json)`)
      .run(now, id, expectedUpdatedAt, now);
    if (!result.changes) return null;
    return deliveryFromRow(this.database.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as IDeliveryRow);
  };

  /**
   * Story 12 (consult ruling A′): claim a delivery whose notice waits in the inbox — `queued`, no
   * `next_attempt_at`, marked `inbox:<itemId>` — for the paste the inbox is about to make. Same
   * answered-and-bound guard as `claimDelivery`.
   */
  claimInboxDelivery = (id: string, marker: string): IMissionDelivery | null => {
    const now = Date.now();
    const result = this.database.prepare(`UPDATE deliveries SET state='dispatching', attempts=attempts+1,
      updated_at=MAX(?,updated_at+1)
      WHERE id=? AND state='queued' AND next_attempt_at IS NULL AND last_error=?
      AND EXISTS (SELECT 1 FROM attention_items item JOIN runs run ON run.id=item.run_id
        WHERE item.answer_id=deliveries.answer_id AND item.state='answered'
          AND run.id=deliveries.run_id AND run.binding_json=deliveries.binding_json)`)
      .run(now, id, marker);
    if (!result.changes) return null;
    return deliveryFromRow(this.database.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as IDeliveryRow);
  };

  /** Story 12: every row handed to the inbox — waiting (`queued`, marked `inbox:…`) or in a paste (`dispatching`). */
  listInboxHandoffs = (): { deliveries: IMissionDelivery[]; bootstrapEntries: IMissionBootstrapQueueEntry[] } => ({
    deliveries: (this.database.prepare(`SELECT * FROM deliveries
      WHERE state='dispatching' OR (state='queued' AND next_attempt_at IS NULL AND last_error LIKE 'inbox:%')`)
      .all() as IDeliveryRow[]).map(deliveryFromRow),
    bootstrapEntries: (this.database.prepare(`SELECT * FROM bootstrap_entries
      WHERE state='dispatching' OR (state='queued' AND reason LIKE 'inbox:%')`)
      .all() as IBootstrapEntryRow[])
      .map((row) => ({ bootstrapId: row.bootstrap_id, entry: bootstrapEntryFromRow(row), attempts: row.attempts, nextAttemptAt: row.next_attempt_at })),
  });

  private deliveryEligibility = (
    id: string,
    expectedUpdatedAt: number,
    expectedRunBinding: IMissionBinding,
  ): TMissionDeliveryValidation => {
    const deliveryRow = this.database.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as IDeliveryRow | undefined;
    if (!deliveryRow) return { ok: false, reason: 'delivery-missing' };
    if (deliveryRow.state !== 'dispatching') return { ok: false, reason: 'delivery-not-dispatching' };
    if (deliveryRow.updated_at !== expectedUpdatedAt) return { ok: false, reason: 'delivery-version-changed' };
    if (!bindingsEqual(parseJson<IMissionBinding>(deliveryRow.binding_json), expectedRunBinding)) {
      return { ok: false, reason: 'delivery-binding-changed' };
    }
    const item = this.database.prepare(`SELECT item.* FROM attention_items item
      JOIN answers answer ON answer.item_id=item.id
      WHERE answer.id=?`).get(deliveryRow.answer_id) as IItemRow | undefined;
    if (!item) return { ok: false, reason: 'answer-records-incomplete' };
    if (item.state !== 'answered' || item.answer_id !== deliveryRow.answer_id) {
      return { ok: false, reason: 'attention-no-longer-answered' };
    }
    const run = this.runRow(deliveryRow.run_id);
    if (!run || !bindingsEqual(parseJson<IMissionBinding>(run.binding_json), expectedRunBinding)) {
      return { ok: false, reason: 'run-binding-changed' };
    }
    return { ok: true };
  };

  validateDeliveryAttempt = (
    id: string,
    expectedUpdatedAt: number,
    expectedRunBinding: IMissionBinding,
  ): TMissionDeliveryValidation => this.database.transaction(() =>
    this.deliveryEligibility(id, expectedUpdatedAt, expectedRunBinding))();

  finalizeDeliveryAttempt = (
    id: string,
    expectedUpdatedAt: number,
    expectedRunBinding: IMissionBinding,
    outcome: IMissionDeliveryOutcome,
  ): IMissionDelivery | null => this.database.transaction(() => {
    if (!['queued', 'submitted', 'held', 'failed'].includes(outcome.state)) invalidMissionRequest('invalid delivery outcome');
    const eligibility = this.deliveryEligibility(id, expectedUpdatedAt, expectedRunBinding);
    const now = Date.now();
    if (!eligibility.ok) {
      const current = this.database.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as IDeliveryRow | undefined;
      if (!current) return null;
      if (outcome.state === 'submitted' && ['dispatching', 'held'].includes(current.state)) {
        this.database.prepare(`UPDATE deliveries SET state='held', next_attempt_at=NULL, last_error=?,
          updated_at=MAX(?,updated_at+1) WHERE id=? AND state IN ('dispatching','held')`)
          .run(`transport-uncertain:post-paste-eligibility-changed:${eligibility.reason}`, now, id);
      } else if (current.state === 'dispatching') {
        this.database.prepare(`UPDATE deliveries SET state='held', next_attempt_at=NULL, last_error=?,
          updated_at=MAX(?,updated_at+1) WHERE id=? AND state='dispatching'`)
          .run(outcome.lastError ?? `eligibility-changed:${eligibility.reason}`, now, id);
      }
      return deliveryFromRow(this.database.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as IDeliveryRow);
    }
    const result = this.database.prepare(`UPDATE deliveries SET state=?, next_attempt_at=?, last_error=?, submitted_at=?,
      updated_at=MAX(?,updated_at+1)
      WHERE id=? AND updated_at=? AND state='dispatching'`)
      .run(outcome.state, outcome.nextAttemptAt, outcome.lastError, outcome.submittedAt ?? null, now, id, expectedUpdatedAt);
    if (!result.changes) return null;
    return deliveryFromRow(this.database.prepare('SELECT * FROM deliveries WHERE id=?').get(id) as IDeliveryRow);
  })();

  recoverDispatching = (reason: string): number => this.database.transaction(() => {
    const now = Date.now();
    const deliveries = this.database.prepare(`UPDATE deliveries SET state='held', next_attempt_at=NULL, last_error=?, updated_at=? WHERE state='dispatching'`)
      .run(reason, now).changes;
    const bootstrap = this.database.prepare(`UPDATE bootstrap_entries SET state='held', next_attempt_at=NULL, reason=?, updated_at=? WHERE state='dispatching'`)
      .run(reason, now).changes;
    return Number(deliveries + bootstrap);
  })();

  reconcileDiscovery = (input: IMissionDiscoveryInput): IMissionBootstrap => {
    const transaction = this.database.transaction(() => {
      const hash = contentHash({ bootstrapId: input.bootstrapId, reconcile: input.reconcile });
      const prior = this.database.prepare('SELECT * FROM bootstrap WHERE id=?').get(input.bootstrapId) as IBootstrapRow | undefined;
      if (prior) {
        if (prior.input_hash !== hash) missionConflict(`bootstrap ${input.bootstrapId} was already used with different content`);
        return this.bootstrapById(input.bootstrapId);
      }
      const now = Date.now();
      const views: IMissionWorkspaceView[] = [];
      this.database.prepare('INSERT INTO bootstrap (id,input_hash,boundary_seq,created_at,workspace_views_json) VALUES (?,?,?,?,?)')
        .run(input.bootstrapId, hash, input.boundarySeq, now, '[]');
      for (const observed of input.workspaces) {
        let run: IMissionRun | null = null;
        const observedIdentities = normalizeIdentities(observed.identities);
        const activeRow = this.database.prepare(`SELECT * FROM runs WHERE workspace_id=? AND state IN ('running','waiting')
          ORDER BY revision DESC,updated_at DESC,created_at DESC,id DESC LIMIT 1`).get(observed.workspaceId) as IRunRow | undefined;
        const newerTerminal = this.database.prepare(`SELECT 1 FROM events
          WHERE workspace_id=? AND seq>? AND type='run.finished' LIMIT 1`)
          .get(observed.workspaceId, input.boundarySeq);
        if (observed.run) {
          const existingBySource = this.database.prepare(`SELECT * FROM runs WHERE workspace_id=? AND source_key=?
            ORDER BY updated_at DESC LIMIT 1`).get(observed.workspaceId, observed.run.sourceKey) as IRunRow | undefined;
          if (activeRow) {
            const accumulated = unionIdentities(
              parseJson<TMissionDiscoveryIdentity[]>(activeRow.observed_identities_json) ?? [],
              observedIdentities,
            );
            this.database.prepare('UPDATE runs SET observed_identities_json=? WHERE id=?')
              .run(toJson(accumulated), activeRow.id);
            run = runFromRow({ ...activeRow, observed_identities_json: toJson(accumulated) });
          } else {
            const historicalRows = this.database.prepare('SELECT observed_identities_json FROM runs WHERE workspace_id=?')
              .all(observed.workspaceId) as Array<Pick<IRunRow, 'observed_identities_json'>>;
            const historicalIdentities = unionIdentities(...historicalRows.map((row) =>
              parseJson<TMissionDiscoveryIdentity[]>(row.observed_identities_json) ?? []));
            const hasTerminalHistory = !!this.database.prepare(`SELECT 1 FROM runs
              WHERE workspace_id=? AND state IN ('completed','cancelled') LIMIT 1`).get(observed.workspaceId);
            const historicalKeys = new Set(historicalIdentities.map(identityKey));
            const hasNewIdentity = observedIdentities.some((identity) => !historicalKeys.has(identityKey(identity)));
            const exactTerminalReplay = !!existingBySource
              && ['completed', 'cancelled'].includes(existingBySource.state);
            const substantiveStandup = observed.run.evidence.source === 'standup';
            const shouldCreate = !newerTerminal
              && !exactTerminalReplay
              && ((substantiveStandup && !hasTerminalHistory)
                || (observedIdentities.length > 0 && hasNewIdentity));
            if (shouldCreate) {
            const runId = deterministicId('run', observed.run.sourceKey);
            this.database.prepare(`INSERT INTO runs
              (id,workspace_id,revision,objective,epic_json,phase,state,next_step,binding_json,evidence_json,closeout_pending,story_counts_json,last_progress_at,created_at,updated_at,source_key,observed_identities_json)
              VALUES (?,?,0,?,NULL,?,?,?,?,?,0,NULL,?,?,?,?,?)`)
              .run(runId, observed.workspaceId, observed.run.objective, observed.run.phase, observed.run.state,
                observed.run.nextStep, null, toJson(observed.run.evidence),
                observed.run.lastProgressAt, now, now, observed.run.sourceKey, toJson(observedIdentities));
            run = runFromRow(this.runRow(runId) as IRunRow);
            }
          }
        } else if (activeRow && observed.candidates.length) {
          const accumulated = unionIdentities(
            parseJson<TMissionDiscoveryIdentity[]>(activeRow.observed_identities_json) ?? [],
            observedIdentities,
          );
          this.database.prepare('UPDATE runs SET observed_identities_json=? WHERE id=?')
            .run(toJson(accumulated), activeRow.id);
          run = runFromRow(activeRow);
        }
        if (run && ['running', 'waiting'].includes(run.state)) {
          for (const candidate of observed.candidates) {
            const duplicate = this.database.prepare('SELECT id FROM attention_items WHERE source_key=?').get(candidate.sourceKey);
            if (duplicate) continue;
            const itemId = deterministicId('item', candidate.sourceKey);
            this.database.prepare(`INSERT INTO attention_items
              (id,workspace_id,run_id,revision,state,question_json,evidence_json,answer_id,resolution,created_at,updated_at,source_key,human_review_json,candidate_reason)
              VALUES (?,?,?,0,'candidate',?,?,NULL,NULL,?,?,?,NULL,'historical-context')`)
              .run(itemId, observed.workspaceId, run.id, toJson(candidate.question), toJson(candidate.evidence), now, now, candidate.sourceKey);
          }
          const provisional = run.revision === 0 && run.binding === null && run.evidence.confidence !== 'confirmed';
          if (input.reconcile && provisional) {
            const previousRequest = observed.reconciliation
              ? this.database.prepare(`SELECT state FROM bootstrap_entries WHERE workspace_id=? AND source_key=? LIMIT 1`)
                .get(observed.workspaceId, observed.reconciliation.sourceKey)
              : undefined;
            const eligible = !!observed.reconciliation && !previousRequest;
            this.database.prepare(`INSERT INTO bootstrap_entries
              (bootstrap_id,workspace_id,run_id,binding_json,state,reason,source_key,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
              .run(input.bootstrapId, observed.workspaceId, run.id, observed.reconciliation ? toJson(observed.reconciliation.binding) : null,
                eligible ? 'queued' : 'provisional', eligible ? null : previousRequest ? 'reconciliation already recorded' : 'no live orchestrator binding',
                observed.reconciliation?.sourceKey ?? null, now);
          }
        }
        const workspaceRunIds = (this.database.prepare('SELECT id FROM runs WHERE workspace_id=?').all(observed.workspaceId) as Array<{ id: string }>).map((entry) => entry.id);
        const counts = this.database.prepare(`SELECT
          SUM(CASE WHEN item.state='open' AND item.human_review_json IS NOT NULL
            AND json_extract(item.human_review_json,'$.humanNeed') IN ('decision','approval','information','external-action')
            THEN 1 ELSE 0 END) AS open_items,
          SUM(CASE WHEN item.state='answered' AND EXISTS (
            SELECT 1 FROM deliveries delivery WHERE delivery.answer_id=item.answer_id AND delivery.state<>'acknowledged'
          ) THEN 1 ELSE 0 END) AS awaiting
          FROM attention_items item WHERE item.workspace_id=?`).get(observed.workspaceId) as { open_items: number | null; awaiting: number | null };
        views.push({
          workspaceId: observed.workspaceId,
          name: observed.name,
          orphaned: false,
          activity: observed.activity,
          agents: observed.agents,
          runIds: workspaceRunIds,
          openItems: Number(counts.open_items ?? 0),
          awaitingAcknowledgement: Number(counts.awaiting ?? 0),
          lastActivityAt: observed.lastActivityAt,
          lastProgressAt: observed.lastProgressAt,
          stale: observed.stale,
          evidence: observed.evidence,
        });
      }
      this.database.prepare('UPDATE bootstrap SET workspace_views_json=? WHERE id=?').run(toJson(views), input.bootstrapId);
      return this.bootstrapById(input.bootstrapId);
    });
    try {
      return transaction();
    } catch (error) {
      if (isMissionControlError(error)) throw error;
      if (isSqliteFailure(error)) throw new MissionControlError(503, 'storage-unavailable', 'Mission Control storage unavailable');
      throw error;
    }
  };

  private bootstrapById = (bootstrapId: string): IMissionBootstrap => {
    const row = this.database.prepare('SELECT * FROM bootstrap WHERE id=?').get(bootstrapId) as IBootstrapRow | undefined;
    if (!row) throw new MissionControlError(404, 'not-found', `bootstrap ${bootstrapId} not found`);
    const entries = (this.database.prepare('SELECT * FROM bootstrap_entries WHERE bootstrap_id=? ORDER BY workspace_id,run_id').all(bootstrapId) as IBootstrapEntryRow[]).map(bootstrapEntryFromRow);
    return { id: row.id, boundarySeq: row.boundary_seq, createdAt: row.created_at, entries };
  };

  listQueuedBootstrapEntries = (limit: number): IMissionBootstrapQueueEntry[] => {
    const now = Date.now();
    // An entry waiting in the inbox (reason `inbox:…`, story 12) is not due: the inbox owns it.
    return (this.database.prepare(`SELECT * FROM bootstrap_entries WHERE state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      AND (reason IS NULL OR reason NOT LIKE 'inbox:%') ORDER BY COALESCE(next_attempt_at,updated_at) LIMIT ?`).all(now, limit) as IBootstrapEntryRow[])
      .map((row) => ({ bootstrapId: row.bootstrap_id, entry: bootstrapEntryFromRow(row), attempts: row.attempts, nextAttemptAt: row.next_attempt_at }));
  };

  claimBootstrapEntry = (
    bootstrapId: string,
    workspaceId: string,
    runId: string,
    expectedUpdatedAt: number,
  ): IMissionBootstrapQueueEntry | null => {
    const now = Date.now();
    const result = this.database.prepare(`UPDATE bootstrap_entries SET state='dispatching', attempts=attempts+1,
      updated_at=MAX(?,updated_at+1)
      WHERE bootstrap_id=? AND workspace_id=? AND run_id=? AND updated_at=? AND state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
      .run(now, bootstrapId, workspaceId, runId, expectedUpdatedAt, now);
    if (!result.changes) return null;
    const row = this.database.prepare(`SELECT * FROM bootstrap_entries WHERE bootstrap_id=? AND workspace_id=? AND run_id=?`)
      .get(bootstrapId, workspaceId, runId) as IBootstrapEntryRow;
    return { bootstrapId, entry: bootstrapEntryFromRow(row), attempts: row.attempts, nextAttemptAt: row.next_attempt_at };
  };

  validateBootstrapAttempt = (
    bootstrapId: string,
    workspaceId: string,
    runId: string,
    expectedUpdatedAt: number,
  ): TMissionDeliveryValidation => this.database.transaction((): TMissionDeliveryValidation => {
    const row = this.database.prepare(`SELECT * FROM bootstrap_entries
      WHERE bootstrap_id=? AND workspace_id=? AND run_id=?`)
      .get(bootstrapId, workspaceId, runId) as IBootstrapEntryRow | undefined;
    if (!row) return { ok: false, reason: 'bootstrap-entry-missing' };
    if (row.state !== 'dispatching') return { ok: false, reason: 'bootstrap-entry-not-dispatching' };
    if (row.updated_at !== expectedUpdatedAt) return { ok: false, reason: 'bootstrap-entry-version-changed' };
    if (!row.binding_json) return { ok: false, reason: 'bootstrap-target-binding-missing' };
    const run = this.runRow(runId);
    if (!run || run.workspace_id !== workspaceId) return { ok: false, reason: 'bootstrap-run-missing' };
    const evidence = parseJson<IMissionEvidence>(run.evidence_json);
    if (run.revision !== 0 || run.binding_json !== null || evidence?.confidence === 'confirmed'
      || !['running', 'waiting'].includes(run.state)) {
      return { ok: false, reason: 'bootstrap-run-no-longer-provisional' };
    }
    const current = this.database.prepare(`SELECT id FROM runs WHERE workspace_id=? AND state IN ('running','waiting')
      ORDER BY revision DESC,updated_at DESC,created_at DESC,id DESC LIMIT 1`)
      .get(workspaceId) as { id: string } | undefined;
    if (current?.id !== runId) return { ok: false, reason: 'bootstrap-run-not-current' };
    return { ok: true };
  })();

  completeBootstrapAttempt = (
    bootstrapId: string,
    workspaceId: string,
    runId: string,
    expectedUpdatedAt: number,
    outcome: { state: 'queued' | 'submitted' | 'held'; reason: string | null; nextAttemptAt?: number | null },
  ): IMissionBootstrapEntry | null => {
    const now = Date.now();
    const result = this.database.prepare(`UPDATE bootstrap_entries SET state=?, reason=?, next_attempt_at=?,
      updated_at=MAX(?,updated_at+1)
      WHERE bootstrap_id=? AND workspace_id=? AND run_id=? AND updated_at=? AND state='dispatching'`)
      .run(outcome.state, outcome.reason, outcome.nextAttemptAt ?? null, now, bootstrapId, workspaceId, runId, expectedUpdatedAt);
    if (!result.changes) return null;
    return bootstrapEntryFromRow(this.database.prepare(`SELECT * FROM bootstrap_entries WHERE bootstrap_id=? AND workspace_id=? AND run_id=?`)
      .get(bootstrapId, workspaceId, runId) as IBootstrapEntryRow);
  };
}

const globalStore = globalThis as unknown as { __ptMissionControlStore?: MissionControlStore };

export const getMissionControlStore = (): MissionControlStore => {
  globalStore.__ptMissionControlStore ??= new MissionControlStore();
  return globalStore.__ptMissionControlStore;
};
const boundToIdentity = (binding: IMissionBinding, identity: TMissionIdentity): boolean =>
  binding.tabId === identity.tabId
  && binding.providerId === identity.providerId
  && binding.sessionId === identity.sessionId
  && binding.runtimeGeneration === identity.runtimeGeneration;
const bindingsEqual = (left: IMissionBinding | null, right: IMissionBinding | null): boolean =>
  left !== null
  && right !== null
  && boundToIdentity(left, right)
  && left.generation === right.generation;
