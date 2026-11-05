import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FINDER_LOOKBACK_MS, FINDER_WAKES_WINDOW_MS, deriveConstraint } from '@/lib/constraint';
import { LedgerStore } from '@/lib/ledger-store';
import type { ILedgerEventInput, TLedgerItemType, TLedgerKind } from '@/types/ledger';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 3, 6, 0, 0);
const WS = 'ws-a';

let dir: string;
let store: LedgerStore;

const ev = (id: string, at: number, key: string, kind: TLedgerKind, extra: Partial<ILedgerEventInput> = {}): ILedgerEventInput => ({
  event_id: id, at, item_type: key.slice(0, key.indexOf(':')) as TLedgerItemType, item_key: key, kind,
  state: null, wait_reason: null, holder: null, clear_input: null, parent_key: null, attrs: null, ...extra,
});

const append = (producer: string, events: ILedgerEventInput[], ws = WS) => store.append(ws, producer, events, events.at(-1)!.at);

const snapshot = (ws = WS) => store.finderSnapshot(ws, { since: NOW - FINDER_LOOKBACK_MS, wakesSince: NOW - FINDER_WAKES_WINDOW_MS }, NOW);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-ledger-finder-'));
  store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LedgerStore.finderSnapshot', () => {
  it('reads 14 days of waits, open and recently closed items, and the producer of each open item', () => {
    append('backfill', [
      ev('o0', NOW - 20 * DAY, 'range:a:old', 'open'),
      ev('w0', NOW - 20 * DAY, 'range:a:old', 'wait', { wait_reason: 'not-armed' }),
      ev('c0', NOW - 19 * DAY, 'range:a:old', 'close', { state: 'landed' }),
    ]);
    append('landchain', [
      ev('o1', NOW - 3 * HOUR, 'range:a:1', 'open'),
      ev('w1', NOW - 3 * HOUR, 'range:a:1', 'wait', { wait_reason: 'not-armed', holder: 'lane-a' }),
      ev('c1', NOW - HOUR, 'range:a:1', 'close', { state: 'landed' }),
      ev('o2', NOW - 150 * MIN, 'range:a:2', 'open'),
      ev('w2', NOW - 150 * MIN, 'range:a:2', 'wait', { wait_reason: 'review-findings', holder: 'lane-a', clear_input: 'fix F1' }),
    ]);
    append('gate', [ev('g1', NOW - 20 * MIN, 'gate:t1:1', 'open', { attrs: { mode: 'affected' } })]);
    append('landchain', [ev('o9', NOW - HOUR, 'range:b:1', 'open')], 'ws-b');

    const snap = snapshot();
    expect(snap.intervals).toEqual([
      { itemKey: 'range:a:1', itemType: 'range', reason: 'not-armed', holder: 'lane-a', start: NOW - 3 * HOUR, end: NOW - HOUR },
    ]);
    expect(snap.items.map((item) => item.itemKey).sort()).toEqual(['gate:t1:1', 'range:a:1', 'range:a:2']);
    expect(snap.lastProducer).toEqual({ 'gate:t1:1': 'gate', 'range:a:2': 'landchain' });
    expect(snap.firstEventAt).toBe(NOW - 20 * DAY);
    expect(snap.tabWakes).toBeNull();

    const result = deriveConstraint(snap, null, null, null, NOW);
    expect(result.constraint).toMatchObject({ reason: 'review-findings', ownerSeat: 'lane-a', clearInput: 'fix F1', waitingHours: 2.5 });
    expect(result.stuck.map((s) => s.key)).toEqual(['range:a:2']);
  });

  it('counts deliveries per tab in 6 h, one per digest, never log rows or undelivered ones', () => {
    const row = (tabId: string, at: number, extra: { class?: string; deliveredAt?: number | null; digestId?: string | null } = {}) =>
      store.insertTabEvent({ workspaceId: WS, tabId, at, class: extra.class ?? 'urgent', kind: 'nudge', text: 'x',
        deliveredAt: extra.deliveredAt === undefined ? at : extra.deliveredAt, digestId: extra.digestId ?? null });
    row('tab-o', NOW - HOUR);
    row('tab-o', NOW - 2 * HOUR);
    row('tab-o', NOW - 3 * HOUR, { class: 'digest', deliveredAt: NOW - 30 * MIN, digestId: 'd1' });
    row('tab-o', NOW - 2 * HOUR, { class: 'digest', deliveredAt: NOW - 30 * MIN, digestId: 'd1' });
    row('tab-o', NOW - HOUR, { class: 'log' });
    row('tab-o', NOW - HOUR, { class: 'digest', deliveredAt: null });
    row('tab-o', NOW - 7 * HOUR);
    row('tab-k', NOW - 8 * HOUR, { class: 'digest', deliveredAt: NOW - 5 * HOUR, digestId: 'd2' });
    expect(snapshot().tabWakes).toEqual([{ tabId: 'tab-k', wakes: 1 }, { tabId: 'tab-o', wakes: 3 }]);
    expect(snapshot('ws-b').tabWakes).toBeNull();
  });
});

