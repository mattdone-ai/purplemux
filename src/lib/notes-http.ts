import type { NextApiResponse } from 'next';
import { createLogger } from '@/lib/logger';
import { isCodedError } from '@/lib/coded-error';
import type { NoteError } from '@/lib/notes-store';
import type { TNoteErrorCode } from '@/types/note';

const log = createLogger('notes-http');

// Typed by the code union, so tsc refuses a code without a status (story 35 review r2).
const STATUS: Record<TNoteErrorCode, number> = {
  'note-not-found': 404,
  'note-too-large': 413,
  'note-target-missing': 400,
  'note-invalid': 400,
  forbidden: 403,
  'note-cap': 409,
  'tab-not-found': 404,
  'session-not-running': 409,
  'note-point-not-ready': 409,
  'note-point-too-soon': 409,
};

/**
 * Every note refusal carries `code`, which the CLI maps to its exit (ADR-0016). `overrides` lets a
 * route answer the status its own contract names for a code.
 */
export const sendNoteError = (res: NextApiResponse, err: unknown, overrides: Partial<Record<TNoteErrorCode, number>> = {}): void => {
  if (isCodedError<NoteError>(err, 'NoteError', STATUS)) {
    res.status(overrides[err.code] ?? STATUS[err.code]).json({ error: err.message, code: err.code });
    return;
  }
  log.error(`notes route failed: ${err instanceof Error ? err.message : err}`);
  // Fail closed: an unreadable store answers nothing about who sent what.
  res.status(500).json({ error: 'note operation failed', code: 'note-internal' });
};
