import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMissionBinding, TMissionProducerEvent } from '@/types/mission-control';

// vel-MC-ACT, the owner's case 2, end to end on the production path: `mission events` -> applyMissionEventBatch -> the
// REAL store. An owner action the orchestrator opens with no humanReview reaches the owner's Needs you list; any other
// tab's stays a candidate. No authority is injected: the batch builds it from the opener (the server-resolved caller
// tab, as the events route passes it) and the workspace record. Only the live-tab identity read and the workspace
// record are stood in for, as in so-proposal.test.ts.

const live = vi.hoisted(() => ({ store: null as unknown, identities: new Map<string, Omit<IMissionBinding, 'generation'>>() }));
vi.mock('@/lib/mission-control-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mission-control-store')>();
  return { ...actual, getMissionControlStore: () => live.store };
});
vi.mock('@/lib/mission-control-runtime', () => ({
  resolveMissionTargetIdentity: vi.fn(async (_ws: string, tabId: string) => live.identities.get(tabId) ?? null),
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async (id: string) => ({ id, orchestration: { enabled: true, orchestratorTabId: 'tab-orch' } })),
}));
vi.mock('@/lib/mission-question-config', () => ({ readQuestionMinVersion: vi.fn(async () => 1) }));
vi.mock('@/lib/attention-alerts', () => ({ alertOpenedAttention: vi.fn(async () => []) }));
vi.mock('@/lib/curator-service', () => ({ curatorOnMissionEvents: vi.fn() }));

import { MissionControlStore } from '@/lib/mission-control-store';
import { applyMissionEventBatch } from '@/lib/mission-control-events';
import { isMissionHumanInboxItem } from '@/components/features/mission-control/mission-control-utils';

const identityOf = (tabId: string): Omit<IMissionBinding, 'generation'> =>
  ({ tabId, providerId: 'claude', sessionId: `session-${tabId}`, runtimeGeneration: `launch-${tabId}` });

let directory = '';
let store: MissionControlStore;

beforeEach(async () => {
  directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'pmux-owner-action-'));
  store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  live.store = store;
  live.identities = new Map([['tab-orch', identityOf('tab-orch')], ['tab-worker', identityOf('tab-worker')]]);
});

afterEach(async () => {
  store.close();
  await fsp.rm(directory, { recursive: true, force: true });
});

const base = (eventId: string, expectedRevision: number, bindingGeneration: number) => ({
  eventId, schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', expectedRevision, producerAt: 1_700_000_000_000, bindingGeneration,
});
const startRun = () => applyMissionEventBatch('ws-a', [{ ...base('ev-start', 0, 0), type: 'run.started', payload: { objective: 'Ship the release', tabId: 'tab-orch' } }],
  { tabId: 'tab-orch', identity: 'launch' });
const openAction = (eventId: string, itemId: string): TMissionProducerEvent => ({
  ...base(eventId, 0, 1),
  type: 'attention.opened',
  payload: {
    itemId, kind: 'action', title: 'Rotate the deploy token', context: 'The token expires on Friday; only the owner can issue one.',
    storyIds: [], options: [], recommendation: null, blockingScope: 'run', canContinue: false,
  },
} as TMissionProducerEvent);
const itemOf = (itemId: string) => store.snapshot().items.find((item) => item.id === itemId)!;

