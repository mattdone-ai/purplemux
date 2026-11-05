import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTENTION_ALERT_MEMORY,
  createAttentionAlertState,
  attentionTransition,
  dispatchAttentionOpenedAlerts,
  openedForHuman,
} from '@/lib/attention-alerts';
import type { IAttentionAlertDeps, IAttentionAlertState } from '@/lib/attention-alerts';
import type { TAlertDraft } from '@/lib/alert-policy';
import { validateMissionQuestion } from '@/lib/mission-question-format';
import { MissionControlStore } from '@/lib/mission-control-store';
import type { IMissionEvent, TMissionHumanReviewInput, TMissionItemState, TMissionProducerEvent } from '@/types/mission-control';
import type { ITab, IWorkspace } from '@/types/terminal';

// An item opened for the human (humanNeed is not `none`) sends one `attention-opened` alert that
// names the item. The events come from a real store, so the payload shape is the committed one.

const binding = { tabId: 'tab-orch', providerId: 'claude' as const, sessionId: 'session-1', runtimeGeneration: 'launch-1' };
const authority = { resolvedIdentity: binding, configuredOrchestratorTabId: binding.tabId };
const base = { schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', producerAt: 1_700_000_000_000 };
const question = {
  kind: 'question' as const, title: '  Raise the budget for lane H-3?  ', context: 'More turns.', storyIds: [],
  options: [{ id: 'raise', label: 'Raise' }, { id: 'stop', label: 'Stop' }], recommendation: null,
  blockingScope: 'story' as const, canContinue: true,
};
const needsOwner: TMissionHumanReviewInput = { humanNeed: 'decision', humanReason: 'Owner call.', handling: 'Checked.', reviewerTabId: binding.tabId };
const noOwner: TMissionHumanReviewInput = { humanNeed: 'none', handling: 'SM handles it.', reviewerTabId: binding.tabId };

const workspace: IWorkspace = {
  id: 'ws-a', name: 'Treasury v2', directories: ['/tmp/ws-a'],
  orchestration: { enabled: true, orchestratorTabId: 'tab-orch' },
} as IWorkspace;
const tabs: Record<string, ITab> = {
  'tab-orch': { id: 'tab-orch', sessionName: 's-orch', name: 'orchestrator', order: 0, panelType: 'claude-code' },
  'tab-sm': { id: 'tab-sm', sessionName: 's-sm', name: 'scrum master', order: 1, panelType: 'codex-cli' },
};

let directory = '';
let store: MissionControlStore;
let state: IAttentionAlertState;
let sent: Array<{ draft: TAlertDraft; workspaceDir: string | null | undefined }>;

const deps = (overrides: Partial<IAttentionAlertDeps> = {}): IAttentionAlertDeps => ({
  workspace: async (id) => (id === 'ws-a' ? workspace : null),
  findTab: async (_ws, tabId) => tabs[tabId] ?? null,
  providerOf: async (tab) => (tab.panelType === 'codex-cli' ? 'codex' : 'claude'),
  dispatch: async (draft, ctx) => { sent.push({ draft, workspaceDir: ctx.workspaceDir }); },
  ...overrides,
});

const open = (eventId: string, itemId: string, humanReview?: TMissionHumanReviewInput): Extract<TMissionProducerEvent, { type: 'attention.opened' }> => ({
  ...base, eventId, expectedRevision: 0, bindingGeneration: 1, type: 'attention.opened',
  payload: { itemId, ...question, ...(humanReview ? { humanReview } : {}) },
});

type TApplied = { events: IMissionEvent[]; fresh: Set<string>; previousStates: Map<string, TMissionItemState> };

/** As the events route does it: the touched items' states are read before the batch applies. */
const apply = (events: TMissionProducerEvent[]): TApplied => {
  const fresh = store.unreplayedEventIds(events);
  const previousStates = store.itemStates(events.flatMap((e) => ('itemId' in e.payload && typeof e.payload.itemId === 'string' ? [e.payload.itemId] : [])));
  const map = new Map(events.map((e) => [e.eventId, authority]));
  return { events: store.applyEvents(events, map).events, fresh, previousStates };
};

const run = (applied: TApplied, openerTabId: string | null = null, d = deps()) =>
  dispatchAttentionOpenedAlerts({ ...applied, openerTabId }, d, state);

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-attention-alerts-'));
  store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  const start: TMissionProducerEvent = { ...base, eventId: 'e-start', expectedRevision: 0, bindingGeneration: 0, type: 'run.started', payload: { objective: 'Ship', tabId: binding.tabId } };
  store.applyEvents([start], new Map([[start.eventId, binding]]));
  state = createAttentionAlertState();
  sent = [];
});

