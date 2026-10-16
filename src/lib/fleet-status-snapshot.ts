import fs from 'fs/promises';
import {
  DEFAULT_FLEET_THRESHOLDS, deriveFleetRow, inboxOf, isAtPrompt, parseThresholdMinutes, sortFleetRows, unansweredFlag,
} from '@/lib/fleet-status';
import { readComposer } from '@/lib/composer-readiness';
import type { IMissionOpenItemOpener } from '@/lib/mission-control-store';
import type {
  IFleetTabFacts, IFleetThresholds, IFleetUnattributed, IFleetView, TComposerReading,
} from '@/types/fleet-status';
import type { ILease } from '@/types/lease';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// The server half of the fleet status read model (ADR-0023): gathers the facts
// the StatusManager, the watch, liveness and lease stores and the Mission
// Control store already hold, then derives one row per agent tab. It never
// writes to a tab: the only pane access is a capture of a tab at its prompt.

export interface IFleetWorkspace {
  id: string;
  name: string;
}

export interface IFleetDeps {
  workspaces: () => Promise<IFleetWorkspace[]>;
  /** The agent tabs of a workspace's layout; null when the layout cannot be read. */
  agentTabs: (workspaceId: string) => Promise<ITab[] | null>;
  statuses: () => Record<string, IClientTabStatusEntry>;
  serverFacts: (tabId: string) => { jsonlPath: string | null; stallReportedAt: number | null; inactiveSince: number | null } | null;
  watches: () => Promise<Array<{ workspaceId: string; tabId: string; kind: string; target: string }>>;
  liveJobs: (tabId: string) => Promise<Array<{ pid: number; label?: string }>>;
  leases: () => Promise<ILease[]>;
  openers: () => IMissionOpenItemOpener[];
  capture: (sessionName: string) => Promise<string | null>;
  mtime: (file: string) => Promise<number | null>;
  config: (key: string) => Promise<string | null>;
  providerId: (tab: ITab) => string | null;
}

export const FLEET_CONFIG_KEYS: Record<keyof IFleetThresholds, string> = {
  stallMinutes: 'fleet-status.stall-minutes',
  waitingLongMinutes: 'fleet-status.waiting-long-minutes',
  unansweredMinutes: 'fleet-status.unanswered-minutes',
  composerMinutes: 'fleet-status.composer-minutes',
};

const g = globalThis as unknown as {
  __ptFleetComposerSeen?: Map<string, number>;
  __ptFleetViewCache?: { at: number; view: Promise<IFleetView> };
};
if (!g.__ptFleetComposerSeen) g.__ptFleetComposerSeen = new Map();
const composerSeen = g.__ptFleetComposerSeen;

/** Two viewers polling at once share one read: no second capture of every pane. */
const CACHE_MS = 5_000;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const settle = async <T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> => {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
};

export const readThresholds = async (config: IFleetDeps['config']): Promise<IFleetThresholds> => {
  const entries = await Promise.all((Object.keys(FLEET_CONFIG_KEYS) as Array<keyof IFleetThresholds>).map(async (key) => {
    const raw = await config(FLEET_CONFIG_KEYS[key]).catch(() => null);
    return [key, parseThresholdMinutes(raw, DEFAULT_FLEET_THRESHOLDS[key])] as const;
  }));
  return Object.fromEntries(entries) as unknown as IFleetThresholds;
};

/** The epic a tab holds: its `epic:<slug>` lease, else the epic named on any lease it holds. */
const epicByTab = (leases: ILease[]): Map<string, string> => {
  const epics = new Map<string, string>();
  for (const lease of leases) {
    const key = lease.holder.workspaceId && lease.holder.tabId ? `${lease.holder.workspaceId}/${lease.holder.tabId}` : null;
    if (!key) continue;
    if (lease.kind === 'epic' && lease.resource) epics.set(key, lease.resource);
    else if (lease.epic && !epics.has(key)) epics.set(key, lease.epic);
  }
  return epics;
};

/**
 * When the text now in the composer arrived: the last automated submission if
 * it came after the tab's last hook event (it was typed and never taken), else
 * the first poll that saw the text. A poll that sees no text clears the memory.
 */
