import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { brandCodedError } from '@/lib/coded-error';
import { TabEventsTable } from '@/lib/tab-events-store';
import { TabTurnsTable } from '@/lib/tab-turns-store';
import { foldLedgerEvent, isLanding, parseAttrs, PHASE_REPLAY_LOOKBACK_MS, silentFor } from '@/lib/ledger-fold';
import type { ILedgerItemRow } from '@/lib/ledger-fold';
import {
  DAY_MS,
  LAND_QUEUE_HEAD_BLOCKED,
  LAND_QUEUE_LOCK_BUSY,
  LEDGER_RETENTION_DAYS,
  LEDGER_ROLLUP_RETENTION_DAYS,
  LEDGER_SERVER_PRODUCER,
  LEDGER_SILENT_MS,
  LEDGER_TAB_EVENTS_RETENTION_DAYS,
  UNKNOWN_REASON,
  clippedMs,
  percentile,
  stageOfReason,
} from '@/lib/ledger';
import type { IFinderLedgerInput, IFinderOwnerIssueSource } from '@/types/constraint';
import type {
  ILedgerAppendResult,
  ILedgerEventInput,
  ILedgerExperiment,
  ILedgerExperimentInput,
  ILedgerItem,
  ILedgerWaitRow,
  TLedgerExperimentVerdict,
  TLedgerIntervalReason,
  TLedgerItemType,
  TLedgerWaitsBy,
} from '@/types/ledger';

const SCHEMA_VERSION = 1;
const defaultDbPath = (): string => path.join(os.homedir(), '.purplemux', 'ledger.sqlite');
/** The producer name the server's own events carry. */
export const SERVER_PRODUCER = LEDGER_SERVER_PRODUCER;

export type TLedgerStoreErrorCode =
  | 'ledger-event-conflict'
  | 'ledger-experiment-cap'
  | 'ledger-experiment-closed'
  | 'ledger-experiment-extended'
  | 'ledger-experiment-not-found';

/**
 * A refusal the store decides from its own state. Branded, because the store singleton may be built
 * by server.ts's module graph while a route of the Next graph catches it (coded-error.ts).
 */
export class LedgerStoreError extends Error {
  readonly code: TLedgerStoreErrorCode;
  /** The batch field a refusal names (`events[3].event_id`), so a producer can set that one event aside. */
  readonly field: string | null;

  constructor(code: TLedgerStoreErrorCode, message: string, field: string | null = null) {
    super(message);
    this.code = code;
    this.field = field;
    brandCodedError(this, 'LedgerStoreError');
  }
}

type IItemRow = ILedgerItemRow;

/** One stored event as the phase replay folds it; attrs are not read. */
export type TLedgerReplayEvent = Omit<ILedgerEventInput, 'event_id' | 'attrs'> & { seq: number };

export interface ILedgerPhaseReplay {
  workspaceId: string;
  scanStart: number;
  seed: ILedgerItemRow[];
  events: TLedgerReplayEvent[];
  /** Items open at the scan start that have events inside the scan, as they stand now (the replay starts them at their first scanned event). */
  carried: ILedgerItemRow[];
  /** The earliest `opened_at` the workspace's items hold; null when the ledger holds none. */
  firstOpenedAt: number | null;
}

const CARRIED_CHUNK = 500;


interface IIntervalRow {
  item_key: string;
  item_type: TLedgerItemType;
  reason: TLedgerIntervalReason;
  holder: string | null;
  start: number;
  end: number;
}

interface IExperimentRow {
  workspace_id: string;
  id: string;
  item_key: string;
  hypothesis: string;
  change_ref: string | null;
  stage: ILedgerExperiment['stage'];
  reason: TLedgerIntervalReason | null;
  metric: string;
  baseline_json: string | null;
  target: number | null;
  guards_json: string;
  revert_if: string | null;
  min_days: number;
  max_days: number;
  started_at: number;
  verdict: TLedgerExperimentVerdict | null;
  verdict_at: number | null;
  evidence: string | null;
  extended_at: number | null;
  extension_days: number | null;
  extension_evidence: string | null;
}

export interface ILedgerItemQuery {
  open?: boolean;
  type?: TLedgerItemType;
  holder?: string;
  limit?: number;
}

export interface ILedgerWaitsQuery {
  since: number;
  until: number;
  by: TLedgerWaitsBy;
  type?: TLedgerItemType;
}

/** Open items of these types are work in progress for the pulse (consult 12, Q1). */
export const PULSE_WORK_ITEM_TYPES: readonly TLedgerItemType[] = ['range', 'slice', 'gate', 'review', 'landing', 'deploy'];

export interface ILedgerPulseSnapshot {
  /** `at` of each open, clear and close event on a work item type since the window start. */
  movement: number[];
  /** Any event on a work item type for the workspace since the window start. */
  eventSince: boolean;
  openWork: number;
  oldest: { itemKey: string; itemType: TLedgerItemType; waitReason: string | null; since: number } | null;
}

