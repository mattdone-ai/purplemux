import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { isMissionControlError, type MissionControlError } from '@/lib/mission-control-errors';
import { MissionControlStore } from '@/lib/mission-control-store';
import { FOLLOW_UP_EVENT_PREFIX, parseMissionEventBatch, parseMissionEvents } from '@/lib/mission-control-validation';
import type { IMissionAnswerRequest, IMissionBinding, TMissionProducerEvent } from '@/types/mission-control';

// ADR-0037 amendment D2: `attention.opened` with `followsUp` links the new item to an answered item and resolves that
// item in the same transaction; every refusal writes nothing.

const scratch: string[] = [];
const binding: IMissionBinding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', generation: 1, runtimeGeneration: 'launch-1' };
const identity = { tabId: binding.tabId, providerId: binding.providerId, sessionId: binding.sessionId, runtimeGeneration: binding.runtimeGeneration };
const authority = { resolvedIdentity: identity, configuredOrchestratorTabId: binding.tabId };
const review = { humanNeed: 'decision', humanReason: 'Only the owner decides.', handling: 'Checked the epic documents.', reviewerTabId: binding.tabId };

const question = (title: string) => ({
  formatVersion: 2,
  kind: 'question',
  title,
  decision: `${title}: which path?`,
  whyNow: 'The lane waits on it.',
  answerType: 'single',
  options: [{ id: 'reuse', label: 'Reuse the gate', recommended: true }, { id: 'keep', label: 'Keep re-gating' }],
  recommendationWhy: 'The gate already ran on the same tree.',
  context: 'Context.',
  storyIds: [],
  blockingScope: 'story',
  canContinue: true,
});

let producerAt = 1_700_000_000_000;
const envelope = (eventId: string, expectedRevision: number, workspaceId = 'ws-a', runId = 'run-a') => ({
  eventId, schemaVersion: 1 as const, workspaceId, runId, expectedRevision, producerAt: producerAt++, bindingGeneration: 1,
});

const apply = (store: MissionControlStore, raw: unknown[]) => {
  const events = parseMissionEvents(raw);
  return store.applyEvents(events, new Map(events.map((event) => [event.eventId, authority])));
};

const start = (store: MissionControlStore, runId: string, workspaceId: string): void => {
  const event: TMissionProducerEvent = { ...envelope(`e-start-${runId}`, 0, workspaceId, runId), bindingGeneration: 0, type: 'run.started',
    payload: { objective: 'Ship', tabId: binding.tabId } };
  store.applyEvents([event], new Map([[event.eventId, identity]]));
};

const openEvent = (itemId: string, over: Record<string, unknown> = {}, env: { workspaceId?: string; runId?: string } = {}) => ({
  ...envelope(`e-open-${itemId}`, 0, env.workspaceId, env.runId), type: 'attention.opened',
  payload: { itemId, ...question(`Question ${itemId}`), humanReview: review, ...over },
});

const ask = (store: MissionControlStore, itemId: string, over: Record<string, unknown> = {}, env: { workspaceId?: string; runId?: string } = {}) =>
  apply(store, [openEvent(itemId, over, env)]);

const answerOf = (expectedRevision: number, over: Partial<IMissionAnswerRequest> = {}): IMissionAnswerRequest => ({
  submissionId: `s-${expectedRevision}-${Math.random()}`, expectedRevision, optionIds: ['keep'], text: 'Keep it for now.', actionCompleted: false, ...over,
});

const answer = (store: MissionControlStore, itemId: string, over: Partial<IMissionAnswerRequest> = {}) => {
  const item = store.snapshot().items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`no item ${itemId}`);
  return store.submitAnswer(itemId, answerOf(item.revision, over), 'owner');
};

const fileOf = (store: MissionControlStore): Database.Database => (store as unknown as { database: Database.Database }).database;

const open = (): { store: MissionControlStore; file: string } => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-follow-up-'));
  scratch.push(directory);
  const file = path.join(directory, 'mission.sqlite');
  const store = new MissionControlStore(file);
  start(store, 'run-a', 'ws-a');
  return { store, file };
};

