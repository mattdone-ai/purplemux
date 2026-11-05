import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, LEDGER_STAGE_REASONS } from '@/lib/ledger';
import { LedgerStore } from '@/lib/ledger-store';
import { buildSpendHoldings, ledgerHorizon, phaseOfItem } from '@/lib/spend/spend-phase';
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
const append = (events: ILedgerEventInput[]) => store.append(WS, 'v2', events, events.at(-1)!.at);
const holdings = (since: number, until: number) => buildSpendHoldings(store.phaseReplay(WS, since, until), T0 - DAY_MS);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-spend-phase-'));
  store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the phase table (consult ruling)', () => {
  it('maps the wait reason first, then the item type', () => {
    expect(phaseOfItem('range', 'review-queue')).toBe('review');
    expect(phaseOfItem('slice', 'review-findings')).toBe('review');
    expect(phaseOfItem('range', 'rework')).toBe('build');
    expect(phaseOfItem('slice', 'receipt-rekey')).toBe('land');
    for (const reason of [...LEDGER_STAGE_REASONS.land, ...LEDGER_STAGE_REASONS.deploy, 'land-queue/lock-busy', 'land-queue/head-blocked']) {
      expect(phaseOfItem('owner-issue', reason), reason).toBe('land');
    }
    expect(phaseOfItem('range', 'owner')).toBe('coordinate');
    for (const reason of ['agent-idle', 'host-load', 'unknown', null]) expect(phaseOfItem('gate', reason), String(reason)).toBe('evaluate');
    expect([
      ['slice', 'build'], ['review', 'review'], ['gate', 'evaluate'], ['experiment', 'evaluate'], ['range', 'land'],
      ['landing', 'land'], ['deploy', 'land'], ['owner-issue', 'plan'], ['mc-item', 'coordinate'],
    ].map(([type]) => [type, phaseOfItem(type as TLedgerItemType, null)])).toEqual([
      ['slice', 'build'], ['review', 'review'], ['gate', 'evaluate'], ['experiment', 'evaluate'], ['range', 'land'],
      ['landing', 'land'], ['deploy', 'land'], ['owner-issue', 'plan'], ['mc-item', 'coordinate'],
    ]);
  });

  it('skips seat items: a seat is the tab, not its work', () => {
    expect(phaseOfItem('seat', null)).toBeNull();
    expect(phaseOfItem('seat', 'owner')).toBeNull();
  });
});

