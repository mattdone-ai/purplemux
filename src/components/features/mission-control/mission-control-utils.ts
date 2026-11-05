import { combineMissionChanges, diffMissionQuestions, questionOfItem } from '@/lib/mission-question-format';
import type {
  IMissionAnswerRequest,
  IMissionAttentionItem,
  IMissionDelivery,
  IMissionQuestionChanges,
  IMissionSnapshot,
} from '@/types/mission-control';

export type TMissionDraftStatus = 'editing' | 'submitting' | 'error' | 'conflict';

/** What changed under the owner's draft (ADR-0037 §4) in the last observed revision; a later revision replaces it. Moved text stays in Other. */
export interface IMissionRevisionNotice {
  /** Whether the answer still applies to the revision it was made on. */
  compatible: boolean;
  /**
   * The span the server will judge: from `expectedRevision` to the current revision while
   * compatible (each observed step merged, as the server merges revisions); the span that forced
   * the move to the current revision otherwise.
   */
  changes: IMissionQuestionChanges;
  /** The last observed step, from the question the owner was looking at to the current one: marks and clearing. */
  step: IMissionQuestionChanges;
  /** Selections the change removed: their option was removed, reworded or is gone. */
  cleared: string[];
  /** Options whose typed text moved into "Other" because the option no longer takes it. */
  moved: string[];
  /** Option labels known when the change arrived: the current question first, then the one before it. */
  labels: Record<string, string>;
}

export interface IMissionDraft {
  /** The current question, as rendered. */
  item: IMissionAttentionItem;
  /** The revision the answer is made on; below `item.revision` while every change since was compatible. */
  expectedRevision: number;
  submissionId: string;
  optionIds: string[];
  /** The text a selected `needsText` option requires, by option id. */
  optionTexts: Record<string, string>;
  /** The "Other" text: always available. */
  text: string;
  actionCompleted: boolean;
  notice: IMissionRevisionNotice | null;
  status: TMissionDraftStatus;
  error: string | null;
  currentItem: IMissionAttentionItem | null;
  hasAttempted: boolean;
}

export interface IMissionDraftPatch {
  optionIds?: string[];
  optionTexts?: Record<string, string>;
  text?: string;
  actionCompleted?: boolean;
}

export const createMissionSubmissionId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
};

export const createMissionDraft = (
  item: IMissionAttentionItem,
  submissionId = createMissionSubmissionId(),
): IMissionDraft => ({
  item,
  expectedRevision: item.revision,
  submissionId,
  optionIds: [],
  optionTexts: {},
  text: '',
  actionCompleted: false,
  notice: null,
  status: 'editing',
  error: null,
  currentItem: null,
  hasAttempted: false,
});

export const editMissionDraft = (
  draft: IMissionDraft,
  patch: IMissionDraftPatch,
  nextSubmissionId = createMissionSubmissionId(),
): IMissionDraft => {
  const unresolvedConflict = draft.status === 'conflict' && draft.currentItem !== null;
  return {
    ...draft,
    ...patch,
    submissionId: draft.hasAttempted ? nextSubmissionId : draft.submissionId,
    status: unresolvedConflict ? 'conflict' : 'editing',
    error: null,
    currentItem: unresolvedConflict ? draft.currentItem : draft.hasAttempted ? null : draft.currentItem,
    hasAttempted: false,
  };
};

export const adoptCurrentMissionItem = (
  draft: IMissionDraft,
  submissionId = createMissionSubmissionId(),
): IMissionDraft => {
  if (!draft.currentItem) return draft;

  const validOptionIds = new Set(draft.currentItem.options.map((option) => option.id));
  return {
    ...draft,
    item: draft.currentItem,
    expectedRevision: draft.currentItem.revision,
    submissionId,
    optionIds: draft.optionIds.filter((optionId) => validOptionIds.has(optionId)),
    notice: null,
    status: 'editing',
    error: null,
    currentItem: null,
    hasAttempted: false,
  };
};

/**
 * The one answer text the server stores: each selected `needsText` option's text under its label,
 * then the "Other" text. The server checks only that text is present (ADR-0037 §1).
 */
export const missionDraftText = (draft: IMissionDraft): string => {
  const other = draft.text.trim();
  const optionParts = draft.optionIds.flatMap((optionId) => {
    const option = draft.item.options.find((candidate) => candidate.id === optionId);
    const value = draft.optionTexts[optionId]?.trim();
    return option?.needsText && value ? [`${option.label}: ${value}`] : [];
  });
  if (!optionParts.length) return other;
  return [...optionParts, ...(other ? [`Other: ${other}`] : [])].join('\n\n');
};

