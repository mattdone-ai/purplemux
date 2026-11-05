import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_TRUST_SEED_RELATIVE, REMOTE_TRUST_SEED_SCRIPT, remoteTrustSeedLine } from '@/lib/remote-kit';

// D14 (story 05 AC 2): the remote half of the pre-trust, run for real against a fake remote host: a
// temporary HOME holding the remote user's ~/.claude.json, and the python3 a pool host has.

const TRUSTED = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };

describe('the remote trust-seed script (story 05 AC 2)', () => {
  let home: string;
  let kit: string;
  let workspace: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-remote-home-')));
    kit = path.join(home, '.purplemux-remote', 'mdserver1');
    fs.mkdirSync(kit, { recursive: true });
    fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), REMOTE_TRUST_SEED_SCRIPT);
    workspace = path.join(home, 'code', 'purplemux');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const seed = (cwd: string, workspaceDirectory = workspace) =>
    spawnSync('python3', [path.join(kit, REMOTE_TRUST_SEED_RELATIVE), cwd, workspaceDirectory], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  const config = () => JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));

  it('pre-trusts a worktree at its cwd and git root, keeps the rest of the file, and leaves no temporary', () => {
    const worktree = path.join(workspace, '.worktrees', 'hfl2-05');
    fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: x\n');
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'é@x' }, projects: { '/other': { allowedTools: ['Bash'] } } }));

    expect(seed(path.join(worktree, 'src')).status).toBe(0);

    const written = config();
    expect(written.oauthAccount).toEqual({ emailAddress: 'é@x' });
    expect(written.projects['/other']).toEqual({ allowedTools: ['Bash'] });
    expect(written.projects[path.join(worktree, 'src')]).toEqual(TRUSTED);
    expect(written.projects[worktree]).toEqual(TRUSTED);
    expect(fs.statSync(path.join(home, '.claude.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.claude.json.'))).toEqual([]);
  });

  it('writes the main repository root of a real worktree layout too: where Claude keys the imports approval', () => {
    const worktree = path.join(workspace, '.worktrees', 'wt');
    fs.mkdirSync(path.join(workspace, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${workspace}/.git/worktrees/wt\n`);

    expect(seed(worktree).status).toBe(0);

    expect(Object.keys(config().projects).sort()).toEqual([workspace, worktree].sort());
    expect(config().projects[workspace]).toEqual(TRUSTED);
  });

  it('keeps the main repository root out when it is outside the workspace directory', () => {
    const repo = path.join(home, 'repo');
    const worktree = path.join(workspace, 'wt');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${repo}/.git/worktrees/wt\n`);

    expect(seed(worktree, worktree).status).toBe(0);

    expect(Object.keys(config().projects)).toEqual([worktree]);
  });

  it('keeps an imports decline and still sets the trust (consult ruling, case 7)', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [workspace]: {
      hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true, lastSessionId: 's',
    } } }));

    expect(seed(workspace).status).toBe(0);

    expect(config().projects[workspace]).toEqual({
      hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true, lastSessionId: 's',
    });
  });

  it('replaces a default-filled triple', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { [workspace]: {
      hasTrustDialogAccepted: false, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false,
    } } }));
    expect(seed(workspace).status).toBe(0);
    expect(config().projects[workspace]).toEqual(TRUSTED);
  });

  it('leaves a file that needs no change untouched, byte for byte', () => {
    const before = JSON.stringify({ projects: { [workspace]: TRUSTED } });
    fs.writeFileSync(path.join(home, '.claude.json'), before);
    expect(seed(workspace).status).toBe(0);
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')).toBe(before);
  });

  it('creates the file on a host that has none', () => {
    expect(seed(workspace).status).toBe(0);
    expect(config()).toEqual({ projects: { [workspace]: TRUSTED } });
  });

  it('refuses a cwd outside the workspace directory (exit 3) and writes nothing', () => {
    const outside = path.join(home, 'portfolio');
    fs.mkdirSync(outside);
    expect(seed(outside).status).toBe(3);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
    expect(seed(`${workspace}-sibling`).status).toBe(3);
  });

  // Review r1 BLOCK: the real path decides, here as in workspace-trust.ts.
  it('seeds nothing for a symlink inside the workspace that points out of it (exit 3)', () => {
    const outside = path.join(home, 'elsewhere');
    fs.mkdirSync(path.join(outside, '.git'), { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, 'link'));
    expect(seed(path.join(workspace, 'link')).status).toBe(3);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
  });

  it('seeds nothing for <ws>/link/.. when the link points out (exit 3)', () => {
    const outside = path.join(home, 'far', 'away');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, 'link'));
    expect(seed(`${workspace}/link/..`).status).toBe(3);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
  });

  it('still seeds through a symlinked workspace directory, at both spellings of the cwd', () => {
    const real = path.join(home, 'real-ws');
    fs.mkdirSync(path.join(real, 'sub'), { recursive: true });
    const link = path.join(home, 'linked-ws');
    fs.symlinkSync(real, link);
    expect(seed(path.join(link, 'sub'), link).status).toBe(0);
    expect(Object.keys(config().projects).sort()).toEqual([path.join(link, 'sub'), path.join(real, 'sub')].sort());
  });

  it('never writes a main repository root whose real path leaves the workspace through a symlink', () => {
    const realRepo = path.join(home, 'outside-repo');
    fs.mkdirSync(path.join(realRepo, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(realRepo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    fs.symlinkSync(realRepo, path.join(workspace, 'repo-link'));
    const worktree = path.join(workspace, 'wt');
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${workspace}/repo-link/.git/worktrees/wt\n`);
    expect(seed(worktree).status).toBe(0);
    expect(Object.keys(config().projects)).toEqual([worktree]);
  });

  it('never climbs past the workspace directory to a git root above it', () => {
    const inner = path.join(workspace, 'packages');
    fs.mkdirSync(path.join(inner, 'a'), { recursive: true });
    expect(seed(path.join(inner, 'a'), inner).status).toBe(0);
    expect(Object.keys(config().projects)).toEqual([path.join(inner, 'a')]);
  });

  it('leaves an unreadable file as it is (exit 4)', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), '{ half a file');
    expect(seed(workspace).status).toBe(4);
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8')).toBe('{ half a file');
  });

  it('a seed that fails, or a host without python3, never stops the create script', () => {
    const run = (script: string, pathEnv: string) => execFileSync('/bin/sh', ['-c', script], { env: { ...process.env, HOME: home, PATH: pathEnv }, encoding: 'utf-8' });
    const line = remoteTrustSeedLine({ cwd: workspace, workspaceDirectory: workspace });
    fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), 'import sys\nsys.exit(1)\n');
    expect(run(`set -e\nd="${kit}"\n${line}\necho created`, process.env.PATH ?? '')).toBe('created\n');
    const noPython = fs.mkdtempSync(path.join(home, 'bin-'));
    expect(run(`set -e\nd="${kit}"\n${line}\necho created`, noPython)).toBe('created\n');
  });

  it('quotes the cwd and the workspace directory for the remote shell', () => {
    expect(remoteTrustSeedLine({ cwd: "/srv/it's here", workspaceDirectory: '/srv' }))
      .toBe(`if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" '/srv/it'\\''s here' '/srv' >/dev/null 2>&1 || :; fi`);
  });
});
