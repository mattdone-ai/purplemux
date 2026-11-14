import type { ICaller } from '@/lib/caller';
import { createHash } from 'crypto';
import type { CoordinatorWindow } from '@/lib/coordinator-window';
import { isRecoverableHold, type IEnqueueRequest } from '@/lib/inbox-store';
import { isNoteBounceReason, renderNotePointerLine, type TNoteEvent } from '@/lib/inbox-templates';
import { NotePointBounds, type INotePointPort, type TPointerTyped } from '@/lib/note-pointer';
import { createLogger } from '@/lib/logger';
import {
  NOTE_EXPIRE_MS,
  NOTE_EXPIRE_NOTICE_GRACE_MS,
  NOTE_OPEN_PER_SENDER,
  NOTE_REMIND_MS,
  NOTE_SENDER_NOTICE_MS,
  NoteError,
  OWNER_ITEMS_ARMED_PER_SENDER,
  bounceNotified,
  OPEN_STATES,
  acked,
  canAck,
  canShow,
  checkBody,
  checkTarget,
  cleanComment,
  cleanSubject,
  createNote,
  expired,
  isEpicSlug,
  isNoteId,
  mutateNotes,
  newNoteId,
  policyBlocked,
  prune,
  reachedComposer,
  pointerSpent,
  pointerStamped,
  readNotesState,
  recipientWorkspace,
  routeKey,
  reminded,
  replaceNote,
  requeued,
  routed,
  senderNotified,
  undeliverable,
  undeliveredNoticeMs,
  viewOf,
} from '@/lib/notes-store';
import type { IGrant } from '@/types/grant';
import type { IInboxItem } from '@/types/inbox';
import type { INote, INoteAdmission, INotePointerStamp, INoteReceipt, INotesState, INoteView, TNoteRoutingStatus } from '@/types/note';
import { WorkerEventError } from '@/lib/worker-event-schema';
import type { INoteEventRecord } from '@/types/worker-event';

// Notes route directly inside one workspace and coordinator-to-coordinator
// across workspaces (ADR-0013). Only the inbox's fixed line is typed; the body is pulled.

const log = createLogger('notes');

export interface INotesDeps {
  now: () => number;
  newId: () => string;
  mutate: typeof mutateNotes;
  read: () => Promise<INotesState>;
  /** The tab holding `epic:<slug>` while that tab is live; null when nobody live holds it. */
  epicHolder: (slug: string) => Promise<{ workspaceId: string; tabId: string } | null>;
  /** True when `caller` itself holds `epic:<slug>`. */
  holdsEpic: (caller: ICaller, slug: string) => Promise<boolean>;
  /** The workspace's orchestrator tab while orchestration is on (liveness is checked by the caller); else null. */
  orchestratorOf: (workspaceId: string) => Promise<string | null>;
  /** Holds the target workspace's orchestration mapping stable through a terminal note mutation. */
  withMappingRead: <T>(workspaceId: string, work: () => Promise<T>) => Promise<T>;
  workspaceExists: (workspaceId: string) => Promise<boolean>;
  /** Every live tab, and the workspaces whose layout could not be read (their tabs are unknown, not closed). */
  liveTabs: () => Promise<ILiveTabs>;
  enqueue: (req: IEnqueueRequest<'note'>) => Promise<{ item: IInboxItem }>;
  /** Drop a notice still waiting in the inbox (queued or held); a delivered one is left alone. */
  withdraw: (itemId: string, reason: string) => Promise<boolean>;
  inboxItems: () => Promise<IInboxItem[]>;
  /** Recheck a persisted portfolio action against its current blocker before routing or delivery. */
  portfolioActionDeliverable?: (actionId: string, noteId: string, workspaceId: string) => Promise<boolean>;
  /** The active owner grant held by this exact tab (ADR-0029), or null. */
  ownerGrantOf?: (tab: { workspaceId: string; tabId: string }) => IGrant | null;
  /** One coordination audit line (`owner-note`, `note-pointer`). */
  audit?: (entry: Record<string, unknown>) => Promise<unknown>;
  /** F6 change 3: the coordinator window a typed pointer claims, as an inbox paste does; absent or null, none. */
  window?: () => CoordinatorWindow | null;
  /**
   * G7: one line to the portfolio Scrum Master seat's digest for a note whose line has not reached its recipient's
   * composer after 15 min. Best effort: a failure never holds back the sender's notice. `senderTold` is true only when
   * a notice to the sender's live tab went out.
   */
  alertUndelivered?: (note: INote, now: number, senderTold: boolean) => Promise<void>;
  /**
   * One line to a bounced note's sender tab, for its digest, after the sender's notice went out. Best effort: a
   * failure never holds back the bounce or the notice.
   */
  alertBounced?: (note: INote, now: number) => Promise<void>;
  /**
   * PMUX-NOTE-DELIVERY: the port the owner-item pointer types through (the inbox dispatcher's target reads). Absent:
   * owner items keep only their inbox notice.
   */
  pointPort?: () => Promise<INotePointPort>;
  /** An owner-item pointer line that may sit in its recipient's composer: alert its sender and the seat. Best effort. */
  alertPointerSpent?: (note: INote, outcome: 'stranded' | 'unverified', at: number) => Promise<void>;
  /** The ack, recorded for the sender as a `log` row in the ledger (never typed). Best effort. */
  recordAck?: (note: INote) => Promise<void>;
}

/**
 * The answer to a typed pointer (G7). `notSubmitted` is set when the line may sit in the composer: still in the box
 * after Enter (`typed-not-submitted`), or not confirmed by the screen (`not-verified`, no receipt).
 */
export interface INotePointResult {
  status: 'sent';
  submitted: boolean;
  noteId: string;
  target: { workspaceId: string; tabId: string };
  cliState: string | null;
  line: string;
  notSubmitted?: 'typed-not-submitted' | 'not-verified';
}

/** Whether the server will point at an owner item: `armed`, or `inactive:<why>` (the send's answer). */
export type TOwnerPointerState = 'armed' | `inactive:${string}`;

/** One owner-item pointer attempt (PMUX-NOTE-DELIVERY). */
type TOwnerAttempt =
  | { result: 'disarmed'; reason: string }
  | { result: 'spacing' }
  | { result: 'refused'; reason: string }
  | { result: Exclude<TPointerTyped, 'not-clean'>; detail?: string; note: INote; at: number }
  | { result: 'not-clean'; reason: string };

export interface ILiveTabs {
  tabs: ReadonlyArray<{ workspaceId: string; tabId: string }>;
  uncertainWorkspaceIds: ReadonlySet<string>;
}

type TTabState = 'live' | 'closed' | 'unknown';

/** What became of a notice to the sender: it went out, there is nobody to tell (no tab, or its tab closed), or not known. */
type TSenderNotice = 'sent' | 'none' | 'unknown';

const isBounce = (note: INote): boolean =>
  note.state === 'undeliverable' && note.routingStatus === 'undeliverable' && isNoteBounceReason(note.routingReason);

/** The note bounced and its sender is not yet told. A note stored before bounce alerts (no field) owes nothing. */
const owesBounceNotice = (note: INote): boolean => isBounce(note) && note.bounceNotifiedAt === null;

/** The send's answer for an owner item: whether the server will point at it on its current route. */
const ownerPointerState = (note: INote): TOwnerPointerState => {
  if (note.state !== 'delivered' || !note.deliveredTo) return `inactive:${note.routingReason ?? note.state}`;
  if (note.deliveredTo.workspaceId === note.from.workspaceId) return 'inactive:same-workspace';
  return 'armed';
};

/**
 * The reads one pass shares: the notes' own inbox and live-tab reads happen once each, and each epic
 * holder and orchestrator is resolved once. An epic holder's lease view reads the live tabs on its
 * own, so it may lag the pass's snapshot by a moment; the next pass settles any difference.
 */
interface IReads {
  epicHolder: (slug: string) => Promise<{ workspaceId: string; tabId: string } | null>;
  /** The workspace's orchestrator tab while it is live; else null. */
  orchestratorOf: (workspaceId: string) => Promise<string | null>;
  tabState: (workspaceId: string, tabId: string) => Promise<TTabState>;
  inboxItem: (id: string) => Promise<IInboxItem | null>;
}

type TRecipientDecision =
  | { status: 'routed'; recipient: { workspaceId: string; tabId: string } }
  | { status: 'undeliverable'; reason: string }
  | { status: 'policyblocked'; reason: string };

export interface ISendInput {
  toEpic?: unknown;
  toWorkspace?: unknown;
  subject?: unknown;
  body?: unknown;
  fromEpic?: unknown;
  externalKey?: string;
  /** `true` flags an owner item; only the verified current orchestrator of the sender's workspace may set it. */
  ownerItem?: unknown;
}

export interface IEventNoteInput {
  toEpic: string;
  subject: string;
  body: string;
  record: INoteEventRecord;
  /** The short status note to the source coordinator (ADR-0043 §4); absent for a step result. */
  status?: { subject: string; body: string; record: INoteEventRecord };
  /** Runs first inside the notes lock; a throw refuses the event before anything is routed (ADR-0043 §4). */
  recheck?: () => Promise<void>;
}

export interface IListFilter {
  open?: boolean;
  toMe?: boolean;
  fromMe?: boolean;
  epic?: string | null;
}

/**
 * `--to-me` is the tab the note was routed to, not the workspace: every epic of the portfolio
 * shares one workspace, and every tab reads its notes at turn start (review round 1). A note not
 * yet routed is no tab's; the lease-acquire tick routes it to the new holder. A token with no tab
 * reads its workspace.
 */
