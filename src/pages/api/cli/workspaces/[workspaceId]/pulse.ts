import type { NextApiRequest, NextApiResponse } from 'next';
import { readPulse } from '@/lib/pulse-service';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';

/** The pulse (ADR-0034 §9) for `purplemux board pulse`; read scope on the workspace. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  return res.status(200).json(await readPulse(workspaceId, Date.now()));
};

export default handler;
