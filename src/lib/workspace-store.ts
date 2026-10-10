import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { nanoid } from 'nanoid';
import { listSessions, killSession } from '@/lib/tmux';
import { createLogger } from '@/lib/logger';
import { emitTabClosing } from '@/lib/tab-lifecycle';
import { RemoteHostError } from '@/lib/remote-host';
import { forgetSessionHost } from '@/lib/session-host';
import { broadcastSync } from '@/lib/sync-server';
import {
  readLayoutFile,
  writeLayoutFile,
  resolveLayoutDir,
  resolveLayoutFile,
  removeLayoutFile,
  crossCheckLayout,
  collectAllTabs,
  createDefaultLayout,
  closeRemoteTabsFirst,
} from '@/lib/layout-store';
import type { ICreateLayoutOptions } from '@/lib/layout-store';
import { listProviders } from '@/lib/providers/registry';
import { getVisuallyOrderedWorkspaces } from '@/lib/workspace-order';
import { removeWorkspaceGrokHome } from '@/lib/grok-home';
import {
  buildDirectoryValidation,
  directoryError,
  planDirectoryCreate,
  type IDirectoryValidation,
  type TDirectoryStat,
} from '@/lib/path-safety';
import { removeWorkspaceClaudeHome } from '@/lib/workspace-home';
import { revokeWorkspaceToken } from '@/lib/workspace-token';
import { revokeWorkspaceTabTokens } from '@/lib/tab-token';
import { normalizeOrchestration, OrchestrationError, requireOrchestrationRevision, type TOrchestrationPatch } from '@/lib/orchestration-contract';
import { withOrchestrationMappingWrite, withOrchestrationMappingRead } from '@/lib/orchestration-mapping-lock';
import type { IWorkspace, IWorkspaceGroup, IWorkspacesData, ILayoutData } from '@/types/terminal';

const log = createLogger('workspace');

const WORKSPACE_PREFIX = 'Workspace ';

export const writeWorkspacePrompts = async (ws: IWorkspace): Promise<void> => {
  const tasks: Promise<void>[] = [];
  for (const provider of listProviders()) {
    const task = provider.writeWorkspacePrompt?.(ws);
    if (task) tasks.push(task);
  }
  await Promise.all(tasks);
};

export const writeAllWorkspacePrompts = async (workspaces: IWorkspace[]): Promise<void> => {
  await Promise.all(workspaces.map(writeWorkspacePrompts));
};

const nextWorkspaceName = (workspaces: IWorkspace[]): string => {
  let max = 0;
  for (const ws of workspaces) {
    if (ws.name.startsWith(WORKSPACE_PREFIX)) {
      const n = parseInt(ws.name.slice(WORKSPACE_PREFIX.length), 10);
      if (n > max) max = n;
    }
  }
  return `${WORKSPACE_PREFIX}${max + 1}`;
};

const BASE_DIR = path.join(os.homedir(), '.purplemux');
const WORKSPACES_FILE = path.join(BASE_DIR, 'workspaces.json');
const LEGACY_LAYOUT_FILE = path.join(BASE_DIR, 'layout.json');
const LEGACY_TABS_FILE = path.join(BASE_DIR, 'tabs.json');

const g = globalThis as unknown as {
  __purplemuxWorkspaceLock?: Promise<void>;
  __purplemuxWorkspacesContentCache?: string;
};
if (!g.__purplemuxWorkspaceLock) g.__purplemuxWorkspaceLock = Promise.resolve();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__purplemuxWorkspaceLock!;
  g.__purplemuxWorkspaceLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const emptyState = (): IWorkspacesData => ({
  workspaces: [],
  groups: [],
  sidebarCollapsed: false,
  sidebarWidth: 240,
  updatedAt: new Date().toISOString(),
});

const ensureGroups = (data: IWorkspacesData): IWorkspaceGroup[] => {
  if (!data.groups) data.groups = [];
  return data.groups;
};

const normalizeWorkspaceOrder = (data: IWorkspacesData): void => {
  const groups = ensureGroups(data);
  data.workspaces = getVisuallyOrderedWorkspaces(data.workspaces, groups);
};

