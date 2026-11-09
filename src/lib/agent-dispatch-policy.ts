import { findTab } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';
import { withOrchestrationMappingRead } from '@/lib/orchestration-mapping-lock';
import {
  claimCodexBootstrapLocked,
  withCodexTargetLock,
} from '@/lib/providers/codex/launch-lifecycle';
import { getCodexModelStatus, type ICodexModelStatus } from '@/lib/providers/codex/model-observation';
import { withSendProofGate } from '@/lib/send-proof-gate';
import { observeTabSessionsStrict } from '@/lib/tmux';
import type { ITab } from '@/types/terminal';

export interface IAgentDispatchPolicyOptions {
  consumeBootstrapForTarget?: boolean;
}

export type TAgentDispatchPolicyResult =
  | { ok: true }
  | {
      ok: false;
      error: 'agent-model-mismatch' | 'agent-model-unverified';
      tabId: string;
      modelStatus: ICodexModelStatus;
    };

export type TAgentDispatchPolicyCheck = (
  options?: IAgentDispatchPolicyOptions,
) => Promise<TAgentDispatchPolicyResult>;

const unverified = (tabId: string, target?: ITab): TAgentDispatchPolicyResult => ({
  ok: false,
  error: 'agent-model-unverified',
  tabId,
  modelStatus: {
    expected: {
      model: target?.agentLaunchConfig?.model ?? null,
      effort: target?.agentLaunchConfig?.effort ?? null,
    },
    observed: null,
    latestTurn: null,
    latestSettings: null,
    scanState: 'unavailable',
    hasActivity: false,
    status: 'unknown',
    reason: 'lifecycle-unverified',
  },
});

const getOrchestratorId = async (workspaceId: string): Promise<string | null> => {
  const workspace = await getWorkspaceById(workspaceId);
  return workspace?.orchestration?.enabled
    ? workspace.orchestration.orchestratorTabId ?? null
    : null;
};

/**
 * Requires both target and the supplied crown's lifecycle locks through submission.
 * A changed crown mapping must not cause inspection of a newly unlocked crown.
 */
export const checkAgentDispatchPolicyLocked = async (
  workspaceId: string,
  target: ITab | undefined,
  lockedOrchestratorId: string | null,
  options: IAgentDispatchPolicyOptions = {},
): Promise<TAgentDispatchPolicyResult> => {
  const foundTarget = target ? await findTab(workspaceId, target.id) : null;
  if (target && (!foundTarget || foundTarget.tab.sessionName !== target.sessionName)) {
    return unverified(target.id, target);
  }
  const currentTarget = foundTarget?.tab;
  const orchestratorId = await getOrchestratorId(workspaceId);
  if (orchestratorId !== lockedOrchestratorId) {
    return unverified(orchestratorId ?? target?.id ?? lockedOrchestratorId ?? '');
  }
  const tabs = currentTarget ? [currentTarget] : [];
  if (orchestratorId && orchestratorId !== currentTarget?.id) {
    const found = await findTab(workspaceId, orchestratorId);
    if (found) tabs.push(found.tab);
    // A closed crown has no model left to verify; only a surviving session keeps it unverified.
    else if ((await observeTabSessionsStrict(workspaceId, orchestratorId)).state !== 'absent') return unverified(orchestratorId);
  }

  let targetAwaitingFirstTurn: { tab: ITab; modelStatus: ICodexModelStatus } | null = null;
  for (const tab of tabs) {
    if (tab.panelType !== 'codex-cli') continue;
    const modelStatus = await getCodexModelStatus(tab);
    if (modelStatus.status === 'mismatch') {
      return { ok: false, error: 'agent-model-mismatch', tabId: tab.id, modelStatus };
    }
    if (modelStatus.status !== 'unknown') continue;

    const mayClaimLater = options.consumeBootstrapForTarget === true
      && currentTarget?.id === tab.id
      && modelStatus.reason === 'awaiting-first-turn';
    if (mayClaimLater) {
      targetAwaitingFirstTurn = { tab, modelStatus };
      continue;
    }
    return { ok: false, error: 'agent-model-unverified', tabId: tab.id, modelStatus };
  }
  if (targetAwaitingFirstTurn) {
    const claim = await claimCodexBootstrapLocked(workspaceId, targetAwaitingFirstTurn.tab.id);
    if (!claim.ok) {
      return {
        ok: false,
        error: 'agent-model-unverified',
        tabId: targetAwaitingFirstTurn.tab.id,
        modelStatus: claim.modelStatus ?? targetAwaitingFirstTurn.modelStatus,
      };
    }
  }
  if (await getOrchestratorId(workspaceId) !== lockedOrchestratorId) {
    return unverified(target?.id ?? lockedOrchestratorId ?? '');
  }
  return { ok: true };
};

const withTargetLocks = async <T>(
  workspaceId: string,
  target: ITab | undefined,
  work: (checkPolicy: TAgentDispatchPolicyCheck) => Promise<T>,
): Promise<T> => withOrchestrationMappingRead(workspaceId, async () => {
  const orchestratorId = await getOrchestratorId(workspaceId);
  const tabIds = [...new Set([target?.id, orchestratorId].filter((id): id is string => !!id))].sort();
  const acquire = (index: number): Promise<T> => index < tabIds.length
    ? withCodexTargetLock(workspaceId, tabIds[index], () => acquire(index + 1))
    : work((options) => checkAgentDispatchPolicyLocked(workspaceId, target, orchestratorId, options));
  return acquire(0);
});

/**
 * Keep the final check and terminal submission inside work; never nest target locks. The target's send gate is
 * taken first (`send-proof-gate.ts`), so no dispatch types into a tab while a `tab send` waits for its proof.
 */
export const withAgentDispatchLock = async <T>(
  workspaceId: string,
  target: ITab | undefined,
  work: (checkPolicy: TAgentDispatchPolicyCheck) => Promise<T>,
): Promise<T> => (target
  ? withSendProofGate(workspaceId, target.id, () => withTargetLocks(workspaceId, target, work))
  : withTargetLocks(workspaceId, target, work));

/**
 * As {@link withAgentDispatchLock}, then `after` once the target and orchestrator locks are released, still inside
 * the target's send gate. A `tab send` waits for its proof there: a Codex hook applies inside the target lock, and
 * an orchestrator's hooks inside its own, so neither may be held through the wait (vel-RETRO-R3, CONFIRM r2).
 */
export const withAgentDispatchThen = async <T, U>(
  workspaceId: string,
  target: ITab,
  work: (checkPolicy: TAgentDispatchPolicyCheck) => Promise<T>,
  after: (typed: T) => Promise<U>,
): Promise<U> => withSendProofGate(workspaceId, target.id, async () => after(await withTargetLocks(workspaceId, target, work)));

/** Called only after the request's workspace authorization succeeds. */
export const checkAgentDispatchPolicy = async (
  workspaceId: string,
  target?: ITab,
  options: IAgentDispatchPolicyOptions = {},
): Promise<TAgentDispatchPolicyResult> =>
  withAgentDispatchLock(workspaceId, target, (checkPolicy) => checkPolicy(options));

/** Test-only compatibility; persisted lifecycle state has no in-memory claims. */
export const clearAgentDispatchPolicyState = (): void => {};
