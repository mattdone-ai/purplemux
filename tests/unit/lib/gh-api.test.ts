import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMIT_FALLBACK_MS, RATE_LIMIT_MAX_HOLD_MS, boundRetryAt, classifyGhError, parseIncluded, rateLimitRetry, rateLimitRetryAt, rateOf, runGhApi } from '@/lib/gh-api';

// PMUX-WATCH-403: `gh api -i` shapes measured with gh 2.102.0 on 2026-11-14 (a 200, a 404, a GraphQL NOT_FOUND
// answered with a 200); the rate-limit bodies are GitHub's documented ones.

const NOW = Date.UTC(2026, 10, 14, 3, 56, 0);
const RESET_S = Math.floor(Date.UTC(2026, 10, 14, 4, 12, 0) / 1000);

const answer = (status: number, headers: Record<string, string | number>, body: string): string =>
  [`HTTP/2.0 ${status} X`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\n');

const budget = (remaining: number, resource = 'core') => ({
  'X-Ratelimit-Limit': 5000, 'X-Ratelimit-Remaining': remaining, 'X-Ratelimit-Reset': RESET_S,
  'X-Ratelimit-Resource': resource, 'X-Ratelimit-Used': 5000 - remaining,
});

describe('parseIncluded and rateOf', () => {
  it('splits the status, the headers and the body, and reads the budget', () => {
    const a = parseIncluded(answer(200, budget(3782), '{"sha":"x"}'));
    expect(a.status).toBe(200);
    expect(a.body).toBe('{"sha":"x"}');
    expect(rateOf(a.headers, NOW)).toEqual({ resource: 'core', limit: 5000, remaining: 3782, used: 1218, resetAt: RESET_S * 1000, resetEpochS: RESET_S });
  });

  it('reads CRLF headers, and a body without a status line as the body alone', () => {
    expect(parseIncluded('HTTP/1.1 404 Not Found\r\nX-Ratelimit-Remaining: 1\r\n\r\n{}').status).toBe(404);
    expect(parseIncluded('{"plain":true}')).toMatchObject({ status: null, body: '{"plain":true}' });
  });

  it('a missing header gives no budget, never a made-up one', () => {
    expect(rateOf(parseIncluded(answer(200, { 'X-Ratelimit-Limit': 5000 }, '{}')).headers, NOW)).toBeUndefined();
  });
});

describe('rateLimitRetryAt', () => {
  const at = (status: number, headers: Record<string, string | number>, body: string, stderr = '') =>
    rateLimitRetryAt(parseIncluded(answer(status, headers, body)), stderr, NOW);

  it('a 403 that spent the budget retries at X-RateLimit-Reset', () => {
    expect(at(403, budget(0), '{"message":"API rate limit exceeded for user ID 1."}')).toBe(RESET_S * 1000);
  });

  it('a 429 and a 403 with Retry-After retry after it, which wins over the reset', () => {
    expect(at(429, { ...budget(0), 'Retry-After': 60 }, '{}')).toBe(NOW + 60_000);
    expect(at(403, { ...budget(12), 'Retry-After': 30 }, '{"message":"You have exceeded a secondary rate limit."}')).toBe(NOW + 30_000);
  });

  it('a secondary limit with neither header retries after the fallback', () => {
    expect(at(403, budget(4000), '{"message":"You have exceeded a secondary rate limit."}')).toBe(NOW + RATE_LIMIT_FALLBACK_MS);
  });

  it('a GraphQL RATE_LIMITED error, which GitHub sends with a 200, is a rate limit at the graphql reset', () => {
    expect(at(200, budget(0, 'graphql'), '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}')).toBe(RESET_S * 1000);
  });

  it('a 403 that is no rate limit, a 404 and a 200 are not', () => {
    expect(at(403, budget(4000), '{"message":"Resource not accessible by integration"}')).toBeNull();
    expect(at(404, budget(4000), '{"message":"Not Found"}')).toBeNull();
    expect(at(200, budget(4000), '{"data":{}}')).toBeNull();
  });
});

// PMUX-WATCH-403 r2 #1: the hold is bounded, and an X-RateLimit-Reset is moved onto this host's clock.
describe('the retry time is bounded and on this host\'s clock', () => {
  const MIN = 60_000;
  const spent = (extra: Record<string, string | number>) =>
    parseIncluded(answer(403, { ...budget(0), ...extra }, '{"message":"API rate limit exceeded"}'));

  it('clamps a Retry-After past an hour to 65 minutes, and names the header it came from', () => {
    expect(rateLimitRetry(spent({ 'Retry-After': 999999999 }), '', NOW)).toEqual({
      at: NOW + RATE_LIMIT_MAX_HOLD_MS, header: 'Retry-After: 999999999', clamped: true });
  });

  it('the raw reset stays the same for every answer of one window, whatever its Date header (r3 #1)', () => {
    const at = (date: number) => rateOf(spent({ Date: new Date(date).toUTCString() }).headers, NOW)!;
    const first = at(NOW - 437);
    const second = at(NOW + 1_612);
    expect(first.resetAt).not.toBe(second.resetAt);
    expect(first.resetEpochS).toBe(RESET_S);
    expect(second.resetEpochS).toBe(RESET_S);
  });

  it('a host clock AHEAD of GitHub waits longer by the gap; one BEHIND waits shorter', () => {
    // GitHub's Date reads 5 min before this host: this host's clock is 5 min ahead.
    const ahead = spent({ Date: new Date(NOW - 5 * MIN).toUTCString() });
    expect(rateLimitRetryAt(ahead, '', NOW)).toBe(RESET_S * 1000 + 5 * MIN);
    const behind = spent({ Date: new Date(NOW + 5 * MIN).toUTCString() });
    expect(rateLimitRetryAt(behind, '', NOW)).toBe(RESET_S * 1000 - 5 * MIN);
    // Retry-After is relative: no clock enters it.
    expect(rateLimitRetryAt(spent({ Date: new Date(NOW + 30 * MIN).toUTCString(), 'Retry-After': 60 }), '', NOW)).toBe(NOW + 60_000);
  });

  it('a reset already past holds for the fallback, never a hold that ended before it began', () => {
    const past = spent({ 'X-Ratelimit-Reset': RESET_S - 3600 });
    expect(rateLimitRetry(past, '', NOW)).toEqual({ at: NOW + RATE_LIMIT_FALLBACK_MS, header: `X-RateLimit-Reset: ${RESET_S - 3600}`, clamped: false });
  });

  it('an out-of-range reset and an unreadable Date header give a time a Date can print', () => {
    const far = rateLimitRetry(spent({ 'X-Ratelimit-Reset': '999999999999999' }), '', NOW)!;
    expect(far).toMatchObject({ at: NOW + RATE_LIMIT_MAX_HOLD_MS, clamped: true });
    expect(() => new Date(far.at).toISOString()).not.toThrow();
    expect(rateLimitRetryAt(spent({ Date: 'not a date' }), '', NOW)).toBe(RESET_S * 1000);
    const rate = rateOf(spent({ 'X-Ratelimit-Reset': '999999999999999' }).headers, NOW)!;
    expect(() => new Date(rate.resetAt).toISOString()).not.toThrow();
  });

  it('boundRetryAt: not finite or not after now is the fallback; past the hour is clamped', () => {
    for (const bad of [NaN, Infinity, -Infinity, NOW, NOW - 1]) expect(boundRetryAt(bad, NOW)).toEqual({ at: NOW + RATE_LIMIT_FALLBACK_MS, clamped: false });
    expect(boundRetryAt(1e300, NOW)).toEqual({ at: NOW + RATE_LIMIT_MAX_HOLD_MS, clamped: true });
    expect(boundRetryAt(NOW + MIN, NOW)).toEqual({ at: NOW + MIN, clamped: false });
  });
});

describe('classifyGhError with the answer', () => {
  const e = (over: Record<string, unknown> = {}) => Object.assign(new Error('x'), over) as never;

  it('names a rate limit before the 403, and a GraphQL NOT_FOUND as http-404', () => {
    expect(classifyGhError(e(), 'gh: API rate limit exceeded (HTTP 403)', parseIncluded(answer(403, budget(0), '{"message":"API rate limit exceeded"}')))).toBe('rate-limited');
    expect(classifyGhError(e(), 'gh: Could not resolve to a PullRequest with the number of 9.',
      parseIncluded(answer(200, budget(4000, 'graphql'), '{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND"}]}')))).toBe('http-404');
    expect(classifyGhError(e(), 'gh: Resource not accessible by integration (HTTP 403)', parseIncluded(answer(403, budget(4000), '{}')))).toBe('http-403');
    expect(classifyGhError(e(), 'gh: Bad credentials (HTTP 401)', parseIncluded(answer(401, {}, '{}')))).toBe('auth');
  });

  it('a GraphQL FORBIDDEN, and an organization\'s SAML enforcement, are http-403, not other (r2 #3)', () => {
    expect(classifyGhError(e(), 'gh: Resource not accessible by integration',
      parseIncluded(answer(200, budget(4000, 'graphql'), '{"data":{"repository":null},"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]}')))).toBe('http-403');
    expect(classifyGhError(e(), 'gh: Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.',
      parseIncluded(answer(200, budget(4000, 'graphql'), '{"data":{"repository":null},"errors":[{"message":"Resource protected by organization SAML enforcement."}]}')))).toBe('http-403');
  });
});

describe('runGhApi through a fake gh', () => {
  let dir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-gh-api-'));
    savedPath = process.env.PATH;
    process.env.PATH = `${dir}:${savedPath}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A gh that records its arguments, prints `stdout` and `stderr`, and exits `code`. */
  const fakeGh = (stdout: string, stderr: string, code: number) => {
    fs.writeFileSync(path.join(dir, 'out'), stdout);
    fs.writeFileSync(path.join(dir, 'err'), stderr);
    fs.writeFileSync(path.join(dir, 'gh'), [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > '${path.join(dir, 'args')}'`,
      `cat '${path.join(dir, 'out')}'`,
      `cat '${path.join(dir, 'err')}' >&2`,
      `exit ${code}`,
      '',
    ].join('\n'), { mode: 0o755 });
  };

  it('asks for the headers, returns the body alone, and reports the budget', async () => {
    fakeGh(answer(200, budget(4871, 'graphql'), '{"data":{"ok":true}}'), '', 0);
    const r = await runGhApi(['api', 'graphql', '-f', 'query=x'], () => NOW);
    expect(fs.readFileSync(path.join(dir, 'args'), 'utf-8').split('\n').slice(0, 2)).toEqual(['api', '-i']);
    expect(r).toEqual({ ok: true, stdout: '{"data":{"ok":true}}', rate: { resource: 'graphql', limit: 5000, remaining: 4871, used: 129, resetAt: RESET_S * 1000, resetEpochS: RESET_S } });
  });

  it('a rate-limited 403 is rate-limited with GitHub\'s reset, never http-403', async () => {
    fakeGh(answer(403, budget(0), '{"message":"API rate limit exceeded for user ID 1."}'), 'gh: API rate limit exceeded for user ID 1. (HTTP 403)', 1);
    const r = await runGhApi(['api', 'repos/o/r/pulls/1'], () => NOW);
    expect(r).toMatchObject({ ok: false, code: 'rate-limited', retryAt: RESET_S * 1000, rate: { remaining: 0, resource: 'core' } });
  });

  it('another 403 stays http-403 and carries no retry time', async () => {
    fakeGh(answer(403, budget(4000), '{"message":"Resource not accessible by integration"}'), 'gh: Resource not accessible by integration (HTTP 403)', 1);
    const r = await runGhApi(['api', 'repos/o/r/pulls/1'], () => NOW);
    expect(r).toMatchObject({ ok: false, code: 'http-403' });
    expect(r).not.toHaveProperty('retryAt');
  });
});