const readWorkspacesFile = async (): Promise<IWorkspacesData | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(WORKSPACES_FILE, 'utf-8');
  } catch {
    return null;
  }

  try {
    const data = JSON.parse(raw) as IWorkspacesData;
    for (const ws of data.workspaces) {
      ws.orchestration = normalizeOrchestration(ws.orchestration);
      const legacy = ws as unknown as { directory?: string; order?: number };
      if (!ws.directories && legacy.directory) {
        ws.directories = [legacy.directory];
        delete legacy.directory;
      }
      delete legacy.order;
    }
    if (!Array.isArray(data.groups)) data.groups = [];
    for (const g of data.groups) {
      delete (g as unknown as { order?: number }).order;
    }
    const validGroupIds = new Set(data.groups.map((g) => g.id));
    for (const ws of data.workspaces) {
      if (ws.groupId && !validGroupIds.has(ws.groupId)) {
        ws.groupId = null;
      }
    }
    return data;
  } catch (error) {
    if (error instanceof OrchestrationError) throw error;
    log.warn('Failed to parse workspaces.json, starting empty');
    try {
      await fs.copyFile(WORKSPACES_FILE, WORKSPACES_FILE.replace(/\.json$/, '.json.bak'));
    } catch {}
    return null;
  }
};

/**
 * The workspace ids, read strictly: a missing file means none, any other read
 * error or an unparseable file throws. `readWorkspacesFile` answers null for
 * both, which is right for the UI and wrong for a sweep that releases what it
 * cannot see.
 */
export const readWorkspacesStrict = async (): Promise<IWorkspacesData> => {
  try {
    const data = JSON.parse(await fs.readFile(WORKSPACES_FILE, 'utf-8')) as IWorkspacesData;
    if (!data || !Array.isArray(data.workspaces) || data.workspaces.some((ws) => !ws || typeof ws.id !== 'string')) throw new Error('Invalid workspaces registry');
    for (const ws of data.workspaces) ws.orchestration = normalizeOrchestration(ws.orchestration);
    return data;
  } catch (error) {
    throw new OrchestrationError(503, 'orchestration-unavailable', `Workspace registry unavailable: ${error instanceof Error ? error.message : error}`);
  }
};

export const getWorkspaceStrict = async (workspaceId: string): Promise<IWorkspace> => {
  const ws = (await readWorkspacesStrict()).workspaces.find((value) => value.id === workspaceId);
  if (!ws) throw new OrchestrationError(404, 'workspace-not-found', 'Workspace not found');
  return { ...ws, orchestration: normalizeOrchestration(ws.orchestration) };
};

