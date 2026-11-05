import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS } from '@/lib/ledger';
import { LedgerStore } from '@/lib/ledger-store';
import type { ITabEventInput } from '@/types/tab-events';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 0, 0, 0);
const WS = 'ws-a';

let dir: string;
let file: string;
let store: LedgerStore;

const ev = (extra: Partial<ITabEventInput> = {}): ITabEventInput => ({
  workspaceId: WS, tabId: 'tab-o', at: T0, class: 'digest', kind: 'turn-marker', text: 'x', ...extra,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-tab-events-'));
  file = path.join(dir, 'ledger.sqlite');
  store = new LedgerStore(file);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tab_events shape (ADR-0035 §3)', () => {
  it('adds its columns to a file story 01 wrote, keeps user_version 1 and the rows', () => {
    store.tabEvents.append(ev({ text: 'before' }));
    store.close();
    const raw = new Database(file);
    raw.exec(`DROP INDEX tab_events_pending_idx; DROP INDEX tab_events_delivered_idx; DROP INDEX tab_events_digest_idx;
      DROP INDEX tab_events_sourced_idx;`);
    raw.exec(`ALTER TABLE tab_events DROP COLUMN source_tab_name; ALTER TABLE tab_events DROP COLUMN source_tab_id;
      ALTER TABLE tab_events DROP COLUMN rule; DROP TABLE tab_turns;`);
    raw.close();
    store = new LedgerStore(file);
    expect(store.pragma('user_version')).toBe(1);
    expect(store.columns('tab_events').slice(-3)).toEqual(['source_tab_id', 'source_tab_name', 'rule']);
    expect(store.columns('tab_turns')).toEqual(['id', 'workspace_id', 'tab_id', 'provider', 'started_at', 'ended_at', 'tool_calls']);
    expect(store.tabEvents.list(WS, { since: 0, limit: 10 }).map((row) => row.text)).toEqual(['before']);
  });
});

