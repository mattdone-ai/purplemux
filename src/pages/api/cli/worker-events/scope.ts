import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller } from '@/lib/lease-http';
import { sendWorkerEventError } from '@/lib/worker-events-http';
import { getWorkerEventsService } from '@/lib/worker-events-service';

/**
 * GET — the event scopes of the caller's workspace; PUT — the coordinator declares one tab's scope;
 * DELETE ?tabId= — the coordinator clears it (ADR-0043 §1).
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET' && req.method !== 'PUT' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const service = await getWorkerEventsService();
    if (req.method === 'GET') return res.status(200).json({ scopes: await service.listScopes(caller) });
    if (req.method === 'PUT') {
      const body = bodyOf(req);
      const scope = await service.declareScope(caller, {
        tabId: body.tabId, epic: body.epic, story: body.story, dependsOn: body.dependsOn, attempt: body.attempt,
      });
      return res.status(200).json({ scope });
    }
    return res.status(200).json({ cleared: await service.clearScope(caller, req.query.tabId) });
  } catch (err) {
    return sendWorkerEventError(res, err);
  }
};

export default handler;
