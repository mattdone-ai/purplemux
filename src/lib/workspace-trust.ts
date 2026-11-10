import fs from 'fs/promises';
import path from 'path';

/**
 * Pre-trust for a tab's cwd (D14, ruling R-05): the owner's act of naming a workspace directory is the
 * trust, so a cwd that is a workspace directory or under one starts without Claude Code's folder-trust and
 * external-imports dialogs. A cwd outside every workspace directory gets nothing and shows the dialog,
 * which the status reader reports as `startup-prompt`.
 *
 * Claude Code 2.1.318 reads trust by walking up from the cwd, bounded by the git root, and reads the
 * imports approval at the MAIN repository root: for a worktree, the checkout its `.git` file points back
 * to (measured 2026-11-05: accepting the dialog in `repo/.worktrees/wt` wrote the approval at `repo`). A
 * worktree is its own git root, so the workspace directory above it never reaches it. The seed writes
 * the cwd, its git root and the main repository root, each only while its REAL path is inside a
 * workspace directory's real path.
 */

/** The keys Claude Code writes when a person accepts both dialogs (measured on 2.1.318). */
export const TRUST_KEYS = [
  'hasTrustDialogAccepted',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
] as const;

export type TProjectEntry = Record<string, unknown>;

/** `child` is `root` or a path below it; plain string paths, already resolved. */
export const isWithinDirectory = (child: string, root: string): boolean => {
  if (child === root) return true;
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return child.startsWith(prefix);
};

/** The deepest of `directories` that holds `target`, or null. Plain string paths, already resolved. */
export const nearestWorkspaceDirectory = (target: string, directories: readonly string[]): string | null => {
  let best: string | null = null;
  for (const dir of directories) {
    if (isWithinDirectory(target, dir) && (best === null || dir.length > best.length)) best = dir;
  }
  return best;
};

/**
 * The one owner refusal Claude Code records on disk (consult ruling, story 05): an imports decline, the pair
 * `hasClaudeMdExternalIncludesApproved: false` with `hasClaudeMdExternalIncludesWarningShown: true`.
 * Claude records no trust refusal ("No, exit" ends the process), and its default project object fills
 * `false` for all three keys, so a `false` is a refusal only in that pair. Measured on 2.1.318: 15 of 15
 * `hasTrustDialogAccepted: false` entries on host-b were the default triple.
 */
export const isImportsDecline = (entry: TProjectEntry): boolean =>
  entry.hasClaudeMdExternalIncludesApproved === false && entry.hasClaudeMdExternalIncludesWarningShown === true;

/**
 * The entry with the trust keys set, an imports decline kept, and the inherited keys of the nearest
 * workspace directory filled where the entry has none. Null when nothing changes.
 */
export const trustedProjectEntry = (
  entry: TProjectEntry | undefined,
  inherited: TProjectEntry | undefined,
  inheritedKeys: readonly string[],
): TProjectEntry | null => {
  const next: TProjectEntry = { ...(entry ?? {}) };
  let changed = entry === undefined;
  for (const key of inheritedKeys) {
    if (next[key] === undefined && inherited?.[key] !== undefined) {
      next[key] = inherited[key];
      changed = true;
    }
  }
  // Read before any key is set: the decline is the pair as the owner left it.
  const declined = isImportsDecline(next);
  for (const key of TRUST_KEYS) {
    if (next[key] === true || (declined && key === 'hasClaudeMdExternalIncludesApproved')) continue;
    next[key] = true;
    changed = true;
  }
  return changed ? next : null;
};

export interface ITrustTargets {
  /** The workspace directory the cwd sits in, as the workspace names it (the key into the owner's config). */
  workspaceDirectory: string;
  /** The project keys to write: the cwd, its real path, its git root and its main repository root (inside the workspace directory). */
  keys: string[];
}

const realOrResolved = async (p: string): Promise<string> => fs.realpath(p).catch(() => path.resolve(p));

const exists = async (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false);

/** The nearest directory at or above `dir` that holds `.git` (a directory, or a worktree's file), up to `limit`. */
const gitRootWithin = async (dir: string, limit: string): Promise<string | null> => {
  let current = dir;
  for (;;) {
    if (await exists(path.join(current, '.git'))) return current;
    if (current === limit) return null;
    const parent = path.dirname(current);
    if (parent === current || !isWithinDirectory(parent, limit)) return null;
    current = parent;
  }
};

/**
 * The main repository root of a git root: itself when `.git` is a directory; for a worktree (`.git` is a
 * file `gitdir: <dir>`), the parent of the common git directory that `<dir>/commondir` names. Null when it
 * cannot be read or the common directory is not a `.git` (a bare repository has no checkout to key).
 */
export const mainRepositoryRoot = async (gitRoot: string): Promise<string | null> => {
  const dotGit = path.join(gitRoot, '.git');
  const stat = await fs.lstat(dotGit).catch(() => null);
  if (!stat) return null;
  if (stat.isDirectory()) return gitRoot;
  const pointer = (await fs.readFile(dotGit, 'utf-8').catch(() => '')).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!pointer) return null;
  const gitDir = path.resolve(gitRoot, pointer);
  const common = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf-8').catch(() => '')).trim();
  if (!common) return null;
  const commonDir = await realOrResolved(path.resolve(gitDir, common));
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
};

/** The real path, or null when it cannot be read: a key the seed cannot place is never written. */
const realOf = async (p: string): Promise<string | null> => fs.realpath(p).catch(() => null);

/**
 * Where the seed writes for a local tab's cwd, or null when the cwd's REAL path is outside every workspace
 * directory's real path (review r1 BLOCK, ruling R-05). The lexical path never qualifies a cwd: a symlink
 * inside a workspace directory that points out of it, or a `<ws>/link/..` form, leaves the workspace when
 * the process resolves it, and Claude Code keys trust by the path its process sees. Each key (the cwd as
 * given, its real path, its git root, its main repository root) is written only when ITS real path is
 * inside a workspace directory's real path; a key whose real path cannot be read is skipped.
 */
export const resolveTrustTargets = async (cwd: string, directories: readonly string[]): Promise<ITrustTargets | null> => {
  const realCwd = await realOf(cwd);
  if (!realCwd) return null;
  const realDirs = (await Promise.all(directories.map(async (dir) => ({ dir, real: await realOf(dir) }))))
    .filter((candidate): candidate is { dir: string; real: string } => candidate.real !== null);
  let match: { dir: string; real: string } | null = null;
  for (const candidate of realDirs) {
    if (isWithinDirectory(realCwd, candidate.real) && (match === null || candidate.real.length > match.real.length)) match = candidate;
  }
  if (!match) return null;
  const candidates = [path.resolve(cwd), realCwd];
  const root = await gitRootWithin(realCwd, match.real);
  if (root) {
    candidates.push(root);
    const main = await mainRepositoryRoot(root);
    if (main) candidates.push(main);
  }
  const keys: string[] = [];
  for (const key of candidates) {
    if (keys.includes(key)) continue;
    const real = await realOf(key);
    if (real && realDirs.some((candidate) => isWithinDirectory(real, candidate.real))) keys.push(key);
  }
  return { workspaceDirectory: match.dir, keys };
};
