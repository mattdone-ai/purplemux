import { prepareOrchestrationLaunch } from '@/lib/orchestration-activity';
import { withOrchestrationMappingRead, withOrchestrationMappingWrite } from '@/lib/orchestration-mapping-lock';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { nanoid } from 'nanoid';
import { createSession, hasSession, killSession, resolveExistingDir, sendKeys, workspaceSessionName } from '@/lib/tmux';
import { broadcastSync } from '@/lib/sync-server';
import { isAgentPanelType as isAgentPanel } from '@/lib/agent-panel-types';
import { createLogger } from '@/lib/logger';
import { emitTabClosing, hasKnownTabs, observeLayoutTabs, observeWorkspaceRemoved } from '@/lib/tab-lifecycle';
import { findTabIdBySession, revokeTabToken } from '@/lib/tab-token';
import { forgetSessionHost, registerSessionHost } from '@/lib/session-host';
import {
  collectPanes,
  collectAllTabs,
  findPane,
  replacePane,
  removePaneWithFocus,
  updateRatioAtPath,
  equalizeNode,
  isEqualized,
} from '@/lib/layout-tree';
import type { ITab, TLayoutNode, IPaneNode, ILayoutData, TPanelType, IDiffSettings, IAgentLaunchConfig } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import type { IAgentProvider } from '@/lib/providers/types';
import { claudeProvider } from '@/lib/providers/claude';
import { defaultTabNameForPanelType, resolveTabNameForPanelTypeChange } from '@/lib/tab-name';
import type { IReapResult } from '@/lib/tab-reaper';

const log = createLogger('layout');

const BASE_DIR = path.join(os.homedir(), '.purplemux');

const g = globalThis as unknown as {
  __ptLayoutLock?: Promise<void>;
  __ptLayoutContentCache?: Map<string, string>;
};
if (!g.__ptLayoutLock) g.__ptLayoutLock = Promise.resolve();
if (!g.__ptLayoutContentCache) g.__ptLayoutContentCache = new Map();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptLayoutLock!;
  g.__ptLayoutLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

export interface IAtomicTabMutation<T> {
  changed: boolean;
  value: T;
}

export type TAtomicTabMutationResult<T> =
  | { found: false }
  | { found: true; value: T; tab: ITab };

/**
 * Server-side compare-and-set seam for persisted tab runtime state. The
 * callback runs under the layout store's process-wide lock and must not await.
 */
export const mutateTabAtomically = async <T>(
  wsId: string,
  tabId: string,
  mutator: (tab: ITab) => IAtomicTabMutation<T>,
): Promise<TAtomicTabMutationResult<T>> => withLock(async () => {
  const filePath = resolveLayoutFile(wsId);
  const layout = await readLayoutFile(filePath);
  if (!layout) return { found: false };
  const tab = collectAllTabs(layout.root).find((candidate) => candidate.id === tabId);
  if (!tab) return { found: false };
  const result = mutator(tab);
  if (result.changed) {
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
  }
  return { found: true, value: result.value, tab: { ...tab } };
});

export const generatePaneId = (): string => `pane-${nanoid(6)}`;
export const generateTabId = (): string => `tab-${nanoid(6)}`;

export const resolveLayoutDir = (wsId: string): string =>
  path.join(BASE_DIR, 'workspaces', wsId);

export const resolveLayoutFile = (wsId: string): string =>
  path.join(resolveLayoutDir(wsId), 'layout.json');

const createDefaultTab = (wsId: string, paneId: string, order = 0, cwd?: string): ITab => {
  const tabId = generateTabId();
  const tab: ITab = {
    id: tabId,
    sessionName: workspaceSessionName(wsId, paneId, tabId),
    name: '',
    order,
  };
  if (cwd) tab.cwd = cwd;
  return tab;
};

const createDefaultPaneNode = (wsId: string, cwd?: string): { pane: IPaneNode; tab: ITab } => {
  const paneId = generatePaneId();
  const tab = createDefaultTab(wsId, paneId, 0, cwd);
  return {
    pane: { type: 'pane', id: paneId, tabs: [tab], activeTabId: tab.id },
    tab,
  };
};

export const readLayoutFile = async (filePath: string): Promise<ILayoutData | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  try {
    return JSON.parse(raw) as ILayoutData;
  } catch {
    log.warn(`${filePath} parse failed`);
    try {
      await fs.copyFile(filePath, filePath.replace(/\.json$/, '.json.bak'));
    } catch {}
    return null;
  }
};

