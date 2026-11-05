import { describe, expect, it } from 'vitest';
import { isHeldOut } from '@/lib/curator';
import {
  RESHAPE_TARGET, reshapeEvalOrder, reshapeGateVerdict, validateJudgeImport, type IReshapeEvalResult, type IReshapeJudgeFile,
} from '@/lib/curator-reshape-gate';

// Story 23 AC 4 and consult C2: 100 held-out replies, all valid and preserved; the judge's >= 95% bound to the run and
// each sha256; 72 h of the version in shadow with every live reply clean.

const H = 'rsq-v1-aaaa~bbbb';
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

const result = (over: Partial<IReshapeEvalResult> = {}): IReshapeEvalResult => {
  const rows = Array.from({ length: RESHAPE_TARGET }, (_, i) => ({
    id: `ws-a/mc/q-${i}`, outcome: 'labelled' as const, label: 'reshaped', draftSha: `sha-${i}`, defects: [], latencyMs: 100,
  }));
  return {
    task: 'reshape-question', runId: 'run-1', promptVersion: H, model: 'gemma4:26b', startedAt: NOW - HOUR, finishedAt: NOW - HOUR / 2,
    target: RESHAPE_TARGET, candidates: 250, replied: 100, clean: 100, nonReplies: 0, unresolved: 0, unreshapable: 0,
    labels: { reshaped: 100 }, outcomes: { labelled: 100 }, latency: { p50: 100, p90: 100 }, refused: null, rows, ...over,
  };
};

const judge = (same: number, over: Partial<IReshapeJudgeFile> = {}): IReshapeJudgeFile => ({
  runId: 'run-1', promptVersion: H, judge: 'claude-opus-5-5 at high', importedAt: NOW,
  verdicts: Array.from({ length: RESHAPE_TARGET }, (_, i) => ({ id: `ws-a/mc/q-${i}`, sha: `sha-${i}`, verdict: i < same ? 'same' as const : 'different' as const })),
  ...over,
});

const gate = (over: Partial<Parameters<typeof reshapeGateVerdict>[0]> = {}) => reshapeGateVerdict({
  now: NOW, promptVersion: H, shadowSince: NOW - 73 * HOUR, result: result(), judge: judge(95), liveReplies: ['reshaped', 'reshaped'], ...over,
});

