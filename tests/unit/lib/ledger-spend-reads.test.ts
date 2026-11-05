import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS } from '@/lib/ledger';
import { LedgerStore } from '@/lib/ledger-store';
import type { ILedgerEventInput, TLedgerItemType, TLedgerKind } from '@/types/ledger';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const WS = 'ws-a';

let dir: string;
let store: LedgerStore;

const ev = (id: string, at: number, key: string, kind: TLedgerKind, extra: Partial<ILedgerEventInput> = {}): ILedgerEventInput => ({
  event_id: id, at, item_type: key.slice(0, key.indexOf(':')) as TLedgerItemType, item_key: key, kind,
  state: null, wait_reason: null, holder: null, clear_input: null, parent_key: null, attrs: null, ...extra,
});

const append = (events: ILedgerEventInput[], ws = WS) => store.append(ws, 'v2', events, events.at(-1)!.at);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-ledger-spend-'));
  store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const agreeOverRandomStreams = (store: LedgerStore): void => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let stream = 0; stream < 40; stream++) {
    const ws = `ws-p${stream}`;
    const keys = ['range:p:1', 'range:p:2', 'range:p:3', 'slice:p'];
    const sent: ILedgerEventInput[] = [];
    const lastSeq = new Map<string, number>();
    const oracle: number[] = [];
    for (let n = 0; n < 40; n++) {
      const key = keys[Math.floor(rand() * keys.length)];
      const at = T0 + Math.floor(rand() * 40) * 60 * MIN;
      const pick = rand();
      const event = sent.length && pick < 0.12 ? { ...sent[Math.floor(rand() * sent.length)], event_id: `re-${n}` }
        : pick < 0.4 ? ev(`e${n}`, at, key, 'open')
          : pick < 0.75 ? ev(`e${n}`, at, key, 'close', { state: rand() < 0.75 ? 'landed' : (rand() < 0.5 ? 'dropped' : null) })
            : ev(`e${n}`, at, key, 'wait', { wait_reason: 'not-armed', holder: 'tab-1' });
      sent.push(event);
      store.append(ws, rand() < 0.5 ? 'v2' : 'backfill', [event], T0 + 2 * DAY_MS);
      const row = store.items(ws, {}, T0 + 2 * DAY_MS).items.find((item) => item.itemKey === event.item_key);
      const applied = row !== undefined && row.lastSeq !== lastSeq.get(event.item_key);
      if (row) lastSeq.set(event.item_key, row.lastSeq);
      if (applied && event.kind === 'close' && event.item_type === 'range' && event.state === 'landed') oracle.push(row!.closedAt!);
    }
    expect(store.landedRanges(ws, 0, T0 + 3 * DAY_MS), ws).toBe(oracle.length);
    for (const [from, to] of [[T0, T0 + 10 * 60 * MIN], [T0 + 10 * 60 * MIN, T0 + DAY_MS]]) {
      expect(store.landedRanges(ws, from, to), `${ws} ${from}`).toBe(oracle.filter((at) => at >= from && at < to).length);
    }
  }
};

