import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, holderOf, leaseAuthority, requireCaller, requireMethod, viewOf } from '@/lib/lease-http';
import { sendPoolError } from '@/lib/pool-http';
import { releasePoolSlot } from '@/lib/pool-service';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const lease = await releasePoolSlot(bodyOf(req).lease, holderOf(caller), leaseAuthority);
    return res.status(200).json({ released: await viewOf(lease) });
  } catch (err) {
    return sendPoolError(res, err);
  }
};

export default handler;
