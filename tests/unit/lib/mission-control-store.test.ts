import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionControlError } from '@/lib/mission-control-errors';
import { MissionControlStore, type IMissionDiscoveryInput } from '@/lib/mission-control-store';
import type { IMissionBinding, IMissionQuestion, TMissionProducerEvent } from '@/types/mission-control';

const scratch: string[] = [];
const binding: IMissionBinding = {
  tabId: 'tab-orchestrator',
  providerId: 'codex',
  sessionId: 'session-current',
  generation: 1,
  runtimeGeneration: 'launch-1',
};
const identity = { ...binding, generation: undefined };
delete identity.generation;
const observedIdentity = (name: string) => ({
  tabId: `tab-${name}`,
  providerId: 'codex',
  sessionId: `session-${name}`,
  runtimeGeneration: `launch-${name}`,
});

const question: IMissionQuestion = {
  kind: 'question',
  title: 'Choose a rollout',
  context: 'The migration needs one rollout strategy.',
  storyIds: ['MC-1'],
  options: [
    { id: 'gradual', label: 'Gradual' },
    { id: 'direct', label: 'Direct' },
  ],
  recommendation: 'gradual',
  blockingScope: 'story',
  canContinue: true,
};
const humanReview = {
  humanNeed: 'decision' as const,
  humanReason: 'Only the human can choose the rollout strategy.',
  handling: 'The orchestrator checked the delivery constraints and delegated analysis.',
  reviewerTabId: binding.tabId,
};
const reviewAuthority = {
  resolvedIdentity: identity,
  configuredOrchestratorTabId: binding.tabId,
};
const humanReviewFor = (humanNeed: 'decision' | 'approval' | 'information' | 'external-action' | 'none') => humanNeed === 'none'
  ? {
      humanNeed,
      handling: 'The orchestrator will handle this with existing workspace authority.',
      reviewerTabId: binding.tabId,
    }
  : {
      humanNeed,
      humanReason: `Only the human can provide the required ${humanNeed}.`,
      handling: 'The orchestrator checked existing instructions, authority, evidence, and delegated handling.',
      reviewerTabId: binding.tabId,
    };

const databasePath = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-mission-'));
  scratch.push(directory);
  return path.join(directory, 'mission.sqlite');
};

const startEvent = (eventId = 'event-start'): TMissionProducerEvent => ({
  eventId,
  schemaVersion: 1,
  workspaceId: 'ws-a',
  runId: 'run-a',
  expectedRevision: 0,
  producerAt: 1_700_000_000_000,
  bindingGeneration: 0,
  type: 'run.started',
  payload: { objective: 'Deliver Mission Control', tabId: binding.tabId },
});

const openEvent = (eventId = 'event-open'): Extract<TMissionProducerEvent, { type: 'attention.opened' }> => ({
  eventId,
  schemaVersion: 1,
  workspaceId: 'ws-a',
  runId: 'run-a',
  expectedRevision: 0,
  producerAt: 1_700_000_000_100,
  bindingGeneration: 1,
  type: 'attention.opened',
  payload: { itemId: 'item-a', ...question, humanReview },
});

const seed = (store: MissionControlStore): void => {
  const start = startEvent();
  store.applyEvents([start], new Map([[start.eventId, identity]]));
  const opened = openEvent();
  store.applyEvents([opened], new Map([[opened.eventId, reviewAuthority]]));
};

const seedRun = (store: MissionControlStore): void => {
  const start = startEvent();
  store.applyEvents([start], new Map([[start.eventId, identity]]));
};

const downgradeToSchema3 = (file: string): void => {
  const database = new Database(file);
  database.exec('ALTER TABLE attention_items DROP COLUMN human_review_json');
  database.exec('ALTER TABLE attention_items DROP COLUMN candidate_reason');
  database.pragma('user_version = 3');
  database.close();
};

const discoveryInput = (
  bootstrapId: string,
  sourceKey = `${bootstrapId}/run`,
  workspaceId = 'ws-a',
): IMissionDiscoveryInput => ({
  bootstrapId,
  reconcile: true,
  boundarySeq: 0,
  observedAt: 1_700_000_000_000,
  workspaces: [{
    workspaceId,
    name: workspaceId,
    activity: 'active',
    agents: [],
    lastActivityAt: 1_700_000_000_000,
    lastProgressAt: 1_700_000_000_000,
    stale: false,
    identities: [identity],
    evidence: { source: 'harness', sourceId: `${sourceKey}/workspace`, observedAt: 1_700_000_000_000, confidence: 'confirmed' },
    run: {
      sourceKey,
      objective: `Objective for ${workspaceId}`,
      phase: 'implementation',
      state: 'running',
      nextStep: 'Continue',
      lastProgressAt: 1_700_000_000_000,
      evidence: { source: 'bootstrap', sourceId: `${sourceKey}/evidence`, observedAt: 1_700_000_000_000, confidence: 'provisional' },
    },
    candidates: [],
    reconciliation: { sourceKey: `${sourceKey}/reconcile`, binding },
  }],
});

