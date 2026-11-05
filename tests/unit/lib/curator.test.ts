import { describe, expect, it } from 'vitest';
import {
  CURATOR_CHARS_PER_TOKEN, CURATOR_MAX_INPUT_TOKENS, addCounts, binomialLowerBound, checkRefusal, countRows, cutToLastTokens, estimateTokens,
  isHeldOut, minTrialsAtZeroErrors, parseCuratorReply, percentile, promoteVerdict, replySchema, scoreRows, spanOccurs, type ICuratorShadowRow,
} from '@/lib/curator';
import { COVERED, NOT_COVERED, OWNER_MESSAGE_CLASSES } from '@/lib/curator-tasks';
import type { ICuratorEvalResult, ICuratorEvalRow } from '@/types/curator';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 7, 0, 0, 0);

describe('the input bound (AC 2)', () => {
  it('keeps a text that fits whole and reports no cut', () => {
    expect(cutToLastTokens('short text')).toEqual({ text: 'short text', cutTokens: 0 });
  });

  it('keeps the LAST 6,000 tokens of a long text, at a word boundary, and says how many went', () => {
    const words = Array.from({ length: 12_000 }, (_, i) => `w${i}`).join(' ');
    const { text, cutTokens } = cutToLastTokens(words);
    expect(text.endsWith('w11999')).toBe(true);
    expect(text.startsWith('w')).toBe(true);
    expect(estimateTokens(text)).toBeLessThanOrEqual(CURATOR_MAX_INPUT_TOKENS);
    expect(text.length).toBeGreaterThan(CURATOR_MAX_INPUT_TOKENS * CURATOR_CHARS_PER_TOKEN - 200);
    expect(cutTokens).toBe(estimateTokens(words) - estimateTokens(text));
    expect(cutTokens).toBeGreaterThan(0);
  });

  it('counts characters below the measured 3.34 per token, so the cut errs short of the 8,192 context', () => {
    expect(CURATOR_CHARS_PER_TOKEN).toBeLessThan(3.34);
  });
});

describe('the reply contract', () => {
  it('takes an offered label and its span', () => {
    expect(parseCuratorReply('{"label":"answer","span":"yes go"}', ['answer', 'one-off'])).toEqual({ ok: true, label: 'answer', span: 'yes go' });
  });

  it('refuses a label it was not offered, a non-object and non-JSON, naming what it saw', () => {
    expect(parseCuratorReply('{"label":"my password is hunter2"}', ['answer'])).toEqual({ ok: false, error: 'label is not one offered (offered: answer)' });
    expect(parseCuratorReply('[1]', ['answer']).ok).toBe(false);
    expect(parseCuratorReply('null', ['answer'])).toEqual({ ok: false, error: 'reply is not an object' });
    expect(parseCuratorReply('token: ghp_abcdefghijklmnopqrstuvwxyz0123', ['answer'])).toEqual({ ok: false, error: 'reply is not JSON (41 chars)' });
  });

  it('an empty span is no span', () => {
    expect(parseCuratorReply('{"label":"answer","span":"  "}', ['answer'])).toEqual({ ok: true, label: 'answer', span: null });
  });

  it('a span is found in the input across case and whitespace, and a made-up one is not', () => {
    expect(spanOccurs('From  now\non', 'ok, from now on use AEDT')).toBe(true);
    expect(spanOccurs('never said this', 'ok, from now on use AEDT')).toBe(false);
    expect(spanOccurs(null, 'x')).toBe(false);
  });

  it('constrains the reply to an enum of the offered labels', () => {
    expect(replySchema(['a', 'b'])).toMatchObject({ properties: { label: { enum: ['a', 'b'] } }, required: ['label', 'span'] });
  });
});

describe('the held-out split (AC 4)', () => {
  it('holds out about 30% by a stable hash of the id', () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `ws-a/id-${i}`);
    const share = ids.filter(isHeldOut).length / ids.length;
    expect(share).toBeGreaterThan(0.27);
    expect(share).toBeLessThan(0.33);
    expect(ids.filter(isHeldOut)).toEqual(ids.filter(isHeldOut));
  });
});

const row = (gold: string, predicted: string | null): Pick<ICuratorEvalRow, 'gold' | 'predicted'> => ({ gold, predicted });

