import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';

// ADR-0037 §2: the events route checks every question at the fleet's min-version, returns the lint
// of an accepted v1 question, and refuses with every defect; the check route answers the same
// without the write; the min-version key is the admin's.

// `itemStates`: the events route reads the touched items' states before applying (story 33 R2).
const store = vi.hoisted(() => ({
  applyEvents: vi.fn(), unreplayedEventIds: vi.fn(), humanInboxPolicy: vi.fn(), itemStates: vi.fn(() => new Map()),
  followUpRefusal: vi.fn((_input: unknown): unknown => null),
}));
const scope = vi.hoisted(() => ({ resolveCliScope: vi.fn() }));
const fleet = vi.hoisted(() => ({ value: null as string | null, unreadable: false }));

vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => store }));
vi.mock('@/lib/mission-control-runtime', () => ({ resolveMissionTargetIdentity: vi.fn(async () => null) }));
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: scope.resolveCliScope }));
vi.mock('@/lib/cli-utils', () => ({ isOwnWorkspace: (s: { type: string; workspaceId?: string }, ws: string) => s.type === 'workspace' && s.workspaceId === ws }));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: vi.fn(async () => ({ id: 'ws-a', orchestration: null })) }));
vi.mock('@/lib/layout-store', () => ({
  collectAllTabs: () => [],
  readLayoutFile: vi.fn(async () => null),
  resolveLayoutFile: (id: string) => `/none/${id}.json`,
  findTabBySessionName: vi.fn(async () => null),
}));
vi.mock('@/lib/fleet-config-store', async (original) => ({
  ...(await original<typeof import('@/lib/fleet-config-store')>()),
  readFleetConfig: vi.fn(async () => {
    if (fleet.unreadable) throw new Error('fleet-config.json is not JSON');
    return {
      values: fleet.value === null ? {} : { 'mission.question-format.min-version': { value: fleet.value, version: 1, setAt: 1, setBy: { workspaceId: null, tabId: null, admin: true } } },
      history: [],
    };
  }),
}));

const v1 = {
  kind: 'question', title: 'Pick one', context: 'Only one option was written.', storyIds: [],
  options: [{ id: 'only', label: 'The only option, written long enough to pass sixty characters' }], recommendation: null,
  blockingScope: 'story', canContinue: true,
};
const v2 = {
  formatVersion: 2, kind: 'question', title: 'Gate policy', decision: 'Reuse the pre-flight gate?', whyNow: 'It costs 13 lock-hours a day.',
  answerType: 'confirm', storyIds: [], blockingScope: 'story', canContinue: true,
};
const event = (eventId: string, payload: Record<string, unknown>) => ({
  eventId, schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 1,
  bindingGeneration: 1, type: 'attention.opened', payload: { itemId: `item-${eventId}`, ...payload },
});

interface IRouteResult {
  status: number;
  body: { code?: string; error?: string; lint?: unknown; defects?: Array<Record<string, unknown>>; ok?: boolean } & Record<string, unknown>;
}

const call = async (route: string, body: unknown): Promise<IRouteResult> => {
  const { default: handler } = await import(route);
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
  await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers: {}, body } as unknown as NextApiRequest, res);
  return state as IRouteResult;
};
const post = (events: unknown[]) => call('@/pages/api/cli/mission-control/events', { events });
const check = (question: unknown) => call('@/pages/api/cli/mission-control/questions/check', { question });

beforeEach(() => {
  vi.clearAllMocks();
  fleet.value = null;
  fleet.unreadable = false;
  scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
  store.applyEvents.mockReturnValue({ events: [], cursor: 0, replayed: false });
  store.followUpRefusal.mockReturnValue(null);
  store.unreplayedEventIds.mockImplementation((events: Array<{ eventId: string }>) => new Set(events.map((e) => e.eventId)));
  store.humanInboxPolicy.mockReturnValue({ version: 1, legacyReviewPending: 0 });
});

