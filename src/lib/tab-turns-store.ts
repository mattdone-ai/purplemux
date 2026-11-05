import type Database from 'better-sqlite3';
import type { ITabTurn } from '@/types/effects';

/** `ledger_meta` key: when the first turn was recorded. Before it, no effect is measured. */
const MEASURED_SINCE_KEY = 'turns-measured-since';

interface ITabTurnRow {
  workspace_id: string;
  tab_id: string;
  provider: string;
  started_at: number | null;
  ended_at: number;
  tool_calls: number | null;
}

/**
 * `tab_turns` in `ledger.sqlite` (story 15, ADR-0035 §7): one row per finished turn of an agent tab, with its acting
 * tool calls. Additive like `tab_events`' columns: created in place, `user_version` stays 1.
 */
export class TabTurnsTable {
  constructor(private readonly database: Database.Database) {}

  ensureShape = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS tab_turns (
        id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL, tab_id TEXT NOT NULL, provider TEXT NOT NULL,
        started_at INTEGER, ended_at INTEGER NOT NULL, tool_calls INTEGER
      );
      CREATE INDEX IF NOT EXISTS tab_turns_ws_end_idx ON tab_turns(workspace_id, ended_at);
    `);
  };

  /** One finished turn; the first one ever stamps `measuredSince`. Answers the row id. */
  record = (turn: ITabTurn): number =>
    this.database.transaction(() => {
      this.database.prepare('INSERT OR IGNORE INTO ledger_meta (key, value) VALUES (?, ?)')
        .run(MEASURED_SINCE_KEY, turn.startedAt ?? turn.endedAt);
      return Number(this.database.prepare(`INSERT INTO tab_turns (workspace_id, tab_id, provider, started_at, ended_at, tool_calls)
        VALUES (?, ?, ?, ?, ?, ?)`).run(turn.workspaceId, turn.tabId, turn.provider, turn.startedAt, turn.endedAt, turn.toolCalls)
        .lastInsertRowid);
    })();

  /** A tool hook that arrived just after its turn's stop: counted on that turn, unless the turn is unmeasured. */
  addToolCall = (id: number): void => {
    this.database.prepare('UPDATE tab_turns SET tool_calls = tool_calls + 1 WHERE id = ? AND tool_calls IS NOT NULL').run(id);
  };

  measuredSince = (): number | null =>
    (this.database.prepare('SELECT value FROM ledger_meta WHERE key = ?').get(MEASURED_SINCE_KEY) as { value: number } | undefined)?.value ?? null;

  /** The workspace's turns that ended at or after `since`, oldest end first. */
  endedSince = (workspaceId: string, since: number): ITabTurn[] =>
    (this.database.prepare(`SELECT workspace_id, tab_id, provider, started_at, ended_at, tool_calls FROM tab_turns
      INDEXED BY tab_turns_ws_end_idx WHERE workspace_id = ? AND ended_at >= ? ORDER BY ended_at, id`)
      .all(workspaceId, since) as ITabTurnRow[])
      .map((row) => ({
        workspaceId: row.workspace_id, tabId: row.tab_id, provider: row.provider, startedAt: row.started_at, endedAt: row.ended_at,
        toolCalls: row.tool_calls,
      }));

  /** The retention statement's shape (`LedgerStore.deleteInChunks`): rows that ended before the cutoff. */
  static readonly RETENTION_DELETE = 'DELETE FROM tab_turns WHERE id IN (SELECT id FROM tab_turns WHERE ended_at < ? LIMIT ?)';
}
