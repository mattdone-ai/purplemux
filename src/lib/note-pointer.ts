import { isAgentPanelType } from '@/lib/agent-panel-types';
import type { TAgentDispatchPolicyCheck } from '@/lib/agent-dispatch-policy';
import { checkComposerReady, paneAsSeen, plainPaneShowsOptionList } from '@/lib/composer-readiness';
import { COORDINATOR_WINDOW_MS } from '@/lib/coordinator-window';
import type { IClientTabStatusEntry } from '@/types/status';
import { composerHolds } from '@/lib/tmux';
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
 * PMUX-NOTE-DELIVERY: the owner-item pointer has no 10-min bound. It waits this long between ANY two pointer lines at
 * one target tab (manual or owner item, from any sender), so a flood of owner items reaches a tab one line a minute.
 */
export const OWNER_POINTER_SPACING_MS = 60_000;
/** After the line is typed, before the screen is read: the TUI draws typed text within this. */
export const POINTER_DRAW_MS = 300;
/** After an Enter, before the screen is read: a submitted line leaves the box within this. */
export const POINTER_SUBMIT_MS = 700;

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

  /** The owner-item spacing: true while a pointer line (any kind) reached the target less than `spacingMs` ago. */
  targetBusy(target: { workspaceId: string; tabId: string }, now: number, spacingMs: number = OWNER_POINTER_SPACING_MS): boolean {
    const tab = this.targets.get(`${target.workspaceId}/${target.tabId}`);
    return tab !== undefined && now - tab < spacingMs;
  }
}

/** What the pointer reads and does at the target tab; the server wires the inbox dispatcher's own dependencies. */
export interface INotePointTargetDeps {
  findTab: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  hasSession: (sessionName: string) => Promise<boolean>;
  status: (tabId: string) => IClientTabStatusEntry | undefined;
  halted: (tabId: string) => boolean;
  /** The pane with its SGR escapes; null when it cannot be read. */
  capture: (sessionName: string) => Promise<string | null>;
  withDispatchLock: <T>(workspaceId: string, tab: ITab, work: (checkPolicy: TAgentDispatchPolicyCheck) => Promise<T>) => Promise<T>;
  /** Put the line in the composer WITHOUT submitting it. */
  typeText: (sessionName: string, line: string) => Promise<void>;
  /** Press Enter once. */
  pressEnter: (sessionName: string) => Promise<void>;
  /** Runs once before the first Enter (the orchestration submission record). */
  beforeSubmit?: (sessionName: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * What became of a typed line. `submitted`: an Enter took the line out of the box. `stranded`: it is still in the box
 * after the one extra Enter. `unverified`: no Enter was pressed, or the screen after it could not be read or showed a
 * dialog, so the line may sit in the composer. `not-clean`: the box held other text beside the line (a person typed
 * before, after or inside it), so no Enter was pressed and nothing was cleared; the note stays armed. Only
 * `submitted` is a composer receipt.
 */
export type TPointerTyped = 'submitted' | 'stranded' | 'unverified' | 'not-clean';

export interface IPointerTypeResult {
  outcome: TPointerTyped;
  cliState: string | null;
  /** Why the outcome is not `submitted`: `line-not-in-composer`, `dialog`, `capture-failed`, `composer-not-clean`. */
  detail?: string;
}

/** Inside the target's dispatch lock: the checks, then the typing. */
export interface INotePointTarget {
  /** Null when the target can take a line now; else the reason (nothing is typed). */
  refusal: () => Promise<{ code: 'tab-not-found' | 'session-not-running' | 'note-point-not-ready'; reason: string } | null>;
  /** Type the line and submit it only when the screen shows it whole in the box and no dialog. */
  type: (line: string) => Promise<IPointerTypeResult>;
}

export interface INotePointPort {
  /** Run `work` inside the target tab's dispatch lock; null when the tab is not found before the lock. */
  withTarget: <T>(workspaceId: string, tabId: string, work: (target: INotePointTarget) => Promise<T>) => Promise<T | null>;
}

/**
 * The inbox dispatcher's target checks (`InboxDispatcher.attempt`) with `busy` admitted and one look: an agent
 * tab, the dispatch policy, no usage-limit halt, no native prompt, a state that holds a composer, no option list
 * and an empty composer on the screen. `needs-input` and `startup-prompt` stay refused: an Enter there answers a
 * dialog. A busy tab still draws its composer, so the screen check reads it as for an idle one. Busy is admitted
 * for Claude Code only: its mid-turn Enter queues the line, measured on 2.1.322
 * (`tests/fixtures/panes/claude-busy-line-queued.ansi`); no other TUI's mid-turn Enter is measured.
 */
export const pointerRefusal = async (
  deps: Pick<INotePointTargetDeps, 'findTab' | 'hasSession' | 'status' | 'halted' | 'capture'>,
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
    waitingAtPrompt: status?.cliState === 'busy' && current.panelType === 'claude-code',
    capture: () => deps.capture(current.sessionName),
  });
  return readiness.ok ? null : { code: 'note-point-not-ready', reason: readiness.reason };
};