describe('LedgerStore.finderSnapshot owner-issue source (story 35)', () => {
  const at = (producer: string, events: ILedgerEventInput[], receivedAt: number) => store.append(WS, producer, events, receivedAt);

  it('is null when the ledger holds no owner-issue item', () => {
    append('landchain', [ev('o1', NOW - HOUR, 'range:a:1', 'open')]);
    expect(snapshot().ownerIssueSource).toBeNull();
  });

  it('names each item\'s producer, the producer of the item opened last, and every first and last receipt, any item type', () => {
    at('backfill', [ev('b1', NOW - 12 * DAY, 'owner-issue:W1-1', 'open')], NOW - 2 * DAY);
    at('backfill', [ev('b2', NOW - 11 * DAY, 'owner-issue:W1-1', 'close', { state: 'closed' })], NOW - 2 * DAY);
    at('v2', [ev('v1', NOW - 3 * DAY, 'range:a:1', 'open')], NOW - 30 * HOUR);
    at('v2', [ev('v2', NOW - 2 * DAY, 'owner-issue:30-I10', 'open')], NOW - 5 * HOUR);
    at('v2', [ev('v3', NOW - 2 * DAY, 'owner-issue:30-I10', 'close', { state: 'closed' })], NOW - 4 * HOUR);
    at('v2', [ev('v4', NOW - 3 * DAY, 'range:a:1', 'close', { state: 'landed' })], NOW - 2 * HOUR);
    at('v2', [ev('v5', NOW - 3 * HOUR, 'gate:t:1', 'open')], NOW - HOUR);
    at('other', [ev('x1', NOW - 4 * DAY, 'owner-issue:01-I4', 'open')], NOW - 10 * MIN);
    store.append('ws-b', 'v2', [ev('y1', NOW - MIN, 'owner-issue:9-I1', 'open')], NOW);

    at('backfill', [ev('b3', NOW - 20 * DAY, 'owner-issue:W0-1', 'open')], NOW - 2 * DAY);
    at('backfill', [ev('b4', NOW - 19 * DAY, 'owner-issue:W0-1', 'close', { state: 'closed' })], NOW - 2 * DAY);

    expect(snapshot().ownerIssueSource).toEqual({
      producerOf: new Map([['owner-issue:W1-1', 'backfill'], ['owner-issue:30-I10', 'v2'], ['owner-issue:01-I4', 'other']]),
      newestProducer: 'v2',
      receipts: new Map([
        ['v2', { firstReceivedAt: NOW - 30 * HOUR, lastReceivedAt: NOW - HOUR }],
        ['backfill', { firstReceivedAt: NOW - 2 * DAY, lastReceivedAt: NOW - 2 * DAY }],
        ['other', { firstReceivedAt: NOW - 10 * MIN, lastReceivedAt: NOW - 10 * MIN }],
      ]),
      earliestOpenedAt: NOW - 20 * DAY,
      anyRaisedAt: false,
    });
  });

  it('says whether any owner-issue item, open or closed, of any age, carries an integer raisedAt (architect R1)', () => {
    at('v2', [ev('o1', NOW - HOUR, 'owner-issue:01-I4', 'open')], NOW - HOUR);
    expect(snapshot().ownerIssueSource?.anyRaisedAt).toBe(false);
    at('v2', [ev('o2', NOW - 20 * DAY, 'owner-issue:W1-1', 'open', { attrs: { raisedAt: NOW - 21 * DAY } })], NOW - 20 * DAY);
    at('v2', [ev('c2', NOW - 19 * DAY, 'owner-issue:W1-1', 'close', { state: 'closed' })], NOW - 19 * DAY);
    expect(snapshot().ownerIssueSource?.anyRaisedAt).toBe(true);
  });

  it('adds the producer receipt index to a ledger written without it; user_version stays 1', () => {
    const file = path.join(dir, 'ledger.sqlite');
    store.close();
    const raw = new Database(file);
    raw.exec('DROP INDEX events_ws_producer_received_idx');
    raw.close();
    store = new LedgerStore(file);
    const check = new Database(file, { readonly: true });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_ws_producer_received_idx'").get())
      .toEqual({ name: 'events_ws_producer_received_idx' });
    expect(check.pragma('user_version', { simple: true })).toBe(1);
    check.close();
  });
});
