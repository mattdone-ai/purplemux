// Browser-safe flow helpers (ADR-0026): the snapshot validator the CLI route runs, the history row
// the server derives at each publish, and the caps and staleness rule every reader shares.
// No node-only imports, so the UI may import it.
import type {
  IFlowHistoryRow,
  IFlowItem,
  IFlowLock,
  IFlowMeter,
  IFlowProducerFlag,
  IFlowQueue,
  IFlowRecord,
  IFlowSnapshot,
  TFlowHistoryMode,
} from '@/types/flow';

/** A producer runs from a timer; ten minutes without a publish means it stopped. */
export const FLOW_STALE_MS = 10 * 60_000;

export const MAX_FLOW_HISTORY = 2_000;
/** The serialized snapshot ceiling (413 above it). */
export const MAX_FLOW_BYTES = 1024 * 1024;
/** The serialized record ceiling: the oldest history rows go first to stay under it. */
export const MAX_FLOW_RECORD_BYTES = 4 * 1024 * 1024;
export const MAX_FLOW_QUEUES = 20;
export const MAX_FLOW_ITEMS = 500;
export const MAX_FLOW_LOCKS = 20;
export const MAX_FLOW_METERS = 50;
export const MAX_FLOW_FLAGS = 20;

export const FUTURE_TOLERANCE_MS = 5 * 60_000;
// `flow show` prints producer strings raw to other workspaces' terminals, so no string carries a
// control character or a bidi control. An identifier also refuses every other format character:
// two look-alike names must not both pass a uniqueness check. Prose (a label, a flag text) keeps
// them, since ZWJ emoji, ZWNJ scripts, flag tags and soft hyphens are legitimate text.
export const IDENTIFIER_REFUSED = /[\p{Cc}\p{Cf}]/u;
export const PROSE_REFUSED = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu;

type TStringKind = 'identifier' | 'prose';
const ITEM_STATES = ['queued', 'active', 'held'] as const;
const FLAG_SEVERITIES = ['info', 'warn', 'block'] as const;
const HISTORY_MODES: readonly TFlowHistoryMode[] = ['all', 'window', 'none'];

const SNAPSHOT_KEYS = ['schemaVersion', 'generatedAt', 'source', 'queues', 'locks', 'meters', 'flags'];
const QUEUE_KEYS = ['name', 'capacity', 'items'];
const ITEM_KEYS = ['id', 'label', 'since', 'state', 'pinned', 'holder'];
const LOCK_KEYS = ['name', 'heldBy', 'since'];
const METER_KEYS = ['name', 'value', 'unit', 'limit', 'windowMinutes'];
const FLAG_KEYS = ['text', 'severity'];
const RECORD_KEYS = ['workspaceId', 'receivedAt', 'snapshot', 'history'];
const ROW_KEYS = ['at', 'queues', 'oldest', 'locks', 'meters'];

class FlowShapeError extends Error {}

/** Producer text inside a refusal: a control, format or bidi character is echoed as `\u{…}`, never raw. */
const escaped = (text: string): string =>
  text.replace(UNPRINTABLE, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase()}}`);

/** The seen value for a refusal: never a raw control, format or bidi character, never a split code point. */
export const show = (value: unknown): string => {
  if (value === undefined) return 'nothing';
  const text = escaped(JSON.stringify(value) ?? String(value));
  const points = Array.from(text);
  return points.length > 60 ? `${points.slice(0, 59).join('')}…` : text;
};

const refuse = (field: string, value: unknown, expected: string): never => {
  throw new FlowShapeError(`${field}: saw ${show(value)}, expected ${expected}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An object holding only `keys`: a typo must be refused, never dropped with its data. `field` is
 * empty at the top level, where `root` names the value instead.
 */
const shape = (
  value: unknown, field: string, keys: readonly string[], root = { label: '', what: 'an object' },
): Record<string, unknown> => {
  if (!isRecord(value)) return refuse(field || root.label, value, field ? 'an object' : root.what);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new FlowShapeError(`${field ? `${field}.` : ''}${escaped(key)}: saw an unknown key, expected only ${keys.join(', ')}`);
    }
  }
  return value;
};

const at = (field: string, key: string): string => (field ? `${field}.${key}` : key);

const list = (value: unknown, field: string, max: number): unknown[] => {
  if (!Array.isArray(value)) return refuse(field, value, 'an array');
  if (value.length > max) throw new FlowShapeError(`${field}: saw ${value.length} entries, expected at most ${max}`);
  return value;
};

