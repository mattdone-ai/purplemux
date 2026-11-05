import { QUESTION_LIMITS, defect, effectiveAnswerType, validateMissionQuestion } from '@/lib/mission-question-format';
import type { IMissionOption, IMissionQuestionDefect, TMissionAnswerType } from '@/types/mission-control';
import type { TMissionStoredQuestion } from '@/lib/mission-question-format';

// The curator's question reshape (ADR-HFL-11 rule 3, ADR-0037 §3). Pure: the draft is lifted to the format-2 shape
// with nothing invented, the model writes only text fields, and a deterministic check refuses any reshape that moved a
// structural field. The asking agent posts the result itself, so it stays the author.

/** What one reshape came to: the label the call record carries, never the draft's text. */
export const RESHAPE_LABELS = ['reshaped', 'not-preserved', 'invalid'] as const;
export type TReshapeLabel = (typeof RESHAPE_LABELS)[number];
/** The rules never reshape: with the curator down, the agent fixes the defects itself. */
export const RESHAPE_RULES_LABEL = 'not-reshaped';

export interface IReshapeOptionText {
  label: string;
  consequence: string;
}

/** The model's reply: the text fields only. Options are keyed by id, so it can neither drop nor reorder one. */
export interface IReshapeReply {
  title: string;
  decision: string;
  whyNow: string;
  recommendationWhy?: string;
  context?: string;
  options: Record<string, IReshapeOptionText>;
}

