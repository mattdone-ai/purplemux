import type { NextApiRequest, NextApiResponse } from 'next';
import { requireCaller, requireMethod } from '@/lib/lease-http';
import { defaultNotePointPort } from '@/lib/note-pointer';
import { sendNoteError } from '@/lib/notes-http';
import { getNotesService } from '@/lib/notes-service';

/** The pointer carries no text: the body is absent, null or `{}` (design ruling, AC1). */
const emptyBody = (body: unknown): boolean =>
  body === undefined || body === null || body === ''
  || (typeof body === 'object' && !Array.isArray(body) && Object.keys(body as object).length === 0);

/**
 * POST — the verified current orchestrator types one fixed pointer line for its own undelivered cross-workspace
 * note into the recipient orchestrator, busy included (G7). The line and the target come from the note, never from
 * the request.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!emptyBody(req.body)) {
    return res.status(400).json({ error: 'a pointer carries no text: send no body', code: 'note-invalid' });
  }
  try {
    const result = await (await getNotesService()).point(caller, req.query.id, await defaultNotePointPort());
    return res.status(200).json(result);
  } catch (err) {
    return sendNoteError(res, err);
  }
};

export default handler;
