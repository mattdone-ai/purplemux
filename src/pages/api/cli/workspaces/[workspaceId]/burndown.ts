import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeOwnWorkspaceWrite } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';
import { MAX_BURNDOWN_BYTES, parseBurndownSnapshot } from '@/lib/burndown';
import { BurndownStoreError, readBurndown, writeBurndown } from '@/lib/burndown-store';

// Above the stored ceiling so a long history still arrives and is capped, not refused.
export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeOwnWorkspaceWrite(req, res, workspaceId, 'The burndown'))) return;
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  if (req.method === 'GET') {
    try {
      return res.status(200).json({ burndown: await readBurndown(workspaceId) });
    } catch (error) {
      if (error instanceof BurndownStoreError) return res.status(500).json({ error: error.message, code: 'burndown-unreadable' });
      throw error;
    }
  }

  if (req.method === 'POST') {
    const receivedAt = Date.now();
    const parsed = parseBurndownSnapshot(req.body, receivedAt);
    if (!parsed.ok) return res.status(400).json({ error: `Invalid burndown: ${parsed.error}`, code: 'invalid-burndown' });
    const bytes = Buffer.byteLength(JSON.stringify(parsed.snapshot));
    if (bytes > MAX_BURNDOWN_BYTES) {
      return res.status(413).json({
        error: `Burndown too large: saw ${bytes} bytes after capping history, expected at most ${MAX_BURNDOWN_BYTES}`,
        code: 'burndown-too-large',
      });
    }
    await writeBurndown({ workspaceId, receivedAt, snapshot: parsed.snapshot });
    return res.status(200).json({
      ok: true, workspaceId, receivedAt, generatedAt: parsed.snapshot.generated_at,
      epics: parsed.snapshot.epics.length, historyRows: parsed.snapshot.history.length,
      historyDropped: parsed.droppedHistory, bytes,
    });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
