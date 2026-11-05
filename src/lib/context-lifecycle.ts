import path from 'path';
import { createLogger } from '@/lib/logger';
import { checkHandoff } from '@/lib/handoff-check';
import { DEFAULT_ROTATE_AT_TOKENS } from '@/lib/constraint';
import { LEDGER_SERVER_PRODUCER } from '@/lib/ledger';
import type { ISeatTab, TRotateAt, TSeatPhase } from '@/types/context-lifecycle';
import type { ILedgerEventInput, TLedgerAttrValue } from '@/types/ledger';

// Context lifecycle (ADR-0036; ADR-HFL-04): a tab created with `--handoff <path>` is a seat. When its context
// reaches the rotate threshold, or after a compaction, and it sits at its prompt with no background work, it is
// sent ROTATE; on HANDOFF-READY its handoff file is checked, and a pass restarts it fresh under the same tab id
// with the file as its first read. The seat item in the ledger records its context, compactions and rotations.

const log = createLogger('context-lifecycle');

export const ROTATE_AT_CONFIG_KEY = 'context.rotate-at-tokens';
export const ROTATE_AT_MIN = 50_000;
export const ROTATE_AT_MAX = 900_000;
/** AC 5: the seat item takes a context reading at most this often. */
export const CONTEXT_RECORD_MS = 5 * 60_000;
/**
 * One deadline per rotation, set by its first ROTATE and never moved by a resend (10-N1): past it the digest hold is
 * released, no ROTATE is resent, and the rotation counts as one failed check.
 */
export const ROTATION_DEADLINE_MS = 30 * 60_000;
/** A rotation asks ROTATE at most this many times more after its first (10-N1). */
const MAX_ROTATE_RESENDS = 1;
export const CONTEXT_TICK_MS = 30_000;
/**
 * A step that could not go yet is tried again this soon, up to RETRIES times, before the next idle or the 30 s
 * tick takes over: a restart refused `tab-busy` right after HANDOFF-READY is usually the stop's own turn
 * acknowledgement still in flight (orchestration-activity.ts; AC 7 run: 28.3 s to the tick without it, 3.9 s
 * with it), and a ROTATE refused inside the settle window of another delivery waits it out.
 */
export const RETRY_MS = 3_000;
const RETRIES = 5;
/** A rotated seat's first message waits this long after the restart for the fresh agent; then it is dropped. */
export const FIRST_MESSAGE_TTL_MS = 10 * 60_000;
/** A failed check's message carries the reasons up to this many bytes; `handoff check` prints them all. */
const FAILED_MESSAGE_MAX = 1_500;

/** `context.rotate-at-tokens` and `--rotate-at`: a whole number of tokens in [50,000, 900,000], or null. */
export const parseRotateAtTokens = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/[_,]/g, '') : '';
  if (!/^\d+$/.test(text)) return null;
  const tokens = Number(text);
  return tokens >= ROTATE_AT_MIN && tokens <= ROTATE_AT_MAX ? tokens : null;
};

export type TRotateAtParse = { ok: true; rotateAt: TRotateAt } | { ok: false; error: string };

/** A tab's `--rotate-at`: `off`, or a token count in range. */
export const parseTabRotateAt = (value: unknown): TRotateAtParse => {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'off') return { ok: true, rotateAt: 'off' };
  const tokens = parseRotateAtTokens(value);
  if (tokens !== null) return { ok: true, rotateAt: tokens };
  return { ok: false, error: `rotateAt must be off or a whole number of tokens from ${ROTATE_AT_MIN} to ${ROTATE_AT_MAX}, got ${JSON.stringify(value)}` };
};

export interface ISeatOptions {
  handoffPath?: string;
  rotateAt?: TRotateAt;
}

export type TSeatOptionsCheck = { ok: true; options: ISeatOptions } | { ok: false; error: string; code: 'invalid-request' };

const HANDOFF_PATH_MAX = 1024;

/**
 * `tab create --handoff <path> --rotate-at <N|off>` (ADR-0036 §1). The path is absolute and need not exist yet: the
 * seat writes it on its first ROTATE. A remote tab is refused: the harness reads the file on this host.
 */
