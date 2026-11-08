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
import { isValidModelName } from '@/lib/claude-command';
import { buildFreshLaunchCommand, launchCodexManaged } from '@/lib/agent-launch';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';
import { agentLaunchConfigFromOptions } from '@/lib/agent-launch-policy';
import { checkAgentDispatchPolicy } from '@/lib/agent-dispatch-policy';
import { checkReportOn, checkReportsTo, isReportOnInvalid } from '@/lib/reports-to';
import { tabIdentityOf } from '@/lib/tab-token';
import { RemoteHostError, isValidRemoteHostName, originName, readRemoteHosts, remoteDirExists } from '@/lib/remote-host';
import fs from 'fs/promises';
import path from 'path';
import type { TPanelType, TTabRole } from '@/types/terminal';
import type { TCliState, TStartupPrompt } from '@/types/timeline';
import { startupPromptBody } from '@/lib/startup-prompt';
import type { ILastEvent } from '@/types/status';
import { remoteHostUnreachableBody, remoteKitBrokenBody } from '@/lib/cli-error';
import { RemoteKitBrokenError } from '@/lib/remote-kit';
import { WipCapError, admitAgentCreate, auditOverCap } from '@/lib/tab-cap';
import { checkEvaluatorBrowser, checkTabRole } from '@/lib/tab-role';
import { AUTO_HOST, resolveAutoHost, type IAutoPlacement } from '@/lib/pool-tab-placement';
import { placeOnPool } from '@/lib/pool-service';
import { checkSeatOptions } from '@/lib/context-lifecycle';
import type { TRotateAt } from '@/types/context-lifecycle';

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
const isCwdShape = (cwd: unknown): cwd is string => typeof cwd === 'string' && path.isAbsolute(cwd) && !/[\0\n\r]/.test(cwd);

const CWD_SHAPE_REFUSAL = (cwd: unknown): TCwdCheck =>
  ({ ok: false, status: 400, body: { error: 'cwd must be an absolute directory path', code: 'cwd-missing', cwd: typeof cwd === 'string' ? cwd : null } });

