import { describe, expect, it } from 'vitest';
import { reshapeCandidate } from '../../../scripts/curator/reshape-set';

// Story 23 AC 4: the reshape set holds the historical items a wording-only reshape could fix, by id; the curator's own
// items, credential-shaped questions, valid questions and structural defects are left out by name.

const v1 = (over: Record<string, unknown> = {}) => JSON.stringify({
  kind: 'question', title: 'Pick a window', context: 'c', storyIds: [], recommendation: null,
  options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], blockingScope: 'none', canContinue: true, ...over,
});

describe('reshape-set selection (AC 4)', () => {
  it('takes a v1 question with 2-4 options or none; a v1 action', () => {
    expect(reshapeCandidate('q-1', v1())).toBeNull();
    expect(reshapeCandidate('q-2', v1({ options: [] }))).toBeNull();
    expect(reshapeCandidate('q-3', v1({ kind: 'action', options: [] }))).toBeNull();
  });

  it('leaves out, by name, what no reshape may touch', () => {
    expect(reshapeCandidate('curator-spot-check-owner-2026-11-03', v1())).toBe('curator item');
    expect(reshapeCandidate('curator-so-4', v1())).toBe('curator item');
    expect(reshapeCandidate('q-4', v1({ context: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123' }))).toBe('credential-shaped');
    expect(reshapeCandidate('q-5', v1({ options: [{ id: 'a', label: 'A' }] }))).toBe('structure');
    expect(reshapeCandidate('q-6', '{not json')).toBe('not JSON');
    expect(reshapeCandidate('q-7', JSON.stringify({
      formatVersion: 2, kind: 'question', title: 'T', decision: 'D', whyNow: 'W', answerType: 'confirm', storyIds: [], blockingScope: 'none', canContinue: true,
    }))).toBe('already valid');
  });
});