export interface ILedgerRetentionResult {
  events: number;
  intervals: number;
  landings: number;
  tabEvents: number;
  tabTurns: number;
  items: number;
  rollups: number;
  rolledUpDays: string[];
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The idempotency key: 12 bytes of SHA-256 over the workspace, the producer and its event_id, so one
 * producer's retransmit is a duplicate and two producers' equal ids are two events. A unique index on
 * it costs about a third of one on the text (story 01's synthetic load: the text index alone was
 * 112 MB of 611 MB). 96 bits: two of 1.4 million retained events collide with odds near 1e-17.
 */
const eventKey = (workspaceId: string, producer: string, eventId: string): Buffer =>
  createHash('sha256').update(workspaceId).update('\0').update(producer).update('\0').update(eventId).digest().subarray(0, 12);

const DIGEST_FIELDS = ['at', 'item_type', 'item_key', 'kind', 'state', 'wait_reason', 'holder', 'clear_input', 'parent_key'] as const;

/**
 * 8 bytes of the event's body, attrs keys sorted, so a retransmit with reordered attrs is still the
 * same event. It only tells a retransmit from a reused id under one key, so 64 bits are ample.
 */
const bodyDigest = (event: ILedgerEventInput): Buffer => {
  const attrs = event.attrs ? Object.keys(event.attrs).sort().map((key) => [key, event.attrs![key]]) : null;
  return createHash('sha256').update(JSON.stringify([...DIGEST_FIELDS.map((key) => event[key] ?? null), attrs]))
    .digest().subarray(0, 8);
};

/** Rows one retention statement deletes before the job yields to the event loop. */
export const RETENTION_CHUNK = 5_000;

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const itemFromRow = (row: IItemRow, now: number): ILedgerItem => {
  const silent = silentFor(row, now - row.last_event_at);
  return {
    workspaceId: row.workspace_id,
    itemKey: row.item_key,
    itemType: row.item_type,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    state: row.state,
    stateSince: row.state_since,
    waitReason: silent ? UNKNOWN_REASON : row.wait_reason,
    waitSince: silent ? row.last_event_at : row.wait_since,
    holder: row.holder,
    clearInput: row.clear_input,
    parentKey: row.parent_key,
    attrs: parseAttrs(row.attrs_json),
    lastEventAt: row.last_event_at,
    lastSeq: row.last_seq,
  };
};

const experimentFromRow = (row: IExperimentRow): ILedgerExperiment => ({
  workspaceId: row.workspace_id,
  id: row.id,
  itemKey: row.item_key,
  hypothesis: row.hypothesis,
  changeRef: row.change_ref,
  stage: row.stage,
  reason: row.reason,
  metric: row.metric,
  baseline: row.baseline_json ? JSON.parse(row.baseline_json) as ILedgerExperiment['baseline'] : null,
  target: row.target,
  guards: JSON.parse(row.guards_json) as ILedgerExperiment['guards'],
  revertIf: row.revert_if,
  minDays: row.min_days,
  maxDays: row.max_days,
  startedAt: row.started_at,
  verdict: row.verdict,
  verdictAt: row.verdict_at,
  evidence: row.evidence,
  extendedAt: row.extended_at,
  extensionDays: row.extension_days,
  extensionEvidence: row.extension_evidence,
});

/** The extend-once columns (story 22, ADR-HFL-03 decision 3 amended 2026-11-03), additive like `tab_events`' columns. */
const EXPERIMENT_ADDED_COLUMNS: ReadonlyArray<[string, string]> = [
  ['extended_at', 'INTEGER'], ['extension_days', 'INTEGER'], ['extension_evidence', 'TEXT'],
];
/** `max_days` after an extension, as `parseExperimentInput` bounds it at open. */
export const EXPERIMENT_MAX_DAYS = 90;

const WAITS_GROUP_COLUMN: Readonly<Record<TLedgerWaitsBy, string>> = {
  reason: 'reason', holder: 'holder', type: 'item_type', stage: 'reason',
};

const groupKey = (row: IIntervalRow, by: TLedgerWaitsBy): string | null => {
  if (by === 'reason') return row.reason;
  if (by === 'holder') return row.holder;
  if (by === 'type') return row.item_type;
  return stageOfReason(row.reason);
};

interface IWaitAccumulator {
  waitedMs: number;
  durations: number[];
  openItems: number;
  openWaitedMs: number;
}

const summarize = (acc: IWaitAccumulator): Omit<ILedgerWaitRow, 'key'> => {
  const sorted = [...acc.durations].sort((a, b) => a - b);
  return {
    waitedMs: acc.waitedMs,
    finished: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p90Ms: percentile(sorted, 0.9),
    openItems: acc.openItems,
    openWaitedMs: acc.openWaitedMs,
  };
};

/**
 * The work-item ledger (ADR-0033): append-only events, the per-item projection, and the wait
 * intervals each projection step writes in the same transaction, so a read is a sum, never a replay.
 */
export class LedgerStore {
  private readonly database: Database.Database;
  /** The durable tab event log (ADR-0035) over this handle. */
  readonly tabEvents: TabEventsTable;
  /** Each agent tab's finished turns and their acting tool calls (story 15, ADR-0035 §7). */
  readonly tabTurns: TabTurnsTable;

  constructor(databasePath = defaultDbPath()) {
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new Database(databasePath);
    try {
      if (databasePath !== ':memory:') fs.chmodSync(databasePath, 0o600);
      this.database.pragma('journal_mode = WAL');
      this.database.pragma('busy_timeout = 5000');
      this.database.pragma('synchronous = FULL');
      this.migrate();
      this.ensureExperimentColumns();
      this.tabEvents = new TabEventsTable(this.database);
      this.tabEvents.ensureShape();
      this.tabTurns = new TabTurnsTable(this.database);
      this.tabTurns.ensureShape();
      this.ensureLandings();
      this.database.exec('CREATE INDEX IF NOT EXISTS events_ws_producer_received_idx ON events(workspace_id, producer, received_at)');
    } catch (error) {
      // A refused file (a newer schema) must not leave a handle open for every request that tries it.
      this.database.close();
      throw error;
    }
  }

  close = (): void => {
    this.database.close();
  };

  private migrate = (): void => {
    const current = this.database.pragma('user_version', { simple: true }) as number;
    if (current > SCHEMA_VERSION) throw new Error(`unsupported ledger schema ${current}`);
    if (current === SCHEMA_VERSION) return;
    this.database.transaction(() => this.database.exec(`
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        at INTEGER NOT NULL, received_at INTEGER NOT NULL, producer TEXT NOT NULL, item_type TEXT NOT NULL,
        item_key TEXT NOT NULL, kind TEXT NOT NULL, state TEXT, wait_reason TEXT, holder TEXT, clear_input TEXT,
        parent_key TEXT, attrs_json TEXT, event_key BLOB NOT NULL UNIQUE, body_digest BLOB NOT NULL
      );
      CREATE INDEX events_at_idx ON events(at);
      CREATE TABLE items (
        workspace_id TEXT NOT NULL, item_key TEXT NOT NULL, item_type TEXT NOT NULL, opened_at INTEGER NOT NULL,
        closed_at INTEGER, state TEXT, state_since INTEGER, wait_reason TEXT, wait_since INTEGER, holder TEXT,
        clear_input TEXT, parent_key TEXT, attrs_json TEXT, last_seq INTEGER NOT NULL, last_event_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, item_key)
      ) WITHOUT ROWID;
      CREATE INDEX items_open_idx ON items(workspace_id) WHERE closed_at IS NULL;
      CREATE TABLE intervals (
        id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, item_key TEXT NOT NULL, item_type TEXT NOT NULL,
        reason TEXT NOT NULL, holder TEXT, start INTEGER NOT NULL, "end" INTEGER NOT NULL
      );
      CREATE INDEX intervals_ws_end_idx ON intervals(workspace_id, "end", start);
      CREATE TABLE rollups_daily (
        workspace_id TEXT NOT NULL, day TEXT NOT NULL, item_type TEXT NOT NULL, reason TEXT NOT NULL,
        waited_ms INTEGER NOT NULL, items INTEGER NOT NULL, p50_ms INTEGER, p90_ms INTEGER,
        PRIMARY KEY (workspace_id, day, item_type, reason)
      ) WITHOUT ROWID;
      CREATE TABLE tab_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, tab_id TEXT NOT NULL, at INTEGER NOT NULL,
        class TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, delivered_at INTEGER, digest_id TEXT
      );
      CREATE INDEX tab_events_tab_idx ON tab_events(workspace_id, tab_id, at);
      CREATE INDEX tab_events_at_idx ON tab_events(at);
      CREATE TABLE experiments (
        workspace_id TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, item_key TEXT NOT NULL,
        hypothesis TEXT NOT NULL, change_ref TEXT, stage TEXT NOT NULL, reason TEXT, metric TEXT NOT NULL,
        baseline_json TEXT, target REAL, guards_json TEXT NOT NULL, revert_if TEXT, min_days INTEGER NOT NULL,
        max_days INTEGER NOT NULL, started_at INTEGER NOT NULL, verdict TEXT, verdict_at INTEGER, evidence TEXT,
        PRIMARY KEY (workspace_id, id)
      );
      CREATE TABLE ledger_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `))();
  };