const printable = (value: string, field: string, kind: TStringKind): string => {
  if (kind === 'identifier') {
    return IDENTIFIER_REFUSED.test(value) ? refuse(field, value, 'no control or format character') : value;
  }
  return PROSE_REFUSED.test(value) ? refuse(field, value, 'no control character and no bidi control') : value;
};

const name = (value: unknown, field: string, max: number, kind: TStringKind = 'identifier'): string =>
  typeof value === 'string' && value.trim() && value.length <= max
    ? printable(value, field, kind) : refuse(field, value, `a non-blank string of at most ${max} characters`);

const text = (value: unknown, field: string, max: number): string =>
  typeof value === 'string' && value.length <= max
    ? printable(value, field, 'identifier') : refuse(field, value, `a string of at most ${max} characters`);

const optionalText = (value: unknown, field: string, max: number, kind: TStringKind): string | null => {
  if (value === null) return null;
  return typeof value === 'string' && value.length <= max
    ? printable(value, field, kind) : refuse(field, value, `null or a string of at most ${max} characters`);
};

/** A blank holder would read as a held lock; a free lock says null. */
const optionalName = (value: unknown, field: string, max: number): string | null => {
  if (value === null) return null;
  return typeof value === 'string' && value.trim() && value.length <= max
    ? printable(value, field, 'identifier') : refuse(field, value, `null for a free lock, or a non-blank string of at most ${max} characters`);
};

const integerIn = (value: unknown, min: number, max: number): boolean =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

const optionalInteger = (value: unknown, field: string, min: number, max: number): number | null =>
  value === null || integerIn(value, min, max) ? value as number | null : refuse(field, value, `null or an integer from ${min} to ${max}`);

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const time = (value: unknown, field: string, receivedAt: number): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= receivedAt + FUTURE_TOLERANCE_MS
    ? value as number
    : refuse(field, value, `a time in Unix ms at most 5 min after the server clock ${receivedAt}`);

const optionalTime = (value: unknown, field: string, receivedAt: number): number | null =>
  value === null ? null : time(value, field, receivedAt);

const oneOf = <T extends string>(value: unknown, field: string, options: readonly T[]): T =>
  options.includes(value as T) ? value as T : refuse(field, value, `one of ${options.join(', ')}`);

const unique = <T>(entries: T[], key: (entry: T) => string, field: (index: number) => string, expected: string): void => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(key(entry))) refuse(field(index), key(entry), expected);
    seen.add(key(entry));
  });
};

const parseItem = (raw: unknown, field: string, receivedAt: number): IFlowItem => {
  const body = shape(raw, field, ITEM_KEYS);
  return {
    id: name(body.id, `${field}.id`, 128),
    label: optionalText(body.label, `${field}.label`, 120, 'prose'),
    since: time(body.since, `${field}.since`, receivedAt),
    state: oneOf(body.state, `${field}.state`, ITEM_STATES),
    pinned: typeof body.pinned === 'boolean' ? body.pinned : refuse(`${field}.pinned`, body.pinned, 'true or false'),
    holder: optionalText(body.holder, `${field}.holder`, 128, 'identifier'),
  };
};

const parseQueue = (raw: unknown, field: string, receivedAt: number): IFlowQueue => {
  const body = shape(raw, field, QUEUE_KEYS);
  const queue: IFlowQueue = {
    name: name(body.name, `${field}.name`, 64),
    capacity: optionalInteger(body.capacity, `${field}.capacity`, 1, 10_000),
    items: list(body.items, `${field}.items`, MAX_FLOW_ITEMS)
      .map((entry, index) => parseItem(entry, `${field}.items[${index}]`, receivedAt)),
  };
  unique(queue.items, (entry) => entry.id, (index) => `${field}.items[${index}].id`, 'an id no other item of the queue holds');
  return queue;
};

const parseLock = (raw: unknown, field: string, receivedAt: number): IFlowLock => {
  const body = shape(raw, field, LOCK_KEYS);
  const lock: IFlowLock = {
    name: name(body.name, `${field}.name`, 64),
    heldBy: optionalName(body.heldBy, `${field}.heldBy`, 128),
    since: optionalTime(body.since, `${field}.since`, receivedAt),
  };
  if (lock.heldBy === null && lock.since !== null) refuse(`${field}.since`, lock.since, 'null for a free lock (heldBy null)');
  return lock;
};

