import fs from 'fs';
import path from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import MissionControlAnswerCard from '@/components/features/mission-control/mission-control-answer-card';
import {
  createMissionDraft,
  editMissionDraft,
  missionDraftRequest,
  rebaseMissionDraft,
  reconcileMissionDraftWithItem,
} from '@/components/features/mission-control/mission-control-utils';
import type { IMissionDraft } from '@/components/features/mission-control/mission-control-utils';
import { missionSubmitState, selectOption } from '@/components/features/mission-control/question-card-model';
import { mergeMissionItem } from '@/hooks/use-mission-control';
import type { IMissionAttentionItem, IMissionSnapshot } from '@/types/mission-control';

// ADR-0037 §4-§5, driven by the shared fixture set (tests/fixtures/mc-question-v2) that the phone
// copies: one layout for every answer type and for v1, and a draft that survives revisions.

const FIXTURES = path.resolve('tests/fixtures/mc-question-v2');
const load = <T,>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
const item = (name: string): IMissionAttentionItem => load<IMissionAttentionItem>(name);
const pair = (name: string) => load<{ before: IMissionAttentionItem; after: IMissionAttentionItem }>(name);

const render = (draft: IMissionDraft): string => renderToStaticMarkup(
  <MissionControlAnswerCard draft={draft} workspaceName="Fixture" onChange={() => undefined} onAdoptCurrent={() => undefined} onSubmit={() => undefined} />,
);
const draftOf = (source: IMissionAttentionItem, edit: Parameters<typeof editMissionDraft>[1] = {}): IMissionDraft =>
  editMissionDraft(createMissionDraft(source, 'submission-1'), edit, 'submission-2');

const submitButton = (html: string, itemId: string): string => {
  const match = new RegExp(`<button[^>]*aria-describedby="${itemId}-submit-reason"[^>]*>`).exec(html);
  if (!match) throw new Error('no submit button');
  return match[0];
};
const reasonText = (html: string, itemId: string): string =>
  new RegExp(`<span id="${itemId}-submit-reason"[^>]*>([^<]*)</span>`).exec(html)?.[1] ?? '';
