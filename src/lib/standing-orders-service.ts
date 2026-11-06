import type { ICaller } from '@/lib/caller';
import { createLogger } from '@/lib/logger';
import {
  StandingOrderError, orderChangeLine, type IOrderInput, type IStandingOrder, type IStandingOrderFile,
} from '@/lib/standing-orders';
import {
  FLEET, addOrder, addOrderOnce, readAllOrderFiles, readOrderFile, strikeOrder, type IOrderChange,
} from '@/lib/standing-orders-store';
import type { ITabEventRoute, ITabEventRouteResult } from '@/lib/tab-event-router';
import { classifyWake } from '@/lib/wake-class';

// Who may change which file, and what a change does next (ADR-0041): the prompt files of the workspaces
// it reaches are rewritten, and every live agent tab it reaches is sent one urgent line naming the order.

const log = createLogger('standing-orders');

export interface IStandingOrderDeps {
  now: () => number;
  /** The workspaces of the host, for a fleet change. */
  workspaceIds: () => Promise<string[]>;
  refreshPrompt: (workspaceId: string) => Promise<void>;
  /** Live agent tabs, of one workspace or (null) of every workspace. */
  liveAgentTabs: (workspaceId: string | null) => Array<{ workspaceId: string; tabId: string }>;
  route: (event: ITabEventRoute) => Promise<ITabEventRouteResult>;
}

export interface IStandingOrderResult extends IOrderChange {
  promptsWritten: number;
  tabsNotified: number;
}

/** The fleet file is the admin token's; a workspace file is that workspace's tabs' (or admin's). */
export const mayChangeOrders = (caller: ICaller, owner: string): void => {
  if (caller.admin) return;
  if (owner === FLEET) throw new StandingOrderError('forbidden', 'a fleet order is added or struck with the admin token; a tab adds orders for its own workspace (-w)');
  if (caller.workspaceId !== owner) throw new StandingOrderError('forbidden', `orders of ${owner} are changed from a tab of ${owner}`);
};

const fanOut = async (deps: IStandingOrderDeps, change: IOrderChange, kind: 'added' | 'struck'): Promise<IStandingOrderResult> => {
  const reached = change.owner === FLEET ? await deps.workspaceIds() : [change.owner];
  const written = await Promise.all(reached.map((ws) => deps.refreshPrompt(ws).then(() => 1, (err) => {
    log.warn(`prompt file of ${ws} not rewritten after ${change.order.id}: ${err instanceof Error ? err.message : err}`);
    return 0;
  })));
  const text = orderChangeLine(change.order, kind, change.owner);
  const tabs = deps.liveAgentTabs(change.owner === FLEET ? null : change.owner);
  const routed = await Promise.all(tabs.map((tab) => deps.route({
    workspaceId: tab.workspaceId, tabId: tab.tabId, kind: 'standing-order', text, class: classifyWake('standing-order'),
  }).then((r) => (r.delivered ? 1 : 0), (err) => {
    log.warn(`${change.order.id} line not sent to ${tab.tabId}: ${err instanceof Error ? err.message : err}`);
    return 0;
  })));
  log.info({ id: change.order.id, kind, owner: change.owner, prompts: reached.length, tabs: tabs.length }, 'standing order changed');
  return { ...change, promptsWritten: written.reduce((a, b) => a + b, 0), tabsNotified: routed.reduce((a, b) => a + b, 0) };
};

export const addStandingOrder = async (
  deps: IStandingOrderDeps, caller: ICaller, owner: string, input: IOrderInput,
): Promise<IStandingOrderResult> => {
  mayChangeOrders(caller, owner);
  const change = await addOrder(owner, input, owner === FLEET ? await deps.workspaceIds() : [], deps.now());
  return fanOut(deps, change, 'added');
};

/**
 * A fleet add that files at most one order for one cause (ADR-0041 §1 amendment D7): `guard` runs under the same hold
 * of the host lock as the add and names the order that already stands for it. Only an add fans out.
 */
export const addFleetOrderOnce = async (
  deps: IStandingOrderDeps, caller: ICaller, input: IOrderInput, guard: (files: readonly IStandingOrderFile[]) => string | null,
): Promise<{ result: IStandingOrderResult; existing?: undefined } | { result?: undefined; existing: string }> => {
  mayChangeOrders(caller, FLEET);
  const once = await addOrderOnce(FLEET, input, await deps.workspaceIds(), deps.now(), guard);
  if (once.existing !== undefined) return { existing: once.existing };
  return { result: await fanOut(deps, once.change, 'added') };
};

export const strikeStandingOrder = async (
  deps: IStandingOrderDeps, caller: ICaller, id: string, reason: unknown,
): Promise<IStandingOrderResult> => {
  const change = await strikeOrder(id, reason, (owner) => mayChangeOrders(caller, owner), deps.now());
  return fanOut(deps, change, 'struck');
};

export interface IStandingOrderList {
  orders: Array<IStandingOrder & { owner: string }>;
}

/** A tab reads the fleet's orders and its own workspace's; admin reads one workspace (-w) or every file. */
export const listStandingOrders = async (caller: ICaller, workspaceId: string | null, all: boolean): Promise<IStandingOrderList> => {
  const ws = workspaceId ?? caller.workspaceId;
  if (!caller.admin && ws !== caller.workspaceId) throw new StandingOrderError('forbidden', 'a tab reads the fleet orders and its own workspace\'s');
  const files = ws ? await Promise.all([readOrderFile(FLEET), readOrderFile(ws)]) : await readAllOrderFiles();
  const orders = files.flatMap((file) => file.orders.map((order) => ({ ...order, owner: file.owner })));
  return { orders: all ? orders : orders.filter((order) => order.state === 'active') };
};
