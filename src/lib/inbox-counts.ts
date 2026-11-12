import type { IInboxItem, TInboxState } from '@/types/inbox';

// PMUX-NOTE-DELIVERY change 3: `inbox list` carries its counts, so a board reads a workspace's inbox in one call.

export type TInboxStateCounts = Record<TInboxState, number>;

export interface IInboxCounts {
  /** Every retained item of the workspace, by state. */
  total: TInboxStateCounts;
  /**
   * Held items by the first word of their reason (`stranded-in-composer`, `composer-not-empty`, …). A null-prototype
   * object: a reason head is never read as an inherited key (`constructor`, `__proto__`).
   */
  heldBy: Record<string, number>;
  /** The same counts per target tab. */
  tabs: Record<string, TInboxStateCounts>;
}

const zero = (): TInboxStateCounts => ({ queued: 0, held: 0, delivered: 0, dropped: 0 });

/** The first word of a held reason: `composer-not-empty (30 refusals)` and `transport-uncertain:EPIPE` group by their head. */
export const heldReasonHead = (reason: string | null): string => {
  const head = (reason ?? '').trim().split(/[\s:(]/, 1)[0];
  return head || 'unknown';
};

export const countInbox = (items: readonly IInboxItem[], workspaceId: string): IInboxCounts => {
  const counts: IInboxCounts = { total: zero(), heldBy: Object.create(null) as Record<string, number>, tabs: Object.create(null) as Record<string, TInboxStateCounts> };
  for (const item of items) {
    if (item.targetWorkspaceId !== workspaceId) continue;
    counts.total[item.state] += 1;
    const tab = (counts.tabs[item.targetTabId] ??= zero());
    tab[item.state] += 1;
    if (item.state === 'held') {
      const head = heldReasonHead(item.heldReason);
      counts.heldBy[head] = (counts.heldBy[head] ?? 0) + 1;
    }
  }
  return counts;
};
