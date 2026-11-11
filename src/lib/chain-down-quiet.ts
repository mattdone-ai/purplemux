// Browser-safe: when a `chain-down` wait raises no alarm (vel-WATCHDOG-F6-NOISE). A v2 range keeps its `chain-down`
// wait open after its chain dies or a later range of its lane replaces it, so the ledger alone alarmed on dead work.
// Three rules quiet it; every other chain-down still alarms:
//   superseded   a later-opened range of the same lane LANDED (the finder names it, `IBoardStuckItem.supersededBy`);
//                a later range that is open or closed in another state supersedes nothing;
//   held         the workspace's chain hold list (`ledger.chain-holds.<ws>`) holds the range with an until in force;
//   holder-gone  the item names a holder that no tab of the workspace's readable layout names.
// The hold list is the file the Scrum Master watcher reads for CHAIN-OLD. This parser holds exactly the lines that
// watcher holds (its grammar and its until window); it reports no refusal, because the watcher already does.

import type { IBoardStuckItem } from '@/types/constraint';

export const CHAIN_HOLDS_PREFIX = 'ledger.chain-holds.';
export const chainHoldsKey = (workspaceId: string): string => `${CHAIN_HOLDS_PREFIX}${workspaceId}`;

/** `ledger.chain-holds.<ws>`: an absolute path of at most 1024 characters, no control character, no `..` part. */
export const chainHoldsPathError = (value: string): string | null => {
  if (!value.startsWith('/') || value.length > 1024 || [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
    || value.split('/').includes('..')) {
    return `must be an absolute file path (at most 1024 characters, no control character, no ..), got ${JSON.stringify(value)}`;
  }
  return null;
};

/** A hold list is a few dozen lines; anything near this is not one. */
export const CHAIN_HOLDS_MAX_BYTES = 1 << 20;
/** The longest hold the hold list allows: a later until holds nothing. */
export const HOLD_MAX_DAYS = 14;

const DAY_MS = 24 * 60 * 60_000;
const LANE = /^[a-z0-9_-]{1,40}$/;
const KEY8 = /^[0-9a-f]{8}$/;
const UNTIL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const LINE = /^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;
const STATES: ReadonlySet<string> = new Set(['held', 'deferred']);

export type TChainDownQuiet = 'superseded' | 'held' | 'holder-gone';

/** The `range:<lane>:<key>` parts of a ledger key, lane casefolded; null for any other key. */
export const rangeParts = (key: string): { lane: string; id: string } | null => {
  const match = /^range:([^:]+):([^:]+)$/.exec(key);
  return match ? { lane: match[1].toLowerCase(), id: match[2].toLowerCase() } : null;
};

/** A control character other than tab (U+0000-U+0008, U+000B-U+001F, U+007F). */
const hasControl = (text: string): boolean => [...text].some((ch) => {
  const code = ch.charCodeAt(0);
  return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;
});

const untilMs = (text: string): number | null => {
  const m = UNTIL.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  // A calendar date that does not exist (02-30, 25:00) is refused, never rolled over.
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day
    && back.getUTCHours() === hour && back.getUTCMinutes() === minute && back.getUTCSeconds() === second ? ms : null;
};

/**
 * The holds in force at `now`, as `<lane>:<key8>` → until (ms). One hold per line, `<lane>:<key8> <state> <until>
 * <reason ...>`; `#` lines and blank lines are ignored. A line that breaks a rule holds nothing: a malformed key, a
 * state other than held or deferred, an until that is not UTC seconds, a reason with a control character, an until
 * at or before now or more than 14 days after it, and a key on two lines (both lines).
 */
export const parseChainHolds = (text: string, now: number): ReadonlyMap<string, number> => {
  const lines = text.replace(/^﻿/, '').split('\n');
  const found = new Map<string, number | null>();
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const fields = LINE.exec(line);
    if (!fields) continue;
    const [, keyText, stateText, untilText, reason] = fields;
    const key = keyText.toLowerCase();
    const colon = key.indexOf(':');
    if (colon < 0 || !LANE.test(key.slice(0, colon)) || !KEY8.test(key.slice(colon + 1))) continue;
    // A key on two lines refuses both, whatever else is wrong with either.
    if (found.has(key)) {
      found.set(key, null);
      continue;
    }
    const until = untilMs(untilText);
    const holds = STATES.has(stateText.toLowerCase()) && until !== null && !hasControl(reason)
      && until > now && until - now <= HOLD_MAX_DAYS * DAY_MS;
    found.set(key, holds ? until : null);
  }
  const held = new Map<string, number>();
  for (const [key, until] of found) if (until !== null) held.set(key, until);
  return held;
};

/** The hold for a range key, or null: lane equal, and the hold's key8 the first 8 characters of the range's key. */
export const holdFor = (holds: ReadonlyMap<string, number>, itemKey: string, now: number): number | null => {
  const parts = rangeParts(itemKey);
  if (!parts || parts.id.length < 8) return null;
  const until = holds.get(`${parts.lane}:${parts.id.slice(0, 8)}`);
  return until !== undefined && until > now ? until : null;
};

export interface IChainDownContext {
  /** The workspace's holds in force; null when no hold list is set or it could not be read (nothing is held). */
  holds: ReadonlyMap<string, number> | null;
  /** The tab ids and names of the workspace's layout; null when the layout could not be read (no holder is judged gone). */
  tabs: ReadonlySet<string> | null;
}

/** Why a `chain-down` item raises no alarm, or null when it alarms. Any other reason always alarms. */
export const chainDownQuiet = (
  item: Pick<IBoardStuckItem, 'key' | 'reason' | 'holder' | 'supersededBy'>, context: IChainDownContext, now: number,
): TChainDownQuiet | null => {
  if (item.reason !== 'chain-down') return null;
  if (item.supersededBy) return 'superseded';
  if (context.holds && holdFor(context.holds, item.key, now) !== null) return 'held';
  if (item.holder !== null && context.tabs !== null && !context.tabs.has(item.holder)) return 'holder-gone';
  return null;
};
