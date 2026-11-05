import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';
import { resolveTrustTargets, trustedProjectEntry } from '@/lib/workspace-trust';

const log = createLogger('workspace-home');

const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const CLAUDE_STATE_FILE = path.join(os.homedir(), '.claude.json');
// Read directly rather than through workspace-store: that module imports tmux,
// and tmux calls in here on every session create, which would close a cycle.
const WORKSPACES_FILE = path.join(os.homedir(), '.purplemux', 'workspaces.json');

const WORKSPACES_DIR = path.join(os.homedir(), '.purplemux', 'workspaces');

// Claude Code keys its session store by cwd (`<config>/projects/<encoded-cwd>/`),
// so two workspaces launched from the same directory share conversation history
// and resume lists. Giving each workspace its own CLAUDE_CONFIG_DIR decouples
// session identity from location, which is what lets several workspaces run from
// one project root.
export const workspaceHomeDir = (wsId: string): string =>
  path.join(WORKSPACES_DIR, wsId, 'claude-home');

// Session names are `pt-<wsId>-<paneId>-<tabId>`, so the owning workspace is
// recoverable anywhere a tmux session name is at hand, without threading it
// through every caller. Names that are not workspace-shaped (the ad-hoc
// `defaultSessionName`) yield null and run unscoped against ~/.claude.
export const workspaceIdFromSessionName = (name: string): string | null =>
  name.match(/^pt-(ws-.+?)-pane-/)?.[1] ?? null;

export const claudeHomeForSession = (sessionName: string): string | null => {
  const wsId = workspaceIdFromSessionName(sessionName);
  return wsId ? workspaceHomeDir(wsId) : null;
};

/**
 * Every workspace claude-home that exists on disk. A pane launched with a
 * workspace CLAUDE_CONFIG_DIR registers its session pid file and transcripts
 * inside its claude-home, not under ~/.claude — session detection must scan
 * both. Pid matching keeps cross-workspace confusion impossible, so listing
 * every home is safe.
 */
export const listWorkspaceClaudeHomes = async (): Promise<string[]> => {
  let entries;
  try {
    entries = await fs.readdir(WORKSPACES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const homes = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const home = path.join(WORKSPACES_DIR, e.name, 'claude-home');
        return (await fs.access(home).then(() => true).catch(() => false)) ? home : null;
      }),
  );
  return homes.filter((h): h is string => h !== null);
};

const CREDENTIALS_FILE = '.credentials.json';
const GLOBAL_CREDENTIALS = path.join(CLAUDE_HOME, CREDENTIALS_FILE);
const CREDENTIAL_SYNC_INTERVAL_MS = 30_000;

/**
 * Claude refreshes OAuth tokens by writing .credentials.json atomically
 * (tmp + rename), and the rename replaces the shared symlink with a private
 * regular file — a fork. From that moment the workspace's refreshes stop
 * reaching ~/.claude, and with refresh-token rotation every other session is
 * eventually left holding an invalidated lineage ("OAuth session expired and
 * could not be refreshed"). Promote a fork's tokens back to the shared store
 * when they are newer, then restore the symlink so every home reads — and the
 * next refresh anywhere advances — a single lineage again.
 */
export const promoteCredentialFork = async (home: string): Promise<void> => {
  const link = path.join(home, CREDENTIALS_FILE);
  let st;
  try {
    st = await fs.lstat(link);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;

  let raw: string | null = null;
  try {
    raw = await fs.readFile(link, 'utf-8');
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { refreshToken?: unknown } };
    if (!parsed.claudeAiOauth?.refreshToken) raw = null;
  } catch {
    raw = null;
  }

  const globalSt = await fs.stat(GLOBAL_CREDENTIALS).catch(() => null);
  if (raw !== null && (!globalSt || st.mtimeMs > globalSt.mtimeMs)) {
    const tmp = GLOBAL_CREDENTIALS + '.tmp';
    await fs.writeFile(tmp, raw, { mode: 0o600 });
    await fs.rename(tmp, GLOBAL_CREDENTIALS);
    log.info(`promoted refreshed credentials from ${path.basename(path.dirname(home))}`);
  } else if (!globalSt) {
    // Nothing shareable to link against; leave the fork alone.
    return;
  }

  await fs.rm(link, { force: true });
  await fs.symlink(GLOBAL_CREDENTIALS, link);
};

const syncCredentialForks = async (): Promise<void> => {
  for (const home of await listWorkspaceClaudeHomes()) {
    await promoteCredentialFork(home).catch((err) => {
      log.warn(`credential fork sync failed for ${home}: ${err instanceof Error ? err.message : err}`);
    });
  }
};