const parseMeter = (raw: unknown, field: string): IFlowMeter => {
  const body = shape(raw, field, METER_KEYS);
  return {
    name: name(body.name, `${field}.name`, 64),
    value: finite(body.value) ? body.value : refuse(`${field}.value`, body.value, 'a finite number'),
    unit: text(body.unit, `${field}.unit`, 16),
    limit: body.limit === null || finite(body.limit) ? body.limit as number | null : refuse(`${field}.limit`, body.limit, 'null or a finite number'),
    windowMinutes: optionalInteger(body.windowMinutes, `${field}.windowMinutes`, 1, 10_080),
  };
};

const parseFlag = (raw: unknown, field: string): IFlowProducerFlag => {
  const body = shape(raw, field, FLAG_KEYS);
  return { text: name(body.text, `${field}.text`, 200, 'prose'), severity: oneOf(body.severity, `${field}.severity`, FLAG_SEVERITIES) };
};

const parseSnapshot = (raw: unknown, receivedAt: number, field: string): IFlowSnapshot => {
  const body = shape(raw, field, SNAPSHOT_KEYS, { label: 'body', what: 'a flow snapshot object' });
  if (body.schemaVersion !== 1) refuse(at(field, 'schemaVersion'), body.schemaVersion, '1');
  const snapshot: IFlowSnapshot = {
    schemaVersion: 1,
    generatedAt: time(body.generatedAt, at(field, 'generatedAt'), receivedAt),
    source: name(body.source, at(field, 'source'), 64),
    queues: list(body.queues, at(field, 'queues'), MAX_FLOW_QUEUES)
      .map((entry, index) => parseQueue(entry, `${at(field, 'queues')}[${index}]`, receivedAt)),
    locks: list(body.locks, at(field, 'locks'), MAX_FLOW_LOCKS)
      .map((entry, index) => parseLock(entry, `${at(field, 'locks')}[${index}]`, receivedAt)),
    meters: list(body.meters, at(field, 'meters'), MAX_FLOW_METERS)
      .map((entry, index) => parseMeter(entry, `${at(field, 'meters')}[${index}]`)),
    flags: list(body.flags, at(field, 'flags'), MAX_FLOW_FLAGS)
      .map((entry, index) => parseFlag(entry, `${at(field, 'flags')}[${index}]`)),
  };
  const named = (kind: string, entries: Array<{ name: string }>) => unique(entries, (entry) => entry.name,
    (index) => `${at(field, `${kind}s`)}[${index}].name`, `a name no other ${kind} holds`);
  named('queue', snapshot.queues);
  named('lock', snapshot.locks);
  named('meter', snapshot.meters);
  return snapshot;
};

const guard = <T>(parse: () => T): { ok: true; value: T } | { ok: false; error: string } => {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    if (error instanceof FlowShapeError) return { ok: false, error: error.message };
    throw error;
  }
};

export type TFlowParseResult = { ok: true; snapshot: IFlowSnapshot } | { ok: false; error: string };

/**
 * Validate a published snapshot strictly. Each refusal names the field, what it saw and what it
 * expected; an unknown key is refused so a typo never drops data. `receivedAt` bounds every time.
 */
export const parseFlowSnapshot = (raw: unknown, receivedAt: number): TFlowParseResult => {
  const result = guard(() => parseSnapshot(raw, receivedAt, ''));
  return result.ok ? { ok: true, snapshot: result.value } : result;
};

/** The one history row a publish appends, derived by the server from the snapshot. */
export const flowHistoryRow = (snapshot: IFlowSnapshot, receivedAt: number): IFlowHistoryRow => ({
  at: receivedAt,
  queues: Object.fromEntries(snapshot.queues.map((queue) => [queue.name, queue.items.length])),
  oldest: Object.fromEntries(snapshot.queues.map((queue) => [queue.name,
    queue.items.length ? Math.min(...queue.items.map((entry) => entry.since)) : null])),
  locks: Object.fromEntries(snapshot.locks.map((lock) => [lock.name, lock.heldBy !== null])),
  meters: Object.fromEntries(snapshot.meters.map((meter) => [meter.name, meter.value])),
});

const encoder = new TextEncoder();
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

export const flowRecordBytes = (record: IFlowRecord): number => byteLength(record);

/**
 * Append `row` and drop the oldest rows until the record holds at most MAX_FLOW_HISTORY rows and
 * MAX_FLOW_RECORD_BYTES serialized. The newest row always stays.
 */
