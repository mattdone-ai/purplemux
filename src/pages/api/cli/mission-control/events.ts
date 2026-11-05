import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCaller } from '@/lib/caller';
import { FOREIGN_MUTATION_HINT } from '@/lib/cli-error';
import { isOwnWorkspace } from '@/lib/cli-utils';
import { MissionControlError } from '@/lib/mission-control-errors';
import { sendMissionError, setMissionHeaders } from '@/lib/mission-control-http';
import { applyMissionEventBatch } from '@/lib/mission-control-events';
import type { IMissionItemOpener } from '@/lib/mission-control-store';

export const config = {
  api: { bodyParser: { sizeLimit: '64kb' } },
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  setMissionHeaders(res);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : '';
    if (!workspaceId) throw new MissionControlError(400, 'invalid-request', 'workspaceId is required');
    const caller = await resolveCaller(req, res);
    if (!caller) throw new MissionControlError(401, 'unauthorized', 'CLI token required');
    const { scope } = caller;
    // Own workspace only: a portfolio grant never lets a tab write another workspace's MC events (ADR-0014).
    if (!isOwnWorkspace(scope, workspaceId)) {
      throw new MissionControlError(403, 'forbidden', `Mission Control writes require this workspace token. ${FOREIGN_MUTATION_HINT}`);
    }
    const body = req.body as { events?: unknown } | null;
    // Who opened an item: the server-resolved caller tab, never a payload claim (ADR-0023). Advisory only.
    const opener: IMissionItemOpener | null = !caller.admin && caller.tabId && caller.workspaceId === workspaceId
      && caller.identity !== 'none'
      ? { tabId: caller.tabId, identity: caller.identity }
      : null;
    return res.status(200).json(await applyMissionEventBatch(workspaceId, body?.events, opener));
  } catch (error) {
    sendMissionError(res, error);
  }
};

export default handler;
