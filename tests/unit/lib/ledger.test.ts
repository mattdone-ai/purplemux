import { describe, expect, it } from 'vitest';
import {
  LEDGER_ITEM_TYPES,
  LEDGER_KINDS,
  LEDGER_WAIT_REASONS,
  LedgerRefusal,
  MAX_LEDGER_EVENTS,
  isLedgerProducer,
  parseExperimentInput,
  parseLedgerBatch,
  percentile,
  stageOfReason,
} from '@/lib/ledger';

const NOW = Date.UTC(2026, 10, 3, 3, 0, 0);

const event = (overrides: Record<string, unknown> = {}) => ({
  event_id: 'v2:range:a:1:wait:1', at: NOW - 1000, item_type: 'range', item_key: 'range:a:0123456789ab', kind: 'wait',
  wait_reason: 'not-armed', holder: 'lane-a', clear_input: 'arm the range', ...overrides,
});

const refusal = (body: unknown): LedgerRefusal => {
  try {
    parseLedgerBatch(body, NOW);
  } catch (error) {
    if (error instanceof LedgerRefusal) return error;
    throw error;
  }
  throw new Error('accepted');
};

describe('parseLedgerBatch (AC 2, AC 3)', () => {
  it('accepts a batch and normalizes absent optional fields to null', () => {
    expect(parseLedgerBatch({ events: [event(), { event_id: 'x', at: NOW, item_type: 'gate', item_key: 'gate:t:1', kind: 'open' }] }, NOW))
      .toEqual([
        { event_id: 'v2:range:a:1:wait:1', at: NOW - 1000, item_type: 'range', item_key: 'range:a:0123456789ab', kind: 'wait', state: null,
          wait_reason: 'not-armed', holder: 'lane-a', clear_input: 'arm the range', parent_key: null, attrs: null },
        { event_id: 'x', at: NOW, item_type: 'gate', item_key: 'gate:t:1', kind: 'open', state: null, wait_reason: null, holder: null,
          clear_input: null, parent_key: null, attrs: null },
      ]);
  });

  it('takes 1 to 500 events', () => {
    expect(refusal({ events: [] }).message).toBe('events: saw "0 events", expected an array of 1 to 500 events');
    expect(refusal({ events: Array.from({ length: MAX_LEDGER_EVENTS + 1 }, (_, i) => event({ event_id: `e${i}` })) }).message)
      .toBe('events: saw "501 events", expected an array of 1 to 500 events');
    expect(parseLedgerBatch({ events: Array.from({ length: MAX_LEDGER_EVENTS }, (_, i) => event({ event_id: `e${i}` })) }, NOW))
      .toHaveLength(500);
  });

  it('refuses an unknown item_type and kind with ledger-event-invalid, the field, the value and the list', () => {
    const type = refusal({ events: [event(), event({ item_type: 'story' })] });
    expect(type).toMatchObject({ code: 'ledger-event-invalid', field: 'events[1].item_type', allowed: LEDGER_ITEM_TYPES });
    expect(type.message).toBe(`events[1].item_type: saw "story", expected one of ${LEDGER_ITEM_TYPES.join(', ')}`);
    const kind = refusal({ events: [event({ kind: 'pause' })] });
    expect(kind).toMatchObject({ code: 'ledger-event-invalid', field: 'events[0].kind', allowed: LEDGER_KINDS });
    expect(kind.message).toContain('saw "pause", expected one of open, state, wait, clear, close, link');
  });

  it('refuses an unknown wait_reason with ledger-reason-invalid and the list', () => {
    const reason = refusal({ events: [event({ wait_reason: 'coffee' })] });
    expect(reason).toMatchObject({ code: 'ledger-reason-invalid', field: 'events[0].wait_reason', allowed: LEDGER_WAIT_REASONS });
    expect(reason.message).toBe(`events[0].wait_reason: saw "coffee", expected one of ${LEDGER_WAIT_REASONS.join(', ')}`);
  });

  it('refuses a derived reason from a producer (AC 7)', () => {
    for (const derived of ['unknown', 'land-queue/lock-busy', 'land-queue/head-blocked']) {
      const reason = refusal({ events: [event({ wait_reason: derived })] });
      expect(reason.code).toBe('ledger-reason-invalid');
      expect(reason.message).toContain('a derived reason: the server writes it, a producer never sends it');
    }
  });

  it('refuses an at more than 5 min after receipt or older than the 92-day retention cutoff', () => {
    const cutoff = NOW - 92 * 24 * 60 * 60_000;
    expect(refusal({ events: [event({ at: NOW + 5 * 60_000 + 1 })] }).message)
      .toBe(`events[0].at: saw ${NOW + 300_001}, expected a time in Unix ms from the 92-day retention cutoff ${cutoff} to 5 min after the server clock ${NOW}`);
    expect(refusal({ events: [event({ at: cutoff - 1 })] }).field).toBe('events[0].at');
    expect(parseLedgerBatch({ events: [event({ at: cutoff })] }, NOW)).toHaveLength(1);
    expect(parseLedgerBatch({ events: [event({ at: NOW + 5 * 60_000 })] }, NOW)).toHaveLength(1);
    expect(refusal({ events: [event({ at: 1.5 })] }).field).toBe('events[0].at');
  });

  it('refuses a control character or a bidi control in an identifier with the ADR-0026 rules, echoed escaped', () => {
    expect(refusal({ events: [event({ item_key: 'range:a:\n1' })] }).message)
      .toBe('events[0].item_key: saw "range:a:\\n1", expected no control or format character');
    expect(refusal({ events: [event({ holder: 'lane\u202Ea' })] }).message)
      .toBe('events[0].holder: saw "lane\\u{202E}a", expected no control or format character');
    expect(refusal({ events: [event({ event_id: 'e\u200D1' })] }).field).toBe('events[0].event_id');
    expect(refusal({ events: [event({ clear_input: 'arm \u2066it' })] }).message).toContain('no control character and no bidi control');
    expect(parseLedgerBatch({ events: [event({ clear_input: 'arm 👩‍💻 it' })] }, NOW)[0].clear_input).toBe('arm 👩‍💻 it');
  });

  it('holds each kind to its fields', () => {
    expect(refusal({ events: [event({ kind: 'clear' })] }).message).toBe('events[0].wait_reason: saw "not-armed", expected nothing for kind clear');
    expect(refusal({ events: [event({ kind: 'state', wait_reason: null, clear_input: null })] }).message)
      .toBe('events[0].state: saw nothing, expected a non-blank string of at most 64 characters');
    expect(refusal({ events: [event({ kind: 'link', wait_reason: null, clear_input: null })] }).field).toBe('events[0].parent_key');
    expect(refusal({ events: [event({ kind: 'wait', wait_reason: undefined })] }).code).toBe('ledger-reason-invalid');
  });

  it('holds an item key to its item type and a parent key to a known type', () => {
    expect(refusal({ events: [event({ item_key: 'gate:a:1' })] }).message).toBe('events[0].item_key: saw "gate:a:1", expected "range:<id>"');
    expect(refusal({ events: [event({ item_key: 'range:' })] }).field).toBe('events[0].item_key');
    expect(refusal({ events: [event({ parent_key: 'story:1' })] }).message).toContain('with an item type one of slice, range');
    expect(parseLedgerBatch({ events: [event({ parent_key: 'slice:a' })] }, NOW)[0].parent_key).toBe('slice:a');
  });

  it('refuses an unknown key, a producer field and non-scalar attrs', () => {
    expect(refusal({ events: [event({ producer: 'v2' })] }).message).toContain('events[0].producer: saw "v2", expected only the keys event_id');
    expect(refusal({ events: [event()], producer: 'v2' }).field).toBe('body.producer');
    expect(refusal({ events: [event({ attrs: { nested: { a: 1 } } })] }).message)
      .toContain('events[0].attrs.nested: saw {"a":1}, expected a string, a finite number, a boolean or null');
    expect(parseLedgerBatch({ events: [event({ attrs: { confidence: 'moderate', n: 2, ok: true, none: null } })] }, NOW)[0].attrs)
      .toEqual({ confidence: 'moderate', n: 2, ok: true, none: null });
  });
});

