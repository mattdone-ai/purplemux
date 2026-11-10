import { isAgentPanelType } from '@/lib/agent-panel-types';
import { checkComposerReady } from '@/lib/composer-readiness';
import { type CoordinatorWindow, WINDOW_DEFERRAL, WINDOW_EXEMPT_INBOX_KINDS, getCoordinatorWindow } from '@/lib/coordinator-window';
import {
  deferInState,
  deliverInState,
  dropForTabInState,
  dropGoneTargetsInState,
  dueItems,
  holdInState,
  mutateInbox,
  refuseInState,
  sweepInState,
  windowHeads,
  withdrawInState,
} from '@/lib/inbox-store';
import { createLogger } from '@/lib/logger';
import { classifyWake } from '@/lib/wake-class';
import type { TAgentDispatchPolicyCheck } from '@/lib/agent-dispatch-policy';
import type { IInboxItem, IInboxState, TInboxKind } from '@/types/inbox';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

const log = createLogger('inbox');

export const INBOX_TICK_MS = 2_000;
/** The longest the first tick waits for `firstTickAfter` (the boot drain of the hook spool, ADR-0020). */
export const INBOX_FIRST_TICK_MAX_WAIT_MS = 10_000;

/**
 * A kind's owner re-validates its own record at paste time (story 12, consult ruling A′): called inside
 * the dispatch lock, after the readiness gate and the still-queued check, immediately before the paste.
 * `ok: false` drops the item (`preflight:<reason>`); an `ok` answer may have claimed the owner's record
 * for this paste, so the delivery that follows is the only one it allows. In memory only: a callback
 * cannot be persisted, and the owner registers it again when its runtime starts.
 */
export type TInboxPreflight = (item: IInboxItem) => Promise<
  | { ok: true; settle?: () => void | Promise<void> }
  | { ok: false; reason: string }
>;

/** Kinds whose items may not be typed without their owner's preflight. */
const PREFLIGHT_KINDS: ReadonlySet<TInboxKind> = new Set<TInboxKind>(['mission', 'note']);

const gp = globalThis as unknown as { __ptInboxPreflights?: Map<TInboxKind, TInboxPreflight> };
const preflights = (): Map<TInboxKind, TInboxPreflight> => (gp.__ptInboxPreflights ??= new Map());

/** Register a kind's preflight; returns the unregister function. */
export const registerInboxPreflight = (kind: TInboxKind, fn: TInboxPreflight): (() => void) => {
  preflights().set(kind, fn);
  return () => {
    if (preflights().get(kind) === fn) preflights().delete(kind);
  };
};

export interface IInboxDispatcherDeps {
  now: () => number;
  mutate: <T>(fn: (state: IInboxState) => { state: IInboxState; value: T }) => Promise<T>;
  findTab: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  /**
   * The tab is positively gone: the workspace list and its layout were read and
   * do not name it. An unreadable store is NOT a close (it would drop for good).
   * Null when it cannot be told.
   */
  tabGone: (workspaceId: string, tabId: string) => Promise<boolean | null>;
  hasSession: (sessionName: string) => Promise<boolean>;
  status: (tabId: string) => IClientTabStatusEntry | undefined;
  /** ADR-0018 ruling A′: busy only because its ended turn waits on background work. */
  waitingAtPrompt: (tabId: string) => boolean;
  /** Halted by a usage limit: never typed into — typing cancels the provider's auto-continue (story 26). */
  halted: (tabId: string) => boolean;
  capture: (sessionName: string) => Promise<string | null>;
  withDispatchLock: <T>(workspaceId: string, tab: ITab, work: (checkPolicy: TAgentDispatchPolicyCheck) => Promise<T>) => Promise<T>;
  deliver: (sessionName: string, line: string) => Promise<void>;
  /** The pasted line still sits in the composer (the Enter was swallowed). */
  isPending: (sessionName: string, line: string) => Promise<boolean>;
  /** Write a delivered notice to the tab's durable event log (ADR-0035); a failure never undoes the delivery. */
  recordDelivered?: (item: IInboxItem) => void;
  /** F6 change 3: the coordinator window shared with the digest router; absent or null, nothing is deferred. */
  window?: () => CoordinatorWindow | null;
}

type TAttempt = (
  | { outcome: 'delivered' }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'held'; reason: string }
  | { outcome: 'dropped'; reason: string }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'withdrawn' }
  | { outcome: 'deferred'; until: number; reason: string }
) & { settle?: () => void | Promise<void> };

