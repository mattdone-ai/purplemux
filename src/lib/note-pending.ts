import { isNoteBounceReason } from '@/lib/inbox-templates';
import { OPEN_STATES, readNotesState } from '@/lib/notes-store';
import type { ITabEventRoute } from '@/lib/tab-event-router';
import type { INote } from '@/types/note';

// G7 step 1 (b): readers only, over the note store that exists. A coordinator's digest and each watchdog nudge typed
// to it carry how many open notes wait for it and the oldest one's age, with the command that lists them; the
// Scrum Master seat's digest hears of a note whose line has not reached its recipient's composer after 15 min, and a
// sender's own digest hears of its note that bounced.
// Every value here is server-made: ids, counts and times. No subject or body is ever read.

const MIN = 60_000;
const WORKSPACE_ID = /^ws-[A-Za-z0-9_-]{1,32}$/;
const TAB_ID = /^tab-[A-Za-z0-9_-]{1,32}$/;
const NOTE_ID = /^n-[A-Za-z0-9_-]{4,32}$/;

/** The open notes routed to this tab: exactly what `note list --open --to-me` lists for it. */
export const pendingNotesFor = (notes: readonly INote[], workspaceId: string, tabId: string): { count: number; oldestAt: number | null } => {
  const mine = notes.filter((n) => OPEN_STATES.has(n.state) && n.deliveredTo !== null
    && n.deliveredTo.workspaceId === workspaceId && n.deliveredTo.tabId === tabId);
  return { count: mine.length, oldestAt: mine.length ? Math.min(...mine.map((n) => n.createdAt)) : null };
};

/** `90 min`, never a fraction; a clock skew that puts the note in the future reads `0 min`. */
const age = (ms: number): string => `${Math.max(0, Math.floor(ms / MIN))} min`;

/** `N notes pending, oldest <age>: run purplemux note list --open --to-me`, or null when none wait. */
export const renderPendingNotesLine = (pending: { count: number; oldestAt: number | null }, now: number): string | null => {
  if (pending.count === 0 || pending.oldestAt === null) return null;
  const noun = pending.count === 1 ? 'note' : 'notes';
  return `${pending.count} ${noun} pending, oldest ${age(now - pending.oldestAt)}: run purplemux note list --open --to-me`;
};

/** The line for a tab now, read from the store. Null when nothing waits; throws when the store is unreadable. */
export const readPendingNotesLine = async (workspaceId: string, tabId: string, now: number): Promise<string | null> =>
  renderPendingNotesLine(pendingNotesFor((await readNotesState()).notes, workspaceId, tabId), now);

const party = (workspaceId: string | null, tabId: string | null): string => {
  if (workspaceId === null || !WORKSPACE_ID.test(workspaceId)) return 'unknown';
  return tabId !== null && TAB_ID.test(tabId) ? `${workspaceId}/${tabId}` : `${workspaceId}/workspace`;
};

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const checkedId = (note: INote): string => {
  if (!NOTE_ID.test(note.id)) throw new Error('note id does not match its grammar');
  return note.id;
};

/**
 * The Scrum Master seat's digest line for an undelivered note: ids and times only, never the subject. The text is
 * fixed per note (a time, not an age), so a second alert for the same note while the first waits is a duplicate.
 * `senderTold` is true only when a notice to the sender's live tab went out.
 */
export const renderUndeliveredAlert = (note: INote, senderTold: boolean): string => {
  const id = checkedId(note);
  const to = note.deliveredTo ? party(note.deliveredTo.workspaceId, note.deliveredTo.tabId) : 'unrouted';
  return `note ${id} from ${party(note.from.workspaceId, note.from.tabId)} to ${to} has not reached its recipient's`
    + ` composer since it was routed at ${iso(note.routedAt ?? note.createdAt)}; `
    + (senderTold ? 'its sender was told' : 'its sender has no live tab and was not told');
};

export const undeliveredDigestEvent = (note: INote, seat: { workspaceId: string; tabId: string }, senderTold: boolean): ITabEventRoute => ({
  ...seat, kind: 'note-undelivered', class: 'digest', text: renderUndeliveredAlert(note, senderTold),
});

/**
 * The sender's digest line for a bounced note: the id, the server's reason and the bounce time. The epic slug is
 * never typed (any tab may hold `epic:<words>`). Fixed per bounce, so a repeat while the first waits is a duplicate.
 */
export const renderBouncedAlert = (note: INote): string => {
  const id = checkedId(note);
  if (!isNoteBounceReason(note.routingReason)) throw new Error('routing reason is not a bounce reason');
  return `note ${id} bounced at ${iso(note.transitionAt)} (${note.routingReason}): no live recipient; it waits for one`
    + ` until it expires — purplemux note show ${id}`;
};

/** The digest event for the sender's own tab, or null when the note has no sender tab. */
export const bouncedDigestEvent = (note: INote): ITabEventRoute | null => {
  const { workspaceId, tabId } = note.from;
  if (!workspaceId || !tabId) return null;
  return { workspaceId, tabId, kind: 'note-bounced', class: 'digest', text: renderBouncedAlert(note) };
};
