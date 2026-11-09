import { isAgentPanelType } from '@/lib/agent-panel-types';
import type { TComposerScreen, TComposerScreenRefusal } from '@/lib/composer-readiness';
import type { ITab, TPanelType } from '@/types/terminal';
import type { TCliState, TStartupPrompt } from '@/types/timeline';

/**
 * A prompt is pasted into a TUI composer, not streamed, so the ceiling is about
 * what tmux and the agent can swallow in one paste rather than about storage.
 * 64 KB is far above any real prompt and well below the point where `send-keys`
 * starts to matter.
 */
export const MAX_SEND_CONTENT_BYTES = 64 * 1024;

/**
 * The states in which an agent is known to hold an empty composer.
 *
 * A readiness signal, NOT a permission to send. Only the `composer-ready` gate
 * consults it — see {@link TSendGate}.
 */
const COMPOSER_READY_STATES: ReadonlySet<TCliState> = new Set<TCliState>([
  'idle',
  'ready-for-review',
  'needs-input',
]);

export const isComposerReadyCliState = (state: TCliState | null | undefined): boolean =>
  state != null && COMPOSER_READY_STATES.has(state);

/**
 * Which question a send asks before it pastes. The two callers want different
 * answers, and conflating them is what stopped the phone talking to a busy
 * agent — the one tab a person standing outside the house most wants to reach.
 *
 * - `live-session` — "is there something on the other end?". A tab whose tmux
 *   session runs is delivered to, in every `cliState` including `busy`. This is
 *   what the web client has always done: `POST /api/tmux/send-input` reads no
 *   `cliState` at all, and an agent TUI queues a prompt that arrives mid-turn.
 *   Every client driven by a person typing belongs on this gate.
 *
 * - `composer-ready` — "is there an empty composer to paste into?". Holds until
 *   the agent reports a composer, and at the deadline refuses with nothing
 *   pasted. This is story 22's gate and it must stay: a brief dispatched by
 *   `purplemux tab send` the instant a tab is created races the TUI's boot, and
 *   a paste that wins that race has its trailing Enter swallowed — the text
 *   sits in the input box, the agent never takes a turn, and the caller is told
 *   `submitted: true`. It cost fifty minutes of an epic once.
 *
 * The distinction is boot-race versus mid-turn, not caution versus recklessness.
 * A person watching the screen sees a swallowed Enter and presses it; an
 * unattended orchestrator dispatching a brief does not, which is why only that
 * path waits.
 */
export type TSendGate = 'live-session' | 'composer-ready';

/**
 * The live StatusManager entry is the truth; the layout copy is a persisted
 * echo that survives a restart and can lag a transition.
 */
export const resolveTabCliState = (
  tab: ITab,
  live: { cliState?: TCliState | null } | undefined,
): TCliState | null => live?.cliState ?? tab.cliState ?? null;

export interface ITabSendRequest {
  workspaceId: string;
  tabId: string;
  content: string;
  submit: boolean;
  submitOnly?: boolean;
  literalPaste?: boolean;
  expectedSessionName?: string;
}

export type TTabSendParseResult =
  | { ok: true; request: ITabSendRequest }
  | { ok: false; error: 'bad-request' };

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

export const parseSendRequest = (
  query: Partial<Record<string, string | string[]>>,
  body: unknown,
): TTabSendParseResult => {
  const tabId = single(query.tabId);
  const workspaceId = single(query.workspaceId);
  if (!tabId || !workspaceId) return { ok: false, error: 'bad-request' };

  if (typeof body !== 'object' || body === null) return { ok: false, error: 'bad-request' };
  const { content, submit, submitOnly, literalPaste, expectedSessionName } = body as { content?: unknown; submit?: unknown; submitOnly?: unknown; literalPaste?: unknown; expectedSessionName?: unknown };

  if (typeof content !== 'string' || content.trim() === '' && submitOnly !== true) return { ok: false, error: 'bad-request' };
  if (Buffer.byteLength(content, 'utf-8') > MAX_SEND_CONTENT_BYTES) return { ok: false, error: 'bad-request' };
  if (submit !== undefined && typeof submit !== 'boolean') return { ok: false, error: 'bad-request' };

  if (submitOnly !== undefined && typeof submitOnly !== 'boolean' || literalPaste !== undefined && typeof literalPaste !== 'boolean') return { ok: false, error: 'bad-request' };
  if (submitOnly && (content !== '' || submit === false) || literalPaste && submit !== false) return { ok: false, error: 'bad-request' };
  if (expectedSessionName !== undefined && (typeof expectedSessionName !== 'string' || !expectedSessionName)) return { ok: false, error: 'bad-request' };
  return { ok: true, request: { workspaceId, tabId, content, submit: submit ?? true,
    ...(submitOnly ? { submitOnly: true } : {}), ...(literalPaste ? { literalPaste: true } : {}),
    ...(typeof expectedSessionName === 'string' ? { expectedSessionName } : {}),
  } };
};

