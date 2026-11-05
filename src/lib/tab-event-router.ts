import { nanoid } from 'nanoid';
import { createLogger } from '@/lib/logger';
import { NUDGE_PREFIX } from '@/lib/orchestration';
import type { TabEventsTable } from '@/lib/tab-events-store';
import type { IPendingDigest, ITabEvent, TWakeClass } from '@/types/tab-events';

const log = createLogger('tab-events');

/** ADR-HFL-05 decision 2: a tab gets at most one digest per 15 min, sooner only when 20 events wait. */
export const DIGEST_INTERVAL_MS = 15 * 60_000;
export const DIGEST_MAX_WAITING = 20;
export const DIGEST_MAX_BYTES = 2048;
/** ADR-HFL-05 decision 1: the same tab, kind and text inside 15 min is logged, not delivered. */
export const DUPLICATE_WINDOW_MS = 15 * 60_000;
export const DIGEST_TICK_MS = 5_000;
/** No digest within this long of any delivery to the tab: the paste may have started a turn not yet seen. */
export const DIGEST_SETTLE_MS = 5_000;
/** A tab whose oldest held event is older than this is reported to the human once (review r2, F6). */
export const DIGEST_STALE_MS = 60 * 60_000;
/** One digest line; the rest of an event is read with `events show`. */
const DIGEST_LINE_CHARS = 160;
/**
 * The text the log keeps of an event typed elsewhere (a brief sent with `tab send` can run to tens of KB).
 * An event the router holds is never cut: it is the only copy until its digest (review r2, F8).
 */
export const TAB_EVENT_TEXT_MAX = 16_384;

const keptText = (text: string): string =>
  text.length > TAB_EVENT_TEXT_MAX ? `${text.slice(0, TAB_EVENT_TEXT_MAX)}… [${text.length - TAB_EVENT_TEXT_MAX} more characters not kept]` : text;

export interface ITabEventRoute {
  workspaceId: string;
  /** The recipient. */
  tabId: string;
  kind: string;
  /** The whole message, as it is typed when delivered on its own. */
  text: string;
  class: TWakeClass;
  sourceTabId?: string | null;
  sourceTabName?: string | null;
  /** A `flag` or `alarm` event's rule or reason, kept so its effect is counted per rule (story 15). */
  rule?: string | null;
  /**
   * An urgent event that must not land mid-turn (ROTATE): re-checked inside the tab's dispatch lock before the
   * paste, together with the settle window, so it never follows another delivery into the turn it started.
   */
  whenReady?: () => boolean;
}

export interface ITabEventRouteResult {
  class: TWakeClass;
  delivered: boolean;
  /** Null when the log could not be written (the event was then delivered, never held). */
  seq: number | null;
  duplicate: boolean;
}

