import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { countInbox } from '@/lib/inbox-counts';
import { readInboxState } from '@/lib/inbox-store';

/**
 * The inbox of one workspace's tabs (ADR-0012): queued and held notices, or
 * every retained one with `all=1`. Read scope, like `tab status`. `counts`
 * covers every retained item, whatever `all` says, so a board reads it in one call.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;

  const all = req.query.all === '1' || req.query.all === 'true';
  const { items } = await readInboxState();
  return res.status(200).json({
    workspaceId,
    counts: countInbox(items, workspaceId),
    items: items
      .filter((item) => item.targetWorkspaceId === workspaceId)
      .filter((item) => all || item.state === 'queued' || item.state === 'held')
      .sort((a, b) => a.createdAt - b.createdAt),
  });
};

export default handler;
