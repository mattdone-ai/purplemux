import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionControlError } from '@/lib/mission-control-errors';
import { MissionControlStore } from '@/lib/mission-control-store';
import { MISSION_AUTO_ANSWER_ACTOR } from '@/lib/attention-class';
import {
  AUTO_ANSWER_KEY,
  autoAnswerNote,
  autoAnswerRefusal,
  autoAnswerSubmissionId,
  parseAutoAnswerMinutes,
} from '@/lib/mission-control-auto-answer';
import {
  readAutoAnswerRule,
  runAutoAnswerPass,
  startAutoAnswerTick,
  stopAutoAnswerTick,
  type IAutoAnswerDeps,
} from '@/lib/mission-control-auto-answer-tick';
import type {
  IMissionAttentionItem,
  IMissionBinding,
  IMissionQuestion,
  TAttentionClass,
  TMissionProducerEvent,
} from '@/types/mission-control';

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: log.info, warn: log.warn, error: log.error, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 27, 8, 0, 0);
const scratch: string[] = [];
const stores: MissionControlStore[] = [];

const binding: IMissionBinding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', generation: 1, runtimeGeneration: 'launch-1' };
const identity = { tabId: binding.tabId, providerId: binding.providerId, sessionId: binding.sessionId, runtimeGeneration: binding.runtimeGeneration };
const authority = { resolvedIdentity: identity, configuredOrchestratorTabId: binding.tabId };

const question: IMissionQuestion = {
  kind: 'question',
  title: 'Raise the turn budget?',
  context: 'The run needs 20 more turns.',
  storyIds: [],
  options: [{ id: 'raise', label: 'Raise by 20' }, { id: 'stop', label: 'Stop the run' }],
  recommendation: null,
  blockingScope: 'story',
  canContinue: true,
};
const review = {
  humanNeed: 'approval' as const,
  humanReason: 'Budget raises are the owner\'s call.',
  handling: 'The orchestrator checked the budget.',
  reviewerTabId: binding.tabId,
};
const rule = { minutes: 30, version: 3 };

const databasePath = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-auto-answer-'));
  scratch.push(directory);
  return path.join(directory, 'mission.sqlite');
};

const openStore = (file = databasePath()): MissionControlStore => {
  const store = new MissionControlStore(file);
  stores.push(store);
  return store;
};

const event = (over: Partial<TMissionProducerEvent> & Pick<TMissionProducerEvent, 'type' | 'payload'>): TMissionProducerEvent => ({
  eventId: `e-${Math.random().toString(36).slice(2)}`,
  schemaVersion: 1,
  workspaceId: 'ws-a',
  runId: 'run-a',
  expectedRevision: 0,
  producerAt: T0,
  bindingGeneration: 1,
  ...over,
} as TMissionProducerEvent);

const seedRun = (store: MissionControlStore): void => {
  const start = event({ type: 'run.started', bindingGeneration: 0, payload: { objective: 'Ship', tabId: binding.tabId } });
  store.applyEvents([start], new Map([[start.eventId, identity]]));
};

const openItem = (
  store: MissionControlStore,
  itemId: string,
  over: Partial<IMissionQuestion> & { class?: TAttentionClass; defaultOptionId?: string; humanNeed?: 'none' | 'approval' } = {},
): void => {
  const { humanNeed = 'approval', ...payloadOver } = over;
  const humanReview = humanNeed === 'none'
    ? { humanNeed: 'none' as const, handling: 'The workspace handles it.', reviewerTabId: binding.tabId }
    : review;
  const opened = event({ type: 'attention.opened', payload: { itemId, ...question, ...payloadOver, humanReview } });
  store.applyEvents([opened], new Map([[opened.eventId, authority]]));
};

const bookkeeping = { class: 'bookkeeping' as const, defaultOptionId: 'raise' };

const item = (over: Partial<IMissionAttentionItem> = {}): IMissionAttentionItem => ({
  id: 'item-a',
  workspaceId: 'ws-a',
  runId: 'run-a',
  revision: 1,
  state: 'open',
  ...question,
  evidence: { source: 'agent', sourceId: 'e-1', observedAt: T0, confidence: 'confirmed' },
  answerId: null,
  resolution: null,
  humanReview: { ...review, binding, eventId: 'e-1', reviewedAt: T0 },
  candidateReason: null,
  class: 'bookkeeping',
  defaultOptionId: 'raise',
  autoAnswer: null,
  evidenceLinks: [],
  lint: [],
  changes: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  log.warn.mockClear();
  log.info.mockClear();
  log.error.mockClear();
});

