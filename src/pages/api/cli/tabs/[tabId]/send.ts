import type { NextApiRequest, NextApiResponse } from 'next';
import { authorizeWorkspaceInput, findTab } from '@/lib/cli-utils';
import { getStatusManager } from '@/lib/status-manager';
import {
  awaitSendReadiness,
  MAX_SEND_READY_TIMEOUT_MS,
  resolveSendWaitMs,
  resolveTabCliState,
} from '@/lib/tab-send';
import { capturePaneContent, hasSessionOrUnreachable, isContentPendingInComposer, isPaneShowingPendingLine, pressEnter } from '@/lib/tmux';
import { readComposerScreen } from '@/lib/composer-readiness';
import { confirmSubmission, type ISubmitConfirmRequest, type TSubmitResult } from '@/lib/send-confirmation';
import { deliverPrompt } from '@/lib/agent-prompt-delivery';
import { remoteTimeoutMs } from '@/lib/remote-timeouts';
import { withAgentDispatchThen } from '@/lib/agent-dispatch-policy';
import { TAB_NOT_FOUND_BODY, remoteHostUnreachableBody, targetChangedBody } from '@/lib/cli-error';
import { RemoteHostError } from '@/lib/remote-host';
import { classifyWake, mayHoldTabSend } from '@/lib/wake-class';
import { isAgentPanelType } from '@/lib/agent-panel-types';
import { getLedgerStore } from '@/lib/ledger-store';
import { appendDelivered } from '@/lib/tab-event-router';
import { createLogger } from '@/lib/logger';
import { startupPromptFix, startupPromptLabel } from '@/lib/startup-prompt';
import { parseRawFlag, rawRefusalText, terminalInputRefusal } from '@/lib/terminal-command-line';

const log = createLogger('tab-send');

/** `submit` is null for a tab with no turn to prove (a terminal or browser tab). */
interface IDelivered {
  submit: TSubmitResult | null;
}

