import type { NextApiRequest, NextApiResponse } from 'next';
import { readBoard } from '@/lib/board';
import { clearBoardGoal, goalInputDefects, readBoardGoal, writeBoardGoal } from '@/lib/board-goal-store';
import { authorizeOwnWorkspaceWrite, findTab } from '@/lib/cli-utils';
import { forgetFinderResult } from '@/lib/constraint-tick';
import { getWorkspaceById } from '@/lib/workspace-store';

/**
 * The workspace's goal (ADR-0034 §10): `GET` reads it, `PUT {label, items}` sets it, `DELETE` clears
 * it (`purplemux board goal set|show|clear`). Writes are confined to the caller's own workspace; the Scrum Master
 * selection does not reach them (ADR-0046).
 * A write answers the board's on-track line derived with the new goal.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT', 'DELETE'].includes(req.method ?? '')) {
    res.setHeader('Allow', 'GET, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const workspaceId = req.query.workspaceId as string;
  const scope = await authorizeOwnWorkspaceWrite(req, res, workspaceId, 'The board goal');
  if (!scope) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  if (req.method === 'GET') return res.status(200).json({ workspaceId, goal: await readBoardGoal(workspaceId) });
  if (req.method === 'DELETE') {
    const cleared = await clearBoardGoal(workspaceId);
    forgetFinderResult(workspaceId);
    return res.status(200).json({ workspaceId, cleared, onTrack: (await readBoard(workspaceId, Date.now())).onTrack });
  }
  const defects = goalInputDefects(req.body);
  if (defects.length) return res.status(400).json({ error: `goal-invalid: ${defects.join('; ')}`, code: 'invalid-request', defects });
  let setBy = 'cli';
  if (scope.type === 'workspace' && scope.tabId) setBy = (await findTab(workspaceId, scope.tabId))?.tab.name || scope.tabId;
  const goal = await writeBoardGoal(workspaceId, req.body as { label: string; items: string[] }, setBy, Date.now());
  forgetFinderResult(workspaceId);
  return res.status(200).json({ workspaceId, goal, onTrack: (await readBoard(workspaceId, Date.now())).onTrack });
};

export default handler;