describe('the reshape gate (AC 4, consult C2)', () => {
  it('passes with 100 clean replies, 95 of 100 judged same, 72 h of shadow and clean live replies', () => {
    expect(gate()).toEqual({ ok: true, refusals: [], same: 95, judged: 100 });
  });

  it('94 of 100 same is refused with the measure; a missing verdict counts as different', () => {
    expect(gate({ judge: judge(94) }).refusals).toEqual(['judge "same decision, same options" 94/100, needs >= 95 (95%; a missing verdict counts as different)']);
    const missing = judge(100);
    missing.verdicts = missing.verdicts.slice(0, 94);
    expect(gate({ judge: missing }).ok).toBe(false);
  });

  it('a failed reply (unparsable, error) has no draft, is judged different, and fails both the 100% and the 95% (review r1 F2)', () => {
    const r = result({ clean: 97 });
    for (const i of [0, 1, 2]) r.rows[i] = { ...r.rows[i], outcome: 'unparsable', label: null, draftSha: null, defects: ['unparsable'] };
    const verdict = gate({ result: r, judge: judge(100) });
    expect(verdict.judged).toBe(100);
    expect(verdict.same).toBe(97);
    expect(verdict.refusals).toEqual(['schema-valid and preservation-clean 97/100, needs 100/100']);
    const worse = result({ clean: 94 });
    for (const i of [0, 1, 2, 3, 4, 5]) worse.rows[i] = { ...worse.rows[i], outcome: 'error', label: null, draftSha: null, defects: ['error'] };
    expect(gate({ result: worse, judge: judge(100) }).refusals).toContain('judge "same decision, same options" 94/100, needs >= 95 (95%; a missing verdict counts as different)');
  });

  it('one reply invalid or not preserved fails 100%: the run must be clean throughout', () => {
    expect(gate({ result: result({ clean: 99 }) }).refusals).toEqual(['schema-valid and preservation-clean 99/100, needs 100/100']);
  });

  it('a run of another version, a refused run, fewer than 100 replies, or no run are each refused by name', () => {
    expect(gate({ result: result({ promptVersion: 'rsq-v1-aaaa~cccc' }) }).refusals[0]).toMatch(/^evaluation is of prompt rsq-v1-aaaa~cccc, the live prompt is/);
    expect(gate({ result: result({ refused: '11 non-replies before the 100th reply (limit 10)' }) }).refusals).toEqual(['evaluation refused: 11 non-replies before the 100th reply (limit 10)']);
    expect(gate({ result: result({ replied: 80, clean: 80 }) }).refusals).toContain('evaluation has 80 replies, needs 100');
    expect(gate({ result: null }).refusals).toEqual(['no evaluation: run `purplemux curator eval --task reshape-question`']);
  });

  it('a verdict file of another run, of another version or naming another sha256 refuses promote', () => {
    expect(gate({ judge: judge(100, { runId: 'run-0' }) }).refusals).toEqual(['judge verdicts are of run run-0, the evaluation is run run-1']);
    expect(gate({ judge: judge(100, { promptVersion: 'x' }) }).refusals[0]).toMatch(/^judge verdicts are of prompt x/);
    const swapped = judge(100);
    swapped.verdicts[3] = { ...swapped.verdicts[3], sha: 'sha-other' };
    expect(gate({ judge: swapped }).refusals).toContain('judge verdicts name 1 draft by another sha256 than the run\'s');
  });

  it('the 72 h clock of the version and every live shadow reply clean are required (consult C2 (iv))', () => {
    expect(gate({ shadowSince: null }).refusals[0]).toMatch(/^shadow has not started for rsq-v1-aaaa~bbbb/);
    expect(gate({ shadowSince: NOW - 10 * HOUR }).refusals[0]).toMatch(/^shadow of rsq-v1-aaaa~bbbb 10\.0 h of 72\.0 h/);
    expect(gate({ liveReplies: ['reshaped', 'invalid', 'not-preserved'] }).refusals)
      .toEqual([`live shadow replies of ${H}: 2 of 3 not schema-valid and preservation-clean, needs 0`]);
  });
});

describe('the evaluation order (consult C2 (i))', () => {
  it('takes held-out ids only, in a fixed hash order that does not depend on the set\'s order', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `ws-a/mc/item-${i}`);
    const order = reshapeEvalOrder(ids);
    expect(order.length).toBeGreaterThan(30);
    expect(order.every(isHeldOut)).toBe(true);
    expect(reshapeEvalOrder([...ids].reverse())).toEqual(order);
  });
});

describe('judge-import (consult C2 (iii))', () => {
  it('accepts one verdict per replied row naming its sha256', () => {
    const r = result();
    const checked = validateJudgeImport(r, 'run-1', judge(97).verdicts);
    expect(checked).toMatchObject({ ok: true });
  });

  it.each([
    ['another run', 'run-9', judge(1).verdicts, 'runId "run-9" is not the evaluation\'s run run-1'],
    ['an id outside the run', 'run-1', [{ id: 'ws-a/mc/nope', sha: 'x', verdict: 'same' }], 'verdicts[0].id "ws-a/mc/nope" is not a replied row of run run-1'],
    ['a wrong sha256', 'run-1', [{ id: 'ws-a/mc/q-0', sha: 'sha-1', verdict: 'same' }], 'verdicts[0].sha does not match the run\'s draft of ws-a/mc/q-0'],
    ['a verdict outside the two', 'run-1', [{ id: 'ws-a/mc/q-0', sha: 'sha-0', verdict: 'mostly' }], 'verdicts[0].verdict must be one of same, different'],
    ['a repeat', 'run-1', [{ id: 'ws-a/mc/q-0', sha: 'sha-0', verdict: 'same' }, { id: 'ws-a/mc/q-0', sha: 'sha-0', verdict: 'same' }], 'verdicts[1].id ws-a/mc/q-0 appears twice'],
  ])('refuses %s', (_name, runId, verdicts, error) => {
    expect(validateJudgeImport(result(), runId, verdicts)).toEqual({ ok: false, error });
  });

  it('refuses with no evaluation to judge', () => {
    expect(validateJudgeImport(null, 'run-1', [])).toMatchObject({ ok: false });
  });
});
