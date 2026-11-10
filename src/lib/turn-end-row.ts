// Browser-safe: the typed turn end (F6, folding in F10 steps 1 and 2; design check (2) ruling, 2026-11-10).
//
// A worker writes one row per turn with `purplemux done` before it stops. No stop is held (party ruling SIMPLIFY,
// 2026-11-10, which amends design check (2) rulings (3), (4) and (6)). At apply time ONE precedence order decides
// between the row and the applied end line (`resolveTurnEnd`); the marker classifier (turn-end.ts) reads that end line.
// A scoped worker's turn end with no row gets an UNREPORTED `no-row` row, which measures adoption. This module holds
// the rules; the store, the service and the stop route apply them.

import { TURN_MARKER_NAMES, readTurnEnd, type TTurnMarkerName } from '@/lib/turn-end';

export type TTurnVerdict = TTurnMarkerName;
export const TURN_VERDICTS: readonly TTurnVerdict[] = TURN_MARKER_NAMES;
export type TSeatRole = 'builder' | 'reviewer' | 'consult';
export const SEAT_ROLES: readonly TSeatRole[] = ['builder', 'reviewer', 'consult'];

/** A scoped turn end with no row: `no-row`, or `no-row:<why>` for a stop no row was asked of (remote, replay, …). */
export type TUnreportedReason = 'no-row' | `no-row:${string}`;

export const REASON_MAX_CHARS = 500;
/** The stop route decides within this, or the classifier applies (ruling (1)). */
export const STOP_DECISION_DEADLINE_MS = 1_000;

/** Fleet config kill switches (F10 staged plan, step 1 and 2). Unset means on. */
export const STOP_PAYLOAD_CONFIG_KEY = 'hook.stop-payload';
export const TURN_END_SOURCE_CONFIG_KEY = 'turn-end.source';

export interface ITurnEndRow {
  sessionId: string;
  turnId: number;
  workspaceId: string;
  tabId: string;
  seatRole: TSeatRole | null;
  story: string | null;
  attempt: number | null;
  verdict: TTurnVerdict | 'UNREPORTED';
  head: string | null;
  gateLog: string | null;
  /** The gate's verdict when a gate log was checked (`VALID` or `VALID (…)`). */
  gateVerdict: string | null;
  reason: string | null;
  /** `done`: the worker wrote it; `unreported`: the server wrote it at a turn end with no valid row. */
  source: 'done' | 'unreported';
  unreportedReason: TUnreportedReason | null;
  at: number;
  consumedAt: number | null;
}

/** C0 controls, DEL and the Unicode line and paragraph separators: none of them survives in a one-line reason. */
const isLineBreaking = (code: number): boolean => code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;

const MARKER_WORD = new RegExp(`(?:^|[^A-Za-z0-9_-])(${TURN_MARKER_NAMES.join('|')}):`);

/**
 * `--reason` as one line of at most 500 characters (ruling (5)): whitespace and control characters collapse to one
 * space. A reason that holds a marker word (`DONE:` …) is refused: the synthesized end line would carry two markers,
 * the D28 shape the classifier refuses.
 */
