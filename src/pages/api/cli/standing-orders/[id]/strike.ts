import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller } from '@/lib/lease-http';
import { sendStandingOrderError, standingOrderDeps } from '@/lib/standing-orders-http';
import { strikeStandingOrder } from '@/lib/standing-orders-service';

/** POST — strike an active order; it stays in its file with the time and the reason (ADR-0041). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    return res.status(200).json(await strikeStandingOrder(standingOrderDeps(), caller, id, bodyOf(req).reason));
  } catch (err) {
    return sendStandingOrderError(res, err);
  }
};

export default handler;
