import type Database from 'better-sqlite3';
import type { ITurnEndRow, TSeatRole, TTurnVerdict, TUnreportedReason } from '@/lib/turn-end-row';

interface ITurnEndDbRow {
  session_id: string;
  turn_id: number;
  workspace_id: string;
  tab_id: string;
  seat_role: string | null;
  story: string | null;
  attempt: number | null;
  verdict: string;
  head_sha: string | null;
  gate_log: string | null;
  gate_verdict: string | null;
  reason: string | null;
  source: string;
  unreported_reason: string | null;
  at: number;
  consumed_at: number | null;
}

const fromRow = (row: ITurnEndDbRow): ITurnEndRow => ({
  sessionId: row.session_id,
  turnId: row.turn_id,
  workspaceId: row.workspace_id,
  tabId: row.tab_id,
  seatRole: row.seat_role as TSeatRole | null,
  story: row.story,
  attempt: row.attempt,
  verdict: row.verdict as TTurnVerdict | 'UNREPORTED',
  head: row.head_sha,
  gateLog: row.gate_log,
  gateVerdict: row.gate_verdict,
  reason: row.reason,
  source: row.source as ITurnEndRow['source'],
  unreportedReason: row.unreported_reason as TUnreportedReason | null,
  at: row.at,
  consumedAt: row.consumed_at,
});

/**
 * `turn_ends` and `session_turns` in `ledger.sqlite` (F6, F10 step 2). Additive like `tab_turns`: created in place,
 * `user_version` stays 1, so a server rolled back to a build without them opens the file as before.
 *
 * The turn key is a per-session counter kept here, bumped by each live prompt-submit (design check (2) ruling,
 * change 2): the in-memory event sequence restarts at 0 after a restore, so an old row could satisfy a new turn.
 */
export class TurnEndsTable {
  static readonly RETENTION_DELETE = 'DELETE FROM turn_ends WHERE rowid IN (SELECT rowid FROM turn_ends WHERE at < ? LIMIT ?)';
  static readonly STARTS_RETENTION_DELETE = `DELETE FROM session_turn_starts WHERE rowid IN
    (SELECT rowid FROM session_turn_starts WHERE at < ? LIMIT ?)`;

  constructor(private readonly database: Database.Database) {}

