import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0041 §1 amendment D7 rule 6: the human answer route runs the proposal step after it stores the answer, never inside
// that transaction, beside the curator's step; a replay runs it too (the step files nothing twice). Any other item does not.

const calls = vi.hoisted(() => ({ settled: [] as string[], curator: [] as string[], order: [] as string[] }));
const stored = vi.hoisted(() => ({ replayed: false, itemId: 'so-proposal-0123456789abcdef01234567' }));
vi.mock('@/lib/mission-control-http', () => ({
  requireMissionHuman: async () => 'human:owner',
  requireMissionSameOrigin: () => undefined,
  setMissionHeaders: () => undefined,
  sendMissionError: (res: NextApiResponse, err: unknown) => res.status(500).json({ error: String(err) }),
}));
vi.mock('@/lib/mission-control-validation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/mission-control-validation')>(),
  parseMissionAnswer: (body: unknown) => body,
}));
vi.mock('@/lib/mission-control-store', () => ({
  getMissionControlStore: () => ({
    submitAnswer: (itemId: string) => {
      calls.order.push('stored');
      return { replayed: stored.replayed, item: { id: itemId, workspaceId: 'ws-sm', context: '' }, answer: { optionIds: ['yes'], actor: 'human:owner' } };
    },
  }),
}));
vi.mock('@/lib/so-proposal-service', () => ({ settleProposalSoon: (itemId: string) => { calls.order.push('step'); calls.settled.push(itemId); } }));
vi.mock('@/lib/curator-routing-service', () => ({ curatorOnMissionAnswer: async (item: { id: string }) => { calls.curator.push(item.id); } }));

const call = async (itemId: string) => {
  const out = { status: 0 };
  const res = { setHeader() { return this; }, status(code: number) { out.status = code; return this; }, json() { return this; } } as unknown as NextApiResponse;
  const { default: handler } = await import('@/pages/api/mission-control/items/[itemId]/answers');
  await handler({ method: 'POST', query: { itemId }, body: {}, headers: {} } as unknown as NextApiRequest, res);
  return out;
};

beforeEach(() => {
  calls.settled = [];
  calls.curator = [];
  calls.order = [];
  stored.replayed = false;
});

describe('the answer route runs the proposal step after the answer is stored', () => {
  it('a so-proposal- item: the step runs after the store, on a fresh answer and on a replay', async () => {
    expect((await call(stored.itemId)).status).toBe(201);
    await vi.waitFor(() => expect(calls.settled).toEqual([stored.itemId]));
    expect(calls.order).toEqual(['stored', 'step']);
    stored.replayed = true;
    expect((await call(stored.itemId)).status).toBe(200);
    await vi.waitFor(() => expect(calls.settled).toEqual([stored.itemId, stored.itemId]));
  });

  it('any other item: no proposal step', async () => {
    await call('curator-so-12');
    await call('nd-0123');
    await vi.waitFor(() => expect(calls.curator).toEqual(['curator-so-12', 'nd-0123']));
    expect(calls.settled).toEqual([]);
  });
});
