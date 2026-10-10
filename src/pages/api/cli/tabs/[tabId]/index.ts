import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { closeTab, setTabReportsTo, updateTabAgentLaunchConfig } from '@/lib/layout-store';
import { getProviderByPanelType } from '@/lib/providers';
import { isValidModelName } from '@/lib/claude-command-shared';
import { isValidReasoningForPanelType, reasoningErrorForPanelType } from '@/lib/agent-effort';
import type { IAgentLaunchConfig } from '@/types/terminal';
import { withCodexTargetLock } from '@/lib/providers/codex/launch-lifecycle';
import { TAB_NOT_FOUND_BODY } from '@/lib/cli-error';
import { RemoteHostError } from '@/lib/remote-host';
import { checkReportsTo } from '@/lib/reports-to';


const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;

  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required' });
  }
  const authorized = req.method === 'PATCH'
    ? await authorizeWorkspaceInput(req, res, workspaceId)
    : await authorizeWorkspace(req, res, workspaceId);
  if (!authorized) return;

  if (req.method === 'GET') {
    const found = await findTab(workspaceId, tabId);
    if (!found) return res.status(404).json(TAB_NOT_FOUND_BODY);
    const provider = getProviderByPanelType(found.tab.panelType);
    return res.status(200).json({
      tabId: found.tab.id,
      workspaceId: found.workspaceId,
      paneId: found.paneId,
      name: found.tab.name,
      sessionName: found.tab.sessionName,
      panelType: found.tab.panelType,
      agentProviderId: provider?.id ?? null,
      agentSessionId: provider?.readSessionId(found.tab) ?? null,
      agentLaunchConfig: found.tab.agentLaunchConfig,
      reportsTo: found.tab.reportsTo ?? null,
    });
  }

  if (req.method === 'DELETE') {
    const found = await findTab(workspaceId, tabId);
    if (!found) return res.status(404).json(TAB_NOT_FOUND_BODY);
    // The tab's processes are reaped before its session dies (ADR-0016);
    // keepProcesses=1 signals only the pane group, as before story 16.
    const keepProcesses = req.query.keepProcesses === '1' || req.query.keepProcesses === 'true';
    let closed: Awaited<ReturnType<typeof closeTab>>;
    try {
      closed = await closeTab(workspaceId, found.paneId, tabId, { keepProcesses });
    } catch (err) {
      if (err instanceof RemoteHostError) return res.status(503).json({ error: err.message, code: 'remote-host-unreachable', host: err.host });
      throw err;
    }
    const { ok, reap } = closed;
    return res.status(200).json({ ok, ...(reap ? { reaper: reap.reaper, envMarker: reap.envMarker, killed: reap.killed, survivors: reap.survivors } : {}) });
  }

  if (req.method === 'PATCH' && req.body && typeof req.body === 'object' && 'reportsTo' in req.body) {
    const body = req.body as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== 'reportsTo')) {
      return res.status(400).json({ error: 'reportsTo is patched on its own' });
    }
    const found = await findTab(workspaceId, tabId);
    if (!found) return res.status(404).json(TAB_NOT_FOUND_BODY);
    const reportsTo = body.reportsTo === null ? null : body.reportsTo;
    if (reportsTo !== null) {
      const refused = await checkReportsTo(workspaceId, reportsTo, tabId);
      if (refused) return res.status(400).json(refused);
    }
    if (!(await setTabReportsTo(workspaceId, tabId, reportsTo as string | null))) {
      return res.status(404).json(TAB_NOT_FOUND_BODY);
    }
    return res.status(200).json({ tabId, workspaceId, reportsTo });
  }

  if (req.method === 'PATCH') {
    return withCodexTargetLock(workspaceId, tabId, async () => {
      const found = await findTab(workspaceId, tabId);
      if (!found) return res.status(404).json(TAB_NOT_FOUND_BODY);
      if (!getProviderByPanelType(found.tab.panelType)) {
        return res.status(400).json({ error: 'Tab is not an agent panel' });
      }
      const value = req.body?.agentLaunchConfig as unknown;
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        return res.status(400).json({ error: 'agentLaunchConfig must be an object or null' });
      }
      const config = value as Record<string, unknown> | null;
      if (config) {
        const unknownKeys = Object.keys(config).filter((key) => key !== 'model' && key !== 'effort');
        if (unknownKeys.length > 0) {
          return res.status(400).json({ error: 'agentLaunchConfig supports only model and effort' });
        }
        if (config.model !== undefined && !isValidModelName(config.model)) {
          return res.status(400).json({ error: 'Invalid model' });
        }
        if (config.effort !== undefined && !isValidReasoningForPanelType(found.tab.panelType!, config.effort)) {
          return res.status(400).json({ error: reasoningErrorForPanelType(found.tab.panelType!) });
        }
      }
      const nextConfig: IAgentLaunchConfig | null = config && (config.model !== undefined || config.effort !== undefined)
        ? {
            ...(config.model !== undefined ? { model: config.model as string } : {}),
            ...(config.effort !== undefined ? { effort: config.effort as string } : {}),
          }
        : null;
      const tab = await updateTabAgentLaunchConfig(workspaceId, found.paneId, tabId, nextConfig);
      if (!tab) return res.status(404).json(TAB_NOT_FOUND_BODY);
      return res.status(200).json({
        tabId,
        workspaceId,
        agentLaunchConfig: tab.agentLaunchConfig ?? null,
        appliesTo: 'future-launches',
        runningProcessChanged: false,
      });
    });
  }

  res.setHeader('Allow', 'GET, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