const extractWsIdFromPath = (filePath: string): string | null => {
  const match = filePath.match(/workspaces\/(ws-[^/]+)\//);
  return match?.[1] ?? null;
};

export const writeLayoutFile = async (data: ILayoutData, filePath: string): Promise<void> => {
  const contentKey = JSON.stringify({ root: data.root, activePaneId: data.activePaneId, diffSettings: data.diffSettings });
  const cache = g.__ptLayoutContentCache!;

  if (cache.get(filePath) === contentKey) return;

  const wsId = extractWsIdFromPath(filePath);
  const previous = wsId && !hasKnownTabs(wsId) ? await readLayoutFile(filePath) : null;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = filePath + '.tmp';
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }

  cache.set(filePath, contentKey);

  if (wsId) {
    observeLayoutTabs(wsId, collectAllTabs(data.root), previous ? collectAllTabs(previous.root) : null);
    broadcastSync({ type: 'layout', workspaceId: wsId });
  }
};

export const removeLayoutFile = async (wsId: string): Promise<void> => {
  const previous = hasKnownTabs(wsId) ? null : await readLayoutFile(resolveLayoutFile(wsId));
  await fs.rm(resolveLayoutDir(wsId), { recursive: true, force: true });
  clearLayoutCache(wsId);
  observeWorkspaceRemoved(wsId, previous ? collectAllTabs(previous.root) : null);
  broadcastSync({ type: 'layout', workspaceId: wsId });
};

export const clearLayoutCache = (wsId: string): void => {
  const filePath = resolveLayoutFile(wsId);
  g.__ptLayoutContentCache!.delete(filePath);
};

export { collectPanes, collectAllTabs, normalizeTree } from '@/lib/layout-tree';

const syncWorkspaceDirectories = (wsId: string, root: TLayoutNode): void => {
  // A remote tab's cwd names another host's tree (ADR-0022 §7).
  const cwds = [...new Set(
    collectAllTabs(root)
      .filter((t) => !t.host)
      .map((t) => t.cwd)
      .filter((c): c is string => !!c),
  )];
  if (cwds.length > 0) {
    import('@/lib/workspace-store').then(({ updateWorkspaceDirectories }) => {
      updateWorkspaceDirectories(wsId, cwds).catch((err) => {
        log.warn(`Workspace ${wsId}: directory sync to [${cwds.join(', ')}] skipped: ${err instanceof Error ? err.message : err}`);
      });
    }).catch(() => {});
  }
};

export const isAgentPanelType = (panelType: TPanelType | undefined): boolean =>
  isAgentPanel(panelType);

export const crossCheckLayout = async (
  layout: ILayoutData,
  tmuxSessions: string[],
  wsId: string,
  defaultCwd?: string,
): Promise<boolean> => {
  let changed = false;
  const tmuxSet = new Set(tmuxSessions);
  const panes = collectPanes(layout.root);
  const layoutSessions = new Set<string>();

  for (const pane of panes) {
    for (const tab of pane.tabs) {
      if (tab.panelType === 'web-browser') continue;
      layoutSessions.add(tab.sessionName);

      // The local tmux list says nothing about a remote session, and a remote
      // tab recreated here would run its work on the wrong host (ADR-0022).
      if (tab.host) continue;
      if (!tmuxSet.has(tab.sessionName) && isAgentPanelType(tab.panelType)) {
        const cwd = tab.cwd || defaultCwd;
        log.debug(`crossCheck: agent tab session recreated: ${tab.sessionName} (cwd: ${cwd})`);
        await createSession(tab.sessionName, 80, 24, cwd, { workspaceId: wsId, tabId: tab.id });
        changed = true;
      }
    }
  }

  const orphans = tmuxSessions.filter((s) => !layoutSessions.has(s));
  if (orphans.length > 0) {
    changed = true;
    const firstPane = panes[0];
    if (firstPane) {
      const usedIds = new Set(collectAllTabs(layout.root).map((t) => t.id));
      // An orphan that carries a tab token keeps the id in its PMUX_TAB_ID, so
      // the layout id and the shell's own idea of its tab stay equal (ADR-0010).
      const adoptedId = (sessionName: string): string => {
        const own = findTabIdBySession(wsId, sessionName);
        const id = own && !usedIds.has(own) ? own : generateTabId();
        usedIds.add(id);
        return id;
      };
      let maxOrder = firstPane.tabs.length > 0 ? Math.max(...firstPane.tabs.map((t) => t.order)) : -1;
      for (const sessionName of orphans) {
        maxOrder++;
        firstPane.tabs.push({
          id: adoptedId(sessionName),
          sessionName,
          name: '',
          order: maxOrder,
        });
      }
      if (!firstPane.activeTabId && firstPane.tabs.length > 0) {
        firstPane.activeTabId = firstPane.tabs[0].id;
      }
    }
  }

  if (changed) {
    layout.updatedAt = new Date().toISOString();
    const finalPanes = collectPanes(layout.root);
    if (layout.activePaneId && !finalPanes.some((p) => p.id === layout.activePaneId)) {
      layout.activePaneId = finalPanes[0]?.id ?? null;
    }
  }

  return changed;
};