afterEach(async () => {
  await stopAutoAnswerTick();
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
  for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('parseAutoAnswerMinutes: unset or invalid is off', () => {
  it.each([
    [null, null, false],
    ['1', 1, false],
    ['10080', 10_080, false],
    [' 45 ', 45, false],
    ['0', null, true],
    ['10081', null, true],
    ['-5', null, true],
    ['1.5', null, true],
    ['soon', null, true],
    ['', null, true],
  ])('%j reads as %j', (raw, minutes, logged) => {
    const parsed = parseAutoAnswerMinutes(raw);
    expect(parsed.minutes).toBe(minutes);
    expect(parsed.reason !== null).toBe(logged);
    if (logged) expect(parsed.reason).toContain(AUTO_ANSWER_KEY);
  });
});

describe('autoAnswerRefusal: the eligibility truth table (ADR-0031 §5)', () => {
  const old = T0 + 30 * MINUTE;

  it('answers only an open, reviewed, bookkeeping question with a current default at least N minutes old', () => {
    expect(autoAnswerRefusal(item(), rule, old)).toBeNull();
  });

  it.each(['money', 'irreversible', 'scope'] as const)('never answers a %s item', (attentionClass) => {
    expect(autoAnswerRefusal(item({ class: attentionClass }), rule, old + 1_000 * MINUTE)).toMatch(/bookkeeping/);
  });

  it('never answers an unclassified item', () => {
    expect(autoAnswerRefusal(item({ class: null }), rule, old + 1_000 * MINUTE)).toMatch(/bookkeeping/);
  });

  it('never answers an item without a stated default, or with a default no option carries', () => {
    expect(autoAnswerRefusal(item({ defaultOptionId: null }), rule, old)).toMatch(/default/);
    expect(autoAnswerRefusal(item({ defaultOptionId: 'gone' }), rule, old)).toMatch(/default/);
  });

  it('never answers an action item', () => {
    expect(autoAnswerRefusal(item({ kind: 'action', options: [] }), rule, old)).toMatch(/action/);
  });

  it.each([
    ['humanNeed none', { humanReview: { humanNeed: 'none' as const, handling: 'h', reviewerTabId: 't', binding, eventId: 'e', reviewedAt: T0 } }],
    ['no review', { humanReview: null }],
  ])('never answers an item with %s', (_case, over) => {
    expect(autoAnswerRefusal(item(over), rule, old)).toMatch(/human answer/);
  });

  it.each(['candidate', 'answered', 'resolved', 'cancelled'] as const)('never answers a %s item', (state) => {
    expect(autoAnswerRefusal(item({ state }), rule, old)).toMatch(/no longer open/);
  });

  it('counts age from the last revision: one millisecond short of N minutes waits', () => {
    expect(autoAnswerRefusal(item({ createdAt: T0 - 1_000 * MINUTE }), rule, old - 1)).toMatch(/younger/);
    expect(autoAnswerRefusal(item({ createdAt: T0 - 1_000 * MINUTE }), rule, old)).toBeNull();
  });
});

describe('autoAnswerNote', () => {
  it('is the exact Q2 text', () => {
    expect(autoAnswerNote({ minutes: 30, version: 3 }, Date.UTC(2026, 9, 27, 8, 30, 0), 'Raise by 20')).toBe(
      'Auto-answered under fleet config attention.auto-answer.bookkeeping-minutes=30 (version 3) at 2026-10-27T08:30:00.000Z: applied the stated default "Raise by 20".',
    );
  });
});

describe('MissionControlStore.submitSystemAnswer', () => {
  const at = T0 + 30 * MINUTE;

  it('records the default as the system actor, with the note as the answer text and on the item', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    vi.setSystemTime(at);

    const result = store.submitSystemAnswer('item-a', 1, rule, at);

    const note = autoAnswerNote(rule, at, 'Raise by 20');
    expect(result.replayed).toBe(false);
    expect(result.answer).toMatchObject({
      actor: MISSION_AUTO_ANSWER_ACTOR,
      submissionId: autoAnswerSubmissionId('item-a', 1),
      expectedRevision: 1,
      optionIds: ['raise'],
      text: note,
      actionCompleted: false,
    });
    expect(result.item).toMatchObject({
      state: 'answered',
      revision: 2,
      answerId: result.answer.id,
      autoAnswer: { rule: AUTO_ANSWER_KEY, ruleVersion: 3, appliedOptionId: 'raise', at, note },
    });
    expect(result.delivery).toMatchObject({ state: 'queued', binding });
    expect(store.listDueDeliveries(at, 10).map((delivery) => delivery.id)).toEqual([result.delivery.id]);
  });

  it('names the system actor on the answer.recorded event', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    const result = store.submitSystemAnswer('item-a', 1, rule, at);
    const recorded = store.snapshot().recentEvents.filter((entry) => entry.type === 'answer.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].payload).toEqual({ answerId: result.answer.id, submissionId: 'auto:item-a:1', expectedRevision: 1,
      appliedRevision: 1, actor: MISSION_AUTO_ANSWER_ACTOR });
  });

  it('writes the side-table row in the answer\'s transaction, with SCHEMA_VERSION 4 and no new column', () => {
    const file = databasePath();
    const store = openStore(file);
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    const result = store.submitSystemAnswer('item-a', 1, rule, at);
    store.close();
    stores.pop();

    const raw = new Database(file, { readonly: true });
    expect(raw.pragma('user_version', { simple: true })).toBe(4);
    expect((raw.prepare('PRAGMA table_info(attention_items)').all() as Array<{ name: string }>).map((c) => c.name)).toEqual([
      'id', 'workspace_id', 'run_id', 'revision', 'state', 'question_json', 'evidence_json', 'answer_id', 'resolution',
      'created_at', 'updated_at', 'source_key', 'human_review_json', 'candidate_reason',
    ]);
    expect(raw.prepare('SELECT * FROM mission_auto_answers').all()).toEqual([{
      answer_id: result.answer.id,
      item_id: 'item-a',
      workspace_id: 'ws-a',
      rule: AUTO_ANSWER_KEY,
      rule_version: 3,
      applied_option_id: 'raise',
      at,
      note: autoAnswerNote(rule, at, 'Raise by 20'),
    }]);
    raw.close();
  });

  it('a second call for the same revision replays: one answer, one record', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    const first = store.submitSystemAnswer('item-a', 1, rule, at);
    const second = store.submitSystemAnswer('item-a', 1, rule, at + MINUTE);
    expect(second.replayed).toBe(true);
    expect(second.answer.id).toBe(first.answer.id);
    expect(store.snapshot().answers).toHaveLength(1);
    expect(store.snapshot().autoAnswered).toHaveLength(1);
  });

  it.each([
    ['a money item', { class: 'money' as const, defaultOptionId: 'raise' }],
    ['an unclassified item', { defaultOptionId: 'raise' }],
    ['an item without a default', { class: 'bookkeeping' as const }],
    ['an item the workspace handles', { ...bookkeeping, humanNeed: 'none' as const }],
  ])('refuses %s with 409 and records nothing', (_case, over) => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', over);
    expect(() => store.submitSystemAnswer('item-a', 1, rule, at)).toThrow(MissionControlError);
    expect(store.snapshot().answers).toHaveLength(0);
    expect(store.snapshot().autoAnswered).toEqual([]);
  });

  it('refuses an item younger than N minutes', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    expect(() => store.submitSystemAnswer('item-a', 1, rule, at - 1)).toThrow(/younger/);
  });

  it('a human answer that came first wins; the rule gets 409 and records nothing', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    store.submitAnswer('item-a', { submissionId: 'human-1', expectedRevision: 1, optionIds: ['stop'], text: '', actionCompleted: false }, 'owner');
    expect(() => store.submitSystemAnswer('item-a', 1, rule, at)).toThrow(expect.objectContaining({ status: 409, code: 'conflict' }));
    const snapshot = store.snapshot();
    expect(snapshot.answers.map((answer) => answer.actor)).toEqual(['owner']);
    expect(snapshot.items[0].autoAnswer).toBeNull();
    expect(snapshot.autoAnswered).toEqual([]);
  });

  it('a cancel that came first wins', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    const cancel = event({ type: 'attention.cancelled', expectedRevision: 1, payload: { itemId: 'item-a', reason: 'no longer needed' } });
    store.applyEvents([cancel], new Map([[cancel.eventId, authority]]));
    expect(() => store.submitSystemAnswer('item-a', 1, rule, at)).toThrow(expect.objectContaining({ status: 409 }));
    expect(store.snapshot().answers).toHaveLength(0);
  });

  it('a race at one revision leaves exactly one answer; the human loser gets the existing 409', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    store.submitSystemAnswer('item-a', 1, rule, at);
    expect(() => store.submitAnswer('item-a', { submissionId: 'human-1', expectedRevision: 1, optionIds: ['stop'], text: '', actionCompleted: false }, 'owner'))
      .toThrow(expect.objectContaining({ status: 409, code: 'conflict', message: 'attention item is no longer open' }));
    expect(store.snapshot().answers.map((answer) => answer.actor)).toEqual([MISSION_AUTO_ANSWER_ACTOR]);
  });

  it('a re-asked question carries a new revision: the read revision is stale and the rule waits again', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    vi.setSystemTime(at);
    const update = event({ type: 'attention.updated', expectedRevision: 1, payload: { itemId: 'item-a', ...question, ...bookkeeping, context: 'Now 40 turns.', humanReview: review } });
    store.applyEvents([update], new Map([[update.eventId, authority]]));
    expect(() => store.submitSystemAnswer('item-a', 1, rule, at)).toThrow(/stale attention revision/);
    expect(() => store.submitSystemAnswer('item-a', 2, rule, at + 29 * MINUTE)).toThrow(/younger/);
    expect(store.submitSystemAnswer('item-a', 2, rule, at + 30 * MINUTE).answer.submissionId).toBe('auto:item-a:2');
  });
});

