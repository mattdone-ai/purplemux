import { ANSWER_TYPES, effectiveAnswerType } from '@/lib/mission-question-format';
import { REMOVED_OPTION_LABEL, isMissionDraftEmpty } from '@/components/features/mission-control/mission-control-utils';
import type { IMissionDraft } from '@/components/features/mission-control/mission-control-utils';
import type {
  IMissionAttentionItem,
  IMissionBlockedCost,
  IMissionEvidenceLink,
  IMissionOption,
  TMissionAnswerType,
  TMissionItemState,
} from '@/types/mission-control';

// The question card's reading of an item (ADR-0037 §5): v1 and v2 in one shape, so both render in
// the same layout with what they have.

export interface IQuestionOptionView {
  id: string;
  label: string;
  consequence: string | null;
  recommended: boolean;
  needsText: boolean;
}

export interface IQuestionView {
  formatVersion: 1 | 2;
  heading: string;
  subtitle: string | null;
  whyNow: string | null;
  answerType: TMissionAnswerType;
  options: IQuestionOptionView[];
  recommendation: { label: string; text: string } | null;
  evidence: IMissionEvidenceLink[];
  context: string;
  blocked: IMissionBlockedCost | null;
  source: Record<string, unknown> | null;
}

/**
 * The answer type the card renders: a type this client does not know (a newer server) reads as
 * the item's kind and options would without one, never as the raw token.
 */
export const cardAnswerType = (item: Pick<IMissionAttentionItem, 'kind' | 'options' | 'answerType'>): TMissionAnswerType =>
  effectiveAnswerType({
    kind: item.kind,
    options: item.options,
    answerType: item.answerType && (ANSWER_TYPES as readonly string[]).includes(item.answerType) ? item.answerType : undefined,
  });

/** "Choose one" and the like; a type this client does not know reads as a neutral phrase. */
export const answerTypeHint = (answerType: string): string =>
  Object.hasOwn(ANSWER_TYPE_HINTS, answerType) ? ANSWER_TYPE_HINTS[answerType as TMissionAnswerType] : 'another answer type';

const optionView = (option: IMissionOption): IQuestionOptionView => ({
  id: option.id,
  label: option.label,
  consequence: option.consequence ?? option.description ?? null,
  recommended: option.recommended === true,
  needsText: option.needsText === true,
});

export const questionView = (item: IMissionAttentionItem): IQuestionView => {
  const v2 = item.formatVersion === 2;
  const heading = item.decision ?? item.title;
  return {
    formatVersion: v2 ? 2 : 1,
    heading,
    subtitle: heading === item.title ? null : item.title,
    whyNow: item.whyNow ?? null,
    answerType: cardAnswerType(item),
    options: item.options.map(optionView),
    recommendation: v2
      ? (item.recommendationWhy ? { label: 'Why recommended', text: item.recommendationWhy } : null)
      : (item.recommendation ? { label: 'Recommendation', text: item.recommendation } : null),
    evidence: item.evidenceLinks ?? [],
    context: item.context,
    blocked: item.blocked ?? null,
    source: item.source ?? null,
  };
};

export const ANSWER_TYPE_HINTS: Readonly<Record<TMissionAnswerType, string>> = {
  single: 'Choose one',
  multi: 'Choose any that apply',
  confirm: 'Confirm or decline',
  text: 'Type your answer',
  'action-done': 'Do the action, then mark it done',
};

const CONTEXT_COLUMNS = 90;
export const CONTEXT_COLLAPSED_LINES = 12;

/** Rendered lines a markdown source takes at the card's width, estimated from its source lines. */
export const estimateContextLines = (context: string): number =>
  context.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / CONTEXT_COLUMNS)), 0);

export const isContextCollapsible = (context: string): boolean => estimateContextLines(context) > CONTEXT_COLLAPSED_LINES;

