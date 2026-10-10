import type { NextApiRequest, NextApiResponse } from 'next';
import { addTabToPane, isAgentPanelType } from '@/lib/layout-store';
import { readWorkspaceLayout } from '@/lib/workspace-layout-read';
import { collectPanes } from '@/lib/layout-tree';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import { authorizeWorkspace, canAccessWorkspace, resolveFirstPaneId } from '@/lib/cli-utils';
import { resolveCliScope } from '@/lib/workspace-token';
import { getProviderByPanelType } from '@/lib/providers';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { isValidReasoningForPanelType, reasoningErrorForPanelType } from '@/lib/agent-effort';
import { buildClaudeFlags, buildRemoteClaudeLaunch, isValidModelName } from '@/lib/claude-command';
import { grokProvider } from '@/lib/providers/grok';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';
import { agentLaunchConfigFromOptions } from '@/lib/agent-launch-policy';
import { checkAgentDispatchPolicy } from '@/lib/agent-dispatch-policy';
import { checkReportsTo } from '@/lib/reports-to';
import { tabIdentityOf } from '@/lib/tab-token';
import { RemoteHostError, isValidRemoteHostName, readRemoteHosts, remoteDirExists } from '@/lib/remote-host';
import fs from 'fs/promises';
import path from 'path';
import {
  prepareCodexManagedLaunch,
  submitCodexManagedLaunch,
  waitForCodexManagedLaunch,
} from '@/lib/providers/codex/managed-launch';
import type { TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import type { ILastEvent } from '@/types/status';
import { remoteHostUnreachableBody } from '@/lib/cli-error';

const log = createLogger('api:cli:tabs');

const VALID_PANEL_TYPES: TPanelType[] = ['terminal', 'claude-code', 'codex-cli', 'grok-cli', 'agent-sessions', 'web-browser', 'diff'];

type TRemoteHostCheck = { ok: true; host: string } | { ok: false; status: number; body: Record<string, unknown> };

/** Why each type cannot run on a remote host (ADR-0022). */
const REMOTE_TYPE_REFUSAL: Partial<Record<TPanelType, string>> = {
  'codex-cli': 'codex-cli cannot run on a remote host: its managed launch proves the Codex process on this host (ADR-0021, ADR-0022)',
  'grok-cli': 'grok-cli cannot run on a remote host yet: there is no remote hook for it (ADR-0022)',
};

/** A remote tab (ADR-0022): a registered host, and a terminal or a claude-code tab. */
const checkRemoteHost = async (host: unknown, panelType: TPanelType): Promise<TRemoteHostCheck> => {
  if (panelType !== 'terminal' && panelType !== 'claude-code') {
    const error = REMOTE_TYPE_REFUSAL[panelType] ?? `only terminal and claude-code tabs run on a remote host (ADR-0022); ${panelType} does not`;
    return { ok: false, status: 400, body: { error, code: 'remote-type-unsupported', panelType } };
  }
  let registered: string[];
  try {
    registered = await readRemoteHosts();
  } catch (err) {
    return { ok: false, status: 500, body: { error: err instanceof Error ? err.message : 'fleet config unreadable', code: 'config-store-unreadable' } };
  }
  if (!isValidRemoteHostName(host) || !registered.includes(host)) {
    return { ok: false, status: 400, body: { error: `host is not a registered remote host; set fleet config remote.hosts (ADR-0022)`, code: 'remote-host-invalid', host: typeof host === 'string' ? host : null, registered } };
  }
  return { ok: true, host };
};

type TCwdCheck = { ok: true } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * `--cwd`: an absolute directory that exists on the host the tab runs on. A
 * remote worker works in its own checkout there; this host's tree says nothing
 * about it (ADR-0022).
 */
const checkCwd = async (cwd: unknown, host: string | undefined): Promise<TCwdCheck> => {
  const where = host ?? 'this host';
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\0\n\r]/.test(cwd)) {
    return { ok: false, status: 400, body: { error: 'cwd must be an absolute directory path', code: 'cwd-missing', cwd: typeof cwd === 'string' ? cwd : null } };
  }
  let exists: boolean;
  if (host) {
    try {
      exists = await remoteDirExists(host, cwd);
    } catch (err) {
      if (err instanceof RemoteHostError) return { ok: false, status: 503, body: remoteHostUnreachableBody(err) };
      throw err;
    }
  } else {
    exists = await fs.stat(cwd).then((st) => st.isDirectory(), () => false);
  }
  if (!exists) return { ok: false, status: 400, body: { error: `${cwd} is not a directory on ${where}; create it there first (a remote worker uses its own checkout or worktree)`, code: 'cwd-missing', cwd, host: host ?? null } };
  return { ok: true };
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  const cliScope = resolveCliScope(req, { response: res });
  if (!cliScope) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method === 'GET') {
    const wsId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    if (wsId && !(await authorizeWorkspace(req, res, wsId))) return;
    const tabs: Array<{
      tabId: string;
      workspaceId: string;
      name: string;
      sessionName: string;
      panelType?: string;
      agentProviderId: string | null;
      agentSessionId: string | null;
      agentLaunchConfig?: { model?: string; effort?: string };
      cliState: TCliState | null;
      lastEvent: ILastEvent | null;
      busySince: number | null;
      reportsTo: string | null;
      /** launch: the server bound its token at launch; hook: taken at a SessionStart (story 36); none: no tab identity. */
      identity: 'launch' | 'hook' | 'none';
      /** The remote host that runs the tab (ADR-0022); absent for a local tab. */
      host?: string;
    }> = [];

    // An unscoped list must not become a directory of every other epic's
    // workers: a workspace-scoped caller sees only what it may read.
    const allWorkspaceIds = (await getWorkspaces()).workspaces.map((w) => w.id);
    const visibleIds = wsId
      ? [wsId]
      : (await Promise.all(
          allWorkspaceIds.map(async (id) => ((await canAccessWorkspace(cliScope, id)) ? id : null)),
        )).filter((id): id is string => id !== null);
    const workspaceIds = visibleIds;
    // Live state lets a deploy drain tell a mid-turn agent from one kept busy
    // only by open background work (last event `stop`).
    const liveStatus = getStatusManager().getAllForClient();

    for (const id of workspaceIds) {
      const ws = await getWorkspaceById(id);
      if (!ws) continue;
      const layout = await readWorkspaceLayout(id);
      if (!layout) continue;
      for (const pane of collectPanes(layout.root)) {
        for (const tab of pane.tabs) {
          const provider = getProviderByPanelType(tab.panelType);
          tabs.push({
            tabId: tab.id,
            workspaceId: id,
            name: tab.name,
            sessionName: tab.sessionName,
            panelType: tab.panelType,
            agentProviderId: provider?.id ?? null,
            agentSessionId: provider?.readSessionId(tab) ?? null,
            agentLaunchConfig: tab.agentLaunchConfig,
            cliState: liveStatus[tab.id]?.cliState ?? tab.cliState ?? null,
            lastEvent: liveStatus[tab.id]?.lastEvent ?? null,
            busySince: liveStatus[tab.id]?.busySince ?? null,
            reportsTo: tab.reportsTo ?? null,
            identity: tab.panelType === 'web-browser' ? 'none' : tabIdentityOf(id, tab.id),
            ...(tab.host ? { host: tab.host } : {}),
          });
        }
      }
    }
    return res.status(200).json({ tabs });
  }

  if (req.method === 'POST') {
    const { workspaceId, name, panelType, model, reasoning, launch, scope, reportsTo, host, cwd } = req.body as {
      workspaceId?: string;
      name?: string;
      panelType?: string;
      model?: string;
      reasoning?: string;
      launch?: boolean;
      scope?: unknown;
      reportsTo?: unknown;
      host?: unknown;
      cwd?: unknown;
    };
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required' });
    }
    if (!(await authorizeWorkspace(req, res, workspaceId))) return;
    if (scope !== undefined && (!Array.isArray(scope) || scope.some((s) => typeof s !== 'string'))) {
      return res.status(400).json({ error: 'scope must be an array of path globs' });
    }
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    if (reportsTo !== undefined && reportsTo !== null) {
      const refused = await checkReportsTo(workspaceId, reportsTo);
      if (refused) return res.status(400).json(refused);
    }
    const dispatchPolicy = await checkAgentDispatchPolicy(workspaceId);
    if (!dispatchPolicy.ok) {
      return res.status(409).json(dispatchPolicy);
    }
    const paneId = await resolveFirstPaneId(workspaceId);
    if (!paneId) {
      return res.status(500).json({ error: 'No pane available in workspace' });
    }
    if (panelType !== undefined && !VALID_PANEL_TYPES.includes(panelType as TPanelType)) {
      return res.status(400).json({
        error: 'Invalid panelType',
        validPanelTypes: VALID_PANEL_TYPES,
      });
    }
    const resolvedType: TPanelType = panelType ? (panelType as TPanelType) : 'terminal';
    let remoteHost: string | undefined;
    if (host !== undefined) {
      const checked = await checkRemoteHost(host, resolvedType);
      if (!checked.ok) return res.status(checked.status).json(checked.body);
      remoteHost = checked.host;
    }
    if (cwd !== undefined) {
      const checkedCwd = await checkCwd(cwd, remoteHost);
      if (!checkedCwd.ok) return res.status(checkedCwd.status).json(checkedCwd.body);
    }
    const availability = await checkAgentAvailabilityForPanelType(resolvedType);
    if (!availability.ok) {
      return res.status(availability.status).json(toAgentAvailabilityError(availability));
    }
    if (model !== undefined && !isValidModelName(model)) {
      return res.status(400).json({ error: 'Invalid model' });
    }
    // Each engine has its own effort vocabulary; validate against the one the
    // tab will actually launch so a typo fails here, not silently at runtime.
    if (reasoning !== undefined) {
      if (!isValidReasoningForPanelType(resolvedType, reasoning)) {
        return res.status(400).json({ error: reasoningErrorForPanelType(resolvedType) });
      }
    }

    // Agent tabs launch their CLI by default (mirrors UI tab creation) —
    // a bare shell made `tab send` briefs land in bash, not the agent.
    const shouldLaunch = launch !== false && isAgentPanelType(resolvedType);
    let command: string | undefined;
    if (shouldLaunch) {
      if (resolvedType === 'claude-code') {
        command = remoteHost
          ? await buildRemoteClaudeLaunch(workspaceId, { model, effort: reasoning })
          : `claude ${await buildClaudeFlags(workspaceId, { model, effort: reasoning })}`;
      } else if (resolvedType === 'grok-cli') {
        // Catch-all else is codex; routing grok through it launched codex
        // inside a grok tab. Pin model/effort at launch the same as the others.
        command = await grokProvider.buildLaunchCommand({ workspaceId, model, effort: reasoning });
      }
    }

    try {
      const tab = await addTabToPane(workspaceId, paneId, name, typeof cwd === 'string' ? cwd : ws.directories[0], resolvedType, command, {
        scope: scope as string[] | undefined,
        agentLaunchConfig: agentLaunchConfigFromOptions(model, reasoning),
        reportsTo: typeof reportsTo === 'string' ? reportsTo : undefined,
        host: remoteHost,
      });
      if (!tab) return res.status(500).json({ error: 'Failed to create tab' });

      if (tab.panelType !== 'web-browser') {
        const provider = getProviderByPanelType(tab.panelType);
        getStatusManager().registerTab(tab.id, {
          cliState: 'inactive',
          workspaceId,
          tabName: tab.name,
          tmuxSession: tab.sessionName,
          panelType: tab.panelType,
          agentProviderId: provider?.id,
          agentSessionId: provider?.readSessionId(tab) ?? null,
          reportsTo: tab.reportsTo ?? null,
          lastEvent: null,
          eventSeq: 0,
        });
        if (command) getStatusManager().markAgentLaunch(tab.id);
      }

      let codexLaunchState: 'active' | 'held' | undefined;
      if (shouldLaunch && resolvedType === 'codex-cli') {
        const prepared = await prepareCodexManagedLaunch(workspaceId, tab.id);
        if (!prepared.ok) {
          return res.status(500).json({
            error: 'Failed to prepare Codex launch',
            reason: prepared.reason,
            tabId: tab.id,
            launchState: 'held',
          });
        }
        const submitted = await submitCodexManagedLaunch(workspaceId, tab.id, prepared.launch.generation);
        if (!submitted.ok) {
          return res.status(500).json({
            error: 'Failed to submit Codex launch',
            reason: submitted.reason,
            tabId: tab.id,
            generation: submitted.generation,
            launchState: submitted.phase,
          });
        }
        const activated = await waitForCodexManagedLaunch(workspaceId, tab.id, submitted.generation);
        codexLaunchState = activated.ok ? activated.phase : 'held';
        if (!activated.ok) {
          return res.status(503).json({
            error: 'Codex launch was not confirmed',
            reason: activated.reason,
            tabId: tab.id,
            generation: activated.generation,
            launchState: activated.phase,
          });
        }
      }

      return res.status(201).json({
        tabId: tab.id,
        workspaceId,
        paneId,
        sessionName: tab.sessionName,
        name: tab.name,
        panelType: tab.panelType,
        agentProviderId: null,
        agentSessionId: null,
        agentLaunchConfig: tab.agentLaunchConfig,
        launched: !!command || codexLaunchState === 'active',
        ...(codexLaunchState ? { launchState: codexLaunchState } : {}),
        ...(tab.host ? { host: tab.host } : {}),
      });
    } catch (err) {
      if (err instanceof RemoteHostError) {
        return res.status(503).json(remoteHostUnreachableBody(err));
      }
      const msg = err instanceof Error ? err.message : 'unknown error';
      log.error(`create tab failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
