import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { LedgerStore } from '@/lib/ledger-store';
import { StopGate, type IStopGateDeps, type IStopGateTab } from '@/lib/stop-gate';
import { TURN_MARKER_NAMES, type TTurnMarkerName } from '@/lib/turn-end';
import {
  cleanReason,
  decideStop,
  noRowExemption,
  resolveTurnEnd,
  seatRoleOf,
  synthesizeLine,
  tailMarker,
  type IStopDecisionInput,
  type ITurnEndContext,
  type ITurnEndRow,
} from '@/lib/turn-end-row';

// F6, folding in F10 steps 1 and 2. No stop is held (party ruling SIMPLIFY, 2026-11-10): one precedence order decides
// between a row and the applied end line, at apply time.

const T0 = Date.UTC(2026, 10, 10, 1, 0, 0);
const S = 'sess-1';

const row = (over: Partial<ITurnEndRow> = {}): ITurnEndRow => ({
  sessionId: S, turnId: 1, workspaceId: 'ws-1', tabId: 'tab-w', seatRole: 'builder', story: 'F6', attempt: 1, verdict: 'DONE',
  head: 'a'.repeat(40), gateLog: '/w/g.log', gateVerdict: 'VALID', reason: 'shipped', source: 'done', unreportedReason: null,
  at: T0, consumedAt: null, ...over,
});

const worker: ITurnEndContext = {
  stopFailure: false, replayed: false, remote: false, evaluator: false, provider: 'claude', openRotation: false, coordinator: false, scoped: true,
};

const input = (over: Partial<IStopDecisionInput> = {}): IStopDecisionInput => ({
  classifierOnly: false, context: worker, sessionId: S, row: null, tailMarker: 'DONE', openWork: async () => 0, ...over,
});

describe('cleanReason (ruling (5))', () => {
  it('makes one line of the reason and keeps text', () => {
    expect(cleanReason('gate red\non lane 3 \tsee log')).toEqual({ ok: true, reason: 'gate red on lane 3 see log' });
    expect(cleanReason(undefined)).toEqual({ ok: true, reason: null });
    expect(cleanReason('  \n ')).toEqual({ ok: true, reason: null });
  });

  it.each(['see DONE: above', 'BLOCKED:x', 'it is (NEEDS-DECISION: which)', 'READY-TO-MERGE: #1'])('refuses a reason holding a marker word: %j', (text) => {
    expect(cleanReason(text)).toMatchObject({ ok: false, error: expect.stringContaining('holds the turn marker') });
  });

  it('keeps a marker-like word that is not a marker, and refuses a reason over 500 characters', () => {
    expect(cleanReason('UNDONE: nothing; X-DONE: no')).toMatchObject({ ok: true });
    expect(cleanReason('x'.repeat(501))).toMatchObject({ ok: false, error: expect.stringContaining('at most 500') });
    expect(cleanReason(42)).toMatchObject({ ok: false });
  });
});

describe('the seat and the synthesized line', () => {
  it('reads a declared seat, else builder when the scope names a story, else none (ruling (8))', () => {
    expect(seatRoleOf({ story: 'F6' })).toBe('builder');
    expect(seatRoleOf({ story: 'F6', seat: 'reviewer' })).toBe('reviewer');
    expect(seatRoleOf({ story: null })).toBeNull();
    expect(seatRoleOf(null)).toBeNull();
  });

  it('starts with the marker and carries story, head and gate (ruling (5))', () => {
    expect(synthesizeLine(row())).toBe(`DONE: shipped (story F6, head ${'a'.repeat(12)}, gate VALID)`);
    expect(synthesizeLine(row({ verdict: 'BLOCKED', reason: 'gate red', head: null, gateVerdict: null }))).toBe('BLOCKED: gate red (story F6)');
    expect(synthesizeLine(row({ reason: null, story: null, head: null, gateVerdict: null }))).toBe('DONE: done');
    expect(tailMarker(synthesizeLine(row({ verdict: 'NEEDS-DECISION', reason: 'A or B' })))).toBe('NEEDS-DECISION');
  });
});