const checkCwd = async (cwd: unknown, host: string | undefined): Promise<TCwdCheck> => {
  const where = host ?? 'this host';
  if (!isCwdShape(cwd)) return CWD_SHAPE_REFUSAL(cwd);
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
      /** A `startup-prompt` tab's dialog, its label and since when (D14); absent in every other state. */
      startupPrompt?: TStartupPrompt | null;
      startupPromptLabel?: string;
      startupPromptSince?: number | null;
      lastEvent: ILastEvent | null;
      busySince: number | null;
      reportsTo: string | null;
      /** The markers whose end lines the tab forwards (ADR-0025); null: every marker. */
      reportOn: string[] | null;
      /** launch: the server bound its token at launch; hook: taken at a SessionStart (story 36); none: no tab identity. */
      identity: 'launch' | 'hook' | 'none';
      /** The remote host that runs the tab (ADR-0022); absent for a local tab. */
      host?: string;
      /** The tab's fixed tool configuration (ADR-0040); absent for an ordinary tab. */
      role?: TTabRole;
      previewOrigin?: string;
      pgService?: string;
      /** The seat's handoff file (ADR-0036); absent for a tab that never rotates. */
      handoffPath?: string;
      rotateAt?: TRotateAt;
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
            ...startupPromptBody(liveStatus[tab.id]?.cliState, liveStatus[tab.id]?.startupPrompt),
            lastEvent: liveStatus[tab.id]?.lastEvent ?? null,
            busySince: liveStatus[tab.id]?.busySince ?? null,
            reportsTo: tab.reportsTo ?? null,
            reportOn: tab.reportOn ?? null,
            identity: tab.panelType === 'web-browser' ? 'none' : tabIdentityOf(id, tab.id),
            ...(tab.host ? { host: tab.host } : {}),
            ...(tab.role ? { role: tab.role } : {}),
            ...(tab.previewOrigin ? { previewOrigin: tab.previewOrigin } : {}),
            ...(tab.pgService ? { pgService: tab.pgService } : {}),
            ...(tab.handoffPath ? { handoffPath: tab.handoffPath } : {}),
            ...(tab.rotateAt !== undefined ? { rotateAt: tab.rotateAt } : {}),
          });
        }
      }
    }
    return res.status(200).json({ tabs });
  }

  if (req.method === 'POST') {
    const { workspaceId, name, panelType, model, reasoning, launch, scope, reportsTo, reportOn, host, cwd, role, previewUrl, pgService, overCap, handoff, rotateAt } = req.body as {
      workspaceId?: string;
      name?: string;
      panelType?: string;
      model?: string;
      reasoning?: string;
      launch?: boolean;
      scope?: unknown;
      reportsTo?: unknown;
      reportOn?: unknown;
      host?: unknown;
      cwd?: unknown;
      role?: unknown;
      previewUrl?: unknown;
      pgService?: unknown;
      overCap?: unknown;
      handoff?: unknown;
      rotateAt?: unknown;
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
    // The markers whose end lines reach the target (ADR-0025); absent or null forwards every marker.
    const reportOnChecked = reportOn === undefined ? { markers: null } : checkReportOn(reportOn);
    if (isReportOnInvalid(reportOnChecked)) return res.status(400).json(reportOnChecked);
    const seat = checkSeatOptions(handoff, rotateAt);
    if (!seat.ok) return res.status(400).json(seat);
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
    // `--host auto` (ADR-0039 §4): a role tab is placed here, so its role check sees no host.
    const roleCheck = checkTabRole(role, panelType as TPanelType | undefined, host === AUTO_HOST ? undefined : host, previewUrl, pgService);
    if (!roleCheck.ok) return res.status(400).json(roleCheck.body);
    if (roleCheck.role === 'evaluator') {
      const browser = await checkEvaluatorBrowser();
      if (!browser.ok) return res.status(400).json({ error: browser.error, code: 'invalid-request', role: roleCheck.role });
    }
    const resolvedType: TPanelType = panelType ? (panelType as TPanelType) : roleCheck.role ? 'claude-code' : 'terminal';
    let remoteHost: string | undefined;
    let autoPlacement: IAutoPlacement | null = null;
    let requestedHost: unknown = host;
    let cwdCheckedOnHost = false;
    if (host === AUTO_HOST) {
      if (cwd !== undefined && !isCwdShape(cwd)) {
        const refused = CWD_SHAPE_REFUSAL(cwd);
        if (!refused.ok) return res.status(refused.status).json(refused.body);
      }
      const auto = await resolveAutoHost(
        { panelType: resolvedType, role: roleCheck.role ?? undefined, cwd: isCwdShape(cwd) ? cwd : undefined },
        { place: placeOnPool, cwdOnHost: remoteDirExists, localName: originName },
      );
      autoPlacement = auto.placement;
      requestedHost = auto.host;
      cwdCheckedOnHost = !!auto.cwdChecked;
    }
    if (requestedHost !== undefined) {
      const checked = await checkRemoteHost(requestedHost, resolvedType);
      if (!checked.ok) return res.status(checked.status).json(checked.body);
      remoteHost = checked.host;
    }
    if (cwd !== undefined && !cwdCheckedOnHost) {
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
    const wipCheck = await admitAgentCreate(req, workspaceId, resolvedType, overCap);
    if (!wipCheck.ok) return res.status(wipCheck.status).json(wipCheck.body);
    const { admission } = wipCheck;

    // Agent tabs launch their CLI by default (mirrors UI tab creation) —
    // a bare shell made `tab send` briefs land in bash, not the agent.
    const shouldLaunch = launch !== false && isAgentPanelType(resolvedType);
    const agentLaunchConfig = agentLaunchConfigFromOptions(model, reasoning);
    const command = shouldLaunch
      ? await buildFreshLaunchCommand(workspaceId, { panelType: resolvedType, host: remoteHost, agentLaunchConfig, role: roleCheck.role, previewOrigin: roleCheck.previewOrigin, pgService: roleCheck.pgService })
      : undefined;

    try {
      const tab = await addTabToPane(workspaceId, paneId, name, typeof cwd === 'string' ? cwd : ws.directories[0], resolvedType, command, {
        scope: scope as string[] | undefined,
        agentLaunchConfig,
        reportsTo: typeof reportsTo === 'string' ? reportsTo : undefined,
        reportOn: reportOnChecked.markers ?? undefined,
        host: remoteHost,
        role: roleCheck.role,
        previewOrigin: roleCheck.previewOrigin,
        pgService: roleCheck.pgService,
        admit: admission?.admit,
        ...seat.options,
      });
      if (!tab) return res.status(500).json({ error: 'Failed to create tab' });
      const wip = admission?.wip() ?? null;
      if (wip && admission?.passedCap() && wipCheck.overCapReason !== null && wipCheck.caller) {
        await auditOverCap({ workspaceId, tabId: tab.id, wip, reason: wipCheck.overCapReason, caller: wipCheck.caller });
      }

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
          reportOn: tab.reportOn ?? null,
          handoffPath: tab.handoffPath ?? null,
          rotateAt: tab.rotateAt ?? null,
          host: tab.host ?? null,
          lastEvent: null,
          eventSeq: 0,
        });
        if (tab.handoffPath) getStatusManager().registerSeat(tab.id);
        if (command) getStatusManager().markAgentLaunch(tab.id);
      }

      let codexLaunchState: 'active' | 'held' | undefined;
      if (shouldLaunch && resolvedType === 'codex-cli') {
        const launched = await launchCodexManaged(workspaceId, tab.id);
        if (!launched.ok && launched.step === 'prepare') {
          return res.status(500).json({
            error: 'Failed to prepare Codex launch',
            reason: launched.reason,
            tabId: tab.id,
            launchState: 'held',
            ...(wip ? { wip } : {}),
          });
        }
        if (!launched.ok && launched.step === 'submit') {
          return res.status(500).json({
            error: 'Failed to submit Codex launch',
            reason: launched.reason,
            tabId: tab.id,
            generation: launched.generation,
            launchState: launched.phase,
            ...(wip ? { wip } : {}),
          });
        }
        if (!launched.ok) {
          return res.status(503).json({
            error: 'Codex launch was not confirmed',
            reason: launched.reason,
            tabId: tab.id,
            generation: launched.generation,
            launchState: launched.phase,
            ...(wip ? { wip } : {}),
          });
        }
        codexLaunchState = 'active';
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
        ...(tab.reportsTo ? { reportsTo: tab.reportsTo } : {}),
        ...(tab.reportOn ? { reportOn: tab.reportOn } : {}),
        ...(codexLaunchState ? { launchState: codexLaunchState } : {}),
        ...(tab.host ? { host: tab.host } : {}),
        ...(tab.role ? { role: tab.role } : {}),
        ...(tab.previewOrigin ? { previewOrigin: tab.previewOrigin } : {}),
        ...(tab.pgService ? { pgService: tab.pgService } : {}),
        ...(tab.handoffPath ? { handoffPath: tab.handoffPath } : {}),
        ...(tab.rotateAt !== undefined ? { rotateAt: tab.rotateAt } : {}),
        ...(wip ? { wip } : {}),
        ...(autoPlacement ? { placement: autoPlacement } : {}),
      });
    } catch (err) {
      if (err instanceof WipCapError) return res.status(409).json(err.body);
      if (err instanceof RemoteHostError) {
        return res.status(503).json(remoteHostUnreachableBody(err));
      }
      if (err instanceof RemoteKitBrokenError) return res.status(502).json(remoteKitBrokenBody(err));
      const msg = err instanceof Error ? err.message : 'unknown error';
      log.error(`create tab failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