afterEach(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('dispatchAttentionOpenedAlerts', () => {
  it('sends one attention-opened alert naming the item, its trimmed title and the opening tab', async () => {
    const drafts = await run(apply([open('e-1', 'item-1', needsOwner)]), 'tab-sm');

    expect(drafts).toHaveLength(1);
    expect(sent).toEqual([{
      draft: {
        kind: 'attention-opened',
        itemId: 'item-1',
        title: 'Mission Control: answer needed',
        body: 'Raise the budget for lane H-3?',
        tabId: 'tab-sm',
        tabName: 'scrum master',
        providerId: 'codex',
        isOrchestrator: false,
        workspaceId: 'ws-a',
        workspaceName: 'Treasury v2',
        at: expect.any(Number),
        question: {
          formatVersion: 1, decision: 'Raise the budget for lane H-3?', answerType: 'multi', revision: 1,
          options: [{ id: 'raise', label: 'Raise', needsText: false }, { id: 'stop', label: 'Stop', needsText: false }],
        },
      },
      workspaceDir: '/tmp/ws-a',
    }]);
  });

  // Story 33 AC 3: the push carries what a notification needs to answer the item in place.
  it('carries a v2 question\'s decision, answer type, options and revision; confirm gets the server\'s Yes / No', async () => {
    const v2 = (itemId: string, input: Record<string, unknown>) => {
      const verdict = validateMissionQuestion({
        formatVersion: 2, kind: 'question', title: 'Deploy', context: '', storyIds: [], blockingScope: 'none', canContinue: true,
        whyNow: 'The dry run passed.', ...input,
      }, 2);
      if (!verdict.ok) throw new Error(verdict.defects.map((d) => d.message).join('; '));
      const event = open(`e-${itemId}`, itemId, needsOwner);
      return { ...event, payload: { itemId, ...verdict.question, humanReview: needsOwner } } as typeof event;
    };
    await run(apply([
      v2('q-deploy', { decision: 'Deploy 0.31.0 to the live server now?', answerType: 'confirm' }),
      v2('q-gate', {
        decision: 'Which gate policy?', answerType: 'single',
        options: [{ id: 'one', label: 'One gate' }, { id: 'other', label: 'Something else', needsText: true }],
      }),
    ]));

    expect(sent.map((s) => s.draft.question)).toEqual([
      {
        formatVersion: 2, decision: 'Deploy 0.31.0 to the live server now?', answerType: 'confirm', revision: 1,
        options: [{ id: 'yes', label: 'Yes', needsText: false }, { id: 'no', label: 'No', needsText: false }],
      },
      {
        formatVersion: 2, decision: 'Which gate policy?', answerType: 'single', revision: 1,
        options: [{ id: 'one', label: 'One gate', needsText: false }, { id: 'other', label: 'Something else', needsText: true }],
      },
    ]);
  });

  it('names the orchestrator tab when the server resolved no opener', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]), null);

    expect(sent[0].draft).toMatchObject({ tabId: 'tab-orch', tabName: 'orchestrator', providerId: 'claude', isOrchestrator: true, itemId: 'item-1' });
  });

  it('sends nothing for an item whose humanNeed is none, or with no human review at all', async () => {
    await run(apply([open('e-1', 'item-1', noOwner), open('e-2', 'item-2')]));

    expect(sent).toEqual([]);
  });

  it('sends nothing for a replayed event: the same request again finds it in the store', async () => {
    const event = open('e-1', 'item-1', needsOwner);
    await run(apply([event]));
    const fresh = createAttentionAlertState();
    sent = [];

    const replay = apply([event]);
    expect(replay.fresh.size).toBe(0);
    await dispatchAttentionOpenedAlerts({ ...replay, openerTabId: null }, deps(), fresh);

    expect(sent).toEqual([]);
  });

  it('sends once per item when two concurrent requests both saw the event as fresh', async () => {
    const event = open('e-1', 'item-1', needsOwner);
    const first = apply([event]);
    await run(first);
    await run({ events: first.events, fresh: first.fresh, previousStates: first.previousStates });

    expect(sent).toHaveLength(1);
  });

  const update = (eventId: string, itemId: string, expectedRevision: number, humanReview?: TMissionHumanReviewInput, title = question.title): TMissionProducerEvent => ({
    ...base, eventId, expectedRevision, bindingGeneration: 1, type: 'attention.updated',
    payload: { itemId, ...question, title, ...(humanReview ? { humanReview } : {}) },
  });

  // Round 2 (R2): the alert is for the FIRST transition to owner-visible open, whatever event causes it.
  it('alerts once when attention.updated promotes a candidate to open, naming revision 2', async () => {
    await run(apply([open('e-1', 'item-1', noOwner)]));
    expect(sent).toEqual([]);

    await run(apply([update('e-2', 'item-1', 1, needsOwner)]));

    expect(sent).toHaveLength(1);
    expect(sent[0].draft).toMatchObject({ kind: 'attention-opened', itemId: 'item-1', question: { revision: 2 } });
  });

  it('alerts for a candidate opened without any review and later reviewed open', async () => {
    await run(apply([open('e-1', 'item-1')]));
    await run(apply([update('e-2', 'item-1', 1, needsOwner)]));

    expect(sent.map((s) => s.draft.itemId)).toEqual(['item-1']);
  });

  it('alerts when one batch opens a candidate and promotes it', async () => {
    await run(apply([open('e-1', 'item-1', noOwner), update('e-2', 'item-1', 1, needsOwner)]));

    expect(sent).toHaveLength(1);
    expect(sent[0].draft.question?.revision).toBe(2);
  });

  it('sends nothing for an update of an item that is already open, even after a restart (no dedupe memory)', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]));
    sent = [];
    state = createAttentionAlertState();

    await run(apply([update('e-2', 'item-1', 1, needsOwner, 'Reworded?')]));

    expect(sent).toEqual([]);
  });

  // Architect confirm C1: a replayed event changes no tracked state, so its old state never masks the real one.
  it('T1: a batch that replays the old candidate open and revises the open item sends nothing, after a restart', async () => {
    const candidate = open('e-1', 'item-1', noOwner);
    await run(apply([candidate]));
    await run(apply([update('e-2', 'item-1', 1, needsOwner)]));
    expect(sent).toHaveLength(1);
    sent = [];
    state = createAttentionAlertState();

    const batch = apply([candidate, update('e-3', 'item-1', 2, needsOwner, 'Reworded?')]);
    expect([...batch.fresh]).toEqual(['e-3']);
    await run(batch);

    expect(sent).toEqual([]);
  });

  it('T2: a replayed open plus a fresh promotion in one batch alerts once', async () => {
    const candidate = open('e-1', 'item-1', noOwner);
    await run(apply([candidate]));
    state = createAttentionAlertState();

    await run(apply([candidate, update('e-2', 'item-1', 1, needsOwner)]));

    expect(sent).toHaveLength(1);
    expect(sent[0].draft).toMatchObject({ itemId: 'item-1', question: { revision: 2 } });
  });

  it('sends nothing for an update that keeps a candidate a candidate', async () => {
    await run(apply([open('e-1', 'item-1', noOwner)]));
    await run(apply([update('e-2', 'item-1', 1, noOwner, 'Still internal')]));

    expect(sent).toEqual([]);
  });

  it('sends nothing for a replayed promotion', async () => {
    await run(apply([open('e-1', 'item-1', noOwner)]));
    const promote = update('e-2', 'item-1', 1, needsOwner);
    await run(apply([promote]));
    sent = [];
    state = createAttentionAlertState();

    const replay = apply([promote]);
    expect(replay.fresh.size).toBe(0);
    await run(replay);

    expect(sent).toEqual([]);
  });

  it('sends nothing for an answer', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]));
    sent = [];
    state = createAttentionAlertState();
    const cursor = store.eventsAfter(0, 1000).cursor;
    store.submitAnswer('item-1', { submissionId: 's-1', expectedRevision: 1, optionIds: ['raise'], text: '', actionCompleted: false }, 'user');
    const answered = store.eventsAfter(cursor, 100).events;
    expect(answered.length).toBeGreaterThan(0);
    await run({ events: answered, fresh: new Set(answered.map((e) => e.id)), previousStates: new Map([['item-1', 'open']]) });

    expect(sent).toEqual([]);
  });

  it('sends nothing for a cancel', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]));
    sent = [];
    const cancel: TMissionProducerEvent = {
      ...base, eventId: 'e-2', expectedRevision: 1, bindingGeneration: 1, type: 'attention.cancelled',
      payload: { itemId: 'item-1', reason: 'done elsewhere' },
    };
    await run(apply([cancel]));

    expect(sent).toEqual([]);
  });

  it('sends one alert per opened item of one batch', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner), open('e-2', 'item-2', needsOwner)]));

    expect(sent.map((s) => s.draft.itemId)).toEqual(['item-1', 'item-2']);
  });

  it('keeps going when the workspace, the tab or the provider cannot be read', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]), 'tab-gone', deps({
      workspace: async () => { throw new Error('store down'); },
      findTab: async () => { throw new Error('layout down'); },
    }));

    expect(sent[0].draft).toMatchObject({ tabId: 'tab-gone', tabName: '', workspaceName: '', providerId: 'claude', isOrchestrator: false, itemId: 'item-1' });
    expect(sent[0].workspaceDir).toBeNull();
  });

  it('falls back to the claude provider when the provider read fails', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]), 'tab-sm', deps({ providerOf: async () => { throw new Error('registry down'); } }));

    expect(sent[0].draft).toMatchObject({ tabId: 'tab-sm', providerId: 'claude' });
  });

  it('names no tab when there is neither an opener nor an orchestrator', async () => {
    await run(apply([open('e-1', 'item-1', needsOwner)]), null, deps({ workspace: async () => ({ ...workspace, orchestration: undefined }) }));

    expect(sent[0].draft).toMatchObject({ tabId: '', tabName: '', isOrchestrator: false });
  });

  it('a failed dispatch is logged and does not retry the item', async () => {
    const dispatch = vi.fn(async () => { throw new Error('channel down'); });
    const applied = apply([open('e-1', 'item-1', needsOwner)]);
    expect(await run(applied, null, deps({ dispatch }))).toEqual([]);
    expect(await run(applied, null, deps({ dispatch }))).toEqual([]);

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('remembers a bounded number of items', async () => {
    for (let i = 0; i < ATTENTION_ALERT_MEMORY + 5; i += 1) state.alerted.add(`ws-x/i-${i}`);
    await run(apply([open('e-1', 'item-1', needsOwner)]));

    expect(state.alerted.size).toBe(ATTENTION_ALERT_MEMORY);
    expect(state.alerted.has('ws-a/item-1')).toBe(true);
  });
});

