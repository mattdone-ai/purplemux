import type { NextApiRequest, NextApiResponse } from 'next';
import { labelTaskOf, sendCuratorError } from '@/lib/curator-http';
import { curatorLabelImport } from '@/lib/curator-service';
import { requireCaller, requireMethod } from '@/lib/lease-http';

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

/** The one writer of shadow gold (consult 16-promote-gate): the admin token only; ids outside the queue are refused. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!caller.admin) return res.status(403).json({ error: 'curator label-import takes the admin token', code: 'forbidden' });
  const task = labelTaskOf(req, res);
  if (!task) return;
  try {
    return res.status(200).json(await curatorLabelImport(task, (req.body as { labels?: unknown } | null)?.labels));
  } catch (err) {
    return sendCuratorError(res, err);
  }
};

export default handler;
