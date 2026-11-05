import path from 'path';
import { orAbsent, pulseFs } from '@/lib/pulse-fs';

// Which movement belongs to which workspace (ADR-0034 §9, story 12 round 2, F1): every event is
// attributed to exactly one workspace. An epic lease (`epic:<slug>`) owns its `_output/<slug>/`
// records and its repositories' integration and story branches; a workspace without one falls back
// to its directories, minus whatever another workspace's epic covers, and a directory it shares
// with another workspace is shown as shared and kept out of the stall decision.

export interface IPulseRepo {
  /** A directory inside the repository (a worktree serves: worktrees share their repository's refs). */
  dir: string;
  /** `git for-each-ref` patterns: an epic's exact integration ref, or the fallback's `main`, `master`, `feature`. */
  refs: string[];
  /** An epic's exact story refs (`refs/heads/<stories[].branch>`, else `refs/heads/story/<key>`); none in the fallback. */
  storyRefs?: string[];
}

/** Another workspace's leased epic and its repositories: commits its refs reach are not counted here unless only this epic's story branches hold them. */
export interface IPulseRival {
  name: string;
  repos: IPulseRepo[];
}

/** What one scope reads; each list holds directories that exist. */
export interface IPulseTargets {
  repos: IPulseRepo[];
  /** `_output/<epic>/evidence/gates` directories (library `gate.sh` logs). */
  libraryGateDirs: string[];
  /** `_output/<epic>/reviews` directories. */
  libraryReviewDirs: string[];
  /** Directories holding a `.v2/` (gate logs, receipts, landings). */
  v2Dirs: string[];
}

export interface IPulseScope {
  workspaceId: string;
  basis: 'epic' | 'directories';
  epics: string[];
  own: IPulseTargets;
  /** Read and shown, never counted: directories this workspace shares with the named ones. */
  shared: Array<{ with: string[]; targets: IPulseTargets }>;
  /** With an epic basis: the other workspaces' leased epics, so a commit two epics reach counts for one or neither. */
  rivals: IPulseRival[];
}

export interface IPulseEpicInfo {
  slug: string;
  /** `<dir>/_output/<slug>` when one exists among the workspace directories. */
  outputDir: string | null;
  repos: IPulseRepo[];
  v2Dirs: string[];
}

export interface IPulseWorkspaceRef {
  id: string;
  name: string;
  directories: string[];
}

export interface IPulseEpicLease {
  slug: string;
  workspaceId: string;
}

const clean = (raw: string): string => raw.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');

/**
 * The keys of an epic's `status.yaml` the pulse reads, line by line: top-level `epic` and
 * `integration_branch`, `repos[]` entries' `path` and `integration_branch`, `stories[]` entries'
 * `key`/`id`, `branch` and `repo`, and `pull_requests[].story` (where an epic records sub-stories
 * that `stories[]` does not list, such as v1-decommission's `24a-qa-hardening`).
 */