const isToMe = (n: INote, caller: ICaller): boolean => {
  if (!caller.tabId) return recipientWorkspace(n) === caller.workspaceId;
  return n.deliveredTo !== null && n.deliveredTo.workspaceId === caller.workspaceId && n.deliveredTo.tabId === caller.tabId;
};

export class NotesService {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly deps: INotesDeps) {}

  /**
   * Note mutations and a successful paste preflight share one lifecycle lock. A preflight keeps the
   * lock until the inbox has durably recorded the paste outcome, so ACK/expiry cannot overtake it.
   */
  private async acquireOperation(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.operationTail;
    this.operationTail = next;
    await previous;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      release();
    };
  }

  private async withOperation<T>(work: () => Promise<T>): Promise<T> {
    const release = await this.acquireOperation();
    try {
      return await work();
    } finally {
      release();
    }
  }

  // ─── routing ────────────────────────────────────────────────────────────

  private async recipientOf(note: INote, r: IReads,
    options: { requireActionDelivery?: boolean } = {}): Promise<TRecipientDecision> {
    if (!note.admission && note.deliveredAt === null) {
      return { status: 'policyblocked', reason: 'legacy-admission-missing' };
    }
    let targetWorkspaceId: string;
    let localRecipient: { workspaceId: string; tabId: string } | null = null;
    if (note.to.epic) {
      const holder = await r.epicHolder(note.to.epic);
      if (!holder) {
        return { status: 'undeliverable', reason: 'target-epic-unowned' };
      }
      targetWorkspaceId = holder.workspaceId;
      localRecipient = holder;
    } else if (note.to.workspaceId) {
      targetWorkspaceId = note.to.workspaceId;
    } else {
      return { status: 'policyblocked', reason: 'target-missing' };
    }
    if (options.requireActionDelivery !== false && note.externalKey?.startsWith('portfolio:action:')) {
      const actionId = note.externalKey.slice('portfolio:action:'.length);
      if (!this.deps.portfolioActionDeliverable
        || !(await this.deps.portfolioActionDeliverable(actionId, note.id, targetWorkspaceId))) {
        return { status: 'policyblocked', reason: 'portfolio-action-superseded' };
      }
    }

    if (note.from.workspaceId === targetWorkspaceId) {
      if (localRecipient) return { status: 'routed', recipient: localRecipient };
      const tabId = await r.orchestratorOf(targetWorkspaceId);
      return tabId
        ? { status: 'routed', recipient: { workspaceId: targetWorkspaceId, tabId } }
        : { status: 'undeliverable', reason: 'target-coordinator-unavailable' };
    }
    if (note.admission?.mode === 'human') {
      if (!note.from.humanActor || note.from.humanActor !== note.admission.humanActor
        || note.from.workspaceId !== null || note.from.tabId !== null
        || note.to.epic !== null || note.admission.targetWorkspaceId !== targetWorkspaceId) {
        return { status: 'policyblocked', reason: 'human-admission-target-mismatch' };
      }
      const tabId = await r.orchestratorOf(targetWorkspaceId);
      return tabId
        ? { status: 'routed', recipient: { workspaceId: targetWorkspaceId, tabId } }
        : { status: 'undeliverable', reason: 'target-coordinator-unavailable' };
    }
    if (note.admission?.mode !== 'coordinator' && note.admission?.mode !== 'owner' && note.admission?.mode !== 'event') {
      return {
        status: 'policyblocked',
        reason: note.admission ? 'cross-workspace-admission-required' : 'legacy-cross-workspace-admission-missing',
      };
    }
    const tabId = await r.orchestratorOf(targetWorkspaceId);
    return tabId
      ? { status: 'routed', recipient: { workspaceId: targetWorkspaceId, tabId } }
      : { status: 'undeliverable', reason: 'target-coordinator-unavailable' };
  }

  private notice(note: INote, to: { workspaceId: string; tabId: string }, event: TNoteEvent): IEnqueueRequest<'note'> {
    const reason = event === 'bounced' && isNoteBounceReason(note.routingReason) ? { reason: note.routingReason } : {};
    return {
      kind: 'note',
      targetWorkspaceId: to.workspaceId,
      targetTabId: to.tabId,
      dedupeKey: `note:${note.id}:${event}:${to.tabId}`,
      fields: { noteId: note.id, fromWorkspaceId: note.from.workspaceId, fromTabId: note.from.tabId,
        fromHuman: note.admission?.mode === 'human', fromOwner: note.admission?.mode === 'owner', sentAt: note.createdAt, event,
        ...reason, ...(event === 'undelivered' ? { afterMinutes: Math.round(undeliveredNoticeMs(note) / 60_000) } : {}) },
    };
  }

  private async admissionFor(caller: ICaller, to: { epic: string | null; workspaceId: string | null }, now: number, r: IReads): Promise<INoteAdmission> {
    const targetWorkspaceId = to.workspaceId ?? (to.epic ? (await r.epicHolder(to.epic))?.workspaceId ?? null : null);
    const sourceCoordinator = caller.workspaceId ? await r.orchestratorOf(caller.workspaceId) : null;
    if (caller.verified && caller.workspaceId && caller.tabId && sourceCoordinator === caller.tabId) {
      return {
        mode: 'coordinator',
        sender: { workspaceId: caller.workspaceId, tabId: caller.tabId },
        authorizedAt: now,
      };
    }
    if (caller.workspaceId && targetWorkspaceId === caller.workspaceId) {
      return { mode: 'local', sender: { workspaceId: caller.workspaceId, tabId: caller.tabId }, authorizedAt: now };
    }
    // ADR-0029: the owner's verified tab sends anywhere, and routes like a coordinator.
    const ownerGrant = caller.verified && caller.workspaceId && caller.tabId
      ? this.deps.ownerGrantOf?.({ workspaceId: caller.workspaceId, tabId: caller.tabId }) ?? null
      : null;
    if (ownerGrant && caller.workspaceId && caller.tabId) {
      return {
        mode: 'owner',
        sender: { workspaceId: caller.workspaceId, tabId: caller.tabId },
        grantId: ownerGrant.id,
        authorizedAt: now,
      };
    }
    throw new NoteError(
      'forbidden',
      targetWorkspaceId
        ? 'cross-workspace notes require the verified, currently designated source coordinator or the owner-granted tab'
        : 'an unresolved epic may be retained only by the verified, currently designated source coordinator or the owner-granted tab',
    );
  }

  private routingStatus(note: INote): TNoteRoutingStatus {
    if (note.routingStatus) return note.routingStatus;
    if (note.state === 'delivered' || note.state === 'acked') return 'routed';
    if (note.state === 'undeliverable') return 'undeliverable';
    return 'pending';
  }

  private receipt(note: INote, items: ReadonlyMap<string, IInboxItem>): INoteReceipt {
    const item = note.inboxItemId ? items.get(note.inboxItemId) ?? null : null;
    const routingStatus = this.routingStatus(note);
    return {
      routingStatus,
      routingReason: note.routingReason ?? null,
      authorizedSender: note.admission?.sender ?? null,
      authorizedRecipient: routingStatus === 'routed' ? note.deliveredTo : null,
      notice: item ? {
        id: item.id,
        state: item.state,
        lastRefusal: item.lastRefusal,
        heldReason: item.heldReason,
        deliveredAt: item.deliveredAt,
      } : null,
      composerDeliveredAt: note.deliveredAt ?? item?.deliveredAt ?? null,
    };
  }

  private async views(notes: readonly INote[]): Promise<INoteView[]> {
    const items = new Map((await this.deps.inboxItems()).map((item) => [item.id, item]));
    return notes.map((note) => ({
      ...viewOf(note, note.inboxItemId ? items.get(note.inboxItemId) ?? null : null),
      receipt: this.receipt(note, items),
    }));
  }

  /** The inbox calls this under its dispatch lock immediately before a note line is pasted. */
  async preflight(item: IInboxItem): Promise<
    | { ok: true; settle: () => void }
    | { ok: false; reason: string }
  > {
    const release = await this.acquireOperation();
    const reject = (reason: string) => {
      release();
      return { ok: false as const, reason };
    };
    try {
      const match = /^note:(n-[A-Za-z0-9_-]{4,32}):(delivered|reminder|unacked|undelivered|expired|bounced|acked):/.exec(item.dedupeKey);
      if (!match) return reject('note-notice-key-invalid');
      const [, id, event] = match;
      // F6: an ack types nothing. An `acked` notice queued before this release is rejected here (withdrawn, never
      // refused), so it neither reaches the sender nor blocks the head of the sender's queue.
      if (event === 'acked') return reject('note-ack-notice-retired');
      const note = (await this.deps.read()).notes.find((candidate) => candidate.id === id);
      if (!note) return reject('note-not-found');
      if (event === 'unacked' || event === 'undelivered' || event === 'expired' || event === 'bounced') {
        // An `undelivered` notice is stale once the line reached the recipient's composer; a `bounced` one once the
        // note has a recipient again.
        const valid = event === 'expired'
          ? note.state === 'expired' || (OPEN_STATES.has(note.state) && this.deps.now() - note.createdAt >= NOTE_EXPIRE_MS)
          : event === 'bounced'
            ? isBounce(note)
            : note.state === 'delivered' && (event === 'unacked' || note.deliveredAt === null);
        if (!valid) return reject(`note-terminal:${note.state}`);
        if (item.targetWorkspaceId !== note.from.workspaceId || item.targetTabId !== note.from.tabId) {
          return reject('note-sender-changed');
        }
        return { ok: true, settle: release };
      }
      if (note.state !== 'delivered') return reject(`note-terminal:${note.state}`);
      const expectedItemId = event === 'reminder' ? note.reminderItemId : note.inboxItemId;
      if (expectedItemId !== item.id) return reject('note-notice-superseded');
      const decision = await this.recipientOf(note, this.reads());
      if (decision.status !== 'routed') {
        if (decision.status === 'policyblocked' && note.deliveredAt === null) {
          await this.deps.mutate((state) => {
            const current = state.notes.find((candidate) => candidate.id === note.id);
            if (!current || current.state !== 'delivered') return { state, value: undefined };
            return { state: replaceNote(state, policyBlocked(current, this.deps.now(), decision.reason)), value: undefined };
          });
        }
        return reject(`note-${decision.status}:${decision.reason}`);
      }
      const { recipient } = decision;
      if (item.targetWorkspaceId !== recipient.workspaceId || item.targetTabId !== recipient.tabId) {
        return reject('note-recipient-changed');
      }
      if (!note.deliveredTo || note.deliveredTo.workspaceId !== recipient.workspaceId || note.deliveredTo.tabId !== recipient.tabId) {
        return reject('note-route-superseded');
      }
      return { ok: true, settle: release };
    } catch (err) {
      release();
      throw err;
    }
  }

  /** Route a queued or undeliverable note: enqueue its line for the live recipient, or mark it undeliverable. */
  private async route(note: INote, now: number, r: IReads): Promise<INote> {
    const decision = await this.recipientOf(note, r);
    if (decision.status === 'policyblocked') return policyBlocked(note, now, decision.reason);
    if (decision.status === 'undeliverable') return undeliverable(note, now, decision.reason);
    const { item } = await this.deps.enqueue(this.notice(note, decision.recipient, 'delivered'));
    return routed(note, decision.recipient, item.id, now);
  }

  /**
   * One notice to the sender's tab when it is live. Settled unless `unknown`: sent, or the sender has no tab or its
   * tab is confirmed closed. An unknown tab state settles nothing.
   */
  private async noticeSender(note: INote, event: 'unacked' | 'undelivered' | 'expired' | 'bounced', r: IReads): Promise<TSenderNotice> {
    const { workspaceId, tabId } = note.from;
    if (!workspaceId || !tabId) return 'none';
    const state = await r.tabState(workspaceId, tabId);
    if (state === 'unknown') return 'unknown';
    if (state === 'closed') return 'none';
    await this.deps.enqueue(this.notice(note, { workspaceId, tabId }, event));
    return 'sent';
  }

  /**
   * The sender of a note that bounced hears it once per bounce: one notice typed to its live tab and one line in that
   * tab's digest. The note comes back marked once that is settled (sent, or no tab to tell). An unknown sender tab or a
   * failed notice leaves it unmarked, and the next pass tries again.
   */
  private async tellBounced(note: INote, now: number, r: IReads): Promise<INote> {
    let told: TSenderNotice;
    try {
      told = await this.noticeSender(note, 'bounced', r);
    } catch (err) {
      log.warn(`note ${note.id} bounced notice not sent: ${err instanceof Error ? err.message : err}`);
      return note;
    }
    if (told === 'unknown') return note;
    // Not awaited, for the lock order `alertUndelivered` keeps below.
    if (told === 'sent' && this.deps.alertBounced) {
      void Promise.resolve().then(() => this.deps.alertBounced!(note, now)).catch((err) => {
        log.warn(`note ${note.id} bounced alert not sent: ${err instanceof Error ? err.message : err}`);
      });
    }
    return bounceNotified(note, now);
  }

  /**
   * The routed tab can no longer act on the note: it is confirmed closed (an epic lease dies with
   * its tab), or the recipient role moved to another live tab. Unknown liveness is not gone.
   */
  private async recipientGone(note: INote, decision: TRecipientDecision, r: IReads): Promise<boolean> {
    const to = note.deliveredTo;
    if (!to) return false;
    const state = await r.tabState(to.workspaceId, to.tabId);
    if (state === 'closed') return true;
    if (state === 'unknown') return false;
    if (decision.status !== 'routed') return true;
    return decision.recipient.workspaceId !== to.workspaceId || decision.recipient.tabId !== to.tabId;
  }

  /**
   * Advance one note by the clock and the inbox. Each side effect is recorded as soon as it is
   * done, so a later failure in the same pass never repeats an earlier notice (review round 1).
   */
  private async advance(note: INote, now: number, r: IReads): Promise<INote> {
    if (OPEN_STATES.has(note.state) && now - note.createdAt >= NOTE_EXPIRE_MS) {
      let expiring = note;
      const item = note.inboxItemId ? await r.inboxItem(note.inboxItemId) : null;
      if (item?.state === 'delivered' && expiring.deliveredAt === null) {
        expiring = reachedComposer(expiring, item.deliveredAt ?? now);
      }
      // The one expiry notice waits while the sender's liveness is unknown, for at most a day.
      const settled = (await this.noticeSender(expiring, 'expired', r)) !== 'unknown';
      if (!settled && now - expiring.createdAt < NOTE_EXPIRE_MS + NOTE_EXPIRE_NOTICE_GRACE_MS) return expiring;
      if (expiring.inboxItemId) await this.deps.withdraw(expiring.inboxItemId, 'note-terminal:expired');
      if (expiring.reminderItemId) await this.deps.withdraw(expiring.reminderItemId, 'note-terminal:expired');
      return expired(expiring, now);
    }
    if (note.state === 'queued' || (note.state === 'undeliverable' && note.routingStatus !== 'policyblocked')) {
      return this.route(note, now, r);
    }
    if (note.state !== 'delivered') return note;

    const item = note.inboxItemId ? await r.inboxItem(note.inboxItemId) : null;
    // Re-route only when the line never reached the recipient: an explicit drop (its tab closed),
    // or an item gone before it was delivered. The inbox prunes a DELIVERED item after 7 days;
    // that is not a drop, and re-routing it would deliver the note again.
    if (note.deliveredAt === null && (item?.state === 'dropped' || !item)) return this.route(requeued(note, now), now, r);
    let next = note;
    if (item?.state === 'delivered' && next.deliveredAt === null) next = reachedComposer(next, item.deliveredAt ?? now);
    const decision = await this.recipientOf(next, r);
    if (decision.status === 'policyblocked') {
      // An actual composer receipt survives a later action expiry. Delivery preflight still rejects
      // pending stale notices, and no stale action is rerouted or reminded to a replacement tab.
      if (next.deliveredAt !== null && (!next.admission || decision.reason === 'portfolio-action-superseded')) {
        if (next.reminderItemId) await this.deps.withdraw(next.reminderItemId, 'note-policyblocked');
        return next;
      }
      if (item && (item.state === 'queued' || item.state === 'held')) await this.deps.withdraw(item.id, 'note-policyblocked');
      if (next.reminderItemId) await this.deps.withdraw(next.reminderItemId, 'note-policyblocked');
      return policyBlocked(next, now, decision.reason);
    }
    // A line that reached a tab which is now closed, or an epic that changed hands, goes to the
    // current owner: `--to-me` is the routed tab, so nobody else would see it (review round 2).
    if (await this.recipientGone(note, decision, r)) {
      // The old tab may still be open with the line waiting: take the line back first, so it is not
      // typed there after the note has moved (review round 3). A failed withdrawal defers the move.
      // The same holds for its reminder (final confirmation): the withdrawal leaves a delivered one alone.
      if (item && (item.state === 'queued' || item.state === 'held')) await this.deps.withdraw(item.id, 'note-rerouted');
      if (note.reminderItemId) await this.deps.withdraw(note.reminderItemId, 'note-rerouted');
      const waiting = requeued(note, now);
      return decision.status === 'undeliverable'
        ? undeliverable(waiting, now, decision.reason)
        : this.route(waiting, now, r);
    }
    // The recipient's reminder counts from the line reaching its composer: a busy recipient is not
    // reminded of a line it has not seen. recipientGone() above leaves only a live or unknown tab;
    // an unknown one is tried again next pass, never marked as reminded.
    if (next.deliveredTo && next.deliveredAt !== null && next.remindedAt === null && now - next.deliveredAt >= NOTE_REMIND_MS) {
      // Not live here means unknown: the reminder waits, and the sender's clock below still runs
      // (review round 3: an unreadable recipient must not hold back the sender's escalation).
      let sent: string | null = null;
      try {
        if ((await r.tabState(next.deliveredTo.workspaceId, next.deliveredTo.tabId)) === 'live') {
          sent = (await this.deps.enqueue(this.notice(next, next.deliveredTo, 'reminder'))).item.id;
        }
      } catch (err) {
        log.warn(`note ${note.id} reminder not sent: ${err instanceof Error ? err.message : err}`);
        return next;
      }
      if (sent) next = reminded(next, now, sent);
    }
    // The sender's notice counts from the first routing, once per note: it is the escalation for a
    // recipient that never reads the line, so it must not wait for the line to be read. G7: when the line has not
    // reached the recipient's composer it comes at 15 min (an owner item: 5 min), and the Scrum Master seat's digest
    // hears it too.
    const undelivered = next.deliveredAt === null;
    const noticeAfter = undelivered ? undeliveredNoticeMs(next) : NOTE_SENDER_NOTICE_MS;
    if (next.senderNotifiedAt === null && next.routedAt !== null && now - next.routedAt >= noticeAfter) {
      let told: TSenderNotice;
      try {
        told = await this.noticeSender(next, undelivered ? 'undelivered' : 'unacked', r);
        if (told === 'unknown') return next;
      } catch (err) {
        log.warn(`note ${note.id} sender notice not sent: ${err instanceof Error ? err.message : err}`);
        return next;
      }
      next = senderNotified(next, now);
      // Not awaited: the alert may type a digest, which takes a dispatch lock, and this pass holds the notes lock.
      // The inbox takes them in the other order (dispatch lock, then the notes lock in its preflight).
      if (undelivered && this.deps.alertUndelivered) {
        const notified = next;
        void Promise.resolve().then(() => this.deps.alertUndelivered!(notified, now, told === 'sent')).catch((err) => {
          log.warn(`note ${note.id} undelivered alert not sent: ${err instanceof Error ? err.message : err}`);
        });
      }
    }
    return next;
  }

  /** One pass's reads: the inbox and the live tabs are read once, each epic holder and orchestrator once. */
  private reads(): IReads {
    const d = this.deps;
    let live: Promise<ILiveTabs> | null = null;
    let inbox: Promise<Map<string, IInboxItem>> | null = null;
    const holders = new Map<string, Promise<{ workspaceId: string; tabId: string } | null>>();
    const orchestrators = new Map<string, Promise<string | null>>();
    const tabState = async (workspaceId: string, tabId: string): Promise<TTabState> => {
      live ??= d.liveTabs();
      const snapshot = await live;
      if (snapshot.tabs.some((t) => t.workspaceId === workspaceId && t.tabId === tabId)) return 'live';
      return snapshot.uncertainWorkspaceIds.has(workspaceId) ? 'unknown' : 'closed';
    };
    return {
      epicHolder: (slug) => {
        if (!holders.has(slug)) holders.set(slug, d.epicHolder(slug));
        return holders.get(slug)!;
      },
      orchestratorOf: (workspaceId) => {
        if (!orchestrators.has(workspaceId)) {
          orchestrators.set(workspaceId, (async () => {
            const tabId = await d.orchestratorOf(workspaceId);
            return tabId && (await tabState(workspaceId, tabId)) === 'live' ? tabId : null;
          })());
        }
        return orchestrators.get(workspaceId)!;
      },
      tabState,
      inboxItem: async (id) => {
        inbox ??= d.inboxItems().then((items) => new Map(items.map((i) => [i.id, i])));
        return (await inbox).get(id) ?? null;
      },
    };
  }

  private ticking: Promise<void> | null = null;
  private again: string | undefined | null = null;

  /**
   * Every note once: route, re-route, remind, expire, prune. `onlyEpic` limits routing to one epic.
   * One tick at a time: a tick asked for while one runs runs once more afterwards, never in parallel.
   */
  async tick(onlyEpic?: string): Promise<void> {
    if (this.ticking) {
      this.again = this.again === null ? onlyEpic : undefined;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        let scope: string | undefined | null = onlyEpic;
        while (scope !== null) {
          this.again = null;
          await this.tickOnce(scope);
          scope = this.again;
        }
        // The owner-item pointer types, so it runs after the pass released the notes lock (the inbox takes the
        // dispatch lock first, then the notes lock).
        await this.pointOwnerItems().catch((err) => log.warn(`owner-item pointer failed: ${err instanceof Error ? err.message : err}`));
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  private async tickOnce(onlyEpic?: string): Promise<void> {
    const now = this.deps.now();
    const r = this.reads();
    await this.withOperation(() => this.deps.mutate(async (state) => {
      let next = state;
      for (const note of state.notes) {
        if (onlyEpic !== undefined && note.to.epic !== onlyEpic) continue;
        let advanced: INote;
        try {
          advanced = await this.advance(note, now, r);
          if (owesBounceNotice(advanced)) advanced = await this.tellBounced(advanced, now, r);
        } catch (err) {
          log.warn(`note ${note.id} could not advance: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        if (advanced !== note) next = replaceNote(next, advanced);
      }
      next = prune(next, now);
      return { state: next, value: undefined };
    }));
  }

  /** One finite boot pass. Runtime periodic/coalesced ticks are armed only after this resolves. */
  async reconcileInitial(): Promise<void> {
    await this.tickOnce();
  }

  // ─── the CLI operations ─────────────────────────────────────────────────

  async send(caller: ICaller, input: ISendInput): Promise<INoteView & { ownerPointer?: TOwnerPointerState }> {
    return this.sendCore(caller, input);
  }

  private async sendCore(caller: ICaller | null, input: ISendInput, humanActor?: string): Promise<INoteView & { ownerPointer?: TOwnerPointerState }> {
    const to = checkTarget(input.toEpic, input.toWorkspace);
    const subject = cleanSubject(input.subject);
    const body = checkBody(input.body);
    if (input.ownerItem !== undefined && input.ownerItem !== true) {
      throw new NoteError('note-invalid', 'ownerItem is true or absent');
    }
    const ownerItem = input.ownerItem === true;
    const externalKey = input.externalKey;
    if (externalKey !== undefined && !/^portfolio:(action|checkpoint|resolved):[A-Za-z0-9_-]{1,128}$/.test(externalKey)) {
      throw new NoteError('note-invalid', 'invalid portfolio note key');
    }
    let epic: string | null = null;
    if (input.fromEpic !== undefined && input.fromEpic !== null && input.fromEpic !== '') {
      if (!caller || !isEpicSlug(input.fromEpic) || !(await this.deps.holdsEpic(caller, input.fromEpic))) {
        throw new NoteError('forbidden', `fromEpic is accepted only from the holder of epic:${String(input.fromEpic)}`);
      }
      epic = input.fromEpic;
    }
    if (to.workspaceId && !(await this.deps.workspaceExists(to.workspaceId))) {
      throw new NoteError('note-target-missing', `no workspace ${to.workspaceId}`);
    }
    const now = this.deps.now();
    const reads = this.reads();
    // PMUX-NOTE-DELIVERY: the owner-item class types into a busy orchestrator, so only the verified current
    // orchestrator of the sender's own workspace sets it: not a worker, the admin token, an owner-granted tab or a human.
    if (ownerItem && (humanActor || !caller || !(await this.isCoordinator(caller, reads)))) {
      await this.deps.audit?.({
        event: 'owner-item-refused', from: { workspaceId: caller?.workspaceId ?? null, tabId: caller?.tabId ?? null }, to,
      }).catch((err) => log.warn(`owner-item audit failed: ${err instanceof Error ? err.message : err}`));
      throw new NoteError('forbidden', 'only the verified, current orchestrator of its own workspace sends an owner item');
    }
    const admission: INoteAdmission = humanActor
      ? { mode: 'human', sender: { workspaceId: null, tabId: null }, humanActor,
        targetWorkspaceId: to.workspaceId!, authorizedAt: now }
      : await this.admissionFor(caller!, to, now, reads);
    const note = createNote(
      {
        from: {
          workspaceId: !caller || caller.admin ? null : caller.workspaceId,
          tabId: !caller || caller.admin ? null : caller.tabId,
          verified: caller?.verified ?? false,
          identity: !caller || caller.admin ? 'none' : caller.identity,
          epic,
          ...(humanActor ? { humanActor } : {}),
        },
        to,
        subject,
        body,
        admission,
      },
      now,
      externalKey ? `n-${createHash('sha256').update(externalKey).digest('hex').slice(0, 24)}` : this.deps.newId(),
    );
    if (externalKey) note.externalKey = externalKey;
    if (ownerItem) note.ownerItem = true;
    let created = false;
    const sent = await this.withOperation(() => this.deps.mutate(async (state) => {
      const existing = externalKey ? state.notes.find((n) => n.id === note.id) : null;
      if (existing) {
        if (existing.externalKey !== externalKey || existing.from.workspaceId !== note.from.workspaceId
          || existing.from.tabId !== note.from.tabId || JSON.stringify(existing.to) !== JSON.stringify(note.to)
          || existing.from.humanActor !== note.from.humanActor
          || existing.subject !== subject || existing.body !== body || (existing.ownerItem === true) !== ownerItem) {
          throw new NoteError('note-invalid', 'portfolio note key reused with different content');
        }
        return { state, value: existing };
      }
      const mine = state.notes.filter((n) => OPEN_STATES.has(n.state)
        && n.from.workspaceId === note.from.workspaceId && n.from.tabId === note.from.tabId
        && n.from.humanActor === note.from.humanActor).length;
      if (mine >= NOTE_OPEN_PER_SENDER) {
        throw new NoteError('note-cap', `this sender already has ${mine} open notes (the limit is ${NOTE_OPEN_PER_SENDER}); wait for acks or expiry`);
      }
      if (ownerItem) {
        // Armed, not open: a note the recipient read but never acked must not block the sender for 14 days, and a
        // bounced one (no recipient yet) arms nothing. The 60 s spacing bounds what reaches one tab when they route.
        const armed = state.notes.filter((n) => n.ownerItem && n.state === 'delivered' && n.deliveredAt === null && !pointerSpent(n)
          && n.from.workspaceId === note.from.workspaceId && n.from.tabId === note.from.tabId).length;
        if (armed >= OWNER_ITEMS_ARMED_PER_SENDER) {
          throw new NoteError('note-cap', `owner-item-cap: this sender already has ${armed} owner items not yet in a composer`
            + ` (the limit is ${OWNER_ITEMS_ARMED_PER_SENDER}); wait for them to be delivered`);
        }
      }
      const bounced = await this.route(note, now, reads);
      // A failed notice never fails the send: the note stays unmarked and the next pass tells the sender.
      const routedNote = owesBounceNotice(bounced) ? await this.tellBounced(bounced, now, reads) : bounced;
      created = true;
      return { state: { notes: [...state.notes, routedNote] }, value: routedNote };
    }));
    if (admission.mode === 'owner' && created) await this.auditOwnerNote(sent);
    const view = (await this.views([sent]))[0];
    if (!sent.ownerItem) return view;
    // Not awaited: the first pointer attempt runs after the send's lock is released, and the answer does not wait on it.
    if (created) void this.pointOwnerItems().catch((err) => log.warn(`owner-item pointer failed: ${err instanceof Error ? err.message : err}`));
    return { ...view, ownerPointer: ownerPointerState(sent) };
  }

  /**
   * A typed worker event the events service validated (ADR-0043): the `event` admission, routed like
   * a coordinator note. One lifecycle lock covers the duplicate check, the sender cap and both notes,
   * so a resend never delivers twice. An event with no live recipient is refused and stores nothing.
   */
  async sendEvent(caller: ICaller, input: IEventNoteInput): Promise<{ note: INoteView; status: INoteView | null }> {
    if (caller.admin || !caller.verified || !caller.workspaceId || !caller.tabId) {
      throw new NoteError('forbidden', 'a typed event needs a verified tab');
    }
    const sender = { workspaceId: caller.workspaceId, tabId: caller.tabId };
    const to = checkTarget(input.toEpic, undefined);
    const now = this.deps.now();
    const reads = this.reads();
    const make = (target: { epic: string | null; workspaceId: string | null }, subject: string, body: string, record: INoteEventRecord): INote => {
      const note = createNote({
        from: { ...sender, verified: true, identity: caller.identity, epic: null },
        to: target,
        subject: cleanSubject(subject),
        body: checkBody(body),
        admission: { mode: 'event', sender, authorizedAt: now },
      }, now, this.deps.newId());
      note.event = record;
      return note;
    };
    const delivery = make(to, input.subject, input.body, input.record);
    const result = await this.withOperation(() => this.deps.mutate(async (state) => {
      await input.recheck?.();
      // An expired note was never acked: the same event may be sent again. Any other earlier note stands.
      const earlier = state.notes.find((n) => n.event?.role === 'delivery' && n.event.dedupeKey === input.record.dedupeKey
        && n.from.workspaceId === sender.workspaceId && n.state !== 'expired');
      if (earlier) {
        const said = earlier.state === 'acked' ? 'acked' : `${earlier.state}, not yet acked`;
        throw new WorkerEventError('event-stale',
          `this event was already sent as note ${earlier.id} (${said}); it is not delivered twice — it may be sent again once that note expires unacked`,
          { noteId: earlier.id, noteState: earlier.state });
      }
      const mine = state.notes.filter((n) => OPEN_STATES.has(n.state)
        && n.from.workspaceId === sender.workspaceId && n.from.tabId === sender.tabId && n.from.humanActor === undefined).length;
      const needed = input.status ? 2 : 1;
      if (mine + needed > NOTE_OPEN_PER_SENDER) {
        throw new NoteError('note-cap', `this sender already has ${mine} open notes (the limit is ${NOTE_OPEN_PER_SENDER}); wait for acks or expiry`);
      }
      const routedDelivery = await this.route(delivery, now, reads);
      if (routedDelivery.state !== 'delivered' || !routedDelivery.deliveredTo) {
        throw new WorkerEventError('event-no-recipient',
          `epic:${to.epic} has no live recipient now (${routedDelivery.routingReason ?? 'unrouted'}); nothing was stored — send again when its holder and orchestrator are live`,
          { reason: routedDelivery.routingReason });
      }
      const coordinator = await reads.orchestratorOf(sender.workspaceId);
      const coordinatorIsRecipient = coordinator !== null && routedDelivery.deliveredTo.workspaceId === sender.workspaceId
        && routedDelivery.deliveredTo.tabId === coordinator;
      let status: INote | null = null;
      if (input.status && !coordinatorIsRecipient && coordinator !== sender.tabId) {
        try {
          status = await this.route(make({ epic: null, workspaceId: sender.workspaceId }, input.status.subject, input.status.body,
            { ...input.status.record, deliveryNoteId: routedDelivery.id }), now, reads);
        } catch (err) {
          // Nothing is stored when this throws, so the delivery's queued line must not stay behind (review R1-6).
          if (routedDelivery.inboxItemId) {
            await this.deps.withdraw(routedDelivery.inboxItemId, 'event-not-stored').catch(() => false);
          }
          throw err;
        }
      }
      const added = status ? [routedDelivery, status] : [routedDelivery];
      return { state: { notes: [...state.notes, ...added] }, value: { delivery: routedDelivery, status } };
    }));
    const views = await this.views(result.status ? [result.delivery, result.status] : [result.delivery]);
    return { note: views[0], status: views[1] ?? null };
  }

  /** One `owner-note` line per note sent under an owner grant (ADR-0029 §5); a failed write never unsends it. */
  private async auditOwnerNote(note: INote): Promise<void> {
    try {
      await this.deps.audit?.({
        event: 'owner-note', grantId: note.admission?.grantId, noteId: note.id,
        from: { workspaceId: note.from.workspaceId, tabId: note.from.tabId }, to: note.to,
      });
    } catch (err) {
      log.warn(`owner-note audit failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * A note from an authenticated human session (ADR-0029 §6): the `human` admission, bound to one
   * target workspace. Only the human control routes call this, with their session subject.
   */
  async sendHuman(actor: string, targetWorkspaceId: string, input: ISendInput): Promise<INoteView> {
    if (!actor.trim()) throw new NoteError('forbidden', 'human actor is required');
    return this.sendCore(null, { ...input, toWorkspace: targetWorkspaceId, toEpic: undefined,
      fromEpic: undefined }, actor);
  }

  /**
   * The workspace a human note goes to: `toWorkspace`, or the workspace of the live `epic:<slug>`
   * holder now. A human admission is bound to one workspace, so an epic never stays unresolved.
   */
  async humanTarget(input: Pick<ISendInput, 'toEpic' | 'toWorkspace'>): Promise<string> {
    const to = checkTarget(input.toEpic, input.toWorkspace);
    if (to.workspaceId) return to.workspaceId;
    const holder = await this.deps.epicHolder(to.epic!);
    if (!holder) throw new NoteError('note-target-missing', `nobody live holds epic:${to.epic}`);
    return holder.workspaceId;
  }

  /** Server-originated evidence/checkpoint notices use the target workspace's durable note inbox. */
  async sendSystemLocal(workspaceId: string, input: ISendInput): Promise<INoteView> {
    return this.send({
      scope: { type: 'workspace', workspaceId }, workspaceId, tabId: null, tabName: null,
      verified: false, identity: 'none', admin: false,
    }, { ...input, toWorkspace: workspaceId, toEpic: undefined, fromEpic: undefined });
  }

  /**
   * The note and its body: the recipient workspace, the sender workspace, admin, or (ADR-0047, owner order) the
   * Portfolio Scrum Master's verified tab when either workspace is in `scrumMasterWorkspaces`, its selection. The route
   * proves the Scrum Master; a read only.
   */
  async show(caller: ICaller, id: unknown, scrumMasterWorkspaces: readonly string[] = []): Promise<{ note: INoteView; body: string }> {
    const note = await this.find(id);
    const inSelection = scrumMasterWorkspaces.some((ws) => ws === recipientWorkspace(note) || ws === note.from.workspaceId);
    if (!canShow(note, caller) && !inSelection) throw new NoteError('forbidden', `note ${note.id} belongs to other workspaces`);
    return { note: (await this.views([note]))[0], body: note.body };
  }

  async ack(caller: ICaller, id: unknown, comment: unknown): Promise<INoteView> {
    const clean = cleanComment(comment);
    const snapshot = await this.find(id);
    if (!canAck(snapshot, caller)) throw new NoteError('forbidden', `only the recipient workspace acks note ${snapshot.id}`);
    const targetWorkspaceId = snapshot.deliveredTo!.workspaceId;
    let newlyAcked = false;
    const done = await this.deps.withMappingRead(targetWorkspaceId, () => this.withOperation(() => this.deps.mutate(async (state) => {
      const note = state.notes.find((n) => n.id === id);
      if (!note) throw new NoteError('note-not-found', `no note ${String(id)}`);
      if (!canAck(note, caller)) throw new NoteError('forbidden', `only the recipient workspace acks note ${note.id}`);
      if (note.deliveredTo!.workspaceId !== targetWorkspaceId) {
        throw new NoteError('forbidden', `note ${note.id} changed recipient while ACK was starting; retry`);
      }
      const item = note.inboxItemId
        ? (await this.deps.inboxItems()).find((candidate) => candidate.id === note.inboxItemId) ?? null
        : null;
      const requiresCoordinator = note.deliveredTo !== null
        && (note.from.workspaceId === null || note.from.workspaceId !== note.deliveredTo.workspaceId);
      if (requiresCoordinator) {
        const legacyDelivered = !note.admission && (note.deliveredAt !== null || item?.state === 'delivered');
        const reads = this.reads();
        const actualDelivery = note.deliveredAt !== null || item?.state === 'delivered';
        const decision = await this.recipientOf(note, reads, { requireActionDelivery: !actualDelivery });
        const currentCoordinator = await reads.orchestratorOf(targetWorkspaceId);
        const routeMatches = legacyDelivered
          ? currentCoordinator === note.deliveredTo!.tabId
          : decision.status === 'routed'
            && decision.recipient.workspaceId === targetWorkspaceId
            && decision.recipient.tabId === note.deliveredTo!.tabId;
        if ((!note.admission && !legacyDelivered) || !routeMatches || !caller.verified
          || caller.workspaceId !== targetWorkspaceId || caller.tabId !== currentCoordinator) {
          throw new NoteError('forbidden', `only the currently routed coordinator acks cross-workspace note ${note.id}`);
        }
      }
      if (note.state === 'acked') return { state, value: note };
      if (note.state !== 'delivered') throw new NoteError('forbidden', `note ${note.id} is ${note.state}, not delivered`);
      newlyAcked = true;
      if (note.inboxItemId) await this.deps.withdraw(note.inboxItemId, 'note-terminal:acked');
      if (note.reminderItemId) await this.deps.withdraw(note.reminderItemId, 'note-terminal:acked');
      const received = item?.state === 'delivered' && note.deliveredAt === null
        ? reachedComposer(note, item.deliveredAt ?? this.deps.now())
        : note;
      const acknowledged = acked(received, { workspaceId: caller.workspaceId!, tabId: caller.tabId }, clean, this.deps.now());
      return { state: replaceNote(state, acknowledged), value: acknowledged };
    })));
    // F6: the ack is the store transition alone; nothing is typed to the sender, who reads it with `note list`.
    // PMUX-NOTE-DELIVERY: it is also recorded in the sender tab's ledger as a `log` row (`events show`), never typed.
    if (newlyAcked && this.deps.recordAck) {
      await this.deps.recordAck(done).catch((err) => log.warn(`note ${done.id} ack record not written: ${err instanceof Error ? err.message : err}`));
    }
    return (await this.views([done]))[0];
  }

  // ─── note point (G7 step 0) ─────────────────────────────────────────────

  private readonly pointBounds = new NotePointBounds();

  /**
   * The caller is the verified, live orchestrator of its own workspace: the coordinator half of `admissionFor`
   * (:244), stated on its own. `admissionFor` also returns `owner` or `local` without a throw, so its return is no coordinator check.
   */
  private async isCoordinator(caller: ICaller, r: IReads): Promise<boolean> {
    if (caller.admin || !caller.verified || !caller.workspaceId || !caller.tabId) return false;
    return (await r.orchestratorOf(caller.workspaceId)) === caller.tabId;
  }

  /**
   * The note the caller may point at, and where the line goes: the caller's own note, routed and not yet in any
   * composer, whose current route (`recipientOf`, as the paste preflight reads it) is its routed recipient, in
   * another workspace. The target is derived from the note; the caller never names a tab. Throws the refusal.
   */
  private async pointTarget(caller: ICaller, id: string, r: IReads): Promise<{ note: INote; target: { workspaceId: string; tabId: string } }> {
    if (!(await this.isCoordinator(caller, r))) {
      throw new NoteError('forbidden', 'only the verified, current orchestrator of its own workspace points at a note');
    }
    const note = await this.find(id);
    if (note.from.workspaceId !== caller.workspaceId || note.from.tabId !== caller.tabId) {
      throw new NoteError('forbidden', `note ${note.id} was not sent by this tab; a pointer names only the caller's own note`);
    }
    if (note.state !== 'delivered' || !note.deliveredTo) {
      throw new NoteError('forbidden', `note ${note.id} is ${note.state}; only a routed, unacked note takes a pointer`);
    }
    const item = note.inboxItemId ? await r.inboxItem(note.inboxItemId) : null;
    if (note.deliveredAt !== null || item?.state === 'delivered') {
      throw new NoteError('forbidden', `note ${note.id} already reached its recipient's composer`);
    }
    // A notice held stranded or transport-uncertain was typed once already: a pointer would type the note twice.
    if (item?.state === 'held' && !isRecoverableHold(item, this.deps.now())) {
      throw new NoteError('forbidden', `note ${note.id}'s notice is held (${item.heldReason ?? 'unknown'}); it is not typed again`);
    }
    if (pointerSpent(note)) {
      throw new NoteError('note-point-spent', `note ${note.id} already took its one pointer line on this route (${note.pointer!.outcome})`);
    }
    const decision = await this.recipientOf(note, r);
    if (decision.status !== 'routed') {
      throw new NoteError('forbidden', `note ${note.id} has no current route (${decision.status}: ${decision.reason})`);
    }
    const { recipient } = decision;
    if (recipient.workspaceId !== note.deliveredTo.workspaceId || recipient.tabId !== note.deliveredTo.tabId) {
      throw new NoteError('forbidden', `note ${note.id} is moving to a new recipient; point after the next routing pass`);
    }
    if (recipient.workspaceId === caller.workspaceId) {
      throw new NoteError('forbidden', `note ${note.id} stays in this workspace; a pointer goes only to another workspace's orchestrator`);
    }
    if ((await r.orchestratorOf(recipient.workspaceId)) !== recipient.tabId) {
      throw new NoteError('forbidden', `note ${note.id} is routed to a tab that is not its workspace's enabled orchestrator`);
    }
    return { note, target: recipient };
  }

  private tooSoon(noteId: string, target: { workspaceId: string; tabId: string }): NoteError | null {
    const bound = this.pointBounds.blocking(noteId, target, this.deps.now());
    if (!bound) return null;
    return new NoteError('note-point-too-soon', bound === 'note'
      ? `note ${noteId} took a pointer less than 10 min ago`
      : `${target.workspaceId}/${target.tabId} took a pointer less than 10 min ago`);
  }

  /**
   * Type one fixed pointer line for the caller's own undelivered note into its recipient orchestrator, busy
   * included (G7, vel-G7-POINTER). Lock order: the target's dispatch lock, then the notes lock, as
   * the inbox takes them before its preflight; every check runs again inside both. The caller's mapping lock is
   * never held. A typed and submitted line is the note's composer receipt, so its queued notice is withdrawn.
   */
  async point(caller: ICaller, id: unknown, port: INotePointPort): Promise<INotePointResult> {
    if (!isNoteId(id)) throw new NoteError('note-invalid', `exactly one note id (n-…) is required, not ${String(id)}`);
    const first = await this.pointTarget(caller, id, this.reads());
    const early = this.tooSoon(id, first.target);
    if (early) throw early;
    const audit = (result: string, detail?: string) => this.deps.audit?.({
      event: 'note-pointer', noteId: id, from: { workspaceId: caller.workspaceId, tabId: caller.tabId }, to: first.target, result,
      ...(detail ? { detail } : {}),
    }).catch((err) => log.warn(`note-pointer audit failed: ${err instanceof Error ? err.message : err}`));
    let outcome: INotePointResult | NoteError;
    try {
      const ran = await port.withTarget(first.target.workspaceId, first.target.tabId, async (target) => {
        const release = await this.acquireOperation();
        try {
          const { note, target: to } = await this.pointTarget(caller, id, this.reads());
          if (to.workspaceId !== first.target.workspaceId || to.tabId !== first.target.tabId) {
            return new NoteError('forbidden', `note ${id} changed recipient while the pointer waited; retry`);
          }
          const bound = this.tooSoon(id, to);
          if (bound) return bound;
          const refusal = await target.refusal();
          if (refusal) {
            return new NoteError(refusal.code, refusal.code === 'note-point-not-ready'
              ? `${to.workspaceId}/${to.tabId} cannot take the line now: ${refusal.reason}`
              : `${to.workspaceId}/${to.tabId}: ${refusal.reason}`);
          }
          const line = renderNotePointerLine({
            noteId: note.id, fromWorkspaceId: note.from.workspaceId, fromTabId: note.from.tabId,
            fromHuman: false, fromOwner: note.admission?.mode === 'owner', sentAt: note.createdAt,
            ...(note.ownerItem ? { ownerItem: true } : {}),
          });
          const stamp = await this.stampPointer(id, to, 'point');
          if (!stamp) return new NoteError('note-point-spent', `note ${id} took its pointer line on this route meanwhile`);
          const typed = await target.type(line);
          const now = this.deps.now();
          this.pointBounds.stamp(id, to, now);
          await this.recordPointer(id, stamp, typed.outcome, now);
          if (typed.outcome === 'not-clean') {
            return new NoteError('note-point-not-ready', `${to.workspaceId}/${to.tabId}: composer-not-clean: the box held other`
              + ' text beside the line, so no Enter was pressed and nothing was cleared; the note stays armed');
          }
          if (typed.outcome !== 'submitted') {
            return { status: 'sent', submitted: false, noteId: id, target: to, cliState: typed.cliState, line,
              notSubmitted: typed.outcome === 'stranded' ? 'typed-not-submitted' : 'not-verified' } satisfies INotePointResult;
          }
          this.deps.window?.()?.claim(to.workspaceId, to.tabId);
          if (note.inboxItemId) await this.deps.withdraw(note.inboxItemId, 'note-pointed');
          return { status: 'sent', submitted: true, noteId: id, target: to, cliState: typed.cliState, line } satisfies INotePointResult;
        } finally {
          release();
        }
      });
      outcome = ran ?? new NoteError('tab-not-found', `${first.target.workspaceId}/${first.target.tabId}: target-tab-gone`);
    } catch (err) {
      await audit('error', err instanceof Error ? err.message : String(err));
      throw err;
    }
    if (outcome instanceof NoteError) {
      await audit(outcome.code, outcome.message);
      throw outcome;
    }
    await audit(outcome.submitted ? 'submitted' : outcome.notSubmitted ?? 'typed-not-submitted');
    return outcome;
  }

  // ─── pointer stamps (PMUX-NOTE-DELIVERY) ─────────────────────────────────

  /**
   * Persist the pointer stamp BEFORE typing: a note takes at most one pointer line per route, across `note point`, the
   * owner-item pointer and a restart. Null when the note is gone, already in a composer, or already stamped on this
   * route. Runs inside the target's dispatch lock and the notes operation lock.
   */
  private async stampPointer(id: string, to: { workspaceId: string; tabId: string }, by: INotePointerStamp['by']): Promise<INotePointerStamp | null> {
    const stamp: INotePointerStamp = { route: routeKey(to), at: this.deps.now(), outcome: 'typing', by };
    return this.deps.mutate(async (state) => {
      const current = state.notes.find((n) => n.id === id);
      if (!current || current.deliveredAt !== null || pointerSpent(current)
        || !current.deliveredTo || routeKey(current.deliveredTo) !== stamp.route) return { state, value: null };
      return { state: replaceNote(state, pointerStamped(current, stamp)), value: stamp };
    });
  }

  /**
   * The typing's outcome on the stamp; a submitted line is the note's composer receipt. A `not-clean` typing (other text
   * in the box, no Enter) removes the stamp, so the note stays armed: the next attempt waits for an empty composer.
   * Returns the note as stored.
   */
  private async recordPointer(id: string, stamp: INotePointerStamp, outcome: TPointerTyped, at: number): Promise<INote | null> {
    return this.deps.mutate(async (state) => {
      const current = state.notes.find((n) => n.id === id);
      if (!current) return { state, value: null };
      if (outcome === 'not-clean') {
        const ours = current.pointer?.route === stamp.route && current.pointer.at === stamp.at && current.pointer.by === stamp.by;
        return ours ? { state: replaceNote(state, { ...current, pointer: null }), value: { ...current, pointer: null } } : { state, value: current };
      }
      let next = pointerStamped(current, { ...stamp, outcome });
      if (outcome === 'submitted' && next.deliveredAt === null) next = reachedComposer(next, at);
      return { state: replaceNote(state, next), value: next };
    });
  }

  // ─── the owner-item pointer (PMUX-NOTE-DELIVERY) ────────────────────────

  private ownerRunning: Promise<void> | null = null;
  private ownerAgain = false;
  /** The last refusal per note, so the audit writes a line only when the reason changes. */
  private readonly ownerRefusals = new Map<string, string>();

  /**
   * Point at the oldest armed owner item of each target tab, one line per target per pass and at least
   * OWNER_POINTER_SPACING_MS after any pointer line there. Runs with no notes lock held; each attempt takes the
   * target's dispatch lock, then the notes lock, and checks everything again. One run at a time; a run asked for
   * meanwhile runs once afterwards.
   */
  async pointOwnerItems(): Promise<void> {
    if (!this.deps.pointPort) return;
    if (this.ownerRunning) {
      this.ownerAgain = true;
      return this.ownerRunning;
    }
    this.ownerRunning = (async () => {
      try {
        do {
          this.ownerAgain = false;
          await this.pointOwnerItemsOnce();
        } while (this.ownerAgain);
      } finally {
        this.ownerRunning = null;
      }
    })();
    return this.ownerRunning;
  }

  private async pointOwnerItemsOnce(): Promise<void> {
    const now = this.deps.now();
    const { notes } = await this.deps.read();
    const items = new Map((await this.deps.inboxItems()).map((item) => [item.id, item]));
    const byTarget = new Map<string, INote[]>();
    const armedIds = new Set<string>();
    for (const note of [...notes].sort((a, b) => a.createdAt - b.createdAt)) {
      if (!note.ownerItem || note.state !== 'delivered' || !note.deliveredTo || note.deliveredAt !== null || pointerSpent(note)) continue;
      if (note.deliveredTo.workspaceId === note.from.workspaceId) continue;
      const item = note.inboxItemId ? items.get(note.inboxItemId) : undefined;
      if (!item || !(item.state === 'queued' || isRecoverableHold(item, now))) continue;
      armedIds.add(note.id);
      const key = routeKey(note.deliveredTo);
      byTarget.set(key, [...(byTarget.get(key) ?? []), note]);
    }
    // The refusal memory holds armed notes only, so it stays as small as the armed set.
    for (const id of this.ownerRefusals.keys()) if (!armedIds.has(id)) this.ownerRefusals.delete(id);
    if (byTarget.size === 0) return;
    const port = await this.deps.pointPort!();
    for (const queue of byTarget.values()) {
      // Oldest first. A note refused for itself (disarmed, or its line refused) does not block the next one; a
      // refusal of the target, a typing or the spacing ends this target's turn: the next note would meet the same tab.
      for (const note of queue) {
        const target = note.deliveredTo!;
        if (this.pointBounds.targetBusy(target, this.deps.now())) break;
        let result: TOwnerAttempt['result'] | 'error';
        try {
          result = await this.pointOwnerItem(note.id, target, port);
        } catch (err) {
          log.warn(`owner-item pointer for note ${note.id} failed: ${err instanceof Error ? err.message : err}`);
          result = 'error';
        }
        if (result !== 'disarmed' && result !== 'error') break;
      }
    }
  }

  /** Why the server will not point at this owner item now, or its current recipient. The stored flag is the authority. */
  private async ownerArmed(note: INote | undefined, r: IReads): Promise<string | { workspaceId: string; tabId: string }> {
    if (!note) return 'note-not-found';
    if (!note.ownerItem) return 'not-owner-item';
    if (note.state !== 'delivered' || !note.deliveredTo) return `note-${note.state}`;
    if (note.deliveredAt !== null) return 'in-composer';
    if (pointerSpent(note)) return 'pointer-spent';
    const item = note.inboxItemId ? await r.inboxItem(note.inboxItemId) : null;
    if (!item || !(item.state === 'queued' || isRecoverableHold(item, this.deps.now()))) {
      return `notice-${item?.state ?? 'missing'}${item?.heldReason ? `:${item.heldReason}` : ''}`;
    }
    const decision = await this.recipientOf(note, r);
    if (decision.status !== 'routed') return `route-${decision.status}:${decision.reason}`;
    const { recipient } = decision;
    if (routeKey(recipient) !== routeKey(note.deliveredTo)) return 'route-moving';
    if (recipient.workspaceId === note.from.workspaceId) return 'same-workspace';
    if ((await r.orchestratorOf(recipient.workspaceId)) !== recipient.tabId) return 'recipient-not-orchestrator';
    return recipient;
  }

  private async pointOwnerItem(id: string, first: { workspaceId: string; tabId: string }, port: INotePointPort): Promise<TOwnerAttempt['result']> {
    const attempt = await port.withTarget(first.workspaceId, first.tabId, async (target): Promise<TOwnerAttempt> => {
      const release = await this.acquireOperation();
      try {
        const note = (await this.deps.read()).notes.find((n) => n.id === id);
        const armed = await this.ownerArmed(note, this.reads());
        if (typeof armed === 'string') return { result: 'disarmed', reason: armed };
        if (routeKey(armed) !== routeKey(first)) return { result: 'disarmed', reason: 'route-moving' };
        if (this.pointBounds.targetBusy(armed, this.deps.now())) return { result: 'spacing' };
        // The note's own checks first (no I/O), then the target's: a refusal of the note does not wait on the tab.
        let line: string;
        try {
          line = renderNotePointerLine({
            noteId: note!.id, fromWorkspaceId: note!.from.workspaceId, fromTabId: note!.from.tabId,
            fromHuman: false, fromOwner: note!.admission?.mode === 'owner', sentAt: note!.createdAt, ownerItem: true,
          });
        } catch (err) {
          return { result: 'disarmed', reason: `line-refused:${err instanceof Error ? err.message : String(err)}` };
        }
        const refusal = await target.refusal();
        if (refusal) return { result: 'refused', reason: refusal.reason };
        const stamp = await this.stampPointer(id, armed, 'owner-item');
        if (!stamp) return { result: 'disarmed', reason: 'pointer-spent' };
        const typed = await target.type(line);
        const at = this.deps.now();
        this.pointBounds.stamp(id, armed, at);
        const stored = await this.recordPointer(id, stamp, typed.outcome, at);
        if (typed.outcome === 'not-clean') return { result: 'not-clean', reason: 'composer-not-clean' };
        // No window claim: an owner line neither waits for the coordinator window nor delays the digest behind it.
        if (typed.outcome === 'submitted' && note!.inboxItemId) await this.deps.withdraw(note!.inboxItemId, 'note-pointed');
        return { result: typed.outcome, detail: typed.detail, note: stored ?? note!, at };
      } finally {
        release();
      }
    });
    const outcome: TOwnerAttempt = attempt ?? { result: 'refused', reason: 'target-tab-gone' };
    if (outcome.result === 'spacing') return outcome.result;
    const kept = 'reason' in outcome;
    if (kept) {
      // A refusal, a disarm or a composer that was not clean: the note keeps its reason, audited when it changes.
      if (this.ownerRefusals.get(id) === outcome.reason) return outcome.result;
      this.ownerRefusals.set(id, outcome.reason);
    } else {
      this.ownerRefusals.delete(id);
    }
    await this.deps.audit?.({
      event: 'note-pointer', by: 'owner-item', noteId: id, to: first, result: outcome.result,
      ...(kept ? { detail: outcome.reason } : {}),
      ...('detail' in outcome && outcome.detail ? { detail: outcome.detail } : {}),
    }).catch((err) => log.warn(`note-pointer audit failed: ${err instanceof Error ? err.message : err}`));
    if ((outcome.result === 'stranded' || outcome.result === 'unverified') && this.deps.alertPointerSpent) {
      const { note, at } = outcome;
      void Promise.resolve().then(() => this.deps.alertPointerSpent!(note, outcome.result as 'stranded' | 'unverified', at)).catch((err) => {
        log.warn(`note ${id} pointer alert not sent: ${err instanceof Error ? err.message : err}`);
      });
    }
    return outcome.result;
  }

  /** The last reason each armed owner item was kept (refused, disarmed or composer-not-clean); for status readers. */
  ownerItemReason(id: string): string | null {
    return this.ownerRefusals.get(id) ?? null;
  }

  // ─── retired ack notices (PMUX-NOTE-DELIVERY change 2) ──────────────────

  /**
   * Boot only: withdraw every `acked` notice (F6 retired the event) still queued or held. A held one was typed before
   * F6 and stranded; it is never typed again, but it stays in `inbox list` for 7 days. Returns how many were withdrawn.
   */
  async sweepRetiredAckNotices(): Promise<number> {
    let withdrawn = 0;
    for (const item of await this.deps.inboxItems()) {
      if (item.kind !== 'note' || (item.state !== 'queued' && item.state !== 'held')) continue;
      if (!/^note:n-[A-Za-z0-9_-]{4,32}:acked:/.test(item.dedupeKey)) continue;
      if (await this.deps.withdraw(item.id, 'note-ack-notice-retired')) withdrawn += 1;
    }
    return withdrawn;
  }

  async list(caller: ICaller, filter: IListFilter): Promise<INoteView[]> {
    const { notes } = await this.deps.read();
    const visible = notes
      .filter((n) => canShow(n, caller))
      .filter((n) => !filter.open || OPEN_STATES.has(n.state))
      .filter((n) => !filter.fromMe || (!caller.admin && n.from.workspaceId === caller.workspaceId))
      .filter((n) => !filter.toMe || caller.admin || isToMe(n, caller))
      .filter((n) => !filter.epic || n.to.epic === filter.epic || n.from.epic === filter.epic)
      .sort((a, b) => a.createdAt - b.createdAt);
    return this.views(visible);
  }

  private async find(id: unknown): Promise<INote> {
    const note = isNoteId(id) ? (await this.deps.read()).notes.find((n) => n.id === id) : undefined;
    if (!note) throw new NoteError('note-not-found', `no note ${String(id)}`);
    return note;
  }
}

// ─── the server's instance ────────────────────────────────────────────────

export const NOTES_TICK_MS = 15_000;

const defaultDeps = async (): Promise<INotesDeps> => {
  const [leaseStore, leaseHttp, workspaceStore, tabLifecycle, inboxStore, mappingLock, grantStore, coordinationAudit, coordinatorWindow] = await Promise.all([
    import('@/lib/lease-store'),
    import('@/lib/lease-http'),
    import('@/lib/workspace-store'),
    import('@/lib/tab-lifecycle'),
    import('@/lib/inbox-store'),
    import('@/lib/orchestration-mapping-lock'),
    import('@/lib/grant-store'),
    import('@/lib/coordination-audit'),
    import('@/lib/coordinator-window'),
  ]);
  const epicLease = async (slug: string) => {
    const now = Date.now();
    const { state } = leaseStore.pruneExpired(await leaseStore.readLeaseState(), now);
    return state.leases.find((l) => l.name === `epic:${slug}`) ?? null;
  };
  return {
    now: () => Date.now(),
    newId: newNoteId,
    mutate: mutateNotes,
    read: readNotesState,
    epicHolder: async (slug) => {
      const lease = await epicLease(slug);
      if (!lease?.holder.tabId || !lease.holder.workspaceId) return null;
      const view = await leaseHttp.viewOf(lease);
      return view.holderState === 'live' ? { workspaceId: lease.holder.workspaceId, tabId: lease.holder.tabId } : null;
    },
    holdsEpic: async (caller, slug) => {
      const lease = await epicLease(slug);
      return !!lease && leaseStore.sameHolder(lease.holder, leaseStore.holderFromCaller(caller));
    },
    orchestratorOf: async (workspaceId) => {
      const orchestration = (await workspaceStore.getWorkspaceById(workspaceId))?.orchestration;
      return (orchestration?.enabled ? orchestration.orchestratorTabId : null) ?? null;
    },
    withMappingRead: mappingLock.withOrchestrationMappingRead,
    workspaceExists: async (workspaceId) => !!(await workspaceStore.getWorkspaceById(workspaceId)),
    liveTabs: tabLifecycle.readLiveTabs,
    enqueue: inboxStore.enqueueNotice,
    withdraw: inboxStore.withdrawNotice,
    inboxItems: async () => (await inboxStore.readInboxState()).items,
    portfolioActionDeliverable: async (actionId, noteId, workspaceId) => {
      const { getPortfolioStore } = await import('@/lib/portfolio-store');
      return getPortfolioStore().actionNoteDeliverable(actionId, noteId, workspaceId);
    },
    ownerGrantOf: (tab) => grantStore.findActiveOwnerGrant(grantStore.grantsSnapshot('owner'), tab, Date.now()),
    audit: coordinationAudit.appendCoordinationAudit,
    window: coordinatorWindow.getCoordinatorWindow,
    alertUndelivered: async (note, _now, senderTold) => {
      // The portfolio Scrum Master seat hears it as one digest line, as a pool flag does. Its own note needs no copy: it
      // is the sender, told already, or the recipient that has not read it.
      const [{ getPortfolioStore }, { getStatusManager }, { undeliveredDigestEvent }] = await Promise.all([
        import('@/lib/portfolio-store'),
        import('@/lib/status-manager'),
        import('@/lib/note-pending'),
      ]);
      const seat = getPortfolioStore().currentSelection()?.selection;
      if (!seat?.managerWorkspaceId || !seat.managerTabId) return;
      const at = { workspaceId: seat.managerWorkspaceId, tabId: seat.managerTabId };
      const same = (t: { workspaceId: string | null; tabId: string | null } | null) => !!t && t.workspaceId === at.workspaceId && t.tabId === at.tabId;
      if (same(note.from) || same(note.deliveredTo)) return;
      await getStatusManager().routeTabEvent(undeliveredDigestEvent(note, at, senderTold));
    },
    pointPort: async () => (await import('@/lib/note-pointer')).defaultNotePointPort(),
    alertPointerSpent: async (note, outcome, at) => {
      const [{ getPortfolioStore }, { getStatusManager }, { pointerSpentEvents }] = await Promise.all([
        import('@/lib/portfolio-store'),
        import('@/lib/status-manager'),
        import('@/lib/note-pending'),
      ]);
      const seat = getPortfolioStore().currentSelection()?.selection;
      const at2 = seat?.managerWorkspaceId && seat.managerTabId ? { workspaceId: seat.managerWorkspaceId, tabId: seat.managerTabId } : null;
      for (const event of pointerSpentEvents(note, outcome, at, at2)) await getStatusManager().routeTabEvent(event);
    },
    recordAck: async (note) => {
      const [{ getStatusManager }, { ackedLogEvent }] = await Promise.all([
        import('@/lib/status-manager'),
        import('@/lib/note-pending'),
      ]);
      const event = ackedLogEvent(note);
      if (event) await getStatusManager().routeTabEvent(event);
    },
    alertBounced: async (note) => {
      const [{ getStatusManager }, { bouncedDigestEvent }] = await Promise.all([
        import('@/lib/status-manager'),
        import('@/lib/note-pending'),
      ]);
      const event = bouncedDigestEvent(note);
      if (event) await getStatusManager().routeTabEvent(event);
    },
  };
};

interface INotesRuntime {
  service: NotesService | null;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribeLease: (() => void) | null;
  unregisterPreflight: (() => void) | null;
}

const g = globalThis as unknown as { __ptNotesRuntime?: INotesRuntime; __ptNotesService?: NotesService };

/** The service the CLI routes use; the runtime ticks the same one. */
export const getNotesService = async (): Promise<NotesService> => {
  if (!g.__ptNotesService) g.__ptNotesService = new NotesService(await defaultDeps());
  return g.__ptNotesService;
};

export const startNotes = async (): Promise<void> => {
  if (g.__ptNotesRuntime) return;
  const runtime: INotesRuntime = { service: null, timer: null, unsubscribeLease: null, unregisterPreflight: null };
  g.__ptNotesRuntime = runtime;
  const service = await getNotesService();
  const [{ onLeaseAcquired }, { registerInboxPreflight }] = await Promise.all([
    import('@/lib/lease-store'),
    import('@/lib/inbox-dispatcher'),
  ]);
  if (g.__ptNotesRuntime !== runtime) return;
  runtime.service = service;
  runtime.unregisterPreflight = registerInboxPreflight('note', (item) => service.preflight(item));
  const tick = (onlyEpic?: string) => {
    service.tick(onlyEpic).catch((err) => log.warn(`notes tick failed: ${err instanceof Error ? err.message : err}`));
  };
  await service.sweepRetiredAckNotices()
    .then((n) => { if (n) log.info(`withdrew ${n} retired ack notice(s)`); })
    .catch((err) => log.warn(`retired ack sweep failed: ${err instanceof Error ? err.message : err}`));
  await service.reconcileInitial().catch((err) => log.warn(`initial notes tick failed: ${err instanceof Error ? err.message : err}`));
  if (g.__ptNotesRuntime !== runtime) return;
  // Claiming an epic routes the notes that waited for its owner now, not on the next tick.
  runtime.unsubscribeLease = onLeaseAcquired((lease, outcome) => {
    if (lease.kind === 'epic' && outcome === 'acquired') tick(lease.resource);
  });
  const timer = setInterval(() => tick(), NOTES_TICK_MS);
  timer.unref?.();
  runtime.timer = timer;
};

export const stopNotes = async (): Promise<void> => {
  const runtime = g.__ptNotesRuntime;
  if (!runtime) return;
  g.__ptNotesRuntime = undefined;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.unsubscribeLease?.();
  runtime.unregisterPreflight?.();
};
