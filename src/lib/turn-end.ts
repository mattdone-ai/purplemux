// Browser-safe: the classifier the watchdog runs on every agent `stop`, and the
// stall rule for a tab that waits on background work (ADR-0018).

import type { IOpenBackgroundTaskKinds } from '@/lib/providers/types';

export const TURN_TAIL_CHARS = 600;
// CHECKPOINTED: a worker's reply to a planned host maintenance (L71): its handoff path, an end line like the others.
export const TURN_MARKERS = ['DONE:', 'BLOCKED:', 'NEEDS-DECISION:', 'READY-TO-MERGE:', 'CHECKPOINTED:'] as const;
const READY_TO_MERGE = 'READY-TO-MERGE:';
const MAX_MARKER_LINE_CHARS = 300;
const MAX_READY_TO_MERGE_LINES = 5;

/** A marker without its colon: the value of `--report-on` and of `ITab.reportOn` (ADR-0025). */
export type TTurnMarkerName = 'DONE' | 'BLOCKED' | 'NEEDS-DECISION' | 'READY-TO-MERGE' | 'CHECKPOINTED';
export const TURN_MARKER_NAMES: readonly TTurnMarkerName[] = TURN_MARKERS.map((m) => m.slice(0, -1) as TTurnMarkerName);

/** The marker a classified end line starts with (`extractTurnMarker` guarantees one), or null. */
export const turnMarkerName = (line: string): TTurnMarkerName | null =>
  TURN_MARKER_NAMES.find((name) => line.startsWith(`${name}:`)) ?? null;

export type TReportOnParse =
  | { ok: true; markers: TTurnMarkerName[] | null }
  | { ok: false; error: string };

/**
 * `--report-on` / `reportOn`: a non-empty subset of the five markers, or `all` /
 * null to clear the filter (every end line is forwarded, today's behaviour).
 * Names are read case-insensitively, with or without the colon; duplicates
 * collapse; order is the markers' own. An empty set is refused: a tab that
 * reports nothing silences itself, and `tab close` is the way to do that.
 */
export const parseReportOn = (value: unknown): TReportOnParse => {
  if (value === null || value === undefined) return { ok: true, markers: null };
  const raw: unknown[] = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [value];
  const names = new Set<TTurnMarkerName>();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: `reportOn takes marker names, not ${JSON.stringify(item)}` };
    const name = item.trim().toUpperCase().replace(/:$/, '');
    if (!name) continue;
    if (name === 'ALL') return { ok: true, markers: null };
    const known = TURN_MARKER_NAMES.find((m) => m === name);
    if (!known) return { ok: false, error: `reportOn: unknown marker ${JSON.stringify(item.trim())}; expected ${TURN_MARKER_NAMES.join(', ')} or all` };
    names.add(known);
  }
  if (names.size === 0) return { ok: false, error: `reportOn needs at least one marker (${TURN_MARKER_NAMES.join(', ')}) or all` };
  return { ok: true, markers: TURN_MARKER_NAMES.filter((m) => names.has(m)) };
};

/**
 * Whether a turn's end lines reach the tab's nudge target: the LAST line's
 * marker (the turn's own verdict; READY-TO-MERGE lines above it ride along)
 * must be in the tab's `reportOn`. No filter forwards every marker.
 */
export const reportOnAdmits = (reportOn: readonly TTurnMarkerName[] | null | undefined, lines: readonly string[]): boolean => {
  if (!reportOn || reportOn.length === 0) return true;
  const last = lines.at(-1);
  const name = last ? turnMarkerName(last) : null;
  return name !== null && reportOn.includes(name);
};

export type TTurnEnd =
  | { kind: 'turn-marker'; lines: string[] }
  | { kind: 'waiting'; openBackgroundTasks: number; liveRegisteredJobs: number; armedWatches: number }
  | { kind: 'ready-for-review'; transcript: boolean };

export interface ITurnEndInput {
  /** `lastAssistantTail` from the provider; undefined when the provider cannot read one. */
  tail: string | null | undefined;
  /** False when no transcript could be read at all (no parser, no path, read error). */
  transcript: boolean;
  openBackgroundTasks: number;
  liveRegisteredJobs: number;
  /** `purplemux watch` records the tab owns: each one wakes it through the inbox (ADR-0015). */
  armedWatches: number;
}