describe('attentionTransition (the pure rule, R2)', () => {
  const event = (type: IMissionEvent['type'], routing: string, humanNeed: string | null, revision = 2): IMissionEvent => ({
    seq: 1, id: 'e', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', entityId: 'item-e', revision, type, producerAt: 1, committedAt: 2,
    payload: { itemId: 'item-e', title: 'T', options: [], routing: { state: routing }, ...(humanNeed ? { humanReview: { humanNeed } } : {}) },
  });

  it('opened open at once, or updated candidate -> open with a human need', () => {
    expect(attentionTransition(null, event('attention.opened', 'open', 'decision', 1))?.itemId).toBe('item-e');
    expect(attentionTransition('candidate', event('attention.updated', 'open', 'approval'))?.question?.revision).toBe(2);
  });

  it('nothing for open -> open, candidate -> candidate, a need of none, an unknown previous state, or other types', () => {
    expect(attentionTransition('open', event('attention.updated', 'open', 'decision'))).toBeNull();
    expect(attentionTransition('candidate', event('attention.updated', 'candidate', 'none'))).toBeNull();
    expect(attentionTransition('candidate', event('attention.updated', 'open', 'none'))).toBeNull();
    expect(attentionTransition('candidate', event('attention.updated', 'open', null))).toBeNull();
    expect(attentionTransition(null, event('attention.updated', 'open', 'decision'))).toBeNull();
    expect(attentionTransition('answered', event('attention.updated', 'open', 'decision'))).toBeNull();
    expect(attentionTransition('open', event('attention.opened', 'open', 'decision', 1))).toBeNull();
    expect(attentionTransition('candidate', event('attention.cancelled', 'cancelled', 'decision'))).toBeNull();
    expect(attentionTransition('open', event('answer.recorded', 'answered', 'decision'))).toBeNull();
  });
});

