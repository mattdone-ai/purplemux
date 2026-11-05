import { createLogger } from '@/lib/logger';
import type { IMissionItemOpener, IMissionOpenRunBinding } from '@/lib/mission-control-store';
import { CURATOR_ORDER_EVENT_PREFIX, CURATOR_ORDER_ITEM_PREFIX } from '@/lib/mission-control-validation';

// The keep-or-strike item for an order the curator filed from an owner message (ADR-HFL-05 decision 7; story 23
// AC 2): format 2 `confirm`, class `bookkeeping`, default keep, opened on the workspace orchestrator's run like a
// NEEDS-DECISION item (ADR-0041). The server applies the answer: strike strikes the order, keep changes nothing.

const log = createLogger('curator');

export const FILED_ORDER_ITEM_PREFIX = CURATOR_ORDER_ITEM_PREFIX;
export const KEEP = 'keep';
export const STRIKE = 'strike';

export const filedOrderItemId = (orderId: string): string => `${FILED_ORDER_ITEM_PREFIX}${orderId.replace(/^SO-/, '')}`;

/** The order an item id names, or null when it is not a filed-order item. */
export const orderOfItem = (itemId: string): string | null => {
  const m = new RegExp(`^${FILED_ORDER_ITEM_PREFIX}([1-9]\\d{0,5})$`).exec(itemId);
  return m ? `SO-${m[1]}` : null;
};

export const isFiledOrderItem = (itemId: string): boolean => itemId.startsWith(FILED_ORDER_ITEM_PREFIX);

const FILED_BY = ', filed by the curator';

/** The `source` of an order the curator files: the owner message it came from, by id, and who filed it. */
export const filedOrderSource = (workspaceId: string, entryId: string, at: number): string =>
  `owner message ${workspaceId}/${entryId} (${new Date(at).toISOString().slice(0, 10)} UTC)${FILED_BY}`;

/** Whether an order's source names the curator and this workspace's message (review r1 F1). */
export const isFiledOrderSource = (source: string, workspaceId: string, entryId: string): boolean =>
  source.startsWith(`owner message ${workspaceId}/${entryId} (`) && source.endsWith(FILED_BY);

/** The history id the keep-or-strike item names in its context, or null: the item is the server's (its prefix is reserved). */
export const filedItemEntryId = (context: string): string | null =>
  /^From your message at [^\n]*?\(`([A-Za-z0-9_-]{1,64})`\)\./m.exec(context)?.[1] ?? null;

/** A time as the owner reads it: Sydney, with its zone name (AEDT or AEST). */
export const ownerTime = (ms: number): string => {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short',
  }).formatToParts(new Date(ms));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} ${part('timeZoneName')}`;
};

export interface IFiledOrder {
  orderId: string;
  text: string;
  workspaceId: string;
  entryId: string;
  at: number;
  promptVersion: string;
}

export const buildFiledOrderQuestion = (order: IFiledOrder): Record<string, unknown> => ({
  formatVersion: 2,
  kind: 'question',
  title: `Filed ${order.orderId}: keep or strike`,
  decision: `Filed ${order.orderId} from your message: keep or strike`,
  whyNow: `${order.orderId} is active now in every Claude tab of ${order.workspaceId}; strike it if the curator misread you.`,
  answerType: 'confirm',
  options: [
    { id: KEEP, label: `Keep ${order.orderId}`, consequence: 'It stays active until you strike it.', recommended: false, needsText: false },
    { id: STRIKE, label: `Strike ${order.orderId}`, consequence: 'It stops at once and every live tab is told.', recommended: false, needsText: false },
  ],
  context: [
    `> ${order.text}`,
    '',
    `From your message at ${ownerTime(order.at)} (\`${order.entryId}\`). The curator labelled it a standing order (prompt \`${order.promptVersion}\`) and filed it as **${order.orderId}**.`,
    '',
    '`purplemux so list` shows every order. Keep changes nothing; strike strikes the order. The orchestrator only acknowledges the answer.',
  ].join('\n'),
  storyIds: [],
  blockingScope: 'none',
  canContinue: true,
  class: 'bookkeeping',
  defaultOptionId: KEEP,
});

