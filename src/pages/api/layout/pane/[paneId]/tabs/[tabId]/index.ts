import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import { removeTabFromPane, restartTabSession, patchTab } from '@/lib/layout-store';
import { getActiveWorkspaceId } from '@/lib/workspace-store';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';
import { findTab } from '@/lib/cli-utils';
import { RemoteHostError } from '@/lib/remote-host';
import type { ITab } from '@/types/terminal';
import { remoteHostUnreachableBody } from '@/lib/cli-error';

const log = createLogger('layout');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  const wsId = (req.query.workspace as string) || await getActiveWorkspaceId();
  if (!wsId) {
    return res.status(400).json({ error: 'No workspace found' });
  }

  const paneId = req.query.paneId as string;
  const tabId = req.query.tabId as string;

  if (req.method === 'DELETE') {
    let found: boolean;
    try {
      found = await removeTabFromPane(wsId, paneId, tabId);
    } catch (err) {
      if (err instanceof RemoteHostError) return res.status(503).json(remoteHostUnreachableBody(err));
      throw err;
    }
    if (!found) {
      return res.status(404).json({ error: 'Tab not found' });
    }
    getStatusManager().removeTab(tabId);
    return res.status(204).end();
  }

  if (req.method === 'POST') {
    try {
      const { command } = req.body ?? {};
      const ok = await restartTabSession(wsId, paneId, tabId, command);
      if (!ok) {
        return res.status(404).json({ error: 'Tab not found' });
      }
      return res.status(200).json({ ok: true });
    } catch (err) {
      if (err instanceof RemoteHostError) return res.status(503).json(remoteHostUnreachableBody(err));
      log.error(`tab restart failed: ${err instanceof Error ? err.message : err}`);
      return res.status(500).json({ error: 'Failed to restart session' });
    }
  }

  if (req.method === 'PATCH') {
    const { name, panelType, title, cwd, lastCommand, webUrl, terminalRatio, terminalCollapsed } = req.body ?? {};

    if (
      name !== undefined ||
      panelType !== undefined ||
      title !== undefined ||
      cwd !== undefined ||
      lastCommand !== undefined ||
      webUrl !== undefined ||
      terminalRatio !== undefined ||
      terminalCollapsed !== undefined
    ) {
      const patch: Partial<Pick<ITab, 'name' | 'panelType' | 'title' | 'cwd' | 'lastCommand' | 'webUrl' | 'terminalRatio' | 'terminalCollapsed'>> = {};
      if (name !== undefined) {
        if (typeof name !== 'string') {
          return res.status(400).json({ error: 'name must be a string' });
        }
        patch.name = name.trim();
      }
      if (panelType !== undefined) {
        // A remote tab is a terminal in this release (ADR-0022 §12): an agent
        // launched there would post its hooks to the remote host's own server.
        if (panelType !== 'terminal' && (await findTab(wsId, tabId))?.tab.host) {
          return res.status(409).json({ error: 'only terminal tabs run on a remote host (ADR-0022)', code: 'remote-type-unsupported', panelType });
        }
        patch.panelType = panelType;
      }
      if (title !== undefined) patch.title = title;
      if (cwd !== undefined) patch.cwd = cwd;
      if (lastCommand !== undefined) patch.lastCommand = lastCommand;
      if (webUrl !== undefined) patch.webUrl = webUrl;
      if (terminalRatio !== undefined) {
        if (typeof terminalRatio !== 'number' || !Number.isFinite(terminalRatio)) {
          return res.status(400).json({ error: 'terminalRatio must be a number' });
        }
        patch.terminalRatio = Math.max(0, Math.min(100, terminalRatio));
      }
      if (terminalCollapsed !== undefined) {
        if (typeof terminalCollapsed !== 'boolean') {
          return res.status(400).json({ error: 'terminalCollapsed must be a boolean' });
        }
        patch.terminalCollapsed = terminalCollapsed;
      }

      const result = await patchTab(wsId, paneId, tabId, patch);
      if (!result) {
        return res.status(404).json({ error: 'Tab not found' });
      }
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'No fields to update' });
  }

  res.setHeader('Allow', 'POST, DELETE, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
