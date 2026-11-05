// Browser-safe: the one wake-class table (ADR-HFL-05 decision 1; ADR-0035 §1, consult ruling 2026-11-03).
// Every event bound for a tab gets exactly one class here: `urgent` is typed at once, `digest` waits for
// the tab's next digest, `log` is recorded and never typed.

import { turnMarkerName } from '@/lib/turn-end';
import type { TInboxKind } from '@/types/inbox';
import type { TOrchestrationNudgeKind } from '@/types/status';
import type { TWakeClass } from '@/types/tab-events';

/** Kinds that are not watchdog nudges or inbox notices. */
export type TWakeOtherKind = 'tab-send' | 'flag' | 'alarm' | 'red-main' | 'rotate' | 'standing-order' | 'curator-candidate';
export type TWakeKind = TOrchestrationNudgeKind | TInboxKind | TWakeOtherKind;

export interface IWakeDetail {
  /** `turn-marker`: the end lines, the last one carrying the verdict. */
  markerLines?: readonly string[];
  /** `bg-*`: the job's owner registered it with `notify: self`, so the tab waits on it. */
  toWaitingTab?: boolean;
  /** `heartbeat`: which beat of the idle episode (1 first). */
  beat?: number;
  /** `flag`, `alarm`: the raised severity. */
  severity?: 'warn' | 'block';
  /** `tab-send`: the message. */
  text?: string;
  /** `tab-send`: the receiving tab's name, matched against the header's `->` and `cc` lists. */
  recipientName?: string;
}

type TRule = TWakeClass | ((detail: IWakeDetail) => TWakeClass);

/** The verdict of a turn's end lines: the marker of the last one, or null when it carries none. */
export const lastTurnMarker = (lines: readonly string[] | undefined): string | null => {
  const last = lines?.at(-1)?.trim();
  return last ? turnMarkerName(last) : null;
};

// CHECKPOINTED waits; DONE, BLOCKED, NEEDS-DECISION, READY-TO-MERGE and an unrecognised end line are urgent
// (ruling 1): a class must never hold what it cannot name.
const byMarker = (detail: IWakeDetail): TWakeClass => (lastTurnMarker(detail.markerLines) === 'CHECKPOINTED' ? 'digest' : 'urgent');

const byWaitingTab = (detail: IWakeDetail): TWakeClass => (detail.toWaitingTab ? 'urgent' : 'digest');
const bySeverity = (detail: IWakeDetail): TWakeClass => (detail.severity === 'block' ? 'urgent' : 'digest');

