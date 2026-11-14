import type { NextApiRequest, NextApiResponse } from 'next';
import { requireCaller, requireMethod } from '@/lib/lease-http';
import { sendNoteError } from '@/lib/notes-http';
import { getNotesService } from '@/lib/notes-service';
import { scrumMasterSnapshot } from '@/lib/scrum-master-access';

/**
 * The note and its body: the recipient workspace, the sender workspace, or admin (ADR-0013); and the Portfolio Scrum
 * Master's verified tab for a note of a workspace in its selection (ADR-0047, owner order). A read only.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const snapshot = caller.admin ? null : await scrumMasterSnapshot(caller.scope);
    return res.status(200).json(await (await getNotesService()).show(caller, req.query.id, snapshot?.selection.workspaceIds ?? []));
  } catch (err) {
    return sendNoteError(res, err);
  }
};

export default handler;
