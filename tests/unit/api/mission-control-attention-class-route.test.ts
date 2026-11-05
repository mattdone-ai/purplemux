import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0031: the events route accepts the producer's class and stated default, and refuses the
// whole batch, naming the field, before any write when either is invalid.

// `itemStates`: the events route reads the touched items' states before applying (story 33 R2).
const store = vi.hoisted(() => ({ applyEvents: vi.fn(), unreplayedEventIds: vi.fn(), humanInboxPolicy: vi.fn(), itemStates: vi.fn(() => new Map()) }));
const scope = vi.hoisted(() => ({ resolveCliScope: vi.fn() }));

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

const question = {
  kind: 'question', title: 'Raise the budget?', context: 'The run needs 20 more turns.', storyIds: [],
  options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], recommendation: null, blockingScope: 'story', canContinue: true,
};
const opened = {
  eventId: 'e-open', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 1,
  bindingGeneration: 1, type: 'attention.opened', payload: { itemId: 'item-a', ...question, class: 'bookkeeping', defaultOptionId: 'yes' },
};
const updated = { ...opened, eventId: 'e-upd', expectedRevision: 1, type: 'attention.updated' };

const post = async (events: unknown[]) => {
  const { default: handler } = await import('@/pages/api/cli/mission-control/events');
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
  await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers: {}, body: { events } } as unknown as NextApiRequest, res);
  return state as { status: number; body: { error?: string; code?: string } };
};

beforeEach(() => {
  vi.clearAllMocks();
  scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
  store.applyEvents.mockReturnValue({ events: [], cursor: 0, replayed: false });
  store.unreplayedEventIds.mockImplementation((events: Array<{ eventId: string }>) => new Set(events.map((e) => e.eventId)));
  store.humanInboxPolicy.mockReturnValue({ version: 1, legacyReviewPending: 0 });
});

describe('POST /api/cli/mission-control/events: attention class and stated default', () => {
  it.each([['attention.opened', opened], ['attention.updated', updated]] as const)('passes both fields of %s to the store', async (_type, event) => {
    const r = await post([event]);
    expect(r.status).toBe(200);
    expect(store.applyEvents.mock.calls[0][0][0].payload).toMatchObject({ class: 'bookkeeping', defaultOptionId: 'yes' });
  });

  it.each([
    ['an unknown class', { class: 'urgent' }, 'class', /class must be one of money, irreversible, scope, bookkeeping/],
    ['a default that names no option', { defaultOptionId: 'maybe' }, 'defaultOptionId', /defaultOptionId must name one of the item's options/],
    ['a default on an action item', { kind: 'action', options: [] }, 'defaultOptionId', /defaultOptionId is refused on an action item/],
  ])('refuses %s with 400 question-invalid, the field named, and nothing stored (ADR-0037)', async (_case, over, field, message) => {
    const good = { ...opened, eventId: 'e-good', payload: { ...opened.payload, itemId: 'item-good' } };
    const bad = { ...opened, payload: { ...opened.payload, ...over } };
    const r = await post([good, bad]);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'question-invalid', defects: [{ eventId: bad.eventId, field }] });
    expect(r.body.error).toMatch(message);
    expect(store.applyEvents).not.toHaveBeenCalled();
  });
});

describe('GET /api/cli/api-guide § Mission Control: attention class', () => {
  const guide = async (): Promise<string> => {
    const { default: handler } = await import('@/pages/api/cli/api-guide');
    const state = { body: undefined as unknown };
    const res = {
      status() { return this; },
      json(payload: unknown) { state.body = payload; return this; },
      send(payload: unknown) { state.body = payload; return this; },
      setHeader() { return this; },
    } as unknown as NextApiResponse;
    await handler({ method: 'GET', headers: {} } as NextApiRequest, res);
    return String(state.body);
  };

  it('documents both fields, the producer rule, and one example the validator accepts', async () => {
    const text = await guide();
    const section = text.slice(text.indexOf('## Mission Control'), text.indexOf('## Web-browser tabs'));
    expect(section).toContain('"class" is one of "money", "irreversible", "scope" or\n  "bookkeeping"');
    expect(section).toContain('"defaultOptionId" names one of the item\'s options[].id');
    expect(section.replace(/\s+/g, ' ')).toContain(
      'A producer that cannot name the class omits it; money, irreversible and scope are never auto-answered.');
    expect(section).toContain('"answersByClass"');
    const start = section.indexOf('{"events":[{"eventId":"evt-question-2"');
    const example = section.slice(start, section.indexOf('\n\n', start)).replace(/\n\s*/g, '');
    const { parseMissionEvents } = await import('@/lib/mission-control-validation');
    expect(parseMissionEvents(JSON.parse(example).events)[0].payload).toMatchObject({ class: 'bookkeeping', defaultOptionId: 'gradual' });
  });
});
