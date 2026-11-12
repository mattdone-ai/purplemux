import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller } from '@/lib/lease-http';
import { sendNoteError } from '@/lib/notes-http';
import { getNotesService } from '@/lib/notes-service';

const flag = (value: unknown): boolean => value === '1' || value === 'true';

/**
 * POST — send a local note, or a coordinator-authorized cross-workspace note;
 * GET — the notes the caller's workspace sent or receives, without bodies (ADR-0013).
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const service = await getNotesService();
    if (req.method === 'POST') {
      const body = bodyOf(req);
      const note = await service.send(caller, {
        toEpic: body.toEpic,
        toWorkspace: body.toWorkspace,
        subject: body.subject,
        body: body.body,
        fromEpic: body.fromEpic,
        ownerItem: body.ownerItem,
      });
      return res.status(200).json({ note });
    }
    const epic = typeof req.query.epic === 'string' && req.query.epic ? req.query.epic : null;
    const notes = await service.list(caller, {
      open: flag(req.query.open),
      toMe: flag(req.query.toMe),
      fromMe: flag(req.query.fromMe),
      epic,
    });
    return res.status(200).json({ notes });
  } catch (err) {
    return sendNoteError(res, err);
  }
};

export default handler;