describe('resolveTurnEnd: the one precedence order (party ruling, section 1)', () => {
  const rank = (marker: TTurnMarkerName | null) => (marker === 'NEEDS-DECISION' ? 2 : marker === 'BLOCKED' ? 1 : 0);
  const lines: Array<TTurnMarkerName | null> = [...TURN_MARKER_NAMES, null];

  it.each(TURN_MARKER_NAMES.flatMap((verdict) => lines.map((line) => [verdict, line] as const)))(
    'row %s against end line %s: the higher rank wins, the row on a tie', (verdict, line) => {
      expect(resolveTurnEnd(verdict, line)).toBe(rank(line) > rank(verdict) ? 'line' : 'row');
    });

  it('spells the order out: NEEDS-DECISION row > NEEDS-DECISION line > BLOCKED row > BLOCKED line > row > line', () => {
    expect(resolveTurnEnd('NEEDS-DECISION', 'NEEDS-DECISION')).toBe('row');
    expect(resolveTurnEnd('BLOCKED', 'NEEDS-DECISION')).toBe('line');
    expect(resolveTurnEnd('BLOCKED', 'BLOCKED')).toBe('row');
    expect(resolveTurnEnd('DONE', 'BLOCKED')).toBe('line');
    expect(resolveTurnEnd('DONE', 'READY-TO-MERGE')).toBe('row');
    expect(resolveTurnEnd('CHECKPOINTED', null)).toBe('row');
  });

  it.each([
    [{ stopFailure: true }, 'stop-failure'], [{ replayed: true }, 'replayed'], [{ remote: true }, 'remote'],
    [{ evaluator: true }, 'evaluator'], [{ provider: 'codex' }, 'provider-codex'], [{ openRotation: true }, 'rotation'],
    [{ coordinator: true }, 'coordinator'], [{ scoped: false }, 'unscoped'], [{}, null],
  ] as const)('names why no row is asked of %j: %s', (over, why) => {
    expect(noRowExemption({ ...worker, ...over })).toBe(why);
  });
});

describe('decideStop never holds a stop', () => {
  const flags = ['stopFailure', 'replayed', 'remote', 'evaluator', 'openRotation', 'coordinator', 'scoped'] as const;
  const contexts: ITurnEndContext[] = [];
  for (let bits = 0; bits < 1 << flags.length; bits++) {
    for (const provider of ['claude', 'codex']) {
      const c = { ...worker, provider } as ITurnEndContext;
      flags.forEach((flag, i) => { (c as unknown as Record<string, boolean>)[flag] = (bits & (1 << i)) !== 0; });
      contexts.push(c);
    }
  }

  it(`returns row, classifier or unreported for all ${contexts.length * 2 * 3} combinations of context, row and tail`, async () => {
    const kinds = new Set<string>();
    for (const context of contexts) {
      for (const r of [null, row()]) {
        for (const tail of ['DONE', 'NEEDS-DECISION', null] as const) {
          const decision = await decideStop(input({ context, row: r, tailMarker: tail, openWork: async () => 0 }));
          kinds.add(decision.kind);
          expect(['row', 'classifier', 'unreported']).toContain(decision.kind);
        }
      }
    }
    expect([...kinds].sort()).toEqual(['classifier', 'row', 'unreported']);
  });

  it('hands any unconsumed row to apply time, whatever the tail says (the order is evaluated there)', async () => {
    expect(await decideStop(input({ row: row(), tailMarker: 'NEEDS-DECISION' }))).toEqual({ kind: 'row', row: row() });
    expect(await decideStop(input({ row: row(), tailMarker: null, openWork: async () => 3 }))).toMatchObject({ kind: 'row' });
  });

  it('A7: a markerless stop with a live job is WAITING: no row asked, open work read once', async () => {
    const openWork = vi.fn(async () => 1);
    expect(await decideStop(input({ tailMarker: null, openWork }))).toEqual({ kind: 'classifier', why: 'waiting on open work' });
    expect(openWork).toHaveBeenCalledOnce();
    expect(await decideStop(input({ tailMarker: null, openWork: async () => null }))).toMatchObject({ kind: 'classifier' });
  });

  it('A6: a scoped turn end with no row is UNREPORTED no-row; an exempt one names why; others keep the classifier', async () => {
    expect(await decideStop(input())).toEqual({ kind: 'unreported', reason: 'no-row' });
    expect(await decideStop(input({ context: { ...worker, replayed: true } }))).toEqual({ kind: 'unreported', reason: 'no-row:replayed' });
    expect(await decideStop(input({ context: { ...worker, scoped: false } }))).toMatchObject({ kind: 'classifier', why: 'unscoped' });
    expect(await decideStop(input({ context: { ...worker, coordinator: true } }))).toMatchObject({ kind: 'classifier', why: 'coordinator' });
  });

  it('A11: the kill switch and an unbound session leave the classifier, and hand over no row', async () => {
    expect(await decideStop(input({ classifierOnly: true, row: row() }))).toMatchObject({ kind: 'classifier', why: 'turn-end.source=classifier' });
    expect(await decideStop(input({ sessionId: null }))).toMatchObject({ kind: 'classifier' });
  });
});