describe('POST /api/cli/mission-control/events: question format (ADR-0037)', () => {
  it('at min-version 1 (unset) accepts a v1 question and returns its lint in the 200 body', async () => {
    const r = await post([event('e-v1', v1)]);
    expect(r.status).toBe(200);
    expect(r.body.lint).toEqual([{ eventId: 'e-v1', itemId: 'item-e-v1', findings: [
      expect.objectContaining({ field: 'formatVersion', measured: 'absent (v1)' }),
      expect.objectContaining({ field: 'options', measured: '1 option on a choice question', limit: 'needs 2-4, or answerType text' }),
      expect.objectContaining({ field: 'options[0].label', measured: '61 chars', limit: 'at most 60' }),
    ] }]);
  });

  it('at min-version 2 refuses a new v1 question with 400 question-invalid and nothing stored', async () => {
    fleet.value = '2';
    const r = await post([event('e-v2', v2), event('e-v1', v1)]);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('question-invalid');
    expect(r.body.defects?.[0]).toEqual({
      eventId: 'e-v1', itemId: 'item-e-v1', field: 'formatVersion', measured: 'absent (v1)',
      limit: 'at least 2 (fleet config mission.question-format.min-version)',
      message: 'formatVersion: absent (v1), at least 2 (fleet config mission.question-format.min-version)',
    });
    expect(store.applyEvents).not.toHaveBeenCalled();
  });

  it('at min-version 2 passes a v1 attention.updated to the store with its lint, and the min-version with it', async () => {
    fleet.value = '2';
    const r = await post([{ ...event('e-upd', v1), type: 'attention.updated', expectedRevision: 1 }]);
    expect(r.status).toBe(200);
    expect((r.body.lint as Array<{ eventId: string }>)[0].eventId).toBe('e-upd');
    expect(store.applyEvents.mock.calls[0][2]).toEqual({ questionMinVersion: 2 });
  });

  it('at min-version 2 accepts a v2 question, normalized, with no lint', async () => {
    fleet.value = '2';
    const r = await post([event('e-v2', v2)]);
    expect(r.status).toBe(200);
    expect(r.body.lint).toEqual([]);
    expect(store.applyEvents.mock.calls[0][0][0].payload.options.map((option: { label: string }) => option.label)).toEqual(['Yes', 'No']);
  });

  it('lists every defect of every event in one refusal', async () => {
    const r = await post([event('e-a', { ...v2, decision: 'x'.repeat(121) }), event('e-b', { ...v2, answerType: 'single', options: [{ id: 'a', label: 'A' }] })]);
    expect(r.status).toBe(400);
    expect(r.body.defects?.map((entry) => `${entry.eventId} ${entry.message}`)).toEqual([
      'e-a decision: 121 chars, at most 120',
      'e-b options: 1 option on answerType single, needs 2-4',
    ]);
    expect(r.body.error).toBe('2 question defects in 2 events: decision: 121 chars, at most 120; options: 1 option on answerType single, needs 2-4');
  });

  it.each([['an invalid value', 'three', false], ['an unreadable store', null, true]])('reads %s as min-version 1', async (_case, value, unreadable) => {
    fleet.value = value;
    fleet.unreadable = unreadable;
    expect((await post([event('e-v1', v1)])).status).toBe(200);
  });
});

describe('POST /api/cli/mission-control/questions/check', () => {
  it('answers the defects without writing, and reports the reshape as not enabled', async () => {
    const r = await check({ ...v2, whyNow: undefined });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, formatVersion: 2, minVersion: 1, defects: [{ field: 'whyNow' }], reshape: { enabled: false } });
    expect(store.applyEvents).not.toHaveBeenCalled();
  });

  it('answers the normalized question and its lint', async () => {
    expect((await check(v1)).body).toMatchObject({ ok: true, formatVersion: 1, lint: [{ field: 'formatVersion' }, { field: 'options' }, { field: 'options[0].label' }] });
    expect((await check(v2)).body).toMatchObject({ ok: true, formatVersion: 2, question: { options: [{ id: 'yes' }, { id: 'no' }] } });
  });

  it('requires a token and a question', async () => {
    scope.resolveCliScope.mockReturnValue(null);
    expect((await check(v2)).status).toBe(401);
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    expect((await call('@/pages/api/cli/mission-control/questions/check', {})).body.code).toBe('invalid-request');
  });
});