describe('the write and read path', () => {
  it('appends, lists newest last within the limit, and filters by tab and by source', () => {
    store.tabEvents.append(ev({ at: T0, text: 'a', sourceTabId: 'tab-w', sourceTabName: 'w' }));
    store.tabEvents.append(ev({ at: T0 + MIN, text: 'b', tabId: 'tab-p' }));
    store.tabEvents.append(ev({ at: T0 + 2 * MIN, text: 'c' }));
    expect(store.tabEvents.list(WS, { since: 0, limit: 10 }).map((row) => row.text)).toEqual(['a', 'b', 'c']);
    expect(store.tabEvents.list(WS, { since: 0, limit: 2 }).map((row) => row.text)).toEqual(['b', 'c']);
    expect(store.tabEvents.list(WS, { tabId: 'tab-o', since: 0, limit: 10 }).map((row) => row.text)).toEqual(['a', 'c']);
    expect(store.tabEvents.list(WS, { since: T0 + MIN, limit: 10 }).map((row) => row.text)).toEqual(['b', 'c']);
    const [sourced] = store.tabEvents.list(WS, { since: 0, limit: 10, sourced: true });
    expect(sourced).toMatchObject({ text: 'a', sourceTabId: 'tab-w', sourceTabName: 'w', deliveredAt: null, digestId: null });
    expect(store.tabEvents.list('ws-b', { since: 0, limit: 10 })).toEqual([]);
  });

  it('finds the same tab, kind and text at or after a time, and nothing else', () => {
    store.tabEvents.append(ev({ at: T0, text: 'same' }));
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'turn-marker', 'same', T0)).toBe(true);
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'turn-marker', 'same', T0 + 1)).toBe(false);
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'stuck', 'same', 0)).toBe(false);
    expect(store.tabEvents.hasSame(WS, 'tab-p', 'turn-marker', 'same', 0)).toBe(false);
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'turn-marker', 'other', 0)).toBe(false);
    store.tabEvents.append(ev({ at: T0, text: 'logged', class: 'log' }));
    expect(store.tabEvents.hasSame(WS, 'tab-o', 'turn-marker', 'logged', 0)).toBe(false);
  });

  it("reads an event's copies by the text's opening: one held, and the latest delivery (story 13)", () => {
    const opening = 'range:h1:abc not-armed for ';
    const copies = () => store.tabEvents.copies(WS, 'tab-o', 'alarm', opening, T0);
    expect(copies()).toEqual({ held: false, lastDeliveredAt: null });
    const first = store.tabEvents.append(ev({ at: T0, kind: 'alarm', text: `${opening}21 min` }));
    store.tabEvents.append(ev({ at: T0, kind: 'alarm', text: 'range:h1:abc rework for 30 min' }));
    store.tabEvents.append(ev({ at: T0, kind: 'stuck', text: `${opening}40 min` }));
    store.tabEvents.append(ev({ at: T0, tabId: 'tab-p', kind: 'alarm', text: `${opening}40 min` }));
    store.tabEvents.append(ev({ at: T0 - 1, kind: 'alarm', text: `${opening}9 h` }));
    expect(copies()).toEqual({ held: true, lastDeliveredAt: null });
    store.tabEvents.markDelivered([first], T0 + 5 * MIN, 'dg-1');
    expect(copies()).toEqual({ held: false, lastDeliveredAt: T0 + 5 * MIN });
    store.tabEvents.append(ev({ at: T0 + 80 * MIN, kind: 'alarm', class: 'log', text: `${opening}80 min` }));
    store.tabEvents.append(ev({ at: T0 + 81 * MIN, kind: 'alarm', class: 'urgent', text: `${opening}81 min`, deliveredAt: T0 + 81 * MIN }));
    expect(copies()).toEqual({ held: false, lastDeliveredAt: T0 + 81 * MIN });
  });

  it('keeps digest events pending until marked, per tab, oldest first', () => {
    const a = store.tabEvents.append(ev({ at: T0, text: 'a' }));
    const b = store.tabEvents.append(ev({ at: T0 + MIN, text: 'b' }));
    store.tabEvents.append(ev({ at: T0 + MIN, text: 'u', class: 'urgent' }));
    store.tabEvents.append(ev({ at: T0 + MIN, text: 'l', class: 'log' }));
    store.tabEvents.append(ev({ at: T0 + 2 * MIN, text: 'p', tabId: 'tab-p' }));
    expect(store.tabEvents.pending(WS, 'tab-o').map((row) => row.text)).toEqual(['a', 'b']);
    expect(store.tabEvents.pendingTabs()).toEqual([
      { workspaceId: WS, tabId: 'tab-o', count: 2, oldestAt: T0 },
      { workspaceId: WS, tabId: 'tab-p', count: 1, oldestAt: T0 + 2 * MIN },
    ]);
    expect(store.tabEvents.lastDigestAt(WS, 'tab-o')).toBeNull();
    store.tabEvents.markDelivered([a, b], T0 + 5 * MIN, 'dg-1');
    expect(store.tabEvents.pending(WS, 'tab-o')).toEqual([]);
    expect(store.tabEvents.lastDigestAt(WS, 'tab-o')).toBe(T0 + 5 * MIN);
    expect(store.tabEvents.pendingTabs().map((row) => row.tabId)).toEqual(['tab-p']);
  });

  // Measured 430-579 ms alone at load 64 and 7.5 s in the full suite under host load (gates 10-r5): 30 s is four times
  // the worst seen. The checks count rows in SQL rather than reading 33,000 rows twice (about 45% of the run).
  it('marks more rows than one statement may bind', { timeout: 30_000 }, () => {
    // SQLite refuses a statement with more than 32,766 parameters (measured on the bundled 3.53): one row
    // past that proves the chunking. The rows are seeded in one transaction on a second handle (WAL), so the
    // test measures markDelivered, not 33,000 fsync'd commits (it timed out under disk load at 1,200).
    const rows = 33_000;
    const raw = new Database(file);
    let seqs: number[];
    try {
      expect(() => raw.prepare(`SELECT 1 WHERE 1 IN (${Array(rows).fill('?').join(',')})`)).toThrow(/too many SQL variables/);
      const insert = raw.prepare(`INSERT INTO tab_events (workspace_id, tab_id, at, class, kind, text) VALUES (?, 'tab-o', ?, 'digest', 'turn-marker', ?)`);
      seqs = raw.transaction(() => Array.from({ length: rows }, (_, i) => Number(insert.run(WS, T0 + i, `e${i}`).lastInsertRowid)))();
    } finally {
      raw.close();
    }
    expect(store.tabEvents.pendingTabs()).toEqual([{ workspaceId: WS, tabId: 'tab-o', count: rows, oldestAt: T0 }]);
    store.tabEvents.markDelivered(seqs, T0 + DAY_MS, 'dg-big');
    expect(store.tabEvents.pendingTabs()).toEqual([]);
    expect(store.tabEvents.pending(WS, 'tab-o')).toEqual([]);
    const check = new Database(file, { readonly: true });
    try {
      expect(check.prepare(`SELECT COUNT(*) AS total, SUM(delivered_at = ? AND digest_id = 'dg-big') AS marked FROM tab_events
        WHERE workspace_id = ?`).get(T0 + DAY_MS, WS)).toEqual({ total: rows, marked: rows });
    } finally {
      check.close();
    }
  });

  it('knows whether a workspace has any tab event', () => {
    expect(store.tabEvents.hasAny(WS)).toBe(false);
    store.tabEvents.append(ev());
    expect(store.tabEvents.hasAny(WS)).toBe(true);
    expect(store.tabEvents.hasAny('ws-b')).toBe(false);
  });
});

