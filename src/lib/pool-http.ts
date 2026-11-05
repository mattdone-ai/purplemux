import type { NextApiResponse } from 'next';
import { sendLeaseError } from '@/lib/lease-http';
import { FleetConfigFileError } from '@/lib/fleet-config-store';
import { PoolError } from '@/lib/pool-service';

/** Pool refusals carry `code` like every CLI route (ADR-0016); lease refusals keep their own. */
export const sendPoolError = async (res: NextApiResponse, err: unknown): Promise<void> => {
  if (err instanceof PoolError) {
    res.status(err.code === 'pool-full' ? 409 : 400).json({ error: err.message, code: err.code, ...(err.refusal ? { refusal: err.refusal } : {}) });
    return;
  }
  if (err instanceof FleetConfigFileError) {
    res.status(503).json({ error: err.message, code: err.code });
    return;
  }
  await sendLeaseError(res, err);
};