export interface ICreateLayoutOptions {
  panelType?: TPanelType;
}

export const createDefaultLayout = async (wsId: string, cwd: string, options?: ICreateLayoutOptions): Promise<ILayoutData> => {
  const { pane, tab } = createDefaultPaneNode(wsId, cwd);
  if (options?.panelType) tab.panelType = options.panelType;
  await createSession(tab.sessionName, 80, 24, cwd, { workspaceId: wsId, tabId: tab.id });
  return {
    root: pane,
    activePaneId: pane.id,
    updatedAt: new Date().toISOString(),
  };
};

export const getLayout = async (wsId: string, defaultCwd?: string): Promise<ILayoutData> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const existing = await readLayoutFile(filePath);
    if (existing) return existing;

    const { pane, tab } = createDefaultPaneNode(wsId, defaultCwd);
    await createSession(tab.sessionName, 80, 24, defaultCwd, { workspaceId: wsId, tabId: tab.id });

    const layout: ILayoutData = {
      root: pane,
      activePaneId: pane.id,
      updatedAt: new Date().toISOString(),
    };
    await writeLayoutFile(layout, filePath);
    return layout;
  });

export const createPane = async (wsId: string, cwd?: string): Promise<{ paneId: string; tab: ITab }> => {
  const paneId = generatePaneId();
  const tabId = generateTabId();
  const sessionName = workspaceSessionName(wsId, paneId, tabId);

  await createSession(sessionName, 80, 24, cwd, { workspaceId: wsId, tabId });

  const tab: ITab = { id: tabId, sessionName, name: '', order: 0, ...(cwd ? { cwd } : {}) };
  return { paneId, tab };
};

export const deletePane = async (
  paneId: string,
  sessions: string[] = [],
): Promise<void> => {
  for (const session of sessions) {
    try {
      await killSession(session);
    } catch {
      // session already gone
    }
  }
};

export const addTabToPane = async (wsId: string, paneId: string, name?: string, cwd?: string, panelType?: string, command?: string, opts?: { scope?: string[]; agentLaunchConfig?: IAgentLaunchConfig; reportsTo?: string; host?: string }): Promise<ITab | null> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return null;

    const isWebBrowser = panelType === 'web-browser';
    const tabId = generateTabId();
    const sessionName = workspaceSessionName(wsId, paneId, tabId);
    const host = !isWebBrowser ? opts?.host : undefined;
    if (!isWebBrowser) {
      // Before the session exists: every tmux call for it must already go to its host.
      if (host) registerSessionHost(sessionName, host);
      try {
        await createSession(sessionName, 80, 24, cwd, { workspaceId: wsId, tabId });
      } catch (err) {
        if (host) forgetSessionHost(sessionName);
        throw err;
      }
    }

    const nextOrder = pane.tabs.length > 0 ? Math.max(...pane.tabs.map((t) => t.order)) + 1 : 0;
    const defaultName = defaultTabNameForPanelType(panelType as ITab['panelType']);
    const tabName = name?.trim() || defaultName;
    const scope = opts?.scope?.map((s) => s.trim()).filter(Boolean);
    const tab: ITab = { id: tabId, sessionName, name: tabName, order: nextOrder, ...(cwd ? { cwd } : {}), ...(panelType ? { panelType: panelType as ITab['panelType'] } : {}), ...(scope?.length ? { scope } : {}), ...(opts?.agentLaunchConfig ? { agentLaunchConfig: opts.agentLaunchConfig } : {}), ...(opts?.reportsTo ? { reportsTo: opts.reportsTo } : {}), ...(host ? { host } : {}) };

    if (command && !isWebBrowser) prepareOrchestrationLaunch(tab);
    pane.tabs.push(tab);
    pane.activeTabId = tabId;
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
    syncWorkspaceDirectories(wsId,layout.root);
    if (command && !isWebBrowser) await sendKeys(sessionName, command);

    return tab;
  });