  /** The extend-once columns on a ledger written before story 22; `user_version` stays 1. */
  private ensureExperimentColumns = (): void => {
    const present = new Set((this.database.prepare('SELECT name FROM pragma_table_info(?)').all('experiments') as Array<{ name: string }>)
      .map((row) => row.name));
    this.database.transaction(() => {
      for (const [name, type] of EXPERIMENT_ADDED_COLUMNS) {
        if (!present.has(name)) this.database.exec(`ALTER TABLE experiments ADD COLUMN ${name} ${type}`);
      }
    })();
  };

  private recordLanding = (workspaceId: string, itemKey: string, at: number, seq: number): void => {
    this.database.prepare('INSERT OR IGNORE INTO landings (event_seq, workspace_id, item_key, at) VALUES (?, ?, ?, ?)')
      .run(seq, workspaceId, itemKey, at);
  };

  /**
   * The `landings` table (04-C1), additive like `tab_events`' columns (ADR-0035): created on the first
   * open of a ledger that lacks it, and filled once in the same transaction by folding the stored range
   * events with the store's own fold, so a ledger written before it counts its landings. `user_version`
   * stays 1. The fold runs on range events alone: a landing's open or close can move a range's clock
   * (the land-queue split), which only a full replay would mirror, so a backfilled landing time can sit
   * up to that split later than the live one; new landings are written by `project` itself.
   */
  private ensureLandings = (): void => {
    if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'landings'").get()) return;
    this.database.transaction(() => {
      this.database.exec(`CREATE TABLE landings (event_seq INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, item_key TEXT NOT NULL,
          at INTEGER NOT NULL);
        CREATE INDEX landings_ws_at_idx ON landings(workspace_id, at);`);
      const rows = new Map<string, IItemRow>();
      const found: Array<[string, string, number, number]> = [];
      const events = this.database.prepare(`SELECT seq, workspace_id, at, item_type, item_key, kind, state, wait_reason, holder,
          clear_input, parent_key FROM events WHERE item_type = 'range' ORDER BY seq`)
        .iterate() as IterableIterator<TLedgerReplayEvent & { workspace_id: string }>;
      for (const { workspace_id: workspaceId, ...event } of events) {
        const key = `${workspaceId}\u0000${event.item_key}`;
        const fold = foldLedgerEvent(workspaceId, rows.get(key), { ...event, event_id: '' }, event.seq, () => LAND_QUEUE_HEAD_BLOCKED);
        if (!fold.applied) continue;
        rows.set(key, fold.item);
        if (isLanding(fold, event)) found.push([workspaceId, event.item_key, fold.at, event.seq]);
      }
      for (const [workspaceId, itemKey, at, seq] of found) this.recordLanding(workspaceId, itemKey, at, seq);
    })();
  };

  private getItem = (workspaceId: string, itemKey: string): IItemRow | undefined =>
    this.database.prepare('SELECT * FROM items WHERE workspace_id = ? AND item_key = ?').get(workspaceId, itemKey) as IItemRow | undefined;

  private hasOpenLanding = (workspaceId: string): boolean =>
    (this.database.prepare(`SELECT EXISTS (SELECT 1 FROM items INDEXED BY items_open_idx WHERE workspace_id = ?
      AND closed_at IS NULL AND item_type = 'landing') AS open`).get(workspaceId) as { open: number }).open === 1;

  private landQueueReason = (workspaceId: string): TLedgerIntervalReason =>
    this.hasOpenLanding(workspaceId) ? LAND_QUEUE_LOCK_BUSY : LAND_QUEUE_HEAD_BLOCKED;

  private meta = (key: string): number | null =>
    (this.database.prepare('SELECT value FROM ledger_meta WHERE key = ?').get(key) as { value: number } | undefined)?.value ?? null;

