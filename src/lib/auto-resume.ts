import { recordOrchestrationLaunch } from '@/lib/orchestration-activity';
import { withOrchestrationMappingsRead } from '@/lib/orchestration-mapping-lock';
import { readLayoutFile, resolveLayoutFile, collectAllTabs } from '@/lib/layout-store';
import { hasSession, createSession, getPaneCurrentCommand, getSessionPanePid, sendKeysSeparated } from '@/lib/tmux';
import { getWorkspaces } from '@/lib/workspace-store';
import { getProviderByPanelType, getProviderByProcessName } from '@/lib/providers';
import type { IAgentPreflight, IAgentProvider } from '@/lib/providers/types';
import { getStatusManager } from '@/lib/status-manager';
import { getChildPids, getProcessArgs } from '@/lib/process-utils';
import { createLogger } from '@/lib/logger';
import { agentLaunchOptionsForTab } from '@/lib/agent-launch-policy';
import type { IAgentLaunchConfig } from '@/types/terminal';
import { CODEX_PROVIDER_ID } from '@/lib/providers/codex';
import {
  prepareCodexManagedLaunch,
  submitCodexManagedLaunch,
  waitForCodexManagedLaunch,
} from '@/lib/providers/codex/managed-launch';

const log = createLogger('auto-resume');

const SHELL_READY_DELAY_MS = 500;
const SAFE_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash']);

interface IAutoResumeTarget {
  workspaceId: string;
  tabId: string;
  tmuxSession: string;
  sessionId: string;
  provider: IAgentProvider;
  agentLaunchConfig?: IAgentLaunchConfig;
}

