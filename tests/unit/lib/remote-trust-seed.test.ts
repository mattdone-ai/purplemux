import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_TRUST_SEED_RELATIVE, REMOTE_TRUST_SEED_SCRIPT, remoteCwdLines, remoteTrustSeedLine } from '@/lib/remote-kit';

// D14 (story 05 AC 2): the remote half of the pre-trust, run for real against a fake remote host: a
// temporary HOME holding the remote user's ~/.claude.json, and the python3 a pool host has.

const TRUSTED = { hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };

describe('the remote trust-seed script (story 05 AC 2)', () => {
  let home: string;
  let kit: string;
  let workspace: string;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-remote-home-')));
    kit = path.join(home, '.purplemux-remote', 'host-a');
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
    const line = remoteTrustSeedLine({ cwd: workspace, workspaceDirectories: [workspace], named: false });
    fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), 'import sys\nsys.exit(1)\n');
    expect(run(`set -e\nd="${kit}"\n${line}\necho created`, process.env.PATH ?? '')).toBe('created\n');
    const noPython = fs.mkdtempSync(path.join(home, 'bin-'));
    expect(run(`set -e\nd="${kit}"\n${line}\necho created`, noPython)).toBe('created\n');
  });

  it('quotes the cwd and the workspace directory for the remote shell', () => {
    expect(remoteTrustSeedLine({ cwd: "/srv/it's here", workspaceDirectories: ['/srv'], named: false }))
      .toBe(`if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" '/srv/it'\\''s here' '/srv' >/dev/null 2>&1 || :; fi`);
    expect(remoteTrustSeedLine({ cwd: '/srv/a', workspaceDirectories: ['/w1', '/w2'], named: true }))
      .toBe(`if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" '--named' '/srv/a' '/w1' '/w2' >/dev/null 2>&1 || :; fi`);
  });
});

