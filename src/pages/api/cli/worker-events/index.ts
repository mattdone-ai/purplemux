import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, requireCaller, requireMethod } from '@/lib/lease-http';
import { sendWorkerEventError } from '@/lib/worker-events-http';
import { getWorkerEventsService } from '@/lib/worker-events-service';

/** POST — a verified worker tab announces a typed event inside its declared scope (ADR-0043). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    const result = await (await getWorkerEventsService()).send(caller, { type: body.type, toEpic: body.toEpic, payload: body.payload });
    return res.status(200).json(result);
  } catch (err) {
    return sendWorkerEventError(res, err);
  }
};

export default handler;