export const appendFlowHistory = (record: IFlowRecord, row: IFlowHistoryRow): IFlowRecord => {
  const history = [...record.history, row].slice(-MAX_FLOW_HISTORY);
  const rowBytes = history.map(byteLength);
  // The serialized record is its empty-history form plus each row and one comma between rows.
  let total = byteLength({ ...record, history: [] }) + rowBytes.reduce((sum, bytes) => sum + bytes, 0) + history.length - 1;
  let drop = 0;
  while (total > MAX_FLOW_RECORD_BYTES && drop < history.length - 1) {
    total -= rowBytes[drop] + 1;
    drop += 1;
  }
  return { ...record, history: history.slice(drop) };
};

const parseCounts = <T>(value: unknown, field: string, max: number, entry: (raw: unknown, field: string) => T): Record<string, T> => {
  if (!isRecord(value)) return refuse(field, value, 'an object');
  const entries = Object.entries(value);
  if (entries.length > max) throw new FlowShapeError(`${field}: saw ${entries.length} keys, expected at most ${max}`);
  return Object.fromEntries(entries.map(([key, raw]) => [key, entry(raw, `${field}.${escaped(key)}`)]));
};

const storedTime = (value: unknown, field: string): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : refuse(field, value, 'a time in Unix ms');

const parseHistoryRow = (raw: unknown, field: string): IFlowHistoryRow => {
  const body = shape(raw, field, ROW_KEYS);
  return {
    at: storedTime(body.at, `${field}.at`),
    queues: parseCounts(body.queues, `${field}.queues`, MAX_FLOW_QUEUES, (value, key) =>
      integerIn(value, 0, MAX_FLOW_ITEMS) ? value as number : refuse(key, value, `an integer from 0 to ${MAX_FLOW_ITEMS}`)),
    oldest: parseCounts(body.oldest, `${field}.oldest`, MAX_FLOW_QUEUES, (value, key) =>
      value === null ? null : storedTime(value, key)),
    locks: parseCounts(body.locks, `${field}.locks`, MAX_FLOW_LOCKS, (value, key) =>
      typeof value === 'boolean' ? value : refuse(key, value, 'true or false')),
    meters: parseCounts(body.meters, `${field}.meters`, MAX_FLOW_METERS, (value, key) =>
      finite(value) ? value : refuse(key, value, 'a finite number')),
  };
};

export type TFlowRecordParseResult = { ok: true; record: IFlowRecord } | { ok: false; error: string };

/**
 * Re-validate a stored record. Its times were bounded when it was received, so the reader's clock
 * does not bound them again.
 */
export const parseFlowRecord = (raw: unknown, workspaceId: string): TFlowRecordParseResult => {
  const result = guard((): IFlowRecord => {
    const body = shape(raw, '', RECORD_KEYS, { label: 'record', what: 'a flow record object' });
    if (body.workspaceId !== workspaceId) refuse('workspaceId', body.workspaceId, JSON.stringify(workspaceId));
    return {
      workspaceId,
      receivedAt: storedTime(body.receivedAt, 'receivedAt'),
      snapshot: parseSnapshot(body.snapshot, Number.MAX_SAFE_INTEGER - FUTURE_TOLERANCE_MS, 'snapshot'),
      history: list(body.history, 'history', MAX_FLOW_HISTORY).map((entry, index) => parseHistoryRow(entry, `history[${index}]`)),
    };
  });
  return result.ok ? { ok: true, record: result.value } : result;
};

/** A `history` query value, `fallback` when absent, null when it names no mode. */
export const parseFlowHistoryMode = (value: unknown, fallback: TFlowHistoryMode): TFlowHistoryMode | null => {
  if (value === undefined) return fallback;
  return HISTORY_MODES.includes(value as TFlowHistoryMode) ? value as TFlowHistoryMode : null;
};

/** The record with the rows a reader asked for: all, the window's (at or after its start), or none. */
export const selectFlowHistory = (record: IFlowRecord, mode: TFlowHistoryMode, now: number, windowMinutes: number): IFlowRecord => {
  if (mode === 'all') return record;
  if (mode === 'none') return { ...record, history: [] };
  const start = now - windowMinutes * 60_000;
  return { ...record, history: record.history.filter((row) => row.at >= start) };
};

export const isFlowStale = (receivedAt: number, now: number): boolean => now - receivedAt > FLOW_STALE_MS;
