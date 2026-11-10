import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMissionBinding } from '@/types/mission-control';

// Story 14 AC 4: a turn whose last line starts NEEDS-DECISION: opens a human-visible Mission Control item
// (question format v2), opened by the tab, unless the tab opened one in the same turn. The opener runs the
// events route's own batch function: the validator at min-version 2 and the orchestrator review authority.

const live = vi.hoisted(() => ({
  store: null as unknown,
  identity: null as null | Omit<IMissionBinding, 'generation'>,
  orchestratorTabId: 'tab-orch' as string | null,
}));
vi.mock('@/lib/mission-control-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mission-control-store')>();
  return { ...actual, getMissionControlStore: () => live.store };
});
vi.mock('@/lib/mission-control-runtime', () => ({ resolveMissionTargetIdentity: vi.fn(async (_ws: string, tabId: string) => (tabId === live.identity?.tabId ? live.identity : null)) }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async (id: string) => ({ id, orchestration: live.orchestratorTabId ? { orchestratorTabId: live.orchestratorTabId } : null })),
}));
vi.mock('@/lib/mission-question-config', () => ({ readQuestionMinVersion: vi.fn(async () => 2) }));
const attention = vi.hoisted(() => ({ alert: vi.fn(async (_input: unknown) => []) }));
vi.mock('@/lib/attention-alerts', () => ({ alertOpenedAttention: attention.alert }));
const curator = vi.hoisted(() => ({ onMissionEvents: vi.fn() }));
vi.mock('@/lib/curator-service', () => ({ curatorOnMissionEvents: curator.onMissionEvents }));

import { MissionControlStore } from '@/lib/mission-control-store';
import { validateMissionQuestion } from '@/lib/mission-question-format';
import {
  buildNeedsDecisionQuestion, needsDecisionIsNew, needsDecisionPushDetail, needsDecisionText, parseNeedsDecisionLine, withoutNewMark,
} from '@/lib/needs-decision';
import Database from 'better-sqlite3';
import {
  NEEDS_DECISION_ANSWER_WINDOW_MS, needsDecisionAskerNotice, needsDecisionDeps, needsDecisionItemId, needsDecisionItemNotice, needsDecisionLineKey,
  needsDecisionNewHint, needsDecisionTextKey, openNeedsDecisionItem, stableNeedsDecisionItemId, type INeedsDecisionStop, type TNeedsDecisionOutcome,
} from '@/lib/needs-decision-opener';
import { extractTurnMarker, lastTurnLine, TURN_TAIL_CHARS } from '@/lib/turn-end';

const ORCH: Omit<IMissionBinding, 'generation'> = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'sess-orch', runtimeGeneration: 'launch-1' };

describe('the NEEDS-DECISION end line', () => {
  it('reads an optional class tag and up to four (a)/(1) options', () => {
    expect(parseNeedsDecisionLine('NEEDS-DECISION: [money] Pay the vendor invoice now? (a) pay today (b) wait for the credit note'))
      .toEqual({ class: 'money', question: 'Pay the vendor invoice now?', options: [{ id: 'a', label: 'pay today' }, { id: 'b', label: 'wait for the credit note' }] });
    expect(parseNeedsDecisionLine('NEEDS-DECISION: Which host runs the gate? (1) host-a, (2) host-b, (3) both'))
      .toEqual({ class: null, question: 'Which host runs the gate?', options: [{ id: '1', label: 'host-a' }, { id: '2', label: 'host-b' }, { id: '3', label: 'both' }] });
    expect(parseNeedsDecisionLine('NEEDS-DECISION: [Scope] Is the export in this epic?')).toEqual({ class: 'scope', question: 'Is the export in this epic?', options: [] });
    expect(parseNeedsDecisionLine('NEEDS-DECISION: [urgent] keep (b) then (a)').options).toEqual([]);
    expect(parseNeedsDecisionLine('NEEDS-DECISION: [urgent] keep (b) then (a)').class).toBeNull();
  });

  it('reads [new] before or after the class tag; it is never part of the question, the push text or the line key (PM-2)', () => {
    for (const line of ['NEEDS-DECISION: [new] [money] Pay now? (a) pay (b) wait', 'NEEDS-DECISION: [money] [NEW] Pay now? (a) pay (b) wait']) {
      expect(needsDecisionIsNew(line)).toBe(true);
      expect(parseNeedsDecisionLine(line)).toEqual({ class: 'money', question: 'Pay now?', options: [{ id: 'a', label: 'pay' }, { id: 'b', label: 'wait' }] });
      expect(needsDecisionText(line)).toBe('Pay now? (a) pay (b) wait');
      expect(needsDecisionLineKey('ws-a', 'tab-w', line)).toBe(needsDecisionLineKey('ws-a', 'tab-w', 'NEEDS-DECISION: [money] Pay now? (a) pay (b) wait'));
    }
    expect(withoutNewMark('NEEDS-DECISION: [new] Ship it?')).toBe('NEEDS-DECISION: Ship it?');
    expect(needsDecisionIsNew('NEEDS-DECISION: Ship the [new] build?')).toBe(false);
    expect(withoutNewMark('NEEDS-DECISION: Ship the [new] build?')).toBe('NEEDS-DECISION: Ship the [new] build?');
    expect(needsDecisionIsNew('DONE: [new] x')).toBe(false);
    // Only the first marker is removed; the class tag stays in the key, so a tag change is a different line.
    expect(needsDecisionLineKey('ws-a', 'tab-w', 'NEEDS-DECISION: [scope] Ship?')).not.toBe(needsDecisionLineKey('ws-a', 'tab-w', 'NEEDS-DECISION: Ship?'));
  });

  it('builds a v2 question the validator accepts at min-version 2: text when the line gives no options', () => {
    const base = { workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'hfl-14' };
    const text = buildNeedsDecisionQuestion({ ...base, line: 'NEEDS-DECISION: [scope] Ship the auth watch without the remote kit refresh?' });
    expect(text).toMatchObject({ formatVersion: 2, kind: 'question', answerType: 'text', options: [], class: 'scope',
      decision: 'Ship the auth watch without the remote kit refresh?', title: 'hfl-14 needs a decision', canContinue: false });
    expect(validateMissionQuestion(text, 2)).toMatchObject({ ok: true, formatVersion: 2 });
    const single = buildNeedsDecisionQuestion({ ...base, line: 'NEEDS-DECISION: Pick one (a) keep (b) revert' });
    expect(single).toMatchObject({ answerType: 'single', options: [
      { id: 'a', label: 'keep', recommended: false, needsText: false }, { id: 'b', label: 'revert', recommended: false, needsText: false }] });
    expect(validateMissionQuestion(single, 2).ok).toBe(true);
    expect(single).not.toHaveProperty('class');
  });

  it('keeps an option longer than a card label in the context, verbatim, as a text question', () => {
    const long = 'x'.repeat(61);
    const q = buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: '', line: `NEEDS-DECISION: Choose (a) ${long} (b) short` });
    expect(q).toMatchObject({ answerType: 'text', options: [], title: 'tab-w needs a decision' });
    expect(q.context).toContain(`(a) ${long} (b) short`);
    expect(validateMissionQuestion(q, 2).ok).toBe(true);
  });

  it('builds the question from the whole line, not the marker line clipped at 300 chars (R2, probe nd.ts)', () => {
    const line = 'NEEDS-DECISION: [scope] The settlement export needs a currency rule before slice 7 can land; which rule do we ship for multi-currency merchants in this epic, given the bank files carry both amounts? (a) settle in merchant base currency (b) settle in the transaction currency (c) defer multi-currency merchants to the next epic';
    expect(line.length).toBe(326);
    const tail = `Built what I can.\n\n${line}`;
    expect(extractTurnMarker(tail)!.at(-1)!.length).toBe(301);
    const full = lastTurnLine(tail)!;
    expect(full).toEqual({ line, complete: true });
    const q = buildNeedsDecisionQuestion({ line: full.line, complete: full.complete, workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w' });
    expect(q.answerType).toBe('single');
    expect((q.options as Array<{ label: string }>).map((o) => o.label)).toEqual([
      'settle in merchant base currency', 'settle in the transaction currency', 'defer multi-currency merchants to the next epic']);
  });

  it('a line whose start may be missing is a text question that says it was clipped (R2)', () => {
    const line = `NEEDS-DECISION: pick ${'x'.repeat(TURN_TAIL_CHARS)} (a) yes (b) no`;
    const tail = line.slice(-TURN_TAIL_CHARS);
    expect(lastTurnLine(tail)).toEqual({ line: tail, complete: false });
    const q = buildNeedsDecisionQuestion({ line: 'NEEDS-DECISION: pick (a) yes (b) no', complete: false, workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w' });
    expect(q).toMatchObject({ answerType: 'text', options: [] });
    expect(q.context).toContain('The line reached the harness clipped');
    expect(validateMissionQuestion(q, 2).ok).toBe(true);
  });

  it('clips a long question at a word for the decision, and keeps the whole line in the context', () => {
    const line = `NEEDS-DECISION: ${'word '.repeat(40)}end?`;
    const q = buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line });
    expect((q.decision as string).length).toBeLessThanOrEqual(120);
    expect(q.decision).toMatch(/word…$/);
    expect(q.context).toContain(line);
    expect(validateMissionQuestion(q, 2).ok).toBe(true);
  });
});

