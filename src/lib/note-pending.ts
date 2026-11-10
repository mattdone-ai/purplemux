import { OPEN_STATES, readNotesState } from '@/lib/notes-store';
import type { INote } from '@/types/note';

// G7 step 1 (b): readers only, over the note store that exists. A coordinator's digest and each watchdog nudge typed
// to it carry how many open notes wait for it and the oldest one's age, with the command that lists them; the
// Scrum Master seat's digest hears of a note whose line has not reached its recipient's composer after 15 min.
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

/** The Scrum Master seat's digest line for an undelivered note: ids and times only, never the subject. */
export const renderUndeliveredAlert = (note: INote, now: number): string => {
  if (!NOTE_ID.test(note.id)) throw new Error('note id does not match its grammar');
  const to = note.deliveredTo ? party(note.deliveredTo.workspaceId, note.deliveredTo.tabId) : 'unrouted';
  const since = note.routedAt ?? note.createdAt;
  return `note ${note.id} from ${party(note.from.workspaceId, note.from.tabId)} to ${to} has not reached its recipient's`
    + ` composer after ${age(now - since)}; its sender was told`;
};
