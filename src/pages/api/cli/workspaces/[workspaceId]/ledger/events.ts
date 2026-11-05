import type { NextApiRequest, NextApiResponse } from 'next';
import { MAX_LEDGER_BYTES, SERVER_OWNED_ITEM_TYPES, parseLedgerBatch } from '@/lib/ledger';
import { answerLedgerError, methodNotAllowed } from '@/lib/ledger-http';
import { getLedgerStore } from '@/lib/ledger-store';
import { LEDGER_SCOPE, resolveLedgerToken } from '@/lib/ledger-token';
import { getWorkspaceById } from '@/lib/workspace-store';
import { resolveCliScope } from '@/lib/workspace-token';
import type { ILedgerAppendResult } from '@/types/ledger';

// Above the 1 MiB batch ceiling, so an oversized batch is answered with ledger-too-large and its size.
export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const workspaceId = req.query.workspaceId as string;
  const header = req.headers['x-pmux-token'];
  const producer = resolveLedgerToken(typeof header === 'string' ? header : undefined);
  if (!producer) {
    if (resolveCliScope(req)) {
      return res.status(403).json({
        error: `This route takes a producer token with the scope ${LEDGER_SCOPE} (purplemux ledger token issue -w WS --producer NAME)`,
        code: 'forbidden',
      });
    }
    return res.status(401).json({ error: 'Unauthorized', code: 'unauthorized' });
  }
  if (producer.workspaceId !== workspaceId) {
    return res.status(403).json({ error: `This ${LEDGER_SCOPE} token emits for workspace ${producer.workspaceId} only`, code: 'forbidden' });
  }
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  const bytes = Buffer.byteLength(JSON.stringify(req.body ?? null));
  if (bytes > MAX_LEDGER_BYTES) {
    return res.status(413).json({ error: `Batch too large: saw ${bytes} bytes, expected at most ${MAX_LEDGER_BYTES}`, code: 'ledger-too-large' });
  }
  const receivedAt = Date.now();
  try {
    const events = parseLedgerBatch(req.body, receivedAt);
    const owned = events.findIndex((event) => SERVER_OWNED_ITEM_TYPES.includes(event.item_type));
    if (owned !== -1) {
      return res.status(403).json({
        error: `events[${owned}].item_type: ${events[owned].item_type} items are written by the server only (${SERVER_OWNED_ITEM_TYPES.join(', ')})`,
        code: 'ledger-type-reserved', field: `events[${owned}].item_type`,
      });
    }
    const body: ILedgerAppendResult = getLedgerStore().append(workspaceId, producer.producer, events, receivedAt);
    return res.status(200).json(body);
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