export const missionDraftRequest = (draft: IMissionDraft): IMissionAnswerRequest => ({
  submissionId: draft.submissionId,
  expectedRevision: draft.expectedRevision,
  optionIds: draft.optionIds,
  text: missionDraftText(draft),
  actionCompleted: draft.actionCompleted,
  // The web client is served by the server it posts to, so the field is always understood (story 33 R3).
  source: 'web',
});

export const isMissionDraftEmpty = (draft: IMissionDraft): boolean =>
  draft.optionIds.length === 0 && draft.text.trim().length === 0 && !draft.actionCompleted;

const labelsOf = (item: IMissionAttentionItem): Record<string, string> =>
  Object.fromEntries(item.options.map((option) => [option.id, option.label]));

/** Neutral words for an option no known revision names: never the raw id. */
export const REMOVED_OPTION_LABEL = 'an option that was removed';

/**
 * Typed text whose option no longer takes it moves into "Other" under the option's old label, so
 * a revision never drops what the owner wrote (ADR-0037 §4).
 */
const keepOptionTexts = (
  draft: IMissionDraft,
  currentItem: IMissionAttentionItem,
  kept: string[],
  labels: Record<string, string>,
): { optionTexts: Record<string, string>; text: string; moved: string[] } => {
  const optionTexts: Record<string, string> = {};
  const movedLines: string[] = [];
  const moved: string[] = [];
  for (const [optionId, value] of Object.entries(draft.optionTexts)) {
    const option = currentItem.options.find((candidate) => candidate.id === optionId);
    const selected = draft.optionIds.includes(optionId);
    if (!selected || (option?.needsText && kept.includes(optionId))) {
      if (!selected && !option) continue;
      optionTexts[optionId] = value;
    } else if (value.trim()) {
      moved.push(optionId);
      movedLines.push(`${labels[optionId] ?? REMOVED_OPTION_LABEL}: ${value.trim()}`);
    }
  }
  const text = [draft.text.trim() ? draft.text : null, ...movedLines].filter((part): part is string => part !== null).join('\n\n');
  return { optionTexts, text: moved.length ? text : draft.text, moved };
};

/**
 * One observed revision applied to the draft (ADR-0037 §4). The step is the change from the
 * question on screen to the current one; the span adds it to the earlier compatible steps, as
 * the server merges each revision, and decides whether the answer still applies. When it does,
 * the selection, the text and the answered revision stay. When it does not, only the selections
 * the step removed or reworded are cleared (all of them when the answer type changed), and the
 * draft answers the current revision. A selection the current question lacks always goes.
 */
const applyMissionRevision = (
  draft: IMissionDraft,
  currentItem: IMissionAttentionItem,
  serverSpan: IMissionQuestionChanges | null,
  nextSubmissionId: string,
): IMissionDraft => {
  const step = diffMissionQuestions(questionOfItem(draft.item), questionOfItem(currentItem), draft.item.revision, currentItem.revision);
  const tracked = draft.notice?.compatible && draft.expectedRevision < draft.item.revision ? draft.notice.changes : null;
  const span = serverSpan
    ? { ...serverSpan, compatible: false }
    : tracked ? combineMissionChanges(tracked, step) : { ...step, fromRevision: draft.expectedRevision };
  const labels = { ...draft.notice?.labels, ...labelsOf(draft.item), ...labelsOf(currentItem) };
  const present = new Set(currentItem.options.map((option) => option.id));
  const changed = new Set([...step.options.removed, ...step.options.relabelled.map((entry) => entry.id)]);
  const cleared = draft.optionIds.filter((optionId) => !present.has(optionId)
    || (!span.compatible && (step.answerType !== null || changed.has(optionId))));
  const kept = draft.optionIds.filter((optionId) => !cleared.includes(optionId));
  const { optionTexts, text, moved } = keepOptionTexts(draft, currentItem, kept, {
    ...labels, ...labelsOf(draft.item),
  });
  return {
    ...draft,
    item: currentItem,
    expectedRevision: span.compatible ? draft.expectedRevision : currentItem.revision,
    submissionId: draft.hasAttempted ? nextSubmissionId : draft.submissionId,
    optionIds: kept,
    optionTexts,
    text,
    notice: { compatible: span.compatible, changes: span, step, cleared, moved, labels },
    status: 'editing',
    error: null,
    currentItem: null,
    hasAttempted: false,
  };
};