export interface ICloseTabResult {
  ok: boolean;
  /** The processes reaped with the tab (null for a browser tab or a session already gone). */
  reap: IReapResult | null;
}

export const removeTabFromPane = async (wsId: string, paneId: string, tabId: string): Promise<boolean> =>
  (await closeTab(wsId, paneId, tabId)).ok;

/** Close a tab: reap its processes, kill its session, remove it from the layout (ADR-0016). */
export const closeTab = async (
  wsId: string,
  paneId: string,
  tabId: string,
  opts: { keepProcesses?: boolean } = {},
): Promise<ICloseTabResult> => withOrchestrationMappingWrite(wsId, async () => {
  const tabInfo = await withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return null;

    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    return { sessionName: tab.sessionName, panelType: tab.panelType, pending: !!(tab.orchestrationActivity?.launch || tab.orchestrationActivity?.turn) };
  });

  if (!tabInfo) return { ok: false, reap: null };

  // Before the reap: the watchdog retires the tab's liveness checks and pending
  // nudges, so the processes this close kills never read as a death (L38).
  const closing = { workspaceId: wsId, tabId, sessionName: tabInfo.sessionName };
  emitTabClosing({ ...closing, phase: 'closing' });
  try {
    const result = await removeClosedTab(wsId, paneId, tabId, tabInfo, opts);
    if (!result.ok) emitTabClosing({ ...closing, phase: 'aborted' });
    return result;
  } catch (err) {
    emitTabClosing({ ...closing, phase: 'aborted' });
    throw err;
  }
});

const requireAbandonedRuntime = async (sessionName: string, reap: IReapResult | null): Promise<void> => {
  const { observeSessionStrict } = await import('@/lib/tmux');
  if (!reap || reap.reaper !== 'linux' || reap.survivors.length || (await observeSessionStrict(sessionName)).state !== 'absent') {
    throw new Error('Pending work retained: process reap or session absence is unconfirmed');
  }
};

const removeClosedTab = async (
  wsId: string,
  paneId: string,
  tabId: string,
  tabInfo: { sessionName: string; panelType: TPanelType | undefined; pending: boolean },
  opts: { keepProcesses?: boolean },
): Promise<ICloseTabResult> => {
  if (tabInfo.pending && opts.keepProcesses) throw new Error('Pending work requires a confirmed process reap');
  const reap = tabInfo.panelType !== 'web-browser'
    ? await killSession(tabInfo.sessionName, { tabId, keepProcesses: opts.keepProcesses })
    : null;
  if (tabInfo.pending) await requireAbandonedRuntime(tabInfo.sessionName, reap);

  const ok = await withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return false;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return false;

    const idx = pane.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return false;

    pane.tabs.splice(idx, 1);

    if (pane.activeTabId === tabId) {
      pane.activeTabId = pane.tabs[0]?.id ?? null;
    }

    if (pane.tabs.length === 0 && collectPanes(layout.root).length > 1) {
      removePaneWithFocus(layout, paneId);
    }

    pane.tabs.forEach((t, i) => { t.order = i; });
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
    syncWorkspaceDirectories(wsId, layout.root);

    return true;
  });
  if (ok) forgetSessionHost(tabInfo.sessionName);
  return { ok, reap };
};

export const renameTabInPane = async (wsId: string, paneId: string, tabId: string, name: string): Promise<ITab | null> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return null;

    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return null;

    tab.name = name;
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);

    return { ...tab };
  });

