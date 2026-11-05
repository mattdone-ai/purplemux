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
import { buildNeedsDecisionQuestion, parseNeedsDecisionLine } from '@/lib/needs-decision';
import { needsDecisionDeps, needsDecisionItemId, openNeedsDecisionItem, type INeedsDecisionStop } from '@/lib/needs-decision-opener';
import { extractTurnMarker, lastTurnLine, TURN_TAIL_CHARS } from '@/lib/turn-end';

const ORCH: Omit<IMissionBinding, 'generation'> = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'sess-orch', runtimeGeneration: 'launch-1' };

describe('the NEEDS-DECISION end line', () => {
  it('reads an optional class tag and up to four (a)/(1) options', () => {
    expect(parseNeedsDecisionLine('NEEDS-DECISION: [money] Pay the vendor invoice now? (a) pay today (b) wait for the credit note'))
      .toEqual({ class: 'money', question: 'Pay the vendor invoice now?', options: [{ id: 'a', label: 'pay today' }, { id: 'b', label: 'wait for the credit note' }] });
    expect(parseNeedsDecisionLine('NEEDS-DECISION: Which host runs the gate? (1) mdserver1, (2) ai-server, (3) both'))
      .toEqual({ class: null, question: 'Which host runs the gate?', options: [{ id: '1', label: 'mdserver1' }, { id: '2', label: 'ai-server' }, { id: '3', label: 'both' }] });
    expect(parseNeedsDecisionLine('NEEDS-DECISION: [Scope] Is the export in this epic?')).toEqual({ class: 'scope', question: 'Is the export in this epic?', options: [] });
    expect(parseNeedsDecisionLine('NEEDS-DECISION: [urgent] keep (b) then (a)').options).toEqual([]);
    expect(parseNeedsDecisionLine('NEEDS-DECISION: [urgent] keep (b) then (a)').class).toBeNull();
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

  it('opens nothing more when the tab opened an item in the same turn, or for a second stop of the turn', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    expect(await openNeedsDecisionItem(deps, stop())).toMatchObject({ opened: true });
    expect(await openNeedsDecisionItem(deps, stop({ stopSeq: 8, line: 'NEEDS-DECISION: another?' }))).toMatchObject({ opened: false, reason: 'asked-this-turn' });
    // The next turn starts after the item: it asks again.
    const later = Date.now() + 1;
    expect(await openNeedsDecisionItem(deps, stop({ stopSeq: 9, line: 'NEEDS-DECISION: next turn?', turnStartedAt: later }))).toMatchObject({ opened: true });
    expect(items()).toHaveLength(2);
  });

  it('the same line on 3 turns opens 1 item; once it is answered, the same line opens a new one (R1)', async () => {
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
    expect(again).toMatchObject({ opened: true });
    expect((again as { itemId: string }).itemId).not.toBe(itemId);
    expect(items()).toHaveLength(2);
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

  it('an answered question reopens after a restart resets the stop seq (confirm D1)', async () => {
    startRun();
    const deps = await needsDecisionDeps();
    const line = 'NEEDS-DECISION: Ship the export now? (a) yes (b) no';
    const first = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 3, stopAt: 1_000 }));
    expect(first).toMatchObject({ opened: true });
    const itemId = (first as { itemId: string }).itemId;
    store.submitAnswer(itemId, { submissionId: 'sub-d1', expectedRevision: items()[0].revision, optionIds: ['b'], text: '', actionCompleted: false }, 'owner');
    // The server restarted: the tab's stop seq is 3 again; only the stop's time differs.
    const again = await openNeedsDecisionItem(deps, stop({ line, stopSeq: 3, stopAt: 2_000, turnStartedAt: Date.now() + 1 }));
    expect(again).toMatchObject({ opened: true });
    expect((again as { itemId: string }).itemId).not.toBe(itemId);
    expect(items()).toHaveLength(2);
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

  it('a producer cannot take the server opener\'s event namespace', async () => {
    startRun();
    const { applyMissionEventBatch } = await import('@/lib/mission-control-events');
    await expect(applyMissionEventBatch('ws-a', [{
      eventId: 'system:needs-decision:forged', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 2, bindingGeneration: 1,
      type: 'attention.opened', payload: { itemId: 'forged', ...buildNeedsDecisionQuestion({ workspaceId: 'ws-a', tabId: 'tab-w', tabName: 'w', line: 'NEEDS-DECISION: x?' }) },
    }], null)).rejects.toThrow('event ID uses a reserved namespace');
  });
});
