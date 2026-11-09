import fs from 'fs/promises';

// D32: a standing-order change rewrites the prompt file of every workspace it reaches, and the copy each remote host
// keeps in its kit (ADR-0022). Before this, the kit copy changed only at a remote create, so a remote launch after a
// strike loaded the struck order.

export interface IPromptRefreshDeps {
  /** Render and write the local `claude-prompt.md` of the workspace. */
  writeLocal: (workspaceId: string) => Promise<void>;
  readLocal: (workspaceId: string) => Promise<string>;
  /** The remote hosts that run a tab of the workspace. */
  remoteHosts: (workspaceId: string) => Promise<string[]>;
  push: (host: string, workspaceId: string, prompt: string) => Promise<void>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Write the local file, then the same text to every remote host of the workspace. Resolves only when every copy is
 * written; otherwise rejects with one message that names each host that failed (the other copies stay written).
 */
export const refreshWorkspacePrompt = async (workspaceId: string, deps: IPromptRefreshDeps): Promise<void> => {
  await deps.writeLocal(workspaceId);
  const hosts = [...new Set(await deps.remoteHosts(workspaceId))].sort();
  if (!hosts.length) return;
  const prompt = await deps.readLocal(workspaceId);
  const failed = (await Promise.all(hosts.map((host) => deps.push(host, workspaceId, prompt).then(
    () => null,
    (err) => `${host}: ${message(err)}`,
  )))).filter((line): line is string => line !== null);
  if (failed.length) {
    throw new Error(`the local prompt file of ${workspaceId} is written; the remote copy is not, on ${failed.length} of ${hosts.length} hosts: ${failed.join('; ')}`);
  }
};

/** The server's deps: the layout names each tab's host, and the kit copy goes over ssh. */
export const defaultPromptRefreshDeps = (): IPromptRefreshDeps => {
  // One import for every host of the refresh: the pushes run at once, and each awaits the same module.
  let tmux: Promise<typeof import('@/lib/tmux')> | null = null;
  return {
    writeLocal: async (workspaceId) => {
      const { writeClaudePromptFile } = await import('@/lib/claude-prompt');
      await writeClaudePromptFile({ id: workspaceId });
    },
    readLocal: async (workspaceId) => {
      const { getClaudePromptPath } = await import('@/lib/claude-prompt');
      return fs.readFile(getClaudePromptPath(workspaceId), 'utf-8');
    },
    remoteHosts: async (workspaceId) => {
      const { readLayoutFile, resolveLayoutFile, collectAllTabs } = await import('@/lib/layout-store');
      const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
      if (!layout) return [];
      return collectAllTabs(layout.root).map((tab) => tab.host).filter((host): host is string => !!host);
    },
    push: async (host, workspaceId, prompt) => {
      tmux ??= import('@/lib/tmux');
      await (await tmux).pushRemotePrompt(host, workspaceId, prompt);
    },
  };
};
