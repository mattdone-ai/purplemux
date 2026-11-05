import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { LedgerRefusal } from '@/lib/ledger';
import { answerLedgerError, methodNotAllowed, queryValue } from '@/lib/ledger-http';
import { getLedgerStore } from '@/lib/ledger-store';
import { timeQuery } from '@/lib/tab-events-http';
import { getWorkspaceById } from '@/lib/workspace-store';
import type { ITabWakesResponse } from '@/types/tab-events';

const BY = ['window', 'day'] as const;

/** Wakes and digests per seat (ADR-0035 §6): one delivery is one wake, a digest counts once. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    const now = Date.now();
    const until = timeQuery(req, 'until', now, now);
    const since = timeQuery(req, 'since', now, until - 86_400_000);
    if (since >= until) throw new LedgerRefusal('ledger-query-invalid', 'since', since, `a time before until (${until})`);
    const by = queryValue(req, 'by') ?? 'window';
    if (!(BY as readonly string[]).includes(by)) throw new LedgerRefusal('ledger-query-invalid', 'by', by, BY.join(' or '), BY);
    const table = getLedgerStore().tabEvents;
    const body: ITabWakesResponse = {
      workspaceId, since, until, by: by as ITabWakesResponse['by'], hasEvents: table.hasAny(workspaceId),
      rows: table.wakes(workspaceId, { since, until, byDay: by === 'day' }),
    };
    return res.status(200).json(body);
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
