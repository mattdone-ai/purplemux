import { describe, expect, it } from 'vitest';
import {
  judgeReshape, liftDraft, mergeReshape, parseReshapeReply, preservationDefects, reshapeReplySchema, structuralDefects, type IReshapeReply, type TLiftedDraft,
} from '@/lib/curator-reshape';
import { CURATOR_TASKS } from '@/lib/curator-tasks';
import { validateMissionQuestion } from '@/lib/mission-question-format';

// Story 23 AC 3 (ADR-HFL-11 rule 3): the curator writes text only; the deterministic check refuses any reshape that
// moves option ids, count, order, recommended, answerType, class or an evidence URL.

const v1 = {
  kind: 'question', title: 'Which deploy window should the epic use for the ledger change next week?',
  context: 'The ledger change needs a window. Option a waits for Friday; option b ships tonight with a rollback ready.',
  storyIds: ['01'], recommendation: 'I recommend a: Friday is quiet.',
  options: [
    { id: 'a', label: 'Wait for the Friday quiet window and deploy then, after the freeze lifts for every team' },
    { id: 'b', label: 'Tonight' },
  ],
  blockingScope: 'story', canContinue: true, class: 'scope', defaultOptionId: 'a',
};

const v2Draft = {
  formatVersion: 2, kind: 'question', title: 'Deploy window', decision: 'Pick the deploy window for the ledger change',
  answerType: 'single', class: 'scope', storyIds: ['01'], blockingScope: 'story', canContinue: true,
  options: [
    { id: 'a', label: 'Wait for the Friday quiet window and deploy then, after the freeze lifts', recommended: true, needsText: false },
    { id: 'b', label: 'Tonight', recommended: false, needsText: false },
  ],
  evidence: [{ label: 'Runbook', url: 'https://example.test/runbook' }],
  context: 'Friday is quiet; tonight has a rollback ready.',
};

const reply = (over: Partial<IReshapeReply> = {}): IReshapeReply => ({
  title: 'Deploy window for the ledger change', decision: 'Pick the deploy window for the ledger change',
  whyNow: 'The change is ready and the epic waits on it.', recommendationWhy: 'Friday is quiet.',
  options: { a: { label: 'Friday quiet window', consequence: 'Ships Friday after the freeze.' }, b: { label: 'Tonight', consequence: 'Ships tonight with a rollback.' } },
  ...over,
});

describe('lifting a draft (story 23 AC 3)', () => {
  it('a v1 question keeps what it has: options as they are, none recommended, the answer type its card derives, no evidence', () => {
    const draft = liftDraft(v1)!;
    expect(draft).toMatchObject({ formatVersion: 2, kind: 'question', answerType: 'multi', evidence: [], class: 'scope', defaultOptionId: 'a' });
    expect(draft.options.map((o) => [o.id, o.recommended, o.needsText])).toEqual([['a', false, false], ['b', false, false]]);
    expect(draft).not.toHaveProperty('recommendation');
  });

  it('a v1 action lifts to action-done and a v1 question with no options to text', () => {
    expect(liftDraft({ ...v1, kind: 'action', options: [], defaultOptionId: undefined })?.answerType).toBe('action-done');
    expect(liftDraft({ ...v1, options: [], defaultOptionId: undefined })?.answerType).toBe('text');
  });

  it('a v2 draft is taken as written; anything else is not a draft', () => {
    expect(liftDraft(v2Draft)).toMatchObject({ answerType: 'single', evidence: v2Draft.evidence });
    expect(liftDraft({ ...v2Draft, answerType: undefined })).toBeNull();
    expect(liftDraft({ ...v1, formatVersion: 3 })).toBeNull();
    expect(liftDraft('a question')).toBeNull();
    expect(liftDraft({ ...v1, title: '' })).toBeNull();
  });

  it('structure no reshape may fix is named: one option on a choice question, a bad evidence URL', () => {
    expect(structuralDefects(liftDraft(v1)!)).toEqual([]);
    expect(structuralDefects(liftDraft({ ...v1, options: [v1.options[0]] })!).map((d) => d.field)).toEqual(['options']);
    expect(structuralDefects(liftDraft({ ...v2Draft, evidence: [{ label: 'x', url: 'ftp://nope' }] })!).map((d) => d.field)).toEqual(['evidence[0].url']);
  });
});