// Story 36 (D6): an item a human must see sorts as Unclassified without a class; a warning, never a refusal (ADR-0031).
describe('class: absent lint on a human-reviewed item (story 36, D6)', () => {
  const review = { humanNeed: 'decision', humanReason: 'Only the owner picks.', handling: 'Orchestrator relays.', reviewerTabId: 'tab-o' };
  const CLASS_ABSENT = {
    field: 'class', measured: 'absent', limit: 'one of money, irreversible, scope, bookkeeping; without it the item sorts as Unclassified (ADR-0031)',
    message: 'class: absent, one of money, irreversible, scope, bookkeeping; without it the item sorts as Unclassified (ADR-0031)',
  };

  it('the events route accepts the item and returns the warning in its 200 body', async () => {
    const r = await post([event('e-hr', { ...v2, humanReview: review })]);
    expect(r.status).toBe(200);
    expect(r.body.lint).toEqual([{ eventId: 'e-hr', itemId: 'item-e-hr', findings: [CLASS_ABSENT] }]);
    expect(store.applyEvents).toHaveBeenCalledTimes(1);
  });

  it('gives no warning with a class, with a none review, or with no review', async () => {
    const r = await post([
      event('e-cls', { ...v2, class: 'scope', humanReview: review }),
      event('e-none', { ...v2, humanReview: { humanNeed: 'none', handling: 'Handled in the workspace.', reviewerTabId: 'tab-o' } }),
      event('e-bare', v2),
    ]);
    expect(r.status).toBe(200);
    expect(r.body.lint).toEqual([]);
  });

  it('adds the warning to a v1 item\'s format findings', async () => {
    const r = await post([event('e-v1hr', { ...v1, humanReview: review })]);
    const [entry] = r.body.lint as Array<{ findings: Array<{ field: string }> }>;
    expect(entry.findings.map((finding) => finding.field)).toEqual(['formatVersion', 'options', 'options[0].label', 'class']);
  });

  it('the check route answers the same warning when mc ask sends the review beside the question', async () => {
    const withReview = await call('@/pages/api/cli/mission-control/questions/check', { question: v2, humanReview: review });
    expect(withReview.body).toMatchObject({ ok: true, defects: [], lint: [CLASS_ABSENT] });
    expect((await check(v2)).body).toMatchObject({ ok: true, lint: [] });
    expect((await call('@/pages/api/cli/mission-control/questions/check', { question: { ...v2, class: 'money' }, humanReview: review })).body)
      .toMatchObject({ ok: true, lint: [] });
  });
});

