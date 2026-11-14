import { execFile } from 'child_process';
import type { TWatchFailure } from '@/types/watch';

// One `gh api` read, run with `-i` so the answer carries its HTTP status and its rate-limit headers
// (PMUX-WATCH-403). GitHub keeps one REST budget and one GraphQL budget per account; every session
// that uses the shared agent account spends from the same two. A read reports the budget it saw, and
// a rate-limited read names when the budget comes back, so a caller waits instead of failing.

export const GH_TIMEOUT_MS = 20_000;
/** A rate limit that names no reset (a secondary limit with no Retry-After) is retried after this. */
export const RATE_LIMIT_FALLBACK_MS = 60_000;

/** The budget one answer reported: `resource` is GitHub's own name for it (`core` is REST, `graphql`). */
export interface IGhRate {
  resource: string;
  limit: number;
  remaining: number;
  used: number;
  /** When the budget is full again, epoch ms (`X-RateLimit-Reset` is epoch seconds). */
  resetAt: number;
}

export type TGhResult =
  | { ok: true; stdout: string; rate?: IGhRate }
  /** `retryAt`, epoch ms, only on `rate-limited`: when the read may run again. */
  | { ok: false; code: TWatchFailure; message: string; rate?: IGhRate; retryAt?: number };

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

/** The budget the headers name, or undefined when one of them is missing. */
export const rateOf = (headers: Map<string, string>): IGhRate | undefined => {
  const limit = wholeNumber(headers.get('x-ratelimit-limit'));
  const remaining = wholeNumber(headers.get('x-ratelimit-remaining'));
  const used = wholeNumber(headers.get('x-ratelimit-used'));
  const reset = wholeNumber(headers.get('x-ratelimit-reset'));
  if (limit === null || remaining === null || reset === null) return undefined;
  return { resource: headers.get('x-ratelimit-resource') ?? 'unknown', limit, remaining, used: used ?? limit - remaining, resetAt: reset * 1000 };
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

/**
 * Whether an answer is a rate limit, and when to retry: a 429; a 403 that spent the budget, carries `Retry-After`,
 * or says "rate limit" (a secondary limit); or a GraphQL `RATE_LIMITED` error, which GitHub sends with a 200.
 * `Retry-After` wins, then the budget's own reset, then {@link RATE_LIMIT_FALLBACK_MS}.
 */
export const rateLimitRetryAt = (answer: IGhAnswer, stderr: string, now: number): number | null => {
  const rate = rateOf(answer.headers);
  const text = `${answer.body}\n${stderr}`;
  const limited = answer.status === 429
    || (answer.status === 403 && (rate?.remaining === 0 || answer.headers.has('retry-after') || /rate limit/i.test(text)))
    || graphqlErrorTypes(answer.body).includes('RATE_LIMITED')
    || (answer.status === null && /rate limit/i.test(stderr));
  if (!limited) return null;
  const retryAfter = wholeNumber(answer.headers.get('retry-after'));
  if (retryAfter !== null) return now + retryAfter * 1000;
  if (rate && rate.remaining === 0 && rate.resetAt > now) return rate.resetAt;
  return now + RATE_LIMIT_FALLBACK_MS;
};

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
  if (answer.status === 401 || /HTTP 401|gh auth login|authentication/i.test(stderr)) return 'auth';
  if (answer.status === 403 || /HTTP 403/.test(stderr)) return 'http-403';
  return 'other';
};

/** `gh api -i …`: `args` start with `api`; `-i` goes right after it. The body comes back without the headers. */
export const runGhApi = (args: string[], now: () => number = Date.now): Promise<TGhResult> =>
  new Promise((resolve) => {
    const withHeaders = args[0] === 'api' ? ['api', '-i', ...args.slice(1)] : args;
    execFile('gh', withHeaders, { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      const answer = parseIncluded(String(stdout ?? ''));
      const rate = rateOf(answer.headers);
      if (!err) return resolve({ ok: true, stdout: answer.body, ...(rate ? { rate } : {}) });
      const text = String(stderr ?? '');
      const message = `${String(text || err.message).trim().split('\n')[0]}`.slice(0, 300);
      const code = classifyGhError(err as never, text, answer);
      const retryAt = code === 'rate-limited' ? (rateLimitRetryAt(answer, text, now()) ?? now() + RATE_LIMIT_FALLBACK_MS) : undefined;
      resolve({ ok: false, code, message, ...(rate ? { rate } : {}), ...(retryAt !== undefined ? { retryAt } : {}) });
    });
  });