/** An answered target A, ready to be followed up. */
const answered = () => {
  const { store, file } = open();
  ask(store, 'item-a');
  const recorded = answer(store, 'item-a');
  return { store, file, answerId: recorded.answer.id, deliveryId: recorded.delivery.id };
};

const refusalOf = (work: () => unknown): MissionControlError => {
  try {
    work();
  } catch (error) {
    if (isMissionControlError(error)) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** Every table a follow-up writes, counted, with the target's row: a refusal must leave all of it as it was. */
const footprint = (store: MissionControlStore, targetId = 'item-a') => {
  const database = fileOf(store);
  const count = (table: string) => (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return {
    items: count('attention_items'),
    links: count('mission_item_links'),
    events: count('events'),
    openers: count('mission_item_openers'),
    target: database.prepare('SELECT state, revision, resolution, updated_at FROM attention_items WHERE id = ?').get(targetId),
    deliveries: database.prepare('SELECT id, state, updated_at FROM deliveries ORDER BY id').all(),
  };
};

const item = (store: MissionControlStore, itemId: string) => {
  const found = store.snapshot().items.find((candidate) => candidate.id === itemId);
  if (!found) throw new Error(`no item ${itemId}`);
  return found;
};

afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('a follow-up of an answered item (rule 3)', () => {
  it('opens the new item, writes the link, acknowledges the delivery and resolves the target with one system event', () => {
    const { store, answerId } = answered();
    const result = ask(store, 'item-b', { followsUp: 'item-a' });
    expect(item(store, 'item-b')).toMatchObject({ state: 'open', revision: 1 });
    expect(item(store, 'item-a')).toMatchObject({ state: 'resolved', resolution: 'Followed up by item-b.' });
    const database = fileOf(store);
    expect(database.prepare('SELECT item_id, follows_up_item_id, workspace_id FROM mission_item_links').all())
      .toEqual([{ item_id: 'item-b', follows_up_item_id: 'item-a', workspace_id: 'ws-a' }]);
    expect(database.prepare('SELECT state, acknowledged_at IS NOT NULL AS acked FROM deliveries WHERE answer_id = ?').get(answerId))
      .toEqual({ state: 'acknowledged', acked: 1 });
    const system = database.prepare("SELECT id, entity_id, type, payload_json FROM events WHERE id LIKE 'system:follow-up:%'").all() as Array<{
      id: string; entity_id: string; type: string; payload_json: string;
    }>;
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ id: `${FOLLOW_UP_EVENT_PREFIX}item-b`, entity_id: 'item-a', type: 'attention.resolved' });
    expect(JSON.parse(system[0].payload_json)).toMatchObject({ itemId: 'item-a', resolution: 'Followed up by item-b.', followedBy: 'item-b' });
    expect(result.followedUp).toEqual({
      itemId: 'item-a', answerId, optionIds: ['keep'], optionLabels: ['Keep re-gating'], text: 'Keep it for now.', resolved: true,
    });
    expect(result.followedUps).toBeUndefined();
  });

  it('keeps followsUp out of question_json and in the stored event payload', () => {
    const { store } = answered();
    ask(store, 'item-b', { followsUp: 'item-a' });
    const database = fileOf(store);
    const stored = JSON.parse((database.prepare("SELECT question_json FROM attention_items WHERE id = 'item-b'").get() as { question_json: string }).question_json);
    expect(stored).not.toHaveProperty('followsUp');
    const opened = JSON.parse((database.prepare("SELECT payload_json FROM events WHERE id = 'e-open-item-b'").get() as { payload_json: string }).payload_json);
    expect(opened.followsUp).toBe('item-a');
  });

  it('a fault after the link write leaves nothing written', () => {
    const { store } = answered();
    const before = footprint(store);
    fileOf(store).exec(`CREATE TRIGGER fault_after_link BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT, 'injected fault'); END;`);
    const refusal = refusalOf(() => ask(store, 'item-b', { followsUp: 'item-a' }));
    expect(refusal).toMatchObject({ status: 503, code: 'storage-unavailable' });
    fileOf(store).exec('DROP TRIGGER fault_after_link');
    expect(footprint(store)).toEqual(before);
  });

  it('a queued delivery of a target that a follow-up resolved is never claimed, and the 200 body carries the answer', () => {
    const { store, deliveryId } = answered();
    const queued = store.snapshot().deliveries.find((delivery) => delivery.id === deliveryId);
    if (!queued) throw new Error('no delivery');
    expect(queued.state).toBe('queued');
    const result = ask(store, 'item-b', { followsUp: 'item-a' });
    expect(result.followedUp?.text).toBe('Keep it for now.');
    const after = store.snapshot().deliveries.find((delivery) => delivery.id === deliveryId);
    expect(store.claimDelivery(deliveryId, queued.updatedAt)).toBeNull();
    expect(store.claimDelivery(deliveryId, after?.updatedAt ?? 0)).toBeNull();
    expect(store.listDueDeliveries(Date.now() + 60_000, 10)).toEqual([]);
  });

  it('a text-only answer still sets answered and is delivered; its follow-up reads "text only"', () => {
    const { store } = open();
    ask(store, 'item-a');
    const recorded = answer(store, 'item-a', { optionIds: [], text: 'Neither: ask the lock owner.' });
    expect(recorded.item.state).toBe('answered');
    expect(store.claimDelivery(recorded.delivery.id, recorded.delivery.updatedAt)).toMatchObject({ state: 'dispatching' });
    const result = ask(store, 'item-b', { followsUp: 'item-a' });
    expect(result.followedUp).toMatchObject({ optionIds: [], optionLabels: [], text: 'Neither: ask the lock owner.', resolved: true });
  });

  it('a target that the ADR-0031 rule answered is followed up as every answered item is', () => {
    const { store } = open();
    ask(store, 'item-a', { class: 'bookkeeping', defaultOptionId: 'reuse' });
    const target = item(store, 'item-a');
    store.submitSystemAnswer('item-a', target.revision, { minutes: 1, version: 1 }, target.updatedAt + 3_600_000);
    expect(item(store, 'item-a').state).toBe('answered');
    expect(ask(store, 'item-b', { followsUp: 'item-a' }).followedUp).toMatchObject({ itemId: 'item-a', optionIds: ['reuse'], resolved: true });
    expect(item(store, 'item-a').state).toBe('resolved');
  });
});

describe('an option id the frozen question lacks never reaches a face (review r1 finding 4)', () => {
  it('reads as "an option no longer in the question" in followedUp and in the served followsUp', () => {
    const { store } = answered();
    // Corrupt data: the answered question no longer holds the selected option 'keep'.
    const database = fileOf(store);
    const row = database.prepare("SELECT question_json FROM attention_items WHERE id = 'item-a'").get() as { question_json: string };
    const stored = JSON.parse(row.question_json) as { options: Array<{ id: string }> };
    stored.options = stored.options.filter((option) => option.id !== 'keep');
    database.prepare("UPDATE attention_items SET question_json = ? WHERE id = 'item-a'").run(JSON.stringify(stored));
    const result = ask(store, 'item-b', { followsUp: 'item-a' });
    expect(result.followedUp).toMatchObject({ optionIds: ['keep'], optionLabels: ['an option no longer in the question'] });
    expect(item(store, 'item-b').followsUp?.answer?.optionLabels).toEqual(['an option no longer in the question']);
  });
});

describe('the served item (rule 5)', () => {
  it('serves followsUp with the earlier answer and followedBy with the new item, and null on an item with no link', () => {
    const { store } = answered();
    ask(store, 'item-b', { followsUp: 'item-a' });
    ask(store, 'item-c');
    const snapshot = store.snapshot();
    const byId = new Map(snapshot.items.map((entry) => [entry.id, entry]));
    expect(byId.get('item-b')?.followsUp).toEqual({
      itemId: 'item-a', title: 'Question item-a',
      answer: { optionIds: ['keep'], optionLabels: ['Keep re-gating'], text: 'Keep it for now.', at: expect.any(Number) },
    });
    expect(byId.get('item-b')?.followedBy).toBeNull();
    expect(byId.get('item-a')?.followedBy).toEqual({ itemId: 'item-b', title: 'Question item-b', state: 'open' });
    expect(byId.get('item-a')?.followsUp).toBeNull();
    expect(byId.get('item-c')).toMatchObject({ followsUp: null, followedBy: null });
    // The per-workspace snapshot serves the same links.
    expect(store.snapshot([], 'ws-a').items.find((entry) => entry.id === 'item-b')?.followsUp?.itemId).toBe('item-a');
  });

  it('the single-item read (an answer response) carries the links too', () => {
    const { store } = answered();
    ask(store, 'item-b', { followsUp: 'item-a' });
    expect(answer(store, 'item-b').item.followsUp).toMatchObject({ itemId: 'item-a' });
  });
});

describe('the follow-up-* fixtures are served items (the phone reads them)', () => {
  const fixture = (name: string) => JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/mc-question-v2', name), 'utf8')) as Record<string, unknown>;
  const keysOf = (value: unknown): string[] => (value && typeof value === 'object' ? Object.keys(value).sort() : []);

  it('carry exactly the keys the store serves, the link objects included', () => {
    const { store } = answered();
    ask(store, 'item-b', { followsUp: 'item-a' });
    const served = store.snapshot();
    const later = served.items.find((entry) => entry.id === 'item-b');
    const earlier = served.items.find((entry) => entry.id === 'item-a');
    const newFixture = fixture('follow-up-new.json');
    const earlierFixture = fixture('follow-up-earlier.json');
    expect(keysOf(newFixture)).toEqual(keysOf(later));
    expect(keysOf(earlierFixture)).toEqual(keysOf(earlier));
    expect(keysOf(newFixture.followsUp)).toEqual(keysOf(later?.followsUp));
    expect(keysOf((newFixture.followsUp as { answer: unknown }).answer)).toEqual(keysOf(later?.followsUp?.answer));
    expect(keysOf(earlierFixture.followedBy)).toEqual(keysOf(earlier?.followedBy));
  });
});

describe('edge cases: each refusal writes nothing', () => {
  const refuses = (setup: (store: MissionControlStore) => void, over: Record<string, unknown>, expected: Record<string, unknown>,
    target = 'item-a', env: { workspaceId?: string; runId?: string } = {}) => {
    const { store } = open();
    setup(store);
    const before = footprint(store, target);
    const refusal = refusalOf(() => ask(store, 'item-b', { followsUp: target, ...over }, env));
    expect(refusal).toMatchObject(expected);
    expect(footprint(store, target)).toEqual(before);
    return refusal;
  };

  it('an open target gets 409 not-answered and the advice to revise it', () => {
    const refusal = refuses((store) => ask(store, 'item-a'), {}, { status: 409, code: 'conflict', detail: { followsUp: { reason: 'not-answered' } } });
    expect(refusal.message).toContain('attention.updated');
  });

  it('a candidate target gets 409 not-answered', () => {
    refuses((store) => ask(store, 'item-a', { humanReview: undefined }), {}, { status: 409, detail: { followsUp: { reason: 'not-answered' } } });
  });

  it('a cancelled target gets 409 not-answered', () => {
    refuses((store) => {
      ask(store, 'item-a');
      apply(store, [{ ...envelope('e-cancel-a', 1), type: 'attention.cancelled', payload: { itemId: 'item-a', reason: 'Done elsewhere.' } }]);
    }, {}, { status: 409, detail: { followsUp: { reason: 'not-answered' } } });
  });

  it('a target in another workspace gets 403 forbidden that names neither the workspace nor the state', () => {
    const refusal = refuses((store) => {
      start(store, 'run-b', 'ws-secret');
      ask(store, 'item-a', {}, { workspaceId: 'ws-secret', runId: 'run-b' });
      answer(store, 'item-a');
    }, {}, { status: 403, code: 'forbidden' });
    expect(refusal.message).not.toContain('ws-secret');
    expect(refusal.message).not.toMatch(/answered|open|resolved|cancelled|candidate/);
    expect(refusal.detail).toBeUndefined();
  });

  it('a target on another run of the same workspace gets 409 other-run', () => {
    refuses((store) => {
      start(store, 'run-a2', 'ws-a');
      ask(store, 'item-a', {}, { runId: 'run-a2' });
      answer(store, 'item-a');
    }, {}, { status: 409, detail: { followsUp: { reason: 'other-run' } } });
  });

  it('a second follow-up gets 409 already-followed with followedBy and the tip of the chain', () => {
    const refusal = refuses((store) => {
      ask(store, 'item-a');
      answer(store, 'item-a');
      ask(store, 'item-x', { followsUp: 'item-a' });
      answer(store, 'item-x');
      ask(store, 'item-y', { followsUp: 'item-x' });
    }, {}, { status: 409, detail: { followsUp: { reason: 'already-followed', followedBy: 'item-x', tip: 'item-y' } } });
    expect(refusal.message).toContain('item-y');
  });

  it('a self-link gets 400 from the event check and from the store', () => {
    const { store } = answered();
    const before = footprint(store);
    expect(refusalOf(() => ask(store, 'item-b', { followsUp: 'item-b' }))).toMatchObject({ status: 400, code: 'invalid-request' });
    const [event] = parseMissionEvents([openEvent('item-b')]);
    const selfLinked = { ...event, payload: { ...event.payload, followsUp: 'item-b' } } as TMissionProducerEvent;
    expect(refusalOf(() => store.applyEvents([selfLinked], new Map([[selfLinked.eventId, authority]]))))
      .toMatchObject({ status: 400, code: 'invalid-request' });
    expect(footprint(store)).toEqual(before);
  });

  it('an unknown target gets 404 not-found', () => {
    refuses(() => undefined, {}, { status: 404, code: 'not-found' }, 'item-missing');
  });

  it('a follow-up with no human review, or with humanNeed none, gets 400', () => {
    const setup = (store: MissionControlStore) => { ask(store, 'item-a'); answer(store, 'item-a'); };
    refuses(setup, { humanReview: undefined }, { status: 400, code: 'invalid-request' });
    refuses(setup, { humanReview: { humanNeed: 'none', handling: 'The workspace handles it.', reviewerTabId: binding.tabId } },
      { status: 400, code: 'invalid-request' });
  });

  it('two follow-ups of one target in one batch refuse the whole batch', () => {
    const { store } = answered();
    const before = footprint(store);
    const refusal = refusalOf(() => apply(store, [openEvent('item-b', { followsUp: 'item-a' }), openEvent('item-c', { followsUp: 'item-a' })]));
    expect(refusal).toMatchObject({ status: 409, detail: { followsUp: { reason: 'already-followed', followedBy: 'item-b' } } });
    expect(footprint(store)).toEqual(before);
  });

  it('follow-ups of two targets in one batch carry followedUps, not followedUp', () => {
    const { store } = answered();
    ask(store, 'item-z');
    answer(store, 'item-z');
    const result = apply(store, [openEvent('item-b', { followsUp: 'item-a' }), openEvent('item-c', { followsUp: 'item-z' })]);
    expect(result.followedUp).toBeUndefined();
    expect(result.followedUps?.map((entry) => entry.itemId)).toEqual(['item-a', 'item-z']);
  });

  it('a replay of the same event writes one link and returns the same answer', () => {
    const { store } = answered();
    const event = openEvent('item-b', { followsUp: 'item-a' });
    const first = apply(store, [event]);
    const replay = apply(store, [event]);
    expect(replay.replayed).toBe(true);
    expect(replay.followedUp).toEqual(first.followedUp);
    expect((fileOf(store).prepare('SELECT COUNT(*) AS n FROM mission_item_links').get() as { n: number }).n).toBe(1);
    expect((fileOf(store).prepare("SELECT COUNT(*) AS n FROM events WHERE id LIKE 'system:follow-up:%'").get() as { n: number }).n).toBe(1);
  });

  it('attention.updated with followsUp gets 400 invalid-request: a link never changes', () => {
    const { store } = answered();
    ask(store, 'item-b');
    const update = { ...envelope('e-update-b', 1), type: 'attention.updated', payload: { itemId: 'item-b', ...question('Question item-b'), humanReview: review, followsUp: 'item-a' } };
    expect(refusalOf(() => apply(store, [update]))).toMatchObject({
      status: 400, code: 'invalid-request', message: 'followsUp is set when an item opens; a link never changes',
    });
  });

  it('no request may take a system:follow-up: event id', () => {
    expect(refusalOf(() => parseMissionEventBatch([{ ...openEvent('item-b'), eventId: `${FOLLOW_UP_EVENT_PREFIX}item-b` }])))
      .toMatchObject({ status: 400, code: 'invalid-request', message: 'event ID uses a reserved namespace' });
  });
});

describe('a target already resolved', () => {
  it('with no follower, gets the link only: its state, resolution and delivery do not change', () => {
    const { store, answerId } = answered();
    const target = item(store, 'item-a');
    apply(store, [{ ...envelope('e-ack-a', target.revision), type: 'answer.acknowledged', payload: { answerId } }]);
    apply(store, [{ ...envelope('e-resolve-a', target.revision), type: 'attention.resolved', payload: { itemId: 'item-a', resolution: 'Applied.' } }]);
    const before = footprint(store);
    const result = ask(store, 'item-b', { followsUp: 'item-a' });
    expect(result.followedUp).toMatchObject({ itemId: 'item-a', answerId, resolved: false });
    const after = footprint(store);
    expect(after.target).toEqual(before.target);
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.links).toBe(1);
    expect((fileOf(store).prepare("SELECT COUNT(*) AS n FROM events WHERE id LIKE 'system:follow-up:%'").get() as { n: number }).n).toBe(0);
    expect(item(store, 'item-a').followedBy).toMatchObject({ itemId: 'item-b' });
  });
});