describe('the bound (consult 16-promote-gate, ruling 1)', () => {
  it('is the exact one-sided 95% Clopper-Pearson lower bound', () => {
    expect(binomialLowerBound(8, 10)).toBeCloseTo(0.4931, 3);
    expect(binomialLowerBound(95, 100)).toBeCloseTo(0.8977, 3);
    expect(Math.abs(binomialLowerBound(8, 10)! - 0.4931)).toBeLessThan(5e-4);
    expect(Math.abs(binomialLowerBound(95, 100)! - 0.8977)).toBeLessThan(5e-4);
    expect(binomialLowerBound(0, 7)).toBe(0);
    expect(binomialLowerBound(3, 0)).toBeNull();
    expect(binomialLowerBound(5, 5)).toBeCloseTo(0.549, 3);
    expect(binomialLowerBound(1, 1)).toBeCloseTo(0.05, 6);
  });

  it('a run with no error needs 149, 59, 29 and 14 trials for 0.98, 0.95, 0.90 and 0.80', () => {
    expect([0.98, 0.95, 0.9, 0.8].map((t) => minTrialsAtZeroErrors(t))).toEqual([149, 59, 29, 14]);
  });
});

describe('scoring (AC 5)', () => {
  it('counts per class; no prediction lowers recall, never precision', () => {
    const score = scoreRows('classify-owner-message', OWNER_MESSAGE_CLASSES, [
      row('standing-order', 'standing-order'), row('standing-order', null), row('one-off', 'standing-order'), row('product-rule', 'product-rule'),
    ]);
    expect(score.classes.find((c) => c.label === 'standing-order')).toMatchObject({ support: 2, predicted: 2, truePositives: 1, precision: 0.5, recall: 0.5 });
    expect(score.classes.find((c) => c.label === 'answer')).toMatchObject({ precision: null, recall: null });
  });

  it('a check carries successes, trials, the bound and the zero-error minimum; the bound alone passes it', () => {
    const score = scoreRows('flag-owner-question', ['question-to-owner', 'not-a-question'], Array.from({ length: 20 }, () => row('question-to-owner', 'question-to-owner')));
    expect(score.checks[0]).toMatchObject({ label: 'question-to-owner', metric: 'precision', measured: 1, successes: 20, trials: 20, minTrials: 59, pass: false });
    expect(score.checks[0].lowerBound).toBeCloseTo(0.05 ** (1 / 20), 9);
  });

  it('one correct prediction is far from passing (review r1 F3)', () => {
    const score = scoreRows('match-standing-order', [COVERED, NOT_COVERED], [row('SO-4', 'SO-4')]);
    expect(score.checks[0]).toMatchObject({ successes: 1, trials: 1, measured: 1, pass: false });
    expect(score.checks[0].lowerBound).toBeCloseTo(0.05, 6);
    expect(checkRefusal(score.checks[0])).toBe('covered precision 1/1 = 1.000; 95% lower bound 0.0500, needs >= 0.98 (0 errors needs >= 149)');
  });

  it('a class never predicted has no bound and fails', () => {
    const score = scoreRows('flag-owner-question', ['question-to-owner', 'not-a-question'], [row('question-to-owner', 'not-a-question')]);
    expect(score.checks[0]).toMatchObject({ measured: null, lowerBound: null, pass: false });
  });

  it('a standing-order match counts as covered only when it names the gold order', () => {
    const score = scoreRows('match-standing-order', [COVERED, NOT_COVERED], [
      row('SO-4', 'SO-4'), row('SO-4', 'SO-3'), row(NOT_COVERED, 'SO-4'), row(NOT_COVERED, NOT_COVERED),
    ]);
    expect(score.classes[0]).toMatchObject({ label: COVERED, support: 2, predicted: 3, truePositives: 1 });
    expect(score.classes[1]).toMatchObject({ label: NOT_COVERED, support: 2, predicted: 1, truePositives: 1 });
  });

  it('pooled counts add class by class', () => {
    const a = countRows('flag-owner-question', ['question-to-owner', 'not-a-question'], [row('question-to-owner', 'question-to-owner')]);
    const b = countRows('flag-owner-question', ['question-to-owner', 'not-a-question'], [row('not-a-question', 'question-to-owner')]);
    expect(addCounts(a, b)[0]).toEqual({ label: 'question-to-owner', support: 1, predicted: 2, truePositives: 1 });
  });

  it('percentiles: nearest rank, null when empty', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
  });
});

type TTask = 'classify-owner-message' | 'flag-owner-question' | 'match-standing-order';
const LABELS: Record<TTask, readonly string[]> = {
  'classify-owner-message': OWNER_MESSAGE_CLASSES, 'flag-owner-question': ['question-to-owner', 'not-a-question'], 'match-standing-order': [COVERED, NOT_COVERED],
};
const VERSION = 'v-test';

