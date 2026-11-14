import fs from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  actionOutcome,
  BREAK_REASON_MAX,
  NOTE_BODY_MAX_BYTES,
  NOTE_SUBJECT_MAX,
  fieldErrors,
  leaseBreakSchema,
  ownerNoteRequest,
  ownerNoteSchema,
  postHumanAction,
} from '@/lib/human-actions';
import { checkBody, cleanSubject } from '@/lib/notes-store';
import { drainLeaseLocks, makeHome, resetLeaseGlobals } from './lease-test-home';

// Story 06 consult Q2: the forms validate with the server's bounds in the server's units. The
// same input goes to the client schema and to the server function, and both must agree.

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const EMOJI = '😀';
const accepts = (run: () => unknown): boolean => {
  try {
    run();
    return true;
  } catch {
    return false;
  }
};

const note = (overrides: Partial<Record<'subject' | 'body', string>>) =>
  ownerNoteSchema.safeParse({ to: 'workspace', target: 'ws-a', subject: 's', body: 'b', ...overrides });

describe('human action bounds (consult Q2)', () => {
  beforeEach(async () => {
    resetLeaseGlobals();
    mockHome.value = await makeHome();
  });

  afterEach(async () => {
    await drainLeaseLocks();
    resetLeaseGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('keeps one source for the bounds', () => {
    expect([NOTE_SUBJECT_MAX, NOTE_BODY_MAX_BYTES, BREAK_REASON_MAX]).toEqual([120, 16 * 1024, 500]);
  });

  it('a break reason: the client and breakLease accept and refuse the same inputs', async () => {
    const { breakLease } = await import('@/lib/lease-store');
    const authority = { now: () => Date.now(), isWorkspaceOrchestrator: async () => false };
    const table: Array<[string, string, boolean]> = [
      ['500 emoji (1000 UTF-16 units)', EMOJI.repeat(500), true],
      ['501 emoji', EMOJI.repeat(501), false],
      ['501 ASCII', 'r'.repeat(501), false],
      ['500 ASCII padded with spaces', `  ${'r'.repeat(500)}  `, true],
      ['empty', '', false],
      ['spaces only', '   ', false],
      ['one character', 'r', true],
    ];
    for (const [why, reason, expected] of table) {
      const client = leaseBreakSchema.safeParse({ reason }).success;
      // A reason the server accepts reaches the store, which has no such lease.
      const server = await breakLease('merge:none/here', reason, { human: 'user' }, authority)
        .then(() => true, (err: { code?: string }) => err.code === 'lease-not-found');
      expect([client, server], why).toEqual([expected, expected]);
    }
  });

  it('a note body: the client and checkBody agree on UTF-8 bytes', () => {
    const table: Array<[string, string, boolean]> = [
      ["'é' × 8192 (16384 bytes)", 'é'.repeat(8192), true],
      ["'é' × 8193 (16386 bytes)", 'é'.repeat(8193), false],
      ['16384 ASCII', 'x'.repeat(NOTE_BODY_MAX_BYTES), true],
      ['16385 ASCII', 'x'.repeat(NOTE_BODY_MAX_BYTES + 1), false],
      ['empty', '', false],
      ['spaces only', '   ', false],
    ];
    for (const [why, body, expected] of table) {
      expect([note({ body }).success, accepts(() => checkBody(body))], why).toEqual([expected, expected]);
    }
  });

  it('a note subject: the client accepts every subject up to 120 code points the server accepts, and refuses 121', () => {
    const table: Array<[string, string, boolean]> = [
      ['120 emoji', EMOJI.repeat(120), true],
      ['120 ASCII padded with spaces', `  ${'s'.repeat(120)}  `, true],
      ['121 emoji', EMOJI.repeat(121), false],
      ['empty', '', false],
      ['spaces only', '   ', false],
    ];
    for (const [why, subject, expected] of table) {
      expect(note({ subject }).success, why).toBe(expected);
      // The server cuts a long subject to 120 code points instead of refusing it.
      if (expected) expect(accepts(() => cleanSubject(subject)), why).toBe(true);
    }
    expect(accepts(() => cleanSubject(''))).toBe(false);
    expect([...cleanSubject(EMOJI.repeat(121))]).toHaveLength(NOTE_SUBJECT_MAX);
  });

  it('names the field to fix, and builds a request with exactly one target', () => {
    const bad = ownerNoteSchema.safeParse({ to: 'epic', target: ' ', subject: '', body: 'b' });
    expect(bad.success).toBe(false);
    expect(fieldErrors(bad.error!)).toEqual({ target: 'Choose where the note goes', subject: 'A subject is required' });
    expect(ownerNoteRequest({ to: 'epic', target: ' flow ', subject: 's', body: 'b' })).toEqual({ toEpic: 'flow', subject: 's', body: 'b' });
    expect(ownerNoteRequest({ to: 'workspace', target: 'ws-a', subject: 's', body: 'b' })).toEqual({ toWorkspace: 'ws-a', subject: 's', body: 'b' });
  });
});

describe('human action outcomes', () => {
  it('a 2xx JSON body is done', () => {
    expect(actionOutcome(200, { item: { id: 'i-1' } })).toEqual({ kind: 'done', body: { item: { id: 'i-1' } } });
  });

  it('a body with a contract code is the server refusal, with its served message', () => {
    expect(actionOutcome(409, { code: 'note-cap', error: 'this sender already has 50 open notes' }))
      .toEqual({ kind: 'refused', code: 'note-cap', text: 'Too many open notes: this sender already has 50 open notes' });
    expect(actionOutcome(401, { code: 'unauthorized', error: 'Authentication required' }))
      .toMatchObject({ kind: 'refused', text: 'Sign in again: Authentication required' });
    expect(actionOutcome(404, { code: 'lease-not-found' })).toMatchObject({ kind: 'refused', text: 'Lease not found' });
  });

  it('a retry refusal reads its reason as a sentence, never the token', () => {
    for (const reason of ['stranded-in-composer', 'transport-uncertain', 'target-not-agent']) {
      const outcome = actionOutcome(409, { code: 'inbox-not-retryable', reason, error: `held ${reason}` });
      expect(outcome.kind).toBe('refused');
      expect(outcome.kind !== 'done' && outcome.text).toMatch(/^Not retried: /);
      expect(outcome.kind !== 'done' && outcome.text).not.toContain(reason);
    }
    expect(actionOutcome(409, { code: 'inbox-not-retryable', reason: 'new-thing', error: 'refused' }))
      .toMatchObject({ kind: 'refused', text: 'Not retried: refused' });
  });

  it('a generic 404, 5xx or unknown code is a failed request, never a refusal', () => {
    expect(actionOutcome(404, null)).toEqual({ kind: 'failed', text: 'Request failed (HTTP 404)' });
    expect(actionOutcome(503, { code: 'storage-unavailable', error: 'Mission Control storage unavailable' }))
      .toEqual({ kind: 'failed', text: 'Request failed (HTTP 503): Mission Control storage unavailable' });
    expect(actionOutcome(200, null)).toEqual({ kind: 'failed', text: 'Request failed (HTTP 200)' });
  });

  it('posts JSON once and maps the answer; a network error is a failed request', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ broken: { name: 'merge:x/y' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(postHumanAction('/api/mission-control/leases/break', { name: 'merge:x/y', reason: 'r' }))
        .resolves.toEqual({ kind: 'done', body: { broken: { name: 'merge:x/y' } } });
      expect(fetchMock).toHaveBeenCalledWith('/api/mission-control/leases/break', expect.objectContaining({
        method: 'POST', body: JSON.stringify({ name: 'merge:x/y', reason: 'r' }),
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }));
      await postHumanAction('/api/mission-control/inbox/i-1/retry');
      expect(fetchMock.mock.calls[1]).toEqual(['/api/mission-control/inbox/i-1/retry', expect.not.objectContaining({ body: expect.anything() })]);
      fetchMock.mockRejectedValueOnce(new TypeError('network down'));
      await expect(postHumanAction('/x')).resolves.toEqual({ kind: 'failed', text: 'Request failed: network down' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ADR-0047 r2 #3: every Portfolio Scrum Master action counts its reason one way: trimmed, then 1..500 code points.
describe('actionReason', () => {
  it('trims, and counts code points, not UTF-16 units', async () => {
    const { ACTION_REASON_MAX, actionReason } = await import('@/lib/human-actions');
    expect(actionReason('  the holder is gone  ')).toBe('the holder is gone');
    expect(actionReason('😀'.repeat(ACTION_REASON_MAX))).toBe('😀'.repeat(ACTION_REASON_MAX)); // 1,000 UTF-16 units
    expect(actionReason(`  ${'x'.repeat(ACTION_REASON_MAX)}  `)).toBe('x'.repeat(ACTION_REASON_MAX));
  });

  it('refuses empty, whitespace only, over 500 code points, and a non-string', async () => {
    const { ACTION_REASON_MAX, actionReason } = await import('@/lib/human-actions');
    for (const raw of ['', '   ', 'x'.repeat(ACTION_REASON_MAX + 1), '😀'.repeat(ACTION_REASON_MAX + 1), undefined, null, 42]) {
      expect(actionReason(raw)).toBeNull();
    }
  });
});