describe('follow-ups (ADR-0037 amendment D2)', () => {
  const review = { humanNeed: 'decision', humanReason: 'Only the owner decides.', handling: 'Checked.', reviewerTabId: 'tab-o' };
  const checkFollowUp = (extra: Record<string, unknown>) =>
    call('@/pages/api/cli/mission-control/questions/check', { question: v2, humanReview: review, ...extra });

  it('the events route passes followsUp to the store beside the question, and its 200 body carries followedUp', async () => {
    const followedUp = { itemId: 'item-a', answerId: 'ans-1', optionIds: ['keep'], optionLabels: ['Keep'], text: 'T', resolved: true };
    store.applyEvents.mockReturnValue({ events: [], cursor: 3, replayed: false, followedUp });
    const r = await post([event('e-f', { ...v2, humanReview: review, followsUp: 'item-a' })]);
    expect(r.status).toBe(200);
    expect(r.body.followedUp).toEqual(followedUp);
    const [events] = store.applyEvents.mock.calls[0] as [Array<{ payload: Record<string, unknown> }>];
    expect(events[0].payload.followsUp).toBe('item-a');
  });

  it('a 409 refusal carries the followsUp detail in its body', async () => {
    const { MissionControlError } = await import('@/lib/mission-control-errors');
    store.applyEvents.mockImplementation(() => {
      throw new MissionControlError(409, 'conflict', 'already followed up', undefined,
        { followsUp: { reason: 'already-followed', followedBy: 'item-b', tip: 'item-c' } });
    });
    const r = await post([event('e-f', { ...v2, humanReview: review, followsUp: 'item-a' })]);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: 'conflict', followsUp: { reason: 'already-followed', followedBy: 'item-b', tip: 'item-c' } });
  });

  it('refuses followsUp on attention.updated with 400 invalid-request, before the store', async () => {
    const r = await post([{ ...event('e-u', { ...v2, followsUp: 'item-a' }), type: 'attention.updated', expectedRevision: 1 }]);
    expect(r).toMatchObject({ status: 400, body: { code: 'invalid-request', error: 'followsUp is set when an item opens; a link never changes' } });
    expect(store.applyEvents).not.toHaveBeenCalled();
  });

  it('the check route reports a refused follow-up as a defect of field followsUp, with its code, and keeps the question', async () => {
    const { MissionControlError } = await import('@/lib/mission-control-errors');
    store.followUpRefusal.mockReturnValue(new MissionControlError(409, 'conflict', 'follow-up target item-a is not answered yet', undefined,
      { followsUp: { reason: 'not-answered' } }));
    const r = await checkFollowUp({ followsUp: 'item-a', itemId: 'item-b', runId: 'run-a' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.defects).toEqual([expect.objectContaining({
      field: 'followsUp', code: 'conflict', status: 409, followsUp: { reason: 'not-answered' },
      message: 'followsUp: follow-up target item-a is not answered yet',
    })]);
    expect(r.body.question).toMatchObject({ decision: v2.decision });
    expect(store.followUpRefusal).toHaveBeenCalledWith({
      workspaceId: 'ws-a', runId: 'run-a', itemId: 'item-b', followsUp: 'item-a', humanReview: { humanNeed: 'decision' },
    });
  });

  it('the check route passes a follow-up the store accepts, and checks nothing when the body names none', async () => {
    expect((await checkFollowUp({ followsUp: 'item-a', itemId: 'item-b', runId: 'run-a' })).body.ok).toBe(true);
    store.followUpRefusal.mockClear();
    expect((await checkFollowUp({})).body.ok).toBe(true);
    expect(store.followUpRefusal).not.toHaveBeenCalled();
  });

  it('the check route answers forbidden for another workspace token, and invalid-request without the ids', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-other' });
    expect((await checkFollowUp({ followsUp: 'item-a', itemId: 'item-b', runId: 'run-a' })).body.defects)
      .toEqual([expect.objectContaining({ field: 'followsUp', code: 'forbidden', status: 403 })]);
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    expect((await checkFollowUp({ followsUp: 'item-a' })).body.defects)
      .toEqual([expect.objectContaining({ field: 'followsUp', code: 'invalid-request', status: 400 })]);
    expect(store.followUpRefusal).not.toHaveBeenCalled();
  });
});

