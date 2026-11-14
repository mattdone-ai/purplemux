import { collectAllTabs, readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import { getPortfolioStore } from '@/lib/portfolio-store';
import { getTabTokenRecord, tabIdentityOf } from '@/lib/tab-token';
import { hasSession } from '@/lib/tmux';
import { getWorkspaceById } from '@/lib/workspace-store';
import type { TCliScope } from '@/lib/workspace-token';
import type { IPortfolioSelection } from '@/types/portfolio';
import type { IWorkspace } from '@/types/terminal';

export const currentCoordinator = async (workspaceId: string, tabId: string,
  snapshot?: { workspace: IWorkspace | undefined; liveSessions: ReadonlySet<string> }): Promise<boolean> => {
  const workspace = snapshot ? snapshot.workspace : await getWorkspaceById(workspaceId);
  if (workspace?.id !== workspaceId || !workspace.orchestration?.enabled
    || workspace.orchestration.orchestratorTabId !== tabId) return false;
  const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
  const tab = layout && collectAllTabs(layout.root).find((entry) => entry.id === tabId);
  const token = getTabTokenRecord(tabId);
  return !!tab?.sessionName && token?.workspaceId === workspaceId && token.sessionName === tab.sessionName
    && tabIdentityOf(workspaceId, tabId) === 'launch'
    && (snapshot ? snapshot.liveSessions.has(tab.sessionName) : await hasSession(tab.sessionName));
};

/** One persisted human selection: who made it, when, and what it names. */
export interface IScrumMasterSnapshot {
  actor: string;
  updatedAt: number;
  selection: IPortfolioSelection;
}

/** The current selection, read synchronously (the fleet-config write compares it inside its store lock, ADR-0045). */
export const currentScrumMasterSelection = (): IScrumMasterSnapshot | null => getPortfolioStore().currentSelection();

/** The same selection: the same actor and time, the same manager, and the same workspaces. */
export const sameSelection = (a: IScrumMasterSnapshot | null, b: IScrumMasterSnapshot | null): boolean =>
  !!a && !!b && a.actor === b.actor && a.updatedAt === b.updatedAt
  && a.selection.managerWorkspaceId === b.selection.managerWorkspaceId && a.selection.managerTabId === b.selection.managerTabId
  && a.selection.workspaceIds.length === b.selection.workspaceIds.length && a.selection.workspaceIds.every((ws, i) => b.selection.workspaceIds[i] === ws);

/**
 * The selection that makes this caller the Portfolio Scrum Master, or null: a persisted human selection is effective
 * only for its exact, still-current launch tab.
 */
export const scrumMasterSnapshot = async (scope: TCliScope, targetWorkspaceId?: string): Promise<IScrumMasterSnapshot | null> => {
  if (scope.type !== 'workspace' || !scope.tabVerified || !scope.tabId) return null;
  const designation = currentScrumMasterSelection();
  if (!designation || designation.selection.managerWorkspaceId !== scope.workspaceId
    || designation.selection.managerTabId !== scope.tabId
    || (targetWorkspaceId && !designation.selection.workspaceIds.includes(targetWorkspaceId))
    || !(await currentCoordinator(scope.workspaceId, scope.tabId))) return null;
  const stillCurrent = currentScrumMasterSelection();
  return stillCurrent?.actor === designation.actor && stillCurrent.updatedAt === designation.updatedAt ? designation : null;
};

/**
 * Inside a store lock (ADR-0047, r2 #5, as ADR-0045 ruling 5): the selection an action was authorized on is still the
 * current one, and still names `targetWorkspaceId` when one is given. A change between the proof and the lock refuses.
 */
export const selectionStillHolds = (snapshot: IScrumMasterSnapshot, targetWorkspaceId?: string): boolean => {
  const now = currentScrumMasterSelection();
  return sameSelection(now, snapshot) && (!targetWorkspaceId || now!.selection.workspaceIds.includes(targetWorkspaceId));
};

/** A persisted human selection is effective only for its exact, still-current launch tab. */
export const selectedScrumMasterScope = async (scope: TCliScope, targetWorkspaceId?: string): Promise<IPortfolioSelection | null> =>
  (await scrumMasterSnapshot(scope, targetWorkspaceId))?.selection ?? null;

export const selectedScrumMasterCanRead = async (scope: TCliScope, workspaceId: string): Promise<boolean> =>
  (await selectedScrumMasterScope(scope, workspaceId)) !== null;
