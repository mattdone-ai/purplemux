import type { NextApiRequest, NextApiResponse } from 'next';
import { sendCuratorError } from '@/lib/curator-http';
import { readCuratorStatus } from '@/lib/curator-service';
import { requireCaller, requireMethod } from '@/lib/lease-http';

/** The curator's state (ADR-0038): health, queue, shadow clock, kodit measure, each task's state. Any CLI scope reads it. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  if (!(await requireCaller(req, res))) return;
  try {
    return res.status(200).json(await readCuratorStatus());
  } catch (err) {
    return sendCuratorError(res, err);
  }
};

export default handler;
