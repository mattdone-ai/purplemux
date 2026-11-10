import { createLogger } from '@/lib/logger';
import { TURN_TAIL_CHARS } from '@/lib/turn-end';
import {
  STOP_DECISION_DEADLINE_MS,
  decideStop,
  tailMarker,
  type ITurnEndContext,
  type ITurnEndRow,
  type TStopDecision,
  type TUnreportedReason,
} from '@/lib/turn-end-row';
import type { TurnEndsTable } from '@/lib/turn-ends-store';

// The stop gate (F6, folding in F10 steps 1 and 2). The Claude Stop hook posts its payload; this class decides,
// within 1 s, whether the stop's turn has a row, applies the classifier, or ends with no row (UNREPORTED `no-row`). It
// keeps the stop's message so the classifier reads the payload rather than racing the transcript flush (F10 step 1).
// No stop is held (party ruling SIMPLIFY, 2026-11-10): StatusManager evaluates the precedence order once, at apply
// time, against the end line it applies.

const log = createLogger('stop-gate');

export interface IStopPayload {
  /** `Stop` or `StopFailure` (the script word is `stop` for both). */
  hookEvent: string | null;
  sessionId: string | null;
  /** `last_assistant_message`, whole. */
  message: string | null;
}

export interface IStopGateTab {
  workspaceId: string;
  agentSessionId: string | null | undefined;
  host: string | null | undefined;
  providerId: string;
}

export interface IStopGateDeps {
  now: () => number;
  table: () => TurnEndsTable;
  /** `turn-end.source` is `row` (unset means row). */
  rowsAreSource: () => boolean;
  /** `hook.stop-payload` is on (unset means on). */
  payloadIsTail: () => boolean;
  isCoordinator: (workspaceId: string, tabId: string) => Promise<boolean>;
  isScoped: (workspaceId: string, tabId: string) => Promise<boolean>;
  /** The tab's fixed role (ADR-0040): an evaluator's allow-list cannot run `purplemux`, so no row is asked of it. */
  roleOf: (workspaceId: string, tabId: string) => Promise<string | null>;
  /** The seat is between ROTATE and its first message (ADR-0036): no row is asked of it. */
  inRotation: (tabId: string) => boolean;
  /** Registered jobs + armed watches + open provider tasks; null when unknown. */
  openWork: (tabId: string) => Promise<number | null>;
  deadlineMs?: number;
}

const timeout = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(value), ms);
    timer.unref?.();
  });

export class StopGate {
  private readonly decisions = new Map<string, TStopDecision>();
  private readonly payloads = new Map<string, { sessionId: string | null; tail: string }>();

  constructor(private readonly deps: IStopGateDeps) {}

  /**
   * Decide one Claude stop and keep the decision for `take` when the stop is applied. Never throws: an error, or the
   * deadline, applies the classifier.
   */
  async decide(tabId: string, tab: IStopGateTab, payload: IStopPayload, replayedAt?: number): Promise<TStopDecision> {
    if (payload.message !== null && payload.sessionId !== null && payload.sessionId === tab.agentSessionId) {
      this.payloads.set(tabId, { sessionId: payload.sessionId, tail: payload.message.slice(-TURN_TAIL_CHARS) });
    } else {
      this.payloads.delete(tabId);
    }
    let decision: TStopDecision;
    let turnId: number | null = null;
    try {
      const decided = await Promise.race([
        this.decideNow(tabId, tab, payload, replayedAt),
        timeout(this.deps.deadlineMs ?? STOP_DECISION_DEADLINE_MS, { decision: { kind: 'classifier', why: 'decision deadline' } as TStopDecision, turnId: null }),
      ]);
      decision = decided.decision;
      turnId = decided.turnId;
    } catch (err) {
      log.warn({ tabId, err: err instanceof Error ? err.message : String(err) }, 'stop decision failed; the classifier applies');
      decision = { kind: 'classifier', why: 'decision error' };
    }
    // An UNREPORTED row is written against the turn this stop belongs to (review nit 3).
    if (decision.kind === 'unreported' && turnId !== null) decision = { ...decision, turnId };
    this.decisions.set(tabId, decision);
    return decision;
  }