describe('holdings replay', () => {
  it('holds an item from its open to its close, matched by the tab id or its name', () => {
    append([ev('o', T0, 'slice:a', 'open', { holder: 'tab-1' }), ev('c', T0 + 30 * MIN, 'slice:a', 'close')]);
    append([ev('o2', T0, 'gate:t:1', 'open', { holder: 'hfl-04' })]);
    const held = holdings(T0, T0 + DAY_MS);
    expect(held.heldBy('tab-1', 'other-name', T0 + MIN)).toEqual({ itemKey: 'slice:a', phase: 'build' });
    expect(held.heldBy('tab-1', 'other-name', T0 + 31 * MIN)).toBeNull();
    expect(held.heldBy('tab-9', 'hfl-04', T0 + 31 * MIN)).toEqual({ itemKey: 'gate:t:1', phase: 'evaluate' });
    expect(held.heldBy('tab-1', null, T0 - MIN)).toBeNull();
  });

  it('follows the wait reason and the sticky holder through the item\'s events', () => {
    append([
      ev('o', T0, 'range:a:1', 'open', { holder: 'tab-1' }),
      ev('w1', T0 + 10 * MIN, 'range:a:1', 'wait', { wait_reason: 'review-queue', holder: 'tab-r' }),
      ev('w2', T0 + 20 * MIN, 'range:a:1', 'wait', { wait_reason: 'not-armed', holder: 'tab-1' }),
      ev('s', T0 + 30 * MIN, 'range:a:1', 'state', { state: 'armed' }),
    ]);
    const held = holdings(T0, T0 + DAY_MS);
    expect(held.heldBy('tab-1', null, T0 + 5 * MIN)?.phase).toBe('land');
    expect(held.heldBy('tab-1', null, T0 + 15 * MIN)).toBeNull();
    expect(held.heldBy('tab-r', null, T0 + 15 * MIN)?.phase).toBe('review');
    expect(held.heldBy('tab-1', null, T0 + 25 * MIN)?.phase).toBe('land');
    expect(held.heldBy('tab-1', null, T0 + 35 * MIN)).toEqual({ itemKey: 'range:a:1', phase: 'land' });
  });

  it('picks the held item with the latest event, the lowest key on a tie, and never a seat item', () => {
    append([
      ev('a', T0, 'slice:b', 'open', { holder: 'tab-1' }),
      ev('b', T0, 'gate:a:1', 'open', { holder: 'tab-1' }),
      ev('s', T0 + 5 * MIN, 'seat:ws-a:x', 'open', { holder: 'tab-1' }),
      ev('c', T0 + 10 * MIN, 'review:r1', 'open', { holder: 'tab-1' }),
    ]);
    const held = holdings(T0, T0 + DAY_MS);
    expect(held.heldBy('tab-1', null, T0 + MIN)).toEqual({ itemKey: 'gate:a:1', phase: 'evaluate' });
    expect(held.heldBy('tab-1', null, T0 + 6 * MIN)).toEqual({ itemKey: 'gate:a:1', phase: 'evaluate' });
    expect(held.heldBy('tab-1', null, T0 + 11 * MIN)).toEqual({ itemKey: 'review:r1', phase: 'review' });
  });

  it('seeds an item silent since before the scan and holds it through the window', () => {
    append([ev('o', T0, 'owner-issue:9', 'open', { holder: 'tab-1' })]);
    const since = T0 + 20 * DAY_MS;
    expect(holdings(since, since + DAY_MS).heldBy('tab-1', null, since + MIN)).toEqual({ itemKey: 'owner-issue:9', phase: 'plan' });
  });

  it('starts a carried item at its first scanned event, with the holder it has had since before the scan', () => {
    append([ev('o1', T0, 'range:a:1', 'open', { holder: 'tab-1' }), ev('o2', T0, 'range:a:2', 'open', { holder: 'tab-1' })]);
    const since = T0 + 20 * DAY_MS;
    append([
      ev('w1', since + 10 * MIN, 'range:a:1', 'wait', { wait_reason: 'review-queue' }),
      ev('w2', since + 10 * MIN, 'range:a:2', 'wait', { wait_reason: 'rework', holder: 'tab-2' }),
    ]);
    const held = holdings(since, since + DAY_MS);
    expect(held.heldBy('tab-1', null, since + 5 * MIN)).toBeNull();
    expect(held.heldBy('tab-1', null, since + 11 * MIN)).toEqual({ itemKey: 'range:a:1', phase: 'review' });
    expect(held.heldBy('tab-2', null, since + 11 * MIN)).toEqual({ itemKey: 'range:a:2', phase: 'build' });
  });

  it('keeps each timeline sorted when a link with a later time arrives before an earlier move (04-F3)', () => {
    const event = (seq: number, at: number, kind: TLedgerKind, extra: Partial<ILedgerEventInput> = {}) => ({
      seq, at, item_type: 'slice' as const, item_key: 'slice:a', kind, state: null, wait_reason: null, holder: null,
      clear_input: null, parent_key: null, ...extra,
    });
    const held = buildSpendHoldings({ workspaceId: WS, scanStart: 0, seed: [], carried: [], firstOpenedAt: 0, events: [
      event(1, 0, 'open', { holder: 'tab-1' }),
      event(2, 1_000_000, 'link', { parent_key: 'range:r' }),
      event(3, 500_000, 'wait', { wait_reason: 'review-queue' }),
    ] }, 0);
    expect(held.heldBy('tab-1', null, 100_000)).toEqual({ itemKey: 'slice:a', phase: 'build' });
    expect(held.heldBy('tab-1', null, 600_000)).toEqual({ itemKey: 'slice:a', phase: 'review' });
    expect(held.heldBy('tab-1', null, 1_200_000)).toEqual({ itemKey: 'slice:a', phase: 'review' });
  });

  it('never takes a carried item\'s holder from an event after the window (04-F6)', () => {
    append([ev('o1', T0, 'range:a:1', 'open', { holder: 'tab-1' })]);
    const day = T0 + 20 * DAY_MS;
    append([ev('w1', day + 10 * MIN, 'range:a:1', 'wait', { wait_reason: 'review-queue' })]);
    append([ev('w2', day + 3 * DAY_MS, 'range:a:1', 'wait', { wait_reason: 'rework', holder: 'tab-2' })]);
    const past = holdings(day, day + DAY_MS);
    expect(past.heldBy('tab-2', null, day + 11 * MIN)).toBeNull();
    expect(past.heldBy('tab-1', null, day + 11 * MIN)).toBeNull();
    const now = holdings(day, day + 4 * DAY_MS);
    expect(now.heldBy('tab-2', null, day + 3 * DAY_MS + MIN)).toEqual({ itemKey: 'range:a:1', phase: 'build' });
  });

  it('carries the horizon it was built with', () => {
    expect(holdings(T0, T0 + DAY_MS).horizon).toBe(T0 - DAY_MS);
  });
});

describe('ledger horizon', () => {
  it('is the later of the retention cutoff + 7 d and the first item, and null with no item', () => {
    const now = T0 + 100 * DAY_MS;
    expect(ledgerHorizon(null, now)).toBeNull();
    expect(ledgerHorizon(T0, now)).toBe(now - 85 * DAY_MS);
    expect(ledgerHorizon(now - DAY_MS, now)).toBe(now - DAY_MS);
  });
});
