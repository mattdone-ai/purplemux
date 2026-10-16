import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signSessionToken } from '@/lib/auth';

const store = vi.hoisted(() => ({
  submitAnswer: vi.fn(),
  applyEvents: vi.fn(),
  unreplayedEventIds: vi.fn(),
  humanInboxPolicy: vi.fn(),
}));
const runtime = vi.hoisted(() => ({
  getMissionSnapshot: vi.fn(),
  resolveMissionTargetIdentity: vi.fn(),
}));
const scope = vi.hoisted(() => ({
  resolveCliScope: vi.fn(),
  canDriveWorkspace: vi.fn(),
  canAccessWorkspace: vi.fn(),
}));
const workspace = vi.hoisted(() => ({
  getWorkspaceById: vi.fn(),
}));

vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => store }));
vi.mock('@/lib/mission-control-runtime', () => runtime);
vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: scope.resolveCliScope }));
vi.mock('@/lib/cli-utils', () => ({
  canDriveWorkspace: scope.canDriveWorkspace,
  // Producer events check own-workspace (ADR-0014: a drive grant never counts); same answers here.
  isOwnWorkspace: scope.canDriveWorkspace,
  canAccessWorkspace: scope.canAccessWorkspace,
}));
vi.mock('@/lib/workspace-store', () => ({ getWorkspaceById: workspace.getWorkspaceById }));

const fakeResponse = () => {
  const state = { statusCode: 0, body: undefined as unknown, headers: {} as Record<string, unknown> };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader(name: string, value: unknown) { state.headers[name] = value; return this; },
  } as unknown as NextApiResponse;
  return { state, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXTAUTH_SECRET = 'mission-control-test-secret-at-least-32-bytes';
  runtime.getMissionSnapshot.mockResolvedValue({ schemaVersion: 1, cursor: 0 });
  store.submitAnswer.mockReturnValue({ replayed: false, answer: { id: 'answer-a' } });
  store.applyEvents.mockReturnValue({ events: [], cursor: 0, replayed: false });
  store.unreplayedEventIds.mockImplementation((events) => new Set(events.map((event: { eventId: string }) => event.eventId)));
  store.humanInboxPolicy.mockReturnValue({ version: 1, legacyReviewPending: 0 });
  runtime.resolveMissionTargetIdentity.mockResolvedValue({
    tabId: 'tab-a', providerId: 'codex', sessionId: 'session-a', runtimeGeneration: 'runtime-a',
  });
  workspace.getWorkspaceById.mockResolvedValue({
    id: 'ws-a', name: 'A', directories: [],
    orchestration: { enabled: false, orchestratorTabId: 'tab-a' },
  });
  scope.canAccessWorkspace.mockResolvedValue(true);
});