/** The format-2 skeleton of a draft: a v2 draft as written, or a v1 question as it renders today (ADR-0037). */
export type TLiftedDraft = Record<string, unknown> & {
  formatVersion: 2;
  kind: 'question' | 'action';
  answerType: TMissionAnswerType;
  options: IMissionOption[];
  evidence: Array<{ label: string; url: string }>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * A v1 question keeps what it has: its options as they are (no option is recommended, since v1 marks none), the answer
 * type its card derives today (action -> action-done, no options -> text, otherwise multi), no evidence links. A v2
 * draft is taken as written. Null when the input is neither a v1 question nor a v2 draft.
 */
export const liftDraft = (input: unknown): TLiftedDraft | null => {
  if (!isRecord(input)) return null;
  if (input.formatVersion === 2) {
    // A list that is not a list, or an entry that is not an object, is not a draft: never silently dropped (review r1 F7).
    const list = (value: unknown): Array<Record<string, unknown>> | null =>
      (value === undefined ? [] : Array.isArray(value) && value.every(isRecord) ? value : null);
    const options = list(input.options);
    const evidence = list(input.evidence);
    const answerType = str(input.answerType) as TMissionAnswerType | undefined;
    if (!options || !evidence || !answerType || (input.kind !== 'question' && input.kind !== 'action')) return null;
    return {
      ...input, formatVersion: 2, kind: input.kind, answerType,
      options: options as unknown as IMissionOption[], evidence: evidence as Array<{ label: string; url: string }>,
    };
  }
  if (input.formatVersion !== undefined) return null;
  const v1 = validateMissionQuestion(input, 1);
  if (!v1.ok || v1.formatVersion !== 1) return null;
  const q = v1.question;
  return {
    formatVersion: 2,
    kind: q.kind,
    title: q.title,
    answerType: effectiveAnswerType(q),
    options: q.options.map((o) => ({ id: o.id, label: o.label, recommended: false, needsText: false })),
    evidence: [],
    context: q.context,
    storyIds: q.storyIds,
    blockingScope: q.blockingScope,
    canContinue: q.canContinue,
    ...(q.class ? { class: q.class } : {}),
    ...(q.defaultOptionId ? { defaultOptionId: q.defaultOptionId } : {}),
  };
};

/** A draft the model cannot read whole (its 6,000-token input) is not reshapable: refused before any call (review r1 F2). */
export const draftTooLong = (source: unknown, maxTokens: number, charsPerToken: number): IMissionQuestionDefect | null => {
  const chars = JSON.stringify(source).length;
  const tokens = Math.ceil(chars / charsPerToken);
  return tokens > maxTokens ? defect('question', `about ${tokens} tokens of JSON`, `at most ${maxTokens} for a reshape`) : null;
};

const PLACEHOLDER_TEXT = 'x';

/**
 * Defects no reshape may fix: the draft with every text field set to a placeholder, validated at format 2. What is left
 * is structure (answer type, option count, ids, class, evidence URLs), which the preservation check forbids changing.
 */
export const structuralDefects = (draft: TLiftedDraft): IMissionQuestionDefect[] => {
  const recommended = draft.options.some((o) => o.recommended === true);
  const { source: _source, recommendation: _recommendation, ...rest } = draft;
  const probe = {
    ...rest,
    title: PLACEHOLDER_TEXT,
    decision: PLACEHOLDER_TEXT,
    ...(draft.kind === 'question' ? { whyNow: PLACEHOLDER_TEXT } : {}),
    context: '',
    ...(recommended ? { recommendationWhy: PLACEHOLDER_TEXT } : {}),
    options: draft.options.map(({ description: _d, ...o }) => ({ ...o, label: PLACEHOLDER_TEXT, consequence: PLACEHOLDER_TEXT })),
    evidence: draft.evidence.map((e) => ({ ...e, label: PLACEHOLDER_TEXT })),
  };
  const verdict = validateMissionQuestion(probe, 2);
  return verdict.ok ? [] : verdict.defects;
};

/** A field the draft already states within its limit is kept as written; the model's text is used only where it fails. */
const keep = (value: unknown, max: number, oneLine: boolean): string | undefined => {
  const text = str(value)?.trim();
  if (!text || text.length > max || (oneLine && /\n/.test(text))) return undefined;
  return text;
};

/** Whether the model must write the context: only when the draft's is over the format-2 limit. */
export const contextNeedsReshape = (draft: TLiftedDraft): boolean => (str(draft.context) ?? '').trim().length > QUESTION_LIMITS.context;

/** The reshaped draft: the source's structure, its valid text, and the model's text where the source's fails. */
export const mergeReshape = (draft: TLiftedDraft, reply: IReshapeReply, source: Record<string, unknown>): Record<string, unknown> => {
  const { recommendation: _recommendation, source: _source, ...structure } = draft;
  const recommended = draft.options.some((o) => o.recommended === true);
  const whyNow = keep(draft.whyNow, QUESTION_LIMITS.whyNow, false) ?? reply.whyNow.trim();
  const recommendationWhy = keep(draft.recommendationWhy, QUESTION_LIMITS.recommendationWhy, false) ?? reply.recommendationWhy?.trim();
  return {
    ...structure,
    title: keep(draft.title, QUESTION_LIMITS.title, true) ?? reply.title.trim(),
    decision: keep(draft.decision, QUESTION_LIMITS.decision, true) ?? reply.decision.trim(),
    ...(draft.kind === 'question' || whyNow ? { whyNow } : {}),
    context: contextNeedsReshape(draft) ? (reply.context ?? '').trim() : (str(draft.context) ?? '').trim(),
    ...(recommended || recommendationWhy ? { recommendationWhy } : {}),
    options: draft.options.map(({ description: _d, ...option }) => {
      const text = Object.hasOwn(reply.options, option.id) ? reply.options[option.id] : undefined;
      return {
        ...option,
        label: keep(option.label, QUESTION_LIMITS.label, true) ?? text?.label.trim() ?? option.label,
        consequence: keep(option.consequence, QUESTION_LIMITS.consequence, true) ?? text?.consequence.trim() ?? '',
      };
    }),
    source,
  };
};

const ids = (options: unknown): string[] => (Array.isArray(options) ? options.map((o) => String((o as { id?: unknown })?.id)) : []);
const flags = (options: unknown, key: 'recommended' | 'needsText'): boolean[] =>
  (Array.isArray(options) ? options.map((o) => (o as Record<string, unknown>)?.[key] === true) : []);
const urls = (evidence: unknown): string[] => (Array.isArray(evidence) ? evidence.map((e) => String((e as { url?: unknown })?.url)) : []);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The deterministic preservation check (ADR-HFL-11 rule 3): option ids, their count and order, `recommended`,
 * `answerType`, `class` and every evidence URL unchanged; also kind, needsText, the default, the story ids and the
 * blocking fields, which no text edit may move. Each defect names the field, what it became and what it was.
 */
export const preservationDefects = (draft: TLiftedDraft, candidate: Record<string, unknown>): IMissionQuestionDefect[] => {
  const out: IMissionQuestionDefect[] = [];
  const was = (value: unknown) => `was ${JSON.stringify(value ?? null)}`;
  const check = (field: string, before: unknown, after: unknown) => {
    if (!same(before, after)) out.push(defect(field, `became ${JSON.stringify(after ?? null)}`, `unchanged: ${was(before)}`));
  };
  check('options.count', draft.options.length, Array.isArray(candidate.options) ? candidate.options.length : 0);
  check('options.ids', ids(draft.options), ids(candidate.options));
  check('options.recommended', flags(draft.options, 'recommended'), flags(candidate.options, 'recommended'));
  check('options.needsText', flags(draft.options, 'needsText'), flags(candidate.options, 'needsText'));
  check('answerType', draft.answerType, candidate.answerType);
  check('kind', draft.kind, candidate.kind);
  check('class', draft.class, candidate.class);
  check('defaultOptionId', draft.defaultOptionId, candidate.defaultOptionId);
  check('evidence.urls', urls(draft.evidence), urls(candidate.evidence));
  check('storyIds', draft.storyIds, candidate.storyIds);
  check('blockingScope', draft.blockingScope, candidate.blockingScope);
  check('canContinue', draft.canContinue, candidate.canContinue);
  return out;
};

export type TReshapeVerdict =
  | { label: 'reshaped'; question: TMissionStoredQuestion; candidate: Record<string, unknown>; defects: [] }
  | { label: 'not-preserved' | 'invalid'; question: null; candidate: Record<string, unknown>; defects: IMissionQuestionDefect[] };

/** The model's reply against the draft: preservation first (a moved field is never posted), then the format-2 validator. */
export const judgeReshape = (draft: TLiftedDraft, reply: IReshapeReply, source: Record<string, unknown>): TReshapeVerdict => {
  const candidate = mergeReshape(draft, reply, source);
  const moved = preservationDefects(draft, candidate);
  if (moved.length) return { label: 'not-preserved', question: null, candidate, defects: moved };
  const verdict = validateMissionQuestion(candidate, 2);
  if (!verdict.ok) return { label: 'invalid', question: null, candidate, defects: verdict.defects };
  return { label: 'reshaped', question: verdict.question, candidate, defects: [] };
};

/** The reply's JSON schema for this draft: Ollama constrains the output to it, one keyed entry per option id. */
export const reshapeReplySchema = (draft: Pick<TLiftedDraft, 'options'>, withContext: boolean) => {
  const optionIds = draft.options.map((o) => o.id);
  const text = { type: 'string' };
  return {
    type: 'object',
    properties: {
      title: text, decision: text, whyNow: text, recommendationWhy: text,
      ...(withContext ? { context: text } : {}),
      options: {
        type: 'object',
        properties: Object.fromEntries(optionIds.map((id) => [id, {
          type: 'object', properties: { label: text, consequence: text }, required: ['label', 'consequence'],
        }])),
        required: optionIds,
      },
    },
    required: ['title', 'decision', 'whyNow', 'options', ...(withContext ? ['context'] : [])],
  };
};

export type TReshapeParse = { ok: true; reply: IReshapeReply } | { ok: false; error: string };

/** The model's reply, checked for shape only; an error names what was wrong, never the reply (review r1 F2 of story 16). */
export const parseReshapeReply = (content: string, draft: Pick<TLiftedDraft, 'options'>): TReshapeParse => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: `reply is not JSON (${content.length} chars)` };
  }
  if (!isRecord(parsed)) return { ok: false, error: 'reply is not an object' };
  for (const field of ['title', 'decision', 'whyNow'] as const) {
    if (typeof parsed[field] !== 'string') return { ok: false, error: `${field} is not a string` };
  }
  if (parsed.recommendationWhy !== undefined && typeof parsed.recommendationWhy !== 'string') return { ok: false, error: 'recommendationWhy is not a string' };
  if (parsed.context !== undefined && typeof parsed.context !== 'string') return { ok: false, error: 'context is not a string' };
  const options = parsed.options;
  if (!isRecord(options)) return { ok: false, error: 'options is not an object' };
  for (const { id } of draft.options) {
    const entry = Object.hasOwn(options, id) ? options[id] : undefined;
    if (!isRecord(entry) || typeof entry.label !== 'string' || typeof entry.consequence !== 'string') {
      return { ok: false, error: `options.${id} has no label and consequence strings` };
    }
  }
  return {
    ok: true,
    reply: {
      title: parsed.title as string, decision: parsed.decision as string, whyNow: parsed.whyNow as string,
      ...(typeof parsed.recommendationWhy === 'string' ? { recommendationWhy: parsed.recommendationWhy } : {}),
      ...(typeof parsed.context === 'string' ? { context: parsed.context } : {}),
      options: Object.fromEntries(draft.options.map(({ id }) => {
        const entry = options[id] as Record<string, string>;
        return [id, { label: entry.label, consequence: entry.consequence }];
      })),
    },
  };
};

