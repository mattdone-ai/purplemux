import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspace, findTab } from '@/lib/cli-utils';
import { capturePaneContentAnsi, hasSessionOrUnreachable } from '@/lib/tmux';
import { renderPaneResult, type TResultMode } from '@/lib/pane-suggestions';
import { TAB_NOT_FOUND_BODY, remoteHostUnreachableBody } from '@/lib/cli-error';
import { RemoteHostError } from '@/lib/remote-host';

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

  let alive: boolean;
  try {
    alive = await hasSessionOrUnreachable(found.tab.sessionName);
  } catch (err) {
    if (err instanceof RemoteHostError) return res.status(503).json(remoteHostUnreachableBody(err));
    throw err;
  }
  if (!alive) return res.status(409).json({ error: 'Tab session is not running', code: 'session-not-running' });

  // Dim composer text is a suggestion the agent shows, not text anyone typed (L7).
  const mode: TResultMode = req.query.raw === '1' ? 'raw' : req.query.suggestions === '0' ? 'no-suggestions' : 'default';
  const captured = await capturePaneContentAnsi(found.tab.sessionName);
  if (captured === null) return res.status(200).json({ content: null, suggestion: null });
  const { content, suggestion } = renderPaneResult(captured, found.tab.panelType, mode);
  return res.status(200).json({ content, suggestion });
};

export default handler;