const order = (html: string, ...needles: string[]): number[] => needles.map((needle) => {
  const index = html.indexOf(needle);
  if (index === -1) throw new Error(`missing ${needle}`);
  return index;
});
const ascending = (values: number[]): boolean => values.every((value, index) => index === 0 || values[index - 1] < value);
const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe('question card layout per answer type (ADR-0037 §5)', () => {
  it('single: a radio list of full-width option cards with label, consequence and the recommended mark', () => {
    const question = item('single.json');
    const html = render(draftOf(question));
    expect(count(html, 'role="radio"')).toBe(3);
    expect(count(html, 'data-option=')).toBe(3);
    expect(html).toContain('Reuse the pre-flight gate');
    expect(html).toContain('The lock holds only the merge; the gate runs once.');
    expect(count(html, 'Recommended')).toBe(1);
    expect(html).toContain('Why recommended: </span>');
    expect(html).toContain('Choose one');
  });

  it('reads decision, whyNow, evidence, then the markdown context, in that order', () => {
    const question = item('single.json');
    const html = render(draftOf(question));
    expect(ascending(order(html, question.decision as string, question.whyNow as string, 'data-evidence-links', 'The pre-flight gate already ran'))).toBe(true);
    expect(html).toMatch(/<a href="https:\/\/example.com\/evidence\/lock-hours" target="_blank" rel="noopener noreferrer"/);
  });

  it('multi: checkboxes, several recommended', () => {
    const html = render(draftOf(item('multi.json')));
    expect(count(html, 'role="checkbox"')).toBe(4);
    expect(count(html, 'role="radio"')).toBe(0);
    expect(html).toContain('Choose any that apply');
  });

  it('confirm: two full-width buttons that select one option', () => {
    const question = item('confirm.json');
    const html = render(draftOf(question, { optionIds: ['yes'] }));
    expect(html.match(/<button[^>]*data-option="(yes|no)"[^>]*>/g)?.map((tag) => /aria-pressed="(true|false)"/.exec(tag)?.[1])).toEqual(['true', 'false']);
    expect(html).toContain('w-full');
    const draft = draftOf(question, { optionIds: ['yes'] });
    expect(selectOption(draft, 'no')).toEqual(['no']);
    expect(selectOption(draft, 'yes')).toEqual([]);
  });

  it('text: no choices, the answer field labelled as the answer', () => {
    const html = render(draftOf(item('text.json')));
    expect(html).not.toContain('data-option=');
    expect(html).toContain('Your answer');
    expect(reasonText(html, 'q-text')).toBe('Type your answer.');
  });

  it('action-done: the completion toggle and an optional note', () => {
    const html = render(draftOf(item('action-done.json')));
    expect(html).toContain('I&#x27;ve completed this action');
    expect(html).toContain('Add a note (optional)');
    expect(html).toContain('<code>adb tcpip 5555</code>');
  });

  it('a needsText option opens a required field, and Submit names what is missing', () => {
    const question = item('needs-text.json');
    const draft = draftOf(question, { optionIds: ['change'] });
    const html = render(draft);
    expect(html).toContain('Required for “Change something first”');
    expect(html).toMatch(/<textarea[^>]*required=""[^>]*aria-required="true"/);
    expect(missionSubmitState(draft)).toMatchObject({ disabled: true, reason: 'Add text for “Change something first” to save.' });
    const filled = editMissionDraft(draft, { optionTexts: { change: 'Split the lock work out.' }, text: 'Also tell lane B.' });
    expect(missionSubmitState(filled).disabled).toBe(false);
    expect(missionDraftRequest(filled).text).toBe('Change something first: Split the lock work out.\n\nOther: Also tell lane B.');
    // Story 33 R3: the web records its answers as `web`.
    expect(missionDraftRequest(filled).source).toBe('web');
  });

  it('"Other" is always last among the answer inputs', () => {
    for (const name of ['single.json', 'multi.json', 'confirm.json', 'needs-text.json', 'v1-item.json']) {
      const html = render(draftOf(item(name)));
      expect(html.lastIndexOf('data-option=')).toBeLessThan(html.indexOf('data-other-text'));
      expect(html).toContain('Other (always available)');
    }
  });

  it('long context: markdown with GFM, no raw HTML, links in a new tab, collapsed beyond 12 lines, original wording', () => {
    const html = render(draftOf(item('long-context.json')));
    expect(html).toContain('data-context-collapsed="true"');
    expect(html).toContain('Show all');
    expect(html).toContain('<table>');
    expect(html).toContain('<li>reason 1: 3% of the wait');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('raw html is not rendered');
    expect(html).toMatch(/<a href="https:\/\/example.com\/research#3.1" target="_blank" rel="noopener noreferrer">research 3.1<\/a>/);
    expect(html).toMatch(/<a href="https:\/\/example.com\/autolink" target="_blank"/);
    expect(html).toContain('Original wording');
    expect(html).toContain('(a) Queue first, which removes most of the wait as measured');
  });

  it('a short context is not collapsed', () => {
    const html = render(draftOf(item('single.json')));
    expect(html).toContain('data-context-collapsed="false"');
    expect(html).not.toContain('Show all');
  });

  it('a v1 item renders in the same layout with what it has', () => {
    const question = item('v1-item.json');
    const html = render(draftOf(question));
    expect(html).toContain('data-format-version="1"');
    expect(html).toContain('Choose rollout');
    expect(count(html, 'role="checkbox"')).toBe(2);
    expect(html).toContain('All tenants at once');
    expect(html).toContain('Recommendation: </span>');
    expect(html).not.toContain('data-why-now');
    expect(html).not.toContain('data-evidence-links');
  });

  it('shows the blocked cost only when the server serves it', () => {
    expect(render(draftOf(item('single.json')))).not.toContain('data-blocked-cost');
    const html = render(draftOf({ ...item('single.json'), blocked: { items: 3, hours: 5.25, critical: true } }));
    expect(html).toContain('Blocking 3 items');
    expect(html).toContain('5.3 h waiting');
    expect(html).toContain('on the critical path');
  });
});

