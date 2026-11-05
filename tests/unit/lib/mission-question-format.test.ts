import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  combineMissionChanges,
  diffMissionQuestions,
  emptyMissionChanges,
  effectiveAnswerType,
  mergeMissionChanges,
  questionLint,
  questionOfItem,
  validateMissionQuestion,
  type TMissionStoredQuestion,
} from '@/lib/mission-question-format';
import type { IMissionAttentionItem, IMissionQuestionChanges } from '@/types/mission-control';

// ADR-0037 §1-§2: one validator, every defect named with its field, the measured value and the limit.

const v2 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  formatVersion: 2,
  kind: 'question',
  title: 'Gate policy',
  decision: 'Should the lock reuse the pre-flight gate?',
  whyNow: 'Re-gating costs 13 lock-hours a day.',
  answerType: 'single',
  options: [
    { id: 'reuse', label: 'Reuse it', consequence: 'The gate runs once.', recommended: true },
    { id: 'keep', label: 'Keep re-gating' },
  ],
  recommendationWhy: '85% of lock time re-runs a passed gate.',
  storyIds: [],
  blockingScope: 'story',
  canContinue: true,
  ...over,
});

const v1 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'question',
  title: 'Choose rollout',
  context: 'Pick one.',
  storyIds: [],
  options: [{ id: 'gradual', label: 'Gradual' }, { id: 'direct', label: 'Direct' }],
  recommendation: 'gradual',
  blockingScope: 'story',
  canContinue: true,
  ...over,
});

const refused = (input: unknown, minVersion: 1 | 2 = 1) => {
  const verdict = validateMissionQuestion(input, minVersion);
  if (verdict.ok) throw new Error('expected a refusal');
  return verdict.defects.map((entry) => entry.message);
};

const label = (length: number): string => 'x'.repeat(length);