const g = globalThis as unknown as { __ptCredentialSyncTimer?: ReturnType<typeof setInterval> };

// A fork can sit unnoticed between tab launches while every other session's
// lineage goes stale, so launch-time promotion alone is not enough — sweep
// continuously. 30s bounds the fork's lifetime well inside OAuth expiry.
export const startCredentialForkSync = (): void => {
  if (g.__ptCredentialSyncTimer) return;
  g.__ptCredentialSyncTimer = setInterval(() => void syncCredentialForks(), CREDENTIAL_SYNC_INTERVAL_MS);
  void syncCredentialForks();
};

// Symlinked back to the real ~/.claude: credentials, settings, and the command
// surface must stay common to every workspace. Recreated on each launch so a
// process that replaced a link with a regular file cannot silently fork them —
// for .credentials.json only after promoteCredentialFork has rescued whatever
// the fork holds.
const SHARED_ENTRIES = [
  '.credentials.json',
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'agents',
  'commands',
  'hooks',
  'rules',
  'plugins',
  'statsig',
];

// Real directories, private to the workspace — the isolation itself.
const PRIVATE_DIRS = ['projects', 'sessions'];

// Login and onboarding state live at the TOP level of ~/.claude.json, not in
// .credentials.json — without these a fresh CLAUDE_CONFIG_DIR greets every new
// workspace with the login/onboarding flow despite valid shared credentials.
const INHERITED_ROOT_KEYS = ['oauthAccount', 'hasCompletedOnboarding', 'lastOnboardingVersion'];

// Decisions worth inheriting from the user's real config. Telemetry (lastCost,
// history, lastAPIDuration) is deliberately left behind.
const INHERITED_PROJECT_KEYS = [
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
  'allowedTools',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
];

const readJson = async (file: string): Promise<Record<string, unknown>> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return {};
  }
};

/**
 * A temporary of its own per write (pid + random, review r1 nit 2): two writers that shared `<file>.tmp`
 * could rename a half-written file into place, and the loser's rename failed with ENOENT.
 */
const writeJsonAtomic = async (file: string, data: unknown): Promise<void> => {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
};

// One seed at a time per config file, across every module copy in the process (the custom server and the
// Next bundle each load this module): several tabs launched together each add their own key, and an
// unserialized read-modify-write kept only the last writer's (review r1 nit 2). A live Claude Code in
// another tab can still rewrite the file; that race is accepted and falls through to `startup-prompt`.
const SEED_CHAINS_KEY = '__ptClaudeHomeSeedChains';
const seedChains = (): Map<string, Promise<void>> => {
  const g = globalThis as Record<string, unknown>;
  if (!(g[SEED_CHAINS_KEY] instanceof Map)) g[SEED_CHAINS_KEY] = new Map<string, Promise<void>>();
  return g[SEED_CHAINS_KEY] as Map<string, Promise<void>>;
};

const serializedPerFile = (file: string, work: () => Promise<void>): Promise<void> => {
  const chains = seedChains();
  const run = (chains.get(file) ?? Promise.resolve()).then(work, work);
  const settled = run.then(() => {}, () => {});
  chains.set(file, settled);
  void settled.then(() => {
    if (chains.get(file) === settled) chains.delete(file);
  });
  return run;
};

/**
 * Carry the user's own trust and MCP-approval decisions into the workspace's
 * config dir. Without this a fresh CLAUDE_CONFIG_DIR starts untrusted and Claude
 * silently drops every `permissions.allow` entry from project settings.
 *
 * Entries are merged, never overwritten: a directory the workspace already knows
 * about keeps whatever it has learned, and a re-rooted workspace picks up the
 * decision for its new directory on the next launch.
 *
 * The tab's cwd, when it is a workspace directory or under one, is pre-trusted
 * (D14, ruling R-05): see workspace-trust.ts. An owner decision stays.
 */
export const seedProjectDecisions = async (home: string, directories: string[], cwd?: string): Promise<void> => {
  const target = path.join(home, '.claude.json');
  await serializedPerFile(target, () => seedOnce(target, directories, cwd));
};

