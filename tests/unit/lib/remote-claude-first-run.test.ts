import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ getDangerouslySkipPermissions: vi.fn(async () => true) }));
const home = vi.hoisted(() => ({ workspaceDirectories: vi.fn(async (_wsId: string): Promise<string[]> => []) }));
vi.mock('@/lib/config-store', () => config);
vi.mock('@/lib/workspace-home', () => home);
vi.mock('@/lib/claude-prompt', () => ({
  getClaudePromptPath: (wsId: string) => `/home/u/.purplemux/workspaces/${wsId}/claude-prompt.md`,
  writeClaudePromptFile: vi.fn(),
}));

import { buildRemoteClaudeLaunch } from '@/lib/claude-command';
import { originName } from '@/lib/remote-host';
import { buildRemoteClaudeCommand, REMOTE_TRUST_SEED_RELATIVE, REMOTE_TRUST_SEED_SCRIPT, remoteKitFiles } from '@/lib/remote-kit';

// A new remote host stopped its first Claude tab at the theme picker, then at the bypass-permissions warning
// (measured 2026-11-09 on two hosts). The kit's seed writes Claude Code's first-run state for the remote user,
// from the Claude launch line itself, so no Claude process on the host can write an older file back first.

const FIRST_RUN_PROJECT = {
  hasTrustDialogAccepted: true,
  hasClaudeMdExternalIncludesApproved: true,
  hasClaudeMdExternalIncludesWarningShown: true,
  hasCompletedProjectOnboarding: true,
};

