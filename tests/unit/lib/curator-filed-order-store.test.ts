import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openFiledOrderItem } from '@/lib/curator-filed-order';
import { MissionControlStore } from '@/lib/mission-control-store';
import { CURATOR_ORDER_EVENT_PREFIX, parseMissionEventBatch } from '@/lib/mission-control-validation';
import type { TMissionProducerEvent } from '@/types/mission-control';

// Story 23 AC 2 through the REAL Mission Control store: the keep-or-strike item opens owner-visible on the
// orchestrator's run; an owner message read as an answer is a suggested link on the latest item awaiting the owner,
// never an answer, and the item's revision does not move.

const binding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', runtimeGeneration: 'launch-1' };
let directory = '';
let store: MissionControlStore;

const authority = (events: TMissionProducerEvent[]) =>
  new Map(events.map((e) => [e.eventId, { resolvedIdentity: binding, configuredOrchestratorTabId: binding.tabId }]));

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-curator-filed-store-'));
  store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  const start: TMissionProducerEvent = {
    schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', producerAt: 1, eventId: 'e-start', expectedRevision: 0, bindingGeneration: 0,
    type: 'run.started', payload: { objective: 'Ship', tabId: binding.tabId },
  };
  store.applyEvents([start], new Map([[start.eventId, binding]]));
});

afterEach(() => {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const openFiled = async (orderId: string, at: number) => openFiledOrderItem({
  now: () => at,
  orchestratorTabId: async () => binding.tabId,
  openRuns: (ws) => store.listOpenRunBindings(ws),
  apply: async (_ws, raw, _opener, options) => {
    const { events } = parseMissionEventBatch(raw, { questionMinVersion: 2, serverPrefix: options.serverPrefix });
    return store.applyEvents(events, authority(events), { questionMinVersion: 2 });
  },
}, { orderId, text: 'From now on use AEDT', workspaceId: 'ws-a', entryId: 'm1', at, promptVersion: 'v' });

describe('the filed-order item and the answer link, in the real store', () => {
  it('opens the keep-or-strike item owner-visible, bookkeeping, default keep', async () => {
    expect(await openFiled('SO-12', 10)).toEqual({ opened: true, itemId: 'curator-so-12' });
    const item = store.snapshot().items.find((i) => i.id === 'curator-so-12')!;
    expect(item).toMatchObject({ state: 'open', class: 'bookkeeping', defaultOptionId: 'keep', answerType: 'confirm', humanReview: { humanNeed: 'decision' } });
    expect(CURATOR_ORDER_EVENT_PREFIX).toBe('system:curator-so:');
  });

  it('suggests a link on the latest open item awaiting the owner before the message; the item keeps its revision and gets no answer', async () => {
    await openFiled('SO-1', 10);
    await openFiled('SO-2', 20);
    const before = store.snapshot().items.find((i) => i.id === 'curator-so-2')!;
    const latest = store.latestOwnerItemBefore('ws-a', Date.now() + 1000);
    expect(latest).toBe('curator-so-2');
    store.suggestAnswer('ws-a', latest!, 'm9', 'yes keep it', 30);
    store.suggestAnswer('ws-a', latest!, 'm9', 'yes keep it', 30);
    const after = store.snapshot().items.find((i) => i.id === 'curator-so-2')!;
    expect(after.suggestedAnswers).toEqual([{ entryId: 'm9', span: 'yes keep it', at: 30 }]);
    expect(after.revision).toBe(before.revision);
    expect(after.state).toBe('open');
    expect(after.answerId).toBeNull();
    expect(store.snapshot().items.find((i) => i.id === 'curator-so-1')).not.toHaveProperty('suggestedAnswers');
  });

  it('no item awaits the owner before the message, or none is open: no link', () => {
    expect(store.latestOwnerItemBefore('ws-a', Date.now())).toBeNull();
    expect(store.latestOwnerItemBefore('ws-b', Date.now())).toBeNull();
  });
});
