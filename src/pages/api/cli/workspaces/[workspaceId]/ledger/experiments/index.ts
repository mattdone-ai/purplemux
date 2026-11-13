import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeOwnWorkspaceWrite } from '@/lib/cli-utils';
import { parseExperimentInput } from '@/lib/ledger';
import { answerLedgerError, methodNotAllowed } from '@/lib/ledger-http';
import { getLedgerStore } from '@/lib/ledger-store';
import { getWorkspaceById } from '@/lib/workspace-store';
import type { ILedgerExperimentsResponse } from '@/types/ledger';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeOwnWorkspaceWrite(req, res, workspaceId, 'An experiment'))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    if (req.method === 'POST') {
      const experiment = getLedgerStore().openExperiment(workspaceId, parseExperimentInput(req.body), Date.now());
      return res.status(201).json({ experiment });
    }
    const body: ILedgerExperimentsResponse = { workspaceId, experiments: getLedgerStore().experiments(workspaceId) };
    return res.status(200).json(body);
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
