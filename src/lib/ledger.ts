// The work-item ledger's closed vocabulary and wire validators (ADR-0033). No node-only imports, so
// the UI may import it. A new item type, kind or wait reason is an amendment of the ADR, never a
// producer decision: the server refuses anything outside these lists.
import { FUTURE_TOLERANCE_MS, IDENTIFIER_REFUSED, PROSE_REFUSED, show } from '@/lib/flow';
import type {
  ILedgerEventInput,
  ILedgerExperimentGuard,
  ILedgerExperimentInput,
  TLedgerAttrValue,
  TLedgerIntervalReason,
  TLedgerItemType,
  TLedgerKind,
  TLedgerStage,
  TLedgerWaitReason,
  TLedgerWaitsBy,
} from '@/types/ledger';

export const LEDGER_ITEM_TYPES = [
  'slice', 'range', 'gate', 'review', 'landing', 'deploy', 'owner-issue', 'mc-item', 'seat', 'experiment',
] as const;

export const LEDGER_KINDS = ['open', 'state', 'wait', 'clear', 'close', 'link'] as const;

/**
 * The item types whose whole open life is waiting (ADR-0033 §3.3): a range from receipt to LANDED,
 * a deploy, an owner issue. Only their silence is an `unknown` wait. For every other type, time with
 * no open wait is work, a hold or a record's life, and is never counted as waiting.
 */
export const LEDGER_UNKNOWN_ITEM_TYPES: readonly string[] = ['range', 'deploy', 'owner-issue'];

/** The producer name of the server's own events; no token may be issued under it. */
export const LEDGER_SERVER_PRODUCER = 'purplemux';

export const isReservedProducer = (producer: string): boolean =>
  producer === LEDGER_SERVER_PRODUCER || producer.startsWith(`${LEDGER_SERVER_PRODUCER}:`);

/** Item types only the server writes: a producer token that sends one is refused. */
export const SERVER_OWNED_ITEM_TYPES: readonly string[] = ['experiment', 'seat', 'mc-item'];

export const LEDGER_STAGES = ['build-review', 'land', 'deploy', 'people', 'hosts'] as const;

export const LEDGER_STAGE_REASONS = {
  'build-review': ['review-queue', 'review-findings', 'rework', 'receipt-rekey'],
  land: [
    'not-armed', 'pre-arm-gate', 'fold-batch', 'own-lane-order', 'group-partner', 'guard-hold', 'gate-slot',
    'pre-flight-gate', 'land-queue', 'lock-wait', 'under-lock-gate', 'red-main', 'chain-down',
  ],
  deploy: ['deploy-queue', 'deploy-run', 'deploy-auth', 'external-team'],
  people: ['owner', 'agent-idle'],
  hosts: ['host-load'],
} as const;

export const LEDGER_WAIT_REASONS = [
  ...LEDGER_STAGE_REASONS['build-review'],
  ...LEDGER_STAGE_REASONS.land,
  ...LEDGER_STAGE_REASONS.deploy,
  ...LEDGER_STAGE_REASONS.people,
  ...LEDGER_STAGE_REASONS.hosts,
] as const;

export const LAND_QUEUE_LOCK_BUSY = 'land-queue/lock-busy';
export const LAND_QUEUE_HEAD_BLOCKED = 'land-queue/head-blocked';
export const UNKNOWN_REASON = 'unknown';
export const LEDGER_DERIVED_REASONS = [LAND_QUEUE_LOCK_BUSY, LAND_QUEUE_HEAD_BLOCKED, UNKNOWN_REASON] as const;

export const LEDGER_WAITS_BY = ['reason', 'holder', 'type', 'stage'] as const;

/** An open item with no active wait and no event for this long is counted as an `unknown` wait. */
export const LEDGER_SILENT_MS = 10 * 60_000;
export const MAX_LEDGER_EVENTS = 500;
export const MAX_LEDGER_BYTES = 1024 * 1024;
export const LEDGER_RETENTION_DAYS = 92;
/** `tab_events` (ADR-HFL-05 decision 3): a month of what each tab was sent. */
export const LEDGER_TAB_EVENTS_RETENTION_DAYS = 30;
export const LEDGER_ROLLUP_RETENTION_DAYS = 400;
export const DAY_MS = 24 * 60 * 60_000;

/** A producer name becomes a spool file name (`ledger-spool/<producer>.jsonl`), so it is a plain slug. */
export const LEDGER_PRODUCER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const MAX_ATTR_KEYS = 32;

export type TLedgerRefusalCode = 'ledger-event-invalid' | 'ledger-reason-invalid' | 'ledger-experiment-invalid' | 'ledger-query-invalid';