export interface ITabSendTarget {
  sessionName: string;
  cliState: TCliState | null;
  panelType?: TPanelType;
  /**
   * `busy` only because its ended turn waits on background work (ADR-0018):
   * the composer is empty, so the `composer-ready` gate accepts it.
   */
  waitingAtPrompt?: boolean;
  /** The startup dialog a `startup-prompt` tab waits at (D14); absent in every other state. */
  startupPrompt?: TStartupPrompt | null;
  /** The ssh alias of a remote tab's host (ADR-0022); absent for a local tab. */
  host?: string;
}

/**
 * How long a send waits for a booting agent before giving up. A cold agent TUI
 * needs tens of seconds to reach a composer — trust prompt, MCP servers, hooks
 * — and a caller that dispatches a brief the moment it creates the tab is the
 * common case, not the exception.
 */
export const DEFAULT_SEND_READY_TIMEOUT_MS = 60_000;

export const MAX_SEND_READY_TIMEOUT_MS = 600_000;

export const SEND_READY_POLL_INTERVAL_MS = 500;

export const resolveSendWaitMs = (raw: unknown): number | null => {
  if (raw === undefined) return DEFAULT_SEND_READY_TIMEOUT_MS;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 0 || raw > MAX_SEND_READY_TIMEOUT_MS) return null;
  return raw;
};

