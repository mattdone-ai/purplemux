import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCaller } from '@/lib/caller';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

/**
 * `mc ask --fix` (ADR-0037 §3; story 23 AC 3): the curator's reshape of a draft that failed the check. It answers a
 * reshaped draft only where `reshape-question` routes; elsewhere it logs the reshape and answers `shadow`. It posts
 * nothing: the CLI validates and posts the draft, so the asking agent stays the author.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const caller = await resolveCaller(req, res);
    if (!caller) throw new MissionControlError(401, 'unauthorized', 'CLI token required');
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) throw new MissionControlError(400, 'invalid-request', 'workspaceId is required');
    if (!caller.admin && caller.workspaceId !== workspaceId) throw new MissionControlError(403, 'forbidden', `a tab reshapes drafts for its own workspace, not ${workspaceId}`);
    const body = req.body as { question?: unknown } | null;
    if (!body || typeof body !== 'object' || !('question' in body)) {
      throw new MissionControlError(400, 'invalid-request', 'body must be { "question": { ... } }');
    }
    const { reshapeForAsk } = await import('@/lib/curator-reshape-service');
    return res.status(200).json(await reshapeForAsk(workspaceId, caller.tabId ?? '-', body.question));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
