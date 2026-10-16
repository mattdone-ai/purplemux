import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionControlStore } from '@/lib/mission-control-store';
import type { TMissionProducerEvent } from '@/types/mission-control';

// ADR-0023: who opened an SM-inbox item lives in an unversioned side table,
// written in the same transaction as the item, first opener wins, and the
// schema version stays 4 so a rolled-back release still opens the file.

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const dbPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purplemux-openers-'));
  scratch.push(dir);
  return path.join(dir, 'mission.sqlite');
};

const identity = { tabId: 'tab-sm', providerId: 'claude', sessionId: 'session-sm', runtimeGeneration: null };

const start: TMissionProducerEvent = {
  eventId: 'e-start', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0,
  producerAt: 1_700_000_000_000, bindingGeneration: 0, type: 'run.started',
  payload: { objective: 'SM inbox', tabId: 'tab-sm' },
};
const opened = (itemId: string, eventId = `e-${itemId}`): TMissionProducerEvent => ({
  eventId, schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 0,
  producerAt: 1_700_000_000_100, bindingGeneration: 1, type: 'attention.opened',
  payload: {
    itemId, kind: 'question', title: `Question ${itemId}`, context: 'ctx', storyIds: [], options: [],
    recommendation: 'SM to rule', blockingScope: 'story', canContinue: true,
  },
});
const authority = (opener: { tabId: string; identity: 'launch' | 'hook' | 'session' } | null) => ({
  resolvedIdentity: null, configuredOrchestratorTabId: null, opener,
});

const seeded = (file = dbPath()) => {
  const store = new MissionControlStore(file);
  store.applyEvents([start], new Map([[start.eventId, identity]]));
  return { store, file };
};

describe('Mission Control item openers', () => {
  it('records the opener of a new item and lists open items with it', () => {
    const { store } = seeded();
    const a = opened('item-a');
    const b = opened('item-b');
    store.applyEvents([a], new Map([[a.eventId, authority({ tabId: 'tab-worker', identity: 'launch' })]]));
    store.applyEvents([b], new Map([[b.eventId, authority(null)]]));
    expect(store.openItemOpeners()).toEqual([
      expect.objectContaining({ workspaceId: 'ws-a', itemId: 'item-a', reviewed: false, opener: { tabId: 'tab-worker', identity: 'launch' } }),
      expect.objectContaining({ itemId: 'item-b', opener: null }),
    ]);
    store.close();
  });

  it('a replayed open keeps the first opener; a cancelled item leaves the list', () => {
    const { store } = seeded();
    const a = opened('item-a');
    store.applyEvents([a], new Map([[a.eventId, authority({ tabId: 'tab-worker', identity: 'hook' })]]));
    store.applyEvents([a], new Map([[a.eventId, authority({ tabId: 'tab-other', identity: 'launch' })]]));
    expect(store.openItemOpeners()[0].opener).toEqual({ tabId: 'tab-worker', identity: 'hook' });
    const cancel: TMissionProducerEvent = {
      eventId: 'e-cancel', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-a', expectedRevision: 1,
      producerAt: 1_700_000_000_200, bindingGeneration: 1, type: 'attention.cancelled', payload: { itemId: 'item-a', reason: 'Done: x' },
    };
    store.applyEvents([cancel]);
    expect(store.openItemOpeners()).toEqual([]);
    store.close();
  });

  it('a failed batch writes no opener row (one transaction with the item)', () => {
    const { store, file } = seeded();
    const good = opened('item-a');
    const bad = { ...opened('item-b'), runId: 'run-missing' } as TMissionProducerEvent;
    expect(() => store.applyEvents([good, bad], new Map([
      [good.eventId, authority({ tabId: 'tab-worker', identity: 'launch' })],
      [bad.eventId, authority({ tabId: 'tab-worker', identity: 'launch' })],
    ]))).toThrow();
    store.close();
    const raw = new Database(file, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM mission_item_openers').get()).toEqual({ n: 0 });
    raw.close();
  });

  it('keeps user_version at 4 and reopens a file that already holds the side table', () => {
    const { store, file } = seeded();
    const a = opened('item-a');
    store.applyEvents([a], new Map([[a.eventId, authority({ tabId: 'tab-worker', identity: 'session' })]]));
    store.close();
    const raw = new Database(file);
    expect(raw.pragma('user_version', { simple: true })).toBe(4);
    raw.close();
    const reopened = new MissionControlStore(file);
    expect(reopened.openItemOpeners()[0].opener).toEqual({ tabId: 'tab-worker', identity: 'session' });
    reopened.close();
  });

  it('a schema-4 file written without the side table gains it on open, and its items read unattributed', () => {
    const { store, file } = seeded();
    const a = opened('item-a');
    store.applyEvents([a], new Map([[a.eventId, authority({ tabId: 'tab-worker', identity: 'launch' })]]));
    store.close();
    const raw = new Database(file);
    raw.exec('DROP TABLE mission_item_openers');
    raw.close();
    const reopened = new MissionControlStore(file);
    expect(reopened.openItemOpeners()).toEqual([expect.objectContaining({ itemId: 'item-a', opener: null })]);
    reopened.close();
  });

  it('an unknown identity token in the side table reads as no opener', () => {
    const { store, file } = seeded();
    const a = opened('item-a');
    store.applyEvents([a], new Map([[a.eventId, authority({ tabId: 'tab-worker', identity: 'launch' })]]));
    store.close();
    const raw = new Database(file);
    raw.prepare("UPDATE mission_item_openers SET identity='forged'").run();
    raw.close();
    const reopened = new MissionControlStore(file);
    expect(reopened.openItemOpeners()[0].opener).toBeNull();
    reopened.close();
  });
});
