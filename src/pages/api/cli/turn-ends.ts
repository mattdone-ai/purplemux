import type { NextApiRequest, NextApiResponse } from 'next';
import { isCodedError } from '@/lib/coded-error';
import { bodyOf, requireCaller, requireMethod } from '@/lib/lease-http';
import { getTurnEndService, turnEndErrorStatus, type TurnEndError } from '@/lib/turn-end-service';

/** POST — `purplemux done`: the caller tab's typed turn end for its current turn (F6, F10 step 2). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    const row = await (await getTurnEndService()).done(caller, {
      verdict: body.verdict, story: body.story, head: body.head, gateLog: body.gateLog, reason: body.reason, cwd: body.cwd,
    });
    return res.status(200).json({ row });
  } catch (err) {
    if (isCodedError<TurnEndError>(err, 'TurnEndError', turnEndErrorStatus)) {
      return res.status(turnEndErrorStatus[err.code]).json({ ...err.details, error: err.message, code: err.code });
    }
    throw err;
  }
};

export default handler;
