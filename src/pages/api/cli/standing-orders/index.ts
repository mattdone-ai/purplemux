import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller } from '@/lib/lease-http';
import { FLEET } from '@/lib/standing-orders-store';
import { sendStandingOrderError, standingOrderDeps } from '@/lib/standing-orders-http';
import { addStandingOrder, listStandingOrders } from '@/lib/standing-orders-service';

/** GET — the orders a caller reads; POST — add one to the fleet (`workspaceId` absent) or a workspace (ADR-0041). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    if (req.method === 'GET') {
      const ws = typeof req.query.workspaceId === 'string' && req.query.workspaceId ? req.query.workspaceId : null;
      return res.status(200).json(await listStandingOrders(caller, ws, req.query.all === '1'));
    }
    const body = bodyOf(req);
    const owner = typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : FLEET;
    const result = await addStandingOrder(standingOrderDeps(), caller, owner,
      { text: body.text, source: body.source, scope: body.scope, check: body.check });
    return res.status(200).json(result);
  } catch (err) {
    return sendStandingOrderError(res, err);
  }
};

export default handler;
