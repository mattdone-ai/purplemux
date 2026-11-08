import type { NextApiResponse } from 'next';
import { isCodedError } from '@/lib/coded-error';
import { sendNoteError } from '@/lib/notes-http';
import type { WorkerEventError } from '@/lib/worker-event-schema';
import type { TWorkerEventErrorCode } from '@/types/worker-event';

const STATUS: Record<TWorkerEventErrorCode, number> = {
  'event-invalid': 400,
  'event-scope-invalid': 400,
  'event-refused': 422,
  'event-out-of-scope': 403,
  'event-stale': 409,
  'event-no-recipient': 503,
  'event-check-unavailable': 409,
  forbidden: 403,
};

/** A typed-event refusal carries `code` and its details (the failed checks); a note refusal keeps its own table. */
export const sendWorkerEventError = (res: NextApiResponse, err: unknown): void => {
  if (isCodedError<WorkerEventError>(err, 'WorkerEventError', STATUS)) {
    res.status(STATUS[err.code]).json({ ...err.details, error: err.message, code: err.code });
    return;
  }
  sendNoteError(res, err);
};