/** A held-out result holding counts only, as the store keeps it. */
const heldOut = (task: TTask, rows: Array<Pick<ICuratorEvalRow, 'gold' | 'predicted'>>, extra: Partial<ICuratorEvalResult> = {}): ICuratorEvalResult => {
  const counts = countRows(task, LABELS[task], rows);
  const score = scoreRows(task, LABELS[task], rows);
  return {
    task, promptVersion: VERSION, model: 'gemma4:26b', split: 'holdout', startedAt: 0, finishedAt: 1, n: rows.length, counts, unresolved: 0, agedOut: 0,
    unresolvedByClass: {}, excluded: { shadow: 0, disputed: 0 }, spotCheck: null, refused: null, outcomes: {}, latency: { p50: 1, p90: 1 }, score, rules: score, ...extra,
  };
};
const shadowRows = (n: number, gold: string, predicted: string | null, prefix = 's'): ICuratorShadowRow[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, gold, predicted }));
const clean = { state: 'answered' as const, disputed: [], unjudged: [], wrongShare: 0, judged: 30 };

const gate = (task: TTask, over: Partial<Parameters<typeof promoteVerdict>[0]> = {}) => promoteVerdict({
  task, now: NOW, promptVersion: VERSION, labels: LABELS[task], shadowSince: NOW - 73 * HOUR, result: heldOut(task, []), shadowRows: [],
  ...(task === 'flag-owner-question' ? {} : { spotCheck: clean, spotCheckApplied: true }), ...over,
});

describe('promote: the pooled bound (consult 16-promote-gate)', () => {
  it('match-standing-order: 149/149 passes; 148/148 refuses with the zero-error text', () => {
    expect(gate('match-standing-order', { shadowRows: shadowRows(149, 'SO-4', 'SO-4') }).ok).toBe(true);
    const refused = gate('match-standing-order', { shadowRows: shadowRows(148, 'SO-4', 'SO-4') });
    expect(refused.ok).toBe(false);
    expect(refused.refusals).toEqual(['covered precision 148/148 = 1.000; 95% lower bound 0.9799, needs >= 0.98 (0 errors needs >= 149)']);
  });

  it('match-standing-order: 235/236 passes, 234/235 refuses', () => {
    const rows = (n: number) => [...shadowRows(n - 1, 'SO-4', 'SO-4'), { id: 'fp', gold: NOT_COVERED, predicted: 'SO-4' }];
    expect(gate('match-standing-order', { shadowRows: rows(236) }).ok).toBe(true);
    expect(gate('match-standing-order', { shadowRows: rows(235) }).ok).toBe(false);
  });

  it('flag-owner-question: 59/59 passes, 58/58 refuses; the pool joins held-out counts and shadow rows', () => {
    const held = Array.from({ length: 29 }, () => row('question-to-owner', 'question-to-owner'));
    expect(gate('flag-owner-question', { result: heldOut('flag-owner-question', held), shadowRows: shadowRows(30, 'question-to-owner', 'question-to-owner') }).ok).toBe(true);
    expect(gate('flag-owner-question', { result: heldOut('flag-owner-question', held.slice(1)), shadowRows: shadowRows(30, 'question-to-owner', 'question-to-owner') }).ok).toBe(false);
  });

  it('recall 0.80: 14/14 passes, 13/13 refuses (owner messages)', () => {
    const mk = (n: number) => [...shadowRows(Math.max(n, 30), 'standing-order', 'standing-order', 'so'), ...shadowRows(Math.max(n, 30), 'product-rule', 'product-rule', 'pr')];
    expect(gate('classify-owner-message', { shadowRows: mk(30) }).ok).toBe(true);
    const recall = (n: number) => scoreRows('classify-owner-message', OWNER_MESSAGE_CLASSES, Array.from({ length: n }, () => row('standing-order', 'standing-order')))
      .checks.find((c) => c.metric === 'recall' && c.label === 'standing-order')!;
    expect(recall(14).pass).toBe(true);
    expect(recall(13).pass).toBe(false);
  });

  it('the same id in a held-out run and the shadow counts once, as the shadow row', () => {
    const verdict = gate('match-standing-order', { shadowRows: [...shadowRows(149, 'SO-4', 'SO-4'), ...shadowRows(149, 'SO-4', 'SO-4')] });
    expect(verdict.score!.checks[0]).toMatchObject({ successes: 149, trials: 149 });
  });
});