describe('merging and the preservation check (AC 3)', () => {
  it('a field the draft states within its limit is kept; the model writes only what fails; the original is the source', () => {
    const draft = liftDraft(v2Draft)!;
    const merged = mergeReshape(draft, reply({ decision: 'something else', title: 'other title' }), v2Draft);
    expect(merged.decision).toBe(v2Draft.decision);
    expect(merged.title).toBe('Deploy window');
    expect(merged.whyNow).toBe('The change is ready and the epic waits on it.');
    expect((merged.options as Array<{ label: string }>).map((o) => o.label)).toEqual(['Friday quiet window', 'Tonight']);
    expect(merged.context).toBe(v2Draft.context);
    expect(merged.source).toBe(v2Draft);
  });

  it('a clean reshape of a v1 question passes the format-2 validator with the original in source', () => {
    const verdict = judgeReshape(liftDraft(v1)!, reply({ recommendationWhy: '' }), v1);
    expect(verdict.label).toBe('reshaped');
    expect(validateMissionQuestion(verdict.candidate, 2).ok).toBe(true);
    expect(verdict.question?.source).toEqual(v1);
    expect(verdict.question?.options.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['options.count', (c: Record<string, unknown>) => ({ ...c, options: (c.options as unknown[]).slice(0, 1) })],
    ['options.ids', (c: Record<string, unknown>) => ({ ...c, options: [...(c.options as unknown[])].reverse() })],
    ['options.recommended', (c: Record<string, unknown>) => ({ ...c, options: (c.options as Array<Record<string, unknown>>).map((o) => ({ ...o, recommended: !o.recommended })) })],
    ['answerType', (c: Record<string, unknown>) => ({ ...c, answerType: 'multi' })],
    ['class', (c: Record<string, unknown>) => ({ ...c, class: 'bookkeeping' })],
    ['evidence.urls', (c: Record<string, unknown>) => ({ ...c, evidence: [] })],
    ['defaultOptionId', (c: Record<string, unknown>) => ({ ...c, defaultOptionId: 'b' })],
  ])('a moved %s is refused, naming what it became and what it was', (field, move) => {
    const draft = liftDraft(v2Draft)!;
    const candidate = move(mergeReshape(draft, reply(), v2Draft));
    const defects = preservationDefects(draft, candidate);
    expect(defects.map((d) => d.field)).toContain(field);
    expect(defects.find((d) => d.field === field)?.limit).toMatch(/^unchanged: was /);
  });

  it('a reply that leaves a label over 60 characters is invalid, not posted', () => {
    const long = 'x'.repeat(61);
    const verdict = judgeReshape(liftDraft(v1)!, reply({ options: { a: { label: long, consequence: 'c' }, b: { label: 'Tonight', consequence: 'c' } } }), v1);
    expect(verdict.label).toBe('invalid');
    expect(verdict.question).toBeNull();
    expect(verdict.defects.map((d) => d.message)).toContain('options[0].label: 61 chars, at most 60');
  });
});

describe('the reply (AC 3)', () => {
  it('the schema keys one entry per option id, so the model can neither drop nor reorder an option', () => {
    const schema = reshapeReplySchema(liftDraft(v1)!, false) as { properties: { options: { required: string[] } }; required: string[] };
    expect(schema.properties.options.required).toEqual(['a', 'b']);
    expect(schema.required).not.toContain('context');
    expect((reshapeReplySchema(liftDraft(v1)!, true) as { required: string[] }).required).toContain('context');
  });

  it('a reply missing an option or not JSON is unparsable, and the error never quotes the reply', () => {
    const draft = liftDraft(v1)!;
    expect(parseReshapeReply('not json at all {secret}', draft)).toEqual({ ok: false, error: 'reply is not JSON (24 chars)' });
    const missing = parseReshapeReply(JSON.stringify({ ...reply(), options: { a: reply().options.a } }), draft);
    expect(missing).toEqual({ ok: false, error: 'options.b has no label and consequence strings' });
    expect(parseReshapeReply(JSON.stringify(reply()), draft)).toMatchObject({ ok: true });
  });

  it('the task asks for the context only when the draft\'s is over 4,000 characters', () => {
    const spec = CURATOR_TASKS['reshape-question'];
    const short = liftDraft(v1)! as TLiftedDraft;
    const long = liftDraft({ ...v1, context: 'y'.repeat(4500) })!;
    const schemaOf = (draft: TLiftedDraft) => spec.schema!(spec.prompt({ text: '', draft, source: v1 }), { text: '', draft, source: v1 }) as { required: string[] };
    expect(schemaOf(short).required).not.toContain('context');
    expect(schemaOf(long).required).toContain('context');
    expect(spec.prompt({ text: '', draft: long, source: v1 }).user).toMatch(/^Also shorten the context/);
    expect(spec.cut).toBe(false);
  });

  it('the task\'s reader merges, checks and labels the reply: the label is the verdict, never draft text', () => {
    const spec = CURATOR_TASKS['reshape-question'];
    const draft = liftDraft(v1)!;
    const input = { text: JSON.stringify(v1), draft, source: v1 };
    const parsed = spec.parse!(JSON.stringify(reply({ recommendationWhy: '' })), spec.prompt(input), input);
    expect(parsed).toMatchObject({ ok: true, label: 'reshaped', span: null });
    expect(spec.rules(input)).toBe('not-reshaped');
  });
});
