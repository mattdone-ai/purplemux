import { getStatusManager } from '@/lib/status-manager';
import { buildClaudeFlags, buildRemoteClaudeLaunch, claudeCommand } from '@/lib/claude-command';
import { grokProvider } from '@/lib/providers/grok';
import { agentLaunchOptionsForTab } from '@/lib/agent-launch-policy';
import {
  prepareCodexManagedLaunch,
  prepareCodexManagedLaunchLocked,
  submitCodexManagedLaunch,
  submitCodexManagedLaunchLocked,
  waitForCodexManagedLaunch,
} from '@/lib/providers/codex/managed-launch';
import type { IAgentProvider } from '@/lib/providers/types';
import type { IAgentLaunchConfig, TPanelType, TTabRole } from '@/types/terminal';

// One place builds every agent launch (ADR-0028 §8): tab create, auto-resume
// and tab restart. The server builds the command from the tab's persisted
// settings; no caller text reaches a session.

export interface IAgentLaunchTab {
  panelType?: TPanelType;
  /** A remote tab (ADR-0022) launches claude through the remote kit. */
  host?: string;
  agentLaunchConfig?: IAgentLaunchConfig;
  /** Every launch of an evaluator tab carries its tool configuration (ADR-0040). */
  role?: TTabRole;
  previewOrigin?: string;
  pgService?: string;
}

export interface IAgentLaunchTarget extends IAgentLaunchTab {
  workspaceId: string;
  tabId: string;
  sessionName: string;
}

export type TCodexLaunchOutcome =
  /** `submitted`: the caller holds the tab's Codex target lock and confirms the launch after it releases it. */
  | { ok: true; generation: string; phase: 'active' | 'submitted' }
  | { ok: false; step: 'prepare'; reason: string }
  | { ok: false; step: 'submit'; reason: string; generation: string; phase: 'prepared' | 'held' }
  | { ok: false; step: 'activate'; reason: string; generation: string; phase: 'submitted' | 'held' };

export interface ICodexLaunchOptions {
  resumeSessionId?: string | null;
  /**
   * The caller holds the tab's Codex target lock (`withAgentDispatchLock`). The
   * lock is not re-entrant, and the hook that confirms the launch takes it, so
   * the caller confirms the launch once it has released the lock.
   */
  targetLockHeld?: boolean;
}

export interface ILaunchAgentOptions extends ICodexLaunchOptions {
  provider: IAgentProvider;
  /** A fresh launch that replaces the tab's agent session (`tab restart --clear`). */
  resetAgentSession?: boolean;
}

export type TAgentLaunchResult =
  | { kind: 'command'; resumed: boolean }
  | { kind: 'codex'; resumed: boolean; outcome: TCodexLaunchOutcome };

/** The fresh launch command of a claude-code or grok-cli tab; a Codex tab launches through its managed path. */
export const buildFreshLaunchCommand = async (workspaceId: string, tab: IAgentLaunchTab): Promise<string | undefined> => {
  const { model, effort, role, previewOrigin, pgService } = agentLaunchOptionsForTab(tab);
  if (tab.panelType === 'claude-code') {
    // The remote kit has no evaluator tool configuration: refuse rather than launch it unrestricted (ADR-0040).
    if (tab.host && role) throw new Error(`a ${role} tab cannot run on remote host ${tab.host} (ADR-0040)`);
    return tab.host
      ? buildRemoteClaudeLaunch(workspaceId, { model, effort })
      : claudeCommand(await buildClaudeFlags(workspaceId, { model, effort, role, previewOrigin }), { role, pgService });
  }
  // The catch-all used to be codex, which launched codex inside a grok tab.
  if (tab.panelType === 'grok-cli') return grokProvider.buildLaunchCommand({ workspaceId, model, effort });
  return undefined;
};

/** Wait for a submitted Codex launch to become active; never under the tab's Codex target lock. */
export const confirmCodexLaunch = async (workspaceId: string, tabId: string, generation: string): Promise<TCodexLaunchOutcome> => {
  const activated = await waitForCodexManagedLaunch(workspaceId, tabId, generation);
  if (!activated.ok) return { ok: false, step: 'activate', reason: activated.reason, generation: activated.generation, phase: activated.phase };
  return { ok: true, generation: activated.generation, phase: 'active' };
};

/** The Codex managed launch: prepare, submit, and (unless the target lock is held) confirm. */
export const launchCodexManaged = async (
  workspaceId: string,
  tabId: string,
  options: ICodexLaunchOptions = {},
): Promise<TCodexLaunchOutcome> => {
  const locked = options.targetLockHeld === true;
  const prepare = locked ? prepareCodexManagedLaunchLocked : prepareCodexManagedLaunch;
  const prepared = options.resumeSessionId === undefined
    ? await prepare(workspaceId, tabId)
    : await prepare(workspaceId, tabId, options.resumeSessionId);
  if (!prepared.ok) return { ok: false, step: 'prepare', reason: prepared.reason };
  const submit = locked ? submitCodexManagedLaunchLocked : submitCodexManagedLaunch;
  const submitted = await submit(workspaceId, tabId, prepared.launch.generation);
  if (!submitted.ok) return { ok: false, step: 'submit', reason: submitted.reason, generation: submitted.generation, phase: submitted.phase };
  if (locked) return { ok: true, generation: submitted.generation, phase: 'submitted' };
  return confirmCodexLaunch(workspaceId, tabId, submitted.generation);
};

/**
 * Launch the provider's agent in an existing tab's live shell: resume
 * `resumeSessionId` when given, else a fresh launch. Takes no workspace mapping
 * guard: its callers hold it (ADR-0028 §2).
 */
export const launchAgentInTab = async (target: IAgentLaunchTarget, options: ILaunchAgentOptions): Promise<TAgentLaunchResult> => {
  // Loaded here, not at the top: tab create needs only the builders above, and its import graph stays as it was.
  const [{ CODEX_PROVIDER_ID }, { recordOrchestrationLaunch }, { sendKeysSeparated }] = await Promise.all([
    import('@/lib/providers/codex'),
    import('@/lib/orchestration-activity'),
    import('@/lib/tmux'),
  ]);
  const resumeSessionId = options.resumeSessionId || null;
  if (options.provider.id === CODEX_PROVIDER_ID) {
    const outcome = await launchCodexManaged(target.workspaceId, target.tabId, {
      resumeSessionId,
      targetLockHeld: options.targetLockHeld,
    });
    return { kind: 'codex', resumed: resumeSessionId !== null, outcome };
  }
  const command = resumeSessionId
    ? await options.provider.buildResumeCommand(resumeSessionId, {
      workspaceId: target.workspaceId,
      ...agentLaunchOptionsForTab(target),
    })
    : await buildFreshLaunchCommand(target.workspaceId, target);
  if (!command) throw new Error(`no launch command for a ${target.panelType ?? 'terminal'} tab`);
  await recordOrchestrationLaunch(target.workspaceId, target.tabId, target.sessionName);
  if (options.resetAgentSession) getStatusManager().markAgentLaunch(target.tabId, { resetAgentSession: true });
  else getStatusManager().markAgentLaunch(target.tabId);
  await sendKeysSeparated(target.sessionName, command);
  return { kind: 'command', resumed: resumeSessionId !== null };
};