/** A coordinator's window takes the next turn of the digest this long after the digest went first. */
const DIGEST_FIRST_RETRY_MS = 10_000;

const STATE_REFUSAL = 'composer-not-ready:';

/**
 * Delivers queued notices (ADR-0012): per target tab, one at a time, oldest
 * first, only into an agent whose composer is ready and empty. A refusal backs
 * off; a tab whose state refused and that has since become ready is retried on
 * the next tick instead of after its full backoff. A paste that throws is held
 * as `transport-uncertain` and never retried blind.
 */
export class InboxDispatcher {
  private running: Promise<void> | null = null;

  constructor(private deps: IInboxDispatcherDeps) {}

  private isReadyState(tabId: string): boolean {
    const status = this.deps.status(tabId);
    if (!status) return false;
    return status.cliState === 'idle' || status.cliState === 'ready-for-review'
      || (status.cliState === 'busy' && this.deps.waitingAtPrompt(tabId));
  }

  /**
   * Early wake: the tab is ready now, and either the last refusal was its state or (for a held
   * item) a turn ended after the last attempt — a sent turn also clears the composer.
   */
  private wake = (item: IInboxItem): boolean => {
    if (!this.isReadyState(item.targetTabId)) return false;
    if ((item.lastRefusal ?? '').startsWith(STATE_REFUSAL)) return true;
    const turnEndAt = this.deps.status(item.targetTabId)?.turnEnd?.at;
    return item.state === 'held' && typeof turnEndAt === 'number' && turnEndAt > (item.lastAttemptAt ?? 0);
  };

  async tick(): Promise<void> {
    if (this.running) return;
    const run = (async () => {
      const now = this.deps.now();
      const due = await this.deps.mutate((state) => {
        const swept = sweepInState(state, now);
        // The router reads which tab's inbox item has waited longer than its digest (F6 ruling, change 3).
        this.deps.window?.()?.setInboxHeads(windowHeads(swept, now));
        return { state: swept, value: dueItems(swept, now, this.wake) };
      });
      for (const item of due) await this.attemptAndRecord(item);
    })();
    this.running = run;
    try {
      await run;
    } finally {
      this.running = null;
    }
  }

  /** Resolves once a tick in flight has recorded its outcome (shutdown waits on it). */
  async idle(): Promise<void> {
    await this.running?.catch(() => {});
  }

  /**
   * Boot pass: tabs that closed while the server was down fired their
   * tab-closed events before anyone listened. Drop the queued and held items of
   * every target the live layouts positively no longer name.
   */
  async dropGoneTargets(isGone: (workspaceId: string, tabId: string) => boolean): Promise<IInboxItem[]> {
    const now = this.deps.now();
    return this.deps.mutate((state) => {
      const result = dropGoneTargetsInState(state, isGone, now);
      return { state: result.state, value: result.dropped };
    });
  }

  private async attemptAndRecord(item: IInboxItem): Promise<void> {
    let attempt: TAttempt;
    try {
      attempt = await this.attempt(item);
    } catch (err) {
      attempt = { outcome: 'refused', reason: `dispatch-error:${err instanceof Error ? err.message : String(err)}` };
    }
    const now = this.deps.now();
    try {
      await this.deps.mutate((state) => {
        switch (attempt.outcome) {
          case 'delivered': return { state: deliverInState(state, item.id, now), value: null };
          case 'held': return { state: holdInState(state, item.id, attempt.reason, now), value: null };
          case 'dropped': return { state: dropForTabInState(state, item.targetWorkspaceId, item.targetTabId, attempt.reason, now).state, value: null };
          case 'refused': return { state: refuseInState(state, item.id, attempt.reason, now), value: null };
          // This item only: its owner refused it at paste time.
          case 'rejected': return { state: withdrawInState(state, item.id, attempt.reason, now), value: null };
          case 'withdrawn': return { state, value: null };
          case 'deferred': return { state: deferInState(state, item.id, attempt.until, attempt.reason, now), value: null };
        }
      });
    } finally {
      // A successful owner preflight may hold its lifecycle lock until the inbox outcome is durable.
      // This makes terminal owner transitions serialize with both the paste and its receipt.
      await attempt.settle?.();
    }
    if (attempt.outcome === 'delivered') {
      log.info({ id: item.id, kind: item.kind, tabId: item.targetTabId }, 'inbox delivered');
      try {
        this.deps.recordDelivered?.(item);
      } catch (err) {
        log.warn(`inbox delivery of ${item.id} not recorded: ${err instanceof Error ? err.message : err}`);
      }
    }
    else if (attempt.outcome !== 'refused' && attempt.outcome !== 'withdrawn' && attempt.outcome !== 'deferred') log.info({ id: item.id, tabId: item.targetTabId, ...attempt }, `inbox ${attempt.outcome}`);
  }