  /**
   * The stop's turn: the session's current one for a live stop; for a replayed stop, the turn that had started when it
   * fired (review nit 3), so neither its row nor its UNREPORTED write lands on a later turn.
   */
  private turnOf(sessionId: string, replayedAt?: number): number | null {
    const table = this.deps.table();
    return replayedAt === undefined ? table.currentTurn(sessionId)?.turnId ?? null : table.turnAt(sessionId, replayedAt);
  }

  private async decideNow(tabId: string, tab: IStopGateTab, payload: IStopPayload, replayedAt?: number): Promise<{ decision: TStopDecision; turnId: number | null }> {
    const sessionId = tab.agentSessionId ?? null;
    const turn = sessionId ? this.turnOf(sessionId, replayedAt) : null;
    const row = sessionId && turn !== null ? this.deps.table().unconsumed(sessionId, turn) : null;
    const tail = this.payloads.get(tabId)?.tail ?? null;
    const context: ITurnEndContext = {
      stopFailure: payload.hookEvent === 'StopFailure',
      replayed: replayedAt !== undefined,
      remote: !!tab.host,
      evaluator: (await this.deps.roleOf(tab.workspaceId, tabId)) === 'evaluator',
      provider: tab.providerId,
      openRotation: this.deps.inRotation(tabId),
      coordinator: await this.deps.isCoordinator(tab.workspaceId, tabId),
      scoped: await this.deps.isScoped(tab.workspaceId, tabId),
    };
    // No payload message (a dropped body, a replay without one) and no row: the classifier alone.
    if (tail === null && !row) return { decision: { kind: 'classifier', why: 'no payload message' }, turnId: turn };
    const decision = await decideStop({
      classifierOnly: !this.deps.rowsAreSource(),
      context,
      sessionId: turn !== null ? sessionId : null,
      row,
      tailMarker: tailMarker(tail),
      openWork: () => this.deps.openWork(tabId),
    });
    return { decision, turnId: turn };
  }

  /** The decision for the stop being applied now, taken once. Absent: the classifier (a stop from an older script). */
  take(tabId: string): TStopDecision | null {
    const decision = this.decisions.get(tabId) ?? null;
    this.decisions.delete(tabId);
    return decision;
  }

  /** The stop's own message as the tail (F10 step 1), when the kill switch allows and it belongs to the bound session. */
  takeTail(tabId: string, boundSessionId: string | null | undefined): string | null {
    const payload = this.payloads.get(tabId);
    this.payloads.delete(tabId);
    if (!payload || !this.deps.payloadIsTail() || payload.sessionId !== boundSessionId) return null;
    return payload.tail;
  }

  /** A row the stop applies: used exactly once. False when another stop used it first. */
  consume(row: ITurnEndRow): boolean {
    return this.deps.table().consume(row.sessionId, row.turnId, this.deps.now());
  }

  /**
   * The turn ended with no valid row: one UNREPORTED row for it, with why (F10 AC2), against the stop's own turn
   * (`turnId`, else the current one). It never replaces a row the worker wrote: such a row is consumed instead, so
   * the turn keeps exactly one row and no later stop applies it (review CONCERN).
   */
  writeUnreported(tab: { workspaceId: string; agentSessionId?: string | null }, tabId: string, reason: TUnreportedReason, turnId?: number): void {
    const sessionId = tab.agentSessionId ?? null;
    if (!sessionId) return;
    const turn = turnId ?? this.deps.table().currentTurn(sessionId)?.turnId ?? null;
    if (turn === null) return;
    const at = this.deps.now();
    const written = this.deps.table().putIfAbsent({
      sessionId, turnId: turn, workspaceId: tab.workspaceId, tabId, seatRole: null, story: null, attempt: null,
      verdict: 'UNREPORTED', head: null, gateLog: null, gateVerdict: null, reason: null, source: 'unreported',
      unreportedReason: reason, at, consumedAt: at,
    });
    if (!written && this.deps.table().consume(sessionId, turn, at)) {
      log.info({ tabId, sessionId, turnId: turn, reason }, 'turn end applied without its row; the worker\'s row is kept and marked used');
    }
  }

  /** A live prompt-submit opened a new turn of the session. */
  onPromptSubmit(sessionId: string): void {
    this.deps.table().bumpTurn(sessionId, this.deps.now());
  }

  forget(tabId: string): void {
    this.decisions.delete(tabId);
    this.payloads.delete(tabId);
  }
}