export interface ITabEventRouterDeps {
  /** The ledger's tab event table; throws when the ledger cannot be opened. */
  table: () => TabEventsTable;
  now: () => number;
  /**
   * Type the message into the tab. `whenReady` is re-checked inside the tab's dispatch lock, just before
   * the paste, so a tab that started a turn since the check is never typed into.
   */
  deliver: (workspaceId: string, tabId: string, message: string, whenReady?: () => boolean) => Promise<boolean>;
  /** The tab sits at its prompt: idle, or waiting on its own background work, and not halted. */
  atPrompt: (tabId: string) => boolean;
  newDigestId?: () => string;
  /** The events a digest carried, now delivered: the client clears its "held for digest" label. */
  onDigestDelivered?: (events: ITabEvent[]) => void;
  /** A tab's oldest held event passed DIGEST_STALE_MS: once per backlog. */
  onStale?: (stale: IPendingDigest) => void;
  /** The tab still exists. A held backlog of a tab that does not is retired, never reported (review F12). */
  isKnownTab?: (tabId: string) => boolean;
  /** The tab takes no digest now: a seat mid-rotation (ADR-0036). Its events stay held for a later digest. */
  holdDigest?: (tabId: string) => boolean;
  /**
   * The tab takes no urgent event now either: a rotated seat before its first message (ADR-0036). The event is
   * recorded undelivered and typed by `releaseHeldUrgent`.
   */
  holdUrgent?: (tabId: string) => boolean;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A nudge's own pointer to the worker's pane; the digest's pointer replaces it. */
const READ_WITH = / — read with: purplemux tab result -w \S+ \S+$/;

const digestLine = (event: ITabEvent): string => {
  const flat = event.text.replace(/\s+/g, ' ').trim();
  const body = (flat.startsWith(NUDGE_PREFIX) ? flat.slice(NUDGE_PREFIX.length).trim() : flat).replace(READ_WITH, '');
  const clipped = body.length > DIGEST_LINE_CHARS ? `${body.slice(0, DIGEST_LINE_CHARS - 1)}…` : body;
  return `- ${hhmm(event.at)}Z ${event.kind}: ${clipped}`;
};

/** Write an event another path already typed (an inbox notice, a tab send) as delivered at `at`. */
export const appendDelivered = (table: TabEventsTable, event: ITabEventRoute, at: number): number =>
  table.append({ ...event, text: keptText(event.text), at, deliveredAt: at });

/**
 * One message for every waiting event (ADR-HFL-05 decision 2): `DIGEST <n> since <time>`, a line per
 * event while they fit, then the pointer to the full list. At most DIGEST_MAX_BYTES in all.
 */
export const renderDigest = (events: readonly ITabEvent[], workspaceId: string, tabId: string): string => {
  const since = iso(events[0].at);
  const header = `DIGEST ${events.length} since ${since}`;
  const pointer = (shown: number) => (shown === events.length
    ? `Full text: purplemux events show -w ${workspaceId} ${tabId} --since ${since}`
    : `${events.length - shown} more: purplemux events show -w ${workspaceId} ${tabId} --since ${since}`);
  const lines: string[] = [];
  for (const event of events) {
    const next = [header, ...lines, digestLine(event), pointer(lines.length + 1)].join('\n');
    if (bytes(next) > DIGEST_MAX_BYTES) break;
    lines.push(digestLine(event));
  }
  return [header, ...lines, pointer(lines.length)].join('\n');
};

/**
 * Routes every event bound for a tab by its class (ADR-0035): an urgent one is typed at once, a digest
 * one waits for the tab's next digest, a log one is recorded only. Every event is written to
 * `tab_events` first, so what a tab was sent survives a restart.
 *
 * A ledger that cannot be written never holds an event: it is typed at once, as before this story.
 */
export class TabEventRouter {
  private readonly flushing = new Set<string>();
  /** Rows typed whose delivery could not be written: never typed again (review r2, F1). */
  private readonly unrecorded = new Set<number>();
  /** The oldest held event each stale tab was reported for, so a tab is reported once per backlog. */
  private readonly staleReported = new Map<string, number>();
  /** When a paste to each tab last started or ended: the ledger records a delivery only after its paste. */
  private readonly lastPaste = new Map<string, number>();
  /**
   * Urgent rows whose paste still runs. The history leaves them out until the paste settles: a row read
   * mid-paste would report a nudge being typed as undelivered (09-fix, release acceptance self-failure-*).
   */
  private readonly inFlight = new Set<number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ITabEventRouterDeps) {}