describe('an owner action opened with no human review, through mission events (vel-MC-ACT)', () => {
  it('by the configured orchestrator: open, external-action, in the owner\'s inbox', async () => {
    await startRun();
    const result = await applyMissionEventBatch('ws-a', [openAction('ev-act', 'item-act')], { tabId: 'tab-orch', identity: 'launch' });
    expect(result.lint).toEqual([expect.objectContaining({ eventId: 'ev-act' })]);
    const item = itemOf('item-act');
    expect(item.state).toBe('open');
    expect(item.humanReview).toMatchObject({ humanNeed: 'external-action', reviewerTabId: 'tab-orch', eventId: 'ev-act' });
    expect(isMissionHumanInboxItem(item)).toBe(true);
  });

  it('by a worker tab: a candidate, never stamped', async () => {
    await startRun();
    await applyMissionEventBatch('ws-a', [openAction('ev-worker', 'item-worker')], { tabId: 'tab-worker', identity: 'launch' });
    const item = itemOf('item-worker');
    expect(item.state).toBe('candidate');
    expect(item.humanReview).toBeNull();
    expect(isMissionHumanInboxItem(item)).toBe(false);
  });

  it('with no opener (a server or admin producer): a candidate', async () => {
    await startRun();
    await applyMissionEventBatch('ws-a', [openAction('ev-server', 'item-server')], null);
    expect(itemOf('item-server').state).toBe('candidate');
  });

  // #60 review follow-up: `hook` and `session` name the tab on the caller's word (ADR-0010). A worker that holds the
  // workspace token can send the orchestrator's session in X-Pmux-Session; the route then names the orchestrator tab.
  it.each(['session', 'hook'] as const)('by the orchestrator tab with a %s identity, not launch: a candidate, never stamped', async (identity) => {
    await startRun();
    await applyMissionEventBatch('ws-a', [openAction(`ev-${identity}`, `item-${identity}`)], { tabId: 'tab-orch', identity });
    const item = itemOf(`item-${identity}`);
    expect(item.state).toBe('candidate');
    expect(item.candidateReason).toBe('workspace-issue');
    expect(item.humanReview).toBeNull();
    expect(isMissionHumanInboxItem(item)).toBe(false);
  });

  it('by the orchestrator tab whose live session no longer matches the run binding: a candidate', async () => {
    await startRun();
    live.identities.set('tab-orch', { ...identityOf('tab-orch'), sessionId: 'session-relaunched' });
    await applyMissionEventBatch('ws-a', [openAction('ev-stale', 'item-stale')], { tabId: 'tab-orch', identity: 'launch' });
    expect(itemOf('item-stale').state).toBe('candidate');
  });
});

describe('a later attention.updated on a stamped owner action (vel-MC-ACT, #60 review follow-up)', () => {
  const update = (eventId: string, expectedRevision: number, title: string, humanReview?: Record<string, unknown>): TMissionProducerEvent => {
    const opened = openAction('unused', 'item-act');
    return {
      ...base(eventId, expectedRevision, 1),
      type: 'attention.updated',
      payload: { ...(opened.payload as object), title, ...(humanReview ? { humanReview } : {}) },
    } as TMissionProducerEvent;
  };

  it('a changed text with no humanReview is refused 409 and the stamp stays; with a humanReview it is re-stamped by that review', async () => {
    await startRun();
    await applyMissionEventBatch('ws-a', [openAction('ev-act', 'item-act')], { tabId: 'tab-orch', identity: 'launch' });
    const stamped = itemOf('item-act');
    expect(stamped.humanReview).toMatchObject({ humanNeed: 'external-action', eventId: 'ev-act' });

    const refused = applyMissionEventBatch('ws-a', [update('ev-upd-bare', 1, 'Rotate the deploy token today')], { tabId: 'tab-orch', identity: 'launch' });
    await expect(refused).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/renewed orchestrator review/) });
    expect(itemOf('item-act')).toEqual(stamped);

    const review = {
      humanNeed: 'external-action',
      humanReason: 'Only the owner can issue the deploy token, and it expires today.',
      handling: 'The orchestrator reviewed the revised step.',
      reviewerTabId: 'tab-orch',
    };
    await applyMissionEventBatch('ws-a', [update('ev-upd-review', 1, 'Rotate the deploy token today', review)], { tabId: 'tab-orch', identity: 'launch' });
    const restamped = itemOf('item-act');
    expect(restamped).toMatchObject({ state: 'open', revision: 2, candidateReason: null, title: 'Rotate the deploy token today' });
    expect(restamped.humanReview).toMatchObject({
      humanNeed: 'external-action', humanReason: review.humanReason, handling: review.handling, reviewerTabId: 'tab-orch', eventId: 'ev-upd-review',
      binding: expect.objectContaining({ tabId: 'tab-orch' }),
    });
    expect(isMissionHumanInboxItem(restamped)).toBe(true);
  });
});