/** What the locked part hands the proof wait: the text is typed, and the baseline was read before it. */
interface ITyped {
  sessionName: string;
  request: ISubmitConfirmRequest | null;
}

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
 *
 * An agent tab's text then needs proof that it was submitted: a turn-starting
 * `prompt-submit` hook after the typing (vel-RETRO-R3, `send-confirmation.ts`).
 * Without it the answer names `notSubmitted` and the CLI exits 1.
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

  const { content, waitMs, raw: rawFlag } = (req.body ?? {}) as { content?: string; waitMs?: unknown; raw?: unknown };
  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }
  const raw = parseRawFlag(rawFlag);
  if (raw === null) return res.status(400).json({ error: rawRefusalText(rawFlag), code: 'invalid-request' });
  const timeoutMs = resolveSendWaitMs(waitMs);
  if (timeoutMs === null) {
    return res
      .status(400)
      .json({ error: `waitMs must be an integer between 0 and ${MAX_SEND_READY_TIMEOUT_MS}` });
  }

  // A copy (this tab on the cc list, not a `->` recipient) or a "no reply needed" message waits for an agent
  // tab's next digest (ADR-0035, architect ruling 09-C1); a shell or browser tab has no digest, so it gets the
  // message at once as before.
  const target = mayHoldTabSend(content) ? await findTab(workspaceId, tabId) : null;
  if (target && isAgentPanelType(target.tab.panelType) && classifyWake('tab-send', { text: content, recipientName: target.tab.name }) === 'digest') {
    // A dead session never reaches a digest: the sender hears it now, as for any send (review r2, F6).
    if (!(await hasSessionOrUnreachable(target.tab.sessionName))) {
      return res.status(409).json({ error: 'agent-not-ready', code: 'session-not-running', tabId, detail: 'session-not-running' });
    }
    const routed = await getStatusManager().routeTabEvent({ workspaceId, tabId, kind: 'tab-send', text: content, class: 'digest' });
    return res.status(200).json({
      status: routed.delivered ? 'sent' : routed.duplicate ? 'logged' : 'queued',
      submitted: routed.delivered,
      wakeClass: routed.class,
      duplicate: routed.duplicate,
    });
  }

  const readiness = await awaitSendReadiness(
    {
      findTarget: async (wsId, id) => {
        const found = await findTab(wsId, id);
        if (!found) return null;
        const live = getStatusManager().getAllForClient()[id];
        return {
          sessionName: found.tab.sessionName,
          panelType: found.tab.panelType,
          cliState: resolveTabCliState(found.tab, live),
          waitingAtPrompt: getStatusManager().isWaitingAtPrompt(id),
          startupPrompt: live?.startupPrompt?.kind ?? null,
          ...(found.tab.host ? { host: found.tab.host } : {}),
        };
      },
      hasSession: hasSessionOrUnreachable,
      readScreen: async (target) => readComposerScreen(target.panelType, await capturePaneContent(target.sessionName, { escapes: true })),
      remoteTimeoutMs,
    },
    // `composer-ready`, not `live-session`: this is the unattended dispatch
    // path, where a paste that beats the TUI's boot is silently swallowed. The
    // cookie-authed route a person types into does NOT wait — see TSendGate.
    { workspaceId, tabId, timeoutMs, gate: 'composer-ready' },
  );

  if (!readiness.ok) {
    if (readiness.reason === 'tab-not-found') return res.status(404).json(TAB_NOT_FOUND_BODY);
    if (readiness.reason === 'startup-prompt') {
      // At once, with nothing typed: a paste would answer the dialog (D14).
      return res.status(409).json({
        error: 'agent-not-ready',
        code: 'startup-prompt',
        tabId,
        cliState: readiness.cliState,
        startupPrompt: readiness.startupPrompt,
        startupPromptLabel: startupPromptLabel(readiness.startupPrompt),
        detail: startupPromptFix(readiness.startupPrompt),
      });
    }
    return res.status(409).json({
      error: 'agent-not-ready',
      code: readiness.reason,
      tabId,
      cliState: readiness.cliState,
      detail: readiness.reason,
      ...(readiness.reason === 'readiness-timeout' ? { waitedMs: readiness.waitedMs, ...(readiness.screen ? { screen: readiness.screen } : {}) } : {}),
    });
  }

  const current = await findTab(workspaceId, tabId);
  if (!current || current.tab.sessionName !== readiness.target.sessionName) {
    return res.status(409).json(targetChangedBody(tabId));
  }
  // The typing runs inside the dispatch lock; the proof wait runs after it, inside the tab's send gate only
  // (CONFIRM r2): a Codex hook applies inside the same lock, so a wait under it would lock out its own proof.
  const delivered = await withAgentDispatchThen(workspaceId, current.tab, async (checkPolicy): Promise<ITyped | null> => {
    const latest = await findTab(workspaceId, tabId);
    if (!latest || latest.tab.sessionName !== readiness.target.sessionName) {
      res.status(409).json(targetChangedBody(tabId));
      return null;
    }
    if (!await hasSessionOrUnreachable(latest.tab.sessionName)) {
      res.status(409).json({ error: 'agent-not-ready', code: 'session-not-running', tabId, detail: 'session-not-running' });
      return null;
    }
    // A shell runs each line as a command (D30): multi-line text into a terminal tab needs raw: true.
    const refusal = terminalInputRefusal(latest.tab, content, raw);
    if (refusal) {
      res.status(400).json(refusal);
      return null;
    }
    const policy = await checkPolicy({ consumeBootstrapForTarget: true });
    if (!policy.ok) {
      res.status(409).json(policy);
      return null;
    }
    const { sessionName, panelType, host } = latest.tab;
    if (!isAgentPanelType(panelType)) {
      await deliverPrompt(sessionName, content);
      return { sessionName, request: null };
    }
    // Inside the lock and the send gate, which every dispatch takes first (the inbox and automated dispatchers,
    // steer, restart and the cookie route): no other dispatch types into this composer, or starts its turn, until
    // this send has its proof or its deadline.
    const baseline = getStatusManager().getSubmitEvidence(tabId);
    // Read before the typing (review r1 F4): text the send cannot prove is never typed.
    if (!baseline) {
      res.status(409).json({ error: 'submit-unconfirmed', code: 'submit-unconfirmed', tabId, typed: false, detail: 'no-submit-evidence' });
      return null;
    }
    const remoteBudgetMs = host ? await remoteTimeoutMs(host) : undefined;
    await deliverPrompt(sessionName, content);
    return {
      sessionName,
      request: {
        panelType,
        remote: !!host,
        content,
        baseline,
        screenEmptyAtGate: readiness.screenEmpty,
        ...(remoteBudgetMs !== undefined ? { remoteTimeoutMs: remoteBudgetMs } : {}),
      },
    };
  }, async (typed): Promise<IDelivered | null> => {
    if (!typed) return null;
    if (!typed.request) return { submit: null };
    const { sessionName } = typed;
    const submit = await confirmSubmission(
      {
        readEvidence: () => getStatusManager().getSubmitEvidence(tabId),
        capture: () => capturePaneContent(sessionName, { escapes: true }),
        isPendingLine: isPaneShowingPendingLine,
        pressEnter: () => pressEnter(sessionName),
      },
      typed.request,
    );
    return { submit };
  });
  if (!delivered) return;
  try {
    appendDelivered(getLedgerStore().tabEvents, { workspaceId, tabId, kind: 'tab-send', text: content, class: 'urgent' }, Date.now());
  } catch (err) {
    log.warn(`tab send to ${tabId} not recorded: ${err instanceof Error ? err.message : err}`);
  }

  const { submit } = delivered;
  if (submit) {
    if (!submit.submitted || submit.resubmitted) {
      log.warn({ tabId, ...submit }, submit.submitted ? 'tab send: submitted after one more Enter' : `tab send: ${submit.notSubmitted}`);
    }
    // HTTP 200 either way: the text was typed (ADR-0004, additive). The CLI exits 1 on `notSubmitted`.
    return res.status(200).json({
      status: 'sent',
      submitted: submit.submitted,
      cliState: readiness.target.cliState,
      confirmation: submit.submitted ? submit.confirmation : null,
      resubmitted: submit.resubmitted,
      ...(submit.submitted ? {} : { notSubmitted: submit.notSubmitted }),
    });
  }

  // A terminal tab takes no turn, so there is nothing to prove: `submitted` reads the screen as before, best-effort.
  const pending = await isContentPendingInComposer(readiness.target.sessionName, content).catch(() => false);
  return res.status(200).json({
    status: 'sent',
    submitted: !pending,
    cliState: readiness.target.cliState,
    confirmation: null,
    resubmitted: false,
  });
};

export default handler;
