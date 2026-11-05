import { alertFor, isOrchestratorTab } from '@/lib/alert-policy';
import type { TAlertDraft } from '@/lib/alert-policy';
import { createLogger } from '@/lib/logger';
import { ANSWER_TYPES, effectiveAnswerType } from '@/lib/mission-question-format';
import type { IAlertContext } from '@/lib/notification-dispatcher';
import type { IMissionEvent, TMissionAnswerType, TMissionItemState } from '@/types/mission-control';
import type { IAlertQuestion, IAlertQuestionOption, TAlertProviderId } from '@/types/status';
import type { ITab, IWorkspace } from '@/types/terminal';

// `attention-opened` alerts: when a Mission Control item first becomes owner-visible (state `open`,
// humanReview.humanNeed not `none`), the server sends one alert that names the item. That is an
// `attention.opened` committed open at once, or an `attention.updated` that moves a candidate to
// open (story 33 round 2). A replayed event, a candidate item, an update of an item already open,
// an answer, a resolve or a cancel sends nothing, and one item alerts at most once per process.

const log = createLogger('attention-alerts');

/** How many alerted item keys the process remembers against a concurrent duplicate request. */
export const ATTENTION_ALERT_MEMORY = 2_000;

export interface IOpenedAttention {
  workspaceId: string;
  itemId: string;
  title: string | null;
  at: number;
  /** What a notification needs to answer the item in place (story 33 AC 3); null when unreadable. */
  question: IAlertQuestion | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const optionOf = (value: unknown): IAlertQuestionOption | null => {
  const option = asRecord(value);
  if (!option || typeof option.id !== 'string' || typeof option.label !== 'string') return null;
  return { id: option.id, label: option.label, needsText: option.needsText === true };
};

/**
 * The committed question as the alert carries it (story 33 AC 3, ADR-HFL-11 decision 6). The payload
 * is the validator's normalized question, so a confirm without options already holds Yes / No. Null
 * when it has no option list or names an answer type the server does not know.
 */
export const questionSummary = (payload: Record<string, unknown>, revision: number): IAlertQuestion | null => {
  if (!Array.isArray(payload.options)) return null;
  const options = payload.options.flatMap((entry) => optionOf(entry) ?? []);
  const declared = payload.answerType;
  if (declared !== undefined && !(ANSWER_TYPES as readonly unknown[]).includes(declared)) return null;
  const formatVersion = payload.formatVersion === 2 ? 2 : 1;
  const decision = formatVersion === 2 && typeof payload.decision === 'string' ? payload.decision : payload.title;
  return {
    formatVersion,
    decision: typeof decision === 'string' ? decision.trim() : '',
    answerType: effectiveAnswerType({
      kind: payload.kind === 'action' ? 'action' : 'question', options, answerType: declared as TMissionAnswerType | undefined,
    }),
    options,
    revision,
  };
};

const openedFrom = (event: IMissionEvent, payload: Record<string, unknown>): IOpenedAttention | null => {
  if (asRecord(payload.routing)?.state !== 'open') return null;
  const review = asRecord(payload.humanReview);
  if (!review || typeof review.humanNeed !== 'string' || review.humanNeed === 'none') return null;
  const itemId = typeof payload.itemId === 'string' && payload.itemId ? payload.itemId : event.entityId;
  if (!itemId) return null;
  return {
    workspaceId: event.workspaceId,
    itemId,
    title: typeof payload.title === 'string' ? payload.title : null,
    at: event.committedAt,
    question: questionSummary(payload, event.revision),
  };
};

/**
 * The transition rule (story 33 round 2), pure so its call site can move: the item an event made
 * owner-visible for the first time, or null. `previous` is the item's state before this event (null:
 * the item did not exist). An `attention.opened` of a new item committed `open`, or an
 * `attention.updated` from `candidate` to `open`, each with a humanReview whose humanNeed is not
 * `none`. Anything else (an update of an item already open, an answer, a resolve, a cancel) is null.
 */
export const attentionTransition = (previous: TMissionItemState | null, event: IMissionEvent): IOpenedAttention | null => {
  const payload = asRecord(event.payload);
  if (!payload) return null;
  if (event.type === 'attention.opened') return previous === null && event.revision === 1 ? openedFrom(event, payload) : null;
  if (event.type === 'attention.updated') return previous === 'candidate' ? openedFrom(event, payload) : null;
  return null;
};

/** An `attention.opened` that opened a new item for the human at once (revision 1, committed open). */
export const openedForHuman = (event: IMissionEvent): IOpenedAttention | null => attentionTransition(null, event);

/** The committed state an event left its item in, from its routing record; null when it carries none. */
const committedState = (event: IMissionEvent): TMissionItemState | null => {
  const state = asRecord(asRecord(event.payload)?.routing)?.state;
  return state === 'candidate' || state === 'open' || state === 'answered' || state === 'resolved' || state === 'cancelled' ? state : null;
};

export interface IAttentionAlertState {
  /** `<workspaceId>/<itemId>` of each item alerted, oldest first. */
  alerted: Set<string>;
}

export const createAttentionAlertState = (): IAttentionAlertState => ({ alerted: new Set() });

const keyOf = (opened: Pick<IOpenedAttention, 'workspaceId' | 'itemId'>): string => `${opened.workspaceId}/${opened.itemId}`;

const remember = (state: IAttentionAlertState, key: string): void => {
  state.alerted.add(key);
  while (state.alerted.size > ATTENTION_ALERT_MEMORY) {
    const oldest = state.alerted.values().next().value;
    if (oldest === undefined) break;
    state.alerted.delete(oldest);
  }
};

export interface IAttentionAlertDeps {
  workspace: (workspaceId: string) => Promise<IWorkspace | null>;
  findTab: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  providerOf: (tab: ITab) => Promise<TAlertProviderId>;
  dispatch: (draft: TAlertDraft, ctx: IAlertContext) => Promise<unknown>;
}

export const attentionAlertDraft = (
  opened: IOpenedAttention,
  workspace: IWorkspace | null,
  tabId: string,
  tab: ITab | null,
  providerId: TAlertProviderId,
): TAlertDraft => alertFor({
  kind: 'attention-opened',
  tabId,
  workspaceId: opened.workspaceId,
  workspaceName: workspace?.name ?? '',
  tabName: tab?.name ?? '',
  providerId,
  isOrchestrator: tabId ? isOrchestratorTab({ id: tabId }, workspace) : false,
  at: opened.at,
  itemId: opened.itemId,
  itemTitle: opened.title,
  question: opened.question,
});

export interface IAttentionAlertInput {
  /** The events `applyEvents` committed or replayed for one request. */
  events: IMissionEvent[];
  /** The event ids that were not in the store before this request: only these can alert. */
  fresh: ReadonlySet<string>;
  /** The server-resolved tab that sent the request, when there is one (ADR-0023). */
  openerTabId: string | null;
  /** The touched items' states before the batch applied (`store.itemStates`); absent: the item was new. */
  previousStates?: ReadonlyMap<string, TMissionItemState>;
}

/**
 * The tab the alert names: the tab that opened the item when the server resolved one, else the
 * workspace's orchestrator. A tab the layout does not show keeps its id with an empty name.
 */
const alertTab = async (
  deps: IAttentionAlertDeps,
  workspace: IWorkspace | null,
  workspaceId: string,
  openerTabId: string | null,
): Promise<{ tabId: string; tab: ITab | null }> => {
  const tabId = openerTabId ?? workspace?.orchestration?.orchestratorTabId ?? '';
  if (!tabId) return { tabId, tab: null };
  return { tabId, tab: await deps.findTab(workspaceId, tabId).catch(() => null) };
};

/** Send one `attention-opened` alert per item this request opened for the human. Answers the drafts sent. */
export const dispatchAttentionOpenedAlerts = async (
  input: IAttentionAlertInput,
  deps: IAttentionAlertDeps,
  state: IAttentionAlertState,
): Promise<TAlertDraft[]> => {
  const sent: TAlertDraft[] = [];
  // Each item's state as the batch moves it: an open-as-candidate then a promotion in one batch alerts once.
  const states = new Map<string, TMissionItemState>(input.previousStates ?? []);
  for (const event of input.events) {
    // A replayed event changes no tracked state: its old state would mask the item's real one (confirm C1).
    if (!input.fresh.has(event.id)) continue;
    const previous = states.get(event.entityId) ?? null;
    const after = committedState(event);
    if (after) states.set(event.entityId, after);
    const opened = attentionTransition(previous, event);
    if (!opened) continue;
    const key = keyOf(opened);
    if (state.alerted.has(key)) continue;
    remember(state, key);
    try {
      const workspace = await deps.workspace(opened.workspaceId).catch(() => null);
      const { tabId, tab } = await alertTab(deps, workspace, opened.workspaceId, input.openerTabId);
      const providerId = tab ? await deps.providerOf(tab).catch((): TAlertProviderId => 'claude') : 'claude';
      const draft = attentionAlertDraft(opened, workspace, tabId, tab, providerId);
      await deps.dispatch(draft, { workspaceDir: workspace?.directories[0] ?? null });
      sent.push(draft);
    } catch (err) {
      log.warn(`attention-opened alert failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sent;
};

const toAlertProvider = (id: string | undefined): TAlertProviderId =>
  id === 'codex' || id === 'grok' ? id : 'claude';

const realDeps = (): IAttentionAlertDeps => ({
  workspace: async (workspaceId) => (await (await import('@/lib/workspace-store')).getWorkspaceById(workspaceId)) ?? null,
  findTab: async (workspaceId, tabId) => (await (await import('@/lib/cli-utils')).findTab(workspaceId, tabId))?.tab ?? null,
  providerOf: async (tab) => toAlertProvider((await import('@/lib/providers/registry')).getProviderByPanelType(tab.panelType)?.id),
  dispatch: async (draft, ctx) => (await import('@/lib/notification-dispatcher')).getNotificationDispatcher().dispatch(draft, ctx),
});

const g = globalThis as unknown as { __ptAttentionAlertState?: IAttentionAlertState };

export const attentionAlertState = (): IAttentionAlertState => {
  if (!g.__ptAttentionAlertState) g.__ptAttentionAlertState = createAttentionAlertState();
  return g.__ptAttentionAlertState;
};

/** Called without await from the events route: the response never waits on a notification channel. */
export const alertOpenedAttention = (input: IAttentionAlertInput, deps: IAttentionAlertDeps = realDeps()): Promise<TAlertDraft[]> =>
  dispatchAttentionOpenedAlerts(input, deps, attentionAlertState()).catch((err) => {
    log.warn(`attention-opened alerts failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  });
