import { describe, expect, it } from 'vitest';
import { countInbox, heldReasonHead } from '@/lib/inbox-counts';
import type { IInboxItem } from '@/types/inbox';

// PMUX-NOTE-DELIVERY change 3: one call answers how many notices wait, per state, per held reason and per tab.

const item = (id: string, targetTabId: string, state: IInboxItem['state'], heldReason: string | null = null, targetWorkspaceId = 'ws-1') =>
  ({ id, targetWorkspaceId, targetTabId, state, heldReason } as IInboxItem);

describe('countInbox', () => {
  it('counts every retained item of the workspace by state, held reason head and tab', () => {
    const items = [
      item('i-1', 'tab-a', 'held', 'stranded-in-composer'),
      item('i-2', 'tab-a', 'held', 'stranded-in-composer'),
      item('i-3', 'tab-a', 'held', 'composer-not-ready:busy (30 refusals)'),
      item('i-4', 'tab-a', 'queued'),
      item('i-5', 'tab-b', 'delivered'),
      item('i-6', 'tab-b', 'dropped'),
      item('i-7', 'tab-a', 'held', 'transport-uncertain:EPIPE'),
      item('i-8', 'tab-z', 'queued', null, 'ws-2'),
    ];
    expect(countInbox(items, 'ws-1')).toEqual({
      total: { queued: 1, held: 4, delivered: 1, dropped: 1 },
      heldBy: { 'stranded-in-composer': 2, 'composer-not-ready': 1, 'transport-uncertain': 1 },
      tabs: {
        'tab-a': { queued: 1, held: 4, delivered: 0, dropped: 0 },
        'tab-b': { queued: 0, held: 0, delivered: 1, dropped: 1 },
      },
    });
  });

  it('a reason head is never read as an inherited key', () => {
    const counts = countInbox([item('i-1', 'tab-a', 'held', 'constructor'), item('i-2', 'tab-a', 'held', '__proto__ x'),
      item('i-3', 'toString', 'queued')], 'ws-1');
    expect(Object.getPrototypeOf(counts.heldBy)).toBeNull();
    expect(Object.getPrototypeOf(counts.tabs)).toBeNull();
    expect(counts.heldBy.constructor).toBe(1);
    expect(Object.keys(counts.heldBy).sort()).toEqual(['__proto__', 'constructor']);
    expect(JSON.parse(JSON.stringify(counts)).tabs.toString).toEqual({ queued: 1, held: 0, delivered: 0, dropped: 0 });
  });

  it('an empty inbox counts zero', () => {
    expect(countInbox([], 'ws-1')).toEqual({ total: { queued: 0, held: 0, delivered: 0, dropped: 0 }, heldBy: {}, tabs: {} });
  });

  it('a held reason groups by its first word', () => {
    expect(heldReasonHead('composer-not-empty (30 refusals)')).toBe('composer-not-empty');
    expect(heldReasonHead('preflight:note-terminal:acked')).toBe('preflight');
    expect(heldReasonHead(null)).toBe('unknown');
    expect(heldReasonHead('  ')).toBe('unknown');
  });
});
