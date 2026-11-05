import type { NextApiRequest, NextApiResponse } from 'next';
import { requireCaller, requireMethod } from '@/lib/lease-http';
import { createLogger } from '@/lib/logger';
import { readPoolView } from '@/lib/pool-service';

const log = createLogger('pool');

/** The pool model (ADR-0039): any valid CLI scope may read it. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  if (!(await requireCaller(req, res))) return;
  try {
    return res.status(200).json(await readPoolView());
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`pool view failed: ${detail}`);
    return res.status(503).json({ error: `the pool could not be read: ${detail}`, code: 'pool-unreadable' });
  }
};

export default handler;