describe('the remote seed: Claude Code first-run state', () => {
  let userHome: string;
  let kit: string;
  let workspace: string;

  beforeEach(() => {
    userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-first-run-')));
    kit = path.join(userHome, '.purplemux-remote', originName());
    fs.mkdirSync(path.join(kit, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), REMOTE_TRUST_SEED_SCRIPT);
    workspace = path.join(userHome, 'code', 'repo');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  const stateFile = () => path.join(userHome, '.claude.json');
  const settingsFile = () => path.join(userHome, '.claude', 'settings.json');
  const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));
  const seed = (...args: string[]) =>
    spawnSync('python3', [path.join(kit, REMOTE_TRUST_SEED_RELATIVE), ...args], { env: { ...process.env, HOME: userHome }, encoding: 'utf-8' });

  describe('the script', () => {
    it('gives a fresh HOME every key the first run asks for', () => {
      expect(seed('--first-run', '--bypass-permissions', workspace, workspace).status).toBe(0);

      expect(readJson(stateFile())).toEqual({
        hasCompletedOnboarding: true,
        theme: 'dark',
        projects: { [workspace]: FIRST_RUN_PROJECT },
      });
      expect(readJson(settingsFile())).toEqual({ skipDangerousModePermissionPrompt: true });
      expect(fs.statSync(path.join(userHome, '.claude')).mode & 0o777).toBe(0o700);
      expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o600);
    });

    it('merges into existing files: every other key survives, and an owner theme stays', () => {
      fs.writeFileSync(stateFile(), JSON.stringify({
        oauthAccount: { emailAddress: 'a@b' },
        hasCompletedOnboarding: false,
        theme: 'light-daltonized',
        numStartups: 7,
        projects: { '/other': { allowedTools: ['Bash'] }, [workspace]: { lastSessionId: 's' } },
      }));
      fs.mkdirSync(path.join(userHome, '.claude'));
      fs.writeFileSync(settingsFile(), JSON.stringify({ model: 'opus', hooks: { Stop: [] }, skipDangerousModePermissionPrompt: false }));
      fs.chmodSync(settingsFile(), 0o644);

      expect(seed('--first-run', '--bypass-permissions', workspace, workspace).status).toBe(0);

      expect(readJson(stateFile())).toEqual({
        oauthAccount: { emailAddress: 'a@b' },
        hasCompletedOnboarding: true,
        theme: 'light-daltonized',
        numStartups: 7,
        projects: { '/other': { allowedTools: ['Bash'] }, [workspace]: { lastSessionId: 's', ...FIRST_RUN_PROJECT } },
      });
      expect(readJson(settingsFile())).toEqual({ model: 'opus', hooks: { Stop: [] }, skipDangerousModePermissionPrompt: true });
      expect(fs.statSync(settingsFile()).mode & 0o777).toBe(0o644);
      expect(fs.readdirSync(userHome).filter((name) => name.startsWith('.claude.json.'))).toEqual([]);
      expect(fs.readdirSync(path.join(userHome, '.claude')).filter((name) => name !== 'settings.json')).toEqual([]);
    });

    it('writes the bypass key only for a launch that bypasses permissions', () => {
      expect(seed('--first-run', workspace, workspace).status).toBe(0);
      expect(readJson(stateFile()).hasCompletedOnboarding).toBe(true);
      expect(fs.existsSync(settingsFile())).toBe(false);
    });

    it('seeds the first run but trusts nothing for a cwd outside every workspace directory (exit 3)', () => {
      const outside = path.join(userHome, 'scratch');
      fs.mkdirSync(outside);
      expect(seed('--first-run', '--bypass-permissions', outside, workspace).status).toBe(3);
      expect(readJson(stateFile())).toEqual({ hasCompletedOnboarding: true, theme: 'dark' });
      expect(readJson(settingsFile())).toEqual({ skipDangerousModePermissionPrompt: true });
      expect(seed('--first-run', outside).status).toBe(3);
    });

    it('trusts the cwd under the deepest of several workspace directories', () => {
      const second = path.join(userHome, 'code', 'other');
      const cwd = path.join(second, 'pkg');
      fs.mkdirSync(cwd, { recursive: true });
      expect(seed('--first-run', cwd, workspace, path.join(userHome, 'code'), second).status).toBe(0);
      expect(Object.keys(readJson(stateFile()).projects)).toEqual([cwd]);
    });

    it('writes through a symlinked settings.json and keeps the link', () => {
      const shared = path.join(userHome, 'shared-settings.json');
      fs.writeFileSync(shared, JSON.stringify({ env: { A: '1' } }));
      fs.mkdirSync(path.join(userHome, '.claude'));
      fs.symlinkSync(shared, settingsFile());
      expect(seed('--first-run', '--bypass-permissions', workspace, workspace).status).toBe(0);
      expect(fs.lstatSync(settingsFile()).isSymbolicLink()).toBe(true);
      expect(readJson(shared)).toEqual({ env: { A: '1' }, skipDangerousModePermissionPrompt: true });
    });

    it('leaves an unreadable settings.json as it is (exit 4) and still seeds ~/.claude.json', () => {
      fs.mkdirSync(path.join(userHome, '.claude'));
      fs.writeFileSync(settingsFile(), '{ half');
      expect(seed('--first-run', '--bypass-permissions', workspace, workspace).status).toBe(4);
      expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe('{ half');
      expect(readJson(stateFile()).hasCompletedOnboarding).toBe(true);
    });

    it('leaves both files byte for byte when nothing changes', () => {
      const state = JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', projects: { [workspace]: FIRST_RUN_PROJECT } });
      const settings = JSON.stringify({ skipDangerousModePermissionPrompt: true });
      fs.writeFileSync(stateFile(), state);
      fs.mkdirSync(path.join(userHome, '.claude'));
      fs.writeFileSync(settingsFile(), settings);
      expect(seed('--first-run', '--bypass-permissions', workspace, workspace).status).toBe(0);
      expect(fs.readFileSync(stateFile(), 'utf-8')).toBe(state);
      expect(fs.readFileSync(settingsFile(), 'utf-8')).toBe(settings);
    });

    it('without --first-run, writes the trust triple only, as the create script asks', () => {
      expect(seed(workspace, workspace).status).toBe(0);
      expect(readJson(stateFile())).toEqual({ projects: { [workspace]: {
        hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true,
      } } });
      expect(fs.existsSync(settingsFile())).toBe(false);
    });

    it('refuses an unknown flag (exit 2) and writes nothing', () => {
      expect(seed('--first-rnu', workspace, workspace).status).toBe(2);
      expect(fs.existsSync(stateFile())).toBe(false);
    });
  });

  describe('the launch line', () => {
    // A stand-in `claude` that records what it reads at start: the files as the real one would load them.
    const fakeClaudeBin = (): string => {
      const bin = fs.mkdtempSync(path.join(userHome, 'fake-bin-'));
      fs.writeFileSync(path.join(bin, 'claude'), [
        '#!/bin/sh',
        'cat "$HOME/.claude.json" > "$HOME/seen-state.json" 2>/dev/null || echo missing > "$HOME/seen-state.json"',
        'cat "$HOME/.claude/settings.json" > "$HOME/seen-settings.json" 2>/dev/null || echo missing > "$HOME/seen-settings.json"',
        'printf "%s\\n" "$@" > "$HOME/seen-args"',
        '',
      ].join('\n'));
      fs.chmodSync(path.join(bin, 'claude'), 0o755);
      return bin;
    };
    const runLaunch = (line: string, cwd: string, pathEnv: string) =>
      execFileSync('/bin/sh', ['-c', line], { cwd, env: { ...process.env, HOME: userHome, PATH: pathEnv }, encoding: 'utf-8' });
    const pythonDir = () => path.dirname(execFileSync('/bin/sh', ['-c', 'command -v python3'], { encoding: 'utf-8' }).trim());

    it('seeds the first-run state before claude starts, in the same command', () => {
      const bin = fakeClaudeBin();
      const line = buildRemoteClaudeCommand({ workspaceId: 'ws-a', skipPermissions: true, workspaceDirectories: [workspace] });

      runLaunch(line, workspace, `${bin}:${pythonDir()}:/usr/bin:/bin`);

      const seen = readJson(path.join(userHome, 'seen-state.json'));
      expect(seen.hasCompletedOnboarding).toBe(true);
      expect(seen.theme).toBe('dark');
      expect(seen.projects[workspace]).toEqual(FIRST_RUN_PROJECT);
      expect(readJson(path.join(userHome, 'seen-settings.json'))).toEqual({ skipDangerousModePermissionPrompt: true });
      expect(fs.readFileSync(path.join(userHome, 'seen-args'), 'utf-8')).toContain('--dangerously-skip-permissions');
    });

    it('re-seeds on each launch: a file an exiting Claude wrote back gets the keys again', () => {
      const bin = fakeClaudeBin();
      const line = buildRemoteClaudeCommand({ workspaceId: 'ws-a', skipPermissions: false, workspaceDirectories: [workspace] });
      runLaunch(line, workspace, `${bin}:${pythonDir()}:/usr/bin:/bin`);
      fs.writeFileSync(stateFile(), JSON.stringify({ numStartups: 1 }));

      runLaunch(line, workspace, `${bin}:${pythonDir()}:/usr/bin:/bin`);

      expect(readJson(path.join(userHome, 'seen-state.json'))).toMatchObject({ numStartups: 1, hasCompletedOnboarding: true, theme: 'dark' });
      expect(fs.readFileSync(path.join(userHome, 'seen-settings.json'), 'utf-8')).toBe('missing\n');
    });

    it('still starts claude when the seed fails or the host has no python3', () => {
      const bin = fakeClaudeBin();
      const line = buildRemoteClaudeCommand({ workspaceId: 'ws-a', workspaceDirectories: [workspace] });
      fs.writeFileSync(path.join(kit, REMOTE_TRUST_SEED_RELATIVE), 'import sys\nsys.exit(1)\n');
      runLaunch(line, workspace, `${bin}:${pythonDir()}:/usr/bin:/bin`);
      expect(fs.existsSync(path.join(userHome, 'seen-args'))).toBe(true);
      fs.rmSync(path.join(userHome, 'seen-args'));

      const noPython = fs.mkdtempSync(path.join(userHome, 'bare-'));
      fs.symlinkSync('/bin/cat', path.join(noPython, 'cat'));
      fs.symlinkSync('/bin/sh', path.join(noPython, 'sh'));
      runLaunch(line, workspace, `${bin}:${noPython}`);
      expect(fs.existsSync(path.join(userHome, 'seen-args'))).toBe(true);
    });

    it('quotes every workspace directory and expands the cwd on the remote shell', () => {
      const line = buildRemoteClaudeCommand({ workspaceId: 'ws-a', skipPermissions: true, workspaceDirectories: ["/srv/it's", '/w'] });
      const kitDir = `"$HOME/.purplemux-remote/${originName()}`;
      expect(line).toBe(
        `command -v python3 >/dev/null 2>&1 && python3 ${kitDir}/trust-seed.py" --first-run --bypass-permissions "$PWD" '/srv/it'\\''s' '/w' >/dev/null 2>&1; `
        + `PATH=${kitDir}/bin":"$PATH" claude --settings ${kitDir}/hooks.json" --append-system-prompt-file ${kitDir}/workspaces/ws-a/claude-prompt.md" --dangerously-skip-permissions`,
      );
    });
  });

  it('every kit ships the seed script: the launch line needs it whether or not the create pre-trusted', () => {
    const files = remoteKitFiles({ tmuxConf: '', cli: null, prompt: null });
    expect(files.find((file) => file.path === REMOTE_TRUST_SEED_RELATIVE)?.content).toBe(REMOTE_TRUST_SEED_SCRIPT);
  });

  it('the remote launch passes the workspace directories and the bypass setting to the seed', async () => {
    home.workspaceDirectories.mockResolvedValueOnce(['/home/u/code/repo', 'relative/dir', '/home/u/code/x/../y']);
    config.getDangerouslySkipPermissions.mockResolvedValueOnce(true);
    const line = await buildRemoteClaudeLaunch('ws-a', { model: 'claude-opus-5-5' });
    expect(home.workspaceDirectories).toHaveBeenCalledWith('ws-a');
    expect(line).toContain(`--first-run --bypass-permissions "$PWD" '/home/u/code/repo' '/home/u/code/y' >/dev/null 2>&1; PATH=`);
    expect(line).toContain('--model claude-opus-5-5');

    home.workspaceDirectories.mockRejectedValueOnce(new Error('workspaces.json unreadable'));
    config.getDangerouslySkipPermissions.mockResolvedValueOnce(false);
    const fallback = await buildRemoteClaudeLaunch('ws-a');
    expect(fallback).toContain('--first-run "$PWD" >/dev/null 2>&1; PATH=');
  });

  it('vel-PMX-FU: a named tab\'s launch seeds its recorded cwd literally with --named, never "$PWD"; a relative one throws', async () => {
    const line = buildRemoteClaudeCommand({ workspaceId: 'ws-a', workspaceDirectories: ['/w'], namedCwd: "/srv/it's/repo" });
    expect(line).toContain(` --first-run --named '/srv/it'\\''s/repo' '/w' >/dev/null 2>&1; PATH=`);
    expect(line).not.toContain('"$PWD"');
    expect(() => buildRemoteClaudeCommand({ workspaceId: 'ws-a', namedCwd: 'srv/repo' })).toThrow(/absolute/);
    home.workspaceDirectories.mockResolvedValueOnce(['/w']);
    config.getDangerouslySkipPermissions.mockResolvedValueOnce(false);
    expect(await buildRemoteClaudeLaunch('ws-a', { trustCwd: '/srv/repo' })).toContain(`--first-run --named '/srv/repo' '/w' >/dev/null`);
  });
});
