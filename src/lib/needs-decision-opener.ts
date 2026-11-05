import { createHash } from 'crypto';
import { createLogger } from '@/lib/logger';
import type { IMissionItemOpener, IMissionOpenRunBinding } from '@/lib/mission-control-store';
import { NEEDS_DECISION_EVENT_PREFIX } from '@/lib/mission-control-validation';
import { buildNeedsDecisionQuestion, isNeedsDecisionLine } from '@/lib/needs-decision';

// The server's NEEDS-DECISION producer (ADR-0041; story 14 AC 4). The item opens human-visible in one
// event: `attention.opened` carrying the workspace orchestrator's human review, on the orchestrator's
// run, through the same validator and authority checks an agent's event meets. Its opener is the tab.

const log = createLogger('needs-decision');

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
  apply: (workspaceId: string, events: unknown[], opener: IMissionItemOpener, options: { serverPrefix: string }) => Promise<unknown>;
}

const digest = (...parts: Array<string | number>): string =>
  createHash('sha256').update(parts.join('\0')).digest('hex');

const normalized = (line: string): string => line.trim().replace(/\s+/g, ' ');

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

/** Never throws: a failing dependency is the `error` outcome, so the stop always takes a path (confirm D2, C4). */
export const openNeedsDecisionItem = async (deps: INeedsDecisionDeps, stop: INeedsDecisionStop): Promise<TNeedsDecisionOutcome> => {
  if (!isNeedsDecisionLine(stop.line)) return { opened: false, reason: 'not-needs-decision' };
  const { itemId, lineKey } = needsDecisionItemId(stop);
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
    apply: (workspaceId, events, opener, options) => applyMissionEventBatch(workspaceId, events, opener, options),
  };
};
