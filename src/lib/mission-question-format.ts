import { z } from 'zod';
import { ATTENTION_CLASSES } from '@/lib/attention-class';
import type {
  IMissionAttentionClassInput,
  IMissionAttentionItem,
  IMissionEvidenceLink,
  IMissionOption,
  IMissionQuestion,
  IMissionQuestionChanges,
  IMissionQuestionDefect,
  TMissionAnswerType,
} from '@/types/mission-control';

// Mission Control question format (ADR-0037). Pure: the server validates with it and the web
// card and the CLI read the same rules, so a client never guesses what the server would refuse.

export type TMissionStoredQuestion = IMissionQuestion & IMissionAttentionClassInput;

export const ANSWER_TYPES = ['single', 'multi', 'confirm', 'text', 'action-done'] as const satisfies readonly TMissionAnswerType[];

export const QUESTION_LIMITS = {
  decision: 120,
  whyNow: 200,
  title: 80,
  label: 60,
  consequence: 160,
  recommendationWhy: 200,
  evidence: 8,
  evidenceLabel: 60,
  url: 2048,
  context: 4000,
  storyIds: 20,
  id: 128,
  source: 16_000,
} as const;

const OPTION_COUNT: Record<TMissionAnswerType, { min: number; max: number }> = {
  single: { min: 2, max: 4 },
  multi: { min: 2, max: 4 },
  confirm: { min: 2, max: 2 },
  text: { min: 0, max: 0 },
  'action-done': { min: 0, max: 0 },
};

const CONFIRM_DEFAULT_OPTIONS: IMissionOption[] = [
  { id: 'yes', label: 'Yes', recommended: false, needsText: false },
  { id: 'no', label: 'No', recommended: false, needsText: false },
];

const V2_FIELDS = new Set([
  'formatVersion', 'kind', 'title', 'decision', 'whyNow', 'answerType', 'options', 'recommendationWhy', 'evidence',
  'context', 'storyIds', 'blockingScope', 'canContinue', 'class', 'defaultOptionId', 'source',
]);
const V2_OPTION_FIELDS = new Set(['id', 'label', 'consequence', 'recommended', 'needsText']);
const V2_EVIDENCE_FIELDS = new Set(['label', 'url']);

/** What an owner face shows for a selected option id that the question no longer holds: never the id (ADR-0037 amendment D2). */
export const OPTION_NOT_IN_QUESTION_LABEL = 'an option no longer in the question';

/**
 * The labels of the selected options, read from one label map of the question's own options (own-property check, so
 * an id such as `constructor` never reads a prototype member). An id the question lacks reads as the neutral words.
 */
export const selectedOptionLabels = (options: ReadonlyArray<{ id: string; label: string }>, optionIds: readonly string[]): string[] => {
  const labels: Record<string, string> = Object.fromEntries(options.map((option) => [option.id, option.label]));
  return optionIds.map((optionId) => (Object.hasOwn(labels, optionId) ? labels[optionId] : OPTION_NOT_IN_QUESTION_LABEL));
};

export const defect = (field: string, measured: string, limit: string): IMissionQuestionDefect => ({
  field,
  measured,
  limit,
  message: `${field}: ${measured}, ${limit}`,
});

const chars = (value: string): string => `${value.length} chars`;
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const typeName = (value: unknown): string => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

const measure = (value: unknown): string => {
  if (typeof value === 'string') return chars(value.trim());
  if (Array.isArray(value)) return plural(value.length, 'item');
  if (value === undefined) return 'absent';
  return typeName(value);
};

const valueAt = (input: unknown, path: ReadonlyArray<PropertyKey>): unknown =>
  path.reduce<unknown>((current, key) => (current !== null && typeof current === 'object'
    ? (current as Record<PropertyKey, unknown>)[key]
    : undefined), input);

const fieldName = (path: ReadonlyArray<PropertyKey>): string =>
  path.reduce<string>((name, key) => (typeof key === 'number' ? `${name}[${key}]` : name ? `${name}.${String(key)}` : String(key)), '') || 'question';

const v1Id = z.string().trim().min(1).max(128);
const v1ShortText = z.string().trim().min(1).max(500);
const v1Option = z.object({
  id: v1Id,
  label: v1ShortText,
  description: z.string().trim().max(8000).optional(),
}).strict();

/** The v1 question rules, unchanged since ADR-0031. */
export const v1QuestionSchema = z.object({
  kind: z.enum(['question', 'action']),
  title: v1ShortText,
  context: z.string().trim().min(1).max(8000),
  storyIds: z.array(v1Id).max(20),
  options: z.array(v1Option).max(20),
  recommendation: z.string().trim().max(8000).nullable(),
  blockingScope: z.enum(['none', 'story', 'run']),
  canContinue: z.boolean(),
  class: z.enum(ATTENTION_CLASSES, { error: `class must be one of ${ATTENTION_CLASSES.join(', ')}` }).optional(),
  defaultOptionId: z.string({ error: 'defaultOptionId must be an option ID' }).trim()
    .min(1, { error: 'defaultOptionId must be a nonempty option ID' })
    .max(128, { error: 'defaultOptionId must be at most 128 characters' })
    .optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.storyIds).size !== value.storyIds.length) {
    context.addIssue({ code: 'custom', path: ['storyIds'], message: 'duplicate story IDs' });
  }
  if (new Set(value.options.map((entry) => entry.id)).size !== value.options.length) {
    context.addIssue({ code: 'custom', path: ['options'], message: 'duplicate option IDs' });
  }
  if (value.defaultOptionId === undefined) return;
  if (value.kind === 'action') {
    context.addIssue({ code: 'custom', path: ['defaultOptionId'], message: 'defaultOptionId is refused on an action item' });
  } else if (!value.options.some((entry) => entry.id === value.defaultOptionId)) {
    context.addIssue({ code: 'custom', path: ['defaultOptionId'], message: "defaultOptionId must name one of the item's options" });
  }
});

