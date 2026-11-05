import { createHash } from 'crypto';
import { createLogger } from '@/lib/logger';
import type { IMissionItemOpener, IMissionOpenRunBinding } from '@/lib/mission-control-store';
import { NEEDS_DECISION_EVENT_PREFIX } from '@/lib/mission-control-validation';
import { buildNeedsDecisionQuestion, isNeedsDecisionLine } from '@/lib/needs-decision';

// The server's NEEDS-DECISION producer (ADR-0041; story 14 AC 4). The item opens human-visible in one
// event: `attention.opened` carrying the workspace orchestrator's human review, on the orchestrator's
// run, through the same validator and authority checks an agent's event meets. Its opener is the tab.

const log = createLogger('needs-decision');

/** One item id per line key for 24 h (story 36 review r1, finding 1); in memory, so a restart may mint one more. */
export const NEEDS_DECISION_ID_WINDOW_MS = 24 * 60 * 60_000;
const NEEDS_DECISION_ID_MEMORY = 2_000;
const g = globalThis as unknown as { __ptNeedsDecisionItemIds?: Map<string, { itemId: string; at: number }> };
const rememberedIds = (): Map<string, { itemId: string; at: number }> => {
  if (!g.__ptNeedsDecisionItemIds) g.__ptNeedsDecisionItemIds = new Map();
  return g.__ptNeedsDecisionItemIds;
};

export interface INeedsDecisionStop {
  workspaceId: string;
  tabId: string;
  tabName: string;
  /** The turn's last line, unclipped where the tail holds all of it. */
  line: string;
  /** False when the line's start may be missing: the question is then a text question (review r1, R2). */
  lineComplete?: boolean;
  /** The stop's sequence number on the tab: one stop opens at most one item. */
  stopSeq: number;
  /** When the stop happened: the seq restarts at 0 with the server, the time does not (confirm D1). */
  stopAt: number;
  /** When the turn began: an item the tab opened since then means it already asked. */
  turnStartedAt: number;
}

/** A NEEDS-DECISION stop that opened no item: the fallback of ADR-0041 §2 takes over. */
export type TNeedsDecisionNoItemReason = 'no-orchestrator' | 'no-orchestrator-run' | 'refused' | 'error';

export type TNeedsDecisionOutcome =
  | { opened: true; itemId: string; runId: string }
  | { opened: false; reason: 'already-open' | 'asked-this-turn'; itemId: string }
  | { opened: false; reason: 'not-needs-decision' }
  /** `itemId` is the id the server would have used: the orchestrator is told to open that one (confirm C4, F1 (i)). */
  | { opened: false; reason: TNeedsDecisionNoItemReason; itemId: string; detail?: string };

export interface INeedsDecisionDeps {
  now: () => number;
  orchestratorTabId: (workspaceId: string) => Promise<string | null>;
  openRuns: (workspaceId: string) => IMissionOpenRunBinding[];
  itemsOpenedByTab: (workspaceId: string, tabId: string, since: number) => string[];
  /** Still-open items (candidate or open) whose id starts with the prefix, whoever opened them (confirm C3). */
  openItemsWithIdPrefix: (workspaceId: string, prefix: string) => string[];
  /** The item's state, or null when no item has that id. */
  itemState: (itemId: string) => string | null;
  apply: (workspaceId: string, events: unknown[], opener: IMissionItemOpener, options: { serverPrefix: string }) => Promise<unknown>;
}

const digest = (...parts: Array<string | number>): string =>
  createHash('sha256').update(parts.join('\0')).digest('hex');

// An item id the asker quotes in its repeat, bare or in brackets, is not part of the question (review r1, finding 3).
const QUOTED_ITEM_ID = /[([]?\bnd-[0-9a-f]{32}\b[)\]]?/g;

const normalized = (line: string): string => line.replace(QUOTED_ITEM_ID, ' ').trim().replace(/\s+/g, ' ');

export const needsDecisionLineKey = (workspaceId: string, tabId: string, line: string): string =>
  digest(workspaceId, tabId, normalized(line)).slice(0, 16);

