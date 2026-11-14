import { z } from 'zod';
import type { IInboxItem, THumanRetryRefusal } from '@/types/inbox';

// The human coordination actions (ADR-0029 §6-§8; story 06 consults Q1 and Q2). No Node import:
// the web panel validates with these, and the server reads the same bounds and retry predicate. They are measured in the
// server's units — code points after trim for a subject or a reason, UTF-8 bytes for a body. The
// server stays the judge: these only gate the submit button and name the field to fix.

export const NOTE_SUBJECT_MAX = 120;
export const NOTE_BODY_MAX_BYTES = 16 * 1024;
export const BREAK_REASON_MAX = 500;

export const codePoints = (text: string): number => [...text].length;

/** The most a Portfolio Scrum Master action's reason may hold (ADR-0047). */
export const ACTION_REASON_MAX = 500;

/**
 * A reason as every Portfolio Scrum Master action counts it (ADR-0047, r2 #3): trimmed, then 1..500 code points.
 * The trimmed text, or null when it is not a string or falls outside that range.
 */
export const actionReason = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  const length = codePoints(text);
  return length >= 1 && length <= ACTION_REASON_MAX ? text : null;
};
export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

export const ownerNoteSchema = z.object({
  to: z.enum(['workspace', 'epic']),
  target: z.string().trim().min(1, 'Choose where the note goes'),
  subject: z.string()
    .refine((s) => s.trim().length > 0, 'A subject is required')
    .refine((s) => codePoints(s.trim()) <= NOTE_SUBJECT_MAX, `At most ${NOTE_SUBJECT_MAX} characters`),
  body: z.string()
    .refine((s) => s.trim().length > 0, 'A body is required')
    .refine((s) => utf8Bytes(s) <= NOTE_BODY_MAX_BYTES, 'At most 16 KiB'),
});

export type TOwnerNoteValues = z.infer<typeof ownerNoteSchema>;

/** The `POST /api/mission-control/notes` body: exactly one target. */
export const ownerNoteRequest = (values: TOwnerNoteValues) => ({
  ...(values.to === 'epic' ? { toEpic: values.target.trim() } : { toWorkspace: values.target.trim() }),
  subject: values.subject,
  body: values.body,
});

export const leaseBreakSchema = z.object({
  reason: z.string().trim()
    .min(1, 'A reason is required')
    .refine((s) => codePoints(s) <= BREAK_REASON_MAX, `At most ${BREAK_REASON_MAX} characters`),
});

/** The first message per field, for the form's error lines. */
export const fieldErrors = (error: z.ZodError): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (!Object.hasOwn(out, key)) out[key] = issue.message;
  }
  return out;
};

const HUMAN_RETRY_REFUSALS: ReadonlySet<string> = new Set<THumanRetryRefusal>(['stranded-in-composer', 'transport-uncertain', 'target-not-agent']);

/**
 * Why a human may not retry this hold (ADR-0029 §7, consult Q1), or null; keyed on the leading token
 * of `heldReason`. A stranded or transport-uncertain paste may already sit in the composer or be
 * submitted, so a retry can type it twice; a target that is not an agent never accepts it.
 * Refusal-budget and 24 h holds are retryable. `src/lib/inbox-store.ts` exports it to the server.
 */
export const humanRetryRefusal = (item: Pick<IInboxItem, 'heldReason'>): THumanRetryRefusal | null => {
  const token = (item.heldReason ?? '').split(':', 1)[0];
  return HUMAN_RETRY_REFUSALS.has(token) ? token as THumanRetryRefusal : null;
};

/** The codes the three routes and their auth answer with (`architecture.md` §4.4). */
const ACTION_REFUSAL_LABEL: Record<string, string> = {
  unauthorized: 'Sign in again',
  forbidden: 'Refused',
  'invalid-request': 'Not accepted',
  'note-invalid': 'Note not accepted',
  'note-too-large': 'Note too large',
  'note-target-missing': 'No such target',
  'note-cap': 'Too many open notes',
  'inbox-not-found': 'Notice not found',
  'inbox-not-held': 'Notice no longer held',
  'lease-not-found': 'Lease not found',
};

const RETRY_REFUSAL_SENTENCE: Record<string, string> = {
  'stranded-in-composer': 'Not retried: the notice may already sit in the composer, so a retry could type it twice',
  'transport-uncertain': 'Not retried: the paste failed part-way and may have reached the composer, so a retry could type it twice',
  'target-not-agent': 'Not retried: the target tab is not an agent tab, so the notice can never be delivered',
};

export type THumanActionOutcome<T> =
  | { kind: 'done'; body: T }
  | { kind: 'refused'; code: string; text: string }
  | { kind: 'failed'; text: string };

/**
 * A route's answer as the toast reads it. Only a JSON body with a contract `code` is the server's
 * refusal, shown with its served message; anything else is a failed request, never a refusal.
 */
export const actionOutcome = <T>(status: number, body: unknown): THumanActionOutcome<T> => {
  if (status >= 200 && status < 300 && body !== null && typeof body === 'object') return { kind: 'done', body: body as T };
  const served = body !== null && typeof body === 'object' ? body as { code?: unknown; error?: unknown; reason?: unknown } : {};
  const code = typeof served.code === 'string' ? served.code : null;
  const message = typeof served.error === 'string' ? served.error : '';
  if (code === 'inbox-not-retryable') {
    const reason = typeof served.reason === 'string' ? served.reason : '';
    return {
      kind: 'refused', code,
      text: Object.hasOwn(RETRY_REFUSAL_SENTENCE, reason) ? RETRY_REFUSAL_SENTENCE[reason] : `Not retried: ${message || 'the server refused the retry'}`,
    };
  }
  if (code && Object.hasOwn(ACTION_REFUSAL_LABEL, code)) {
    return { kind: 'refused', code, text: message ? `${ACTION_REFUSAL_LABEL[code]}: ${message}` : ACTION_REFUSAL_LABEL[code] };
  }
  return { kind: 'failed', text: `Request failed (HTTP ${status})${message ? `: ${message}` : ''}` };
};

/** POST one human action with this page's Origin and session cookie (the browser sends both). */
export const postHumanAction = async <T>(url: string, body?: unknown): Promise<THumanActionOutcome<T>> => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return actionOutcome<T>(response.status, await response.json().catch(() => null));
  } catch (err) {
    return { kind: 'failed', text: `Request failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};
