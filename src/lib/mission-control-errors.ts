import type { IMissionAttentionItem, IMissionEventDefect, IMissionQuestionChanges, IMissionRun } from '@/types/mission-control';

export type TMissionErrorCode =
  | 'invalid-request'
  | 'question-invalid'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'storage-unavailable';

const MISSION_CONTROL_ERROR_BRAND = Symbol.for('purplemux.mission-control-error');
const ERROR_STATUS: Record<TMissionErrorCode, number> = {
  'invalid-request': 400,
  'question-invalid': 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'storage-unavailable': 503,
};

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null;

const isMissionCurrent = (value: unknown): value is IMissionAttentionItem | IMissionRun => {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.workspaceId !== 'string'
    || !Number.isSafeInteger(value.revision)
    || typeof value.state !== 'string') return false;

  if ('runId' in value) {
    return typeof value.runId === 'string'
      && typeof value.title === 'string'
      && ['candidate', 'open', 'answered', 'resolved', 'cancelled'].includes(value.state);
  }
  return typeof value.objective === 'string'
    && ['running', 'waiting', 'completed', 'cancelled'].includes(value.state);
};

/** What a refusal carries beyond its message: the defects of a question, or what changed under an answer. */
export interface IMissionErrorDetail {
  defects?: IMissionEventDefect[];
  changes?: IMissionQuestionChanges;
}

export class MissionControlError extends Error {
  readonly status: number;
  readonly code: TMissionErrorCode;
  readonly current?: IMissionAttentionItem | IMissionRun;
  readonly detail?: IMissionErrorDetail;

  constructor(
    status: number,
    code: TMissionErrorCode,
    message: string,
    current?: IMissionAttentionItem | IMissionRun,
    detail?: IMissionErrorDetail,
  ) {
    super(message);
    Object.defineProperty(this, MISSION_CONTROL_ERROR_BRAND, { value: true });
    this.name = 'MissionControlError';
    this.status = status;
    this.code = code;
    this.current = current;
    this.detail = detail;
  }
}

/** Recognize domain errors across the custom-server and Next bundle module graphs. */
export const isMissionControlError = (error: unknown): error is MissionControlError => {
  if (!isRecord(error)) return false;
  try {
    const code = error.code;
    return error[MISSION_CONTROL_ERROR_BRAND] === true
      && typeof code === 'string'
      && Object.hasOwn(ERROR_STATUS, code)
      && error.status === ERROR_STATUS[code as TMissionErrorCode]
      && typeof error.message === 'string'
      && (error.current === undefined || isMissionCurrent(error.current));
  } catch {
    return false;
  }
};

export const invalidMissionRequest = (message: string): never => {
  throw new MissionControlError(400, 'invalid-request', message);
};

export const missionConflict = (
  message: string,
  current?: IMissionAttentionItem | IMissionRun,
  detail?: IMissionErrorDetail,
): never => {
  throw new MissionControlError(409, 'conflict', message, current, detail);
};

export const missionNotFound = (message: string): never => {
  throw new MissionControlError(404, 'not-found', message);
};