export const cleanReason = (raw: unknown): { ok: true; reason: string | null } | { ok: false; error: string } => {
  if (raw === undefined || raw === null) return { ok: true, reason: null };
  if (typeof raw !== 'string') return { ok: false, error: `reason must be text, got ${typeof raw}` };
  const one = Array.from(raw, (ch) => (isLineBreaking(ch.codePointAt(0)!) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  if (!one) return { ok: true, reason: null };
  if (one.length > REASON_MAX_CHARS) return { ok: false, error: `reason is ${one.length} characters after cleaning; at most ${REASON_MAX_CHARS}` };
  const marker = MARKER_WORD.exec(one);
  if (marker) return { ok: false, error: `reason holds the turn marker ${marker[1]}:; the verdict is --verdict, never text in the reason` };
  return { ok: true, reason: one };
};

/** The seat a scope declares, or `builder` when it names a story and declares none (ruling (8)). */
export const seatRoleOf = (scope: { story: string | null; seat?: TSeatRole | null } | null): TSeatRole | null =>
  scope ? scope.seat ?? (scope.story ? 'builder' : null) : null;

/**
 * The end line the row stands for, starting with its marker so every later step (the nudge, reportOn, the window's
 * BLOCKED/NEEDS-DECISION exemption, the NEEDS-DECISION item) reads it as an end line (ruling (5)).
 */
export const synthesizeLine = (row: Pick<ITurnEndRow, 'verdict' | 'reason' | 'story' | 'head' | 'gateVerdict'>): string => {
  const marker = row.verdict === 'UNREPORTED' ? 'UNREPORTED' : row.verdict;
  const facts = [
    row.story ? `story ${row.story}` : null,
    row.head ? `head ${row.head.slice(0, 12)}` : null,
    row.gateVerdict ? `gate ${row.gateVerdict}` : null,
  ].filter((fact): fact is string => fact !== null);
  const reason = row.reason ?? (row.verdict === 'DONE' ? 'done' : row.verdict.toLowerCase());
  return `${marker}: ${reason}${facts.length ? ` (${facts.join(', ')})` : ''}`;
};

/** rank (party ruling, section 1): NEEDS-DECISION 2, BLOCKED 1, every other verdict or no marker 0. */
const RANK: Readonly<Record<string, number>> = { 'NEEDS-DECISION': 2, BLOCKED: 1 };
const rankOf = (verdict: string | null): number => (verdict !== null && Object.hasOwn(RANK, verdict) ? RANK[verdict] : 0);

/** The payload tail's end-line marker, or null (no tail, no marker, or a refused two-marker line). */
export const tailMarker = (tail: string | null | undefined): TTurnMarkerName | null => {
  const read = readTurnEnd(tail);
  if (read?.kind !== 'marker') return null;
  const last = read.lines.at(-1) ?? '';
  return TURN_MARKER_NAMES.find((name) => last.startsWith(`${name}:`)) ?? null;
};

/**
 * The ONE precedence order (party ruling SIMPLIFY, section 1), evaluated once, at apply time, against E: the end line
 * the stop applies. The higher rank wins (NEEDS-DECISION > BLOCKED > the rest); on equal rank the row wins over the
 * end line. So: a NEEDS-DECISION row > a NEEDS-DECISION line > a BLOCKED row > a BLOCKED line > a rank-0 row > a rank-0
 * line. WAITING and ready-for-review (no row, no marker) are the classifier's and never reach here.
 */
export const resolveTurnEnd = (rowVerdict: TTurnVerdict, endLineMarker: TTurnMarkerName | null): 'row' | 'line' =>
  rankOf(endLineMarker) > rankOf(rowVerdict) ? 'line' : 'row';

/** A stop's context: why no row is asked of it, or null when one is (a live, local, scoped Claude worker). */
export interface ITurnEndContext {
  stopFailure: boolean;
  replayed: boolean;
  remote: boolean;
  evaluator: boolean;
  provider: string;
  openRotation: boolean;
  coordinator: boolean;
  scoped: boolean;
}

export const noRowExemption = (c: ITurnEndContext): string | null => {
  if (c.stopFailure) return 'stop-failure';
  if (c.replayed) return 'replayed';
  if (c.remote) return 'remote';
  if (c.evaluator) return 'evaluator';
  if (c.provider !== 'claude') return `provider-${c.provider}`;
  if (c.openRotation) return 'rotation';
  if (c.coordinator) return 'coordinator';
  if (!c.scoped) return 'unscoped';
  return null;
};

export type TStopDecision =
  /** The stop applies as before this story: the classifier's lines. */
  | { kind: 'classifier'; why: string }
  /** The stop's turn has a row: `resolveTurnEnd` decides at apply time between it and the applied end line. */
  | { kind: 'row'; row: ITurnEndRow }
  /** A scoped turn end with no row: an UNREPORTED row for its turn, and the classifier's verdict. */
  | { kind: 'unreported'; reason: TUnreportedReason; turnId?: number };

export interface IStopDecisionInput {
  /** `turn-end.source=classifier`: the kill switch. */
  classifierOnly: boolean;
  context: ITurnEndContext;
  /** The tab's bound agent session; null when none is bound. */
  sessionId: string | null;
  /** The unconsumed row of the stop's own turn, or null. */
  row: ITurnEndRow | null;
  /** The payload tail's marker: only whether the stop is markerless (a WAITING candidate) is read here. */
  tailMarker: TTurnMarkerName | null;
  /**
   * Open work that makes a markerless stop a WAITING stop: registered jobs + armed watches + open provider tasks.
   * null when it could not be read by the deadline. Read only when the tail has no marker and there is no row.
   */
  openWork: () => Promise<number | null>;
}

/**
 * One stop's decision. Nothing is held. A row is always handed to apply time, where the precedence order is evaluated
 * against the end line actually applied (never against this tail). A markerless stop with open work is WAITING and
 * asks no row; an unknown count asks none either.
 */
export const decideStop = async (input: IStopDecisionInput): Promise<TStopDecision> => {
  if (input.classifierOnly) return { kind: 'classifier', why: 'turn-end.source=classifier' };
  if (input.sessionId === null) return { kind: 'classifier', why: 'no bound agent session' };
  if (input.row) return { kind: 'row', row: input.row };
  if (input.tailMarker === null) {
    const open = await input.openWork();
    if (open === null) return { kind: 'classifier', why: 'open work unknown by the deadline' };
    if (open > 0) return { kind: 'classifier', why: 'waiting on open work' };
  }
  const exempt = noRowExemption(input.context);
  if (exempt === 'unscoped' || exempt === 'coordinator') return { kind: 'classifier', why: exempt };
  return { kind: 'unreported', reason: exempt === null ? 'no-row' : `no-row:${exempt}` };
};
