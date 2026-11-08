import type { ICaller } from '@/lib/caller';
import { createHash } from 'crypto';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import type { TNoteEvent } from '@/lib/inbox-templates';
import { createLogger } from '@/lib/logger';
import {
  NOTE_EXPIRE_MS,
  NOTE_EXPIRE_NOTICE_GRACE_MS,
  NOTE_OPEN_PER_SENDER,
  NOTE_REMIND_MS,
  NOTE_SENDER_NOTICE_MS,
  NoteError,
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
  readNotesState,
  recipientWorkspace,
  reminded,
  replaceNote,
  requeued,
  routed,
  senderNotified,
  undeliverable,
  viewOf,
} from '@/lib/notes-store';
import type { IGrant } from '@/types/grant';
import type { IInboxItem } from '@/types/inbox';
import type { INote, INoteAdmission, INoteReceipt, INotesState, INoteView, TNoteRoutingStatus } from '@/types/note';
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
  /** One coordination audit line (`owner-note`). */
  audit?: (entry: Record<string, unknown>) => Promise<unknown>;
}

export interface ILiveTabs {
  tabs: ReadonlyArray<{ workspaceId: string; tabId: string }>;
  uncertainWorkspaceIds: ReadonlySet<string>;
}

type TTabState = 'live' | 'closed' | 'unknown';

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
    const acker = event === 'acked' && note.ackedBy && note.ackedAt !== null
      ? { ackedByWorkspaceId: note.ackedBy.workspaceId, ackedByTabId: note.ackedBy.tabId, ackedAt: note.ackedAt }
      : {};
    return {
      kind: 'note',
      targetWorkspaceId: to.workspaceId,
      targetTabId: to.tabId,
      dedupeKey: `note:${note.id}:${event}:${to.tabId}`,
      fields: { noteId: note.id, fromWorkspaceId: note.from.workspaceId, fromTabId: note.from.tabId,
        fromHuman: note.admission?.mode === 'human', fromOwner: note.admission?.mode === 'owner', sentAt: note.createdAt, event,
        ...acker },
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
      const match = /^note:(n-[A-Za-z0-9_-]{4,32}):(delivered|reminder|unacked|expired|acked):/.exec(item.dedupeKey);
      if (!match) return reject('note-notice-key-invalid');
      const [, id, event] = match;
      const note = (await this.deps.read()).notes.find((candidate) => candidate.id === id);
      if (!note) return reject('note-not-found');
      if (event === 'acked') {
        if (note.state !== 'acked') return reject(`note-not-acked:${note.state}`);
        if (item.targetWorkspaceId !== note.from.workspaceId || item.targetTabId !== note.from.tabId) {
          return reject('note-sender-changed');
        }
        return { ok: true, settle: release };
      }
      if (event === 'unacked' || event === 'expired') {
        const valid = event === 'expired'
          ? note.state === 'expired' || (OPEN_STATES.has(note.state) && this.deps.now() - note.createdAt >= NOTE_EXPIRE_MS)
          : note.state === 'delivered';
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
   * One notice to the sender's tab when it is live. True when the notice is settled: sent, or the
   * sender has no tab or its tab is confirmed closed. An unknown tab state settles nothing.
   */
  private async noticeSender(note: INote, event: 'unacked' | 'expired', r: IReads): Promise<boolean> {
    const { workspaceId, tabId } = note.from;
    if (!workspaceId || !tabId) return true;
    const state = await r.tabState(workspaceId, tabId);
    if (state === 'live') await this.deps.enqueue(this.notice(note, { workspaceId, tabId }, event));
    return state !== 'unknown';
  }

  /**
   * D17 (story hfl2-06): an ack that carries a comment reaches the sender's own tab as a fixed line;
   * the comment is pulled with `note show`, never typed (ADR-0012). The line is queued when the tab
   * is live or its state is unknown: the inbox refuses an unresolved target and drops the item only
   * when it sees the tab gone. Nothing goes to a sender with no tab, to a closed tab, or to the tab
   * that acked its own note. A failure here never fails the ack, which is already stored.
   */
  private async noticeAck(note: INote): Promise<void> {
    const { workspaceId, tabId } = note.from;
    if (note.ackComment === null || !workspaceId || !tabId) return;
    if (note.ackedBy?.workspaceId === workspaceId && note.ackedBy.tabId === tabId) return;
    try {
      if ((await this.reads().tabState(workspaceId, tabId)) === 'closed') return;
      await this.deps.enqueue(this.notice(note, { workspaceId, tabId }, 'acked'));
    } catch (err) {
      log.warn(`note ${note.id} ack notice not sent: ${err instanceof Error ? err.message : err}`);
    }
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
      const settled = await this.noticeSender(expiring, 'expired', r);
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
    // recipient that never reads the line, so it must not wait for the line to be read.
    if (next.senderNotifiedAt === null && next.routedAt !== null && now - next.routedAt >= NOTE_SENDER_NOTICE_MS) {
      try {
        if (!(await this.noticeSender(next, 'unacked', r))) return next;
      } catch (err) {
        log.warn(`note ${note.id} sender notice not sent: ${err instanceof Error ? err.message : err}`);
        return next;
      }
      next = senderNotified(next, now);
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

  async send(caller: ICaller, input: ISendInput): Promise<INoteView> {
    return this.sendCore(caller, input);
  }

  private async sendCore(caller: ICaller | null, input: ISendInput, humanActor?: string): Promise<INoteView> {
    const to = checkTarget(input.toEpic, input.toWorkspace);
    const subject = cleanSubject(input.subject);
    const body = checkBody(input.body);
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
    let created = false;
    const sent = await this.withOperation(() => this.deps.mutate(async (state) => {
      const existing = externalKey ? state.notes.find((n) => n.id === note.id) : null;
      if (existing) {
        if (existing.externalKey !== externalKey || existing.from.workspaceId !== note.from.workspaceId
          || existing.from.tabId !== note.from.tabId || JSON.stringify(existing.to) !== JSON.stringify(note.to)
          || existing.from.humanActor !== note.from.humanActor
          || existing.subject !== subject || existing.body !== body) {
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
      const routedNote = await this.route(note, now, reads);
      created = true;
      return { state: { notes: [...state.notes, routedNote] }, value: routedNote };
    }));
    if (admission.mode === 'owner' && created) await this.auditOwnerNote(sent);
    return (await this.views([sent]))[0];
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

  async show(caller: ICaller, id: unknown): Promise<{ note: INoteView; body: string }> {
    const note = await this.find(id);
    if (!canShow(note, caller)) throw new NoteError('forbidden', `note ${note.id} belongs to other workspaces`);
    return { note: (await this.views([note]))[0], body: note.body };
  }

  async ack(caller: ICaller, id: unknown, comment: unknown): Promise<INoteView> {
    const clean = cleanComment(comment);
    const snapshot = await this.find(id);
    if (!canAck(snapshot, caller)) throw new NoteError('forbidden', `only the recipient workspace acks note ${snapshot.id}`);
    const targetWorkspaceId = snapshot.deliveredTo!.workspaceId;
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
      if (note.state === 'acked') return { state, value: { note, fresh: false } };
      if (note.state !== 'delivered') throw new NoteError('forbidden', `note ${note.id} is ${note.state}, not delivered`);
      if (note.inboxItemId) await this.deps.withdraw(note.inboxItemId, 'note-terminal:acked');
      if (note.reminderItemId) await this.deps.withdraw(note.reminderItemId, 'note-terminal:acked');
      const received = item?.state === 'delivered' && note.deliveredAt === null
        ? reachedComposer(note, item.deliveredAt ?? this.deps.now())
        : note;
      const acknowledged = acked(received, { workspaceId: caller.workspaceId!, tabId: caller.tabId }, clean, this.deps.now());
      return { state: replaceNote(state, acknowledged), value: { note: acknowledged, fresh: true } };
    })));
    // Only the ack that made the transition notifies: a repeated ack sends nothing new.
    if (done.fresh) await this.noticeAck(done.note);
    return (await this.views([done.note]))[0];
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
  const [leaseStore, leaseHttp, workspaceStore, tabLifecycle, inboxStore, mappingLock, grantStore, coordinationAudit] = await Promise.all([
    import('@/lib/lease-store'),
    import('@/lib/lease-http'),
    import('@/lib/workspace-store'),
    import('@/lib/tab-lifecycle'),
    import('@/lib/inbox-store'),
    import('@/lib/orchestration-mapping-lock'),
    import('@/lib/grant-store'),
    import('@/lib/coordination-audit'),
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