// Markdown emphasis, a quote, or a list prefix (`- `, `+ `, `1. `, `2) `) around the marker does not hide it (review r1, 3).
const bare = (line: string): string =>
  line.trim().replace(/^(?:[>*_`\s]|[-+](?=\s)|\d+[.)](?=\s))+/, '').replace(/[*_`\s]+$/, '');

const clip = (line: string): string =>
  line.length > MAX_MARKER_LINE_CHARS ? `${line.slice(0, MAX_MARKER_LINE_CHARS)}…` : line;

// A second marker inside an end line, at the start or after a character that cannot be part of a marker word
// (D28: "NEEDS-DECISION: is not mine to send — ORCH holds it. CHECKPOINTED: …" opened an owner item).
const INNER_MARKER = new RegExp(`(?:^|[^A-Za-z0-9_-])(${TURN_MARKER_NAMES.join('|')}):`, 'g');
const NEEDS_DECISION = 'NEEDS-DECISION:';

const startMarker = (line: string): string | null => TURN_MARKERS.find((marker) => line.startsWith(marker)) ?? null;

/**
 * True when the line starts with a marker, names one more marker after it, and one of the two is `NEEDS-DECISION:`
 * (the D28 shape: a question quoted beside another verdict asks nothing). Any other pair keeps the FIRST marker:
 * `DONE: … READY-TO-MERGE: PR #12` is a DONE (review r1, 2).
 */
const holdsTwoMarkers = (line: string): boolean => {
  const marker = startMarker(line);
  if (marker === null) return false;
  const inner = [...line.slice(marker.length).matchAll(INNER_MARKER)].map((match) => `${match[1]}:`);
  return inner.length > 0 && (marker === NEEDS_DECISION || inner.includes(NEEDS_DECISION));
};

/**
 * What a turn's tail ends on, unclipped:
 * - `marker`: the end line and the `READY-TO-MERGE:` lines that ride along above it. `complete` is false only when the
 *   end line runs from the first character of a tail cut at TURN_TAIL_CHARS, where its start may be missing.
 * - `refused`: the end line starts with a marker and holds a second one, one of the two `NEEDS-DECISION:` (D28). It
 *   counts as no marker; the caller logs it.
 * - null: no end line.
 *
 * The end line is the last non-empty line when that starts with a marker (ADR-0018). Otherwise it is the last
 * paragraph (the lines after the last blank line) joined by one space, when the paragraph's FIRST line starts with a
 * marker (R-09: a wrapped DONE line); `READY-TO-MERGE:` lines that open the paragraph ride along and the join starts at
 * the marker line after them. An earlier paragraph is never read, and no marker inside a line counts.
 */
export type TTurnEndRead =
  | { kind: 'marker'; lines: string[]; complete: boolean }
  | { kind: 'refused'; reason: 'two-markers'; line: string }
  | null;

export const readTurnEnd = (tail: string | null | undefined): TTurnEndRead => {
  if (!tail) return null;
  const raw = tail.split('\n').map(bare);
  let lastIndex = raw.length - 1;
  while (lastIndex >= 0 && !raw[lastIndex]) lastIndex--;
  if (lastIndex < 0) return null;
  const cut = tail.length >= TURN_TAIL_CHARS;
  let end: string;
  let endIndex = lastIndex;
  if (startMarker(raw[lastIndex])) {
    end = raw[lastIndex];
  } else {
    let first = lastIndex;
    while (first > 0 && raw[first - 1]) first--;
    // A paragraph that starts at the first character of a cut tail may lack its start: its first line is unknown.
    if (first === lastIndex || !startMarker(raw[first]) || (first === 0 && cut)) return null;
    // READY-TO-MERGE lines that open the paragraph ride along; the end line is the marker line after them.
    let start = first;
    while (start < lastIndex && raw[start].startsWith(READY_TO_MERGE) && startMarker(raw[start + 1])) start++;
    end = raw.slice(start, lastIndex + 1).join(' ');
    endIndex = start;
  }
  if (holdsTwoMarkers(end)) return { kind: 'refused', reason: 'two-markers', line: end };
  const above: string[] = [];
  for (let i = endIndex - 1; i >= 0 && above.length < MAX_READY_TO_MERGE_LINES; i--) {
    if (!raw[i]) continue;
    if (!raw[i].startsWith(READY_TO_MERGE) || holdsTwoMarkers(raw[i])) break;
    above.unshift(raw[i]);
  }
  if (end.startsWith(READY_TO_MERGE) && above.length === MAX_READY_TO_MERGE_LINES) above.shift();
  return { kind: 'marker', lines: [...above, end], complete: endIndex > 0 || !cut };
};

/**
 * The marker lines a turn ended on, each clipped at 300 chars, or null (`readTurnEnd`). `READY-TO-MERGE:` lines
 * directly above the end line ride along (one per PR, then `DONE:` — worker contract rule 10), at most five.
 */
export const extractTurnMarker = (tail: string | null | undefined): string[] | null => {
  const read = readTurnEnd(tail);
  return read?.kind === 'marker' ? read.lines.map(clip) : null;
};

/**
 * The turn's end line, unclipped (ADR-0041: a NEEDS-DECISION question is built from all of it): the marker end line
 * of `readTurnEnd`, joined when it wrapped, else the last non-empty line. The tail is the END of the message, so a line
 * that starts inside it is whole; `complete` is false only when the line runs from the first character of a tail cut
 * at TURN_TAIL_CHARS, where its start may be missing.
 */
export const lastTurnLine = (tail: string | null | undefined): { line: string; complete: boolean } | null => {
  if (!tail) return null;
  const read = readTurnEnd(tail);
  if (read?.kind === 'marker') return { line: read.lines.at(-1)!, complete: read.complete };
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = bare(lines[i]);
    if (line) return { line, complete: i > 0 || tail.length < TURN_TAIL_CHARS };
  }
  return null;
};