/**
 * `nd-<16 hex of the tab and its normalized line><16 hex of this stop>`: the first half names the question, so a
 * repeat of the line finds the open item of the same question (review r1, R1); the second half takes the stop's
 * time as well as its seq, which restarts with the server (confirm D1).
 */
export const needsDecisionItemId = (
  stop: Pick<INeedsDecisionStop, 'workspaceId' | 'tabId' | 'line' | 'stopSeq' | 'stopAt'>,
): { itemId: string; lineKey: string } => {
  const lineKey = needsDecisionLineKey(stop.workspaceId, stop.tabId, stop.line);
  return { lineKey, itemId: `nd-${lineKey}${digest(lineKey, stop.stopAt, stop.stopSeq).slice(0, 16)}` };
};

/**
 * The line's id for this stop (review r1, finding 1): the id first minted for the line key within 24 h, unless an item
 * of that id has closed (answered, resolved, cancelled: the same line then asks anew); otherwise this stop's own id,
 * remembered. So every not-opened outcome names the id a later open takes, and a second open meets the same id.
 * `closed` reports an item of that id that exists and is no longer open; a failing read counts as not closed.
 */
export const stableNeedsDecisionItemId = (
  stop: Pick<INeedsDecisionStop, 'workspaceId' | 'tabId' | 'line' | 'stopSeq' | 'stopAt'>,
  now: number,
  closed: (itemId: string) => boolean,
): { itemId: string; lineKey: string } => {
  const fresh = needsDecisionItemId(stop);
  const ids = rememberedIds();
  const held = ids.get(fresh.lineKey);
  if (held && now - held.at < NEEDS_DECISION_ID_WINDOW_MS) {
    let isClosed = false;
    try {
      isClosed = closed(held.itemId);
    } catch {
      isClosed = false;
    }
    if (!isClosed) return { itemId: held.itemId, lineKey: fresh.lineKey };
  }
  ids.delete(fresh.lineKey);
  ids.set(fresh.lineKey, { itemId: fresh.itemId, at: now });
  while (ids.size > NEEDS_DECISION_ID_MEMORY) ids.delete(ids.keys().next().value!);
  return fresh;
};

const OPEN_STATES = new Set(['candidate', 'open']);

/** Never throws: a failing dependency is the `error` outcome, so the stop always takes a path (confirm D2, C4). */
export const openNeedsDecisionItem = async (deps: INeedsDecisionDeps, stop: INeedsDecisionStop): Promise<TNeedsDecisionOutcome> => {
  if (!isNeedsDecisionLine(stop.line)) return { opened: false, reason: 'not-needs-decision' };
  const { itemId, lineKey } = stableNeedsDecisionItemId(stop, deps.now(), (id) => {
    const state = deps.itemState(id);
    return state !== null && !OPEN_STATES.has(state);
  });
  try {
    return await openItem(deps, stop, itemId, lineKey);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId }, `NEEDS-DECISION opener failed: ${detail}`);
    return { opened: false, reason: 'error', itemId, detail };
  }
};

