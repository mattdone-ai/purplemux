import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, LEDGER_SILENT_MS, clippedMs } from '@/lib/ledger';
import { LedgerStore, LedgerStoreError, RETENTION_CHUNK } from '@/lib/ledger-store';
import type { ILedgerEventInput, ILedgerExperimentInput, TLedgerItemType, TLedgerKind, TLedgerWaitReason } from '@/types/ledger';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const WS = 'ws-a';

let dir: string;
let store: LedgerStore;

const ev = (
  id: string, at: number, key: string, kind: TLedgerKind, extra: Partial<ILedgerEventInput> = {},
): ILedgerEventInput => ({
  event_id: id, at, item_type: key.slice(0, key.indexOf(':')) as TLedgerItemType, item_key: key, kind,
  state: null, wait_reason: null, holder: null, clear_input: null, parent_key: null, attrs: null, ...extra,
});

const wait = (id: string, at: number, key: string, reason: TLedgerWaitReason, holder: string | null = null) =>
  ev(id, at, key, 'wait', { wait_reason: reason, holder });

/** Only an open creates an item (ADR-0033 §3.7): the fixed cases open each item at its first event. */
const op = (key: string, at: number) => ev(`open:${key}:${at}`, at, key, 'open');

const append = (events: ILedgerEventInput[], producer = 'v2', ws = WS) => store.append(ws, producer, events, events.at(-1)!.at);

type TInterval = [key: string, reason: string, holder: string | null, start: number, end: number];

const storedIntervals = (since = 0, until = Number.MAX_SAFE_INTEGER, ws = WS): TInterval[] =>
  store.intervalsIn(ws, since, until).map((row) => [row.item_key, row.reason, row.holder, row.start, row.end]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-ledger-store-'));
  store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ledger.sqlite (AC 1)', () => {
  it('is WAL, 0600, user_version 1, with the six tables and the ADR columns', () => {
    expect(store.pragma('journal_mode')).toBe('wal');
    expect(store.pragma('user_version')).toBe(1);
    expect(fs.statSync(path.join(dir, 'ledger.sqlite')).mode & 0o777).toBe(0o600);
    expect(store.columns('events')).toEqual(['seq', 'event_id', 'workspace_id', 'at', 'received_at', 'producer', 'item_type',
      'item_key', 'kind', 'state', 'wait_reason', 'holder', 'clear_input', 'parent_key', 'attrs_json', 'event_key', 'body_digest']);
    expect(store.columns('items')).toEqual(['workspace_id', 'item_key', 'item_type', 'opened_at', 'closed_at', 'state',
      'state_since', 'wait_reason', 'wait_since', 'holder', 'clear_input', 'parent_key', 'attrs_json', 'last_seq', 'last_event_at']);
    expect(store.columns('intervals')).toEqual(['id', 'workspace_id', 'item_key', 'item_type', 'reason', 'holder', 'start', 'end']);
    expect(store.columns('rollups_daily')).toEqual(['workspace_id', 'day', 'item_type', 'reason', 'waited_ms', 'items', 'p50_ms', 'p90_ms']);
    // ADR-0035 adds the event's source tab to ADR-0033's columns, and story 15 a flag's rule (ADR-0035 §7).
    expect(store.columns('tab_events')).toEqual(['seq', 'workspace_id', 'tab_id', 'at', 'class', 'kind', 'text', 'delivered_at', 'digest_id',
      'source_tab_id', 'source_tab_name', 'rule']);
    expect(store.columns('tab_turns')).toEqual(['id', 'workspace_id', 'tab_id', 'provider', 'started_at', 'ended_at', 'tool_calls']);
    expect(store.columns('experiments')).toEqual(expect.arrayContaining(['workspace_id', 'id', 'hypothesis', 'change_ref', 'stage',
      'reason', 'metric', 'baseline_json', 'target', 'guards_json', 'revert_if', 'min_days', 'max_days', 'started_at', 'verdict',
      'verdict_at', 'evidence']));
  });

  it('reopens an existing file without migrating again and refuses a newer schema', () => {
    append([ev('e1', T0, 'range:a:1', 'open')]);
    store.close();
    store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
    expect(store.counts().events).toBe(1);
    store.close();
    const raw = new Database(path.join(dir, 'ledger.sqlite'));
    raw.pragma('user_version = 2');
    raw.close();
    expect(() => new LedgerStore(path.join(dir, 'ledger.sqlite'))).toThrow('unsupported ledger schema 2');
    store = new LedgerStore(':memory:');
  });

  it('closes its handle when it refuses a newer schema, so repeated tries leave no descriptor open', () => {
    store.close();
    const raw = new Database(path.join(dir, 'ledger.sqlite'));
    raw.pragma('user_version = 2');
    raw.close();
    // Only descriptors on this ledger file: a count of every fd moves with whatever else the worker opens.
    const open = () => fs.readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(path.join(dir, 'ledger.sqlite'));
      } catch {
        return false;
      }
    }).length;
    const before = open();
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => new LedgerStore(path.join(dir, 'ledger.sqlite'))).toThrow('unsupported ledger schema 2');
    }
    expect(open()).toBe(before);
    store = new LedgerStore(':memory:');
  });
});

