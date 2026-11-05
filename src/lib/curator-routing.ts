import { looksLikeSecret } from '@/lib/secret-patterns';
import { ORDER_LIMITS } from '@/lib/standing-orders';
import type { ICuratorResult } from '@/types/curator';

// Where an owner message's label routes (ADR-HFL-05 decision 7; story 23 AC 2, AC 5, consult C1). The decision is pure
// over its dependencies: a label routes only when the classifier is `routing` on the version that produced it, and
// (but for a v2 candidate) only in a workspace that opts in. Records name ids and actions, never the message text.

export const ORDER_CANDIDATES_KEY = 'curator.standing-order.candidates';
/**
 * treasury-v2's workspace files no SO-n: its owner rules live in its own decisions record (consult v2 point 6). Its SM
 * receives the label as a candidate for `/v2-scope` until v2 records its own row and the admin removes the entry.
 */
export const DEFAULT_ORDER_CANDIDATES = 'ws-ldhziO=v2-scrum-master';

export type TOwnerMessageAction =
  | 'filed-order'
  | 'filed-no-item'
  | 'order-candidate'
  | 'candidate-undelivered'
  | 'spec-queued'
  | 'already-filed'
  | 'answer-linked'
  | 'answer-unmatched'
  | 'counted'
  | 'not-filed'
  | 'logged'
  | 'failed';

/** One routing decision, as `tab_events` records it (kind `curator-route`, class `log`): ids and actions only. */
export interface ICuratorRouteRecord {
  task: 'classify-owner-message';
  sourceId: string;
  label: string | null;
  promptVersion: string;
  action: TOwnerMessageAction;
  /** What the action reached: `SO-<n>`, an MC item id, a tab name, the spec queue; null when nothing. */
  target: string | null;
  reason?: string;
}

export interface IOwnerMessage {
  workspaceId: string;
  entryId: string;
  text: string;
  at: number;
}

export interface IOwnerRoutingDeps {
  /** The classifier is `routing` on this served version (the gate passed on it). */
  routingOn: (promptVersion: string) => Promise<boolean>;
  optedIn: (workspaceId: string) => Promise<boolean>;
  /** The tab name a workspace's standing-order labels go to as candidates, or null when the workspace files SO-n. */
  candidateTabName: (workspaceId: string) => Promise<string | null>;
  /** One line per message id; a message already sent is not sent again (review r1 F8). */
  sendCandidate: (message: IOwnerMessage, tabName: string, line: string) => Promise<boolean>;
  /** An active order of the workspace or the fleet with the same normalised text, or null (review r1 F3). */
  findActiveOrder: (workspaceId: string, text: string) => Promise<string | null>;
  /**
   * File the order and open its keep-or-strike item, never one without the other (review r1 F4): the item's readiness is
   * checked first, and an order whose item still fails to open is struck again. `orderId` null: nothing is filed.
   * `itemId` null: the order is active with no item (the item did not open and the strike failed); the record names the order.
   */
  fileOrder: (message: IOwnerMessage, text: string, promptVersion: string) => Promise<
    { orderId: string; itemId: string } | { orderId: null; reason: string } | { orderId: string; itemId: null; reason: string }
  >;
  queueProductRule: (message: IOwnerMessage, text: string) => Promise<void>;
  /** The open Mission Control item the message most likely answers: the latest owner-facing item before it. */
  linkAnswer: (message: IOwnerMessage, span: string | null) => Promise<string | null>;
  record: (workspaceId: string, record: ICuratorRouteRecord, at: number) => void;
}

/** The text an order or a queue entry carries: the message, whitespace collapsed to one line. */
export const oneLineText = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Two orders say the same when their one-line texts match ignoring case and trailing punctuation (review r1 F3). */
export const normalisedOrderText = (text: string): string => oneLineText(text).toLowerCase().replace(/[\s.!;,]+$/, '');

