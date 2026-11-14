import { execFile } from 'child_process';
import type { TWatchFailure } from '@/types/watch';

// One `gh api` read, run with `-i` so the answer carries its HTTP status and its rate-limit headers
// (PMUX-WATCH-403). GitHub keeps one REST budget and one GraphQL budget per account; every session
// that uses the shared agent account spends from the same two. A read reports the budget it saw, and
// a rate-limited read names when the budget comes back, so a caller waits instead of failing.

export const GH_TIMEOUT_MS = 20_000;
/**
 * A rate limit that names no usable reset is retried after this: a secondary limit with no Retry-After, a reset
 * already past, or a value that is not a time.
 */
export const RATE_LIMIT_FALLBACK_MS = 60_000;
/** The longest hold any header can ask for: GitHub's budget window is one hour (PMUX-WATCH-403 r2). */
export const RATE_LIMIT_MAX_HOLD_MS = 65 * 60_000;

/**
 * A retry time no header can push out of range: a value that is not finite, or not after `now`, is the fallback; a
 * value past {@link RATE_LIMIT_MAX_HOLD_MS} is clamped. Every Date built from a retry time is built from this.
 */
export const boundRetryAt = (candidate: number, now: number): { at: number; clamped: boolean } => {
  if (!Number.isFinite(candidate) || candidate <= now) return { at: now + RATE_LIMIT_FALLBACK_MS, clamped: false };
  if (candidate > now + RATE_LIMIT_MAX_HOLD_MS) return { at: now + RATE_LIMIT_MAX_HOLD_MS, clamped: true };
  return { at: candidate, clamped: false };
};

/**
 * GitHub's clock minus this host's, from the answer's `Date` header, in ms; 0 without a usable one. An
 * `X-RateLimit-Reset` is GitHub's epoch time: a host clock that runs ahead or behind would hold too short or too long.
 */
export const clockOffsetMs = (headers: Map<string, string>, now: number): number => {
  const date = headers.get('date');
  const server = date === undefined ? NaN : Date.parse(date);
  return Number.isFinite(server) ? server - now : 0;
};

/** The budget one answer reported: `resource` is GitHub's own name for it (`core` is REST, `graphql`). */
export interface IGhRate {
  resource: string;
  limit: number;
  remaining: number;
  used: number;
  /** When the budget is full again, epoch ms on this host's clock, bounded (`X-RateLimit-Reset` moved by `Date`). */
  resetAt: number;
  /**
   * `X-RateLimit-Reset` as GitHub sent it, epoch seconds on GitHub's clock: the same for every answer in one budget
   * window, so it keys a once-per-window log line; `resetAt` moves with each answer's 1 s `Date` (r3 #1).
   */
  resetEpochS: number;
}

export type TGhResult =
  | { ok: true; stdout: string; rate?: IGhRate }
  /**
   * `retryAt`, epoch ms on this host's clock, only on `rate-limited`: when the read may run again, bounded by
   * {@link boundRetryAt}. `retryHeader` is the raw header it came from; `retryClamped` says the header asked for more.
   */
  | { ok: false; code: TWatchFailure; message: string; rate?: IGhRate; retryAt?: number; retryHeader?: string; retryClamped?: boolean };

export interface IGhAnswer {
  status: number | null;
  headers: Map<string, string>;
  body: string;
}

/**
 * The output of `gh api -i`: a status line, the headers, a blank line, the body. Output without a status line (a
 * gh that printed nothing, or a body alone) reads as status null and the whole text as the body.
 */
export const parseIncluded = (stdout: string): IGhAnswer => {
  const match = stdout.match(/^HTTP\/[\d.]+ (\d{3})[^\n]*\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/);
  if (!match) return { status: null, headers: new Map(), body: stdout };
  const headers = new Map<string, string>();
  for (const line of match[2].split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(match[1]), headers, body: match[3] };
};

const wholeNumber = (value: string | undefined): number | null => (value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : null);

/**
 * The budget the headers name, or undefined when one of them is missing. `resetAt` is on this host's clock (corrected
 * by {@link clockOffsetMs}) and bounded like a retry time, so a log line can always print it.
 */
export const rateOf = (headers: Map<string, string>, now: number): IGhRate | undefined => {
  const limit = wholeNumber(headers.get('x-ratelimit-limit'));
  const remaining = wholeNumber(headers.get('x-ratelimit-remaining'));
  const used = wholeNumber(headers.get('x-ratelimit-used'));
  const reset = wholeNumber(headers.get('x-ratelimit-reset'));
  if (limit === null || remaining === null || reset === null) return undefined;
  const resetAt = boundRetryAt(reset * 1000 - clockOffsetMs(headers, now), now).at;
  return { resource: headers.get('x-ratelimit-resource') ?? 'unknown', limit, remaining, used: used ?? limit - remaining, resetAt, resetEpochS: reset };
};

/** The `type` of each GraphQL error in a body; none when the body is not GraphQL JSON. */
const graphqlErrorTypes = (body: string): string[] => {
  try {
    const parsed = JSON.parse(body) as { errors?: Array<{ type?: unknown }> };
    return Array.isArray(parsed?.errors) ? parsed.errors.map((e) => String(e?.type ?? '')) : [];
  } catch {
    return [];
  }
};