describe('Submit is never disabled without a visible reason (ADR-0037 §4)', () => {
  const drafts = (): Array<[string, IMissionDraft]> => {
    const names = ['single.json', 'multi.json', 'confirm.json', 'text.json', 'action-done.json', 'needs-text.json', 'long-context.json', 'v1-item.json'];
    return names.flatMap((name) => {
      const source = item(name);
      const first = source.options[0]?.id;
      const needsText = source.options.find((option) => option.needsText)?.id;
      return [
        [`${name} empty`, draftOf(source)],
        [`${name} chosen`, first ? draftOf(source, { optionIds: [first] }) : draftOf(source, { text: 'An answer' })],
        [`${name} submitting`, { ...draftOf(source, { text: 'x' }), status: 'submitting' }],
        [`${name} error`, { ...draftOf(source, { text: 'x' }), status: 'error', error: 'Network failed' }],
        [`${name} answered elsewhere`, { ...draftOf(source, { text: 'x' }), status: 'conflict', currentItem: { ...source, state: 'answered' } }],
        [`${name} back to candidate`, { ...draftOf(source, { text: 'x' }), status: 'conflict', currentItem: { ...source, state: 'candidate' } }],
        ...(needsText ? [[`${name} needsText unfilled`, draftOf(source, { optionIds: [needsText] })] as [string, IMissionDraft]] : []),
      ] as Array<[string, IMissionDraft]>;
    });
  };

  it.each(drafts())('%s', (_name, draft) => {
    const html = render(draft);
    const button = submitButton(html, draft.item.id);
    const state = missionSubmitState(draft);
    expect(button.includes('disabled=""')).toBe(state.disabled);
    if (state.disabled) {
      expect(state.reason).toBeTruthy();
      expect(reasonText(html, draft.item.id)).toBe(state.reason?.replace(/&/g, '&amp;'));
    }
  });
});

describe('the draft across revisions (ADR-0037 §4, AC 6)', () => {
  it('a compatible revision keeps the selection, the text and the answered revision, and marks what changed', () => {
    const { before, after } = pair('revision-compatible.json');
    const draft = draftOf(before, { optionIds: ['keep'], text: 'Only until story 02 lands.' });
    const next = reconcileMissionDraftWithItem(draft, after) as IMissionDraft;
    expect(next).toMatchObject({ optionIds: ['keep'], text: 'Only until story 02 lands.', expectedRevision: 1, status: 'editing' });
    expect(next.item.revision).toBe(2);
    expect(next.notice).toMatchObject({ compatible: true, cleared: [] });
    expect(missionSubmitState(next).disabled).toBe(false);
    const html = render(next);
    expect(html).toContain('data-revision-notice="compatible"');
    expect(html).toContain('Updated while you answered: options added, option wording, context. Your choices and text are kept.');
    expect(html).toMatch(/data-option="later"[\s\S]*?>New</);
    expect(html).toMatch(/data-option="keep"[\s\S]*?>Changed</);
    expect(html).toContain('Keep re-gating (status quo)');
    expect(missionDraftRequest(next)).toMatchObject({ expectedRevision: 1, optionIds: ['keep'] });
  });

  it('an incompatible revision clears only the removed selection, keeps the text, and shows old and new wording', () => {
    const { before, after } = pair('revision-incompatible.json');
    const draft = draftOf(before, { optionIds: ['trial'], text: 'Seven days is enough.' });
    const next = reconcileMissionDraftWithItem(draft, after) as IMissionDraft;
    expect(next).toMatchObject({ optionIds: [], text: 'Seven days is enough.', expectedRevision: 2, status: 'editing' });
    expect(next.notice).toMatchObject({ compatible: false, cleared: ['trial'] });
    const html = render(next);
    expect(html).toContain('data-revision-notice="incompatible"');
    expect(html).toContain('Changed: decision, options removed. Your text is kept; review your choices.');
    expect(html).toContain(before.decision as string);
    expect(html).toContain(after.decision as string);
    expect(html).toContain('Removed: “Trial it for 7 days”');
    expect(html).toContain('Cleared your choice “Trial it for 7 days”');
    expect(submitButton(html, next.item.id)).not.toContain('disabled=""');
  });

  it('an incompatible revision keeps a selection whose option is unchanged', () => {
    const { before, after } = pair('revision-incompatible.json');
    const next = reconcileMissionDraftWithItem(draftOf(before, { optionIds: ['reuse'] }), after) as IMissionDraft;
    expect(next).toMatchObject({ optionIds: ['reuse'], expectedRevision: 2 });
    expect(missionSubmitState(next).disabled).toBe(false);
  });

  it('a 409 from the server moves the draft to the current revision with Submit enabled', () => {
    const { before, after } = pair('revision-compatible.json');
    const attempted = { ...draftOf(before, { optionIds: ['keep'] }), hasAttempted: true };
    const next = rebaseMissionDraft(attempted, after, { ...after.changes!, compatible: false, unrecorded: [2] }, 'submission-3');
    expect(next).toMatchObject({ expectedRevision: 2, optionIds: [], submissionId: 'submission-3', status: 'editing' });
    expect(next.notice?.cleared).toEqual(['keep']);
    expect(render(next)).toContain('Changed: options added, option wording, context, other fields.');
  });

  it('no open revision leaves Submit disabled for a draft that still holds an answer (162 -> 0)', () => {
    for (const name of ['revision-compatible.json', 'revision-incompatible.json']) {
      const { before, after } = pair(name);
      for (const optionId of before.options.map((option) => option.id)) {
        const next = reconcileMissionDraftWithItem(draftOf(before, { optionIds: [optionId], text: 'context' }), after) as IMissionDraft;
        expect(missionSubmitState(next)).toMatchObject({ disabled: false, reason: null });
      }
    }
  });
});