const findAutoResumeTargets = async (): Promise<IAutoResumeTarget[]> => {
  const { workspaces } = await getWorkspaces();
  const targets: IAutoResumeTarget[] = [];
  const preflightByProvider = new Map<string, IAgentPreflight>();

  const getProviderPreflight = async (provider: IAgentProvider): Promise<IAgentPreflight> => {
    const cached = preflightByProvider.get(provider.id);
    if (cached) return cached;
    const status = await provider.preflight();
    preflightByProvider.set(provider.id, status);
    return status;
  };

  for (const ws of workspaces) {
    const layout = await readLayoutFile(resolveLayoutFile(ws.id));
    if (!layout) continue;

    const tabs = collectAllTabs(layout.root);
    for (const tab of tabs) {
      const provider = getProviderByPanelType(tab.panelType);
      if (!provider) continue;
      // A resume types this host's launch command; a remote tab is never resumed here (ADR-0022).
      if (tab.host) {
        log.info(`Skip resume for remote tab ${tab.id} on ${tab.host}`);
        continue;
      }
      const preflight = await getProviderPreflight(provider);
      if (!preflight.installed) {
        const reason = provider.id === 'claude' && preflight.binaryPath ? 'PATH not configured' : 'not installed';
        log.info(`Skip resume for ${provider.id} tab ${tab.id}: ${reason}`);
        continue;
      }
      const sessionId = provider.readSessionId(tab);
      if (!sessionId) continue;
      targets.push({
        workspaceId: ws.id,
        tabId: tab.id,
        tmuxSession: tab.sessionName,
        sessionId,
        provider,
        agentLaunchConfig: tab.agentLaunchConfig,
      });
    }
  }

  return targets;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fetchForegroundArgs = async (tmuxSession: string): Promise<string[] | undefined> => {
  const panePid = await getSessionPanePid(tmuxSession);
  if (!panePid) return undefined;
  const childPids = await getChildPids(panePid);
  for (const cpid of childPids) {
    const argsStr = await getProcessArgs(cpid);
    if (argsStr) return argsStr.split(/\s+/);
  }
  return undefined;
};

const sendResumeKeys = async (target: IAutoResumeTarget): Promise<boolean> => {
  try {
    const command = await getPaneCurrentCommand(target.tmuxSession);
    if (!command) {
      log.warn(`Cannot check process: ${target.tmuxSession}`);
      return false;
    }

    if (!SAFE_SHELLS.has(command)) {
      const args = command === 'node' ? await fetchForegroundArgs(target.tmuxSession) : undefined;
      const runningProvider = getProviderByProcessName(command, args);
      if (runningProvider && runningProvider.id === target.provider.id) {
        log.debug(`${target.provider.displayName} already running, skip: ${target.tmuxSession}`);
        return true;
      }
      log.debug(`Non-shell process running (${command}), skip: ${target.tmuxSession}`);
      return false;
    }

    if (target.provider.id === CODEX_PROVIDER_ID) {
      const prepared = await prepareCodexManagedLaunch(target.workspaceId, target.tabId, target.sessionId);
      if (!prepared.ok) {
        log.warn(`Cannot prepare managed Codex resume: ${target.tmuxSession} — ${prepared.reason}`);
        return false;
      }
      const submitted = await submitCodexManagedLaunch(
        target.workspaceId,
        target.tabId,
        prepared.launch.generation,
      );
      if (!submitted.ok) {
        log.warn(`Cannot submit managed Codex resume: ${target.tmuxSession} — ${submitted.reason}`);
        return false;
      }
      const activated = await waitForCodexManagedLaunch(
        target.workspaceId,
        target.tabId,
        submitted.generation,
      );
      if (!activated.ok) {
        log.warn(`Managed Codex resume not confirmed: ${target.tmuxSession} — ${activated.reason}`);
        return false;
      }
      return true;
    }

    const resumeCmd = await target.provider.buildResumeCommand(target.sessionId, {
      workspaceId: target.workspaceId,
      ...agentLaunchOptionsForTab(target),
    });
    log.debug(`Sending resume: ${target.tmuxSession} → ${target.sessionId}`);
    await recordOrchestrationLaunch(target.workspaceId, target.tabId, target.tmuxSession);
    getStatusManager().markAgentLaunch(target.tabId);
    await sendKeysSeparated(target.tmuxSession, resumeCmd);

    return true;
  } catch (err) {
    log.error(`Failed: ${target.tmuxSession} — ${err instanceof Error ? err.message : err}`);
    return false;
  }
};

export const executeAutoResume = async (targets: IAutoResumeTarget[]): Promise<void> =>
  withOrchestrationMappingsRead(targets.map((target) => target.workspaceId), () => executeAutoResumeLocked(targets));

const executeAutoResumeLocked = async (targets: IAutoResumeTarget[]): Promise<void> => {
  // Phase 1: Sequential session creation — first createSession cold-starts tmux server, so avoid race
  let hasNewSession = false;
  for (const target of targets) {
    if (!(await hasSession(target.tmuxSession))) {
      log.debug(`No tmux session, creating new: ${target.tmuxSession}`);
      await createSession(target.tmuxSession, 80, 24, undefined, { workspaceId: target.workspaceId, tabId: target.tabId });
      hasNewSession = true;
    }
  }

  // Phase 2: Wait for shell initialization if new sessions were created (once)
  if (hasNewSession) {
    await sleep(SHELL_READY_DELAY_MS);
  }

  // Phase 3: Send resume commands in parallel
  await Promise.allSettled(targets.map((target) => sendResumeKeys(target)));
};

export const autoResumeOnStartup = async (mappingGuardsHeld = false): Promise<void> => {
  const targets = await findAutoResumeTargets();
  if (targets.length === 0) return;

  if (mappingGuardsHeld) { await executeAutoResumeLocked(targets); return; }
  log.debug(`${targets.length} surface(s) auto-resume started`);
  executeAutoResume(targets).then(() => {
    log.debug('Auto-resume complete');
  }).catch((err) => {
    log.error(`Auto-resume error: ${err instanceof Error ? err.message : err}`);
  });
};
