import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { DAY_MS, LEDGER_ITEM_TYPES, LEDGER_RETENTION_DAYS, LEDGER_WAITS_BY, LedgerRefusal, isWaitsBy } from '@/lib/ledger';
import { answerLedgerError, methodNotAllowed, parseTime, queryValue } from '@/lib/ledger-http';
import { getLedgerStore } from '@/lib/ledger-store';
import { getWorkspaceById } from '@/lib/workspace-store';
import type { ILedgerWaitsResponse, TLedgerItemType } from '@/types/ledger';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    const now = Date.now();
    const untilText = queryValue(req, 'until');
    const sinceText = queryValue(req, 'since');
    const until = untilText === undefined ? now : parseTime(untilText, 'until');
    const since = sinceText === undefined ? until - 7 * DAY_MS : parseTime(sinceText, 'since');
    if (since >= until) throw new LedgerRefusal('ledger-query-invalid', 'since', sinceText ?? since, `a time before until ${until}`);
    // Intervals are kept 92 days: an older window would read the deleted waits as no waiting.
    const retained = now - LEDGER_RETENTION_DAYS * DAY_MS;
    if (since < retained) {
      throw new LedgerRefusal('ledger-query-invalid', 'since', sinceText ?? since,
        `a time no older than the 92-day retention limit ${retained}; older waits are deleted`);
    }
    const by = queryValue(req, 'by') ?? 'reason';
    if (!isWaitsBy(by)) throw new LedgerRefusal('ledger-query-invalid', 'by', by, `one of ${LEDGER_WAITS_BY.join(', ')}`, LEDGER_WAITS_BY);
    const type = queryValue(req, 'type');
    if (type !== undefined && !(LEDGER_ITEM_TYPES as readonly string[]).includes(type)) {
      throw new LedgerRefusal('ledger-query-invalid', 'type', type, `one of ${LEDGER_ITEM_TYPES.join(', ')}`, LEDGER_ITEM_TYPES);
    }
    const view = getLedgerStore().waits(workspaceId, { since, until, by, type: type as TLedgerItemType | undefined }, now);
    const body: ILedgerWaitsResponse = { workspaceId, since, until, now, by, type: (type as TLedgerItemType | undefined) ?? null, ...view };
    return res.status(200).json(body);
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