describe('wakes per seat (AC 6)', () => {
  const seed = () => {
    // tab-o: two urgent deliveries and one digest of three events on day 1, one urgent on day 2, one logged,
    // one urgent never delivered (its tab was gone). tab-p: one digest.
    const deliver = (at: number, extra: Partial<ITabEventInput>) => store.tabEvents.append(ev({ at, deliveredAt: at, class: 'urgent', ...extra }));
    deliver(T0 + MIN, {});
    deliver(T0 + 2 * MIN, {});
    const digest = [0, 1, 2].map((i) => store.tabEvents.append(ev({ at: T0 + i * MIN })));
    store.tabEvents.markDelivered(digest, T0 + 20 * MIN, 'dg-o1');
    deliver(T0 + DAY_MS + MIN, {});
    store.tabEvents.append(ev({ at: T0 + 3 * MIN, class: 'log' }));
    store.tabEvents.append(ev({ at: T0 + 4 * MIN, class: 'urgent' }));
    const p = store.tabEvents.append(ev({ at: T0, tabId: 'tab-p' }));
    store.tabEvents.markDelivered([p], T0 + 30 * MIN, 'dg-p1');
  };

  it('counts a delivery once: an urgent event, or a digest however many events it carried', () => {
    seed();
    expect(store.tabEvents.wakes(WS, { since: T0, until: T0 + 2 * DAY_MS })).toEqual([
      { tabId: 'tab-o', day: null, wakes: 4, digests: 1, urgent: 3, logged: 1 },
      { tabId: 'tab-p', day: null, wakes: 1, digests: 1, urgent: 0, logged: 0 },
    ]);
  });

  it('splits by the UTC day of the delivery and clips to the window', () => {
    seed();
    expect(store.tabEvents.wakes(WS, { since: T0, until: T0 + 2 * DAY_MS, byDay: true })).toEqual([
      { tabId: 'tab-o', day: '2026-11-03', wakes: 3, digests: 1, urgent: 2, logged: 1 },
      { tabId: 'tab-o', day: '2026-11-04', wakes: 1, digests: 0, urgent: 1, logged: 0 },
      { tabId: 'tab-p', day: '2026-11-03', wakes: 1, digests: 1, urgent: 0, logged: 0 },
    ]);
    expect(store.tabEvents.wakes(WS, { since: T0 + 15 * MIN, until: T0 + 25 * MIN })).toEqual([
      { tabId: 'tab-o', day: null, wakes: 1, digests: 1, urgent: 0, logged: 0 },
    ]);
    expect(store.tabEvents.wakes('ws-b', { since: T0, until: T0 + 2 * DAY_MS })).toEqual([]);
  });
});

