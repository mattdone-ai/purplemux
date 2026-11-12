import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, holderOf, leaseAuthority, requireCaller, requireMethod } from '@/lib/lease-http';
import { sendPoolError } from '@/lib/pool-http';
import { acquirePoolSlot } from '@/lib/pool-service';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    const result = await acquirePoolSlot(
      {
        kind: body.kind, memGb: body.memGb, threads: body.threads, ttlSeconds: body.ttlSeconds, panelType: body.panelType, role: body.role,
        class: body.class, queue: body.queue, ticket: body.ticket, ask: body.ask, pin: body.pin, item: body.item,
      },
      holderOf(caller),
      leaseAuthority,
    );
    // A queued request (vel-D4) is accepted, not admitted: the caller re-asks with its ticket.
    return res.status('queued' in result ? 202 : 200).json(result);
  } catch (err) {
    return sendPoolError(res, err);
  }
};

export default handler;
