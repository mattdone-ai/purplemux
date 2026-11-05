import type { NextApiRequest, NextApiResponse } from 'next';
import { labelTaskOf, sendCuratorError } from '@/lib/curator-http';
import { commitSpotCheck, draftSpotCheck, readSpotCheck } from '@/lib/curator-service';
import { requireCaller } from '@/lib/lease-http';

/**
 * POST { task, workspaceId } drafts a task's spot-check item (AC 6) and writes nothing; the caller posts the question
 * as its own Mission Control event, then POST { task, workspaceId, commit: itemId } records the number map once the
 * item exists. Admin, or a tab of that workspace. GET ?task= reads the answer.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed', code: 'method-not-allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const task = labelTaskOf(req, res);
  if (!task) return;
  try {
    if (req.method === 'GET') return res.status(200).json(await readSpotCheck(task));
    const { workspaceId, commit } = (req.body ?? {}) as { workspaceId?: unknown; commit?: unknown };
    if (typeof workspaceId !== 'string' || !/^ws-[A-Za-z0-9_-]+$/.test(workspaceId)) {
      return res.status(400).json({ error: 'workspaceId is required', code: 'curator-workspace-invalid' });
    }
    if (!caller.admin && caller.workspaceId !== workspaceId) {
      return res.status(403).json({ error: 'a tab drafts the spot check for its own workspace only', code: 'forbidden' });
    }
    if (typeof commit === 'string') return res.status(200).json(await commitSpotCheck(task, workspaceId, commit));
    return res.status(200).json(await draftSpotCheck(task, workspaceId, Date.now()));
  } catch (err) {
    return sendCuratorError(res, err);
  }
};

export default handler;