export const readWorkspaceIdsStrict = async (): Promise<string[]> => {
  let raw: string;
  try {
    raw = await fs.readFile(WORKSPACES_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`${WORKSPACES_FILE} unreadable: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${WORKSPACES_FILE} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  const workspaces = (parsed as { workspaces?: unknown } | null)?.workspaces;
  if (!Array.isArray(workspaces)) throw new Error(`${WORKSPACES_FILE} has no "workspaces" array`);
  return workspaces.map((ws) => (ws as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string');
};

const writeWorkspacesFile = async (data: IWorkspacesData): Promise<void> => {
  normalizeWorkspaceOrder(data);
  const { workspaces, groups, activeWorkspaceId, sidebarCollapsed, sidebarWidth } = data;
  const contentKey = JSON.stringify({ workspaces, groups: groups ?? [], activeWorkspaceId, sidebarCollapsed, sidebarWidth });

  if (g.__purplemuxWorkspacesContentCache === contentKey) return;

  data.updatedAt = new Date().toISOString();
  const tmpFile = WORKSPACES_FILE + '.tmp';
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, WORKSPACES_FILE);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }

  g.__purplemuxWorkspacesContentCache = contentKey;
  broadcastSync({ type: 'workspace' });
};

const migrateFromPhase4 = async (): Promise<IWorkspacesData | null> => {
  const legacyLayout = await readLayoutFile(LEGACY_LAYOUT_FILE);
  if (!legacyLayout) return null;

  const wsId = 'ws-default';
  await fs.mkdir(resolveLayoutDir(wsId), { recursive: true });
  await writeLayoutFile(legacyLayout, resolveLayoutFile(wsId));

  const data: IWorkspacesData = {
    workspaces: [{
      id: wsId,
      name: 'default',
      directories: [os.homedir()],
    }],
    sidebarCollapsed: false,
    sidebarWidth: 240,
    updatedAt: legacyLayout.updatedAt || new Date().toISOString(),
  };

  await writeWorkspacesFile(data);
  log.info(`Phase 4 layout.json → Workspace 'default' migration complete`);
  return data;
};

const migrateFromTabs = async (): Promise<IWorkspacesData | null> => {
  try {
    const raw = await fs.readFile(LEGACY_TABS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tabs) || data.tabs.length === 0) return null;

    const paneId = `pane-${nanoid(6)}`;
    const legacyLayout: ILayoutData = {
      root: {
        type: 'pane',
        id: paneId,
        tabs: data.tabs,
        activeTabId: data.activeTabId ?? null,
      },
      activePaneId: paneId,
      updatedAt: new Date().toISOString(),
    };

    const tmpFile = LEGACY_LAYOUT_FILE + '.tmp';
    try {
      await fs.writeFile(tmpFile, JSON.stringify(legacyLayout, null, 2), { mode: 0o600 });
      await fs.rename(tmpFile, LEGACY_LAYOUT_FILE);
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      throw err;
    }
    log.info('tabs.json → layout.json migration complete');

    return await migrateFromPhase4();
  } catch {
    return null;
  }
};

export const initWorkspaceStore = async (mappingGuardsHeld = false): Promise<void> => {
  await fs.mkdir(path.join(BASE_DIR, 'workspaces'), { recursive: true });

  let data = await readWorkspacesFile();

  if (!data) {
    const layoutExists = await fs.access(LEGACY_LAYOUT_FILE).then(() => true).catch(() => false);
    if (layoutExists) {
      data = await migrateFromPhase4();
    } else {
      const tabsExists = await fs.access(LEGACY_TABS_FILE).then(() => true).catch(() => false);
      if (tabsExists) {
        data = await migrateFromTabs();
      }
    }
  }

  if (!data) {
    const state = emptyState();
    await writeWorkspacesFile(state);
    data = state;
    log.info('Initial workspaces.json created');
  }

  if (data.workspaces.length === 0) {
    return;
  }

  const allTmuxSessions = await listSessions();

  for (const ws of data.workspaces) {
    const reconcile = async () => {
    const layoutFile = resolveLayoutFile(ws.id);
    let layout = await readLayoutFile(layoutFile);

    if (!layout) {
      log.warn(`Workspace '${ws.name}': layout.json corrupted, reset to default pane`);
      layout = await createDefaultLayout(ws.id, ws.directories[0]);
      await writeLayoutFile(layout, layoutFile);
      return;
    }

    const wsTabs = collectAllTabs(layout.root);
    const wsSessionNames = wsTabs.map((t) => t.sessionName);

    const wsPrefix = `pt-${ws.id}-`;
    const relevantTmuxSessions = allTmuxSessions.filter(
      (s) => wsSessionNames.includes(s) || s.startsWith(wsPrefix),
    );

    try {
      const changed = await crossCheckLayout(layout, relevantTmuxSessions, ws.id, ws.directories[0]);
      if (changed) {
        await writeLayoutFile(layout, layoutFile);
      }
    } catch (err) {
      log.error(`Workspace '${ws.name}': tmux consistency check failed: ${err instanceof Error ? err.message : err}`);
    }

    };
    if (mappingGuardsHeld) await reconcile();
    else await withOrchestrationMappingRead(ws.id, reconcile);
  }
};

export const getWorkspaces = async (): Promise<{
  workspaces: IWorkspace[];
  groups: IWorkspaceGroup[];
  activeWorkspaceId?: string;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
}> => {
  const data = await readWorkspacesFile();
  if (!data) return { workspaces: [], groups: [], sidebarCollapsed: false, sidebarWidth: 220 };

  return {
    workspaces: data.workspaces,
    groups: data.groups ?? [],
    activeWorkspaceId: data.activeWorkspaceId,
    sidebarCollapsed: data.sidebarCollapsed,
    sidebarWidth: data.sidebarWidth,
  };
};

export const getActiveWorkspaceId = async (): Promise<string | null> => {
  const data = await readWorkspacesFile();
  if (data?.activeWorkspaceId && data.workspaces.some((w) => w.id === data.activeWorkspaceId)) {
    return data.activeWorkspaceId;
  }
  return data?.workspaces[0]?.id ?? null;
};

export const getWorkspaceById = async (wsId: string): Promise<IWorkspace | undefined> => {
  const data = await readWorkspacesFile();
  return data?.workspaces.find((w) => w.id === wsId);
};

const gMemo = globalThis as unknown as { __ptWorkspacesMemo?: { key: string; data: IWorkspacesData } };

/**
 * Read-only workspaces snapshot, memoized on the file's mtime+size.
 *
 * The alert predicate and the orchestrator nudge both need the workspace on
 * every agent state transition, and re-parsing workspaces.json per transition
 * buys nothing. Every writer goes through writeWorkspacesFile, which bumps
 * mtime and invalidates the memo. Callers must not mutate the result.
 */
export const getWorkspacesCached = async (): Promise<IWorkspacesData | null> => {
  let key: string;
  try {
    const stat = await fs.stat(WORKSPACES_FILE);
    key = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }

  const memo = gMemo.__ptWorkspacesMemo;
  if (memo && memo.key === key) return memo.data;

  const data = await readWorkspacesFile();
  if (data) gMemo.__ptWorkspacesMemo = { key, data };
  return data;
};

export const getWorkspaceByIdCached = async (wsId: string): Promise<IWorkspace | undefined> =>
  (await getWorkspacesCached())?.workspaces.find((w) => w.id === wsId);

// Claude keys its session store by cwd, which used to mean two workspaces in one
// directory shared conversation history and resume lists — so this file enforced
// one-directory-one-workspace, and every concurrent epic needed its own worktree.
// Each workspace now launches with its own CLAUDE_CONFIG_DIR (see
// lib/workspace-home.ts), so session identity no longer follows location and
// several workspaces can share a project root. Kept only to report the overlap.
const findPrimaryDirOwner = (data: IWorkspacesData, dir: string, excludeWsId?: string): IWorkspace | undefined => {
  const norm = path.resolve(dir);
  return data.workspaces.find((w) => w.id !== excludeWsId && w.directories[0] && path.resolve(w.directories[0]) === norm);
};

const statDirectory = async (directory: string): Promise<TDirectoryStat> => {
  try {
    const stat = await fs.stat(directory);
    return stat.isDirectory() ? 'directory' : 'file';
  } catch {
    return 'missing';
  }
};

export interface ICreateWorkspaceOptions {
  mkdir?: boolean;
}

export const createWorkspace = async (
  directory: string,
  name?: string,
  layoutOptions?: ICreateLayoutOptions,
  options?: ICreateWorkspaceOptions,
): Promise<IWorkspace> =>
  withLock(async () => {
    const plan = planDirectoryCreate({
      directory,
      home: os.homedir(),
      stat: await statDirectory(directory),
      mkdir: options?.mkdir === true,
    });

    if (plan.action === 'reject') throw directoryError(plan.error);

    if (plan.action === 'create') {
      try {
        await fs.mkdir(directory, { recursive: true });
      } catch (err) {
        throw directoryError(`Could not create directory: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
      log.info(`Created directory ${directory} for a new workspace`);
    }

    const data = (await readWorkspacesFile()) ?? emptyState();

    const owner = findPrimaryDirOwner(data, directory);
    if (owner) {
      log.info(`${directory} is also workspace "${owner.name}"'s primary directory; sessions stay separate via per-workspace CLAUDE_CONFIG_DIR`);
    }

    const wsId = `ws-${nanoid(6)}`;
    const wsName = name?.trim() || nextWorkspaceName(data.workspaces);

    const layout = await createDefaultLayout(wsId, directory, layoutOptions);
    await fs.mkdir(resolveLayoutDir(wsId), { recursive: true });
    await writeLayoutFile(layout, resolveLayoutFile(wsId));

    const workspace: IWorkspace = { id: wsId, name: wsName, directories: [directory] };
    data.workspaces.push(workspace);
    await writeWorkspacesFile(data);
    await writeWorkspacePrompts(workspace);

    log.debug(`Created: ${wsId} (${wsName}, ${directory})`);
    return workspace;
  });

