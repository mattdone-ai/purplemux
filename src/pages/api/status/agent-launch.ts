import { findTab } from '@/lib/cli-utils';
import { recordOrchestrationLaunch } from '@/lib/orchestration-activity';
import { withOrchestrationMappingRead } from '@/lib/orchestration-mapping-lock';
import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getStatusManager } from '@/lib/status-manager';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { tabId, resetAgentSession, panelType } = req.body as { tabId?: string; resetAgentSession?: boolean; panelType?: string };
  if (!tabId) {
    return res.status(400).json({ error: 'tabId is required' });
  }

  if (panelType !== 'claude-code' && panelType !== 'grok-cli') {
    return res.status(400).json({ error: 'An explicit non-Codex agent type is required' });
  }
  const manager = getStatusManager();
  const workspaceId = manager.getAllForClient()[tabId]?.workspaceId;
  if (!workspaceId) return res.status(404).json({ error: 'Tab not found' });
  const launched = await withOrchestrationMappingRead(workspaceId, async () => {
    const found = await findTab(workspaceId, tabId);
    if (!found) throw new Error('Launch target disappeared');
    // A remote tab is a terminal in this release (ADR-0022 §12).
    if (found.tab.host) return false;
    await recordOrchestrationLaunch(workspaceId, tabId, found.tab.sessionName, panelType);
    manager.markAgentLaunch(tabId, { resetAgentSession: resetAgentSession === true });
    return true;
  });
  if (!launched) return res.status(409).json({ error: 'only terminal tabs run on a remote host (ADR-0022)', code: 'remote-type-unsupported', panelType });
  return res.status(204).end();
};

export default handler;