const seedOnce = async (target: string, directories: string[], cwd?: string): Promise<void> => {
  const current = await readJson(target);
  const source = await readJson(CLAUDE_STATE_FILE);
  const sourceProjects = (source.projects ?? {}) as Record<string, Record<string, unknown>>;
  const projects = (current.projects ?? {}) as Record<string, Record<string, unknown>>;

  let changed = false;
  const root: Record<string, unknown> = {};
  for (const key of INHERITED_ROOT_KEYS) {
    if (current[key] === undefined && source[key] !== undefined) {
      root[key] = source[key];
      changed = true;
    }
  }
  for (const dir of directories) {
    if (projects[dir]) continue;
    const inherited = sourceProjects[dir] ?? sourceProjects[path.resolve(dir)];
    if (!inherited) continue;
    const carried: Record<string, unknown> = {};
    for (const key of INHERITED_PROJECT_KEYS) {
      if (inherited[key] !== undefined) carried[key] = inherited[key];
    }
    if (Object.keys(carried).length === 0) continue;
    projects[dir] = carried;
    changed = true;
  }
  const trust = cwd ? await resolveTrustTargets(cwd, directories) : null;
  if (trust) {
    const inherited = sourceProjects[trust.workspaceDirectory] ?? sourceProjects[path.resolve(trust.workspaceDirectory)];
    for (const key of trust.keys) {
      const next = trustedProjectEntry(projects[key], inherited, INHERITED_PROJECT_KEYS);
      if (!next) continue;
      projects[key] = next;
      changed = true;
    }
  }

  if (!changed && Object.keys(current).length > 0) return;
  await writeJsonAtomic(target, { ...current, ...root, projects });
};

export interface IWorkspaceSummary {
  id: string;
  name: string;
  directories: string[];
}

/**
 * Id, display name and directories of every configured workspace. Read straight
 * from the settings file for the same reason as the rest of this module:
 * workspace-store pulls in tmux, and tmux calls back in here.
 */
export const listWorkspaceSummaries = async (): Promise<IWorkspaceSummary[]> => {
  const data = await readJson(WORKSPACES_FILE);
  const workspaces = (data.workspaces ?? []) as Array<{
    id?: unknown;
    name?: unknown;
    directories?: unknown;
  }>;

  const summaries: IWorkspaceSummary[] = [];
  for (const workspace of workspaces) {
    if (typeof workspace.id !== 'string') continue;
    summaries.push({
      id: workspace.id,
      name: typeof workspace.name === 'string' ? workspace.name : workspace.id,
      directories: Array.isArray(workspace.directories)
        ? workspace.directories.filter((dir): dir is string => typeof dir === 'string')
        : [],
    });
  }
  return summaries;
};

export const workspaceDirectories = async (wsId: string): Promise<string[]> =>
  (await listWorkspaceSummaries()).find((workspace) => workspace.id === wsId)?.directories ?? [];

/**
 * Build (or repair) the workspace's private Claude config dir and return its path
 * for CLAUDE_CONFIG_DIR. Idempotent — safe to call on every tab launch. `cwd`
 * is the tab's launch directory, pre-trusted when it is inside the workspace.
 */
export const ensureWorkspaceClaudeHome = async (wsId: string, cwd?: string): Promise<string> => {
  const directories = await workspaceDirectories(wsId);
  const home = workspaceHomeDir(wsId);
  await fs.mkdir(home, { recursive: true });
  await Promise.all(PRIVATE_DIRS.map((d) => fs.mkdir(path.join(home, d), { recursive: true })));

  // Must run before the SHARED_ENTRIES loop below, which would otherwise
  // clobber a forked-but-fresher credentials file with a link to stale tokens.
  await promoteCredentialFork(home).catch((err) => {
    log.warn(`credential fork rescue failed for ${wsId}: ${err instanceof Error ? err.message : err}`);
  });

  await Promise.all(
    SHARED_ENTRIES.map(async (entry) => {
      const source = path.join(CLAUDE_HOME, entry);
      if (!(await fs.access(source).then(() => true).catch(() => false))) return;
      const link = path.join(home, entry);
      try {
        await fs.rm(link, { recursive: true, force: true });
        await fs.symlink(source, link);
      } catch (err) {
        log.warn(`could not link ${entry} into ${wsId}'s claude home: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );

  await seedProjectDecisions(home, directories, cwd);
  return home;
};

// Transcript roots for anything that aggregates across every claude session on
// this machine (usage stats). Each transcript lives in exactly one home, so
// walking all roots cannot double-count.
export const listClaudeProjectsDirs = async (): Promise<string[]> => [
  path.join(CLAUDE_HOME, 'projects'),
  ...(await listWorkspaceClaudeHomes()).map((home) => path.join(home, 'projects')),
];

export const removeWorkspaceClaudeHome = async (wsId: string): Promise<void> => {
  await fs.rm(workspaceHomeDir(wsId), { recursive: true, force: true });
};
