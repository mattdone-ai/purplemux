import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 23 AC 3, AC 5: `mc ask --fix` reaches the reshape route; a tab reshapes for its own workspace; the check route
// says whether the reshape routes here.

const h = vi.hoisted(() => ({
  caller: null as null | { admin: boolean; workspaceId: string | null; tabId: string | null },
  reshape: vi.fn(async () => ({ outcome: 'shadow', reason: 'r' })),
  enabled: vi.fn(async () => true),
  routesIn: vi.fn(async () => false),
}));
vi.mock('@/lib/caller', () => ({ resolveCaller: vi.fn(async () => h.caller) }));
vi.mock('@/lib/curator-reshape-service', () => ({ reshapeForAsk: h.reshape }));
vi.mock('@/lib/curator-service', () => ({ curatorEnabled: h.enabled, curatorRoutesIn: h.routesIn }));
vi.mock('@/lib/mission-question-config', () => ({ readQuestionMinVersion: vi.fn(async () => 1) }));

const call = async (route: string, body: unknown, workspaceId = 'ws-a') => {
  const { default: handler } = await import(route);
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
  await handler({ method: 'POST', query: { workspaceId }, headers: {}, body } as unknown as NextApiRequest, res);
  return state as { status: number; body: Record<string, unknown> };
};

const draft = { formatVersion: 2, kind: 'question', title: 'T', decision: 'D', answerType: 'single', options: [], storyIds: [], blockingScope: 'story', canContinue: true };

beforeEach(() => {
  h.caller = { admin: false, workspaceId: 'ws-a', tabId: 'tab-1' };
  h.reshape.mockClear();
  h.enabled.mockResolvedValue(true);
  h.routesIn.mockResolvedValue(false);
});

describe('POST /api/cli/mission-control/questions/reshape', () => {
  it('hands the draft to the curator reshape with the caller\'s workspace and tab, and answers its outcome', async () => {
    const res = await call('@/pages/api/cli/mission-control/questions/reshape', { question: draft });
    expect(res).toEqual({ status: 200, body: { outcome: 'shadow', reason: 'r' } });
    expect(h.reshape).toHaveBeenCalledWith('ws-a', 'tab-1', draft);
  });

  it('a tab of another workspace is refused; no token is 401; a body without a question is 400', async () => {
    expect((await call('@/pages/api/cli/mission-control/questions/reshape', { question: draft }, 'ws-ldhziO')).status).toBe(403);
    h.caller = null;
    expect((await call('@/pages/api/cli/mission-control/questions/reshape', { question: draft })).status).toBe(401);
    h.caller = { admin: false, workspaceId: 'ws-a', tabId: 'tab-1' };
    expect((await call('@/pages/api/cli/mission-control/questions/reshape', { draft })).status).toBe(400);
    expect(h.reshape).not.toHaveBeenCalled();
  });
});

describe('the check route\'s reshape seam', () => {
  it('reads enabled only where reshape-question routes in the workspace, and says why otherwise', async () => {
    const shadow = await call('@/pages/api/cli/mission-control/questions/check', { question: draft });
    expect(shadow.body.reshape).toEqual({ enabled: false, reason: 'the curator reshape is in shadow for this workspace: --fix logs a reshape and posts nothing' });
    expect(h.routesIn).toHaveBeenCalledWith('reshape-question', 'ws-a');
    h.routesIn.mockResolvedValue(true);
    expect((await call('@/pages/api/cli/mission-control/questions/check', { question: draft })).body.reshape).toEqual({ enabled: true, reason: null });
    h.enabled.mockResolvedValue(false);
    expect((await call('@/pages/api/cli/mission-control/questions/check', { question: draft })).body.reshape)
      .toEqual({ enabled: false, reason: 'the curator is switched off (curator.enabled=off)' });
  });
});
