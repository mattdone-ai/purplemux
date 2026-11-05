import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace } from '@/lib/cli-utils';
import { computeEffects, EFFECTS_DEFAULT_DAYS, effectWindowStart } from '@/lib/effects';
import { DAY_MS, LEDGER_TAB_EVENTS_RETENTION_DAYS, LedgerRefusal } from '@/lib/ledger';
import { answerLedgerError, methodNotAllowed, queryValue } from '@/lib/ledger-http';
import { getLedgerStore } from '@/lib/ledger-store';
import { readLayoutFile, resolveLayoutFile } from '@/lib/layout-store';
import { collectAllTabs } from '@/lib/layout-tree';
import { getStatusManager } from '@/lib/status-manager';
import { getWorkspaceById } from '@/lib/workspace-store';

const daysQuery = (req: NextApiRequest): number => {
  const text = queryValue(req, 'days');
  const days = text === undefined ? EFFECTS_DEFAULT_DAYS : Number(text);
  if (!Number.isSafeInteger(days) || days < 1 || days > LEDGER_TAB_EVENTS_RETENTION_DAYS) {
    throw new LedgerRefusal('ledger-query-invalid', 'days', text, `an integer from 1 to ${LEDGER_TAB_EVENTS_RETENTION_DAYS} (tab events are kept ${LEDGER_TAB_EVENTS_RETENTION_DAYS} days)`);
  }
  return days;
};

/** Effect counts per component (story 15, ADR-0035 §7): delivered, and followed by an acting tool call in the next turn. */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;
  if (!(await getWorkspaceById(workspaceId))) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });
  try {
    const until = Date.now();
    const requestedSince = until - daysQuery(req) * DAY_MS;
    const store = getLedgerStore();
    const measuredSince = store.tabTurns.measuredSince();
    const since = effectWindowStart(requestedSince, until, measuredSince);
    const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
    // An unreadable layout cannot tell a closed tab from an idle one: both stay out of the judged count either way.
    const tabs = layout ? new Set(collectAllTabs(layout.root).map((tab) => tab.id)) : null;
    return res.status(200).json(computeEffects({
      workspaceId, requestedSince, until, measuredSince,
      fired: since === null ? [] : store.tabEvents.recordedCounts(workspaceId, since, until),
      deliveries: since === null ? [] : store.tabEvents.deliveries(workspaceId, since, until),
      turns: since === null ? [] : store.tabTurns.endedSince(workspaceId, since),
      // The turns still running are this server's: a paste whose turn has not ended is pending, not unanswered.
      openTurns: getStatusManager().openTurns(workspaceId),
      tabExists: (tabId) => tabs?.has(tabId) ?? true,
    }));
  } catch (error) {
    return answerLedgerError(res, error);
  }
};

export default handler;
