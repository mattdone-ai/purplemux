import { randomUUID } from 'crypto';
import { findTab } from '@/lib/cli-utils';
import { withAgentDispatchLock } from '@/lib/agent-dispatch-policy';
import { getStatusManager } from '@/lib/status-manager';
import { hasSession, hasSessionOrUnreachable, killSession } from '@/lib/tmux';
import { registerSessionHost } from '@/lib/session-host';
import { emitTabRestart } from '@/lib/tab-lifecycle';
import { markTabRestarted, mutateTabAtomically, restartTabSessionUnguarded } from '@/lib/layout-store';
import { getProviderByPanelType } from '@/lib/providers';
import { confirmCodexLaunch, launchAgentInTab, type TAgentLaunchResult } from '@/lib/agent-launch';
import { tabIdentityOf } from '@/lib/tab-token';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { RemoteHostError } from '@/lib/remote-host';
import { TAB_NOT_FOUND_BODY, remoteHostUnreachableBody } from '@/lib/cli-error';
import { resolveTabCliState } from '@/lib/tab-send';
import { createLogger } from '@/lib/logger';
import type { IReapResult } from '@/lib/tab-reaper';
import type { TCallerIdentity } from '@/types/identity';
import type { IRestartReaped, IRestartTabAnswer, TRestartResumeSkipped } from '@/types/tab-restart';
import type { ITab, TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

// `tab restart` (ADR-0028): a fresh agent process under the same tab id. The
// tab's processes are reaped and its session recreated without the layout
// removal and without `tab-closing`/`tab-closed`, so the tab token, leases,
// watches, probes, notes, grants, `reportsTo` and the Mission Control run
// binding stay as they are. The server builds the launch; no caller text
// reaches the session.

const log = createLogger('tab-restart');

/** Panels with no process of their own to restart (ADR-0028 §1). */
const RESTART_UNSUPPORTED: ReadonlySet<TPanelType> = new Set(['web-browser', 'diff', 'agent-sessions']);

export type TRestartActor =
  | { kind: 'agent'; workspaceId: string; tabId: string | null; identity: TCallerIdentity }
  | { kind: 'human'; actor: string }
  /** The server itself: a seat's rotation (ADR-0036). */
  | { kind: 'server'; reason: 'context-rotation' };

export interface IRestartTabInput {
  workspaceId: string;
  tabId: string;
  clear: boolean;
  interrupt: boolean;
  /**
   * Decided inside the dispatch lock when the tab is busy: true proceeds as `interrupt` (a rotation of a seat whose
   * stop waits only on watches, ADR-0036). Read after the lock is taken, so no paste lands between it and the kill.
   */
  interruptIf?: (tab: ITab) => boolean;
  by: TRestartActor;
}

export type TRestartTabResult =
  | { status: 200; body: IRestartTabAnswer }
  | { status: 400 | 404 | 409 | 500 | 503; body: { error: string; code: string } & Record<string, unknown> };

type TRestartRefusal = Extract<TRestartTabResult, { status: 400 | 404 | 409 | 500 | 503 }>;

export type TParsedRestartRequest =
  | { ok: true; workspaceId: string; tabId: string; clear: boolean; interrupt: boolean }
  | { ok: false; error: string };

/** The request both routes accept: `?workspaceId=WS` and `{clear?: boolean, interrupt?: boolean}`. */
export const parseRestartRequest = (query: Record<string, unknown>, body: unknown): TParsedRestartRequest => {
  const workspaceId = typeof query.workspaceId === 'string' ? query.workspaceId : '';
  const tabId = typeof query.tabId === 'string' ? query.tabId : '';
  if (!workspaceId) return { ok: false, error: 'workspaceId is required' };
  if (!tabId) return { ok: false, error: 'tabId is required' };
  const fields = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  for (const key of ['clear', 'interrupt'] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
  }
  return { ok: true, workspaceId, tabId, clear: fields.clear === true, interrupt: fields.interrupt === true };
};

interface IAbandonedWork {
  cliState: TCliState | null;
  launch: boolean;
  turn: boolean;
}

interface ILaunchedRestart {
  sessionName: string;
  reaped: IRestartReaped;
  abandoned: IAbandonedWork | null;
  resumeSkipped?: TRestartResumeSkipped;
  launched: TAgentLaunchResult | null;
  /** The interrupt as decided inside the lock (`interrupt`, or `interruptIf` on a busy tab). */
  interrupt: boolean;
}

/** Busy (ADR-0028 §3): the agent is mid-turn, or the tab holds a pending launch or turn. */
const busyWork = (tab: ITab): IAbandonedWork | null => {
  const cliState = resolveTabCliState(tab, getStatusManager().getTabAgentState(tab.id) ?? undefined);
  const launch = !!tab.orchestrationActivity?.launch;
  const turn = !!tab.orchestrationActivity?.turn;
  return cliState === 'busy' || launch || turn ? { cliState, launch, turn } : null;
};

/** The reap killed every tab-owned process and the session is gone; abandoned work also needs a proven reaper. */
const reapConfirmed = async (tab: ITab, reap: IReapResult, abandoned: boolean): Promise<boolean> => {
  if (reap.survivors.length > 0) return false;
  if (abandoned && reap.reaper !== 'linux' && reap.reaper !== 'remote') return false;
  if (tab.host) return reap.reaper === 'remote' && reap.sessionGone === true;
  return !(await hasSession(tab.sessionName));
};

const resumePlan = (tab: ITab, clear: boolean, cwdLost: boolean): { resumeSessionId: string | null; resumeSkipped?: TRestartResumeSkipped } => {
  const provider = getProviderByPanelType(tab.panelType);
  if (!provider) return { resumeSessionId: null };
  if (clear) return { resumeSessionId: null, resumeSkipped: 'clear' };
  // The resume path is this host's (auto-resume.ts); a remote agent restarts fresh.
  if (tab.host) return { resumeSessionId: null, resumeSkipped: 'remote' };
  // The agent's session belongs to the directory it ran in; resuming it in a parent would be another project.
  if (cwdLost) return { resumeSessionId: null, resumeSkipped: 'cwd-lost' };
  const sessionId = provider.readSessionId(tab);
  return sessionId ? { resumeSessionId: sessionId } : { resumeSessionId: null, resumeSkipped: 'no-session' };
};

const abandonPendingWork = (workspaceId: string, tabId: string) =>
  mutateTabAtomically(workspaceId, tabId, (tab) => {
    if (!tab.orchestrationActivity) return { changed: false, value: undefined };
    delete tab.orchestrationActivity;
    return { changed: true, value: undefined };
  });

/** One restart's lifecycle: `sessionName` is set once `restarting` was sent; `restartTab` sends the one end event. */
interface IRestartRun {
  restartId: string;
  sessionName: string | null;
  endPhase: 'restarted' | 'failed';
}

const restartLocked = async (request: IRestartTabInput, run: IRestartRun): Promise<ILaunchedRestart | TRestartRefusal> => {
  const { workspaceId, tabId, clear } = request;
  const found = await findTab(workspaceId, tabId);
  if (!found) return { status: 404, body: { ...TAB_NOT_FOUND_BODY } };
  const { tab, paneId } = found;
  const abandoned = busyWork(tab);
  const interrupt = request.interrupt || (abandoned !== null && request.interruptIf?.(tab) === true);
  const input: IRestartTabInput = { ...request, interrupt };
  if (abandoned && !interrupt) {
    return {
      status: 409,
      body: { error: 'the tab is mid-turn; restart it with --interrupt to abandon the turn', code: 'tab-busy', tabId, cliState: abandoned.cliState },
    };
  }
  if (tab.host) {
    registerSessionHost(tab.sessionName, tab.host);
    // Throws RemoteHostError before anything is killed (ADR-0028 §4): the caller answers 503.
    await hasSessionOrUnreachable(tab.sessionName);
  }

  emitTabRestart({ workspaceId, tabId, sessionName: tab.sessionName, restartId: run.restartId, phase: 'restarting' });
  run.sessionName = tab.sessionName;
  let reaped: IRestartReaped | null = null;
  const notConfirmed = async (error: string, outcome: 'not-confirmed' | 'failed'): Promise<TRestartRefusal> => {
    await audit(input, { outcome, reaped, abandoned, ...(outcome === 'failed' ? { error } : {}) });
    return { status: 500, body: { error, code: 'restart-not-confirmed', tabId, reaped } };
  };
  try {
    const reap = await killSession(tab.sessionName, { tabId });
    // With a tab id, killSession always answers with a reap; none means nothing proves the processes died.
    if (!reap) return await notConfirmed('no reap came back; nothing was relaunched', 'not-confirmed');
    reaped = { killed: reap.killed.length, survivors: reap.survivors.length };
    if (!(await reapConfirmed(tab, reap, abandoned !== null))) {
      return await notConfirmed('the reap left a process or the session behind; nothing was relaunched', 'not-confirmed');
    }
    if (abandoned) await abandonPendingWork(workspaceId, tabId);
    const recreated = await restartTabSessionUnguarded(workspaceId, paneId, tabId);
    if (!recreated.found) return await notConfirmed('the tab left the layout after the reap; nothing was relaunched', 'failed');
    const { resumeSessionId, resumeSkipped } = resumePlan(tab, clear, recreated.cwdLost);
    const provider = getProviderByPanelType(tab.panelType);
    const launched = provider
      ? await launchAgentInTab(
        { workspaceId, tabId, sessionName: tab.sessionName, panelType: tab.panelType, host: tab.host, agentLaunchConfig: tab.agentLaunchConfig, role: tab.role, previewOrigin: tab.previewOrigin, pgService: tab.pgService },
        { provider, resumeSessionId, targetLockHeld: true, resetAgentSession: resumeSessionId === null },
      )
      : null;
    await markTabRestarted(workspaceId, tabId, Date.now());
    return { sessionName: tab.sessionName, reaped, abandoned, ...(resumeSkipped ? { resumeSkipped } : {}), launched, interrupt };
  } catch (err) {
    // Past the kill a silent host is no longer "nothing killed": the restart is unconfirmed (ADR-0028 §4).
    if (err instanceof RemoteHostError) return notConfirmed(err.message, 'failed');
    await audit(input, { outcome: 'failed', error: err instanceof Error ? err.message : String(err), reaped, abandoned });
    throw err;
  }
};

const audit = (
  input: IRestartTabInput,
  detail: { outcome: 'restarted' | 'not-confirmed' | 'failed'; reaped?: IRestartReaped | null; abandoned: IAbandonedWork | null; resumed?: boolean; error?: string },
): Promise<boolean> => appendCoordinationAudit({
  event: 'tab-restart',
  workspaceId: input.workspaceId,
  tabId: input.tabId,
  by: input.by,
  clear: input.clear,
  interrupt: input.interrupt,
  outcome: detail.outcome,
  ...(detail.resumed !== undefined ? { resumed: detail.resumed } : {}),
  ...(detail.reaped !== undefined ? { reaped: detail.reaped } : {}),
  ...(detail.abandoned ? { abandoned: detail.abandoned } : {}),
  ...(detail.error ? { error: detail.error } : {}),
});

const isRefusal = (value: ILaunchedRestart | TRestartRefusal): value is TRestartRefusal => 'status' in value;

/** One restart for both routes: the CLI route and the cookie route call it alike. */
export const restartTab = async (input: IRestartTabInput): Promise<TRestartTabResult> => {
  const found = await findTab(input.workspaceId, input.tabId);
  if (!found) return { status: 404, body: { ...TAB_NOT_FOUND_BODY } };
  const panelType = found.tab.panelType;
  if (panelType && RESTART_UNSUPPORTED.has(panelType)) {
    return { status: 400, body: { error: `a ${panelType} tab has no process to restart`, code: 'restart-unsupported', panelType } };
  }

  const run: IRestartRun = { restartId: randomUUID(), sessionName: null, endPhase: 'failed' };
  try {
    let locked: ILaunchedRestart | TRestartRefusal;
    try {
      locked = await withAgentDispatchLock(input.workspaceId, found.tab, () => restartLocked(input, run));
    } catch (err) {
      // Only the probe before the kill lets a RemoteHostError out of restartLocked.
      if (err instanceof RemoteHostError) return { status: 503, body: remoteHostUnreachableBody(err) };
      throw err;
    }
    if (isRefusal(locked)) return locked;
    return await finishRestart(input, run, locked);
  } finally {
    // Exactly one end event per `restarting`, after the Codex confirmation (ADR-0028 §5); none for a refusal before it.
    if (run.sessionName !== null) {
      emitTabRestart({ workspaceId: input.workspaceId, tabId: input.tabId, sessionName: run.sessionName, restartId: run.restartId, phase: run.endPhase });
    }
  }
};

const finishRestart = async (input: IRestartTabInput, run: IRestartRun, locked: ILaunchedRestart): Promise<TRestartTabResult> => {
  let launchState: 'active' | 'held' | undefined;
  let resumed = false;
  try {
    if (locked.launched?.kind === 'codex') {
      let outcome = locked.launched.outcome;
      // Confirmed only now: the hook that activates the launch takes the target lock the restart held.
      if (outcome.ok && outcome.phase === 'submitted') outcome = await confirmCodexLaunch(input.workspaceId, input.tabId, outcome.generation);
      launchState = outcome.ok ? 'active' : 'held';
      resumed = locked.launched.resumed && outcome.ok;
      if (!outcome.ok) log.warn({ tabId: input.tabId, step: outcome.step, reason: outcome.reason }, 'restarted Codex launch held');
    } else if (locked.launched) {
      resumed = locked.launched.resumed;
    }
  } catch (err) {
    await audit({ ...input, interrupt: locked.interrupt }, { outcome: 'failed', error: err instanceof Error ? err.message : String(err), reaped: locked.reaped, abandoned: locked.abandoned });
    throw err;
  }
  run.endPhase = launchState === 'held' ? 'failed' : 'restarted';
  await audit({ ...input, interrupt: locked.interrupt }, { outcome: 'restarted', reaped: locked.reaped, abandoned: locked.abandoned, resumed });
  return {
    status: 200,
    body: {
      ok: true,
      workspaceId: input.workspaceId,
      tabId: input.tabId,
      resumed,
      ...(locked.resumeSkipped ? { resumeSkipped: locked.resumeSkipped } : {}),
      identity: tabIdentityOf(input.workspaceId, input.tabId),
      reaped: locked.reaped,
      ...(launchState ? { launchState } : {}),
    },
  };
};
