import type { NextApiRequest, NextApiResponse } from 'next';
import { isCodedError } from '@/lib/coded-error';
import { LedgerRefusal } from '@/lib/ledger';
import { LedgerStoreError, type TLedgerStoreErrorCode } from '@/lib/ledger-store';
import { createLogger } from '@/lib/logger';

const log = createLogger('ledger');

const STORE_STATUS: Readonly<Record<TLedgerStoreErrorCode, number>> = {
  'ledger-event-conflict': 409,
  'ledger-experiment-cap': 409,
  'ledger-experiment-closed': 409,
  'ledger-experiment-extended': 409,
  'ledger-experiment-not-found': 404,
};

/**
 * Answer a refusal or a store failure with its code. A refusal names the field, the value seen and
 * what was expected; a vocabulary refusal also carries the allowed list.
 */
export const answerLedgerError = (res: NextApiResponse, error: unknown): void => {
  if (error instanceof LedgerRefusal) {
    res.status(400).json({
      error: error.message, code: error.code, field: error.field, ...(error.allowed ? { allowed: error.allowed } : {}),
    });
    return;
  }
  if (isCodedError<LedgerStoreError>(error, 'LedgerStoreError', STORE_STATUS)) {
    res.status(STORE_STATUS[error.code]).json({ error: error.message, code: error.code, ...(error.field ? { field: error.field } : {}) });
    return;
  }
  log.error({ err: error }, 'ledger store failed');
  res.status(500).json({ error: `ledger store failed: ${(error as Error)?.message ?? String(error)}`, code: 'ledger-store-failed' });
};

export const queryValue = (req: NextApiRequest, name: string): string | undefined => {
  const value = req.query[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** A time given as Unix ms or as an ISO-8601 date or timestamp. */
export const parseTime = (value: string, field: string): number => {
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new LedgerRefusal('ledger-query-invalid', field, value, 'a time in Unix ms or an ISO-8601 date');
  }
  return ms;
};

export const methodNotAllowed = (res: NextApiResponse, allow: string): void => {
  res.setHeader('Allow', allow);
  res.status(405).json({ error: 'Method not allowed', code: 'invalid-request' });
};