export const restartTabSession = async (wsId: string, paneId: string, tabId: string, command?: string): Promise<boolean> =>
  withOrchestrationMappingRead(wsId, () => withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return false;

    const pane = collectPanes(layout.root).find((p) => p.id === paneId);
    if (!pane) return false;

    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return false;

    if (tab.host) registerSessionHost(tab.sessionName, tab.host);
    const exists = await hasSession(tab.sessionName);
    if (exists) return true;

    // A remote cwd is checked by the remote tmux, which starts a missing one in HOME (ADR-0022 §8).
    const effectiveCwd = tab.host ? tab.cwd : await resolveExistingDir(tab.cwd);
    const cwdLost = Boolean(tab.cwd && tab.cwd !== effectiveCwd);

    await createSession(tab.sessionName, 80, 24, effectiveCwd, { workspaceId: wsId, tabId: tab.id });
    if (command && !cwdLost) {
      prepareOrchestrationLaunch(tab);
      layout.updatedAt = new Date().toISOString();
      await writeLayoutFile(layout, filePath);
      await sendKeys(tab.sessionName, command);
    }

    if (cwdLost) {
      log.warn(`tab cwd missing, falling back to ${effectiveCwd}: ${tab.sessionName} (was ${tab.cwd})`);
      tab.cwd = effectiveCwd;
      delete tab.lastCommand;
      layout.updatedAt = new Date().toISOString();
      await writeLayoutFile(layout, filePath);
    }
    return true;
  }));

export const reconcileTabCwd = async (sessionName: string): Promise<void> =>
  withLock(async () => {
    const parsed = parseSessionName(sessionName);
    if (!parsed) return;

    const filePath = resolveLayoutFile(parsed.wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return;

    const pane = collectPanes(layout.root).find((p) => p.id === parsed.paneId);
    if (!pane) return;
    const tab = pane.tabs.find((t) => t.id === parsed.tabId);
    // This host's filesystem says nothing about a remote tab's cwd (ADR-0022 §7).
    if (!tab || !tab.cwd || tab.host) return;

    const effectiveCwd = await resolveExistingDir(tab.cwd);
    if (effectiveCwd === tab.cwd) return;

    log.warn(`tab cwd missing, clearing: ${sessionName} (was ${tab.cwd})`);
    tab.cwd = effectiveCwd;
    delete tab.lastCommand;
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
  });

export const getFirstPaneTabs = async (wsId: string): Promise<{ tabs: ITab[]; activeTabId: string | null }> =>
  withLock(async () => {
    const layout = await readLayoutFile(resolveLayoutFile(wsId));
    if (!layout) return { tabs: [], activeTabId: null };
    const first = collectPanes(layout.root)[0];
    if (!first) return { tabs: [], activeTabId: null };
    return {
      tabs: [...first.tabs].sort((a, b) => a.order - b.order),
      activeTabId: first.activeTabId,
    };
  });

export const parseSessionName = (sessionName: string): { wsId: string; paneId: string; tabId: string } | null => {
  const match = sessionName.match(/^pt-(ws-.*?)-(pane-.*?)-(tab-.+)$/);
  if (!match) return null;
  return { wsId: match[1], paneId: match[2], tabId: match[3] };
};

/**
 * Read-only: the tab a tmux session belongs to, or null when no layout names it.
 * With `workspaceId`, only that workspace's layout is consulted — the caller's
 * own workspace, never one named by the session string.
 */
export const findTabBySessionName = async (sessionName: string, workspaceId?: string): Promise<ITab | null> => {
  const wsId = workspaceId ?? parseSessionName(sessionName)?.wsId;
  if (!wsId) return null;
  const layout = await readLayoutFile(resolveLayoutFile(wsId));
  if (!layout) return null;
  return collectAllTabs(layout.root).find((t) => t.sessionName === sessionName) ?? null;
};

const mutateTab = async (
  sessionName: string,
  mutator: (tab: ITab) => boolean,
): Promise<void> => {
  const parsed = parseSessionName(sessionName);
  if (!parsed) return;

  await withLock(async () => {
    const filePath = resolveLayoutFile(parsed.wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return;

    const tab = collectAllTabs(layout.root).find((t) => t.sessionName === sessionName);
    if (!tab) return;
    if (!mutator(tab)) return;

    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
  });
};

export const updateTabAgentSessionId = (
  sessionName: string,
  provider: IAgentProvider,
  sessionId: string | null,
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    if (provider.readSessionId(tab) === sessionId) return false;
    provider.writeSessionId(tab, sessionId);
    return true;
  });

export const updateTabAgentSummary = (
  sessionName: string,
  provider: IAgentProvider,
  summary: string | null,
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    if (provider.readSummary(tab) === summary) return false;
    provider.writeSummary(tab, summary);
    return true;
  });

