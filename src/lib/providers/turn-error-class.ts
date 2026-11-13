import type { ITurnError } from '@/lib/providers/types';

/**
 * The provider-neutral part of a failed turn's class (PMUX-REMOTE-RESILIENCE fix 1). A provider first maps the
 * codes it measured; a code it does not know falls through to these text rules, which only ever read the text
 * of an entry the provider itself flagged as an API error, never a worker's own message.
 *
 * - `auth-failure`: the account or its credentials failed — Claude's `authentication_failed`, Codex's
 *   `unauthorized`, an HTTP 401 or 403, "Please run /login", a Cloudflare 403 page. Typing a resume into it
 *   fails the same way, so nobody is resumed until the provider answers on that host again.
 * - `usage-limit`: a plan or subscription limit ("usage limit reached", "5-hour limit", "resets at …"), whatever
 *   code it carries — Claude may write one as `rate_limit` (review r1). Never typed into, as before.
 * - `rate-limit`: HTTP 429 or the provider's rate-limit error. Resumed with backoff.
 */
const AUTH_CODES: ReadonlySet<string> = new Set(['authentication_failed', 'unauthorized', 'oauth_token_revoked', 'invalid_api_key']);
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(['rate_limit', 'rate_limit_error', 'rate_limited', 'rate_limit_exceeded']);

const AUTH_TEXT: readonly RegExp[] = [
  /please run \/login/i,
  /\b(401|403)\b[^\n]{0,80}\b(unauthori[sz]ed|forbidden|authenticat\w*|api key|token|cloudflare)/i,
  /\b(unauthori[sz]ed|forbidden)\b[^\n]{0,40}\b(401|403)\b/i,
  /cloudflare[^\n]{0,200}\b403\b|\b403\b[^\n]{0,200}cloudflare/i,
  /\b(failed to authenticate|authentication[_ ]failed|invalid api key|oauth (session|token) (expired|revoked))/i,
];
const USAGE_LIMIT_TEXT: readonly RegExp[] = [
  /\busage limit\b/i,
  /\b(session|5-hour|five-hour|weekly|opus|daily|monthly) limit\b/i,
  /\blimit (reached|exceeded)\b[^\n]{0,80}\breset/i,
  /\bresets? (at|in|on)\b/i,
];
const RATE_LIMIT_TEXT: readonly RegExp[] = [
  /(\bapi error:?|\bstatus|\bcode|\bhttp)\s*\(?429\b|\(429\)/i,
  /\brate[_ -]?limit(ed|_error)?\b/i,
  /\btoo many requests\b/i,
];

export const classifyTurnErrorText = (code: string, text: string): ITurnError['class'] => {
  if (AUTH_CODES.has(code)) return 'auth-failure';
  if (USAGE_LIMIT_TEXT.some((re) => re.test(text))) return 'usage-limit';
  if (RATE_LIMIT_CODES.has(code)) return 'rate-limit';
  if (AUTH_TEXT.some((re) => re.test(text))) return 'auth-failure';
  if (RATE_LIMIT_TEXT.some((re) => re.test(text))) return 'rate-limit';
  return 'other';
};
