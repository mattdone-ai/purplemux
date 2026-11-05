import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { steerSession } from '@/lib/agent-steer';
import { withAgentDispatchLock } from '@/lib/agent-dispatch-policy';
import { TAB_NOT_FOUND_BODY, targetChangedBody } from '@/lib/cli-error';
import { decideSteerInterrupt, resolveSteerCaller } from '@/lib/steer-policy';
import { parseRawFlag, terminalInputRefusal } from '@/lib/terminal-command-line';
import { appendCoordinationAudit } from '@/lib/coordination-audit';

/**
 * Correct a worker mid-turn. Unlike `send`, which waits for the agent to accept a turn, a steer can
 * interrupt the current turn first, so the correction is read at once.
 *
 * The interrupt default depends on the caller (story 14, `@/lib/steer-policy`): an agent tab does
 * not interrupt unless it sends `interrupt: true` with a reason, and that interrupt writes one
 * `steer-interrupt` audit line; any other caller interrupts by default, as before. A terminal
 * target refuses multi-line text unless `raw: true` (D30, `@/lib/terminal-command-line`).
 */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const tabId = req.query.tabId as string;
  const workspaceId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
  if (!workspaceId) {
    return res.status(400).json({ error: 'workspaceId is required' });
  }
  if (!(await authorizeWorkspaceInput(req, res, workspaceId))) return;

  const body = (req.body ?? {}) as { content?: string; interrupt?: unknown; reason?: unknown; raw?: unknown };
  const { content } = body;
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }
  const raw = parseRawFlag(body.raw);
  if (raw === null) return res.status(400).json({ error: 'raw must be a boolean', code: 'invalid-request' });

  const steerCaller = await resolveSteerCaller(req, res);
  const decision = decideSteerInterrupt(body, steerCaller.kind);
  if (!decision.ok) return res.status(400).json({ error: decision.error, code: decision.code });

  const found = await findTab(workspaceId, tabId);
  if (!found) return res.status(404).json(TAB_NOT_FOUND_BODY);

  return withAgentDispatchLock(workspaceId, found.tab, async (checkPolicy) => {
    const current = await findTab(workspaceId, tabId);
    if (!current || current.tab.sessionName !== found.tab.sessionName) {
      return res.status(409).json(targetChangedBody(tabId));
    }
    // Read on the tab as it is under the lock: an agent switch can change the panel type in place.
    const refusal = terminalInputRefusal(current.tab, content, raw);
    if (refusal) return res.status(400).json(refusal);
    let policy = await checkPolicy();
    if (!policy.ok) return res.status(409).json(policy);

    const result = await steerSession(current.tab.sessionName, content, {
      interrupt: decision.interrupt,
      beforeDeliver: async () => {
        policy = await checkPolicy();
        return policy.ok;
      },
    });
    if (decision.explicit && decision.interrupt) {
      const { caller } = steerCaller;
      await appendCoordinationAudit({
        event: 'steer-interrupt',
        workspaceId,
        tabId,
        targetName: current.tab.name || null,
        caller: {
          kind: steerCaller.kind,
          workspaceId: caller?.workspaceId ?? null,
          tabId: caller?.tabId ?? null,
          tabName: caller?.tabName ?? null,
          panelType: steerCaller.panelType,
          identity: caller?.identity ?? 'none',
          verified: caller?.verified ?? false,
        },
        reason: decision.reason,
        interrupted: result.interrupted,
        ok: result.ok && policy.ok,
        ...(result.reason ? { failure: result.reason } : !policy.ok ? { failure: 'policy-refused' } : {}),
      });
    }
    if (!policy.ok) return res.status(409).json(policy);
    if (!result.ok) {
      if (result.reason === 'session not found') {
        return res.status(409).json({ error: result.reason, code: 'session-not-running' });
      }
      return res.status(500).json({ error: result.reason ?? 'steer failed' });
    }
    return res.status(200).json({ status: 'steered', interrupted: result.interrupted });
  });
};

export default handler;
