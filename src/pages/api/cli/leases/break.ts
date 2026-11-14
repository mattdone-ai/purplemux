import type { NextApiRequest, NextApiResponse } from 'next';
import { breakLease } from '@/lib/lease-store';
import { bodyOf, holderOf, leaseAuthority, requireCaller, requireMethod, sendLeaseError, viewOf } from '@/lib/lease-http';
import { scrumMasterSnapshot, selectionStillHolds } from '@/lib/scrum-master-access';
import type { ILeaseHolder, ILeaseScrumMasterBreaker } from '@/types/lease';

/**
 * The admin token, or the Portfolio Scrum Master's verified tab (ADR-0047, owner order), with a reason; audited, the
 * Scrum Master with its role and selection. Cooperative, not a security boundary (C-312 class).
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  try {
    const body = bodyOf(req);
    const holder = holderOf(caller);
    const snapshot = caller.admin ? null : await scrumMasterSnapshot(caller.scope);
    const breaker: ILeaseHolder | ILeaseScrumMasterBreaker = snapshot
      ? { ...holder, role: 'portfolio-scrum-master', selection: { actor: snapshot.actor, updatedAt: snapshot.updatedAt,
        managerWorkspaceId: snapshot.selection.managerWorkspaceId, managerTabId: snapshot.selection.managerTabId } }
      : holder;
    const recheck = () => (snapshot && !selectionStillHolds(snapshot)
      ? 'the portfolio selection changed while the lease was broken; nothing was broken (ADR-0047)' : null);
    const broken = await breakLease(body.name, body.reason, breaker, leaseAuthority, recheck);
    return res.status(200).json({ broken: await viewOf(broken) });
  } catch (err) {
    return sendLeaseError(res, err);
  }
};

export default handler;
