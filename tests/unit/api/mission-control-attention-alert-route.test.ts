import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The events route hands every applied batch to the attention alerts: the committed events, the
// event ids that were new before the request, and the server-resolved opener tab (never a payload
// claim). The response never waits on the alert.

const store = vi.hoisted(() => ({ applyEvents: vi.fn(), unreplayedEventIds: vi.fn(), humanInboxPolicy: vi.fn(), itemStates: vi.fn() }));
const scope = vi.hoisted(() => ({ resolveCliScope: vi.fn() }));
const alerts = vi.hoisted(() => ({ alertOpenedAttention: vi.fn() }));

vi.mock('@/lib/attention-alerts', () => alerts);
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

const question = { kind: 'question', title: 'Q', context: 'C', storyIds: [], options: [], recommendation: 'SM to rule', blockingScope: 'story', canContinue: true };
const opened = { eventId: 'e-open', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 1, bindingGeneration: 1, type: 'attention.opened', payload: { itemId: 'item-a', ...question } };
const committed = [{ seq: 4, id: 'e-open', type: 'attention.opened', revision: 1 }];

const post = async (events: unknown[]) => {
  const { default: handler } = await import('@/pages/api/cli/mission-control/events');
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
  await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers: {}, body: { events } } as unknown as NextApiRequest, res);
  return state as { status: number; body: Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  store.applyEvents.mockReturnValue({ events: committed, cursor: 4, replayed: false });
  store.unreplayedEventIds.mockImplementation((events: Array<{ eventId: string }>) => new Set(events.map((e) => e.eventId)));
  store.humanInboxPolicy.mockReturnValue({ version: 1, legacyReviewPending: 0 });
  store.itemStates.mockImplementation(() => new Map());
  alerts.alertOpenedAttention.mockReturnValue(new Promise(() => undefined));
});

describe('POST /api/cli/mission-control/events: attention-opened alerts', () => {
  it('passes the committed events, the fresh ids and the resolved opener, and answers without waiting', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-w', tabVerified: true });

    const r = await post([opened]);

    expect(r.status).toBe(200);
    // The route also returns the question-format lint for the batch (story 31, ADR-0037); the alert does not change it.
    expect(r.body).toEqual({ events: committed, cursor: 4, replayed: false, humanInboxPolicy: { version: 1, legacyReviewPending: 0 }, lint: expect.any(Array) });
    expect(alerts.alertOpenedAttention).toHaveBeenCalledTimes(1);
    const [input] = alerts.alertOpenedAttention.mock.calls[0];
    expect(input.events).toBe(committed);
    expect([...input.fresh]).toEqual(['e-open']);
    expect(input.openerTabId).toBe('tab-w');
  });

  it('passes no opener for a workspace token without a tab, and an empty fresh set for a replay', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    store.unreplayedEventIds.mockReturnValue(new Set());

    await post([opened]);

    const [input] = alerts.alertOpenedAttention.mock.calls[0];
    expect(input.openerTabId).toBeNull();
    expect(input.fresh.size).toBe(0);
  });

  it('reads the states of the items a fresh update touches before the batch applies (story 33 R2)', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-w', tabVerified: true });
    const order: string[] = [];
    store.itemStates.mockImplementation((ids: string[]) => { order.push(`states:${ids.join(',')}`); return new Map([['item-a', 'candidate']]); });
    store.applyEvents.mockImplementation(() => { order.push('apply'); return { events: committed, cursor: 4, replayed: false }; });
    const updated = { ...opened, eventId: 'e-up', expectedRevision: 1, type: 'attention.updated' };

    await post([updated]);

    expect(order).toEqual(['states:item-a', 'apply']);
    const [input] = alerts.alertOpenedAttention.mock.calls[0];
    expect([...input.previousStates]).toEqual([['item-a', 'candidate']]);
  });

  it('sends nothing when the store refuses the batch', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-w', tabVerified: true });
    store.applyEvents.mockImplementation(() => { throw new Error('boom'); });

    const r = await post([opened]);

    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(alerts.alertOpenedAttention).not.toHaveBeenCalled();
  });
});
