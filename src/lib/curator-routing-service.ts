import type { ICaller } from '@/lib/caller';
import {
  STRIKE, filedItemEntryId, filedItemReady, filedOrderDeps, filedOrderSource, isFiledOrderItem, isFiledOrderSource, openFiledOrderItem, orderOfItem,
} from '@/lib/curator-filed-order';
import {
  ORDER_CANDIDATES_KEY, normalisedOrderText, parseCandidateMap, type ICuratorRouteRecord, type IOwnerMessage, type IOwnerRoutingDeps,
} from '@/lib/curator-routing';
import { CURATOR_KEYS, demoteCuratorTask, parseRoutingWorkspaces } from '@/lib/curator-service';
import { candidateSent, markCandidateSent, readCuratorState } from '@/lib/curator-store';
import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { createLogger } from '@/lib/logger';
import { appendProductRule } from '@/lib/spec-queue';
import { ORDER_LIMITS } from '@/lib/standing-orders';
import type { IMissionAnswer, IMissionAttentionItem } from '@/types/mission-control';

// The runtime of owner-message routing (story 23 AC 2, AC 5): the standing-order store, the keep-or-strike item, the
// spec queue, the answer suggestion, the v2 candidate line, and the ADR-HFL-06 correction rule.

const log = createLogger('curator');
const TASK = 'classify-owner-message' as const;
const OWNER_TAB = '-';
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** ADR-HFL-06 "what proves it wrong": more than 2% of routed labels corrected in a week sends the task back to shadow. */
export const ROUTED_CORRECTION_LIMIT = 0.02;

const SERVER: ICaller = {
  scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true,
};

/** A strike reason the order store accepts: one line, no control or format character, within its limit. */
const strikeReason = (text: string): string =>
  [...text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/ {2,}/g, ' ').trim()].slice(0, ORDER_LIMITS.reason).join('');

const fleetValue = async (key: string): Promise<string | null> => valueOf(await readFleetConfig(), key)?.value ?? null;

const appendRoute = async (workspaceId: string, record: ICuratorRouteRecord | Record<string, unknown>, at: number): Promise<void> => {
  const { getLedgerStore } = await import('@/lib/ledger-store');
  getLedgerStore().tabEvents.append({ workspaceId, tabId: OWNER_TAB, at, class: 'log', kind: 'curator-route', text: JSON.stringify(record) });
};

const liveTabNamed = async (workspaceId: string, name: string): Promise<string | null> => {
  const { getStatusManager } = await import('@/lib/status-manager');
  const manager = getStatusManager();
  const live = new Set(manager.liveAgentTabs(workspaceId).map((t) => t.tabId));
  const { collectAllTabs, readLayoutFile, resolveLayoutFile } = await import('@/lib/layout-store');
  const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
  const tab = layout ? collectAllTabs(layout.root).find((t) => t.name === name && live.has(t.id)) : undefined;
  return tab?.id ?? null;
};

export const ownerRoutingDeps = (): IOwnerRoutingDeps => ({
  routingOn: async (promptVersion) => {
    const entry = (await readCuratorState()).tasks[TASK];
    return entry?.state === 'routing' && entry.promotedPromptVersion === promptVersion;
  },
  optedIn: async (workspaceId) => parseRoutingWorkspaces(await fleetValue(CURATOR_KEYS.routingWorkspaces)).includes(workspaceId),
  candidateTabName: async (workspaceId) => parseCandidateMap(await fleetValue(ORDER_CANDIDATES_KEY)).get(workspaceId) ?? null,
  sendCandidate: async (message, tabName, line) => {
    // One line per message id, kept on disk after a send that landed (consult C1; review r1 F8).
    const key = `${message.workspaceId}/${message.entryId}`;
    if (await candidateSent(key)) return true;
    const tabId = await liveTabNamed(message.workspaceId, tabName);
    if (!tabId) return false;
    const { getStatusManager } = await import('@/lib/status-manager');
    await getStatusManager().routeTabEvent({ workspaceId: message.workspaceId, tabId, kind: 'curator-candidate', text: line, class: 'digest' });
    // The line landed: a failure to remember it is logged, never reported as a failed route (r2 NIT 3).
    await markCandidateSent(key).catch((err: unknown) => log.warn(`curator: candidate ${key} sent but not remembered (${err instanceof Error ? err.message : String(err)})`));
    return true;
  },
  findActiveOrder: async (workspaceId, text) => {
    const { FLEET, readOrderFile } = await import('@/lib/standing-orders-store');
    const want = normalisedOrderText(text);
    const files = await Promise.all([readOrderFile(workspaceId), readOrderFile(FLEET)]);
    return files.flatMap((f) => f.orders).find((o) => o.state === 'active' && normalisedOrderText(o.text) === want)?.id ?? null;
  },
  fileOrder: async (message, text, promptVersion) => {
    const itemDeps = await filedOrderDeps();
    // Never an order without its keep-or-strike item (review r1 F4): the item must be able to open first.
    const ready = await filedItemReady(itemDeps, message.workspaceId);
    if (!ready.ok) return { orderId: null, reason: `no keep-or-strike item could open: ${ready.reason}` };
    const [{ addStandingOrder, strikeStandingOrder }, { standingOrderDeps }] = await Promise.all([
      import('@/lib/standing-orders-service'), import('@/lib/standing-orders-http'),
    ]);
    const added = await addStandingOrder(standingOrderDeps(), SERVER, message.workspaceId, {
      text, source: filedOrderSource(message.workspaceId, message.entryId, message.at), scope: message.workspaceId, check: 'prose',
    });
    const opened = await openFiledOrderItem(itemDeps, {
      orderId: added.order.id, text, workspaceId: message.workspaceId, entryId: message.entryId, at: message.at, promptVersion,
    });
    if (opened.opened) return { orderId: added.order.id, itemId: opened.itemId };
    const id = added.order.id;
    const why = strikeReason(`its keep-or-strike item did not open (${opened.reason})`);
    try {
      await strikeStandingOrder(standingOrderDeps(), SERVER, id, why);
    } catch (err) {
      const detail = strikeReason(err instanceof Error ? err.message : String(err)).slice(0, 200);
      log.error({ workspaceId: message.workspaceId, orderId: id }, `curator: ${id} is active with no keep-or-strike item; the strike failed (${detail})`);
      return { orderId: id, itemId: null, reason: `${id} is active with no keep-or-strike item: the item did not open (${opened.reason}) and the strike failed (${detail}); strike it with \`purplemux so strike ${id}\`` };
    }
    return { orderId: null, reason: `${id} struck again: ${why}` };
  },
  queueProductRule: async (message, text) => {
    await appendProductRule(message.workspaceId, message.entryId, message.at, text);
  },
  linkAnswer: async (message, span) => {
    const { getMissionControlStore } = await import('@/lib/mission-control-store');
    const store = getMissionControlStore();
    const itemId = store.latestOwnerItemBefore(message.workspaceId, message.at);
    if (itemId) store.suggestAnswer(message.workspaceId, itemId, message.entryId, span, message.at);
    return itemId;
  },
  record: (workspaceId, record, at) => {
    void appendRoute(workspaceId, record, at).catch((err: unknown) => log.warn(`curator: route not logged (${err instanceof Error ? err.message : String(err)})`));
  },
});

