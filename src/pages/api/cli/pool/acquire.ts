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
      { kind: body.kind, memGb: body.memGb, ttlSeconds: body.ttlSeconds, panelType: body.panelType, role: body.role },
      holderOf(caller),
      leaseAuthority,
    );
    return res.status(200).json(result);
  } catch (err) {
    return sendPoolError(res, err);
  }
};

export default handler;