describe('the server opens the item (story 14 AC 4)', () => {
  let dir: string;
  let store: MissionControlStore;

  const startRun = (identity = ORCH) => {
    const start = {
      eventId: 'start-1', schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 1,
      bindingGeneration: 0, type: 'run.started' as const, payload: { objective: 'Epic', tabId: identity.tabId },
    };
    store.applyEvents([start], new Map([[start.eventId, identity]]));
  };
  const stop = (extra: Partial<INeedsDecisionStop> = {}): INeedsDecisionStop => ({
    workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'hfl-14', line: 'NEEDS-DECISION: [scope] Is the export in scope? (a) yes (b) no',
    stopSeq: 7, stopAt: 1_000, turnStartedAt: 0, ...extra,
  });
  const items = () => store.snapshot([], 'ws-a').items;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-nd-'));
    store = new MissionControlStore(path.join(dir, 'mission-control.sqlite'));
    live.store = store;
    live.identity = ORCH;
    live.orchestratorTabId = 'tab-orch';
    attention.alert.mockClear();
    delete (globalThis as { __ptNeedsDecisionItemIds?: unknown }).__ptNeedsDecisionItemIds;
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('opens one OPEN item, not a candidate: v2, the class from the tag, the tab as opener', async () => {
    startRun();
    const outcome = await openNeedsDecisionItem(await needsDecisionDeps(), stop());
    expect(outcome).toMatchObject({ opened: true, runId: 'run-a' });
    const [item] = items();
    expect(item).toMatchObject({
      state: 'open', candidateReason: null, class: 'scope', formatVersion: 2, answerType: 'single',
      decision: 'Is the export in scope?', options: [{ id: 'a', label: 'yes' }, { id: 'b', label: 'no' }],
      humanReview: { humanNeed: 'decision', reviewerTabId: 'tab-orch' },
    });
    expect(store.openItemOpeners()).toEqual([expect.objectContaining({ itemId: item.id, reviewed: true, opener: { tabId: 'tab-w', identity: 'hook' } })]);
    expect(store.snapshot([], 'ws-a').workspaces).toBeDefined();
  });

  // Story 33 (merge with story 14): a server-opened item reaches the alert through the same batch, and the
  // real transition rule alerts it exactly once, with the summary an answer button needs.
  it('a server-opened item alerts once through the story 33 rule', async () => {
    startRun();
    await openNeedsDecisionItem(await needsDecisionDeps(), stop());
    expect(attention.alert).toHaveBeenCalledTimes(1);
    const input = attention.alert.mock.calls[0][0] as Parameters<typeof import('@/lib/attention-alerts').dispatchAttentionOpenedAlerts>[0];
    expect(input.previousStates).toEqual(new Map());
    const real = await vi.importActual<typeof import('@/lib/attention-alerts')>('@/lib/attention-alerts');
    const sent: unknown[] = [];
    const deps = {
      workspace: async () => null, findTab: async () => null, providerOf: async () => 'claude' as const,
      dispatch: async (draft: unknown) => { sent.push(draft); },
    };
    const state = real.createAttentionAlertState();
    await real.dispatchAttentionOpenedAlerts(input, deps, state);
    await real.dispatchAttentionOpenedAlerts(input, deps, state);
    const [item] = items();
    expect(sent).toEqual([expect.objectContaining({
      kind: 'attention-opened', itemId: item.id, tabId: 'tab-w',
      question: expect.objectContaining({ formatVersion: 2, answerType: 'single', revision: 1, decision: 'Is the export in scope?' }),
    })]);
  });

  it('the server\'s own item of the previous stop is not "asked this turn": a second line revises it, a [new] line opens (PM-2, consult 1)', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    expect(await openNeedsDecisionItem(deps, stop())).toMatchObject({ opened: true });
    // The turn's start is before the item: the server's own nd- item is still not the tab's own ask.
    expect(await openNeedsDecisionItem(deps, stop({ stopSeq: 8, line: 'NEEDS-DECISION: another?' }))).toMatchObject({ opened: false, reason: 'revised' });
    expect(await openNeedsDecisionItem(deps, stop({ stopSeq: 9, line: 'NEEDS-DECISION: [new] next question?' }))).toMatchObject({ opened: true });
    expect(items()).toHaveLength(2);
  });

  it('the same line on 3 turns opens 1 item; once it is answered, the same line opens nothing and gets the answer (R1, PM-2 D51)', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const line = 'NEEDS-DECISION: Ship the export now? (a) yes (b) no';
    const first = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 1, turnStartedAt: 0 }));
    expect(first).toMatchObject({ opened: true });
    const itemId = (first as { itemId: string }).itemId;
    expect(itemId).toBe(needsDecisionItemId({ workspaceId: 'ws-a', tabId: 'tab-w', line, stopSeq: 1, stopAt: 1_000 }).itemId);
    for (const seq of [2, 3]) {
      // A later turn, the same question with other spacing: no second item.
      expect(await openNeedsDecisionItem(deps, stop({ line: line.replace(' now?', '  now?'), stopSeq: seq, turnStartedAt: Date.now() + seq })))
        .toEqual({ opened: false, reason: 'already-open', itemId });
    }
    expect(items()).toHaveLength(1);
    const item = items()[0];
    store.submitAnswer(itemId, { submissionId: 'sub-1', expectedRevision: item.revision, optionIds: ['a'], text: '', actionCompleted: false }, 'owner');
    expect(items().find((i) => i.id === itemId)?.state).toBe('answered');
    const again = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 4, turnStartedAt: Date.now() + 10 }));
    expect(again).toMatchObject({ opened: false, reason: 'answered', itemId, differs: false, answer: { optionIds: ['a'], optionLabels: ['yes'], text: '' } });
    expect(items()).toHaveLength(1);
  });

  // Story 16 merge (M1): the curator shadows every owner ask that passes the batch, a server-opened one too.
  it('hands each fresh batch to the curator once: an mc ask, a NEEDS-DECISION the server opened, never a replay', async () => {
    startRun();
    curator.onMissionEvents.mockClear();
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    const ask = {
      eventId: 'ask-1', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: { itemId: 'ask-item', ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: 'NEEDS-DECISION: own?' }),
        humanReview: { humanNeed: 'decision', humanReason: 'Owner call.', handling: 'Checked.', reviewerTabId: 'tab-orch' } },
    };
    await applyMissionEventBatch('ws-a', [ask], { tabId: 'tab-w', identity: 'launch' });
    await vi.waitFor(() => expect(curator.onMissionEvents).toHaveBeenCalledTimes(1));
    expect(curator.onMissionEvents.mock.calls[0][0]).toEqual([expect.objectContaining({ eventId: 'ask-1', type: 'attention.opened' })]);
    await applyMissionEventBatch('ws-a', [ask], { tabId: 'tab-w', identity: 'launch' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(curator.onMissionEvents).toHaveBeenCalledTimes(1);
    expect(await openNeedsDecisionItem(await needsDecisionDeps(), stop({ turnStartedAt: Date.now() + 5 }))).toMatchObject({ opened: true });
    await vi.waitFor(() => expect(curator.onMissionEvents).toHaveBeenCalledTimes(2));
    expect(curator.onMissionEvents.mock.calls[1][0]).toEqual([expect.objectContaining({
      type: 'attention.opened', payload: expect.objectContaining({ humanReview: expect.objectContaining({ humanNeed: 'decision' }) }),
    })]);
  });

  it('an item the tab opened itself this turn (mc ask) suppresses the automatic one', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'own-ask', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: { itemId: 'own-item', ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: 'NEEDS-DECISION: own?' }) },
    }], { tabId: 'tab-w', identity: 'launch' });
    expect(await openNeedsDecisionItem(deps, stop())).toEqual({ opened: false, reason: 'asked-this-turn', itemId: 'own-item' });
  });

  it('says why when no item can open: no orchestrator, no run of it, or a review the store refuses', async () => {
    const deps = await needsDecisionDeps();
    const { itemId } = needsDecisionItemId(stop());
    live.orchestratorTabId = null;
    expect(await openNeedsDecisionItem(deps, stop())).toEqual({ opened: false, reason: 'no-orchestrator', itemId });
    live.orchestratorTabId = 'tab-orch';
    expect(await openNeedsDecisionItem(deps, stop())).toEqual({ opened: false, reason: 'no-orchestrator-run', itemId, detail: 'tab-orch' });
    startRun();
    live.identity = { ...ORCH, sessionId: 'sess-new' };
    expect(await openNeedsDecisionItem(deps, stop())).toMatchObject({ opened: false, reason: 'refused', itemId, detail: expect.stringMatching(/target agent binding|current orchestrator session/) });
    expect(items()).toEqual([]);
    expect(await openNeedsDecisionItem(deps, stop({ line: 'DONE: fine' }))).toEqual({ opened: false, reason: 'not-needs-decision' });
  });

  it('states the fallback reason in the item when a reportsTo tab\'s question reaches the owner (D28 review r1, 1)', async () => {
    startRun();
    const reason = 'reports-to target unavailable: tab-lead is gone or halted, and no live orchestrator can take it';
    expect(await openNeedsDecisionItem(await needsDecisionDeps(), stop({ fallbackReason: reason }))).toMatchObject({ opened: true });
    const [item] = items() as unknown as Array<Record<string, unknown>>;
    expect(JSON.stringify(item)).toContain(`It reached you because ${reason}.`);
    expect(JSON.stringify(item)).toContain(`hfl-14 ended its turn with NEEDS-DECISION and no tab can take it (${reason}): the owner decides it.`);
  });

  it('refuses a line with no question mark after the marker: no item, no id remembered (D28 v2 addendum)', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const D28 = 'NEEDS-DECISION: is not mine to send — ORCH holds it.';
    expect(await openNeedsDecisionItem(deps, stop({ line: D28 }))).toEqual({ opened: false, reason: 'no-question' });
    expect(await openNeedsDecisionItem(deps, stop({ line: 'NEEDS-DECISION: [scope] pick one (a) keep (b) revert' }))).toEqual({ opened: false, reason: 'no-question' });
    // A full-width question mark after the marker counts too.
    expect(await openNeedsDecisionItem(deps, stop({ line: 'NEEDS-DECISION: ship？' }))).toMatchObject({ opened: true });
    expect(items()).toHaveLength(1);
    expect((globalThis as { __ptNeedsDecisionItemIds?: Map<string, unknown> }).__ptNeedsDecisionItemIds?.size).toBe(1);
  });

  it('an answered question stays answered after a restart resets the stop seq (confirm D1, PM-2 D51)', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const line = 'NEEDS-DECISION: Ship the export now? (a) yes (b) no';
    const first = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 3, stopAt: 1_000 }));
    expect(first).toMatchObject({ opened: true });
    const itemId = (first as { itemId: string }).itemId;
    store.submitAnswer(itemId, { submissionId: 'sub-d1', expectedRevision: items()[0].revision, optionIds: ['b'], text: '', actionCompleted: false }, 'owner');
    // The server restarted: the tab's stop seq is 3 again; only the stop's time differs.
    delete (globalThis as { __ptNeedsDecisionItemIds?: unknown }).__ptNeedsDecisionItemIds;
    const again = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 3, stopAt: 2_000, turnStartedAt: Date.now() + 1 }));
    expect(again).toMatchObject({ opened: false, reason: 'answered', itemId });
    expect(items()).toHaveLength(1);
  });

  it('an item the orchestrator opened from the note dedupes the worker\'s repeat (confirm C3)', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const line = 'NEEDS-DECISION: Ship the export now? (a) yes (b) no';
    // The id the server would have used, as the (i) note names it.
    const { itemId } = needsDecisionItemId(stop({ line, stopSeq: 5, stopAt: 5_000 }));
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'orch-open-1', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-orch', identity: 'launch' });
    expect(await openNeedsDecisionItem(deps, stop({ line, stopSeq: 6, stopAt: 6_000, turnStartedAt: Date.now() + 1 })))
      .toEqual({ opened: false, reason: 'already-open', itemId });
    expect(items()).toHaveLength(1);
  });

  it('never throws: a failing dependency is the error outcome, with the id (confirm D2)', async () => {
    const deps = { ...(await needsDecisionDeps()), openRuns: () => { throw new Error('SQLITE_BUSY'); } };
    const outcome = await openNeedsDecisionItem(deps, stop());
    expect(outcome).toEqual({ opened: false, reason: 'error', itemId: needsDecisionItemId(stop()).itemId, detail: 'SQLITE_BUSY' });
  });

  it('a server-opened NEEDS-DECISION item sends one attention-opened alert naming the item, with the tab as opener (confirm C1)', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const first = await openNeedsDecisionItem(deps, stop());
    expect(await openNeedsDecisionItem(deps, stop({ stopSeq: 8, stopAt: 8_000, turnStartedAt: Date.now() + 1 }))).toMatchObject({ reason: 'already-open' });
    expect(attention.alert).toHaveBeenCalledTimes(1);
    const input = attention.alert.mock.calls[0][0] as { events: Array<{ id: string; entityId: string }>; fresh: Set<string>; openerTabId: string | null };
    const eventId = `system:needs-decision:${(first as { itemId: string }).itemId.slice(3)}`;
    expect(input.openerTabId).toBe('tab-w');
    expect([...input.fresh]).toEqual([eventId]);
    expect(input.events.map((e) => [e.id, e.entityId])).toEqual([[eventId, (first as { itemId: string }).itemId]]);
  });

  // Review r1 finding 1: one id per line key inside 24 h, so "its id would be" is true and a later open takes that id.
  it('not opened, then opened, for one line: the same id', async () => {
    const deps = await needsDecisionDeps();
    const first = await openNeedsDecisionItem(deps, stop({ stopSeq: 1, stopAt: 1_000 }));
    expect(first).toMatchObject({ opened: false, reason: 'no-orchestrator-run' });
    startRun();
    const second = await openNeedsDecisionItem(deps, stop({ stopSeq: 2, stopAt: 2_000, turnStartedAt: Date.now() + 1 }));
    expect(second).toEqual({ opened: true, itemId: (first as { itemId: string }).itemId, runId: 'run-a' });
    expect(items().map((item) => item.id)).toEqual([(first as { itemId: string }).itemId]);
    expect(await openNeedsDecisionItem(deps, stop({ stopSeq: 3, stopAt: 3_000, turnStartedAt: Date.now() + 2 })))
      .toEqual({ opened: false, reason: 'already-open', itemId: (first as { itemId: string }).itemId });
  });

  it('a refused or failed stop, then an opened stop: the same id', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const refused = await openNeedsDecisionItem({ ...deps, apply: async () => { throw new Error('store said no'); } }, stop({ stopSeq: 1, stopAt: 1_000 }));
    const failed = await openNeedsDecisionItem({ ...deps, openRuns: () => { throw new Error('SQLITE_BUSY'); } }, stop({ stopSeq: 2, stopAt: 2_000 }));
    expect(refused).toMatchObject({ reason: 'refused' });
    expect(failed).toMatchObject({ reason: 'error', itemId: (refused as { itemId: string }).itemId });
    expect(await openNeedsDecisionItem(deps, stop({ stopSeq: 3, stopAt: 3_000 }))).toMatchObject({ opened: true, itemId: (refused as { itemId: string }).itemId });
  });

  it('the remembered id lasts 24 h: past it, a stop takes its own id', async () => {
    const deps = await needsDecisionDeps();
    const first = await openNeedsDecisionItem(deps, stop({ stopSeq: 1, stopAt: 1_000 }));
    const later = await openNeedsDecisionItem({ ...deps, now: () => Date.now() + 24 * 60 * 60_000 + 1 }, stop({ stopSeq: 2, stopAt: 2_000 }));
    expect((later as { itemId: string }).itemId).not.toBe((first as { itemId: string }).itemId);
    expect((later as { itemId: string }).itemId.slice(0, 19)).toBe((first as { itemId: string }).itemId.slice(0, 19));
  });

  // Finding 2: path (i) tells the orchestrator to open the id; the worker's repeats never make a second item.
  it('path (i): the worker\'s repeats name the one id and open no second item, before and after the orchestrator opens it', async () => {
    const deps = await needsDecisionDeps();
    const line = 'NEEDS-DECISION: Ship the export now? (a) yes (b) no';
    const first = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 1, stopAt: 1_000 }));
    const itemId = (first as { itemId: string }).itemId;
    expect(await openNeedsDecisionItem(deps, stop({ line, stopSeq: 2, stopAt: 2_000 }))).toMatchObject({ reason: 'no-orchestrator-run', itemId });
    startRun();
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'orch-open-i', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-orch', identity: 'launch' });
    expect(await openNeedsDecisionItem(deps, stop({ line, stopSeq: 3, stopAt: 3_000, turnStartedAt: Date.now() + 1 })))
      .toEqual({ opened: false, reason: 'already-open', itemId });
    expect(items()).toHaveLength(1);
  });

  // #521 AC 1: the id memory is in memory only; after a restart the store gives the line its open item's id back.
  it('a restart empties the id memory: the same line takes the open nd-<lineKey> item\'s id from the store; no second item opens (#521)', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const line = 'NEEDS-DECISION: Ship the export now? (a) yes (b) no';
    const first = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 1, stopAt: 1_000 }));
    expect(first).toMatchObject({ opened: true });
    const itemId = (first as { itemId: string }).itemId;
    // The server restarted: no remembered id, and the stop seq starts again.
    delete (globalThis as { __ptNeedsDecisionItemIds?: unknown }).__ptNeedsDecisionItemIds;
    const restartStop = stop({ line, stopSeq: 1, stopAt: 9_000, turnStartedAt: Date.now() + 1 });
    expect(needsDecisionItemId(restartStop).itemId).not.toBe(itemId);
    expect(await openNeedsDecisionItem(deps, restartStop)).toEqual({ opened: false, reason: 'already-open', itemId });
    // The id the store gave is the one remembered, so a later not-opened outcome names it too.
    const remembered = (globalThis as { __ptNeedsDecisionItemIds?: Map<string, { itemId: string }> }).__ptNeedsDecisionItemIds!;
    expect([...remembered.values()].map((held) => held.itemId)).toEqual([itemId]);
    expect(await openNeedsDecisionItem({ ...deps, openRuns: () => [] }, stop({ line, stopSeq: 2, stopAt: 9_500, turnStartedAt: Date.now() + 2 })))
      .toEqual({ opened: false, reason: 'already-open', itemId });
    expect(items().map((item) => item.id)).toEqual([itemId]);
  });

  it('on a miss the newest open item of the line key gives the id; a failing store read mints the stop\'s own id (#521)', () => {
    const s = stop({ stopSeq: 4, stopAt: 4_000 });
    const { lineKey, itemId: own } = needsDecisionItemId(s);
    const older = `nd-${lineKey}${'a'.repeat(16)}`;
    const newer = `nd-${lineKey}${'b'.repeat(16)}`;
    const prefixes: string[] = [];
    const openIds = (prefix: string) => { prefixes.push(prefix); return [older, newer]; };
    expect(stableNeedsDecisionItemId(s, 10, () => false, openIds)).toEqual({ itemId: newer, lineKey });
    expect(prefixes).toEqual([`nd-${lineKey}`]);
    // A remembered id that is still open needs no store read.
    expect(stableNeedsDecisionItemId(s, 20, () => false, openIds)).toEqual({ itemId: newer, lineKey });
    expect(prefixes).toHaveLength(1);
    delete (globalThis as { __ptNeedsDecisionItemIds?: unknown }).__ptNeedsDecisionItemIds;
    expect(stableNeedsDecisionItemId(s, 30, () => false, () => { throw new Error('SQLITE_BUSY'); })).toEqual({ itemId: own, lineKey });
    // The remembered id closed: the store is read again, and with no open item the stop asks under its own id.
    expect(stableNeedsDecisionItemId(stop({ stopSeq: 5, stopAt: 5_000 }), 40, () => true, () => []).itemId)
      .toBe(needsDecisionItemId(stop({ stopSeq: 5, stopAt: 5_000 })).itemId);
  });

  // #521 AC 2 (R-03): the note sent before a restart names one id, the server's open after it another; the store keeps one.
  it('the store refuses a second open nd-<lineKey> id with 409 already-open, naming the open item (#521, R-03)', async () => {
    const deps = await needsDecisionDeps();
    const line = 'NEEDS-DECISION: Ship the export now? (a) yes (b) no';
    const before = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 1, stopAt: 1_000 }));
    expect(before).toMatchObject({ opened: false, reason: 'no-orchestrator-run' });
    const noted = (before as { itemId: string }).itemId;
    delete (globalThis as { __ptNeedsDecisionItemIds?: unknown }).__ptNeedsDecisionItemIds;
    startRun();
    const after = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 1, stopAt: 7_000, turnStartedAt: Date.now() + 1 }));
    expect(after).toMatchObject({ opened: true });
    const opened = (after as { itemId: string }).itemId;
    expect(opened).not.toBe(noted);
    expect(opened.slice(0, 19)).toBe(noted.slice(0, 19));
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    const fromNote = applyMissionEventBatch('ws-a', [{
      eventId: 'orch-open-stale-note', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: noted, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-orch', identity: 'launch' });
    await expect(fromNote).rejects.toMatchObject({
      status: 409, code: 'already-open', message: `an item for this NEEDS-DECISION line is already open: ${opened}`, current: { id: opened, state: 'open' },
    });
    expect(items().map((item) => item.id)).toEqual([opened]);
    // The served body (ADR-0041 §2): the message, the code and the open item.
    const { sendMissionError } = await import('@/lib/mission-control-http');
    const json = vi.fn();
    const res = { status: vi.fn(() => ({ json })) };
    sendMissionError(res as unknown as Parameters<typeof sendMissionError>[0], await fromNote.catch((error: unknown) => error));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      error: `an item for this NEEDS-DECISION line is already open: ${opened}`, code: 'already-open', current: expect.objectContaining({ id: opened }),
    });
    // Another line's nd- id, and the same line once its item has closed, still open.
    const other = needsDecisionItemId(stop({ line: 'NEEDS-DECISION: Another question?', stopSeq: 2, stopAt: 2_000 })).itemId;
    await applyMissionEventBatch('ws-a', [{
      eventId: 'orch-open-other', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 3, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: other, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: 'NEEDS-DECISION: Another question?' }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-orch', identity: 'launch' });
    const item = items().find((i) => i.id === opened)!;
    store.submitAnswer(opened, { submissionId: 'sub-521', expectedRevision: item.revision, optionIds: ['a'], text: '', actionCompleted: false }, 'owner');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'orch-open-after-answer', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 4, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: noted, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-orch', identity: 'launch' });
    expect(items().map((i) => i.id).sort()).toEqual([noted, opened, other].sort());
  });

  // #521 review r1, 1: another opener takes the line between the opener's dedupe and its write.
  it('a racing open between the dedupe and the write: the typed refusal is already-open with the open item\'s id, and the line keeps it', async () => {
    startRun();
    const base = await needsDecisionDeps();
    const line = 'NEEDS-DECISION: Ship the export now? (a) yes (b) no';
    const racer = needsDecisionItemId(stop({ line, stopSeq: 99, stopAt: 99_000 })).itemId;
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    const deps = {
      ...base,
      orchestratorTabId: async (workspaceId: string) => {
        await applyMissionEventBatch('ws-a', [{
          eventId: 'orch-open-race', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
          type: 'attention.opened', payload: {
            itemId: racer, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line }),
            humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
          },
        }], { tabId: 'tab-orch', identity: 'launch' });
        return base.orchestratorTabId(workspaceId);
      },
    };
    const own = needsDecisionItemId(stop({ line, stopSeq: 1, stopAt: 1_000 })).itemId;
    expect(own).not.toBe(racer);
    expect(await openNeedsDecisionItem(deps, stop({ line, stopSeq: 1, stopAt: 1_000 }))).toEqual({ opened: false, reason: 'already-open', itemId: racer });
    expect(items().map((item) => item.id)).toEqual([racer]);
    const remembered = (globalThis as { __ptNeedsDecisionItemIds?: Map<string, { itemId: string }> }).__ptNeedsDecisionItemIds!;
    expect([...remembered.values()].map((held) => held.itemId)).toEqual([racer]);
    // Any other refusal stays `refused` with the line's own id.
    const refused = await openNeedsDecisionItem({ ...base, apply: async () => { throw new Error('store said no'); } },
      stop({ line: 'NEEDS-DECISION: Other?', stopSeq: 2, stopAt: 2_000, turnStartedAt: Date.now() + 1 }));
    expect(refused).toMatchObject({ opened: false, reason: 'refused', detail: 'store said no' });
  });

  // Finding 3: an asker that quotes the item id in its repeat keeps the line's key, so it finds the same item.
  it('the line key ignores a quoted nd- id, bare or in brackets', async () => {
    const id = `nd-${'0123456789abcdef'.repeat(2)}`;
    const key = needsDecisionLineKey('ws-a', 'tab-w', 'NEEDS-DECISION: Ship it? (a) yes (b) no');
    expect(needsDecisionLineKey('ws-a', 'tab-w', `NEEDS-DECISION: Ship it? ${id} (a) yes (b) no`)).toBe(key);
    expect(needsDecisionLineKey('ws-a', 'tab-w', `NEEDS-DECISION: Ship it? (${id}) (a) yes (b) no`)).toBe(key);
    expect(needsDecisionLineKey('ws-a', 'tab-w', `NEEDS-DECISION: Ship it? [${id}] (a) yes (b) no`)).toBe(key);
    expect(needsDecisionLineKey('ws-a', 'tab-w', 'NEEDS-DECISION: Ship it now? (a) yes (b) no')).not.toBe(key);
    startRun();
    const deps = await needsDecisionDeps();
    const opened = await openNeedsDecisionItem(deps, stop({ line: 'NEEDS-DECISION: Ship it? (a) yes (b) no' }));
    const quoted = `NEEDS-DECISION: Ship it? (${(opened as { itemId: string }).itemId}) (a) yes (b) no`;
    expect(await openNeedsDecisionItem(deps, stop({ line: quoted, stopSeq: 9, stopAt: 9_000, turnStartedAt: Date.now() + 1 })))
      .toEqual({ opened: false, reason: 'already-open', itemId: (opened as { itemId: string }).itemId });
  });

  it('a NEEDS-DECISION line never sets followsUp, even when it names an answered item (ADR-0037 amendment D2)', async () => {
    startRun();
    const first = await openNeedsDecisionItem(await needsDecisionDeps(), stop());
    if (!first.opened) throw new Error('first item did not open');
    const [asked] = items();
    store.submitAnswer(asked.id, { submissionId: 's-nd', expectedRevision: asked.revision, optionIds: ['a'], text: '', actionCompleted: false }, 'owner');
    const outcome = await openNeedsDecisionItem(await needsDecisionDeps(),
      stop({ stopSeq: 8, stopAt: 2_000, turnStartedAt: Date.now() + 10, line: `NEEDS-DECISION: [new] follow up ${asked.id}: is the export still in scope? (a) yes (b) no` }));
    expect(outcome).toMatchObject({ opened: true });
    const opened = store.snapshot([], 'ws-a').recentEvents.filter((event) => event.type === 'attention.opened');
    expect(opened).toHaveLength(2);
    for (const event of opened) expect(event.payload).not.toHaveProperty('followsUp');
    expect(items().find((entry) => entry.id === asked.id)).toMatchObject({ state: 'answered', followedBy: null });
  });

  it('a producer cannot take the server opener\'s event namespace', async () => {
    startRun();
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await expect(applyMissionEventBatch('ws-a', [{
      eventId: 'system:needs-decision:forged', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: { itemId: 'forged', ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: 'NEEDS-DECISION: x?' }) },
    }], null)).rejects.toThrow('event ID uses a reserved namespace');
  });
});