export const parseEpicStatus = (text: string): {
  epic: string | null;
  integrationBranch: string | null;
  repos: Array<{ path: string; integrationBranch: string | null }>;
  storyRepos: string[];
  /** Each story's `branch`, else `story/<key>`. */
  storyBranches: string[];
} => {
  let epic: string | null = null;
  let integrationBranch: string | null = null;
  const repos: Array<{ path: string | null; integrationBranch: string | null }> = [];
  const storyRepos = new Set<string>();
  const stories: Array<{ key: string | null; branch: string | null }> = [];
  let block: string | null = null;
  for (const line of text.split('\n')) {
    const top = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (top) {
      block = top[1];
      if (top[1] === 'epic') epic = clean(top[2]) || null;
      if (top[1] === 'integration_branch') integrationBranch = clean(top[2]) || null;
      continue;
    }
    if (block === 'repos') {
      if (/^\s*-\s/.test(line)) repos.push({ path: null, integrationBranch: null });
      const field = /^\s*(?:-\s+)?(path|integration_branch):\s*(.*)$/.exec(line);
      const entry = repos.at(-1);
      if (field && entry) {
        if (field[1] === 'path') entry.path = clean(field[2]) || null;
        else entry.integrationBranch = clean(field[2]) || null;
      }
    }
    if (block === 'pull_requests') {
      const story = /\bstory:\s*["']?([A-Za-z0-9._-]+)/.exec(line);
      if (story) stories.push({ key: story[1], branch: null });
    }
    if (block === 'stories') {
      const entry = /^\s*-\s+(key|id):\s*(.*)$/.exec(line);
      if (entry) stories.push({ key: clean(entry[2]) || null, branch: null });
      const repo = /^\s+repo:\s*(.*)$/.exec(line);
      if (repo && clean(repo[1])) storyRepos.add(clean(repo[1]));
      const branch = /^\s+branch:\s*(.*)$/.exec(line);
      if (branch && stories.length && clean(branch[1])) stories[stories.length - 1].branch = clean(branch[1]);
    }
  }
  const storyBranches = [...new Set(stories.flatMap((story) => (story.branch ? [story.branch] : story.key ? [`story/${story.key}`] : [])))];
  return {
    epic, integrationBranch, storyRepos: [...storyRepos], storyBranches,
    repos: repos.filter((repo): repo is { path: string; integrationBranch: string | null } => repo.path !== null),
  };
};

const exists = async (target: string): Promise<boolean> => pulseFs.stat(target).then(() => true, orAbsent(false));
const readText = async (file: string): Promise<string | null> => pulseFs.readFile(file).catch(orAbsent(null));

const headRef = (branch: string): string => `refs/heads/${branch}`;

/**
 * Where an epic's movement is: its `_output/<slug>` (under any workspace directory), the
 * repositories its `status.yaml` names with an integration branch (that branch and its stories'
 * exact branches, never a `story/*` wildcard, which would claim another epic's stories; an
 * entry without one, such as a repository it only sends briefs to, is not its own), the
 * repositories its stories name under the top-level integration branch, and every directory whose
 * `.v2/status.yaml` names the epic (its `main`, where v2 lanes land).
 */
export const readEpicInfo = async (slug: string, allDirectories: readonly string[]): Promise<IPulseEpicInfo> => {
  let outputDir: string | null = null;
  for (const dir of allDirectories) {
    const candidate = path.join(dir, '_output', slug);
    if (await exists(candidate)) {
      outputDir = candidate;
      break;
    }
  }
  const repos: IPulseRepo[] = [];
  const status = outputDir ? await readText(path.join(outputDir, 'status.yaml')) : null;
  if (status && outputDir) {
    const parsed = parseEpicStatus(status);
    // Each story file `stories/<key>.md` names a story too; its branch is `story/<key>`.
    const files = (await pulseFs.readdir(path.join(outputDir, 'stories')).catch(orAbsent([] as string[])))
      .filter((name) => name.endsWith('.md')).map((name) => `story/${name.slice(0, -3)}`);
    const storyRefs = [...new Set([...parsed.storyBranches, ...files])].map(headRef);
    for (const repo of parsed.repos) {
      if (repo.integrationBranch && path.isAbsolute(repo.path)) repos.push({ dir: repo.path, refs: [headRef(repo.integrationBranch)], storyRefs });
    }
    if (!parsed.repos.length && parsed.integrationBranch) {
      const base = path.dirname(path.dirname(outputDir));
      for (const repo of parsed.storyRepos) repos.push({ dir: path.resolve(base, repo), refs: [headRef(parsed.integrationBranch)], storyRefs });
    }
  }
  const v2Dirs: string[] = [];
  for (const dir of new Set(allDirectories)) {
    const text = await readText(path.join(dir, '.v2', 'status.yaml'));
    if (text && parseEpicStatus(text).epic === slug) {
      v2Dirs.push(dir);
      repos.push({ dir, refs: ['refs/heads/main'], storyRefs: [] });
    }
  }
  const real = await Promise.all(repos.map(async (repo) => ((await exists(repo.dir)) ? repo : null)));
  return { slug, outputDir, repos: real.filter((repo): repo is IPulseRepo => repo !== null), v2Dirs };
};

const inside = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}${path.sep}`);

/** The directories an epic covers: its repositories, its v2 directories and its `_output/<slug>`. */
const coveredBy = (epic: IPulseEpicInfo): string[] =>
  [...epic.repos.map((repo) => repo.dir), ...epic.v2Dirs, ...(epic.outputDir ? [epic.outputDir] : [])];

const EMPTY: IPulseTargets = { repos: [], libraryGateDirs: [], libraryReviewDirs: [], v2Dirs: [] };

const FALLBACK_REFS = ['refs/heads/main', 'refs/heads/master', 'refs/heads/feature'];

/**
 * A directory read in the fallback: its repository's main and integration branches and its `.v2/`.
 * Its `_output/*` is never scanned (architect CONCERN C1): only a leased epic's `_output/<slug>` is
 * read, and the ~450 unowned epics there were about 900 calls a minute on the sshfs mount for a
 * number that was never counted.
 */
