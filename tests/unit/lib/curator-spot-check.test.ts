import { describe, expect, it } from 'vitest';
import {
  SPOT_CHECK_DECISION, buildSpotCheckQuestion, drawMatchSpotCheck, drawSpotCheck, excerpt, readSpotCheckAnswer, spotCheckContext, type ISpotCheckCandidate,
} from '@/lib/curator-spot-check';
import { OWNER_MESSAGE_CLASSES } from '@/lib/curator-tasks';
import { validateMissionQuestion } from '@/lib/mission-question-format';
import { looksLikeSecret } from '@/lib/secret-patterns';

// AC 6 with the consult ruling of 2026-11-03 (story file, ## Consult).

const candidates = (perClass: number, extra: ISpotCheckCandidate[] = []): ISpotCheckCandidate[] => [
  ...OWNER_MESSAGE_CLASSES.flatMap((label) => Array.from({ length: perClass }, (_, i) => ({ id: `ws-a/${label}-${i}`, label, text: `${label} message ${i} `.repeat(12) }))),
  ...extra,
];

const numbers = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i + 1), `ws-a/m${i + 1}`]));
const answer = (optionIds: string[], text = '', actor = 'session:owner') => ({ optionIds, text, actor, createdAt: 77 });

describe('the draw', () => {
  it('draws 30, six per class, and records the per-class counts', () => {
    const draw = drawSpotCheck(candidates(20));
    expect(draw.picked).toHaveLength(30);
    expect(draw.perClass).toEqual({ 'standing-order': 6, 'product-rule': 6, answer: 6, 'status-ping': 6, 'one-off': 6 });
    expect(new Set(draw.picked.map((p) => p.id)).size).toBe(30);
  });

  it('skips a message that looks like a credential (never redacts it) and fills a short class from the others', () => {
    const secret = { id: 'ws-a/secret', label: 'status-ping', text: 'status? token: ghp_abcdefghijklmnopqrstuvwxyz0123456789' };
    const pool = candidates(10).filter((c) => c.label !== 'status-ping' || c.id.endsWith('-0'));
    const draw = drawSpotCheck([...pool, secret]);
    expect(draw.picked.map((p) => p.id)).not.toContain('ws-a/secret');
    expect(draw.skippedSecret).toBe(1);
    expect(draw.picked).toHaveLength(30);
    expect(draw.perClass['status-ping']).toBe(1);
  });
});