describe('the check route view (rule 2)', () => {
  it('followUpRefusal answers the refusal the events route would give, and writes nothing', () => {
    const { store } = open();
    ask(store, 'item-a');
    const before = footprint(store);
    const input = { workspaceId: 'ws-a', runId: 'run-a', itemId: 'item-b', followsUp: 'item-a', humanReview: { humanNeed: 'decision' as const } };
    expect(store.followUpRefusal(input)).toMatchObject({ status: 409, detail: { followsUp: { reason: 'not-answered' } } });
    answer(store, 'item-a');
    const answeredFootprint = footprint(store);
    expect(store.followUpRefusal(input)).toBeNull();
    expect(footprint(store)).toEqual(answeredFootprint);
    expect(before.links).toBe(0);
  });
});

describe('cycles cannot form (property)', () => {
  // A seeded generator: the same sequences on every run.
  const random = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };

  // Run time (measured 2026-11-08, this test alone): about 500 ms for the 40 runs with a file store (1,396 fsync calls)
  // and a full snapshot for each read; under full-suite load it went past the 5 s default timeout. The same 40 seeded
  // sequences now run on an in-memory store (the property is about the link rows, not durability) and read one served
  // item, not the whole snapshot. For each seed, both forms leave the same items, links and events. About 270 ms
  // alone, at most 773 ms beside a full-suite run: the default 5 s timeout holds.

  it('random sequences of opens, follow-ups, answers, resolves and cancels leave chains only', () => {
    for (let run = 0; run < 40; run += 1) {
      const next = random(run + 1);
      const store = new MissionControlStore(':memory:');
      start(store, 'run-a', 'ws-a');
      const read = (itemId: string) => {
        const found = store.attentionItem(itemId);
        if (!found) throw new Error(`no item ${itemId}`);
        return found;
      };
      const ids: string[] = [];
      for (let step = 0; step < 30; step += 1) {
        const roll = next();
        const pick = () => ids[Math.floor(next() * ids.length)];
        try {
          if (roll < 0.45 || !ids.length) {
            const id = `item-${run}-${step}`;
            const followsUp = ids.length && next() < 0.7 ? (next() < 0.1 ? id : pick()) : undefined;
            ask(store, id, followsUp === undefined ? {} : { followsUp });
            ids.push(id);
          } else if (roll < 0.8) {
            const target = read(pick());
            if (target.state === 'open') store.submitAnswer(target.id, answerOf(target.revision), 'owner');
          } else if (roll < 0.9) {
            const target = read(pick());
            apply(store, [{ ...envelope(`e-cancel-${run}-${step}`, target.revision), type: 'attention.cancelled', payload: { itemId: target.id, reason: 'R' } }]);
          } else {
            const target = read(pick());
            if (target.answerId) {
              apply(store, [{ ...envelope(`e-ack-${run}-${step}`, target.revision), type: 'answer.acknowledged', payload: { answerId: target.answerId } }]);
              apply(store, [{ ...envelope(`e-res-${run}-${step}`, target.revision), type: 'attention.resolved', payload: { itemId: target.id, resolution: 'R' } }]);
            }
          }
        } catch (error) {
          if (!isMissionControlError(error)) throw error;
        }
      }
      const links = fileOf(store).prepare('SELECT item_id, follows_up_item_id FROM mission_item_links').all() as Array<{ item_id: string; follows_up_item_id: string }>;
      const predecessors = new Map(links.map((link) => [link.item_id, link.follows_up_item_id]));
      expect(new Set(links.map((link) => link.follows_up_item_id)).size).toBe(links.length);
      expect(predecessors.size).toBe(links.length);
      for (const start of predecessors.keys()) {
        const seen = new Set<string>();
        for (let at: string | undefined = start; at !== undefined; at = predecessors.get(at)) {
          expect(seen.has(at)).toBe(false);
          seen.add(at);
        }
      }
      // Each link points from a newer item to an older one, and its target was answered or resolved.
      for (const link of links) expect(ids.indexOf(link.item_id)).toBeGreaterThan(ids.indexOf(link.follows_up_item_id));
      store.close();
    }
  });
});

