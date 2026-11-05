import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LedgerStore } from '@/lib/ledger-store';
import type { ILedgerEventInput, TLedgerItemType, TLedgerKind } from '@/types/ledger';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 6, 0, 0);
const WS = 'ws-a';

let dir: string;
let store: LedgerStore;

const ev = (id: string, at: number, key: string, kind: TLedgerKind, extra: Partial<ILedgerEventInput> = {}): ILedgerEventInput => ({
  event_id: id, at, item_type: key.slice(0, key.indexOf(':')) as TLedgerItemType, item_key: key, kind,
  state: null, wait_reason: null, holder: null, clear_input: null, parent_key: null, attrs: null, ...extra,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-ledger-pulse-'));
  store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('LedgerStore.pulseSnapshot', () => {
  it('an empty ledger holds no event, no movement and no open work', () => {
    expect(store.pulseSnapshot(WS, NOW - 168 * HOUR)).toEqual({ movement: [], eventSince: false, openWork: 0, oldest: null });
  });

  it('counts opens, clears and closes on work items; seats and MC items are not movement', () => {
    store.append(WS, 'v2', [
      ev('a', NOW - 300 * HOUR, 'range:a:1', 'open'),
      ev('b', NOW - 5 * HOUR, 'range:b:1', 'open'),
      ev('c', NOW - 4 * HOUR, 'range:b:1', 'wait', { wait_reason: 'not-armed', holder: 'lane-b' }),
      ev('d', NOW - 3 * HOUR, 'range:b:1', 'clear'),
      ev('e', NOW - 2 * HOUR, 'range:a:1', 'close', { state: 'landed' }),
      ev('f', NOW - 2 * HOUR, 'seat:ws-a:w1', 'open'),
      ev('g', NOW - HOUR, 'gate:abc:1', 'open'),
      ev('h', NOW - HOUR, 'range:c:1', 'open'),
      ev('i', NOW - 30 * 60_000, 'range:c:1', 'wait', { wait_reason: 'lock-wait' }),
    ], NOW);
    store.append(WS, 'purplemux', [ev('j', NOW - HOUR, 'mc-item:x', 'open')], NOW);
    store.append('ws-b', 'v2', [ev('k', NOW - HOUR, 'range:z:1', 'open')], NOW);
    const snap = store.pulseSnapshot(WS, NOW - 168 * HOUR);
    expect(snap.movement.sort()).toEqual([NOW - 5 * HOUR, NOW - 3 * HOUR, NOW - 2 * HOUR, NOW - HOUR, NOW - HOUR].sort());
    expect(snap.eventSince).toBe(true);
    // range:b:1, gate:abc:1 and range:c:1 are open; the seat and the MC item are not work.
    expect(snap.openWork).toBe(3);
    expect(snap.oldest).toEqual({ itemKey: 'range:b:1', itemType: 'range', waitReason: null, since: NOW - 5 * HOUR });
  });

  it('an event before the window is not an event since it', () => {
    store.append(WS, 'v2', [ev('a', NOW - 300 * HOUR, 'range:a:1', 'open')], NOW);
    expect(store.pulseSnapshot(WS, NOW - 168 * HOUR)).toMatchObject({ movement: [], eventSince: false, openWork: 1 });
  });

  it('an experiment, seat or MC item event alone never switches the WIP basis and is no movement (round 2, F2)', () => {
    store.append(WS, 'purplemux', [
      ev('s1', NOW - HOUR, 'seat:ws-a:w1', 'open'),
      ev('m1', NOW - HOUR, 'mc-item:x', 'open'),
      ev('x1', NOW - HOUR, 'experiment:EXP-1', 'open'),
      ev('x2', NOW - 30 * 60_000, 'experiment:EXP-1', 'close', { state: 'kept' }),
    ], NOW);
    expect(store.pulseSnapshot(WS, NOW - 168 * HOUR)).toEqual({ movement: [], eventSince: false, openWork: 0, oldest: null });
  });
});