const NO_REPLY = /\bno reply (?:is )?needed\b/i;
/** A verdict at a line start or right after the header (`X -> ORCH (cc Y): DONE: ...`): urgent (F7, 09-C1). */
const URGENT_MARKER = /(?:^|^[^:\n]{0,160}:)\s*(?:DONE|BLOCKED|NEEDS-DECISION|READY-TO-MERGE):/m;
/** An owner's answer relayed verbatim (the scrum master's approval route): urgent, as ADR-HFL-05 names it. */
const OWNER_RELAY = /\b(?:OWNER|answer)\b[^\n]{0,80}\bverbatim\b/i;
/** The fleet's header: `FROM -> TO[, TO...] (cc COPY[, COPY...]): ...`, sometimes in brackets. */
const HEADER = /^\[?([^:\n]{0,160}?)->([^:\n]{0,160}):/;
const TOKEN_SPLIT = /[\s,;()[\]]+/;
const GENERIC_PART = /^(?:v\d+|w)$/;

/** The header's `->` and `cc` lists, or null when the text carries none. */
export const parseSendHeader = (text: string): { to: string[]; cc: string[] } | null => {
  const header = HEADER.exec(text);
  if (!header) return null;
  const [toPart, ...ccParts] = header[2].split(/\bcc\b/i);
  const tokens = (part: string) => part.split(TOKEN_SPLIT).map((token) => token.trim()).filter(Boolean);
  return { to: tokens(toPart), cc: ccParts.flatMap(tokens) };
};

/**
 * A header name names the tab: its whole name, one part of it (`kit` for `v2-kit`, `H-1` for `…-h1`), a prefix
 * of a part of at least 3 letters (`ORCH` for `v2-orchestrator`), or the initials of its parts (`SM` for
 * `v2-scrum-master`). A name that matches nothing leaves the message urgent.
 */
export const headerNames = (token: string, tabName: string): boolean => {
  const name = tabName.toLowerCase();
  const want = token.toLowerCase();
  if (!want) return false;
  if (want === name) return true;
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  const bare = want.replace(/-/g, '');
  if (parts.includes(want) || parts.includes(bare)) return true;
  if (want.length >= 3 && parts.some((part) => part.startsWith(want))) return true;
  const initials = parts.filter((part) => !GENERIC_PART.test(part)).map((part) => part[0]).join('');
  return initials.length >= 2 && initials === bare;
};

/**
 * A `tab send` waits for the digest only when the receiving tab is a copy (on the `cc` list and not among the
 * `->` recipients), or when it says no reply is needed (ADR-HFL-05 decision 1; architect ruling 09-C1). Anything
 * addressed to the tab, a relayed owner answer, and a verdict marker stay urgent.
 */
export const isNoReplyMessage = (text: string, recipientName?: string): boolean => {
  if (URGENT_MARKER.test(text) || OWNER_RELAY.test(text)) return false;
  if (NO_REPLY.test(text)) return true;
  const header = parseSendHeader(text);
  if (!header || !recipientName) return false;
  return header.cc.some((token) => headerNames(token, recipientName)) && !header.to.some((token) => headerNames(token, recipientName));
};

/** Whether a send could be held at all: the route reads the receiving tab only for these. */
export const mayHoldTabSend = (text: string): boolean => NO_REPLY.test(text) || /\bcc\b/i.test(text.slice(0, 200));

/**
 * The class table. ADR-HFL-05 names urgent: red main, an owner answer, BLOCKED, NEEDS-DECISION, DONE,
 * READY-TO-MERGE, a block-severity alarm, ROTATE; digest: CHECKPOINTED, notes, "no reply needed", warn
 * flags, ledger alarms, probe reports; log: unchanged heartbeats and duplicates. The rest follow the
 * consult ruling of 2026-11-03: what stops a worker, or what a tab waits on, is urgent.
 */
export const WAKE_CLASS_TABLE: Readonly<Record<TWakeKind, TRule>> = {
  'turn-marker': byMarker,
  'needs-input': 'urgent',
  'off-scope': 'urgent',
  thrash: 'urgent',
  'api-error': 'urgent',
  'usage-limit': 'urgent',
  inactive: 'urgent',
  stalled: 'urgent',
  'model-drift': 'urgent',
  'bg-failed': byWaitingTab,
  'bg-exited-unknown': byWaitingTab,
  'bg-died': byWaitingTab,
  'bg-completed': byWaitingTab,
  'ready-for-review': 'digest',
  'turn-ended': 'digest',
  'idle-no-end-line': 'digest',
  'long-wait': 'digest',
  stuck: 'digest',
  'probe-failed': 'digest',
  // The first beat of an idle episode is news; later beats of the same episode are unchanged.
  heartbeat: (detail) => ((detail.beat ?? 1) > 1 ? 'log' : 'digest'),
  mission: 'urgent',
  resume: 'urgent',
  watch: 'urgent',
  deploy: 'urgent',
  note: 'digest',
  'tab-send': (detail) => (isNoReplyMessage(detail.text ?? '', detail.recipientName) ? 'digest' : 'urgent'),
  flag: bySeverity,
  alarm: bySeverity,
  'red-main': 'urgent',
  rotate: 'urgent',
  // A changed standing order reaches every live tab at once (ADR-HFL-05 decision 4, ADR-0041).
  'standing-order': 'urgent',
  // A standing-order candidate for v2's SM (story 23, consult C1): read at its next digest, never a wake of its own.
  'curator-candidate': 'digest',
};

/** The kind's class; a kind the table does not hold is urgent. */
export const classifyWake = (kind: string, detail: IWakeDetail = {}): TWakeClass => {
  const rule = Object.prototype.hasOwnProperty.call(WAKE_CLASS_TABLE, kind) ? WAKE_CLASS_TABLE[kind as TWakeKind] : 'urgent';
  return typeof rule === 'function' ? rule(detail) : rule;
};
