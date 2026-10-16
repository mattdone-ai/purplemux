import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import type {
  IMissionAnswer,
  IMissionAnswerRequest,
  IMissionAnswerResponse,
  IMissionAttentionItem,
  IMissionBinding,
  IMissionBootstrap,
  IMissionBootstrapEntry,
  IMissionDelivery,
  IMissionEvent,
  IMissionEventsResponse,
  IMissionEvidence,
  IMissionHumanInboxPolicy,
  IMissionQuestion,
  IMissionRun,
  IMissionRunReboundPayload,
  IMissionSnapshot,
  IMissionWorkspaceView,
  TMissionProducerEvent,
  TMissionCandidateReason,
  TMissionHumanReview,
  TMissionRebindCause,
} from '@/types/mission-control';
import {
  isMissionControlError,
  MissionControlError,
  invalidMissionRequest,
  missionConflict,
} from '@/lib/mission-control-errors';

const DEFAULT_DB_PATH = path.join(os.homedir(), '.purplemux', 'mission-control.sqlite');
const SCHEMA_VERSION = 4;
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

const itemFromRow = (row: IItemRow): IMissionAttentionItem => ({
  id: row.id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  revision: row.revision,
  state: row.state,
  ...(JSON.parse(row.question_json) as IMissionQuestion),
  evidence: JSON.parse(row.evidence_json) as IMissionEvidence,
  answerId: row.answer_id,
  resolution: row.resolution,
  humanReview: parseJson<TMissionHumanReview>(row.human_review_json),
  candidateReason: row.candidate_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const answerFromRow = (row: IAnswerRow): IMissionAnswer => ({
  id: row.id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  itemId: row.item_id,
  actor: row.actor,
  ...(JSON.parse(row.request_json) as IMissionAnswerRequest),
  createdAt: row.created_at,
});

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
  }

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
      const items = (this.database.prepare(`SELECT * FROM attention_items${where} ORDER BY updated_at DESC`).all(...args) as IItemRow[]).map(itemFromRow);
      const answers = (this.database.prepare(`SELECT * FROM answers${where} ORDER BY created_at DESC`).all(...args) as IAnswerRow[]).map(answerFromRow);
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
        generatedAt: Date.now(),
        workspaces: merged,
        runs,
        items,
        answers,
        deliveries,
        recentEvents,
        bootstrap,
        pendingBootstrapEntries,
      };
    });
    return read();
  };

  eventsAfter = (after: number, limit: number, workspaceId?: string): IMissionEventsResponse => {
    const where = workspaceId ? 'seq > ? AND workspace_id = ?' : 'seq > ?';
    const args = workspaceId ? [after, workspaceId, limit + 1] : [after, limit + 1];
    const rows = this.database.prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq LIMIT ?`).all(...args) as IEventRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(eventFromRow);
    return { schemaVersion: 1, events, cursor: events.at(-1)?.seq ?? after, hasMore };
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
        committed.push(this.applyOneEvent(event, requestHash, authority));
      }
      const cursor = Number((this.database.prepare('SELECT COALESCE(MAX(seq), 0) AS cursor FROM events').get() as { cursor: number }).cursor);
      return { events: committed, cursor, replayed: allReplayed };
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
      if (itemRow) missionConflict('attention item already exists', itemFromRow(itemRow));
      const { itemId: ignored, humanReview: reviewInput, ...question } = event.payload;
      void ignored;
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
      this.confirmBootstrap(run.id, now);
      return this.insertEvent(event, itemId, 1, now, requestHash,
        this.attentionEventPayload(event.payload, state, candidateReason, humanReview));
    }

    if (!itemRow) throw new MissionControlError(404, 'not-found', `attention item ${itemId} not found`);
    if (itemRow.workspace_id !== event.workspaceId || itemRow.run_id !== event.runId) missionConflict('attention item is outside this run');
    const item = itemFromRow(itemRow);
    if (event.expectedRevision !== item.revision) missionConflict('stale attention revision', item);

    if (event.type === 'attention.updated') {
      if (!['open', 'candidate'].includes(item.state)) missionConflict('only open or candidate items can be updated', item);
      const { itemId: ignored, humanReview: reviewInput, ...question } = event.payload;
      void ignored;
      const changed = contentHash(question) !== contentHash(this.questionFromItem(item));
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
      this.database.prepare(`UPDATE attention_items SET revision=?, state=?, question_json=?, evidence_json=?,
        human_review_json=?, candidate_reason=?, updated_at=? WHERE id=?`)
        .run(revision, state, toJson(question), toJson({ source: 'agent', sourceId: event.eventId, observedAt: event.producerAt, confidence: 'confirmed' }),
          humanReview ? toJson(humanReview) : null, candidateReason, now, item.id);
      this.confirmBootstrap(run.id, now);
      return this.insertEvent(event, item.id, revision, now, requestHash,
        this.attentionEventPayload(event.payload, state, candidateReason, humanReview));
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

  private questionFromItem = (item: IMissionAttentionItem): IMissionQuestion => ({
    kind: item.kind,
    title: item.title,
    context: item.context,
    storyIds: item.storyIds,
    options: item.options,
    recommendation: item.recommendation,
    blockingScope: item.blockingScope,
    canContinue: item.canContinue,
  });

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
  ): IMissionAnswerResponse => {
    const transaction = this.database.transaction(() => {
      const requestHash = contentHash({ itemId, request });
      const existing = this.database.prepare('SELECT * FROM answers WHERE submission_id=?').get(request.submissionId) as IAnswerRow | undefined;
      if (existing) {
        if (existing.request_hash !== requestHash) missionConflict(`submission ${request.submissionId} was already used with different content`);
        return this.answerResponse(existing, true);
      }
      const row = this.itemRow(itemId);
      if (!row) throw new MissionControlError(404, 'not-found', `attention item ${itemId} not found`);
      const item = itemFromRow(row);
      if (item.state !== 'open') missionConflict('attention item is no longer open', item);
      if (!item.humanReview || item.humanReview.humanNeed === 'none') {
        missionConflict('attention item is not eligible for a human answer', item);
      }
      if (item.revision !== request.expectedRevision) missionConflict('stale attention revision', item);
      const allowedOptions = new Set(item.options.map((option) => option.id));
      if (request.optionIds.some((optionId) => !allowedOptions.has(optionId))) invalidMissionRequest('answer selected an unknown option');
      if (item.kind === 'action' && request.optionIds.length) invalidMissionRequest('action answers cannot select question options');

      const now = Date.now();
      const answerId = randomUUID();
      const deliveryId = randomUUID();
      this.database.prepare(`INSERT INTO answers
        (id,submission_id,request_hash,workspace_id,run_id,item_id,actor,request_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(answerId, request.submissionId, requestHash, item.workspaceId, item.runId, item.id, actor, toJson(request), now);
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
      const syntheticEvent: TMissionProducerEvent = {
        eventId: `answer:${request.submissionId}`,
        schemaVersion: 1,
        workspaceId: item.workspaceId,
        runId: item.runId,
        expectedRevision: item.revision,
        producerAt: now,
        bindingGeneration: binding?.generation ?? 0,
        type: 'attention.updated',
        payload: { itemId: item.id, kind: item.kind, title: item.title, context: item.context, storyIds: item.storyIds, options: item.options, recommendation: item.recommendation, blockingScope: item.blockingScope, canContinue: item.canContinue },
      };
      this.database.prepare(`INSERT INTO events
        (id,request_hash,schema_version,workspace_id,run_id,entity_id,revision,type,payload_json,producer_at,committed_at)
        VALUES (?,?,1,?,?,?,?, 'answer.recorded',?,?,?)`)
        .run(syntheticEvent.eventId, requestHash, item.workspaceId, item.runId, item.id, revision, toJson({ answerId, submissionId: request.submissionId }), now, now);
      return this.answerResponse(this.database.prepare('SELECT * FROM answers WHERE id=?').get(answerId) as IAnswerRow, false);
    });
    try {
      return transaction();
    } catch (error) {
      if (isMissionControlError(error)) throw error;
      if (isSqliteFailure(error)) throw new MissionControlError(503, 'storage-unavailable', 'Mission Control storage unavailable');
      throw error;
    }
  };

  private answerResponse = (answerRow: IAnswerRow, replayed: boolean): IMissionAnswerResponse => {
    const item = this.itemRow(answerRow.item_id);
    const delivery = this.database.prepare('SELECT * FROM deliveries WHERE answer_id=?').get(answerRow.id) as IDeliveryRow | undefined;
    if (!item || !delivery) throw new Error('stored answer is incomplete');
    const cursor = Number((this.database.prepare('SELECT COALESCE(MAX(seq), 0) AS cursor FROM events').get() as { cursor: number }).cursor);
    return { answer: answerFromRow(answerRow), item: itemFromRow(item), delivery: deliveryFromRow(delivery), cursor, replayed };
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