const composerSince = (tab: ITab, status: IClientTabStatusEntry, reading: TComposerReading, now: number): number | null => {
  if (reading !== 'text') {
    composerSeen.delete(tab.id);
    return null;
  }
  const submittedAt = tab.orchestrationActivity?.sessionName === tab.sessionName ? tab.orchestrationActivity.turn?.at ?? null : null;
  const lastEventAt = status.lastEvent?.at ?? 0;
  if (!composerSeen.has(tab.id)) composerSeen.set(tab.id, now);
  if (submittedAt !== null && submittedAt >= lastEventAt) return submittedAt;
  return composerSeen.get(tab.id) ?? now;
};

export const buildFleetView = async (deps: IFleetDeps, now = Date.now()): Promise<IFleetView> => {
  const errors: IFleetView['errors'] = [];
  const [workspaces, thresholds, watches, leases, openers] = await Promise.all([
    deps.workspaces(),
    readThresholds(deps.config),
    settle(deps.watches),
    settle(deps.leases),
    settle(async () => deps.openers()),
  ]);
  if (!watches.ok) errors.push({ scope: 'watches', error: watches.error });
  if (!leases.ok) errors.push({ scope: 'leases', error: leases.error });
  if (!openers.ok) errors.push({ scope: 'SM inbox', error: openers.error });
  const epics = leases.ok ? epicByTab(leases.value) : new Map<string, string>();
  const statuses = deps.statuses();
  const facts: IFleetTabFacts[] = [];
  const liveTabKeys = new Set<string>();
  let jobsFailed = false;
  let layoutFailed = false;

  await Promise.all(workspaces.map(async (workspace) => {
    const tabs = await deps.agentTabs(workspace.id).catch((err) => {
      errors.push({ scope: workspace.name, error: errorText(err) });
      return undefined;
    });
    if (tabs === null) errors.push({ scope: workspace.name, error: 'workspace layout could not be read' });
    if (!tabs) {
      layoutFailed = true;
      return;
    }
    await Promise.all(tabs.map(async (tab) => {
      const key = `${workspace.id}/${tab.id}`;
      liveTabKeys.add(key);
      const status = statuses[tab.id]?.workspaceId === workspace.id ? statuses[tab.id] : null;
      const server = deps.serverFacts(tab.id);
      const [jobs, transcriptAt, composer] = await Promise.all([
        deps.liveJobs(tab.id).catch(() => {
          jobsFailed = true;
          return null;
        }),
        server?.jsonlPath ? deps.mtime(server.jsonlPath).catch(() => null) : Promise.resolve(null),
        // Only a tab at its prompt has a composer worth reading, and a remote pane is not captured from here.
        status && isAtPrompt(status) && !tab.host
          ? deps.capture(tab.sessionName).catch(() => null).then((captured) => {
            const reading = readComposer(tab.panelType, captured);
            return { reading, since: composerSince(tab, status, reading, now) };
          })
          : Promise.resolve(null),
      ]);
      if (!composer) composerSeen.delete(tab.id);
      facts.push({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        tabId: tab.id,
        tabName: tab.name || tab.id,
        panelType: tab.panelType ?? null,
        providerId: deps.providerId(tab),
        epic: epics.get(key) ?? null,
        status,
        transcriptAt,
        stallReportedAt: server?.stallReportedAt ?? null,
        inactiveSince: server?.inactiveSince ?? null,
        watches: watches.ok
          ? watches.value.filter((w) => w.workspaceId === workspace.id && w.tabId === tab.id).map((w) => ({ kind: w.kind, target: w.target }))
          : null,
        liveJobs: jobs,
        composer,
        inbox: openers.ok
          ? openers.value
            .filter((item) => item.workspaceId === workspace.id && item.opener?.tabId === tab.id)
            .map((item) => ({ createdAt: item.createdAt, reviewed: item.reviewed }))
          : null,
      });
    }));
  }));
  // A closed tab's composer memory goes with it; an unread layout proves no tab closed.
  if (!layoutFailed) {
    const seenTabIds = new Set(facts.map((f) => f.tabId));
    for (const tabId of composerSeen.keys()) if (!seenTabIds.has(tabId)) composerSeen.delete(tabId);
  }
  if (jobsFailed) errors.push({ scope: 'jobs', error: 'registered jobs could not be read for some tabs' });

  // An item whose opener is unknown, or whose opener tab is gone, still shows: on its workspace's line.
  const unattributed: IFleetUnattributed[] = [];
  if (openers.ok) {
    for (const workspace of workspaces) {
      const items = openers.value.filter((item) => item.workspaceId === workspace.id
        && (!item.opener || !liveTabKeys.has(`${workspace.id}/${item.opener.tabId}`)));
      if (items.length === 0) continue;
      const inbox = inboxOf(items, now, thresholds);
      const flag = unansweredFlag(inbox, now);
      unattributed.push({ workspaceId: workspace.id, workspaceName: workspace.name, inbox, flags: flag ? [flag] : [] });
    }
  }

  return {
    at: now,
    thresholds,
    rows: sortFleetRows(facts.map((f) => deriveFleetRow(f, now, thresholds))),
    unattributed,
    errors,
  };
};