export const deleteWorkspace = async (workspaceId: string): Promise<boolean> =>
  withOrchestrationMappingWrite(workspaceId, async () => {
    // Remote tabs first, outside the store lock (ADR-0022, review r1 B3): a host that does not
    // answer refuses the delete before any tab is reaped or any file changes.
    const before = await readLayoutFile(resolveLayoutFile(workspaceId));
    const remoteTabs = before ? collectAllTabs(before.root).filter((t) => t.host) : [];
    for (const tab of remoteTabs) emitTabClosing({ workspaceId, tabId: tab.id, sessionName: tab.sessionName, phase: 'closing' });
    const remoteClosed = new Set<string>();
    try {
      if (remoteTabs.length > 0) await closeRemoteTabsFirst(remoteTabs, (sessionName) => remoteClosed.add(sessionName));
    } catch (err) {
      // A tab reaped before the refusal stays closing: its work is gone, and an `aborted` would
      // let the watchdog report it dead (review r2 nit 5). The rest get their checks back.
      for (const tab of remoteTabs) {
        if (!remoteClosed.has(tab.sessionName)) emitTabClosing({ workspaceId, tabId: tab.id, sessionName: tab.sessionName, phase: 'aborted' });
      }
      throw err;
    }
    return withLock(async () => {
    const data = (await readWorkspacesFile()) ?? emptyState();
    const idx = data.workspaces.findIndex((w) => w.id === workspaceId);
    if (idx === -1) return false;

    const ws = data.workspaces[idx];

    const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
    if (layout) {
      const tabs = collectAllTabs(layout.root).filter((tab) => !remoteClosed.has(tab.sessionName));
      for (const tab of tabs) {
        // Deliberate: the watchdog must not read this reap as a death (L38).
        emitTabClosing({ workspaceId, tabId: tab.id, sessionName: tab.sessionName, phase: 'closing' });
        try {
          await killSession(tab.sessionName, { tabId: tab.id });
        } catch (err) {
          // A remote tab added since the first pass: its host's refusal stops the delete here too.
          if (err instanceof RemoteHostError) throw err;
        }
      }
    }

    try {
      await removeLayoutFile(workspaceId);
    } catch {}

    data.workspaces.splice(idx, 1);

    await writeWorkspacesFile(data);
    await removeWorkspaceClaudeHome(workspaceId).catch(() => {});
    await removeWorkspaceGrokHome(workspaceId).catch(() => {});
    revokeWorkspaceToken(workspaceId);
    await revokeWorkspaceTabTokens(workspaceId);
    if (layout) for (const tab of collectAllTabs(layout.root)) forgetSessionHost(tab.sessionName);
    log.info(`Deleted: ${workspaceId} (${ws.name})`);
    return true;
    });
  });