describe('openedForHuman', () => {
  const event = (overrides: Partial<IMissionEvent> = {}, payload: Record<string, unknown> = {}): IMissionEvent => ({
    seq: 1, id: 'e', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', entityId: 'item-e', revision: 1,
    type: 'attention.opened', producerAt: 1, committedAt: 2,
    payload: { itemId: 'item-e', title: 'T', humanReview: { humanNeed: 'approval' }, routing: { state: 'open' }, ...payload },
    ...overrides,
  });

  it('reads an open item with a human need', () => {
    expect(openedForHuman(event())).toEqual({ workspaceId: 'ws-a', itemId: 'item-e', title: 'T', at: 2, question: null });
  });

  it('summarises the question; a payload with no readable options summarises nothing', () => {
    expect(openedForHuman(event({}, {
      formatVersion: 2, kind: 'question', decision: '  Ship it?  ', answerType: 'confirm',
      options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No', needsText: true }, { id: 7 }, 'x'],
    }))?.question).toEqual({
      formatVersion: 2, decision: 'Ship it?', answerType: 'confirm', revision: 1,
      options: [{ id: 'yes', label: 'Yes', needsText: false }, { id: 'no', label: 'No', needsText: true }],
    });
    expect(openedForHuman(event({}, { kind: 'action', options: [] }))?.question)
      .toEqual({ formatVersion: 1, decision: 'T', answerType: 'action-done', revision: 1, options: [] });
    expect(openedForHuman(event({}, { options: 'none' }))?.question).toBeNull();
    expect(openedForHuman(event({}, { options: [], answerType: 'radio', formatVersion: 2, decision: 'D' }))?.question).toBeNull();
  });

  it('refuses another type, another revision, a candidate, humanNeed none and a missing review', () => {
    expect(openedForHuman(event({ type: 'attention.updated' }))).toBeNull();
    expect(openedForHuman(event({ revision: 2 }))).toBeNull();
    expect(openedForHuman(event({}, { routing: { state: 'candidate' } }))).toBeNull();
    expect(openedForHuman(event({}, { humanReview: { humanNeed: 'none' } }))).toBeNull();
    expect(openedForHuman(event({}, { humanReview: undefined }))).toBeNull();
    expect(openedForHuman(event({}, { routing: null }))).toBeNull();
  });

  it('falls back to the entity id and a null title', () => {
    expect(openedForHuman(event({}, { itemId: undefined, title: 7 }))).toEqual({ workspaceId: 'ws-a', itemId: 'item-e', title: null, at: 2, question: null });
  });
});