/**
 * The server refused the answer with 409 (ADR-0037 §4): move the draft onto the current revision
 * with the server's record of what changed. Submit stays available.
 */
export const rebaseMissionDraft = (
  draft: IMissionDraft,
  currentItem: IMissionAttentionItem,
  changes?: IMissionQuestionChanges,
  nextSubmissionId = createMissionSubmissionId(),
): IMissionDraft => applyMissionRevision(draft, currentItem, changes ?? diffMissionQuestions(
  questionOfItem(draft.item), questionOfItem(currentItem), draft.expectedRevision, currentItem.revision), nextSubmissionId);

export const reconcileMissionDraftWithItem = (
  draft: IMissionDraft,
  currentItem: IMissionAttentionItem | undefined,
  nextSubmissionId = createMissionSubmissionId(),
): IMissionDraft | null => {
  if (!currentItem || (currentItem.state === 'open' && currentItem.revision === draft.item.revision)) {
    return draft;
  }
  // A snapshot older than the draft's item (a 409 already moved the draft on) is stale, not the draft.
  if (currentItem.revision < draft.item.revision) return draft;
  if (currentItem.state === 'open' && currentItem.revision > draft.item.revision) {
    if (draft.status === 'submitting') return draft;
    return applyMissionRevision(draft, currentItem, null, nextSubmissionId);
  }
  if (currentItem.state !== 'candidate' && isMissionDraftEmpty(draft) && !draft.hasAttempted) return null;
  return {
    ...draft,
    status: 'conflict',
    error: null,
    currentItem,
    hasAttempted: true,
  };
};

export const isMissionHumanInboxItem = (item: IMissionAttentionItem): boolean =>
  item.state === 'open'
  && item.humanReview !== null
  && item.humanReview.humanNeed !== 'none';

export const missionWorkspaceIssuePresentation = (
  item: IMissionAttentionItem,
): { badge: string; explanation: string } => {
  if (item.humanReview?.humanNeed === 'none') {
    return {
      badge: 'Orchestrator handling',
      explanation: item.humanReview.handling,
    };
  }
  if (item.candidateReason === 'legacy-review') {
    return {
      badge: 'Orchestrator review required',
      explanation: 'Previously shown in Needs you. Awaiting review of whether your input is required.',
    };
  }
  return {
    badge: 'Orchestrator review required',
    explanation: item.candidateReason === 'historical-context'
      ? 'Historical context is waiting for the orchestrator to decide how it should be handled.'
      : 'The orchestrator must review this workspace issue before it can require your input.',
  };
};

export const shouldApplyMissionSnapshot = (
  current: IMissionSnapshot | null,
  incoming: IMissionSnapshot,
): boolean => {
  if (!current) return true;
  if (incoming.cursor !== current.cursor) return incoming.cursor > current.cursor;
  return incoming.generatedAt >= current.generatedAt;
};

export const mergeMissionRefreshSnapshot = (
  current: IMissionSnapshot | null,
  incoming: IMissionSnapshot,
  bootstrapEpochAtRequest: number,
  currentBootstrapEpoch: number,
): IMissionSnapshot => {
  if (current && !shouldApplyMissionSnapshot(current, incoming)) return current;
  if (current && currentBootstrapEpoch > bootstrapEpochAtRequest) {
    return { ...incoming, bootstrap: current.bootstrap };
  }
  return incoming;
};

export const deliveryStatus = (
  delivery: IMissionDelivery | undefined,
): { label: string; tone: 'neutral' | 'positive' | 'warning' | 'negative' } => {
  if (!delivery) return { label: 'Saved · delivery status pending', tone: 'neutral' };

  switch (delivery.state) {
    case 'queued':
      return { label: 'Saved · queued for delivery', tone: 'neutral' };
    case 'dispatching':
      return { label: 'Saved · delivery in progress', tone: 'neutral' };
    case 'submitted':
      return { label: 'Delivered · awaiting acknowledgement', tone: 'warning' };
    case 'acknowledged':
      return { label: 'Acknowledged by orchestrator', tone: 'positive' };
    case 'held':
      return { label: 'Saved · delivery held', tone: 'warning' };
    case 'failed':
      return { label: 'Saved · delivery failed', tone: 'negative' };
  }
};

export const formatMissionAge = (timestamp: number | null, now = Date.now()): string => {
  if (timestamp === null) return 'Not reported';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};
