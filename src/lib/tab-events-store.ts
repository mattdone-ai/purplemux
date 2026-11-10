import type Database from 'better-sqlite3';
import type { IPendingDigest, ITabDelivery, ITabEvent, ITabEventCount, ITabEventInput, ITabWakeRow, TWakeClass } from '@/types/tab-events';

interface ITabEventRow {
  seq: number;
  workspace_id: string;
  tab_id: string;
  at: number;
  class: TWakeClass;
  kind: string;
  text: string;
  source_tab_id: string | null;
  source_tab_name: string | null;
  rule: string | null;
  delivered_at: number | null;
  digest_id: string | null;
}

const fromRow = (row: ITabEventRow): ITabEvent => ({
  seq: row.seq,
  workspaceId: row.workspace_id,
  tabId: row.tab_id,
  at: row.at,
  class: row.class,
  kind: row.kind,
  text: row.text,
  sourceTabId: row.source_tab_id,
  sourceTabName: row.source_tab_name,
  rule: row.rule,
  deliveredAt: row.delivered_at,
  digestId: row.digest_id,
});

/** The columns and indexes ADR-0035 adds to ADR-0033's `tab_events`; `rule` is story 15's (ADR-0035 §7). */
const ADDED_COLUMNS = [['source_tab_id', 'TEXT'], ['source_tab_name', 'TEXT'], ['rule', 'TEXT']] as const;
const ADDED_INDEXES = `
  CREATE INDEX IF NOT EXISTS tab_events_pending_idx ON tab_events(workspace_id, tab_id)
    WHERE class = 'digest' AND delivered_at IS NULL AND digest_id IS NULL;
  CREATE INDEX IF NOT EXISTS tab_events_delivered_idx ON tab_events(workspace_id, delivered_at)
    WHERE delivered_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS tab_events_digest_idx ON tab_events(workspace_id, tab_id, delivered_at)
    WHERE digest_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS tab_events_sourced_idx ON tab_events(workspace_id, seq)
    WHERE source_tab_id IS NOT NULL;
`;

/** SQLite caps bound parameters per statement; a digest marks at most this many rows per statement. */
const MARK_CHUNK = 500;

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * `tab_events` in `ledger.sqlite` (ADR-0035): the durable record of what each tab was sent. The table
 * shares the ledger's handle; the ledger store builds this view over it.
 *
 * Its two columns and two indexes are additive and leave `user_version` at 1 (ADR-0035 §3): a server
 * rolled back to a build without them opens the file as before, and names neither.
 */
export class TabEventsTable {
  constructor(private readonly database: Database.Database) {}

  ensureShape = (): void => {
    const present = new Set((this.database.prepare('SELECT name FROM pragma_table_info(?)').all('tab_events') as Array<{ name: string }>)
      .map((row) => row.name));
    this.database.transaction(() => {
      for (const [name, type] of ADDED_COLUMNS) {
        if (!present.has(name)) this.database.exec(`ALTER TABLE tab_events ADD COLUMN ${name} ${type}`);
      }
      this.database.exec(ADDED_INDEXES);
    })();
  };