describe('fleet config mission.question-format.min-version is admin-only', () => {
  it('refuses an enabled orchestrator and accepts the admin', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    const orchestrator = { admin: false, workspaceId: 'ws-a', tabId: 'tab-orch', verified: true, identity: 'launch' } as unknown as ICaller;
    await expect(putValue(orchestrator, 'mission.question-format.min-version', { value: '2' }, { isWorkspaceOrchestrator: async () => true, now: () => 1 }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('GET /api/cli/api-guide § Mission Control: question format v2 (ADR-0037)', () => {
  const guide = async (): Promise<string> => {
    const { default: handler } = await import('@/pages/api/cli/api-guide');
    const state = { body: '' };
    const res = {
      status() { return this; },
      json() { return this; },
      send(payload: unknown) { state.body = String(payload); return this; },
      setHeader() { return this; },
    } as unknown as NextApiResponse;
    await handler({ method: 'GET', headers: {} } as NextApiRequest, res);
    return state.body;
  };

  it('gives one example per answer type, each accepted by the validator', async () => {
    const { validateMissionQuestion } = await import('@/lib/mission-question-format');
    const text = await guide();
    const block = text.slice(text.indexOf('One example per answer type'), text.indexOf('Revisions keep the owner'));
    const examples = block.split(/\n {2}(single|multi|confirm|text|action-done):/).slice(1);
    const byType = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < examples.length; index += 2) {
      const chunk = examples[index + 1];
      byType.set(examples[index], JSON.parse(chunk.slice(chunk.indexOf('{'), chunk.lastIndexOf('}') + 1)) as Record<string, unknown>);
    }
    expect([...byType.keys()]).toEqual(['single', 'multi', 'confirm', 'text', 'action-done']);
    for (const [answerType, payload] of byType) {
      const { itemId: _itemId, ...question } = payload;
      expect(question.answerType).toBe(answerType);
      const verdict = validateMissionQuestion(question, 2);
      expect(verdict.ok ? [] : verdict.defects.map((entry) => entry.message)).toEqual([]);
    }
  });

  it('documents the refusal, the min-version key, the revision rule and mc ask', async () => {
    const text = await guide();
    const section = text.slice(text.indexOf('## Mission Control'), text.indexOf('## Human coordination routes'));
    for (const phrase of ['"code": "question-invalid"', 'options[2].label: 87 chars, at most 60', 'mission.question-format.min-version',
      '"appliedRevision"', '"unrecorded"', 'purplemux mc ask -w WS --json @DRAFT [--fix]', '"evidenceLinks"']) {
      expect(section).toContain(phrase);
    }
  });
});

// vel-MC-ACT: the ask path (the check route the CLI calls first) and the events route both warn on owner steps inside a
// question, name the split, and still accept the question.
describe('owner steps inside a question (vel-MC-ACT)', () => {
  const steps = { ...v2, context: 'Your steps:\n1. Paste the token to the repository secret.\n2. Click Save.' };

  it('the check route accepts it and returns the warning', async () => {
    const r = await check(steps);
    expect(r.body).toMatchObject({ ok: true, lint: [expect.objectContaining({ field: 'context', measured: expect.stringContaining("'Your steps'") })] });
  });

  it('the events route accepts it, writes it, and returns the warning beside the event', async () => {
    const r = await post([event('e-steps', steps)]);
    expect(r.status).toBe(200);
    expect(r.body.lint).toEqual([{ eventId: 'e-steps', itemId: 'item-e-steps', findings: [expect.objectContaining({ field: 'context', limit: expect.stringContaining('kind=action') })] }]);
    expect(store.applyEvents).toHaveBeenCalledTimes(1);
  });

  const action = { formatVersion: 2, kind: 'action', title: 'Rotate the token', decision: 'Rotate the token', answerType: 'action-done', context: 'Paste the new token to the repository secret.', storyIds: [], blockingScope: 'story', canContinue: true };
  const review = { humanNeed: 'external-action', humanReason: 'Only the owner holds the token.', handling: 'Opened for the owner.', reviewerTabId: 'tab-o' };

  it('an action item that is itself the step gets no owner-steps warning', async () => {
    const r = await post([event('e-act', { ...action, class: 'scope', humanReview: review })]);
    expect(r.status).toBe(200);
    expect(r.body.lint).toEqual([]);
  });

  it('an action opened with no human review is warned that only the orchestrator makes it visible (both routes)', async () => {
    const r = await post([event('e-bare', action)]);
    expect(r.status).toBe(200);
    expect(r.body.lint).toEqual([{ eventId: 'e-bare', itemId: 'item-e-bare', findings: [expect.objectContaining({ field: 'humanReview', limit: expect.stringContaining('configured orchestrator') })] }]);
    expect((await check(action)).body).toMatchObject({ ok: true, lint: [expect.objectContaining({ field: 'humanReview' })] });
  });
});
