import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLayoutDir } from '@/lib/layout-store';
import { addMessageHistory, readMessageHistory } from '@/lib/message-history-store';

// Story 36 (D8): the owner's prompts, by workspace, with the tab each was sent to; a re-send keeps its first id.

let seq = 0;
const freshWorkspace = () => `ws-mh-${process.pid}-${++seq}`;

afterEach(() => {
  vi.useRealTimers();
});

describe('message-history-store (story 36, D8)', () => {
  it('records the tab a message was sent to; a message with no tab records null', async () => {
    const ws = freshWorkspace();
    const sent = await addMessageHistory(ws, 'ship it', 'tab-a');
    const bare = await addMessageHistory(ws, 'from the phone');
    expect(sent).toMatchObject({ message: 'ship it', tabId: 'tab-a' });
    expect(bare.tabId).toBeNull();
    expect((await readMessageHistory(ws)).map((e) => [e.message, e.tabId])).toEqual([['from the phone', null], ['ship it', 'tab-a']]);
  });

  it('a re-send of the same text keeps its first id, records the new time and tab, and moves to the front', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const ws = freshWorkspace();
    vi.setSystemTime(new Date('2026-11-04T01:00:00.000Z'));
    const first = await addMessageHistory(ws, 'use AEDT', 'tab-a');
    vi.setSystemTime(new Date('2026-11-04T01:05:00.000Z'));
    await addMessageHistory(ws, 'something else', 'tab-a');
    vi.setSystemTime(new Date('2026-11-04T01:10:00.000Z'));
    const again = await addMessageHistory(ws, 'use AEDT', 'tab-b');
    expect(again).toEqual({ id: first.id, message: 'use AEDT', sentAt: '2026-11-04T01:10:00.000Z', tabId: 'tab-b' });
    const entries = await readMessageHistory(ws);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(again);
  });

  it('keeps the newest 500 entries', async () => {
    const ws = freshWorkspace();
    const file = path.join(resolveLayoutDir(ws), 'message-history.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entries = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, message: `message ${i}`, sentAt: '2026-11-01T00:00:00.000Z' }));
    fs.writeFileSync(file, JSON.stringify({ entries }));
    const added = await addMessageHistory(ws, 'the 501st', 'tab-a');
    const kept = await readMessageHistory(ws);
    expect(kept).toHaveLength(500);
    expect(kept[0].id).toBe(added.id);
    expect(kept.at(-1)!.id).toBe('m498');
    expect(kept.some((e) => e.id === 'm499')).toBe(false);
  });
});