const v1Defects = (input: unknown): { question: TMissionStoredQuestion | null; defects: IMissionQuestionDefect[] } => {
  const result = v1QuestionSchema.safeParse(input);
  if (result.success) return { question: result.data, defects: [] };
  return {
    question: null,
    defects: result.error.issues.map((issue) => {
      if (issue.code === 'unrecognized_keys') {
        return defect(issue.keys.map((key) => fieldName([...issue.path, key])).join(', '), 'present', 'not a v1 question field');
      }
      return defect(fieldName(issue.path), measure(valueAt(input, issue.path)), issue.message);
    }),
  };
};

/** The answer type a question is answered by; a v1 item derives one from its kind and options. */
export const effectiveAnswerType = (question: Pick<IMissionQuestion, 'kind' | 'options' | 'answerType'>): TMissionAnswerType => {
  if (question.answerType) return question.answerType;
  if (question.kind === 'action') return 'action-done';
  return question.options.length === 0 ? 'text' : 'multi';
};

/** The one line that names the decision: `decision` on v2, `title` on v1. */
export const questionDecision = (question: Pick<IMissionQuestion, 'decision' | 'title'>): string =>
  question.decision ?? question.title;

/** The format-2 findings of a v1 question: what it would need to pass at min-version 2. */
export const questionLint = (question: TMissionStoredQuestion): IMissionQuestionDefect[] => {
  if (question.formatVersion === 2) return [];
  const findings = [defect('formatVersion', 'absent (v1)', 'formatVersion 2 adds decision, whyNow and answerType')];
  if (question.title.length > QUESTION_LIMITS.title) {
    findings.push(defect('title', chars(question.title), `at most ${QUESTION_LIMITS.title}`));
  }
  if (question.kind === 'question' && question.options.length < 2) {
    findings.push(defect('options', `${plural(question.options.length, 'option')} on a choice question`,
      'needs 2-4, or answerType text'));
  }
  if (question.options.length > 4) {
    findings.push(defect('options', plural(question.options.length, 'option'), 'at most 4'));
  }
  question.options.forEach((option, index) => {
    if (option.label.length > QUESTION_LIMITS.label) {
      findings.push(defect(`options[${index}].label`, chars(option.label), `at most ${QUESTION_LIMITS.label}`));
    }
  });
  if (question.context.length > QUESTION_LIMITS.context) {
    findings.push(defect('context', chars(question.context), `at most ${QUESTION_LIMITS.context}`));
  }
  return findings;
};

/*
 * Owner steps (vel-MC-ACT; PR #60 r6). An owner step is a clause that asks the owner to act outside his answer:
 *   - an imperative ("Copy the token into the vault", "Press Squash and merge", "Set can_admins_bypass to false"), or
 *   - "you <present verb>" at the start of a clause ("A one-off: you run the script", "Or you sign in with a role",
 *     "If you choose (b), you put the key in"), or "only you <verb>" ("only you edit that file"), or
 *   - a phrase that addresses the owner's steps ("Your steps", "please ask the vendor to ...", "steps from you").
 * It is NOT, by the sentence it sits in:
 *   - a past reference: a date ("On 21 Oct, you set ...") or "you" with a past verb ("you wrote", "you ruled");
 *   - a relative clause or a condition: "you" not at a clause start ("the list you accept", "until you accept");
 *   - a request for information ("please tell us whether ...", "please confirm which ...");
 *   - an answer instruction ("Reply with ...", "Type the names in the text box", "Tick the ones that apply");
 *   - an agent plan: after "Fix:", "Plan:", "We recommend", "Recommended:", a sentence led by "I <verb>", "we <step>"
 *     or a role ("The role may read the password, open a tunnel"), or a "lets the agent ..." capability list;
 *   - a question ("Run this migration tonight, or wait?").
 * A lettered item ("(a) Add your role", "(b) add a calendar") is an option of the decision: an imperative there is a
 * step only when its object is the owner's own ("your", "yourself").
 * Tuned on tests/fixtures/mission-questions/owner-steps.json, whose `labelled` table is the measurable target.
 */
const STEP_VERBS = 'click|tap|press|paste|copy|run|open|go|navigate|sign|log|enter|type|select|upload|download|install|rotate|add|set|update|create|merge|restart|reset|grant|send|connect|plug|unplug|approve|visit|put';
/** What the owner does to a third party or an item ("Please ask the vendor to ...", "please cancel it"). */
const PARTY_VERBS = 'ask|tell|email|message|contact|call|forward|share|cancel|disable|enable|re-enable|delete|remove|pay|book|schedule';
const YOU_VERBS = `${STEP_VERBS}|${PARTY_VERBS}|check|edit|change|accept`;
/** Not a request for information: "tell us", "let me know", "<verb> whether|which|..." (the owner answers it). */
const INFO_REQUEST = String.raw`(?!(?:tell|let)\s+(?:us|me)\b)(?!\w+(?:\s+(?:us|me|it|this|that))?\s+(?:whether|if|which|what|when|where|how|who|why)\b)`;

/** "you <do>" at a clause start: after a numbered marker, a short label, or a connective. */
const YOU_STEP = new RegExp(String.raw`^(?:\(?\d{1,2}\)\s+)?(?:[^:,]{1,40}:\s+)?(?:(?:then|and|so|now|next|first|instead|also)\s+)?you\s+(?:then\s+|can\s+|must\s+)?${INFO_REQUEST}(?:${YOU_VERBS})\b(?!-)`, 'i');
/** "only you <do>": the owner is the only one who can act ("which only you can edit"). */
const ONLY_YOU = new RegExp(String.raw`\bonly\s+you\s+(?:can\s+|could\s+)?(?:${YOU_VERBS})\b(?!-)`, 'i');
/** A sentence about the past: a date, a past marker, or "you" with a past verb. */
const PAST_MARKER = /\b(?:on\s+\d{1,2}\s+[A-Z][a-z]{2,8}|on\s+[A-Z][a-z]{2,8}\s+\d{1,2}|on\s+\d{4}-\d{2}-\d{2}|yesterday|earlier|last\s+(?:week|night|time|month)|ago|previously)\b/i;
const PAST_YOU = /\byou\s+(?:wrote|said|ruled|asked|chose|answered|approved|decided|agreed|picked|named|gave|replied|noted|told|ran|sent|merged|opened|added|granted|rotated|signed)\b/i;

