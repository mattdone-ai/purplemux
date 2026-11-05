import type { NextApiRequest, NextApiResponse } from 'next';
import { requireCaller, requireMethod } from '@/lib/lease-http';
import { readMessageHistory } from '@/lib/message-history-store';
import { looksLikeSecret } from '@/lib/secret-patterns';

/**
 * One owner message by its history id (story 23, consult C1): the line a standing-order candidate sends names the id,
 * never the text, and the receiving tab reads it here. A tab reads its own workspace's messages; admin reads any.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
  const entryId = typeof req.query.entryId === 'string' ? req.query.entryId : '';
  if (!workspaceId || !entryId) return res.status(400).json({ error: 'workspaceId and entryId are required', code: 'invalid-request' });
  if (!caller.admin && caller.workspaceId !== workspaceId) {
    return res.status(403).json({ error: `a tab reads its own workspace's messages, not ${workspaceId}'s`, code: 'forbidden' });
  }
  const entry = (await readMessageHistory(workspaceId)).find((e) => e.id === entryId);
  if (!entry) return res.status(404).json({ error: `no message ${entryId} in ${workspaceId}'s history (it keeps the last 500)`, code: 'not-found' });
  // A credential-shaped message is never shown, not even in part (story 16 consult ruling 7; review r1 F5).
  if (looksLikeSecret(entry.message)) {
    return res.status(409).json({ error: `message ${entryId} looks like it holds a credential and is not shown; read it in the owner's own history`, code: 'curator-refused' });
  }
  return res.status(200).json({ workspaceId, entryId, sentAt: entry.sentAt, message: entry.message });
};

export default handler;
