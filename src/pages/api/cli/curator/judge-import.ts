import type { NextApiRequest, NextApiResponse } from 'next';
import { sendCuratorError } from '@/lib/curator-http';
import { requireCaller, requireMethod } from '@/lib/lease-http';

export const config = { api: { bodyParser: { sizeLimit: '256kb' } } };

/** The only writer of the reshape judge's verdicts (consult C2 (iii)): the admin token, bound to the run and each sha256. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!caller.admin) return res.status(403).json({ error: 'curator judge-import takes the admin token', code: 'forbidden' });
  const body = (req.body ?? {}) as { runId?: unknown; verdicts?: unknown; judge?: unknown };
  try {
    const { importReshapeJudge } = await import('@/lib/curator-reshape-service');
    return res.status(200).json(await importReshapeJudge(body.runId, body.verdicts, body.judge, Date.now()));
  } catch (err) {
    return sendCuratorError(res, err);
  }
};

export default handler;