/** A refusal that names the field, the value seen and what was expected (the allowed list for a vocabulary). */
export class LedgerRefusal extends Error {
  readonly code: TLedgerRefusalCode;
  readonly field: string;
  readonly allowed: readonly string[] | null;

  constructor(code: TLedgerRefusalCode, field: string, value: unknown, expected: string, allowed: readonly string[] | null = null) {
    super(`${field}: saw ${show(value)}, expected ${expected}`);
    this.name = 'LedgerRefusal';
    this.code = code;
    this.field = field;
    this.allowed = allowed;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const has = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

const oneOf = (list: readonly string[]): string => `one of ${list.join(', ')}`;

type TCode = TLedgerRefusalCode;

const keysOnly = (value: Record<string, unknown>, field: string, keys: readonly string[], code: TCode): void => {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new LedgerRefusal(code, `${field}.${key}`, value[key], `only the keys ${keys.join(', ')}`);
  }
};

const identifier = (value: unknown, field: string, max: number, code: TCode): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new LedgerRefusal(code, field, value, `a non-blank string of at most ${max} characters`);
  }
  if (IDENTIFIER_REFUSED.test(value)) throw new LedgerRefusal(code, field, value, 'no control or format character');
  return value;
};

const optionalIdentifier = (value: unknown, field: string, max: number, code: TCode): string | null =>
  value === undefined || value === null ? null : identifier(value, field, max, code);

const prose = (value: unknown, field: string, max: number, code: TCode): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new LedgerRefusal(code, field, value, `a non-blank string of at most ${max} characters`);
  }
  if (PROSE_REFUSED.test(value)) throw new LedgerRefusal(code, field, value, 'no control character and no bidi control');
  return value;
};

const optionalProse = (value: unknown, field: string, max: number, code: TCode): string | null =>
  value === undefined || value === null ? null : prose(value, field, max, code);

const absent = (event: Record<string, unknown>, key: string, field: string, kind: string): void => {
  if (event[key] !== undefined && event[key] !== null) {
    throw new LedgerRefusal('ledger-event-invalid', `${field}.${key}`, event[key], `nothing for kind ${kind}`);
  }
};

const EVENT_KEYS = [
  'event_id', 'at', 'item_type', 'item_key', 'kind', 'state', 'wait_reason', 'holder', 'clear_input', 'parent_key', 'attrs',
];

const itemKey = (value: unknown, field: string, type: TLedgerItemType | null): string => {
  const key = identifier(value, field, 200, 'ledger-event-invalid');
  const prefix = key.slice(0, key.indexOf(':'));
  const rest = key.slice(key.indexOf(':') + 1);
  const expected = type ? `"${type}:<id>"` : `"<item type>:<id>" with an item type ${oneOf(LEDGER_ITEM_TYPES)}`;
  if (!key.includes(':') || !rest || (type ? prefix !== type : !has(LEDGER_ITEM_TYPES, prefix))) {
    throw new LedgerRefusal('ledger-event-invalid', field, value, expected);
  }
  return key;
};

const attrs = (value: unknown, field: string): Record<string, TLedgerAttrValue> | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new LedgerRefusal('ledger-event-invalid', field, value, 'an object of scalar values');
  const entries = Object.entries(value);
  if (entries.length > MAX_ATTR_KEYS) {
    throw new LedgerRefusal('ledger-event-invalid', field, `${entries.length} keys`, `at most ${MAX_ATTR_KEYS} keys`);
  }
  const result: Record<string, TLedgerAttrValue> = {};
  for (const [key, entry] of entries) {
    identifier(key, `${field} key`, 64, 'ledger-event-invalid');
    const at = `${field}.${key}`;
    if (typeof entry === 'string') result[key] = prose(entry, at, 500, 'ledger-event-invalid');
    else if (entry === null || typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))) result[key] = entry;
    else throw new LedgerRefusal('ledger-event-invalid', at, entry, 'a string, a finite number, a boolean or null');
  }
  return result;
};

