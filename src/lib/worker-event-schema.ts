import path from 'path';
import { brandCodedError } from '@/lib/coded-error';
import type { TWorkerEvent, TWorkerEventErrorCode, TWorkerEventType } from '@/types/worker-event';

// The fixed schema of each typed worker event (ADR-0043 §2). Pure: no file or git reads.

export class WorkerEventError extends Error {
  constructor(readonly code: TWorkerEventErrorCode, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    brandCodedError(this, 'WorkerEventError');
  }
}

export const WORKER_EVENT_TYPES: readonly TWorkerEventType[] = ['review-ready', 'landed', 'blocked-on'];
export const EVENT_PAYLOAD_MAX_BYTES = 8 * 1024;
export const EVENT_TEXT_MAX = 500;
const PATH_MAX = 4096;
const ATTEMPT_MAX = 1_000_000;

/** A full object id: SHA-1 (40 hex) or SHA-256 (64 hex). An abbreviation or a rev expression is refused. */
export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

type TFieldKind = 'oid' | 'branch' | 'path' | 'attempt' | 'text';

const RANGE_FIELDS: Record<string, TFieldKind> = { repo: 'path', branch: 'branch', head: 'oid', base: 'oid', attempt: 'attempt' };

const SCHEMAS: Record<TWorkerEventType, Record<string, TFieldKind>> = {
  'review-ready': { ...RANGE_FIELDS, key: 'oid', gateLog: 'path', reviewDir: 'path', receipt: 'path' },
  landed: { ...RANGE_FIELDS, key: 'oid', gateLog: 'path', target: 'branch' },
  'blocked-on': { ...RANGE_FIELDS, reason: 'text', clearInput: 'text' },
};

/**
 * Fields a sender may leave out. `review-ready` is the hand-off FOR review, so the review's own
 * receipt does not exist yet on a first hand-off; given, it is checked (ADR-0043 §3, ruling R1-2).
 */
const OPTIONAL: Record<TWorkerEventType, ReadonlySet<string>> = {
  'review-ready': new Set(['receipt']),
  landed: new Set(['target']),
  'blocked-on': new Set(),
};

export const isWorkerEventType = (value: unknown): value is TWorkerEventType =>
  typeof value === 'string' && (WORKER_EVENT_TYPES as readonly string[]).includes(value);

const isBranch = (value: string): boolean =>
  BRANCH.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/')
  && !value.endsWith('.lock') && !value.endsWith('.');

/** Control and format characters removed and whitespace collapsed, as a note subject is. */
const cleanText = (value: string): string => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The cleaned value, or the defect in words. */
const checkField = (kind: TFieldKind, value: unknown): { value: unknown } | { defect: string } => {
  switch (kind) {
    case 'oid':
      return typeof value === 'string' && OBJECT_ID.test(value) ? { value } : { defect: 'a full object id (40 or 64 lower-case hex)' };
    case 'branch':
      return typeof value === 'string' && isBranch(value) ? { value } : { defect: 'a branch name (no "..", no leading "-", not ending in "/" or ".lock")' };
    case 'path':
      if (typeof value !== 'string' || !value || value.length > PATH_MAX || value.includes('\0') || !path.isAbsolute(value)) {
        return { defect: `an absolute path of at most ${PATH_MAX} characters` };
      }
      return { value: path.normalize(value) };
    case 'attempt':
      return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= ATTEMPT_MAX
        ? { value }
        : { defect: `a whole number from 1 to ${ATTEMPT_MAX}` };
    case 'text': {
      const clean = typeof value === 'string' ? cleanText(value) : '';
      if (!clean) return { defect: 'non-empty text' };
      return [...clean].length > EVENT_TEXT_MAX ? { defect: `at most ${EVENT_TEXT_MAX} characters` } : { value: clean };
    }
  }
};

/**
 * The payload checked against its type's schema. Every defect is named in one refusal: a missing
 * field, a field of the wrong form, and a field the schema does not have.
 */
export const parseWorkerEvent = (type: unknown, payload: unknown): TWorkerEvent => {
  if (!isWorkerEventType(type)) {
    throw new WorkerEventError('event-invalid', `type must be one of ${WORKER_EVENT_TYPES.join(', ')}, got ${JSON.stringify(type)}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new WorkerEventError('event-invalid', 'payload must be a JSON object');
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > EVENT_PAYLOAD_MAX_BYTES) {
    throw new WorkerEventError('event-invalid', `payload is ${bytes} bytes; the limit is ${EVENT_PAYLOAD_MAX_BYTES}`);
  }
  const schema = SCHEMAS[type];
  const input = payload as Record<string, unknown>;
  const defects: string[] = [];
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(schema)) {
    if (!Object.hasOwn(input, name)) {
      if (!OPTIONAL[type].has(name)) defects.push(`${name}: missing`);
      continue;
    }
    const result = checkField(kind, input[name]);
    if ('defect' in result) defects.push(`${name}: expected ${result.defect}`);
    else out[name] = result.value;
  }
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(schema, name)) defects.push(`${name}: not a ${type} field`);
  }
  if (defects.length) {
    throw new WorkerEventError('event-invalid', `${type} payload refused: ${defects.join('; ')}`, { defects });
  }
  return { type, payload: out } as unknown as TWorkerEvent;
};

/** The fields of a type's schema, for the CLI help and the API guide. */
export const schemaFields = (type: TWorkerEventType): string[] => Object.keys(SCHEMAS[type]);

/** The fields a type requires. */
export const requiredFields = (type: TWorkerEventType): string[] => schemaFields(type).filter((name) => !OPTIONAL[type].has(name));