export const renameWorkspace = async (workspaceId: string, name: string): Promise<IWorkspace | null> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return null;

    const ws = data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;

    ws.name = name;
    await writeWorkspacesFile(data);
    await writeWorkspacePrompts(ws);

    log.debug(`Renamed: ${workspaceId} → "${name}"`);
    return { ...ws };
  });

export const updateActive = async (updates: {
  activeWorkspaceId?: string;
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
}): Promise<void> =>
  withLock(async () => {
    const data = (await readWorkspacesFile()) ?? emptyState();
    if (updates.activeWorkspaceId !== undefined) data.activeWorkspaceId = updates.activeWorkspaceId;
    if (updates.sidebarCollapsed !== undefined) data.sidebarCollapsed = updates.sidebarCollapsed;
    if (updates.sidebarWidth !== undefined) data.sidebarWidth = updates.sidebarWidth;
    await writeWorkspacesFile(data);
  });

export const updateWorkspaceDirectories = async (workspaceId: string, directories: string[]): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const ws = data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return false;
    if (directories[0]) {
      const owner = findPrimaryDirOwner(data, directories[0], workspaceId);
      if (owner) {
        log.info(`${directories[0]} is also workspace "${owner.name}"'s primary directory; sessions stay separate via per-workspace CLAUDE_CONFIG_DIR`);
      }
    }
    const current = JSON.stringify(ws.directories);
    if (current === JSON.stringify(directories)) return true;
    ws.directories = directories;
    await writeWorkspacesFile(data);
    await writeWorkspacePrompts(ws);
    return true;
  });

/**
 * Replace the set of workspaces allowed to reach into this one. Admin-only at the
 * API layer: a workspace-scoped agent must never be able to widen its own reach.
 */
export const updateWorkspaceAllowedPeers = async (
  workspaceId: string,
  peers: string[],
): Promise<IWorkspace | null> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return null;
    const ws = data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    const known = new Set(data.workspaces.map((w) => w.id));
    ws.allowedPeers = [...new Set(peers)].filter((id) => id !== workspaceId && known.has(id));
    await writeWorkspacesFile(data);
    log.info(`${workspaceId} allowedPeers = [${ws.allowedPeers.join(', ')}]`);
    return { ...ws };
  });

/** Internal CAS persistence: caller must hold the mapping write lease and lifecycle guards. */
export const commitWorkspaceOrchestrationLocked = async (
  workspaceId: string, patch: TOrchestrationPatch, expectedRevision: number,
): Promise<IWorkspace> => withLock(async () => {
  const data = await readWorkspacesStrict();
  const ws = data.workspaces.find((value) => value.id === workspaceId);
  if (!ws) throw new OrchestrationError(404, 'workspace-not-found', 'Workspace not found');
  const current = normalizeOrchestration(ws.orchestration);
  requireOrchestrationRevision(current, expectedRevision);
  const next = { ...current, ...patch };
  if (JSON.stringify(next) === JSON.stringify(current)) return { ...ws, orchestration: current };
  if (current.revision === Number.MAX_SAFE_INTEGER) throw new OrchestrationError(503, 'orchestration-unavailable', 'Orchestration revision exhausted');
  ws.orchestration = { ...next, revision: current.revision + 1 };
  await writeWorkspacesFile(data);
  return ws;
});

