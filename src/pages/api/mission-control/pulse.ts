import type { NextApiRequest, NextApiResponse } from 'next';
import { readPulse } from '@/lib/pulse-service';
import { invalidMissionRequest, missionNotFound } from '@/lib/mission-control-errors';
import { requireMissionHuman, sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import type { IMissionPulseListResponse } from '@/types/pulse';

/** The pulse (ADR-0034 §9) for the human: `?workspaceId=all` (the default) or one workspace. */
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
      const body: IMissionPulseListResponse = { pulses: await Promise.all(workspaces.map((ws) => readPulse(ws.id, now))) };
      return res.status(200).json(body);
    }
    if (!(await getWorkspaceById(workspaceId))) missionNotFound(`Workspace ${workspaceId} not found`);
    return res.status(200).json(await readPulse(workspaceId, now));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
