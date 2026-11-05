import { describe, expect, it } from 'vitest';
import { MissionControlError } from '@/lib/mission-control-errors';
import { parseMissionAnswer, parseMissionEvents } from '@/lib/mission-control-validation';

const event = (humanReview: unknown) => ({
  eventId: 'event-review',
  schemaVersion: 1,
  workspaceId: 'ws-a',
  runId: 'run-a',
  expectedRevision: 0,
  producerAt: 1_700_000_000_000,
  bindingGeneration: 1,
  type: 'attention.opened',
  payload: {
    itemId: 'item-a',
    kind: 'question',
    title: 'Choose',
    context: 'Choose a safe rollout.',
    storyIds: [],
    options: [],
    recommendation: null,
    blockingScope: 'story',
    canContinue: true,
    humanReview,
  },
});

describe('Mission Control human review validation', () => {
  it.each(['decision', 'approval', 'information', 'external-action'] as const)(
    'accepts and trims a complete %s review',
    (humanNeed) => {
      const [parsed] = parseMissionEvents([event({
        humanNeed,
        humanReason: '  Only the human can supply this.  ',
        handling: '  Existing authority and delegated handling were checked.  ',
        reviewerTabId: ' tab-orchestrator ',
      })]);
      expect(parsed).toMatchObject({
        payload: {
          humanReview: {
            humanNeed,
            humanReason: 'Only the human can supply this.',
            handling: 'Existing authority and delegated handling were checked.',
            reviewerTabId: 'tab-orchestrator',
          },
        },
      });
    },
  );

  it('accepts a strict workspace disposition without a human reason', () => {
    const [parsed] = parseMissionEvents([event({
      humanNeed: 'none',
      handling: 'The orchestrator can handle this.',
      reviewerTabId: 'tab-orchestrator',
    })]);
    expect(parsed.payload).toMatchObject({ humanReview: { humanNeed: 'none' } });
  });

  it.each([
    ['null review', null],
    ['unknown need', { humanNeed: 'routine', humanReason: 'Reason', handling: 'Checked', reviewerTabId: 'tab-a' }],
    ['missing reason', { humanNeed: 'approval', handling: 'Checked', reviewerTabId: 'tab-a' }],
    ['blank reason', { humanNeed: 'approval', humanReason: ' ', handling: 'Checked', reviewerTabId: 'tab-a' }],
    ['oversized reason', { humanNeed: 'approval', humanReason: 'x'.repeat(1001), handling: 'Checked', reviewerTabId: 'tab-a' }],
    ['blank handling', { humanNeed: 'none', handling: ' ', reviewerTabId: 'tab-a' }],
    ['server stamp', { humanNeed: 'none', handling: 'Checked', reviewerTabId: 'tab-a', reviewedAt: 1 }],
  ])('rejects %s', (_case, review) => {
    expect(() => parseMissionEvents([event(review)])).toThrowError(MissionControlError);
  });

  it('rejects client routing and the reserved migration event namespace', () => {
    const withRouting = event(undefined);
    withRouting.payload = { ...withRouting.payload, routing: { state: 'open' } } as typeof withRouting.payload;
    expect(() => parseMissionEvents([withRouting])).toThrowError(MissionControlError);
    expect(() => parseMissionEvents([{ ...event(undefined), eventId: 'system:migration:forged' }]))
      .toThrowError(/reserved namespace/);
  });

  it('keeps the orchestrator rebind server-authored: producers cannot send run.rebound or claim its event IDs', () => {
    const rebound = {
      ...event(undefined),
      type: 'run.rebound',
      payload: {
        cause: 'handoff',
        previousBinding: { tabId: 'tab-a', providerId: 'claude', sessionId: 'session-a', generation: 1, runtimeGeneration: null },
        binding: { tabId: 'tab-b', providerId: 'claude', sessionId: 'session-b', generation: 2, runtimeGeneration: null },
      },
    };
    expect(() => parseMissionEvents([rebound])).toThrowError(MissionControlError);
    expect(() => parseMissionEvents([{ ...event(undefined), eventId: 'system:rebind:forged' }]))
      .toThrowError(/reserved namespace/);
  });
});

describe('Mission Control attention class and stated default (ADR-0031)', () => {
  const classified = (type: 'attention.opened' | 'attention.updated', over: Record<string, unknown>) => {
    const base = event(undefined);
    return {
      ...base,
      type,
      payload: { ...base.payload, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], ...over },
    };
  };

  it.each(['attention.opened', 'attention.updated'] as const)('accepts a class and a default that names an option on %s', (type) => {
    const [parsed] = parseMissionEvents([classified(type, { class: 'bookkeeping', defaultOptionId: 'yes' })]);
    expect(parsed.payload).toMatchObject({ class: 'bookkeeping', defaultOptionId: 'yes' });
  });

  it.each(['money', 'irreversible', 'scope', 'bookkeeping'] as const)('accepts the class %s without a default', (attentionClass) => {
    const [parsed] = parseMissionEvents([classified('attention.opened', { class: attentionClass })]);
    expect(parsed.payload).toMatchObject({ class: attentionClass });
    expect(parsed.payload).not.toHaveProperty('defaultOptionId');
  });

  it('keeps both fields optional: an item without them still parses unchanged', () => {
    const [parsed] = parseMissionEvents([classified('attention.opened', {})]);
    expect(parsed.payload).not.toHaveProperty('class');
    expect(parsed.payload).not.toHaveProperty('defaultOptionId');
  });

  it.each([
    ['an unknown class', { class: 'urgent' }, /class must be one of money, irreversible, scope, bookkeeping/],
    ['a null class', { class: null }, /class must be one of money, irreversible, scope, bookkeeping/],
    ['a default that names no option', { defaultOptionId: 'maybe' }, /defaultOptionId must name one of the item's options/],
    ['a blank default', { defaultOptionId: ' ' }, /defaultOptionId/],
  ])('refuses %s with a message that names the field', (_case, over, message) => {
    expect(() => parseMissionEvents([classified('attention.updated', over)])).toThrowError(message);
  });

  it('refuses a default on an action item, which has no options to choose', () => {
    const action = classified('attention.opened', { kind: 'action', options: [], class: 'bookkeeping', defaultOptionId: 'yes' });
    expect(() => parseMissionEvents([action])).toThrowError(/defaultOptionId is refused on an action item/);
    const actionWithOptions = classified('attention.opened', { kind: 'action', defaultOptionId: 'yes' });
    expect(() => parseMissionEvents([actionWithOptions])).toThrowError(/defaultOptionId is refused on an action item/);
  });

  it('refuses the whole batch when one event carries an invalid class (atomic batch)', () => {
    const good = classified('attention.opened', { class: 'money' });
    const bad = { ...classified('attention.opened', { class: 'urgent' }), eventId: 'event-bad' };
    let thrown: unknown;
    try {
      parseMissionEvents([good, bad]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissionControlError);
    expect((thrown as MissionControlError).status).toBe(400);
  });
});

describe('answer source (story 33 R3)', () => {
  const answer = { submissionId: 's-1', expectedRevision: 1, optionIds: ['a'], text: '', actionCompleted: false };

  it('accepts web, phone and notification, and an answer with none', () => {
    for (const source of ['web', 'phone', 'notification'] as const) expect(parseMissionAnswer({ ...answer, source }).source).toBe(source);
    expect(parseMissionAnswer(answer)).not.toHaveProperty('source');
  });

  it('refuses an unknown source with 400', () => {
    expect(() => parseMissionAnswer({ ...answer, source: 'desktop' })).toThrowError(MissionControlError);
  });
});
