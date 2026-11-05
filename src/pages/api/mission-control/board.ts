import type { NextApiRequest, NextApiResponse } from 'next';
import { readBoard } from '@/lib/board';
import { invalidMissionRequest, missionNotFound } from '@/lib/mission-control-errors';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import type { IMissionBoardListResponse } from '@/types/constraint';

/** The board (ADR-0034) for the human: `?workspaceId=all` (the default) or one workspace. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  try {
    await requireMissionHuman(req);
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const now = Date.now();
    const { workspaceId = 'all' } = req.query;
    if (typeof workspaceId !== 'string' || !workspaceId) return invalidMissionRequest('workspaceId: expected all or one workspace id');
    if (workspaceId === 'all') {
      const { workspaces } = await getWorkspaces();
      const body: IMissionBoardListResponse = { boards: await Promise.all(workspaces.map((ws) => readBoard(ws.id, now))) };
      return res.status(200).json(body);
    }
    if (!(await getWorkspaceById(workspaceId))) missionNotFound(`Workspace ${workspaceId} not found`);
    return res.status(200).json(await readBoard(workspaceId, now));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