  private tableOrNull(): TabEventsTable | null {
    try {
      return this.deps.table();
    } catch (err) {
      log.warn(`tab event log unavailable; delivering at once: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** No log: every non-log event is typed at once, as before this story. Delivery never depends on a ledger write. */
  private async deliverUnlogged(event: ITabEventRoute): Promise<ITabEventRouteResult> {
    const delivered = event.class === 'log' ? false : await this.paste(event.workspaceId, event.tabId, event.text, event.whenReady);
    return { class: event.class, delivered, seq: null, duplicate: false };
  }

  /**
   * Every paste the router makes, stamped at its start and its end for the settle window. A paste its own
   * `whenReady` refused typed nothing and stamps nothing: a ROTATE retried every 3 s would otherwise hold its own
   * window open for good (ADR-0036).
   */
  private async paste(workspaceId: string, tabId: string, message: string, whenReady?: () => boolean): Promise<boolean> {
    const key = `${workspaceId}/${tabId}`;
    if (!whenReady) this.lastPaste.set(key, this.deps.now());
    let delivered = false;
    try {
      delivered = await this.deps.deliver(workspaceId, tabId, message, whenReady);
      return delivered;
    } finally {
      if (delivered || !whenReady) this.lastPaste.set(key, this.deps.now());
    }
  }

  /**
   * No delivery reached the tab within DIGEST_SETTLE_MS: a paste may have started a turn its state does not
   * show yet (review r2, F10). Read again inside the dispatch lock, after any paste queued ahead of the digest.
   */
  private settled(table: TabEventsTable, workspaceId: string, tabId: string): boolean {
    const now = this.deps.now();
    const last = Math.max(
      this.lastPaste.get(`${workspaceId}/${tabId}`) ?? -Infinity,
      table.lastDigestAt(workspaceId, tabId) ?? -Infinity,
      table.lastDeliveredSince(workspaceId, tabId, now - DIGEST_SETTLE_MS) ?? -Infinity,
    );
    return now - last >= DIGEST_SETTLE_MS;
  }

  private markDelivered(table: TabEventsTable, seqs: readonly number[], digestId: string | null): void {
    try {
      table.markDelivered(seqs, this.deps.now(), digestId);
    } catch (err) {
      for (const seq of seqs) this.unrecorded.add(seq);
      log.warn(`delivery of ${seqs.length} tab event(s) typed but not recorded: ${err instanceof Error ? err.message : err}`);
    }
  }

  async route(event: ITabEventRoute): Promise<ITabEventRouteResult> {
    const now = this.deps.now();
    const table = this.tableOrNull();
    if (!table) return this.deliverUnlogged(event);
    let seq: number;
    let cls: TWakeClass;
    let duplicate: boolean;
    try {
      // Urgent kinds keep only the episode filter: an identical end line after a fix round is a new decision
      // (consult ruling 2). A copy is a duplicate only while the earlier one still waits (review r2, F3).
      duplicate = event.class !== 'urgent'
        && table.hasSame(event.workspaceId, event.tabId, event.kind, event.text, now - DUPLICATE_WINDOW_MS);
      cls = duplicate ? 'log' : event.class;
      seq = table.append({ ...event, class: cls, at: now });
    } catch (err) {
      log.warn(`tab event for ${event.tabId} not written; delivering at once: ${err instanceof Error ? err.message : err}`);
      return this.deliverUnlogged(event);
    }
    if (cls === 'urgent' && this.deps.holdUrgent?.(event.tabId)) {
      log.info({ workspaceId: event.workspaceId, tabId: event.tabId, kind: event.kind, seq }, 'urgent event held: the seat reads its handoff first');
      return { class: cls, delivered: false, seq, duplicate };
    }
    if (cls === 'urgent') {
      const { whenReady } = event;
      const ready = whenReady ? () => whenReady() && this.settled(table, event.workspaceId, event.tabId) : undefined;
      this.inFlight.add(seq);
      try {
        const delivered = await this.paste(event.workspaceId, event.tabId, event.text, ready);
        if (delivered) this.markDelivered(table, [seq], null);
        return { class: cls, delivered, seq, duplicate };
      } finally {
        this.inFlight.delete(seq);
      }
    }
    // A tab at its prompt with a digest due gets it now; `delivered` says this event went out in it.
    const delivered = cls === 'digest' && await this.flush(event.workspaceId, event.tabId);
    return { class: cls, delivered, seq, duplicate };
  }

  /**
   * Type the urgent events the tab's hold kept since `since`, oldest first (ADR-0036): every undelivered urgent row
   * but a ROTATE (a refused ROTATE is retried by its own owner). Each is in flight while typed, as any urgent paste,
   * so it enters the nudge history with its outcome. Returns how many were typed.
   */
  async releaseHeldUrgent(workspaceId: string, tabId: string, since: number): Promise<number> {
    const table = this.tableOrNull();
    if (!table) return 0;
    const held = table.list(workspaceId, { tabId, since, limit: 500 })
      .filter((row) => row.class === 'urgent' && row.deliveredAt === null && row.kind !== 'rotate' && !this.unrecorded.has(row.seq));
    let typed = 0;
    for (const row of held) {
      this.inFlight.add(row.seq);
      try {
        if (!(await this.paste(workspaceId, tabId, row.text))) break;
        this.markDelivered(table, [row.seq], null);
        typed += 1;
      } finally {
        this.inFlight.delete(row.seq);
      }
    }
    if (held.length) log.info({ workspaceId, tabId, held: held.length, typed }, 'held urgent events released');
    return typed;
  }

  /**
   * The workspace's newest watchdog nudges, newest last (a row with a source tab is a nudge), without an urgent
   * one still being typed: it enters with its outcome, as before ADR-0035. Throws when the log is unreadable.
   */
  history(workspaceId: string, limit: number): ITabEvent[] {
    return this.deps.table().list(workspaceId, { since: 0, limit, sourced: true }).filter((row) => !this.inFlight.has(row.seq));
  }

  /** Send the tab its digest when one is due and the tab is at its prompt; true when one went out. */
  async flush(workspaceId: string, tabId: string): Promise<boolean> {
    const key = `${workspaceId}/${tabId}`;
    if (this.flushing.has(key)) return false;
    this.flushing.add(key);
    try {
      const table = this.tableOrNull();
      if (!table) return false;
      const pending = table.pending(workspaceId, tabId).filter((event) => !this.unrecorded.has(event.seq));
      if (!pending.length) return false;
      const now = this.deps.now();
      const last = table.lastDigestAt(workspaceId, tabId);
      const due = pending.length >= DIGEST_MAX_WAITING || last === null || now - last >= DIGEST_INTERVAL_MS;
      if (!due || this.deps.holdDigest?.(tabId) || !this.deps.atPrompt(tabId) || !this.settled(table, workspaceId, tabId)) return false;
      const message = renderDigest(pending, workspaceId, tabId);
      const delivered = await this.paste(workspaceId, tabId, message,
        () => !this.deps.holdDigest?.(tabId) && this.deps.atPrompt(tabId) && this.settled(table, workspaceId, tabId));
      if (!delivered) return false;
      const digestId = this.deps.newDigestId?.() ?? `dg-${nanoid(10)}`;
      this.markDelivered(table, pending.map((event) => event.seq), digestId);
      log.info({ workspaceId, tabId, digestId, events: pending.length, bytes: bytes(message) }, 'digest delivered');
      const deliveredAt = this.deps.now();
      this.deps.onDigestDelivered?.(pending.map((event) => ({ ...event, deliveredAt, digestId })));
      return true;
    } catch (err) {
      log.warn(`digest for ${key} failed: ${err instanceof Error ? err.message : err}`);
      return false;
    } finally {
      this.flushing.delete(key);
    }
  }

  async tick(): Promise<void> {
    const table = this.tableOrNull();
    if (!table) return;
    const now = this.deps.now();
    for (const { workspaceId, tabId, count, oldestAt } of table.pendingTabs()) {
      const key = `${workspaceId}/${tabId}`;
      if (now - oldestAt >= DIGEST_STALE_MS && this.deps.isKnownTab && !this.deps.isKnownTab(tabId)) {
        // Closed while no one listened (a server restart): its backlog will never be typed.
        this.retire(workspaceId, tabId);
        continue;
      }
      if (now - oldestAt >= DIGEST_STALE_MS && this.staleReported.get(key) !== oldestAt) {
        this.staleReported.set(key, oldestAt);
        this.deps.onStale?.({ workspaceId, tabId, count, oldestAt });
      }
      if (this.deps.atPrompt(tabId)) await this.flush(workspaceId, tabId);
    }
  }

  /** The tab closed: its held events become `log` rows, never typed and never reported. */
  retire(workspaceId: string, tabId: string): void {
    const table = this.tableOrNull();
    if (!table) return;
    try {
      const retired = table.retirePending(workspaceId, tabId);
      if (retired) log.info({ workspaceId, tabId, retired }, 'held tab events retired: the tab closed');
    } catch (err) {
      log.warn(`held tab events of ${tabId} not retired: ${err instanceof Error ? err.message : err}`);
    }
    this.staleReported.delete(`${workspaceId}/${tabId}`);
    this.lastPaste.delete(`${workspaceId}/${tabId}`);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => log.warn(`digest tick failed: ${err instanceof Error ? err.message : err}`));
    }, DIGEST_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