const L = QUESTION_LIMITS;

export const RESHAPE_SYSTEM = [
  'You rewrite the wording of one question an AI coding agent asks its human owner, so it reads in a few seconds. Answer with JSON only.',
  'Never change what is asked, what each option means, or which option is which. Write only what the schema asks for; every other field stays as the agent wrote it.',
  `- title: at most ${L.title} characters, one line.`,
  `- decision: the thing to decide, one sentence, at most ${L.decision} characters, drawn from the question.`,
  `- whyNow: why it needs an answer now, at most ${L.whyNow} characters, drawn from the context.`,
  `- recommendationWhy: at most ${L.recommendationWhy} characters; the agent's own recommendation, if it gave one, else "".`,
  `- options: for each option id, a label of at most ${L.label} characters that keeps the option's meaning, and a consequence of at most ${L.consequence} characters, one line: what choosing it does, taken from the context's own sentences.`,
  `- context (only when asked): the same content in at most ${L.context} characters of markdown; keep every fact, number, link and name.`,
  'Never add an option, a fact, a number or a link the question does not hold.',
].join('\n');

export const reshapeUserPrompt = (source: Record<string, unknown>, withContext: boolean): string =>
  `${withContext ? 'Also shorten the context.\n' : ''}Question as the agent wrote it (JSON):\n"""\n${JSON.stringify(source, null, 1)}\n"""`;
