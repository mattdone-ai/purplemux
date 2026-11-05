import { describe, expect, it, vi } from 'vitest';
import {
  FILED_ORDER_ITEM_PREFIX, buildFiledOrderQuestion, filedOrderItemId, openFiledOrderItem, orderOfItem, ownerTime, type IFiledOrderDeps,
} from '@/lib/curator-filed-order';
import { CURATOR_ORDER_EVENT_PREFIX, parseMissionEventBatch } from '@/lib/mission-control-validation';
import { validateMissionQuestion } from '@/lib/mission-question-format';

// Story 23 AC 2: an order the curator filed opens one item: format 2 confirm, class bookkeeping, default keep,
// "Filed SO-n from your message: keep or strike", on the orchestrator's run, under the server's own event prefix.

const order = { orderId: 'SO-12', text: 'From now on answer status asks with the board URL', workspaceId: 'ws-a', entryId: 'm1', at: Date.parse('2026-11-03T04:05:00Z'), promptVersion: 'com-v1-6eec31d7~aaaaaaaa' };

describe('the keep-or-strike item (AC 2)', () => {
  it('is a valid format-2 confirm question of class bookkeeping with keep as its default', () => {
    const question = buildFiledOrderQuestion(order);
    const verdict = validateMissionQuestion(question, 2);
    expect(verdict.ok).toBe(true);
    expect(question).toMatchObject({
      answerType: 'confirm', class: 'bookkeeping', defaultOptionId: 'keep', decision: 'Filed SO-12 from your message: keep or strike',
    });
    expect((question.options as Array<{ id: string }>).map((o) => o.id)).toEqual(['keep', 'strike']);
    expect(question.context).toContain('> From now on answer status asks with the board URL');
    expect(question.context).toContain('2026-11-03 15:05 AEDT');
  });

  it('names its order in its id, and only its own ids', () => {
    expect(filedOrderItemId('SO-12')).toBe(`${FILED_ORDER_ITEM_PREFIX}12`);
    expect(orderOfItem('curator-so-12')).toBe('SO-12');
    expect(orderOfItem('curator-so-x')).toBeNull();
    expect(orderOfItem('nd-123')).toBeNull();
  });

  it('owner times are Sydney time with the zone name', () => {
    expect(ownerTime(Date.parse('2026-07-01T00:00:00Z'))).toBe('2026-07-01 10:00 AEST');
  });

  const deps = (over: Partial<IFiledOrderDeps> = {}): IFiledOrderDeps & { apply: ReturnType<typeof vi.fn> } => ({
    now: () => 5,
    orchestratorTabId: async () => 'tab-o',
    openRuns: () => [{ runId: 'run-1', binding: { tabId: 'tab-o', generation: 3 } } as never],
    apply: vi.fn(async () => ({})),
    ...over,
  }) as IFiledOrderDeps & { apply: ReturnType<typeof vi.fn> };

  it('opens on the orchestrator\'s bound run, with no opener and the reserved server prefix, and passes the events validator', async () => {
    const d = deps();
    expect(await openFiledOrderItem(d, order)).toEqual({ opened: true, itemId: 'curator-so-12' });
    const [ws, events, opener, options] = d.apply.mock.calls[0];
    expect([ws, opener, options]).toEqual(['ws-a', null, { serverPrefix: CURATOR_ORDER_EVENT_PREFIX }]);
    expect(events[0]).toMatchObject({ eventId: 'system:curator-so:curator-so-12', runId: 'run-1', bindingGeneration: 3, expectedRevision: 0 });
    expect(events[0].payload.humanReview).toMatchObject({ humanNeed: 'decision', reviewerTabId: 'tab-o' });
    expect(() => parseMissionEventBatch(events, { questionMinVersion: 2, serverPrefix: CURATOR_ORDER_EVENT_PREFIX })).not.toThrow();
    expect(() => parseMissionEventBatch(events, { questionMinVersion: 2 })).toThrow();
  });

  it('without an orchestrator, a bound run, or when the apply refuses, it says why and the order stays filed', async () => {
    expect(await openFiledOrderItem(deps({ orchestratorTabId: async () => null }), order)).toEqual({ opened: false, itemId: 'curator-so-12', reason: 'no orchestrator' });
    expect(await openFiledOrderItem(deps({ openRuns: () => [] }), order)).toMatchObject({ opened: false, reason: 'no open run bound to the orchestrator tab-o' });
    expect(await openFiledOrderItem(deps({ apply: vi.fn(async () => { throw new Error('stale generation'); }) }), order)).toMatchObject({ opened: false, reason: 'stale generation' });
  });
});

describe('the curator-so- item namespace is the server\'s (review r1 F1)', () => {
  const tabEvent = (type: 'attention.opened' | 'attention.updated', itemId: string, eventId = `tab-${itemId}-${type}`) => ({
    eventId, schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-1', expectedRevision: 0, producerAt: 1, bindingGeneration: 1, type,
    payload: { itemId, ...buildFiledOrderQuestion({ ...order, orderId: 'SO-5' }) },
  });

  it('a tab (or any token) that opens or revises a curator-so-5 item is refused, whatever its event id', () => {
    for (const type of ['attention.opened', 'attention.updated'] as const) {
      expect(() => parseMissionEventBatch([tabEvent(type, 'curator-so-5')], { questionMinVersion: 2 }))
        .toThrow('item ID curator-so-5 uses a namespace only the server opens or revises');
      expect(() => parseMissionEventBatch([tabEvent(type, 'curator-so-5')], { questionMinVersion: 2, serverPrefix: 'system:needs-decision:' }))
        .toThrow('uses a namespace only the server opens or revises');
    }
  });

  it('the server\'s own opener, under its prefix, may; other item ids are untouched', () => {
    expect(() => parseMissionEventBatch([tabEvent('attention.opened', 'curator-so-5', 'system:curator-so:curator-so-5')],
      { questionMinVersion: 2, serverPrefix: CURATOR_ORDER_EVENT_PREFIX })).not.toThrow();
    expect(() => parseMissionEventBatch([tabEvent('attention.opened', 'curator-sox')], { questionMinVersion: 2 })).not.toThrow();
  });

  it('the item names its message, and only an order sourced from that message by the curator matches', async () => {
    const { filedItemEntryId, filedOrderSource, isFiledOrderSource } = await import('@/lib/curator-filed-order');
    expect(filedItemEntryId(buildFiledOrderQuestion(order).context as string)).toBe('m1');
    const source = filedOrderSource('ws-a', 'm1', order.at);
    expect(source).toBe('owner message ws-a/m1 (2026-11-03 UTC), filed by the curator');
    expect(isFiledOrderSource(source, 'ws-a', 'm1')).toBe(true);
    expect(isFiledOrderSource(source, 'ws-a', 'm2')).toBe(false);
    expect(isFiledOrderSource(source, 'ws-b', 'm1')).toBe(false);
    expect(isFiledOrderSource('owner message ws-a/m1 (2026-11-03 UTC)', 'ws-a', 'm1')).toBe(false);
  });
});
