import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeOwnWorkspaceWrite } from '@/lib/cli-utils';
import { getWorkspaceStrict, updateWorkspaceOrchestration } from '@/lib/workspace-store';
import { getStatusManager } from '@/lib/status-manager';
import { resolveCaller } from '@/lib/caller';
import { parseOrchestrationPrecondition } from '@/lib/orchestration-contract';
import { sendOrchestrationError } from '@/lib/orchestration-http';
import { parseOrchestrationPatch } from '@/lib/orchestration';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const workspaceId = req.query.workspaceId as string;
  // A drive grant or the Scrum Master selection never changes a workspace's settings (ADR-0014, ADR-0046).
  if (!(await authorizeOwnWorkspaceWrite(req, res, workspaceId, 'The orchestration setting'))) return;
  try {
    const ws = await getWorkspaceStrict(workspaceId);

    if (req.method === 'GET') {
      return res.status(200).json({
        orchestration: ws.orchestration ?? { enabled: false, orchestratorTabId: null },
        nudges: getStatusManager().getOrchestrationNudges(workspaceId),
      });
    }

    if (req.method === 'PATCH') {
      const patch = parseOrchestrationPatch(req.body);
      if (!patch) return res.status(400).json({ error: 'Invalid orchestration settings' });
      const condition = parseOrchestrationPrecondition(req.body);
      const caller = await resolveCaller(req, res);
      if (!caller || caller.admin || caller.workspaceId !== workspaceId) return res.status(403).json({ code: 'forbidden', error: 'Own workspace required' });
      const updated = await updateWorkspaceOrchestration(workspaceId, patch, { ...condition, actor: { kind: 'workspace', workspaceId, tabId: caller.tabId, verified: caller.verified } });
      if (!updated) return res.status(404).json({ error: 'Workspace not found' });
      return res.status(200).json({ orchestration: updated.orchestration });
    }

    res.setHeader('Allow', 'GET, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) { return sendOrchestrationError(res, error); }
};

export default handler;
