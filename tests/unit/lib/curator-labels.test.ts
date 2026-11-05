import { describe, expect, it } from 'vitest';
import { queueAdditions, queueView, validateImport, type IShadowCall } from '@/lib/curator-labels';
import type { ILabelQueue } from '@/lib/curator-store';

// The blind label pass (consult 16-promote-gate, ruling 1): queue, view, import.

const call = (sourceId: string, predicted: string | null, promptVersion = 'v1', outcome = 'labelled'): IShadowCall =>
  ({ sourceId, promptVersion, predicted, outcome, at: 1 });

describe('queueAdditions', () => {
  it('precision-only: every predicted positive and as many predicted negatives; no-label calls left out; other versions and known ids skipped', () => {
    const calls = [
      call('p1', 'question-to-owner'), call('p2', 'question-to-owner'),
      ...Array.from({ length: 10 }, (_, i) => call(`n${i}`, 'not-a-question')),
      call('t1', null, 'v1', 'timeout'), call('old', 'question-to-owner', 'v0'), call('known', 'question-to-owner'), call('p1', 'question-to-owner'),
    ];
    const added = queueAdditions('flag-owner-question', 'v1', calls, new Set(['known']));
    expect(added.filter((a) => a.predicted === 'question-to-owner').map((a) => a.id)).toEqual(['p1', 'p2']);
    expect(added.filter((a) => a.predicted === 'not-a-question')).toHaveLength(2);
    expect(added.map((a) => a.id)).not.toContain('t1');
    expect(queueAdditions('flag-owner-question', 'v1', calls, new Set(['known']))).toEqual(added);
  });

  it('match-standing-order: a predicted order id is a positive', () => {
    const added = queueAdditions('match-standing-order', 'v1', [call('a', 'SO-4'), call('b', 'not-covered'), call('c', 'not-covered')], new Set());
    expect(added.map((a) => a.predicted).sort()).toEqual(['SO-4', 'not-covered']);
  });

  it('owner messages: every call, misses included (recall needs them)', () => {
    const added = queueAdditions('classify-owner-message', 'v1', [call('a', 'one-off'), call('b', null, 'v1', 'timeout')], new Set());
    expect(added.map((a) => a.id)).toEqual(['a', 'b']);
  });
});

const queue: ILabelQueue = {
  task: 'flag-owner-question', promptVersion: 'v1',
  items: [{ id: 'p1', predicted: 'question-to-owner', outcome: 'labelled', at: 5 }, { id: 'n1', predicted: 'not-a-question', outcome: 'labelled', at: 3 }],
};

describe('queueView', () => {
  it('shows ids only, never a prediction, with the size and the oldest call', () => {
    const view = queueView(queue);
    expect(view).toEqual({ task: 'flag-owner-question', promptVersion: 'v1', size: 2, oldestAt: 3, ids: expect.arrayContaining(['p1', 'n1']) });
    expect(JSON.stringify(view)).not.toMatch(/question-to-owner|not-a-question/);
  });
});

describe('validateImport', () => {
  it('accepts queued ids with an allowed label', () => {
    expect(validateImport('flag-owner-question', queue, [{ id: 'p1', label: 'question-to-owner' }], []))
      .toEqual({ ok: true, accepted: [{ id: 'p1', label: 'question-to-owner' }], excluded: [] });
  });

  it('refuses an id that is not in the queue, and a label the task does not allow', () => {
    expect(validateImport('flag-owner-question', queue, [{ id: 'p1', label: 'question-to-owner' }, { id: 'zz', label: 'not-a-question' }], []))
      .toEqual({ ok: false, error: 'ids not in the flag-owner-question queue: zz' });
    expect(validateImport('flag-owner-question', queue, [{ id: 'p1', label: 'maybe' }], []))
      .toEqual({ ok: false, error: 'labels not allowed (question-to-owner, not-a-question): p1="maybe"' });
    expect(validateImport('flag-owner-question', null, [], [])).toMatchObject({ ok: false, error: expect.stringContaining('no label queue') });
    expect(validateImport('flag-owner-question', queue, [], [])).toMatchObject({ ok: false });
  });

  it('match-standing-order takes the orders in force, not-covered, and exclude (no permission ask)', () => {
    const q: ILabelQueue = { ...queue, task: 'match-standing-order', items: [{ id: 'a', predicted: 'SO-4', outcome: 'labelled', at: 1 }, { id: 'b', predicted: 'not-covered', outcome: 'labelled', at: 1 }] };
    expect(validateImport('match-standing-order', q, [{ id: 'a', label: 'SO-4' }, { id: 'b', label: 'exclude' }], ['SO-4']))
      .toEqual({ ok: true, accepted: [{ id: 'a', label: 'SO-4' }], excluded: ['b'] });
    expect(validateImport('match-standing-order', q, [{ id: 'a', label: 'SO-9' }], ['SO-4'])).toMatchObject({ ok: false });
  });
});