describe('promote: the shadow of the version (ruling 2)', () => {
  it('the clock is the prompt version\'s own: 1 h of v2 refuses whatever v1 ran', () => {
    const verdict = gate('flag-owner-question', { shadowSince: NOW - HOUR, shadowRows: shadowRows(59, 'question-to-owner', 'question-to-owner') });
    expect(verdict.refusals).toEqual([expect.stringMatching(/^shadow of v-test 1\.0 h of 72\.0 h \(since /)]);
    expect(gate('flag-owner-question', { shadowSince: null }).refusals[0]).toBe('shadow has not started for v-test: no live call of this prompt yet');
  });

  it('needs 30 labelled shadow rows at or above the threshold per check', () => {
    const held = Array.from({ length: 300 }, () => row('SO-4', 'SO-4'));
    const at = (rows: ICuratorShadowRow[]) => gate('match-standing-order', { result: heldOut('match-standing-order', held), shadowRows: rows });
    expect(at(shadowRows(29, 'SO-4', 'SO-4')).refusals).toEqual(['shadow evidence for v-test: covered precision 29/29, needs n >= 30 and >= 0.98']);
    expect(at([...shadowRows(29, 'SO-4', 'SO-4'), { id: 'fp', gold: NOT_COVERED, predicted: 'SO-4' }]).refusals)
      .toEqual(['shadow evidence for v-test: covered precision 29/30, needs n >= 30 and >= 0.98']);
    expect(at(shadowRows(30, 'SO-4', 'SO-4')).ok).toBe(true);
  });
});

describe('promote: spot checks', () => {
  it('match-standing-order: unanswered refuses; a disputed true positive becomes a false positive; 4 of 30 wrong fails the gold', () => {
    const rows = shadowRows(150, 'SO-4', 'SO-4');
    expect(gate('match-standing-order', { shadowRows: rows, spotCheck: { state: 'unanswered' } }).refusals)
      .toEqual(['spot-check unanswered: the owner checks the labels first (`purplemux curator spot-check open --task match-standing-order`)']);
    const one = gate('match-standing-order', { shadowRows: rows, spotCheck: { ...clean, disputed: ['s0'], wrongShare: 1 / 30 } });
    expect(one.score!.checks[0]).toMatchObject({ successes: 149, trials: 150, pass: false });
    expect(gate('match-standing-order', { shadowRows: rows, spotCheck: { ...clean, disputed: ['s0', 's1', 's2', 's3'], wrongShare: 4 / 30 } }).refusals)
      .toContain('gold set failed spot-check: 4 of 30 wrong (limit 10%)');
  });

  it('owner messages: disputed ids leave the shadow rows, and an evaluation from before the answer refuses', () => {
    const spot = { ...clean, disputed: ['so0'], wrongShare: 1 / 30 };
    const rows = [...shadowRows(31, 'standing-order', 'standing-order', 'so'), ...shadowRows(30, 'product-rule', 'product-rule', 'pr')];
    expect(gate('classify-owner-message', { shadowRows: rows, spotCheck: spot, spotCheckApplied: false }).refusals)
      .toEqual(['evaluation predates the spot-check answer: evaluate again so the disputed ids are left out']);
    expect(gate('classify-owner-message', { shadowRows: rows, spotCheck: spot, spotCheckApplied: true }).ok).toBe(true);
    expect(gate('classify-owner-message', { shadowRows: rows, spotCheck: { state: 'unreadable', reason: 'text with no option selected' } }).refusals)
      .toContain('spot-check answer unreadable: text with no option selected');
  });

  it('flag-owner-question has no spot check', () => {
    expect(gate('flag-owner-question', { shadowRows: shadowRows(59, 'question-to-owner', 'question-to-owner') }).ok).toBe(true);
  });
});

describe('promote: the evaluation', () => {
  const rows = shadowRows(149, 'SO-4', 'SO-4');
  it.each([
    [null, 'no evaluation: run `purplemux curator eval --task match-standing-order`'],
    [{ promptVersion: 'v-old' }, 'evaluation is of prompt v-old, the live prompt is v-test: evaluate again'],
    [{ split: 'train' as const }, 'evaluation ran outside the held-out 30%: the gate reads the held-out split'],
    [{ refused: '20 of 100 unresolved (20.0%), limit 10.0%' }, 'evaluation refused: 20 of 100 unresolved (20.0%), limit 10.0%'],
  ])('%j refuses: %s', (extra, refusal) => {
    const result = extra === null ? null : heldOut('match-standing-order', [], extra);
    expect(gate('match-standing-order', { result, shadowRows: rows }).refusals).toEqual([refusal]);
  });
});
