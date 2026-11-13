import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeOwnWorkspaceMutation } from '@/lib/cli-utils';
import { LedgerRefusal } from '@/lib/ledger';
import { answerLedgerError, methodNotAllowed } from '@/lib/ledger-http';
import { getLedgerStore } from '@/lib/ledger-store';
import { PROSE_REFUSED } from '@/lib/flow';
import { getWorkspaceById } from '@/lib/workspace-store';

const VERDICTS = ['keep', 'revert'] as const;

const parseClose = (body: unknown): { verdict: (typeof VERDICTS)[number]; evidence: string } => {
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  for (const key of Object.keys(record)) {
    if (key !== 'verdict' && key !== 'evidence') {
      throw new LedgerRefusal('ledger-experiment-invalid', `body.${key}`, record[key], 'only the keys verdict, evidence');
    }
  }
  if (!(VERDICTS as readonly unknown[]).includes(record.verdict)) {
    throw new LedgerRefusal('ledger-experiment-invalid', 'verdict', record.verdict, 'one of keep, revert', VERDICTS);
  }
  const evidence = record.evidence;
  if (typeof evidence !== 'string' || !evidence.trim() || evidence.length > 2000 || PROSE_REFUSED.test(evidence)) {
    throw new LedgerRefusal('ledger-experiment-invalid', 'evidence', evidence,
      'a non-blank string of at most 2000 characters with no control character and no bidi control');
  }
  return { verdict: record.verdict as (typeof VERDICTS)[number], evidence };
};

/** Close an experiment with its verdict (purplemux ledger experiment close). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeOwnWorkspaceMutation(req, res, workspaceId, 'An experiment verdict'))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    const { verdict, evidence } = parseClose(req.body);
    const experiment = getLedgerStore().closeExperiment(workspaceId, req.query.id as string, verdict, evidence, Date.now());
    return res.status(200).json({ experiment });
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