const CLOSED_REASONS: Readonly<Record<TMissionItemState, string>> = {
  candidate: 'This item went back to the orchestrator for review; it can no longer be answered here.',
  open: 'The question changed on the server; update the draft to the current question to save.',
  answered: 'This item was answered elsewhere; it can no longer be answered here.',
  resolved: 'This item is resolved; it can no longer be answered here.',
  cancelled: 'This item was cancelled; it can no longer be answered here.',
};

const EMPTY_REASONS: Readonly<Record<TMissionAnswerType, string>> = {
  single: 'Choose an option or type an answer.',
  multi: 'Choose an option or type an answer.',
  confirm: 'Choose an option or type an answer.',
  text: 'Type your answer.',
  'action-done': 'Mark the action complete or type a note.',
};

export interface ISubmitState {
  disabled: boolean;
  /** Shown beside the button whenever it is disabled: Submit is never disabled without a reason on screen. */
  reason: string | null;
  label: string;
}

export const missionSubmitState = (draft: IMissionDraft): ISubmitState => {
  if (draft.status === 'submitting') return { disabled: true, reason: 'Saving your answer…', label: 'Saving…' };
  const label = draft.status === 'error' ? 'Retry answer' : 'Save answer';
  if (draft.status === 'conflict' && draft.currentItem) {
    const state = draft.currentItem.state;
    return { disabled: true, reason: Object.hasOwn(CLOSED_REASONS, state) ? CLOSED_REASONS[state] : 'This item changed on the server; it can no longer be answered here.', label };
  }
  if (isMissionDraftEmpty(draft)) return { disabled: true, reason: EMPTY_REASONS[cardAnswerType(draft.item)], label };
  const missing = draft.optionIds
    .map((optionId) => draft.item.options.find((option) => option.id === optionId))
    .find((option) => option?.needsText && !draft.optionTexts[option.id]?.trim());
  if (missing) return { disabled: true, reason: `Add text for “${missing.label}” to save.`, label };
  return { disabled: false, reason: null, label };
};

/** The option selection after one click: one pick on single and confirm, a toggle on multi. */
export const selectOption = (draft: IMissionDraft, optionId: string): string[] => {
  const answerType = cardAnswerType(draft.item);
  if (answerType === 'confirm') return draft.optionIds.includes(optionId) ? [] : [optionId];
  if (answerType === 'single') return [optionId];
  return draft.optionIds.includes(optionId)
    ? draft.optionIds.filter((candidate) => candidate !== optionId)
    : [...draft.optionIds, optionId];
};

/** The changed fields of the span, in reading order, for "changed: <fields>"; empty when the owner could see no change. */
export const changedFields = (draft: IMissionDraft): string[] => {
  const changes = draft.notice?.changes;
  if (!changes) return [];
  return [
    changes.decision && 'decision',
    changes.title && 'title',
    changes.answerType && 'answer type',
    changes.options.removed.length > 0 && 'options removed',
    changes.options.added.length > 0 && 'options added',
    changes.options.relabelled.length > 0 && 'option wording',
    (changes.recommended !== null || changes.recommendation) && 'recommendation',
    changes.whyNow && 'why now',
    changes.context && 'context',
    changes.evidence && 'evidence',
    changes.unrecorded.length > 0 && 'other fields',
  ].filter((field): field is string => typeof field === 'string');
};

/** Whether the revision notice has anything to say: a re-stamp with no visible change shows none. */
export const hasVisibleRevision = (draft: IMissionDraft): boolean =>
  draft.notice !== null
  && (changedFields(draft).length > 0 || draft.notice.cleared.length > 0 || draft.notice.moved.length > 0);

/** An option's label as the notice knew it; neutral words when no revision named it, never the id. */
export const noticeOptionLabel = (draft: IMissionDraft, optionId: string): string => {
  const label = draft.item.options.find((option) => option.id === optionId)?.label ?? draft.notice?.labels[optionId];
  return label === undefined ? REMOVED_OPTION_LABEL : `“${label}”`;
};
