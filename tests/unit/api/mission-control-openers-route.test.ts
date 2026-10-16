import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0023: the events route records who opened an item from the server-resolved
// caller (ADR-0010), never from the payload, and only for `attention.opened`.

const store = vi.hoisted(() => ({ applyEvents: vi.fn(), unreplayedEventIds: vi.fn(), humanInboxPolicy: vi.fn() }));
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
  findTabBySessionName: vi.fn(async (session: string) => (session === 'pt-ws-a-pane-p-tab-s' ? { id: 'tab-s', name: 'worker-s' } : null)),
}));

const question = { kind: 'question', title: 'Q', context: 'C', storyIds: [], options: [], recommendation: 'SM to rule', blockingScope: 'story', canContinue: true };
const opened = { eventId: 'e-open', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0, producerAt: 1, bindingGeneration: 1, type: 'attention.opened', payload: { itemId: 'item-a', ...question } };
const updated = { ...opened, eventId: 'e-upd', expectedRevision: 1, type: 'attention.updated' };

const post = async (events: unknown[], headers: Record<string, string> = {}) => {
  const { default: handler } = await import('@/pages/api/cli/mission-control/events');
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
  await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers, body: { events } } as unknown as NextApiRequest, res);
  return { ...state, authorities: store.applyEvents.mock.calls[0]?.[1] as Map<string, { opener?: unknown }> | undefined };
};

beforeEach(() => {
  vi.clearAllMocks();
  store.applyEvents.mockReturnValue({ events: [], cursor: 0, replayed: false });
  store.unreplayedEventIds.mockImplementation((events: Array<{ eventId: string }>) => new Set(events.map((e) => e.eventId)));
  store.humanInboxPolicy.mockReturnValue({ version: 1, legacyReviewPending: 0 });
});

describe('POST /api/cli/mission-control/events: opener attribution', () => {
  it('a launch tab token names a verified opener', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-w', tabVerified: true });
    const r = await post([opened]);
    expect(r.status).toBe(200);
    expect(r.authorities?.get('e-open')?.opener).toEqual({ tabId: 'tab-w', identity: 'launch' });
  });

  it('a hook token names an asserted opener', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-h', tabVerified: false });
    expect((await post([opened])).authorities?.get('e-open')?.opener).toEqual({ tabId: 'tab-h', identity: 'hook' });
  });

  it('a workspace token with a session of this workspace names a session opener; without one, none', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    expect((await post([opened], { 'x-pmux-session': 'pt-ws-a-pane-p-tab-s' })).authorities?.get('e-open')?.opener)
      .toEqual({ tabId: 'tab-s', identity: 'session' });
    vi.clearAllMocks();
    store.applyEvents.mockReturnValue({ events: [], cursor: 0, replayed: false });
    store.unreplayedEventIds.mockImplementation((events: Array<{ eventId: string }>) => new Set(events.map((e) => e.eventId)));
    store.humanInboxPolicy.mockReturnValue({ version: 1, legacyReviewPending: 0 });
    expect((await post([opened])).authorities?.get('e-open')?.opener).toBeNull();
  });

  it('only attention.opened carries an opener; a payload cannot name one', async () => {
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a', tabId: 'tab-w', tabVerified: true });
    const forged = { ...opened, payload: { ...opened.payload, opener: { tabId: 'tab-forged', identity: 'launch' } } };
    const r = await post([updated]);
    expect(r.authorities?.get('e-upd')?.opener).toBeNull();
    vi.clearAllMocks();
    store.applyEvents.mockReturnValue({ events: [], cursor: 0, replayed: false });
    store.unreplayedEventIds.mockImplementation((events: Array<{ eventId: string }>) => new Set(events.map((e) => e.eventId)));
    store.humanInboxPolicy.mockReturnValue({ version: 1, legacyReviewPending: 0 });
    // The strict payload schema refuses the field before any write.
    const f = await post([forged]);
    expect(f.status).toBe(400);
    expect(store.applyEvents).not.toHaveBeenCalled();
  });

  it('no token is 401 and nothing is stored', async () => {
    scope.resolveCliScope.mockReturnValue(null);
    const r = await post([opened]);
    expect(r.status).toBe(401);
    expect(store.applyEvents).not.toHaveBeenCalled();
  });
});