interface IStepPhrase { pattern: RegExp; name: string; inQuestion: boolean; perClause?: boolean; owner?: boolean }
/**
 * Phrases read per sentence. `inQuestion: false` skips a sentence that asks; `perClause` tests each clause from its
 * start; `owner` marks a "you" phrase, which a past sentence never carries.
 */
const OWNER_STEP_PHRASES: readonly IStepPhrase[] = [
  { pattern: /\b(?:your|owner|manual)\s+steps?\b/i, name: "'Your steps'", inQuestion: true },
  { pattern: /\bsteps\s+for\s+you\b/i, name: "'steps for you'", inQuestion: true },
  { pattern: /^\s*steps\s*:/i, name: "'Steps:'", inQuestion: true },
  { pattern: new RegExp(`\\bplease\\s+${INFO_REQUEST}(?:${STEP_VERBS}|${PARTY_VERBS})\\b`, 'i'), name: "'please <do>'", inQuestion: true },
  { pattern: new RegExp(`\\byou(?:'ll|\\s+will)?\\s+(?:need|have)\\s+to\\s+(?:${STEP_VERBS})\\b`, 'i'), name: "'you need to <do>'", inQuestion: true },
  { pattern: new RegExp(`\\byou\\s+must\\s+(?:${STEP_VERBS})\\b`, 'i'), name: "'you must <do>'", inQuestion: true },
  { pattern: /\b(?:steps?|actions?)\s+from\s+you\b/i, name: "'steps from you'", inQuestion: true },
  { pattern: new RegExp(`\\bneed\\s+you\\s+to\\s+${INFO_REQUEST}(?:${YOU_VERBS})\\b`, 'i'), name: "'need you to <do>'", inQuestion: true },
  { pattern: YOU_STEP, name: "'you <do>'", inQuestion: false, perClause: true, owner: true },
  { pattern: ONLY_YOU, name: "'only you <do>'", inQuestion: false, owner: true },
  // A message for an outside party: "Paste this to the vendor's desk:", "Send to the bank contact:".
  { pattern: /\b(?:paste|send|forward|post)\s+(?:this\s+|the\s+(?:following|text\s+below)\s+)?to\s+[^.:?\n]{1,60}:/i, name: "'Paste to <party>:'", inQuestion: true },
];

/**
 * An imperative verb at the start of a clause, followed by what makes it a command, since most of these verbs are also
 * nouns or a question's own words ("Press coverage", "Run time", "Open question", "Copy of", "Type:", "Click rate",
 * "Go to production", "Press on", "Open to").
 */