export const updateTabAgentState = (
  sessionName: string,
  provider: IAgentProvider,
  state: {
    sessionId?: string | null;
    jsonlPath?: string | null;
    summary?: string | null;
    lastUserMessage?: string | null;
  },
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    let changed = false;
    if (state.sessionId !== undefined && provider.readSessionId(tab) !== state.sessionId) {
      provider.writeSessionId(tab, state.sessionId);
      changed = true;
    }
    if (state.jsonlPath !== undefined && provider.readJsonlPath(tab) !== state.jsonlPath) {
      provider.writeJsonlPath(tab, state.jsonlPath);
      changed = true;
    }
    if (state.summary !== undefined && provider.readSummary(tab) !== state.summary) {
      provider.writeSummary(tab, state.summary);
      changed = true;
    }
    if (state.lastUserMessage !== undefined && tab.lastUserMessage !== state.lastUserMessage) {
      tab.lastUserMessage = state.lastUserMessage;
      changed = true;
    }
    return changed;
  });

export const updateTabClaudeSessionId = (
  sessionName: string,
  claudeSessionId: string | null,
): Promise<void> => updateTabAgentSessionId(sessionName, claudeProvider, claudeSessionId);

export const updateTabClaudeSummary = (
  sessionName: string,
  claudeSummary: string | null,
): Promise<void> => updateTabAgentSummary(sessionName, claudeProvider, claudeSummary);

export const updateTabLastUserMessage = (
  sessionName: string,
  lastUserMessage: string | null,
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    if (tab.lastUserMessage === lastUserMessage) return false;
    tab.lastUserMessage = lastUserMessage;
    return true;
  });

export const updateTabCliStatus = (
  sessionName: string,
  cliState: TCliState,
  dismissedAt?: number | null,
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    if (tab.cliState === cliState && tab.dismissedAt === dismissedAt) return false;
    tab.cliState = cliState;
    tab.dismissedAt = dismissedAt;
    return true;
  });

/** Persist the watchdog's stop record (or clear it with null); unchanged content is not written. */
export const updateTabWatchdogTurnEnd = (
  sessionName: string,
  record: ITab['watchdogTurnEnd'],
): Promise<void> =>
  mutateTab(sessionName, (tab) => {
    const next = record ?? null;
    if (JSON.stringify(tab.watchdogTurnEnd ?? null) === JSON.stringify(next)) return false;
    if (next) tab.watchdogTurnEnd = next;
    else delete tab.watchdogTurnEnd;
    return true;
  });

export const updateTabAgentLaunchConfig = async (
  wsId: string,
  paneId: string,
  tabId: string,
  agentLaunchConfig: IAgentLaunchConfig | null,
): Promise<ITab | null> => {
  const result = await mutate(wsId, (layout) => {
    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    const tab = pane.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return null;
    if (agentLaunchConfig) {
      tab.agentLaunchConfig = { ...agentLaunchConfig };
    } else {
      delete tab.agentLaunchConfig;
    }
    return layout;
  });
  if (!result) return null;
  return findPane(result.root, paneId)?.tabs.find((tab) => tab.id === tabId) ?? null;
};

const mutate = async (
  wsId: string,
  fn: (layout: ILayoutData) => ILayoutData | null,
): Promise<ILayoutData | null> =>
  withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const result = fn(layout);
    if (!result) return null;

    result.updatedAt = new Date().toISOString();
    await writeLayoutFile(result, filePath);
    syncWorkspaceDirectories(wsId, result.root);
    return result;
  });

/** Set or clear the tab a tab reports to; false when the tab is gone. */
export const setTabReportsTo = async (wsId: string, tabId: string, reportsTo: string | null): Promise<boolean> =>
  (await mutateTabAtomically(wsId, tabId, (tab) => {
    if ((tab.reportsTo ?? null) === reportsTo) return { changed: false, value: true };
    if (reportsTo) tab.reportsTo = reportsTo;
    else delete tab.reportsTo;
    return { changed: true, value: true };
  })).found;

/** Drop every `reportsTo` in a workspace that names a closed tab; the ids cleared. */
export const clearReportsTo = async (wsId: string, closedTabId: string): Promise<string[]> => {
  const cleared: string[] = [];
  await mutate(wsId, (layout) => {
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.reportsTo !== closedTabId) continue;
      delete tab.reportsTo;
      cleared.push(tab.id);
    }
    return cleared.length ? layout : null;
  });
  return cleared;
};

