import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller } from '@/lib/lease-http';
import { isMissionControlError } from '@/lib/mission-control-errors';
import { sendStandingOrderError } from '@/lib/standing-orders-http';

/**
 * POST — the selected portfolio manager proposes a fleet standing order (ADR-0041 §1 amendment D7). The server opens a
 * `confirm` item of class `scope` with no default on the manager's own run; the owner's Yes files the order.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    const { proposeStandingOrder, soProposalDeps } = await import('@/lib/so-proposal-service');
    const result = await proposeStandingOrder(await soProposalDeps(), caller,
      { text: body.text, why: body.why, cites: body.cites, scope: body.scope, check: body.check });
    return res.status(201).json(result);
  } catch (err) {
    // The item's own refusal (the question validator, a lost run binding) keeps its Mission Control code.
    if (isMissionControlError(err)) return res.status(err.status).json({ error: err.message, code: err.code });
    return sendStandingOrderError(res, err);
  }
};

export default handler;
