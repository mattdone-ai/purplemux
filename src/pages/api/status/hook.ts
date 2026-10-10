import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyCliToken } from '@/lib/cli-token';
import { isRequestAllowed } from '@/lib/access-filter';
import { dispatchHook } from '@/lib/hook-dispatch';
import { authorizeRemoteHook } from '@/lib/remote-hook';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  // A remote tab's hook posts with that tab's own token, for that tab's session only (ADR-0022).
  const remote = req.query.remote !== undefined;
  if (remote && req.query.remote !== 'claude') {
    return res.status(400).json({ error: 'unsupported remote provider' });
  }
  const allowed = remote
    ? await authorizeRemoteHook(req.headers['x-pmux-token'], req.query.session)
    : verifyCliToken(req);
  if (!allowed) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!isRequestAllowed(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const outcome = await dispatchHook({ query: req.query, body: req.body });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  return res.status(outcome.status).end();
};

export default handler;
