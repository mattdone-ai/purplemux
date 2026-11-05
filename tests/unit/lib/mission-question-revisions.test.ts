import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { isMissionControlError } from '@/lib/mission-control-errors';
import { MissionControlStore } from '@/lib/mission-control-store';
import { parseMissionEvents } from '@/lib/mission-control-validation';
import type { IMissionAnswerRequest, IMissionBinding, TMissionProducerEvent } from '@/types/mission-control';

// ADR-0037 §4: each attention.updated stores a changes record, and an answer made on revision r
// applies to the current revision r' when every revision between them was compatible.

const scratch: string[] = [];
const binding: IMissionBinding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', generation: 1, runtimeGeneration: 'launch-1' };
const identity = { tabId: binding.tabId, providerId: binding.providerId, sessionId: binding.sessionId, runtimeGeneration: binding.runtimeGeneration };
const authority = { resolvedIdentity: identity, configuredOrchestratorTabId: binding.tabId };
const review = { humanNeed: 'decision', humanReason: 'Only the owner decides.', handling: 'Checked the epic documents.', reviewerTabId: binding.tabId };

const options = [
  { id: 'reuse', label: 'Reuse the gate', consequence: 'The gate runs once.', recommended: true },
  { id: 'keep', label: 'Keep re-gating' },
  { id: 'trial', label: 'Trial for 7 days', needsText: true },
];
const question = {
  formatVersion: 2,
  kind: 'question',
  title: 'Gate policy',
  decision: 'Should the lock reuse the pre-flight gate?',
  whyNow: 'Re-gating costs 13 lock-hours a day.',
  answerType: 'single',
  options,
  recommendationWhy: '85% of lock time re-runs a passed gate.',
  evidence: [{ label: 'Lock-hours', url: 'https://example.com/lock' }],
  context: 'The **pre-flight** gate ran on the same tree.',
  storyIds: [],
  blockingScope: 'story',
  canContinue: true,
};

const envelope = (eventId: string, expectedRevision: number) => ({
  eventId, schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision, producerAt: 1_700_000_000_000 + expectedRevision, bindingGeneration: 1,
});

const apply = (store: MissionControlStore, raw: unknown[], questionMinVersion: 1 | 2 = 1) => {
  const events = parseMissionEvents(raw, { questionMinVersion });
  return store.applyEvents(events, new Map(events.map((event) => [event.eventId, authority])), { questionMinVersion });
};

const open = (over: Record<string, unknown> = {}): MissionControlStore => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-question-'));
  scratch.push(directory);
  const store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  const start: TMissionProducerEvent = { ...envelope('e-start', 0), bindingGeneration: 0, type: 'run.started', payload: { objective: 'Ship', tabId: binding.tabId } };
  store.applyEvents([start], new Map([[start.eventId, identity]]));
  apply(store, [{ ...envelope('e-open', 0), type: 'attention.opened', payload: { itemId: 'item-a', ...question, ...over, humanReview: review } }]);
  return store;
};

const update = (store: MissionControlStore, revision: number, over: Record<string, unknown>) =>
  apply(store, [{ ...envelope(`e-update-${revision}`, revision), type: 'attention.updated', payload: { itemId: 'item-a', ...question, ...over, humanReview: review } }]);

const answer = (expectedRevision: number, over: Partial<IMissionAnswerRequest> = {}): IMissionAnswerRequest => ({
  submissionId: `s-${expectedRevision}-${Object.keys(over).join('-')}`, expectedRevision, optionIds: ['keep'], text: '', actionCompleted: false, ...over,
});

const refusalOf = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    if (isMissionControlError(error)) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('format-2 items in the store', () => {
  it('serves the v2 fields, the evidence links as evidenceLinks, and no lint', () => {
    const item = open().snapshot().items[0];
    expect(item).toMatchObject({
      formatVersion: 2,
      decision: question.decision,
      answerType: 'single',
      evidenceLinks: question.evidence,
      evidence: { source: 'agent', confidence: 'confirmed' },
      lint: [],
      changes: null,
      recommendation: null,
    });
    expect(item.options[1]).toEqual({ id: 'keep', label: 'Keep re-gating', recommended: false, needsText: false });
  });

  it('serves the lint findings of a v1 item', () => {
    const store = open();
    apply(store, [{ ...envelope('e-open-v1', 0), type: 'attention.opened', payload: {
      itemId: 'item-v1', kind: 'question', title: 'Pick', context: 'One option only.', storyIds: [],
      options: [{ id: 'only', label: 'The only option' }], recommendation: null, blockingScope: 'story', canContinue: true, humanReview: review,
    } }]);
    const item = store.snapshot().items.find((candidate) => candidate.id === 'item-v1');
    expect(item?.lint.map((finding) => finding.field)).toEqual(['formatVersion', 'options']);
    expect(item?.evidenceLinks).toEqual([]);
  });
});

