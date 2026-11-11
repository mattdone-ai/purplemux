import type { TCallerIdentity } from '@/types/identity';
import type { INoteEventRecord } from '@/types/worker-event';

// Notes with acknowledgement (ADR-0013): a body the recipient pulls. Only the
// inbox's fixed one-line notice is ever typed into the recipient's tab.

export type TNoteState = 'queued' | 'delivered' | 'acked' | 'undeliverable' | 'expired';
export type TNoteRoutingStatus = 'pending' | 'routed' | 'undeliverable' | 'policyblocked';

export interface INoteAdmission {
  /**
   * Human admission is bound to one target by the authenticated same-origin control.
   * Owner admission is a verified tab holding an active owner grant (ADR-0029); it routes like `coordinator`.
   * Event admission is a verified worker tab whose typed event the server validated in its declared
   * scope (ADR-0043); it routes like `coordinator`.
   */
  mode: 'local' | 'coordinator' | 'human' | 'owner' | 'event';
  sender: { workspaceId: string | null; tabId: string | null };
  /** The owner grant that admitted an `owner` note. */
  grantId?: string;
  humanActor?: string;
  targetWorkspaceId?: string;
  authorizedAt: number;
}

export interface INoteParty {
  /** null for an admin-token sender. */
  workspaceId: string | null;
  tabId: string | null;
  verified: boolean;
  /** How the sender was named (story 36); absent on notes sent before it. */
  identity?: TCallerIdentity;
  /** Set only when the sender's tab held `epic:<slug>` at send time. */
  epic: string | null;
  /** Authenticated browser-session subject; never a CLI tab identity. */
  humanActor?: string;
}

export interface INoteTarget {
  epic: string | null;
  workspaceId: string | null;
}

export interface INote {
  /** `n-<nanoid>`. */
  id: string;
  /** Stable producer key for an idempotent portfolio action or escalation. */
  externalKey?: string;
  /** A typed worker event this note carries (ADR-0043). */
  event?: INoteEventRecord;
  from: INoteParty;
  to: INoteTarget;
  /** ≤ 120 characters, control characters removed. Shown by list/show, never typed. */
  subject: string;
  /** ≤ 16 KiB UTF-8. Shown by show only. */
  body: string;
  createdAt: number;
  state: TNoteState;
  /** Send-time authority. Absent on notes persisted before coordinator routing was introduced. */
  admission?: INoteAdmission;
  /** Routing is separate from composer receipt; `state: delivered` remains the legacy routed value. */
  routingStatus?: TNoteRoutingStatus;
  routingReason?: string | null;
  /** The tab the note was last routed to. */
  deliveredTo: { workspaceId: string; tabId: string } | null;
  /** When the note was FIRST routed (its inbox notice queued): the sender's clock. A re-route keeps it. */
  routedAt: number | null;
  /** When the notice reached the recipient's composer (the inbox item delivered). */
  deliveredAt: number | null;
  inboxItemId: string | null;
  ackedAt: number | null;
  ackedBy: { workspaceId: string; tabId: string | null } | null;
  ackComment: string | null;
  remindedAt: number | null;
  /** The inbox item of the reminder to the current recipient, so a re-route can withdraw it. Absent in notes stored before it existed. */
  reminderItemId?: string | null;
  senderNotifiedAt: number | null;
  /**
   * When the sender of the current bounce was told, or was found to have no tab to tell. Null while that is owed; a
   * route or a re-queue resets it. Absent on notes stored before bounce alerts: those owe none.
   */
  bounceNotifiedAt?: number | null;
  expiredAt: number | null;
  transitionAt: number;
}

export interface INotesState {
  notes: INote[];
}

export interface INoteReceipt {
  routingStatus: TNoteRoutingStatus;
  routingReason: string | null;
  authorizedSender: INoteAdmission['sender'] | null;
  authorizedRecipient: { workspaceId: string; tabId: string } | null;
  notice: {
    id: string;
    state: 'queued' | 'delivered' | 'held' | 'dropped';
    lastRefusal: string | null;
    heldReason: string | null;
    deliveredAt: number | null;
  } | null;
  /** Kept after the inbox prunes its item. Null means routed, but not known to have reached a composer. */
  composerDeliveredAt: number | null;
}

/**
 * The state a response reports. A stored `delivered` note is only routed: it reads `pending` while
 * its notice waits in the inbox, `held` while the notice is held, and `delivered` once the notice
 * reached the recipient's composer.
 */
export type TNoteViewState = TNoteState | 'pending' | 'held';

/** A note without its body: what `note list` returns. */
export type INoteView = Omit<INote, 'body' | 'state'> & {
  state: TNoteViewState;
  bodyBytes: number;
  /** Server-made: the words after "from" in the note's inbox line, e.g. `owner (<ws>/<tab>)` (ADR-0029). */
  fromLabel: string;
  receipt?: INoteReceipt;
};

export type TNoteErrorCode = 'note-not-found' | 'note-too-large' | 'note-target-missing' | 'forbidden' | 'note-invalid' | 'note-cap'
  // `note point` (G7): the target tab is gone, its session is dead, it cannot take a line now, or a bound holds.
  | 'tab-not-found' | 'session-not-running' | 'note-point-not-ready' | 'note-point-too-soon';
