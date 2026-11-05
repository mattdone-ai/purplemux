import { z } from 'zod';
import type {
  IMissionAnswerRequest,
  IMissionEventDefect,
  IMissionEventLint,
  TMissionProducerEvent,
} from '@/types/mission-control';
import { MissionControlError } from '@/lib/mission-control-errors';
import { validateMissionQuestion } from '@/lib/mission-question-format';

const id = z.string().trim().min(1).max(128);
const timestamp = z.number().int().safe().nonnegative();
const revision = z.number().int().safe().nonnegative();
const shortText = z.string().trim().min(1).max(500);
const nullableLongText = z.string().trim().max(8000).nullable();
const epic = z.object({
  id,
  title: shortText,
  url: z.string().url().max(2048).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)).nullable(),
}).strict();
const storyCounts = z.object({
  total: revision,
  done: revision,
  blocked: revision,
}).strict().refine((value) => value.done <= value.total && value.blocked <= value.total, 'invalid story counts');
const reviewText = z.string().trim().min(1).max(1000);
const humanReview = z.discriminatedUnion('humanNeed', [
  z.object({
    humanNeed: z.literal('none'),
    handling: reviewText,
    reviewerTabId: id,
  }).strict(),
  z.object({
    humanNeed: z.enum(['decision', 'approval', 'information', 'external-action']),
    humanReason: reviewText,
    handling: reviewText,
    reviewerTabId: id,
  }).strict(),
]);
const base = {
  eventId: id,
  schemaVersion: z.literal(1),
  workspaceId: id,
  runId: id,
  expectedRevision: revision,
  producerAt: timestamp,
  bindingGeneration: revision,
};

const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('run.started'), payload: z.object({ objective: shortText, epic: epic.optional().nullable(), tabId: id }).strict() }).strict(),
  z.object({ ...base, type: z.literal('run.resumed'), payload: z.object({ tabId: id, transferPendingAnswers: z.boolean() }).strict() }).strict(),
  z.object({ ...base, type: z.literal('progress.updated'), payload: z.object({
    objective: shortText.optional(),
    epic: epic.optional().nullable(),
    phase: z.string().trim().max(500).optional().nullable(),
    state: z.enum(['running', 'waiting']).optional(),
    nextStep: nullableLongText.optional(),
    storyCounts: storyCounts.optional().nullable(),
    closeoutPending: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'progress update must change at least one field') }).strict(),
  z.object({ ...base, type: z.literal('run.finished'), payload: z.object({ state: z.enum(['completed', 'cancelled']), summary: z.string().trim().min(1).max(8000), closeoutPending: z.boolean() }).strict() }).strict(),
  // The question fields are checked by validateMissionQuestion (ADR-0037), which names every defect.
  z.object({ ...base, type: z.literal('attention.opened'), payload: z.object({ itemId: id, humanReview: humanReview.optional() }).loose() }).strict(),
  z.object({ ...base, type: z.literal('attention.updated'), payload: z.object({ itemId: id, humanReview: humanReview.optional() }).loose() }).strict(),
  z.object({ ...base, type: z.literal('attention.resolved'), payload: z.object({ itemId: id, resolution: z.string().trim().min(1).max(8000) }).strict() }).strict(),
  z.object({ ...base, type: z.literal('attention.cancelled'), payload: z.object({ itemId: id, reason: z.string().trim().min(1).max(8000) }).strict() }).strict(),
  z.object({ ...base, type: z.literal('answer.acknowledged'), payload: z.object({ answerId: id }).strict() }).strict(),
]);

const answerSchema = z.object({
  submissionId: id,
  expectedRevision: revision,
  optionIds: z.array(id).max(20),
  text: z.string().trim().max(8000),
  actionCompleted: z.boolean(),
  /** Where the owner answered (story 33): recorded, outside the content hash; absent from older clients. */
  source: z.enum(['web', 'phone', 'notification']).optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.optionIds).size !== value.optionIds.length) {
    context.addIssue({ code: 'custom', message: 'duplicate option selections' });
  }
  if (!value.optionIds.length && !value.text && !value.actionCompleted) {
    context.addIssue({ code: 'custom', message: 'answer must select an option, provide text, or complete the action' });
  }
});

const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new MissionControlError(400, 'invalid-request', result.error.issues[0]?.message ?? 'invalid request');
  }
  return result.data;
};

// `answer:auto:` is the event ID of the bookkeeping rule's answer (ADR-0031 §6): its submission ID is
// predictable, so a producer must not take the event ID first.
// `system:needs-decision:` is the server's NEEDS-DECISION opener (ADR-0041): only it may take one.
export const NEEDS_DECISION_EVENT_PREFIX = 'system:needs-decision:';
/** The server's keep-or-strike item for an order the curator filed (story 23): only it may take one. */
export const CURATOR_ORDER_EVENT_PREFIX = 'system:curator-so:';
const RESERVED_EVENT_ID_PREFIXES = ['system:migration:', 'system:rebind:', 'answer:auto:', NEEDS_DECISION_EVENT_PREFIX, CURATOR_ORDER_EVENT_PREFIX];
/**
 * Item ids only a server producer opens or revises, by the producer's event prefix: a `strike` answer on a
 * `curator-so-<n>` item strikes an order, so no tab or token may open one (story 23 review r1 F1).
 */