const realDeps = async (): Promise<IFleetDeps> => {
  const [
    { getWorkspaces }, { collectAllTabs, readLayoutFile, resolveLayoutFile }, { isAgentPanelType },
    { getStatusManager }, { readWatches }, { getLivenessManager }, { listLeases },
    { getMissionControlStore }, { capturePaneContent }, { readFleetConfig, valueOf }, { getProviderByPanelType },
  ] = await Promise.all([
    import('@/lib/workspace-store'),
    import('@/lib/layout-store'),
    import('@/lib/agent-panel-types'),
    import('@/lib/status-manager'),
    import('@/lib/watch-store'),
    import('@/lib/liveness-manager'),
    import('@/lib/lease-store'),
    import('@/lib/mission-control-store'),
    import('@/lib/tmux'),
    import('@/lib/fleet-config-store'),
    import('@/lib/providers/registry'),
  ]);
  const fleetConfig = readFleetConfig();
  // Each threshold read handles its own failure; this keeps an early rejection from going unhandled.
  fleetConfig.catch(() => {});
  return {
    workspaces: async () => (await getWorkspaces()).workspaces.map((w) => ({ id: w.id, name: w.name })),
    agentTabs: async (workspaceId) => {
      const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
      return layout ? collectAllTabs(layout.root).filter((tab) => isAgentPanelType(tab.panelType)) : null;
    },
    statuses: () => getStatusManager().getAllForClient(),
    serverFacts: (tabId) => getStatusManager().fleetFacts(tabId),
    watches: async () => (await readWatches()).watches,
    liveJobs: async (tabId) => (await getLivenessManager().statusForTab(tabId)).backgroundJobs
      .filter((job) => job.alive)
      .map((job) => ({ pid: job.pid, ...(job.label ? { label: job.label } : {}) })),
    leases: () => listLeases(),
    openers: () => getMissionControlStore().openItemOpeners(),
    capture: (sessionName) => capturePaneContent(sessionName, { escapes: true }),
    mtime: async (file) => (await fs.stat(file)).mtimeMs,
    config: async (key) => valueOf(await fleetConfig, key)?.value ?? null,
    providerId: (tab) => getProviderByPanelType(tab.panelType)?.id ?? null,
  };
};

/** The fleet view, read at most once per 5 s however many viewers poll. */
export const readFleetView = async (now = Date.now(), deps: () => Promise<IFleetDeps> = realDeps): Promise<IFleetView> => {
  const cached = g.__ptFleetViewCache;
  if (cached && now - cached.at < CACHE_MS) return cached.view;
  const view = deps().then((resolved) => buildFleetView(resolved, now));
  g.__ptFleetViewCache = { at: now, view };
  view.catch(() => {
    if (g.__ptFleetViewCache?.view === view) g.__ptFleetViewCache = undefined;
  });
  return view;
};
