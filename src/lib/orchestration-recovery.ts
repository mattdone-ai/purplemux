import { withOrchestrationMappingWrite } from '@/lib/orchestration-mapping-lock';
import { withCodexTargetLock } from '@/lib/providers/codex/launch-lifecycle';
import { collectAllTabs, isAgentPanelType } from '@/lib/layout-store';
import { readWorkspaceLayout } from '@/lib/workspace-layout-read';
import { getWorkspaceStrict, commitWorkspaceOrchestrationLocked } from '@/lib/workspace-store';
import { normalizeOrchestration, OrchestrationError, requireOrchestrationRevision, parseOrchestrationPrecondition,
  type TOrchestrationActor, type TOrchestrationMode, type IOrchestrationPrecondition, type TOrchestrationPatch } from '@/lib/orchestration-contract';
import { observeOrchestrationRuntime, candidateModelUsable } from '@/lib/orchestration-runtime';
import { readOrchestrationWorkState } from '@/lib/orchestration-work-state';
import { createLogger } from '@/lib/logger';
import type { ITab, IWorkspace } from '@/types/terminal';

const log = createLogger('orchestration');
export interface IOrchestrationChange extends IOrchestrationPrecondition { actor: TOrchestrationActor }

const underTargets = <T>(workspaceId: string, ids: string[], work: () => Promise<T>): Promise<T> => {
  const sorted = [...new Set(ids)].sort();
  const take = (index: number): Promise<T> => index === sorted.length ? work() : withCodexTargetLock(workspaceId, sorted[index], () => take(index + 1));
  return take(0);
};
const strictTabs = async (workspaceId: string): Promise<ITab[]> => {
  try {
    const layout = await readWorkspaceLayout(workspaceId);
    if (!layout) throw new Error('layout missing');
    return collectAllTabs(layout.root);
  } catch {
    throw new OrchestrationError(409, 'orchestrator-state-unknown', 'Authoritative workspace layout is unavailable');
  }
};
const authorize = (workspaceId: string, options: IOrchestrationChange): void => {
  if (!options?.actor || options.actor.kind !== 'human' && (options.actor.kind !== 'workspace' || options.actor.workspaceId !== workspaceId)) {
    throw new OrchestrationError(403, 'forbidden', 'Only an own-workspace caller or authenticated human may change this mapping');
  }
  parseOrchestrationPrecondition(options);
  if (options.mode === 'replace' && options.actor.kind !== 'human') throw new OrchestrationError(403, 'forbidden', 'Explicit replacement requires authenticated human control');
};
const checkIncumbent = async (workspace: IWorkspace, tabs: ITab[], options: IOrchestrationChange): Promise<void> => {
  const current = normalizeOrchestration(workspace.orchestration);
  if (!current.orchestratorTabId) return;
  if (options.actor.kind === 'human' && options.mode === 'replace') return;
  if (options.mode === 'handoff' && options.actor.kind === 'workspace' && options.actor.verified && options.actor.tabId === current.orchestratorTabId) return;
  const incumbent = tabs.find((tab) => tab.id === current.orchestratorTabId);
  if (!incumbent) {
    const { observeTabSessionsStrict } = await import('@/lib/tmux');
    const sessions = await observeTabSessionsStrict(workspace.id, current.orchestratorTabId);
    if (sessions.state !== 'absent') throw new OrchestrationError(409, 'orchestrator-state-unknown', 'Incumbent has no authoritative session binding; use explicit human replacement', current);
    if (options.mode !== 'recover' && options.actor.kind !== 'human') throw new OrchestrationError(409, 'orchestration-recovery-required', 'Use explicit local recovery for the closed incumbent', current);
    return;
  }
  const observed = await observeOrchestrationRuntime(incumbent);
  if (observed.state === 'unknown') throw new OrchestrationError(409, 'orchestrator-state-unknown', observed.reason, current);
  if (observed.state === 'present') throw new OrchestrationError(409, 'orchestrator-live', 'The incumbent is live; only its verified handoff or explicit human replacement may change ownership', current);
  if (options.mode !== 'recover' && options.actor.kind !== 'human') throw new OrchestrationError(409, 'orchestration-recovery-required', 'Use explicit local recovery for the positively absent incumbent', current);
};
/**
 * The Mission Control runs of the workspace follow the committed coordinator. The mapping is already
 * durable, so a failure here is logged and never thrown.
 */
const rebindMissionRuns = async (workspaceId: string, tabId: string, mode: TOrchestrationMode): Promise<void> => {
  const cause = mode === 'handoff' ? 'handoff' : mode === 'replace' ? 'replace' : 'recover';
  try {
    const { rebindMissionRunsToOrchestrator } = await import('@/lib/mission-control-runtime');
    await rebindMissionRunsToOrchestrator(workspaceId, tabId, cause);
  } catch (error) {
    log.error({ err: error, workspaceId, tabId, cause }, 'Mission Control rebind failed after the coordinator commit');
  }
};

