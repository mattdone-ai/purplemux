import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FINDER_LOOKBACK_MS, FINDER_WAKES_WINDOW_MS, deriveConstraint } from '@/lib/constraint';
import { LedgerStore } from '@/lib/ledger-store';
import type { ILedgerEventInput } from '@/types/ledger';

const HOUR = 3_600_000;
const MTIME = Date.UTC(2026, 10, 3, 13, 22, 33);
const NOW = MTIME + HOUR;
const WS = 'ws-v2';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const SYDNEY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Australia/Sydney', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
});

const sydneyParts = (ms: number) => {
  const parts = Object.fromEntries(SYDNEY.formatToParts(ms).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month - 1, day: parts.day, hour: parts.hour, minute: parts.minute };
};

/** 00:00 `Australia/Sydney` of a day, as epoch ms: the offset is read at the instant itself, so AEST and AEDT both hold. */
const sydneyMidnight = (year: number, month: number, day: number): number => {
  const wall = Date.UTC(year, month, day);
  const offsetAt = (ms: number) => {
    const p = sydneyParts(ms);
    return Date.UTC(p.year, p.month, p.day, p.hour, p.minute) - ms;
  };
  return wall - offsetAt(wall - offsetAt(wall));
};

/** Consult Q2's kit rule: the leading `D Mon` of `raised`, the year of the mtime in Sydney (one less if that would be later). */
const raisedAt = (raised: string, mtime: number): number | null => {
  const found = /^(\d{1,2}) ([A-Z][a-z]{2})\b/.exec(raised);
  const month = found ? MONTHS.indexOf(found[2]) : -1;
  if (!found || month < 0) return null;
  const seen = sydneyParts(mtime);
  const later = month > seen.month || (month === seen.month && Number(found[1]) > seen.day);
  return sydneyMidnight(seen.year - (later ? 1 : 0), month, Number(found[1]));
};

const fixtureRows = (): Array<{ id: string; raised: string }> => {
  const text = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/owner-issues/owner-issues.yaml'), 'utf8');
  const rows: Array<{ id: string; raised: string }> = [];
  for (const line of text.split('\n')) {
    const id = /^- id: (.+)$/.exec(line);
    const raised = /^ {2}raised: (.+)$/.exec(line);
    if (id) rows.push({ id: id[1], raised: '' });
    else if (raised) rows[rows.length - 1].raised = raised[1];
  }
  return rows;
};

const openEvent = (id: string, attrs: Record<string, string | number> | null): ILedgerEventInput => ({
  event_id: `open|${id}`, at: MTIME, item_type: 'owner-issue', item_key: `owner-issue:${id}`, kind: 'open',
  state: null, wait_reason: null, holder: 'owner', clear_input: null, parent_key: null, attrs,
});

let dir: string;
let store: LedgerStore;

const sendFixedPass = (at: number) => {
  const events = fixtureRows().map((row) => {
    const raised = raisedAt(row.raised, MTIME)!;
    return { ...openEvent(row.id, { raisedAt: raised }), event_id: `open|${row.id}|${raised}`, at };
  });
  expect(store.append(WS, 'v2', events, at)).toMatchObject({ accepted: events.length, duplicates: 0, closedItem: 0 });
};

const expectDatedAtMtime = () => {
  const { items } = store.items(WS, { type: 'owner-issue' }, NOW);
  expect(items).toHaveLength(7);
  for (const item of items) {
    expect(item.openedAt).toBe(MTIME);
    expect(item.closedAt).toBeNull();
    expect(typeof item.attrs.raisedAt).toBe('number');
  }
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-owner-defects-'));
  store = new LedgerStore(path.join(dir, 'ledger.sqlite'));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const defects = (now = NOW) => deriveConstraint(
  store.finderSnapshot(WS, { since: now - FINDER_LOOKBACK_MS, wakesSince: now - FINDER_WAKES_WINDOW_MS }, now), null, null, null, now,
).anomalies.find((a) => a.id === 'owner-found-defects')!;

describe('owner-found defects from an owner-issues.yaml fixture (story 35 AC 3, consult Q2)', () => {
  it('maps an AEDT raised date to 00:00 Sydney, ignoring trailing text', () => {
    expect(raisedAt('28 Oct', MTIME)).toBe(1793106000000);
    expect(new Date(raisedAt('28 Oct', MTIME)!).toISOString()).toBe('2026-10-27T13:00:00.000Z');
    expect(raisedAt('2 Nov (see the note)', MTIME)).toBe(Date.UTC(2026, 10, 1, 13));
    expect(raisedAt('15 Jun', MTIME)).toBe(Date.UTC(2026, 5, 14, 14));
    expect(raisedAt('5 Dec', MTIME)).toBe(Date.UTC(2025, 11, 4, 13));
    expect(raisedAt('soon', MTIME)).toBeNull();
  });

  it('counts each row by its raised time, while opened_at stays the time the feed first saw the row', () => {
    const rows = fixtureRows();
    expect(rows).toHaveLength(7);
    store.append(WS, 'v2', rows.map((row) => openEvent(row.id, { raisedAt: raisedAt(row.raised, MTIME)! })), MTIME + 60_000);
    const { items } = store.items(WS, { type: 'owner-issue' }, NOW);
    expect(items.map((item) => item.openedAt)).toEqual(rows.map(() => MTIME));
    // 25 Oct proves the window; 28 Oct (2026-10-27T13:00Z) falls before it starts at 2026-10-27T14:22:33Z.
    expect(defects()).toMatchObject({ value: 5 / 7, reason: null, text: 'defects you found: 0.7 a day (5 raised) in 7d, no threshold' });
  });

  it('is unknown, never a count, for the live feed shape: opened at the file mtime with no raised time', () => {
    store.append(WS, 'v2', fixtureRows().map((row) => openEvent(row.id, null)), MTIME + 60_000);
    expect(defects()).toMatchObject({ value: null, reason: 'window not covered' });
    // Seven days on the producer covers the window and is still live, and the open rows still carry no raised time.
    const later = NOW + 7 * 24 * HOUR;
    const pass: ILedgerEventInput = { ...openEvent('x', null), event_id: 'range|later', item_type: 'range', item_key: 'range:a:1', at: later - 60_000 };
    store.append(WS, 'v2', [pass], later - 60_000);
    expect(defects(later)).toMatchObject({ value: null, reason: 'owner-issue raised time missing' });
    // The fixed feed's next pass: the same rows, now dated, under new ids (v2 hashes the row body into the id).
    sendFixedPass(later + 60_000);
    expectDatedAtMtime();
    expect(defects(later + 2 * 60_000)).toMatchObject({ value: 0, reason: null });
  });

  it('turns into the count once the fixed feed dates the already-open rows, opened_at unchanged (post-review N1)', () => {
    store.append(WS, 'v2', fixtureRows().map((row) => openEvent(row.id, null)), MTIME + 60_000);
    expect(defects()).toMatchObject({ value: null, reason: 'window not covered' });
    const fixedAt = NOW + 24 * HOUR;
    sendFixedPass(fixedAt);
    expectDatedAtMtime();
    // 25 Oct now proves the window (since 2026-10-28T14:22:33Z); 30 Oct to 4 Nov are inside it.
    expect(defects(fixedAt + 60_000)).toMatchObject({ value: 5 / 7, reason: null });
  });
});
