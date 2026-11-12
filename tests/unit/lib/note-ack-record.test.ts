import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderInboxLine, renderNotePointerLine } from '@/lib/inbox-templates';
import { LedgerStore } from '@/lib/ledger-store';
import { ackedLogEvent, pointerSpentEvents, renderPointerSpentAlert } from '@/lib/note-pending';
import { TabEventRouter } from '@/lib/tab-event-router';
import type { INote } from '@/types/note';

// PMUX-NOTE-DELIVERY: an ack is recorded in the sender tab's ledger and never typed (change 2); a spent owner-item
// pointer alerts its sender and the Scrum Master seat; the templates state their own minutes and who flagged the item.

const T0 = Date.UTC(2026, 10, 12, 4, 0, 0);

const note = (over: Partial<INote> = {}): INote => ({
  id: 'n-abcd1234', from: { workspaceId: 'ws-2', tabId: 'tab-b', verified: true, epic: null }, to: { epic: null, workspaceId: 'ws-1' },
  subject: 'GO', body: 'the owner says go', createdAt: T0, state: 'acked', routingStatus: 'routed', routingReason: null,
  deliveredTo: { workspaceId: 'ws-1', tabId: 'tab-a' }, routedAt: T0, deliveredAt: T0 + 60_000, inboxItemId: 'i-1',
  ackedAt: T0 + 120_000, ackedBy: { workspaceId: 'ws-1', tabId: 'tab-a' }, ackComment: 'GO taken', remindedAt: null,
  senderNotifiedAt: null, expiredAt: null, transitionAt: T0 + 120_000, ...over,
});

describe('the ack record (change 2)', () => {
  let store: LedgerStore;
  const typed: string[] = [];

  beforeEach(() => { store = new LedgerStore(':memory:'); typed.length = 0; });
  afterEach(() => store.close());

  it('is a fixed log row for the sender: ids and the time, never the comment, subject or body', () => {
    expect(ackedLogEvent(note())).toEqual({
      workspaceId: 'ws-2', tabId: 'tab-b', kind: 'note-acked', class: 'log',
      text: 'note n-abcd1234 acked by ws-1/tab-a at 2026-11-12T04:02:00Z with a comment — purplemux note show n-abcd1234',
    });
    expect(ackedLogEvent(note({ ackComment: null }))!.text).not.toContain('comment');
    expect(ackedLogEvent(note({ from: { workspaceId: null, tabId: null, verified: false, epic: null } }))).toBeNull();
    expect(ackedLogEvent(note({ ackedBy: null, ackedAt: null }))).toBeNull();
  });

  it('routed through the real router it is written to tab_events and typed into no tab, at its prompt or not', async () => {
    const router = new TabEventRouter({
      table: () => store.tabEvents, now: () => T0, atPrompt: () => true,
      deliver: async (_ws, _tab, message) => { typed.push(message); return true; },
    });
    const result = await router.route(ackedLogEvent(note())!);
    expect(result).toMatchObject({ class: 'log', delivered: false });
    expect(store.tabEvents.list('ws-2', { tabId: 'tab-b', since: 0, limit: 10 })).toEqual([
      expect.objectContaining({ kind: 'note-acked', class: 'log', deliveredAt: null }),
    ]);
    // A digest flush for the tab carries no log row either.
    await router.route({ workspaceId: 'ws-2', tabId: 'tab-b', kind: 'turn-ended', class: 'digest', text: 'worker ended' });
    expect(typed.join('\n')).not.toContain('acked');
  });

  it('with the ledger down it is still typed nowhere', async () => {
    const router = new TabEventRouter({
      table: () => { throw new Error('ledger down'); }, now: () => T0, atPrompt: () => true,
      deliver: async (_ws, _tab, message) => { typed.push(message); return true; },
    });
    await expect(router.route(ackedLogEvent(note())!)).resolves.toMatchObject({ delivered: false });
    expect(typed).toEqual([]);
  });
});

describe('the spent-pointer alert', () => {
  const routed = note({ state: 'delivered', deliveredAt: null, ackedAt: null, ackedBy: null, ackComment: null, ownerItem: true });

  it('states what happened, with ids and a time only', () => {
    expect(renderPointerSpentAlert(routed, 'stranded', T0)).toBe('note n-abcd1234: its owner-item pointer line to ws-1/tab-a at'
      + ' 2026-11-12T04:00:00Z stayed in the composer after Enter; it is not typed again, and its inbox notice still waits'
      + ' — purplemux note show n-abcd1234');
    expect(renderPointerSpentAlert(routed, 'unverified', T0)).toContain('could not be confirmed as submitted');
  });

  it('goes to the sender (urgent) and to the seat (digest), never twice to one tab', () => {
    const seat = { workspaceId: 'ws-9', tabId: 'tab-sm' };
    expect(pointerSpentEvents(routed, 'stranded', T0, seat).map((e) => [e.tabId, e.class])).toEqual([['tab-b', 'urgent'], ['tab-sm', 'digest']]);
    expect(pointerSpentEvents(routed, 'stranded', T0, { workspaceId: 'ws-2', tabId: 'tab-b' }).map((e) => e.tabId)).toEqual(['tab-b']);
    expect(pointerSpentEvents(routed, 'stranded', T0, null).map((e) => e.tabId)).toEqual(['tab-b']);
  });
});

describe('the templates', () => {
  it('the undelivered notice states its own minutes, 15 when absent; a bad count is refused', () => {
    const base = { noteId: 'n-abcd1', fromWorkspaceId: 'ws-2', fromTabId: 'tab-b', sentAt: T0, event: 'undelivered' as const };
    expect(renderInboxLine('note', base).line).toContain('after 15 min');
    expect(renderInboxLine('note', { ...base, afterMinutes: 5 }).line).toContain('after 5 min');
    expect(() => renderInboxLine('note', { ...base, afterMinutes: 2.5 })).toThrow();
  });

  it('an owner-item pointer says the sender flagged it; an owner grant still says owner decision', () => {
    const base = { noteId: 'n-abcd1', fromWorkspaceId: 'ws-2', fromTabId: 'tab-b', sentAt: T0 };
    expect(renderNotePointerLine({ ...base, ownerItem: true })).toBe('[purplemux note n-abcd1] from ws-2/tab-b at 2026-11-12T04:00:00Z,'
      + ' flagged owner item, needs action now: run purplemux note show n-abcd1 now, then purplemux note ack n-abcd1');
    expect(renderNotePointerLine(base)).toContain('at 2026-11-12T04:00:00Z needs action now:');
    expect(renderNotePointerLine({ ...base, fromOwner: true, ownerItem: true })).toContain('carries an owner decision');
    expect(() => renderNotePointerLine({ ...base, ownerItem: 'yes' as never })).toThrow();
  });
});