describe('curator call rows (ADR-0038 §2)', () => {
  it('are read back by curatorCalls for the workspace and window, oldest first', () => {
    store.tabEvents.append(ev({ class: 'log', kind: 'curator', text: '{"n":1}', at: T0 }));
    store.tabEvents.append(ev({ class: 'log', kind: 'curator', text: '{"n":2}', at: T0 + MIN }));
    store.tabEvents.append(ev({ class: 'log', kind: 'curator', text: '{"n":0}', at: T0 - DAY_MS }));
    store.tabEvents.append(ev({ workspaceId: 'ws-b', class: 'log', kind: 'curator', text: '{"other":1}', at: T0 }));
    store.tabEvents.append(ev({ class: 'log', kind: 'turn-marker', text: 'not a curator row', at: T0 }));
    expect(store.tabEvents.curatorCalls(WS, T0 - MIN)).toEqual(['{"n":1}', '{"n":2}']);
  });

  it('curatorCallsSince reads every workspace but the evaluation\'s, with each row\'s own time (r2 F4)', () => {
    store.tabEvents.append(ev({ class: 'log', kind: 'curator', text: '{"a":1}', at: T0 + 5 }));
    store.tabEvents.append(ev({ workspaceId: 'ws-b', class: 'log', kind: 'curator', text: '{"b":1}', at: T0 + 7 }));
    store.tabEvents.append(ev({ workspaceId: '_curator-eval', class: 'log', kind: 'curator', text: '{"e":1}', at: T0 + 9 }));
    expect(store.tabEvents.curatorCallsSince(T0, '_curator-eval')).toEqual([
      { workspaceId: WS, at: T0 + 5, text: '{"a":1}' }, { workspaceId: 'ws-b', at: T0 + 7, text: '{"b":1}' },
    ]);
  });

  it('never count as a logged event sent to the tab', () => {
    store.tabEvents.append(ev({ class: 'log', kind: 'curator', text: '{}', at: T0 }));
    store.tabEvents.append(ev({ class: 'log', kind: 'turn-marker', text: 'held then retired', at: T0 }));
    expect(store.tabEvents.wakes(WS, { since: T0 - MIN, until: T0 + MIN })).toEqual([
      { tabId: 'tab-o', day: null, wakes: 0, digests: 0, urgent: 0, logged: 1 },
    ]);
  });
});

describe('the effect count never reads a curator call as a firing (ADR-0038; story 15 merge, M2)', () => {
  it('recordedCounts leaves the curator log rows out, and computeEffects shows no curator component', async () => {
    const { computeEffects } = await import('@/lib/effects');
    store.tabEvents.append(ev({ class: 'log', kind: 'curator', text: '{"task":"flag-owner-question"}', at: T0 + MIN }));
    store.tabEvents.append(ev({ class: 'log', kind: 'curator', text: '{"task":"classify-owner-message"}', at: T0 + 2 * MIN }));
    store.tabEvents.append(ev({ class: 'urgent', kind: 'turn-marker', text: 'DONE: x', at: T0 + 3 * MIN }));
    store.tabEvents.append(ev({ class: 'log', kind: 'turn-marker', text: 'held then retired', at: T0 + 4 * MIN }));
    const fired = store.tabEvents.recordedCounts(WS, T0, T0 + 10 * MIN);
    expect(fired.map((f) => f.kind)).toEqual(['turn-marker']);
    expect(fired[0].count).toBe(2);
    const rows = computeEffects({
      workspaceId: WS, requestedSince: T0, until: T0 + 10 * MIN, measuredSince: T0, fired, deliveries: [], turns: [], openTurns: new Map(), tabExists: () => true,
    });
    expect(rows.rows.map((r) => r.component)).not.toContain('curator');
    expect(JSON.stringify(rows)).not.toMatch(/"component":"other"[^}]*"fired":2/);
  });
});
