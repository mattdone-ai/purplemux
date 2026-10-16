import { acknowledgeOrchestrationActivity } from '@/lib/orchestration-activity';
import { WebSocket } from 'ws';
import { getWorkspaces, getWorkspaceByIdCached, getWorkspacesCached } from '@/lib/workspace-store';
import { readLayoutFile, resolveLayoutFile, collectAllTabs, updateTabCliStatus, updateTabAgentSummary, updateTabAgentState, parseSessionName, clearReportsTo, updateTabWatchdogTurnEnd } from '@/lib/layout-store';
import { HOOK_REPLAY_WINDOW_MS, HOOK_SPOOL_DIR, type IHookSpoolDrainResult } from '@/lib/hook-spool';
import { HookFloorStore } from '@/lib/hook-floors';
import { onTabClosed, onTabClosing } from '@/lib/tab-lifecycle';
import { capturePaneContent, getAllPanesInfo, getListeningPorts, SAFE_SHELLS, getPaneTitle, getSessionCwd, getSessionPanePid } from '@/lib/tmux';
import { sessionHostOf } from '@/lib/session-host';
import { getChildPids } from '@/lib/process-utils';
import { getProvider, getProviderByPanelType } from '@/lib/providers/registry';
import { detectAnyActiveSession } from '@/lib/providers/session-scan';
import type { IAgentProvider, IAgentRuntimeSnapshot, ITurnError, TSessionStartSource } from '@/lib/providers/types';
import type { IAgentHookMetaPatch, TAgentWorkStateEvent } from '@/lib/providers/types';
import { deriveAgentCliState } from '@/lib/agent-state-transition';
import { cwdToProjectPath } from '@/lib/session-list';
import { formatTabTitle } from '@/lib/tab-title';
import { createRateLimitsWatcher } from '@/lib/rate-limits-watcher';
import { createClaudeUsagePoller } from '@/lib/claude-usage-poller';
import { createLogger } from '@/lib/logger';
import { capturePaneAtWidth } from '@/lib/capture-at-width';
import { paneShowsEmptyComposer } from '@/lib/composer-readiness';
import { isCodexTuiReadyContent } from '@/lib/codex-tui-ready-detector';
import { CODEX_PROVIDER_ID } from '@/lib/providers/codex';
import { GROK_PROVIDER_ID } from '@/lib/providers/grok';
import { resolveGrokJsonlPath } from '@/lib/providers/grok/session-detection';
import { isAgentPanelType, toSessionHistoryProvider } from '@/lib/agent-panel-types';
import { runtimeHandleFor, runtimeProviderId } from '@/lib/agent-runtime-handle';
import { findCodexSessionById } from '@/lib/providers/codex/session-detection';
import { cacheCodexRateLimitsFromJsonl } from '@/lib/codex-rate-limits-cache';
import { parsePermissionOptions } from '@/lib/permission-prompt';
import type { IPaneInfo } from '@/lib/tmux';
import type { ITab, IWorkspace, TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import type { ITurnErrorEpisode, ICurrentAction, TTerminalStatus, ITabStatusEntry, IClientTabStatusEntry, IStatusUpdateMessage, IRateLimitsCache, TEventName, ILastEvent, IOrchestrationNudge, TOrchestrationNudgeKind, IWorkspaceStandup, TAlertKind, TAlertProviderId } from '@/types/status';
import { addStandup, readAllLatestStandups, readLatestStandupEvidence } from '@/lib/standup-store';
import { buildNudgeMessage, buildHeartbeatMessage, nudgeKindForTransition, MAX_NUDGE_HISTORY, KICKOFF_FALLBACK_DELAY_MS, ORCH_IDLE_HEARTBEAT_MS, ORCH_MAX_HEARTBEATS } from '@/lib/orchestration';
import { getSignalEngine } from '@/lib/signal-engine';
import {
  IDLE_NUDGE_CONFIG_KEY,
  IDLE_NUDGE_DEFAULT_MS,
  WAIT_BACKSTOP_CONFIG_KEY,
  WAIT_BACKSTOP_DEFAULT_MS,
  classifyTurnEnd,
  holdsOffStall,
  idleNudgeDue,
  isBackgroundWaitStalled,
  longWaitDue,
  parseIdleNudgeMinutes,
  parseWaitBackstopHours,
} from '@/lib/turn-end';
import { NudgeDeduper } from '@/lib/nudge-dedupe';
import { readWatches } from '@/lib/watch-store';
import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { enqueueNotice, onInboxHeld, withdrawNotice } from '@/lib/inbox-store';
import type { IInboxItem } from '@/types/inbox';
import { getLivenessManager } from '@/lib/liveness-manager';
import { readLivenessEvidence } from '@/lib/liveness-store';
import { getLeaseSweeper, setLeaseAgentStateSource, type ITabAgentState } from '@/lib/lease-sweeper';
import { readLeaseEvidence } from '@/lib/lease-store';
import type { TBackgroundJobNotify, TLivenessEvent } from '@/types/liveness';
import { AgentModelWatch } from '@/lib/agent-model-watch';
import { AutomatedPromptDispatcher } from '@/lib/automated-prompt-dispatcher';
import type { IAgentSignal, IToolActivity } from '@/types/signals';
import type { ISessionHistoryEntry } from '@/types/session-history';
import { addSessionHistoryEntry, updateSessionHistoryDismissedAt } from '@/lib/session-history';
import { alertFor, isOrchestratorTab, isStallEpisodeEnd, shouldAlert, standupAlertTabId } from '@/lib/alert-policy';
import { createStatusSocketChannel, createWebPushChannel, getNotificationDispatcher } from '@/lib/notification-dispatcher';
import { registerFcmChannel } from '@/lib/fcm-channel';
import { getConfig } from '@/lib/config-store';
import { nanoid } from 'nanoid';
import { reconcileCodexLaunchTimeout } from '@/lib/providers/codex/launch-lifecycle';
import { getOrchestratorPresenceMonitor } from '@/lib/orchestrator-presence';
import type { IOrchestratorPresenceFacts } from '@/types/coordination';
import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';
import { syncRemoteTranscript } from '@/lib/remote-transcript';

const toAlertProvider = (providerId: string | undefined): TAlertProviderId =>
  providerId === 'codex' || providerId === 'grok' ? providerId : 'claude';

/**
 * Whether the pane's agent runs. A remote pane has no pid here (ADR-0022): its
 * foreground command, which tmux reports over ssh, is the evidence. `null` is
 * "cannot tell": a remote tab whose host the last scan did not read (a failed
 * scan, the backoff). No transition may act on it (review r3 B1).
 */
const agentRunningIn = async (
  paneInfo: IPaneInfo | undefined,
  provider: IAgentProvider | null,
  remoteHost: string | null = null,
  hostAnswered = false,
): Promise<boolean | null> => {
  if (!provider) return false;
  if (remoteHost) {
    if (paneInfo?.host) return provider.matchesProcess(paneInfo.command);
    return hostAnswered ? false : null;
  }
  if (!paneInfo || !paneInfo.pid) return false;
  return provider.isAgentRunning(paneInfo.pid, await getChildPids(paneInfo.pid));
};

const log = createLogger('status');
const hookLog = createLogger('hooks');

const entryAgentFields = (
  provider: IAgentProvider | null,
  tab: ITab,
  jsonlPath: string | null | undefined,
): { agentProviderId?: string; agentSessionId: string | null; agentSummary: string | null } => ({
  agentProviderId: provider?.id,
  agentSummary: provider?.readSummary(tab) ?? null,
  agentSessionId: provider?.sessionIdFromJsonlPath(jsonlPath ?? null)
    ?? provider?.readSessionId(tab)
    ?? null,
});

// Notification hook의 notification_type 중 권한 요청류만 needs-input으로 전환.
// idle_prompt(응답 후 60s idle 알람), computer_use_*, elicitation_*, auth_success 등은 상태 변경 없이 무시한다.
const INPUT_REQUESTING_NOTIFICATION_TYPES = new Set(['permission_prompt', 'worker_permission_prompt']);

const COMPACT_STALE_MS = 60_000;

// A tab's scope is set at creation and effectively never changes, so a long TTL
// keeps the layout read off the per-tool-call path.
const TAB_SCOPE_TTL_MS = 5 * 60_000;

const POLL_INTERVAL_SMALL = 30_000;
const POLL_INTERVAL_MEDIUM = 45_000;
const POLL_INTERVAL_LARGE = 60_000;
const TAB_COUNT_MEDIUM = 11;
const TAB_COUNT_LARGE = 21;
const BUSY_STUCK_MS = 10 * 60 * 1000;
const STOP_SETTLE_MS = 500;
const PROCESS_START_CACHE_MS = 60_000;
const AGENT_LAUNCH_GRACE_MS = 5_000;
// A Claude or Grok tab whose SessionStart hook never fired stays `inactive` with
// its prompt up, and `tab send` refuses it (L8: W1, 2026-09-26 01:06Z). After this
// long inactive with the agent running, the poll looks at the pane (story 17).
export const READINESS_PROBE_AFTER_MS = 8_000;
// Claude only. grok-cli joins once a real grok pane is pinned as a fixture
// (story 30 F8): its `[›❯>]` marker also matches a bare `>` line.
const PANE_PROBE_PANELS: ReadonlySet<TPanelType> = new Set<TPanelType>(['claude-code']);
const AGENT_GUARDED_STATES: Set<TCliState> = new Set(['busy', 'idle', 'needs-input', 'ready-for-review']);
// tmux set-titles emits "<cmd>|<path>" once a shell takes over the pane.
// An agent CLI normally writes its own title (no pipe), so this regex
// distinguishes "agent gone" from "agent rewrote title" without a process call.
const SHELL_TITLE_RE = /^[^|]+\|[^|]+$/;

const PROCESS_RETRY_COUNT = 3;
/**
 * A tab announced as closing (`tab-closing`) is retired for this long, or until
 * its `tab-closed` or `aborted` event: a close reaps within seconds. A closed
 * tab stays retired this long again, so a poll that read the layout before the
 * close cannot bring its entry back (L38: a poll 38 s after the close did).
 */
const CLOSING_RETIRE_MS = 60_000;
const CLOSED_RETIRE_MS = 5 * 60_000;
const JSONL_WATCH_DEBOUNCE_MS = 100;
// 9.5 s and 12 s: the first polls past READINESS_PROBE_AFTER_MS, counted from
// the first poll that sees the agent running (~0.7 s), so a tab whose
// SessionStart hook never fires is probed without waiting for the interval poll.
export const LAUNCH_READY_POLL_DELAYS_MS = [700, 1_500, 3_000, 5_000, 8_000, 9_500, 12_000] as const;
/** Hook events kept per tab in `getHookHistory`. */
export const HOOK_HISTORY_LIMIT = 32;
/** The second boot drain, for hooks that renamed their file after the first one listed the spool. */
export const HOOK_SPOOL_LATE_DRAIN_MS = 5_000;

/** One hook event a tab received, live or replayed from the spool (ADR-0020). */
export interface IHookHistoryItem {
  event: string;
  at: number;
  replayed: boolean;
  /** Older than the tab's hook floor or the replay window: recorded here, never applied to its state. */
  stale: boolean;
}

const g = globalThis as unknown as { __ptStatusManager?: StatusManager };

export class StatusManager {
  private tabs = new Map<string, ITabStatusEntry>();
  private orchestrationPendingLaunches = new Set<string>();
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private currentInterval = 0;
  private clients = new Set<WebSocket>();
  private initialized = false;
  private rateLimitsWatcher: ReturnType<typeof createRateLimitsWatcher> | null = null;
  private claudeUsagePoller: ReturnType<typeof createClaudeUsagePoller> | null = null;
  private lastRateLimits: IRateLimitsCache | null = null;
  private jsonlWatchers = new Map<string, { watcher: FSWatcher; jsonlPath: string; debounceTimer: ReturnType<typeof setTimeout> | null }>();
  private compactStaleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private orchestrationNudges: IOrchestrationNudge[] = [];
  private standups = new Map<string, IWorkspaceStandup>();

  // Scope/cwd are read from the layout file, which is far too slow to touch per
  // tool call. Cached with a short TTL and refreshed off the hot path.
  private tabScopeCache = new Map<string, { scope?: string[]; cwd?: string; at: number }>();
  private orchKeeper = new Map<string, { idleSince: number | null; beats: number; lastBeatAt: number; stallAlerted: boolean }>();
  /** Identical nudges within 60 s are dropped and counted (L49). */
  private nudgeDedupe = new NudgeDeduper();
  /** When each tab's last registered job reported its exit: a sign of life for the stall check. */
  private jobEventAt = new Map<string, number>();
  /** Tabs being closed, or just closed, with the time their retirement ends (L38). */
  private retiredTabs = new Map<string, number>();
  private modelWatch = new AgentModelWatch();
  private automatedPrompts: AutomatedPromptDispatcher;
  private cacheCodexRateLimits: typeof cacheCodexRateLimitsFromJsonl;
  private updateAgentState: typeof updateTabAgentState;
  /** Tab → when its once-per-busy-stretch `stuck` nudge went out (the fleet panel reads the time, ADR-0023). */
  private stuckNudgedTabs = new Map<string, number>();
  /** Tab → when it last became `inactive` (runtime only; the fleet panel times the dead agent from it). */
  private inactiveSince = new Map<string, number>();
  private transcriptFallbackLogged = new Set<string>();
  /** When the poll first saw each tab `inactive` (the pane-probe clock). */
  private inactiveSeenAt = new Map<string, number>();
  /**
   * Session ids the poll persisted because no hook bound one (L8). The poll may
   * move its own binding (a hookless `/clear`), never one a hook or a launch set.
   */
  private pollBoundSessions = new Map<string, string>();
  /** Bumped by every hook or launch binding: a poll write that lands after one never claims ownership. */
  private sessionBindingEpoch = new Map<string, number>();
  private orphanResumesEscalated = new Set<string>();
  private processStartCache = new Map<string, { startedAt: number | null; checkedAt: number; stamp: number | null }>();
  private pendingKickoffs = new Map<string, { prompt: string; timer: ReturnType<typeof setTimeout> }>();
  private codexLifecycleEpoch = new Map<string, { generation: string; phase: 'pending' | 'active'; epoch: number }>();
  /**
   * Each tab's hook floor: when its latest applied hook STATE event happened.
   * Saved in `hook-spool/.floors.json` (never the layout) and loaded at boot,
   * so an older replayed event is history only across restarts too (ADR-0020).
   */
  private hookFloors = new HookFloorStore({ dir: HOOK_SPOOL_DIR });
  /** Set once `init()`'s scan has built every tab: a drain before it would find no tabs (ADR-0020). */
  private hookScanReady = false;
  private scansInFlight = 0;
  /** The latest scan started, settled either way; the boot drain waits for it (ADR-0020). */
  private latestScan: Promise<void> = Promise.resolve();
  private settleBootHookSpoolDrain!: () => void;
  private readonly bootHookSpoolDrain = new Promise<void>((resolve) => {
    this.settleBootHookSpoolDrain = resolve;
  });
  private hookHistory = new Map<string, IHookHistoryItem[]>();
  private hookSpoolDrain: (() => Promise<IHookSpoolDrainResult>) | null = null;
  private hookSpoolDraining: Promise<void> | null = null;
  /**
   * Replayed STATE events that changed no state (older than the tab's floor or
   * the replay window), counted in `admitHookEvent`, and replayed hooks their
   * gate refused (`recordSkippedReplay`); a drain logs its delta. A stale
   * metadata patch is not counted: its state event, if any, is.
   */
  private staleReplays = 0;

  constructor(
    automatedPrompts = new AutomatedPromptDispatcher(),
    cacheCodexRateLimits = cacheCodexRateLimitsFromJsonl,
    updateAgentState = updateTabAgentState,
  ) {
    this.automatedPrompts = automatedPrompts;
    this.cacheCodexRateLimits = cacheCodexRateLimits;
    this.updateAgentState = updateAgentState;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    getSignalEngine().setEmitter((signal) => this.deliverSignal(signal));

    // Standups are file-backed so "where are things at" survives a restart;
    // ticks posted while hydration is in flight win via the at-comparison.
    readAllLatestStandups().then((latest) => {
      for (const [wsId, standup] of Object.entries(latest)) {
        const current = this.standups.get(wsId);
        if (!current || current.at < standup.at) this.standups.set(wsId, standup);
      }
    }).catch(() => {});

    await this.hookFloors.load();
    await this.scanAll();
    // Floors of tabs closed while no server ran go; a missing floor is only too low, never wrong.
    this.hookFloors.retain(new Set(this.tabs.keys()));
    this.hookScanReady = true;
    this.startPolling();

    this.rateLimitsWatcher = createRateLimitsWatcher((data) => {
      this.lastRateLimits = data;
      this.broadcast({ type: 'rate-limits:update', data });
    });
    this.rateLimitsWatcher.start();
    this.claudeUsagePoller = createClaudeUsagePoller();
    this.claudeUsagePoller.start();
  }

  private async scanAll(): Promise<void> {
    this.scansInFlight += 1;
    const scan = this.scanAllTabs();
    this.latestScan = scan.then(() => {}, () => {});
    try {
      await scan;
    } finally {
      this.scansInFlight -= 1;
    }
  }

  /**
   * Drain once no scan runs: waits for a scan in flight (a rescan overlapping
   * the boot) instead of skipping, so the boot drain is a real one.
   */
  private async drainHookSpoolAfterScans(): Promise<void> {
    while (this.scansInFlight > 0) await this.latestScan;
    await this.drainHookSpool();
  }

  private async scanAllTabs(): Promise<void> {
    const { workspaces } = await getWorkspaces();
    const panesInfo = await getAllPanesInfo();
    for (const tabId of [...this.jsonlWatchers.keys()]) {
      this.stopJsonlWatch(tabId);
    }
    this.tabs.clear();

    for (const ws of workspaces) {
      const layout = await readLayoutFile(resolveLayoutFile(ws.id));
      if (!layout) continue;

      const tabs = collectAllTabs(layout.root);
      for (const tab of tabs) {
        const paneInfo = panesInfo.get(tab.sessionName);
        const provider = getProviderByPanelType(tab.panelType);
        const detected = await this.readTabMetadata(paneInfo, provider, tab);
        const persisted: TCliState = (tab.cliState as TCliState | undefined) ?? 'idle';
        const cliState: TCliState = persisted === 'busy' ? 'unknown' : persisted;

        const { terminalStatus, listeningPorts } = provider
          ? { terminalStatus: 'idle' as const, listeningPorts: [] as number[] }
          : await this.detectTerminalStatus(paneInfo);
        const currentProcess = paneInfo?.command;
        const paneTitle = paneInfo ? `${paneInfo.command}|${paneInfo.path}` : undefined;
        // lastEvent는 메모리 전용이라 재시작 시 유실. persisted needs-input 복원 시
        // 클라 ack가 seq=0과 매칭할 baseline이 필요하므로 합성한다.
        const syntheticLastEvent: ILastEvent | null = cliState === 'needs-input'
          ? { name: 'notification', at: Date.now(), seq: 0 }
          : null;
        this.tabs.set(tab.id, {
          cliState,
          workspaceId: ws.id,
          tabName: tab.name || (paneTitle ? formatTabTitle(paneTitle, tab.panelType) : ''),
          currentProcess,
          paneTitle,
          tmuxSession: tab.sessionName,
          panelType: tab.panelType,
          terminalStatus,
          listeningPorts,
          ...entryAgentFields(provider, tab, detected.jsonlPath),
          reportsTo: tab.reportsTo ?? null,
          lastUserMessage: tab.lastUserMessage,
          lastAssistantMessage: detected.lastAssistantSnippet,
          currentAction: detected.currentAction,
          readyForReviewAt: cliState === 'ready-for-review' ? Date.now() : null,
          busySince: null,
          dismissedAt: tab.dismissedAt ?? null,
          jsonlPath: detected.jsonlPath,
          lastEvent: syntheticLastEvent,
          eventSeq: 0,
        });
        this.applyRestoredStop(tab, this.tabs.get(tab.id)!);
        this.reconcileJsonlWatch(tab.id, this.tabs.get(tab.id)!);
        if (cliState === 'unknown') {
          this.resolveUnknown(tab.id).catch((err) => log.warn('resolveUnknown failed: %s', err));
        }
      }
    }
  }

  private async resolveUnknown(tabId: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.cliState !== 'unknown') return;

    const provider = getProviderByPanelType(entry.panelType);
    const panes = await getAllPanesInfo();
    const paneInfo = panes.get(entry.tmuxSession);
    const remoteHost = await sessionHostOf(entry.tmuxSession);
    const agentRunning = await agentRunningIn(paneInfo, provider, remoteHost, !!remoteHost && !!panes.answeredRemoteHosts?.has(remoteHost));
    // A remote host not read: the tab stays unknown until a hook or a read pane says (review r3 B1).
    if (agentRunning === null) return;

    if (!agentRunning) {
      this.applyCliState(tabId, entry, 'idle', { silent: true });
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
      return;
    }

    await syncRemoteTranscript(entry.tmuxSession).catch(() => false);
    const unknownStateHandle = this.runtimeHandle(entry);
    if (provider && unknownStateHandle) {
      const snapshot = await provider.readRuntimeSnapshot(unknownStateHandle, {
        tasksSince: await this.agentProcessStartedAt(tabId, entry),
        withBackground: true,
      });
      const { idle, stale, lastAssistantSnippet } = snapshot;
      const liveRegisteredJobs = await this.liveRegisteredJobs(tabId);
      const armedWatches = await this.armedWatches(entry.workspaceId, tabId);
      // No await past this point: a hook event must not be overwritten.
      if (this.tabs.get(tabId) !== entry || entry.cliState !== 'unknown') return;
      const turnEnd = idle && !stale && lastAssistantSnippet
        ? classifyTurnEnd({
            tail: snapshot.lastAssistantTail,
            transcript: true,
            openBackgroundTasks: snapshot.openBackgroundTasks ?? 0,
            liveRegisteredJobs,
            armedWatches,
          })
        : null;
      if (turnEnd?.kind === 'waiting') {
        // A restart lost the stop this tab ended on; rebuild it, silently, so
        // `tab send` (ruling A′) and the stall check still see a WAITING tab.
        // Dated at the transcript's last entry, so the stall clocks do not restart.
        const at = snapshot.lastEntryTs ?? Date.now();
        const seq = (entry.eventSeq ?? 0) + 1;
        entry.eventSeq = seq;
        entry.lastEvent = { name: 'stop', at, seq };
        entry.turnEnd = { kind: 'waiting', at, seq, openBackgroundTasks: turnEnd.openBackgroundTasks, liveRegisteredJobs: turnEnd.liveRegisteredJobs, armedWatches: turnEnd.armedWatches };
        this.applyCliState(tabId, entry, 'busy', { silent: true });
        this.persistToLayout(entry);
        this.broadcastUpdate(tabId, entry);
        return;
      }
      if (idle && !stale && lastAssistantSnippet) {
        this.applyCliState(tabId, entry, 'ready-for-review', { silent: true });
        this.persistToLayout(entry);
        this.broadcastUpdate(tabId, entry);
        return;
      }
    }
  }

  private async readTabMetadata(
    paneInfo: IPaneInfo | undefined,
    provider: IAgentProvider | null,
    tab?: ITab,
  ): Promise<{ lastAssistantSnippet: string | null; currentAction: ICurrentAction | null; jsonlPath: string | null }> {
    const empty = { lastAssistantSnippet: null, currentAction: null, jsonlPath: null };
    if (!(await agentRunningIn(paneInfo, provider, tab?.host ?? null)) || !paneInfo || !provider) return empty;
    // A remote tab's transcript is the local copy its hooks bound (ADR-0022); nothing else is local.
    if (paneInfo.host) {
      const copy = tab ? provider.readJsonlPath(tab) : null;
      if (!copy) return empty;
      try {
        await fs.access(copy);
        const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(copy);
        return { lastAssistantSnippet, currentAction, jsonlPath: copy };
      } catch {
        return empty;
      }
    }
    const childPids = await getChildPids(paneInfo.pid);

    if (tab) {
      const persistedJsonlPath = provider.readJsonlPath(tab);
      if (persistedJsonlPath) {
        try {
          await fs.access(persistedJsonlPath);
          const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(persistedJsonlPath);
          return { lastAssistantSnippet, currentAction, jsonlPath: persistedJsonlPath };
        } catch { /* fall through */ }
      }

      // Codex and grok both key their stores by their own index rather than by
      // the pane's cwd, so a persisted session id resolves to a transcript
      // without re-detecting the process.
      const persistedSessionId = provider.readSessionId(tab);
      if (persistedSessionId) {
        const storeJsonlPath = provider.id === CODEX_PROVIDER_ID
          ? (await findCodexSessionById(persistedSessionId))?.jsonlPath ?? null
          : provider.id === GROK_PROVIDER_ID
            ? await resolveGrokJsonlPath(persistedSessionId)
            : null;
        const handle = runtimeHandleFor(provider.id, {
          jsonlPath: storeJsonlPath,
          sessionId: persistedSessionId,
        });
        if (handle) {
          const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(handle);
          return { lastAssistantSnippet, currentAction, jsonlPath: storeJsonlPath };
        }
      }
    }

    const session = await provider.detectActiveSession(paneInfo.pid, childPids);
    if (session.status !== 'running' || !session.jsonlPath) {
      return { lastAssistantSnippet: null, currentAction: null, jsonlPath: session.jsonlPath ?? null };
    }

    const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(session.jsonlPath);
    return { lastAssistantSnippet, currentAction, jsonlPath: session.jsonlPath };
  }

  private async detectTerminalStatus(
    paneInfo?: IPaneInfo,
  ): Promise<{ terminalStatus: TTerminalStatus; listeningPorts: number[] }> {
    // A remote pane has no local pid (ADR-0022 §11): its foreground command alone, no ports.
    if (paneInfo?.host) return { terminalStatus: SAFE_SHELLS.has(paneInfo.command) ? 'idle' : 'running', listeningPorts: [] };
    if (!paneInfo || !paneInfo.pid) return { terminalStatus: 'idle', listeningPorts: [] };

    const ports = await getListeningPorts(paneInfo.pid);
    if (ports.length > 0) return { terminalStatus: 'server', listeningPorts: ports };

    const isShell = SAFE_SHELLS.has(paneInfo.command);
    return { terminalStatus: isShell ? 'idle' : 'running', listeningPorts: [] };
  }

  private getPollingInterval(): number {
    const count = this.tabs.size;
    if (count >= TAB_COUNT_LARGE) return POLL_INTERVAL_LARGE;
    if (count >= TAB_COUNT_MEDIUM) return POLL_INTERVAL_MEDIUM;
    return POLL_INTERVAL_SMALL;
  }

  async rescan(): Promise<void> {
    await this.scanAll();
  }

  startPolling(): void {
    this.stopPolling();
    this.currentInterval = this.getPollingInterval();
    this.pollingTimer = setInterval(() => {
      this.poll().catch((err) => {
        log.error({ err }, 'Polling error');
      });
    }, this.currentInterval);
  }

  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.currentInterval = 0;
    }
  }

  /** The replay of the hook spool, set by the server before `init` (ADR-0020). */
  setHookSpoolDrain(drain: (() => Promise<IHookSpoolDrainResult>) | null): void {
    this.hookSpoolDrain = drain;
  }

  /**
   * Replay the hook spool; one drain at a time, a caller during one waits for it.
   * A no-op until `init()`'s scan has built the tabs, and while a rescan
   * rebuilds them: an event for a tab not yet built would be deleted unapplied.
   * The files wait for the next drain. A drain that found files logs one line:
   * applied, the replayed state events among them that were stale
   * (history only), timed out, bad, and its duration.
   */
  drainHookSpool(): Promise<void> {
    if (!this.hookSpoolDrain || !this.hookScanReady || this.scansInFlight > 0) return Promise.resolve();
    if (!this.hookSpoolDraining) {
      const startedAt = Date.now();
      const staleBefore = this.staleReplays;
      this.hookSpoolDraining = this.hookSpoolDrain()
        .then((result) => {
          this.logHookSpoolDrain(result, this.staleReplays - staleBefore, Date.now() - startedAt);
        }, (err) => {
          hookLog.error({ err, durationMs: Date.now() - startedAt }, 'hook spool drain failed');
        })
        .finally(() => {
          this.hookSpoolDraining = null;
        });
    }
    return this.hookSpoolDraining;
  }

  private logHookSpoolDrain(result: IHookSpoolDrainResult, stale: number, durationMs: number): void {
    const { applied, timedOut, bad, dropped, metadataOnly } = result;
    if (applied + bad + dropped + metadataOnly === 0) return;
    const fields = { applied, stale, timedOut, bad, dropped, metadataOnly, durationMs };
    const line = `hook spool drain: ${applied} applied (${stale} stale), ${timedOut} timed out, ${bad} bad, in ${durationMs} ms`;
    if (timedOut > 0 || bad > 0) hookLog.warn(fields, line);
    else hookLog.info(fields, line);
  }

  /**
   * The boot drains, started once the server listens and has written its port
   * file, and never awaited: a large spool must not hold up startup or the
   * deploy's health gate. The second drain catches a hook that saw no port
   * file and renamed its spool file after the first drain listed the spool.
   * Both wait for a scan in flight rather than skip; `bootHookSpoolDrained()`
   * settles only after the first has drained (the inbox caps its wait at 10 s).
   */
  startBootHookSpoolDrains(lateDelayMs = HOOK_SPOOL_LATE_DRAIN_MS): void {
    void this.drainHookSpoolAfterScans().then(() => this.settleBootHookSpoolDrain());
    const timer = setTimeout(() => { void this.drainHookSpoolAfterScans(); }, lateDelayMs);
    timer.unref?.();
  }

  /** Settles when the first boot drain has finished; the inbox holds its first tick for it. */
  bootHookSpoolDrained(): Promise<void> {
    return this.bootHookSpoolDrain;
  }

  getHookHistory(tabId: string): IHookHistoryItem[] {
    return [...(this.hookHistory.get(tabId) ?? [])];
  }

  private isStaleReplay(tabId: string, replayedAt: number | undefined): boolean {
    if (replayedAt === undefined) return false;
    if (Date.now() - replayedAt > HOOK_REPLAY_WINDOW_MS) return true;
    const floor = this.hookFloors.get(tabId);
    return floor !== undefined && replayedAt < floor;
  }

  /**
   * Record a hook event in the tab's history. Returns the event's time when it
   * may change the tab's state, null when it may not: a live event always may,
   * a replayed one only when it is not older than the latest event applied.
   */
  private admitHookEvent(tabId: string, event: string, replayedAt: number | undefined): number | null {
    const at = replayedAt ?? Date.now();
    const stale = this.isStaleReplay(tabId, replayedAt);
    this.recordHookHistory(tabId, { event, at, replayed: replayedAt !== undefined, stale });
    if (stale) {
      this.staleReplays += 1;
      hookLog.info({ tabId, event, at, floor: this.hookFloors.get(tabId) }, 'replayed hook event older than the tab\'s floor or the replay window: history only');
      return null;
    }
    this.hookFloors.raise(tabId, at);
    return at;
  }

  /** Insert one event in the tab's hook history, in time order, keeping the last `HOOK_HISTORY_LIMIT`. */
  private recordHookHistory(tabId: string, item: IHookHistoryItem): void {
    const history = this.hookHistory.get(tabId) ?? [];
    let index = history.length;
    while (index > 0 && history[index - 1].at > item.at) index -= 1;
    history.splice(index, 0, item);
    if (history.length > HOOK_HISTORY_LIMIT) history.splice(0, history.length - HOOK_HISTORY_LIMIT);
    this.hookHistory.set(tabId, history);
  }

  /** The Codex launch this server tracks for the tab in memory; null when it tracks none (e.g. since a restart). */
  codexLaunchLifecycle(tabId: string): { generation: string; phase: 'pending' | 'active' } | null {
    const tracked = this.codexLifecycleEpoch.get(tabId);
    return tracked ? { generation: tracked.generation, phase: tracked.phase } : null;
  }

  /**
   * A replayed hook its gate refused (ADR-0020): it changes no state, like a
   * stale replay, and is recorded the same way — in the tab's history as
   * stale, in the drain's stale count, and in one log line with the reason.
   */
  recordSkippedReplay(tmuxSession: string, event: string, replayedAt: number, reason: string): void {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (tabId) this.recordHookHistory(tabId, { event, at: replayedAt, replayed: true, stale: true });
    this.staleReplays += 1;
    hookLog.info({ tabId, tmuxSession, event, at: replayedAt, reason }, `replayed hook event skipped (${reason}): history only`);
  }

  async poll(): Promise<void> {
    // Started, never awaited (ADR-0020): the liveness reconcile, the stuck
    // checks and the idle nudges must not wait for a slow replay. The drain is
    // one shared promise, so a poll during a drain starts no second one. On
    // 28 Sep a drain of 11 files held every poll for 7 minutes.
    if (this.hookSpoolDrain) void this.drainHookSpool();
    const { workspaces } = await getWorkspaces();
    const panesInfo = await getAllPanesInfo();
    const knownTabIds = new Set<string>();
    const tabsBeforePoll = new Set(this.tabs.keys());
    const now = Date.now();
    for (const [tabId, until] of this.retiredTabs) {
      if (until <= now) this.retiredTabs.delete(tabId);
    }

    for (const ws of workspaces) {
      const layout = await readLayoutFile(resolveLayoutFile(ws.id));
      if (!layout) continue;

      const tabs = collectAllTabs(layout.root);
      for (const tab of tabs) {
        if (tab.panelType === 'codex-cli' && tab.codexLaunchRuntime?.pending) {
          await reconcileCodexLaunchTimeout(ws.id, tab.id, now).catch((err) => {
            log.warn(`Codex launch timeout reconciliation failed: ${err instanceof Error ? err.message : err}`);
          });
        }
        const trackedLifecycle = this.codexLifecycleEpoch.get(tab.id);
        const persistedLifecycle = tab.codexLaunchRuntime?.pending
          ? { generation: tab.codexLaunchRuntime.pending.generation, phase: 'pending' as const }
          : tab.codexLaunchRuntime?.active
            ? { generation: tab.codexLaunchRuntime.active.generation, phase: 'active' as const }
            : null;
        if (trackedLifecycle && (
          !persistedLifecycle
          || trackedLifecycle.generation !== persistedLifecycle.generation
          || trackedLifecycle.phase !== persistedLifecycle.phase
        )) {
          continue;
        }
        const lifecycleEpoch = trackedLifecycle?.epoch ?? 0;
        knownTabIds.add(tab.id);
        // Being closed, or closed after this layout was read: its reap is no death (L38).
        if (this.isRetired(tab.id)) continue;
        const existing = this.tabs.get(tab.id);
        const provider = getProviderByPanelType(tab.panelType);
        const persistedSessionId = provider?.readSessionId(tab) ?? null;
        const sessionBindingChanged = !!existing
          && !!persistedSessionId
          && persistedSessionId !== existing.agentSessionId;
        if (existing && sessionBindingChanged) {
          this.stopJsonlWatch(tab.id);
          existing.agentSessionId = persistedSessionId;
          existing.jsonlPath = null;
          existing.agentSummary = null;
          existing.lastUserMessage = null;
          existing.lastAssistantMessage = null;
          existing.currentAction = null;
          existing.permissionRequest = null;
        }
        await this.modelWatch.check(tab, async (detail) => {
          await this.nudgeLiveness(ws.id, tab.id, tab.name, 'model-drift', detail, undefined, `model-drift:${detail}`);
          return true;
        }).catch((err) => log.warn(`model policy check failed: ${err instanceof Error ? err.message : err}`));
        if ((this.codexLifecycleEpoch.get(tab.id)?.epoch ?? 0) !== lifecycleEpoch) continue;
        const paneInfo = panesInfo.get(tab.sessionName);
        // A remote tab whose host this scan did not read keeps what it showed (review r3 B1).
        const hostAnswered = !!tab.host && !!panesInfo.answeredRemoteHosts?.has(tab.host);
        const paneUnread = !!tab.host && !paneInfo && !hostAnswered;

        const { terminalStatus, listeningPorts } = paneUnread && existing
          ? { terminalStatus: existing.terminalStatus ?? 'idle', listeningPorts: existing.listeningPorts ?? [] }
          : provider
            ? { terminalStatus: 'idle' as const, listeningPorts: [] as number[] }
            : await this.detectTerminalStatus(paneInfo);
        const currentProcess = paneUnread && existing ? existing.currentProcess : paneInfo?.command;
        const newPaneTitle = paneUnread && existing ? existing.paneTitle : paneInfo ? `${paneInfo.command}|${paneInfo.path}` : undefined;

        if (!existing) {
          const persisted: TCliState = (tab.cliState as TCliState | undefined) ?? 'idle';
          const initialState: TCliState = persisted === 'busy' ? 'unknown' : persisted;
          const detected = await this.readTabMetadata(paneInfo, provider, tab);
          // lastEvent는 메모리 전용이라 재시작 시 유실. persisted needs-input을 복원할 때는
          // 클라이언트 ack가 seq=0과 매칭할 baseline이 필요하므로 합성한다.
          const syntheticLastEvent: ILastEvent | null = initialState === 'needs-input'
            ? { name: 'notification', at: Date.now(), seq: 0 }
            : null;
          const entry: ITabStatusEntry = {
            cliState: initialState,
            workspaceId: ws.id,
            tabName: tab.name || (newPaneTitle ? formatTabTitle(newPaneTitle, tab.panelType) : ''),
            currentProcess,
            paneTitle: newPaneTitle,
            tmuxSession: tab.sessionName,
            panelType: tab.panelType,
            terminalStatus,
            listeningPorts,
            ...entryAgentFields(provider, tab, detected.jsonlPath),
            reportsTo: tab.reportsTo ?? null,
            lastUserMessage: tab.lastUserMessage,
            lastAssistantMessage: detected.lastAssistantSnippet,
            currentAction: detected.currentAction,
            jsonlPath: detected.jsonlPath,
            lastEvent: syntheticLastEvent,
            eventSeq: 0,
          };
          this.applyRestoredStop(tab, entry);
          this.tabs.set(tab.id, entry);
          this.persistPolledSession(tab.id, tab, provider, detected.jsonlPath);
          this.reconcileJsonlWatch(tab.id, entry);
          this.persistToLayout(entry);
          this.broadcastUpdate(tab.id, entry);
          if (initialState === 'unknown') {
            this.resolveUnknown(tab.id).catch((err) => log.warn('resolveUnknown failed: %s', err));
          }
          continue;
        }

        // A busy remote tab's copy follows the remote transcript between hooks (ADR-0022): the
        // watch on the copy then updates the snippet and current action.
        if (paneInfo?.host && (existing.cliState === 'busy' || existing.cliState === 'needs-input')) {
          void syncRemoteTranscript(tab.sessionName).catch(() => false);
        }
        const processChanged = existing.currentProcess !== currentProcess;
        const messageChanged = existing.lastUserMessage !== tab.lastUserMessage;
        const panelTypeChanged = existing.panelType !== tab.panelType;
        const refreshed = await this.readTabMetadata(paneInfo, provider, tab);
        if ((this.codexLifecycleEpoch.get(tab.id)?.epoch ?? 0) !== lifecycleEpoch) continue;
        existing.tabName = tab.name || (newPaneTitle ? formatTabTitle(newPaneTitle, tab.panelType) : '');
        existing.currentProcess = currentProcess;
        existing.paneTitle = newPaneTitle;
        existing.workspaceId = ws.id;
        existing.panelType = tab.panelType;
        existing.agentProviderId = provider?.id;
        existing.agentSessionId = provider?.sessionIdFromJsonlPath(refreshed.jsonlPath)
          ?? provider?.readSessionId(tab) ?? null;
        this.persistPolledSession(tab.id, tab, provider, refreshed.jsonlPath);
        existing.jsonlPath = refreshed.jsonlPath ?? existing.jsonlPath;
        existing.lastUserMessage = tab.lastUserMessage;
        existing.reportsTo = tab.reportsTo ?? null;
        this.reconcileJsonlWatch(tab.id, existing);

        if (processChanged) {
          existing.processRetries = PROCESS_RETRY_COUNT;
        }
        const processRetryNeeded = !processChanged && (existing.processRetries ?? 0) > 0;
        if (processRetryNeeded) {
          existing.processRetries = existing.processRetries! - 1;
        }

        const prevPorts = existing.listeningPorts;
        const portsChanged = prevPorts?.length !== listeningPorts.length
          || listeningPorts.some((p, i) => prevPorts![i] !== p);
        const terminalChanged = existing.terminalStatus !== terminalStatus || portsChanged;
        if (terminalChanged) {
          existing.terminalStatus = terminalStatus;
          existing.listeningPorts = listeningPorts;
        }

        let summaryChanged = false;
        const tabSummary = provider ? provider.readSummary(tab) : null;
        if (existing.cliState === 'busy' || existing.cliState === 'needs-input') {
          const paneTitle = await getPaneTitle(tab.sessionName);
          const liveSummary = provider?.parsePaneTitle(paneTitle) ?? null;
          const nextSummary = liveSummary ?? tabSummary;
          if (nextSummary !== existing.agentSummary) {
            existing.agentSummary = nextSummary;
            summaryChanged = true;
            if (liveSummary && provider) {
              updateTabAgentSummary(tab.sessionName, provider, liveSummary).catch(() => {});
            }
          }
        } else {
          if (existing.agentSummary !== tabSummary) {
            existing.agentSummary = tabSummary;
            summaryChanged = true;
          }
        }

        let agentRunningCache: boolean | null | undefined;
        const agentRunningNow = async (): Promise<boolean | null> => {
          if (agentRunningCache === undefined) agentRunningCache = await agentRunningIn(paneInfo, provider, tab.host ?? null, hostAnswered);
          return agentRunningCache;
        };
        const checkAgentRunning = async (): Promise<boolean> => (await agentRunningNow()) === true;

        // A remote tab left unknown while its host was not read is resolved once its pane reads again.
        if (existing.cliState === 'unknown' && tab.host && !paneUnread) {
          this.resolveUnknown(tab.id).catch((err) => log.warn('resolveUnknown failed: %s', err));
        }

        // A remote tab whose pane is unread may be mid-turn: no timeout, idle or inactive transition acts on it.
        if (existing.cliState === 'busy' && existing.lastEvent
            && now - existing.lastEvent.at > BUSY_STUCK_MS && (await agentRunningNow()) !== null) {
          if (!(await checkAgentRunning())) {
            log.info({ tabId: tab.id }, 'busy stuck — agent process gone, forcing idle');
            this.applyCliState(tab.id, existing, 'idle', { silent: true });
            this.persistToLayout(existing);
            this.broadcastUpdate(tab.id, existing);
            continue;
          }
          // A registered job that died speaks first: its completion event, not a stall (L49, tab-peo88o).
          if (!this.stuckNudgedTabs.has(tab.id) && !(await this.reportDeadJobs(tab.id))
              && await this.looksStalled(tab.id, existing, now)) {
            this.stuckNudgedTabs.set(tab.id, now);
            this.nudgeOrchestrator(tab.id, existing, 'stuck').catch((err) => {
              log.warn(`stuck nudge failed: ${err instanceof Error ? err.message : err}`);
            });
          }
        }

        if (provider && AGENT_GUARDED_STATES.has(existing.cliState)) {
          const stamp = existing.lastResumeOrStartedAt;
          const inGrace = stamp !== undefined && now - stamp < AGENT_LAUNCH_GRACE_MS;
          if (!inGrace) {
            const title = existing.paneTitle ?? '';
            const titleShellStyle = !!title && SHELL_TITLE_RE.test(title);
            if ((!title || titleShellStyle) && (await agentRunningNow()) === false) {
              log.info({ tabId: tab.id, prevState: existing.cliState }, 'agent process gone — transitioning to inactive');
              this.applyCliState(tab.id, existing, 'inactive', { silent: true });
              this.persistToLayout(existing);
              this.broadcastUpdate(tab.id, existing);
              continue;
            }
          }
        }

        if (existing.cliState === 'inactive' && existing.panelType === 'codex-cli' && provider) {
          const seq = existing.eventSeq;
          if (await this.checkCodexTuiReady(existing, checkAgentRunning)
              && this.stillInactiveAt(tab.id, existing, seq)) {
            hookLog.debug({ tabId: tab.id }, 'codex tui ready — synthetic session-start');
            this.updateTabFromHook(existing.tmuxSession, 'session-start');
            continue;
          }
        }

        if (existing.cliState !== 'inactive') {
          this.inactiveSeenAt.delete(tab.id);
        } else if (provider && existing.panelType && PANE_PROBE_PANELS.has(existing.panelType)) {
          const seq = existing.eventSeq;
          if (await this.checkAgentPaneReady(tab.id, existing, now, checkAgentRunning)
              && this.stillInactiveAt(tab.id, existing, seq)) {
            this.inactiveSeenAt.delete(tab.id);
            hookLog.info({ tabId: tab.id, panelType: existing.panelType }, 'readiness: pane-probe — synthetic session-start');
            this.updateTabFromHook(existing.tmuxSession, 'session-start');
            continue;
          }
        }

        if (terminalChanged || processChanged || processRetryNeeded || messageChanged || panelTypeChanged || summaryChanged || sessionBindingChanged) {
          this.broadcastUpdate(tab.id, existing);
        }
      }
    }

    for (const tabId of tabsBeforePoll) {
      if (!knownTabIds.has(tabId) && this.tabs.has(tabId)) {
        this.stopJsonlWatch(tabId);
        this.tabs.delete(tabId);
        this.orchestrationPendingLaunches.delete(tabId);
        this.jobEventAt.delete(tabId);
        this.modelWatch.forget(tabId);
        this.codexLifecycleEpoch.delete(tabId);
        this.stuckNudgedTabs.delete(tabId);
        this.transcriptFallbackLogged.delete(tabId);
        this.inactiveSeenAt.delete(tabId);
        this.inactiveSince.delete(tabId);
        this.pollBoundSessions.delete(tabId);
        this.sessionBindingEpoch.delete(tabId);
        this.processStartCache.delete(tabId);
        this.clearPendingKickoff(tabId);
        this.broadcastRemove(tabId);
      }
    }

    const newInterval = this.getPollingInterval();
    if (this.pollingTimer && newInterval !== this.currentInterval) {
      this.startPolling();
    }

    await this.runWatchdogTimers(Date.now()).catch((err) => {
      log.warn(`watchdog timers failed: ${err instanceof Error ? err.message : err}`);
    });

    await this.runOrchestratorKeeper().catch((err) => {
      log.warn(`orchestrator keeper failed: ${err instanceof Error ? err.message : err}`);
    });

    await getLivenessManager().tick((event) => {
      this.handleLivenessEvent(event).catch((err) => {
        log.warn(`liveness event handling failed: ${err instanceof Error ? err.message : err}`);
      });
    }).catch((err) => {
      log.warn(`liveness tick failed: ${err instanceof Error ? err.message : err}`);
    });

    await getLeaseSweeper().sweep().catch((err) => {
      log.warn(`lease sweep failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  /**
   * A WAITING worker sits at an empty composer: its turn ended on a stop from
   * the current process and only its background work runs. `tab send` may
   * paste into it (ADR-0018, architect ruling A′). Only while that stop is
   * still the latest event, and no agent launch has happened since it — a
   * relaunched TUI is booting, the race ADR-0008's composer gate exists for.
   */
  isWaitingAtPrompt(tabId: string): boolean {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.cliState !== 'busy') return false;
    const turnEnd = entry.turnEnd;
    const stop = entry.lastEvent;
    if (turnEnd?.kind !== 'waiting' || stop?.name !== 'stop' || turnEnd.seq !== stop.seq) return false;
    return (entry.lastResumeOrStartedAt ?? 0) < stop.at;
  }

  getTabAgentState(tabId: string): ITabAgentState | null {
    const entry = this.tabs.get(tabId);
    return entry ? { cliState: entry.cliState, isAgent: isAgentPanelType(entry.panelType) } : null;
  }

  /**
   * Report the tab's dead registered jobs before its stall is judged. True when
   * one was reported now or is dead and not yet reportable (its exit file is in
   * its grace): either way the stall check waits for a later pass.
   */
  private async reportDeadJobs(tabId: string): Promise<boolean> {
    try {
      const { reported, pendingDead } = await getLivenessManager().reconcileJobs(tabId, (event) => {
        this.handleLivenessEvent(event).catch((err) => {
          log.warn(`liveness event handling failed: ${err instanceof Error ? err.message : err}`);
        });
      });
      return reported + pendingDead > 0;
    } catch (err) {
      hookLog.debug({ tabId, err: String(err) }, 'registered job reconcile failed');
      return false;
    }
  }

  // Milestone watchers are silent during both success-in-progress and total
  // failure; these events are the freshness watcher that tells them apart.
  private async handleLivenessEvent(event: TLivenessEvent): Promise<void> {
    const src = 'probe' in event ? event.probe : event.job;
    if ('job' in event) this.jobEventAt.set(src.tabId, Date.now());
    // The close reaps the tab's registered jobs: their exit is the close, not a failure (L38).
    if (this.isRetired(src.tabId)) {
      log.info({ tabId: src.tabId, kind: event.kind }, 'liveness event dropped: its tab is being closed');
      return;
    }
    const entry = this.tabs.get(src.tabId);
    const tabName = entry?.tabName ?? '';

    let kind: TOrchestrationNudgeKind;
    let detail: string;
    if (event.kind === 'stalled') {
      kind = 'stalled';
      detail = `probe "${event.probe.label}" reports no progress for ~${Math.round(event.ageS / 60)} min (threshold ${Math.round(event.probe.stalenessThresholdS / 60)} min)`;
    } else if (event.kind === 'probe-failed') {
      kind = 'probe-failed';
      detail = `probe "${event.probe.label}" failed ${event.failures}x in a row — last error: ${event.error}`;
    } else {
      kind = event.kind;
      const label = event.job.label ? `"${event.job.label}" ` : '';
      const code = 'exitCode' in event ? `code ${event.exitCode}` : 'unknown exit code';
      detail = `${label}pid ${event.job.pid} exited with ${code}${event.stderrTail ? `; stderr tail:\n${event.stderrTail}` : ''}`;
    }

    const episode = 'job' in event
      ? `pid:${event.job.pid}`
      : event.kind === 'stalled' ? `probe:${event.probe.label}:age:${event.ageS}` : `probe:${event.probe.label}:failures:${event.failures}`;
    const delivered = await this.nudgeLiveness(src.workspaceId, src.tabId, tabName, kind, detail, 'job' in event ? event.job.notify : undefined, episode);

    if (event.kind === 'bg-completed') return;
    // A `--notify self` job whose known failure reached the tab that registered it is that tab's to
    // act on (a red gate in a TDD loop): it escalates through its own turn-end marker (ADR-0018) to a
    // live agent that also gets its `stuck` nudge if it hangs. Paging the human for each one would bury
    // the page that matters (story 34, consult ruling A) — but only when the tab can carry it on.
    if (event.kind === 'bg-failed' && event.job.notify === 'self' && delivered && await this.carriesSelfFailure(src.tabId, entry)) {
      // The wake starts a new episode: re-arm the once-per-wait stuck nudge, which this skip relies
      // on if the woken tab hangs (story 34 CONFIRM).
      this.stuckNudgedTabs.delete(src.tabId);
      return;
    }

    // Registering a probe or pid is an explicit opt-in to being watched, so a firing reaches the human
    // too (push), regardless of alert policy — an escalation that only lands in a log is not an
    // escalation. The one exception is above: a self-notified failure its own tab received and can
    // carry on. A job that vanished (`bg-exited-unknown`), a stall, a failing probe, an
    // orchestrator-notified job and any self-notice that was NOT delivered (e.g. a tab halted by a
    // usage limit) or reached a tab that cannot carry it on still page.
    const ws = await getWorkspaceByIdCached(src.workspaceId);
    await this.dispatchAlert({
      kind: event.kind === 'bg-exited-unknown' ? 'bg-job-unknown' : 'job' in event ? 'bg-job-died' : 'work-stalled',
      tabId: src.tabId,
      workspace: ws,
      workspaceId: src.workspaceId,
      tabName,
      providerId: toAlertProvider(entry?.agentProviderId),
      agentSessionId: entry?.agentSessionId,
      detail,
    });
  }

  /**
   * Whether a tab that received its own job's failure can carry it on without a page (story 34
   * reviews r1, r2): the tab is a live agent — a shell would run the notice and an exited agent never
   * reads it, though tmux accepts the keys for both — and so is its escalation target, which gets
   * both its turn-end marker and its `stuck` nudge. The alert policy is no substitute: the human's
   * stall alert runs only for an idle orchestrator, so a woken tab that hung would reach no one.
   */
  private async carriesSelfFailure(tabId: string, entry: ITabStatusEntry | undefined): Promise<boolean> {
    const liveAgent = (e: ITabStatusEntry | undefined): e is ITabStatusEntry =>
      !!e && isAgentPanelType(e.panelType) && e.cliState !== 'inactive' && e.cliState !== 'unknown';
    if (!liveAgent(entry)) return false;
    const ws = await getWorkspaceByIdCached(entry.workspaceId);
    const target = ws ? this.escalationTarget(tabId, entry, ws) : null;
    const targetEntry = target ? this.tabs.get(target) : undefined;
    // An orchestrator id is stored as given; one naming another workspace's tab would drop the
    // escalation (the dispatcher looks only in this workspace) — review r3.
    return liveAgent(targetEntry) && targetEntry.workspaceId === entry.workspaceId;
  }

  /**
   * Where a tab's turn-end escalation goes (ADR-0018): its live `reportsTo`, else the enabled
   * orchestrator when that is another tab. A target halted by a usage limit would have the nudge
   * withheld and dropped, so it counts as no target and an escalation falls back to the human
   * (story 26 review r2).
   */
  private escalationTarget(tabId: string, entry: ITabStatusEntry, ws: IWorkspace): string | null {
    const orch = ws.orchestration;
    const target = this.liveReportsTo(tabId, entry)
      ?? (orch?.enabled && orch.orchestratorTabId && orch.orchestratorTabId !== tabId ? orch.orchestratorTabId : null);
    return target && !this.isHaltedByUsageLimit(target) ? target : null;
  }

  /** The tab's `reportsTo` while that tab is live in the same workspace (ADR-0018). */
  private liveReportsTo(tabId: string, entry: ITabStatusEntry | undefined): string | null {
    const target = entry?.reportsTo;
    if (!target || target === tabId) return null;
    const targetEntry = this.tabs.get(target);
    return targetEntry && targetEntry.workspaceId === entry.workspaceId && isAgentPanelType(targetEntry.panelType)
      ? target
      : null;
  }

  // Unlike nudgeOrchestrator this may target the registering tab itself: when
  // the workspace has no orchestrator (or the orchestrator IS the registrant),
  // the tab whose work died is the actor that must wake up. `notify: 'self'`
  // asks for exactly that, so a worker wakes on its own gate.
  private async nudgeLiveness(
    workspaceId: string,
    tabId: string,
    tabName: string,
    kind: TOrchestrationNudgeKind,
    detail: string,
    notify: TBackgroundJobNotify | undefined,
    /** What triggered it (a job's pid, a probe's reading), for the duplicate filter. */
    episode: string,
  ): Promise<boolean> {
    const now = Date.now();
    // Sources deduplicate their own episodes. Debouncing by tab/kind here
    // drops independent jobs that finish on the same tab close together.

    const ws = await getWorkspaceByIdCached(workspaceId);
    const orch = ws?.orchestration;
    const targetTabId = notify === 'self'
      ? tabId
      : this.liveReportsTo(tabId, this.tabs.get(tabId))
        ?? (orch?.enabled && orch.orchestratorTabId ? orch.orchestratorTabId : tabId);
    if (!this.admitNudge(tabId, targetTabId, kind, episode, now)) return true;
    const message = buildNudgeMessage(kind, tabId, tabName, workspaceId, detail);
    const delivered = await this.deliverAutomatedPrompt(workspaceId, targetTabId, message, 'liveness nudge');

    const nudge: IOrchestrationNudge = {
      id: nanoid(8),
      workspaceId,
      tabId,
      tabName,
      kind,
      message,
      at: now,
      delivered,
    };
    this.orchestrationNudges.push(nudge);
    if (this.orchestrationNudges.length > MAX_NUDGE_HISTORY) {
      this.orchestrationNudges.splice(0, this.orchestrationNudges.length - MAX_NUDGE_HISTORY);
    }
    this.broadcast({ type: 'orchestration:nudge', nudge });
    log.info({ tabId, kind, targetTabId, delivered }, 'liveness nudge');
    return delivered;
  }

  // 워커는 상태 전환 훅이 깨워주지만, 워커가 하나도 없을 때 orchestrator가
  // idle로 잠들면 아무것도 깨우지 못한다 — 그 유일한 사각을 keeper가 메운다.
  private async runOrchestratorKeeper(): Promise<void> {
    await this.runOrchestratorPresence().catch((err) => {
      log.warn(`orchestrator presence refresh failed: ${err instanceof Error ? err.message : err}`);
    });
    const workspaceData = await getWorkspacesCached();
    if (!workspaceData) return;
    const workspaces = workspaceData.workspaces;
    const now = Date.now();
    for (const ws of workspaces) {
      const orch = ws.orchestration;
      if (!orch?.enabled || !orch.orchestratorTabId) { this.orchKeeper.delete(ws.id); continue; }
      if (this.standups.get(ws.id)?.state === 'awaiting-human') { this.orchKeeper.delete(ws.id); continue; }
      const entry = this.tabs.get(orch.orchestratorTabId);
      if (!entry) { this.orchKeeper.delete(ws.id); continue; }

      const state = this.orchKeeper.get(ws.id) ?? { idleSince: null, beats: 0, lastBeatAt: 0, stallAlerted: false };
      const workersActive = [...this.tabs.entries()].some(([id, t]) =>
        id !== orch.orchestratorTabId && t.workspaceId === ws.id
        && isAgentPanelType(t.panelType)
        && (t.cliState === 'busy' || t.cliState === 'needs-input' || t.cliState === 'ready-for-review'));

      // busy = working; needs-input = waiting on the HUMAN (the alert already fired) — do not nag.
      if (entry.cliState === 'busy' || entry.cliState === 'needs-input' || workersActive) {
        this.orchKeeper.set(ws.id, { idleSince: null, beats: 0, lastBeatAt: 0, stallAlerted: false });
        continue;
      }
      if (entry.cliState !== 'idle' && entry.cliState !== 'ready-for-review') continue;
      // A usage-limit halt is not a stall: no heartbeat is typed and none is counted.
      if (this.isHaltedByUsageLimit(orch.orchestratorTabId)) continue;

      let watchedWorkActive = false;
      const livenessManager = getLivenessManager();
      for (const [tabId, tab] of this.tabs) {
        if (tab.workspaceId !== ws.id) continue;
        const { backgroundJobs } = await livenessManager.statusForTab(tabId);
        if (backgroundJobs.some((job) => job.alive)) {
          watchedWorkActive = true;
          break;
        }
      }
      if (watchedWorkActive) {
        this.orchKeeper.set(ws.id, { idleSince: null, beats: 0, lastBeatAt: 0, stallAlerted: false });
        continue;
      }

      if (state.idleSince === null) {
        this.orchKeeper.set(ws.id, { ...state, idleSince: now });
        continue;
      }
      if (now - state.idleSince < ORCH_IDLE_HEARTBEAT_MS || now - state.lastBeatAt < ORCH_IDLE_HEARTBEAT_MS) continue;
      if (state.beats >= ORCH_MAX_HEARTBEATS) continue;

      const idleMinutes = Math.round((now - state.idleSince) / 60_000);
      const message = buildHeartbeatMessage(idleMinutes, ws.id);
      const delivered = await this.deliverAutomatedPrompt(
        ws.id,
        orch.orchestratorTabId,
        message,
        'orchestrator heartbeat',
      );
      const beats = state.beats + 1;
      // Last heartbeat of the episode: the orchestrator slept through every
      // nudge purplemux can send, so the human is the only one left to ask.
      const stalled = isStallEpisodeEnd(beats, ORCH_MAX_HEARTBEATS, state.stallAlerted);
      this.orchKeeper.set(ws.id, { ...state, beats, lastBeatAt: now, stallAlerted: state.stallAlerted || stalled });
      if (stalled) {
        void this.dispatchStallAlert(ws, entry, orch.orchestratorTabId, idleMinutes).catch((err) => {
          log.warn(`orchestrator stall alert failed: ${err instanceof Error ? err.message : err}`);
        });
      }
      const nudge: IOrchestrationNudge = {
        id: nanoid(8),
        workspaceId: ws.id,
        tabId: orch.orchestratorTabId,
        tabName: entry.tabName,
        kind: 'heartbeat',
        message,
        at: now,
        delivered,
      };
      this.orchestrationNudges.push(nudge);
      if (this.orchestrationNudges.length > MAX_NUDGE_HISTORY) {
        this.orchestrationNudges.splice(0, this.orchestrationNudges.length - MAX_NUDGE_HISTORY);
      }
      this.broadcast({ type: 'orchestration:nudge', nudge });
      log.info({ workspaceId: ws.id, beats, delivered }, 'orchestrator heartbeat');
    }
  }

  private async runOrchestratorPresence(): Promise<void> {
    const monitor = getOrchestratorPresenceMonitor();
    let workspaceById = new Map<string, IWorkspace>();
    await monitor.refresh(async () => {
      const workspaceData = await getWorkspacesCached();
      if (!workspaceData) throw new Error('workspace registry unreadable');
      const workspaces = workspaceData.workspaces;
      workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
      const observedAt = Date.now();
      const leaseEvidence = await readLeaseEvidence(observedAt);
      const statuses = this.getAllForClient();
      const liveness = getLivenessManager();
      const facts = await Promise.all(workspaces.map(async (workspace): Promise<IOrchestratorPresenceFacts> => {
        const [layout, standup, livenessEvidence] = await Promise.all([
          readLayoutFile(resolveLayoutFile(workspace.id)),
          readLatestStandupEvidence(workspace.id),
          readLivenessEvidence(workspace.id),
        ]);
        const layoutTabs = layout ? collectAllTabs(layout.root) : null;
        const tabs = layoutTabs?.map((tab) => ({
          tabId: tab.id,
          tabName: tab.name,
          isAgent: isAgentPanelType(tab.panelType),
          cliState: statuses[tab.id]?.workspaceId === workspace.id ? statuses[tab.id].cliState : null,
        })) ?? null;

        let liveBackgroundTabIds: string[] | null = livenessEvidence.known ? [] : null;
        let backgroundWorkIncomplete = !livenessEvidence.known;
        if (livenessEvidence.known) {
          const pidsByTab = new Map<string, Set<number>>();
          for (const job of livenessEvidence.data.jobs) {
            const pids = pidsByTab.get(job.tabId) ?? new Set<number>();
            pids.add(job.pid);
            pidsByTab.set(job.tabId, pids);
          }
          const readings = await Promise.allSettled([...pidsByTab].map(async ([tabId, registeredPids]) => ({
            tabId,
            registeredPids,
            status: await liveness.statusForTab(tabId),
          })));
          liveBackgroundTabIds = readings.flatMap((reading) => {
            if (reading.status !== 'fulfilled') {
              backgroundWorkIncomplete = true;
              return [];
            }
            if ([...reading.value.registeredPids].some((pid) => (
              !reading.value.status.backgroundJobs.some((job) => job.pid === pid)
            ))) backgroundWorkIncomplete = true;
            return reading.value.status.backgroundJobs.some((job) => (
              reading.value.registeredPids.has(job.pid) && job.alive
            )) ? [reading.value.tabId] : [];
          });
        }

        return {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          orchestration: workspace.orchestration
            ? { enabled: workspace.orchestration.enabled, orchestratorTabId: workspace.orchestration.orchestratorTabId }
            : null,
          epicLeases: !leaseEvidence.known
            ? null
            : leaseEvidence.leases
              .filter((lease) => lease.name.startsWith('epic:') && lease.holder.workspaceId === workspace.id)
              .map((lease) => lease.name),
          standupState: standup.known ? standup.standup?.state ?? null : undefined,
          tabs,
          liveBackgroundTabIds,
          backgroundWorkIncomplete,
        };
      }));
      return { facts, observedAt };
    }, async (issue) => {
      const tabId = issue.designatedTabId ?? '';
      const entry = tabId ? this.tabs.get(tabId) : undefined;
      const workspace = workspaceById.get(issue.workspaceId);
      await this.dispatchAlert({
        kind: 'orchestrator-missing',
        tabId,
        workspace,
        workspaceId: issue.workspaceId,
        tabName: entry?.tabName ?? '',
        providerId: toAlertProvider(entry?.agentProviderId),
        agentSessionId: entry?.agentSessionId,
        detail: issue.reason,
      });
    });
  }

  private async dispatchStallAlert(ws: IWorkspace, entry: ITabStatusEntry, tabId: string, idleMinutes: number): Promise<void> {
    if (!shouldAlert({ id: tabId }, ws, await getConfig())) return;
    await this.dispatchAlert({
      kind: 'orchestrator-stalled',
      tabId,
      workspace: ws,
      workspaceId: ws.id,
      tabName: entry.tabName,
      providerId: toAlertProvider(entry.agentProviderId),
      agentSessionId: entry.agentSessionId,
      detail: `Idle ~${idleMinutes} min with no worker activity after ${ORCH_MAX_HEARTBEATS} heartbeats.`,
    });
  }

  /** The server-only facts the fleet status panel reads (ADR-0023): read only, no side effect. */
  fleetFacts(tabId: string): { jsonlPath: string | null; stallReportedAt: number | null; inactiveSince: number | null } | null {
    const entry = this.tabs.get(tabId);
    if (!entry) return null;
    return {
      jsonlPath: entry.jsonlPath ?? null,
      stallReportedAt: this.stuckNudgedTabs.get(tabId) ?? null,
      inactiveSince: entry.cliState === 'inactive' ? this.inactiveSince.get(tabId) ?? null : null,
    };
  }

  getAllForClient(): Record<string, IClientTabStatusEntry> {
    const result: Record<string, IClientTabStatusEntry> = {};
    for (const [tabId, entry] of this.tabs) {
      result[tabId] = {
        cliState: entry.cliState,
        workspaceId: entry.workspaceId,
        tabName: entry.tabName,
        currentProcess: entry.currentProcess,
        paneTitle: entry.paneTitle,
        panelType: entry.panelType,
        terminalStatus: entry.terminalStatus,
        listeningPorts: entry.listeningPorts,
        agentProviderId: entry.agentProviderId,
        agentSummary: entry.agentSummary,
        lastUserMessage: entry.lastUserMessage,
        lastAssistantMessage: entry.lastAssistantMessage,
        currentAction: entry.currentAction,
        readyForReviewAt: entry.readyForReviewAt,
        busySince: entry.busySince,
        dismissedAt: entry.dismissedAt,
        agentSessionId: entry.agentSessionId,
        compactingSince: entry.compactingSince,
        permissionRequest: entry.permissionRequest,
        lastEvent: entry.lastEvent,
        eventSeq: entry.eventSeq,
        turnEnd: entry.turnEnd ?? null,
      };
    }
    return result;
  }

  private applyCliState(
    tabId: string,
    entry: ITabStatusEntry,
    newState: TCliState,
    /** `nudge: null` keeps the human alert and sends the orchestrator nothing (a stop with no end line, L49). */
    opts: { silent?: boolean; nudge?: { kind: TOrchestrationNudgeKind; detail: string } | null } = {},
  ): void {
    const prevState = entry.cliState;
    if (prevState === newState) {
      this.reconcileJsonlWatch(tabId, entry);
      return;
    }
    const prevBusySince = entry.busySince;
    entry.cliState = newState;
    // The agent process is gone: its halt went with it.
    if (newState === 'inactive' && entry.turnError?.class === 'usage-limit') this.closeTurnErrorEpisode(entry, 'agent-exited');
    entry.readyForReviewAt = newState === 'ready-for-review' ? Date.now() : null;
    entry.busySince = newState === 'busy' ? Date.now() : null;
    if (newState === 'inactive') this.inactiveSince.set(tabId, Date.now());
    else this.inactiveSince.delete(tabId);
    if (newState === 'busy') entry.dismissedAt = null;
    if (prevState === 'needs-input' && newState !== 'needs-input' && entry.permissionRequest) {
      entry.permissionRequest = null;
    }

    if (newState === 'ready-for-review' && entry.jsonlPath) {
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      delay(500).then(() => this.saveSessionHistory(tabId, entry, prevBusySince, false)).catch((err) => {
        log.warn('Failed to save session history: %s', err);
      });
    }

    if (newState === 'ready-for-review' && !opts.silent) {
      void this.dispatchTransitionAlert(tabId, entry, 'review');
    }

    if (newState === 'needs-input' && !opts.silent) {
      void this.dispatchTransitionAlert(tabId, entry, 'needs-input');
    }

    this.reconcileJsonlWatch(tabId, entry);

    if (newState !== 'busy') this.stuckNudgedTabs.delete(tabId);
    if (newState === 'idle' && this.pendingKickoffs.has(tabId)) {
      this.deliverKickoff(tabId);
    }
    const nudgeKind = opts.nudge === null ? null : nudgeKindForTransition(prevState, newState, !!opts.silent);
    if (nudgeKind) {
      const nudge = opts.nudge && !opts.silent ? opts.nudge : { kind: nudgeKind, detail: undefined };
      this.nudgeOrchestrator(tabId, entry, nudge.kind, nudge.detail).catch((err) => {
        log.warn(`orchestrator nudge failed: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  // Every channel — web push, the status socket, and the client-side Electron
  // and toast hooks — asks alert-policy the same question. See docs/STATUS.md.
  private async dispatchTransitionAlert(tabId: string, entry: ITabStatusEntry, kind: 'review' | 'needs-input'): Promise<void> {
    try {
      const ws = await getWorkspaceByIdCached(entry.workspaceId);
      if (!shouldAlert({ id: tabId }, ws, await getConfig())) return;
      await this.dispatchAlert({
        kind,
        tabId,
        workspace: ws,
        workspaceId: entry.workspaceId,
        tabName: entry.tabName,
        providerId: toAlertProvider(entry.agentProviderId),
        agentSessionId: entry.agentSessionId,
        lastUserMessage: entry.lastUserMessage,
      });
    } catch (err) {
      log.warn('Alert dispatch failed: %s', err);
    }
  }

  private async dispatchAlert(params: {
    kind: TAlertKind;
    tabId: string;
    workspace: IWorkspace | undefined;
    workspaceId: string;
    tabName: string;
    providerId: TAlertProviderId;
    agentSessionId?: string | null;
    lastUserMessage?: string | null;
    headline?: string | null;
    detail?: string | null;
  }): Promise<void> {
    const draft = alertFor({
      kind: params.kind,
      tabId: params.tabId,
      workspaceId: params.workspaceId,
      workspaceName: params.workspace?.name ?? '',
      tabName: params.tabName,
      providerId: params.providerId,
      isOrchestrator: isOrchestratorTab({ id: params.tabId }, params.workspace),
      at: Date.now(),
      lastUserMessage: params.lastUserMessage,
      headline: params.headline,
      detail: params.detail,
    });
    await getNotificationDispatcher().dispatch(draft, {
      agentSessionId: params.agentSessionId ?? null,
      workspaceDir: params.workspace?.directories[0] ?? null,
    });
  }

  /**
   * Feed one mutating tool call to the signal engine.
   *
   * Runs on every Edit/Write/Bash a worker makes, so it must stay allocation-
   * light and must never await the layout on the hot path — scope and cwd come
   * from a short-lived cache instead.
   */
  handleToolActivity(providerId: string, tmuxSession: string, activity: IToolActivity, replayedAt?: number): void {
    // Tool activity is signal history, so a replay feeds it whatever the tab's
    // latest event; only one past the replay window could fire a stale signal.
    if (replayedAt !== undefined && Date.now() - replayedAt > HOOK_REPLAY_WINDOW_MS) return;
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) return;
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    const expectedProvider = getProviderByPanelType(entry.panelType);
    if (expectedProvider && expectedProvider.id !== providerId) return;

    const meta = this.tabScopeCache.get(tabId);
    if (!meta || Date.now() - meta.at > TAB_SCOPE_TTL_MS) {
      // Refresh out of band; this call uses whatever is cached, including
      // nothing on the very first tool call of a tab.
      this.refreshTabScope(tabId, entry).catch(() => {});
    }
    getSignalEngine().record(tabId, activity, meta?.scope, meta?.cwd);
  }

  private async refreshTabScope(tabId: string, entry: ITabStatusEntry): Promise<void> {
    const layout = await readLayoutFile(resolveLayoutFile(entry.workspaceId));
    if (!layout) return;
    const tab = collectAllTabs(layout.root).find((t) => t.id === tabId);
    this.tabScopeCache.set(tabId, { scope: tab?.scope, cwd: tab?.cwd, at: Date.now() });
  }

  private deliverSignal(signal: IAgentSignal): void {
    const entry = this.tabs.get(signal.tabId);
    if (!entry) return;
    const evidence = signal.evidence.length ? ` (${signal.evidence.join(', ')})` : '';
    // The signal engine keeps its own per-kind cooldown; its fire time is the episode.
    this.nudgeOrchestrator(signal.tabId, entry, signal.kind, `${signal.detail}${evidence}`, `signal:${signal.at}`).catch((err) => {
      log.warn(`signal nudge failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  /** Nudge the tab's target; false when it has none (no reportsTo, no other orchestrator). */
  /**
   * `episode` names what triggered the nudge, for the 60 s duplicate filter
   * (review r1 finding 3); by default the tab's latest hook event, which every
   * transition, stop and stuck check follows.
   */
  private async nudgeOrchestrator(
    tabId: string,
    entry: ITabStatusEntry,
    kind: TOrchestrationNudgeKind,
    detail?: string,
    episode = `seq:${entry.lastEvent?.seq ?? 'none'}`,
  ): Promise<boolean> {
    if (!isAgentPanelType(entry.panelType)) return false;
    // A tab being closed raises nothing: the close is deliberate (L38).
    if (this.isRetired(tabId)) {
      log.info({ tabId, kind }, 'orchestrator nudge dropped: its tab is being closed');
      return false;
    }
    const ws = await getWorkspaceByIdCached(entry.workspaceId);
    if (!ws) return false;
    const targetTabId = this.escalationTarget(tabId, entry, ws);
    if (!targetTabId) return false;

    const now = Date.now();
    if (!this.admitNudge(tabId, targetTabId, kind, episode, now)) return true;
    const message = buildNudgeMessage(kind, tabId, entry.tabName, ws.id, detail);
    const delivered = await this.deliverAutomatedPrompt(ws.id, targetTabId, message, 'orchestrator nudge');

    const nudge: IOrchestrationNudge = {
      id: nanoid(8),
      workspaceId: ws.id,
      tabId,
      tabName: entry.tabName,
      kind,
      message,
      at: now,
      delivered,
    };
    this.orchestrationNudges.push(nudge);
    if (this.orchestrationNudges.length > MAX_NUDGE_HISTORY) {
      this.orchestrationNudges.splice(0, this.orchestrationNudges.length - MAX_NUDGE_HISTORY);
    }
    this.broadcast({ type: 'orchestration:nudge', nudge });
    log.info({ tabId, kind, targetTabId, delivered }, 'orchestrator nudge');
    return true;
  }

  /**
   * The one filter both nudge paths share (L49, review r1 finding 3): the same
   * episode of the same class from the same tab to the same recipient within
   * 60 s is dropped and counted.
   */
  private admitNudge(tabId: string, targetTabId: string, kind: TOrchestrationNudgeKind, episode: string, now: number): boolean {
    if (this.nudgeDedupe.admit({ sourceTabId: tabId, recipientTabId: targetTabId, kind, episode }, now)) return true;
    log.info({ tabId, kind, targetTabId, episode, deduplicated: this.nudgeDedupe.dropped }, 'nudge deduplicated: the same episode was nudged within 60 s');
    return false;
  }

  /** How many nudges the 60 s duplicate filter dropped since the server started. */
  getNudgeDedupeCount(): number {
    return this.nudgeDedupe.dropped;
  }

  getOrchestrationNudges(workspaceId: string): IOrchestrationNudge[] {
    return this.orchestrationNudges.filter((n) => n.workspaceId === workspaceId);
  }

  async reportStandup(standup: IWorkspaceStandup): Promise<void> {
    const current = this.standups.get(standup.workspaceId);
    if (current && current.at > standup.at) return;
    this.standups.set(standup.workspaceId, standup);
    await addStandup(standup).catch((err) => {
      log.warn(`standup persist failed: ${err instanceof Error ? err.message : err}`);
    });
    this.broadcast({ type: 'standup:update', standup });
    log.info({ workspaceId: standup.workspaceId, state: standup.state, needsHuman: standup.needsHuman }, 'standup tick');

    void this.dispatchStandupAlert(standup).catch((err) => {
      log.warn(`standup alert failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  // A standup that needs a human is the orchestrator asking for you, so the
  // alert is addressed to the orchestrator tab rather than to whoever ticked.
  private async dispatchStandupAlert(standup: IWorkspaceStandup): Promise<void> {
    const ws = await getWorkspaceByIdCached(standup.workspaceId);
    const tabId = standupAlertTabId(standup, ws, await getConfig());
    if (!tabId) return;

    const entry = this.tabs.get(tabId);
    await this.dispatchAlert({
      kind: 'standup-needs-human',
      tabId,
      workspace: ws,
      workspaceId: standup.workspaceId,
      tabName: entry?.tabName ?? '',
      providerId: toAlertProvider(entry?.agentProviderId),
      agentSessionId: entry?.agentSessionId,
      headline: standup.headline,
    });
  }

  getStandupsForClient(): Record<string, IWorkspaceStandup> {
    return Object.fromEntries(this.standups);
  }

  queueKickoffPrompt(tabId: string, prompt: string): void {
    this.clearPendingKickoff(tabId);
    const timer = setTimeout(() => this.deliverKickoff(tabId), KICKOFF_FALLBACK_DELAY_MS);
    this.pendingKickoffs.set(tabId, { prompt, timer });
  }

  private clearPendingKickoff(tabId: string): void {
    const pending = this.pendingKickoffs.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingKickoffs.delete(tabId);
  }

  // TUI가 뜬 직후 붙여넣으면 입력이 유실될 수 있어 800ms 정착 후 전송한다.
  private deliverKickoff(tabId: string): void {
    const pending = this.pendingKickoffs.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingKickoffs.delete(tabId);
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    setTimeout(() => {
      void this.deliverAutomatedPrompt(
        entry.workspaceId,
        tabId,
        pending.prompt,
        'kickoff prompt',
      );
    }, 800);
  }

  private async deliverAutomatedPrompt(
    workspaceId: string,
    targetTabId: string,
    message: string,
    context: string,
  ): Promise<boolean> {
    // A usage-limit halt is never typed into, by any automated path (story 26).
    if (this.isHaltedByUsageLimit(targetTabId)) {
      log.info({ targetTabId, context }, 'automated prompt withheld: target halted by a usage limit');
      return false;
    }
    const result = await this.automatedPrompts.dispatch({ workspaceId, targetTabId, message });
    if (!result.delivered && result.error) {
      log.warn(`${context} delivery failed: ${result.error instanceof Error ? result.error.message : result.error}`);
    }
    return result.delivered;
  }

  /**
   * A tab busy past BUSY_STUCK_MS is stalled when its transcript has been quiet
   * that long — unless it waits on its own background work, which is judged by
   * that work's activity and kind (ADR-0018, L19, L25): the main transcript
   * alone is silent while a subagent or a gate waiter runs. A live registered
   * job or an armed watch holds the tab off STALLED altogether (L49), but only
   * while the tab WAITS on it: its latest event is the stop classified
   * `waiting`. A tab busy past a newer event is mid-turn, so a job that happens
   * to be alive says nothing about it; it keeps the staleness rule (review r2
   * nit 3: an agent hung in a foreground tool next to a live server).
   */
  private async looksStalled(tabId: string, entry: ITabStatusEntry, now: number): Promise<boolean> {
    const waitingOnStop = entry.turnEnd?.kind === 'waiting' && entry.lastEvent?.name === 'stop'
      && entry.turnEnd.seq === entry.lastEvent.seq;
    if (waitingOnStop && holdsOffStall(await this.liveRegisteredJobs(tabId), await this.armedWatches(entry.workspaceId, tabId))) return false;
    // A job that just reported its exit told its recipient what happened; the
    // tab gets the no-open window from that report before it can be STALLED.
    const jobEvent = this.jobEventAt.get(tabId);
    if (jobEvent !== undefined && now - jobEvent < BUSY_STUCK_MS) return false;
    const handle = this.runtimeHandle(entry);
    const provider = entry.agentProviderId ? getProvider(entry.agentProviderId) : getProviderByPanelType(entry.panelType);
    let snapshot: IAgentRuntimeSnapshot | null = null;
    if (handle && provider) {
      try {
        snapshot = await provider.readRuntimeSnapshot(handle, {
          tasksSince: await this.agentProcessStartedAt(tabId, entry),
          withBackground: true,
          withActivity: true,
        });
      } catch {
        snapshot = null;
      }
    }
    const kinds = snapshot?.openBackgroundTaskKinds ?? { shell: 0, agent: 0, monitor: 0 };
    // The stop the tab waits from is itself a sign of life.
    const activityAt = Math.max(
      snapshot?.lastEntryTs ?? -Infinity,
      snapshot?.backgroundActivityAt ?? -Infinity,
      entry.lastEvent?.at ?? -Infinity,
    );
    const waitVerdict = isBackgroundWaitStalled(kinds, Number.isFinite(activityAt) ? activityAt : null, now);
    if (!snapshot) return waitVerdict ?? true;
    if (waitVerdict !== null) return waitVerdict;
    return !(snapshot.lastEntryTs !== null && now - snapshot.lastEntryTs < BUSY_STUCK_MS);
  }

  /**
   * A turn that ended on a provider error (story 26, ADR-0018 amendment).
   * `api-error`: the worker is resumed ONCE through the inbox (composer gate,
   * bounded) and no one is nudged; a second failure in the same episode, or a
   * resume notice the inbox holds, nudges the target once. `usage-limit`:
   * nothing is ever typed (typing cancels the provider's auto-continue); the
   * target is nudged once. A clean stop ends the episode.
   */
  private applyTurnError(tabId: string, entry: ITabStatusEntry, error: ITurnError, stopSeq: number | undefined): void {
    const at = Date.now();
    entry.turnEnd = { kind: error.class === 'usage-limit' ? 'usage-limit' : 'api-error', at, seq: stopSeq };
    if (entry.cliState !== 'ready-for-review') {
      this.applyCliState(tabId, entry, 'ready-for-review', { silent: true });
      this.persistToLayout(entry);
    }
    this.broadcastUpdate(tabId, entry);

    const episode = entry.turnError?.class === error.class ? entry.turnError : null;
    // A stop on a tab already ready-for-review is classified since review r1, so the
    // same failed turn can arrive twice; only a NEW failed turn is a second failure.
    if (episode && error.turnId && episode.turnId === error.turnId) {
      hookLog.debug({ tabId, turnId: error.turnId }, 'repeated stop of the same failed turn: ignored');
      return;
    }
    if (episode) episode.turnId = error.turnId || episode.turnId;
    if (!episode) this.closeTurnErrorEpisode(entry, `episode-closed:${error.class}`);
    if (error.class === 'usage-limit') {
      if (episode) return;
      entry.turnError = { class: 'usage-limit', code: error.code, text: error.text, startedAt: at, resumeItemId: null, escalated: true, turnId: error.turnId };
      this.escalateTurnError(tabId, entry, 'usage-limit', error.text || error.code);
      return;
    }
    if (episode) {
      if (!episode.escalated) {
        episode.escalated = true;
        this.withdrawResume(episode, 'episode-escalated');
        this.escalateTurnError(tabId, entry, 'api-error', error.text || error.code);
      }
      return;
    }
    const next: ITurnErrorEpisode = { class: 'api-error', code: error.code, text: error.text, startedAt: at, resumeItemId: null, escalated: false, turnId: error.turnId };
    entry.turnError = next;
    enqueueNotice({
      kind: 'resume',
      targetWorkspaceId: entry.workspaceId,
      targetTabId: tabId,
      dedupeKey: `resume-${tabId}-${error.turnId || at}`,
      fields: { resumeId: `r-${nanoid(8)}` },
    }).then(({ item }) => {
      next.resumeItemId = item.id;
      // The episode ended while the resume was being queued: withdraw it.
      if (entry.turnError !== next || next.escalated) {
        this.withdrawResume(next, 'episode-closed');
        return;
      }
      log.info({ tabId, resume: item.id, code: error.code }, 'api-error stop: one resume queued');
    }).catch((err) => {
      // No resume can go out, so the episode escalates at once.
      log.warn(`api-error resume could not be queued for ${tabId}: ${err instanceof Error ? err.message : err}`);
      if (entry.turnError === next && !next.escalated) {
        next.escalated = true;
        this.escalateTurnError(tabId, entry, 'api-error', `${error.text || error.code} (the resume could not be queued)`);
      }
    });
  }

  /**
   * Tell the tab's target. When there is none (the orchestrator itself, no
   * orchestrator and no reportsTo, or a target that is itself halted, whose
   * nudge would be withheld and dropped), the human is alerted directly,
   * whatever the alert policy: an escalation that reaches no one is not one.
   */
  private escalateTurnError(tabId: string, entry: ITabStatusEntry, kind: 'api-error' | 'usage-limit', detail: string): void {
    this.nudgeOrchestrator(tabId, entry, kind, detail).then(async (hadTarget) => {
      if (hadTarget) return;
      const ws = await getWorkspaceByIdCached(entry.workspaceId);
      await this.dispatchAlert({
        kind: 'review',
        tabId,
        workspace: ws,
        workspaceId: entry.workspaceId,
        tabName: entry.tabName,
        providerId: toAlertProvider(entry.agentProviderId),
        agentSessionId: entry.agentSessionId,
        detail: `${kind === 'usage-limit' ? 'halted by a usage limit' : 'API error after its one automatic resume'}: ${detail}`,
      });
    }).catch((err) => {
      log.warn(`${kind} nudge failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private withdrawResume(episode: ITurnErrorEpisode, reason: string): void {
    const id = episode.resumeItemId;
    if (!id) return;
    withdrawNotice(id, reason).then((withdrawn) => {
      if (withdrawn) log.info({ resume: id, reason }, 'resume withdrawn');
    }).catch((err) => log.warn(`resume ${id} could not be withdrawn: ${err instanceof Error ? err.message : err}`));
  }

  private closeTurnErrorEpisode(entry: ITabStatusEntry, reason: string): void {
    if (entry.turnError) this.withdrawResume(entry.turnError, reason);
    entry.turnError = null;
  }

  /** True while the tab's last stop was a usage-limit halt: nothing automated types into it. */
  isHaltedByUsageLimit(tabId: string): boolean {
    return this.tabs.get(tabId)?.turnError?.class === 'usage-limit';
  }

  /**
   * The inbox held a resume notice: its episode escalates once. A resume
   * queued before a server restart has no episode in memory; it escalates too,
   * once per notice.
   */
  handleHeldResume(item: IInboxItem): void {
    if (item.kind !== 'resume') return;
    const entry = this.tabs.get(item.targetTabId);
    if (!entry || entry.workspaceId !== item.targetWorkspaceId) return;
    const held = `resume notice ${item.id} held: ${item.heldReason ?? 'undelivered'}`;
    const episode = entry.turnError;
    if (episode?.class === 'api-error' && episode.resumeItemId === item.id) {
      if (episode.escalated) return;
      episode.escalated = true;
      this.escalateTurnError(item.targetTabId, entry, 'api-error', `${episode.text || episode.code} (${held})`);
      return;
    }
    if (this.orphanResumesEscalated.has(item.id)) return;
    this.orphanResumesEscalated.add(item.id);
    this.escalateTurnError(item.targetTabId, entry, 'api-error', `the last automatic resume could not be delivered (${held})`);
  }

  private async liveRegisteredJobs(tabId: string): Promise<number> {
    try {
      return (await getLivenessManager().statusForTab(tabId)).backgroundJobs.filter((job) => job.alive).length;
    } catch (err) {
      hookLog.debug({ tabId, err: String(err) }, 'registered job read failed');
      return 0;
    }
  }

  /**
   * The `purplemux watch` records this tab owns (ADR-0015). A record stays in the
   * store until its notice is queued, so each one will wake the tab: when its
   * condition holds, when it fails, or when it expires. An unreadable store
   * counts none, which errs toward today's nudges rather than silence.
   */
  private async armedWatches(workspaceId: string, tabId: string): Promise<number> {
    try {
      return (await readWatches()).watches.filter((w) => w.workspaceId === workspaceId && w.tabId === tabId).length;
    } catch (err) {
      hookLog.debug({ tabId, err: String(err) }, 'watch store read failed');
      return 0;
    }
  }

  /** Whether the tab is being closed, or was closed less than CLOSED_RETIRE_MS ago (L38). */
  private isRetired(tabId: string): boolean {
    const until = this.retiredTabs.get(tabId);
    return until !== undefined && until > Date.now();
  }

  /**
   * `tab-closing`: the close reaps the tab's processes next. Retire its liveness
   * checks — the poll's agent-process check, the stuck check, registered-job
   * events — and its pending idle nudge, so the reap raises no INACTIVE and no
   * job failure (L38). `aborted` restores them; `tab-closed` keeps them retired
   * a while longer (`removeTab`).
   */
  handleTabClosing(tabId: string, phase: 'closing' | 'aborted'): void {
    if (phase === 'aborted') {
      this.retiredTabs.delete(tabId);
      log.info({ tabId }, 'tab close aborted: watchdog checks restored');
      return;
    }
    this.retiredTabs.set(tabId, Date.now() + CLOSING_RETIRE_MS);
    this.stuckNudgedTabs.delete(tabId);
    log.info({ tabId }, 'tab closing: watchdog checks retired');
  }

  /** A fleet-config duration (ADR-0019), read at each pass; the default on any problem. */
  private async fleetDurationMs(
    state: Awaited<ReturnType<typeof readFleetConfig>> | null,
    key: string,
    parse: (raw: string) => number | null,
    fallback: number,
  ): Promise<number> {
    const raw = state ? valueOf(state, key)?.value ?? null : null;
    if (raw === null) return fallback;
    const parsed = parse(raw);
    if (parsed === null) log.warn({ key, value: raw }, 'fleet config value out of range; the default applies');
    return parsed ?? fallback;
  }

  /**
   * The watchdog's derived timers, run by every poll (review r1 finding 2: one
   * mechanism, derived from the recorded stop, so a restart neither loses a
   * pending nudge nor repeats a sent one):
   * - `idle-no-end-line`: ONE nudge per markerless stop with nothing live, once
   *   the tab has stayed on that stop for the idle window (L49). Any newer hook
   *   event that counts (a prompt, a stop, a permission request, a session start)
   *   moves `lastEvent` on, so the record no longer matches; a Claude
   *   `idle_prompt` notification does not.
   * - `long-wait`: ONE nudge per WAITING stretch on a live registered job or an
   *   armed watch that outlasts the backstop (review r1 finding 4). A new
   *   classified stop starts a new stretch.
   */
  private async runWatchdogTimers(now: number): Promise<void> {
    let fleet: Awaited<ReturnType<typeof readFleetConfig>> | null = null;
    try {
      fleet = await readFleetConfig();
    } catch (err) {
      log.warn(`fleet config unreadable; watchdog windows stay at their defaults: ${err instanceof Error ? err.message : err}`);
    }
    const idleMs = await this.fleetDurationMs(fleet, IDLE_NUDGE_CONFIG_KEY, parseIdleNudgeMinutes, IDLE_NUDGE_DEFAULT_MS);
    const waitMs = await this.fleetDurationMs(fleet, WAIT_BACKSTOP_CONFIG_KEY, parseWaitBackstopHours, WAIT_BACKSTOP_DEFAULT_MS);
    for (const [tabId, entry] of [...this.tabs]) {
      if (this.isRetired(tabId)) continue;
      if (idleNudgeDue(entry.turnEnd, entry.lastEvent, entry.cliState, idleMs, now)) {
        await this.fireIdleNudge(tabId, entry, now);
      } else if (longWaitDue(entry.turnEnd, entry.lastEvent, entry.cliState, waitMs, now)) {
        await this.fireLongWait(tabId, entry, now);
      }
    }
  }

  private async fireIdleNudge(tabId: string, entry: ITabStatusEntry, now: number): Promise<void> {
    const record = entry.turnEnd!;
    const seq = record.seq!;
    // Marked before any await: a concurrent pass cannot send it twice.
    entry.turnEnd = { ...record, idleNudgeSentSeq: seq };
    this.persistTurnEnd(entry);
    const jobs = await this.liveRegisteredJobs(tabId);
    const watches = await this.armedWatches(entry.workspaceId, tabId);
    if (this.tabs.get(tabId) !== entry || entry.lastEvent?.seq !== seq || this.isRetired(tabId)) return;
    if (jobs > 0 || watches > 0) {
      // The tab waits on registered work now; that work reports its own outcome.
      hookLog.debug({ tabId, jobs, watches }, 'idle nudge skipped: the tab now waits on registered work');
      return;
    }
    // The real time since the stop, which after a restart can exceed the window (review r2 nit 2).
    const minutes = Math.round(((now - record.at) / 60_000) * 100) / 100;
    const detail = `${minutes} min ago${record.transcript === false ? ' (its transcript could not be read, so any end line is unknown)' : ''}`;
    await this.nudgeOrchestrator(tabId, entry, 'idle-no-end-line', detail, `idle:${seq}`);
  }

  private async fireLongWait(tabId: string, entry: ITabStatusEntry, now: number): Promise<void> {
    const record = entry.turnEnd!;
    const seq = record.seq!;
    entry.turnEnd = { ...record, longWaitSentSeq: seq };
    let jobs: Array<{ pid: number; label?: string | null }> = [];
    try {
      jobs = (await getLivenessManager().statusForTab(tabId)).backgroundJobs.filter((job) => job.alive);
    } catch {
      jobs = [];
    }
    let watches: Array<{ id: string; target: string; until: string }> = [];
    try {
      watches = (await readWatches()).watches.filter((w) => w.workspaceId === entry.workspaceId && w.tabId === tabId);
    } catch {
      watches = [];
    }
    if (this.tabs.get(tabId) !== entry || entry.lastEvent?.seq !== seq || this.isRetired(tabId)) return;
    // WAITING on the provider's own tasks alone keeps the 15 / 90 min stall rules instead.
    if (jobs.length === 0 && watches.length === 0) return;
    const hours = Math.round(((now - record.at) / 3_600_000) * 10) / 10;
    const named = [
      ...jobs.map((job) => `job pid ${job.pid}${job.label ? ` "${job.label}"` : ''}`),
      ...watches.map((w) => `watch ${w.id} on ${w.target} until ${w.until}`),
    ].slice(0, 5).join(', ');
    await this.nudgeOrchestrator(tabId, entry, 'long-wait', `${hours} h on ${named}`, `long-wait:${seq}`);
  }

  /**
   * The stop record the idle nudge is derived from survives a restart (finding 2). An end-line
   * stop survives too, so the tab still reads as ended on its line after a restart (ADR-0023).
   */
  private persistTurnEnd(entry: ITabStatusEntry): void {
    const record = entry.turnEnd?.kind === 'ready-for-review' || entry.turnEnd?.kind === 'turn-marker'
      ? { ...entry.turnEnd, agentSessionId: entry.agentSessionId ?? null }
      : null;
    updateTabWatchdogTurnEnd(entry.tmuxSession, record).catch((err) => {
      hookLog.debug({ tmuxSession: entry.tmuxSession, err: String(err) }, 'watchdog turn-end persist failed');
    });
  }

  /**
   * A tab restored at boot from a persisted markerless stop gets that stop back
   * as its latest event, so the poll's idle check applies to it (finding 2) —
   * only when the record belongs to the agent session the tab runs now. A
   * record of another session (the agent was relaunched while the server was
   * down) is dropped, on disk too, so a stale stop is never nudged (r2 nit 2).
   */
  private applyRestoredStop(tab: ITab, entry: ITabStatusEntry): void {
    const record = tab.watchdogTurnEnd;
    if (!record) return;
    // An end-line stop also comes back to a tab dismissed to idle after it; it fires no nudge (the
    // idle nudge reads only a `ready-for-review` record, and the marker nudge only a new stop). An
    // idle tab not dismissed since the stop was prompted and interrupted: that line is stale.
    const dismissedAfterStop = typeof tab.dismissedAt === 'number' && tab.dismissedAt >= record.at;
    const kindFits = record.kind === 'ready-for-review'
      ? entry.cliState === 'ready-for-review'
      : record.kind === 'turn-marker'
        && (entry.cliState === 'ready-for-review' || (entry.cliState === 'idle' && dismissedAfterStop));
    const usable = kindFits
      && Number.isSafeInteger(record.seq) && Number.isFinite(record.at)
      && (record.agentSessionId ?? null) === (entry.agentSessionId ?? null);
    if (!usable) {
      hookLog.debug({ tabId: tab.id, recordSession: record.agentSessionId ?? null, session: entry.agentSessionId ?? null }, 'persisted watchdog stop dropped: not this session\'s latest stop');
      updateTabWatchdogTurnEnd(tab.sessionName, null).catch(() => {});
      return;
    }
    const seq = record.seq!;
    entry.turnEnd = { ...record };
    entry.lastEvent = { name: 'stop', at: record.at, seq };
    entry.eventSeq = seq;
    this.hookFloors.raise(tab.id, record.at);
  }

  /**
   * When the tab's current Claude process started, from its session pid file.
   * Background tasks older than it were orphaned by a restart (`--resume`
   * appends to the same transcript) and never report back. Other providers
   * report no background tasks, so they need no cutoff. Measured 2026-09-26:
   * `startedAt` is milliseconds, 1–3 s after the process start, and never
   * rewritten (`evidence/story-15/pidfile-startedat.txt`). Cached for a minute
   * and dropped on a session start.
   */
  private async agentProcessStartedAt(tabId: string, entry: ITabStatusEntry): Promise<number | null> {
    if (runtimeProviderId(entry.agentProviderId, entry.panelType) !== 'claude') return null;
    const cached = this.processStartCache.get(tabId);
    const now = Date.now();
    const stamp = entry.lastResumeOrStartedAt ?? null;
    if (cached && cached.stamp === stamp && now - cached.checkedAt < PROCESS_START_CACHE_MS) return cached.startedAt;
    let startedAt: number | null = null;
    try {
      const provider = getProviderByPanelType(entry.panelType);
      const panePid = await getSessionPanePid(entry.tmuxSession);
      if (provider && panePid) {
        startedAt = (await provider.detectActiveSession(panePid, undefined, { tmuxSession: entry.tmuxSession })).startedAt ?? null;
      }
    } catch {
      startedAt = null;
    }
    this.processStartCache.set(tabId, { startedAt, checkedAt: now, stamp });
    return startedAt;
  }

  private runtimeHandle(entry: ITabStatusEntry): string | null {
    return runtimeHandleFor(
      runtimeProviderId(entry.agentProviderId, entry.panelType),
      { jsonlPath: entry.jsonlPath, sessionId: entry.agentSessionId },
    );
  }

  private async saveSessionHistory(tabId: string, entry: ITabStatusEntry, prevBusySince: number | null | undefined, cancelled: boolean): Promise<void> {
    if (!entry.lastUserMessage) return;

    const provider = entry.agentProviderId ? getProvider(entry.agentProviderId) : getProviderByPanelType(entry.panelType);
    const handle = this.runtimeHandle(entry);
    const stats = handle && provider
      ? await provider.readSessionHistoryStats(handle)
      : null;
    const { workspaces } = await getWorkspaces();
    const ws = workspaces.find((w) => w.id === entry.workspaceId);
    const now = Date.now();
    const startedAt = stats?.firstUserTs ?? prevBusySince ?? now;
    const completedAt = cancelled ? now : (stats?.lastAssistantTs ?? now);
    const duration = cancelled
      ? completedAt - startedAt
      : (stats?.turnDurationMs ?? (completedAt - startedAt));

    const providerId = toSessionHistoryProvider(entry.agentProviderId);
    const historyEntry: ISessionHistoryEntry = {
      id: nanoid(),
      workspaceId: entry.workspaceId,
      workspaceName: ws?.name ?? entry.workspaceId,
      workspaceDir: ws?.directories[0] ?? null,
      tabId,
      providerId,
      agentSessionId: entry.agentSessionId ?? null,
      prompt: stats?.lastUserText ?? entry.lastUserMessage,
      result: stats?.lastAssistantText ?? null,
      startedAt,
      completedAt,
      duration,
      dismissedAt: completedAt,
      toolUsage: stats?.toolUsage ?? {},
      touchedFiles: stats?.touchedFiles ?? [],
      ...(cancelled ? { cancelled: true } : {}),
    };

    await addSessionHistoryEntry(historyEntry);
    this.broadcast({ type: 'session-history:update', entry: historyEntry });
  }

  dismissTab(tabId: string, exclude?: WebSocket): void {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.cliState !== 'ready-for-review') return;

    const dismissedAt = Date.now();
    this.applyCliState(tabId, entry, 'idle', { silent: true });
    entry.dismissedAt = dismissedAt;
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry, exclude);

    updateSessionHistoryDismissedAt(tabId, dismissedAt).then((updated) => {
      if (updated) this.broadcast({ type: 'session-history:update', entry: updated });
    }).catch((err) => {
      log.warn('Failed to update session history dismissedAt: %s', err);
    });
  }

  ackNotificationInput(tabId: string, seq: number): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    if (entry.cliState !== 'needs-input') return;
    if (entry.lastEvent?.name !== 'notification' || entry.lastEvent.seq !== seq) return;

    hookLog.debug({ tabId, seq }, 'ack: needs-input→busy');
    this.applyCliState(tabId, entry, 'busy');
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry);
  }

  // Codex의 SessionStart hook은 첫 사용자 메시지 후에야 발사된다(turn.rs:299).
  // 그 전엔 cliState가 'inactive'에 머물러 WebInputBar가 비활성화되므로
  // dead state. 3-layer 신호로 composer가 입력 받을 준비됐다고 확신될 때
  // 합성 session-start를 트리거해 idle로 진입시킨다.
  private async checkCodexTuiReady(
    entry: ITabStatusEntry,
    checkAgentRunning: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!(await checkAgentRunning())) return false;

    const content = await capturePaneAtWidth(entry.tmuxSession, 80, 24).catch((err) => {
      log.warn('codex tui ready capture failed: %s', err);
      return null;
    });
    if (!content) return false;
    return isCodexTuiReadyContent(content);
  }

  /**
   * The Claude/Grok readiness fallback (story 17): `inactive` for longer than
   * READINESS_PROBE_AFTER_MS, the agent process running, and the pane showing an
   * empty composer with no option list over it. A trust prompt or a first-run
   * picker is not ready. Never inferred from a persisted `idle` (no process check).
   */
  private async checkAgentPaneReady(
    tabId: string,
    entry: ITabStatusEntry,
    now: number,
    checkAgentRunning: () => Promise<boolean>,
  ): Promise<boolean> {
    // The clock runs only while the agent runs: a tab idling at a shell does not
    // age it, and a relaunch typed at the shell starts it again (review r1: a
    // stale clock probed a booting TUI at +700 ms). A launch through
    // markAgentLaunch is held off by the launch-stamp wait below.
    if (!(await checkAgentRunning())) {
      this.inactiveSeenAt.delete(tabId);
      return false;
    }
    const since = this.inactiveSeenAt.get(tabId);
    if (since === undefined) {
      this.inactiveSeenAt.set(tabId, now);
      return false;
    }
    if (now - since < READINESS_PROBE_AFTER_MS) return false;
    const launch = entry.lastResumeOrStartedAt;
    if (launch !== undefined && now - launch < READINESS_PROBE_AFTER_MS) return false;
    // The pane at its own size: the marker check needs no width, and a resize
    // would pause a narrow viewer on every poll while a trust prompt waits.
    const content = await capturePaneContent(entry.tmuxSession, { escapes: true });
    return !!content && paneShowsEmptyComposer(entry.panelType, content);
  }

  /**
   * After a probe's awaits: the tab is still this entry, still inactive, and no
   * event arrived meanwhile. A prompt-submit or notification in that window must
   * not be overwritten by the synthetic session start (a false turn end).
   */
  private stillInactiveAt(tabId: string, entry: ITabStatusEntry, seq: number | undefined): boolean {
    return this.tabs.get(tabId) === entry && entry.cliState === 'inactive' && entry.eventSeq === seq;
  }

  /** A hook or launch bound the session: the poll no longer owns it, and a write in flight does not reclaim it. */
  private releasePollBinding(tabId: string): void {
    this.pollBoundSessions.delete(tabId);
    this.sessionBindingEpoch.set(tabId, (this.sessionBindingEpoch.get(tabId) ?? 0) + 1);
  }

  /**
   * Persist a session id the poll detected when no hook bound one, so `tab
   * status` / `tab list` show it and it survives a restart (L8: the binding
   * lived in memory only). A hook's or a launch's binding is never overwritten.
   */
  private persistPolledSession(tabId: string, tab: ITab, provider: IAgentProvider | null, jsonlPath: string | null): void {
    const detected = provider?.sessionIdFromJsonlPath(jsonlPath) ?? null;
    if (!provider || !detected) return;
    const persisted = provider.readSessionId(tab);
    if (persisted === detected) return;
    if (persisted && this.pollBoundSessions.get(tabId) !== persisted) return;
    // Ownership is recorded only once the write lands: a failed move leaves the
    // old id in the layout, and the next poll must still be allowed to retry it.
    // A hook or launch binding during the write wins: the epoch moved.
    const epoch = this.sessionBindingEpoch.get(tabId) ?? 0;
    this.updateAgentState(tab.sessionName, provider, { sessionId: detected }).then(() => {
      if ((this.sessionBindingEpoch.get(tabId) ?? 0) !== epoch) return;
      this.pollBoundSessions.set(tabId, detected);
      hookLog.debug({ tabId, sessionId: detected }, 'session id bound by poll — persisted');
    }).catch((err) => {
      log.warn(`poll session persist failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  async recoverUnknownIfPending(tabId: string): Promise<{ recovered: boolean; reason?: string }> {
    const entry = this.tabs.get(tabId);
    if (!entry) return { recovered: false, reason: 'no-entry' };
    if (entry.cliState !== 'unknown') return { recovered: false, reason: 'not-unknown' };

    const content = await capturePaneAtWidth(entry.tmuxSession, 120, 50).catch((err) => {
      log.warn('recoverUnknownIfPending capture failed: %s', err);
      return null;
    });
    if (!content) return { recovered: false, reason: 'capture-failed' };

    const { options } = parsePermissionOptions(content);
    if (options.length === 0) return { recovered: false, reason: 'no-options' };

    const now = Date.now();
    const seq = (entry.eventSeq ?? 0) + 1;
    entry.eventSeq = seq;
    entry.lastEvent = { name: 'notification', at: now, seq };

    hookLog.debug({ tabId, seq, options: options.length }, 'recover unknown→needs-input from pane capture');
    this.applyCliState(tabId, entry, 'needs-input', { silent: true });
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry);
    return { recovered: true };
  }

  private findTabIdBySession(tmuxSession: string): string | undefined {
    for (const [tabId, entry] of this.tabs) {
      if (entry.tmuxSession === tmuxSession) return tabId;
    }
    return undefined;
  }

  /** The agent session a tab's pane is bound to, or null when none is bound (or no tab owns the pane). */
  agentSessionIdForTmuxSession(tmuxSession: string): string | null {
    const tabId = this.findTabIdBySession(tmuxSession);
    return tabId ? this.tabs.get(tabId)?.agentSessionId ?? null : null;
  }

  /**
   * Classify a `stop` before announcing it (ADR-0018). A marker line
   * (`DONE:` …) becomes a `turn-marker` nudge carrying it. No marker and open
   * background work — the provider's own tasks, read from the whole transcript,
   * or a live registered `tab bg` job — is WAITING: the tab stays busy and no
   * nudge goes out, because the harness wakes the worker when the work returns
   * (measured 2026-09-26: 95 of 108 READY nudges in one hour were such waits).
   * Otherwise today's ready-for-review. Any read failure falls back to the
   * plain transition so a broken transcript never hides a real finish.
   */
  private async applyStopTurnEnd(tabId: string, entry: ITabStatusEntry, tmuxSession: string, replayedAt?: number): Promise<void> {
    const stopSeq = entry.lastEvent?.seq;
    // A stop on a tab already ready-for-review makes no transition, so its end
    // line is sent here, unless it repeats the line the tab already reported
    // (a second stop event of the same turn).
    const previous = entry.turnEnd;
    let snapshot: IAgentRuntimeSnapshot | null = null;
    try {
      if (!this.runtimeHandle(entry)) await this.resolveAndWatchJsonl(tabId, tmuxSession);
      const provider = getProviderByPanelType(entry.panelType);
      const handle = this.runtimeHandle(entry);
      if (provider && handle) {
        const read = async () => {
          // A remote tab's copy is brought up to date before each read (ADR-0022).
          await syncRemoteTranscript(tmuxSession).catch(() => false);
          return provider.readRuntimeSnapshot(handle, {
            force: true,
            tasksSince: await this.agentProcessStartedAt(tabId, entry),
            withBackground: true,
          });
        };
        snapshot = await read();
        // The Stop hook can fire before the final entry reaches the file.
        if (!snapshot.idle || !snapshot.lastAssistantTail) {
          await new Promise((resolve) => setTimeout(resolve, STOP_SETTLE_MS));
          snapshot = await read();
        }
      }
    } catch (err) {
      hookLog.debug({ tabId, err: String(err) }, 'turn-end read failed; treating stop as ready');
    }
    const liveRegisteredJobs = await this.liveRegisteredJobs(tabId);
    const armedWatches = await this.armedWatches(entry.workspaceId, tabId);

    const current = this.tabs.get(tabId);
    if (!current || current !== entry) return;
    // A newer event — even a newer stop — owns the tab now.
    if (entry.lastEvent?.name !== 'stop' || entry.lastEvent.seq !== stopSeq) return;
    // Each classified stop opens a new wait: a WAITING chain never leaves busy,
    // so the one-stuck-nudge-per-busy-stretch latch re-arms here.
    this.stuckNudgedTabs.delete(tabId);

    const turnError = snapshot?.lastTurnError ?? null;
    if (turnError && turnError.class !== 'other') {
      this.applyTurnError(tabId, entry, turnError, stopSeq);
      this.persistTurnEnd(entry);
      return;
    }
    // A clean stop (or an unclassified error) ends any error episode, and a
    // resume not yet typed is withdrawn: it would be stale.
    this.closeTurnErrorEpisode(entry, 'episode-closed');

    const turnEnd = classifyTurnEnd({
      tail: snapshot?.lastAssistantTail,
      // An empty snapshot from an unreadable transcript is not a read (story 37).
      transcript: snapshot !== null && snapshot.transcriptRead !== false,
      openBackgroundTasks: snapshot?.openBackgroundTasks ?? 0,
      liveRegisteredJobs,
      armedWatches,
    });
    // A replayed stop ended its turn when it happened, so the idle clocks start there.
    const at = replayedAt ?? Date.now();
    if (turnEnd.kind === 'waiting') {
      entry.turnEnd = {
        kind: 'waiting', at, seq: stopSeq,
        openBackgroundTasks: turnEnd.openBackgroundTasks, liveRegisteredJobs: turnEnd.liveRegisteredJobs, armedWatches: turnEnd.armedWatches,
      };
      hookLog.debug({ tabId, ...entry.turnEnd }, 'stop with open background work: waiting, no nudge');
      if (entry.cliState !== 'busy') this.applyCliState(tabId, entry, 'busy', { silent: true });
      this.persistToLayout(entry);
      this.persistTurnEnd(entry);
      this.broadcastUpdate(tabId, entry);
      return;
    }
    if (turnEnd.kind === 'turn-marker') {
      entry.turnEnd = { kind: 'turn-marker', at, seq: stopSeq, marker: turnEnd.lines };
    } else {
      // What the classifier saw, so `tab status` explains a READY nudge (story 37).
      entry.turnEnd = {
        kind: 'ready-for-review', at, seq: stopSeq, transcript: turnEnd.transcript,
        // null: the background ledger was not read, which differs from "read, nothing open".
        openBackgroundTasks: snapshot?.openBackgroundTasks ?? null, liveRegisteredJobs, armedWatches,
      };
      if (!turnEnd.transcript && !this.transcriptFallbackLogged.has(tabId)) {
        this.transcriptFallbackLogged.add(tabId);
        log.info({ tabId, panelType: entry.panelType }, 'no transcript for turn-end classification; ready-for-review fallback');
      }
    }
    // Only an end line nudges at once (L49); a stop without one waits out the idle window.
    const nudge = turnEnd.kind === 'turn-marker'
      ? { kind: 'turn-marker' as const, detail: turnEnd.lines.join('\n') }
      : null;
    if (entry.cliState !== 'ready-for-review') {
      this.applyCliState(tabId, entry, 'ready-for-review', { nudge });
      this.persistToLayout(entry);
    } else if (nudge && !(previous?.kind === 'turn-marker' && previous.marker?.join('\n') === nudge.detail)) {
      this.nudgeOrchestrator(tabId, entry, nudge.kind, nudge.detail).catch((err) => {
        log.warn(`orchestrator nudge failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    this.persistTurnEnd(entry);
    this.broadcastUpdate(tabId, entry);
  }

  /** `replayedAt`: the time a spooled event happened, for a replay (ADR-0020); a live event has none. */
  updateTabFromHook(tmuxSession: string, event: string, notificationType?: string, source?: TSessionStartSource, replayedAt?: number): void {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) {
      hookLog.debug({ tmuxSession, event, notificationType }, 'no tabId for session');
      return;
    }
    const entry = this.tabs.get(tabId);
    if (!entry) {
      hookLog.debug({ tabId, event, notificationType }, 'no entry for tab');
      return;
    }
    const now = this.admitHookEvent(tabId, event, replayedAt);
    if (now === null) return;

    if (event === 'pre-compact' || event === 'post-compact') {
      hookLog.debug({ tabId, event }, 'compact hook');
      this.setCompacting(tabId, entry, event === 'pre-compact' ? now : null);
      return;
    }

    // A compaction's own SessionStart (L30, measured 2026-09-26 08:29Z on W4):
    // the agent compacted mid-turn and carries on, so it is neither a session
    // start nor a turn end. Only the hook's `source` says so; status-hook.sh is
    // rewritten on every server start, so the server that reads `source` also
    // installed the script that sends it.
    if (event === 'session-start' && source === 'compact') {
      // No state change, no nudge, no relaunch stamp: the turn goes on.
      entry.turnEnd = { kind: 'compacting', at: now, seq: entry.lastEvent?.seq };
      hookLog.debug({ tabId, source, cliState: entry.cliState }, 'compaction session-start: turn continues');
      this.setCompacting(tabId, entry, null);
      this.broadcastUpdate(tabId, entry);
      return;
    }

    if (event !== 'session-start' && event !== 'prompt-submit' && event !== 'notification' && event !== 'stop' && event !== 'interrupt') {
      hookLog.debug({ tabId, event, notificationType }, 'unknown event, ignoring');
      return;
    }
    const eventName = event as TEventName;
    if (replayedAt !== undefined) {
      void acknowledgeOrchestrationActivity(entry.workspaceId, tabId, tmuxSession, eventName, now)
        .catch((err) => log.warn({ err, tabId }, 'pending orchestration activity retained: hook persistence failed'));
    }

    if (eventName === 'notification' && notificationType && !INPUT_REQUESTING_NOTIFICATION_TYPES.has(notificationType)) {
      hookLog.debug({ tabId, event: eventName, notificationType }, 'non-input notification, skipping state transition');
      return;
    }

    const seq = (entry.eventSeq ?? 0) + 1;
    entry.eventSeq = seq;
    entry.lastEvent = { name: eventName, at: now, seq };
    if (eventName === 'session-start') {
      if (now >= (entry.lastResumeOrStartedAt ?? 0)) {
        this.orchestrationPendingLaunches.delete(tabId);
        entry.lastResumeOrStartedAt = now;
      }
      // A new agent session is not the halted one (story 26 review r2).
      if (entry.turnError?.class === 'usage-limit') this.closeTurnErrorEpisode(entry, 'session-start');
    }
    this.broadcast({ type: 'status:hook-event', tabId, event: entry.lastEvent });

    const prevState = entry.cliState;
    const newState = deriveAgentCliState(entry.lastEvent, prevState);

    hookLog.debug(
      { tabId, event: eventName, notificationType, seq, prevState, newState, transition: prevState !== newState },
      `processed ${eventName}${notificationType ? `(${notificationType})` : ''} ${prevState}→${newState}`,
    );

    if (newState === 'ready-for-review' && eventName === 'stop') {
      // A stop while already ready-for-review is classified too (review r1
      // finding 1): its record re-arms the idle nudge from THIS stop.
      void this.applyStopTurnEnd(tabId, entry, tmuxSession, replayedAt);
    } else if (prevState !== newState) {
      this.applyCliState(tabId, entry, newState);
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
    }

    if ((newState === 'busy' || newState === 'needs-input') && !entry.jsonlPath) {
      this.resolveAndWatchJsonl(tabId, tmuxSession).catch(() => {});
    }

    const stopHandle = this.runtimeHandle(entry);
    if (eventName === 'stop' && stopHandle) {
      const refreshSnippet = (force = false) => {
        const provider = getProviderByPanelType(entry.panelType);
        if (!provider) return;
        provider.readRuntimeSnapshot(stopHandle, { force }).then(({ currentAction, lastAssistantSnippet, reset }) => {
          let updated = false;
          if (reset) {
            if (entry.currentAction !== null) { entry.currentAction = null; updated = true; }
            if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; updated = true; }
          } else {
            if (currentAction !== null && currentAction.summary !== entry.currentAction?.summary) {
              entry.currentAction = currentAction;
              updated = true;
            }
            if (lastAssistantSnippet !== null && entry.lastAssistantMessage !== lastAssistantSnippet) {
              entry.lastAssistantMessage = lastAssistantSnippet;
              updated = true;
            }
          }
          if (updated) this.broadcastUpdate(tabId, entry);
        }).catch(() => {});
      };
      refreshSnippet();
      setTimeout(() => {
        refreshSnippet(true);
      }, 500);
    }
  }

  handleProviderEvent(providerId: string, tmuxSession: string, event: TAgentWorkStateEvent, replayedAt?: number): boolean {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) {
      hookLog.debug({ providerId, tmuxSession, event: event.kind }, 'no tabId for provider event');
      return false;
    }
    const entry = this.tabs.get(tabId);
    if (!entry) {
      hookLog.debug({ providerId, tabId, event: event.kind }, 'no entry for provider event tab');
      return false;
    }
    const expectedProvider = getProviderByPanelType(entry.panelType);
    if (expectedProvider && expectedProvider.id !== providerId) {
      hookLog.debug(
        { providerId, expectedProviderId: expectedProvider.id, tabId, event: event.kind },
        'provider event panel mismatch',
      );
      return false;
    }
    this.handleTabWorkStateEvent(tabId, event, replayedAt);
    return true;
  }

  /** A replayed patch older than the tab's latest event changes nothing and says `stale` (ADR-0020). */
  applyAgentHookMeta(
    providerId: string,
    tmuxSession: string,
    meta: IAgentHookMetaPatch,
    replayedAt?: number,
  ): { tabId: string; cliState: TCliState; stale?: boolean } | null {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) return null;
    const entry = this.tabs.get(tabId);
    if (!entry) return null;
    const expectedProvider = getProviderByPanelType(entry.panelType);
    if (expectedProvider && expectedProvider.id !== providerId) {
      hookLog.debug(
        { providerId, expectedProviderId: expectedProvider.id, tabId },
        'provider hook meta panel mismatch',
      );
      return null;
    }
    // Ordered against the floor, but never raises it: only state events do (ADR-0020).
    if (this.isStaleReplay(tabId, replayedAt)) return { tabId, cliState: entry.cliState, stale: true };

    let changed = false;

    if (entry.agentProviderId !== providerId) {
      entry.agentProviderId = providerId;
      changed = true;
    }
    const sessionBindingChanged = meta.sessionId !== undefined && entry.agentSessionId !== meta.sessionId;
    // A hook's binding is the provider's own word; the poll never moves it.
    if (meta.sessionId !== undefined) this.releasePollBinding(tabId);
    if (sessionBindingChanged) {
      entry.agentSessionId = meta.sessionId;
      changed = true;
      if (meta.jsonlPath === undefined && entry.jsonlPath !== null) {
        entry.jsonlPath = null;
      }
    }
    if (meta.jsonlPath !== undefined && entry.jsonlPath !== meta.jsonlPath) {
      entry.jsonlPath = meta.jsonlPath;
      changed = true;
    }
    if (meta.clearMessages) {
      if (entry.agentSummary !== null) { entry.agentSummary = null; changed = true; }
      if (entry.lastUserMessage !== null) { entry.lastUserMessage = null; changed = true; }
      if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; changed = true; }
    }
    if (meta.lastUserMessage !== undefined && entry.lastUserMessage !== meta.lastUserMessage) {
      entry.lastUserMessage = meta.lastUserMessage;
      changed = true;
    }
    if (meta.agentSummary !== undefined && entry.agentSummary !== meta.agentSummary) {
      entry.agentSummary = meta.agentSummary;
      changed = true;
    }
    if (meta.permissionRequest !== undefined && entry.permissionRequest !== meta.permissionRequest) {
      entry.permissionRequest = meta.permissionRequest;
      changed = true;
    }

    if (changed) {
      this.reconcileJsonlWatch(tabId, entry);
      const provider = expectedProvider ?? getProvider(providerId);
      if (provider) {
        this.updateAgentState(entry.tmuxSession, provider, {
          ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
          ...(meta.jsonlPath !== undefined || sessionBindingChanged
            ? { jsonlPath: meta.jsonlPath ?? null }
            : {}),
          ...(meta.agentSummary !== undefined || meta.clearMessages
            ? { summary: meta.clearMessages ? null : meta.agentSummary ?? null }
            : {}),
          ...(meta.lastUserMessage !== undefined || meta.clearMessages
            ? { lastUserMessage: meta.clearMessages ? null : meta.lastUserMessage ?? null }
            : {}),
        }).catch(() => {});
      }
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
    }

    return { tabId, cliState: entry.cliState };
  }

  private setCompacting(tabId: string, entry: ITabStatusEntry, since: number | null): void {
    const existingTimer = this.compactStaleTimers.get(tabId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.compactStaleTimers.delete(tabId);
    }

    if ((entry.compactingSince ?? null) === since) return;
    entry.compactingSince = since;
    this.broadcastUpdate(tabId, entry);

    if (since !== null) {
      const timer = setTimeout(() => {
        this.compactStaleTimers.delete(tabId);
        const e = this.tabs.get(tabId);
        if (!e || e.compactingSince !== since) return;
        e.compactingSince = null;
        hookLog.debug({ tabId }, 'compact stale, auto-cleared');
        this.broadcastUpdate(tabId, e);
      }, COMPACT_STALE_MS);
      this.compactStaleTimers.set(tabId, timer);
    }
  }

  removeTab(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry) getLivenessManager().removeTab(entry.workspaceId, tabId);
    if (entry && (entry.cliState === 'busy' || entry.cliState === 'needs-input') && entry.lastUserMessage) {
      this.saveSessionHistory(tabId, entry, entry.busySince, true).catch((err) => {
        log.warn('Failed to save cancelled session history: %s', err);
      });
    }
    this.stopJsonlWatch(tabId);
    const compactTimer = this.compactStaleTimers.get(tabId);
    if (compactTimer) {
      clearTimeout(compactTimer);
      this.compactStaleTimers.delete(tabId);
    }
    this.stuckNudgedTabs.delete(tabId);
    this.inactiveSince.delete(tabId);
    this.jobEventAt.delete(tabId);
    // A poll that read the layout before the close must not bring the tab back (L38).
    this.retiredTabs.set(tabId, Date.now() + CLOSED_RETIRE_MS);
    this.tabs.delete(tabId);
    this.orchestrationPendingLaunches.delete(tabId);
    this.codexLifecycleEpoch.delete(tabId);
    this.processStartCache.delete(tabId);
    this.hookFloors.forget(tabId);
    this.hookHistory.delete(tabId);
    this.broadcastRemove(tabId);
  }

  registerTab(tabId: string, entry: ITabStatusEntry): void {
    this.tabs.set(tabId, entry);
    this.reconcileJsonlWatch(tabId, entry);
    this.broadcastUpdate(tabId, entry);
  }

  private handleTabWorkStateEvent(tabId: string, event: TAgentWorkStateEvent, replayedAt?: number): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    switch (event.kind) {
      case 'session-start':
        this.updateTabFromHook(entry.tmuxSession, 'session-start', undefined, event.source, replayedAt);
        break;
      case 'prompt-submit':
      case 'stop':
      case 'interrupt':
      case 'pre-compact':
      case 'post-compact':
        this.updateTabFromHook(entry.tmuxSession, event.kind, undefined, undefined, replayedAt);
        break;
      case 'notification':
        this.updateTabFromHook(entry.tmuxSession, 'notification', event.notificationType, undefined, replayedAt);
        break;
      case 'summary-update':
        if (this.admitHookEvent(tabId, event.kind, replayedAt) === null) break;
        if (entry.agentSummary !== event.summary) {
          entry.agentSummary = event.summary;
          this.broadcastUpdate(tabId, entry);
        }
        break;
      case 'last-user-message':
        if (this.admitHookEvent(tabId, event.kind, replayedAt) === null) break;
        if (entry.lastUserMessage !== event.message) {
          entry.lastUserMessage = event.message;
          this.broadcastUpdate(tabId, entry);
        }
        break;
    }
  }

  isOrchestrationLaunchPending(tabId: string): boolean {
    return this.orchestrationPendingLaunches.has(tabId);
  }

  markAgentLaunch(tabId: string, options?: { resetAgentSession?: boolean; resumeSessionId?: string }): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    this.orchestrationPendingLaunches.add(tabId);
    entry.lastResumeOrStartedAt = Date.now();
    const provider = getProviderByPanelType(entry.panelType);
    const isCodex = entry.agentProviderId === CODEX_PROVIDER_ID || entry.panelType === 'codex-cli';
    const nextSessionId = isCodex
      ? undefined
      : options?.resumeSessionId ?? (options?.resetAgentSession ? null : undefined);
    if (nextSessionId !== undefined) {
      this.releasePollBinding(tabId);
      entry.agentSessionId = nextSessionId;
      entry.jsonlPath = null;
      entry.agentSummary = null;
      entry.lastUserMessage = null;
      entry.lastAssistantMessage = null;
      entry.currentAction = null;
      entry.permissionRequest = null;
      this.stopJsonlWatch(tabId);
      this.persistToLayout(entry);
      if (provider) {
        this.updateAgentState(entry.tmuxSession, provider, {
          sessionId: nextSessionId,
          jsonlPath: null,
          summary: null,
          lastUserMessage: null,
        }).catch(() => {});
      }
      this.broadcastUpdate(tabId, entry);
    }
    for (const delay of LAUNCH_READY_POLL_DELAYS_MS) {
      setTimeout(() => {
        this.poll().catch((err) => {
          log.error({ err, tabId }, 'Launch readiness poll error');
        });
      }, delay);
    }
  }

  markCodexLaunchPending(tabId: string, generation: string): void {
    const previous = this.codexLifecycleEpoch.get(tabId);
    this.codexLifecycleEpoch.set(tabId, {
      generation,
      phase: 'pending',
      epoch: (previous?.epoch ?? 0) + 1,
    });
    this.modelWatch.forget(tabId);
  }

  applyConfirmedCodexLaunch(tabId: string, generation: string, resumeSessionId: string | null): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    entry.panelType = 'codex-cli';
    entry.agentProviderId = CODEX_PROVIDER_ID;
    entry.lastResumeOrStartedAt = Date.now();
    entry.agentSessionId = resumeSessionId;
    entry.jsonlPath = null;
    entry.agentSummary = null;
    entry.lastUserMessage = null;
    entry.lastAssistantMessage = null;
    entry.currentAction = null;
    entry.permissionRequest = null;
    const previous = this.codexLifecycleEpoch.get(tabId);
    this.codexLifecycleEpoch.set(tabId, {
      generation,
      phase: 'active',
      epoch: (previous?.epoch ?? 0) + 1,
    });
    this.stopJsonlWatch(tabId);
    this.broadcastUpdate(tabId, entry);
    hookLog.debug({ tabId, generation, resumeSessionId }, 'applied confirmed Codex launch');
    for (const delay of LAUNCH_READY_POLL_DELAYS_MS) {
      setTimeout(() => {
        this.poll().catch((err) => {
          log.error({ err, tabId, generation }, 'Confirmed launch readiness poll error');
        });
      }, delay);
    }
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    if (this.lastRateLimits && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'rate-limits:update', data: this.lastRateLimits }));
    }
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  private persistToLayout(entry: ITabStatusEntry): void {
    updateTabCliStatus(entry.tmuxSession, entry.cliState, entry.dismissedAt).catch(() => {});
  }

  private broadcastUpdate(tabId: string, entry: ITabStatusEntry, exclude?: WebSocket): void {
    const msg: IStatusUpdateMessage = {
      type: 'status:update',
      tabId,
      cliState: entry.cliState,
      workspaceId: entry.workspaceId,
      tabName: entry.tabName,
      currentProcess: entry.currentProcess,
      paneTitle: entry.paneTitle,
      panelType: entry.panelType,
      terminalStatus: entry.terminalStatus,
      listeningPorts: entry.listeningPorts,
      agentProviderId: entry.agentProviderId,
      agentSummary: entry.agentSummary,
      lastUserMessage: entry.lastUserMessage,
      lastAssistantMessage: entry.lastAssistantMessage,
      currentAction: entry.currentAction,
      readyForReviewAt: entry.readyForReviewAt,
      busySince: entry.busySince,
      dismissedAt: entry.dismissedAt,
      agentSessionId: entry.agentSessionId,
      compactingSince: entry.compactingSince,
      permissionRequest: entry.permissionRequest,
      lastEvent: entry.lastEvent,
      eventSeq: entry.eventSeq,
    };
    this.broadcast(msg, exclude);
  }

  private broadcastRemove(tabId: string): void {
    const msg: IStatusUpdateMessage = {
      type: 'status:update',
      tabId,
      cliState: null,
      workspaceId: '',
      tabName: '',
    };
    this.broadcast(msg);
  }

  private static readonly BACKPRESSURE_LIMIT = 1024 * 1024;

  broadcast(event: object, exclude?: WebSocket): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < StatusManager.BACKPRESSURE_LIMIT) {
        ws.send(msg);
      }
    }
  }

  private async resolveAndWatchJsonl(tabId: string, tmuxSession: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.jsonlPath) return;

    let jsonlPath: string | null = null;

    const parsed = parseSessionName(tmuxSession);
    if (parsed) {
      const layout = await readLayoutFile(resolveLayoutFile(parsed.wsId));
      if (layout) {
        const tab = collectAllTabs(layout.root).find((t) => t.sessionName === tmuxSession);
        const tabProvider = getProviderByPanelType(tab?.panelType);
        const tabSessionId = tab && tabProvider ? tabProvider.readSessionId(tab) : null;
        if (tab && tabProvider && tabSessionId) {
          if (tabProvider.id === GROK_PROVIDER_ID) {
            jsonlPath = await resolveGrokJsonlPath(tabSessionId);
          } else if (tabProvider.id === CODEX_PROVIDER_ID) {
            jsonlPath = (await findCodexSessionById(tabSessionId))?.jsonlPath ?? null;
          } else {
            const cwd = await getSessionCwd(tmuxSession);
            if (cwd) {
              const candidate = `${cwdToProjectPath(cwd)}/${tabSessionId}.jsonl`;
              try {
                await fs.access(candidate);
                jsonlPath = candidate;
              } catch { /* noop */ }
            }
          }
        }

        if (tab?.lastUserMessage && entry.lastUserMessage !== tab.lastUserMessage) {
          entry.lastUserMessage = tab.lastUserMessage;
          this.broadcastUpdate(tabId, entry);
        }
      }
    }

    if (!jsonlPath) {
      const panePid = await getSessionPanePid(tmuxSession);
      if (panePid) {
        const { info } = await detectAnyActiveSession(panePid);
        jsonlPath = info.jsonlPath;
      }
    }

    if (!jsonlPath) return;

    entry.jsonlPath = jsonlPath;
    const provider = getProviderByPanelType(entry.panelType);
    if (provider) {
      entry.agentProviderId = provider.id;
      entry.agentSessionId = provider.sessionIdFromJsonlPath(jsonlPath) ?? entry.agentSessionId;
    }

    this.reconcileJsonlWatch(tabId, entry);
  }

  private reconcileJsonlWatch(tabId: string, entry: ITabStatusEntry): void {
    const existing = this.jsonlWatchers.get(tabId);
    const shouldWatch = entry.cliState === 'busy'
      || entry.cliState === 'needs-input'
      || entry.cliState === 'unknown';
    if (shouldWatch && entry.jsonlPath) {
      this.startJsonlWatch(tabId, entry.jsonlPath);
      return;
    }
    const keepForFinalRead = entry.cliState === 'ready-for-review'
      && !!entry.jsonlPath
      && existing?.jsonlPath === entry.jsonlPath;
    if (!keepForFinalRead && existing) this.stopJsonlWatch(tabId);
  }

  private startJsonlWatch(tabId: string, jsonlPath: string): void {
    const existing = this.jsonlWatchers.get(tabId);
    if (existing?.jsonlPath === jsonlPath) return;
    if (existing) this.stopJsonlWatch(tabId);

    log.debug('startJsonlWatch tabId=%s path=%s', tabId, jsonlPath);
    try {
      const watcher = watch(jsonlPath, () => {
        const w = this.jsonlWatchers.get(tabId);
        if (!w || w.jsonlPath !== jsonlPath) return;
        if (w.debounceTimer) clearTimeout(w.debounceTimer);
        w.debounceTimer = setTimeout(() => {
          this.onJsonlFileChange(tabId, jsonlPath).catch(() => {});
        }, JSONL_WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        if (this.jsonlWatchers.get(tabId)?.jsonlPath === jsonlPath) {
          this.stopJsonlWatch(tabId);
        }
      });
      this.jsonlWatchers.set(tabId, { watcher, jsonlPath, debounceTimer: null });
      const entry = this.tabs.get(tabId);
      if (entry?.agentProviderId === CODEX_PROVIDER_ID || entry?.panelType === 'codex-cli') {
        this.cacheCodexRateLimits(jsonlPath).catch(() => {});
      }
    } catch {
      // file may not exist yet
    }
  }

  private stopJsonlWatch(tabId: string): void {
    const w = this.jsonlWatchers.get(tabId);
    if (!w) return;
    log.debug('stopJsonlWatch tabId=%s', tabId);
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    try { w.watcher.close(); } catch { /* noop */ }
    this.jsonlWatchers.delete(tabId);
  }

  private async onJsonlFileChange(tabId: string, jsonlPath: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry) {
      this.stopJsonlWatch(tabId);
      return;
    }
    const isActive = entry.cliState === 'busy' || entry.cliState === 'needs-input' || entry.cliState === 'unknown';
    if (!isActive && entry.cliState !== 'ready-for-review') {
      this.stopJsonlWatch(tabId);
      return;
    }

    const provider = getProviderByPanelType(entry.panelType);
    if (!provider) return;
    const { currentAction, lastAssistantSnippet, reset, interrupted, lastEntryTs } = await provider.readRuntimeSnapshot(jsonlPath);
    if (entry.agentProviderId === CODEX_PROVIDER_ID || entry.panelType === 'codex-cli') {
      this.cacheCodexRateLimits(jsonlPath).catch(() => {});
    }

    if (
      interrupted
      && entry.cliState === 'busy'
      && lastEntryTs !== null
      && lastEntryTs > (entry.lastInterruptTs ?? 0)
      && lastEntryTs > (entry.lastEvent?.at ?? 0)
    ) {
      entry.lastInterruptTs = lastEntryTs;
      hookLog.debug({ tabId, lastEntryTs }, 'synthetic interrupt from JSONL');
      this.updateTabFromHook(entry.tmuxSession, 'interrupt');
    }

    let changed = false;

    if (reset) {
      if (entry.currentAction !== null) { entry.currentAction = null; changed = true; }
      if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; changed = true; }
    } else {
      if (currentAction !== null && currentAction.summary !== entry.currentAction?.summary) {
        entry.currentAction = currentAction;
        changed = true;
      }
      if (lastAssistantSnippet !== null && entry.lastAssistantMessage !== lastAssistantSnippet) {
        entry.lastAssistantMessage = lastAssistantSnippet;
        changed = true;
      }
    }

    if (changed) {
      this.broadcastUpdate(tabId, entry);
    }
  }

  /** Stops at once; the returned promise settles when the hook floors are saved (the graceful shutdown awaits it). */
  shutdown(): Promise<void> {
    const floorsSaved = this.hookFloors.flush();
    this.stopPolling();
    this.rateLimitsWatcher?.stop();
    this.claudeUsagePoller?.stop();
    for (const tabId of [...this.jsonlWatchers.keys()]) {
      this.stopJsonlWatch(tabId);
    }
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
    }
    this.clients.clear();
    return floorsSaved;
  }

  /** A closed tab stops receiving nudges at once; the layout copy is cleared too. */
  forgetReportsTo(workspaceId: string, closedTabId: string): void {
    for (const entry of this.tabs.values()) {
      if (entry.workspaceId === workspaceId && entry.reportsTo === closedTabId) entry.reportsTo = null;
    }
    clearReportsTo(workspaceId, closedTabId).then((cleared) => {
      if (cleared.length) log.info({ closedTabId, cleared }, 'reportsTo cleared: target tab closed');
    }).catch((err) => {
      log.warn(`reportsTo clear failed for ${closedTabId}: ${err instanceof Error ? err.message : err}`);
    });
  }

  notifyLastUserMessage(sessionName: string, message: string): void {
    const parsed = parseSessionName(sessionName);
    if (!parsed) return;
    const entry = this.tabs.get(parsed.tabId);
    if (!entry || entry.lastUserMessage === message) return;
    entry.lastUserMessage = message;
    this.broadcastUpdate(parsed.tabId, entry);
  }
}

export const getStatusManager = (): StatusManager => {
  if (!g.__ptStatusManager) {
    const manager = new StatusManager();
    g.__ptStatusManager = manager;
    const dispatcher = getNotificationDispatcher();
    dispatcher.register(createStatusSocketChannel((frame) => manager.broadcast(frame)));
    dispatcher.register(createWebPushChannel());
    registerFcmChannel(dispatcher);
    onTabClosing(({ tabId, phase }) => manager.handleTabClosing(tabId, phase));
    onTabClosed(({ tabId, workspaceId }) => {
      manager.removeTab(tabId);
      manager.forgetReportsTo(workspaceId, tabId);
    });
    onInboxHeld((item) => manager.handleHeldResume(item));
    setLeaseAgentStateSource((tabId) => manager.getTabAgentState(tabId));
  }
  return g.__ptStatusManager;
};
