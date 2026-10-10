import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, findTab } from '@/lib/cli-utils';
import { hasSession, getPaneCurrentCommand } from '@/lib/tmux';
import { getProviderByPanelType } from '@/lib/providers';
import { getLivenessManager } from '@/lib/liveness-manager';
import { getCodexModelStatus } from '@/lib/providers/codex/model-observation';
import { TAB_NOT_FOUND_BODY } from '@/lib/cli-error';
import { tabIdentityOf } from '@/lib/tab-token';
import { getStatusManager } from '@/lib/status-manager';
import { resolveTabCliState } from '@/lib/tab-send';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required' });
  }
  if (!(await authorizeWorkspace(req, res, workspaceId))) return;

  const found = await findTab(workspaceId, tabId);
  if (!found) return res.status(404).json(TAB_NOT_FOUND_BODY);

  const provider = getProviderByPanelType(found.tab.panelType);
  // The live StatusManager entry, as `tab send` reads it; the layout copy lags (L8).
  const live = getStatusManager().getAllForClient()[tabId];
  const agentSessionId = live?.agentSessionId ?? provider?.readSessionId(found.tab) ?? null;
  const alive = await hasSession(found.tab.sessionName);
  const modelStatus = found.tab.panelType === 'codex-cli'
    ? await getCodexModelStatus(found.tab, alive ? {} : { runtimeAlive: false })
    : null;
  // Registered liveness watch, so idle-done and idle-holding-dead-work are
  // distinguishable from the status read alone.
  const { probes, backgroundJobs } = await getLivenessManager().statusForTab(tabId);
  // How the watchdog classified the last stop (story 37): a READY nudge is explained by the status alone.
  const turnEnd = live?.turnEnd ?? null;
  // The remote host that runs the tab (ADR-0022); absent for a local tab.
  const host = found.tab.host ? { host: found.tab.host } : {};
  if (!alive) {
    return res.status(200).json({
      tabId,
      workspaceId,
      ...host,
      alive: false,
      agentProviderId: provider?.id ?? null,
      agentSessionId,
      claudeSessionId: agentSessionId,
      modelStatus,
      probes,
      backgroundJobs,
      turnEnd,
      identity: tabIdentityOf(workspaceId, tabId),
    });
  }

  const command = await getPaneCurrentCommand(found.tab.sessionName);
  return res.status(200).json({
    tabId,
    workspaceId,
    ...host,
    alive: true,
    command,
    cliState: resolveTabCliState(found.tab, live),
    agentProviderId: provider?.id ?? null,
    agentSessionId,
    // Response key kept as `claudeSessionId` for back-compat with external CLI consumers.
    claudeSessionId: agentSessionId,
    modelStatus,
    probes,
    backgroundJobs,
    turnEnd,
    identity: tabIdentityOf(workspaceId, tabId),
  });
};

export default handler;
