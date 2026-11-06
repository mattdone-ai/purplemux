import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isImportsDecline,
  isWithinDirectory,
  mainRepositoryRoot,
  nearestWorkspaceDirectory,
  resolveTrustTargets,
  trustedProjectEntry,
} from '@/lib/workspace-trust';

// D14 (story 05, ruling R-05 and the story 05 consult ruling): the pure rules of the pre-trust.

const INHERITED = ['hasTrustDialogAccepted', 'allowedTools', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown'];
const DEFAULT_TRIPLE = { hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false };
const DECLINE = { hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true };
const TRUSTED = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };

describe('isWithinDirectory / nearestWorkspaceDirectory', () => {
  it('holds the directory itself and paths below it, never a sibling that shares a prefix', () => {
    expect(isWithinDirectory('/w/repo', '/w/repo')).toBe(true);
    expect(isWithinDirectory('/w/repo/.worktrees/x', '/w/repo')).toBe(true);
    expect(isWithinDirectory('/w/repo-other', '/w/repo')).toBe(false);
    expect(isWithinDirectory('/w', '/w/repo')).toBe(false);
    expect(isWithinDirectory('/w/repo/x', '/w/repo/')).toBe(true);
  });

  it('picks the deepest workspace directory that holds the path', () => {
    expect(nearestWorkspaceDirectory('/w/repo/sub/x', ['/w', '/w/repo', '/w/repo/sub'])).toBe('/w/repo/sub');
    expect(nearestWorkspaceDirectory('/elsewhere', ['/w', '/w/repo'])).toBeNull();
    expect(nearestWorkspaceDirectory('/w/repo', [])).toBeNull();
  });
});

describe('trustedProjectEntry (consult ruling (b))', () => {
  it('(1) replaces a default-filled triple and keeps every other key', () => {
    const entry = { ...DEFAULT_TRIPLE, lastSessionId: 's-1', allowedTools: ['Bash'] };
    expect(trustedProjectEntry(entry, undefined, INHERITED)).toEqual({ ...TRUSTED, lastSessionId: 's-1', allowedTools: ['Bash'] });
  });

  it('(2) keeps an imports decline, and still sets the trust', () => {
    expect(trustedProjectEntry({ hasTrustDialogAccepted: false, ...DECLINE }, undefined, INHERITED))
      .toEqual({ hasTrustDialogAccepted: true, ...DECLINE });
  });

  it('(3) changes nothing over a decline that is already trusted', () => {
    expect(trustedProjectEntry({ hasTrustDialogAccepted: true, ...DECLINE }, undefined, INHERITED)).toBeNull();
    expect(trustedProjectEntry({ ...TRUSTED }, undefined, INHERITED)).toBeNull();
  });

  it('(4) writes every trust key for a cwd with no entry', () => {
    expect(trustedProjectEntry(undefined, undefined, INHERITED)).toEqual(TRUSTED);
  });

  it('(5) keeps a decline inherited from the owner config of the nearest workspace directory', () => {
    expect(trustedProjectEntry(undefined, { ...DECLINE, allowedTools: ['Read'] }, INHERITED))
      .toEqual({ hasTrustDialogAccepted: true, ...DECLINE, allowedTools: ['Read'] });
  });

  it('fills only the inherited keys the entry lacks: the entry wins', () => {
    expect(trustedProjectEntry({ allowedTools: ['Edit'] }, { allowedTools: ['Read'], enabledMcpjsonServers: ['x'] }, INHERITED))
      .toEqual({ ...TRUSTED, allowedTools: ['Edit'] });
  });

  it('reads a decline only as the pair', () => {
    expect(isImportsDecline(DECLINE)).toBe(true);
    expect(isImportsDecline(DEFAULT_TRIPLE)).toBe(false);
    expect(isImportsDecline({ hasClaudeMdExternalIncludesWarningShown: true })).toBe(false);
  });
});