const directoryTargets = (dir: string, hasV2: boolean): IPulseTargets => ({
  ...EMPTY,
  repos: [{ dir, refs: FALLBACK_REFS }],
  v2Dirs: hasV2 ? [dir] : [],
});

/**
 * One workspace's scope. With epic leases: exactly what its epics own. Without: its directories,
 * each left out when another workspace's epic covers it, and shown as shared (not counted) when
 * another workspace lists it too.
 */
export const resolvePulseScope = (
  workspaceId: string,
  workspaces: readonly IPulseWorkspaceRef[],
  leases: readonly IPulseEpicLease[],
  epics: ReadonlyMap<string, IPulseEpicInfo>,
  v2Present: ReadonlySet<string>,
): IPulseScope => {
  const mine = leases.filter((lease) => lease.workspaceId === workspaceId).map((lease) => lease.slug).sort();
  if (mine.length) {
    const own: IPulseTargets = { ...EMPTY, repos: [], libraryGateDirs: [], libraryReviewDirs: [], v2Dirs: [] };
    for (const slug of mine) {
      const epic = epics.get(slug);
      if (!epic) continue;
      own.repos.push(...epic.repos);
      if (epic.outputDir) {
        own.libraryGateDirs.push(path.join(epic.outputDir, 'evidence', 'gates'));
        own.libraryReviewDirs.push(path.join(epic.outputDir, 'reviews'));
      }
      own.v2Dirs.push(...epic.v2Dirs);
    }
    const rivals = leases.filter((lease) => lease.workspaceId !== workspaceId).flatMap((lease) => {
      const epic = epics.get(lease.slug);
      const holder = workspaces.find((candidate) => candidate.id === lease.workspaceId);
      return epic ? [{ name: holder?.name ?? lease.workspaceId, repos: epic.repos }] : [];
    });
    return { workspaceId, basis: 'epic', epics: mine, own, shared: [], rivals };
  }
  const others = leases.filter((lease) => lease.workspaceId !== workspaceId)
    .map((lease) => epics.get(lease.slug)).filter((epic): epic is IPulseEpicInfo => epic !== undefined);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  const own: IPulseTargets = { ...EMPTY, repos: [], v2Dirs: [] };
  const shared = new Map<string, IPulseScope['shared'][number]>();
  for (const dir of new Set(workspace?.directories ?? [])) {
    if (others.some((epic) => coveredBy(epic).some((root) => inside(dir, root)))) continue;
    const targets = directoryTargets(dir, v2Present.has(dir));
    const sharers = workspaces.filter((candidate) => candidate.id !== workspaceId && candidate.directories.includes(dir)).map((candidate) => candidate.name).sort();
    if (!sharers.length) {
      own.repos.push(...targets.repos);
      own.v2Dirs.push(...targets.v2Dirs);
      continue;
    }
    const key = sharers.join('\u0000');
    const entry = shared.get(key) ?? { with: sharers, targets: { ...EMPTY, repos: [], v2Dirs: [] } };
    entry.targets.repos.push(...targets.repos);
    entry.targets.v2Dirs.push(...targets.v2Dirs);
    shared.set(key, entry);
  }
  return { workspaceId, basis: 'directories', epics: [], own, shared: [...shared.values()], rivals: [] };
};
