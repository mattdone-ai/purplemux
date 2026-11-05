import type { NextApiRequest, NextApiResponse } from 'next';
import { labelTaskOf, sendCuratorError } from '@/lib/curator-http';
import { curatorLabelQueue } from '@/lib/curator-service';
import { requireCaller, requireMethod } from '@/lib/lease-http';

/** The blind label queue (consult 16-promote-gate): adds the live version's unlabelled shadow calls; answers ids only. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  if (!(await requireCaller(req, res))) return;
  const task = labelTaskOf(req, res);
  if (!task) return;
  try {
    return res.status(200).json(await curatorLabelQueue(task, Date.now()));
  } catch (err) {
    return sendCuratorError(res, err);
  }
};

export default handler;