describe('TurnEndsTable', () => {
  it('counts turns per session, replaces an unconsumed row, and lets one stop consume it', () => {
    const store = new LedgerStore(':memory:');
    const t = store.turnEnds;
    expect(t.currentTurn(S)).toBeNull();
    expect(t.bumpTurn(S, T0)).toBe(1);
    expect(t.bumpTurn(S, T0)).toBe(2);
    expect(t.currentTurn(S)).toEqual({ turnId: 2 });
    expect(t.put(row({ turnId: 2 }))).toBe(true);
    expect(t.put(row({ turnId: 2, verdict: 'BLOCKED', reason: 'second' }))).toBe(true);
    expect(t.unconsumed(S, 2)).toMatchObject({ verdict: 'BLOCKED', reason: 'second' });
    expect(t.consume(S, 2, T0 + 1)).toBe(true);
    expect(t.consume(S, 2, T0 + 2)).toBe(false);
    expect(t.unconsumed(S, 2)).toBeNull();
    expect(t.put(row({ turnId: 2 }))).toBe(false);
    expect(t.list('ws-1', 0)).toHaveLength(1);
    store.close();
  });

  it('adversarial 3: the counter survives a restart; a new turn after it has no row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-turn-ends-'));
    try {
      const file = path.join(dir, 'ledger.sqlite');
      const before = new LedgerStore(file);
      before.turnEnds.bumpTurn(S, T0);
      before.turnEnds.put(row({ turnId: 1 }));
      before.close();
      const after = new LedgerStore(file);
      expect(after.turnEnds.unconsumed(S, 1)).toMatchObject({ verdict: 'DONE' });
      expect(after.turnEnds.bumpTurn(S, T0 + 1)).toBe(2);
      expect(after.turnEnds.unconsumed(S, 2)).toBeNull();
      after.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('StopGate', () => {
  const tab: IStopGateTab = { workspaceId: 'ws-1', agentSessionId: S, host: null, providerId: 'claude' };
  const make = (over: Partial<IStopGateDeps> = {}) => {
    const store = new LedgerStore(':memory:');
    const gate = new StopGate({
      now: () => T0, table: () => store.turnEnds, rowsAreSource: () => true, payloadIsTail: () => true,
      isCoordinator: async () => false, isScoped: async () => true, roleOf: async () => null, inRotation: () => false,
      openWork: async () => 0, ...over,
    });
    store.turnEnds.bumpTurn(S, T0);
    return { gate, store };
  };
  const payload = (message: string | null, sessionId: string | null = S) => ({ hookEvent: 'Stop', sessionId, message });

  it('a scoped turn end with no row decides UNREPORTED no-row for its turn, and keeps the decision for the apply', async () => {
    const { gate, store } = make();
    expect(await gate.decide('tab-w', tab, payload('Gate green.\n\nDONE: x'))).toEqual({ kind: 'unreported', reason: 'no-row', turnId: 1 });
    expect(gate.take('tab-w')).toEqual({ kind: 'unreported', reason: 'no-row', turnId: 1 });
    expect(gate.take('tab-w')).toBeNull();
    store.close();
  });

  it('keeps the payload message as the tail only for the bound session and only with the switch on', async () => {
    const { gate, store } = make();
    store.turnEnds.put(row());
    expect(await gate.decide('tab-w', tab, payload('x'.repeat(700) + '\nDONE: y'))).toMatchObject({ kind: 'row' });
    expect(gate.takeTail('tab-w', S)).toHaveLength(600);
    expect(gate.take('tab-w')).toMatchObject({ kind: 'row' });
    await gate.decide('tab-w', tab, payload('DONE: z', 'another-session'));
    expect(gate.takeTail('tab-w', S)).toBeNull();
    store.close();
    const off = make({ payloadIsTail: () => false });
    await off.gate.decide('tab-w', tab, payload('DONE: z'));
    expect(off.gate.takeTail('tab-w', S)).toBeNull();
    off.store.close();
  });

  it('applies the classifier without a payload message and no row (a dropped body); with a row, the row goes to apply time (A2)', async () => {
    const { gate, store } = make();
    expect(await gate.decide('tab-w', tab, payload(null))).toMatchObject({ kind: 'classifier', why: 'no payload message' });
    store.turnEnds.put(row());
    expect(await gate.decide('tab-w', tab, payload(null))).toMatchObject({ kind: 'row' });
    store.close();
  });

  it('answers within its deadline: a hung open-work read applies the classifier', async () => {
    const { gate, store } = make({ openWork: () => new Promise(() => {}), deadlineMs: 50 });
    const started = Date.now();
    expect(await gate.decide('tab-w', tab, payload('working on it'))).toMatchObject({ kind: 'classifier', why: 'decision deadline' });
    expect(Date.now() - started).toBeLessThan(1_000);
    store.close();
  });

  it('an UNREPORTED write never replaces the worker\'s row; the row is kept and marked used', async () => {
    const { gate, store } = make();
    store.turnEnds.put(row({ reason: 'the worker\'s own' }));
    gate.writeUnreported(tab, 'tab-w', 'no-row');
    expect(store.turnEnds.list('ws-1', 0)).toEqual([expect.objectContaining({ verdict: 'DONE', reason: 'the worker\'s own', consumedAt: T0 })]);
    store.close();
  });

  it('A8: a replayed stop is judged and written against its own turn, never the current one; a second replay consumes nothing', async () => {
    const { gate, store } = make();
    store.turnEnds.bumpTurn(S, T0 + 60_000);
    store.turnEnds.bumpTurn(S, T0 + 120_000);
    expect(store.turnEnds.turnAt(S, T0 + 30_000)).toBe(1);
    expect(store.turnEnds.turnAt(S, T0 - 1)).toBeNull();
    expect(await gate.decide('tab-w', tab, payload('DONE: x'), T0 + 30_000)).toEqual({ kind: 'unreported', reason: 'no-row:replayed', turnId: 1 });
    store.turnEnds.put(row({ turnId: 1, reason: 'turn one' }));
    store.turnEnds.put(row({ turnId: 3, reason: 'turn three' }));
    const replay = await gate.decide('tab-w', tab, payload('BLOCKED: q'), T0 + 30_000);
    expect(replay).toMatchObject({ kind: 'row', row: { turnId: 1 } });
    expect(gate.consume((replay as { row: ITurnEndRow }).row)).toBe(true);
    expect(gate.consume((replay as { row: ITurnEndRow }).row)).toBe(false);
    expect(store.turnEnds.unconsumed(S, 3)).toMatchObject({ reason: 'turn three' });
    store.close();
  });
});
