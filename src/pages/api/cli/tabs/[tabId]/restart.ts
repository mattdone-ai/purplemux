import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceMutation } from '@/lib/cli-utils';
import { resolveCaller } from '@/lib/caller';
import { parseRestartRequest, restartTab } from '@/lib/tab-restart';

/**
 * `purplemux tab restart` (ADR-0028): a fresh agent process under the same tab
 * id. Own workspace, or the selected Scrum Master in a workspace it manages
 * (ADR-0046); the admin token and every other workspace get `forbidden`
 * (ADR-0021). The audit `by` names the caller's own workspace and tab.
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const parsed = parseRestartRequest(req.query, req.body);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'invalid-request' });
  const scope = await authorizeWorkspaceMutation(req, res, parsed.workspaceId);
  if (!scope) return;
  const caller = await resolveCaller(req);
  const result = await restartTab({
    workspaceId: parsed.workspaceId,
    tabId: parsed.tabId,
    clear: parsed.clear,
    interrupt: parsed.interrupt,
    by: { kind: 'agent', workspaceId: scope.workspaceId, tabId: caller?.tabId ?? null, identity: caller?.identity ?? 'none' },
  });
  return res.status(result.status).json(result.body);
};

export default handler;