export const patchLayout = async (
  wsId: string,
  patch: { activePaneId?: string; ratioUpdate?: { path: number[]; ratio: number }; equalize?: boolean; diffSettings?: Partial<IDiffSettings> },
): Promise<ILayoutData | null> =>
  mutate(wsId, (layout) => {
    if (patch.activePaneId !== undefined) {
      const pane = findPane(layout.root, patch.activePaneId);
      if (!pane) return null;
      layout.activePaneId = patch.activePaneId;
    }
    if (patch.ratioUpdate) {
      layout.root = updateRatioAtPath(layout.root, patch.ratioUpdate.path, patch.ratioUpdate.ratio);
    }
    if (patch.equalize) {
      layout.root = equalizeNode(layout.root);
    }
    if (patch.diffSettings) {
      layout.diffSettings = {
        ...(layout.diffSettings ?? {}),
        ...patch.diffSettings,
      };
    }
    return layout;
  });

export const patchPane = async (
  wsId: string,
  paneId: string,
  patch: { activeTabId?: string },
): Promise<ILayoutData | null> =>
  mutate(wsId, (layout) => {
    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    if (patch.activeTabId !== undefined) {
      if (!pane.tabs.some((t) => t.id === patch.activeTabId)) return null;
      pane.activeTabId = patch.activeTabId;
    }
    return layout;
  });

export const splitPaneInLayout = async (
  wsId: string,
  sourcePaneId: string,
  orientation: 'horizontal' | 'vertical',
  cwd?: string,
  panelType?: string,
): Promise<ILayoutData | null> => {
  const isWebBrowser = panelType === 'web-browser';
  const paneId = generatePaneId();
  const tabId = generateTabId();
  const sessionName = workspaceSessionName(wsId, paneId, tabId);

  if (!isWebBrowser) {
    await createSession(sessionName, 80, 24, cwd, { workspaceId: wsId, tabId });
  }

  const defaultName = defaultTabNameForPanelType(panelType as ITab['panelType']);
  const tab: ITab = { id: tabId, sessionName, name: defaultName, order: 0, ...(cwd ? { cwd } : {}) };
  if (panelType) tab.panelType = panelType as ITab['panelType'];

  const newPane: IPaneNode = { type: 'pane', id: paneId, tabs: [tab], activeTabId: tabId };

  const result = await mutate(wsId, (layout) => {
    const existing = findPane(layout.root, sourcePaneId);
    if (!existing) return null;
    const wasEqualized = isEqualized(layout.root);
    if (cwd) {
      const activeTab = existing.tabs.find((t) => t.id === existing.activeTabId);
      if (activeTab) activeTab.cwd = cwd;
    }
    const splitNode: TLayoutNode = {
      type: 'split',
      orientation,
      ratio: 50,
      children: [{ ...existing }, newPane],
    };
    layout.root = replacePane(layout.root, sourcePaneId, splitNode);
    if (wasEqualized) {
      layout.root = equalizeNode(layout.root);
    }
    layout.activePaneId = paneId;
    return layout;
  });

  if (!result && !isWebBrowser) {
    await killSession(sessionName).catch(() => {});
    await revokeTabToken(tabId).catch(() => {});
  }

  return result;
};

export const closePaneInLayout = async (wsId: string, paneId: string): Promise<ILayoutData | null> => withOrchestrationMappingWrite(wsId, async () => {
  const result = await withLock(async () => {
    const filePath = resolveLayoutFile(wsId);
    const layout = await readLayoutFile(filePath);
    if (!layout) return null;

    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    if (collectPanes(layout.root).length <= 1) return null;

    for (const tab of pane.tabs.filter((t) => t.panelType !== 'web-browser')) {
      const reap = await killSession(tab.sessionName, { tabId: tab.id });
      if (tab.orchestrationActivity?.launch || tab.orchestrationActivity?.turn) await requireAbandonedRuntime(tab.sessionName, reap);
    }
    const wasEqualized = isEqualized(layout.root);
    removePaneWithFocus(layout, paneId);
    if (wasEqualized) {
      layout.root = equalizeNode(layout.root);
    }
    layout.updatedAt = new Date().toISOString();
    await writeLayoutFile(layout, filePath);
    syncWorkspaceDirectories(wsId, layout.root);
    return layout;
  });

  return result;
});