/** One producer event, normalized: an optional field absent on the wire is null here. */
export const parseLedgerEvent = (value: unknown, field: string, receivedAt: number): ILedgerEventInput => {
  if (!isRecord(value)) throw new LedgerRefusal('ledger-event-invalid', field, value, 'an event object');
  keysOnly(value, field, EVENT_KEYS, 'ledger-event-invalid');
  const eventId = identifier(value.event_id, `${field}.event_id`, 128, 'ledger-event-invalid');
  const at = value.at;
  // Older than retention, an event would recreate an item the daily job already deleted.
  const cutoff = receivedAt - LEDGER_RETENTION_DAYS * DAY_MS;
  if (!Number.isSafeInteger(at) || (at as number) < cutoff || (at as number) > receivedAt + FUTURE_TOLERANCE_MS) {
    throw new LedgerRefusal('ledger-event-invalid', `${field}.at`, at,
      `a time in Unix ms from the 92-day retention cutoff ${cutoff} to 5 min after the server clock ${receivedAt}`);
  }
  if (!has(LEDGER_ITEM_TYPES, value.item_type)) {
    throw new LedgerRefusal('ledger-event-invalid', `${field}.item_type`, value.item_type, oneOf(LEDGER_ITEM_TYPES), LEDGER_ITEM_TYPES);
  }
  const itemType = value.item_type as TLedgerItemType;
  if (!has(LEDGER_KINDS, value.kind)) {
    throw new LedgerRefusal('ledger-event-invalid', `${field}.kind`, value.kind, oneOf(LEDGER_KINDS), LEDGER_KINDS);
  }
  const kind = value.kind as TLedgerKind;
  const key = itemKey(value.item_key, `${field}.item_key`, itemType);
  if (kind === 'wait') {
    if (!has(LEDGER_WAIT_REASONS, value.wait_reason)) {
      const derived = has(LEDGER_DERIVED_REASONS, value.wait_reason) ? ' (a derived reason: the server writes it, a producer never sends it)' : '';
      throw new LedgerRefusal('ledger-reason-invalid', `${field}.wait_reason`, value.wait_reason,
        `${oneOf(LEDGER_WAIT_REASONS)}${derived}`, LEDGER_WAIT_REASONS);
    }
  } else {
    absent(value, 'wait_reason', field, kind);
  }
  if (kind !== 'wait') absent(value, 'clear_input', field, kind);
  const state = kind === 'state'
    ? identifier(value.state, `${field}.state`, 64, 'ledger-event-invalid')
    : optionalIdentifier(value.state, `${field}.state`, 64, 'ledger-event-invalid');
  const parentKey = value.parent_key === undefined || value.parent_key === null
    ? (kind === 'link' ? itemKey(value.parent_key, `${field}.parent_key`, null) : null)
    : itemKey(value.parent_key, `${field}.parent_key`, null);
  return {
    event_id: eventId,
    at: at as number,
    item_type: itemType,
    item_key: key,
    kind,
    state,
    wait_reason: kind === 'wait' ? value.wait_reason as TLedgerWaitReason : null,
    holder: optionalIdentifier(value.holder, `${field}.holder`, 128, 'ledger-event-invalid'),
    clear_input: optionalProse(value.clear_input, `${field}.clear_input`, 500, 'ledger-event-invalid'),
    parent_key: parentKey,
    attrs: attrs(value.attrs, `${field}.attrs`),
  };
};

/** A batch `{ "events": [...] }` of 1 to 500 events. Any refused event refuses the whole batch. */
export const parseLedgerBatch = (body: unknown, receivedAt: number): ILedgerEventInput[] => {
  if (!isRecord(body)) throw new LedgerRefusal('ledger-event-invalid', 'body', body, 'an object { "events": [...] }');
  keysOnly(body, 'body', ['events'], 'ledger-event-invalid');
  if (!Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_LEDGER_EVENTS) {
    const seen = Array.isArray(body.events) ? `${body.events.length} events` : body.events;
    throw new LedgerRefusal('ledger-event-invalid', 'events', seen, `an array of 1 to ${MAX_LEDGER_EVENTS} events`);
  }
  return body.events.map((event, index) => parseLedgerEvent(event, `events[${index}]`, receivedAt));
};

export const isLedgerProducer = (value: unknown): value is string =>
  typeof value === 'string' && LEDGER_PRODUCER_PATTERN.test(value);

/** The stage a counted reason belongs to; `unknown` is its own stage. */
export const stageOfReason = (reason: string): TLedgerStage | typeof UNKNOWN_REASON => {
  if (reason === LAND_QUEUE_LOCK_BUSY || reason === LAND_QUEUE_HEAD_BLOCKED) return 'land';
  for (const stage of LEDGER_STAGES) {
    if ((LEDGER_STAGE_REASONS[stage] as readonly string[]).includes(reason)) return stage;
  }
  return UNKNOWN_REASON;
};

/** Every reason an interval may carry: the producer reasons less `land-queue`, plus the derived ones. */
export const LEDGER_INTERVAL_REASONS: readonly TLedgerIntervalReason[] = [
  ...LEDGER_WAIT_REASONS.filter((reason): reason is Exclude<TLedgerWaitReason, 'land-queue'> => reason !== 'land-queue'),
  ...LEDGER_DERIVED_REASONS,
];