/** The candidate line the v2 SM receives: the message id and the curator's span, never the whole message. */
export const candidateLine = (message: IOwnerMessage, span: string | null, withheld: boolean): string => {
  const quote = withheld ? 'withheld (credential-shaped)' : span ? `"${span}"` : 'no span';
  return `[purplemux curator] standing-order candidate for /v2-scope: the owner's message ${message.workspaceId}/${message.entryId} `
    + `at ${new Date(message.at).toISOString()} reads as a standing order (${quote}). Not filed as SO-n (consult v2 point 6). `
    + `Read it: purplemux curator message -w ${message.workspaceId} ${message.entryId}`;
};

/** `ws-a=tab-name,ws-b=other`: the workspaces whose standing-order labels go to a named tab as candidates. */
export const parseCandidateMap = (value: string | null): Map<string, string> => {
  const raw = value === null ? DEFAULT_ORDER_CANDIDATES : value.trim() === 'none' ? '' : value;
  const map = new Map<string, string>();
  for (const pair of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(at + 1).trim()) map.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  return map;
};

/**
 * Route one classified owner message (AC 2, AC 5). A label from the rules (the curator down) never routes: the rules
 * passed no gate. Shadow, or a workspace that has not opted in, logs only; a v2 standing-order label is a candidate
 * whenever the classifier routes, and never an SO-n.
 */
export const routeOwnerMessage = async (deps: IOwnerRoutingDeps, message: IOwnerMessage, result: ICuratorResult): Promise<ICuratorRouteRecord> => {
  const { record: call } = result;
  const base = { task: 'classify-owner-message' as const, sourceId: `${message.workspaceId}/${message.entryId}`, label: call.label, promptVersion: call.promptVersion };
  const done = (action: TOwnerMessageAction, target: string | null = null, reason?: string, recorded = true): ICuratorRouteRecord => {
    const out: ICuratorRouteRecord = { ...base, action, target, ...(reason ? { reason } : {}) };
    if (recorded) deps.record(message.workspaceId, out, message.at);
    return out;
  };
  // In shadow the call record is the whole log (ADR-0038 §2): a routing row is written only once the task routes.
  if (call.source !== 'curator' || call.label === null) return done('logged', null, 'rules label: the rules route nothing here', false);
  if (!(await deps.routingOn(call.promptVersion))) return done('logged', null, 'shadow', false);
  const label = call.label;
  try {
    const candidateTab = label === 'standing-order' ? await deps.candidateTabName(message.workspaceId) : null;
    if (candidateTab) {
      const sent = await deps.sendCandidate(message, candidateTab, candidateLine(message, call.span, call.withheld === true));
      return done(sent ? 'order-candidate' : 'candidate-undelivered', candidateTab, sent ? undefined : `no live tab named ${candidateTab}`);
    }
    if (!(await deps.optedIn(message.workspaceId))) return done('logged', null, 'workspace not in curator.routing.workspaces');
    if (label === 'status-ping' || label === 'one-off') return done('counted');
    if (label === 'answer') {
      const itemId = await deps.linkAnswer(message, call.withheld ? null : call.span);
      return itemId ? done('answer-linked', itemId) : done('answer-unmatched', null, 'no open item awaits the owner');
    }
    const text = oneLineText(message.text);
    if (looksLikeSecret(message.text)) return done('not-filed', null, 'credential-shaped text is never filed');
    if (label === 'product-rule') {
      await deps.queueProductRule(message, message.text.trim());
      return done('spec-queued', 'spec-queue.md');
    }
    if (label === 'standing-order') {
      if ([...text].length > ORDER_LIMITS.text) return done('not-filed', null, `${[...text].length} chars, an order holds at most ${ORDER_LIMITS.text}`);
      const existing = await deps.findActiveOrder(message.workspaceId, text);
      if (existing) return done('already-filed', existing, `already filed ${existing}`);
      const filed = await deps.fileOrder(message, text, call.promptVersion);
      if (filed.orderId === null) return done('not-filed', null, filed.reason);
      if (filed.itemId === null) return done('filed-no-item', filed.orderId, filed.reason);
      return done('filed-order', filed.orderId, `item ${filed.itemId}`);
    }
    return done('logged', null, 'label not in the routing table');
  } catch (err) {
    return done('failed', null, err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200));
  }
};
