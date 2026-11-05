import type { NextApiRequest } from 'next';
import { LedgerRefusal } from '@/lib/ledger';
import { parseTime, queryValue } from '@/lib/ledger-http';

const UNIT_MS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const RELATIVE = /^(\d{1,6})([smhd])$/;

/** A time as Unix ms, an ISO-8601 date, or an age before `now` (`90s`, `15m`, `1h`, `7d`). */
export const parseEventTime = (value: string, field: string, now: number): number => {
  const relative = RELATIVE.exec(value);
  return relative ? now - Number(relative[1]) * UNIT_MS[relative[2]] : parseTime(value, field);
};

export const timeQuery = (req: NextApiRequest, field: string, now: number, fallback: number): number => {
  const value = queryValue(req, field);
  return value === undefined ? fallback : parseEventTime(value, field, now);
};

export const limitQuery = (req: NextApiRequest, fallback: number, max: number): number => {
  const text = queryValue(req, 'limit');
  const limit = text === undefined ? fallback : Number(text);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new LedgerRefusal('ledger-query-invalid', 'limit', text, `an integer from 1 to ${max}`);
  }
  return limit;
};
