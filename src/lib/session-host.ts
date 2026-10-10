/**
 * Which host runs a tmux session (ADR-0022). The layout is the record
 * (`ITab.host`, absent = local); this is its cache, shared by the custom server
 * and the Next routes. A tab never changes host, so an answer read from a
 * layout is kept for the life of the process. A session the layout does not
 * name yet is answered local and not kept: every remote session is registered
 * before its tmux session exists, so only a local tab can be in that state.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('terminal');

const WORKSPACE_SESSION = /^pt-(ws-.*?)-(pane-.*?)-(tab-.+)$/;

const g = globalThis as unknown as { __ptSessionHosts?: Map<string, string | null>; __ptSessionHostsPrimed?: Promise<void> };
if (!g.__ptSessionHosts) g.__ptSessionHosts = new Map();
const hosts = g.__ptSessionHosts;

export const registerSessionHost = (sessionName: string, host: string | null): void => {
  hosts.set(sessionName, host);
};

export const forgetSessionHost = (sessionName: string): void => {
  hosts.delete(sessionName);
};

/** The remote hosts of the sessions this process has seen. */
export const knownRemoteHosts = (): string[] =>
  [...new Set([...hosts.values()].filter((h): h is string => !!h))];

const primeFromLayouts = async (): Promise<void> => {
  const [{ getWorkspaces }, { readLayoutFile, resolveLayoutFile, collectAllTabs }] = await Promise.all([
    import('@/lib/workspace-store'),
    import('@/lib/layout-store'),
  ]);
  for (const ws of (await getWorkspaces()).workspaces) {
    const layout = await readLayoutFile(resolveLayoutFile(ws.id));
    if (!layout) continue;
    for (const tab of collectAllTabs(layout.root)) if (tab.host && !hosts.has(tab.sessionName)) hosts.set(tab.sessionName, tab.host);
  }
};

/**
 * The hosts that own at least one tab: every layout read once per process,
 * then kept by registration at create and removal at close. A registered host
 * with no tab is never asked anything.
 */
export const remoteHostsInUse = async (): Promise<string[]> => {
  if (!g.__ptSessionHostsPrimed) {
    g.__ptSessionHostsPrimed = primeFromLayouts().catch((err) => {
      g.__ptSessionHostsPrimed = undefined;
      log.warn(`remote hosts not primed, layouts unreadable: ${err instanceof Error ? err.message : err}`);
    });
  }
  await g.__ptSessionHostsPrimed;
  return knownRemoteHosts();
};

export const sessionHostOf = async (sessionName: string): Promise<string | null> => {
  const cached = hosts.get(sessionName);
  if (cached !== undefined) return cached;
  if (!WORKSPACE_SESSION.test(sessionName)) {
    hosts.set(sessionName, null);
    return null;
  }
  try {
    const { findTabBySessionName } = await import('@/lib/layout-store');
    const tab = await findTabBySessionName(sessionName);
    if (!tab) return null;
    const host = tab.host ?? null;
    hosts.set(sessionName, host);
    return host;
  } catch (err) {
    // Answered local, not kept: for a remote tab that means tmux finds no such local session.
    log.warn(`layout unreadable for ${sessionName}; treated as local this once: ${err instanceof Error ? err.message : err}`);
    return null;
  }
};
