import { authorizeHumanMutation } from '@/lib/human-mutation';
import type { NextApiRequest, NextApiResponse } from 'next';
import {
  deleteWorkspace,
  renameWorkspace,
  setWorkspaceGroup,
  updateWorkspaceOrchestration,
} from '@/lib/workspace-store';
import { applyDirectoriesPatch } from '@/lib/workspace-patch';
import { parseOrchestrationPatch } from '@/lib/orchestration';
import { parseOrchestrationPrecondition } from '@/lib/orchestration-contract';
import { sendOrchestrationError } from '@/lib/orchestration-http';
import { RemoteHostError } from '@/lib/remote-host';
import { remoteHostUnreachableBody } from '@/lib/cli-error';

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method ?? '') && !(await authorizeHumanMutation(req, res))) return;
  const workspaceId = req.query.workspaceId as string;

  if (req.method === 'DELETE') {
    let found: boolean;
    try {
      found = await deleteWorkspace(workspaceId);
    } catch (err) {
      if (err instanceof RemoteHostError) return res.status(503).json(remoteHostUnreachableBody(err));
      throw err;
    }
    if (!found) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    return res.status(204).end();
  }

  if (req.method === 'PATCH') {
    const { name, groupId, orchestration, directories } = req.body ?? {};

    if (orchestration !== undefined) {
      if (name !== undefined || groupId !== undefined || directories !== undefined) return res.status(400).json({ error: 'Change orchestration separately from other workspace fields' });
      try {
        const patch = parseOrchestrationPatch(orchestration);
        if (!patch) {
          return res.status(400).json({ error: 'Invalid orchestration settings' });
        }
        const ws = await updateWorkspaceOrchestration(workspaceId, patch, { ...parseOrchestrationPrecondition(req.body), actor: { kind: 'human' } });
        if (!ws) return res.status(404).json({ error: 'Workspace not found' });
        return res.status(200).json(ws);
      } catch (error) { return sendOrchestrationError(res, error); }
    }

    if (directories !== undefined) {
      const result = await applyDirectoriesPatch(workspaceId, directories);
      if (result.status !== 200) {
        return res.status(result.status).json({ error: result.error });
      }
      if (name === undefined && groupId === undefined && orchestration === undefined) {
        return res.status(200).json(result.workspace);
      }
    }

    if (groupId !== undefined) {
      const next = groupId === null ? null : typeof groupId === 'string' ? groupId : undefined;
      if (next === undefined) {
        return res.status(400).json({ error: 'Invalid groupId' });
      }
      const ok = await setWorkspaceGroup(workspaceId, next);
      if (!ok) return res.status(404).json({ error: 'Workspace not found' });
      if (name === undefined) return res.status(200).json({ ok: true });
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name field required' });
      }
      const ws = await renameWorkspace(workspaceId, name.trim());
      if (!ws) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      return res.status(200).json(ws);
    }

    return res.status(400).json({ error: 'name, groupId, orchestration, or directories required' });
  }

  res.setHeader('Allow', 'DELETE, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