// Story PM-2 (D50, D51): one Mission Control item per question. Every case runs on a TEST store in a temp dir.
describe('one item per question (story PM-2, D50 and D51)', () => {
  let dir: string;
  let store: MissionControlStore;
  const LINE = 'NEEDS-DECISION: [scope] Is the export in scope? (a) yes (b) no';
  const REWORD = 'NEEDS-DECISION: [scope] Does the export belong to this epic? (a) yes (b) no';
  let seq = 0;

  const startRun = () => {
    const start = {
      eventId: 'start-1', schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 1,
      bindingGeneration: 0, type: 'run.started' as const, payload: { objective: 'Epic', tabId: ORCH.tabId },
    };
    store.applyEvents([start], new Map([[start.eventId, ORCH]]));
  };
  // One fixed clock for the store, the opener and the turn bounds: `Date` is faked from T0, and each stop comes 1 s
  // after the one before. A real clock put the previous stop's item inside or outside the turn by the millisecond.
  const T0 = Date.UTC(2026, 10, 8);
  let previousStopAt = new Map<string, number>();
  /** One stop of the tab on its own turn: the turn began at the previous stop, as the status manager passes it. */
  const ask = async (line: string, extra: Partial<INeedsDecisionStop> = {}, deps?: Awaited<ReturnType<typeof needsDecisionDeps>>) => {
    seq += 1;
    const tabId = extra.tabId ?? 'tab-w';
    const turnStartedAt = previousStopAt.get(tabId) ?? T0;
    vi.setSystemTime(Date.now() + 1_000);
    const stopAt = Date.now();
    previousStopAt.set(tabId, stopAt);
    return openNeedsDecisionItem(deps ?? await needsDecisionDeps(), {
      workspaceId: 'ws-a', tabId, tabName: 'hfl-pm2', line, stopSeq: seq, stopAt, turnStartedAt, ...extra,
    });
  };
  const items = () => store.snapshot([], 'ws-a').items;
  const answer = (itemId: string, optionIds = ['a'], text = '') => {
    const item = items().find((entry) => entry.id === itemId)!;
    store.submitAnswer(itemId, { submissionId: `sub-${itemId}-${item.revision}`, expectedRevision: item.revision, optionIds, text, actionCompleted: false }, 'owner');
    return store.snapshot([], 'ws-a').answers.find((entry) => entry.itemId === itemId)!;
  };
  const ack = (itemId: string, answerId: string) => {
    const item = items().find((entry) => entry.id === itemId)!;
    const event = {
      eventId: `ack-${answerId}`, schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: item.revision, producerAt: 3,
      bindingGeneration: 1, type: 'answer.acknowledged' as const, payload: { answerId },
    };
    store.applyEvents([event], new Map([[event.eventId, ORCH]]));
  };
  const restart = () => { delete (globalThis as { __ptNeedsDecisionItemIds?: unknown }).__ptNeedsDecisionItemIds; };
  const cancel = (itemId: string) => {
    const item = items().find((entry) => entry.id === itemId)!;
    const event = {
      eventId: `cancel-${itemId}`, schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: item.revision, producerAt: 3,
      bindingGeneration: 1, type: 'attention.cancelled' as const, payload: { itemId, reason: 'superseded' },
    };
    store.applyEvents([event], new Map([[event.eventId, ORCH]]));
  };
  const idOf = (outcome: TNeedsDecisionOutcome): string => {
    if (!outcome.opened) throw new Error(`not opened: ${JSON.stringify(outcome)}`);
    return outcome.itemId;
  };
  /** The asker notice the status manager sends for the outcome (one shared mapping). */
  const noticeOf = (outcome: TNeedsDecisionOutcome): string => needsDecisionAskerNotice(needsDecisionItemNotice(outcome, false)!);
  const tabItem = (itemId: string, tabId = 'tab-w') => store.needsDecisionItemsOfTab('ws-a', tabId, '0'.repeat(16), 0).find((item) => item.id === itemId);
  // Round 2 lines: Q2 opens the tab's [new] question, Q2R rewords it with [new], Q3 is a genuinely third question.
  const Q2 = 'NEEDS-DECISION: [new] [money] Pay the vendor today? (a) pay (b) wait';
  const Q2R = 'NEEDS-DECISION: [new] Pay the vendor now? (a) pay (b) wait';
  const Q3 = 'NEEDS-DECISION: [new] Which bank file wins? (a) BC (b) Kyriba';
  const PLAIN_NEW = 'end on NEEDS-DECISION: [new] <question>?';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    previousStopAt = new Map();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-nd-pm2-'));
    store = new MissionControlStore(path.join(dir, 'mission-control.sqlite'));
    live.store = store;
    live.identity = ORCH;
    live.orchestratorTabId = 'tab-orch';
    restart();
    startRun();
  });
  afterEach(() => {
    vi.useRealTimers();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a reword while open revises the item: attention.updated with the new text and a revision bump; no second item', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    const revised = await ask(REWORD);
    expect(revised).toEqual({ opened: false, reason: 'revised', itemId: first.itemId, revision: 2, replaced: 'Is the export in scope?' });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ id: first.itemId, state: 'open', revision: 2 });
    const updated = store.snapshot([], 'ws-a').recentEvents.filter((event) => event.type === 'attention.updated');
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe(`system:needs-decision:${first.itemId.slice(3)}:r2`);
    expect(updated[0].payload).toMatchObject({ itemId: first.itemId, decision: 'Does the export belong to this epic?' });
    // The reworded line repeated, and the first line again (A -> B -> A): the same item, no further revision (consult 4).
    expect(await ask(REWORD)).toEqual({ opened: false, reason: 'already-open', itemId: first.itemId });
    expect(await ask(LINE)).toEqual({ opened: false, reason: 'already-open', itemId: first.itemId });
    expect(items()[0].revision).toBe(2);
  });

  it('an exact repeat while open opens nothing and writes nothing', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    for (let i = 0; i < 3; i += 1) expect(await ask(LINE)).toEqual({ opened: false, reason: 'already-open', itemId: first.itemId });
    expect(items()).toHaveLength(1);
    expect(items()[0].revision).toBe(1);
  });

  it('an exact repeat after the answer opens nothing, before and after the ack, with or without [new]: the answer is re-delivered (D51)', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    const given = answer(first.itemId, ['b'], 'park it until the bank file lands');
    const expected = {
      opened: false, reason: 'answered', itemId: first.itemId, differs: false, question: 'Is the export in scope?',
      answer: { answeredAt: given.createdAt, optionIds: ['b'], optionLabels: ['no'], text: 'park it until the bank file lands' },
    };
    expect(await ask(LINE)).toMatchObject(expected);
    ack(first.itemId, given.id);
    // The measured D51 shape: the same line 22 min after the answer, after the ack.
    expect(await ask(LINE)).toMatchObject({ ...expected, answer: { ...expected.answer, delivery: { state: 'acknowledged' } } });
    expect(await ask(LINE.replace('NEEDS-DECISION: ', 'NEEDS-DECISION: [new] '))).toMatchObject({ reason: 'answered', itemId: first.itemId });
    expect(items()).toHaveLength(1);
  });

  it('a reword after the answer opens nothing before the ack; after the ack a different question opens a new item', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    const given = answer(first.itemId);
    expect(await ask(REWORD)).toMatchObject({ opened: false, reason: 'answered', itemId: first.itemId, differs: true, question: 'Is the export in scope?' });
    expect(items()).toHaveLength(1);
    ack(first.itemId, given.id);
    const next = await ask(REWORD);
    expect(next).toMatchObject({ opened: true });
    expect(items().map((item) => item.id).sort()).toEqual([first.itemId, (next as { itemId: string }).itemId].sort());
  });

  it('[new] while open opens a second item; its repeat finds it; a third [new] question is held and nothing is revised (r2 ruling A, test 1)', async () => {
    const first = idOf(await ask(LINE));
    const second = idOf(await ask(Q2));
    expect(items().find((item) => item.id === second)).toMatchObject({ state: 'open' });
    expect(await ask(Q2)).toEqual({ opened: false, reason: 'already-open', itemId: second });
    // The same line without the marker is the same line key: the marker is removed, the class tag is kept.
    expect(await ask(Q2.replace('[new] ', ''))).toEqual({ opened: false, reason: 'already-open', itemId: second });
    const newHeldBy = { itemId: second, answered: false, question: 'Pay the vendor today?' };
    const held = await ask(Q3);
    expect(held).toEqual({ opened: false, reason: 'already-open', itemId: second, heldNew: true, newHeldBy });
    expect(noticeOf(held)).not.toContain(PLAIN_NEW);
    expect(noticeOf(held)).toContain('Your [new] line opened nothing and changed nothing.');
    // An unmarked reword while two are open revises neither; its notice says [new] cannot open yet.
    const reword = await ask('NEEDS-DECISION: Pay the vendor this week? (a) pay (b) wait');
    expect(reword).toEqual({ opened: false, reason: 'already-open', itemId: second, openIds: [first, second], newHeldBy });
    expect(noticeOf(reword)).not.toContain(PLAIN_NEW);
    expect(noticeOf(reword)).toContain(needsDecisionNewHint(newHeldBy));
    expect(items()).toHaveLength(2);
    expect(items().map((item) => item.revision)).toEqual([1, 1]);
  });

  it('with only a [new] item open, a [new] line never revises it: a third question and a reword are held; the unmarked reword revises (tests 2, 3)', async () => {
    const first = idOf(await ask(LINE));
    ack(first, answer(first).id);
    const second = idOf(await ask(Q2));
    expect(await ask(Q3)).toMatchObject({ opened: false, reason: 'already-open', itemId: second, heldNew: true, newHeldBy: { itemId: second } });
    expect(await ask(Q2R)).toMatchObject({ opened: false, reason: 'already-open', itemId: second, heldNew: true });
    // Q2 stays on the owner's screen: no revision, the same decision, and no attention.updated.
    expect(items().find((item) => item.id === second)).toMatchObject({ revision: 1, decision: 'Pay the vendor today?' });
    expect(store.snapshot([], 'ws-a').recentEvents.filter((event) => event.type === 'attention.updated')).toEqual([]);
    // AC 1 kept: the reword without the marker revises the open item.
    expect(await ask(Q2R.replace('[new] ', ''))).toMatchObject({
      opened: false, reason: 'revised', itemId: second, revision: 2, replaced: 'Pay the vendor today?', newHeldBy: { itemId: second, answered: false },
    });
    expect(items()).toHaveLength(2);
  });

  it('a reworded [new] line after its answer opens nothing until the ack; after the ack a [new] question opens, marked new (finding 3, test 4)', async () => {
    const first = idOf(await ask(LINE));
    ack(first, answer(first).id);
    const second = idOf(await ask(Q2));
    const given = answer(second);
    const held = await ask(Q2R);
    expect(held).toMatchObject({
      opened: false, reason: 'answered', itemId: second, differs: true, heldNew: true, question: 'Pay the vendor today?',
      newHeldBy: { itemId: second, answered: true }, answer: { optionIds: ['a'] },
    });
    expect(noticeOf(held)).toContain('Your [new] line opened nothing: the owner answered this tab\'s [new] question "Pay the vendor today?", and its answer is not yet acknowledged.');
    expect(noticeOf(held)).not.toContain(PLAIN_NEW);
    expect(items()).toHaveLength(2);
    ack(second, given.id);
    const third = idOf(await ask(Q3));
    expect(tabItem(third)).toMatchObject({ markedNew: true, state: 'open' });
    expect(items()).toHaveLength(3);
  });

  it('the hold lifts when the [new] item is cancelled; across a restart the hold is read from the store (test 5)', async () => {
    const second = idOf(await ask(Q2));
    restart();
    expect(await ask(Q3, { stopSeq: 1 })).toMatchObject({ reason: 'already-open', itemId: second, heldNew: true });
    cancel(second);
    restart();
    expect(await ask(Q3, { stopSeq: 1 })).toMatchObject({ opened: true });
  });

  it('the hold lifts past the answer window: an unacked [new] answer older than 24 h holds nothing (test 5)', async () => {
    const second = idOf(await ask(Q2));
    const given = answer(second);
    expect(await ask(Q3)).toMatchObject({ reason: 'answered', itemId: second, heldNew: true });
    const deps = await needsDecisionDeps();
    expect(await ask(Q3, {}, { ...deps, now: () => given.createdAt + NEEDS_DECISION_ANSWER_WINDOW_MS + 1 })).toMatchObject({ opened: true });
  });

  it('an item the orchestrator opened from a handed [new] id is the tab\'s waiting [new] question: its reworded [new] repeat is held (test 6)', async () => {
    const deps = await needsDecisionDeps();
    const handed = await ask(Q2, {}, { ...deps, openRuns: () => [] });
    expect(handed).toMatchObject({ opened: false, reason: 'no-orchestrator-run' });
    const handedId = (handed as { itemId: string }).itemId;
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'orch-open-new', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: handedId, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: Q2 }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-orch', identity: 'launch' });
    expect(tabItem(handedId)).toMatchObject({ markedNew: true });
    // The orchestrator's own open, not the server's: it is the orchestrator's ask, never tab-w's.
    expect(store.itemsAskedByTab('ws-a', 'tab-orch', 0)).toEqual([handedId]);
    expect(store.itemsAskedByTab('ws-a', 'tab-w', 0)).toEqual([]);
    expect(await ask(Q2R)).toMatchObject({ opened: false, reason: 'already-open', itemId: handedId, heldNew: true });
    expect(items()).toHaveLength(1);
    expect(items()[0].revision).toBe(1);
  });

  // Review r2 nit (round 3): a revision-0 reservation of a stop that opened nothing must not decide the marker of the
  // item a later stop of the same line key opens; the line key ignores [new], so the marker can toggle in between.
  const reserveThenOpen = async (reserved: string, opening: string) => {
    const deps = await needsDecisionDeps();
    const reservation = await ask(reserved, {}, { ...deps, openRuns: () => [] });
    expect(reservation).toMatchObject({ opened: false, reason: 'no-orchestrator-run' });
    const itemId = (reservation as { itemId: string }).itemId;
    expect(await ask(opening)).toEqual({ opened: true, itemId, runId: 'run-a' });
    const row = (store as unknown as { database: Database.Database }).database
      .prepare('SELECT revision, marked_new FROM mission_nd_lines WHERE item_id = ?').all(itemId);
    return { itemId, row };
  };

  it('a reservation without [new], then an open with [new]: the item is markedNew and holds the next [new] line (round 3)', async () => {
    const { itemId, row } = await reserveThenOpen(Q2.replace('[new] ', ''), Q2);
    expect(row).toEqual([{ revision: 1, marked_new: 1 }]);
    expect(tabItem(itemId)).toMatchObject({ markedNew: true });
    expect(await ask(Q3)).toMatchObject({ opened: false, reason: 'already-open', itemId, heldNew: true });
    expect(items()).toHaveLength(1);
  });

  it('a reservation with [new], then an open without [new]: the item is not markedNew and a [new] line opens (round 3)', async () => {
    const { itemId, row } = await reserveThenOpen(Q2, Q2.replace('[new] ', ''));
    expect(row).toEqual([{ revision: 1, marked_new: 0 }]);
    expect(tabItem(itemId)).toMatchObject({ markedNew: false });
    const third = await ask(Q3);
    expect(third).toMatchObject({ opened: true });
    expect(idOf(third)).not.toBe(itemId);
    expect(items()).toHaveLength(2);
  });

  it('an orchestrator-opened [new] item stays markedNew after an unmarked revise: the next [new] line is held (round 3, consult r3)', async () => {
    const deps = await needsDecisionDeps();
    const handed = await ask(Q2, {}, { ...deps, openRuns: () => [] });
    const handedId = (handed as { itemId: string }).itemId;
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'orch-open-new-r3', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: handedId, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: Q2 }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-orch', identity: 'launch' });
    expect(await ask(Q2R.replace('[new] ', ''))).toMatchObject({ opened: false, reason: 'revised', itemId: handedId });
    const rows = (store as unknown as { database: Database.Database }).database
      .prepare('SELECT revision, marked_new FROM mission_nd_lines WHERE item_id = ? ORDER BY revision').all(handedId);
    expect(rows).toEqual([{ revision: 0, marked_new: 1 }, { revision: 2, marked_new: 0 }]);
    expect(tabItem(handedId)).toMatchObject({ markedNew: true, revision: 2 });
    expect(await ask(Q3)).toMatchObject({ opened: false, itemId: handedId, heldNew: true });
    expect(items()).toHaveLength(1);
  });

  it('an answered question matches its text whatever its tag or letter case; an open item still revises on a tag change (finding 2, test 7)', async () => {
    const money = 'NEEDS-DECISION: [money] Release the hold? (a) yes (b) no';
    const first = idOf(await ask(money));
    ack(first, answer(first).id);
    for (const line of [
      'NEEDS-DECISION: [scope] Release the hold? (a) yes (b) no',
      'NEEDS-DECISION: [MONEY] release the HOLD?  (a) yes (b) no',
      'NEEDS-DECISION: [new] [scope] Release the hold? (a) yes (b) no',
    ]) expect(await ask(line)).toMatchObject({ opened: false, reason: 'answered', itemId: first, differs: false });
    expect(items()).toHaveLength(1);
    // While open, the tag is part of the line key: the tag change revises the item, and the new class reaches the owner.
    const refund = idOf(await ask('NEEDS-DECISION: [money] Wire the refund? (a) yes (b) no'));
    expect(await ask('NEEDS-DECISION: [scope] Wire the refund? (a) yes (b) no')).toMatchObject({ reason: 'revised', itemId: refund, revision: 2 });
    expect(items().find((item) => item.id === refund)).toMatchObject({ class: 'scope', revision: 2 });
    expect(tabItem(refund)?.textKeys).toEqual([needsDecisionTextKey('ws-a', 'tab-w', 'NEEDS-DECISION: [scope] wire the refund? (a) yes (b) no')]);
  });

  it('a legacy item with no line rows matches its exact line key only (test 7)', async () => {
    const first = idOf(await ask(LINE));
    (store as unknown as { database: Database.Database }).database.prepare('DELETE FROM mission_nd_lines WHERE item_id = ?').run(first);
    ack(first, answer(first).id);
    expect(await ask(LINE)).toMatchObject({ reason: 'answered', itemId: first, differs: false });
    expect(await ask(LINE.replace('[scope]', '[money]'))).toMatchObject({ opened: true });
  });

  it('a mission_nd_lines table from before text_key gains the column; its old rows match by line key (test 7)', async () => {
    const legacy = path.join(dir, 'legacy.sqlite');
    const raw = new Database(legacy);
    raw.exec(`CREATE TABLE mission_nd_lines (
      item_id TEXT NOT NULL, line_key TEXT NOT NULL, workspace_id TEXT NOT NULL, tab_id TEXT NOT NULL,
      revision INTEGER NOT NULL, marked_new INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (item_id, line_key));
      INSERT INTO mission_nd_lines VALUES ('nd-old', 'abc', 'ws-a', 'tab-w', 1, 1, 5);`);
    raw.close();
    const reopened = new MissionControlStore(legacy);
    try {
      const db = (reopened as unknown as { database: Database.Database }).database;
      expect((db.prepare('PRAGMA table_info(mission_nd_lines)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('text_key');
      expect(db.prepare('SELECT item_id, line_key, text_key, marked_new FROM mission_nd_lines').all())
        .toEqual([{ item_id: 'nd-old', line_key: 'abc', text_key: null, marked_new: 1 }]);
    } finally {
      reopened.close();
    }
  });

  it('the revise limit: after X goes Q1 to Q3, [new] Q3 is X, and [new] Q1 in new words opens (test 10)', async () => {
    const x = idOf(await ask(LINE));
    const q3 = 'NEEDS-DECISION: [scope] Ship the export on Monday? (a) yes (b) no';
    expect(await ask(q3)).toMatchObject({ reason: 'revised', itemId: x });
    expect(await ask(q3.replace('NEEDS-DECISION: ', 'NEEDS-DECISION: [new] '))).toEqual({ opened: false, reason: 'already-open', itemId: x });
    expect(await ask('NEEDS-DECISION: [new] [scope] Is the export part of this release? (a) yes (b) no')).toMatchObject({ opened: true });
    expect(items()).toHaveLength(2);
  });

  it('notice truth: after a notice with the plain [new] hint a [new] line opens; after a notice with the held hint it is held (test 9)', async () => {
    const PROBE = 'NEEDS-DECISION: [new] Which audit lane runs first? (a) bank (b) ledger';
    const offersPlain = (text: string) => text.includes('end on NEEDS-DECISION: [new] <');
    const holdsNew = (text: string) => text.includes('cannot open yet') || text.includes('Your [new] line opened nothing');
    /** One scenario on its own tab: the outcome whose notice is judged, and the [new] line that notice offers. */
    const scenarios: Array<{ name: string; plain: boolean; run: (tabId: string) => Promise<{ outcome: TNeedsDecisionOutcome; probe?: string }> }> = [
      { name: 'opened', plain: true, run: async (tabId) => ({ outcome: await ask(LINE, { tabId }) }) },
      {
        name: 'revised', plain: true, run: async (tabId) => {
          await ask(LINE, { tabId });
          return { outcome: await ask(REWORD, { tabId }), probe: 'NEEDS-DECISION: [new] [scope] Is the export part of this release? (a) yes (b) no' };
        },
      },
      {
        name: 'answered, differs, unmarked', plain: true, run: async (tabId) => {
          const x = idOf(await ask(LINE, { tabId }));
          answer(x);
          return { outcome: await ask(REWORD, { tabId }) };
        },
      },
      {
        name: 'answered, same question', plain: true, run: async (tabId) => {
          const x = idOf(await ask(LINE, { tabId }));
          answer(x);
          return { outcome: await ask(LINE, { tabId }) };
        },
      },
      {
        name: 'already-open with openIds', plain: true, run: async (tabId) => {
          await ask(LINE, { tabId });
          const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
          await applyMissionEventBatch('ws-a', [{
            eventId: `own-${tabId}`, schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
            type: 'attention.opened', payload: {
              itemId: `nd-${'7'.repeat(16)}${tabId.slice(-1).repeat(16)}`,
              ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId, tabName: 'w', line: 'NEEDS-DECISION: own nd ask?' }),
              humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
            },
          }], { tabId, identity: 'session' });
          return { outcome: await ask(REWORD, { tabId, turnStartedAt: Date.now() + 1_000 }) };
        },
      },
      {
        name: 'already-open with openIds, [new] pending', plain: false, run: async (tabId) => {
          await ask(LINE, { tabId });
          await ask(Q2, { tabId });
          return { outcome: await ask('NEEDS-DECISION: Pay the vendor this week?', { tabId }) };
        },
      },
      { name: 'held, open', plain: false, run: async (tabId) => { await ask(Q2, { tabId }); return { outcome: await ask(Q3, { tabId }) }; } },
      { name: 'revised, [new] pending', plain: false, run: async (tabId) => { await ask(Q2, { tabId }); return { outcome: await ask(Q2R.replace('[new] ', ''), { tabId }) }; } },
      {
        name: 'answered, differs, [new] pending', plain: false, run: async (tabId) => {
          answer(idOf(await ask(Q2, { tabId })));
          return { outcome: await ask('NEEDS-DECISION: Ship on Monday?', { tabId }) };
        },
      },
      { name: 'answered, same, [new] pending', plain: false, run: async (tabId) => { answer(idOf(await ask(Q2, { tabId }))); return { outcome: await ask(Q2, { tabId }) }; } },
      { name: 'held, answered', plain: false, run: async (tabId) => { answer(idOf(await ask(Q2, { tabId }))); return { outcome: await ask(Q2R, { tabId }) }; } },
    ];
    const judged: Array<[string, boolean, boolean]> = [];
    const reached: string[] = [];
    for (const [index, scenario] of scenarios.entries()) {
      const tabId = `tab-s${index.toString(16)}`;
      const { outcome, probe } = await scenario.run(tabId);
      const text = noticeOf(outcome);
      reached.push(`${scenario.name}=${outcome.opened ? 'opened' : outcome.reason}${'openIds' in outcome && outcome.openIds ? '+openIds' : ''}${'heldNew' in outcome && outcome.heldNew ? '+held' : ''}`);
      expect(holdsNew(text), `${scenario.name}: ${text}`).toBe(!scenario.plain);
      if (!scenario.plain) expect(offersPlain(text), `${scenario.name}: ${text}`).toBe(false);
      const next = await ask(probe ?? PROBE, { tabId, turnStartedAt: Date.now() + 1_000 });
      judged.push([scenario.name, scenario.plain, next.opened]);
      if (!scenario.plain) expect(next, scenario.name).toMatchObject({ opened: false, heldNew: true });
    }
    expect(judged.filter(([, plain, opened]) => plain !== opened)).toEqual([]);
    // Each scenario reached the outcome it names, so no row of the check passes on the wrong notice.
    expect(reached).toEqual([
      'opened=opened', 'revised=revised', 'answered, differs, unmarked=answered', 'answered, same question=answered',
      'already-open with openIds=already-open+openIds', 'already-open with openIds, [new] pending=already-open+openIds', 'held, open=already-open+held',
      'revised, [new] pending=revised', 'answered, differs, [new] pending=answered', 'answered, same, [new] pending=answered', 'held, answered=answered+held',
    ]);
  });

  it('a new question after the ack opens; a [new] question while an answer is unacked opens', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    const given = answer(first.itemId);
    const marked = await ask('NEEDS-DECISION: [new] Which bank file wins? (a) BC (b) Kyriba');
    expect(marked).toMatchObject({ opened: true });
    const markedId = (marked as { itemId: string }).itemId;
    ack(first.itemId, given.id);
    answer(markedId);
    // Its own answer is not acked: an unmarked different line is still "answered" for the newest unacked item.
    expect(await ask('NEEDS-DECISION: Ship on Monday? (a) yes (b) no')).toMatchObject({ reason: 'answered', itemId: markedId, differs: true });
    expect(items()).toHaveLength(2);
  });

  it('a server restart between lines loses nothing: the store holds every line key (story 03 kept)', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    restart();
    expect(await ask(LINE, { stopSeq: 1 })).toEqual({ opened: false, reason: 'already-open', itemId: first.itemId });
    restart();
    expect(await ask(REWORD, { stopSeq: 1 })).toMatchObject({ reason: 'revised', itemId: first.itemId });
    restart();
    // The reworded line, after a restart and after the answer and the ack: still the answered item (the line row holds it).
    const given = answer(first.itemId);
    ack(first.itemId, given.id);
    restart();
    expect(await ask(REWORD, { stopSeq: 1 })).toMatchObject({ reason: 'answered', itemId: first.itemId, differs: false });
    expect(items()).toHaveLength(1);
  });

  it('past the 24 h answer window the same line asks anew', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    const given = answer(first.itemId);
    ack(first.itemId, given.id);
    const deps = await needsDecisionDeps();
    const later = { ...deps, now: () => given.createdAt + NEEDS_DECISION_ANSWER_WINDOW_MS + 1 };
    expect(NEEDS_DECISION_ANSWER_WINDOW_MS).toBe(24 * 60 * 60_000);
    expect(await ask(LINE, {}, later)).toMatchObject({ opened: true });
    expect(items()).toHaveLength(2);
  });

  it('a cancelled item never matches: the same line asks anew', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    const event = {
      eventId: 'cancel-1', schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 1, producerAt: 3,
      bindingGeneration: 1, type: 'attention.cancelled' as const, payload: { itemId: first.itemId, reason: 'superseded' },
    };
    store.applyEvents([event], new Map([[event.eventId, ORCH]]));
    expect(await ask(LINE)).toMatchObject({ opened: true });
  });

  it('a failed revise never opens a second item: still open is already-open; answered in the race is answered (consult 6)', async () => {
    const first = await ask(LINE);
    if (!first.opened) throw new Error('not opened');
    const deps = await needsDecisionDeps();
    // The item's run is not among the open runs: the revise cannot be written.
    expect(await ask(REWORD, {}, { ...deps, openRuns: () => [] })).toEqual({ opened: false, reason: 'already-open', itemId: first.itemId });
    // The owner answers between the read and the write: the store refuses the revision as stale.
    const racing = {
      ...deps,
      apply: async (...args: Parameters<typeof deps.apply>) => {
        answer(first.itemId);
        return deps.apply(...args);
      },
    };
    expect(await ask(REWORD, {}, racing)).toMatchObject({ opened: false, reason: 'answered', itemId: first.itemId, differs: true });
    // The line was recorded against the answered item: after the ack, its repeat is still a repeat.
    ack(first.itemId, store.snapshot([], 'ws-a').answers[0].id);
    expect(await ask(REWORD)).toMatchObject({ reason: 'answered', itemId: first.itemId, differs: false });
    expect(items()).toHaveLength(1);
  });

  it('an id handed to the orchestrator is the tab\'s once that item exists: a reword revises it (consult 5)', async () => {
    const deps = await needsDecisionDeps();
    const handed = await ask(LINE, {}, { ...deps, openRuns: () => [] });
    expect(handed).toMatchObject({ opened: false, reason: 'no-orchestrator-run' });
    const handedId = (handed as { itemId: string }).itemId;
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'orch-open-pm2', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: handedId, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: LINE }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-orch', identity: 'launch' });
    expect(await ask(REWORD)).toMatchObject({ opened: false, reason: 'revised', itemId: handedId });
    expect(items()).toHaveLength(1);
  });

  it('a tab\'s own mc ask this turn still suppresses the line; another tab\'s items never count (AC 3)', async () => {
    const other = await openNeedsDecisionItem(await needsDecisionDeps(), {
      workspaceId: 'ws-a', tabId: 'tab-other', tabName: 'other', line: LINE, stopSeq: 1, stopAt: 1, turnStartedAt: 0,
    });
    expect(other).toMatchObject({ opened: true });
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'tab-ask-1', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: 'ask-1', ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: 'NEEDS-DECISION: own ask?' }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-w', identity: 'session' });
    expect(await ask(REWORD)).toEqual({ opened: false, reason: 'asked-this-turn', itemId: 'ask-1' });
    // The other tab's open item is not tab-w's: a later line of tab-w opens its own item, the other stays at revision 1.
    expect(await ask(REWORD, { turnStartedAt: Date.now() + 10 })).toMatchObject({ opened: true });
    expect(items().find((item) => item.id === (other as { itemId: string }).itemId)?.revision).toBe(1);
  });

  it('the server\'s item of the previous stop is never the tab\'s own ask: not inside the turn, not past the answer window', async () => {
    const first = idOf(await ask(LINE));
    const given = answer(first);
    ack(first, given.id);
    // The store tells the two openers apart by the event id, for any `since`, state or age.
    expect(store.itemsAskedByTab('ws-a', 'tab-w', 0)).toEqual([]);
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await applyMissionEventBatch('ws-a', [{
      eventId: 'tab-ask-own', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: 'ask-own', ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: 'NEEDS-DECISION: own ask?' }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-w', identity: 'session' });
    expect(store.itemsAskedByTab('ws-a', 'tab-w', 0)).toEqual(['ask-own']);
    expect(store.itemsAskedByTab('ws-a', 'tab-w', Date.now() + 1)).toEqual([]);
    // The next stop's turn began at the stop that opened `first`, and the tab asked `ask-own` in it. Past the answer
    // window, `first` has left the tab's windowed items: the tab's own ask still counts, the server's item never does.
    const later = { ...(await needsDecisionDeps()), now: () => given.createdAt + NEEDS_DECISION_ANSWER_WINDOW_MS + 1 };
    expect(await ask(LINE, {}, later)).toEqual({ opened: false, reason: 'asked-this-turn', itemId: 'ask-own' });
  });

  it('only the server opener records a line, only on an nd- item of the tab that owns it (AC 3)', async () => {
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    const lines = (itemId: string) => (store as unknown as { database: { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } } })
      .database.prepare('SELECT * FROM mission_nd_lines WHERE item_id = ?').all(itemId);
    // A request without the server prefix: the side input is dropped.
    await applyMissionEventBatch('ws-a', [{
      eventId: 'tool-open-1', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: {
        itemId: 'tool-1', ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: 'NEEDS-DECISION: tool?' }),
        humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    }], { tabId: 'tab-w', identity: 'session' }, { ndLines: new Map([['tool-open-1', { tabId: 'tab-w', lineKey: 'f'.repeat(16), textKey: 'f'.repeat(16), markedNew: false }]]) });
    expect(lines('tool-1')).toEqual([]);
    // The store itself refuses a line row on a non-nd item, or for a tab that does not own the item.
    const first = await ask(LINE, { turnStartedAt: Date.now() + 10 });
    if (!first.opened) throw new Error('not opened');
    const update = (eventId: string, itemId: string, revision: number) => ({
      eventId, schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: revision, producerAt: 4, bindingGeneration: 1,
      type: 'attention.updated' as const, payload: {
        itemId, ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: REWORD }),
        humanReview: { humanNeed: 'decision' as const, humanReason: 'r', handling: 'h', reviewerTabId: 'tab-orch' },
      },
    });
    const authority = (eventId: string) => new Map([[eventId, { resolvedIdentity: ORCH, configuredOrchestratorTabId: 'tab-orch' }]]);
    expect(() => store.applyEvents([update('u-1', first.itemId, 1) as never], authority('u-1'),
      { ndLines: new Map([['u-1', { tabId: 'tab-intruder', lineKey: 'e'.repeat(16), textKey: 'e'.repeat(16), markedNew: false }]]) })).toThrow('is not its own');
    expect(() => store.applyEvents([update('u-2', 'tool-1', 1) as never], authority('u-2'),
      { ndLines: new Map([['u-2', { tabId: 'tab-w', lineKey: 'e'.repeat(16), textKey: 'e'.repeat(16), markedNew: false }]]) })).toThrow('needs an nd- item');
    expect(items().find((item) => item.id === first.itemId)?.revision).toBe(1);
    expect(lines(first.itemId)).toHaveLength(1);
  });
});

