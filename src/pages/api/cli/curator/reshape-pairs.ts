import type { NextApiRequest, NextApiResponse } from 'next';
import { sendCuratorError } from '@/lib/curator-http';
import { requireCaller, requireMethod } from '@/lib/lease-http';

/**
 * The reshape judge's input (story 23 AC 4, consult C2 (iii)): each replied row's original and reshaped draft with its
 * sha256, from the server's memory of the last run. Admin token only; the CLI prints it to stdout and writes no file.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!caller.admin) return res.status(403).json({ error: 'curator reshape-pairs takes the admin token', code: 'forbidden' });
  try {
    const { reshapePairs } = await import('@/lib/curator-reshape-service');
    return res.status(200).json(await reshapePairs());
  } catch (err) {
    return sendCuratorError(res, err);
  }
};

export default handler;
