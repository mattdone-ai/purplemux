import type { NextApiRequest, NextApiResponse } from 'next';
import { canAccessWorkspace } from '@/lib/cli-utils';
import { requireCaller, requireMethod } from '@/lib/lease-http';
import { createLogger } from '@/lib/logger';
import { readPoolView, readPoolViewFor } from '@/lib/pool-service';

const log = createLogger('pool');

/**
 * The pool model (ADR-0039): any valid CLI scope may read it. The tabs by workspace and the job holders, items and
 * epics of a workspace the caller cannot read are redacted (ADR-0045, ruling 13); the admin token reads all.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'GET')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const view = caller.admin ? await readPoolView() : await readPoolViewFor((ws) => canAccessWorkspace(caller.scope, ws));
    return res.status(200).json(view);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`pool view failed: ${detail}`);
    return res.status(503).json({ error: `the pool could not be read: ${detail}`, code: 'pool-unreadable' });
  }
};

export default handler;
