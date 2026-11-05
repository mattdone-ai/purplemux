import type { NextApiRequest, NextApiResponse } from 'next';
import { readMessageHistory, addMessageHistory, deleteMessageHistory } from '@/lib/message-history-store';
import { curatorOnOwnerMessage } from '@/lib/curator-service';
import { createLogger } from '@/lib/logger';

const log = createLogger('message-history');

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    const wsId = req.query.wsId as string | undefined;
    if (!wsId) return res.status(400).json({ error: 'wsId is required' });

    const entries = await readMessageHistory(wsId);
    return res.status(200).json({ entries });
  }

  if (req.method === 'POST') {
    const { wsId, message } = req.body as { wsId?: string; message?: string };
    if (!wsId) return res.status(400).json({ error: 'wsId is required' });
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

    try {
      const entry = await addMessageHistory(wsId, message);
      curatorOnOwnerMessage(wsId, entry.id, message, Date.parse(entry.sentAt) || Date.now());
      return res.status(201).json({ entry });
    } catch (e) {
      log.error({ err: e }, 'write failed');
      return res.status(500).json({ error: 'Failed to save' });
    }
  }

  if (req.method === 'DELETE') {
    const { wsId, id } = req.body as { wsId?: string; id?: string };
    if (!wsId) return res.status(400).json({ error: 'wsId is required' });
    if (!id) return res.status(400).json({ error: 'id is required' });

    try {
      const success = await deleteMessageHistory(wsId, id);
      return res.status(200).json({ success });
    } catch (e) {
      log.error({ err: e }, 'delete failed');
      return res.status(500).json({ error: 'Failed to save' });
    }
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