describe('the asking tab\'s notice (story 36, D1)', () => {
  const ID = 'nd-0123456789abcdef0123456789abcdef';

  it('names the item that opened, or the reason none did, the fate and the id it would have had', () => {
    expect(needsDecisionAskerNotice({ kind: 'item', state: 'opened', itemId: ID }))
      .toBe(`[needs-decision] [MC item ${ID} opened for the owner by the server: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control.`);
    expect(needsDecisionAskerNotice({ kind: 'not-opened', reason: 'no-orchestrator', itemId: ID, fate: 'owner push dispatched, delivery not confirmed', askerIsOrchestrator: false }))
      .toBe(`[needs-decision] item-not-opened: no-orchestrator. Your NEEDS-DECISION line opened no Mission Control item; owner push dispatched, delivery not confirmed. Its id would be ${ID}.`);
  });

  it('names the open items a line revised none of, and what a revision replaced (PM-2)', () => {
    expect(needsDecisionAskerNotice({ kind: 'item', state: 'already-open', itemId: ID, openIds: ['nd-a', ID] })).toBe(
      `[needs-decision] [MC item ${ID} already open for the owner: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control. Your open items: nd-a, ${ID}; your line revised none of them. A different question: end on NEEDS-DECISION: [new] <question>?`);
    expect(needsDecisionAskerNotice({ kind: 'revised', itemId: ID, replaced: 'Ship   it?' })).toBe(
      `[needs-decision] [MC item ${ID} revised for the owner by the server: do not open another] Your line replaced the question "Ship it?"; the owner no longer sees it. If yours is a different question, ask the replaced one again in its own item: end on NEEDS-DECISION: [new] <the replaced question, in new words>? (its old line stays item ${ID}'s).`);
  });

  it('re-delivers the answer: the options and the text, the delivery, and to the orchestrator itself "delivered to you" (PM-2, D51)', () => {
    const answer = { answeredAt: Date.UTC(2026, 10, 7, 0, 0, 0), optionIds: ['a'], optionLabels: ['yes'], text: 'and tell v2', delivery: { state: 'submitted', reason: null, tabId: 'tab-orch' } };
    expect(needsDecisionAskerNotice({ kind: 'answered', itemId: ID, answer, differs: false, question: 'Ship?', askerIsOrchestrator: true })).toBe(
      `[needs-decision] [MC item ${ID} answered by the owner at 2026-11-07T00:00:00.000Z: do not open another] The answer: (a) yes; "and tell v2". It was delivered to you (delivery submitted). Act on this answer: this question opens no new item until 2026-11-08T00:00:00.000Z, with or without [new]. If something has changed since the answer, ask a new question that says what changed: end on NEEDS-DECISION: [new] <question>?`);
    expect(needsDecisionAskerNotice({ kind: 'answered', itemId: ID, answer: { ...answer, delivery: { state: 'queued', reason: null, tabId: 'tab-orch' } }, differs: false, question: 'Ship?', askerIsOrchestrator: false }))
      .toContain('Delivery queued: on its way to tab-orch.');
    expect(needsDecisionAskerNotice({ kind: 'answered', itemId: ID, answer: { ...answer, optionIds: [], optionLabels: [], text: '', delivery: { state: null, reason: null, tabId: null } }, differs: false, question: 'Ship?', askerIsOrchestrator: false }))
      .toContain('The answer: (no option and no text). No delivery is recorded.');
  });

  it('the same question inside the window says until when, with or without [new]; a waiting [new] question replaces the hint (finding 4, test 8)', () => {
    const answer = { answeredAt: Date.UTC(2026, 10, 7, 0, 0, 0), optionIds: ['a'], optionLabels: ['yes'], text: '', delivery: { state: 'submitted', reason: null, tabId: 'tab-orch' } };
    const base = { kind: 'answered' as const, itemId: ID, answer, differs: false, question: 'Ship?', askerIsOrchestrator: false };
    expect(needsDecisionAskerNotice(base)).toBe(
      `[needs-decision] [MC item ${ID} answered by the owner at 2026-11-07T00:00:00.000Z: do not open another] The answer: (a) yes. It went to tab-orch (delivery submitted), which relays it. Act on this answer: this question opens no new item until 2026-11-08T00:00:00.000Z, with or without [new]. If something has changed since the answer, ask a new question that says what changed: end on NEEDS-DECISION: [new] <question>?`);
    const open = { itemId: 'nd-p', answered: false, question: 'Pay?' };
    expect(needsDecisionAskerNotice({ ...base, newHeldBy: open })).toBe(
      `[needs-decision] [MC item ${ID} answered by the owner at 2026-11-07T00:00:00.000Z: do not open another] The answer: (a) yes. It went to tab-orch (delivery submitted), which relays it. Act on this answer: this question opens no new item until 2026-11-08T00:00:00.000Z, with or without [new]. A different question cannot open yet: this tab's [new] question nd-p is still open, and a tab has one [new] question at a time. End on your [new] line again after nd-p is answered and its answer acknowledged.`);
    expect(needsDecisionNewHint({ ...open, answered: true })).toBe(
      'A different question cannot open yet: the owner answered this tab\'s [new] question nd-p, and the answer is not yet acknowledged. End on your [new] line again once it is (your orchestrator acknowledges it when it relays it).');
    expect(needsDecisionNewHint(undefined)).toBe('A different question: end on NEEDS-DECISION: [new] <question>?');
    // The differs notice and the revise notice take the held hint too.
    expect(needsDecisionAskerNotice({ ...base, differs: true, newHeldBy: open }).endsWith(`, which relays it. ${needsDecisionNewHint(open)}`)).toBe(true);
    expect(needsDecisionAskerNotice({ kind: 'revised', itemId: ID, replaced: 'Ship?', newHeldBy: open })).toBe(
      `[needs-decision] [MC item ${ID} revised for the owner by the server: do not open another] Your line replaced the question "Ship?"; the owner no longer sees it. ${needsDecisionNewHint(open)}`);
    expect(needsDecisionAskerNotice({ kind: 'held', itemId: 'nd-p', question: 'Pay   the vendor?' })).toBe(
      '[needs-decision] [MC item nd-p already open for the owner: do not open another] Your [new] line opened nothing and changed nothing. This tab\'s [new] question nd-p is still open ("Pay the vendor?"), and a tab has one [new] question at a time. If your line rewords that question, end on that item\'s line unchanged. If it is a different question, it is not in Mission Control yet: end on it again with [new] after nd-p is answered and its answer acknowledged.');
  });

  it('tells a line with no question that nothing opened (D28)', () => {
    expect(needsDecisionAskerNotice({ kind: 'no-question' })).toBe(
      '[needs-decision] item-not-opened: no-question. Your NEEDS-DECISION line holds no question mark after the marker, so the server opened no Mission Control item and told no one. If you need a decision, end on one line: NEEDS-DECISION: <question>? (a) <option> (b) <option>.');
  });

  it('collapses a refusal detail to one line of at most 200 chars, and tells an orchestrator how to open the item itself', () => {
    const notice = needsDecisionAskerNotice({
      kind: 'not-opened', reason: 'refused', itemId: ID, detail: `bad\n review ${'x'.repeat(400)}`, fate: 'f', askerIsOrchestrator: true,
    });
    const detail = /\(([^)]*)\)/.exec(notice)![1];
    expect(detail.startsWith('bad review x')).toBe(true);
    expect(detail).toHaveLength(200);
    expect(notice.endsWith(`You are the orchestrator: resume or start your Mission Control run, then open item ${ID} from your line with your human review.`)).toBe(true);
  });
});

describe('the owner push detail (story 36; the phone fixture generator calls it)', () => {
  it('is `<tab name or id> · <workspace name or id>: <line without marker and tag, whitespace collapsed>`', () => {
    expect(needsDecisionPushDetail({ tabId: 'tab-w', tabName: 'w1', workspaceId: 'ws-a', workspaceName: 'alpha', line: 'NEEDS-DECISION: [money]  Pay the\n vendor? (a) yes (b) no' }))
      .toBe('w1 · alpha: Pay the vendor? (a) yes (b) no');
    expect(needsDecisionPushDetail({ tabId: 'tab-w', tabName: '', workspaceId: 'ws-a', workspaceName: undefined, line: 'NEEDS-DECISION: Ship it?' }))
      .toBe('tab-w · ws-a: Ship it?');
  });
});
