import { describe, expect, it } from 'vitest';
import {
  CURATOR_MODEL, CURATOR_REQUEST_OPTIONS, CURATOR_TASKS, CURATOR_TASK_IDS, NOT_COVERED, curatorLabelName, curatorTaskName, endingAsksSomething, isCuratorTask, promptHash,
} from '@/lib/curator-tasks';

const rules = (task: keyof typeof CURATOR_TASKS, text: string, orders?: Array<{ id: string; text: string }>) =>
  CURATOR_TASKS[task].rules({ text, ...(orders ? { orders } : {}) });

describe('the curator tasks (AC 3)', () => {
  it('has the three classifiers of story 16 and the reshape of story 23, each with a versioned prompt', () => {
    expect(CURATOR_TASK_IDS).toEqual(['classify-owner-message', 'flag-owner-question', 'match-standing-order', 'reshape-question']);
    for (const task of CURATOR_TASK_IDS) {
      const spec = CURATOR_TASKS[task];
      expect(spec.promptVersion).toMatch(/^[a-z]+-v\d+-[0-9a-f]{8}$/);
      expect(spec.promptVersion.endsWith(`-${promptHash(spec.prompt, spec.labels, undefined, undefined, spec.schema)}`)).toBe(true);
    }
    expect(isCuratorTask('reshape-question')).toBe(true);
    expect(isCuratorTask('__proto__')).toBe(false);
  });

  it('story 23 leaves the classifiers\' prompt versions as story 16 hashed them, so their clocks and evidence carry over', () => {
    expect(CURATOR_TASKS['classify-owner-message'].promptVersion).toBe('com-v1-6eec31d7');
    expect(CURATOR_TASKS['flag-owner-question'].promptVersion).toBe('foq-v1-6d70d230');
    expect(CURATOR_TASKS['match-standing-order'].promptVersion).toBe('mso-v1-f36d389b');
  });

  it('classify-owner-message offers the five classes and quotes the message', () => {
    const prompt = CURATOR_TASKS['classify-owner-message'].prompt({ text: 'from now on use AEDT' });
    expect(prompt.labels).toEqual(['standing-order', 'product-rule', 'answer', 'status-ping', 'one-off']);
    expect(prompt.user).toContain('from now on use AEDT');
    expect(prompt.system).toContain('span');
  });

  it('match-standing-order offers the orders in force and not-covered', () => {
    const prompt = CURATOR_TASKS['match-standing-order'].prompt({ text: 'may I redeploy dev?', orders: [{ id: 'SO-4', text: 'Reversible work needs no approval.' }] });
    expect(prompt.labels).toEqual(['SO-4', NOT_COVERED]);
    expect(prompt.system).toContain('SO-4: Reversible work needs no approval.');
  });
});

describe('the prompt version is the prompt text (review r1 F6)', () => {
  it('an edit to the template, the labels, the model or the request options gives a new hash (r2 F1)', () => {
    const spec = CURATOR_TASKS['classify-owner-message'];
    const base = promptHash(spec.prompt, spec.labels);
    const edited = (input: Parameters<typeof spec.prompt>[0]) => {
      const p = spec.prompt(input);
      return { ...p, system: p.system.replace('Answer with JSON only.', 'Answer with JSON only, please.') };
    };
    expect(promptHash(edited, spec.labels)).not.toBe(base);
    expect(promptHash(spec.prompt, [...spec.labels].reverse())).not.toBe(base);
    expect(promptHash(spec.prompt, spec.labels, 'qwen3.5:27b')).not.toBe(base);
    expect(promptHash(spec.prompt, spec.labels, CURATOR_MODEL, { ...CURATOR_REQUEST_OPTIONS, options: { temperature: 0.2 } })).not.toBe(base);
    expect(promptHash(spec.prompt, spec.labels)).toBe(base);
  });

  it('the text a prompt is filled with does not change its version', () => {
    const spec = CURATOR_TASKS['match-standing-order'];
    expect(spec.prompt({ text: 'a', orders: [{ id: 'SO-1', text: 'x' }] }).system).toContain('SO-1: x');
    expect(spec.promptVersion).toBe(`mso-v1-${promptHash(spec.prompt, spec.labels)}`);
  });
});

describe('the rules that route when the curator does not (ADR-0038 §6)', () => {
  it('owner messages by keyword: standing order, product rule, answer, status ask, else one-off', () => {
    expect(rules('classify-owner-message', 'From now on, always give times in AEDT')).toBe('standing-order');
    expect(rules('classify-owner-message', 'The report must show the fee; the screen should total it')).toBe('product-rule');
    expect(rules('classify-owner-message', 'yes, go with (b)')).toBe('answer');
    expect(rules('classify-owner-message', 'status?')).toBe('status-ping');
    expect(rules('classify-owner-message', 'fix the failing test in billing')).toBe('one-off');
  });

  it('a turn ending is flagged only with a question mark in its last lines that addresses someone', () => {
    expect(rules('flag-owner-question', 'Done the refactor.\nShall I merge it now?')).toBe('question-to-owner');
    expect(rules('flag-owner-question', 'Two ways to do it.\nWhich do you prefer: (a) or (b)?')).toBe('question-to-owner');
    expect(rules('flag-owner-question', 'All green. Merged.')).toBe('not-a-question');
    expect(rules('flag-owner-question', 'What next? Nothing: tests pass.')).toBe('not-a-question');
  });

  it('the rules never cover a permission question', () => {
    expect(rules('match-standing-order', 'may I redeploy dev?', [{ id: 'SO-4', text: 'Reversible work needs no approval.' }])).toBe(NOT_COVERED);
  });

  it("a turn ending reaches the flag task only with a '?' in its last three lines", () => {
    expect(endingAsksSomething('a\nb\nc\nOK?')).toBe(true);
    expect(endingAsksSomething('Why?\na\nb\nc')).toBe(false);
    expect(endingAsksSomething('x?\n\n\ny\nz')).toBe(true);
  });
});

describe('labels on a face (pre-review item 1)', () => {
  it('every label has a display name; an order id reads as covered by it; anything else is a neutral word', () => {
    expect(curatorLabelName('standing-order')).toBe('Standing order');
    expect(curatorLabelName('SO-12')).toBe('Covered by SO-12');
    expect(curatorLabelName('toString')).toBe('Label not in the label map');
    expect(curatorTaskName('flag-owner-question')).toBe('Unmarked question flag');
    expect(curatorTaskName('constructor')).toBe('Task not in the label map');
  });
});
