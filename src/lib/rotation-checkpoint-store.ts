import type Database from 'better-sqlite3';
import { checkpointDigest } from '@/lib/rotation-checkpoint';
import type { IRotationCheckpoint, IStoredCheckpoint, TCheckpointStatus } from '@/types/rotation-checkpoint';

interface ICheckpointRow {
  workspace_id: string;
  checkpoint_id: string;
  task_id: string;
  tab_id: string;
  attempt: number;
  status: TCheckpointStatus;
  digest: string;
  body_json: string;
  created_at: number;
  updated_at: number;
}

/** A row in one of these states is finished: nothing moves it again. */
export const TERMINAL_CHECKPOINT_STATES: readonly TCheckpointStatus[] = ['delivered', 'abandoned', 'undelivered', 'delivery-unknown'];

const IN_TERMINAL = TERMINAL_CHECKPOINT_STATES.map((status) => `'${status}'`).join(', ');

export class CheckpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointConflictError';
  }
}

/**
 * `rotation_checkpoints` in `ledger.sqlite` (vel-D5): one row per rotation attempt of a seat, written and read back
 * before the session is cleared. Additive like `tab_turns`: created in place, `user_version` stays 1. The handle is
 * the ledger's (WAL, `synchronous = FULL`), so a committed row survives a crash of the server or the host.
 */
export class RotationCheckpointsTable {
  constructor(private readonly database: Database.Database) {}

  ensureShape = (): void => {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS rotation_checkpoints (
        workspace_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL, tab_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, status TEXT NOT NULL, digest TEXT NOT NULL, body_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, checkpoint_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS rotation_checkpoints_task_idx ON rotation_checkpoints(workspace_id, task_id, attempt);
      CREATE INDEX IF NOT EXISTS rotation_checkpoints_tab_idx ON rotation_checkpoints(tab_id, status);
    `);
  };

  /**
   * Store the attempt as `written`. The same body again changes nothing; a row still `written` (its clear never ran)
   * takes a new body; a row past `written` is immutable and a different body for it is refused.
   */
  put = (checkpoint: IRotationCheckpoint, at: number): void => {
    const digest = checkpointDigest(checkpoint);
    this.database.transaction(() => {
      const existing = this.row(checkpoint.workspaceId, checkpoint.id);
      if (existing && existing.digest === digest) return;
      if (existing && existing.status !== 'written') {
        throw new CheckpointConflictError(`checkpoint ${checkpoint.id} is already ${existing.status} with another body (digest ${existing.digest.slice(0, 12)}, new ${digest.slice(0, 12)})`);
      }
      this.database.prepare(`INSERT INTO rotation_checkpoints (workspace_id, checkpoint_id, task_id, tab_id, attempt, status, digest,
          body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'written', ?, ?, ?, ?)
        ON CONFLICT (workspace_id, checkpoint_id) DO UPDATE SET status = 'written', tab_id = excluded.tab_id, digest = excluded.digest,
          body_json = excluded.body_json, updated_at = excluded.updated_at`)
        .run(checkpoint.workspaceId, checkpoint.id, checkpoint.taskId, checkpoint.tabId, checkpoint.attempt, digest,
          JSON.stringify(checkpoint), checkpoint.createdAt, at);
    })();
  };

  get = (workspaceId: string, checkpointId: string): IStoredCheckpoint | null => {
    const row = this.row(workspaceId, checkpointId);
    return row ? stored(row) : null;
  };

  /** The task's newest attempt, or null when it has none. */
  latest = (workspaceId: string, taskId: string): IStoredCheckpoint | null => {
    const row = this.database.prepare(`SELECT * FROM rotation_checkpoints INDEXED BY rotation_checkpoints_task_idx
      WHERE workspace_id = ? AND task_id = ? ORDER BY attempt DESC LIMIT 1`).get(workspaceId, taskId) as ICheckpointRow | undefined;
    return row ? stored(row) : null;
  };

  /** Move the row to `to` only from one of `from`: a step that runs twice changes nothing the second time. */
  mark = (workspaceId: string, checkpointId: string, from: readonly TCheckpointStatus[], to: TCheckpointStatus, at: number): boolean =>
    this.database.prepare(`UPDATE rotation_checkpoints SET status = ?, updated_at = ? WHERE workspace_id = ? AND checkpoint_id = ?
      AND status IN (${from.map(() => '?').join(', ')})`).run(to, at, workspaceId, checkpointId, ...from).changes === 1;

  /** A closed tab's rotations are over (review r1 F1): every row of it not yet finished becomes `abandoned`. */
  abandonTab = (tabId: string, at: number): number =>
    this.database.prepare(`UPDATE rotation_checkpoints INDEXED BY rotation_checkpoints_tab_idx SET status = 'abandoned', updated_at = ?
      WHERE tab_id = ? AND status NOT IN (${IN_TERMINAL})`).run(at, tabId).changes;

  /**
   * The retention statement's shape (`LedgerStore.deleteInChunks`): finished rows last moved before the cutoff,
   * never a task's newest row, because the next attempt number is read from it.
   */
  static readonly RETENTION_DELETE = `DELETE FROM rotation_checkpoints WHERE (workspace_id, checkpoint_id) IN (
    SELECT c.workspace_id, c.checkpoint_id FROM rotation_checkpoints c WHERE c.status IN (${IN_TERMINAL}) AND c.updated_at < ?
      AND c.attempt < (SELECT MAX(n.attempt) FROM rotation_checkpoints n WHERE n.workspace_id = c.workspace_id AND n.task_id = c.task_id)
    LIMIT ?)`;

  private row = (workspaceId: string, checkpointId: string): ICheckpointRow | undefined =>
    this.database.prepare('SELECT * FROM rotation_checkpoints WHERE workspace_id = ? AND checkpoint_id = ?')
      .get(workspaceId, checkpointId) as ICheckpointRow | undefined;
}

const stored = (row: ICheckpointRow): IStoredCheckpoint => ({
  checkpoint: JSON.parse(row.body_json) as IRotationCheckpoint,
  status: row.status,
  digest: row.digest,
  updatedAt: row.updated_at,
});
