/**
 * Which host runs a tmux session (ADR-0022). The layout is the record
 * (`ITab.host`, absent = local); this is its cache, shared by the custom server
 * and the Next routes. A tab never changes host, so an answer read from a
 * layout is kept for the life of the process. A session the layout does not
 * name yet is answered local and not kept: every remote session is registered
 * before its tmux session exists, so only a local tab can be in that state.
 */

const WORKSPACE_SESSION = /^pt-(ws-.*?)-(pane-.*?)-(tab-.+)$/;

const g = globalThis as unknown as { __ptSessionHosts?: Map<string, string | null> };
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
  } catch {
    return null;
  }
};
