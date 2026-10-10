import { createLogger } from '@/lib/logger';
import { getStatusManager } from '@/lib/status-manager';
import { translateClaudeHookEvent } from '@/lib/providers/claude/hook-handler';
import { parseClaudeToolActivity } from '@/lib/providers/claude/tool-activity';
import { bindRemoteTranscript, isValidRemoteTranscriptPath, syncRemoteTranscript } from '@/lib/remote-transcript';
import { sessionHostOf } from '@/lib/session-host';
import { resolveTabToken } from '@/lib/tab-token';

/**
 * Claude hook events from a remote tab (ADR-0022, slice b). The remote hook
 * posts Claude's raw hook JSON; the session id and transcript path in it bind
 * the tab's local transcript copy, which is brought up to date before the event
 * is applied, so a stop is classified on the final transcript as for a local tab.
 */

const log = createLogger('hooks');

export interface IRemoteHookDelivery {
  query: Partial<Record<string, string | string[]>>;
  body: unknown;
  replayedAt?: number;
  occurredAt?: number;
}

const one = (query: IRemoteHookDelivery['query'], key: string): string | null => {
  const value = query[key];
  return typeof value === 'string' && value ? value : null;
};

const record = (body: unknown): Record<string, unknown> =>
  body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

/**
 * A remote delivery carries the posting tab's own token, never the global one:
 * accepted only for that tab's session, and only while the session is remote.
 */
export const authorizeRemoteHook = async (token: unknown, session: unknown): Promise<boolean> => {
  if (typeof token !== 'string' || typeof session !== 'string' || !session) return false;
  const resolved = resolveTabToken(token);
  if (!resolved || resolved.record.sessionName !== session) return false;
  return !!(await sessionHostOf(session));
};

export const handleRemoteClaudeHook = async (delivery: IRemoteHookDelivery): Promise<{ status: number; error?: string }> => {
  const session = one(delivery.query, 'session');
  const event = one(delivery.query, 'event');
  if (!session || !event) return { status: 400, error: 'missing session or event' };
  const host = await sessionHostOf(session);
  if (!host) return { status: 404, error: 'not a remote session' };
  const payload = record(delivery.body);
  const at = delivery.replayedAt ?? delivery.occurredAt;
  const statusManager = getStatusManager();

  const { session_id: sessionId, transcript_path: transcriptPath } = payload;
  if (isValidRemoteTranscriptPath(transcriptPath, sessionId)) {
    try {
      const jsonlPath = await bindRemoteTranscript({ session, host, sessionId: sessionId as string, remotePath: transcriptPath });
      await syncRemoteTranscript(session);
      statusManager.applyAgentHookMeta('claude', session, { sessionId: sessionId as string, jsonlPath }, at);
    } catch (err) {
      log.warn({ session, host, err: err instanceof Error ? err.message : String(err) }, 'remote transcript bind failed; applying the event without it');
    }
  } else if (transcriptPath !== undefined) {
    log.warn({ session, host }, 'remote hook named a transcript that is not a Claude transcript path; ignored');
  }

  if (one(delivery.query, 'kind') === 'tool') {
    const activity = parseClaudeToolActivity(payload);
    if (activity) statusManager.handleToolActivity('claude', session, activity, delivery.replayedAt);
    return { status: 204 };
  }

  const notificationType = typeof payload.notification_type === 'string' && payload.notification_type ? payload.notification_type : undefined;
  const source = typeof payload.source === 'string' && /^[a-z]+$/.test(payload.source) ? payload.source : undefined;
  const workEvent = translateClaudeHookEvent(event, notificationType, source);
  if (!workEvent) {
    log.debug({ event, session }, 'unknown remote claude hook event, ignoring');
    return { status: 204 };
  }
  statusManager.handleProviderEvent('claude', session, workEvent, at);
  return { status: 204 };
};
