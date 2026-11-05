// Browser-safe alert policy: the single predicate every notification channel
// consults, plus the alert builder. No node-only imports — the server dispatches
// from status-manager and the Electron/toast hooks apply the same rule client-side.
import type { IWorkspace } from '@/types/terminal';
import type { IAlert, IAlertFlag, IAlertQuestion, IWorkspaceStandup, TAlertKind, TAlertProviderId } from '@/types/status';

export const ALERTS_ORCHESTRATOR_ONLY_DEFAULT = true;

const MAX_BODY = 100;

export interface IAlertPolicyTab {
  id: string;
}

export interface IAlertPolicyConfig {
  alertsOrchestratorOnly?: boolean;
}

export type TAlertPolicyWorkspace = Pick<IWorkspace, 'orchestration'>;

const orchestratorTabIdOf = (workspace: TAlertPolicyWorkspace | null | undefined): string | null => {
  const orch = workspace?.orchestration;
  if (!orch?.enabled) return null;
  return orch.orchestratorTabId ?? null;
};

export const isOrchestratorTab = (
  tab: IAlertPolicyTab,
  workspace: TAlertPolicyWorkspace | null | undefined,
): boolean => orchestratorTabIdOf(workspace) === tab.id;

/**
 * Whether a tab's transition is worth interrupting the human for.
 *
 * Default (`alertsOrchestratorOnly`): only the orchestrator tab of an
 * orchestrated workspace alerts — everything else is the orchestrator's job.
 * With the flag off, the pre-dispatcher rule applies: every agent tab alerts,
 * and workers are muted only when the workspace has an orchestrator.
 */
export const shouldAlert = (
  tab: IAlertPolicyTab,
  workspace: TAlertPolicyWorkspace | null | undefined,
  config: IAlertPolicyConfig | null | undefined,
): boolean => {
  const orchestratorTabId = orchestratorTabIdOf(workspace);
  const isOrchestrator = orchestratorTabId !== null && orchestratorTabId === tab.id;
  const orchestratorOnly = config?.alertsOrchestratorOnly ?? ALERTS_ORCHESTRATOR_ONLY_DEFAULT;
  if (orchestratorOnly) return isOrchestrator;
  return orchestratorTabId === null || isOrchestrator;
};

const HUMAN_WAITING_STATES = new Set(['blocked', 'awaiting-human']);

/**
 * The tab a `standup-needs-human` alert is addressed to, or null when the tick
 * needs nobody. A standup belongs to the workspace, not to a tab, so the alert
 * is addressed to the orchestrator that posted it — which also means an
 * un-orchestrated workspace has nothing to address and stays silent.
 */
export const standupAlertTabId = (
  standup: Pick<IWorkspaceStandup, 'needsHuman' | 'state'>,
  workspace: TAlertPolicyWorkspace | null | undefined,
  config: IAlertPolicyConfig | null | undefined,
): string | null => {
  if (!standup.needsHuman && !HUMAN_WAITING_STATES.has(standup.state)) return null;
  const tabId = orchestratorTabIdOf(workspace);
  if (!tabId) return null;
  return shouldAlert({ id: tabId }, workspace, config) ? tabId : null;
};

/**
 * Whether this heartbeat is the one that ends the stall episode — the last beat
 * the keeper will send before it gives up on waking the orchestrator itself.
 * `alreadyAlerted` is what keeps it to one alert per episode; the keeper clears
 * it when the orchestrator or a worker becomes active again.
 */
export const isStallEpisodeEnd = (beats: number, maxBeats: number, alreadyAlerted: boolean): boolean =>
  beats >= maxBeats && !alreadyAlerted;

export interface IAlertSource {
  kind: TAlertKind;
  tabId: string;
  workspaceId: string;
  workspaceName: string;
  tabName: string;
  providerId: TAlertProviderId;
  isOrchestrator: boolean;
  at: number;
  lastUserMessage?: string | null;
  headline?: string | null;
  detail?: string | null;
  /** Kind `flag` only: the raised flag, carried on the alert as served (ADR-0032). */
  flag?: IAlertFlag;
  /** Kind `attention-opened` only: the opened Mission Control item, carried on the alert. */
  itemId?: string;
  /** Kind `attention-opened` only: the item's title, the alert body. */
  itemTitle?: string | null;
  /** Kind `attention-opened` only: the question summary a notification answers from (story 33). */
  question?: IAlertQuestion | null;
}

export type TAlertDraft = Omit<IAlert, 'id' | 'seq'>;

/** Cut by code points, so a cut never splits a surrogate pair. */
const cutBody = (text: string): string => {
  const points = Array.from(text);
  return points.length <= MAX_BODY ? text : points.slice(0, MAX_BODY).join('');
};

const STALL_BODY = 'Idle with no worker activity — the orchestrator stopped driving the epic.';

const titleFor = (kind: TAlertKind): string => {
  switch (kind) {
    case 'needs-input': return 'Input Required';
    case 'review': return 'Task Complete';
    case 'standup-needs-human': return 'Standup Needs You';
    case 'orchestrator-stalled': return 'Orchestrator Stalled';
    case 'orchestrator-missing': return 'Orchestrator Missing';
    case 'work-stalled': return 'Work Stalled';
    case 'bg-job-died': return 'Background Job Died';
    case 'bg-job-unknown': return 'Background Job Status Unknown';
    case 'flag': return 'Flag Raised';
    case 'attention-opened': return 'Mission Control: answer needed';
    // A NEEDS-DECISION line no Mission Control item could take, and no orchestrator can act on (ADR-0041 §2).
    case 'needs-decision': return 'Decision needed: no Mission Control item';
  }
};

const bodyFor = (source: IAlertSource): string => {
  switch (source.kind) {
    case 'needs-input':
    case 'review':
      return source.lastUserMessage?.slice(0, MAX_BODY) || source.tabName || source.tabId;
    case 'standup-needs-human':
      return source.headline || source.tabName || source.tabId;
    case 'orchestrator-stalled':
      return source.detail || STALL_BODY;
    case 'orchestrator-missing':
      return source.detail?.slice(0, MAX_BODY) || 'Unfinished work has no usable orchestrator.';
    case 'work-stalled':
    case 'bg-job-died':
    case 'bg-job-unknown':
      return source.detail?.slice(0, MAX_BODY) || source.tabName || source.tabId;
    case 'flag':
      return cutBody(source.detail || source.flag?.text || source.tabName || source.tabId);
    case 'attention-opened':
      return cutBody(source.itemTitle?.trim() || source.workspaceName || source.tabName || source.tabId);
    case 'needs-decision':
      return cutBody(source.detail || source.tabName || source.tabId);
  }
};

export const alertFor = (source: IAlertSource): TAlertDraft => ({
  kind: source.kind,
  tabId: source.tabId,
  workspaceId: source.workspaceId,
  workspaceName: source.workspaceName,
  tabName: source.tabName,
  providerId: source.providerId,
  isOrchestrator: source.isOrchestrator,
  title: titleFor(source.kind),
  body: bodyFor(source),
  at: source.at,
  ...(source.kind === 'flag' && source.flag ? { flag: { ...source.flag } } : {}),
  ...(source.kind === 'attention-opened' && source.itemId ? { itemId: source.itemId } : {}),
  ...(source.kind === 'attention-opened' && source.question ? { question: source.question } : {}),
});