export const checkSeatOptions = (handoff: unknown, rotateAt: unknown, host: unknown): TSeatOptionsCheck => {
  const refuse = (error: string): TSeatOptionsCheck => ({ ok: false, error, code: 'invalid-request' });
  if (handoff === undefined || handoff === null) {
    return rotateAt === undefined || rotateAt === null ? { ok: true, options: {} } : refuse('rotateAt needs handoff: only a tab with a handoff path rotates');
  }
  if (typeof handoff !== 'string' || !path.isAbsolute(handoff)) return refuse(`handoff must be an absolute path, got ${JSON.stringify(handoff)}`);
  if (handoff.length > HANDOFF_PATH_MAX || /[\p{C}]/u.test(handoff)) return refuse(`handoff must be one printable path of at most ${HANDOFF_PATH_MAX} characters`);
  if (host !== undefined && host !== null) return refuse('handoff is local only: the harness reads the handoff file on this host, and a remote tab writes it on its own');
  const options: ISeatOptions = { handoffPath: path.normalize(handoff) };
  if (rotateAt === undefined || rotateAt === null) return { ok: true, options };
  const parsed = parseTabRotateAt(rotateAt);
  return parsed.ok ? { ok: true, options: { ...options, rotateAt: parsed.rotateAt } } : refuse(parsed.error);
};

/** The threshold a seat rotates at, or null when its rotation is off. */
export const seatThreshold = (rotateAt: TRotateAt | null | undefined, fleetDefault: number): number | null =>
  (rotateAt === 'off' ? null : typeof rotateAt === 'number' ? rotateAt : fleetDefault);

/** ADR-HFL-01: `seat:<ws>:<tab-name>`. */
export const seatItemKey = (workspaceId: string, tabName: string): string => `seat:${workspaceId}:${tabName}`;

export const rotateMessage = (path: string): string => `ROTATE: bring ${path} up to date, then end your turn with HANDOFF-READY.`;

export const resumeMessage = (path: string, resumeCommand: string): string => `Read ${path}, then continue: ${resumeCommand}`;

export const checkFailedMessage = (path: string, reasons: readonly string[]): string => {
  const head = `HANDOFF CHECK FAILED: ${path}: `;
  const tail = ' Fix the file, then end your turn with HANDOFF-READY.';
  let listed = reasons.join('; ');
  if (listed.length > FAILED_MESSAGE_MAX) listed = `${listed.slice(0, FAILED_MESSAGE_MAX - 1)}… (purplemux handoff check ${path} prints every reason)`;
  return `${head}${listed}.${tail}`;
};

// Markdown emphasis or a quote around the line does not hide it (turn-end.ts reads end lines the same way).
const bare = (line: string): string => line.trim().replace(/^[>*_`\s]+/, '').replace(/[*_`\s]+$/, '');

/**
 * The turn's last non-empty line is the word `HANDOFF-READY` (case as written), alone, followed by `.` or `!`, or
 * starting `HANDOFF-READY:` (10-N1).
 */
export const isHandoffReady = (tail: string | null | undefined): boolean => {
  const last = tail?.split('\n').map(bare).filter(Boolean).at(-1);
  return !!last && /^HANDOFF-READY(?::|[.!]?$)/.test(last);
};

export type TRestartOutcome = { ok: true } | { ok: false; busy: boolean; error: string };

export interface IContextLifecycleDeps {
  now: () => number;
  /** The tab when it is a seat (has a handoff path), else null. */
  seat: (tabId: string) => ISeatTab | null;
  seats: () => ISeatTab[];
  /** `context.rotate-at-tokens`, parsed; the default when unset or invalid. */
  fleetRotateAt: () => number;
  /** The agent session the tab is bound to now, or null while none is. */
  sessionId: (tabId: string) => string | null;
  /** At its prompt (idle, ready for review or a WAITING stop), not halted, no registered job or open task (consult 10-C1). */
  canRotate: (tabId: string) => Promise<boolean>;
  /** The state half of `canRotate`, re-checked inside the dispatch lock just before a paste. */
  atPrompt: (tabId: string) => boolean;
  /** Type a `rotate` event through the tab event router (urgent, ADR-0035); true when it was typed. */
  send: (seat: ISeatTab, text: string, whenReady: () => boolean) => Promise<boolean>;
  /** The handoff file as UTF-8 text, a BOM kept; throws when it cannot be read or decoded. */
  readHandoff: (path: string) => Promise<string>;
  /** `tab restart --clear` (ADR-0028); a WAITING seat's `interrupt` is decided inside the restart lock. */
  restart: (seat: ISeatTab) => Promise<TRestartOutcome>;
  /** Type the fresh session's first message once it is idle at its prompt; true when it was typed. */
  typeFirstMessage: (seat: ISeatTab, text: string) => Promise<boolean>;
  /** Type the urgent events held for the seat since `since` (the router's hold while it is `rotating`). */
  releaseUrgent: (seat: ISeatTab, since: number) => void;
  /** Append server events to the ledger; throws when the ledger cannot be written. */
  record: (workspaceId: string, events: ILedgerEventInput[]) => void;
  /** The attrs and state of the seat's open item, to carry its state across a server restart. */
  readSeatItem: (workspaceId: string, itemKey: string, holder: string) => { state: string | null; attrs: Record<string, TLedgerAttrValue> } | null;
  /** Tests shorten RETRY_MS. */
  retryMs?: number;
}