/** Routed filings and the owner's strikes over the last week; above 2% struck, the classifier goes back to shadow. */
export const correctionShare = (texts: readonly string[]): { filed: number; struck: number } => {
  let filed = 0;
  let struck = 0;
  for (const text of texts) {
    try {
      const row = JSON.parse(text) as { action?: unknown };
      if (row.action === 'filed-order') filed += 1;
      if (row.action === 'order-struck') struck += 1;
    } catch {
      // a row this module did not write: not a filing
    }
  }
  return { filed, struck };
};

const checkCorrections = async (now: number): Promise<void> => {
  const { getLedgerStore } = await import('@/lib/ledger-store');
  const { filed, struck } = correctionShare(getLedgerStore().tabEvents.curatorRoutesSince(now - WEEK_MS));
  if (filed === 0 || struck / filed <= ROUTED_CORRECTION_LIMIT) return;
  if (await demoteCuratorTask(TASK)) {
    log.warn({ filed, struck }, `curator: ${struck} of ${filed} filed orders struck by the owner in 7 days (over 2%); ${TASK} is back in shadow`);
  }
};

/**
 * An owner's answer on a keep-or-strike item (story 23 AC 2): strike strikes the order and counts as a correction of
 * a routed label; keep changes nothing. Runs after the answer is stored, never inside it.
 */
export const curatorOnMissionAnswer = async (
  item: Pick<IMissionAttentionItem, 'id' | 'workspaceId' | 'context'>, answer: Pick<IMissionAnswer, 'optionIds' | 'actor'>, now: number,
): Promise<void> => {
  if (!isFiledOrderItem(item.id) || !answer.optionIds.includes(STRIKE) || answer.actor.startsWith('system:')) return;
  const orderId = orderOfItem(item.id);
  if (!orderId) return;
  // Only an order the curator filed in this item's workspace, from the message the item names (review r1 F1).
  const entryId = filedItemEntryId(item.context ?? '');
  const { readOrderFile } = await import('@/lib/standing-orders-store');
  const order = (await readOrderFile(item.workspaceId)).orders.find((o) => o.id === orderId);
  const refusal = !entryId ? 'the item names no owner message'
    : !order ? `${orderId} is not an order of ${item.workspaceId}`
      : !isFiledOrderSource(order.source, item.workspaceId, entryId) ? `${orderId}'s source is not the curator's filing of ${item.workspaceId}/${entryId}` : null;
  if (refusal) {
    log.warn({ itemId: item.id }, `curator: strike refused (${refusal})`);
    await appendRoute(item.workspaceId, { task: TASK, sourceId: `${item.workspaceId}/mc/${item.id}`, action: 'strike-refused', target: orderId, reason: refusal }, now);
    return;
  }
  const [{ strikeStandingOrder }, { standingOrderDeps }] = await Promise.all([import('@/lib/standing-orders-service'), import('@/lib/standing-orders-http')]);
  try {
    await strikeStandingOrder(standingOrderDeps(), SERVER, orderId, `struck by the owner from Mission Control item ${item.id}`);
  } catch (err) {
    log.warn({ itemId: item.id }, `curator: ${orderId} not struck (${err instanceof Error ? err.message : String(err)})`);
    return;
  }
  await appendRoute(item.workspaceId, { task: TASK, sourceId: `${item.workspaceId}/mc/${item.id}`, action: 'order-struck', target: orderId }, now);
  await checkCorrections(now);
};

export type { IOwnerMessage };