/**
 * A marker wins: the worker said what it is. Without one, open background work
 * (the provider's own tasks, a registered `tab bg` job, or an armed `purplemux
 * watch`) means the harness wakes the worker later, so the stop is WAITING.
 * Otherwise the stop is `ready-for-review` with no end line: the watchdog sends
 * no immediate nudge for it, only the delayed idle nudge (L49).
 */
export const classifyTurnEnd = (input: ITurnEndInput): TTurnEnd => {
  const lines = extractTurnMarker(input.tail);
  if (lines) return { kind: 'turn-marker', lines };
  if (input.openBackgroundTasks > 0 || input.liveRegisteredJobs > 0 || input.armedWatches > 0) {
    return {
      kind: 'waiting',
      openBackgroundTasks: input.openBackgroundTasks,
      liveRegisteredJobs: input.liveRegisteredJobs,
      armedWatches: input.armedWatches,
    };
  }
  return { kind: 'ready-for-review', transcript: input.transcript };
};

/**
 * The quiet window after a stop with no end line and nothing live, before the
 * one `idle-no-end-line` nudge (L49; measured 27 Sep: 22 immediate READY nudges
 * in 2 h 07 min, all on tabs that were only waiting). Fleet config key
 * `watchdog.idle-nudge-minutes` (ADR-0019) overrides it, read by every status poll.
 */
export const IDLE_NUDGE_CONFIG_KEY = 'watchdog.idle-nudge-minutes';
export const IDLE_NUDGE_DEFAULT_MS = 15 * 60 * 1000;
const IDLE_NUDGE_MAX_MINUTES = 24 * 60;

/**
 * The window in ms for a fleet value, or null when the value is absent or not
 * a number of minutes in (0, 1440]. Decimals are allowed (0.05 = 3 s), so an
 * acceptance run can prove the nudge without a 15 min wait.
 */
export const parseIdleNudgeMinutes = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const minutes = Number(value.trim());
  if (!(minutes > 0) || minutes > IDLE_NUDGE_MAX_MINUTES) return null;
  return Math.round(minutes * 60 * 1000);
};

// Measured 2026-09-26: the longest silence of an open subagent was 10.0 min
// (the foreground Bash limit) over 46 intervals; gates run 20–40 min.
export const AGENT_STALL_WINDOW_MS = 15 * 60 * 1000;
export const SHELL_STALL_BACKSTOP_MS = 90 * 60 * 1000;

