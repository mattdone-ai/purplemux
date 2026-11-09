import type { NextApiRequest, NextApiResponse } from 'next';
import { bodyOf, holderOf, leaseAuthority, requireCaller, requireMethod, viewOf } from '@/lib/lease-http';
import { sendPoolError } from '@/lib/pool-http';
import { cancelPoolAsk, releasePoolSlot } from '@/lib/pool-service';

// vel-POOL-ENF: `{lease, ask}` releases only the slot that ask took; `{ask}` alone cancels the ask (its slots, and a mark
// that refuses a late acquire with it); `{lease}` is the release of before.
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    if ((body.lease === undefined || body.lease === null || body.lease === '') && body.ask !== undefined && body.ask !== null) {
      return res.status(200).json(await cancelPoolAsk(body.ask, holderOf(caller), leaseAuthority));
    }
    const lease = await releasePoolSlot(body.lease, holderOf(caller), leaseAuthority, body.ask ?? undefined);
    return res.status(200).json({ released: await viewOf(lease) });
  } catch (err) {
    return sendPoolError(res, err);
  }
};

export default handler;
