import type { NextApiRequest, NextApiResponse } from 'next';
import { requireCaller, requireMethod } from '@/lib/lease-http';
import { readMessageHistory } from '@/lib/message-history-store';
import { looksLikeSecret } from '@/lib/secret-patterns';

/**
 * The owner's prompts of a workspace, oldest first (story 36, D8): id, time, tab and text, `since` an ISO time. A tab
 * reads its own workspace's; admin reads any. A credential-shaped message is withheld, as `curator message` refuses it.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required', code: 'invalid-request' });
  if (!caller.admin && caller.workspaceId !== workspaceId) {
    return res.status(403).json({ error: `a tab reads its own workspace's messages, not ${workspaceId}'s`, code: 'forbidden' });
  }
  const rawSince = typeof req.query.since === 'string' ? req.query.since : '';
  const sinceMs = rawSince ? Date.parse(rawSince) : null;
  if (sinceMs !== null && Number.isNaN(sinceMs)) {
    return res.status(400).json({ error: `since must be an ISO time, got "${rawSince}"`, code: 'invalid-request' });
  }
  const messages = (await readMessageHistory(workspaceId))
    .filter((entry) => sinceMs === null || Date.parse(entry.sentAt) >= sinceMs)
    .reverse()
    .map((entry) => {
      const withheld = looksLikeSecret(entry.message);
      return { id: entry.id, sentAt: entry.sentAt, tabId: entry.tabId ?? null, message: withheld ? null : entry.message, withheld };
    });
  return res.status(200).json({ workspaceId, since: sinceMs === null ? null : new Date(sinceMs).toISOString(), messages });
};

export default handler;
