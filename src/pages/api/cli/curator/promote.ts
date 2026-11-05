import type { NextApiRequest, NextApiResponse } from 'next';
import { sendCuratorError, taskOf } from '@/lib/curator-http';
import { demoteCuratorTask, promoteCuratorTask } from '@/lib/curator-service';
import { requireCaller, requireMethod } from '@/lib/lease-http';

/**
 * The only way a task reaches `routing` (AC 5), and back to `shadow` with `{ demote: true }` (ADR-0038, "what proves
 * it wrong"). The admin token only, like every fleet-wide routing key (ADR-0019).
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!requireMethod(req, res, 'POST')) return;
  const caller = await requireCaller(req, res);
  if (!caller) return;
  if (!caller.admin) return res.status(403).json({ error: 'curator promote and demote take the admin token', code: 'forbidden' });
  const task = taskOf(req, res);
  if (!task) return;
  try {
    if ((req.body as { demote?: unknown } | null)?.demote === true) {
      return res.status(200).json({ task, state: 'shadow', wasRouting: await demoteCuratorTask(task) });
    }
    const verdict = await promoteCuratorTask(task, Date.now());
    if (!verdict.ok) {
      return res.status(409).json({ error: `${task} stays in shadow: ${verdict.refusals.join('; ')}`, code: 'curator-gate-refused', ...verdict });
    }
    return res.status(200).json({ task, state: 'routing', ...verdict });
  } catch (err) {
    return sendCuratorError(res, err);
  }
};

export default handler;