interface ISeatState {
  itemKey: string;
  phase: TSeatPhase;
  contextTokens: number | null;
  contextAt: number | null;
  /** The session the reading came from: a reading of another session is no reading of this one (F5). */
  contextSessionId: string | null;
  recordedAt: number | null;
  recordedTokens: number | null;
  compactions: number;
  compactionsSinceRotation: number;
  rotations: number;
  lastRotationAt: number | null;
  rotateRequestedAt: number | null;
  /** ROTATE is asked again at the next idle: the seat ran a turn that did not end with HANDOFF-READY (F1). */
  resendRotate: boolean;
  /** ROTATEs typed after the first of this rotation (at most MAX_ROTATE_RESENDS). */
  resends: number;
  /** The rotation's deadline, set by its first ROTATE (10-N1). */
  deadline: number | null;
  /** After a timed-out rotation the next one starts no sooner than this: the digest hold is never back-to-back. */
  nextRotationAt: number | null;
  /** The session that ended its turn with HANDOFF-READY, to tell a restart that happened from one that did not (F3). */
  readySessionId: string | null;
  failures: number;
  /** The failed-check message, until it is typed (it waits out the settle window like ROTATE). */
  pendingMessage: string | null;
  /** A PostCompact came: the rotation runs at the next idle, whatever the context. */
  compactionPending: boolean;
  alarm: string | null;
  /** `rotating`: the first message, the session before the restart, when the restart finished. */
  firstMessage: string | null;
  sessionBefore: string | null;
  restartedAt: number | null;
  /** A session-start newer than the restart came, or the bound session is not the one before it (F4). */
  freshSession: boolean;
  /** When the seat entered `rotating`: urgent events held since then are released after the first message. */
  rotatingSince: number | null;
  /** When a rotated seat's first message was dropped; the board flags it until a later rotation delivers one. */
  handoffUndeliveredAt: number | null;
  retries: number;
}

const num = (value: TLedgerAttrValue | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: TLedgerAttrValue | undefined): string | null => (typeof value === 'string' && value ? value : null);

/** Every phase in which the seat owes, or is getting, a rotation: its digests are held (F1, F4). */
const OPEN_PHASES: readonly TSeatPhase[] = ['rotate-requested', 'handoff-ready', 'rotating'];

/**
 * One instance per server process (the StatusManager owns it). Every step for one tab runs in turn
 * (`advance` is serialized per tab), so two idles never send two ROTATEs or run two checks.
 */
export class ContextLifecycle {
  private readonly states = new Map<string, ISeatState>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private eventCounter = 0;

  constructor(private readonly deps: IContextLifecycleDeps) {}

  /** A tab's state for tests; null for a tab that is not a seat or was never seen. */
  view(tabId: string): Readonly<ISeatState> | null {
    return this.states.get(tabId) ?? null;
  }

  /** The router holds the seat's digests while it owes a rotation or waits for its first message (F1, F4). */
  holdsDigest(tabId: string): boolean {
    const state = this.states.get(tabId);
    return !!state && OPEN_PHASES.includes(state.phase);
  }

  /** While `rotating` the router holds urgent events too, so the fresh session reads its handoff first. */
  holdsUrgent(tabId: string): boolean {
    return this.states.get(tabId)?.phase === 'rotating';
  }

  private attrs(seat: ISeatTab, state: ISeatState): Record<string, TLedgerAttrValue> {
    return {
      tabId: seat.tabId,
      handoffPath: seat.handoffPath,
      rotateAtTokens: seatThreshold(seat.rotateAt, this.deps.fleetRotateAt()),
      contextTokens: state.contextTokens,
      contextAt: state.contextAt,
      compactions: state.compactions,
      compactionsSinceRotation: state.compactionsSinceRotation,
      rotations: state.rotations,
      lastRotationAt: state.lastRotationAt,
      rotateRequestedAt: state.rotateRequestedAt,
      rotationDeadline: state.deadline,
      nextRotationAt: state.nextRotationAt,
      rotateResends: state.resends,
      readySessionId: state.readySessionId,
      rotationFailures: state.failures,
      rotationAlarm: state.alarm,
      firstMessage: state.firstMessage,
      sessionBefore: state.sessionBefore,
      restartedAt: state.restartedAt,
      rotatingSince: state.rotatingSince,
      handoffUndeliveredAt: state.handoffUndeliveredAt,
    };
  }