describe('append (AC 2, AC 6)', () => {
  const batch = (): ILedgerEventInput[] => [
    ev('e1', T0, 'range:a:1', 'open', { holder: 'lane-a', attrs: { lane: 'a' } }),
    wait('e2', T0 + 5 * MIN, 'range:a:1', 'not-armed', 'lane-a'),
    ev('e3', T0 + 25 * MIN, 'range:a:1', 'state', { state: 'armed' }),
    wait('e4', T0 + 26 * MIN, 'range:a:1', 'review-queue'),
    ev('e5', T0 + 90 * MIN, 'range:a:1', 'close', { state: 'landed' }),
  ];

  it('replaying the same batch gives identical items and intervals; event_id is idempotent', () => {
    const first = append(batch());
    const items = store.items(WS, {}, T0 + 100 * MIN);
    const intervals = storedIntervals();
    const replay = append(batch());
    expect(first).toMatchObject({ accepted: 5, duplicates: 0, intervals: 2 });
    expect(replay).toMatchObject({ accepted: 0, duplicates: 5, intervals: 0 });
    expect(store.items(WS, {}, T0 + 100 * MIN)).toEqual(items);
    expect(storedIntervals()).toEqual(intervals);
    expect(store.counts().events).toBe(5);
  });

  it('writes each wait interval in the transaction of the event that ends it', () => {
    append(batch().slice(0, 3));
    expect(storedIntervals()).toEqual([['range:a:1', 'not-armed', 'lane-a', T0 + 5 * MIN, T0 + 25 * MIN]]);
    append(batch().slice(3));
    expect(storedIntervals()).toEqual([
      ['range:a:1', 'not-armed', 'lane-a', T0 + 5 * MIN, T0 + 25 * MIN],
      ['range:a:1', 'review-queue', 'lane-a', T0 + 26 * MIN, T0 + 90 * MIN],
    ]);
    expect(store.items(WS, {}, T0 + 100 * MIN).items[0]).toMatchObject({
      itemKey: 'range:a:1', itemType: 'range', closedAt: T0 + 90 * MIN, state: 'landed', waitReason: null, holder: 'lane-a',
      attrs: { lane: 'a' },
    });
  });

  it('keeps one event_id space per workspace and producer', () => {
    append([ev('e1', T0, 'range:a:1', 'open')]);
    expect(append([ev('e1', T0, 'range:b:1', 'open')], 'v2', 'ws-b')).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(append([ev('e1', T0, 'range:c:1', 'open')], 'feed')).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(append([ev('e1', T0, 'range:a:1', 'open')], 'v2')).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('refuses the same event_id with a different body, naming it, and stores nothing of the batch', () => {
    append([ev('e1', T0, 'range:a:1', 'open', { attrs: { a: 1, b: 2 } })]);
    expect(append([ev('e1', T0, 'range:a:1', 'open', { attrs: { b: 2, a: 1 } })])).toMatchObject({ duplicates: 1 });
    let refused: unknown;
    try {
      append([ev('e2', T0 + MIN, 'range:a:1', 'state', { state: 'armed' }), ev('e1', T0 + MIN, 'range:a:1', 'open')]);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(LedgerStoreError);
    expect(refused).toMatchObject({ code: 'ledger-event-conflict', field: 'events[1].event_id',
      message: 'events[1].event_id: "e1" is already stored for producer v2 with a different body' });
    expect(store.counts().events).toBe(1);
  });

  it('a repeated wait with the same reason and holder continues the open wait', () => {
    append([
      op('range:a:1', T0),
      wait('e1', T0, 'range:a:1', 'not-armed', 'lane-a'),
      wait('e2', T0 + 5 * MIN, 'range:a:1', 'not-armed', 'lane-a'),
      wait('e3', T0 + 9 * MIN, 'range:a:1', 'not-armed'),
      wait('e4', T0 + 12 * MIN, 'range:a:1', 'not-armed', 'lane-b'),
      ev('e5', T0 + 20 * MIN, 'range:a:1', 'clear'),
    ]);
    expect(storedIntervals()).toEqual([
      ['range:a:1', 'not-armed', 'lane-a', T0, T0 + 12 * MIN],
      ['range:a:1', 'not-armed', 'lane-b', T0 + 12 * MIN, T0 + 20 * MIN],
    ]);
  });

  it('a state event ends an open wait', () => {
    append([op('range:a:1', T0), wait('e1', T0, 'range:a:1', 'pre-arm-gate'), ev('e2', T0 + 3 * MIN, 'range:a:1', 'state', { state: 'armed' })]);
    expect(storedIntervals()).toEqual([['range:a:1', 'pre-arm-gate', null, T0, T0 + 3 * MIN]]);
  });

  it('a late event never writes a negative interval: time runs forward per item', () => {
    append([op('range:a:1', T0 + 10 * MIN), wait('e1', T0 + 10 * MIN, 'range:a:1', 'lock-wait'), ev('e2', T0, 'range:a:1', 'clear')]);
    expect(storedIntervals()).toEqual([]);
    expect(store.items(WS, {}, T0 + 11 * MIN).items[0]).toMatchObject({ waitReason: null, lastEventAt: T0 + 10 * MIN });
  });

  it('stores an event for a closed item without changing it, and reopens it on an open after the close', () => {
    append([op('range:a:1', T0), ev('e1', T0, 'range:a:1', 'close', { state: 'dropped' })]);
    expect(append([wait('e2', T0 + MIN, 'range:a:1', 'rework')])).toMatchObject({ accepted: 1, closedItem: 1 });
    expect(store.items(WS, {}, T0 + 2 * MIN).items[0]).toMatchObject({ closedAt: T0, waitReason: null });
    append([ev('e3', T0 + 3 * MIN, 'range:a:1', 'open')]);
    expect(store.items(WS, {}, T0 + 4 * MIN).items[0]).toMatchObject({ closedAt: null, openedAt: T0 + 3 * MIN, state: 'dropped' });
  });

  it('a late open, at or before the close, does not reopen the item in the past', () => {
    append([ev('e1', T0, 'range:a:1', 'open'), ev('e2', T0 + 30 * MIN, 'range:a:1', 'close', { state: 'landed' })]);
    expect(append([ev('e3', T0 + 10 * MIN, 'range:a:1', 'open'), ev('e4', T0 + 30 * MIN, 'range:a:1', 'open', { holder: 'x' })]))
      .toMatchObject({ accepted: 2, closedItem: 2 });
    expect(store.items(WS, {}, T0 + 40 * MIN).items[0]).toMatchObject({ openedAt: T0, closedAt: T0 + 30 * MIN });
  });
});

describe('derived reasons (AC 7)', () => {
  it('splits a land-queue wait into lock-busy and head-blocked from the open landing item', () => {
    append([
      op('range:a:1', T0),
      wait('e1', T0, 'range:a:1', 'land-queue', 'lane-a'),
      ev('e2', T0 + 10 * MIN, 'landing:100', 'open'),
      op('range:b:1', T0 + 15 * MIN),
      wait('e3', T0 + 15 * MIN, 'range:b:1', 'land-queue', 'lane-b'),
      ev('e4', T0 + 40 * MIN, 'landing:100', 'close', { state: 'landed' }),
      ev('e5', T0 + 50 * MIN, 'range:a:1', 'clear'),
      wait('e6', T0 + 55 * MIN, 'range:b:1', 'land-queue', 'lane-b'),
      ev('e7', T0 + 60 * MIN, 'range:b:1', 'clear'),
    ]);
    expect(storedIntervals()).toEqual([
      ['range:a:1', 'land-queue/head-blocked', 'lane-a', T0, T0 + 10 * MIN],
      ['range:a:1', 'land-queue/lock-busy', 'lane-a', T0 + 10 * MIN, T0 + 40 * MIN],
      ['range:b:1', 'land-queue/lock-busy', 'lane-b', T0 + 15 * MIN, T0 + 40 * MIN],
      ['range:a:1', 'land-queue/head-blocked', 'lane-a', T0 + 40 * MIN, T0 + 50 * MIN],
      ['range:b:1', 'land-queue/head-blocked', 'lane-b', T0 + 40 * MIN, T0 + 60 * MIN],
    ]);
  });

  it('an open item with no wait and no event for more than 10 min reads unknown, from its last event', () => {
    append([ev('e1', T0, 'range:a:1', 'open'), ev('e2', T0 + 2 * MIN, 'range:a:1', 'state', { state: 'staged' })]);
    expect(store.items(WS, {}, T0 + 12 * MIN).items[0]).toMatchObject({ waitReason: null, waitSince: null });
    expect(store.items(WS, {}, T0 + 12 * MIN + 1).items[0]).toMatchObject({ waitReason: 'unknown', waitSince: T0 + 2 * MIN });
    expect(store.waits(WS, { since: T0, until: T0 + 30 * MIN, by: 'reason' }, T0 + 30 * MIN).rows).toEqual([
      { key: 'unknown', waitedMs: 0, finished: 0, p50Ms: null, p90Ms: null, openItems: 1, openWaitedMs: 28 * MIN },
    ]);
    append([wait('e3', T0 + 40 * MIN, 'range:a:1', 'review-queue')]);
    expect(storedIntervals()).toEqual([['range:a:1', 'unknown', null, T0 + 2 * MIN, T0 + 40 * MIN]]);
  });

  it('a gap of exactly 10 min writes nothing; a link does not move the last event time', () => {
    append([
      ev('e1', T0, 'range:a:1', 'open'),
      ev('e2', T0 + LEDGER_SILENT_MS, 'range:a:1', 'state', { state: 'staged' }),
      ev('e3', T0 + 15 * MIN, 'range:a:1', 'link', { parent_key: 'slice:a' }),
      ev('e4', T0 + 22 * MIN, 'range:a:1', 'state', { state: 'armed' }),
    ]);
    expect(storedIntervals()).toEqual([['range:a:1', 'unknown', null, T0 + 10 * MIN, T0 + 22 * MIN]]);
    expect(store.items(WS, {}, T0 + 23 * MIN).items[0]).toMatchObject({ parentKey: 'slice:a', lastEventAt: T0 + 22 * MIN });
  });

  it('only a wait-life type reads unknown: a range silent 11 min does, a gate running 23 min after its slot does not', () => {
    append([
      op('range:a:1', T0),
      op('gate:t:1', T0), wait('g1', T0, 'gate:t:1', 'gate-slot'), ev('g2', T0 + 2 * MIN, 'gate:t:1', 'clear'),
      ev('g3', T0 + 25 * MIN, 'gate:t:1', 'close', { state: 'passed' }),
      op('landing:1', T0 + MIN), ev('l2', T0 + 15 * MIN, 'landing:1', 'close'),
    ]);
    expect(store.items(WS, { type: 'range' }, T0 + 11 * MIN).items[0]).toMatchObject({ waitReason: 'unknown', waitSince: T0 });
    append([ev('r2', T0 + 11 * MIN, 'range:a:1', 'state', { state: 'armed' })]);
    expect(storedIntervals()).toEqual([
      ['gate:t:1', 'gate-slot', null, T0, T0 + 2 * MIN],
      ['range:a:1', 'unknown', null, T0, T0 + 11 * MIN],
    ]);
  });

  it('an experiment open for 7 days writes no unknown interval and shows no open WIP', () => {
    const experiment = store.openExperiment(WS, { hypothesis: 'h', change_ref: null, stage: 'land', reason: null, metric: 'm',
      baseline: null, target: null, guards: [], revert_if: null, min_days: 7, max_days: 7 }, T0);
    const mid = T0 + 3 * DAY_MS;
    expect(store.items(WS, { type: 'experiment' }, mid).items[0]).toMatchObject({ waitReason: null, waitSince: null });
    expect(store.waits(WS, { since: T0, until: mid, by: 'type' }, mid).rows).toEqual([]);
    store.closeExperiment(WS, experiment.id, 'keep', 'held', T0 + 7 * DAY_MS);
    expect(storedIntervals()).toEqual([]);
  });

  it('limits waits to one item type when asked', () => {
    append([op('range:a:1', T0), wait('r1', T0, 'range:a:1', 'not-armed'), ev('r2', T0 + 5 * MIN, 'range:a:1', 'clear'),
      op('gate:t:1', T0), wait('g1', T0, 'gate:t:1', 'gate-slot'), ev('g2', T0 + 3 * MIN, 'gate:t:1', 'clear')]);
    const window = { since: T0, until: T0 + 6 * MIN, by: 'reason' as const };
    expect(store.waits(WS, { ...window, type: 'gate' }, T0 + 6 * MIN).rows.map((row) => [row.key, row.waitedMs])).toEqual([['gate-slot', 3 * MIN]]);
    expect(store.waits(WS, window, T0 + 6 * MIN).rows.map((row) => row.key)).toEqual(['not-armed', 'gate-slot']);
  });

  it('an event for an item the ledger does not hold is an orphan: stored, no item created, also after retention', async () => {
    expect(append([wait('x1', T0, 'range:x:1', 'owner'), ev('x2', T0 + MIN, 'range:x:1', 'close')])).toMatchObject({ accepted: 2, orphan: 2 });
    expect(store.items(WS, {}, T0 + 2 * MIN).items).toEqual([]);
    expect(store.counts().events).toBe(2);
    append([op('range:y:1', T0), ev('y2', T0 + MIN, 'range:y:1', 'close')]);
    const now = T0 + 93 * DAY_MS;
    await store.runRetention(now);
    expect(store.items(WS, {}, now).items).toEqual([]);
    expect(append([ev('y3', now - DAY_MS, 'range:y:1', 'clear')])).toMatchObject({ accepted: 1, orphan: 1 });
    expect(store.items(WS, {}, now).items).toEqual([]);
    expect(store.waits(WS, { since: now - 7 * DAY_MS, until: now, by: 'reason' }, now).rows).toEqual([]);
  });

  it('a known wait left silent for 12 h still reads its reason', () => {
    append([op('range:a:1', T0), wait('e1', T0, 'range:a:1', 'review-queue', 'lane-a')]);
    const later = T0 + 12 * 60 * MIN;
    expect(store.items(WS, { open: true }, later).items[0]).toMatchObject({ waitReason: 'review-queue', waitSince: T0 });
    expect(store.waits(WS, { since: T0, until: later, by: 'reason' }, later).rows.map((row) => row.key)).toEqual(['review-queue']);
  });
});

describe('reads (AC 9)', () => {
  beforeEach(() => {
    append([
      ev('e1', T0, 'range:a:1', 'open', { holder: 'lane-a' }),
      wait('e2', T0 + MIN, 'range:a:1', 'not-armed'),
      ev('e3', T0 + 2 * MIN, 'gate:abc:1', 'open', { holder: 'gate-host' }),
      wait('e4', T0 + 3 * MIN, 'gate:abc:1', 'gate-slot'),
      ev('e5', T0 + 9 * MIN, 'gate:abc:1', 'close'),
      ev('e6', T0 + 4 * MIN, 'range:b:1', 'open', { holder: 'lane-b' }),
    ]);
  });

  it('filters items by open, type and holder', () => {
    const now = T0 + 5 * MIN;
    expect(store.items(WS, {}, now).items.map((item) => item.itemKey)).toEqual(['range:a:1', 'gate:abc:1', 'range:b:1']);
    expect(store.items(WS, { open: true }, now).items.map((item) => item.itemKey)).toEqual(['range:a:1', 'range:b:1']);
    expect(store.items(WS, { type: 'gate' }, now).items.map((item) => item.itemKey)).toEqual(['gate:abc:1']);
    expect(store.items(WS, { holder: 'lane-b' }, now).items.map((item) => item.itemKey)).toEqual(['range:b:1']);
    expect(store.items(WS, { limit: 2 }, now)).toMatchObject({ truncated: true, items: [{ itemKey: 'range:a:1' }, { itemKey: 'gate:abc:1' }] });
    expect(store.items('ws-other', {}, now).items).toEqual([]);
  });

  it('groups waits by reason, holder, type and stage, with p50, p90 and open WIP', () => {
    const now = T0 + 11 * MIN;
    const window = { since: T0, until: now };
    expect(store.waits(WS, { ...window, by: 'reason' }, now)).toEqual({
      rows: [
        { key: 'not-armed', waitedMs: 0, finished: 0, p50Ms: null, p90Ms: null, openItems: 1, openWaitedMs: 10 * MIN },
        { key: 'gate-slot', waitedMs: 6 * MIN, finished: 1, p50Ms: 6 * MIN, p90Ms: 6 * MIN, openItems: 0, openWaitedMs: 0 },
      ],
      totals: { waitedMs: 6 * MIN, finished: 1, p50Ms: 6 * MIN, p90Ms: 6 * MIN, openItems: 1, openWaitedMs: 10 * MIN },
    });
    expect(store.waits(WS, { ...window, by: 'holder' }, now).rows.map((row) => row.key)).toEqual(['lane-a', 'gate-host']);
    expect(store.waits(WS, { ...window, by: 'type' }, now).rows.map((row) => row.key)).toEqual(['range', 'gate']);
    expect(store.waits(WS, { ...window, by: 'stage' }, now).rows.map((row) => [row.key, row.waitedMs + row.openWaitedMs]))
      .toEqual([['land', 16 * MIN]]);
  });

  it('answers an empty window with no rows and zero totals, percentiles null', () => {
    expect(store.waits('ws-none', { since: T0, until: T0 + MIN, by: 'holder' }, T0 + MIN)).toEqual({
      rows: [], totals: { waitedMs: 0, finished: 0, p50Ms: null, p90Ms: null, openItems: 0, openWaitedMs: 0 },
    });
  });

  it('clips every wait to the window', () => {
    const now = T0 + 11 * MIN;
    const rows = store.waits(WS, { since: T0 + 5 * MIN, until: T0 + 7 * MIN, by: 'reason' }, now).rows;
    expect(rows).toEqual([
      { key: 'gate-slot', waitedMs: 2 * MIN, finished: 0, p50Ms: null, p90Ms: null, openItems: 0, openWaitedMs: 0 },
      { key: 'not-armed', waitedMs: 0, finished: 0, p50Ms: null, p90Ms: null, openItems: 1, openWaitedMs: 2 * MIN },
    ]);
  });
});

// A seeded generator, so a failing sequence is reproduced by its seed.
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const REASONS: TLedgerWaitReason[] = ['not-armed', 'land-queue', 'lock-wait', 'review-queue', 'owner'];
const HOLDERS = [null, 'lane-a', 'lane-b'];

const randomEvents = (random: () => number, count: number): ILedgerEventInput[] => {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const keys = ['range:a:1', 'range:a:2', 'range:b:1', 'slice:c', 'landing:1', 'landing:2'];
  const events: ILedgerEventInput[] = [];
  let clock = T0;
  for (let index = 0; index < count; index++) {
    clock += Math.floor(random() * 25 * MIN);
    // A third of the events arrive late: producers and spools deliver out of order across items.
    const at = random() < 0.3 ? clock - Math.floor(random() * 120 * MIN) : clock;
    const key = pick(keys);
    if (key.startsWith('landing:')) {
      events.push(ev(`e${index}`, at, key, pick(['open', 'close', 'state'] as const), { state: 'held' }));
      continue;
    }
    const kind = pick(['open', 'state', 'wait', 'wait', 'wait', 'clear', 'close', 'link'] as const);
    events.push(ev(`e${index}`, at, key, kind, {
      state: kind === 'state' || kind === 'close' ? 'x' : null,
      wait_reason: kind === 'wait' ? pick(REASONS) : null,
      holder: pick(HOLDERS),
      parent_key: kind === 'link' ? 'slice:c' : null,
    }));
  }
  return events;
};

interface IReference {
  intervals: TInterval[];
  /** Per item: no-wait gaps of 10 min or less (counted nowhere), the summed lifetimes, the current life. */
  items: Map<string, { uncovered: number; lifetimes: number; opened: number; closed: number | null }>;
}

/** An independent replay of the ruling, kept deliberately naive: the store must agree with it. */
const reference = (events: ILedgerEventInput[]): IReference => {
  interface IRef { type: string; closed: number | null; opened: number; wait: string | null; since: number; holder: string | null; last: number; uncovered: number; lifetimes: number }
  const items = new Map<string, IRef>();
  const out: TInterval[] = [];
  const push = (key: string, reason: string, holder: string | null, start: number, end: number) => {
    if (end > start) out.push([key, reason, holder, start, end]);
  };
  const landQueue = () => ([...items.values()].some((item) => item.type === 'landing' && item.closed === null)
    ? 'land-queue/lock-busy' : 'land-queue/head-blocked');
  for (const event of events) {
    const key = event.item_key;
    let item = items.get(key);
    if (!item && event.kind !== 'open') continue;
    if (item && item.closed !== null && !(event.kind === 'open' && event.at > item.closed)) continue;
    const fresh = !item || item.closed !== null;
    const at = fresh ? event.at : Math.max(event.at, item!.last, item!.since);
    if (fresh) {
      item = { type: event.item_type, closed: null, opened: at, wait: null, since: 0, holder: item?.holder ?? null, last: at,
        uncovered: item?.uncovered ?? 0, lifetimes: item?.lifetimes ?? 0 };
      items.set(key, item);
    }
    const it = item!;
    const holder = event.holder ?? it.holder;
    if (event.kind !== 'link' && !fresh && it.wait === null) {
      if (at - it.last > LEDGER_SILENT_MS && ['range', 'deploy', 'owner-issue'].includes(it.type)) push(key, 'unknown', it.holder, it.last, at);
      else it.uncovered += at - it.last;
    }
    const same = event.kind === 'wait' && it.wait !== null && holder === it.holder
      && (event.wait_reason === 'land-queue' ? it.wait.startsWith('land-queue/') : event.wait_reason === it.wait);
    if (it.wait !== null && ['wait', 'state', 'clear', 'close'].includes(event.kind) && !same) {
      push(key, it.wait, it.holder, it.since, at);
      it.wait = null;
    }
    it.holder = holder;
    if (event.kind !== 'link') it.last = at;
    if (event.kind === 'wait' && !same) {
      it.wait = event.wait_reason === 'land-queue' ? landQueue() : event.wait_reason!;
      it.since = at;
    }
    if (event.kind === 'close') {
      it.closed = at;
      it.lifetimes += at - it.opened;
    }
    if (it.type === 'landing' && (fresh || event.kind === 'close')) {
      const reason = landQueue();
      for (const [otherKey, other] of [...items.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (other.closed !== null || !other.wait?.startsWith('land-queue/') || other.wait === reason) continue;
        const since = Math.max(at, other.since, other.last);
        push(otherKey, other.wait, other.holder, other.since, since);
        other.wait = reason;
        other.since = since;
        other.last = since;
      }
    }
  }
  return {
    intervals: out,
    items: new Map([...items.entries()].map(([key, it]) => [key, { uncovered: it.uncovered, lifetimes: it.lifetimes, opened: it.opened, closed: it.closed }])),
  };
};

const sortIntervals = (list: TInterval[]): TInterval[] => [...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

describe('property: waits equal the clipped intervals (AC 6)', () => {
  it('for random out-of-order sequences: intervals match a reference replay, never overlap, fill each closed lifetime, and waits sum them', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = mulberry32(seed);
      store.close();
      store = new LedgerStore(':memory:');
      const events = randomEvents(random, 20 + Math.floor(random() * 80));
      for (let start = 0; start < events.length;) {
        const size = 1 + Math.floor(random() * 12);
        append(events.slice(start, start + size));
        start += size;
      }
      const intervals = storedIntervals(-Number.MAX_SAFE_INTEGER);
      const expected = reference(events);
      expect(sortIntervals(intervals), `seed ${seed}`).toEqual(sortIntervals(expected.intervals));
      const items = new Map(store.items(WS, {}, T0).items.map((item) => [item.itemKey, item]));
      for (const [key, ref] of expected.items) {
        const own = intervals.filter((interval) => interval[0] === key);
        for (const [, , , start, end] of own) {
          expect(own.filter((other) => other[3] < end && other[4] > start).length, `seed ${seed} overlap on ${key}`).toBe(1);
        }
        expect(items.get(key), `seed ${seed} ${key}`).toMatchObject({ openedAt: ref.opened, closedAt: ref.closed });
        if (ref.closed === null) continue;
        const waited = own.reduce((sum, [, , , start, end]) => sum + end - start, 0);
        expect(waited, `seed ${seed} ${key} within its lifetime`).toBeLessThanOrEqual(ref.lifetimes);
        expect(waited + ref.uncovered, `seed ${seed} ${key} fills its lifetime`).toBe(ref.lifetimes);
      }
      const ats = events.map((event) => event.at);
      const first = Math.min(...ats);
      const last = Math.max(...ats);
      for (let w = 0; w < 5; w++) {
        const since = first + Math.floor(random() * (last - first + 1));
        const until = since + 1 + Math.floor(random() * (last - since + 60 * MIN));
        const sums = new Map<string, number>();
        for (const [, reason, , start, end] of intervals) {
          if (end > since && start < until) sums.set(reason, (sums.get(reason) ?? 0) + clippedMs(start, end, since, until));
        }
        const view = store.waits(WS, { since, until, by: 'reason' }, last);
        const got = new Map(view.rows.map((row) => [row.key!, row.waitedMs]));
        for (const [reason, ms] of sums) expect(got.get(reason), `seed ${seed} ${reason} [${since},${until})`).toBe(ms);
        expect(view.totals.waitedMs, `seed ${seed} total`).toBe([...sums.values()].reduce((a, b) => a + b, 0));
      }
    }
  });

  it('a late event for an item split by a landing lands at the split, not before it (round 2 probe A)', () => {
    append([
      op('range:a:1', T0),
      wait('e1', T0, 'range:a:1', 'land-queue'),
      ev('e2', T0 + 100 * MIN, 'landing:1', 'open'),
      ev('e3', T0 + 50 * MIN, 'range:a:1', 'clear'),
      wait('e4', T0 + 60 * MIN, 'range:a:1', 'review-queue'),
      ev('e5', T0 + 70 * MIN, 'range:a:1', 'close'),
    ]);
    const own = storedIntervals().filter(([key]) => key === 'range:a:1');
    expect(own).toEqual([['range:a:1', 'land-queue/head-blocked', null, T0, T0 + 100 * MIN]]);
    expect(store.items(WS, { type: 'range' }, T0).items[0]).toMatchObject({ openedAt: T0, closedAt: T0 + 100 * MIN });
  });

  it('a closed item whose no-wait gaps all exceed 10 min sums its intervals to its lifetime', () => {
    append([
      ev('e1', T0, 'range:a:1', 'open'),
      wait('e2', T0 + 11 * MIN, 'range:a:1', 'not-armed'),
      ev('e3', T0 + 30 * MIN, 'range:a:1', 'state', { state: 'armed' }),
      wait('e4', T0 + 45 * MIN, 'range:a:1', 'land-queue'),
      ev('e5', T0 + 47 * MIN, 'landing:1', 'open'),
      ev('e6', T0 + 80 * MIN, 'range:a:1', 'close', { state: 'landed' }),
    ]);
    const lifetime = storedIntervals().filter(([key]) => key === 'range:a:1').reduce((sum, [, , , start, end]) => sum + end - start, 0);
    expect(lifetime).toBe(80 * MIN);
  });
});

describe('experiments (ADR-HFL-03)', () => {
  const input = (overrides: Partial<ILedgerExperimentInput> = {}): ILedgerExperimentInput => ({
    hypothesis: 'one gate outside the lock halves lock hours', change_ref: 'acme-ledger-v2#1', stage: 'land', reason: 'under-lock-gate',
    metric: 'lock-hours', baseline: { value: 13, window: '7d' }, target: 6, guards: [{ metric: 'red-mains', limit: 1 }],
    revert_if: 'red mains above 1 a day', min_days: 3, max_days: 7, ...overrides,
  });

  it('opens EXP-n as an experiment item, at most one per stage and two in all, and closes it with a verdict', () => {
    const first = store.openExperiment(WS, input(), T0);
    expect(first).toMatchObject({ id: 'EXP-1', itemKey: 'experiment:EXP-1', stage: 'land', startedAt: T0, verdict: null });
    expect(store.items(WS, { type: 'experiment' }, T0).items[0]).toMatchObject({ itemKey: 'experiment:EXP-1', closedAt: null });
    expect(() => store.openExperiment(WS, input(), T0)).toThrow(/stage land already has active experiment EXP-1/);
    store.openExperiment(WS, input({ stage: 'deploy' }), T0 + 1);
    let capped: unknown;
    try { store.openExperiment(WS, input({ stage: 'people' }), T0 + 2); } catch (error) { capped = error; }
    expect(capped).toBeInstanceOf(LedgerStoreError);
    expect(capped).toMatchObject({ code: 'ledger-experiment-cap', message: expect.stringContaining('EXP-1, EXP-2') });
    const closed = store.closeExperiment(WS, 'EXP-1', 'revert', 'lock hours did not fall', T0 + DAY_MS);
    expect(closed).toMatchObject({ verdict: 'revert', verdictAt: T0 + DAY_MS, evidence: 'lock hours did not fall' });
    expect(store.items(WS, { type: 'experiment' }, T0 + DAY_MS).items[0]).toMatchObject({ closedAt: T0 + DAY_MS, state: 'reverted' });
    expect(() => store.closeExperiment(WS, 'EXP-1', 'keep', 'x', T0 + DAY_MS)).toThrow(/already has the verdict revert/);
    expect(() => store.closeExperiment(WS, 'EXP-9', 'keep', 'x', T0)).toThrow(/no experiment EXP-9/);
    expect(store.openExperiment(WS, input({ stage: 'people' }), T0 + DAY_MS + 1).id).toBe('EXP-3');
    expect(store.experiments(WS).map((experiment) => experiment.id)).toEqual(['EXP-1', 'EXP-2', 'EXP-3']);
    expect(store.experiments('ws-b')).toEqual([]);
  });

  it('extends an active experiment once, keeps max_days at most 90, and records a state event (story 22)', () => {
    store.openExperiment(WS, input({ min_days: 3, max_days: 7 }), T0);
    expect(store.experiments(WS)[0]).toMatchObject({ extendedAt: null, extensionDays: null, extensionEvidence: null });
    const extended = store.extendExperiment(WS, 'EXP-1', 3, 're-gates still noisy', T0 + 7 * DAY_MS);
    expect(extended).toMatchObject({ maxDays: 10, extendedAt: T0 + 7 * DAY_MS, extensionDays: 3, extensionEvidence: 're-gates still noisy' });
    expect(store.items(WS, { type: 'experiment' }, T0 + 7 * DAY_MS).items[0]).toMatchObject({ state: 'extended', closedAt: null });
    let again: unknown;
    try { store.extendExperiment(WS, 'EXP-1', 1, 'more', T0 + 8 * DAY_MS); } catch (error) { again = error; }
    expect(again).toMatchObject({ code: 'ledger-experiment-extended', message: expect.stringContaining('extended once already, by 3 days') });
    expect(store.experiments(WS)[0].maxDays).toBe(10);

    store.openExperiment(WS, input({ stage: 'deploy', min_days: 30, max_days: 85 }), T0);
    let capped: unknown;
    try { store.extendExperiment(WS, 'EXP-2', 6, 'long', T0); } catch (error) { capped = error; }
    expect(capped).toMatchObject({ code: 'ledger-experiment-cap', field: 'days', message: 'max_days 85 + 6 = 91, at most 90' });
    expect(store.extendExperiment(WS, 'EXP-2', 5, 'to the cap', T0).maxDays).toBe(90);

    store.closeExperiment(WS, 'EXP-1', 'keep', 'met', T0 + 9 * DAY_MS);
    expect(() => store.extendExperiment(WS, 'EXP-1', 1, 'x', T0)).toThrow(/already has the verdict keep/);
    expect(() => store.extendExperiment(WS, 'EXP-9', 1, 'x', T0)).toThrow(/no experiment EXP-9/);
  });

  it('adds the extension columns to a ledger written before them', () => {
    const file = path.join(dir, 'pre-22.sqlite');
    const first = new LedgerStore(file);
    first.openExperiment(WS, input(), T0);
    first.close();
    const raw = new Database(file);
    for (const column of ['extended_at', 'extension_days', 'extension_evidence']) raw.exec(`ALTER TABLE experiments DROP COLUMN ${column}`);
    expect((raw.prepare('SELECT name FROM pragma_table_info(?)').all('experiments') as Array<{ name: string }>).map((row) => row.name))
      .not.toContain('extended_at');
    raw.close();
    const reopened = new LedgerStore(file);
    try {
      expect(reopened.experiments(WS)[0]).toMatchObject({ id: 'EXP-1', extendedAt: null, extensionDays: null });
      expect(reopened.extendExperiment(WS, 'EXP-1', 2, 'noisy', T0 + DAY_MS).maxDays).toBe(9);
    } finally {
      reopened.close();
    }
  });
});

describe('retention and rollups (AC 8)', () => {
  it('deletes events and intervals older than 92 days, tab events older than 30 days, rollups older than 400 days', async () => {
    const now = T0 + 500 * DAY_MS;
    const old = now - 93 * DAY_MS;
    const kept = now - 91 * DAY_MS;
    const tabEvent = (at: number, text: string) =>
      store.tabEvents.append({ workspaceId: WS, tabId: 't1', at, class: 'log', kind: 'x', text });
    append([op('range:a:1', old), wait('o1', old, 'range:a:1', 'not-armed'), ev('o2', old + MIN, 'range:a:1', 'close')]);
    append([op('range:b:1', kept), wait('k1', kept, 'range:b:1', 'not-armed'), ev('k2', kept + MIN, 'range:b:1', 'close')]);
    // ADR-HFL-05 decision 3: a month of tab events, against the 92 days of the work-item record.
    tabEvent(old, 'old');
    tabEvent(now - 31 * DAY_MS, 'past a month');
    tabEvent(now - 29 * DAY_MS, 'kept');
    store.rollUp(now - 401 * DAY_MS, now - 401 * DAY_MS);
    store.rollUp(old, old);
    store.rollUp(kept, kept);
    const before = store.counts();
    const result = await store.runRetention(now);
    expect(result).toMatchObject({ events: 3, intervals: 1, tabEvents: 2, items: 1 });
    // The first pass rolls up from the earliest day a finished wait touches, clamped to the 92-day window.
    // N3: the cutoff day is never re-rolled (a second pass on one UTC day would replace it with a partial rollup).
    expect(result.rolledUpDays[0]).toBe(new Date(Math.floor((now - 92 * DAY_MS) / DAY_MS) * DAY_MS + DAY_MS).toISOString().slice(0, 10));
    expect(result.rolledUpDays.at(-1)).toBe(new Date(now - DAY_MS).toISOString().slice(0, 10));
    expect(before.rollups_daily).toBe(2);
    expect(store.counts()).toMatchObject({ events: 3, intervals: 1, tab_events: 1, items: 1 });
    expect(store.rollups(WS).map((row) => row.day)).toEqual([new Date(old).toISOString().slice(0, 10), new Date(kept).toISOString().slice(0, 10)]);
    const ancient = now - 401 * DAY_MS;
    append([op('range:c:1', ancient), wait('a1', ancient, 'range:c:1', 'owner'), ev('a2', ancient + MIN, 'range:c:1', 'clear')]);
    store.rollUp(ancient, ancient);
    expect(store.rollups(WS)).toHaveLength(3);
    await store.runRetention(now);
    expect(store.rollups(WS).filter((row) => row.day < new Date(now - 400 * DAY_MS).toISOString().slice(0, 10))).toEqual([]);
  });

  const day = (n: number) => new Date(T0 + n * DAY_MS).toISOString().slice(0, 10);
  const waitedOn = (d: number) => store.rollups(WS).find((row) => row.day === day(d) && row.reason === 'owner')?.waitedMs ?? null;

  it('a wait longer than three days appears in the rollup of every day it covers', async () => {
    await store.runRetention(T0 + 12 * 60 * MIN);
    append([op('range:a:1', T0 + 12 * 60 * MIN), wait('w1', T0 + 12 * 60 * MIN, 'range:a:1', 'owner')]);
    for (let d = 1; d <= 5; d++) await store.runRetention(T0 + d * DAY_MS + MIN);
    append([ev('w2', T0 + 5 * DAY_MS + 12 * 60 * MIN, 'range:a:1', 'clear')]);
    await store.runRetention(T0 + 6 * DAY_MS + MIN);
    expect([0, 1, 2, 3, 4, 5].map(waitedOn)).toEqual([12 * 60 * MIN, DAY_MS, DAY_MS, DAY_MS, DAY_MS, 12 * 60 * MIN]);
  });

  it('a server down for ten days leaves no gap in the rollups', async () => {
    await store.runRetention(T0 + MIN);
    for (let d = 1; d <= 10; d++) {
      append([op(`range:a:${d}`, T0 + d * DAY_MS + 60 * MIN), wait(`a${d}`, T0 + d * DAY_MS + 60 * MIN, `range:a:${d}`, 'owner'), ev(`b${d}`, T0 + d * DAY_MS + 90 * MIN, `range:a:${d}`, 'clear')]);
    }
    const pass = await store.runRetention(T0 + 11 * DAY_MS + MIN);
    expect(pass.rolledUpDays).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(day));
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(waitedOn)).toEqual(Array(10).fill(30 * MIN));
  });

  it('deletes in chunks and yields to the event loop between them', async () => {
    const old = T0 - 100 * DAY_MS;
    for (let batch = 0; batch < 24; batch++) {
      store.append(WS, 'v2', Array.from({ length: 500 }, (_, i) => ev(`o${batch}-${i}`, old + batch * 500 + i, `range:o:${batch}`, 'state', { state: 's' })), T0);
    }
    let turns = 0;
    let running = true;
    const tick = () => { turns += 1; if (running) setImmediate(tick); };
    setImmediate(tick);
    const result = await store.runRetention(T0);
    running = false;
    expect(result.events).toBe(12_000);
    expect(RETENTION_CHUNK).toBe(5_000);
    expect(turns).toBeGreaterThanOrEqual(2);
  });

  it('rolls a day up from its intervals, clipped to the day, with items and percentiles', () => {
    const day = T0;
    append([
      op('range:a:1', day - 30 * MIN),
      wait('e1', day - 30 * MIN, 'range:a:1', 'not-armed'),
      ev('e2', day + 30 * MIN, 'range:a:1', 'clear'),
      op('range:b:1', day + MIN),
      wait('e3', day + MIN, 'range:b:1', 'not-armed'),
      ev('e4', day + 11 * MIN, 'range:b:1', 'clear'),
    ]);
    store.rollUp(day, day);
    expect(store.rollups(WS)).toEqual([
      { day: '2026-11-01', itemType: 'range', reason: 'not-armed', waitedMs: 40 * MIN, items: 2, p50Ms: 10 * MIN, p90Ms: 60 * MIN },
    ]);
  });
});
