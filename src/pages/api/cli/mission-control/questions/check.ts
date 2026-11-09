import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCaller } from '@/lib/caller';
import { isOwnWorkspace } from '@/lib/cli-utils';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { readQuestionMinVersion } from '@/lib/mission-question-config';
import { actionReviewLint, ownerStepsLint, reviewLint, validateMissionQuestion } from '@/lib/mission-question-format';
import { getMissionControlStore } from '@/lib/mission-control-store';
import type { TCliScope } from '@/lib/workspace-token';
import type { IMissionFollowUpRefusal, IMissionQuestionDefect } from '@/types/mission-control';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

/** Whether `--fix` may reshape here (ADR-0037 §3; story 23): the curator on, and `reshape-question` routing in this workspace. */
const reshapeSeam = async (workspaceId: string): Promise<{ enabled: boolean; reason: string | null }> => {
  const { curatorEnabled, curatorRoutesIn } = await import('@/lib/curator-service');
  if (!(await curatorEnabled())) return { enabled: false, reason: 'the curator is switched off (curator.enabled=off)' };
  if (!workspaceId || !(await curatorRoutesIn('reshape-question', workspaceId))) {
    return { enabled: false, reason: 'the curator reshape is in shadow for this workspace: --fix logs a reshape and posts nothing' };
  }
  return { enabled: true, reason: null };
};

/** A refused follow-up as a defect of field `followsUp`, with the code and the body the events route would answer. */
export interface IFollowUpDefect extends IMissionQuestionDefect {
  code: string;
  status: number;
  followsUp?: IMissionFollowUpRefusal;
}

const FOLLOW_UP_LIMIT = 'an answered or resolved item of this workspace and run that no item follows up yet';

const followUpDefect = (code: string, status: number, message: string, followsUp?: IMissionFollowUpRefusal): IFollowUpDefect => ({
  field: 'followsUp', measured: message, limit: FOLLOW_UP_LIMIT, message: `followsUp: ${message}`, code, status, ...(followsUp ? { followsUp } : {}),
});

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * The store's follow-up check (ADR-0037 amendment D2, rule 2): the refusal the events route would give, as a defect;
 * nothing is written. Null when the body names no follow-up.
 */
const checkFollowUp = (
  body: { followsUp?: unknown; itemId?: unknown; runId?: unknown; humanReview?: unknown },
  workspaceId: string,
  scope: TCliScope,
): IFollowUpDefect | null => {
  if (!('followsUp' in body) || body.followsUp === undefined) return null;
  const followsUp = text(body.followsUp);
  const itemId = text(body.itemId);
  const runId = text(body.runId);
  if (!followsUp || !itemId || !runId) {
    return followUpDefect('invalid-request', 400, 'a follow-up check needs followsUp, itemId and runId as non-empty strings');
  }
  if (!workspaceId || !isOwnWorkspace(scope, workspaceId)) {
    return followUpDefect('forbidden', 403, 'a follow-up is checked with this workspace token only (ADR-0021)');
  }
  const review = body.humanReview && typeof body.humanReview === 'object'
    ? { humanNeed: (body.humanReview as { humanNeed?: unknown }).humanNeed as 'none' }
    : null;
  const refusal = getMissionControlStore().followUpRefusal({ workspaceId, runId, itemId, followsUp, humanReview: review });
  return refusal ? followUpDefect(refusal.code, refusal.status, refusal.message, refusal.detail?.followsUp) : null;
};

/**
 * The events route's question check without the write (ADR-0037 §2-§3): `purplemux mc ask` runs it
 * before it posts, so the agent fixes every defect in the same turn. `humanReview`, when sent, adds the
 * events route's review lint (story 36, D6).
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const caller = await resolveCaller(req, res);
    if (!caller) throw new MissionControlError(401, 'unauthorized', 'CLI token required');
    const body = req.body as { question?: unknown; humanReview?: unknown; followsUp?: unknown; itemId?: unknown; runId?: unknown } | null;
    if (!body || typeof body !== 'object' || !('question' in body)) {
      throw new MissionControlError(400, 'invalid-request', 'body must be { "question": { ... } }');
    }
    const minVersion = await readQuestionMinVersion();
    const verdict = validateMissionQuestion(body.question, minVersion);
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    const reshape = await reshapeSeam(workspaceId);
    const followUp = checkFollowUp(body, workspaceId, caller.scope);
    if (verdict.ok && !followUp) {
      return res.status(200).json({ ok: true, formatVersion: verdict.formatVersion, minVersion, defects: [],
        lint: [
          ...verdict.lint,
          ...reviewLint(verdict.question, body.humanReview),
          ...ownerStepsLint(verdict.question as unknown as Record<string, unknown>),
          ...actionReviewLint(verdict.question, body.humanReview),
        ], question: verdict.question, reshape });
    }
    const defects = [...(verdict.ok ? [] : verdict.defects), ...(followUp ? [followUp] : [])];
    // A refused follow-up alone keeps the checked question: only the link is wrong.
    return res.status(200).json({ ok: false, formatVersion: verdict.formatVersion, minVersion, defects,
      lint: [], question: verdict.ok ? verdict.question : null, reshape });
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