// vel-PMX-FU, consult ruling C: a remote tab create pre-trusts the cwd its creator named, on the host, outside every
// workspace directory: the trust key on the cwd only, the CLAUDE.md-include keys on its main repository root, and
// hard refusals for a cwd whose trust would cover the home or the whole disk. Run for real against a fake home.
describe('the named cwd pre-trust (vel-PMX-FU)', () => {
  const INCLUDES = { hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };
  let root: string;
  let home: string;
  let kit: string;
  let workspace: string;

  beforeEach(() => {
    // Nested, so the home has an ancestor that is not a top-level directory.
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-named-')));
    home = path.join(root, 'users', 'user');
    kit = path.join(home, '.purplemux-remote', 'control-host');
    fs.mkdirSync(kit, { recursive: true });
    fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), REMOTE_TRUST_SEED_SCRIPT);
    workspace = path.join(home, 'code', 'workspace-dir');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const seed = (args: string[]) =>
    spawnSync('python3', [path.join(kit, REMOTE_TRUST_SEED_RELATIVE), ...args], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  const configFile = () => path.join(home, '.claude.json');
  const projects = () => JSON.parse(fs.readFileSync(configFile(), 'utf-8')).projects ?? {};

  it('outside every workspace directory: the trust key on the cwd only, the include keys on the repository root', () => {
    const repo = path.join(home, 'elsewhere', 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(configFile(), JSON.stringify({ oauthAccount: { id: 'kept' }, projects: { '/other': { allowedTools: ['Bash'] } } }));

    expect(seed(['--named', path.join(repo, 'src'), workspace]).status).toBe(0);

    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written.oauthAccount).toEqual({ id: 'kept' });
    expect(written.projects).toEqual({
      '/other': { allowedTools: ['Bash'] },
      [path.join(repo, 'src')]: TRUSTED,
      [repo]: INCLUDES,
    });
    expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.claude.json.'))).toEqual([]);
  });

  it('a linked worktree outside the workspace: trust on the worktree, the include keys on its main checkout; both spellings of a link', () => {
    const main = path.join(home, 'clones', 'main');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const worktree = path.join(home, 'trees', 'wt');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${main}/.git/worktrees/wt\n`);
    const link = path.join(home, 'link-to-wt');
    fs.symlinkSync(worktree, link);

    expect(seed(['--first-run', '--named', link]).status).toBe(0);

    // The real path only (review r1 C2): the link's spelling is not keyed.
    const onboarded = { ...TRUSTED, hasCompletedProjectOnboarding: true };
    expect(projects()).toEqual({
      [worktree]: onboarded,
      [main]: { ...INCLUDES, hasCompletedProjectOnboarding: true },
    });
  });

  it('a link followed by "..": the trust key goes on the real parent, never on the lexical one (review r1 C2)', () => {
    const target = path.join(home, 'clones', 'deep', 'repo');
    fs.mkdirSync(target, { recursive: true });
    const holder = path.join(home, 'links');
    fs.mkdirSync(holder);
    fs.symlinkSync(target, path.join(holder, 'to-repo'));
    expect(seed(['--named', `${holder}/to-repo/..`]).status).toBe(0);
    expect(projects()).toEqual({ [path.join(home, 'clones', 'deep')]: TRUSTED });
    expect(projects()).not.toHaveProperty(home);
  });

  const hasTmux = spawnSync('tmux', ['-V']).status === 0;
  /**
   * The create script's own cwd, seed and session lines, run for real: the kit's `$d`, a throwaway tmux socket. The
   * pane writes its own physical directory to a marker file. That, not tmux's pane_current_path, is the pane folder:
   * pane_current_path read right after new-session can show the server's directory while the pane child is still
   * between taking the terminal and its chdir (CI on PR #59; measured 6 of 200 immediate reads off under CPU load).
   */
  const runCreateFragment = (cwd: string, socket: string, marker: string, onMissing: 'refuse' | 'home') => spawnSync('/bin/sh', ['-c', [
    'set -e',
    `d="${kit}"`,
    ...remoteCwdLines(cwd, onMissing),
    `if [ -z "$pmux_cwd_fallback" ]; then ${remoteTrustSeedLine({ cwd, workspaceDirectories: [workspace], named: true }, '"$pmux_cwd"')}; fi`,
    `tmux -L ${socket} -f /dev/null new-session -d -s trust -c "$pmux_cwd" 'pwd -P > ${marker}; exec sleep 30'`,
  ].join('\n')], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  const paneFolder = async (marker: string): Promise<string> => {
    await vi.waitFor(() => expect(fs.existsSync(marker) && fs.readFileSync(marker, 'utf-8').endsWith('\n')).toBe(true), { timeout: 10_000, interval: 25 });
    return fs.readFileSync(marker, 'utf-8').trim();
  };

  it.skipIf(!hasTmux)('"<link>/..": the pane folder, the trusted key and the host realpath are one path (CI on PR #59)', async () => {
    const target = path.join(home, 'clones', 'deep', 'repo');
    fs.mkdirSync(target, { recursive: true });
    const holder = path.join(home, 'links');
    fs.mkdirSync(holder);
    fs.symlinkSync(target, path.join(holder, 'to-repo'));
    const cwd = `${holder}/to-repo/..`;
    const socket = `pmux-trust-${process.pid}-${Date.now()}`;
    const marker = path.join(root, 'pane-folder');
    try {
      const run = runCreateFragment(cwd, socket, marker, 'refuse');
      expect(run.status, run.stderr).toBe(0);
      const folder = await paneFolder(marker);
      // Node's realpath collapses ".." before it follows the link; the host's, like the kernel's chdir, follows it first.
      const hostRealpath = execFileSync('python3', ['-c', 'import os, sys; print(os.path.realpath(sys.argv[1]))', cwd], { encoding: 'utf-8' }).trim();
      expect(hostRealpath).toBe(path.join(home, 'clones', 'deep'));
      expect(folder).toBe(hostRealpath);
      expect(Object.keys(projects())).toEqual([hostRealpath]);
    } finally {
      spawnSync('tmux', ['-L', socket, 'kill-server']);
    }
  });

  it('a fresh create of a named cwd that does not resolve refuses by name, exit 19, before the seed or tmux runs', () => {
    const run = runCreateFragment(path.join(home, 'no-such-dir'), `pmux-trust-none-${process.pid}`, path.join(root, 'unused'), 'refuse');
    expect(run.status).toBe(19);
    expect(run.stderr).toContain(`pmux: cwd ${path.join(home, 'no-such-dir')} is not a directory on this host`);
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it.skipIf(!hasTmux)('a revival of a named cwd the host lost starts in HOME with a note, and trusts nothing (review r4)', async () => {
    const socket = `pmux-trust-revive-${process.pid}-${Date.now()}`;
    const marker = path.join(root, 'pane-folder-revived');
    try {
      const run = runCreateFragment(path.join(home, 'deleted-worktree'), socket, marker, 'home');
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toContain(`pmux: cwd ${path.join(home, 'deleted-worktree')} is not a directory on this host; the pane starts in HOME`);
      expect(await paneFolder(marker)).toBe(home);
      expect(fs.existsSync(configFile())).toBe(false);
    } finally {
      spawnSync('tmux', ['-L', socket, 'kill-server']);
    }
  });

  /**
   * Runs the seed's own functions with read_object wrapped: `races` other writes land on the file right after the
   * seed reads it, the lost-update window of an unlocked read-modify-write (review r1 C1).
   */
  const seedWithRacingWriter = (args: string[], races: number) => {
    const runner = `
import json, sys
src = open(sys.argv[1], encoding='utf-8').read().replace('sys.exit(main(sys.argv[1:]))', '')
ns = {'__name__': 'seed'}
exec(src, ns)
original = ns['read_object']
left = [int(sys.argv[2])]
def racing(target):
    data = original(target)
    if left[0] > 0 and target.endswith('.claude.json'):
        left[0] -= 1
        current = original(target) or {}
        current['otherWriter'] = current.get('otherWriter', 0) + 1
        with open(target, 'w', encoding='utf-8') as handle:
            json.dump(current, handle)
    return data
ns['read_object'] = racing
sys.exit(ns['main'](sys.argv[3:]))
`;
    return spawnSync('python3', ['-c', runner, path.join(kit, REMOTE_TRUST_SEED_RELATIVE), String(races), ...args],
      { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
  };

  it('a write that lands between the read and the replace is kept: the seed re-reads and applies its keys on top', () => {
    fs.mkdirSync(path.join(home, 'proj'));
    fs.writeFileSync(configFile(), JSON.stringify({ kept: true }));
    const run = seedWithRacingWriter(['--named', path.join(home, 'proj')], 1);
    expect(run.status, run.stderr).toBe(0);
    const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
    expect(written.kept).toBe(true);
    expect(written.otherWriter).toBe(1);
    expect(written.projects).toEqual({ [path.join(home, 'proj')]: TRUSTED });
  });

  it('two racing writes: the seed writes nothing and exits 7, so the other writer\'s file stands', () => {
    fs.mkdirSync(path.join(home, 'proj'));
    fs.writeFileSync(configFile(), JSON.stringify({ kept: true }));
    const run = seedWithRacingWriter(['--named', path.join(home, 'proj')], 2);
    expect(run.status, run.stderr).toBe(7);
    expect(JSON.parse(fs.readFileSync(configFile(), 'utf-8'))).toEqual({ kept: true, otherWriter: 2 });
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.claude.json.'))).toEqual([]);
  });

  it('a cwd inside a workspace directory still takes the D14 rule under --named', () => {
    fs.mkdirSync(path.join(workspace, 'src'));
    expect(seed(['--named', path.join(workspace, 'src'), workspace]).status).toBe(0);
    expect(projects()).toEqual({ [path.join(workspace, 'src')]: TRUSTED, [workspace]: TRUSTED });
  });

  it('refuses a cwd whose trust would cover the home or the disk (exit 6) and a missing one (exit 5), writing no project key', () => {
    fs.symlinkSync('/', path.join(home, 'to-root'));
    fs.symlinkSync(home, path.join(root, 'to-home'));
    fs.mkdirSync(path.join(home, 'x'));
    const cases: Array<[string, number]> = [
      ['/', 6],
      [path.parse(root).root + root.split(path.sep)[1], 6],
      [home, 6],
      [path.dirname(home), 6],
      [path.join(home, 'to-root'), 6],
      [path.join(root, 'to-home'), 6],
      [`${home}/x/..`, 6],
      [path.join(home, 'no-such-dir'), 5],
    ];
    for (const [cwd, code] of cases) {
      expect(seed(['--named', cwd]).status, cwd).toBe(code);
      expect(fs.existsSync(configFile()), cwd).toBe(false);
    }
    fs.writeFileSync(configFile(), '{"keep": 1}');
    for (const [cwd, code] of cases) {
      expect(seed(['--named', cwd]).status, cwd).toBe(code);
      expect(fs.readFileSync(configFile(), 'utf-8'), cwd).toBe('{"keep": 1}');
    }
    for (const [cwd, code] of cases) {
      expect(seed(['--first-run', '--named', cwd]).status, cwd).toBe(code);
      const written = JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
      expect(written.projects ?? {}, cwd).toEqual({});
      expect(written.hasCompletedOnboarding, cwd).toBe(true);
    }
  });

  it('a dotfiles repository in the home: the cwd keys only, nothing at the home', () => {
    fs.mkdirSync(path.join(home, '.git'));
    fs.mkdirSync(path.join(home, 'proj'));
    expect(seed(['--named', path.join(home, 'proj')]).status).toBe(0);
    expect(projects()).toEqual({ [path.join(home, 'proj')]: TRUSTED });
  });

  it('no widening without --named: an empty workspace list still exits 3 and writes nothing', () => {
    const repo = path.join(home, 'elsewhere', 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(seed([repo]).status).toBe(3);
    expect(fs.existsSync(configFile())).toBe(false);
    expect(seed(['--named']).status).toBe(2);
  });
});
