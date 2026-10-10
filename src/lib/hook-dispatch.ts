import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';
import { translateClaudeHookEvent } from '@/lib/providers/claude/hook-handler';
import { parseClaudeToolActivity } from '@/lib/providers/claude/tool-activity';
import { processCodexHookPayload, shouldEmitCodexHookEvent } from '@/lib/providers/codex/hook-handler';
import { codexHookEvents } from '@/lib/providers/codex/hook-events';
import { isCodexSubagentHook } from '@/lib/providers/codex/subagent-hook';
import { processGrokHookPayload, shouldEmitGrokHookEvent } from '@/lib/providers/grok/hook-handler';
import { grokHookEvent, parseGrokToolActivity } from '@/lib/providers/grok/hook-payload';
import { grokHookEvents } from '@/lib/providers/grok/hook-events';
import { handleRemoteClaudeHook } from '@/lib/remote-hook';
import {
  withReplayedCodexHookGeneration,
  withValidatedCodexHookGeneration,
  withValidatedLegacyCodexHook,
} from '@/lib/providers/codex/launch-lifecycle';

const log = createLogger('hooks');

/**
 * One hook event, as the route receives it or as the spool replays it. A live
 * POST has no `replayedAt`; a replayed one carries the time the hook fired, so
 * an event older than the tab's latest is kept in history only (ADR-0020).
 */
export interface IHookDelivery {
  query: Partial<Record<string, string | string[]>>;
  body: unknown;
  replayedAt?: number;
  occurredAt?: number;
}

export interface IHookOutcome {
  status: number;
  error?: string;
}

const NO_CONTENT: IHookOutcome = { status: 204 };

const queryString = (query: IHookDelivery['query'], key: string): string | null => {
  const value = query[key];
  return typeof value === 'string' ? value : null;
};

const bodyRecord = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};

const handleClaudeToolHook = ({ query, body, replayedAt }: IHookDelivery): IHookOutcome => {
  const session = queryString(query, 'session');
  if (!session) return NO_CONTENT;
  const activity = parseClaudeToolActivity(body);
  if (!activity) {
    log.debug({ session }, 'tool hook payload not recognised, ignoring');
    return NO_CONTENT;
  }
  getStatusManager().handleToolActivity('claude', session, activity, replayedAt);
  return NO_CONTENT;
};

const handleClaudeHook = ({ body, replayedAt, occurredAt }: IHookDelivery): IHookOutcome => {
  const { event, session, notificationType, source } = bodyRecord(body);
  if (typeof event === 'string' && event !== 'poll' && typeof session === 'string' && session) {
    const type = typeof notificationType === 'string' && notificationType ? notificationType : undefined;
    log.debug({ event, session, notificationType: type, source, replayedAt }, `received ${event}${type ? `(${type})` : ''}${typeof source === 'string' ? `(source=${source})` : ''}`);
    const workEvent = translateClaudeHookEvent(event, type, source);
    if (workEvent) {
      getStatusManager().handleProviderEvent('claude', session, workEvent, replayedAt ?? occurredAt);
    } else {
      log.debug({ event, session, notificationType: type }, 'unknown claude hook event, ignoring');
    }
  } else if (replayedAt === undefined) {
    log.debug({ body }, 'poll trigger');
    getStatusManager().poll().catch((err) => {
      log.error({ err }, 'Poll trigger failed');
    });
  }
  return NO_CONTENT;
};