export const updateWorkspaceOrchestration = async (
  workspaceId: string, patch: TOrchestrationPatch,
  options: import('@/lib/orchestration-recovery').IOrchestrationChange,
): Promise<IWorkspace> => (await import('@/lib/orchestration-recovery')).changeOrchestration(workspaceId, patch, options);

export interface IReorderItem {
  id: string;
  groupId?: string | null;
}

export const reorderWorkspaces = async (items: IReorderItem[]): Promise<boolean> =>
  withLock(async () => {
    const data = (await readWorkspacesFile()) ?? emptyState();
    const byId = new Map(data.workspaces.map((w) => [w.id, w]));
    const validGroupIds = new Set((data.groups ?? []).map((g) => g.id));

    const reordered: IWorkspace[] = [];
    for (const item of items) {
      const ws = byId.get(item.id);
      if (!ws) return false;
      if (item.groupId !== undefined) {
        ws.groupId = item.groupId && validGroupIds.has(item.groupId) ? item.groupId : null;
      }
      reordered.push(ws);
    }

    if (reordered.length !== data.workspaces.length) return false;

    data.workspaces = reordered;
    await writeWorkspacesFile(data);
    return true;
  });

export const createGroup = async (name: string): Promise<IWorkspaceGroup> =>
  withLock(async () => {
    const data = (await readWorkspacesFile()) ?? emptyState();
    const groups = ensureGroups(data);
    const trimmed = name.trim() || `Group ${groups.length + 1}`;
    const group: IWorkspaceGroup = {
      id: `grp-${nanoid(6)}`,
      name: trimmed,
      collapsed: false,
    };
    groups.push(group);
    await writeWorkspacesFile(data);
    log.debug(`Group created: ${group.id} (${group.name})`);
    return group;
  });

export const renameGroup = async (groupId: string, name: string): Promise<IWorkspaceGroup | null> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return null;
    const group = (data.groups ?? []).find((g) => g.id === groupId);
    if (!group) return null;
    const trimmed = name.trim();
    if (!trimmed) return group;
    group.name = trimmed;
    await writeWorkspacesFile(data);
    return { ...group };
  });

export const setGroupCollapsed = async (groupId: string, collapsed: boolean): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const group = (data.groups ?? []).find((g) => g.id === groupId);
    if (!group) return false;
    if (group.collapsed === collapsed) return true;
    group.collapsed = collapsed;
    await writeWorkspacesFile(data);
    return true;
  });

export const ungroupGroup = async (groupId: string): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const groups = ensureGroups(data);
    const idx = groups.findIndex((g) => g.id === groupId);
    if (idx === -1) return false;
    for (const ws of data.workspaces) {
      if (ws.groupId === groupId) ws.groupId = null;
    }
    groups.splice(idx, 1);
    await writeWorkspacesFile(data);
    log.info(`Group ungrouped: ${groupId}`);
    return true;
  });

export const reorderGroups = async (groupIds: string[]): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const groups = ensureGroups(data);
    const byId = new Map(groups.map((g) => [g.id, g]));
    const reordered: IWorkspaceGroup[] = [];
    for (const id of groupIds) {
      const g = byId.get(id);
      if (!g) return false;
      reordered.push(g);
    }
    if (reordered.length !== groups.length) return false;
    data.groups = reordered;
    await writeWorkspacesFile(data);
    return true;
  });

export const setWorkspaceGroup = async (workspaceId: string, groupId: string | null): Promise<boolean> =>
  withLock(async () => {
    const data = await readWorkspacesFile();
    if (!data) return false;
    const ws = data.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return false;
    const validGroupIds = new Set((data.groups ?? []).map((g) => g.id));
    const nextGroupId = groupId && validGroupIds.has(groupId) ? groupId : null;
    if ((ws.groupId ?? null) === nextGroupId) return true;
    ws.groupId = nextGroupId;
    await writeWorkspacesFile(data);
    return true;
  });

export const validateDirectory = async (directory: string): Promise<IDirectoryValidation> =>
  buildDirectoryValidation({
    directory,
    home: os.homedir(),
    stat: await statDirectory(directory),
  });