export const CURATOR_ORDER_ITEM_PREFIX = 'curator-so-';
const RESERVED_ITEM_ID_PREFIXES: ReadonlyArray<{ itemPrefix: string; serverPrefix: string }> = [
  { itemPrefix: CURATOR_ORDER_ITEM_PREFIX, serverPrefix: CURATOR_ORDER_EVENT_PREFIX },
];
const RESERVED_SUBMISSION_ID_PREFIX = 'auto:';

export interface IMissionEventBatch {
  events: TMissionProducerEvent[];
  /** Format-2 findings of the accepted v1 questions (ADR-0037 §2); only events with findings. */
  lint: IMissionEventLint[];
}

type TParsedEvent = z.infer<typeof eventSchema>;

/**
 * Each attention event's question through the one validator: the batch is refused with every
 * defect of every event, or each payload is replaced by its normalized question.
 */
const checkQuestions = (events: TParsedEvent[], minVersion: 1 | 2): IMissionEventBatch => {
  const defects: IMissionEventDefect[] = [];
  const lint: IMissionEventLint[] = [];
  const checked = events.map((event) => {
    if (event.type !== 'attention.opened' && event.type !== 'attention.updated') return event;
    const { itemId, humanReview: review, ...question } = event.payload;
    // AC 3 refuses a NEW v1 question; an update of a v1 item stays v1 with lint (the store refuses a v2 -> v1 downgrade).
    const verdict = validateMissionQuestion(question, event.type === 'attention.opened' ? minVersion : 1);
    if (!verdict.ok) {
      defects.push(...verdict.defects.map((entry) => ({ eventId: event.eventId, itemId, ...entry })));
      return event;
    }
    if (verdict.lint.length) lint.push({ eventId: event.eventId, itemId, findings: verdict.lint });
    return { ...event, payload: { itemId, ...verdict.question, ...(review ? { humanReview: review } : {}) } };
  });
  if (defects.length) {
    const refused = new Set(defects.map((entry) => entry.eventId)).size;
    throw new MissionControlError(400, 'question-invalid',
      `${defects.length} question defect${defects.length === 1 ? '' : 's'} in ${refused} event${refused === 1 ? '' : 's'}: ${defects.map((entry) => entry.message).join('; ')}`,
      undefined, { defects });
  }
  return { events: checked as TMissionProducerEvent[], lint };
};

/** `serverPrefix`: the one reserved namespace a server producer writes in; no request ever carries it. */
export const parseMissionEventBatch = (
  input: unknown,
  options: { questionMinVersion?: 1 | 2; serverPrefix?: string } = {},
): IMissionEventBatch => {
  const events = parse(z.array(eventSchema).min(1).max(25), input);
  const reserved = RESERVED_EVENT_ID_PREFIXES.filter((prefix) => prefix !== options.serverPrefix);
  if (events.some((event) => reserved.some((prefix) => event.eventId.startsWith(prefix)))) {
    throw new MissionControlError(400, 'invalid-request', 'event ID uses a reserved namespace');
  }
  for (const event of events) {
    if (event.type !== 'attention.opened' && event.type !== 'attention.updated') continue;
    const owner = RESERVED_ITEM_ID_PREFIXES.find((r) => event.payload.itemId.startsWith(r.itemPrefix));
    if (owner && owner.serverPrefix !== options.serverPrefix) {
      throw new MissionControlError(400, 'invalid-request', `item ID ${event.payload.itemId} uses a namespace only the server opens or revises`);
    }
  }
  const eventIds = events.map((event) => event.eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    throw new MissionControlError(400, 'invalid-request', 'duplicate event IDs in batch');
  }
  return checkQuestions(events, options.questionMinVersion ?? 1);
};

export const parseMissionEvents = (input: unknown, options: { questionMinVersion?: 1 | 2 } = {}): TMissionProducerEvent[] =>
  parseMissionEventBatch(input, options).events;

export const parseMissionAnswer = (input: unknown): IMissionAnswerRequest => {
  const answer = parse(answerSchema, input);
  if (answer.submissionId.startsWith(RESERVED_SUBMISSION_ID_PREFIX)) {
    throw new MissionControlError(400, 'invalid-request', 'submission ID uses a reserved namespace');
  }
  return answer;
};

export const parseMissionCursor = (value: unknown, fallback: number): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new MissionControlError(400, 'invalid-request', 'cursor must be a nonnegative integer');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new MissionControlError(400, 'invalid-request', 'cursor must be a safe integer');
  }
  return parsed;
};

export const parseMissionLimit = (value: unknown, fallback: number, maximum: number): number => {
  const parsed = parseMissionCursor(value, fallback);
  if (parsed < 1 || parsed > maximum) {
    throw new MissionControlError(400, 'invalid-request', `limit must be between 1 and ${maximum}`);
  }
  return parsed;
};