describe('the item', () => {
  it('is a valid format-2 multi question with the three options and no recommendation', () => {
    const question = buildSpotCheckQuestion(drawSpotCheck(candidates(20)).picked);
    const verdict = validateMissionQuestion(question, 2);
    expect(verdict.ok ? [] : verdict.defects).toEqual([]);
    expect(verdict).toMatchObject({ ok: true, formatVersion: 2 });
    expect(question.answerType).toBe('multi');
    expect(question.decision).toBe(SPOT_CHECK_DECISION);
    expect(question.options.map((o) => [o.id, o.needsText, o.recommended])).toEqual([
      ['all-right', false, false], ['some-wrong', true, false], ['cant-judge', true, false],
    ]);
  });

  it('lists 30 numbered lines with the label display name, never the wire token', () => {
    const context = buildSpotCheckQuestion(drawSpotCheck(candidates(20)).picked).context;
    const lines = context.split('\n').slice(1);
    expect(lines).toHaveLength(30);
    expect(lines[0]).toMatch(/^1\. ".+" -> (Standing order|Product rule|Answer to a question|Status ask|One-off instruction)$/);
    expect(context).not.toMatch(/-> (standing-order|product-rule|status-ping|one-off)\b/);
  });

  it('shortens every excerpt alike to fit the 4,000-character context, and drops none', () => {
    const long = OWNER_MESSAGE_CLASSES.flatMap((label) => Array.from({ length: 6 }, (_, i) => ({ id: `${label}${i}`, label, text: 'x'.repeat(500) })));
    const context = spotCheckContext(long, 'intro');
    expect(context.length).toBeLessThanOrEqual(4000);
    expect(context.split('\n')).toHaveLength(31);
  });

  it('an excerpt strips ANSI and control characters, collapses whitespace and cuts to 90 with an ellipsis', () => {
    expect(excerpt('\u001b[31mred\u001b[0m\n\tline\u0007 two')).toBe('red line two');
    const cut = excerpt('word '.repeat(40));
    expect(cut.length).toBe(90);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('reading the answer (consult ruling 3-6)', () => {
  it('no answer is unanswered; "all right" alone is a clean check', () => {
    expect(readSpotCheckAnswer(null, numbers)).toEqual({ state: 'unanswered' });
    expect(readSpotCheckAnswer(answer(['all-right']), numbers)).toEqual({ state: 'answered', disputed: [], unjudged: [], wrongShare: 0, judged: 30, answeredAt: 77 });
  });

  it('one needs-text option takes a bare number list', () => {
    expect(readSpotCheckAnswer(answer(['some-wrong'], '3, 7 12'), numbers))
      .toEqual({ state: 'answered', disputed: ['ws-a/m3', 'ws-a/m7', 'ws-a/m12'], unjudged: [], judged: 30, wrongShare: 0.1, answeredAt: 77 });
    expect(readSpotCheckAnswer(answer(['cant-judge'], '4'), numbers))
      .toEqual({ state: 'answered', disputed: [], unjudged: ['ws-a/m4'], judged: 29, wrongShare: 0, answeredAt: 77 });
  });

  it('both options take "wrong: ...; unsure: ..."', () => {
    expect(readSpotCheckAnswer(answer(['some-wrong', 'cant-judge'], 'wrong: 3,7; unsure: 12'), numbers))
      .toMatchObject({ state: 'answered', disputed: ['ws-a/m3', 'ws-a/m7'], unjudged: ['ws-a/m12'], judged: 29 });
  });

  it.each([
    [['all-right', 'some-wrong'], '3', '"all right" selected with another option'],
    [[], 'none', 'text with no option selected'],
    [['some-wrong'], '', 'the selected option needs its numbers, e.g. "3, 7, 12"'],
    [['some-wrong'], 'three', 'the selected option needs its numbers, e.g. "3, 7, 12"'],
    [['some-wrong'], '31', 'number outside 1-30: 31'],
    [['some-wrong', 'cant-judge'], 'wrong: 3; unsure: 3', 'in both lists: 3'],
    [['some-wrong', 'cant-judge'], '3, 4', 'both options selected: the text must read "wrong: 3,7; unsure: 12"'],
    [['other'], '3', 'no known option selected'],
  ])('%j with %j is unreadable: %s', (optionIds, text, reason) => {
    expect(readSpotCheckAnswer(answer(optionIds, text), numbers)).toEqual({ state: 'unreadable', reason });
  });

  it('a system actor (the bookkeeping rule) is never the owner (review r1 F10)', () => {
    expect(readSpotCheckAnswer(answer(['all-right'], '', 'system:auto-answer'), numbers))
      .toEqual({ state: 'unreadable', reason: 'answered by system:auto-answer, not the owner' });
  });
});

describe("the matcher's spot check (consult 16-promote-gate, ruling 1)", () => {
  it('takes up to 30 covered rows, skips credential-like asks, and builds an item with its own count', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `ws-a/mc/i${i}`, label: i % 2 ? 'SO-4' : 'SO-3', text: `may I redeploy dev ${i}?` }));
    const draw = drawMatchSpotCheck([...rows, { id: 'x', label: 'SO-4', text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123' }], 30);
    expect(draw.picked).toHaveLength(30);
    expect(draw.skippedSecret).toBe(1);
    const few = drawMatchSpotCheck(rows.slice(0, 7), 30);
    const question = buildSpotCheckQuestion(few.picked, 'standing-order-matches');
    expect(validateMissionQuestion(question, 2)).toMatchObject({ ok: true });
    expect(question.decision).toBe('Which of these 7 standing-order matches are wrong?');
    expect(question.context).toMatch(/^1\. ".+" -> Covered by SO-[34]$/m);
  });
});

describe('credential patterns', () => {
  it.each([
    'AKIAABCDEFGHIJKLMNOP', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'sk-abcdefghijklmnop1234', 'password: hunter22',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig', '-----BEGIN RSA PRIVATE KEY-----', 'deadbeef'.repeat(5),
    'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7dE9', 'xoxb-1234567890-abcdef',
  ])('%s looks like a secret', (text) => {
    expect(looksLikeSecret(`see ${text} here`)).toBe(true);
  });

  it.each([
    'from now on use AEDT', '/home/user/code/acme/acme-ledger-v2/.worktrees/kit/src/billing', 'commit 0f978cc2 landed',
    'the password policy should be in the spec',
  ])('%s does not', (text) => {
    expect(looksLikeSecret(text)).toBe(false);
  });
});
