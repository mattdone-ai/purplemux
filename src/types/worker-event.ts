// Typed worker-to-worker events (ADR-0043): a fixed schema per type, checked by
// the server before the notes service delivers it.

export type TWorkerEventType = 'review-ready' | 'landed' | 'blocked-on';

/** Every type names the exact range it speaks about, and the attempt it belongs to. */
export interface IWorkerEventRange {
  /** Absolute path of the git checkout or worktree; confined to the evidence roots. */
  repo: string;
  branch: string;
  head: string;
  base: string;
  attempt: number;
}

/** The hand-off FOR review: the review's receipt is absent on a first hand-off, and checked when given. */
export interface IReviewReadyPayload extends IWorkerEventRange {
  key: string;
  gateLog: string;
  reviewDir: string;
  receipt?: string;
}

export interface ILandedPayload extends IWorkerEventRange {
  key: string;
  gateLog: string;
  /** The branch the range landed in (default `main`): a head in it stays valid once `branch` is gone. */
  target?: string;
}

export interface IBlockedOnPayload extends IWorkerEventRange {
  /** ≤ 500 characters, control characters removed. Shown by `note show`, never typed. */
  reason: string;
  clearInput: string;
}

export interface IWorkerEventPayloads {
  'review-ready': IReviewReadyPayload;
  landed: ILandedPayload;
  'blocked-on': IBlockedOnPayload;
}

export type TWorkerEvent = {
  [K in TWorkerEventType]: { type: K; payload: IWorkerEventPayloads[K] };
}[TWorkerEventType];

/**
 * What a worker tab may announce, and to whom (ADR-0043 §1). Only the workspace's verified,
 * designated coordinator writes it. It dies with the tab: tab ids are never reused.
 */
export interface IEventScope {
  workspaceId: string;
  tabId: string;
  /** The epic the worker serves: held as `epic:<slug>` by a live tab of the same workspace. */
  epic: string;
  story: string | null;
  /** The epics the current story depends on. */
  dependsOn: string[];
  /** Bumped by the coordinator on a re-dispatch; an event from another attempt is stale. */
  attempt: number;
  declaredBy: { workspaceId: string; tabId: string };
  declaredAt: number;
}

export interface IEventScopesState {
  scopes: IEventScope[];
}

/** The record a delivered event note carries (`INote.event`). */
export interface INoteEventRecord {
  type: TWorkerEventType;
  /** `delivery`: the event itself; `status`: the short notice to the source coordinator. */
  role: 'delivery' | 'status';
  payload: IWorkerEventPayloads[TWorkerEventType];
  scope: { epic: string; story: string | null; dependsOn: string[]; attempt: number };
  /** The validators that passed, by id. */
  checks: string[];
  /** sha256 over the fields that make two sends the same event. */
  dedupeKey: string;
  /** On a status note: the delivery note it reports. */
  deliveryNoteId?: string;
}

export interface ICheckFailure {
  check: string;
  measured: string;
  expected: string;
  /** The check could not run here (server configuration, or another host): `event-check-unavailable`, not `event-refused`. */
  unavailable?: true;
}

export type TWorkerEventErrorCode =
  | 'event-invalid'
  | 'event-refused'
  | 'event-out-of-scope'
  | 'event-stale'
  | 'event-no-recipient'
  | 'event-check-unavailable'
  | 'event-scope-invalid'
  | 'forbidden';
