import type { NextApiRequest, NextApiResponse } from 'next';
import { readBoard } from '@/lib/board';
import { authorizeWorkspace, findTab } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';

/**
 * The board (ADR-0034) for `purplemux board show`; read scope on the workspace. `?mine=1` keeps the
 * stuck items the calling tab holds, matched by its name or id, so it needs a tab token.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const workspaceId = req.query.workspaceId as string;
  const scope = await authorizeWorkspace(req, res, workspaceId);
  if (!scope) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  let holders: string[] | null = null;
  if (req.query.mine !== undefined) {
    if (req.query.mine !== '1') {
      return res.status(400).json({ error: `mine: saw ${JSON.stringify(req.query.mine)}, expected 1`, code: 'invalid-request' });
    }
    if (scope.type !== 'workspace' || !scope.tabId) {
      return res.status(400).json({ error: 'mine: the calling tab is unknown; run it from a tab (PMUX_TAB_TOKEN)', code: 'invalid-request' });
    }
    const tab = await findTab(scope.workspaceId, scope.tabId);
    holders = tab ? [tab.tab.name, scope.tabId] : [scope.tabId];
  }
  return res.status(200).json(await readBoard(workspaceId, Date.now(), holders));
};

export default handler;
