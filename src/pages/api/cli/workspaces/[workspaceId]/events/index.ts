import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { answerLedgerError, methodNotAllowed, queryValue } from '@/lib/ledger-http';
import { getLedgerStore } from '@/lib/ledger-store';
import { limitQuery, timeQuery } from '@/lib/tab-events-http';
import { getWorkspaceById } from '@/lib/workspace-store';
import type { ITabEventsResponse } from '@/types/tab-events';

/** `events show` (ADR-0035 §4): what a tab was sent, delivered or held, from the durable log. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    const now = Date.now();
    const since = timeQuery(req, 'since', now, now - 3_600_000);
    const tabId = queryValue(req, 'tab') ?? null;
    const limit = limitQuery(req, 500, 5_000);
    const events = getLedgerStore().tabEvents.list(workspaceId, { tabId, since, limit: limit + 1 });
    const body: ITabEventsResponse = {
      workspaceId, tabId, since, now, truncated: events.length > limit, events: events.slice(-limit),
    };
    return res.status(200).json(body);
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
