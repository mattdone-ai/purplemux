import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceMutation } from '@/lib/cli-utils';
import { PROSE_REFUSED } from '@/lib/flow';
import { LedgerRefusal } from '@/lib/ledger';
import { answerLedgerError, methodNotAllowed } from '@/lib/ledger-http';
import { EXPERIMENT_MAX_DAYS, getLedgerStore } from '@/lib/ledger-store';
import { getWorkspaceById } from '@/lib/workspace-store';

const KEYS = ['days', 'evidence'];

export const parseExtend = (body: unknown): { days: number; evidence: string } => {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  for (const key of Object.keys(record)) {
    if (!KEYS.includes(key)) {
      throw new LedgerRefusal('ledger-experiment-invalid', `body.${key}`, record[key], 'only the keys days, evidence');
    }
  }
  const days = record.days;
  if (!Number.isSafeInteger(days) || (days as number) < 1 || (days as number) > EXPERIMENT_MAX_DAYS) {
    throw new LedgerRefusal('ledger-experiment-invalid', 'days', days, `an integer from 1 to ${EXPERIMENT_MAX_DAYS}`);
  }
  const evidence = record.evidence;
  if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000 || PROSE_REFUSED.test(evidence)) {
    throw new LedgerRefusal('ledger-experiment-invalid', 'evidence', evidence,
      'a non-blank string of at most 2000 characters with no control character and no bidi control');
  }
  return { days: days as number, evidence };
};

/** Extend an active experiment once (purplemux ledger experiment extend; ADR-HFL-03 "extend once"). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspaceMutation(req, res, workspaceId))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    const { days, evidence } = parseExtend(req.body);
    const experiment = getLedgerStore().extendExperiment(workspaceId, req.query.id as string, days, evidence, Date.now());
    return res.status(200).json({ experiment });
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