describe('attention.updated stores a changes record (ADR-0037 §4)', () => {
  it('records an answer-type change as incompatible, then a context change as compatible, on the item and the event', () => {
    const store = open();
    const result = update(store, 1, { options: [...options.slice(0, 1), { id: 'keep', label: 'Keep (status quo)' }, options[2], { id: 'later', label: 'Later' }], answerType: 'multi', recommendationWhy: 'x' });
    const changes = store.snapshot().items[0].changes;
    expect(changes).toMatchObject({ fromRevision: 1, toRevision: 2, compatible: false, answerType: { from: 'single', to: 'multi' } });
    expect(result.events[0].payload.changes).toEqual(changes);

    update(store, 2, { answerType: 'multi', recommendationWhy: 'x', options: [...options.slice(0, 1), { id: 'keep', label: 'Keep (status quo)' }, options[2], { id: 'later', label: 'Later' }], context: 'New context' });
    expect(store.snapshot().items[0].changes).toMatchObject({ fromRevision: 2, toRevision: 3, compatible: true, context: true });
  });
});

describe('answers across revisions (ADR-0037 §4)', () => {
  it('accepts an answer on r against a compatible r\' and stores both revisions', () => {
    const store = open();
    update(store, 1, { options: [...options, { id: 'later', label: 'Later' }], context: 'More context' });
    const response = store.submitAnswer('item-a', answer(1), 'owner');
    expect(response.answer).toMatchObject({ expectedRevision: 1, appliedRevision: 2, optionIds: ['keep'] });
    expect(store.snapshot().answers[0]).toMatchObject({ expectedRevision: 1, appliedRevision: 2 });
    const recorded = store.snapshot().recentEvents.find((event) => event.type === 'answer.recorded');
    expect(recorded?.payload).toMatchObject({ expectedRevision: 1, appliedRevision: 2 });
  });

  it('refuses an answer across a removed option with 409 and the changes record', () => {
    const store = open();
    update(store, 1, { options: options.slice(0, 2) });
    const refusal = refusalOf(() => store.submitAnswer('item-a', answer(1), 'owner'));
    expect(refusal.status).toBe(409);
    expect(refusal.detail?.changes).toMatchObject({ fromRevision: 1, toRevision: 2, compatible: false, options: { removed: ['trial'] } });
    expect(refusal.current).toMatchObject({ id: 'item-a', revision: 2 });
  });

  it('refuses across a changed decision, even when the selected option survived', () => {
    const store = open();
    update(store, 1, { decision: 'Should the lock reuse a gate at most 1 h old?' });
    expect(refusalOf(() => store.submitAnswer('item-a', answer(1), 'owner')).detail?.changes?.decision)
      .toEqual({ from: question.decision, to: 'Should the lock reuse a gate at most 1 h old?' });
  });

  it('refuses when any revision in the span was incompatible, though the ends look alike', () => {
    const store = open();
    update(store, 1, { options: options.slice(0, 2) });
    update(store, 2, { options });
    const refusal = refusalOf(() => store.submitAnswer('item-a', answer(1), 'owner'));
    expect(refusal.detail?.changes).toMatchObject({ fromRevision: 1, toRevision: 3, compatible: false, options: { removed: ['trial'], added: ['trial'] } });
    expect(store.submitAnswer('item-a', answer(3), 'owner').answer.appliedRevision).toBe(3);
  });

  it('refuses across a revision with no record (written before ADR-0037) and names it', () => {
    const store = open();
    update(store, 1, { context: 'a' });
    const file = (store as unknown as { database: Database.Database }).database;
    file.prepare('DELETE FROM mission_item_changes WHERE revision = 2').run();
    expect(refusalOf(() => store.submitAnswer('item-a', answer(1), 'owner')).detail?.changes?.unrecorded).toEqual([2]);
  });

  it('race: the agent updates between the owner\'s read and submit', () => {
    const store = open();
    const read = store.snapshot().items[0].revision;
    update(store, read, { context: 'The agent added a line while the owner was choosing.' });
    expect(store.submitAnswer('item-a', answer(read), 'owner').answer.appliedRevision).toBe(read + 1);
    expect(() => update(store, read + 2, { context: 'late' })).toThrowError(/only open or candidate items can be updated/);
  });

  it('race: an incompatible update wins; the owner answers the new revision', () => {
    const store = open();
    update(store, 1, { options: options.slice(1) });
    expect(refusalOf(() => store.submitAnswer('item-a', answer(1), 'owner')).status).toBe(409);
    expect(store.submitAnswer('item-a', answer(2, { submissionId: 'retry' }), 'owner').answer).toMatchObject({ expectedRevision: 2, appliedRevision: 2 });
  });

  it('still refuses a revision from the future', () => {
    expect(refusalOf(() => open().submitAnswer('item-a', answer(5), 'owner')).message).toBe('stale attention revision');
  });

  it('replays an identical submission with the stored answer', () => {
    const store = open();
    const first = store.submitAnswer('item-a', answer(1), 'owner');
    expect(store.submitAnswer('item-a', answer(1), 'owner')).toMatchObject({ replayed: true, answer: { id: first.answer.id } });
  });
});