describe('rollback (ADR-0037 amendment D2, test 5)', () => {
  it('keeps user_version at 4, so a release before the amendment opens the file and reads the target as resolved', () => {
    const { store, file } = answered();
    ask(store, 'item-b', { followsUp: 'item-a' });
    store.close();
    // The older release's open path: its version gate (`current > SCHEMA_VERSION` refuses), its own side tables, its
    // item read. It never names mission_item_links, and the link table has no constraint that an older writer can trip.
    const older = new Database(file);
    expect(older.pragma('user_version', { simple: true })).toBe(4);
    older.exec(`CREATE TABLE IF NOT EXISTS mission_item_changes (item_id TEXT NOT NULL, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL,
      changes_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (item_id, revision))`);
    expect(older.prepare("SELECT state, resolution FROM attention_items WHERE id = 'item-a'").get())
      .toEqual({ state: 'resolved', resolution: 'Followed up by item-b.' });
    expect(older.prepare("SELECT sql FROM sqlite_master WHERE name = 'mission_item_links'").pluck().get()).not.toMatch(/REFERENCES|TRIGGER/i);
    older.prepare("UPDATE attention_items SET state = 'cancelled', resolution = 'older writer' WHERE id = 'item-b'").run();
    older.close();
    // Forward again: this release reopens the file the older one wrote and still serves the link.
    const reopened = new MissionControlStore(file);
    expect(reopened.snapshot().items.find((entry) => entry.id === 'item-a')?.followedBy).toEqual({ itemId: 'item-b', title: 'Question item-b', state: 'cancelled' });
    reopened.close();
  });

  it('a file written without the link table gains it on open, and its items read with no links', () => {
    const { store, file } = answered();
    store.close();
    const raw = new Database(file);
    raw.exec('DROP TABLE mission_item_links');
    raw.close();
    const reopened = new MissionControlStore(file);
    expect(reopened.snapshot().items[0]).toMatchObject({ followsUp: null, followedBy: null });
    reopened.close();
  });
});
