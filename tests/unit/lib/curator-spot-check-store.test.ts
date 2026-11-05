import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionControlStore } from '@/lib/mission-control-store';
import { parseMissionEventBatch } from '@/lib/mission-control-validation';
import type { TMissionProducerEvent } from '@/types/mission-control';

// Review r1 F1: the spot-check event the CLI posts, through the REAL Mission Control store: a new item at revision 0,
// visible to the owner, and the number map written only after the store holds it.

const holder = vi.hoisted(() => ({ store: null as MissionControlStore | null }));
vi.mock('@/lib/mission-control-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mission-control-store')>()),
  getMissionControlStore: () => holder.store,
}));

const { spotCheckEvent } = createRequire(import.meta.url)(path.resolve('bin/curator-spot-check-event.js')) as {
  spotCheckEvent: (input: Record<string, unknown>) => TMissionProducerEvent;
};

const binding = { tabId: 'tab-orch', providerId: 'claude', sessionId: 'session-1', runtimeGeneration: 'launch-1' };
let directory = '';
let home: ReturnType<typeof vi.spyOn>;

const authority = (event: TMissionProducerEvent) => new Map([[event.eventId, { resolvedIdentity: binding, configuredOrchestratorTabId: binding.tabId }]]);

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-curator-spot-store-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  for (const key of ['__ptCuratorSpotDrafts', '__ptCuratorStateLock']) delete (globalThis as Record<string, unknown>)[key];
  holder.store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  const start: TMissionProducerEvent = {
    schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', producerAt: 1, eventId: 'e-start', expectedRevision: 0, bindingGeneration: 0,
    type: 'run.started', payload: { objective: 'Ship', tabId: binding.tabId },
  };
  holder.store.applyEvents([start], new Map([[start.eventId, binding]]));
});

afterEach(() => {
  holder.store?.close();
  holder.store = null;
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the spot-check item through the real store', () => {
  it('the event the CLI builds opens a visible item at revision 0; the map is written only after, by commit', async () => {
    const service = await import('@/lib/curator-service');
    const sources = await import('@/lib/curator-sources');
    fs.mkdirSync(path.join(directory, '.purplemux/curator/eval'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.purplemux/curator/eval/classify-owner-message.json'), JSON.stringify({
      task: 'classify-owner-message', labelledBy: 't', labelledAt: 't',
      items: ['standing-order', 'product-rule', 'answer', 'status-ping', 'one-off'].flatMap((label) => Array.from({ length: 6 }, (_, i) => ({ id: `ws-x/${label}-${i}`, label }))),
    }));
    const spy = vi.spyOn(sources, 'resolveLabelledText').mockImplementation(async (item) => `message ${typeof item === 'string' ? item : item.id}`);
    const draft = await service.draftSpotCheck('classify-owner-message', 'ws-a', Date.now());
    const run = holder.store!.snapshot().runs[0];
    expect(run.revision).toBeGreaterThan(0);
    const event = spotCheckEvent({ draft, run: { runId: run.id, revision: run.revision, bindingGeneration: run.binding!.generation, tabId: binding.tabId }, workspaceId: 'ws-a', task: 'classify-owner-message', now: 2 });
    expect(event.expectedRevision).toBe(0);
    const { events } = parseMissionEventBatch([event], { questionMinVersion: 2 });
    const mapFile = path.join(directory, '.purplemux/curator/eval/spot-check.classify-owner-message.json');
    expect(fs.existsSync(mapFile)).toBe(false);
    holder.store!.applyEvents(events, authority(event), { questionMinVersion: 2 });
    const item = holder.store!.snapshot().items.find((i) => i.id === draft.itemId)!;
    expect(item).toMatchObject({ state: 'open', revision: 1, humanReview: { humanNeed: 'decision', reviewerTabId: binding.tabId } });
    expect(JSON.parse(holder.store!.itemQuestion('ws-a', draft.itemId)!.questionJson)).toMatchObject({ formatVersion: 2, answerType: 'multi' });
    expect(await service.commitSpotCheck('classify-owner-message', 'ws-a', draft.itemId)).toMatchObject({ committed: true });
    expect(Object.keys(JSON.parse(fs.readFileSync(mapFile, 'utf-8')).numbers)).toHaveLength(30);
    spy.mockRestore();
  });

  it("the r1 event (expectedRevision = the run's revision) is refused, so nothing would ever have opened", async () => {
    const run = holder.store!.snapshot().runs[0];
    const draft = { itemId: 'curator-spot-check-owner-x', question: { formatVersion: 2, kind: 'question', title: 't', decision: 'Which?', whyNow: 'w', answerType: 'multi',
      options: [{ id: 'a', label: 'A', recommended: false, needsText: false }, { id: 'b', label: 'B', recommended: false, needsText: false }], context: 'c', storyIds: [],
      blockingScope: 'none', canContinue: true } };
    const event = { ...spotCheckEvent({ draft, run: { runId: run.id, bindingGeneration: run.binding!.generation, tabId: binding.tabId }, workspaceId: 'ws-a', task: 'classify-owner-message', now: 2 }), expectedRevision: run.revision };
    const { events } = parseMissionEventBatch([event], { questionMinVersion: 2 });
    expect(() => holder.store!.applyEvents(events, authority(event), { questionMinVersion: 2 })).toThrow();
    expect(holder.store!.snapshot().items).toEqual([]);
  });
});