describe('MissionControlStore.submitAnswer: a human can never carry the system actor (ADR-0031 §8)', () => {
  it.each([MISSION_AUTO_ANSWER_ACTOR, 'system:anything'])('refuses actor %s with 403 and records nothing', (actor) => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    expect(() => store.submitAnswer('item-a', { submissionId: 'h-1', expectedRevision: 1, optionIds: ['raise'], text: '', actionCompleted: false }, actor))
      .toThrow(expect.objectContaining({ status: 403, code: 'forbidden' }));
    expect(store.snapshot().answers).toHaveLength(0);
  });

  it('counts a human answer as human in answersByClass, and a rule answer as rule', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    openItem(store, 'item-b', bookkeeping);
    store.submitAnswer('item-a', { submissionId: 'h-1', expectedRevision: 1, optionIds: ['raise'], text: '', actionCompleted: false }, 'owner');
    vi.setSystemTime(T0 + 30 * MINUTE);
    store.submitSystemAnswer('item-b', 1, rule, T0 + 30 * MINUTE);
    expect(store.snapshot().answersByClass).toEqual([
      { day: '2026-10-27', class: 'bookkeeping', by: 'human', count: 1 },
      { day: '2026-10-27', class: 'bookkeeping', by: 'rule', count: 1 },
    ]);
  });
});

