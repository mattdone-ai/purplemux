import type { TCliState } from '@/types/timeline';

export type TConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'session-ended';

export type TDisconnectReason = 'max-connections' | 'pty-error' | 'session-not-found' | 'reconnect-exhausted' | null;

export type TPanelType = 'terminal' | 'claude-code' | 'codex-cli' | 'grok-cli' | 'agent-sessions' | 'web-browser' | 'diff';
export type TDiffViewMode = 'split' | 'unified';
export type TDiffTab = 'changes' | 'history';

export interface IDiffSettings {
  activeTab?: TDiffTab;
  viewMode?: TDiffViewMode;
  panelOpen?: boolean;
  panelSize?: number;
}

export interface IAgentState {
  providerId: string;
  sessionId: string | null;
  jsonlPath: string | null;
  summary: string | null;
}

export interface IAgentLaunchConfig {
  model?: string;
  effort?: string;
}

export interface ICodexLaunchProcessIdentity {
  pid: number;
  startedAtMs: number;
}

export interface ICodexLaunchObservationBoundary {
  sessionId: string;
  jsonlPath: string;
  byteOffset: number;
}

export type TCodexPendingLaunchPhase = 'prepared' | 'submitted' | 'held';

export interface ICodexPendingLaunch {
  generation: string;
  workspaceId: string;
  tabId: string;
  sessionName: string;
  resumeSessionId: string | null;
  launchedConfig: IAgentLaunchConfig;
  observationBoundary: ICodexLaunchObservationBoundary | null;
  priorLauncher: ICodexLaunchProcessIdentity | null;
  priorAgent: ICodexLaunchProcessIdentity | null;
  phase: TCodexPendingLaunchPhase;
  preparedAt: string;
  submittedAt?: string;
  heldReason?: string;
}

export interface ICodexActiveLaunch {
  generation: string;
  workspaceId: string;
  tabId: string;
  sessionName: string;
  resumeSessionId: string | null;
  launchedConfig: IAgentLaunchConfig;
  observationBoundary: ICodexLaunchObservationBoundary | null;
  launcher: ICodexLaunchProcessIdentity;
  agent: ICodexLaunchProcessIdentity;
  phase: 'active' | 'held';
  bootstrap: 'unused' | 'consumed';
  confirmedAt: string;
  heldReason?: string;
}

export interface ICodexLaunchRuntime {
  active?: ICodexActiveLaunch;
  pending?: ICodexPendingLaunch;
}

/** Server-owned lifecycle evidence. Pending work has no expiry. */
export interface IOrchestrationActivity {
  sessionName: string;
  runtimeGeneration: string;
  launch?: { at: number; priorIdentity?: string; priorUnknown?: boolean };
  turn?: { generation: string; runtimeGeneration: string; at: number; rawInput?: boolean; rawEpoch?: number; runningAt?: number; runningIdentity?: string };
}

export interface ITab {
  id: string;
  sessionName: string;
  name: string;
  order: number;
  title?: string;
  cwd?: string;
  panelType?: TPanelType;
  agentState?: IAgentState;
  agentLaunchConfig?: IAgentLaunchConfig;
  /** Server-owned proof of the Codex process generation currently attached to this tab. */
  codexLaunchRuntime?: ICodexLaunchRuntime;
  orchestrationActivity?: IOrchestrationActivity;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeSessionId?: string | null;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeJsonlPath?: string | null;
  /** @deprecated use agentState; kept for disk back-compat */
  claudeSummary?: string | null;
  lastUserMessage?: string | null;
  lastCommand?: string | null;
  /**
   * Path globs this tab is expected to edit, relative to its cwd. The signal
   * engine reports an edit outside them as off-scope. purplemux never derives
   * this — a caller supplies it at tab create, so no workflow convention leaks
   * in here. Absent means the off-scope detector stays inert for this tab.
   */
  scope?: string[];
  /**
   * The tab (same workspace) that receives this tab's watchdog nudges while it
   * is live, ahead of the workspace orchestrator (ADR-0018). Cleared when that
   * tab closes.
   */
  reportsTo?: string;
  /**
   * The ssh alias of the host whose tmux runs this tab (ADR-0022). Absent: this
   * server's host. Set once at create; a tab never changes host.
   */
  host?: string;
  cliState?: TCliState;
  dismissedAt?: number | null;
  /**
   * The watchdog's record of the last markerless stop (ADR-0018, L49): the poll
   * derives the idle nudge from it, so a server restart keeps a pending nudge
   * and never sends a sent one again.
   */
  watchdogTurnEnd?: import('@/types/status').ITurnEndRecord | null;
  webUrl?: string | null;
  terminalRatio?: number;
  terminalCollapsed?: boolean;
}

export interface ISplitNode {
  type: 'split';
  orientation: 'horizontal' | 'vertical';
  ratio: number;
  children: [TLayoutNode, TLayoutNode];
}

export interface IPaneNode {
  type: 'pane';
  id: string;
  tabs: ITab[];
  activeTabId: string | null;
}

export type TLayoutNode = ISplitNode | IPaneNode;

export interface ILayoutData {
  root: TLayoutNode;
  activePaneId: string | null;
  diffSettings?: IDiffSettings;
  updatedAt: string;
}

export interface IWorkspaceOrchestration {
  /** Absent legacy revisions normalize to zero without a migration write. */
  revision?: number;
  enabled: boolean;
  orchestratorTabId: string | null;
  kickoffTemplate?: string | null;
}

export interface IWorkspace {
  id: string;
  name: string;
  directories: string[];
  groupId?: string | null;
  orchestration?: IWorkspaceOrchestration;
  /**
   * Workspace ids permitted to reach INTO this one over the CLI API. Empty or
   * absent means no cross-workspace access, which is the default: an agent's
   * token is confined to the workspace whose tab it runs in.
   */
  allowedPeers?: string[];
}

export interface IWorkspaceGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}

export interface IWorkspacesData {
  workspaces: IWorkspace[];
  groups?: IWorkspaceGroup[];
  activeWorkspaceId?: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  updatedAt: string;
}