describe('landedRanges (harness-flow-loop 04 AC 4, 04-F5)', () => {
  it('counts close events with state landed on ranges inside [since, until), one workspace only', () => {
    append([
      ev('o1', T0, 'range:a:1', 'open'), ev('c1', T0 + MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('o2', T0, 'range:a:2', 'open'), ev('c2', T0 + DAY_MS, 'range:a:2', 'close', { state: 'landed' }),
      ev('o3', T0, 'range:a:3', 'open'), ev('c3', T0 + 2 * MIN, 'range:a:3', 'close', { state: 'dropped' }),
      ev('o4', T0, 'range:a:4', 'open'),
      ev('o5', T0, 'landing:5', 'open'), ev('c5', T0 + MIN, 'landing:5', 'close', { state: 'landed' }),
    ]);
    append([ev('o9', T0, 'range:b:9', 'open'), ev('c9', T0 + MIN, 'range:b:9', 'close', { state: 'landed' })], 'ws-b');
    expect(store.landedRanges(WS, T0, T0 + DAY_MS)).toBe(1);
    expect(store.landedRanges(WS, T0, T0 + DAY_MS + 1)).toBe(2);
    expect(store.landedRanges(WS, T0 + 2 * MIN, T0 + DAY_MS)).toBe(0);
    expect(store.landedRanges('ws-none', T0, T0 + 2 * DAY_MS)).toBe(0);
  });

  it('counts each landing of a reopened range, and no landing for a stateless close after a landed state', () => {
    append([
      ev('o1', T0, 'range:a:1', 'open'), ev('c1', T0 + MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('r1', T0 + 2 * MIN, 'range:a:1', 'open'), ev('c1b', T0 + 3 * MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('o2', T0, 'range:a:2', 'open'), ev('s2', T0 + MIN, 'range:a:2', 'state', { state: 'landed' }),
      ev('c2', T0 + 2 * MIN, 'range:a:2', 'close'),
    ]);
    expect(store.landedRanges(WS, T0, T0 + DAY_MS)).toBe(2);
    expect(store.items(WS, {}, T0 + DAY_MS).items.find((item) => item.itemKey === 'range:a:2')?.state).toBe('landed');
  });

  it('counts only a close that landed the item: not a second close under a new id, not a close for an item never opened (04-F7)', () => {
    append([
      ev('o1', T0, 'range:a:1', 'open'), ev('c1', T0 + MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('c1-again', T0 + 2 * MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('ghost', T0 + MIN, 'range:a:9', 'close', { state: 'landed' }),
    ]);
    expect(store.landedRanges(WS, T0, T0 + DAY_MS)).toBe(1);
  });

  it('counts a range that a backfill re-sends after live producers landed it once (04-C1, the architect\'s case)', () => {
    const result = (events: ILedgerEventInput[], producer: string) => store.append(WS, producer, events, events.at(-1)!.at);
    result([ev('o', T0, 'range:a:1', 'open'), ev('c', T0 + 2 * 60 * MIN, 'range:a:1', 'close', { state: 'landed' })], 'v2');
    const resent = result([ev('o', T0, 'range:a:1', 'open'), ev('c', T0 + 2 * 60 * MIN, 'range:a:1', 'close', { state: 'landed' })], 'backfill');
    expect(resent).toMatchObject({ accepted: 2, closedItem: 2 });
    expect(store.landedRanges(WS, T0, T0 + DAY_MS)).toBe(1);
  });

  it('agrees with the store\'s own projection over random streams with late, repeated and re-sent events (04-C1)', () => {
    const memory = new LedgerStore(':memory:');
    try {
      agreeOverRandomStreams(memory);
    } finally {
      memory.close();
    }
    // 1,600 append-and-read round trips: about 0.3 s on a quiet host, several times that under a loaded full-suite gate.
  }, 20_000);

  it('counts a landing whose open is older than the scan, and not a repeat close of a range closed before it (04-F7)', () => {
    const since = T0 + 10 * DAY_MS;
    append([ev('o1', T0, 'range:a:1', 'open'), ev('o2', T0, 'range:a:2', 'open'), ev('c2', T0 + MIN, 'range:a:2', 'close', { state: 'landed' })]);
    append([ev('c1', since + MIN, 'range:a:1', 'close', { state: 'landed' }), ev('c2-late', since + MIN, 'range:a:2', 'close', { state: 'landed' })]);
    expect(store.landedRanges(WS, since, since + DAY_MS)).toBe(1);
    expect(store.landedRanges(WS, T0, since + DAY_MS)).toBe(2);
  });

  it('reads the first item\'s open time, null for a workspace with none', () => {
    append([ev('o1', T0 + MIN, 'range:a:1', 'open'), ev('o2', T0, 'slice:a', 'open')]);
    expect(store.firstOpenedAt(WS)).toBe(T0);
    expect(store.firstOpenedAt('ws-none')).toBeNull();
    expect(store.holdsItems(WS)).toBe(true);
    expect(store.holdsItems('ws-none')).toBe(false);
  });
});

describe('the landings table (04-C1)', () => {
  it('is filled once from the stored events when a ledger written before it is opened, and never again', () => {
    const file = path.join(dir, 'ledger.sqlite');
    append([
      ev('o1', T0, 'range:a:1', 'open'), ev('c1', T0 + MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('c1-again', T0 + 2 * MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('r1', T0 + 3 * MIN, 'range:a:1', 'open'), ev('c1b', T0 + 4 * MIN, 'range:a:1', 'close', { state: 'landed' }),
      ev('ghost', T0, 'range:a:9', 'close', { state: 'landed' }),
    ]);
    store.close();
    const raw = new Database(file);
    raw.exec('DROP TABLE landings');
    raw.close();
    store = new LedgerStore(file);
    expect(store.landedRanges(WS, T0, T0 + DAY_MS)).toBe(2);
    store.close();
    store = new LedgerStore(file);
    expect(store.landedRanges(WS, T0, T0 + DAY_MS)).toBe(2);
    expect(store.pragma('user_version')).toBe(1);
  });

  it('leaves the landings with the events past retention', async () => {
    append([ev('o1', T0, 'range:a:1', 'open'), ev('c1', T0 + MIN, 'range:a:1', 'close', { state: 'landed' })]);
    const result = await store.runRetention(T0 + 93 * DAY_MS);
    expect(result.landings).toBe(1);
    expect(store.landedRanges(WS, 0, T0 + DAY_MS)).toBe(0);
  });
});

describe('phaseReplay (harness-flow-loop 04 AC 1)', () => {
  it('seeds the items silent since before the scan and returns the scan events in arrival order', () => {
    append([ev('old', T0, 'slice:a', 'open', { holder: 'tab-1' })]);
    append([ev('closed-old', T0, 'gate:x:1', 'open', { holder: 'tab-1' }), ev('closed-old-c', T0 + MIN, 'gate:x:1', 'close')]);
    const since = T0 + 10 * DAY_MS;
    append([ev('late', since - DAY_MS, 'range:a:1', 'open', { holder: 'tab-2' }), ev('in', since + MIN, 'range:a:1', 'wait', { wait_reason: 'review-queue' })]);
    append([ev('other-ws', since, 'range:b:1', 'open')], 'ws-b');
    const replay = store.phaseReplay(WS, since, since + DAY_MS);
    expect(replay.scanStart).toBe(since - 7 * DAY_MS);
    expect(replay.seed.map((row) => row.item_key)).toEqual(['slice:a']);
    expect(replay.events.map((event) => [event.item_key, event.kind])).toEqual([['range:a:1', 'open'], ['range:a:1', 'wait']]);
    expect(replay.events[1]).toMatchObject({ wait_reason: 'review-queue', holder: null, at: since + MIN });
    expect(replay.firstOpenedAt).toBe(T0);
    expect(replay.carried).toEqual([]);
  });

  it('carries the items open at the scan start whose first scanned event is not their open, and not the ones closed before it', () => {
    const since = T0 + 10 * DAY_MS;
    append([ev('o1', T0, 'range:a:1', 'open', { holder: 'tab-1' }), ev('o2', T0, 'range:a:2', 'open'),
      ev('c2', T0 + MIN, 'range:a:2', 'close', { state: 'landed' })]);
    append([ev('w1', since, 'range:a:1', 'wait', { wait_reason: 'not-armed' }), ev('late2', since, 'range:a:2', 'state', { state: 'x' })]);
    const replay = store.phaseReplay(WS, since, since + DAY_MS);
    expect(replay.seed).toEqual([]);
    expect(replay.carried.map((row) => [row.item_key, row.holder, row.wait_reason])).toEqual([['range:a:1', 'tab-1', 'not-armed']]);
  });

  it('answers no history for a workspace the ledger never heard from', () => {
    expect(store.phaseReplay('ws-none', T0, T0 + DAY_MS)).toEqual({ workspaceId: 'ws-none', scanStart: T0 - 7 * DAY_MS, seed: [], events: [], carried: [], firstOpenedAt: null });
  });
});