describe('resolveTrustTargets (real directories)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-trust-')));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes the cwd and its worktree git root under a workspace directory', async () => {
    const workspace = path.join(root, 'code', 'purplemux');
    const worktree = path.join(workspace, '.worktrees', 'hfl2-05');
    await fs.mkdir(path.join(worktree, 'src'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.git'));
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${workspace}/.git/worktrees/hfl2-05\n`);

    const targets = await resolveTrustTargets(path.join(worktree, 'src'), [workspace]);

    expect(targets).toEqual({ workspaceDirectory: workspace, keys: [path.join(worktree, 'src'), worktree] });
  });

  it('adds the main repository root of a worktree (where Claude 2.1.318 keys the imports approval)', async () => {
    const workspace = path.join(root, 'code');
    const repo = path.join(workspace, 'purplemux');
    const worktree = path.join(repo, '.worktrees', 'wt');
    await fs.mkdir(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    await fs.writeFile(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${repo}/.git/worktrees/wt\n`);

    expect((await resolveTrustTargets(worktree, [workspace]))?.keys).toEqual([worktree, repo]);
    // A workspace rooted at the worktree itself: the main checkout is outside it, so it is not written.
    expect((await resolveTrustTargets(worktree, [worktree]))?.keys).toEqual([worktree]);
  });

  it('reads the main repository root only from a readable worktree pointer', async () => {
    const plain = path.join(root, 'plain');
    await fs.mkdir(path.join(plain, '.git'), { recursive: true });
    expect(await mainRepositoryRoot(plain)).toBe(plain);
    const broken = path.join(root, 'broken');
    await fs.mkdir(broken);
    await fs.writeFile(path.join(broken, '.git'), 'gitdir: /nonexistent/worktrees/x\n');
    expect(await mainRepositoryRoot(broken)).toBeNull();
    const bare = path.join(root, 'bare-wt');
    await fs.mkdir(path.join(root, 'bare.git', 'worktrees', 'x'), { recursive: true });
    await fs.writeFile(path.join(root, 'bare.git', 'worktrees', 'x', 'commondir'), '../..\n');
    await fs.mkdir(bare);
    await fs.writeFile(path.join(bare, '.git'), `gitdir: ${root}/bare.git/worktrees/x\n`);
    expect(await mainRepositoryRoot(bare)).toBeNull();
    expect(await mainRepositoryRoot(path.join(root, 'nothing'))).toBeNull();
  });

  it('writes the workspace directory itself when the cwd is it', async () => {
    const workspace = path.join(root, 'portfolio');
    await fs.mkdir(workspace);
    expect(await resolveTrustTargets(workspace, [workspace])).toEqual({ workspaceDirectory: workspace, keys: [workspace] });
  });

  it('never climbs past the workspace directory to a git root above it', async () => {
    const repo = path.join(root, 'repo');
    const workspace = path.join(repo, 'packages');
    await fs.mkdir(path.join(workspace, 'a'), { recursive: true });
    await fs.mkdir(path.join(repo, '.git'));
    const targets = await resolveTrustTargets(path.join(workspace, 'a'), [workspace]);
    expect(targets?.keys).toEqual([path.join(workspace, 'a')]);
  });

  it('pre-trusts nothing outside every workspace directory', async () => {
    const workspace = path.join(root, 'ws');
    const outside = path.join(root, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    expect(await resolveTrustTargets(outside, [workspace])).toBeNull();
    expect(await resolveTrustTargets(`${workspace}-sibling`, [workspace])).toBeNull();
  });

  // Review r1 BLOCK: the real path decides; a lexical path inside the workspace never qualifies.
  it('seeds nothing for a symlink inside the workspace that points out of it', async () => {
    const workspace = path.join(root, 'ws');
    const outside = path.join(root, 'elsewhere');
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(outside, '.git'), { recursive: true });
    await fs.symlink(outside, path.join(workspace, 'link'));
    expect(await resolveTrustTargets(path.join(workspace, 'link'), [workspace])).toBeNull();
  });

  it('seeds nothing for <ws>/link/.. when the link points out (the process resolves the link first)', async () => {
    const workspace = path.join(root, 'ws');
    const outside = path.join(root, 'far', 'away');
    await fs.mkdir(workspace);
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(workspace, 'link'));
    expect(await resolveTrustTargets(`${workspace}/link/..`, [workspace])).toBeNull();
  });

  it('never writes a main repository root whose real path leaves the workspace through a symlink', async () => {
    const workspace = path.join(root, 'ws');
    const realRepo = path.join(root, 'outside-repo');
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(realRepo, '.git', 'worktrees', 'wt'), { recursive: true });
    await fs.writeFile(path.join(realRepo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    await fs.symlink(realRepo, path.join(workspace, 'repo-link'));
    const worktree = path.join(workspace, 'wt');
    await fs.mkdir(worktree);
    await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${workspace}/repo-link/.git/worktrees/wt\n`);
    expect((await resolveTrustTargets(worktree, [workspace]))?.keys).toEqual([worktree]);
  });

  it('seeds nothing for a cwd that does not exist (its real path cannot be read)', async () => {
    const workspace = path.join(root, 'ws');
    await fs.mkdir(workspace);
    expect(await resolveTrustTargets(path.join(workspace, 'missing'), [workspace])).toBeNull();
  });

  it('matches through a symlinked workspace directory and writes both spellings of the cwd', async () => {
    const real = path.join(root, 'real-ws');
    await fs.mkdir(path.join(real, 'sub'), { recursive: true });
    const link = path.join(root, 'linked-ws');
    await fs.symlink(real, link);
    const targets = await resolveTrustTargets(path.join(link, 'sub'), [link]);
    expect(targets?.workspaceDirectory).toBe(link);
    expect(targets?.keys).toEqual([path.join(link, 'sub'), path.join(real, 'sub')]);
  });
});
