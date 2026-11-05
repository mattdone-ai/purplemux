import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceMutation } from '@/lib/cli-utils';
import { LEDGER_PRODUCER_PATTERN, LEDGER_SERVER_PRODUCER, isLedgerProducer, isReservedProducer } from '@/lib/ledger';
import { methodNotAllowed } from '@/lib/ledger-http';
import { issueLedgerToken } from '@/lib/ledger-token';
import { getWorkspaceById } from '@/lib/workspace-store';
import { show } from '@/lib/flow';
import type { ILedgerTokenIssued } from '@/types/ledger';

/** Issue a producer token (purplemux ledger token issue). Own workspace only, like every mutation. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspaceMutation(req, res, workspaceId))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  const producer = (req.body as { producer?: unknown } | undefined)?.producer;
  if (!isLedgerProducer(producer)) {
    return res.status(400).json({
      error: `producer: saw ${show(producer)}, expected a name matching ${LEDGER_PRODUCER_PATTERN.source}`,
      code: 'ledger-token-invalid', field: 'producer',
    });
  }
  // The server's own events carry this name: a token under it could pre-claim their event ids.
  if (isReservedProducer(producer)) {
    return res.status(400).json({
      error: `producer: saw ${show(producer)}, expected a name other than the reserved ${LEDGER_SERVER_PRODUCER} or ${LEDGER_SERVER_PRODUCER}:*`,
      code: 'ledger-token-invalid', field: 'producer',
    });
  }
  const body: ILedgerTokenIssued = issueLedgerToken(workspaceId, producer, Date.now());
  return res.status(200).json(body);
};

export default handler;