/** One public transaction boundary for CLI, UI and controlled human start. */
export const changeOrchestration = async (
  workspaceId: string, patch: TOrchestrationPatch, options: IOrchestrationChange,
): Promise<IWorkspace> => {
  authorize(workspaceId, options);
  return withOrchestrationMappingWrite(workspaceId, async () => {
    const workspace = await getWorkspaceStrict(workspaceId);
    const current = normalizeOrchestration(workspace.orchestration);
    requireOrchestrationRevision(current, options.expectedRevision);
    const next = { ...current, ...patch };
    if (!next.enabled && next.orchestratorTabId && next.orchestratorTabId !== current.orchestratorTabId) throw new OrchestrationError(400, 'orchestration-invalid', 'A replacement coordinator must be enabled');
    const mappingChanged = current.enabled !== next.enabled || current.orchestratorTabId !== next.orchestratorTabId;
    if (!mappingChanged) {
      const unchanged = await commitWorkspaceOrchestrationLocked(workspaceId, patch, options.expectedRevision);
      // A handoff or recovery that names the coordinator already in place re-asserts it: a run left on another tab follows.
      if (next.enabled && next.orchestratorTabId && patch.orchestratorTabId && (options.mode === 'handoff' || options.mode === 'recover')) await rebindMissionRuns(workspaceId, next.orchestratorTabId, options.mode);
      return unchanged;
    }
    return underTargets(workspaceId, [current.orchestratorTabId, next.orchestratorTabId].filter((id): id is string => !!id), async () => {
      if (!next.enabled || !next.orchestratorTabId) {
        const work = await readOrchestrationWorkState(workspace);
        if (work.state !== 'complete' || work.incomplete) throw new OrchestrationError(409, 'orchestration-work-remains', `Keep a coordinator while work is ${work.state}: ${work.evidence.join('; ')}`, current);
      } else {
        const tabs = await strictTabs(workspaceId);
        if (next.orchestratorTabId !== current.orchestratorTabId) {
          if (!current.orchestratorTabId && options.actor.kind !== 'human' && options.mode !== 'recover') throw new OrchestrationError(409, 'orchestration-recovery-required', 'Use explicit local recovery to designate a coordinator');
          await checkIncumbent(workspace, tabs, options);
        }
        const candidate = tabs.find((tab) => tab.id === next.orchestratorTabId);
        if (!candidate || !isAgentPanelType(candidate.panelType)) throw new OrchestrationError(409, 'orchestrator-candidate-invalid', 'Recovery requires an agent tab in this workspace');
        // A coordinator runs on this server's host: its process proof, nudges and recovery are local (ADR-0022).
        if (candidate.host) throw new OrchestrationError(409, 'orchestrator-candidate-invalid', `A tab on remote host ${candidate.host} cannot coordinate a workspace (ADR-0022); designate a local agent tab`);
        const observation = await observeOrchestrationRuntime(candidate);
        if (observation.state !== 'present') throw new OrchestrationError(409, observation.state === 'unknown' ? 'orchestrator-state-unknown' : 'orchestrator-candidate-invalid', observation.reason);
        if (!(await candidateModelUsable(candidate))) throw new OrchestrationError(409, 'orchestrator-candidate-invalid', 'Candidate model identity is not verified; recovery does not grant a bootstrap claim');
        const fresh = (await strictTabs(workspaceId)).find((tab) => tab.id === candidate.id);
        if (!fresh || fresh.sessionName !== candidate.sessionName || JSON.stringify(fresh.codexLaunchRuntime) !== JSON.stringify(candidate.codexLaunchRuntime)) throw new OrchestrationError(409, 'orchestrator-state-unknown', 'Candidate session or managed generation changed');
        const recheck = await observeOrchestrationRuntime(fresh);
        if (recheck.state !== 'present' || recheck.identity !== observation.identity) throw new OrchestrationError(409, 'orchestrator-state-unknown', 'Candidate runtime changed during recovery');
      }
      const updated = await commitWorkspaceOrchestrationLocked(workspaceId, patch, options.expectedRevision);
      log.info({ workspaceId, mode: options.mode, oldTabId: current.orchestratorTabId, newTabId: updated.orchestration?.orchestratorTabId, revision: updated.orchestration?.revision }, 'coordinator mapping committed');
      if (next.enabled && next.orchestratorTabId && next.orchestratorTabId !== current.orchestratorTabId) await rebindMissionRuns(workspaceId, next.orchestratorTabId, options.mode);
      return updated;
    });
  });
};

/** Human start alone may designate the agent it creates before provider readiness. */
export const startOrchestrationTransaction = async (
  workspaceId: string, options: IOrchestrationChange, template: string | undefined,
  create: (workspace: IWorkspace) => Promise<ITab>,
): Promise<{ workspace: IWorkspace; tab: ITab }> => {
  authorize(workspaceId, options);
  if (options.actor.kind !== 'human') throw new OrchestrationError(403, 'forbidden', 'Starting orchestration requires human control');
  return withOrchestrationMappingWrite(workspaceId, async () => {
    const workspace = await getWorkspaceStrict(workspaceId);
    const current = normalizeOrchestration(workspace.orchestration);
    requireOrchestrationRevision(current, options.expectedRevision);
    return underTargets(workspaceId, current.orchestratorTabId ? [current.orchestratorTabId] : [], async () => {
      await checkIncumbent(workspace, await strictTabs(workspaceId), options);
      const tab = await create(workspace);
      let updated: IWorkspace;
      try {
        updated = await commitWorkspaceOrchestrationLocked(workspaceId, {
          enabled: true, orchestratorTabId: tab.id, ...(template !== undefined ? { kickoffTemplate: template } : {}),
        }, options.expectedRevision);
      } catch {
        throw new OrchestrationError(503, 'orchestration-persist-failed', `Tab ${tab.id} was created but is undesignated; no kickoff was queued. Refresh before acting.`, undefined, tab.id);
      }
      await rebindMissionRuns(workspaceId, tab.id, options.mode);
      return { workspace: updated, tab };
    });
  });
};
