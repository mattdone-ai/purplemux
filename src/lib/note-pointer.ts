import { isAgentPanelType } from '@/lib/agent-panel-types';
import type { TAgentDispatchPolicyCheck } from '@/lib/agent-dispatch-policy';
import { checkComposerReady } from '@/lib/composer-readiness';
import { COORDINATOR_WINDOW_MS } from '@/lib/coordinator-window';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// `note point` (G7 step 0): a verified coordinator types ONE fixed line that names its own undelivered note into the
// recipient workspace's orchestrator, busy included. The note stays the record; the line only makes the recipient
// pull it. The service (`NotesService.point`) decides who may point at which note; this module holds the bounds and
// the target-side checks, which are the inbox dispatcher's checks with `busy` admitted and no wait.

/**
 * One pointer per note, and one per target tab from any sender, per coordinator window: a coordinator holds up to 50
 * open notes, so a per-note bound alone would let one sender type 50 lines into one tab at once.
 */
export const NOTE_POINT_BOUND_MS = COORDINATOR_WINDOW_MS;

/**
 * The two bounds, in memory: a restart forgets them, which costs at most one extra line per note. They are checked
 * and stamped inside the target's dispatch lock and the notes lock, and stamped only when text was typed.
 */
export class NotePointBounds {
  private readonly notes = new Map<string, number>();
  private readonly targets = new Map<string, number>();

  constructor(private readonly boundMs: number = NOTE_POINT_BOUND_MS) {}

  /** The bound that holds now, or null when the pointer may go. */
  blocking(noteId: string, target: { workspaceId: string; tabId: string }, now: number): 'note' | 'target' | null {
    const note = this.notes.get(noteId);
    if (note !== undefined && now - note < this.boundMs) return 'note';
    const tab = this.targets.get(`${target.workspaceId}/${target.tabId}`);
    if (tab !== undefined && now - tab < this.boundMs) return 'target';
    return null;
  }

  stamp(noteId: string, target: { workspaceId: string; tabId: string }, now: number): void {
    this.notes.set(noteId, now);
    this.targets.set(`${target.workspaceId}/${target.tabId}`, now);
  }
}

/** What the pointer reads and does at the target tab; the server wires the inbox dispatcher's own dependencies. */
export interface INotePointTargetDeps {
  findTab: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  hasSession: (sessionName: string) => Promise<boolean>;
  status: (tabId: string) => IClientTabStatusEntry | undefined;
  halted: (tabId: string) => boolean;
  capture: (sessionName: string) => Promise<string | null>;
  withDispatchLock: <T>(workspaceId: string, tab: ITab, work: (checkPolicy: TAgentDispatchPolicyCheck) => Promise<T>) => Promise<T>;
  deliver: (sessionName: string, line: string) => Promise<void>;
  isPending: (sessionName: string, line: string) => Promise<boolean>;
}

/** Inside the target's dispatch lock: the checks, then the typing. */
export interface INotePointTarget {
  /** Null when the target can take a line now; else the reason (nothing is typed). */
  refusal: () => Promise<{ code: 'tab-not-found' | 'session-not-running' | 'note-point-not-ready'; reason: string } | null>;
  /** Type the line and press Enter; `submitted` is false when the line still sits in the composer. */
  type: (line: string) => Promise<{ submitted: boolean; cliState: string | null }>;
}

export interface INotePointPort {
  /** Run `work` inside the target tab's dispatch lock; null when the tab is not found before the lock. */
  withTarget: <T>(workspaceId: string, tabId: string, work: (target: INotePointTarget) => Promise<T>) => Promise<T | null>;
}

/**
 * The inbox dispatcher's target checks (`InboxDispatcher.attempt`) with `busy` admitted and one look: an agent
 * tab, the dispatch policy, no usage-limit halt, no native prompt, a state that holds a composer, no option list
 * and an empty composer on the screen. `needs-input` and `startup-prompt` stay refused: an Enter there answers a
 * dialog. A busy tab still draws its composer, so the screen check reads it as for an idle one.
 */
export const pointerRefusal = async (
  deps: INotePointTargetDeps,
  workspaceId: string,
  tab: ITab,
  checkPolicy: TAgentDispatchPolicyCheck,
): Promise<{ code: 'tab-not-found' | 'session-not-running' | 'note-point-not-ready'; reason: string } | null> => {
  const current = await deps.findTab(workspaceId, tab.id);
  if (!current) return { code: 'tab-not-found', reason: 'target-tab-gone' };
  if (current.sessionName !== tab.sessionName) return { code: 'tab-not-found', reason: 'target-changed' };
  if (!(await deps.hasSession(current.sessionName))) return { code: 'session-not-running', reason: 'session-not-running' };
  if (!isAgentPanelType(current.panelType)) return { code: 'note-point-not-ready', reason: 'target-not-agent' };
  const policy = await checkPolicy();
  if (!policy.ok) return { code: 'note-point-not-ready', reason: `policy:${policy.error ?? 'refused'}` };
  if (deps.halted(current.id)) return { code: 'note-point-not-ready', reason: 'usage-limit-halt' };
  const status = deps.status(current.id);
  const readiness = await checkComposerReady({
    panelType: current.panelType,
    status,
    // Busy is admitted here, and only here: the line is fixed, and the screen check below still refuses text.
    waitingAtPrompt: status?.cliState === 'busy',
    capture: () => deps.capture(current.sessionName),
  });
  return readiness.ok ? null : { code: 'note-point-not-ready', reason: readiness.reason };
};

export const notePointPort = (deps: INotePointTargetDeps): INotePointPort => ({
  withTarget: async (workspaceId, tabId, work) => {
    const tab = await deps.findTab(workspaceId, tabId);
    if (!tab) return null;
    return deps.withDispatchLock(workspaceId, tab, (checkPolicy) => work({
      refusal: () => pointerRefusal(deps, workspaceId, tab, checkPolicy),
      type: async (line) => {
        const cliState = deps.status(tab.id)?.cliState ?? null;
        await deps.deliver(tab.sessionName, line);
        const pending = await deps.isPending(tab.sessionName, line).catch(() => false);
        return { submitted: !pending, cliState };
      },
    }));
  },
});

/** The server's port: the inbox dispatcher's own target dependencies, so the two paths read one tab the same way. */
export const defaultNotePointPort = async (): Promise<INotePointPort> => {
  const { defaultInboxDeps } = await import('@/lib/inbox-dispatcher');
  return notePointPort(await defaultInboxDeps());
};