afterEach(() => {
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('MissionControlStore', () => {
  it('routes ordinary attention to a durable workspace candidate with audited event routing', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const event: TMissionProducerEvent = {
      ...openEvent('event-workspace-issue'),
      payload: { itemId: 'item-a', ...question },
    };
    const result = store.applyEvents([event]);
    expect(store.snapshot().items[0]).toMatchObject({
      id: 'item-a', state: 'candidate', revision: 1,
      candidateReason: 'workspace-issue', humanReview: null,
    });
    expect(store.snapshot().workspaces[0].openItems).toBe(0);
    expect(result.events[0].payload).toMatchObject({
      routing: { state: 'candidate', candidateReason: 'workspace-issue', review: null },
    });
    expect(store.applyEvents([event])).toMatchObject({ replayed: true, events: [{ id: event.eventId }] });
    expect(() => store.applyEvents([{
      ...event, payload: { ...event.payload, title: 'Changed under the same event ID' },
    }])).toThrowError(/different content/);
    expect(() => store.submitAnswer('item-a', {
      submissionId: 'candidate-answer', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user')).toThrowError(/no longer open/);
    store.close();
  });

  it.each(['decision', 'approval', 'information', 'external-action'] as const)(
    'opens attention only after a valid %s review and exposes the reason',
    (humanNeed) => {
      const store = new MissionControlStore(databasePath());
      seedRun(store);
      const event: TMissionProducerEvent = {
        ...openEvent(`event-human-${humanNeed}`),
        payload: { itemId: `item-${humanNeed}`, ...question, humanReview: humanReviewFor(humanNeed) },
      };
      const result = store.applyEvents([event], new Map([[event.eventId, reviewAuthority]]));
      expect(store.snapshot().items[0]).toMatchObject({
        state: 'open', candidateReason: null,
        humanReview: {
          humanNeed,
          humanReason: `Only the human can provide the required ${humanNeed}.`,
          reviewerTabId: binding.tabId,
          binding,
          eventId: event.eventId,
        },
      });
      expect(store.snapshot().workspaces[0].openItems).toBe(1);
      expect(result.events[0].payload).toMatchObject({
        humanReview: { humanNeed },
        routing: { state: 'open', candidateReason: null, review: { binding, eventId: event.eventId } },
      });
      store.close();
    },
  );

  it('keeps candidates non-actionable until review and requires renewed review for changed open content', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const ordinary: TMissionProducerEvent = {
      ...openEvent('event-candidate'),
      payload: { itemId: 'item-a', ...question },
    };
    store.applyEvents([ordinary]);
    const unchangedCandidate: TMissionProducerEvent = {
      ...ordinary, eventId: 'event-candidate-unchanged', type: 'attention.updated', expectedRevision: 1,
    };
    store.applyEvents([unchangedCandidate]);
    expect(store.snapshot().items[0]).toMatchObject({ state: 'candidate', revision: 2, humanReview: null });

    const promote: TMissionProducerEvent = {
      ...ordinary, eventId: 'event-promote', type: 'attention.updated', expectedRevision: 2,
      payload: { ...ordinary.payload, humanReview: humanReviewFor('approval') },
    };
    store.applyEvents([promote], new Map([[promote.eventId, reviewAuthority]]));
    const promoted = store.snapshot().items[0];
    expect(promoted).toMatchObject({ state: 'open', revision: 3, candidateReason: null, humanReview: { humanNeed: 'approval' } });

    const changedWithoutReview: TMissionProducerEvent = {
      ...ordinary, eventId: 'event-change-without-review', type: 'attention.updated', expectedRevision: 3,
      payload: { itemId: 'item-a', ...question, title: 'A different human question' },
    };
    expect(() => store.applyEvents([changedWithoutReview])).toThrowError(/renewed orchestrator review/);
    expect(store.snapshot().items[0]).toEqual(promoted);

    const unchangedOpen: TMissionProducerEvent = {
      ...ordinary, eventId: 'event-open-unchanged', type: 'attention.updated', expectedRevision: 3,
    };
    store.applyEvents([unchangedOpen]);
    expect(store.snapshot().items[0]).toMatchObject({ state: 'open', revision: 4, humanReview: { eventId: promote.eventId } });

    const disposition: TMissionProducerEvent = {
      ...ordinary, eventId: 'event-workspace-disposition', type: 'attention.updated', expectedRevision: 4,
      payload: { ...ordinary.payload, humanReview: humanReviewFor('none') },
    };
    store.applyEvents([disposition], new Map([[disposition.eventId, reviewAuthority]]));
    expect(store.snapshot().items[0]).toMatchObject({
      state: 'candidate', revision: 5, candidateReason: 'workspace-issue', humanReview: { humanNeed: 'none' }, answerId: null,
    });
    store.close();
  });

  it.each([
    ['wrong configured tab', { ...reviewAuthority, configuredOrchestratorTabId: 'tab-worker' }, /configured orchestrator/],
    ['stale session', { ...reviewAuthority, resolvedIdentity: { ...identity, sessionId: 'session-stale' } }, /current orchestrator session/],
    ['stale runtime', { ...reviewAuthority, resolvedIdentity: { ...identity, runtimeGeneration: 'launch-stale' } }, /current orchestrator session/],
    ['missing live identity', { ...reviewAuthority, resolvedIdentity: null }, /current orchestrator session/],
  ] as const)('rejects %s review authority without mutation', (_case, authority, message) => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const event = openEvent(`event-authority-${_case}`);
    expect(() => store.applyEvents([event], new Map([[event.eventId, authority]]))).toThrowError(message);
    expect(store.snapshot().items).toEqual([]);
    store.close();
  });

  it('rejects review when the run is bound to a worker instead of the configured orchestrator', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const workerIdentity = observedIdentity('worker');
    const event: Extract<TMissionProducerEvent, { type: 'attention.opened' }> = {
      ...openEvent('event-worker-review'),
      payload: {
        itemId: 'item-a', ...question,
        humanReview: { ...humanReviewFor('decision'), reviewerTabId: workerIdentity.tabId },
      },
    };
    expect(() => store.applyEvents([event], new Map([[event.eventId, {
      resolvedIdentity: workerIdentity,
      configuredOrchestratorTabId: workerIdentity.tabId,
    }]]))).toThrowError(/run bound to the configured orchestrator/);
    expect(store.snapshot().items).toEqual([]);
    store.close();
  });

  it('rejects review against an unbound provisional run', () => {
    const store = new MissionControlStore(databasePath());
    store.reconcileDiscovery(discoveryInput('bootstrap-unbound-review'));
    const provisional = store.snapshot().runs[0];
    const event: Extract<TMissionProducerEvent, { type: 'attention.opened' }> = {
      ...openEvent('event-unbound-review'),
      runId: provisional.id,
      bindingGeneration: 0,
    };
    expect(() => store.applyEvents([event], new Map([[event.eventId, reviewAuthority]])))
      .toThrowError(/unbound/);
    expect(store.snapshot().items).toEqual([]);
    store.close();
  });

  it('lists a workspace\'s open items, id and title, for the board (ADR-0034)', () => {
    const store = new MissionControlStore(databasePath());
    expect(store.openItemTitles('ws-a')).toEqual([]);
    seed(store);
    expect(store.openItemTitles('ws-a')).toEqual([{ id: 'item-a', title: 'Choose a rollout', createdAt: expect.any(Number) }]);
    expect(store.openItemTitles('ws-b')).toEqual([]);
    store.close();
  });

  it('lists when each answer to a workspace was recorded, for the pulse (ADR-0034 §9)', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const before = Date.now();
    expect(store.answerTimes('ws-a', 0)).toEqual([]);
    store.submitAnswer('item-a', { submissionId: 'pulse-answer', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false }, 'user');
    const [at] = store.answerTimes('ws-a', 0);
    expect(at).toBeGreaterThanOrEqual(before - 1_000);
    expect(store.answerTimes('ws-a', at + 1)).toEqual([]);
    expect(store.answerTimes('ws-b', 0)).toEqual([]);
    store.close();
  });

  it('persists open attention and replays events after reopen without cursor gaps', () => {
    const file = databasePath();
    const first = new MissionControlStore(file);
    seed(first);
    first.close();

    const reopened = new MissionControlStore(file);
    const snapshot = reopened.snapshot();
    expect(snapshot.items).toMatchObject([{ id: 'item-a', state: 'open', revision: 1 }]);
    expect(snapshot.cursor).toBe(2);
    const page = reopened.eventsAfter(0, 1);
    expect(page.events).toHaveLength(1);
    expect(page.cursor).toBe(page.events[0].seq);
    expect(page.hasMore).toBe(true);
    expect(reopened.eventsAfter(page.cursor, 10).events).toHaveLength(1);
    reopened.close();
  });

  it('migrates schema v2 identity metadata transactionally without losing durable runs', () => {
    const file = databasePath();
    const original = new MissionControlStore(file);
    seed(original);
    original.close();

    const legacy = new Database(file);
    legacy.exec('ALTER TABLE runs DROP COLUMN observed_identities_json');
    legacy.exec('ALTER TABLE attention_items DROP COLUMN human_review_json');
    legacy.exec('ALTER TABLE attention_items DROP COLUMN candidate_reason');
    legacy.pragma('user_version = 2');
    legacy.close();

    const migrated = new MissionControlStore(file);
    expect(migrated.snapshot().runs).toMatchObject([{ id: 'run-a', objective: 'Deliver Mission Control' }]);
    migrated.close();
    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(4);
    expect((inspected.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>).map((column) => column.name))
      .toContain('observed_identities_json');
    expect((inspected.prepare('PRAGMA table_info(attention_items)').all() as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining(['human_review_json', 'candidate_reason']));
    inspected.close();
  });

  it('reclassifies unanswered schema-3 opens exactly once while preserving durable records', () => {
    const file = databasePath();
    const original = new MissionControlStore(file);
    seed(original);
    const before = original.snapshot();
    original.close();
    downgradeToSchema3(file);

    const migrated = new MissionControlStore(file);
    const after = migrated.snapshot();
    expect(after.runs).toEqual(before.runs);
    expect(after.answers).toEqual(before.answers);
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.bootstrap).toEqual(before.bootstrap);
    expect(after.items[0]).toMatchObject({
      id: before.items[0].id,
      title: before.items[0].title,
      context: before.items[0].context,
      state: 'candidate',
      revision: before.items[0].revision + 1,
      candidateReason: 'legacy-review',
      humanReview: null,
      createdAt: before.items[0].createdAt,
    });
    const migrationEvents = after.recentEvents.filter((event) => event.type === 'attention.reclassified');
    expect(migrationEvents).toHaveLength(1);
    expect(migrationEvents[0]).toMatchObject({
      workspaceId: 'ws-a', runId: 'run-a', entityId: 'item-a', revision: 2,
      payload: {
        itemId: 'item-a', fromState: 'open', toState: 'candidate', previousRevision: 1,
        reason: 'legacy-human-review-required', policyVersion: 1, actor: 'system:migration',
      },
    });
    expect(migrationEvents[0].id).toMatch(/^system:migration:v4:[a-f0-9]{64}$/);
    expect(migrated.humanInboxPolicy('ws-a')).toEqual({
      version: 1,
      legacyReviewPending: 1,
      guidance: expect.stringContaining('Do not rerun bootstrap'),
    });
    const originalReplay = migrated.applyEvents([openEvent()], new Map([[openEvent().eventId, reviewAuthority]]));
    expect(originalReplay.replayed).toBe(true);
    expect(migrated.snapshot().items[0]).toMatchObject({ state: 'candidate', revision: 2 });
    migrated.close();

    const reopened = new MissionControlStore(file);
    expect(reopened.snapshot().recentEvents.filter((event) => event.type === 'attention.reclassified')).toHaveLength(1);
    expect(reopened.snapshot().items[0]).toMatchObject({ state: 'candidate', revision: 2, candidateReason: 'legacy-review' });
    const stalePromotion: TMissionProducerEvent = {
      ...openEvent('event-stale-legacy-promotion'), type: 'attention.updated', expectedRevision: 1,
    };
    expect(() => reopened.applyEvents([stalePromotion], new Map([[stalePromotion.eventId, reviewAuthority]])))
      .toThrowError(/stale attention revision/);
    const promotion: TMissionProducerEvent = {
      ...openEvent('event-legacy-promotion'), type: 'attention.updated', expectedRevision: 2,
    };
    reopened.applyEvents([promotion], new Map([[promotion.eventId, reviewAuthority]]));
    expect(reopened.snapshot().items[0]).toMatchObject({
      id: 'item-a', state: 'open', revision: 3, candidateReason: null,
      humanReview: { humanNeed: 'decision', eventId: promotion.eventId },
    });
    expect(reopened.humanInboxPolicy('ws-a')).toEqual({ version: 1, legacyReviewPending: 0 });
    reopened.close();
  });

  it('rolls back every schema-4 migration change when reclassification event persistence fails', () => {
    const file = databasePath();
    const original = new MissionControlStore(file);
    seed(original);
    original.close();
    downgradeToSchema3(file);
    const legacy = new Database(file);
    legacy.exec(`CREATE TRIGGER reject_reclassification BEFORE INSERT ON events
      WHEN NEW.type='attention.reclassified' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    legacy.close();

    expect(() => new MissionControlStore(file)).toThrowError(/injected migration failure/);
    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(3);
    expect((inspected.prepare('PRAGMA table_info(attention_items)').all() as Array<{ name: string }>).map((column) => column.name))
      .not.toEqual(expect.arrayContaining(['human_review_json', 'candidate_reason']));
    expect(inspected.prepare('SELECT state,revision FROM attention_items WHERE id=?').get('item-a'))
      .toEqual({ state: 'open', revision: 1 });
    expect(inspected.prepare("SELECT COUNT(*) AS count FROM events WHERE type='attention.reclassified'").get())
      .toEqual({ count: 0 });
    inspected.close();
  });

  it('aborts migration when an anomalous open item is already linked to an answer', () => {
    const file = databasePath();
    const original = new MissionControlStore(file);
    seed(original);
    original.submitAnswer('item-a', {
      submissionId: 'anomalous-answer', expectedRevision: 1,
      optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    original.close();
    const legacy = new Database(file);
    legacy.prepare("UPDATE attention_items SET state='open' WHERE id='item-a'").run();
    legacy.exec('ALTER TABLE attention_items DROP COLUMN human_review_json');
    legacy.exec('ALTER TABLE attention_items DROP COLUMN candidate_reason');
    legacy.pragma('user_version = 3');
    legacy.close();

    expect(() => new MissionControlStore(file)).toThrowError(/already has an answer/);
    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(3);
    expect(inspected.prepare("SELECT state,answer_id FROM attention_items WHERE id='item-a'").get())
      .toMatchObject({ state: 'open', answer_id: expect.any(String) });
    inspected.close();
  });

  it('preserves an answered item and identical answer replay through schema-4 migration', () => {
    const file = databasePath();
    const original = new MissionControlStore(file);
    seed(original);
    const request = {
      submissionId: 'answer-before-migration', expectedRevision: 1,
      optionIds: ['gradual'], text: '', actionCompleted: false,
    };
    const accepted = original.submitAnswer('item-a', request, 'user');
    original.close();
    downgradeToSchema3(file);

    const migrated = new MissionControlStore(file);
    expect(migrated.snapshot().items[0]).toMatchObject({ state: 'answered', revision: 2, answerId: accepted.answer.id });
    expect(migrated.snapshot().recentEvents.filter((event) => event.type === 'attention.reclassified')).toEqual([]);
    expect(migrated.submitAnswer('item-a', request, 'user')).toMatchObject({ replayed: true, answer: { id: accepted.answer.id } });
    migrated.close();
  });

  // Story 33 R3 (consult ruling B): the source rides in request_json, outside the content hash.
  it('records an answer\'s source; an answer without one reads null; the hash ignores it', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const request = { submissionId: 'submission-src', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false };
    const created = store.submitAnswer('item-a', { ...request, source: 'notification' }, 'user');
    expect(created.answer.source).toBe('notification');
    // A resend that differs only in its source is a replay, and the first source stands.
    const replay = store.submitAnswer('item-a', { ...request, source: 'phone' }, 'user');
    expect(replay).toMatchObject({ replayed: true, answer: { id: created.answer.id, source: 'notification' } });
    expect(store.submitAnswer('item-a', request, 'user').replayed).toBe(true);
    store.close();
  });

  it('keeps every request_hash byte-identical: the same answer hashes the same with or without a source', () => {
    const hashOf = (source?: 'web') => {
      const file = databasePath();
      const store = new MissionControlStore(file);
      seed(store);
      const answered = store.submitAnswer('item-a', {
        submissionId: 'submission-plain', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false, ...(source ? { source } : {}),
      }, 'user');
      store.close();
      const raw = new Database(file, { readonly: true });
      const row = raw.prepare('SELECT request_hash, request_json FROM answers').get() as { request_hash: string; request_json: string };
      raw.close();
      return { hash: row.request_hash, stored: JSON.parse(row.request_json) as Record<string, unknown>, source: answered.answer.source };
    };
    const plain = hashOf();
    const web = hashOf('web');
    expect(web.hash).toBe(plain.hash);
    expect(plain.stored).not.toHaveProperty('source');
    expect(plain.source).toBeNull();
    expect(web.stored.source).toBe('web');
  });

  it('the Measure query counts owner answers by source, a row with none as "not recorded"', () => {
    const file = databasePath();
    const store = new MissionControlStore(file);
    seed(store);
    store.submitAnswer('item-a', { submissionId: 's-1', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false }, 'user');
    store.close();
    const raw = new Database(file, { readonly: true });
    const rows = raw.prepare(`SELECT COALESCE(json_extract(request_json,'$.source'),'not recorded') AS source, COUNT(*) AS n
      FROM answers WHERE actor NOT LIKE 'system:%' GROUP BY 1`).all();
    raw.close();
    expect(rows).toEqual([{ source: 'not recorded', n: 1 }]);
  });

  it('returns original answer results for identical retries and conflicts on changed reuse', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const request = {
      submissionId: 'submission-a',
      expectedRevision: 1,
      optionIds: ['gradual'],
      text: '',
      actionCompleted: false,
    };
    const created = store.submitAnswer('item-a', request, 'user');
    const replay = store.submitAnswer('item-a', request, 'user');
    expect(created.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.answer.id).toBe(created.answer.id);
    expect(replay.delivery.id).toBe(created.delivery.id);
    expect(() => store.submitAnswer('item-a', { ...request, text: 'different' }, 'user'))
      .toThrowError(MissionControlError);
    expect(store.snapshot().answers).toHaveLength(1);
    store.close();
  });

  it('serializes workspace disposition against answer submission without losing a winning answer', () => {
    const demoted = new MissionControlStore(databasePath());
    seed(demoted);
    const disposition: TMissionProducerEvent = {
      ...openEvent('event-demote-before-answer'), type: 'attention.updated', expectedRevision: 1,
      payload: { ...openEvent().payload, humanReview: humanReviewFor('none') },
    };
    demoted.applyEvents([disposition], new Map([[disposition.eventId, reviewAuthority]]));
    const request = {
      submissionId: 'answer-race', expectedRevision: 1,
      optionIds: ['gradual'], text: '', actionCompleted: false,
    };
    expect(() => demoted.submitAnswer('item-a', request, 'user')).toThrowError(/no longer open/);
    expect(demoted.snapshot()).toMatchObject({ answers: [], deliveries: [], items: [{ state: 'candidate', revision: 2 }] });
    demoted.close();

    const answered = new MissionControlStore(databasePath());
    seed(answered);
    const accepted = answered.submitAnswer('item-a', request, 'user');
    const lateDisposition: TMissionProducerEvent = {
      ...disposition, eventId: 'event-demote-after-answer', expectedRevision: 2,
    };
    expect(() => answered.applyEvents([lateDisposition], new Map([[lateDisposition.eventId, reviewAuthority]])))
      .toThrowError(/only open or candidate/);
    expect(answered.submitAnswer('item-a', request, 'user')).toMatchObject({
      replayed: true, answer: { id: accepted.answer.id }, delivery: { id: accepted.delivery.id },
    });
    expect(answered.snapshot().items[0]).toMatchObject({ state: 'answered', revision: 2 });
    answered.close();
  });

  it('rolls back an entire producer batch when a later event conflicts', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const progress: TMissionProducerEvent = {
      eventId: 'event-progress', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_200, bindingGeneration: 1,
      type: 'progress.updated', payload: { phase: 'testing' },
    };
    const stale: TMissionProducerEvent = {
      eventId: 'event-stale', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 99, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'attention.updated', payload: { itemId: 'item-a', ...question, title: 'Changed' },
    };
    expect(() => store.applyEvents([progress, stale])).toThrowError(MissionControlError);
    const snapshot = store.snapshot();
    expect(snapshot.runs[0]).toMatchObject({ revision: 1, phase: null });
    expect(snapshot.recentEvents.map((event) => event.id)).not.toContain('event-progress');
    store.close();
  });

  it('rolls back earlier batch events when a later human review lacks authority', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const progress: TMissionProducerEvent = {
      eventId: 'event-progress-before-review', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_200, bindingGeneration: 1,
      type: 'progress.updated', payload: { phase: 'reviewing' },
    };
    const review = openEvent('event-invalid-review');
    expect(() => store.applyEvents([progress, review], new Map([[review.eventId, {
      ...reviewAuthority, configuredOrchestratorTabId: 'tab-worker',
    }]]))).toThrowError(/configured orchestrator/);
    expect(store.snapshot().runs[0]).toMatchObject({ revision: 1, phase: null });
    expect(store.snapshot().items).toEqual([]);
    expect(store.snapshot().recentEvents.map((event) => event.id)).not.toContain(progress.eventId);
    store.close();
  });

  it('rejects cross-workspace references and stale orchestrator generations', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const crossWorkspace: TMissionProducerEvent = {
      eventId: 'event-cross', schemaVersion: 1, workspaceId: 'ws-b', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_200, bindingGeneration: 1,
      type: 'progress.updated', payload: { phase: 'wrong' },
    };
    const staleGeneration: TMissionProducerEvent = {
      ...crossWorkspace,
      eventId: 'event-old-generation',
      workspaceId: 'ws-a',
      bindingGeneration: 0,
    };
    expect(() => store.applyEvents([crossWorkspace])).toThrowError(/another workspace/);
    expect(() => store.applyEvents([staleGeneration])).toThrowError(/generation/);
    store.close();
  });

  it('does not expose another workspace row through colliding opaque IDs', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const collidingRun = { ...startEvent('event-cross-run'), workspaceId: 'ws-b' };
    try {
      store.applyEvents([collidingRun], new Map([[collidingRun.eventId, identity]]));
      throw new Error('expected run collision');
    } catch (error) {
      expect(error).toBeInstanceOf(MissionControlError);
      expect((error as MissionControlError).current).toBeUndefined();
    }

    const secondStart = { ...startEvent('event-start-b'), workspaceId: 'ws-b', runId: 'run-b' };
    store.applyEvents([secondStart], new Map([[secondStart.eventId, identity]]));
    const collidingItem = { ...openEvent('event-cross-item'), workspaceId: 'ws-b', runId: 'run-b' };
    try {
      store.applyEvents([collidingItem]);
      throw new Error('expected item collision');
    } catch (error) {
      expect(error).toBeInstanceOf(MissionControlError);
      expect((error as MissionControlError).current).toBeUndefined();
    }
    store.close();
  });

  it('requires acknowledgement before resolution and survives delivery recovery', () => {
    const file = databasePath();
    const store = new MissionControlStore(file);
    seed(store);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-a', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    const claimed = store.claimDelivery(accepted.delivery.id, accepted.delivery.updatedAt);
    expect(claimed?.state).toBe('dispatching');
    store.close();

    const reopened = new MissionControlStore(file);
    expect(reopened.recoverDispatching('uncertain after restart')).toBe(1);
    expect(reopened.snapshot().deliveries[0]).toMatchObject({ state: 'held', lastError: 'uncertain after restart' });
    const resolve: TMissionProducerEvent = {
      eventId: 'event-resolve', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'attention.resolved', payload: { itemId: 'item-a', resolution: 'Applied' },
    };
    expect(() => reopened.applyEvents([resolve])).toThrowError(/acknowledged/);
    const acknowledge: TMissionProducerEvent = {
      eventId: 'event-ack', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: 1_700_000_000_250, bindingGeneration: 1,
      type: 'answer.acknowledged', payload: { answerId: accepted.answer.id },
    };
    reopened.applyEvents([acknowledge, resolve]);
    const replay = reopened.applyEvents([acknowledge]);
    expect(replay.replayed).toBe(true);
    expect(replay.events[0].id).toBe('event-ack');
    expect(reopened.snapshot().items[0].state).toBe('resolved');
    const resolveAgain: TMissionProducerEvent = {
      ...resolve,
      eventId: 'event-resolve-again',
      expectedRevision: 3,
      producerAt: 1_700_000_000_400,
    };
    expect(() => reopened.applyEvents([resolveAgain]))
      .toThrowError('attention item is already closed; do not retry this event unchanged');
    expect(reopened.snapshot().items[0]).toMatchObject({ state: 'resolved', revision: 3 });
    reopened.close();
  });

  it('guides externally completed unanswered attention to cancellation without changing it', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const resolve: TMissionProducerEvent = {
      eventId: 'event-resolve-unanswered', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'attention.resolved', payload: { itemId: 'item-a', resolution: 'Completed elsewhere' },
    };

    expect(() => store.applyEvents([resolve])).toThrowError(
      /send attention\.cancelled with a reason instead; do not retry this event unchanged/,
    );
    expect(store.snapshot().items[0]).toMatchObject({ state: 'open', revision: 1, answerId: null });
    expect(store.snapshot().recentEvents.map((event) => event.id)).not.toContain(resolve.eventId);

    const cancel: TMissionProducerEvent = {
      eventId: 'event-cancel-unanswered', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_400, bindingGeneration: 1,
      type: 'attention.cancelled', payload: { itemId: 'item-a', reason: 'Completed elsewhere' },
    };
    store.applyEvents([cancel]);
    const resolveCancelled: TMissionProducerEvent = {
      ...resolve,
      eventId: 'event-resolve-cancelled',
      expectedRevision: 2,
      producerAt: 1_700_000_000_500,
    };
    expect(() => store.applyEvents([resolveCancelled]))
      .toThrowError('attention item is already closed; do not retry this event unchanged');
    expect(store.snapshot().items[0]).toMatchObject({ state: 'cancelled', revision: 2, answerId: null });
    store.close();
  });

  it('rechecks delivery eligibility around paste and preserves uncertainty across resume', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-race', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    const claimed = store.claimDelivery(accepted.delivery.id, accepted.delivery.updatedAt);
    expect(claimed).not.toBeNull();
    expect(store.validateDeliveryAttempt(claimed!.id, claimed!.updatedAt, binding)).toEqual({ ok: true });

    const resume: TMissionProducerEvent = {
      eventId: 'event-resume-race', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers: true },
    };
    store.applyEvents([resume], new Map([[resume.eventId, identity]]));
    expect(store.validateDeliveryAttempt(claimed!.id, claimed!.updatedAt, binding))
      .toEqual({ ok: false, reason: 'delivery-not-dispatching' });
    const finalized = store.finalizeDeliveryAttempt(claimed!.id, claimed!.updatedAt, binding, {
      state: 'submitted', nextAttemptAt: null, lastError: null, submittedAt: Date.now(),
    });
    expect(finalized).toMatchObject({
      state: 'held',
      lastError: 'transport-uncertain:post-paste-eligibility-changed:delivery-not-dispatching',
    });
    expect(finalized!.updatedAt).toBeGreaterThan(claimed!.updatedAt);
    store.close();
  });

  it('claims a delivery waiting in the inbox only by its own marker, and lists every handoff (story 12)', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-inbox', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    // Not waiting yet: nothing to claim, nothing handed off.
    expect(store.claimInboxDelivery(accepted.delivery.id, 'inbox:i-one')).toBeNull();
    expect(store.listInboxHandoffs().deliveries).toEqual([]);

    const claimed = store.claimDelivery(accepted.delivery.id, accepted.delivery.updatedAt)!;
    expect(store.listInboxHandoffs().deliveries.map((row) => row.state)).toEqual(['dispatching']);
    const waiting = store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, binding, { state: 'queued', nextAttemptAt: null, lastError: 'inbox:i-one' })!;
    expect(store.listDueDeliveries(Date.now() + 60_000, 10)).toEqual([]);
    expect(store.listInboxHandoffs().deliveries).toEqual([waiting]);

    expect(store.claimInboxDelivery(accepted.delivery.id, 'inbox:i-other')).toBeNull();
    const pasting = store.claimInboxDelivery(accepted.delivery.id, 'inbox:i-one');
    expect(pasting).toMatchObject({ state: 'dispatching', attempts: waiting.attempts + 1 });
    expect(pasting!.updatedAt).toBeGreaterThan(waiting.updatedAt);
    expect(store.validateDeliveryAttempt(pasting!.id, pasting!.updatedAt, binding)).toEqual({ ok: true });
    expect(store.claimInboxDelivery(accepted.delivery.id, 'inbox:i-one')).toBeNull();
    store.close();
  });

  it('does not claim a waiting delivery whose answer is no longer current (story 12)', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-inbox-cancel', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    const claimed = store.claimDelivery(accepted.delivery.id, accepted.delivery.updatedAt)!;
    store.finalizeDeliveryAttempt(claimed.id, claimed.updatedAt, binding, { state: 'queued', nextAttemptAt: null, lastError: 'inbox:i-one' });
    const cancel: TMissionProducerEvent = {
      eventId: 'event-cancel-inbox', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'attention.cancelled', payload: { itemId: 'item-a', reason: 'No longer needed' },
    };
    store.applyEvents([cancel]);
    expect(store.claimInboxDelivery(accepted.delivery.id, 'inbox:i-one')).toBeNull();
    store.close();
  });

  it('does not list a bootstrap entry waiting in the inbox as due (story 12)', () => {
    const store = new MissionControlStore(databasePath());
    store.reconcileDiscovery(discoveryInput('bootstrap-inbox'));
    const [queued] = store.listQueuedBootstrapEntries(10);
    expect(queued).toBeDefined();
    const claimed = store.claimBootstrapEntry(queued.bootstrapId, queued.entry.workspaceId, queued.entry.runId, queued.entry.updatedAt)!;
    store.completeBootstrapAttempt(queued.bootstrapId, queued.entry.workspaceId, queued.entry.runId, claimed.entry.updatedAt, {
      state: 'queued', reason: 'inbox:i-boot', nextAttemptAt: null,
    });
    expect(store.listQueuedBootstrapEntries(10)).toEqual([]);
    expect(store.listInboxHandoffs().bootstrapEntries.map((row) => row.entry.reason)).toEqual(['inbox:i-boot']);
    store.close();
  });

  it('does not requeue an answer after its attention item is cancelled', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-cancel', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    const cancel: TMissionProducerEvent = {
      eventId: 'event-cancel-answer', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'attention.cancelled', payload: { itemId: 'item-a', reason: 'No longer needed' },
    };
    store.applyEvents([cancel]);
    const resume: TMissionProducerEvent = {
      eventId: 'event-resume-cancelled', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_400, bindingGeneration: 1,
      type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers: true },
    };
    store.applyEvents([resume], new Map([[resume.eventId, identity]]));
    expect(store.snapshot().deliveries.find((delivery) => delivery.id === accepted.delivery.id))
      .toMatchObject({ state: 'held', lastError: 'attention item cancelled' });
    expect(store.listDueDeliveries(Date.now() + 10_000, 10)).toEqual([]);
    store.close();
  });

  it('merges live workspace observations with durable state and retains missing workspaces as orphans', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const secondOpen: TMissionProducerEvent = {
      eventId: 'event-open-second', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 0, producerAt: 1_700_000_000_150, bindingGeneration: 1,
      type: 'attention.opened',
      payload: { itemId: 'item-second', ...question, title: 'Second question', humanReview },
    };
    store.applyEvents([secondOpen], new Map([[secondOpen.eventId, reviewAuthority]]));
    const accepted = store.submitAnswer('item-a', {
      submissionId: 'submission-snapshot', expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    store.reconcileDiscovery({
      ...discoveryInput('bootstrap-snapshot'),
      workspaces: [
        discoveryInput('bootstrap-snapshot').workspaces[0],
        discoveryInput('bootstrap-orphan', 'orphan/run', 'ws-orphan').workspaces[0],
      ],
    });
    const liveView = {
      ...store.snapshot().workspaces.find((view) => view.workspaceId === 'ws-a')!,
      runIds: [], openItems: 0, awaitingAcknowledgement: 0, lastProgressAt: null,
      evidence: { source: 'harness' as const, sourceId: 'live-ws-a', observedAt: 1_700_000_001_000, confidence: 'confirmed' as const },
    };
    const merged = store.snapshot([liveView]);
    expect(merged.workspaces.find((view) => view.workspaceId === 'ws-a')).toMatchObject({
      runIds: ['run-a'], openItems: 1, awaitingAcknowledgement: 1,
      lastProgressAt: 1_700_000_000_000,
    });
    expect(merged.runs.find((run) => run.id === 'run-a')?.objective).toBe('Deliver Mission Control');
    expect(merged.workspaces.find((view) => view.workspaceId === 'ws-orphan')).toMatchObject({
      orphaned: true, runIds: [expect.any(String)],
    });

    store.applyEvents([{
      eventId: 'event-ack-snapshot', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 2, producerAt: accepted.answer.createdAt, bindingGeneration: 1,
      type: 'answer.acknowledged', payload: { answerId: accepted.answer.id },
    }]);
    expect(store.snapshot([liveView]).workspaces.find((view) => view.workspaceId === 'ws-a')?.awaitingAcknowledgement)
      .toBe(0);
    store.close();
  });

  it('does not recreate a stale observed run after a terminal event crossed the bootstrap boundary', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    store.applyEvents([{
      eventId: 'event-finished-after-boundary', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_300, bindingGeneration: 1,
      type: 'run.finished', payload: { state: 'completed', summary: 'Done', closeoutPending: false },
    }]);
    const stale = discoveryInput('bootstrap-after-finish', 'ws-a/stale-run');
    stale.boundarySeq = 2;
    const result = store.reconcileDiscovery(stale);
    expect(result.entries).toEqual([]);
    expect(store.snapshot().runs).toMatchObject([{ id: 'run-a', state: 'completed' }]);
    store.close();
  });

  it.each(['queued', 'dispatching', 'submitted', 'held'] as const)(
    'confirms a %s bootstrap entry monotonically and rejects late completion',
    (state) => {
      const store = new MissionControlStore(databasePath());
      const bootstrapId = `bootstrap-confirm-${state}`;
      store.reconcileDiscovery(discoveryInput(bootstrapId));
      const pending = store.listQueuedBootstrapEntries(1)[0];
      let staleUpdatedAt = pending.entry.updatedAt;
      if (state !== 'queued') {
        const claimed = store.claimBootstrapEntry(bootstrapId, 'ws-a', pending.entry.runId, pending.entry.updatedAt)!;
        staleUpdatedAt = claimed.entry.updatedAt;
        expect(store.validateBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, claimed.entry.updatedAt))
          .toEqual({ ok: true });
        if (state === 'submitted' || state === 'held') {
          const completed = store.completeBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, claimed.entry.updatedAt, {
            state, reason: state === 'held' ? 'uncertain' : null,
          })!;
          staleUpdatedAt = completed.updatedAt;
        }
      }
      const runId = pending.entry.runId;
      const resume: TMissionProducerEvent = {
        eventId: `event-confirm-${state}`, schemaVersion: 1, workspaceId: 'ws-a', runId,
        expectedRevision: 0, producerAt: 1_700_000_000_500, bindingGeneration: 0,
        type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers: false },
      };
      store.applyEvents([resume], new Map([[resume.eventId, identity]]));
      const confirmed = store.snapshot().bootstrap!.entries[0];
      expect(confirmed.state).toBe('confirmed');
      expect(confirmed.updatedAt).toBeGreaterThan(staleUpdatedAt);
      expect(store.validateBootstrapAttempt(bootstrapId, 'ws-a', runId, staleUpdatedAt).ok).toBe(false);
      expect(store.completeBootstrapAttempt(bootstrapId, 'ws-a', runId, staleUpdatedAt, {
        state: 'submitted', reason: null,
      })).toBeNull();
      expect(store.snapshot().bootstrap!.entries[0].state).toBe('confirmed');
      store.close();
    },
  );

  it.each(['queued', 'dispatching', 'submitted', 'held'] as const)(
    'run.started confirms a %s bootstrap entry and invalidates its dispatch CAS',
    (state) => {
      const store = new MissionControlStore(databasePath());
      const bootstrapId = `bootstrap-start-${state}`;
      store.reconcileDiscovery(discoveryInput(bootstrapId));
      const pending = store.listQueuedBootstrapEntries(1)[0];
      let staleUpdatedAt = pending.entry.updatedAt;
      if (state !== 'queued') {
        const claimed = store.claimBootstrapEntry(bootstrapId, 'ws-a', pending.entry.runId, pending.entry.updatedAt)!;
        staleUpdatedAt = claimed.entry.updatedAt;
        expect(store.validateBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, staleUpdatedAt))
          .toEqual({ ok: true });
        if (state === 'submitted' || state === 'held') {
          const completed = store.completeBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, staleUpdatedAt, {
            state, reason: state === 'held' ? 'uncertain' : null,
          })!;
          staleUpdatedAt = completed.updatedAt;
        }
      }
      const start = { ...startEvent(`event-start-${state}`), runId: pending.entry.runId };
      store.applyEvents([start], new Map([[start.eventId, identity]]));
      const confirmed = store.snapshot().bootstrap!.entries[0];
      expect(confirmed.state).toBe('confirmed');
      expect(confirmed.updatedAt).toBeGreaterThan(staleUpdatedAt);
      expect(store.validateBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, staleUpdatedAt))
        .toEqual({ ok: false, reason: 'bootstrap-entry-not-dispatching' });
      expect(store.completeBootstrapAttempt(bootstrapId, 'ws-a', pending.entry.runId, staleUpdatedAt, {
        state: 'submitted', reason: null,
      })).toBeNull();
      store.close();
    },
  );

  it('rejects bootstrap dispatch when another confirmed run becomes current', () => {
    const store = new MissionControlStore(databasePath());
    store.reconcileDiscovery(discoveryInput('bootstrap-current-check'));
    const pending = store.listQueuedBootstrapEntries(1)[0];
    const claimed = store.claimBootstrapEntry(
      pending.bootstrapId, pending.entry.workspaceId, pending.entry.runId, pending.entry.updatedAt,
    )!;
    const concurrentStart = { ...startEvent('event-concurrent-start'), runId: 'run-concurrent' };
    store.applyEvents([concurrentStart], new Map([[concurrentStart.eventId, identity]]));
    expect(store.validateBootstrapAttempt(
      pending.bootstrapId, pending.entry.workspaceId, pending.entry.runId, claimed.entry.updatedAt,
    )).toEqual({ ok: false, reason: 'bootstrap-run-not-current' });
    store.close();
  });

  it('creates a fresh provisional for a new lifecycle while tombstoning a completed source', () => {
    const store = new MissionControlStore(databasePath());
    store.reconcileDiscovery(discoveryInput('bootstrap-lifecycle-a', 'orchestrator/session-a'));
    const lifecycleA = store.snapshot().runs[0];
    const start = { ...startEvent('event-lifecycle-a-start'), runId: lifecycleA.id };
    store.applyEvents([start], new Map([[start.eventId, identity]]));
    store.applyEvents([{
      eventId: 'event-lifecycle-a-finish', schemaVersion: 1, workspaceId: 'ws-a', runId: lifecycleA.id,
      expectedRevision: 1, producerAt: 1_700_000_000_500, bindingGeneration: 1,
      type: 'run.finished', payload: { state: 'completed', summary: 'Done', closeoutPending: false },
    }]);
    const boundary = store.snapshot().cursor;

    const lifecycleBInput = discoveryInput('bootstrap-lifecycle-b', 'orchestrator/session-b');
    lifecycleBInput.boundarySeq = boundary;
    lifecycleBInput.workspaces[0].identities = [observedIdentity('b')];
    expect(store.reconcileDiscovery(lifecycleBInput).entries[0].state).toBe('queued');
    const lifecycleB = store.snapshot().runs.find((run) => run.evidence.confidence === 'provisional');
    expect(lifecycleB).toMatchObject({ revision: 0, state: 'running', binding: null });
    expect(lifecycleB?.id).not.toBe(lifecycleA.id);

    const repeatedA = discoveryInput('bootstrap-lifecycle-a-again', 'orchestrator/session-a');
    repeatedA.boundarySeq = boundary;
    expect(store.reconcileDiscovery(repeatedA).entries).toMatchObject([{
      state: 'provisional', reason: 'reconciliation already recorded', runId: lifecycleB?.id,
    }]);
    expect(store.snapshot().runs.filter((run) => run.id === lifecycleA.id)).toHaveLength(1);
    store.close();
  });

  it.each(['completed', 'cancelled'] as const)(
    'uses durable identity membership to suppress %s lifecycle subsets and admit a new identity',
    (terminalState) => {
      const store = new MissionControlStore(databasePath());
      const orchestrator = observedIdentity('orchestrator');
      const workerOne = observedIdentity('worker-one');
      const workerTwo = observedIdentity('worker-two');
      const initial = discoveryInput(`bootstrap-membership-${terminalState}`, 'live-set:o,w1');
      initial.workspaces[0].identities = [workerOne, orchestrator, orchestrator];
      initial.workspaces[0].reconciliation!.sourceKey = 'orchestrator:o';
      store.reconcileDiscovery(initial);
      const firstRunId = store.snapshot().runs[0].id;
      const start = { ...startEvent(`event-membership-start-${terminalState}`), runId: firstRunId };
      store.applyEvents([start], new Map([[start.eventId, identity]]));
      store.applyEvents([{
        eventId: `event-membership-finish-${terminalState}`, schemaVersion: 1,
        workspaceId: 'ws-a', runId: firstRunId, expectedRevision: 1,
        producerAt: 1_700_000_000_600, bindingGeneration: 1,
        type: 'run.finished', payload: { state: terminalState, summary: 'Closed', closeoutPending: false },
      }]);
      const boundary = store.snapshot().cursor;

      const subsets = [
        { source: 'live-set:o,w1', identities: [orchestrator, workerOne] },
        { source: 'live-set:o', identities: [orchestrator] },
        { source: 'live-set:w1', identities: [workerOne] },
        { source: 'live-set:empty', identities: [] },
      ];
      for (const [index, subset] of subsets.entries()) {
        const replay = discoveryInput(`bootstrap-subset-${terminalState}-${index}`, subset.source);
        replay.boundarySeq = boundary;
        replay.workspaces[0].identities = subset.identities;
        replay.workspaces[0].reconciliation!.sourceKey = 'orchestrator:o';
        expect(store.reconcileDiscovery(replay).entries).toEqual([]);
        expect(store.snapshot().runs).toHaveLength(1);
      }
      for (const [index, identities] of [[], [orchestrator]].entries()) {
        const recentStandup = discoveryInput(
          `bootstrap-standup-subset-${terminalState}-${index}`,
          `standup:changed-after-${terminalState}:${index}`,
        );
        recentStandup.boundarySeq = boundary;
        recentStandup.workspaces[0].identities = identities;
        recentStandup.workspaces[0].run!.evidence = {
          source: 'standup', sourceId: `recent-standup-${terminalState}-${index}`,
          observedAt: 1_700_000_000_900 + index, confidence: 'provisional',
        };
        recentStandup.workspaces[0].reconciliation!.sourceKey = 'orchestrator:o';
        expect(store.reconcileDiscovery(recentStandup).entries).toEqual([]);
        expect(store.snapshot().runs).toHaveLength(1);
      }

      const changed = discoveryInput(`bootstrap-new-worker-${terminalState}`, 'live-set:o,w2');
      changed.boundarySeq = boundary;
      changed.workspaces[0].identities = [orchestrator, workerTwo];
      changed.workspaces[0].reconciliation!.sourceKey = 'orchestrator:o';
      expect(store.reconcileDiscovery(changed).entries).toMatchObject([{
        state: 'provisional', reason: 'reconciliation already recorded',
      }]);
      expect(store.snapshot().runs).toHaveLength(2);
      expect(store.snapshot().runs.find((run) => run.revision === 0)).toMatchObject({ binding: null });
      store.close();
    },
  );

  it('accumulates identities on the current run and suppresses recombined historical sets after close', () => {
    const store = new MissionControlStore(databasePath());
    const orchestrator = observedIdentity('orchestrator');
    const workerOne = observedIdentity('worker-one');
    const workerTwo = observedIdentity('worker-two');
    const initial = discoveryInput('bootstrap-identity-union-a', 'live-set:o,w1');
    initial.workspaces[0].identities = [orchestrator, workerOne];
    store.reconcileDiscovery(initial);
    const runId = store.snapshot().runs[0].id;

    const expanded = discoveryInput('bootstrap-identity-union-expanded', 'live-set:o,w1,w2');
    expanded.workspaces[0].identities = [workerTwo, orchestrator, workerOne];
    store.reconcileDiscovery(expanded);
    const start = { ...startEvent('event-identity-union-start'), runId };
    store.applyEvents([start], new Map([[start.eventId, identity]]));
    store.applyEvents([{
      eventId: 'event-identity-union-finish', schemaVersion: 1, workspaceId: 'ws-a', runId,
      expectedRevision: 1, producerAt: 1_700_000_000_700, bindingGeneration: 1,
      type: 'run.finished', payload: { state: 'completed', summary: 'Closed', closeoutPending: false },
    }]);
    const afterFinish = store.snapshot().cursor;

    const recombined = discoveryInput('bootstrap-identity-union-recombined', 'live-set:o,w2');
    recombined.boundarySeq = afterFinish;
    recombined.workspaces[0].identities = [orchestrator, workerTwo];
    expect(store.reconcileDiscovery(recombined).entries).toEqual([]);
    expect(store.snapshot().runs).toHaveLength(1);
    store.close();
  });

  it('treats legacy terminal membership as unknown and seeds one identifiable lifecycle', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    store.applyEvents([{
      eventId: 'event-legacy-finish', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_800, bindingGeneration: 1,
      type: 'run.finished', payload: { state: 'completed', summary: 'Legacy done', closeoutPending: false },
    }]);
    const fresh = discoveryInput('bootstrap-after-legacy', 'live-set:new-session');
    fresh.boundarySeq = store.snapshot().cursor;
    fresh.workspaces[0].identities = [observedIdentity('new-session')];
    expect(store.reconcileDiscovery(fresh).entries[0].state).toBe('queued');
    expect(store.snapshot().runs).toHaveLength(2);
    expect(store.reconcileDiscovery({ ...fresh, bootstrapId: 'bootstrap-after-legacy-repeat' }).entries[0])
      .toMatchObject({ state: 'provisional', reason: 'reconciliation already recorded' });
    expect(store.snapshot().runs).toHaveLength(2);
    store.close();
  });

  it('deduplicates bootstrap sources across IDs and preserves newer semantic state', () => {
    const store = new MissionControlStore(databasePath());
    const discovery = (bootstrapId: string): IMissionDiscoveryInput => ({
      bootstrapId,
      reconcile: true,
      boundarySeq: 0,
      observedAt: 1_700_000_000_000,
      workspaces: [{
        workspaceId: 'ws-a', name: 'Alpha', activity: 'active', agents: [],
        lastActivityAt: 1_700_000_000_000, lastProgressAt: 1_700_000_000_000, stale: false,
        identities: [identity],
        evidence: { source: 'harness', sourceId: 'workspace-a', observedAt: 1_700_000_000_000, confidence: 'confirmed' },
        run: {
          sourceKey: 'ws-a/session-a', objective: 'Observed objective', phase: 'implementation', state: 'running',
          nextStep: 'Continue', lastProgressAt: 1_700_000_000_000,
          evidence: { source: 'bootstrap', sourceId: 'run-source', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        },
        candidates: [{
          sourceKey: 'ws-a/question-a', question,
          evidence: { source: 'bootstrap', sourceId: 'candidate-a', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        }],
        reconciliation: { sourceKey: 'ws-a/reconcile-a', binding },
      }],
    });
    const first = store.reconcileDiscovery(discovery('bootstrap-a'));
    expect(first.entries[0].state).toBe('queued');
    expect(store.snapshot().runs[0]).toMatchObject({ revision: 0, binding: null });
    expect(store.reconcileDiscovery({
      ...discovery('bootstrap-a'),
      observedAt: 1_700_000_000_999,
      workspaces: [],
    })).toEqual(first);

    const provisionalRunId = store.snapshot().runs[0].id;
    const start = { ...startEvent('event-confirm'), runId: provisionalRunId };
    store.applyEvents([start], new Map([[start.eventId, identity]]));
    const second = store.reconcileDiscovery(discovery('bootstrap-b'));
    const snapshot = store.snapshot();
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({ revision: 1, objective: 'Deliver Mission Control' });
    expect(snapshot.items).toHaveLength(1);
    expect(second.entries).toEqual([]);
    store.close();
  });

  it('requires a server-resolved resume before a provisional run can report progress or questions', () => {
    const store = new MissionControlStore(databasePath());
    const input: IMissionDiscoveryInput = {
      bootstrapId: 'bootstrap-provisional', reconcile: false, boundarySeq: 0, observedAt: 1_700_000_000_000,
      workspaces: [{
        workspaceId: 'ws-a', name: 'Alpha', activity: 'active', agents: [],
        lastActivityAt: 1_700_000_000_000, lastProgressAt: null, stale: false,
        identities: [identity],
        evidence: { source: 'harness', sourceId: 'workspace-a', observedAt: 1_700_000_000_000, confidence: 'confirmed' },
        run: {
          sourceKey: 'ws-a/provisional', objective: 'Observed', phase: null, state: 'running', nextStep: null,
          lastProgressAt: null,
          evidence: { source: 'bootstrap', sourceId: 'run-provisional', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        }, candidates: [], reconciliation: null,
      }],
    };
    store.reconcileDiscovery(input);
    const runId = store.snapshot().runs[0].id;
    const progress: TMissionProducerEvent = {
      eventId: 'event-provisional-progress', schemaVersion: 1, workspaceId: 'ws-a', runId,
      expectedRevision: 0, producerAt: 1_700_000_000_100, bindingGeneration: 0,
      type: 'progress.updated', payload: { phase: 'unsafe' },
    };
    expect(() => store.applyEvents([progress])).toThrowError(/unbound/);
    const resume: TMissionProducerEvent = {
      eventId: 'event-provisional-resume', schemaVersion: 1, workspaceId: 'ws-a', runId,
      expectedRevision: 0, producerAt: 1_700_000_000_200, bindingGeneration: 0,
      type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers: false },
    };
    store.applyEvents([resume], new Map([[resume.eventId, identity]]));
    expect(store.snapshot().runs[0]).toMatchObject({ revision: 1, binding: { generation: 1 } });
    store.close();
  });

  it('holds an uncertain bootstrap dispatch after restart instead of sending it twice', () => {
    const store = new MissionControlStore(databasePath());
    const input: IMissionDiscoveryInput = {
      bootstrapId: 'bootstrap-restart', reconcile: true, boundarySeq: 0, observedAt: 1_700_000_000_000,
      workspaces: [{
        workspaceId: 'ws-a', name: 'Alpha', activity: 'active', agents: [],
        lastActivityAt: 1_700_000_000_000, lastProgressAt: 1_700_000_000_000, stale: false,
        identities: [identity],
        evidence: { source: 'harness', sourceId: 'workspace-a', observedAt: 1_700_000_000_000, confidence: 'confirmed' },
        run: {
          sourceKey: 'ws-a/restart-run', objective: 'Observed', phase: null, state: 'running', nextStep: null,
          lastProgressAt: 1_700_000_000_000,
          evidence: { source: 'bootstrap', sourceId: 'restart-run', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        },
        candidates: [],
        reconciliation: { sourceKey: 'ws-a/restart-reconcile', binding },
      }],
    };
    store.reconcileDiscovery(input);
    const pending = store.listQueuedBootstrapEntries(1)[0];
    const claimed = store.claimBootstrapEntry(pending.bootstrapId, pending.entry.workspaceId, pending.entry.runId, pending.entry.updatedAt);
    expect(claimed?.entry.state).toBe('dispatching');
    expect(store.recoverDispatching('uncertain after restart')).toBe(1);
    expect(store.listQueuedBootstrapEntries(1)).toEqual([]);
    expect(store.snapshot().bootstrap?.entries[0]).toMatchObject({ state: 'held', reason: 'uncertain after restart' });
    store.close();
  });

  it('does not queue a second reconciliation for the same source while the first is pending or uncertain', () => {
    const store = new MissionControlStore(databasePath());
    const discovery = (bootstrapId: string, sourceKey = 'ws-a/reconcile-once'): IMissionDiscoveryInput => ({
      bootstrapId, reconcile: true, boundarySeq: 0, observedAt: 1_700_000_000_000,
      workspaces: [{
        workspaceId: 'ws-a', name: 'Alpha', activity: 'active', agents: [],
        lastActivityAt: 1_700_000_000_000, lastProgressAt: null, stale: false,
        identities: [identity],
        evidence: { source: 'harness', sourceId: 'workspace-a', observedAt: 1_700_000_000_000, confidence: 'confirmed' },
        run: {
          sourceKey: 'ws-a/one-run', objective: 'Observed', phase: null, state: 'running', nextStep: null,
          lastProgressAt: null,
          evidence: { source: 'bootstrap', sourceId: 'one-run', observedAt: 1_700_000_000_000, confidence: 'provisional' },
        }, candidates: [], reconciliation: { sourceKey, binding },
      }],
    });
    store.reconcileDiscovery(discovery('bootstrap-one'));
    const pending = store.listQueuedBootstrapEntries(1)[0];
    store.claimBootstrapEntry(pending.bootstrapId, pending.entry.workspaceId, pending.entry.runId, pending.entry.updatedAt);
    expect(store.reconcileDiscovery(discovery('bootstrap-two')).entries[0])
      .toMatchObject({ state: 'provisional', reason: 'reconciliation already recorded' });
    store.recoverDispatching('uncertain');
    expect(store.reconcileDiscovery(discovery('bootstrap-three')).entries[0])
      .toMatchObject({ state: 'provisional', reason: 'reconciliation already recorded' });
    expect(store.listQueuedBootstrapEntries(10)).toHaveLength(0);
    expect(store.reconcileDiscovery(discovery('bootstrap-four', 'ws-a/reconcile-new-identity')).entries[0].state)
      .toBe('queued');
    store.close();
  });
});

describe('MissionControlStore orchestrator rebind', () => {
  const successor = { tabId: 'tab-successor', providerId: 'claude', sessionId: 'session-successor', runtimeGeneration: null };
  const successorAuthority = { resolvedIdentity: successor, configuredOrchestratorTabId: successor.tabId };
  const successorReview = { ...humanReview, reviewerTabId: successor.tabId };
  const runEvents = (store: MissionControlStore, runId = 'run-a') =>
    store.eventsAfter(0, 200).events.filter((event) => event.runId === runId);
  const progress = (eventId: string, expectedRevision: number, bindingGeneration: number): TMissionProducerEvent => ({
    eventId, schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision,
    producerAt: 1_700_000_000_500, bindingGeneration, type: 'progress.updated', payload: { phase: 'verification' },
  });
  const answer = (store: MissionControlStore, submissionId = 'submission-rebind') => store.submitAnswer('item-a', {
    submissionId, expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
  }, 'user');

  it('moves an open run to the new orchestrator at the next generation and audits it in the same event log', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const before = store.snapshot().runs[0];
    const cursor = store.snapshot().cursor;

    const [event, ...rest] = store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'handoff' });

    expect(rest).toEqual([]);
    const after = store.snapshot().runs[0];
    expect(after.binding).toEqual({ ...successor, generation: 2 });
    expect(after.revision).toBe(before.revision + 1);
    expect(after).toMatchObject({
      state: before.state, objective: before.objective, evidence: before.evidence, lastProgressAt: before.lastProgressAt,
    });
    expect(event).toMatchObject({
      type: 'run.rebound', workspaceId: 'ws-a', runId: 'run-a', entityId: 'run-a', revision: after.revision, schemaVersion: 1,
      payload: { cause: 'handoff', previousBinding: binding, binding: { ...successor, generation: 2 }, actor: 'system:orchestration' },
    });
    expect(event.seq).toBe(cursor + 1);
    expect(store.snapshot().cursor).toBe(event.seq);
    expect(store.eventsAfter(cursor, 10)).toMatchObject({ events: [event], cursor: event.seq, hasMore: false });
    expect(store.snapshot().recentEvents.at(-1)).toEqual(event);
    store.close();
  });

  it('refuses producer events from the old generation after a rebind and accepts the new one', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'recover' });

    expect(() => store.applyEvents([progress('event-old-progress', 1, 1)]))
      .toThrowError('stale run revision');
    expect(() => store.applyEvents([progress('event-old-generation', 2, 1)]))
      .toThrowError('stale or unbound orchestrator generation');
    const staleQuestion: TMissionProducerEvent = { ...openEvent('event-old-open'), payload: { itemId: 'item-old', ...question } };
    expect(() => store.applyEvents([staleQuestion])).toThrowError('stale or unbound orchestrator generation');
    const restart = startEvent('event-restart');
    expect(() => store.applyEvents([restart], new Map([[restart.eventId, successor]]))).toThrowError('run already exists');

    const accepted = store.applyEvents([progress('event-new-progress', 2, 2)]);
    expect(accepted.events[0]).toMatchObject({ type: 'progress.updated', revision: 3 });
    expect(store.snapshot().runs[0]).toMatchObject({ revision: 3, phase: 'verification', binding: { tabId: successor.tabId, generation: 2 } });
    store.close();
  });

  it('accepts human review from the new orchestrator at the new generation and refuses the old tab', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const reviewed = (eventId: string, itemId: string, bindingGeneration: number, review: typeof humanReview): TMissionProducerEvent => ({
      ...openEvent(eventId), bindingGeneration, payload: { itemId, ...question, humanReview: review },
    });
    const blocked = reviewed('event-review-before', 'item-before', 1, successorReview);
    expect(() => store.applyEvents([blocked], new Map([[blocked.eventId, successorAuthority]])))
      .toThrowError('human review requires a run bound to the configured orchestrator');

    store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'handoff' });

    const fromOldTab = reviewed('event-review-old-tab', 'item-old-tab', 2, humanReview);
    expect(() => store.applyEvents([fromOldTab], new Map([[fromOldTab.eventId, { resolvedIdentity: identity, configuredOrchestratorTabId: successor.tabId }]])))
      .toThrowError('human review requires the configured orchestrator');
    const opened = reviewed('event-review-after', 'item-after', 2, successorReview);
    store.applyEvents([opened], new Map([[opened.eventId, successorAuthority]]));
    expect(store.snapshot().items.find((item) => item.id === 'item-after')).toMatchObject({
      state: 'open', humanReview: { reviewerTabId: successor.tabId, binding: { ...successor, generation: 2 } },
    });

    const candidate: TMissionProducerEvent = { ...openEvent('event-candidate'), bindingGeneration: 2, payload: { itemId: 'item-candidate', ...question } };
    store.applyEvents([candidate]);
    const promoted: TMissionProducerEvent = {
      ...candidate, eventId: 'event-promote', expectedRevision: 1, type: 'attention.updated',
      payload: { itemId: 'item-candidate', ...question, humanReview: successorReview },
    };
    store.applyEvents([promoted], new Map([[promoted.eventId, successorAuthority]]));
    expect(store.snapshot().items.find((item) => item.id === 'item-candidate')).toMatchObject({ state: 'open', revision: 2 });
    store.close();
  });

  it('leaves finished runs, unbound provisional runs and other workspaces untouched', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const finished: TMissionProducerEvent = {
      eventId: 'event-finish', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 1,
      producerAt: 1_700_000_000_200, bindingGeneration: 1, type: 'run.finished',
      payload: { state: 'completed', summary: 'Shipped', closeoutPending: false },
    };
    store.applyEvents([finished]);
    const cancelledStart: TMissionProducerEvent = { ...startEvent('event-start-cancelled'), runId: 'run-cancelled' };
    store.applyEvents([cancelledStart], new Map([[cancelledStart.eventId, identity]]));
    store.applyEvents([{ ...finished, eventId: 'event-cancel', runId: 'run-cancelled', payload: { state: 'cancelled', summary: 'Dropped', closeoutPending: false } }]);
    const foreign: TMissionProducerEvent = { ...startEvent('event-start-foreign'), workspaceId: 'ws-b', runId: 'run-b' };
    store.applyEvents([foreign], new Map([[foreign.eventId, identity]]));
    store.reconcileDiscovery(discoveryInput('bootstrap-provisional', 'ws-c/run', 'ws-c'));
    const before = store.snapshot();

    expect(store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'handoff' })).toEqual([]);
    expect(store.rebindOpenRuns({ workspaceId: 'ws-c', identity: successor, cause: 'recover' })).toEqual([]);

    const after = store.snapshot();
    expect(after.cursor).toBe(before.cursor);
    expect(after.recentEvents).toEqual(before.recentEvents);
    for (const run of before.runs) {
      expect(after.runs.find((candidate) => candidate.id === run.id)).toEqual(run);
    }
    expect(after.runs.find((run) => run.workspaceId === 'ws-c')).toMatchObject({ revision: 0, binding: null });
    expect(store.listOpenRunBindings()).toEqual([{ runId: 'run-b', workspaceId: 'ws-b', binding }]);
    store.close();
  });

  it('rebinds only the named workspace when two workspaces hold open runs', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const foreign: TMissionProducerEvent = { ...startEvent('event-start-foreign'), workspaceId: 'ws-b', runId: 'run-b' };
    store.applyEvents([foreign], new Map([[foreign.eventId, identity]]));
    const foreignBefore = store.snapshot().runs.find((run) => run.id === 'run-b')!;
    const foreignEvents = runEvents(store, 'run-b');

    expect(store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'handoff' })).toHaveLength(1);

    expect(store.snapshot().runs.find((run) => run.id === 'run-b')).toEqual(foreignBefore);
    expect(runEvents(store, 'run-b')).toEqual(foreignEvents);
    expect(store.listOpenRunBindings('ws-a')).toEqual([{ runId: 'run-a', workspaceId: 'ws-a', binding: { ...successor, generation: 2 } }]);
    store.close();
  });

  it('is idempotent: a repeated rebind to the same identity changes nothing', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'handoff' });
    const settled = store.snapshot();

    expect(store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'handoff' })).toEqual([]);
    expect(store.rebindOpenRuns({ workspaceId: 'ws-a', identity: { ...successor }, cause: 'recover' })).toEqual([]);

    const repeated = store.snapshot();
    expect(repeated.runs).toEqual(settled.runs);
    expect(repeated.cursor).toBe(settled.cursor);
    expect(runEvents(store).filter((event) => event.type === 'run.rebound')).toHaveLength(1);

    const [again] = store.rebindOpenRuns({ workspaceId: 'ws-a', identity: { ...successor, sessionId: 'session-relaunched' }, cause: 'recover' });
    expect(again.payload).toMatchObject({ cause: 'recover', binding: { sessionId: 'session-relaunched', generation: 3 } });
    store.close();
  });

  it('narrows the rebind to the bindings the caller declares eligible', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const second: TMissionProducerEvent = {
      eventId: 'event-start-second', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-second', expectedRevision: 0,
      producerAt: 1_700_000_000_000, bindingGeneration: 0, type: 'run.started', payload: { objective: 'Second', tabId: 'tab-worker' },
    };
    store.applyEvents([second], new Map([[second.eventId, { ...identity, tabId: 'tab-worker' }]]));

    const events = store.rebindOpenRuns({
      workspaceId: 'ws-a', identity: successor, cause: 'heal', eligible: (current) => current.tabId === binding.tabId,
    });

    expect(events.map((event) => [event.runId, event.payload.cause])).toEqual([['run-a', 'heal']]);
    expect(store.snapshot().runs.find((run) => run.id === 'run-second')?.binding).toMatchObject({ tabId: 'tab-worker', generation: 1 });
    store.close();
  });

  it('rolls back every run of the batch when one rebind fails', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const second: TMissionProducerEvent = { ...startEvent('event-start-second'), runId: 'run-second' };
    store.applyEvents([second], new Map([[second.eventId, identity]]));
    const before = store.snapshot();
    let seen = 0;

    expect(() => store.rebindOpenRuns({
      workspaceId: 'ws-a', identity: successor, cause: 'handoff',
      eligible: () => {
        seen += 1;
        if (seen === 2) throw new Error('eligibility failed');
        return true;
      },
    })).toThrowError('eligibility failed');

    expect(seen).toBe(2);
    expect(store.snapshot().runs).toEqual(before.runs);
    expect(store.snapshot().cursor).toBe(before.cursor);
    store.close();
  });

  it('carries queued and held answers to the new binding and holds a paste in flight as uncertain', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const reviewedOpen = (eventId: string, itemId: string): TMissionProducerEvent => ({
      ...openEvent(eventId), payload: { itemId, ...question, humanReview },
    });
    for (const itemId of ['item-flight', 'item-held', 'item-cancelled', 'item-acknowledged']) {
      const opened = reviewedOpen(`event-open-${itemId}`, itemId);
      store.applyEvents([opened], new Map([[opened.eventId, reviewAuthority]]));
    }
    const submit = (itemId: string) => store.submitAnswer(itemId, {
      submissionId: `submission-${itemId}`, expectedRevision: 1, optionIds: ['gradual'], text: '', actionCompleted: false,
    }, 'user');
    const waiting = answer(store);
    const claimedWaiting = store.claimDelivery(waiting.delivery.id, waiting.delivery.updatedAt)!;
    store.finalizeDeliveryAttempt(claimedWaiting.id, claimedWaiting.updatedAt, binding, { state: 'queued', nextAttemptAt: null, lastError: 'inbox:i-old-tab' });
    const flight = submit('item-flight');
    const pasting = store.claimDelivery(flight.delivery.id, flight.delivery.updatedAt)!;
    const held = submit('item-held');
    const claimedHeld = store.claimDelivery(held.delivery.id, held.delivery.updatedAt)!;
    store.finalizeDeliveryAttempt(claimedHeld.id, claimedHeld.updatedAt, binding, { state: 'held', nextAttemptAt: null, lastError: 'bound-agent-not-live' });
    const cancelled = submit('item-cancelled');
    store.applyEvents([{
      eventId: 'event-cancel-item', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 2,
      producerAt: 1_700_000_000_300, bindingGeneration: 1, type: 'attention.cancelled', payload: { itemId: 'item-cancelled', reason: 'Superseded' },
    }]);
    const acknowledged = submit('item-acknowledged');
    store.applyEvents([{
      eventId: 'event-ack-item', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 2,
      producerAt: 1_700_000_000_350, bindingGeneration: 1, type: 'answer.acknowledged', payload: { answerId: acknowledged.answer.id },
    }]);

    store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'handoff' });

    const rebound = { ...successor, generation: 2 };
    const row = (id: string) => store.snapshot().deliveries.find((delivery) => delivery.id === id)!;
    expect(row(waiting.delivery.id)).toMatchObject({ state: 'queued', lastError: null, binding: rebound });
    expect(row(waiting.delivery.id).nextAttemptAt).not.toBeNull();
    expect(row(held.delivery.id)).toMatchObject({ state: 'queued', lastError: null, binding: rebound });
    expect(row(flight.delivery.id)).toMatchObject({
      state: 'held', nextAttemptAt: null, lastError: 'transport-uncertain:run-rebound-during-dispatch', binding,
    });
    expect(row(cancelled.delivery.id)).toMatchObject({ state: 'held', lastError: 'attention item cancelled', binding });
    expect(row(acknowledged.delivery.id)).toMatchObject({ state: 'acknowledged', binding });

    expect(store.finalizeDeliveryAttempt(pasting.id, pasting.updatedAt, binding, {
      state: 'submitted', nextAttemptAt: null, lastError: null, submittedAt: Date.now(),
    })).toMatchObject({ state: 'held', lastError: 'transport-uncertain:post-paste-eligibility-changed:delivery-not-dispatching' });
    const due = store.listDueDeliveries(Date.now() + 1_000, 10).map((delivery) => delivery.id).sort();
    expect(due).toEqual([waiting.delivery.id, held.delivery.id].sort());
    const claimed = store.claimDelivery(waiting.delivery.id, row(waiting.delivery.id).updatedAt)!;
    expect(claimed).toMatchObject({ state: 'dispatching', binding: rebound });
    expect(store.validateDeliveryAttempt(claimed.id, claimed.updatedAt, rebound)).toEqual({ ok: true });

    const ackFlight: TMissionProducerEvent = {
      eventId: 'event-ack-flight', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 2,
      producerAt: 1_700_000_000_600, bindingGeneration: 2, type: 'answer.acknowledged', payload: { answerId: flight.answer.id },
    };
    store.applyEvents([ackFlight]);
    expect(row(flight.delivery.id).state).toBe('acknowledged');
    store.close();
  });

  it('keeps the run.resumed delivery handling it shares with the rebind', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const accepted = answer(store, 'submission-resume-shared');
    const resume = (eventId: string, expectedRevision: number, bindingGeneration: number, transferPendingAnswers: boolean): TMissionProducerEvent => ({
      eventId, schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision, producerAt: 1_700_000_000_300,
      bindingGeneration, type: 'run.resumed', payload: { tabId: binding.tabId, transferPendingAnswers },
    });
    const withheld = resume('event-resume-withheld', 1, 1, false);
    store.applyEvents([withheld], new Map([[withheld.eventId, identity]]));
    expect(store.snapshot().deliveries[0]).toMatchObject({ id: accepted.delivery.id, state: 'held', lastError: 'run resumed without answer transfer', binding });
    const transferred = resume('event-resume-transferred', 2, 2, true);
    store.applyEvents([transferred], new Map([[transferred.eventId, identity]]));
    expect(store.snapshot().deliveries[0]).toMatchObject({ state: 'queued', lastError: null, binding: { ...binding, generation: 3 } });
    store.close();
  });

  it('keeps a reopened store on the rebound binding and its audit event', () => {
    const file = databasePath();
    const store = new MissionControlStore(file);
    seedRun(store);
    const [event] = store.rebindOpenRuns({ workspaceId: 'ws-a', identity: successor, cause: 'heal' });
    store.close();

    const reopened = new MissionControlStore(file);
    expect(reopened.snapshot().runs[0].binding).toEqual({ ...successor, generation: 2 });
    expect(reopened.eventsAfter(0, 200).events.find((candidate) => candidate.type === 'run.rebound')).toEqual(event);
    reopened.close();
  });
});

describe('MissionControlStore attention class and stated default (ADR-0031)', () => {
  const DAY = 86_400_000;
  const classifiedOpen = (
    itemId: string,
    over: Partial<{ class: 'money' | 'irreversible' | 'scope' | 'bookkeeping'; defaultOptionId: string }>,
  ): Extract<TMissionProducerEvent, { type: 'attention.opened' }> => ({
    ...openEvent(`event-open-${itemId}`),
    payload: { itemId, ...question, ...over, humanReview },
  });
  const openClassified = (store: MissionControlStore, event: TMissionProducerEvent): void => {
    store.applyEvents([event], new Map([[event.eventId, reviewAuthority]]));
  };
  const answer = (store: MissionControlStore, itemId: string, actor = 'user') => store.submitAnswer(itemId, {
    submissionId: `submission-${itemId}`,
    expectedRevision: 1,
    optionIds: ['gradual'],
    text: '',
    actionCompleted: false,
  }, actor);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores class and default inside question_json and serves them on the snapshot item', () => {
    const file = databasePath();
    const store = new MissionControlStore(file);
    seedRun(store);
    openClassified(store, classifiedOpen('item-a', { class: 'bookkeeping', defaultOptionId: 'gradual' }));
    expect(store.snapshot().items[0]).toMatchObject({
      id: 'item-a', revision: 1, state: 'open', class: 'bookkeeping', defaultOptionId: 'gradual',
    });
    store.close();

    const raw = new Database(file, { readonly: true });
    const row = raw.prepare('SELECT question_json FROM attention_items WHERE id=?').get('item-a') as { question_json: string };
    expect(JSON.parse(row.question_json)).toMatchObject({ class: 'bookkeeping', defaultOptionId: 'gradual' });
    raw.close();

    const reopened = new MissionControlStore(file);
    expect(reopened.snapshot().items[0]).toMatchObject({ class: 'bookkeeping', defaultOptionId: 'gradual' });
    reopened.close();
  });

  it('serves null for an item without a class or a default (absence, never a guessed class)', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    const [item] = store.snapshot().items;
    expect(item.class).toBeNull();
    expect(item.defaultOptionId).toBeNull();
    store.close();
  });

  it('lets attention.updated change both fields under the existing revision rule', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const opened = classifiedOpen('item-a', { class: 'scope' });
    openClassified(store, opened);
    const reclassifiedPayload = { ...opened.payload, class: 'bookkeeping' as const, defaultOptionId: 'direct' };
    const reclassified: TMissionProducerEvent = {
      ...opened, eventId: 'event-reclassify', type: 'attention.updated', expectedRevision: 1, payload: reclassifiedPayload,
    };
    store.applyEvents([reclassified], new Map([[reclassified.eventId, reviewAuthority]]));
    expect(store.snapshot().items[0]).toMatchObject({ revision: 2, state: 'open', class: 'bookkeeping', defaultOptionId: 'direct' });

    const stale: TMissionProducerEvent = { ...reclassified, eventId: 'event-reclassify-stale', expectedRevision: 1 };
    expect(() => store.applyEvents([stale], new Map([[stale.eventId, reviewAuthority]]))).toThrowError(/stale attention revision/);

    const { humanReview: ignored, ...withoutReview } = reclassifiedPayload;
    void ignored;
    const changedClassWithoutReview: TMissionProducerEvent = {
      ...opened, eventId: 'event-reclassify-unreviewed', type: 'attention.updated', expectedRevision: 2,
      payload: { ...withoutReview, class: 'money' },
    };
    expect(() => store.applyEvents([changedClassWithoutReview])).toThrowError(/renewed orchestrator review/);

    const unchangedWithoutReview: TMissionProducerEvent = {
      ...opened, eventId: 'event-reclassify-unchanged', type: 'attention.updated', expectedRevision: 2,
      payload: withoutReview,
    };
    store.applyEvents([unchangedWithoutReview]);
    expect(store.snapshot().items[0]).toMatchObject({ revision: 3, state: 'open', class: 'bookkeeping', defaultOptionId: 'direct' });

    const declassified: TMissionProducerEvent = {
      ...opened, eventId: 'event-declassify', type: 'attention.updated', expectedRevision: 3,
      payload: { itemId: 'item-a', ...question, humanReview },
    };
    store.applyEvents([declassified], new Map([[declassified.eventId, reviewAuthority]]));
    expect(store.snapshot().items[0]).toMatchObject({ revision: 4, class: null, defaultOptionId: null });
    store.close();
  });

  it('keeps SCHEMA_VERSION 4 and the schema-4 DDL unchanged after classified items are written', () => {
    const plainFile = databasePath();
    const plain = new MissionControlStore(plainFile);
    plain.close();
    const classifiedFile = databasePath();
    const store = new MissionControlStore(classifiedFile);
    seedRun(store);
    openClassified(store, classifiedOpen('item-a', { class: 'money', defaultOptionId: 'gradual' }));
    answer(store, 'item-a');
    store.snapshot();
    store.close();

    const ddl = (file: string) => {
      const database = new Database(file, { readonly: true });
      const version = database.pragma('user_version', { simple: true });
      const schema = database.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      database.close();
      return { version, schema };
    };
    expect(ddl(classifiedFile)).toEqual(ddl(plainFile));
    expect(ddl(classifiedFile).version).toBe(4);
  });

  it('opens a classified database with the pre-story read path: the plain question_json spread', () => {
    const file = databasePath();
    const store = new MissionControlStore(file);
    seedRun(store);
    openClassified(store, classifiedOpen('item-a', { class: 'bookkeeping', defaultOptionId: 'gradual' }));
    store.close();
    // The 882190ab release reads every attention_items row with SELECT * and spreads question_json;
    // the release check itself runs at /dod against the built release.
    const raw = new Database(file, { readonly: true });
    const rows = raw.prepare('SELECT * FROM attention_items').all() as Array<{ question_json: string }>;
    expect(rows.map((row) => ({ ...JSON.parse(row.question_json) }))[0]).toMatchObject({ ...question, class: 'bookkeeping' });
    raw.close();
  });

  it('counts answers per UTC day, class and actor kind over the last 7 days', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const today = Date.UTC(2026, 9, 27, 12, 0, 0);
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const opens: Array<[string, Partial<{ class: 'money' | 'irreversible' | 'scope' | 'bookkeeping'; defaultOptionId: string }>]> = [
      ['too-old', { class: 'money' }],
      ['just-before-window', { class: 'money' }],
      ['oldest-in-window', { class: 'money' }],
      ['money-today', { class: 'money' }],
      ['book-human', { class: 'bookkeeping', defaultOptionId: 'gradual' }],
      ['book-rule', { class: 'bookkeeping', defaultOptionId: 'gradual' }],
      ['plain', {}],
      ['open-only', { class: 'scope' }],
    ];
    vi.setSystemTime(today - 8 * DAY);
    for (const [itemId, over] of opens) openClassified(store, classifiedOpen(itemId, over));
    answer(store, 'too-old');
    vi.setSystemTime(Date.parse('2026-10-20T23:59:59.999Z'));
    answer(store, 'just-before-window');
    vi.setSystemTime(Date.parse('2026-10-21T00:00:00.000Z'));
    answer(store, 'oldest-in-window');
    vi.setSystemTime(today);
    answer(store, 'money-today');
    answer(store, 'book-human');
    store.submitSystemAnswer('book-rule', 1, { minutes: 1, version: 1 }, today);
    answer(store, 'plain');

    expect(store.snapshot().answersByClass).toEqual([
      { day: '2026-10-21', class: 'money', by: 'human', count: 1 },
      { day: '2026-10-27', class: 'money', by: 'human', count: 1 },
      { day: '2026-10-27', class: 'bookkeeping', by: 'human', count: 1 },
      { day: '2026-10-27', class: 'bookkeeping', by: 'rule', count: 1 },
      { day: '2026-10-27', class: 'unclassified', by: 'human', count: 1 },
    ]);
    expect(store.snapshot([], 'ws-other').answersByClass).toEqual([]);
    expect(store.snapshot([], 'ws-a').answersByClass).toHaveLength(5);
    store.close();
  });

  it('serves an empty answersByClass, not an absent one, when nothing was answered', () => {
    const store = new MissionControlStore(databasePath());
    seed(store);
    expect(store.snapshot().answersByClass).toEqual([]);
    store.close();
  });
});

// vel-MC-ACT, the owner's recurrence: an owner action the orchestrator opened without a human review was stored as a
// candidate, so it never reached the owner's Needs you list although it was "open" work. The configured orchestrator's
// own action is now stamped external-action and opens; anyone else's action stays a candidate for its review.
describe('MissionControlStore: an owner action opened without a human review (vel-MC-ACT)', () => {
  const action: IMissionQuestion = {
    kind: 'action',
    title: 'Rotate the deploy token',
    context: 'The token expires on Friday; only the owner can issue a new one.',
    storyIds: [],
    options: [],
    recommendation: null,
    blockingScope: 'run',
    canContinue: false,
  };
  const openAction = (eventId: string, itemId: string): TMissionProducerEvent => ({
    ...openEvent(eventId),
    payload: { itemId, ...action },
  });

  it('opened by the configured orchestrator: open, stamped external-action, in the owner\'s inbox and the open count', async () => {
    const { isMissionHumanInboxItem } = await import('@/components/features/mission-control/mission-control-utils');
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const opened = openAction('event-action', 'item-action');
    store.applyEvents([opened], new Map([[opened.eventId, { ...reviewAuthority, opener: { tabId: binding.tabId, identity: 'launch' as const } }]]));

    const item = store.snapshot().items.find((entry) => entry.id === 'item-action')!;
    expect(item.state).toBe('open');
    expect(item.candidateReason).toBeNull();
    expect(item.humanReview).toMatchObject({
      humanNeed: 'external-action',
      reviewerTabId: binding.tabId,
      humanReason: expect.stringContaining('Rotate the deploy token'),
      eventId: 'event-action',
    });
    expect(isMissionHumanInboxItem(item)).toBe(true);
    expect(store.latestOwnerItemBefore('ws-a', Date.now() + 1)).toBe('item-action');
  });

  it('opened by any other tab: still a candidate for the orchestrator to review, never stamped', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const opened = openAction('event-worker-action', 'item-worker-action');
    store.applyEvents([opened], new Map([[opened.eventId, {
      resolvedIdentity: observedIdentity('worker'), configuredOrchestratorTabId: binding.tabId, opener: { tabId: 'tab-worker', identity: 'launch' as const },
    }]]));
    const item = store.snapshot().items.find((entry) => entry.id === 'item-worker-action')!;
    expect(item.state).toBe('candidate');
    expect(item.humanReview).toBeNull();
  });

  it('the orchestrator\'s identity without the orchestrator as opener, or the opener named with another identity: a candidate', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const noOpener = openAction('event-no-opener', 'item-no-opener');
    store.applyEvents([noOpener], new Map([[noOpener.eventId, reviewAuthority]]));
    const spoofed = openAction('event-spoofed', 'item-spoofed');
    store.applyEvents([spoofed], new Map([[spoofed.eventId, {
      resolvedIdentity: observedIdentity('worker'), configuredOrchestratorTabId: binding.tabId, opener: { tabId: binding.tabId, identity: 'launch' as const },
    }]]));
    const states = store.snapshot().items.filter((entry) => entry.id === 'item-no-opener' || entry.id === 'item-spoofed').map((entry) => entry.state);
    expect(states).toEqual(['candidate', 'candidate']);
  });

  it('with no configured orchestrator: a candidate, as before', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const opened = openAction('event-no-orch', 'item-no-orch');
    store.applyEvents([opened], new Map([[opened.eventId, identity]]));
    expect(store.snapshot().items.find((entry) => entry.id === 'item-no-orch')!.state).toBe('candidate');
  });

  it('a question with no review is untouched: it stays a candidate', () => {
    const store = new MissionControlStore(databasePath());
    seedRun(store);
    const opened: TMissionProducerEvent = { ...openEvent('event-q'), payload: { itemId: 'item-q', ...question } };
    store.applyEvents([opened], new Map([[opened.eventId, reviewAuthority]]));
    expect(store.snapshot().items.find((entry) => entry.id === 'item-q')!.state).toBe('candidate');
  });
});