describe('a served token this client does not know', () => {
  it('an unknown answerType renders as the kind and options would, never the token', () => {
    const question = { ...item('single.json'), answerType: 'ranked' as unknown as IMissionAttentionItem['answerType'] };
    const html = render(draftOf(question));
    expect(html).not.toContain('ranked');
    expect(count(html, 'role="checkbox"')).toBe(3);
    expect(html).toContain('Choose any that apply');
  });

  it('an unknown answer type in a revision record reads as a neutral phrase', () => {
    const { before, after } = pair('revision-incompatible.json');
    const next = rebaseMissionDraft(draftOf(before), after,
      { ...after.changes!, answerType: { from: 'single', to: 'ranked' as unknown as 'multi' } }, 's3');
    const html = render(next);
    expect(html).toContain('Answer type: Choose one → another answer type');
    expect(html).not.toContain('ranked');
  });
});

// Round 2 (F1-F4): the reviewer's revision cases, built from the single fixture.
describe('the draft tracks the revision the owner chose on (F1)', () => {
  const base = item('single.json');
  const option = (id: string, label: string, extra: Record<string, unknown> = {}) => ({ id, label, recommended: false, needsText: false, ...extra });
  const at = (revision: number, options: IMissionAttentionItem['options'], over: Partial<IMissionAttentionItem> = {}): IMissionAttentionItem =>
    ({ ...base, revision, options, recommendationWhy: undefined, ...over });
  const r1 = at(1, [option('a', 'Keep'), option('b', 'Stop')]);
  const r2 = at(2, [option('a', 'Keep'), option('b', 'Stop'), option('c', 'Deploy to dev')]);
  const choose = (draft: IMissionDraft, optionIds: string[]) => editMissionDraft(draft, { optionIds }, 'submission-x');
  const step = (draft: IMissionDraft, next: IMissionAttentionItem) => reconcileMissionDraftWithItem(draft, next, 'submission-y') as IMissionDraft;

  it('A: added, chosen, then reworded: kept on the answered revision, marked Changed, span compatible', () => {
    const r3 = at(3, [option('a', 'Keep'), option('b', 'Stop'), option('c', 'Deploy to PROD')]);
    const draft = step(choose(step(createMissionDraft(r1, 's1'), r2), ['c']), r3);
    expect(draft).toMatchObject({ optionIds: ['c'], expectedRevision: 1 });
    expect(draft.notice).toMatchObject({ compatible: true, cleared: [], step: { options: { relabelled: [{ id: 'c', from: 'Deploy to dev', to: 'Deploy to PROD' }] } } });
    expect(draft.notice?.changes).toMatchObject({ fromRevision: 1, toRevision: 3, compatible: true });
    const html = render(draft);
    expect(html).toMatch(/data-option="c"[\s\S]*?>Changed</);
    expect(html).not.toMatch(/data-option="c"[\s\S]*?>New</);
    expect(html).toContain('Reworded: <span class="line-through decoration-foreground/30">Deploy to dev</span> → Deploy to PROD');
    expect(missionSubmitState(draft)).toMatchObject({ disabled: false, reason: null });
    expect(missionDraftRequest(draft)).toMatchObject({ expectedRevision: 1, optionIds: ['c'] });
  });

  it('B: added, chosen, then reworded with another option removed: the reworded choice is cleared, r3 answered', () => {
    const r3 = at(3, [option('a', 'Keep'), option('c', 'Deploy to PROD')]);
    const draft = step(choose(step(createMissionDraft(r1, 's1'), r2), ['c']), r3);
    expect(draft).toMatchObject({ optionIds: [], expectedRevision: 3 });
    expect(draft.notice).toMatchObject({ compatible: false, cleared: ['c'] });
    const html = render(draft);
    expect(html).toContain('Removed: “Stop”');
    expect(html).toContain('Cleared your choice “Deploy to PROD”: it was removed or reworded.');
    expect(missionSubmitState(draft)).toMatchObject({ disabled: true, reason: 'Choose an option or type an answer.' });
    expect(reasonText(html, draft.item.id)).toBe('Choose an option or type an answer.');
    expect(missionDraftRequest(choose(draft, ['a']))).toMatchObject({ expectedRevision: 3, optionIds: ['a'] });
  });

  it('C: added, chosen, then removed: the span is incompatible, the gone choice is cleared by its label, r3 answered', () => {
    const multi = (revision: number, options: ReturnType<typeof option>[]) => at(revision, options, { answerType: 'multi' });
    const draft = step(choose(step(createMissionDraft(multi(1, [option('a', 'Keep'), option('b', 'Stop')]), 's1'),
      multi(2, [option('a', 'Keep'), option('b', 'Stop'), option('opt-later-7', 'Decide later')])), ['a', 'opt-later-7']),
    multi(3, [option('a', 'Keep'), option('b', 'Stop')]));
    expect(draft).toMatchObject({ optionIds: ['a'], expectedRevision: 3 });
    expect(draft.notice).toMatchObject({ compatible: false, cleared: ['opt-later-7'] });
    const html = render(draft);
    expect(html).toContain('Cleared your choice “Decide later”');
    expect(html).not.toContain('opt-later-7”');
    expect(html).not.toMatch(/>[^<]*opt-later-7/);
    expect(missionSubmitState(draft)).toMatchObject({ disabled: false, reason: null });
    expect(missionDraftRequest(draft)).toMatchObject({ expectedRevision: 3, optionIds: ['a'] });
  });

  it('an option no known revision names reads as neutral words, never its id (F4)', () => {
    const draft = rebaseMissionDraft({ ...draftOf(r1), optionIds: ['ghost-9'] }, at(2, r1.options), undefined, 's3');
    expect(draft.notice?.cleared).toEqual(['ghost-9']);
    const html = render(draft);
    expect(html).toContain('Cleared your choice an option that was removed');
    expect(html).not.toContain('ghost-9</');
    expect(html).not.toMatch(/>[^<]*ghost-9/);
  });

  it('shows the recommendation move a -> b, and no notice for a re-stamp with no visible change (F2)', () => {
    const c1 = at(1, [option('a', 'Keep', { recommended: true }), option('b', 'Stop')], { recommendationWhy: 'a is safe' });
    const c2 = at(2, [option('a', 'Keep'), option('b', 'Stop', { recommended: true })], { recommendationWhy: 'b is safe now' });
    const moved = step(choose(createMissionDraft(c1, 's1'), ['a']), c2);
    expect(moved).toMatchObject({ optionIds: ['a'], expectedRevision: 1 });
    const html = render(moved);
    expect(html).toContain('Updated while you answered: recommendation. Your choices and text are kept.');
    expect(html).toContain('Recommended: “Keep” → “Stop”');
    const restamped = step(choose(createMissionDraft(c1, 's1'), ['a']), { ...c1, revision: 2 });
    expect(restamped).toMatchObject({ optionIds: ['a'], expectedRevision: 1, notice: { compatible: true } });
    expect(render(restamped)).not.toContain('data-revision-notice');
  });
});