describe('vocabulary helpers', () => {
  it('maps each reason to its stage, the split reasons to land and unknown to itself', () => {
    expect(stageOfReason('review-queue')).toBe('build-review');
    expect(stageOfReason('land-queue/lock-busy')).toBe('land');
    expect(stageOfReason('host-load')).toBe('hosts');
    expect(stageOfReason('unknown')).toBe('unknown');
  });

  it('takes a producer name that is a safe file name only', () => {
    expect(isLedgerProducer('v2')).toBe(true);
    expect(isLedgerProducer('ledger-feed.py')).toBe(true);
    for (const bad of ['', '../x', 'V2', 'a/b', '.hidden', 'x'.repeat(65)]) expect(isLedgerProducer(bad)).toBe(false);
  });

  it('takes the nearest-rank percentile', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });
});

describe('parseExperimentInput', () => {
  const body = { hypothesis: 'h', stage: 'land', metric: 'lock-hours', min_days: 3, max_days: 7 };

  it('defaults the optional fields and validates the closed ones', () => {
    expect(parseExperimentInput(body)).toEqual({ hypothesis: 'h', change_ref: null, stage: 'land', reason: null, metric: 'lock-hours',
      baseline: null, target: null, guards: [], revert_if: null, min_days: 3, max_days: 7 });
    expect(() => parseExperimentInput({ ...body, stage: 'build' })).toThrow('stage: saw "build", expected one of build-review, land, deploy, people, hosts');
    expect(() => parseExperimentInput({ ...body, reason: 'land-queue' })).toThrow(/reason: saw "land-queue"/);
    expect(parseExperimentInput({ ...body, reason: 'land-queue/lock-busy' }).reason).toBe('land-queue/lock-busy');
    expect(() => parseExperimentInput({ ...body, max_days: 2 })).toThrow('max_days: saw 2, expected an integer from 3 to 90');
    expect(() => parseExperimentInput({ ...body, guards: [{ metric: 'red-mains' }] })).toThrow('guards[0].limit: saw nothing, expected a finite number');
    expect(() => parseExperimentInput({ ...body, verdict: 'keep' })).toThrow(/body.verdict/);
  });
});