const openItem = async (deps: INeedsDecisionDeps, stop: INeedsDecisionStop, itemId: string, lineKey: string): Promise<TNeedsDecisionOutcome> => {
  // The same question, still open from any opener: the worker's repeat, or the orchestrator's item from the note.
  const [same] = deps.openItemsWithIdPrefix(stop.workspaceId, `nd-${lineKey}`);
  if (same) return { opened: false, reason: 'already-open', itemId: same };
  const asked = deps.itemsOpenedByTab(stop.workspaceId, stop.tabId, stop.turnStartedAt);
  if (asked.length) return { opened: false, reason: 'asked-this-turn', itemId: asked[0] };
  const orchestratorTabId = await deps.orchestratorTabId(stop.workspaceId);
  if (!orchestratorTabId) return { opened: false, reason: 'no-orchestrator', itemId };
  const run = deps.openRuns(stop.workspaceId).find((r) => r.binding.tabId === orchestratorTabId);
  if (!run) return { opened: false, reason: 'no-orchestrator-run', itemId, detail: orchestratorTabId };
  const name = stop.tabName || stop.tabId;
  const event = {
    eventId: `${NEEDS_DECISION_EVENT_PREFIX}${itemId.slice(3)}`,
    schemaVersion: 1,
    type: 'attention.opened',
    workspaceId: stop.workspaceId,
    runId: run.runId,
    expectedRevision: 0,
    producerAt: deps.now(),
    bindingGeneration: run.binding.generation,
    payload: {
      itemId,
      ...buildNeedsDecisionQuestion({ line: stop.line, complete: stop.lineComplete, workspaceId: stop.workspaceId, tabId: stop.tabId, tabName: stop.tabName }),
      humanReview: {
        humanNeed: 'decision',
        humanReason: `${name} ended its turn with NEEDS-DECISION: only the owner decides it.`,
        handling: 'Opened by the purplemux server from the end line (ADR-0041); the orchestrator relays the answer.',
        reviewerTabId: orchestratorTabId,
      },
    },
  };
  try {
    await deps.apply(stop.workspaceId, [event], { tabId: stop.tabId, identity: 'hook' }, { serverPrefix: NEEDS_DECISION_EVENT_PREFIX });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId }, `NEEDS-DECISION item not opened: ${detail}`);
    return { opened: false, reason: 'refused', itemId, detail };
  }
  log.info({ workspaceId: stop.workspaceId, tabId: stop.tabId, itemId, runId: run.runId }, 'NEEDS-DECISION opened a Mission Control item');
  return { opened: true, itemId, runId: run.runId };
};

/** What the asking tab itself is told of its line (story 36, D1); `fate` says what the server did instead. */
export type TNeedsDecisionAskerNotice =
  | { kind: 'item'; state: 'opened' | 'already-open'; itemId: string }
  | { kind: 'not-opened'; reason: TNeedsDecisionNoItemReason; itemId: string; detail?: string; fate: string; askerIsOrchestrator: boolean };

const NOTICE_DETAIL_MAX = 200;

export const needsDecisionAskerNotice = (notice: TNeedsDecisionAskerNotice): string => {
  if (notice.kind === 'item') {
    const state = notice.state === 'opened' ? 'opened for the owner by the server' : 'already open for the owner';
    return `[needs-decision] [MC item ${notice.itemId} ${state}: do not open another] Name this id while you wait; the owner's answer arrives through Mission Control.`;
  }
  const detail = notice.detail ? ` (${notice.detail.replace(/\s+/g, ' ').trim().slice(0, NOTICE_DETAIL_MAX)})` : '';
  const own = notice.askerIsOrchestrator
    ? ` You are the orchestrator: resume or start your Mission Control run, then open item ${notice.itemId} from your line with your human review.`
    : '';
  return `[needs-decision] item-not-opened: ${notice.reason}${detail}. Your NEEDS-DECISION line opened no Mission Control item; ${notice.fate}. Its id would be ${notice.itemId}.${own}`;
};

/** The runtime wiring: the Mission Control store and the events route's own batch function. */
export const needsDecisionDeps = async (): Promise<INeedsDecisionDeps> => {
  const [{ getMissionControlStore }, { applyMissionEventBatch }, { getWorkspaceById }] = await Promise.all([
    import('@/lib/mission-control-store'),
    import('@/lib/mission-control-events'),
    import('@/lib/workspace-store'),
  ]);
  return {
    now: () => Date.now(),
    orchestratorTabId: async (workspaceId) => (await getWorkspaceById(workspaceId))?.orchestration?.orchestratorTabId ?? null,
    openRuns: (workspaceId) => getMissionControlStore().listOpenRunBindings(workspaceId),
    itemsOpenedByTab: (workspaceId, tabId, since) => getMissionControlStore().itemsOpenedByTab(workspaceId, tabId, since),
    openItemsWithIdPrefix: (workspaceId, prefix) => getMissionControlStore().openItemsWithIdPrefix(workspaceId, prefix),
    itemState: (itemId) => getMissionControlStore().itemStates([itemId]).get(itemId) ?? null,
    apply: (workspaceId, events, opener, options) => applyMissionEventBatch(workspaceId, events, opener, options),
  };
};