  private async missing(item: IInboxItem): Promise<TAttempt> {
    const gone = await this.deps.tabGone(item.targetWorkspaceId, item.targetTabId).catch(() => null);
    return gone === true
      ? { outcome: 'dropped', reason: 'target-tab-closed' }
      : { outcome: 'refused', reason: 'target-unresolved' };
  }

  private async attempt(item: IInboxItem): Promise<TAttempt> {
    const found = await this.deps.findTab(item.targetWorkspaceId, item.targetTabId);
    if (!found) return this.missing(item);
    if (!isAgentPanelType(found.panelType)) return { outcome: 'held', reason: 'target-not-agent' };
    if (!(await this.deps.hasSession(found.sessionName))) return { outcome: 'refused', reason: 'session-not-running' };

    let settle: (() => void | Promise<void>) | undefined;
    let result: TAttempt;
    try {
      result = await this.deps.withDispatchLock<TAttempt>(item.targetWorkspaceId, found, async (checkPolicy) => {
        const current = await this.deps.findTab(item.targetWorkspaceId, item.targetTabId);
        if (!current) return this.missing(item);
        if (current.sessionName !== found.sessionName) return { outcome: 'refused', reason: 'target-changed' };
        const policy = await checkPolicy();
        if (!policy.ok) return { outcome: 'refused', reason: `policy:${policy.error ?? 'refused'}` };
        if (this.deps.halted(item.targetTabId)) return { outcome: 'refused', reason: 'usage-limit-halt' };
        const readiness = await checkComposerReady({
          panelType: current.panelType,
          status: this.deps.status(item.targetTabId),
          waitingAtPrompt: this.deps.waitingAtPrompt(item.targetTabId),
          capture: () => this.deps.capture(current.sessionName),
        });
        if (!readiness.ok) return { outcome: 'refused', reason: readiness.reason };
        // F6 change 3: a coordinator's window, after readiness and before the still-queued check and the preflight, so
        // a deferral claims nothing (a mission row, a note lock) and spends no refusal budget (design ruling, change 2).
        const window = await this.governingWindow(item);
        if (window) {
          const now = this.deps.now();
          const openAt = window.openAt(item.targetWorkspaceId, item.targetTabId);
          if (now < openAt) return { outcome: 'deferred', until: openAt, reason: `${WINDOW_DEFERRAL}${Math.ceil((openAt - now) / 1000)}s` };
          if (!window.inboxTurn(item.targetWorkspaceId, item.targetTabId, item.createdAt)) {
            return { outcome: 'deferred', until: now + DIGEST_FIRST_RETRY_MS, reason: `${WINDOW_DEFERRAL}digest-first` };
          }
        }
        // Its owner may have withdrawn it since this tick picked it (a closed episode).
        const stillWaiting = await this.deps.mutate((state) => ({
          state,
          value: state.items.find((i) => i.id === item.id)?.state === item.state,
        }));
        if (!stillWaiting) return { outcome: 'withdrawn' };
        if (PREFLIGHT_KINDS.has(item.kind)) {
          const preflight = preflights().get(item.kind);
          // No owner listening yet (a boot before its runtime started): wait, within the bound.
          if (!preflight) return { outcome: 'refused', reason: 'preflight-unregistered' };
          let verdict: Awaited<ReturnType<TInboxPreflight>>;
          try {
            verdict = await preflight(item);
          } catch (err) {
            return { outcome: 'refused', reason: `preflight-error:${err instanceof Error ? err.message : String(err)}` };
          }
          if (!verdict.ok) return { outcome: 'rejected', reason: `preflight:${verdict.reason}` };
          settle = verdict.settle;
        }
        try {
          await this.deps.deliver(current.sessionName, item.line);
        } catch (err) {
          return { outcome: 'held', reason: `transport-uncertain:${err instanceof Error ? err.message : String(err)}` };
        }
        // Typed: the coordinator's next window counts from now, inside the lock the digest also takes.
        window?.claim(item.targetWorkspaceId, item.targetTabId);
        // No caller reads `submitted` here, so a stranded paste is held, never retried blind.
        const pending = await this.deps.isPending(current.sessionName, item.line).catch(() => false);
        return pending ? { outcome: 'held', reason: 'stranded-in-composer' } : { outcome: 'delivered' };
      });
    } catch (err) {
      result = { outcome: 'refused', reason: `dispatch-error:${err instanceof Error ? err.message : String(err)}` };
    }
    return settle ? { ...result, settle } : result;
  }

