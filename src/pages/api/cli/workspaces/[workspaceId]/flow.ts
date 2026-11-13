import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeOwnWorkspaceWrite } from '@/lib/cli-utils';
import { getWorkspaceById } from '@/lib/workspace-store';
import { MAX_FLOW_BYTES, parseFlowHistoryMode, parseFlowSnapshot } from '@/lib/flow';
import { FlowStoreError, publishFlow } from '@/lib/flow-store';
import { readFlowView } from '@/lib/flow-view';
import type { IFlowPublishResponse, IFlowReadResponse } from '@/types/flow';

// Above the snapshot ceiling, so an oversized snapshot is answered with flow-too-large and its size.
export const config = { api: { bodyParser: { sizeLimit: '2mb' } } };

const storeFailure = (res: NextApiResponse, error: FlowStoreError) =>
  res.status(500).json({ error: error.message, code: error.code });

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  res.setHeader('Cache-Control', 'no-store');
  const workspaceId = req.query.workspaceId as string;
  if (!(await authorizeOwnWorkspaceWrite(req, res, workspaceId, 'The flow report'))) return;
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) return res.status(404).json({ error: 'Workspace not found', code: 'not-found' });

  if (req.method === 'GET') {
    const mode = parseFlowHistoryMode(req.query.history, 'all');
    if (!mode) {
      return res.status(400).json({ error: `history: saw ${JSON.stringify(req.query.history)}, expected all, window or none`, code: 'invalid-request' });
    }
    try {
      const body: IFlowReadResponse = await readFlowView(workspaceId, mode, Date.now());
      return res.status(200).json(body);
    } catch (error) {
      if (error instanceof FlowStoreError) return storeFailure(res, error);
      throw error;
    }
  }

  if (req.method === 'POST') {
    const receivedAt = Date.now();
    const parsed = parseFlowSnapshot(req.body, receivedAt);
    if (!parsed.ok) return res.status(400).json({ error: `Invalid flow: ${parsed.error}`, code: 'flow-invalid' });
    const snapshotBytes = Buffer.byteLength(JSON.stringify(parsed.snapshot));
    if (snapshotBytes > MAX_FLOW_BYTES) {
      return res.status(413).json({
        error: `Flow too large: saw ${snapshotBytes} bytes, expected at most ${MAX_FLOW_BYTES}`,
        code: 'flow-too-large',
      });
    }
    try {
      const { record, historyReset, bytes } = await publishFlow(workspaceId, parsed.snapshot, receivedAt);
      const body: IFlowPublishResponse = {
        ok: true, workspaceId, receivedAt, generatedAt: record.snapshot.generatedAt,
        historyRows: record.history.length, historyReset, bytes,
      };
      return res.status(200).json(body);
    } catch (error) {
      if (error instanceof FlowStoreError) return storeFailure(res, error);
      throw error;
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
