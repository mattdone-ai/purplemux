import type { NextApiRequest, NextApiResponse } from 'next';
import { getMissionControlStore } from '@/lib/mission-control-store';
import {
  requireMissionHuman,
  requireMissionSameOrigin,
  sendMissionError,
  setMissionHeaders,
} from '@/lib/mission-control-http';
import { SO_PROPOSAL_ITEM_PREFIX, parseMissionAnswer } from '@/lib/mission-control-validation';
import { createLogger } from '@/lib/logger';

const log = createLogger('mission-control');

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const actor = await requireMissionHuman(req);
    requireMissionSameOrigin(req);
    const itemId = Array.isArray(req.query.itemId) ? req.query.itemId[0] : req.query.itemId;
    if (!itemId) return res.status(400).json({ error: 'itemId is required', code: 'invalid-request' });
    const result = getMissionControlStore().submitAnswer(itemId, parseMissionAnswer(req.body), actor);
    // A keep-or-strike answer on an order the curator filed is applied by the server (story 23), after the answer is stored.
    if (!result.replayed) {
      void import('@/lib/curator-routing-service').then((m) => m.curatorOnMissionAnswer(result.item, result.answer, Date.now()))
        .catch((err: unknown) => log.warn(`curator answer hook failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    // A fleet standing-order proposal (ADR-0041 §1 amendment D7): the owner's Yes files the order, after the answer is
    // stored and never inside it. A replay runs the step too: it files nothing twice, and it recovers a step lost to a crash.
    void Promise.resolve().then(async () => {
      if (!result.item.id.startsWith(SO_PROPOSAL_ITEM_PREFIX)) return;
      (await import('@/lib/so-proposal-service')).settleProposalSoon(result.item.id);
    }).catch((err: unknown) => log.warn(`proposal answer hook failed: ${err instanceof Error ? err.message : String(err)}`));
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