  /** The window that governs this item's target: a coordinator, and a kind that does not skip it. */
  private async governingWindow(item: IInboxItem): Promise<CoordinatorWindow | null> {
    if (WINDOW_EXEMPT_INBOX_KINDS.has(item.kind)) return null;
    const window = this.deps.window?.() ?? null;
    if (!window) return null;
    return (await window.governs(item.targetWorkspaceId, item.targetTabId)) ? window : null;
  }

  /** `tab-closed`: the tab's queued and held notices are dropped; their owners re-route them. */
  async dropForTab(workspaceId: string, tabId: string): Promise<IInboxItem[]> {
    const now = this.deps.now();
    return this.deps.mutate((state) => {
      const result = dropForTabInState(state, workspaceId, tabId, 'target-tab-closed', now);
      return { state: result.dropped.length ? result.state : state, value: result.dropped };
    });
  }
}

// ─── the server's instance ───────────────────────────────────────────────

interface IInboxRuntime {
  dispatcher: InboxDispatcher | null;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
}

/** Positive absence from a strict read: unreadable stores and layouts answer null. */
const liveTabsGone = async () => {
  const { readLiveTabs } = await import('@/lib/tab-lifecycle');
  const snapshot = await readLiveTabs();
  const live = new Set(snapshot.tabs.map((t) => `${t.workspaceId}/${t.tabId}`));
  return (workspaceId: string, tabId: string): boolean | null =>
    snapshot.uncertainWorkspaceIds.has(workspaceId) ? null : !live.has(`${workspaceId}/${tabId}`);
};

const g = globalThis as unknown as { __ptInboxRuntime?: IInboxRuntime };

/** The server's dispatcher dependencies (exported for the wiring test). */
export const defaultInboxDeps = async (): Promise<IInboxDispatcherDeps> => {
  const [{ readLayoutFile, resolveLayoutFile, collectAllTabs }, { hasSession, isContentPendingInComposer }, { getStatusManager }, { capturePaneAtWidth }, { withAgentDispatchLock }, { deliverPrompt }, { getLedgerStore }, { appendDelivered }] = await Promise.all([
    import('@/lib/layout-store'),
    import('@/lib/tmux'),
    import('@/lib/status-manager'),
    import('@/lib/capture-at-width'),
    import('@/lib/agent-dispatch-policy'),
    import('@/lib/agent-prompt-delivery'),
    import('@/lib/ledger-store'),
    import('@/lib/tab-event-router'),
  ]);
  return {
    now: () => Date.now(),
    mutate: mutateInbox,
    // A read that never writes: `getLayout` replaces an unreadable layout with a
    // default one, which fires a close for every tab. An unreadable layout here
    // is just "not found", and `tabGone` then refuses rather than drops.
    findTab: async (workspaceId, tabId) => {
      const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
      return layout ? collectAllTabs(layout.root).find((tab) => tab.id === tabId) ?? null : null;
    },
    tabGone: async (workspaceId, tabId) => {
      try {
        return (await liveTabsGone())(workspaceId, tabId);
      } catch {
        return null; // the workspace list itself is unreadable
      }
    },
    hasSession,
    status: (tabId) => getStatusManager().getAllForClient()[tabId],
    waitingAtPrompt: (tabId) => getStatusManager().isWaitingAtPrompt(tabId),
    halted: (tabId) => getStatusManager().isHaltedByUsageLimit(tabId),
    capture: (sessionName) => capturePaneAtWidth(sessionName, 120, 50, { escapes: true }),
    withDispatchLock: (workspaceId, tab, work) => withAgentDispatchLock(workspaceId, tab, work),
    deliver: deliverPrompt,
    isPending: isContentPendingInComposer,
    // Inbox notices keep their own delivery and receipts (consult ruling 3); the log records each with its class.
    recordDelivered: (item) => appendDelivered(getLedgerStore().tabEvents, {
      workspaceId: item.targetWorkspaceId, tabId: item.targetTabId, kind: item.kind, text: item.line, class: classifyWake(item.kind),
    }, Date.now()),
    window: getCoordinatorWindow,
  };
};