describe('validateMissionQuestion: format 2 (ADR-0037 §1)', () => {
  it('accepts a complete single question and normalizes it', () => {
    const verdict = validateMissionQuestion(v2());
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.formatVersion).toBe(2);
    expect(verdict.lint).toEqual([]);
    expect(verdict.question).toMatchObject({ formatVersion: 2, context: '', evidence: [], recommendation: null });
    expect(verdict.question.options[1]).toEqual({ id: 'keep', label: 'Keep re-gating', recommended: false, needsText: false });
  });

  it('refuses 1 option on answerType single, naming the count and the range', () => {
    expect(refused(v2({ options: [{ id: 'a', label: 'A' }], recommendationWhy: undefined })))
      .toEqual(['options: 1 option on answerType single, needs 2-4']);
  });

  it('refuses 0 and 5 options on multi', () => {
    expect(refused(v2({ answerType: 'multi', options: [], recommendationWhy: undefined })))
      .toEqual(['options: 0 options on answerType multi, needs 2-4']);
    const five = Array.from({ length: 5 }, (_, index) => ({ id: `o${index}`, label: `O${index}` }));
    expect(refused(v2({ answerType: 'multi', options: five, recommendationWhy: undefined })))
      .toEqual(['options: 5 options on answerType multi, needs 2-4']);
  });

  it('supplies Yes/No on a confirm with no options and refuses a confirm with 3', () => {
    const verdict = validateMissionQuestion(v2({ answerType: 'confirm', options: undefined, recommendationWhy: undefined }));
    expect(verdict.ok && verdict.question.options.map((option) => option.label)).toEqual(['Yes', 'No']);
    expect(refused(v2({ answerType: 'confirm', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], recommendationWhy: undefined })))
      .toEqual(['options: 3 options on answerType confirm, needs exactly 2']);
  });

  it('refuses options on text and action-done', () => {
    expect(refused(v2({ answerType: 'text' }))).toEqual(['options: 2 options on answerType text, takes none']);
    expect(refused(v2({ kind: 'action', answerType: 'action-done', whyNow: undefined })))
      .toEqual(['options: 2 options on answerType action-done, takes none']);
  });

  it('measures every over-long field against its limit', () => {
    const messages = refused(v2({
      title: label(81),
      decision: label(121),
      whyNow: label(201),
      options: [
        { id: 'reuse', label: label(87), consequence: label(161), recommended: true },
        { id: 'keep', label: 'Keep' },
      ],
      recommendationWhy: label(201),
      context: label(4001),
    }));
    expect(messages).toEqual(expect.arrayContaining([
      'title: 81 chars, at most 80',
      'decision: 121 chars, at most 120',
      'whyNow: 201 chars, at most 200',
      'options[0].label: 87 chars, at most 60',
      'options[0].consequence: 161 chars, at most 160',
      'recommendationWhy: 201 chars, at most 200',
      'context: 4001 chars, at most 4000',
    ]));
    expect(messages).toHaveLength(7);
  });

  it('lists every defect, not only the first', () => {
    expect(refused(v2({ decision: undefined, whyNow: undefined, answerType: 'sometimes' })))
      .toEqual(['answerType: "sometimes", one of single, multi, confirm, text, action-done',
        'decision: absent, required, at most 120 chars',
        'whyNow: absent, required, at most 200 chars']);
  });

  it('requires whyNow on a question and not on an action', () => {
    expect(refused(v2({ whyNow: undefined }))).toEqual(['whyNow: absent, required, at most 200 chars']);
    expect(validateMissionQuestion(v2({ kind: 'action', answerType: 'action-done', whyNow: undefined, options: [], recommendationWhy: undefined })).ok)
      .toBe(true);
  });

  it('ties kind to answerType', () => {
    expect(refused(v2({ kind: 'action', whyNow: undefined }))).toEqual(['kind: action on answerType single, answerType single needs kind question']);
  });

  it('keeps decision and labels to one line', () => {
    expect(refused(v2({ decision: 'Line one\nline two' }))).toEqual(['decision: several lines, one line']);
  });

  it('allows at most one recommended option on single and requires recommendationWhy for one', () => {
    expect(refused(v2({ options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }] })))
      .toEqual(['options: 2 recommended on answerType single, at most 1']);
    expect(validateMissionQuestion(v2({ answerType: 'multi', options: [{ id: 'a', label: 'A', recommended: true }, { id: 'b', label: 'B', recommended: true }] })).ok)
      .toBe(true);
    expect(refused(v2({ recommendationWhy: undefined }))).toEqual(['recommendationWhy: absent, required, at most 200 chars']);
  });

  it('checks evidence count, label and URL scheme', () => {
    const nine = Array.from({ length: 9 }, (_, index) => ({ label: `E${index}`, url: `https://example.com/${index}` }));
    expect(refused(v2({ evidence: nine }))).toEqual(['evidence: 9 links, at most 8']);
    expect(refused(v2({ evidence: [{ label: label(61), url: 'https://example.com' }] }))).toEqual(['evidence[0].label: 61 chars, at most 60']);
    expect(refused(v2({ evidence: [{ label: 'Run', url: 'javascript:alert(1)' }] }))).toEqual(['evidence[0].url: "javascript:alert(1)", an http or https URL']);
    expect(refused(v2({ evidence: [{ label: 'A', url: 'https://e.example/a' }, { label: 'B', url: 'https://e.example/a' }] })))
      .toEqual(['evidence[1].url: "https://e.example/a", each url once (evidence[0] has it)']);
    expect(refused(v2({ evidence: [{ label: 'F', url: 'ftp://x' }, { label: 'A', url: 'https://e.example/a' }, { label: 'B', url: 'https://e.example/a' }] })))
      .toEqual(['evidence[0].url: "ftp://x", an http or https URL', 'evidence[2].url: "https://e.example/a", each url once (evidence[1] has it)']);
  });

  it('refuses unknown fields, including the v1 recommendation and option description', () => {
    expect(refused(v2({ recommendation: 'reuse', options: [{ id: 'a', label: 'A', description: 'd' }, { id: 'b', label: 'B' }], recommendationWhy: undefined })))
      .toEqual(['recommendation: present, not a formatVersion 2 field', 'options[0].description: present, not a formatVersion 2 field']);
  });

  it('refuses duplicate option IDs and a default that names no option', () => {
    expect(refused(v2({ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], recommendationWhy: undefined })))
      .toEqual(['options: duplicate option IDs, each id once']);
    expect(refused(v2({ defaultOptionId: 'other' }))).toEqual(['defaultOptionId: "other", one of the item\'s options']);
  });

  it('refuses a formatVersion other than 2', () => {
    expect(refused(v2({ formatVersion: 3 }))).toEqual(['formatVersion: 3, 2, or absent for a v1 question']);
  });

  it('keeps source and bounds its size', () => {
    const verdict = validateMissionQuestion(v2({ source: { title: 'The original long wording' } }));
    expect(verdict.ok && verdict.question.source).toEqual({ title: 'The original long wording' });
    expect(refused(v2({ source: { context: label(16_001) } }))[0]).toMatch(/^source: \d+ chars of JSON, at most 16000$/);
  });
});