describe('typed text is never dropped (F3)', () => {
  const needs = item('needs-text.json');
  const withText = editMissionDraft(createMissionDraft(needs, 's1'), { optionIds: ['change'], optionTexts: { change: 'Split the lock work out.' }, text: 'Tell lane B.' }, 's2');

  it('a compatible revision that turns needsText off moves the text into Other under the option label', () => {
    const next = reconcileMissionDraftWithItem(withText, { ...needs, revision: 2, options: needs.options.map((entry) =>
      entry.id === 'change' ? { ...entry, needsText: false } : entry) }) as IMissionDraft;
    expect(next).toMatchObject({ optionIds: ['change'], optionTexts: {}, text: 'Tell lane B.\n\nChange something first: Split the lock work out.', expectedRevision: 1 });
    const html = render(next);
    expect(html).toContain('Moved your text for “Change something first” into Other: the option no longer takes it.');
    expect(html).toContain('“Change something first” (no longer needs text)');
    expect(missionDraftRequest(next).text).toBe('Tell lane B.\n\nChange something first: Split the lock work out.');
  });

  it('an incompatible revision that clears the option moves its text into Other under the old label', () => {
    const next = reconcileMissionDraftWithItem(withText, { ...needs, revision: 2, options: needs.options.map((entry) =>
      entry.id === 'change' ? { ...entry, label: 'Rewrite the scope' } : entry), decision: 'Approve the story 20 scope as rewritten?' }) as IMissionDraft;
    expect(next).toMatchObject({ optionIds: [], expectedRevision: 2, text: 'Tell lane B.\n\nChange something first: Split the lock work out.' });
    expect(next.notice).toMatchObject({ cleared: ['change'], moved: ['change'] });
    expect(render(next)).toContain('data-moved-text');
  });
});