describe('answer rules by answer type (ADR-0037 §1)', () => {
  it('refuses two options on single and a needsText option without text', () => {
    const store = open();
    expect(refusalOf(() => store.submitAnswer('item-a', answer(1, { optionIds: ['reuse', 'keep'] }), 'owner')).message)
      .toBe('answerType single takes one option; 2 were selected');
    expect(refusalOf(() => store.submitAnswer('item-a', answer(1, { optionIds: ['trial'] }), 'owner')).message)
      .toBe('option "Trial for 7 days" needs text');
    expect(store.submitAnswer('item-a', answer(1, { optionIds: ['trial'], text: 'Only on lane A' }), 'owner').answer.text).toBe('Only on lane A');
  });

  it('accepts "Other" text with no option on any type', () => {
    expect(open().submitAnswer('item-a', answer(1, { optionIds: [], text: 'Neither: ask the lock owner.' }), 'owner').answer.optionIds).toEqual([]);
  });
});

describe('min-version on opened and updated (ADR-0037 §2, AC 3)', () => {
  const v1Question = { kind: 'question', title: 'Pick', context: 'Two options.', storyIds: [],
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], recommendation: null, blockingScope: 'story', canContinue: true };
  const openV1 = (store: MissionControlStore, minVersion: 1 | 2) =>
    apply(store, [{ ...envelope('e-open-v1', 0), type: 'attention.opened', payload: { itemId: 'item-v1', ...v1Question, humanReview: review } }], minVersion);
  const updateV1 = (store: MissionControlStore, itemId: string, minVersion: 1 | 2) =>
    apply(store, [{ ...envelope(`e-update-${itemId}`, 1), type: 'attention.updated', payload: { itemId, ...v1Question, context: 'Changed.', humanReview: review } }], minVersion);

  it('opened: a v1 question is accepted at 1 and refused at 2', () => {
    expect(openV1(open(), 1).events).toHaveLength(1);
    expect(refusalOf(() => openV1(open(), 2))).toMatchObject({ status: 400, code: 'question-invalid' });
  });

  it('updated: a v1 item stays v1 at 1 and at 2, with its lint', () => {
    for (const minVersion of [1, 2] as const) {
      const store = open();
      openV1(store, 1);
      expect(updateV1(store, 'item-v1', minVersion).events[0].revision).toBe(2);
      expect(store.snapshot().items.find((candidate) => candidate.id === 'item-v1')?.lint[0]?.field).toBe('formatVersion');
    }
  });

  it('updated: a format-2 item is not turned back into v1 at 2, and nothing is written', () => {
    const store = open();
    const refusal = refusalOf(() => updateV1(store, 'item-a', 2));
    expect(refusal).toMatchObject({ status: 400, code: 'question-invalid' });
    expect(refusal.detail?.defects?.[0]).toMatchObject({ eventId: 'e-update-item-a', itemId: 'item-a', field: 'formatVersion' });
    expect(store.snapshot().items[0]).toMatchObject({ revision: 1, formatVersion: 2 });
    expect(updateV1(open(), 'item-a', 1).events[0].revision).toBe(2);
  });
});