  /** One server event on the seat item. A ledger that cannot be written never stops a rotation. */
  private write(seat: ISeatTab, state: ISeatState, kind: 'open' | 'state' | 'clear' | 'close', extra: Record<string, TLedgerAttrValue> = {}): void {
    const at = this.deps.now();
    this.eventCounter += 1;
    const event: ILedgerEventInput = {
      event_id: kind === 'open' || kind === 'close'
        ? `${LEDGER_SERVER_PRODUCER}:${state.itemKey}:${kind}:${seat.tabId}`
        : `${LEDGER_SERVER_PRODUCER}:${state.itemKey}:${kind}:${at}:${this.eventCounter}`,
      at,
      item_type: 'seat',
      item_key: state.itemKey,
      kind,
      holder: seat.tabName,
      ...(kind === 'state' ? { state: state.phase } : {}),
      ...(kind === 'close' ? { state: 'closed' } : {}),
      attrs: { ...this.attrs(seat, state), ...extra },
    };
    try {
      this.deps.record(seat.workspaceId, [event]);
    } catch (err) {
      log.warn(`seat ${state.itemKey} ${kind} not recorded: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Where a seat stood when the server last wrote its item (F3). `rotating` resumes waiting for the fresh session,
   * or, when the restart never ran (no restart time and the same session), checks the file again. `handoff-ready`
   * whose session changed was restarted: it is `rotating` with the first message read from the file again; with the
   * same session it owes a fresh HANDOFF-READY.
   */
  private resumed(item: { state: string | null; attrs: Record<string, TLedgerAttrValue> } | null, sessionNow: string | null): Partial<ISeatState> {
    const a = item?.attrs ?? {};
    const requested = num(a.rotateRequestedAt);
    // An item written before the deadline was kept carries none: its request time bounds it.
    const deadline = num(a.rotationDeadline) ?? (requested === null ? null : requested + ROTATION_DEADLINE_MS);
    const sessionChanged = (before: string | null) => before !== null && sessionNow !== null && sessionNow !== before;
    if (item?.state === 'rotation-alarm') return { phase: 'rotation-alarm' };
    if (item?.state === 'rotating') {
      const restartedAt = num(a.restartedAt);
      if (restartedAt === null && !sessionChanged(str(a.sessionBefore))) return { phase: 'handoff-ready', deadline };
      // The first-message timeout runs from the resume: a server down longer than it must not drop the handoff of a
      // fresh session that is waiting at its prompt, nor leave an unknown restart time unbounded (confirm P1, P2).
      return {
        phase: 'rotating', firstMessage: str(a.firstMessage), sessionBefore: str(a.sessionBefore), restartedAt: this.deps.now(),
        freshSession: sessionChanged(str(a.sessionBefore)), rotatingSince: num(a.rotatingSince) ?? restartedAt ?? this.deps.now(),
      };
    }
    if (item?.state === 'handoff-ready') {
      const ready = str(a.readySessionId);
      // Restarted while no server listened: the first-message timeout runs from now, not from an older rotation (10-N2).
      if (sessionChanged(ready)) {
        return { phase: 'rotating', firstMessage: null, sessionBefore: ready, restartedAt: this.deps.now(), freshSession: true, rotatingSince: this.deps.now() };
      }
      return { phase: 'rotate-requested', resendRotate: true, deadline };
    }
    if (item?.state === 'rotate-requested' && requested !== null) return { phase: 'rotate-requested', deadline };
    return { phase: 'watching' };
  }

  /** The seat's state, opened in the ledger the first time it is seen, with its counts carried from the item. */
  private stateOf(seat: ISeatTab): ISeatState {
    const existing = this.states.get(seat.tabId);
    if (existing) return existing;
    const itemKey = seatItemKey(seat.workspaceId, seat.tabName);
    let item: ReturnType<IContextLifecycleDeps['readSeatItem']> = null;
    try {
      item = this.deps.readSeatItem(seat.workspaceId, itemKey, seat.tabName);
    } catch (err) {
      log.warn(`seat ${itemKey} not read; counting from 0: ${err instanceof Error ? err.message : err}`);
    }
    const a = item?.attrs ?? {};
    const state: ISeatState = {
      itemKey,
      phase: 'watching',
      contextTokens: null,
      contextAt: null,
      contextSessionId: null,
      recordedAt: null,
      recordedTokens: null,
      compactions: num(a.compactions) ?? 0,
      compactionsSinceRotation: num(a.compactionsSinceRotation) ?? 0,
      rotations: num(a.rotations) ?? 0,
      lastRotationAt: num(a.lastRotationAt),
      rotateRequestedAt: num(a.rotateRequestedAt),
      resendRotate: false,
      resends: num(a.rotateResends) ?? 0,
      deadline: null,
      nextRotationAt: num(a.nextRotationAt),
      readySessionId: str(a.readySessionId),
      failures: num(a.rotationFailures) ?? 0,
      pendingMessage: null,
      compactionPending: false,
      alarm: str(a.rotationAlarm),
      firstMessage: null,
      sessionBefore: null,
      restartedAt: null,
      freshSession: false,
      rotatingSince: num(a.rotatingSince),
      handoffUndeliveredAt: num(a.handoffUndeliveredAt),
      retries: 0,
      ...this.resumed(item, this.deps.sessionId(seat.tabId)),
    };
    this.states.set(seat.tabId, state);
    this.write(seat, state, item ? 'state' : 'open');
    return state;
  }

  /** Open the seat item of every seat now (server start, tab create): a seat with no reading is still a seat. */
  register(tabId: string): void {
    const seat = this.deps.seat(tabId);
    if (seat) this.stateOf(seat);
  }

  /** A statusline reading (AC 5) of `sessionId`: kept at once, recorded at most every 5 min, and a rotation checked. */
  onContext(tabId: string, tokens: number, sessionId: string | null = this.deps.sessionId(tabId)): void {
    const seat = this.deps.seat(tabId);
    if (!seat || !Number.isFinite(tokens) || tokens < 0) return;
    const state = this.stateOf(seat);
    state.contextTokens = tokens;
    state.contextAt = this.deps.now();
    state.contextSessionId = sessionId;
    this.recordReadingIfDue(seat, state);
    const threshold = seatThreshold(seat.rotateAt, this.deps.fleetRotateAt());
    if (threshold !== null && tokens >= threshold) this.schedule(tabId);
  }

  /** The reading belongs to the session the tab is bound to now; a reading of an earlier session is dropped (F5). */
  private dropStaleReading(seat: ISeatTab, state: ISeatState): void {
    const now = this.deps.sessionId(seat.tabId);
    if (state.contextTokens !== null && state.contextSessionId !== null && now !== null && now !== state.contextSessionId) {
      state.contextTokens = null;
      state.contextAt = null;
    }
  }

  private recordReadingIfDue(seat: ISeatTab, state: ISeatState): void {
    if (state.contextTokens === null || state.contextTokens === state.recordedTokens) return;
    const now = this.deps.now();
    if (state.recordedAt !== null && now - state.recordedAt < CONTEXT_RECORD_MS) return;
    state.recordedAt = now;
    state.recordedTokens = state.contextTokens;
    this.write(seat, state, 'clear');
  }

  /** PreCompact counts a missed rotation (the board flags it); PostCompact makes the rotation due at the next idle. */
  onCompact(tabId: string, phase: 'pre' | 'post'): void {
    const seat = this.deps.seat(tabId);
    if (!seat) return;
    const state = this.stateOf(seat);
    if (phase === 'pre') {
      state.compactions += 1;
      state.compactionsSinceRotation += 1;
      this.write(seat, state, 'clear', { lastCompactAt: this.deps.now() });
      return;
    }
    state.compactionPending = true;
    state.contextTokens = null;
    this.schedule(tabId);
  }

  /**
   * A session start (not a compaction's): a human `/clear` or a fresh launch has no context yet (F5); after a
   * rotation's restart it is the fresh session the first message waits for (F4).
   */
  onSessionStart(tabId: string): void {
    const state = this.states.get(tabId);
    if (!state) return;
    state.contextTokens = null;
    state.contextAt = null;
    state.contextSessionId = null;
    if (state.phase === 'rotating' && state.restartedAt !== null && this.deps.now() >= state.restartedAt) state.freshSession = true;
    this.schedule(tabId);
  }

  /** A new turn started after HANDOFF-READY: the file may be stale again, so the seat owes a fresh HANDOFF-READY (F1). */
  onPromptSubmit(tabId: string): void {
    const seat = this.deps.seat(tabId);
    const state = this.states.get(tabId);
    if (!seat || !state || state.phase !== 'handoff-ready') return;
    state.phase = 'rotate-requested';
    state.resendRotate = true;
    state.rotateRequestedAt = this.wholeSecond();
    this.write(seat, state, 'state', { rotateResend: 'a turn started after HANDOFF-READY' });
  }

  /**
   * A classified stop. HANDOFF-READY answers an open request (or retries after an alarm). Any other end line while
   * the seat owes a rotation means the seat did other work: ROTATE is asked again at the next idle (F1).
   */
  onTurnEnd(tabId: string, tail: string | null | undefined): void {
    const seat = this.deps.seat(tabId);
    if (!seat) return;
    const state = this.stateOf(seat);
    const ready = isHandoffReady(tail);
    if (ready && (state.phase === 'rotate-requested' || state.phase === 'rotation-alarm')) {
      state.phase = 'handoff-ready';
      state.readySessionId = this.deps.sessionId(tabId);
      state.resendRotate = false;
      state.pendingMessage = null;
      // A HANDOFF-READY after an alarm has no rotation deadline yet: it starts one, so the hold stays bounded (P3).
      if (state.deadline === null) state.deadline = this.deps.now() + ROTATION_DEADLINE_MS;
      this.write(seat, state, 'state');
    } else if (!ready && (state.phase === 'rotate-requested' || state.phase === 'handoff-ready')) {
      // The stamp must be newer than this turn (10-N4), whether or not ROTATE is asked again.
      state.phase = 'rotate-requested';
      state.resendRotate = true;
      state.rotateRequestedAt = this.wholeSecond();
      this.write(seat, state, 'state', { rotateResend: 'a turn ended without HANDOFF-READY' });
    }
    this.schedule(tabId);
  }

  /** The tab reached its prompt. */
  onIdle(tabId: string): void {
    if (this.deps.seat(tabId)) this.schedule(tabId);
  }

  /** A restart from outside the rotation: the new session's context is not yet read. */
  onRestarted(tabId: string): void {
    const state = this.states.get(tabId);
    if (!state || state.phase === 'rotating') return;
    state.contextTokens = null;
    state.contextAt = null;
  }

  onClosed(tabId: string, seat: ISeatTab | null): void {
    const state = this.states.get(tabId);
    if (state && seat) this.write(seat, state, 'close');
    this.states.delete(tabId);
  }

  /** Every seat: a reading due for the ledger, a rotation or a first message due at the prompt. */
  async tick(): Promise<void> {
    for (const seat of this.deps.seats()) {
      const state = this.stateOf(seat);
      this.dropStaleReading(seat, state);
      this.recordReadingIfDue(seat, state);
      await this.advance(seat.tabId);
    }
  }

  private schedule(tabId: string): void {
    void this.advance(tabId).catch((err) => log.warn(`context lifecycle step for ${tabId} failed: ${err instanceof Error ? err.message : err}`));
  }

  /** A step that could not go yet runs again shortly, a bounded number of times; progress resets the count. */
  private retrySoon(seat: ISeatTab, state: ISeatState): void {
    if (state.retries >= RETRIES) return;
    state.retries += 1;
    setTimeout(() => this.schedule(seat.tabId), this.deps.retryMs ?? RETRY_MS).unref?.();
  }

  /** One step for the tab; a step asked for while one runs runs once more after it. */
  advance(tabId: string): Promise<void> {
    const current = this.running.get(tabId);
    if (current) {
      this.again.add(tabId);
      return current;
    }
    const run = (async () => {
      try {
        do {
          this.again.delete(tabId);
          await this.step(tabId);
        } while (this.again.has(tabId));
      } finally {
        this.running.delete(tabId);
      }
    })();
    this.running.set(tabId, run);
    return run;
  }

  private async step(tabId: string): Promise<void> {
    const seat = this.deps.seat(tabId);
    if (!seat) return;
    const state = this.stateOf(seat);
    // Urgent events held by a rotation that is no longer `rotating` (resumed after a server stop as `handoff-ready`)
    // go now, whatever the re-check or the deadline does next (architect re-confirm r2, U).
    if (state.phase !== 'rotating' && state.rotatingSince !== null) this.release(seat, state);
    this.dropStaleReading(seat, state);
    if ((state.phase === 'rotate-requested' || state.phase === 'handoff-ready') && state.deadline !== null && this.deps.now() >= state.deadline) {
      this.timedOut(seat, state);
      return;
    }
    if (state.phase === 'watching') await this.maybeRequest(seat, state, false);
    else if (state.phase === 'rotate-requested') {
      if (state.resendRotate && state.resends >= MAX_ROTATE_RESENDS) state.resendRotate = false;
      if (state.pendingMessage) await this.sendPending(seat, state);
      else if (state.resendRotate) await this.maybeRequest(seat, state, true);
    }
    else if (state.phase === 'handoff-ready') await this.checkAndRotate(seat, state);
    else if (state.phase === 'rotating') await this.maybeTypeFirstMessage(seat, state);
  }

  /** Whole seconds: `date -u -Iseconds` in the same second is not older than a request stamped now. */
  private wholeSecond(): number {
    return Math.floor(this.deps.now() / 1000) * 1000;
  }

  /**
   * The rotation's deadline passed without a restart (10-N1): the digest hold is released, no ROTATE is resent, and
   * it counts as one failed check, so a second failed rotation raises the alarm (ADR-0036 §2).
   */
  private timedOut(seat: ISeatTab, state: ISeatState): void {
    const reason = `no rotation within ${ROTATION_DEADLINE_MS / 60_000} min of the first ROTATE (the seat was ${state.phase})`;
    state.failures += 1;
    state.resendRotate = false;
    state.pendingMessage = null;
    state.deadline = null;
    if (state.failures >= 2) {
      state.phase = 'rotation-alarm';
      state.alarm = reason;
      this.write(seat, state, 'state', { rotationTimedOut: true });
      log.warn({ tabId: seat.tabId, failures: state.failures }, 'rotation alarm: the second rotation failed; the session is left as it is');
      return;
    }
    state.phase = 'watching';
    state.nextRotationAt = this.deps.now() + ROTATION_DEADLINE_MS;
    this.write(seat, state, 'state', { rotationTimedOut: true, lastCheckFailure: reason });
    log.info({ tabId: seat.tabId }, 'rotation timed out: the digest hold is released');
  }

  /** Why the router holds this tab's digests, for the stale-digest flag; null when the lifecycle holds nothing. */
  holdReason(tabId: string): string | null {
    const state = this.states.get(tabId);
    if (!state || !OPEN_PHASES.includes(state.phase)) return null;
    const until = state.deadline !== null ? `, released by ${new Date(state.deadline).toISOString().replace(/\.\d{3}Z$/, 'Z')} at the latest` : '';
    return `the seat's context rotation holds its digests (phase ${state.phase}${until})`;
  }

  /** ROTATE when due (`again`: the seat owes a fresh HANDOFF-READY, whatever its context). */
  private async maybeRequest(seat: ISeatTab, state: ISeatState, again: boolean): Promise<void> {
    const threshold = seatThreshold(seat.rotateAt, this.deps.fleetRotateAt());
    if (threshold === null) return;
    const overThreshold = state.contextTokens !== null && state.contextTokens >= threshold;
    if (!again && !overThreshold && !state.compactionPending) return;
    if (!again && state.nextRotationAt !== null && this.deps.now() < state.nextRotationAt) return;
    if (!(await this.deps.canRotate(seat.tabId))) return;
    const requestedAt = this.wholeSecond();
    const sent = await this.deps.send(seat, rotateMessage(seat.handoffPath), () => this.deps.atPrompt(seat.tabId));
    if (!sent) {
      this.retrySoon(seat, state);
      return;
    }
    state.phase = 'rotate-requested';
    state.rotateRequestedAt = requestedAt;
    state.resendRotate = false;
    state.retries = 0;
    // Failures count across rotations until one succeeds: the second failed rotation is the alarm (10-N1).
    if (again) state.resends += 1;
    else {
      state.resends = 0;
      state.deadline = this.deps.now() + ROTATION_DEADLINE_MS;
      state.nextRotationAt = null;
    }
    this.write(seat, state, 'state', { rotateReason: again ? 'resend' : state.compactionPending ? 'compaction' : 'threshold' });
    log.info({ tabId: seat.tabId, contextTokens: state.contextTokens, threshold, compaction: state.compactionPending, again }, 'rotate requested');
  }

  private async checkAndRotate(seat: ISeatTab, state: ISeatState): Promise<void> {
    if (!(await this.deps.canRotate(seat.tabId))) {
      log.info({ tabId: seat.tabId }, 'handoff check waits: the seat is not at its prompt or has background work');
      return;
    }
    let reasons: string[];
    let resumeCommand: string | null = null;
    try {
      const result = checkHandoff(await this.deps.readHandoff(seat.handoffPath), this.deps.now(), state.rotateRequestedAt);
      reasons = result.reasons;
      resumeCommand = result.resumeCommand;
    } catch (err) {
      reasons = [`cannot read ${seat.handoffPath}: ${err instanceof Error ? err.message : err} (expected a readable UTF-8 handoff file)`];
    }
    if (!reasons.length && resumeCommand) {
      // Written before the restart: a server that stops mid-rotation resumes it from here (F3).
      state.phase = 'rotating';
      // Kept when set: a rotation resumed from before a server stop releases what it held then too.
      state.rotatingSince ??= this.deps.now();
      state.firstMessage = resumeMessage(seat.handoffPath, resumeCommand);
      state.sessionBefore = this.deps.sessionId(seat.tabId);
      state.restartedAt = null;
      state.freshSession = false;
      this.write(seat, state, 'state');
      log.info({ tabId: seat.tabId }, 'handoff check passed: restarting the seat');
      const outcome = await this.deps.restart(seat);
      if (outcome.ok) {
        this.restarted(seat, state);
        return;
      }
      state.phase = 'handoff-ready';
      state.firstMessage = null;
      state.sessionBefore = null;
      this.release(seat, state);
      if (outcome.busy) {
        // A turn started, or the stop's acknowledgement is still in flight: the check runs again shortly.
        this.write(seat, state, 'state');
        this.retrySoon(seat, state);
        return;
      }
      reasons = [`the restart failed: ${outcome.error}`];
    }
    await this.failed(seat, state, reasons);
  }

  /** The restart ran; the seat stays `rotating` until its first message is typed into the fresh session (F3, F4). */
  private restarted(seat: ISeatTab, state: ISeatState): void {
    const now = this.deps.now();
    state.rotations += 1;
    state.lastRotationAt = now;
    state.restartedAt = now;
    state.compactionsSinceRotation = 0;
    state.compactionPending = false;
    state.contextTokens = null;
    state.contextAt = null;
    state.contextSessionId = null;
    state.recordedTokens = null;
    state.rotateRequestedAt = null;
    state.deadline = null;
    state.resends = 0;
    state.failures = 0;
    state.alarm = null;
    state.retries = 0;
    this.write(seat, state, 'state');
    log.info({ tabId: seat.tabId, rotations: state.rotations }, 'seat restarted: the first message waits for the fresh session');
  }

  /** The first message goes once a session newer than the restart is idle at its prompt; never on the old idle (F4). */
  private async maybeTypeFirstMessage(seat: ISeatTab, state: ISeatState): Promise<void> {
    if (state.restartedAt !== null && this.deps.now() - state.restartedAt >= FIRST_MESSAGE_TTL_MS) {
      log.warn({ tabId: seat.tabId }, 'rotated seat never reported a fresh session: its first message was not typed');
      state.handoffUndeliveredAt = this.deps.now();
      this.settle(seat, state, { firstMessageDropped: true });
      return;
    }
    const bound = this.deps.sessionId(seat.tabId);
    if (!state.freshSession && bound !== null && state.sessionBefore !== null && bound !== state.sessionBefore) state.freshSession = true;
    if (!state.freshSession) return;
    if (!state.firstMessage) {
      try {
        const resume = checkHandoff(await this.deps.readHandoff(seat.handoffPath), this.deps.now(), null).resumeCommand;
        state.firstMessage = resume ? resumeMessage(seat.handoffPath, resume) : null;
      } catch (err) {
        log.warn(`first message of ${seat.tabId} not rebuilt: ${err instanceof Error ? err.message : err}`);
      }
      if (!state.firstMessage) {
        state.handoffUndeliveredAt = this.deps.now();
        this.settle(seat, state, { firstMessageDropped: true });
        return;
      }
    }
    if (await this.deps.typeFirstMessage(seat, state.firstMessage)) {
      state.handoffUndeliveredAt = null;
      this.settle(seat, state, {});
      log.info({ tabId: seat.tabId, rotations: state.rotations }, 'seat rotated');
    }
  }

  /** The urgent events held while `rotating` go now, oldest first. */
  private release(seat: ISeatTab, state: ISeatState): void {
    const since = state.rotatingSince;
    state.rotatingSince = null;
    if (since !== null) this.deps.releaseUrgent(seat, since);
  }

  /** The rotation is over: back to watching, and the urgent events it held are typed after the first message. */
  private settle(seat: ISeatTab, state: ISeatState, extra: Record<string, TLedgerAttrValue>): void {
    this.release(seat, state);
    state.phase = 'watching';
    state.firstMessage = null;
    state.sessionBefore = null;
    state.restartedAt = null;
    state.freshSession = false;
    state.readySessionId = null;
    this.write(seat, state, 'state', extra);
  }

  /** One message naming the failed check; a second failure raises the alarm and leaves the session (ADR-0036 §2). */
  private async failed(seat: ISeatTab, state: ISeatState, reasons: string[]): Promise<void> {
    state.failures += 1;
    if (state.failures >= 2) {
      state.phase = 'rotation-alarm';
      state.alarm = reasons.join('; ').slice(0, 500);
      this.write(seat, state, 'state');
      log.warn({ tabId: seat.tabId, failures: state.failures, reasons }, 'rotation alarm: the handoff check failed twice; the session is left as it is');
      return;
    }
    state.phase = 'rotate-requested';
    state.pendingMessage = checkFailedMessage(seat.handoffPath, reasons);
    this.write(seat, state, 'state', { lastCheckFailure: reasons.join('; ').slice(0, 500) });
    await this.sendPending(seat, state);
  }

  /** The failed-check message, at the prompt and out of any delivery's settle window; retried until typed. */
  private async sendPending(seat: ISeatTab, state: ISeatState): Promise<void> {
    if (!state.pendingMessage || !(await this.deps.canRotate(seat.tabId))) return;
    if (await this.deps.send(seat, state.pendingMessage, () => this.deps.atPrompt(seat.tabId))) {
      state.pendingMessage = null;
      state.retries = 0;
    } else {
      this.retrySoon(seat, state);
    }
  }
}

/** A fleet value that does not parse is the default; the reason is logged once per value. */
export const fleetRotateAtFrom = (value: string | null, onInvalid?: (value: string) => void): number => {
  if (value === null) return DEFAULT_ROTATE_AT_TOKENS;
  const parsed = parseRotateAtTokens(value);
  if (parsed === null) onInvalid?.(value);
  return parsed ?? DEFAULT_ROTATE_AT_TOKENS;
};