export interface IRetry {
  /** Epoch ms on this host's clock, bounded by {@link boundRetryAt}. */
  at: number;
  /** The header the time came from, as GitHub sent it, or `none` for the fallback. */
  header: string;
  clamped: boolean;
}

/**
 * Whether an answer is a rate limit, and when to retry: a 429; a 403 that spent the budget, carries `Retry-After`,
 * or says "rate limit" (a secondary limit); or a GraphQL `RATE_LIMITED` error, which GitHub sends with a 200.
 * `Retry-After` (seconds, relative) wins; then `X-RateLimit-Reset` (GitHub's epoch seconds, moved onto this host's
 * clock by the `Date` header) when the budget is spent; then {@link RATE_LIMIT_FALLBACK_MS}. The result is bounded.
 */
export const rateLimitRetry = (answer: IGhAnswer, stderr: string, now: number): IRetry | null => {
  const remaining = wholeNumber(answer.headers.get('x-ratelimit-remaining'));
  const text = `${answer.body}\n${stderr}`;
  const limited = answer.status === 429
    || (answer.status === 403 && (remaining === 0 || answer.headers.has('retry-after') || /rate limit/i.test(text)))
    || graphqlErrorTypes(answer.body).includes('RATE_LIMITED')
    || (answer.status === null && /rate limit/i.test(stderr));
  if (!limited) return null;
  const retryAfterRaw = answer.headers.get('retry-after');
  const retryAfter = wholeNumber(retryAfterRaw);
  if (retryAfter !== null) return { ...boundRetryAt(now + retryAfter * 1000, now), header: `Retry-After: ${retryAfterRaw}` };
  const resetRaw = answer.headers.get('x-ratelimit-reset');
  const reset = wholeNumber(resetRaw);
  if (remaining === 0 && reset !== null) {
    return { ...boundRetryAt(reset * 1000 - clockOffsetMs(answer.headers, now), now), header: `X-RateLimit-Reset: ${resetRaw}` };
  }
  return { at: now + RATE_LIMIT_FALLBACK_MS, header: 'none', clamped: false };
};

/** {@link rateLimitRetry}'s time alone, or null when the answer is no rate limit. */
export const rateLimitRetryAt = (answer: IGhAnswer, stderr: string, now: number): number | null =>
  rateLimitRetry(answer, stderr, now)?.at ?? null;

/** Classify a failed `gh` run into a server token; the raw text is kept for `watch list` only. */
export const classifyGhError = (
  err: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null },
  stderr: string,
  answer: IGhAnswer = { status: null, headers: new Map(), body: '' },
): TWatchFailure => {
  if (err.code === 'ENOENT') return 'gh-missing';
  // A reply larger than maxBuffer also kills the child; it is not a timeout.
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'other';
  if (err.killed || err.signal === 'SIGTERM') return 'timeout';
  if (rateLimitRetryAt(answer, stderr, 0) !== null || /rate limit/i.test(stderr)) return 'rate-limited';
  if (answer.status === 404 || /HTTP 404/.test(stderr) || graphqlErrorTypes(answer.body).includes('NOT_FOUND')) return 'http-404';
  // GraphQL answers a refusal with a 200 and an error: FORBIDDEN, or an organization's SAML enforcement (r2 #3).
  if (graphqlErrorTypes(answer.body).includes('FORBIDDEN') || /SAML enforcement/i.test(`${answer.body}\n${stderr}`)) return 'http-403';
  if (answer.status === 401 || /HTTP 401|gh auth login|authentication/i.test(stderr)) return 'auth';
  if (answer.status === 403 || /HTTP 403/.test(stderr)) return 'http-403';
  return 'other';
};

/** `gh api -i …`: `args` start with `api`; `-i` goes right after it. The body comes back without the headers. */
export const runGhApi = (args: string[], now: () => number = Date.now): Promise<TGhResult> =>
  new Promise((resolve) => {
    const withHeaders = args[0] === 'api' ? ['api', '-i', ...args.slice(1)] : args;
    execFile('gh', withHeaders, { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      const at = now();
      const answer = parseIncluded(String(stdout ?? ''));
      const rate = rateOf(answer.headers, at);
      if (!err) return resolve({ ok: true, stdout: answer.body, ...(rate ? { rate } : {}) });
      const text = String(stderr ?? '');
      const message = `${String(text || err.message).trim().split('\n')[0]}`.slice(0, 300);
      const code = classifyGhError(err as never, text, answer);
      const retry = code === 'rate-limited'
        ? (rateLimitRetry(answer, text, at) ?? { at: at + RATE_LIMIT_FALLBACK_MS, header: 'none', clamped: false })
        : null;
      resolve({
        ok: false, code, message, ...(rate ? { rate } : {}),
        ...(retry ? { retryAt: retry.at, retryHeader: retry.header, retryClamped: retry.clamped } : {}),
      });
    });
  });