type TLook = 'line' | 'dirty' | 'other' | 'gone' | 'dialog' | 'unreadable';

/**
 * One read of the target after typing: the box holds exactly the line (`line`), the line with other text (`dirty`),
 * other text without the whole line (`other`), nothing or an unreadable box (`gone`); or the line sits under a dialog
 * (`dialog`: a native permission request or an option list); or the screen cannot be read (`unreadable`).
 */
const look = async (deps: INotePointTargetDeps, tab: ITab, line: string): Promise<TLook> => {
  const pane = await deps.capture(tab.sessionName).catch(() => null);
  if (!pane) return 'unreadable';
  const plain = paneAsSeen(tab.panelType, pane);
  const holds = composerHolds(plain, line);
  if (holds === 'empty' || holds === 'unknown') return 'gone';
  if (holds === 'other-text') return 'other';
  if (deps.status(tab.id)?.permissionRequest || plainPaneShowsOptionList(plain)) return 'dialog';
  return holds === 'exact' ? 'line' : 'dirty';
};

/**
 * Type the line, then submit it only when a capture shows the box holding exactly that line, with no dialog: a
 * mid-turn agent can raise a permission prompt at any moment, and an Enter would answer it; a person may type in the
 * box, and an Enter would submit their draft with the line. At most one more Enter, after a fresh capture. An
 * unreadable capture is never a receipt. Other text in the box is never cleared.
 */
export const typeGuarded = async (deps: INotePointTargetDeps, tab: ITab, line: string): Promise<IPointerTypeResult> => {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const cliState = deps.status(tab.id)?.cliState ?? null;
  const unverified = (seen: TLook): IPointerTypeResult => ({
    outcome: 'unverified',
    cliState,
    detail: seen === 'gone' ? 'line-not-in-composer' : seen === 'dialog' ? 'dialog' : 'capture-failed',
  });
  const notClean: IPointerTypeResult = { outcome: 'not-clean', cliState, detail: 'composer-not-clean' };
  await deps.typeText(tab.sessionName, line);
  await sleep(POINTER_DRAW_MS);
  const typed = await look(deps, tab, line);
  if (typed === 'dirty' || typed === 'other') return notClean;
  if (typed !== 'line') return unverified(typed);
  await deps.beforeSubmit?.(tab.sessionName);
  for (let press = 0; press < 2; press += 1) {
    await deps.pressEnter(tab.sessionName);
    await sleep(POINTER_SUBMIT_MS);
    const after = await look(deps, tab, line);
    // The line left the box: submitted, whatever a person typed in the box since.
    if (after === 'gone' || after === 'other') return { outcome: 'submitted', cliState };
    if (after === 'dirty') return notClean;
    if (after !== 'line') return unverified(after);
  }
  return { outcome: 'stranded', cliState, detail: 'line-in-composer' };
};

export const notePointPort = (deps: INotePointTargetDeps): INotePointPort => ({
  withTarget: async (workspaceId, tabId, work) => {
    const tab = await deps.findTab(workspaceId, tabId);
    if (!tab) return null;
    return deps.withDispatchLock(workspaceId, tab, (checkPolicy) => work({
      refusal: () => pointerRefusal(deps, workspaceId, tab, checkPolicy),
      type: (line) => typeGuarded(deps, tab, line),
    }));
  },
});

/** The server's port: the inbox dispatcher's own target dependencies, so the two paths read one tab the same way. */
export const defaultNotePointPort = async (): Promise<INotePointPort> => {
  const [{ defaultInboxDeps }, { deliverPromptText }, { pressEnter }, { recordOrchestrationSubmission }] = await Promise.all([
    import('@/lib/inbox-dispatcher'),
    import('@/lib/agent-prompt-delivery'),
    import('@/lib/tmux'),
    import('@/lib/orchestration-activity'),
  ]);
  const inbox = await defaultInboxDeps();
  return notePointPort({
    findTab: inbox.findTab,
    hasSession: inbox.hasSession,
    status: inbox.status,
    halted: inbox.halted,
    capture: inbox.capture,
    withDispatchLock: inbox.withDispatchLock,
    typeText: (sessionName, line) => deliverPromptText(sessionName, line),
    pressEnter,
    beforeSubmit: (sessionName) => recordOrchestrationSubmission(sessionName),
  });
};