export interface IFiledOrderDeps {
  now: () => number;
  orchestratorTabId: (workspaceId: string) => Promise<string | null>;
  openRuns: (workspaceId: string) => IMissionOpenRunBinding[];
  apply: (workspaceId: string, events: unknown[], opener: IMissionItemOpener | null, options: { serverPrefix: string }) => Promise<unknown>;
}

export type TFiledItemOutcome = { opened: true; itemId: string } | { opened: false; itemId: string; reason: string };

type TItemReady = { ok: true; orchestratorTabId: string; run: IMissionOpenRunBinding } | { ok: false; reason: string };

/** Whether the keep-or-strike item can open in a workspace: checked before an order is filed (review r1 F4). */
export const filedItemReady = async (deps: Pick<IFiledOrderDeps, 'orchestratorTabId' | 'openRuns'>, workspaceId: string): Promise<TItemReady> => {
  const orchestratorTabId = await deps.orchestratorTabId(workspaceId);
  if (!orchestratorTabId) return { ok: false, reason: 'no orchestrator' };
  const run = deps.openRuns(workspaceId).find((r) => r.binding.tabId === orchestratorTabId);
  if (!run) return { ok: false, reason: `no open run bound to the orchestrator ${orchestratorTabId}` };
  return { ok: true, orchestratorTabId, run };
};

/** Open the keep-or-strike item on the orchestrator's bound run. */
export const openFiledOrderItem = async (deps: IFiledOrderDeps, order: IFiledOrder): Promise<TFiledItemOutcome> => {
  const itemId = filedOrderItemId(order.orderId);
  try {
    const ready = await filedItemReady(deps, order.workspaceId);
    if (!ready.ok) return { opened: false, itemId, reason: ready.reason };
    const { orchestratorTabId, run } = ready;
    const event = {
      eventId: `${CURATOR_ORDER_EVENT_PREFIX}${itemId}`,
      schemaVersion: 1,
      type: 'attention.opened',
      workspaceId: order.workspaceId,
      runId: run.runId,
      expectedRevision: 0,
      producerAt: deps.now(),
      bindingGeneration: run.binding.generation,
      payload: {
        itemId,
        ...buildFiledOrderQuestion(order),
        humanReview: {
          humanNeed: 'decision',
          humanReason: `The curator filed ${order.orderId} from the owner's message; only the owner keeps or strikes it.`,
          handling: 'Opened by the purplemux server (story 23); the server applies the answer.',
          reviewerTabId: orchestratorTabId,
        },
      },
    };
    // No opener: the item is the server's, and an orchestrator that asks in the same turn must still open its own (ADR-0041).
    await deps.apply(order.workspaceId, [event], null, { serverPrefix: CURATOR_ORDER_EVENT_PREFIX });
    return { opened: true, itemId };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
    log.warn({ workspaceId: order.workspaceId, itemId }, `curator: keep-or-strike item not opened (${reason})`);
    return { opened: false, itemId, reason };
  }
};

export const filedOrderDeps = async (): Promise<IFiledOrderDeps> => {
  const [{ getMissionControlStore }, { applyMissionEventBatch }, { getWorkspaceById }] = await Promise.all([
    import('@/lib/mission-control-store'),
    import('@/lib/mission-control-events'),
    import('@/lib/workspace-store'),
  ]);
  return {
    now: () => Date.now(),
    orchestratorTabId: async (workspaceId) => (await getWorkspaceById(workspaceId))?.orchestration?.orchestratorTabId ?? null,
    openRuns: (workspaceId) => getMissionControlStore().listOpenRunBindings(workspaceId),
    apply: (workspaceId, events, opener, options) => applyMissionEventBatch(workspaceId, events, opener, options),
  };
};