  ensureShape = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS turn_ends (
        session_id TEXT NOT NULL, turn_id INTEGER NOT NULL, workspace_id TEXT NOT NULL, tab_id TEXT NOT NULL,
        seat_role TEXT, story TEXT, attempt INTEGER, verdict TEXT NOT NULL, head_sha TEXT, gate_log TEXT, gate_verdict TEXT,
        reason TEXT, source TEXT NOT NULL, unreported_reason TEXT, at INTEGER NOT NULL, consumed_at INTEGER,
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS turn_ends_ws_at_idx ON turn_ends(workspace_id, at);
      -- blocks: nothing reads it since the party ruling SIMPLIFY (no stop is held); kept, the ledger is additive.
      CREATE TABLE IF NOT EXISTS session_turns (
        session_id TEXT PRIMARY KEY, turn_id INTEGER NOT NULL, blocks INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS session_turn_starts (
        session_id TEXT NOT NULL, turn_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session_id, turn_id)
      );
    `);
  };

  /** A live prompt-submit started a new turn of the session: the next turn id. */
  bumpTurn = (sessionId: string, at: number): number =>
    this.database.transaction(() => {
      const turnId = (this.database.prepare(`INSERT INTO session_turns (session_id, turn_id, blocks, updated_at) VALUES (?, 1, 0, ?)
        ON CONFLICT(session_id) DO UPDATE SET turn_id = turn_id + 1, blocks = 0, updated_at = excluded.updated_at
        RETURNING turn_id`).get(sessionId, at) as { turn_id: number }).turn_id;
      this.database.prepare('INSERT OR REPLACE INTO session_turn_starts (session_id, turn_id, at) VALUES (?, ?, ?)').run(sessionId, turnId, at);
      return turnId;
    })();

  /**
   * The turn a stop that happened at `at` belongs to: the latest turn the session started at or before it (review nit
   * 3: a replayed stop is judged against its own turn, never the session's current one). Null when none is recorded.
   */
  turnAt = (sessionId: string, at: number): number | null =>
    (this.database.prepare(`SELECT turn_id FROM session_turn_starts WHERE session_id = ? AND at <= ?
      ORDER BY turn_id DESC LIMIT 1`).get(sessionId, at) as { turn_id: number } | undefined)?.turn_id ?? null;

  /** The session's current turn; null before its first prompt-submit. */
  currentTurn = (sessionId: string): { turnId: number } | null => {
    const row = this.database.prepare('SELECT turn_id FROM session_turns WHERE session_id = ?').get(sessionId) as
      { turn_id: number } | undefined;
    return row ? { turnId: row.turn_id } : null;
  };

  /** Write the turn's row; a second `done` in the same turn replaces an unconsumed one. A consumed row stays. */
  put = (row: ITurnEndRow): boolean =>
    this.database.prepare(`INSERT INTO turn_ends (session_id, turn_id, workspace_id, tab_id, seat_role, story, attempt, verdict,
        head_sha, gate_log, gate_verdict, reason, source, unreported_reason, at, consumed_at)
      VALUES (@sessionId, @turnId, @workspaceId, @tabId, @seatRole, @story, @attempt, @verdict, @head, @gateLog, @gateVerdict,
        @reason, @source, @unreportedReason, @at, @consumedAt)
      ON CONFLICT(session_id, turn_id) DO UPDATE SET workspace_id = excluded.workspace_id, tab_id = excluded.tab_id,
        seat_role = excluded.seat_role, story = excluded.story, attempt = excluded.attempt, verdict = excluded.verdict,
        head_sha = excluded.head_sha, gate_log = excluded.gate_log, gate_verdict = excluded.gate_verdict, reason = excluded.reason,
        source = excluded.source, unreported_reason = excluded.unreported_reason, at = excluded.at, consumed_at = excluded.consumed_at
      WHERE turn_ends.consumed_at IS NULL`).run(row).changes === 1;

  /**
   * An UNREPORTED row for a turn end with no valid row. It never replaces a row (review CONCERN): when the turn already
   * has one, nothing is written and false is returned.
   */
  putIfAbsent = (row: ITurnEndRow): boolean =>
    this.database.prepare(`INSERT INTO turn_ends (session_id, turn_id, workspace_id, tab_id, seat_role, story, attempt, verdict,
        head_sha, gate_log, gate_verdict, reason, source, unreported_reason, at, consumed_at)
      VALUES (@sessionId, @turnId, @workspaceId, @tabId, @seatRole, @story, @attempt, @verdict, @head, @gateLog, @gateVerdict,
        @reason, @source, @unreportedReason, @at, @consumedAt)
      ON CONFLICT(session_id, turn_id) DO NOTHING`).run(row).changes === 1;

  /** The turn's row while no stop has used it. */
  unconsumed = (sessionId: string, turnId: number): ITurnEndRow | null => {
    const row = this.database.prepare('SELECT * FROM turn_ends WHERE session_id = ? AND turn_id = ? AND consumed_at IS NULL')
      .get(sessionId, turnId) as ITurnEndDbRow | undefined;
    return row ? fromRow(row) : null;
  };

  /** Exactly one stop uses a row. False when another stop already did. */
  consume = (sessionId: string, turnId: number, at: number): boolean =>
    this.database.prepare('UPDATE turn_ends SET consumed_at = ? WHERE session_id = ? AND turn_id = ? AND consumed_at IS NULL')
      .run(at, sessionId, turnId).changes === 1;

  /** A workspace's rows recorded at or after `since`, oldest first: the AC2 report reads them by source. */
  list = (workspaceId: string, since: number): ITurnEndRow[] =>
    (this.database.prepare('SELECT * FROM turn_ends WHERE workspace_id = ? AND at >= ? ORDER BY at, session_id, turn_id')
      .all(workspaceId, since) as ITurnEndDbRow[]).map(fromRow);
}