  append = (event: ITabEventInput): number =>
    Number(this.database.prepare(`INSERT INTO tab_events (workspace_id, tab_id, at, class, kind, text, source_tab_id,
      source_tab_name, rule, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(event.workspaceId, event.tabId, event.at,
      event.class, event.kind, event.text, event.sourceTabId ?? null, event.sourceTabName ?? null, event.rule ?? null,
      event.deliveredAt ?? null).lastInsertRowid);

  markDelivered = (seqs: readonly number[], at: number, digestId: string | null = null): void => {
    const update = (chunk: readonly number[]) => this.database.prepare(`UPDATE tab_events SET delivered_at = ?, digest_id = ?
      WHERE seq IN (${chunk.map(() => '?').join(',')})`).run(at, digestId, ...chunk);
    this.database.transaction(() => {
      for (let i = 0; i < seqs.length; i += MARK_CHUNK) update(seqs.slice(i, i + MARK_CHUNK));
    })();
  };

  /**
   * A copy of this tab, kind and text recorded at or after `since` still waits undelivered (ADR-0035 §2): a
   * duplicate. A delivered copy never suppresses a later one, whose template may carry no episode token
   * (review r2, F3); a logged duplicate never counts.
   */
  hasSame = (workspaceId: string, tabId: string, kind: string, text: string, since: number): boolean =>
    (this.database.prepare(`SELECT EXISTS (SELECT 1 FROM tab_events INDEXED BY tab_events_tab_idx
      WHERE workspace_id = ? AND tab_id = ? AND at >= ? AND kind = ? AND text = ? AND class != 'log'
      AND delivered_at IS NULL) AS hit`)
      .get(workspaceId, tabId, since, kind, text) as { hit: number }).hit === 1;

  /**
   * The copies of one event sent to the tab since `since`, matched on the text's fixed opening: whether one still
   * waits for a digest, and the latest delivery of any. Read from the log, so it holds across a restart. SQLite
   * measures `length` and `substr` in characters, so the opening's length is SQLite's, never JavaScript's UTF-16 count.
   */
  copies = (workspaceId: string, tabId: string, kind: string, opening: string, since: number): { held: boolean; lastDeliveredAt: number | null } => {
    const row = this.database.prepare(`SELECT
        COALESCE(MAX(class = 'digest' AND delivered_at IS NULL AND digest_id IS NULL), 0) AS held, MAX(delivered_at) AS delivered
      FROM tab_events INDEXED BY tab_events_tab_idx
      WHERE workspace_id = @workspaceId AND tab_id = @tabId AND at >= @since AND kind = @kind
        AND substr(text, 1, length(@opening)) = @opening`)
      .get({ workspaceId, tabId, since, kind, opening }) as { held: number; delivered: number | null };
    return { held: row.held === 1, lastDeliveredAt: row.delivered };
  };

  /** Digest events waiting for the tab's next digest, oldest first. */
  pending = (workspaceId: string, tabId: string): ITabEvent[] =>
    (this.database.prepare(`SELECT * FROM tab_events INDEXED BY tab_events_pending_idx WHERE workspace_id = ? AND tab_id = ?
      AND class = 'digest' AND delivered_at IS NULL AND digest_id IS NULL ORDER BY seq`).all(workspaceId, tabId) as ITabEventRow[])
      .map(fromRow);

  /** A closed tab's held events will never be typed: they become `log` rows (ADR-0035 §3; review F12). */
  retirePending = (workspaceId: string, tabId: string): number =>
    this.database.prepare(`UPDATE tab_events SET class = 'log' WHERE seq IN (SELECT seq FROM tab_events INDEXED BY tab_events_pending_idx
      WHERE workspace_id = ? AND tab_id = ? AND class = 'digest' AND delivered_at IS NULL AND digest_id IS NULL)`)
      .run(workspaceId, tabId).changes;

  pendingTabs = (): IPendingDigest[] =>
    (this.database.prepare(`SELECT workspace_id, tab_id, COUNT(*) AS count, MIN(at) AS oldest_at
      FROM tab_events INDEXED BY tab_events_pending_idx WHERE class = 'digest' AND delivered_at IS NULL AND digest_id IS NULL
      GROUP BY workspace_id, tab_id ORDER BY workspace_id, tab_id`)
      .all() as Array<{ workspace_id: string; tab_id: string; count: number; oldest_at: number }>)
      .map((row) => ({ workspaceId: row.workspace_id, tabId: row.tab_id, count: row.count, oldestAt: row.oldest_at }));

  lastDigestAt = (workspaceId: string, tabId: string): number | null =>
    (this.database.prepare(`SELECT MAX(delivered_at) AS at FROM tab_events INDEXED BY tab_events_digest_idx
      WHERE workspace_id = ? AND tab_id = ? AND digest_id IS NOT NULL`).get(workspaceId, tabId) as { at: number | null }).at;

  /**
   * F6 change 3: the latest window-governed delivery to a coordinator — a digest, or an inbox row of a windowed kind —
   * among rows recorded in the last 25 h (bounded so the read stays on the tab index; an older one cannot shut a 10-min
   * window). Urgent pastes, sends and skipping kinds are not counted (design ruling, change 1).
   */
  lastGovernedDelivery = (workspaceId: string, tabId: string, windowedKinds: readonly string[], now: number): number | null =>
    (this.database.prepare(`SELECT MAX(delivered_at) AS at FROM tab_events INDEXED BY tab_events_tab_idx
      WHERE workspace_id = ? AND tab_id = ? AND at >= ? AND delivered_at IS NOT NULL
        AND (digest_id IS NOT NULL OR kind IN (${windowedKinds.map(() => '?').join(',') || "''"}))`)
      .get(workspaceId, tabId, now - 25 * 60 * 60_000, ...windowedKinds) as { at: number | null }).at;

  /** The latest delivery to the tab of an event recorded at or after `since` (an urgent paste, a notice, a send). */
  lastDeliveredSince = (workspaceId: string, tabId: string, since: number): number | null =>
    (this.database.prepare(`SELECT MAX(delivered_at) AS at FROM tab_events INDEXED BY tab_events_tab_idx
      WHERE workspace_id = ? AND tab_id = ? AND at >= ?`).get(workspaceId, tabId, since) as { at: number | null }).at;

  /** Newest last; `limit` keeps the newest rows. */
  list = (workspaceId: string, query: { tabId?: string | null; since: number; limit: number; sourced?: boolean }): ITabEvent[] => {
    // The nudge history walks its own partial index newest first; the rest the (workspace, tab, at) one.
    const from = query.sourced ? 'tab_events INDEXED BY tab_events_sourced_idx' : 'tab_events';
    const clauses = ['workspace_id = ?', 'at >= ?'];
    const params: Array<string | number> = [workspaceId, query.since];
    if (query.tabId) {
      clauses.push('tab_id = ?');
      params.push(query.tabId);
    }
    if (query.sourced) clauses.push('source_tab_id IS NOT NULL');
    const rows = this.database.prepare(`SELECT * FROM ${from} WHERE ${clauses.join(' AND ')} ORDER BY seq DESC LIMIT ?`)
      .all(...params, query.limit) as ITabEventRow[];
    return rows.reverse().map(fromRow);
  };

  /** The curator's call records in a workspace since `since` (ADR-0038 §2), oldest first: their JSON text only. */
  curatorCalls = (workspaceId: string, since: number): string[] =>
    this.database.prepare(`SELECT text FROM tab_events INDEXED BY tab_events_at_idx WHERE at >= ? AND workspace_id = ?
      AND class = 'log' AND kind = 'curator' ORDER BY seq`).pluck().all(since, workspaceId) as string[];

  /** Every workspace's routing decisions since `since` (story 23), oldest first: their JSON text only. */
  curatorRoutesSince = (since: number): string[] =>
    this.database.prepare(`SELECT text FROM tab_events INDEXED BY tab_events_at_idx WHERE at >= ? AND class = 'log' AND kind = 'curator-route'
      ORDER BY seq`).pluck().all(since) as string[];

  /** Every workspace's curator call records since `since`, but the evaluation's: the label queue reads them. */
  curatorCallsSince = (since: number, excludeWorkspace: string): Array<{ workspaceId: string; at: number; text: string }> =>
    (this.database.prepare(`SELECT workspace_id, at, text FROM tab_events INDEXED BY tab_events_at_idx WHERE at >= ?
      AND class = 'log' AND kind = 'curator' AND workspace_id != ? ORDER BY seq`).all(since, excludeWorkspace) as Array<{ workspace_id: string; at: number; text: string }>)
      .map((row) => ({ workspaceId: row.workspace_id, at: row.at, text: row.text }));

  /** The events delivered to the workspace's tabs in [since, until), oldest first: the effect count's input (story 15). */
  deliveries = (workspaceId: string, since: number, until: number): ITabDelivery[] =>
    (this.database.prepare(`SELECT seq, tab_id, kind, rule, delivered_at, digest_id FROM tab_events INDEXED BY tab_events_delivered_idx
      WHERE workspace_id = ? AND delivered_at IS NOT NULL AND delivered_at >= ? AND delivered_at < ? AND class != 'log'
      ORDER BY delivered_at, seq`)
      .all(workspaceId, since, until) as Array<{ seq: number; tab_id: string; kind: string; rule: string | null; delivered_at: number; digest_id: string | null }>)
      .map((row) => ({ seq: row.seq, tabId: row.tab_id, kind: row.kind, rule: row.rule, deliveredAt: row.delivered_at, digestId: row.digest_id }));

  /**
   * The rows recorded in [since, until), counted by kind and rule: the effect count's firings (story 15). Any class but
   * the curator's call log, which records a classification, never an event sent to a tab (ADR-0038).
   */
  recordedCounts = (workspaceId: string, since: number, until: number): ITabEventCount[] =>
    this.database.prepare(`SELECT kind, rule, COUNT(*) AS count FROM tab_events INDEXED BY tab_events_at_idx
      WHERE at >= ? AND at < ? AND workspace_id = ? AND NOT (class = 'log' AND kind IN ('curator', 'curator-route'))
      GROUP BY kind, rule ORDER BY kind, rule`)
      .all(since, until, workspaceId) as ITabEventCount[];

  hasAny = (workspaceId: string): boolean =>
    (this.database.prepare('SELECT EXISTS (SELECT 1 FROM tab_events INDEXED BY tab_events_tab_idx WHERE workspace_id = ?) AS hit')
      .get(workspaceId) as { hit: number }).hit === 1;

  /**
   * Wakes per seat (ADR-0035 §6; story 03's anomaly input). A wake is one delivery: an event delivered
   * on its own, or a digest, counted once however many events it carried. Undelivered and `log` rows
   * never wake. `byDay` splits by the UTC day of the delivery (of the record, for `logged`).
   */
  wakes = (workspaceId: string, query: { since: number; until: number; byDay?: boolean }): ITabWakeRow[] => {
    const rows = new Map<string, ITabWakeRow>();
    const row = (tabId: string, at: number): ITabWakeRow => {
      const day = query.byDay ? dayOf(at) : null;
      const key = `${tabId}\0${day ?? ''}`;
      let found = rows.get(key);
      if (!found) {
        found = { tabId, day, wakes: 0, digests: 0, urgent: 0, logged: 0 };
        rows.set(key, found);
      }
      return found;
    };
    const delivered = this.database.prepare(`SELECT tab_id, delivered_at, digest_id FROM tab_events INDEXED BY tab_events_delivered_idx
      WHERE workspace_id = ? AND delivered_at IS NOT NULL AND delivered_at >= ? AND delivered_at < ? AND class != 'log'`)
      .raw().all(workspaceId, query.since, query.until) as Array<[string, number, string | null]>;
    const digestsSeen = new Set<string>();
    for (const [tabId, at, digestId] of delivered) {
      const target = row(tabId, at);
      if (digestId === null) {
        target.urgent += 1;
        target.wakes += 1;
      } else if (!digestsSeen.has(digestId)) {
        digestsSeen.add(digestId);
        target.digests += 1;
        target.wakes += 1;
      }
    }
    // A curator call or routing decision is a log row about a tab, never an event sent to it (ADR-0038 §2, story 23).
    const logged = this.database.prepare(`SELECT tab_id, at FROM tab_events INDEXED BY tab_events_at_idx
      WHERE at >= ? AND at < ? AND workspace_id = ? AND class = 'log' AND kind NOT IN ('curator', 'curator-route')`).raw().all(query.since, query.until, workspaceId) as Array<[string, number]>;
    for (const [tabId, at] of logged) row(tabId, at).logged += 1;
    return [...rows.values()].sort((a, b) => a.tabId.localeCompare(b.tabId) || (a.day ?? '').localeCompare(b.day ?? ''));
  };
}
