// The durable tab event log (ADR-0035): every nudge, notice and digest a tab is sent, in `ledger.sqlite`.

/** How an event reaches its tab (ADR-HFL-05 decision 1). */
export type TWakeClass = 'urgent' | 'digest' | 'log';

export interface ITabEventInput {
  workspaceId: string;
  /** The recipient. */
  tabId: string;
  at: number;
  class: TWakeClass;
  kind: string;
  text: string;
  /** The tab the event is about (a watchdog nudge's worker); null for a notice. */
  sourceTabId?: string | null;
  sourceTabName?: string | null;
  /** The flag rule or alarm reason a `flag` or `alarm` event carries (story 15): its effect is counted per rule. */
  rule?: string | null;
  deliveredAt?: number | null;
}

export interface ITabEvent {
  seq: number;
  workspaceId: string;
  tabId: string;
  at: number;
  class: TWakeClass;
  kind: string;
  text: string;
  sourceTabId: string | null;
  sourceTabName: string | null;
  rule: string | null;
  deliveredAt: number | null;
  digestId: string | null;
}

/** Wakes of one seat (tab) in a window, or in one UTC day of it (ADR-0035 §6). */
export interface ITabWakeRow {
  tabId: string;
  /** `YYYY-MM-DD` when read by day; null for the whole window. */
  day: string | null;
  /** Deliveries: each urgent event delivered, plus each digest once however many events it carried. */
  wakes: number;
  digests: number;
  urgent: number;
  /** Events recorded and never delivered by design (`log`). */
  logged: number;
}

export interface IPendingDigest {
  workspaceId: string;
  tabId: string;
  count: number;
  oldestAt: number;
}

export interface ITabEventsResponse {
  workspaceId: string;
  tabId: string | null;
  since: number;
  now: number;
  /** More events match than `limit`: the newest are returned. */
  truncated: boolean;
  events: ITabEvent[];
}

export interface ITabWakesResponse {
  workspaceId: string;
  since: number;
  until: number;
  by: 'window' | 'day';
  /** False when the workspace has no tab event at all: zero wakes then means no record, not a quiet seat. */
  hasEvents: boolean;
  rows: ITabWakeRow[];
}

/** One delivered event as the effect count reads it (story 15). */
export interface ITabDelivery {
  seq: number;
  tabId: string;
  kind: string;
  rule: string | null;
  deliveredAt: number;
  digestId: string | null;
}

/** Rows the router recorded for one kind and rule in a window (story 15: a component's firings). */
export interface ITabEventCount {
  kind: string;
  rule: string | null;
  count: number;
}