describe('validateMissionQuestion: v1 and min-version (ADR-0037 §2)', () => {
  it('accepts a v1 question under the v1 rules with its format-2 findings as lint', () => {
    const verdict = validateMissionQuestion(v1({ options: [{ id: 'only', label: label(70) }] }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.formatVersion).toBe(1);
    expect(verdict.lint.map((finding) => finding.message)).toEqual([
      'formatVersion: absent (v1), formatVersion 2 adds decision, whyNow and answerType',
      'options: 1 option on a choice question, needs 2-4, or answerType text',
      'options[0].label: 70 chars, at most 60',
    ]);
  });

  it('refuses a v1 question that breaks a v1 rule with every defect named', () => {
    expect(refused(v1({ title: '', class: 'urgent', extra: true }))).toEqual(expect.arrayContaining([
      'extra: present, not a v1 question field',
      expect.stringMatching(/^title: 0 chars, /),
      'class: 6 chars, class must be one of money, irreversible, scope, bookkeeping',
    ]));
  });

  it('refuses a v1 question at min-version 2 and names the config key', () => {
    expect(refused(v1(), 2)).toEqual(['formatVersion: absent (v1), at least 2 (fleet config mission.question-format.min-version)']);
  });

  it('accepts a v2 question at min-version 2', () => {
    expect(validateMissionQuestion(v2(), 2).ok).toBe(true);
  });
});

describe('effectiveAnswerType and lint', () => {
  it('derives a v1 answer type from kind and options', () => {
    expect(effectiveAnswerType({ kind: 'action', options: [] })).toBe('action-done');
    expect(effectiveAnswerType({ kind: 'question', options: [] })).toBe('text');
    expect(effectiveAnswerType({ kind: 'question', options: [{ id: 'a', label: 'A' }] })).toBe('multi');
  });

  it('finds nothing on a v2 question', () => {
    const verdict = validateMissionQuestion(v2());
    expect(verdict.ok && questionLint(verdict.question)).toEqual([]);
  });
});

describe('diffMissionQuestions and mergeMissionChanges (ADR-0037 §4)', () => {
  const stored = (over: Record<string, unknown> = {}): TMissionStoredQuestion => {
    const verdict = validateMissionQuestion(v2(over));
    if (!verdict.ok) throw new Error(verdict.defects.map((entry) => entry.message).join('; '));
    return verdict.question;
  };

  it('is compatible when only options were added or relabelled and context changed', () => {
    const changes = diffMissionQuestions(stored(), stored({
      answerType: 'single',
      options: [
        { id: 'reuse', label: 'Reuse it', consequence: 'The gate runs once.', recommended: true },
        { id: 'keep', label: 'Keep re-gating (status quo)' },
        { id: 'later', label: 'Later' },
      ],
      context: 'New context',
    }), 1, 2);
    expect(changes).toMatchObject({
      compatible: true,
      decision: null,
      answerType: null,
      options: { added: ['later'], removed: [], relabelled: [{ id: 'keep', from: 'Keep re-gating', to: 'Keep re-gating (status quo)' }] },
      context: true,
      evidence: false,
    });
  });

  it('is incompatible when the decision, the answer type or an option goes', () => {
    expect(diffMissionQuestions(stored(), stored({ decision: 'Another decision?' }), 1, 2)).toMatchObject({
      compatible: false,
      decision: { from: 'Should the lock reuse the pre-flight gate?', to: 'Another decision?' },
    });
    expect(diffMissionQuestions(stored(), stored({ answerType: 'multi' }), 1, 2)).toMatchObject({
      compatible: false,
      answerType: { from: 'single', to: 'multi' },
    });
    expect(diffMissionQuestions(stored(), stored({ answerType: 'confirm', options: [
      { id: 'reuse', label: 'Reuse it', recommended: true }, { id: 'no', label: 'No' }] }), 1, 2).options.removed).toEqual(['keep']);
  });

  it('records a recommendation move, recommendationWhy, whyNow and the v2 title (F2)', () => {
    const moved = diffMissionQuestions(stored(), stored({
      title: 'Gate policy, revised',
      whyNow: 'Re-gating now costs 15 lock-hours a day.',
      options: [{ id: 'reuse', label: 'Reuse it', consequence: 'The gate runs once.' }, { id: 'keep', label: 'Keep re-gating', recommended: true }],
      recommendationWhy: 'The lock owner prefers it.',
    }), 1, 2);
    expect(moved).toMatchObject({ compatible: true, recommended: { from: ['reuse'], to: ['keep'] }, recommendation: true, whyNow: true, title: true });
  });

  it('records a v1 recommendation change and nothing for an unchanged re-stamp (F2)', () => {
    const v1Stored = (recommendation: string) => validateMissionQuestion(v1({ recommendation })) as { ok: true; question: TMissionStoredQuestion };
    expect(diffMissionQuestions(v1Stored('gradual').question, v1Stored('direct').question, 1, 2)).toMatchObject({ recommendation: true, title: false });
    expect(diffMissionQuestions(stored(), stored(), 1, 2)).toEqual(emptyMissionChanges(1, 2));
  });

  it('names a needsText flip on the reworded option (F3)', () => {
    const changes = diffMissionQuestions(stored(), stored({ options: [
      { id: 'reuse', label: 'Reuse it', consequence: 'The gate runs once.', recommended: true },
      { id: 'keep', label: 'Keep re-gating', needsText: true }] }), 1, 2);
    expect(changes.options.relabelled).toEqual([{ id: 'keep', from: 'Keep re-gating', to: 'Keep re-gating', needsText: { from: false, to: true } }]);
  });

  it('combines consecutive spans: an option added then removed stays incompatible', () => {
    const added = diffMissionQuestions(stored(), stored({ answerType: 'single', options: [...(v2().options as unknown[]), { id: 'later', label: 'Later' }] }), 1, 2);
    const removed = diffMissionQuestions(stored({ options: [...(v2().options as unknown[]), { id: 'later', label: 'Later' }] }), stored(), 2, 3);
    expect(combineMissionChanges(added, removed)).toMatchObject({ fromRevision: 1, toRevision: 3, compatible: false,
      options: { added: ['later'], removed: ['later'] } });
  });

  it('merges a span and counts a revision without a record as incompatible', () => {
    const one: IMissionQuestionChanges = diffMissionQuestions(stored(), stored({ context: 'a' }), 1, 2);
    const two = diffMissionQuestions(stored({ context: 'a' }), stored({ context: 'a', evidence: [{ label: 'E', url: 'https://e.example' }] }), 2, 3);
    const merged = mergeMissionChanges(1, 3, new Map([[2, one], [3, two]]));
    expect(merged).toMatchObject({ compatible: true, context: true, evidence: true, unrecorded: [] });
    expect(mergeMissionChanges(1, 4, new Map([[2, one], [3, two]]))).toMatchObject({ compatible: false, unrecorded: [4] });
  });
});

describe('the mc-question-v2 fixtures are valid served questions', () => {
  const directory = path.resolve('tests/fixtures/mc-question-v2');
  const items = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).flatMap((name) => {
    const data = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')) as Record<string, unknown>;
    return 'before' in data ? [[`${name} before`, data.before], [`${name} after`, data.after]] : [[name, data]];
  }) as Array<[string, Record<string, unknown>]>;

  it.each(items)('%s passes the validator for its format', (_name, item) => {
    const question: Record<string, unknown> = { ...questionOfItem(item as unknown as IMissionAttentionItem) };
    if (question.formatVersion === 2) delete question.recommendation;
    const verdict = validateMissionQuestion(question);
    expect(verdict.ok ? [] : verdict.defects.map((entry) => entry.message)).toEqual([]);
  });
});
