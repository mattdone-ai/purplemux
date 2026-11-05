import type { NextApiRequest, NextApiResponse } from 'next';
import { sendCuratorError, taskOf } from '@/lib/curator-http';
import { readCuratorEval, startCuratorEval } from '@/lib/curator-service';
import { isLabelTask } from '@/lib/curator-tasks';
import type { TCuratorSplit } from '@/lib/curator-eval';
import { requireCaller } from '@/lib/lease-http';

const SPLITS: readonly TCuratorSplit[] = ['holdout', 'train', 'all'];
const splitOf = (raw: unknown): TCuratorSplit | null => (raw === undefined ? 'holdout' : SPLITS.find((s) => s === raw) ?? null);

/** POST starts (or joins) a task's evaluation; GET reads its progress and the latest result of a split (AC 5). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed', code: 'method-not-allowed' });
  }
  if (!(await requireCaller(req, res))) return;
  const task = taskOf(req, res);
  if (!task) return;
  const split = splitOf(req.method === 'GET' ? req.query.split : (req.body as { split?: unknown } | null)?.split);
  if (!split) return res.status(400).json({ error: `split must be one of ${SPLITS.join(', ')}`, code: 'curator-task-invalid' });
  try {
    if (req.method === 'GET') {
      if (isLabelTask(task)) return res.status(200).json(await readCuratorEval(task, split));
      const { readReshapeEval } = await import('@/lib/curator-reshape-service');
      return res.status(200).json(await readReshapeEval());
    }
    return res.status(202).json({ progress: await startCuratorEval(task, split) });
  } catch (err) {
    return sendCuratorError(res, err);
  }
};

export default handler;
