import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { getStatusManager } from '@/lib/status-manager';
import {
  awaitSendReadiness,
  MAX_SEND_READY_TIMEOUT_MS,
  resolveSendWaitMs,
  resolveTabCliState,
} from '@/lib/tab-send';
import { hasSessionOrUnreachable, isContentPendingInComposer } from '@/lib/tmux';
import { deliverPrompt } from '@/lib/agent-prompt-delivery';
import { withAgentDispatchLock } from '@/lib/agent-dispatch-policy';
import { TAB_NOT_FOUND_BODY, remoteHostUnreachableBody, targetChangedBody } from '@/lib/cli-error';
import { RemoteHostError } from '@/lib/remote-host';

/**
 * Deliver a prompt to a tab.
 *
 * The send holds until the target can accept a turn, because the alternative
 * cost fifty minutes of an epic: three workers were sent their briefs while
 * their agent TUIs were still booting, the pastes landed in input boxes whose
 * Enter was swallowed, and every call answered `submitted: true` over agents
 * that never started. A tab that never starts never changes state, so nothing
 * downstream surfaced it either.
 *
 * `waitMs: 0` opts out and answers with whatever the tab is doing right now.
 * On timeout nothing is pasted at all — half a brief sitting in a composer for
 * a stray Enter to submit is worse than no brief.
 */
/** A remote tab's host that did not answer is retryable, never "the session is dead" (ADR-0022). */
const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    return await send(req, res);
  } catch (err) {
    if (err instanceof RemoteHostError && !res.headersSent) return res.status(503).json(remoteHostUnreachableBody(err));
    throw err;
  }
};

const send = async (req: NextApiRequest, res: NextApiResponse) => {
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

  const { content, waitMs } = (req.body ?? {}) as { content?: string; waitMs?: unknown };
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }
  const timeoutMs = resolveSendWaitMs(waitMs);
  if (timeoutMs === null) {
    return res
      .status(400)
      .json({ error: `waitMs must be an integer between 0 and ${MAX_SEND_READY_TIMEOUT_MS}` });
  }

  const readiness = await awaitSendReadiness(
    {
      findTarget: async (wsId, id) => {
        const found = await findTab(wsId, id);
        if (!found) return null;
        return {
          sessionName: found.tab.sessionName,
          panelType: found.tab.panelType,
          cliState: resolveTabCliState(found.tab, getStatusManager().getAllForClient()[id]),
          waitingAtPrompt: getStatusManager().isWaitingAtPrompt(id),
        };
      },
      hasSession: hasSessionOrUnreachable,
    },
    // `composer-ready`, not `live-session`: this is the unattended dispatch
    // path, where a paste that beats the TUI's boot is silently swallowed. The
    // cookie-authed route a person types into does NOT wait — see TSendGate.
    { workspaceId, tabId, timeoutMs, gate: 'composer-ready' },
  );

  if (!readiness.ok) {
    if (readiness.reason === 'tab-not-found') return res.status(404).json(TAB_NOT_FOUND_BODY);
    return res.status(409).json({
      error: 'agent-not-ready',
      code: readiness.reason,
      tabId,
      cliState: readiness.cliState,
      detail: readiness.reason,
      ...(readiness.reason === 'readiness-timeout' ? { waitedMs: readiness.waitedMs } : {}),
    });
  }

  const current = await findTab(workspaceId, tabId);
  if (!current || current.tab.sessionName !== readiness.target.sessionName) {
    return res.status(409).json(targetChangedBody(tabId));
  }
  const delivered = await withAgentDispatchLock(workspaceId, current.tab, async (checkPolicy) => {
    const latest = await findTab(workspaceId, tabId);
    if (!latest || latest.tab.sessionName !== readiness.target.sessionName) {
      res.status(409).json(targetChangedBody(tabId));
      return false;
    }
    if (!await hasSessionOrUnreachable(latest.tab.sessionName)) {
      res.status(409).json({ error: 'agent-not-ready', code: 'session-not-running', tabId, detail: 'session-not-running' });
      return false;
    }
    const policy = await checkPolicy({ consumeBootstrapForTarget: true });
    if (!policy.ok) {
      res.status(409).json(policy);
      return false;
    }
    await deliverPrompt(latest.tab.sessionName, content);
    return true;
  });
  if (!delivered) return;

  // Report delivery, not just dispatch. A paste that lands while the agent is
  // mid-turn can have its Enter swallowed and sit in the composer until
  // somebody else's keystroke submits it, so a caller that reads only
  // `status` cannot tell a queued message from a stranded one. `pending` is
  // best-effort and never fatal: the send DID happen either way.
  const pending = await isContentPendingInComposer(readiness.target.sessionName, content).catch(() => false);
  return res.status(200).json({
    status: 'sent',
    submitted: !pending,
    cliState: readiness.target.cliState,
  });
};

export default handler;
