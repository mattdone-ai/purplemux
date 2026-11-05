import fs from 'fs';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { MissionControlStore } from '@/lib/mission-control-store';
import type { TMissionProducerEvent } from '@/types/mission-control';

// Story 23 AC 2: the human answer route hands a fresh answer to the curator's keep-or-strike hook after the answer is
// stored; a replayed submission is not handed over again.

const holder = vi.hoisted(() => ({ store: null as MissionControlStore | null }));
vi.mock('@/lib/mission-control-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mission-control-store')>()),
  getMissionControlStore: () => holder.store,
}));
const hook = vi.hoisted(() => ({ onAnswer: vi.fn(async () => undefined) }));
vi.mock('@/lib/curator-routing-service', () => ({ curatorOnMissionAnswer: hook.onAnswer }));
vi.mock('@/lib/workspace-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-token')>()),
  resolveCliScope: () => ({ type: 'workspace', workspaceId: 'ws-a' }),
}));

const binding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', runtimeGeneration: 'launch-1' };
let directory = '';

const seed = (store: MissionControlStore): void => {
  const base = { schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', producerAt: 1 };
  const start: TMissionProducerEvent = { ...base, eventId: 'e-start', expectedRevision: 0, bindingGeneration: 0, type: 'run.started', payload: { objective: 'Ship', tabId: binding.tabId } };
  store.applyEvents([start], new Map([[start.eventId, binding]]));
  const opened: TMissionProducerEvent = {
    ...base, eventId: 'e-open', expectedRevision: 0, bindingGeneration: 1, type: 'attention.opened',
    payload: {
      itemId: 'item-a', kind: 'question', title: 'Raise the budget?', context: 'More turns.', storyIds: [],
      options: [{ id: 'raise', label: 'Raise' }, { id: 'stop', label: 'Stop' }], recommendation: null,
      blockingScope: 'story', canContinue: true, class: 'bookkeeping', defaultOptionId: 'raise',
      humanReview: { humanNeed: 'approval', humanReason: 'Owner call.', handling: 'Checked.', reviewerTabId: binding.tabId },
    },
  };
  store.applyEvents([opened], new Map([[opened.eventId, { resolvedIdentity: binding, configuredOrchestratorTabId: binding.tabId }]]));
};

const post = async (sub: string, body: Record<string, unknown>) => {
  const { default: handler } = await import('@/pages/api/mission-control/items/[itemId]/answers');
  const token = await new SignJWT({ sub }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.NEXTAUTH_SECRET));
  const cookie = `session-token=${token}`;
  const state = { status: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({
    method: 'POST',
    query: { itemId: 'item-a' },
    headers: { cookie, origin: 'http://localhost:8022', host: 'localhost:8022' },
    socket: {},
    body,
  } as unknown as NextApiRequest, res);
  return state as { status: number; body: { code?: string; error?: string } };
};

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = 'mission-control-test-secret-at-least-32-bytes';
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-answer-hook-route-'));
  holder.store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  seed(holder.store);
  hook.onAnswer.mockClear();
});

afterEach(() => {
  holder.store?.close();
  holder.store = null;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the answer route hands a fresh answer to the curator (story 23 AC 2)', () => {
  it('once, after the answer is stored, with the item and the answer; a replay is not handed over', async () => {
    const request = { submissionId: 's-1', expectedRevision: 1, optionIds: ['stop'], text: '', actionCompleted: false };
    expect((await post('owner@example.test', request)).status).toBe(201);
    await vi.waitFor(() => expect(hook.onAnswer).toHaveBeenCalledTimes(1));
    const [item, stored] = hook.onAnswer.mock.calls[0] as unknown as [{ id: string; state: string }, { optionIds: string[]; actor: string }];
    expect(item).toMatchObject({ id: 'item-a', state: 'answered' });
    expect(stored).toMatchObject({ optionIds: ['stop'], actor: 'owner@example.test' });
    expect((await post('owner@example.test', request)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hook.onAnswer).toHaveBeenCalledTimes(1);
  });
});
