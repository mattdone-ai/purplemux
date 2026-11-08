import { describe, expect, it } from 'vitest';
import { EVENT_PAYLOAD_MAX_BYTES, WorkerEventError, parseWorkerEvent, requiredFields, schemaFields } from '@/lib/worker-event-schema';

// ADR-0043 §2: one strict schema per type; every defect is named in one refusal.

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const KEY = 'c'.repeat(40);
const range = { repo: '/w/repo', branch: 'story/x-1', head: HEAD, base: BASE, attempt: 1 };
const reviewReady = { ...range, key: KEY, gateLog: '/w/gate.log', reviewDir: '/w/review/x-r1', receipt: `/w/receipts/${KEY}.md` };

const refusal = (fn: () => unknown): WorkerEventError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WorkerEventError);
    return err as WorkerEventError;
  }
  throw new Error('expected a refusal');
};

describe('typed worker event schema (ADR-0043 §2)', () => {
  it('accepts each type with exactly its fields and normalises paths', () => {
    expect(parseWorkerEvent('review-ready', { ...reviewReady, gateLog: '/w/x/../gate.log' })).toEqual({
      type: 'review-ready', payload: { ...reviewReady, gateLog: '/w/gate.log' },
    });
    expect(parseWorkerEvent('landed', { ...range, key: KEY, gateLog: '/w/gate.log' }).payload).toEqual({ ...range, key: KEY, gateLog: '/w/gate.log' });
    expect(parseWorkerEvent('blocked-on', { ...range, reason: ' waits\non‮ epic b ', clearInput: 'merge of b#12' }).payload)
      .toMatchObject({ reason: 'waits on epic b', clearInput: 'merge of b#12' });
    expect(parseWorkerEvent('review-ready', { ...reviewReady, head: 'd'.repeat(64), base: 'e'.repeat(64) }).payload).toMatchObject({ head: 'd'.repeat(64) });
  });

  it('makes head, base, branch, repo and attempt mandatory in every type', () => {
    for (const type of ['review-ready', 'landed', 'blocked-on'] as const) {
      expect(requiredFields(type)).toEqual(expect.arrayContaining(['repo', 'branch', 'head', 'base', 'attempt']));
    }
    const err = refusal(() => parseWorkerEvent('blocked-on', { reason: 'r', clearInput: 'c' }));
    expect(err.code).toBe('event-invalid');
    expect(err.message).toContain('repo: missing');
    expect(err.message).toContain('head: missing');
    expect(err.message).toContain('base: missing');
    expect(err.message).toContain('attempt: missing');
  });

  it('names every defect: a missing field, a wrong form and an unknown field', () => {
    const { reviewDir: _reviewDir, ...withoutFolder } = reviewReady;
    const err = refusal(() => parseWorkerEvent('review-ready', { ...withoutFolder, head: 'HEAD~1', gateLog: 'gate.log', extra: 1 }));
    expect(err.details.defects).toEqual([
      'head: expected a full object id (40 or 64 lower-case hex)',
      'gateLog: expected an absolute path of at most 4096 characters',
      'reviewDir: missing',
      'extra: not a review-ready field',
    ]);
  });

  it('takes review-ready without a receipt: the first hand-off for review has none yet (ruling R1-2)', () => {
    const { receipt: _receipt, ...firstHandOff } = reviewReady;
    expect(parseWorkerEvent('review-ready', firstHandOff).payload).toEqual(firstHandOff);
    expect(requiredFields('review-ready')).not.toContain('receipt');
    expect(schemaFields('review-ready')).toContain('receipt');
    expect(refusal(() => parseWorkerEvent('review-ready', { ...firstHandOff, receipt: 'r.md' })).message).toContain('receipt: expected an absolute path');
  });

  it('takes an optional target branch on landed, in the branch grammar (review r2 N2)', () => {
    expect(parseWorkerEvent('landed', { ...range, key: KEY, gateLog: '/w/gate.log', target: 'feature/epic-x' }).payload).toMatchObject({ target: 'feature/epic-x' });
    expect(requiredFields('landed')).not.toContain('target');
    expect(refusal(() => parseWorkerEvent('landed', { ...range, key: KEY, gateLog: '/w/gate.log', target: '-x' })).message).toContain('target: expected a branch name');
    expect(refusal(() => parseWorkerEvent('review-ready', { ...reviewReady, target: 'main' })).message).toContain('target: not a review-ready field');
  });

  it('keeps the gate log and the key mandatory on landed', () => {
    expect(requiredFields('landed')).toEqual(expect.arrayContaining(['key', 'gateLog']));
    const err = refusal(() => parseWorkerEvent('landed', range));
    expect(err.details.defects).toEqual(['key: missing', 'gateLog: missing']);
  });

  it.each([
    ['an abbreviated head', { head: 'abc1234' }, 'head'],
    ['an option for a head', { head: '--upload-pack=x' }, 'head'],
    ['an upper-case key', { key: 'C'.repeat(40) }, 'key'],
    ['a branch with ..', { branch: 'a..b' }, 'branch'],
    ['a branch that is an option', { branch: '-x' }, 'branch'],
    ['a .lock branch', { branch: 'x.lock' }, 'branch'],
    ['a relative repo', { repo: 'repo' }, 'repo'],
    ['a path with NUL', { receipt: '/w/a\0b' }, 'receipt'],
    ['attempt 0', { attempt: 0 }, 'attempt'],
    ['a fractional attempt', { attempt: 1.5 }, 'attempt'],
    ['a string attempt', { attempt: '1' }, 'attempt'],
  ])('refuses %s', (_name, change, field) => {
    expect(refusal(() => parseWorkerEvent('review-ready', { ...reviewReady, ...change })).message).toContain(`${field}: expected`);
  });

  it('refuses empty or over-long text in blocked-on', () => {
    expect(refusal(() => parseWorkerEvent('blocked-on', { ...range, reason: '\n\t', clearInput: 'c' })).message).toContain('reason: expected non-empty text');
    expect(refusal(() => parseWorkerEvent('blocked-on', { ...range, reason: 'r', clearInput: 'x'.repeat(501) })).message)
      .toContain('clearInput: expected at most 500 characters');
  });

  it('refuses an unknown type, a payload that is not an object, and an over-size payload', () => {
    expect(refusal(() => parseWorkerEvent('merged', reviewReady)).message).toContain('type must be one of review-ready, landed, blocked-on');
    expect(refusal(() => parseWorkerEvent('landed', [range])).message).toBe('payload must be a JSON object');
    expect(refusal(() => parseWorkerEvent('landed', null)).message).toBe('payload must be a JSON object');
    const big = { ...range, key: KEY, gateLog: '/w/gate.log', pad: 'x'.repeat(EVENT_PAYLOAD_MAX_BYTES) };
    expect(refusal(() => parseWorkerEvent('landed', big)).message).toContain(`the limit is ${EVENT_PAYLOAD_MAX_BYTES}`);
  });

  it('reads only own fields: an inherited field is missing, not taken', () => {
    const inherited = Object.create({ key: KEY }) as Record<string, unknown>;
    Object.assign(inherited, range, { gateLog: '/w/gate.log' });
    expect(refusal(() => parseWorkerEvent('landed', inherited)).message).toContain('key: missing');
  });
});