  private setMeta = (key: string, value: number): void => {
    this.database.prepare('INSERT INTO ledger_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  };

  private writeInterval = (
    workspaceId: string, item: Pick<IItemRow, 'item_key' | 'item_type' | 'holder'>, reason: string, start: number, end: number,
  ): number => {
    if (end <= start) return 0;
    this.database.prepare(`INSERT INTO intervals (workspace_id, item_key, item_type, reason, holder, start, "end")
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, item.item_key, item.item_type, reason, item.holder, start, end);
    // The longest interval bounds a window read: an interval overlapping [since, until) ends before until + longest.
    const longestKey = `longest-interval-ms:${workspaceId}`;
    if (end - start > (this.meta(longestKey) ?? 0)) this.setMeta(longestKey, end - start);
    return 1;
  };

  /**
   * A landing opened or closed: every land-queue wait of the workspace ends its segment and starts
   * the other half of the split, so lock-busy and head-blocked are measured, not guessed.
   */
  private resplitLandQueue = (workspaceId: string, at: number): number => {
    const reason = this.landQueueReason(workspaceId);
    const waiting = this.database.prepare(`SELECT * FROM items INDEXED BY items_open_idx WHERE workspace_id = ?
      AND closed_at IS NULL AND wait_reason IN (?, ?) ORDER BY item_key`).all(workspaceId, LAND_QUEUE_LOCK_BUSY, LAND_QUEUE_HEAD_BLOCKED) as IItemRow[];
    let written = 0;
    for (const row of waiting) {
      if (row.wait_reason === reason) continue;
      const since = Math.max(at, row.wait_since ?? at, row.last_event_at);
      written += this.writeInterval(workspaceId, row, row.wait_reason!, row.wait_since ?? since, since);
      // The new segment starts the item's clock there: a late event for it cannot land before the split.
      this.database.prepare('UPDATE items SET wait_reason = ?, wait_since = ?, last_event_at = ? WHERE workspace_id = ? AND item_key = ?')
        .run(reason, since, since, workspaceId, row.item_key);
    }
    return written;
  };

  /** One event onto its item's projection: the pure fold (`ledger-fold.ts`), then its writes. */
  private project = (
    workspaceId: string, event: ILedgerEventInput, seq: number,
  ): { intervals: number; closedItem: boolean; orphan: boolean } => {
    const fold = foldLedgerEvent(workspaceId, this.getItem(workspaceId, event.item_key), event, seq,
      () => this.landQueueReason(workspaceId));
    if (!fold.applied) return { intervals: 0, closedItem: fold.closedItem, orphan: fold.orphan };
    const { item, reopened, closing, at } = fold;
    let intervals = 0;
    for (const interval of fold.intervals) {
      intervals += this.writeInterval(workspaceId, { item_key: item.item_key, item_type: item.item_type, holder: interval.holder },
        interval.reason, interval.start, interval.end);
    }
    this.database.prepare(`INSERT INTO items (workspace_id, item_key, item_type, opened_at, closed_at, state, state_since,
        wait_reason, wait_since, holder, clear_input, parent_key, attrs_json, last_seq, last_event_at)
      VALUES (@workspace_id, @item_key, @item_type, @opened_at, @closed_at, @state, @state_since, @wait_reason, @wait_since,
        @holder, @clear_input, @parent_key, @attrs_json, @last_seq, @last_event_at)
      ON CONFLICT (workspace_id, item_key) DO UPDATE SET item_type = excluded.item_type, opened_at = excluded.opened_at,
        closed_at = excluded.closed_at, state = excluded.state, state_since = excluded.state_since,
        wait_reason = excluded.wait_reason, wait_since = excluded.wait_since, holder = excluded.holder,
        clear_input = excluded.clear_input, parent_key = excluded.parent_key, attrs_json = excluded.attrs_json,
        last_seq = excluded.last_seq, last_event_at = excluded.last_event_at`).run(item);
    if (item.item_type === 'landing' && (reopened || closing)) intervals += this.resplitLandQueue(workspaceId, at);
    if (isLanding(fold, event)) this.recordLanding(workspaceId, item.item_key, at, seq);
    return { intervals, closedItem: false, orphan: false };
  };

  private appendInTransaction = (
    workspaceId: string, producer: string, events: readonly ILedgerEventInput[], receivedAt: number,
  ): Omit<ILedgerAppendResult, 'ok' | 'workspaceId' | 'producer' | 'receivedAt'> => {
    const insert = this.database.prepare(`INSERT OR IGNORE INTO events (event_id, workspace_id, at, received_at, producer,
        item_type, item_key, kind, state, wait_reason, holder, clear_input, parent_key, attrs_json, event_key, body_digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const stored = this.database.prepare('SELECT body_digest FROM events WHERE event_key = ?');
    const result = { accepted: 0, duplicates: 0, closedItem: 0, orphan: 0, intervals: 0 };
    events.forEach((event, index) => {
      const key = eventKey(workspaceId, producer, event.event_id);
      const digest = bodyDigest(event);
      const inserted = insert.run(event.event_id, workspaceId, event.at, receivedAt, producer, event.item_type, event.item_key,
        event.kind, event.state ?? null, event.wait_reason ?? null, event.holder ?? null, event.clear_input ?? null,
        event.parent_key ?? null, event.attrs ? JSON.stringify(event.attrs) : null, key, digest);
      if (!inserted.changes) {
        // A retransmit is a duplicate; the same id with another body is a producer bug, never dropped silently.
        if (!digest.equals((stored.get(key) as { body_digest: Buffer }).body_digest)) {
          throw new LedgerStoreError('ledger-event-conflict',
            `events[${index}].event_id: ${JSON.stringify(event.event_id)} is already stored for producer ${producer} with a different body`,
            `events[${index}].event_id`);
        }
        result.duplicates += 1;
        return;
      }
      result.accepted += 1;
      const projected = this.project(workspaceId, event, Number(inserted.lastInsertRowid));
      result.intervals += projected.intervals;
      if (projected.closedItem) result.closedItem += 1;
      if (projected.orphan) result.orphan += 1;
    });
    return result;
  };

  /**
   * Append a validated batch in one transaction. An `event_id` the workspace already holds is
   * skipped, so a replayed spool or batch changes nothing.
   */
  append = (workspaceId: string, producer: string, events: readonly ILedgerEventInput[], receivedAt: number): ILedgerAppendResult => {
    const counts = this.database.transaction(() => this.appendInTransaction(workspaceId, producer, events, receivedAt))();
    return { ok: true, workspaceId, producer, receivedAt, ...counts };
  };

  items = (workspaceId: string, query: ILedgerItemQuery, now: number): { items: ILedgerItem[]; truncated: boolean } => {
    const limit = query.limit ?? 500;
    const clauses = ['workspace_id = ?'];
    const params: Array<string | number> = [workspaceId];
    if (query.open) clauses.push('closed_at IS NULL');
    // Without statistics the planner prefers the primary key and walks every closed item.
    const from = query.open ? 'items INDEXED BY items_open_idx' : 'items';
    if (query.type) {
      clauses.push('item_type = ?');
      params.push(query.type);
    }
    if (query.holder) {
      clauses.push('holder = ?');
      params.push(query.holder);
    }
    const rows = this.database.prepare(`SELECT * FROM ${from} WHERE ${clauses.join(' AND ')}
      ORDER BY opened_at, item_key LIMIT ?`).all(...params, limit + 1) as IItemRow[];
    return { items: rows.slice(0, limit).map((row) => itemFromRow(row, now)), truncated: rows.length > limit };
  };

  /** Finished intervals that overlap [since, until), each with its full start and end. */
  intervalsIn = (workspaceId: string, since: number, until: number): IIntervalRow[] =>
    this.database.prepare(`SELECT item_key, item_type, reason, holder, start, "end" FROM intervals
      WHERE workspace_id = ? AND "end" > ? AND start < ? ORDER BY start, id`).all(workspaceId, since, until) as IIntervalRow[];

  /**
   * Landings in [since, until): the rows `project` wrote when it applied a `close` with state `landed` to a
   * `range` (04-C1), so the count is the store's own. A re-sent, repeated or orphan close counts none; a
   * range reopened and landed again counts each landing. The one landed count of cache reads per landed
   * item and the constraint finder.
   */
  landedRanges = (workspaceId: string, since: number, until: number): number =>
    (this.database.prepare('SELECT COUNT(*) AS n FROM landings WHERE workspace_id = ? AND at >= ? AND at < ?')
      .get(workspaceId, since, until) as { n: number }).n;

  /** Whether the ledger holds any item for the workspace (a seek on the items primary key). */
  holdsItems = (workspaceId: string): boolean =>
    (this.database.prepare('SELECT EXISTS (SELECT 1 FROM items WHERE workspace_id = ?) AS held').get(workspaceId) as { held: number }).held === 1;

  /** The earliest `opened_at` of the workspace's items; null when the ledger holds none for it. */
  firstOpenedAt = (workspaceId: string): number | null =>
    (this.database.prepare('SELECT MIN(opened_at) AS at FROM items WHERE workspace_id = ?').get(workspaceId) as { at: number | null }).at;

  /**
   * What the spend view's phase replay folds (harness-flow-loop 04 consult ruling): the open items
   * silent since before `since - 7 d` as the seed, then every event of the workspace from there to
   * `until` in arrival order. The scan rides the `at` index; there is no per-item event index.
   */
  phaseReplay = (workspaceId: string, since: number, until: number): ILedgerPhaseReplay => {
    const scanStart = since - PHASE_REPLAY_LOOKBACK_MS;
    const seed = this.database.prepare(`SELECT * FROM items INDEXED BY items_open_idx WHERE workspace_id = ?
      AND closed_at IS NULL AND last_event_at < ? ORDER BY item_key`).all(workspaceId, scanStart) as IItemRow[];
    const events = this.database.prepare(`SELECT seq, at, item_type, item_key, kind, state, wait_reason, holder, clear_input,
        parent_key FROM events WHERE at >= ? AND at < ? AND workspace_id = ? ORDER BY seq`)
      .all(scanStart, until, workspaceId) as TLedgerReplayEvent[];
    const opensFirst = new Map<string, boolean>();
    for (const event of events) if (!opensFirst.has(event.item_key)) opensFirst.set(event.item_key, event.kind === 'open');
    const unopened = [...opensFirst].filter(([, opens]) => !opens).map(([key]) => key);
    const carried: IItemRow[] = [];
    for (let i = 0; i < unopened.length; i += CARRIED_CHUNK) {
      const keys = unopened.slice(i, i + CARRIED_CHUNK);
      carried.push(...this.database.prepare(`SELECT * FROM items WHERE workspace_id = ? AND item_key IN (${keys.map(() => '?').join(', ')})
        AND opened_at < ? AND (closed_at IS NULL OR closed_at >= ?)`).all(workspaceId, ...keys, scanStart, scanStart) as IItemRow[]);
    }
    return {
      workspaceId, scanStart, seed, events, carried: carried.sort((a, b) => a.item_key.localeCompare(b.item_key)),
      firstOpenedAt: this.firstOpenedAt(workspaceId),
    };
  };

  waits = (workspaceId: string, query: ILedgerWaitsQuery, now: number): { rows: ILedgerWaitRow[]; totals: Omit<ILedgerWaitRow, 'key'> } => {
    const { since, until, by } = query;
    const groups = new Map<string | null, IWaitAccumulator>();
    const total: IWaitAccumulator = { waitedMs: 0, durations: [], openItems: 0, openWaitedMs: 0 };
    const accumulator = (key: string | null): IWaitAccumulator => {
      let acc = groups.get(key);
      if (!acc) {
        acc = { waitedMs: 0, durations: [], openItems: 0, openWaitedMs: 0 };
        groups.set(key, acc);
      }
      return acc;
    };
    // Unordered raw rows: a sum needs no order, and objects cost twice the time on a 7-day window.
    // Bounded on both sides, so a window 84 days back scans its own week, not every later interval.
    const longest = this.meta(`longest-interval-ms:${workspaceId}`) ?? 0;
    const typed = query.type ? ' AND item_type = ?' : '';
    const typeParam = query.type ? [query.type] : [];
    const finished = this.database.prepare(`SELECT ${WAITS_GROUP_COLUMN[by]}, start, "end" FROM intervals
      WHERE workspace_id = ? AND "end" > ? AND "end" <= ? AND start < ?${typed}`).raw()
      .all(workspaceId, since, until + longest, until, ...typeParam) as Array<[string | null, number, number]>;
    for (const [group, start, end] of finished) {
      const acc = accumulator(by === 'stage' ? stageOfReason(group!) : group);
      const inside = clippedMs(start, end, since, until);
      acc.waitedMs += inside;
      total.waitedMs += inside;
      if (end <= until) {
        acc.durations.push(end - start);
        total.durations.push(end - start);
      }
    }
    const open = this.database.prepare(`SELECT * FROM items INDEXED BY items_open_idx WHERE workspace_id = ?
      AND closed_at IS NULL AND (wait_reason IS NOT NULL OR last_event_at < ?)${typed} ORDER BY item_key`)
      .all(workspaceId, now - LEDGER_SILENT_MS, ...typeParam) as IItemRow[];
    for (const row of open) {
      const item = itemFromRow(row, now);
      if (item.waitReason === null || item.waitSince === null || item.waitSince >= until) continue;
      const acc = accumulator(groupKey({ ...row, reason: item.waitReason, start: item.waitSince, end: now }, by));
      const inside = clippedMs(item.waitSince, now, since, until);
      acc.openItems += 1;
      acc.openWaitedMs += inside;
      total.openItems += 1;
      total.openWaitedMs += inside;
    }
    const rows = [...groups.entries()]
      .map(([key, acc]) => ({ key, ...summarize(acc) }))
      .sort((a, b) => (b.waitedMs + b.openWaitedMs) - (a.waitedMs + a.openWaitedMs) || String(a.key).localeCompare(String(b.key)));
    return { rows, totals: summarize(total) };
  };

  /**
   * What the constraint finder reads for one workspace (ADR-0034): finished waits overlapping
   * [since, now), open items and items closed since `since`, the producer of each open item's last
   * event, where the workspace's history starts, and deliveries per tab since `wakesSince`.
   */
  finderSnapshot = (workspaceId: string, window: { since: number; wakesSince: number }, now: number): IFinderLedgerInput => {
    const intervals = (this.database.prepare(`SELECT item_key, item_type, reason, holder, start, "end" FROM intervals
      WHERE workspace_id = ? AND "end" > ? AND "end" <= ? AND start < ?`).raw()
      .all(workspaceId, window.since, now + (this.meta(`longest-interval-ms:${workspaceId}`) ?? 0), now) as Array<
      [string, TLedgerItemType, TLedgerIntervalReason, string | null, number, number]>)
      .map(([itemKey, itemType, reason, holder, start, end]) => ({ itemKey, itemType, reason, holder, start, end }));
    const items = (this.database.prepare('SELECT * FROM items WHERE workspace_id = ? AND (closed_at IS NULL OR closed_at > ?)')
      .all(workspaceId, window.since) as IItemRow[]).map((row) => itemFromRow(row, now));
    const lastProducer = Object.fromEntries(this.database.prepare(`SELECT i.item_key, e.producer FROM items AS i INDEXED BY items_open_idx
      JOIN events e ON e.seq = i.last_seq WHERE i.workspace_id = ? AND i.closed_at IS NULL`).raw()
      .all(workspaceId) as Array<[string, string]>);
    const firstEventAt = (this.database.prepare('SELECT MIN(opened_at) AS first FROM items WHERE workspace_id = ?')
      .get(workspaceId) as { first: number | null }).first;
    const anyTabEvent = this.database.prepare('SELECT 1 FROM tab_events WHERE workspace_id = ? LIMIT 1').get(workspaceId) !== undefined;
    // A delivery follows its event, so `at` (indexed) bounds the scan; a digest holds events for at most a day.
    const tabWakes = anyTabEvent
      ? (this.database.prepare(`SELECT tab_id, COUNT(DISTINCT COALESCE(digest_id, 'seq:' || seq)) FROM tab_events
        WHERE workspace_id = ? AND at > ? AND at <= ? AND delivered_at > ? AND delivered_at <= ? AND class != 'log'
        GROUP BY tab_id ORDER BY tab_id`).raw()
        .all(workspaceId, window.wakesSince - DAY_MS, now, window.wakesSince, now) as Array<[string, number]>)
        .map(([tabId, wakes]) => ({ tabId, wakes }))
      : null;
    return { intervals, items, lastProducer, firstEventAt, tabWakes, ownerIssueSource: this.ownerIssueSource(workspaceId, window.since) };
  };

  private ownerIssueSource = (workspaceId: string, since: number): IFinderOwnerIssueSource | null => {
    const newest = this.database.prepare(`SELECT e.producer FROM items AS i JOIN events AS e ON e.seq = i.last_seq
      WHERE i.workspace_id = ? AND i.item_type = 'owner-issue' ORDER BY i.opened_at DESC, i.item_key LIMIT 1`)
      .get(workspaceId) as { producer: string } | undefined;
    if (!newest) return null;
    const producerOf = new Map(this.database.prepare(`SELECT i.item_key, e.producer FROM items AS i JOIN events AS e ON e.seq = i.last_seq
      WHERE i.workspace_id = ? AND i.item_type = 'owner-issue' AND (i.closed_at IS NULL OR i.closed_at > ?)`).raw()
      .all(workspaceId, since) as Array<[string, string]>);
    const received = this.database.prepare(`SELECT MIN(received_at) AS first, MAX(received_at) AS last FROM events
      WHERE workspace_id = ? AND producer = ?`);
    const receipts = new Map([...new Set([newest.producer, ...producerOf.values()])].map((producer) => {
      const row = received.get(workspaceId, producer) as { first: number; last: number };
      return [producer, { firstReceivedAt: row.first, lastReceivedAt: row.last }];
    }));
    const { earliest } = this.database.prepare(`SELECT MIN(opened_at) AS earliest FROM items WHERE workspace_id = ? AND item_type = 'owner-issue'`)
      .get(workspaceId) as { earliest: number };
    const { dated } = this.database.prepare(`SELECT EXISTS (SELECT 1 FROM items WHERE workspace_id = ? AND item_type = 'owner-issue'
      AND json_type(attrs_json, '$.raisedAt') = 'integer') AS dated`).get(workspaceId) as { dated: number };
    return { producerOf, newestProducer: newest.producer, receipts, earliestOpenedAt: earliest, anyRaisedAt: dated === 1 };
  };

  /**
   * What the pulse reads (ADR-0034 §9): movement (open, clear and close events) on the work item
   * types only, whether any event on those types arrived since `since` (experiment, seat and MC item
   * events never switch the WIP basis, round 2 F2), and the open work items with the oldest of them
   * by its wait (else its open).
   */
  pulseSnapshot = (workspaceId: string, since: number): ILedgerPulseSnapshot => {
    const types = PULSE_WORK_ITEM_TYPES.map(() => '?').join(', ');
    const movement = (this.database.prepare(`SELECT at FROM events WHERE at >= ? AND workspace_id = ?
      AND kind IN ('open', 'clear', 'close') AND item_type IN (${types})`).pluck()
      .all(since, workspaceId, ...PULSE_WORK_ITEM_TYPES) as number[]);
    const eventSince = this.database.prepare(`SELECT 1 FROM events WHERE at >= ? AND workspace_id = ? AND item_type IN (${types}) LIMIT 1`)
      .get(since, workspaceId, ...PULSE_WORK_ITEM_TYPES) !== undefined;
    const openWork = (this.database.prepare(`SELECT COUNT(*) FROM items INDEXED BY items_open_idx
      WHERE workspace_id = ? AND closed_at IS NULL AND item_type IN (${types})`).pluck()
      .get(workspaceId, ...PULSE_WORK_ITEM_TYPES) as number);
    const oldest = this.database.prepare(`SELECT item_key, item_type, wait_reason, COALESCE(wait_since, opened_at) AS since
      FROM items INDEXED BY items_open_idx WHERE workspace_id = ? AND closed_at IS NULL AND item_type IN (${types})
      ORDER BY since, item_key LIMIT 1`).get(workspaceId, ...PULSE_WORK_ITEM_TYPES) as
      { item_key: string; item_type: TLedgerItemType; wait_reason: string | null; since: number } | undefined;
    return {
      movement, eventSince, openWork,
      oldest: oldest ? { itemKey: oldest.item_key, itemType: oldest.item_type, waitReason: oldest.wait_reason, since: oldest.since } : null,
    };
  };

  experiments = (workspaceId: string): ILedgerExperiment[] =>
    (this.database.prepare('SELECT * FROM experiments WHERE workspace_id = ? ORDER BY seq')
      .all(workspaceId) as IExperimentRow[]).map(experimentFromRow);

  /**
   * Open an experiment (ADR-HFL-03): one active per stage, at most two in all. It is also a ledger
   * item of type `experiment`, opened by the server.
   */
  openExperiment = (workspaceId: string, input: ILedgerExperimentInput, now: number): ILedgerExperiment =>
    this.database.transaction(() => {
      const active = this.experiments(workspaceId).filter((experiment) => experiment.verdict === null);
      const sameStage = active.find((experiment) => experiment.stage === input.stage);
      if (sameStage) {
        throw new LedgerStoreError('ledger-experiment-cap', `stage ${input.stage} already has active experiment ${sameStage.id}; close it first`);
      }
      if (active.length >= 2) {
        throw new LedgerStoreError('ledger-experiment-cap',
          `two experiments are active (${active.map((experiment) => experiment.id).join(', ')}); at most two run at once`);
      }
      const seq = ((this.database.prepare('SELECT MAX(seq) AS seq FROM experiments WHERE workspace_id = ?')
        .get(workspaceId) as { seq: number | null }).seq ?? 0) + 1;
      const id = `EXP-${seq}`;
      const itemKey = `experiment:${id}`;
      this.database.prepare(`INSERT INTO experiments (workspace_id, id, seq, item_key, hypothesis, change_ref, stage, reason,
          metric, baseline_json, target, guards_json, revert_if, min_days, max_days, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(workspaceId, id, seq, itemKey, input.hypothesis,
        input.change_ref, input.stage, input.reason, input.metric, input.baseline ? JSON.stringify(input.baseline) : null,
        input.target, JSON.stringify(input.guards), input.revert_if, input.min_days, input.max_days, now);
      this.appendInTransaction(workspaceId, SERVER_PRODUCER, [{
        event_id: `${SERVER_PRODUCER}:${itemKey}:open`, at: now, item_type: 'experiment', item_key: itemKey, kind: 'open',
        attrs: { stage: input.stage, metric: input.metric, reason: input.reason },
      }], now);
      return this.experiments(workspaceId).find((experiment) => experiment.id === id)!;
    })();

  closeExperiment = (
    workspaceId: string, id: string, verdict: TLedgerExperimentVerdict, evidence: string, now: number,
  ): ILedgerExperiment =>
    this.database.transaction(() => {
      const found = this.experiments(workspaceId).find((experiment) => experiment.id === id);
      if (!found) throw new LedgerStoreError('ledger-experiment-not-found', `no experiment ${id} in ${workspaceId}`);
      if (found.verdict !== null) {
        throw new LedgerStoreError('ledger-experiment-closed', `${id} already has the verdict ${found.verdict}`);
      }
      this.database.prepare('UPDATE experiments SET verdict = ?, verdict_at = ?, evidence = ? WHERE workspace_id = ? AND id = ?')
        .run(verdict, now, evidence, workspaceId, id);
      this.appendInTransaction(workspaceId, SERVER_PRODUCER, [{
        event_id: `${SERVER_PRODUCER}:${found.itemKey}:close`, at: now, item_type: 'experiment', item_key: found.itemKey,
        kind: 'close', state: verdict === 'keep' ? 'kept' : 'reverted',
      }], now);
      return this.experiments(workspaceId).find((experiment) => experiment.id === id)!;
    })();

  /**
   * Extend an active experiment once (ADR-HFL-03 decision 2 step 1, "extend once"): `max_days` grows by `days`, at most to
   * 90. A second extension is refused (409 `ledger-experiment-extended`), and so is a closed experiment. The ledger item
   * gains a server `state` event `extended`.
   */
  extendExperiment = (workspaceId: string, id: string, days: number, evidence: string, now: number): ILedgerExperiment =>
    this.database.transaction(() => {
      const found = this.experiments(workspaceId).find((experiment) => experiment.id === id);
      if (!found) throw new LedgerStoreError('ledger-experiment-not-found', `no experiment ${id} in ${workspaceId}`);
      if (found.verdict !== null) {
        throw new LedgerStoreError('ledger-experiment-closed', `${id} already has the verdict ${found.verdict}`);
      }
      if (found.extendedAt !== null) {
        throw new LedgerStoreError('ledger-experiment-extended',
          `${id} was extended once already, by ${found.extensionDays} days at ${new Date(found.extendedAt).toISOString()}`);
      }
      const maxDays = found.maxDays + days;
      if (maxDays > EXPERIMENT_MAX_DAYS) {
        throw new LedgerStoreError('ledger-experiment-cap',
          `max_days ${found.maxDays} + ${days} = ${maxDays}, at most ${EXPERIMENT_MAX_DAYS}`, 'days');
      }
      this.database.prepare(`UPDATE experiments SET max_days = ?, extended_at = ?, extension_days = ?, extension_evidence = ?
          WHERE workspace_id = ? AND id = ?`).run(maxDays, now, days, evidence, workspaceId, id);
      this.appendInTransaction(workspaceId, SERVER_PRODUCER, [{
        event_id: `${SERVER_PRODUCER}:${found.itemKey}:extend`, at: now, item_type: 'experiment', item_key: found.itemKey,
        kind: 'state', state: 'extended', attrs: { extension_days: days, max_days: maxDays },
      }], now);
      return this.experiments(workspaceId).find((experiment) => experiment.id === id)!;
    })();

  /** Every workspace holding an interval, read from the (workspace_id, end) index; per-workspace reads then use it. */
  private workspacesWithIntervals = (): string[] =>
    (this.database.prepare('SELECT DISTINCT workspace_id FROM intervals ORDER BY workspace_id').all() as Array<{ workspace_id: string }>)
      .map((row) => row.workspace_id);

  /** Roll up one whole UTC day from the intervals that overlap it, in one transaction; replaced, so a re-run is safe. */
  private rollUpDay = (start: number): string => {
    const end = start + DAY_MS;
    const day = utcDay(start);
    this.database.transaction(() => {
      const rows = this.workspacesWithIntervals().flatMap((workspaceId) => {
        const longest = this.meta(`longest-interval-ms:${workspaceId}`) ?? 0;
        return this.database.prepare(`SELECT workspace_id, item_key, item_type, reason, start, "end" FROM intervals
          WHERE workspace_id = ? AND "end" > ? AND "end" <= ? AND start < ?`)
          .all(workspaceId, start, end + longest, end) as Array<IIntervalRow & { workspace_id: string }>;
      });
      const groups = new Map<string, { workspaceId: string; type: string; reason: string; waited: number; items: Set<string>; durations: number[] }>();
      for (const row of rows) {
        const key = JSON.stringify([row.workspace_id, row.item_type, row.reason]);
        let group = groups.get(key);
        if (!group) {
          group = { workspaceId: row.workspace_id, type: row.item_type, reason: row.reason, waited: 0, items: new Set(), durations: [] };
          groups.set(key, group);
        }
        group.waited += clippedMs(row.start, row.end, start, end);
        group.items.add(row.item_key);
        if (row.end <= end) group.durations.push(row.end - row.start);
      }
      this.database.prepare('DELETE FROM rollups_daily WHERE day = ?').run(day);
      const insert = this.database.prepare(`INSERT INTO rollups_daily (workspace_id, day, item_type, reason, waited_ms, items,
        p50_ms, p90_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const group of groups.values()) {
        const sorted = group.durations.sort((a, b) => a - b);
        insert.run(group.workspaceId, day, group.type, group.reason, group.waited, group.items.size,
          percentile(sorted, 0.5), percentile(sorted, 0.9));
      }
    })();
    return day;
  };

  /** Roll up each whole UTC day from the one holding fromMs to the one holding toMs. */
  rollUp = (fromMs: number, toMs: number): string[] => {
    const days: string[] = [];
    for (let start = Math.floor(fromMs / DAY_MS) * DAY_MS; start <= toMs; start += DAY_MS) days.push(this.rollUpDay(start));
    return days;
  };

  rollups = (workspaceId: string): Array<{ day: string; itemType: string; reason: string; waitedMs: number; items: number; p50Ms: number | null; p90Ms: number | null }> =>
    (this.database.prepare(`SELECT day, item_type, reason, waited_ms, items, p50_ms, p90_ms FROM rollups_daily
      WHERE workspace_id = ? ORDER BY day, item_type, reason`).all(workspaceId) as Array<Record<string, number | string | null>>)
      .map((row) => ({
        day: row.day as string, itemType: row.item_type as string, reason: row.reason as string, waitedMs: row.waited_ms as number,
        items: row.items as number, p50Ms: row.p50_ms as number | null, p90Ms: row.p90_ms as number | null,
      }));

  /** Delete with `sql` (its last parameter is the chunk size) until a chunk comes back short, yielding between chunks. */
  private deleteInChunks = async (sql: string, params: Array<string | number>): Promise<number> => {
    let total = 0;
    for (;;) {
      const changes = this.database.prepare(sql).run(...params, RETENTION_CHUNK).changes;
      total += changes;
      if (changes < RETENTION_CHUNK) return total;
      await yieldToEventLoop();
    }
  };

  /**
   * The days a pass rolls up: from the day after the last rolled-up day, or from the earliest day a
   * wait finished since the last pass touched, whichever is earlier, to yesterday; never before the
   * day after the retention cutoff. A wait longer than a day re-rolls every day it covers once it finishes, so
   * each day is rolled up with all its finished waits before it leaves the 92-day window, and a
   * server down for days leaves no gap.
   */
  private rollUpRange = (now: number): { from: number; to: number; lastIntervalId: number } => {
    const today = Math.floor(now / DAY_MS) * DAY_MS;
    const cutoffDay = Math.floor((now - LEDGER_RETENTION_DAYS * DAY_MS) / DAY_MS) * DAY_MS;
    const rolledThrough = this.meta('rolled-through-day');
    const lastIntervalId = (this.database.prepare('SELECT MAX(id) AS id FROM intervals').get() as { id: number | null }).id ?? 0;
    const newest = (this.database.prepare('SELECT MIN(start) AS start FROM intervals WHERE id > ?')
      .get(this.meta('rolled-interval-id') ?? 0) as { start: number | null }).start;
    const touched = newest === null ? today : Math.floor(newest / DAY_MS) * DAY_MS;
    // The cutoff day itself is partly deleted already when a pass runs twice on one UTC day, so re-rolling it
    // would replace its rollup with a partial one: the first day rolled is the day after the cutoff.
    const from = Math.max(cutoffDay + DAY_MS, Math.min(rolledThrough === null ? touched : rolledThrough + DAY_MS, touched));
    return { from, to: today - DAY_MS, lastIntervalId };
  };

  /**
   * The daily job: roll up (see rollUpRange), then delete events and intervals older than 92 days,
   * tab events and tab turns older than 30 days, items closed before then, and rollups older than 400 days. Each day's rollup is one
   * transaction and each delete runs in chunks of RETENTION_CHUNK rows, yielding to the event loop
   * between them, so the server keeps answering while it runs.
   */
  runRetention = async (now: number): Promise<ILedgerRetentionResult> => {
    const range = this.rollUpRange(now);
    const rolledUpDays: string[] = [];
    for (let day = range.from; day <= range.to; day += DAY_MS) {
      rolledUpDays.push(this.rollUpDay(day));
      await yieldToEventLoop();
    }
    this.setMeta('rolled-through-day', Math.max(this.meta('rolled-through-day') ?? range.to, range.to));
    this.setMeta('rolled-interval-id', range.lastIntervalId);
    const cutoff = now - LEDGER_RETENTION_DAYS * DAY_MS;
    let intervals = 0;
    for (const workspaceId of this.workspacesWithIntervals()) {
      intervals += await this.deleteInChunks(`DELETE FROM intervals WHERE id IN (SELECT id FROM intervals
        WHERE workspace_id = ? AND "end" < ? LIMIT ?)`, [workspaceId, cutoff]);
    }
    return {
      events: await this.deleteInChunks('DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE at < ? LIMIT ?)', [cutoff]),
      intervals,
      landings: await this.deleteInChunks('DELETE FROM landings WHERE event_seq IN (SELECT event_seq FROM landings WHERE at < ? LIMIT ?)', [cutoff]),
      tabEvents: await this.deleteInChunks('DELETE FROM tab_events WHERE seq IN (SELECT seq FROM tab_events WHERE at < ? LIMIT ?)',
        [now - LEDGER_TAB_EVENTS_RETENTION_DAYS * DAY_MS]),
      tabTurns: await this.deleteInChunks(TabTurnsTable.RETENTION_DELETE, [now - LEDGER_TAB_EVENTS_RETENTION_DAYS * DAY_MS]),
      items: await this.deleteInChunks(`DELETE FROM items WHERE (workspace_id, item_key) IN (SELECT workspace_id, item_key FROM items
        WHERE closed_at IS NOT NULL AND closed_at < ? LIMIT ?)`, [cutoff]),
      rollups: await this.deleteInChunks(`DELETE FROM rollups_daily WHERE (workspace_id, day, item_type, reason) IN
        (SELECT workspace_id, day, item_type, reason FROM rollups_daily WHERE day < ? LIMIT ?)`,
      [utcDay(now - LEDGER_ROLLUP_RETENTION_DAYS * DAY_MS)]),
      rolledUpDays,
    };
  };

  /** A test helper for the retention, schema and finder tests; the writer is TabEventsTable (ADR-0035). Not a route. */
  insertTabEvent = (row: {
    workspaceId: string; tabId: string; at: number; class: string; kind: string; text: string; deliveredAt?: number | null; digestId?: string | null;
  }): void => {
    this.database.prepare(`INSERT INTO tab_events (workspace_id, tab_id, at, class, kind, text, delivered_at, digest_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(row.workspaceId, row.tabId, row.at, row.class, row.kind, row.text, row.deliveredAt ?? null, row.digestId ?? null);
  };

  counts = (): Record<'events' | 'items' | 'intervals' | 'rollups_daily' | 'tab_events' | 'experiments', number> => {
    const count = (table: string): number => (this.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      events: count('events'), items: count('items'), intervals: count('intervals'),
      rollups_daily: count('rollups_daily'), tab_events: count('tab_events'), experiments: count('experiments'),
    };
  };

  pragma = (name: string): unknown => this.database.pragma(name, { simple: true });

  columns = (table: string): string[] =>
    (this.database.prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`).all(table) as Array<{ name: string }>).map((row) => row.name);
}

const g = globalThis as unknown as { __ptLedgerStore?: LedgerStore };

export const getLedgerStore = (): LedgerStore => {
  if (!g.__ptLedgerStore) g.__ptLedgerStore = new LedgerStore();
  return g.__ptLedgerStore;
};

/** Tests only: drop the singleton so the next call opens a file under the current HOME. */
export const resetLedgerStoreForTests = (): void => {
  g.__ptLedgerStore?.close();
  delete g.__ptLedgerStore;
};