const OBJECT = String.raw`(?:(?:the|your|yourself|it|this|that|these|a|an)\b|https?:|` + '`' + String.raw`|"|[A-Za-z][\w-]*_[\w.-]*)`;
const IMPERATIVE_VERBS = 'paste|copy|enter|type|select|upload|download|install|rotate|visit|add|set|update|create|merge|restart|reset|grant|send|connect|unplug|approve|run';
const OWNER_STEP_IMPERATIVES: readonly RegExp[] = [
  new RegExp(String.raw`^(?:${IMPERATIVE_VERBS})\s+${OBJECT}`, 'i'),
  new RegExp(String.raw`^(?:click|tap)\s+(?:on\s+)?${OBJECT}`, 'i'),
  new RegExp(String.raw`^(?:plug\s+in|paste\s+(?:to|into))\b`, 'i'),
  // A UI label after click, tap, press or open ("Click Approve", "Press Enter", "open Environments"); not a
  // capitalised heading ("Press Coverage:").
  /^(?:[Cc]lick|[Tt]ap|[Pp]ress|[Oo]pen)\s+(?![\w-]+\s*:)[A-Z]/,
  /^(?:[Gg]o|[Nn]avigate)\s+to\s+(?:the\b|your\b|https?:|`|[A-Z])/,
  new RegExp(String.raw`^(?:sign|log)\s+in\s+(?:to|with|as|again|using)\b`, 'i'),
  new RegExp(String.raw`^open\s+(?:(?:the|your|a|an)\b|https?:|` + '`' + String.raw`)(?!\s*(?:questions?|items?|issues?|risks?)\b)`, 'i'),
];
/** In a lettered option, an imperative is a step only on the owner's own object, or a UI label. */
const OPTION_STEP_IMPERATIVES: readonly RegExp[] = [
  new RegExp(String.raw`^(?:${IMPERATIVE_VERBS}|open)\s+(?:your|yourself)\b`, 'i'),
  /^(?:[Cc]lick|[Tt]ap|[Pp]ress)\s+(?![\w-]+\s*:)[A-Z]/,
];
const LEADING_CONNECTIVE = /^(?:then|and|or|now|next|first|finally|after\s+that|once\s+(?:that\s+is\s+|it\s+is\s+)?done)[,\s]+/i;
/** A short label before the step: "Your one click: open the run page", "A one-off: run the script". */
const LEADING_LABEL = /^[^:,"`]{1,30}:\s+/;

/**
 * How the owner answers is not a step: the answer IS that action. "Tap Done" is not here: the labelled table reads
 * "Tap Done, with the outputs in the text box, after step 1" as an owner step (r4's rule for it never matched "Tap").
 */
const ANSWER_CHANNEL: readonly RegExp[] = [
  /^(?:please\s+)?reply\b/i,
  /\b(?:type|enter|write|list|put|paste)\b[^.?!]*\b(?:in|into)\s+(?:the\s+)?(?:text|free-text|free\s+text|answer|reply)\s+(?:box|field)\b/i,
  /^(?:please\s+)?tick\b/i,
  /^(?:please\s+)?(?:pick|choose|select)\s+(?:an?\s+|one\s+)?(?:option|answer)\b/i,
];

/** An agent plan, not an owner step. */
const AGENT_LABEL = /^(?:fix|plan|recommended|recommendation|next\s+steps?\s+for\s+(?:me|us|the\s+agents?)|agent\s+steps|what\s+(?:i|we)\s+(?:will\s+)?do)\s*:/i;
const MODAL = String.raw`(?:'ll|\s+will|\s+would|\s+can|\s+could|\s+may|\s+must|\s+then|\s+also|\s+first)?`;
const AGENT_SUBJECT: readonly RegExp[] = [
  // "I re-point the migration and open the PR"; not a sentence that turns to the owner ("I have the file, please upload it").
  /^i\s+(?![^.;]*\b(?:please|you|your)\b)[a-z'][\w'-]*/i,
  new RegExp(String.raw`^we${MODAL}\s+(?:${STEP_VERBS}|${PARTY_VERBS}|read|write|recommend|propose|suggest|plan|keep|fix)\b`, 'i'),
  new RegExp(String.raw`^(?:the\s+(?:agents?|orchestrator|worker|bot|role|grant|token|policy|service\s+account)|agents?|it)${MODAL}\s+` +
    String.raw`(?:${STEP_VERBS}|${PARTY_VERBS}|read|write|lets|allows|enables)\b`, 'i'),
];
const CAPABILITY = /\b(?:lets|allows|permits|enables)\s+(?:the\s+)?(?:agents?|orchestrator|worker|bot|role|us|me|it)\b/i;
const isAgentSentence = (sentence: string): boolean => {
  const text = sentence.replace(LEADING_CONNECTIVE, '');
  return AGENT_LABEL.test(text) || AGENT_SUBJECT.some((p) => p.test(text)) || CAPABILITY.test(sentence);
};

/** The owner step a clause starts with, by its first words; null when it is not one. */
const ownerStepOf = (clause: string, option: boolean): string | null => {
  const plain = clause.replace(LEADING_CONNECTIVE, '');
  const patterns = option ? OPTION_STEP_IMPERATIVES : OWNER_STEP_IMPERATIVES;
  // The clause itself ("Run this from your laptop: ..."), else what follows a short label ("Your one click: open ...").
  const text = [plain, plain.replace(LEADING_LABEL, '').replace(LEADING_CONNECTIVE, '')]
    .find((candidate) => patterns.some((pattern) => pattern.test(candidate)));
  if (text === undefined) return null;
  return text.split(/\s+/).slice(0, 2).join(' ').replace(/[`:"',.]+$/, '');
};
const LIST_MARKER = /^\s*(?:[-*•]|\d{1,2}[.):]|\(\d{1,2}\)|step\s+\d{1,2}[.):]?)\s+/i;
const OPTION_MARKER = /^\s*\(?[a-h]\)\s+/i;
const BLANK = /^\s*$/;

interface IStepSentence { sentence: string; asks: boolean; option: boolean; past: boolean }
/**
 * The sentences that can hold an owner step, each without its list or option marker. A "Fix:" or "Plan:" heading on
 * its own line opens an agent block: its list items are agent steps, until a blank line, a line that is not a list
 * item, or an owner-steps heading. An answer-channel sentence and an agent sentence are dropped.
 */
const stepSentences = (text: string): IStepSentence[] => {
  const out: IStepSentence[] = [];
  let agentBlock = false;
  for (const line of text.split('\n')) {
    const isItem = LIST_MARKER.test(line);
    const option = !isItem && OPTION_MARKER.test(line);
    const body = line.replace(LIST_MARKER, '').replace(OPTION_MARKER, '').trim();
    if (agentBlock && (BLANK.test(line) || !isItem || /^(?:your|owner|manual)\s+steps?\b|^steps\s*:/i.test(body))) agentBlock = false;
    if (agentBlock) continue;
    if (AGENT_LABEL.test(body) && body.replace(AGENT_LABEL, '').trim() === '') {
      agentBlock = true;
      continue;
    }
    body.split(/(?<=[.!?;])\s+/).forEach((raw, index) => {
      const sentence = raw.trim();
      if (!sentence || ANSWER_CHANNEL.some((p) => p.test(sentence.replace(LEADING_CONNECTIVE, ''))) || isAgentSentence(sentence)) return;
      out.push({ sentence, asks: sentence.endsWith('?'), option: option && index === 0, past: PAST_MARKER.test(sentence) || PAST_YOU.test(sentence) });
    });
  }
  return out;
};

/** Each sentence's clauses: split at a comma or a slash ("In the billing page, click Upgrade", "I merge it / you merge it"). */
const clausesOf = (sentence: string): string[] => sentence.split(/,\s+|\s+\/\s+/).map((part) => part.trim()).filter(Boolean);

/** The question's own words: never `title` (v1 title IS the decision), code blocks dropped (quoted text, not a step). */
const ownerStepTexts = (question: Record<string, unknown>): Array<[string, string]> => {
  const texts: Array<[string, string]> = [];
  const add = (field: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) texts.push([field, value.replace(/```[\s\S]*?```/g, ' ')]);
  };
  add('context', question.context);
  add('decision', question.decision);
  add('whyNow', question.whyNow);
  if (Array.isArray(question.options)) {
    question.options.forEach((option: unknown, index: number) => {
      if (option && typeof option === 'object') {
        const o = option as Record<string, unknown>;
        add(`options[${index}].label`, o.label);
        add(`options[${index}].consequence`, o.consequence);
        add(`options[${index}].description`, o.description);
      }
    });
  }
  return texts;
};

/** Fields that name a choice: an imperative there is the choice ("Select the rollout path", "Merge now"), not a step. */
const PHRASES_ONLY = /^(?:decision|options\[\d+\]\.label)$/;

/**
 * Owner steps inside a question (vel-MC-ACT, a recurrence the owner raised): an action the owner must take, written into
 * a question, closes with the question when he answers it, undone. A warning, never a refusal: it names what it found,
 * where, and the split, one kind=action item per step. A kind=action item is not read: it is the step.
 *
 * A heuristic, tuned on a fixture set (tests/fixtures/mission-questions/owner-steps.json and the served question
 * fixtures) and, by counts and shapes only, on the real store (PR #60 r4): an imperative owner verb starting a
 * sentence, line or list item, or a phrase that addresses the owner's steps. A plain decision ("Should I run this
 * migration?", "1. Ship staged", "click-through rate"), how the owner answers ("Reply with ..."), and what the agent
 * does ("Fix: add a test", "the role lets the agent open a tunnel") are not steps.
 */
export const ownerStepsLint = (question: Record<string, unknown>): IMissionQuestionDefect[] => {
  if (question.kind !== 'question') return [];
  const found: string[] = [];
  const fields: string[] = [];
  for (const [field, text] of ownerStepTexts(question)) {
    const sentences = stepSentences(text);
    const phrases = OWNER_STEP_PHRASES
      .filter(({ pattern, inQuestion, perClause, owner }) => sentences.some(({ sentence, asks, past }) => (inQuestion || !asks)
        && !(owner && past)
        && (perClause
          ? clausesOf(sentence).some((clause) => pattern.test(clause.replace(LEADING_CONNECTIVE, '')))
          : pattern.test(sentence))))
      .map(({ name }) => name);
    const steps = PHRASES_ONLY.test(field) ? [] : sentences
      .filter(({ asks }) => !asks)
      .flatMap(({ sentence, option }) => clausesOf(sentence).map((clause) => ownerStepOf(clause, option)))
      .filter((step): step is string => step !== null);
    if (!phrases.length && !steps.length) continue;
    fields.push(field);
    found.push(...phrases.filter((name) => !found.includes(name)));
    if (steps.length) {
      const named = [...new Set(steps.map((step) => `'${step}'`))];
      found.push(`${steps.length} owner step${steps.length === 1 ? '' : 's'} (${named.join(', ')}) in ${field}`);
    }
  }
  if (!found.length) return [];
  return [defect(fields.join(', '), `owner steps in a question: ${found.join('; ')}`,
    'split them: open each owner step as its own kind=action item (answerType action-done, humanNeed external-action) and keep this question to the decision; answering a question closes it, and a step written inside it closes with it, undone')];
};

/**
 * A kind=action opened with no human review (vel-MC-ACT): from the configured orchestrator the server stamps
 * external-action and it reaches the owner; from any other tab it is a candidate the owner does not see until the
 * orchestrator reviews it. A warning, never a refusal.
 */
export const actionReviewLint = (question: { kind?: unknown }, humanReview: unknown): IMissionQuestionDefect[] =>
  question.kind === 'action' && (humanReview === undefined || humanReview === null)
    ? [defect('humanReview', 'absent on a kind=action',
      'the owner sees an action only with a review: opened by the configured orchestrator, the server stamps external-action; from any other tab it stays a candidate until the orchestrator sends attention.updated with humanReview external-action')]
    : [];

/**
 * A human-reviewed item with no class sorts as Unclassified on the owner's board (ADR-0031): a warning, never a refusal,
 * since a producer that cannot name the class omits it (story 36, D6). A `none` review is never owner-visible.
 */
export const reviewLint = (question: { class?: unknown }, humanReview: unknown): IMissionQuestionDefect[] => {
  if (!isRecord(humanReview) || humanReview.humanNeed === 'none' || question.class != null) return [];
  return [defect('class', 'absent', `one of ${ATTENTION_CLASSES.join(', ')}; without it the item sorts as Unclassified (ADR-0031)`)];
};

interface IV2Check {
  input: Record<string, unknown>;
  defects: IMissionQuestionDefect[];
}

const unknownFields = (check: IV2Check, value: Record<string, unknown>, allowed: Set<string>, prefix: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) check.defects.push(defect(prefix ? `${prefix}.${key}` : key, 'present', 'not a formatVersion 2 field'));
  }
};

/** A trimmed string within limits, or undefined after recording the defect. */
const text = (
  check: IV2Check,
  field: string,
  value: unknown,
  rule: { max: number; required: boolean; oneLine?: boolean },
): string | undefined => {
  if (value === undefined || value === null) {
    if (rule.required) check.defects.push(defect(field, 'absent', `required, at most ${rule.max} chars`));
    return undefined;
  }
  if (typeof value !== 'string') {
    check.defects.push(defect(field, typeName(value), `a string of at most ${rule.max} chars`));
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed && rule.required) {
    check.defects.push(defect(field, 'empty', `required, at most ${rule.max} chars`));
    return undefined;
  }
  if (trimmed.length > rule.max) {
    check.defects.push(defect(field, chars(trimmed), `at most ${rule.max}`));
    return undefined;
  }
  if (rule.oneLine && /[\r\n]/.test(trimmed)) {
    check.defects.push(defect(field, 'several lines', 'one line'));
    return undefined;
  }
  return trimmed;
};

const oneOf = <T extends string>(check: IV2Check, field: string, value: unknown, allowed: readonly T[]): T | undefined => {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  check.defects.push(defect(field, value === undefined ? 'absent' : JSON.stringify(value), `one of ${allowed.join(', ')}`));
  return undefined;
};

const flag = (check: IV2Check, field: string, value: unknown, required: boolean): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (value === undefined && !required) return undefined;
  check.defects.push(defect(field, value === undefined ? 'absent' : typeName(value), 'true or false'));
  return undefined;
};

const v2Option = (check: IV2Check, value: unknown, index: number): IMissionOption | null => {
  const field = `options[${index}]`;
  if (!isRecord(value)) {
    check.defects.push(defect(field, typeName(value), 'an object with id and label'));
    return null;
  }
  unknownFields(check, value, V2_OPTION_FIELDS, field);
  const id = text(check, `${field}.id`, value.id, { max: QUESTION_LIMITS.id, required: true, oneLine: true });
  const label = text(check, `${field}.label`, value.label, { max: QUESTION_LIMITS.label, required: true, oneLine: true });
  const consequence = text(check, `${field}.consequence`, value.consequence, { max: QUESTION_LIMITS.consequence, required: false, oneLine: true });
  const recommended = flag(check, `${field}.recommended`, value.recommended, false) ?? false;
  const needsText = flag(check, `${field}.needsText`, value.needsText, false) ?? false;
  if (id === undefined || label === undefined) return null;
  return { id, label, ...(consequence ? { consequence } : {}), recommended, needsText };
};

const v2Options = (check: IV2Check, answerType: TMissionAnswerType | undefined): IMissionOption[] => {
  const raw = check.input.options;
  if (raw !== undefined && !Array.isArray(raw)) {
    check.defects.push(defect('options', typeName(raw), 'an array'));
    return [];
  }
  const entries = raw ?? [];
  if (answerType === 'confirm' && entries.length === 0) return CONFIRM_DEFAULT_OPTIONS.map((option) => ({ ...option }));
  if (answerType) {
    const { min, max } = OPTION_COUNT[answerType];
    if (entries.length < min || entries.length > max) {
      const need = max === 0 ? 'takes none' : min === max ? `needs exactly ${min}` : `needs ${min}-${max}`;
      check.defects.push(defect('options', `${plural(entries.length, 'option')} on answerType ${answerType}`, need));
    }
  }
  const options = entries.flatMap((entry, index) => v2Option(check, entry, index) ?? []);
  if (new Set(options.map((option) => option.id)).size !== options.length) {
    check.defects.push(defect('options', 'duplicate option IDs', 'each id once'));
  }
  const recommended = options.filter((option) => option.recommended).length;
  if (recommended > 1 && (answerType === 'single' || answerType === 'confirm')) {
    check.defects.push(defect('options', `${recommended} recommended on answerType ${answerType}`, 'at most 1'));
  }
  return options;
};

const v2Evidence = (check: IV2Check): IMissionEvidenceLink[] => {
  const raw = check.input.evidence;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    check.defects.push(defect('evidence', typeName(raw), 'an array'));
    return [];
  }
  if (raw.length > QUESTION_LIMITS.evidence) {
    check.defects.push(defect('evidence', plural(raw.length, 'link'), `at most ${QUESTION_LIMITS.evidence}`));
  }
  const firstIndexByUrl = new Map<string, number>();
  return raw.flatMap((entry, index) => {
    const field = `evidence[${index}]`;
    if (!isRecord(entry)) {
      check.defects.push(defect(field, typeName(entry), 'an object with label and url'));
      return [];
    }
    unknownFields(check, entry, V2_EVIDENCE_FIELDS, field);
    const label = text(check, `${field}.label`, entry.label, { max: QUESTION_LIMITS.evidenceLabel, required: true, oneLine: true });
    const url = text(check, `${field}.url`, entry.url, { max: QUESTION_LIMITS.url, required: true, oneLine: true });
    if (url !== undefined && !isHttpUrl(url)) {
      check.defects.push(defect(`${field}.url`, JSON.stringify(url.slice(0, 40)), 'an http or https URL'));
      return [];
    }
    return label !== undefined && url !== undefined ? [{ index, link: { label, url } }] : [];
  }).filter(({ index, link }) => {
    const first = firstIndexByUrl.get(link.url);
    if (first === undefined) {
      firstIndexByUrl.set(link.url, index);
      return true;
    }
    check.defects.push(defect(`evidence[${index}].url`, JSON.stringify(link.url.slice(0, 60)), `each url once (evidence[${first}] has it)`));
    return false;
  }).map(({ link }) => link);
};

export const isHttpUrl = (value: string): boolean => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const v2StoryIds = (check: IV2Check): string[] => {
  const raw = check.input.storyIds;
  if (!Array.isArray(raw)) {
    check.defects.push(defect('storyIds', measure(raw), 'an array of at most 20 story IDs'));
    return [];
  }
  if (raw.length > QUESTION_LIMITS.storyIds) {
    check.defects.push(defect('storyIds', plural(raw.length, 'item'), `at most ${QUESTION_LIMITS.storyIds}`));
  }
  const ids = raw.flatMap((entry, index) => text(check, `storyIds[${index}]`, entry, { max: QUESTION_LIMITS.id, required: true, oneLine: true }) ?? []);
  if (new Set(ids).size !== ids.length) check.defects.push(defect('storyIds', 'duplicate story IDs', 'each id once'));
  return ids;
};

const v2Source = (check: IV2Check): Record<string, unknown> | undefined => {
  const raw = check.input.source;
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    check.defects.push(defect('source', typeName(raw), 'the original draft object'));
    return undefined;
  }
  const size = JSON.stringify(raw).length;
  if (size > QUESTION_LIMITS.source) {
    check.defects.push(defect('source', `${size} chars of JSON`, `at most ${QUESTION_LIMITS.source}`));
    return undefined;
  }
  return raw;
};

const KIND_OF: Record<TMissionAnswerType, 'question' | 'action'> = {
  single: 'question',
  multi: 'question',
  confirm: 'question',
  text: 'question',
  'action-done': 'action',
};

const v2Question = (input: Record<string, unknown>): { question: TMissionStoredQuestion | null; defects: IMissionQuestionDefect[] } => {
  const check: IV2Check = { input, defects: [] };
  unknownFields(check, input, V2_FIELDS, '');
  const kind = oneOf(check, 'kind', input.kind, ['question', 'action'] as const);
  const answerType = oneOf(check, 'answerType', input.answerType, ANSWER_TYPES);
  if (kind && answerType && KIND_OF[answerType] !== kind) {
    check.defects.push(defect('kind', `${kind} on answerType ${answerType}`, `answerType ${answerType} needs kind ${KIND_OF[answerType]}`));
  }
  const title = text(check, 'title', input.title, { max: QUESTION_LIMITS.title, required: true, oneLine: true });
  const decision = text(check, 'decision', input.decision, { max: QUESTION_LIMITS.decision, required: true, oneLine: true });
  const whyNow = text(check, 'whyNow', input.whyNow, { max: QUESTION_LIMITS.whyNow, required: kind === 'question' });
  const context = text(check, 'context', input.context, { max: QUESTION_LIMITS.context, required: false }) ?? '';
  const options = v2Options(check, answerType);
  const recommendationWhy = text(check, 'recommendationWhy', input.recommendationWhy, {
    max: QUESTION_LIMITS.recommendationWhy,
    required: options.some((option) => option.recommended),
  });
  const evidence = v2Evidence(check);
  const storyIds = v2StoryIds(check);
  const blockingScope = oneOf(check, 'blockingScope', input.blockingScope, ['none', 'story', 'run'] as const);
  const canContinue = flag(check, 'canContinue', input.canContinue, true);
  const attentionClass = input.class === undefined ? undefined : oneOf(check, 'class', input.class, ATTENTION_CLASSES);
  const defaultOptionId = input.defaultOptionId === undefined
    ? undefined
    : text(check, 'defaultOptionId', input.defaultOptionId, { max: QUESTION_LIMITS.id, required: true, oneLine: true });
  if (defaultOptionId !== undefined) {
    if (kind === 'action') check.defects.push(defect('defaultOptionId', 'present on an action item', 'refused on an action item'));
    else if (!options.some((option) => option.id === defaultOptionId)) {
      check.defects.push(defect('defaultOptionId', JSON.stringify(defaultOptionId), "one of the item's options"));
    }
  }
  const source = v2Source(check);
  if (check.defects.length || !kind || !answerType || title === undefined || decision === undefined
    || !blockingScope || canContinue === undefined) {
    return { question: null, defects: check.defects };
  }
  return {
    defects: [],
    question: {
      formatVersion: 2,
      kind,
      title,
      decision,
      ...(whyNow ? { whyNow } : {}),
      answerType,
      options,
      ...(recommendationWhy ? { recommendationWhy } : {}),
      evidence,
      context,
      recommendation: null,
      storyIds,
      blockingScope,
      canContinue,
      ...(attentionClass ? { class: attentionClass } : {}),
      ...(defaultOptionId !== undefined ? { defaultOptionId } : {}),
      ...(source ? { source } : {}),
    },
  };
};

export type TMissionQuestionVerdict =
  | { ok: true; formatVersion: 1 | 2; question: TMissionStoredQuestion; lint: IMissionQuestionDefect[] }
  | { ok: false; formatVersion: 1 | 2 | null; defects: IMissionQuestionDefect[] };

/**
 * The one validator of a question payload (ADR-0037 §2), the same for `attention.opened` and
 * `attention.updated`. A v2 question is held to the format-2 rules; a v1 question to the v1 rules,
 * and at `minVersion` 2 it is refused with its format-2 findings as the defects.
 */
export const validateMissionQuestion = (input: unknown, minVersion: 1 | 2 = 1): TMissionQuestionVerdict => {
  if (!isRecord(input)) return { ok: false, formatVersion: null, defects: [defect('question', typeName(input), 'an object')] };
  if (input.formatVersion !== undefined && input.formatVersion !== 2) {
    return { ok: false, formatVersion: null, defects: [defect('formatVersion', JSON.stringify(input.formatVersion), '2, or absent for a v1 question')] };
  }
  if (input.formatVersion === 2) {
    const { question, defects } = v2Question(input);
    return question ? { ok: true, formatVersion: 2, question, lint: [] } : { ok: false, formatVersion: 2, defects };
  }
  const { question, defects } = v1Defects(input);
  if (!question) return { ok: false, formatVersion: 1, defects };
  const lint = questionLint(question);
  if (minVersion === 2) {
    return { ok: false, formatVersion: 1, defects: lint.map((finding) => finding.field === 'formatVersion'
      ? defect('formatVersion', 'absent (v1)', 'at least 2 (fleet config mission.question-format.min-version)')
      : finding) };
  }
  return { ok: true, formatVersion: 1, question, lint };
};

const optionWording = (option: IMissionOption): string =>
  JSON.stringify([option.label, option.consequence ?? option.description ?? '', option.needsText === true]);

const recommendedIds = (question: TMissionStoredQuestion): string[] =>
  question.options.filter((option) => option.recommended === true).map((option) => option.id);

const recommendationText = (question: TMissionStoredQuestion): string | null =>
  question.formatVersion === 2 ? question.recommendationWhy ?? null : question.recommendation;

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What changed from one question revision to the next (ADR-0037 §4). */
export const diffMissionQuestions = (
  before: TMissionStoredQuestion,
  after: TMissionStoredQuestion,
  fromRevision: number,
  toRevision: number,
): IMissionQuestionChanges => {
  const beforeDecision = questionDecision(before);
  const afterDecision = questionDecision(after);
  const beforeType = effectiveAnswerType(before);
  const afterType = effectiveAnswerType(after);
  const beforeOptions = new Map(before.options.map((option) => [option.id, option]));
  const afterIds = new Set(after.options.map((option) => option.id));
  const removed = before.options.filter((option) => !afterIds.has(option.id)).map((option) => option.id);
  const added = after.options.filter((option) => !beforeOptions.has(option.id)).map((option) => option.id);
  const relabelled = after.options.flatMap((option) => {
    const previous = beforeOptions.get(option.id);
    if (!previous || optionWording(previous) === optionWording(option)) return [];
    const needsText = (previous.needsText === true) === (option.needsText === true)
      ? {}
      : { needsText: { from: previous.needsText === true, to: option.needsText === true } };
    return [{ id: option.id, from: previous.label, to: option.label, ...needsText }];
  });
  const beforeRecommended = recommendedIds(before);
  const afterRecommended = recommendedIds(after);
  const decision = beforeDecision === afterDecision ? null : { from: beforeDecision, to: afterDecision };
  const answerType = beforeType === afterType ? null : { from: beforeType, to: afterType };
  return {
    fromRevision,
    toRevision,
    compatible: decision === null && answerType === null && removed.length === 0,
    decision,
    answerType,
    options: { added, removed, relabelled },
    recommended: sameJson(beforeRecommended, afterRecommended) ? null : { from: beforeRecommended, to: afterRecommended },
    recommendation: recommendationText(before) !== recommendationText(after),
    whyNow: (before.whyNow ?? null) !== (after.whyNow ?? null),
    title: before.title !== after.title && (before.decision !== undefined || after.decision !== undefined),
    context: before.context !== after.context,
    evidence: !sameJson(before.evidence ?? [], after.evidence ?? []),
    unrecorded: [],
  };
};

/** No change at all: the record of a revision the owner cannot tell apart from the one before. */
export const emptyMissionChanges = (fromRevision: number, toRevision: number): IMissionQuestionChanges => ({
  fromRevision,
  toRevision,
  compatible: true,
  decision: null,
  answerType: null,
  options: { added: [], removed: [], relabelled: [] },
  recommended: null,
  recommendation: false,
  whyNow: false,
  title: false,
  context: false,
  evidence: false,
  unrecorded: [],
});

const appendUnique = (target: string[], values: string[]): void => {
  for (const value of values) if (!target.includes(value)) target.push(value);
};

/**
 * Two consecutive spans as one: compatible only when both are. An option added in the first and
 * removed in the second is listed as both added and removed, so the span stays incompatible.
 */
export const combineMissionChanges = (first: IMissionQuestionChanges, second: IMissionQuestionChanges): IMissionQuestionChanges => {
  const merged: IMissionQuestionChanges = {
    ...first,
    toRevision: second.toRevision,
    compatible: first.compatible && second.compatible,
    decision: second.decision ? { from: first.decision?.from ?? second.decision.from, to: second.decision.to } : first.decision,
    answerType: second.answerType ? { from: first.answerType?.from ?? second.answerType.from, to: second.answerType.to } : first.answerType,
    options: { added: [...first.options.added], removed: [...first.options.removed], relabelled: first.options.relabelled.map((entry) => ({ ...entry })) },
    recommended: second.recommended ? { from: first.recommended?.from ?? second.recommended.from, to: second.recommended.to } : first.recommended,
    recommendation: first.recommendation || second.recommendation,
    whyNow: first.whyNow || second.whyNow,
    title: first.title || second.title,
    context: first.context || second.context,
    evidence: first.evidence || second.evidence,
    unrecorded: [...first.unrecorded, ...second.unrecorded],
  };
  appendUnique(merged.options.added, second.options.added);
  appendUnique(merged.options.removed, second.options.removed);
  for (const entry of second.options.relabelled) {
    const existing = merged.options.relabelled.find((candidate) => candidate.id === entry.id);
    if (!existing) {
      merged.options.relabelled.push({ ...entry });
      continue;
    }
    existing.to = entry.to;
    if (entry.needsText) existing.needsText = { from: existing.needsText?.from ?? entry.needsText.from, to: entry.needsText.to };
  }
  return merged;
};

/**
 * One record for a span of revisions: the per-revision records merged, plus the revisions that
 * have none. It is compatible only when every revision in the span is.
 */
export const mergeMissionChanges = (
  fromRevision: number,
  toRevision: number,
  records: ReadonlyMap<number, IMissionQuestionChanges>,
): IMissionQuestionChanges => {
  let merged = emptyMissionChanges(fromRevision, fromRevision);
  for (let revision = fromRevision + 1; revision <= toRevision; revision += 1) {
    const record = records.get(revision)
      ?? { ...emptyMissionChanges(revision - 1, revision), compatible: false, unrecorded: [revision] };
    merged = combineMissionChanges(merged, record);
  }
  return { ...merged, toRevision };
};

/** The stored question of a served item: the inverse of the store's item mapping. */
export const questionOfItem = (item: IMissionAttentionItem): TMissionStoredQuestion => {
  const { kind, title, context, storyIds, options, recommendation, blockingScope, canContinue } = item;
  const base: TMissionStoredQuestion = {
    kind, title, context, storyIds, options, recommendation, blockingScope, canContinue,
    ...(item.class === null ? {} : { class: item.class }),
    ...(item.defaultOptionId === null ? {} : { defaultOptionId: item.defaultOptionId }),
  };
  if (item.formatVersion !== 2) return base;
  return {
    ...base,
    formatVersion: 2,
    ...(item.decision === undefined ? {} : { decision: item.decision }),
    ...(item.whyNow === undefined ? {} : { whyNow: item.whyNow }),
    ...(item.answerType === undefined ? {} : { answerType: item.answerType }),
    ...(item.recommendationWhy === undefined ? {} : { recommendationWhy: item.recommendationWhy }),
    evidence: item.evidenceLinks,
    ...(item.source === undefined ? {} : { source: item.source }),
  };
};

/** Why the server refuses this answer to the item's current revision, or null when it applies (ADR-0037 §1). */
export const answerRefusal = (
  item: Pick<IMissionQuestion, 'kind' | 'options' | 'answerType'>,
  request: { optionIds: string[]; text: string },
): string | null => {
  const options = new Map(item.options.map((option) => [option.id, option]));
  if (request.optionIds.some((optionId) => !options.has(optionId))) return 'answer selected an unknown option';
  if (item.kind === 'action' && request.optionIds.length) return 'action answers cannot select question options';
  const answerType = effectiveAnswerType(item);
  if ((answerType === 'single' || answerType === 'confirm') && request.optionIds.length > 1) {
    return `answerType ${answerType} takes one option; ${request.optionIds.length} were selected`;
  }
  const needsText = request.optionIds.map((optionId) => options.get(optionId)).find((option) => option?.needsText);
  if (needsText && !request.text.trim()) return `option "${needsText.label}" needs text`;
  return null;
};
