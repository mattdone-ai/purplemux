import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { LEDGER_ITEM_TYPES, LedgerRefusal } from '@/lib/ledger';
import { answerLedgerError, methodNotAllowed, queryValue } from '@/lib/ledger-http';
import { getLedgerStore } from '@/lib/ledger-store';
import { getWorkspaceById } from '@/lib/workspace-store';
import type { ILedgerItemsResponse, TLedgerItemType } from '@/types/ledger';

const OPEN_VALUES: Readonly<Record<string, boolean>> = { 1: true, true: true, 0: false, false: false };

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    const open = queryValue(req, 'open');
    if (open !== undefined && !Object.hasOwn(OPEN_VALUES, open)) {
      throw new LedgerRefusal('ledger-query-invalid', 'open', open, '1, 0, true or false');
    }
    const type = queryValue(req, 'type');
    if (type !== undefined && !(LEDGER_ITEM_TYPES as readonly string[]).includes(type)) {
      throw new LedgerRefusal('ledger-query-invalid', 'type', type, `one of ${LEDGER_ITEM_TYPES.join(', ')}`, LEDGER_ITEM_TYPES);
    }
    const limitText = queryValue(req, 'limit');
    const limit = limitText === undefined ? 500 : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) {
      throw new LedgerRefusal('ledger-query-invalid', 'limit', limitText, 'an integer from 1 to 2000');
    }
    const now = Date.now();
    const found = getLedgerStore().items(workspaceId, {
      open: open === undefined ? false : OPEN_VALUES[open], type: type as TLedgerItemType | undefined, holder: queryValue(req, 'holder'), limit,
    }, now);
    const body: ILedgerItemsResponse = { workspaceId, now, ...found };
    return res.status(200).json(body);
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