export interface IStartInboxOptions {
  /**
   * Ticks are skipped until this settles, or until `firstTickMaxWaitMs` passes
   * (then the inbox starts anyway and logs it). The server passes the first boot
   * drain of the hook spool: until it has run, a tab whose `prompt-submit` was
   * spooled during the restart still looks ready (ADR-0020).
   */
  firstTickAfter?: Promise<unknown>;
  firstTickMaxWaitMs?: number;
}

/** Resolves when `gate` settles or `maxWaitMs` passes, whichever is first; says which. */
const waitForGate = (gate: Promise<unknown>, maxWaitMs: number): Promise<'settled' | 'timed-out'> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timed-out'), maxWaitMs);
    timer.unref?.();
    const settle = () => {
      clearTimeout(timer);
      resolve('settled');
    };
    gate.then(settle, settle);
  });

export const startInbox = async (options: IStartInboxOptions = {}): Promise<void> => {
  if (g.__ptInboxRuntime) return;
  // Claimed before the first await, so two concurrent starts cannot both pass.
  const runtime: IInboxRuntime = { dispatcher: null, timer: null, unsubscribe: null };
  g.__ptInboxRuntime = runtime;
  const dispatcher = new InboxDispatcher(await defaultInboxDeps());
  const { onTabClosed } = await import('@/lib/tab-lifecycle');
  // Stopped while starting: install nothing, or a timer would tick on a slot nobody holds.
  if (g.__ptInboxRuntime !== runtime) return;
  runtime.dispatcher = dispatcher;
  // Listen first, then the boot pass: a close in between is caught either way (drops are idempotent).
  runtime.unsubscribe = onTabClosed(({ workspaceId, tabId }) => {
    dispatcher.dropForTab(workspaceId, tabId).then((dropped) => {
      if (dropped.length) log.info({ tabId, dropped: dropped.map((i) => i.id) }, 'inbox dropped: target tab closed');
    }).catch((err) => log.warn(`inbox drop failed for ${tabId}: ${err instanceof Error ? err.message : err}`));
  });
  try {
    const gone = await liveTabsGone();
    const dropped = await dispatcher.dropGoneTargets((ws, tab) => gone(ws, tab) === true);
    if (dropped.length) log.info({ dropped: dropped.map((i) => i.id) }, 'inbox boot pass: target tabs closed while down');
  } catch (err) {
    log.warn(`inbox boot pass skipped: ${err instanceof Error ? err.message : err}`);
  }
  if (g.__ptInboxRuntime !== runtime) return;
  let gateOpen = !options.firstTickAfter;
  if (options.firstTickAfter) {
    const maxWaitMs = options.firstTickMaxWaitMs ?? INBOX_FIRST_TICK_MAX_WAIT_MS;
    // Awaited once, in the background: the boot drain starts only after the server listens.
    void waitForGate(options.firstTickAfter, maxWaitMs).then((outcome) => {
      if (outcome === 'timed-out') {
        log.warn(`inbox: the first boot drain of the hook spool took over ${maxWaitMs} ms; the inbox starts anyway`);
      }
      gateOpen = true;
    });
  }
  let lastTickError: string | null = null;
  const timer = setInterval(() => {
    if (!gateOpen) return;
    dispatcher.tick().then(() => { lastTickError = null; }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      // A corrupt inbox fails every tick; say so once per distinct cause.
      if (message !== lastTickError) log.warn(`inbox tick failed: ${message}`);
      lastTickError = message;
    });
  }, INBOX_TICK_MS);
  timer.unref?.();
  runtime.timer = timer;
};

/** Stop ticking, and wait for a delivery in flight to be recorded before shutdown. */
export const stopInbox = async (): Promise<void> => {
  const runtime = g.__ptInboxRuntime;
  if (!runtime) return;
  g.__ptInboxRuntime = undefined;
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.unsubscribe?.();
  await runtime.dispatcher?.idle();
};