export const reorderTabsInPane = async (
  wsId: string,
  paneId: string,
  tabIds: string[],
): Promise<ILayoutData | null> =>
  mutate(wsId, (layout) => {
    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    const tabMap = new Map(pane.tabs.map((t) => [t.id, t]));
    const reordered = tabIds
      .map((id, i) => {
        const t = tabMap.get(id);
        return t ? { ...t, order: i } : null;
      })
      .filter((t): t is ITab => t !== null);
    if (reordered.length !== pane.tabs.length) return null;
    pane.tabs = reordered;
    return layout;
  });

export const moveTabBetweenPanes = async (
  wsId: string,
  tabId: string,
  fromPaneId: string,
  toPaneId: string,
  toIndex: number,
): Promise<ILayoutData | null> => {
  return mutate(wsId, (layout) => {
    const fromPane = findPane(layout.root, fromPaneId);
    const toPane = findPane(layout.root, toPaneId);
    if (!fromPane || !toPane) return null;

    const tabIdx = fromPane.tabs.findIndex((t) => t.id === tabId);
    if (tabIdx === -1) return null;

    const [tab] = fromPane.tabs.splice(tabIdx, 1);
    if (fromPane.activeTabId === tabId) {
      fromPane.activeTabId = fromPane.tabs[0]?.id ?? null;
    }
    fromPane.tabs.forEach((t, i) => { t.order = i; });

    toPane.tabs.splice(toIndex, 0, tab);
    toPane.tabs.forEach((t, i) => { t.order = i; });
    toPane.activeTabId = tabId;

    if (fromPane.tabs.length === 0 && collectPanes(layout.root).length > 1) {
      removePaneWithFocus(layout, fromPaneId);
    }

    layout.activePaneId = toPaneId;
    return layout;
  });
};

export const patchTab = async (
  wsId: string,
  paneId: string,
  tabId: string,
  patch: Partial<Pick<ITab, 'name' | 'panelType' | 'title' | 'cwd' | 'lastCommand' | 'webUrl' | 'terminalRatio' | 'terminalCollapsed'>>,
): Promise<ILayoutData | null> => withOrchestrationMappingRead(wsId, async () => {
  let authoritativeCwd: string | null | undefined;
  let authoritativeTitle: string | null | undefined;
  if (patch.cwd !== undefined || patch.title !== undefined) {
    const tabInfo = await (async () => {
      const filePath = resolveLayoutFile(wsId);
      const layout = await readLayoutFile(filePath);
      if (!layout) return null;
      const tab = findPane(layout.root, paneId)?.tabs.find((t) => t.id === tabId);
      return tab ? { sessionName: tab.sessionName, panelType: patch.panelType ?? tab.panelType } : null;
    })();
    if (tabInfo?.sessionName) {
      const { getSessionCwd, getPaneCurrentCommand } = await import('@/lib/tmux');
      const { formatTabTitle } = await import('@/lib/tab-title');
      if (patch.cwd !== undefined) {
        authoritativeCwd = await getSessionCwd(tabInfo.sessionName);
      }
      if (patch.title !== undefined) {
        const [cmd, cwd] = await Promise.all([
          getPaneCurrentCommand(tabInfo.sessionName),
          authoritativeCwd !== undefined ? Promise.resolve(authoritativeCwd) : getSessionCwd(tabInfo.sessionName),
        ]);
        if (cmd && cwd) {
          authoritativeTitle = formatTabTitle(`${cmd}|${cwd}`, tabInfo.panelType);
        }
      }
    }
  }

  return mutate(wsId, (layout) => {
    const pane = findPane(layout.root, paneId);
    if (!pane) return null;
    const tab = pane.tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    const resolvedTitle = patch.title !== undefined ? (authoritativeTitle ?? patch.title) : undefined;
    if (patch.name !== undefined) tab.name = patch.name;
    if (patch.panelType !== undefined) {
      if (patch.name === undefined) {
        tab.name = resolveTabNameForPanelTypeChange(tab.name, tab.panelType, patch.panelType);
      }
      tab.panelType = patch.panelType;
    }
    if (resolvedTitle !== undefined) tab.title = resolvedTitle;
    if (patch.cwd !== undefined) tab.cwd = authoritativeCwd ?? patch.cwd;
    if (patch.lastCommand !== undefined) tab.lastCommand = patch.lastCommand;
    if (patch.webUrl !== undefined) tab.webUrl = patch.webUrl;
    if (patch.terminalRatio !== undefined) tab.terminalRatio = patch.terminalRatio;
    if (patch.terminalCollapsed !== undefined) tab.terminalCollapsed = patch.terminalCollapsed;
    return layout;
  });
});