describe('Mission Control human authentication', () => {
  it('does not let a Scrum Master tab token save the human-selected scope', async () => {
    const { default: handler } = await import('@/pages/api/mission-control/portfolio');
    const { state, res } = fakeResponse();
    await handler({ method: 'PUT', headers: { 'x-pmux-token': 'manager-tab-token' }, body: {
      managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-a'],
    } } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(401);
  });

  it('does not accept the global CLI token as a human session', async () => {
    const { default: handler } = await import('@/pages/api/mission-control/index');
    const { state, res } = fakeResponse();
    await handler({ method: 'GET', headers: { 'x-pmux-token': 'global-token' } } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(401);
    expect(state.headers['Cache-Control']).toBe('no-store');
    expect(runtime.getMissionSnapshot).not.toHaveBeenCalled();
  });

  it('requires matching origin or same-origin Fetch Metadata for cookie mutations', async () => {
    const { default: handler } = await import('@/pages/api/mission-control/items/[itemId]/answers');
    const token = await signSessionToken();
    const request = {
      method: 'POST',
      query: { itemId: 'item-a' },
      headers: { cookie: `session-token=${token}`, host: 'purplemux.test' },
      body: { submissionId: 'submission-a', expectedRevision: 1, optionIds: ['yes'], text: '', actionCompleted: false },
    } as unknown as NextApiRequest;
    const denied = fakeResponse();
    await handler(request, denied.res);
    expect(denied.state.statusCode).toBe(403);
    expect(store.submitAnswer).not.toHaveBeenCalled();

    const allowed = fakeResponse();
    request.headers.origin = 'http://purplemux.test';
    await handler(request, allowed.res);
    expect(allowed.state.statusCode).toBe(201);
    expect(allowed.state.headers['Cache-Control']).toBe('no-store');
    expect(store.submitAnswer).toHaveBeenCalledWith('item-a', expect.objectContaining({ submissionId: 'submission-a' }), 'user');
  });

  it('rejects cross-site Fetch Metadata even when Origin is forged to match', async () => {
    const { default: handler } = await import('@/pages/api/mission-control/items/[itemId]/answers');
    const token = await signSessionToken();
    const { state, res } = fakeResponse();
    await handler({
      method: 'POST', query: { itemId: 'item-a' },
      headers: {
        cookie: `session-token=${token}`,
        host: 'purplemux.test',
        origin: 'http://purplemux.test',
        'sec-fetch-site': 'cross-site',
      },
      body: { submissionId: 'submission-a', expectedRevision: 1, optionIds: ['yes'], text: '', actionCompleted: false },
    } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(403);
  });
});

describe('Mission Control agent authorization', () => {
  const start = {
    eventId: 'event-start', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
    expectedRevision: 0, producerAt: 1_700_000_000_000, bindingGeneration: 0,
    type: 'run.started', payload: { objective: 'Ship', tabId: 'tab-a' },
  };

  it('adds the workspace human-inbox policy to CLI snapshots', async () => {
    const { default: handler } = await import('@/pages/api/cli/mission-control/index');
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    store.humanInboxPolicy.mockReturnValue({
      version: 1, legacyReviewPending: 2, guidance: 'Review on the next ordinary turn.',
    });
    const { state, res } = fakeResponse();
    await handler({ method: 'GET', query: { workspaceId: 'ws-a' }, headers: {} } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(200);
    expect(state.body).toMatchObject({
      schemaVersion: 1,
      humanInboxPolicy: { version: 1, legacyReviewPending: 2, guidance: 'Review on the next ordinary turn.' },
    });
    expect(store.humanInboxPolicy).toHaveBeenCalledWith('ws-a');
  });

  it.each([
    [{ type: 'admin' }, 'global token'],
    [{ type: 'workspace', workspaceId: 'ws-peer' }, 'peer token'],
  ])('denies %s from writing without a same-workspace scope', async (resolvedScope, _label) => {
    const { default: handler } = await import('@/pages/api/cli/mission-control/events');
    scope.resolveCliScope.mockReturnValue(resolvedScope);
    scope.canDriveWorkspace.mockReturnValue(false);
    const { state, res } = fakeResponse();
    await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers: {}, body: { events: [start] } } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(403);
    expect(store.applyEvents).not.toHaveBeenCalled();
  });

  it('resolves the live binding server-side for a same-workspace start', async () => {
    const { default: handler } = await import('@/pages/api/cli/mission-control/events');
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    scope.canDriveWorkspace.mockReturnValue(true);
    const { state, res } = fakeResponse();
    await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers: {}, body: { events: [start] } } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(200);
    expect(runtime.resolveMissionTargetIdentity).toHaveBeenCalledWith('ws-a', 'tab-a');
    expect(store.applyEvents).toHaveBeenCalledWith([start], expect.any(Map));
  });

  it('rejects a batch containing another workspace before storage', async () => {
    const { default: handler } = await import('@/pages/api/cli/mission-control/events');
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    scope.canDriveWorkspace.mockReturnValue(true);
    const { state, res } = fakeResponse();
    await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers: {}, body: { events: [{ ...start, workspaceId: 'ws-b' }] } } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(403);
    expect(store.applyEvents).not.toHaveBeenCalled();
  });

  it('resolves review identity before reading configured orchestrator and passes both to storage', async () => {
    const { default: handler } = await import('@/pages/api/cli/mission-control/events');
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    scope.canDriveWorkspace.mockReturnValue(true);
    const review = {
      eventId: 'event-review', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_100, bindingGeneration: 1,
      type: 'attention.updated',
      payload: {
        itemId: 'item-a', kind: 'question', title: 'Approve', context: 'Approve the release.',
        storyIds: [], options: [], recommendation: null, blockingScope: 'run', canContinue: false,
        humanReview: {
          humanNeed: 'approval', humanReason: 'Only the human can approve release.',
          handling: 'The orchestrator checked delegated authority.', reviewerTabId: 'tab-a',
        },
      },
    };
    const { state, res } = fakeResponse();
    await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers: {}, body: { events: [review] } } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(200);
    expect(runtime.resolveMissionTargetIdentity).toHaveBeenCalledWith('ws-a', 'tab-a');
    expect(workspace.getWorkspaceById).toHaveBeenCalledWith('ws-a');
    const authorities = store.applyEvents.mock.calls[0][1] as Map<string, unknown>;
    expect(authorities.get('event-review')).toEqual({
      resolvedIdentity: { tabId: 'tab-a', providerId: 'codex', sessionId: 'session-a', runtimeGeneration: 'runtime-a' },
      configuredOrchestratorTabId: 'tab-a',
      opener: null,
    });
    expect(state.body).toMatchObject({ humanInboxPolicy: { version: 1, legacyReviewPending: 0 } });
  });

  it('does not resolve identity or reread configuration for an identical replay', async () => {
    const { default: handler } = await import('@/pages/api/cli/mission-control/events');
    scope.resolveCliScope.mockReturnValue({ type: 'workspace', workspaceId: 'ws-a' });
    scope.canDriveWorkspace.mockReturnValue(true);
    store.unreplayedEventIds.mockReturnValue(new Set());
    const replay = {
      eventId: 'event-review-replay', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a',
      expectedRevision: 1, producerAt: 1_700_000_000_100, bindingGeneration: 1,
      type: 'attention.updated',
      payload: {
        itemId: 'item-a', kind: 'question', title: 'Approve', context: 'Approve the release.',
        storyIds: [], options: [], recommendation: null, blockingScope: 'run', canContinue: false,
        humanReview: {
          humanNeed: 'approval', humanReason: 'Only the human can approve release.',
          handling: 'The orchestrator checked delegated authority.', reviewerTabId: 'tab-a',
        },
      },
    };
    const { state, res } = fakeResponse();
    await handler({ method: 'POST', query: { workspaceId: 'ws-a' }, headers: {}, body: { events: [replay] } } as unknown as NextApiRequest, res);
    expect(state.statusCode).toBe(200);
    expect(runtime.resolveMissionTargetIdentity).not.toHaveBeenCalled();
    expect(workspace.getWorkspaceById).not.toHaveBeenCalled();
    expect(store.applyEvents).toHaveBeenCalledWith([replay], new Map());
  });
});