/**
 * One `long-wait` nudge per WAITING stretch on a live registered job or an armed
 * watch that outlasts this (review r1 finding 4; story 30 F3's intent): such a
 * tab is never STALLED, so without it a hung gate or a 7-day watch is silent.
 * Fleet config key `watchdog.wait-backstop-hours` overrides it.
 */
export const WAIT_BACKSTOP_CONFIG_KEY = 'watchdog.wait-backstop-hours';
export const WAIT_BACKSTOP_DEFAULT_MS = 4 * 60 * 60 * 1000;
const WAIT_BACKSTOP_MAX_HOURS = 7 * 24;

/** The backstop in ms for a fleet value, or null when it is not hours in (0, 168]. */
export const parseWaitBackstopHours = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const hours = Number(value.trim());
  if (!(hours > 0) || hours > WAIT_BACKSTOP_MAX_HOURS) return null;
  return Math.round(hours * 60 * 60 * 1000);
};

/**
 * The poll's derived timers (review r1 finding 2: derived from the recorded
 * stop, so a server restart keeps them). The idle nudge is due when the tab's
 * latest event is still the markerless stop it classified, the window has
 * passed since it, and no nudge was sent for that stop yet.
 */
export const idleNudgeDue = (
  turnEnd: { kind: string; at: number; seq?: number; idleNudgeSentSeq?: number } | null | undefined,
  lastEvent: { name: string; seq: number } | null | undefined,
  cliState: string,
  windowMs: number,
  now: number,
): boolean =>
  !!turnEnd && turnEnd.kind === 'ready-for-review' && cliState === 'ready-for-review'
  && turnEnd.seq !== undefined && lastEvent?.name === 'stop' && lastEvent.seq === turnEnd.seq
  && turnEnd.idleNudgeSentSeq !== turnEnd.seq && now - turnEnd.at >= windowMs;

/** The long-wait backstop is due on the same terms for a WAITING stop that is still the latest event. */
export const longWaitDue = (
  turnEnd: { kind: string; at: number; seq?: number; longWaitSentSeq?: number } | null | undefined,
  lastEvent: { name: string; seq: number } | null | undefined,
  cliState: string,
  backstopMs: number,
  now: number,
): boolean =>
  !!turnEnd && turnEnd.kind === 'waiting' && cliState === 'busy'
  && turnEnd.seq !== undefined && lastEvent?.name === 'stop' && lastEvent.seq === turnEnd.seq
  && turnEnd.longWaitSentSeq !== turnEnd.seq && now - turnEnd.at >= backstopMs;

/**
 * A live registered `tab bg` job or an armed `purplemux watch` holds a busy tab
 * that WAITS on it (its latest event is the stop classified `waiting`) off
 * STALLED completely (L49: both "possibly stalled" nudges of 27 Sep fired
 * on such tabs). Each has its own reporter: the liveness manager reports the
 * job's exit, and the watch reports its condition, its failure or its expiry.
 */
export const holdsOffStall = (liveRegisteredJobs: number, armedWatches: number): boolean =>
  liveRegisteredJobs > 0 || armedWatches > 0;

/**
 * Whether a busy tab that waits on its own background work is stalled, or null
 * when nothing is open (the caller keeps its default rule). Silence means
 * something different per kind: a working subagent writes its transcript all
 * the time; a gate waiter writes nothing until it exits; a Monitor ends itself
 * at its timeout. `activityAt` is the newest sign of life of the tab.
 */
export const isBackgroundWaitStalled = (
  kinds: IOpenBackgroundTaskKinds | undefined,
  activityAt: number | null,
  now: number,
): boolean | null => {
  if (!kinds || kinds.shell + kinds.agent + kinds.monitor === 0) return null;
  const silentMs = activityAt === null ? Infinity : now - activityAt;
  if (kinds.agent > 0) return silentMs >= AGENT_STALL_WINDOW_MS;
  if (kinds.shell > 0) return silentMs >= SHELL_STALL_BACKSTOP_MS;
  return false;
};
