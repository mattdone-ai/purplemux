import type { NextApiRequest, NextApiResponse } from 'next';
import { readWorkspaceLayout } from '@/lib/workspace-layout-read';
import { getLayout } from '@/lib/layout-store';
import { collectPanes, getFirstPaneId } from '@/lib/layout-tree';
import { getWorkspaceById } from '@/lib/workspace-store';
import { resolveCliScope, type TCliScope } from '@/lib/workspace-token';
import { getBrowserBridge, type IBrowserBridgeClient } from '@/lib/browser-bridge-client';
import type { ITab } from '@/types/terminal';
import { FOREIGN_MUTATION_HINT, TAB_NOT_FOUND_BODY } from '@/lib/cli-error';
import { auditOwnerRead } from '@/lib/grant-service';
import { findActiveDriveGrant, findActiveOwnerGrant, grantsSnapshot } from '@/lib/grant-store';
import { selectedScrumMasterCanRead, selectedScrumMasterScope } from '@/lib/scrum-master-access';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import type { IGrant } from '@/types/grant';

export interface ITabLocation {
  workspaceId: string;
  paneId: string;
  tab: ITab;
}

/** Read authority is deliberately wider than mutation authority. */
export const canAccessWorkspace = async (scope: TCliScope, workspaceId: string): Promise<boolean> =>
  (await accessDecision(scope, workspaceId)).ok;

export const accessDecision = async (scope: TCliScope, workspaceId: string): Promise<{ ok: boolean; grant: IGrant | null }> => {
  if (scope.type === 'admin') return { ok: true, grant: null };
  if (scope.workspaceId === workspaceId) return { ok: true, grant: null };
  const target = await getWorkspaceById(workspaceId);
  if (target?.allowedPeers?.includes(scope.workspaceId)) return { ok: true, grant: null };
  const grant = scope.tabVerified === true && scope.tabId
    ? findActiveDriveGrant(grantsSnapshot(), { workspaceId: scope.workspaceId, tabId: scope.tabId }, workspaceId, Date.now())
    : null;
  if (grant) return { ok: true, grant };
  // ADR-0029: the owner's verified tab reads every workspace, including one created after the grant.
  const owner = scope.tabVerified === true && scope.tabId
    ? findActiveOwnerGrant(grantsSnapshot('owner'), { workspaceId: scope.workspaceId, tabId: scope.tabId }, Date.now())
    : null;
  if (owner) {
    await auditOwnerRead(owner, workspaceId);
    return { ok: true, grant: owner };
  }
  return { ok: await selectedScrumMasterCanRead(scope, workspaceId), grant: null };
};

export const isOwnWorkspace = (scope: TCliScope, workspaceId: string): boolean =>
  scope.type === 'workspace' && scope.workspaceId === workspaceId;

/** Legacy drive grants retain read access only; no grant expands mutation scope. */
export const driveDecision = (scope: TCliScope, workspaceId: string): { ok: boolean; grant: IGrant | null } =>
  ({ ok: isOwnWorkspace(scope, workspaceId), grant: null });

export const canDriveWorkspace = (scope: TCliScope, workspaceId: string): boolean =>
  driveDecision(scope, workspaceId).ok;

/**
 * ADR-0046: the human-saved Scrum Master selection is the one route to a foreign mutation. It holds only for the
 * selection's exact, still-current, launch-verified manager tab, and only in a workspace the selection names. Each
 * use is audited as "scrum-master-mutation". A selection store that cannot be read refuses (fails closed).
 */
export const selectedScrumMasterMayMutate = async (
  scope: TCliScope,
  workspaceId: string,
  route: string | undefined,
  audit: (entry: Record<string, unknown>) => Promise<boolean> = appendCoordinationAudit,
): Promise<boolean> => {
  if (scope.type !== 'workspace') return false;
  let selected: boolean;
  try {
    selected = (await selectedScrumMasterScope(scope, workspaceId)) !== null;
  } catch {
    return false;
  }
  if (!selected) return false;
  await audit({ event: 'scrum-master-mutation', managerWorkspaceId: scope.workspaceId, managerTabId: scope.tabId ?? null,
    workspaceId, route: (route ?? '').split('?')[0] }).catch(() => false);
  return true;
};

export const authorizeWorkspaceMutation = async (
  req: NextApiRequest,
  res: NextApiResponse,
  workspaceId: string,
): Promise<TCliScope | null> => {
  const scope = resolveCliScope(req, { response: res });
  if (!scope) {
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  }
  if (!isOwnWorkspace(scope, workspaceId) && !(await selectedScrumMasterMayMutate(scope, workspaceId, req.url))) {
    res.status(403).json({
      error: `Agent mutations are confined to the caller workspace. ${FOREIGN_MUTATION_HINT}`,
      code: 'forbidden',
    });
    return null;
  }
  return scope;
};

/** All non-read calls share the same boundary, including browser and configuration routes. */
export const authorizeWorkspace = async (
  req: NextApiRequest,
  res: NextApiResponse,
  workspaceId: string,
  _opts: { grant?: 'allow' | 'refuse' } = {},
): Promise<TCliScope | null> => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) {
    return authorizeWorkspaceMutation(req, res, workspaceId);
  }
  const scope = resolveCliScope(req, { response: res });
  if (!scope) {
    res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
    return null;
  }
  if (!(await accessDecision(scope, workspaceId)).ok) {
    res.status(403).json({ error: 'Workspace read access is out of scope. Use coordinator notes or local human controls.', code: 'forbidden' });
    return null;
  }
  return scope;
};

export const authorizeWorkspaceInput = authorizeWorkspaceMutation;

export const findTab = async (
  workspaceId: string,
  tabId: string,
): Promise<ITabLocation | null> => {
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return null;
  const layout = await readWorkspaceLayout(workspaceId);
  if (!layout) return null;
  for (const pane of collectPanes(layout.root)) {
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (tab) return { workspaceId, paneId: pane.id, tab };
  }
  return null;
};

export const resolveFirstPaneId = async (workspaceId: string): Promise<string | null> => {
  const layout = await getLayout(workspaceId);
  const paneId = getFirstPaneId(layout.root);
  return paneId || null;
};

interface IBrowserTabContext {
  tabId: string;
  bridge: IBrowserBridgeClient;
}

export const withBrowserTab = async (
  req: NextApiRequest,
  res: NextApiResponse,
  method: 'GET' | 'POST',
  handler: (ctx: IBrowserTabContext) => Promise<void> | void,
): Promise<void> => {
  if (req.method !== method) {
    res.setHeader('Allow', method);
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) {
    res.status(400).json({ error: 'workspaceId is required' });
    return;
  }
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  const found = await findTab(workspaceId, tabId);
  if (!found) {
    res.status(404).json(TAB_NOT_FOUND_BODY);
    return;
  }
  if (found.tab.panelType !== 'web-browser') {
    res.status(400).json({ error: 'Tab is not a web-browser panel' });
    return;
  }
  const bridge = getBrowserBridge();
  if (!bridge) {
    res.status(503).json({ error: 'Browser bridge unavailable (Electron-only feature)' });
    return;
  }
  await handler({ tabId, bridge });
};