describe('snapshot.autoAnswered', () => {
  it('lists the rule\'s answers newest first with the item\'s current state, and each item carries autoAnswer', () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-a', bookkeeping);
    openItem(store, 'item-b', { ...bookkeeping, title: 'Rotate the log?', options: [{ id: 'rotate', label: 'Rotate now' }], defaultOptionId: 'rotate' });
    openItem(store, 'item-c', bookkeeping);
    const firstAt = T0 + 30 * MINUTE;
    vi.setSystemTime(firstAt);
    store.submitSystemAnswer('item-a', 1, rule, firstAt);
    vi.setSystemTime(firstAt + MINUTE);
    store.submitSystemAnswer('item-b', 1, rule, firstAt + MINUTE);

    const snapshot = store.snapshot();
    expect(snapshot.autoAnswered).toEqual([
      {
        itemId: 'item-b', workspaceId: 'ws-a', runId: 'run-a', title: 'Rotate the log?', class: 'bookkeeping',
        appliedOptionId: 'rotate', appliedOptionLabel: 'Rotate now', at: firstAt + MINUTE,
        note: autoAnswerNote(rule, firstAt + MINUTE, 'Rotate now'), itemState: 'answered',
      },
      expect.objectContaining({ itemId: 'item-a', appliedOptionLabel: 'Raise by 20', at: firstAt }),
    ]);
    const byId = new Map(snapshot.items.map((entry) => [entry.id, entry]));
    expect(byId.get('item-a')?.autoAnswer).toMatchObject({ appliedOptionId: 'raise', at: firstAt });
    expect(byId.get('item-c')?.autoAnswer).toBeNull();
  });

  it('keeps 7 days, filters by workspace, and caps at 100', () => {
    const store = openStore();
    seedRun(store);
    for (let index = 0; index < 102; index += 1) openItem(store, `item-${index}`, bookkeeping);
    const base = T0 + 30 * MINUTE;
    store.submitSystemAnswer('item-0', 1, rule, base);
    for (let index = 1; index < 102; index += 1) store.submitSystemAnswer(`item-${index}`, 1, rule, base + 8 * 86_400_000 + index);
    vi.setSystemTime(base + 8 * 86_400_000 + 200);

    const all = store.snapshot().autoAnswered ?? [];
    expect(all).toHaveLength(100);
    expect(all[0].itemId).toBe('item-101');
    expect(all.some((entry) => entry.itemId === 'item-0')).toBe(false);
    expect(store.snapshot([], 'ws-other').autoAnswered).toEqual([]);
    expect(store.snapshot([], 'ws-a').autoAnswered).toHaveLength(100);
  });
});