describe('a stale snapshot after a 409 (31-C1)', () => {
  it('409 rebase, then an older snapshot, then the current one: editing, Submit enabled, answer sent against r\'', () => {
    const { before, after } = pair('revision-incompatible.json');
    const submitted = { ...draftOf(before, { optionIds: ['reuse'] }), status: 'submitting' as const, hasAttempted: true };
    const rebased = rebaseMissionDraft(submitted, after, after.changes!, 'submission-r2');
    const stale = reconcileMissionDraftWithItem(rebased, before) as IMissionDraft;
    expect(stale).toBe(rebased);
    const current = reconcileMissionDraftWithItem(stale, after) as IMissionDraft;
    expect(current).toMatchObject({ status: 'editing', expectedRevision: 2, currentItem: null, optionIds: ['reuse'] });
    expect(missionSubmitState(current)).toMatchObject({ disabled: false, reason: null });
    expect(missionDraftRequest(current)).toMatchObject({ expectedRevision: 2, optionIds: ['reuse'], submissionId: 'submission-r2' });
    expect(submitButton(render(current), after.id)).not.toContain('disabled=""');
  });

  it('a stale answered or cancelled row older than the draft does not turn it into a conflict', () => {
    const { before, after } = pair('revision-incompatible.json');
    const rebased = rebaseMissionDraft(draftOf(before, { optionIds: ['reuse'] }), after, after.changes!, 's');
    expect(reconcileMissionDraftWithItem(rebased, { ...before, state: 'cancelled' })).toBe(rebased);
  });

  it('the page snapshot takes the 409 current item when it is newer, and keeps a newer held one', () => {
    const { before, after } = pair('revision-incompatible.json');
    const snapshot = { items: [before] } as unknown as IMissionSnapshot;
    expect(mergeMissionItem(snapshot, after).items).toEqual([after]);
    const newer = { items: [after] } as unknown as IMissionSnapshot;
    expect(mergeMissionItem(newer, before)).toBe(newer);
  });
});

describe('a suggested answer from an owner message (story 23 AC 2)', () => {
  it('shows each suggestion as a pointer with the quoted span, never as a chosen option', () => {
    const question = { ...item('single.json'), suggestedAnswers: [{ entryId: 'm9', span: 'go with the pre-flight gate', at: Date.now() - 120_000 }] };
    const html = render(draftOf(question));
    expect(html).toContain('data-suggested-answers');
    expect(html).toContain('Your message 2m ago may answer this');
    expect(html).toContain('<q class="text-foreground">go with the pre-flight gate</q>');
    expect(html).toContain('It is not an answer: choose below.');
    expect(count(html, 'aria-checked="true"')).toBe(0);
  });

  it('an item without suggestions shows none', () => {
    expect(render(draftOf(item('single.json')))).not.toContain('data-suggested-answers');
  });
});
