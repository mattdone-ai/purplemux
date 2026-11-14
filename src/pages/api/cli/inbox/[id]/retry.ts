import type { NextApiRequest, NextApiResponse } from 'next';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { ACTION_REASON_MAX, actionReason } from '@/lib/human-actions';
import { InboxError, mutateInbox, readInboxState, retryInState } from '@/lib/inbox-store';
import { noticeSenderWorkspace, readNotesState } from '@/lib/notes-store';
import { scrumMasterSnapshot, selectionStillHolds, type IScrumMasterSnapshot } from '@/lib/scrum-master-access';
import { resolveCliScope } from '@/lib/workspace-token';
import type { IInboxItem } from '@/types/inbox';

type TScope = NonNullable<ReturnType<typeof resolveCliScope>>;

class SelectionChanged extends Error {}

/**
 * Re-queue a `held` notice once, with a fresh refusal budget. The target
 * workspace's own token, the admin token, or the workspace that sent the note a
 * notice carries may: the sender already holds the authority that routed it, and
 * the note's paste-time preflight still decides whether it is typed. The Portfolio
 * Scrum Master's verified tab may too, for a target workspace in its selection,
 * with a reason, audited (ADR-0047, owner order).
 */
const mayRetry = async (scope: TScope, item: IInboxItem): Promise<boolean> => {
  if (scope.type === 'admin' || scope.workspaceId === item.targetWorkspaceId) return true;
  return item.kind === 'note' && noticeSenderWorkspace(await readNotesState(), item.id) === scope.workspaceId;
};

const notFound = (res: NextApiResponse, id: string) => res.status(404).json({
  error: `inbox item ${id} not found for this token (only the target workspace's token, the note's sending workspace, `
    + "the Portfolio Scrum Master's verified tab for a workspace in its selection, or the admin token may retry)",
  code: 'inbox-not-found',
});

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const scope = resolveCliScope(req, { response: res });
  if (!scope) return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  const id = req.query.id as string;

  const item = (await readInboxState()).items.find((i) => i.id === id);
  // Another workspace's item answers exactly like a missing one: its id leaks nothing.
  if (!item) return notFound(res, id);
  let scrumMaster: IScrumMasterSnapshot | null = null;
  if (!(await mayRetry(scope, item))) {
    scrumMaster = await scrumMasterSnapshot(scope, item.targetWorkspaceId);
    if (!scrumMaster) return notFound(res, id);
  }
  const reason = actionReason((req.body as { reason?: unknown } | undefined)?.reason);
  if (scrumMaster && reason === null) {
    return res.status(400).json({ error: `a Portfolio Scrum Master retry needs a reason (--reason TEXT, 1..${ACTION_REASON_MAX} characters, ADR-0047)`, code: 'reason-missing' });
  }
  try {
    const retried = await mutateInbox((state) => {
      // The selection the retry was authorized on must hold inside the lock too (ADR-0047 r2 #5).
      if (scrumMaster && !selectionStillHolds(scrumMaster, item.targetWorkspaceId)) throw new SelectionChanged();
      const result = retryInState(state, id, Date.now());
      return { state: result.state, value: result.item };
    });
    if (scrumMaster && scope.type === 'workspace') {
      await appendCoordinationAudit({
        event: 'inbox-retry',
        itemId: id,
        targetWorkspaceId: item.targetWorkspaceId,
        reason,
        by: { workspaceId: scope.workspaceId, tabId: scope.tabId ?? null, verified: true, role: 'portfolio-scrum-master' },
        selection: { actor: scrumMaster.actor, updatedAt: scrumMaster.updatedAt,
          managerWorkspaceId: scrumMaster.selection.managerWorkspaceId, managerTabId: scrumMaster.selection.managerTabId },
      });
    }
    return res.status(200).json({ item: retried });
  } catch (err) {
    if (err instanceof SelectionChanged) {
      return res.status(403).json({ error: 'the portfolio selection changed while the notice was retried; nothing was retried (ADR-0047)', code: 'selection-changed' });
    }
    if (err instanceof InboxError) {
      return res.status(err.code === 'inbox-not-found' ? 404 : 409).json({ error: err.message, code: err.code });
    }
    throw err;
  }
};

export default handler;