describe('readAutoAnswerRule', () => {
  it('is off when unset, and off (logged once) when invalid', async () => {
    expect(await readAutoAnswerRule(async () => null)).toBeNull();
    const invalid = { value: 'soon', version: 2, setAt: T0, setBy: { workspaceId: null, tabId: null, admin: true } };
    expect(await readAutoAnswerRule(async () => invalid)).toBeNull();
    expect(await readAutoAnswerRule(async () => invalid)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toContain('not an integer');
  });

  it('carries the minutes and the fleet-config version', async () => {
    const value = { value: '30', version: 7, setAt: T0, setBy: { workspaceId: null, tabId: null, admin: true } };
    expect(await readAutoAnswerRule(async () => value)).toEqual({ minutes: 30, version: 7 });
  });

  it('is off, and logged, when the fleet config cannot be read', async () => {
    expect(await readAutoAnswerRule(async () => { throw new Error('fleet-config.json is unreadable'); })).toBeNull();
    expect(log.warn.mock.calls.at(-1)?.[0]).toContain('unreadable');
  });
});

describe('runAutoAnswerPass', () => {
  const deps = (store: MissionControlStore, over: Partial<IAutoAnswerDeps> = {}): IAutoAnswerDeps & { audit: ReturnType<typeof vi.fn> } => ({
    store: () => store,
    readRule: async () => rule,
    audit: vi.fn(async () => {}),
    now: () => Date.now(),
    ...over,
  } as IAutoAnswerDeps & { audit: ReturnType<typeof vi.fn> });

  const seedMixed = (store: MissionControlStore): void => {
    seedRun(store);
    openItem(store, 'item-book', bookkeeping);
    openItem(store, 'item-money', { class: 'money', defaultOptionId: 'raise' });
    openItem(store, 'item-irrev', { class: 'irreversible', defaultOptionId: 'raise' });
    openItem(store, 'item-scope', { class: 'scope', defaultOptionId: 'raise' });
    openItem(store, 'item-none', { defaultOptionId: 'raise' });
    openItem(store, 'item-nodefault', { class: 'bookkeeping' });
    openItem(store, 'item-workspace', { ...bookkeeping, humanNeed: 'none' });
  };

  it('with the rule unset, answers nothing however old the items are', async () => {
    const store = openStore();
    seedMixed(store);
    vi.setSystemTime(T0 + 100 * 86_400_000);
    const d = deps(store, { readRule: async () => null });
    expect(await runAutoAnswerPass(d)).toEqual([]);
    expect(store.snapshot().answers).toHaveLength(0);
    expect(d.audit).not.toHaveBeenCalled();
  });

  it('before N minutes answers nothing', async () => {
    const store = openStore();
    seedMixed(store);
    vi.setSystemTime(T0 + 30 * MINUTE - 1);
    expect(await runAutoAnswerPass(deps(store))).toEqual([]);
  });

  it('answers only the bookkeeping item with a default; every other item stays open in "Needs you"', async () => {
    const store = openStore();
    seedMixed(store);
    vi.setSystemTime(T0 + 30 * MINUTE);
    const d = deps(store);
    const outcomes = await runAutoAnswerPass(d);
    expect(outcomes.map((outcome) => outcome.itemId)).toEqual(['item-book']);
    const states = Object.fromEntries(store.snapshot().items.map((entry) => [entry.id, entry.state]));
    expect(states).toEqual({
      'item-book': 'answered',
      'item-money': 'open',
      'item-irrev': 'open',
      'item-scope': 'open',
      'item-none': 'open',
      'item-nodefault': 'open',
      'item-workspace': 'candidate',
    });
    expect(d.audit).toHaveBeenCalledTimes(1);
    expect(d.audit).toHaveBeenCalledWith({
      event: 'attention-auto-answer',
      itemId: 'item-book',
      workspaceId: 'ws-a',
      rule: AUTO_ANSWER_KEY,
      ruleVersion: 3,
      optionId: 'raise',
      ageMs: 30 * MINUTE,
    });
  });

  it('after a restart (a new store on the same file) answers no item twice', async () => {
    const file = databasePath();
    const first = openStore(file);
    seedMixed(first);
    vi.setSystemTime(T0 + 30 * MINUTE);
    await runAutoAnswerPass(deps(first));
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const second = openStore(file);
    vi.setSystemTime(T0 + 90 * MINUTE);
    const d = deps(second);
    expect(await runAutoAnswerPass(d)).toEqual([]);
    expect(second.snapshot().answers).toHaveLength(1);
    expect(d.audit).not.toHaveBeenCalled();
  });

  it('a conflict on one item (a human won) skips it and the pass goes on', async () => {
    const store = openStore();
    seedRun(store);
    openItem(store, 'item-1', bookkeeping);
    openItem(store, 'item-2', bookkeeping);
    vi.setSystemTime(T0 + 30 * MINUTE);
    const racing: IAutoAnswerDeps['store'] = () => ({
      listAutoAnswerCandidates: () => store.listAutoAnswerCandidates(),
      submitSystemAnswer: (itemId, revision, r, now) => {
        if (itemId === 'item-1') {
          store.submitAnswer('item-1', { submissionId: 'human', expectedRevision: 1, optionIds: ['stop'], text: '', actionCompleted: false }, 'owner');
        }
        return store.submitSystemAnswer(itemId, revision, r, now);
      },
    });
    const outcomes = await runAutoAnswerPass(deps(store, { store: racing }));
    expect(outcomes.map((outcome) => outcome.itemId)).toEqual(['item-2']);
    expect(store.snapshot().answers.map((answer) => [answer.itemId, answer.actor]).sort()).toEqual([
      ['item-1', 'owner'], ['item-2', MISSION_AUTO_ANSWER_ACTOR],
    ]);
  });
});

describe('the tick: once per process, on globalThis', () => {
  it('starts one interval however often it is started, and stops in shutdown', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const pass = vi.fn(async () => []);
    startAutoAnswerTick(pass);
    startAutoAnswerTick(pass);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0][1]).toBe(60_000);
    expect((globalThis as unknown as { __ptAutoAnswerTick?: unknown }).__ptAutoAnswerTick).toBeDefined();
    await stopAutoAnswerTick();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect((globalThis as unknown as { __ptAutoAnswerTick?: unknown }).__ptAutoAnswerTick).toBeUndefined();
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });

  it('runs a pass each interval, never two at once, and logs a failed pass', async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const pass = vi.fn(() => new Promise<never[]>((resolve) => { release = () => resolve([]); }));
    startAutoAnswerTick(pass);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pass).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pass).toHaveBeenCalledTimes(2);
    release();
    pass.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.error).toHaveBeenCalled();
    await stopAutoAnswerTick();
  });
});

describe('server wiring (pinned in server.ts)', () => {
  it('starts the tick beside the Mission Control runtime and stops it in shutdownWs', () => {
    const server = fs.readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8');
    const boot = server.slice(server.indexOf('await getMissionControlRuntime().start();'));
    expect(boot.indexOf('startAutoAnswerTick();')).toBeGreaterThan(-1);
    expect(boot.indexOf('startAutoAnswerTick();')).toBeLessThan(boot.indexOf('await startSpend();'));
    const shutdown = server.slice(server.indexOf('const shutdownWs = async'), server.indexOf('// --- Production'));
    expect(shutdown.indexOf('await stopAutoAnswerTick();')).toBeGreaterThan(-1);
    expect(shutdown.indexOf('await stopAutoAnswerTick();')).toBeLessThan(shutdown.indexOf('await getMissionControlRuntime().stop();'));
  });
});
