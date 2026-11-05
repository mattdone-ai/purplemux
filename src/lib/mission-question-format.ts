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