export interface ISendReadinessDeps {
  findTarget: (workspaceId: string, tabId: string) => Promise<ITabSendTarget | null>;
  hasSession: (sessionName: string) => Promise<boolean>;
  /**
   * The screen half of the `composer-ready` gate (vel-RETRO-R3). Absent: the gate reads `cliState` only, as the
   * phone route and older callers do.
   */
  readScreen?: (target: ITabSendTarget) => Promise<TComposerScreen>;
  /** A remote host's ssh budget (`remote.timeout-ms`, vel-D61). Absent: the default budget. */
  remoteTimeoutMs?: (host: string) => Promise<number>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ISendReadinessRequest {
  workspaceId: string;
  tabId: string;

  /** Ignored on the `live-session` gate, which never has anything to wait for. */
  timeoutMs: number;

  gate: TSendGate;
}

export type TSendReadiness =
  /** `screenEmpty`: the gate read an empty composer on the screen just before it answered. */
  | { ok: true; target: ITabSendTarget; screenEmpty: boolean }
  | { ok: false; reason: 'tab-not-found' }
  | { ok: false; reason: 'session-not-running'; cliState: TCliState | null }
  | { ok: false; reason: 'readiness-timeout'; cliState: TCliState | null; waitedMs: number; screen?: TComposerScreenRefusal }
  | { ok: false; reason: 'startup-prompt'; cliState: TCliState | null; startupPrompt: TStartupPrompt | null };

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The states whose screen the `composer-ready` gate reads, the ones Mission Control screens
 * (`checkComposerReady`). A fresh Claude tab turns `idle` on its SessionStart hook, which can fire before the TUI
 * takes keys (vel-RETRO-R3). `needs-input` stays status-only (ADR-0007): its option list is what a send answers.
 */
const screensComposer = (target: ITabSendTarget): boolean =>
  target.cliState === 'idle' || target.cliState === 'ready-for-review'
  || (target.cliState === 'busy' && target.waitingAtPrompt === true);

/** The ssh budget of one remote tmux call when `remote.timeout-ms` is unset (ADR-0022 §5). */
export const REMOTE_CALL_DEFAULT_MS = 5_000;

/**
 * The gate's deadline once it reads a remote screen (review r1 F2). One capture is one ssh call that may run the
 * host's whole budget and then fail, so the wait leaves room for a second capture after it: at least two budgets.
 * The caller's longer wait stands, `timeoutMs: 0` stays one look, and the largest budget (120 s) gives 240 s, the
 * CLI's own cap.
 */
const remoteScreenDeadlineMs = async (deps: ISendReadinessDeps, host: string, timeoutMs: number): Promise<number> => {
  if (timeoutMs === 0) return 0;
  const budget = deps.remoteTimeoutMs
    ? await deps.remoteTimeoutMs(host).catch(() => REMOTE_CALL_DEFAULT_MS)
    : REMOTE_CALL_DEFAULT_MS;
  return Math.max(timeoutMs, 2 * Math.max(REMOTE_CALL_DEFAULT_MS, budget));
};

/**
 * Resolve a tab and decide whether it can be pasted into, per {@link TSendGate}.
 *
 * Both gates refuse a tab that is gone and a tmux session that is not running —
 * that is not policy, it is the absence of a recipient. Only `composer-ready`
 * goes on to wait for a composer, and only it can time out.
 *
 * The state is re-resolved on every poll rather than once up front, so a tab
 * that is closed or whose session dies mid-wait is reported as such instead of
 * being pasted into at the deadline.
 *
 * `timeoutMs: 0` is a plain "answer now": one look, no sleep.
 */
export const awaitSendReadiness = async (
  deps: ISendReadinessDeps,
  request: ISendReadinessRequest,
): Promise<TSendReadiness> => {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const startedAt = now();
  let screen: TComposerScreenRefusal | undefined;
  let deadlineMs = request.timeoutMs;
  let remoteDeadlineSet = false;

  for (;;) {
    screen = undefined;
    const target = await deps.findTarget(request.workspaceId, request.tabId);
    if (!target) return { ok: false, reason: 'tab-not-found' };

    // Checked before the composer gate: a dead session never reaches a sendable
    // state, so waiting one out would trade an immediate diagnosis for a
    // deadline's worth of silence.
    if (!(await deps.hasSession(target.sessionName))) {
      return { ok: false, reason: 'session-not-running', cliState: target.cliState };
    }

    // A live session is the whole bar on the `live-session` gate. Past it, the
    // composer check guards an agent composer only: a terminal pane has no turn
    // to accept and no cliState to report.
    if (request.gate === 'live-session' || !isAgentPanelType(target.panelType)) {
      return { ok: true, target, screenEmpty: false };
    }
    if (isComposerReadyCliState(target.cliState) || target.waitingAtPrompt === true) {
      if (!deps.readScreen || !screensComposer(target)) return { ok: true, target, screenEmpty: false };
      if (target.host && !remoteDeadlineSet) {
        remoteDeadlineSet = true;
        deadlineMs = await remoteScreenDeadlineMs(deps, target.host, request.timeoutMs);
      }
      // A failed or slow capture is one reading, never the answer: the gate reads again until the deadline.
      const read = await deps.readScreen(target).catch((): TComposerScreen => ({ ok: false, reason: 'composer-unreadable' }));
      if (read.ok) return { ok: true, target, screenEmpty: true };
      screen = read.reason;
    }

    // A startup dialog (folder trust, external imports) never clears on its own: a wait would trade an
    // immediate diagnosis for a deadline's worth of silence, and a paste would answer the dialog (D14).
    if (target.cliState === 'startup-prompt') {
      return { ok: false, reason: 'startup-prompt', cliState: target.cliState, startupPrompt: target.startupPrompt ?? null };
    }

    const waitedMs = now() - startedAt;
    const remainingMs = deadlineMs - waitedMs;
    if (remainingMs <= 0) {
      return { ok: false, reason: 'readiness-timeout', cliState: target.cliState, waitedMs, ...(screen ? { screen } : {}) };
    }
    await sleep(Math.min(SEND_READY_POLL_INTERVAL_MS, remainingMs));
  }
};

export interface ITabSendDeps extends ISendReadinessDeps {
  paste: (sessionName: string, content: string) => Promise<void>;
  pasteWithoutSubmit: (sessionName: string, content: string) => Promise<void>;
  isContentPendingInComposer: (sessionName: string, content: string) => Promise<boolean>;
}

export type TTabSendResult =
  | { status: 200; body: { status: 'sent'; submitted: boolean; cliState: TCliState | null } }
  | { status: 404; body: { error: 'tab-not-found' } }
  | {
      status: 409;
      body: { error: 'agent-not-ready'; cliState: TCliState | null; detail: 'session-not-running' };
    };

/**
 * The send behind `POST /api/tabs/[tabId]/send` — the cookie-authed route the
 * phone uses.
 *
 * On the `live-session` gate, so the phone is a peer of the web client rather
 * than a viewer of it: both can talk to the same tab at the same time, in any
 * state, which is the entire reason the phone app exists. The only refusal left
 * is a tab with no running tmux session, and that one is honest — there is
 * nothing on the other end to queue the prompt.
 *
 * `busy` therefore pastes. Whether the agent swallowed the Enter is a question
 * the response answers separately, in `submitted`.
 */
export const performTabSend = async (
  deps: ITabSendDeps,
  request: ITabSendRequest,
): Promise<TTabSendResult> => {
  // Nothing to wait for on this gate, so the route never holds a phone's tap
  // open.
  const readiness = await awaitSendReadiness(deps, {
    workspaceId: request.workspaceId,
    tabId: request.tabId,
    timeoutMs: 0,
    gate: 'live-session',
  });

  if (!readiness.ok) {
    if (readiness.reason === 'tab-not-found') return { status: 404, body: { error: 'tab-not-found' } };
    // `readiness-timeout` and `startup-prompt` cannot occur on this gate: it
    // has no composer check, so a refusal here is always a dead session.
    return {
      status: 409,
      body: { error: 'agent-not-ready', cliState: readiness.cliState, detail: 'session-not-running' },
    };
  }

  const target = readiness.target;

  if (!request.submit) {
    await deps.pasteWithoutSubmit(target.sessionName, request.content);
    return { status: 200, body: { status: 'sent', submitted: false, cliState: target.cliState } };
  }

  await deps.paste(target.sessionName, request.content);

  // Report delivery, not just dispatch: an agent that is mid-turn can swallow
  // the Enter, leaving the text in the composer for somebody else's keystroke
  // to submit. Best-effort and never fatal — the paste DID happen either way,
  // so a failed probe reads as submitted rather than as an error.
  const pending = await deps
    .isContentPendingInComposer(target.sessionName, request.content)
    .catch(() => false);

  return { status: 200, body: { status: 'sent', submitted: !pending, cliState: target.cliState } };
};