/** Nearest-rank percentile of an ascending list; null for an empty one. */
export const percentile = (sorted: readonly number[], p: number): number | null =>
  sorted.length ? sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] : null;

/** The part of [start, end) inside [since, until), in ms; 0 when they do not overlap. */
export const clippedMs = (start: number, end: number, since: number, until: number): number =>
  Math.max(0, Math.min(end, until) - Math.max(start, since));

export const isWaitsBy = (value: unknown): value is TLedgerWaitsBy => has(LEDGER_WAITS_BY, value);

const EXPERIMENT_KEYS = [
  'hypothesis', 'change_ref', 'stage', 'reason', 'metric', 'baseline', 'target', 'guards', 'revert_if', 'min_days', 'max_days',
];

const finiteOrNull = (value: unknown, field: string): number | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new LedgerRefusal('ledger-experiment-invalid', field, value, 'null or a finite number');
};

const days = (value: unknown, field: string, min: number): number => {
  if (Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= 90) return value as number;
  throw new LedgerRefusal('ledger-experiment-invalid', field, value, `an integer from ${min} to 90`);
};

const guards = (value: unknown): ILedgerExperimentGuard[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new LedgerRefusal('ledger-experiment-invalid', 'guards', value, 'an array of at most 8 { "metric", "limit" }');
  }
  return value.map((guard, index) => {
    const field = `guards[${index}]`;
    if (!isRecord(guard)) throw new LedgerRefusal('ledger-experiment-invalid', field, guard, 'an object { "metric", "limit" }');
    keysOnly(guard, field, ['metric', 'limit'], 'ledger-experiment-invalid');
    const limit = finiteOrNull(guard.limit, `${field}.limit`);
    if (limit === null) throw new LedgerRefusal('ledger-experiment-invalid', `${field}.limit`, guard.limit, 'a finite number');
    return { metric: identifier(guard.metric, `${field}.metric`, 64, 'ledger-experiment-invalid'), limit };
  });
};

/** The experiment record ADR-HFL-03 point 3 names; the server assigns the id, start time and verdict. */
export const parseExperimentInput = (body: unknown): ILedgerExperimentInput => {
  if (!isRecord(body)) throw new LedgerRefusal('ledger-experiment-invalid', 'body', body, 'an experiment object');
  keysOnly(body, 'body', EXPERIMENT_KEYS, 'ledger-experiment-invalid');
  if (!has(LEDGER_STAGES, body.stage)) {
    throw new LedgerRefusal('ledger-experiment-invalid', 'stage', body.stage, oneOf(LEDGER_STAGES), LEDGER_STAGES);
  }
  if (body.reason !== undefined && body.reason !== null && !has(LEDGER_INTERVAL_REASONS, body.reason)) {
    throw new LedgerRefusal('ledger-reason-invalid', 'reason', body.reason, `null or ${oneOf(LEDGER_INTERVAL_REASONS)}`, LEDGER_INTERVAL_REASONS);
  }
  let baseline: ILedgerExperimentInput['baseline'] = null;
  if (body.baseline !== undefined && body.baseline !== null) {
    if (!isRecord(body.baseline)) throw new LedgerRefusal('ledger-experiment-invalid', 'baseline', body.baseline, 'null or { "value", "window" }');
    keysOnly(body.baseline, 'baseline', ['value', 'window'], 'ledger-experiment-invalid');
    const value = finiteOrNull(body.baseline.value, 'baseline.value');
    if (value === null) throw new LedgerRefusal('ledger-experiment-invalid', 'baseline.value', body.baseline.value, 'a finite number');
    baseline = { value, window: identifier(body.baseline.window, 'baseline.window', 64, 'ledger-experiment-invalid') };
  }
  const minDays = days(body.min_days, 'min_days', 1);
  return {
    hypothesis: prose(body.hypothesis, 'hypothesis', 500, 'ledger-experiment-invalid'),
    change_ref: optionalIdentifier(body.change_ref, 'change_ref', 200, 'ledger-experiment-invalid'),
    stage: body.stage as TLedgerStage,
    reason: (body.reason ?? null) as TLedgerIntervalReason | null,
    metric: identifier(body.metric, 'metric', 64, 'ledger-experiment-invalid'),
    baseline,
    target: finiteOrNull(body.target, 'target'),
    guards: guards(body.guards),
    revert_if: optionalProse(body.revert_if, 'revert_if', 500, 'ledger-experiment-invalid'),
    min_days: minDays,
    max_days: days(body.max_days, 'max_days', minDays),
  };
};