const handleCodexHook = async ({ query, body, replayedAt, occurredAt }: IHookDelivery): Promise<IHookOutcome> => {
  const payload = bodyRecord(body);
  const tmuxSession = queryString(query, 'tmuxSession');
  if (!tmuxSession) {
    log.warn({ event: payload.hook_event_name }, 'codex hook missing tmuxSession');
    return { status: 400, error: 'missing tmuxSession' };
  }
  const generation = queryString(query, 'generation') || null;
  log.debug(
    { tmuxSession, event: payload.hook_event_name, source: payload.source, replayedAt },
    `codex ${payload.hook_event_name ?? 'unknown'}`,
  );
  const statusManager = getStatusManager();
  // A native subagent's hook shares its parent's pane and generation: it must never re-key the
  // parent tab's session or transcript, nor move its work state (tab-QizeO4, 2026-09-29). Its
  // PermissionRequest is dropped too (architect ruling 2026-09-29, option C): every way of showing
  // it on the tab could leave the tab stuck. What that leaves, stated exactly (ruling A of the
  // send-guard consult): only the inbox dispatcher reads the pane before a paste; `tab send` and the
  // watchdog nudges do not, as before this change. The orchestrator keeper's heartbeat used to stay
  // quiet while a subagent's prompt held the tab in needs-input and no longer does. None of this can
  // happen while Codex tabs launch with --yolo (dangerouslySkipPermissions, true on this host; the
  // Codex orchestrators record approval_policy "never"). A dialog-aware send guard is its own story.
  if (await isCodexSubagentHook(payload, statusManager.agentSessionIdForTmuxSession(tmuxSession))) {
    log.debug(
      { tmuxSession, event: payload.hook_event_name, sessionId: payload.session_id, replayedAt },
      'codex subagent hook ignored: it does not describe the tab',
    );
    return NO_CONTENT;
  }
  const { result, translation } = processCodexHookPayload(payload);
  const applyHook = () => {
    const applied = translation.meta
      ? statusManager.applyAgentHookMeta('codex', tmuxSession, translation.meta, replayedAt ?? occurredAt)
      : null;
    if (!applied) return { applied: null };
    if (translation.sessionInfo && !applied.stale) {
      codexHookEvents.emit('session-info', tmuxSession, translation.sessionInfo);
      if (translation.clearSession) codexHookEvents.emit('session-clear', tmuxSession);
    }
    if (translation.event && shouldEmitCodexHookEvent(payload, applied.cliState)) {
      statusManager.handleProviderEvent('codex', tmuxSession, translation.event, replayedAt ?? occurredAt);
    }
    return { applied };
  };
  if (replayedAt !== undefined) {
    // A replay is checked for attribution only: the live process proof, the
    // tab's lock and the legacy model check are live conditions (ADR-0020).
    // A legacy hook carries no generation to attribute it by, so it is skipped.
    const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'codex-hook';
    const replayed = generation
      ? await withReplayedCodexHookGeneration(tmuxSession, generation, applyHook,
        (tabId) => statusManager.codexLaunchLifecycle(tabId))
      : { ok: false as const, reason: 'legacy-unattributable' };
    if (!replayed.ok) statusManager.recordSkippedReplay(tmuxSession, eventName, replayedAt, replayed.reason);
    return NO_CONTENT;
  }
  const guarded = generation
    ? await withValidatedCodexHookGeneration(tmuxSession, generation, applyHook)
    : await withValidatedLegacyCodexHook(tmuxSession, {
        sessionId: translation.meta?.sessionId ?? null,
        jsonlPath: translation.meta?.jsonlPath,
      }, applyHook);
  if (!guarded.ok || !guarded.value.applied) {
    log.debug({
      tmuxSession,
      event: payload.hook_event_name,
      reason: guarded.ok ? 'unknown-session' : guarded.reason,
    }, 'codex hook skipped');
    return NO_CONTENT;
  }
  if (!result.ok) {
    log.debug({ tmuxSession, event: payload.hook_event_name, reason: result.reason }, 'codex hook skipped');
  }
  return NO_CONTENT;
};

const handleGrokHook = ({ query, body, replayedAt, occurredAt }: IHookDelivery): IHookOutcome => {
  const payload = bodyRecord(body);
  const tmuxSession = queryString(query, 'tmuxSession');
  if (!tmuxSession) {
    log.warn({ event: payload.hookEventName }, 'grok hook missing tmuxSession');
    return { status: 400, error: 'missing tmuxSession' };
  }
  const event = grokHookEvent(payload.hookEventName);
  log.debug(
    { tmuxSession, event: payload.hookEventName, source: payload.source, replayedAt },
    `grok ${payload.hookEventName ?? 'unknown'}`,
  );

  const statusManager = getStatusManager();
  const { result, translation } = processGrokHookPayload(payload);
  const applied = translation.meta
    ? statusManager.applyAgentHookMeta('grok', tmuxSession, translation.meta, replayedAt ?? occurredAt)
    : null;
  if (!applied) {
    log.debug({ tmuxSession, event: payload.hookEventName, reason: 'unknown-session' }, 'grok hook skipped');
    return NO_CONTENT;
  }

  if (translation.sessionInfo && !applied.stale) {
    grokHookEvents.emit('session-info', tmuxSession, translation.sessionInfo);
  }

  // Tool activity feeds the signal engine, not the work-state machine, so it
  // runs alongside the (absent) state event rather than instead of it.
  if (event === 'post_tool_use') {
    const activity = parseGrokToolActivity(payload);
    if (activity) statusManager.handleToolActivity('grok', tmuxSession, activity, replayedAt);
    // A tool that completed cannot still be waiting on a permission prompt.
    // Recovers from a permission_prompt hook whose payload omitted
    // permissionMode (always-approve still auto-resolves wait_ms: 0).
    if (applied.cliState === 'needs-input') {
      statusManager.handleProviderEvent('grok', tmuxSession, { kind: 'prompt-submit' }, replayedAt);
    }
  }

  if (!result.ok) {
    log.debug({ tmuxSession, event: payload.hookEventName, reason: result.reason }, 'grok hook skipped');
  }
  if (translation.event && shouldEmitGrokHookEvent(payload, applied.cliState)) {
    statusManager.handleProviderEvent('grok', tmuxSession, translation.event, replayedAt ?? occurredAt);
  }
  return NO_CONTENT;
};

/**
 * The hook route's handler without the HTTP layer: the route calls it for a
 * live POST, the spool drain for a replayed one (ADR-0020), so both apply an
 * event the same way.
 */
export const dispatchHook = async (delivery: IHookDelivery): Promise<IHookOutcome> => {
  const occurredAt = Number(queryString(delivery.query, 'occurredAt'));
  if (delivery.replayedAt === undefined && Number.isSafeInteger(occurredAt) && occurredAt > 0 && occurredAt <= Date.now()) {
    delivery = { ...delivery, occurredAt };
  }
  if (queryString(delivery.query, 'remote') === 'claude') return handleRemoteClaudeHook(delivery);
  const provider = queryString(delivery.query, 'provider') ?? 'claude';
  if (provider === 'codex') return handleCodexHook(delivery);
  if (provider === 'grok') return handleGrokHook(delivery);
  if (queryString(delivery.query, 'kind') === 'tool') return handleClaudeToolHook(delivery);
  return handleClaudeHook(delivery);
};
