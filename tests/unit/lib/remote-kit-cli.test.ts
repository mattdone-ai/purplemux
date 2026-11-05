import { execFile, spawnSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import {
  REMOTE_KIT_BROKEN_EXIT,
  buildRemoteCreateScript,
  cliLocalRequires,
  readRemoteCliModules,
  remoteKitFiles,
  remoteKitProbeFailureLine,
  remoteKitProbeLines,
  type IRemoteKitFile,
} from '@/lib/remote-kit';

// Story 36: the remote kit shipped bin/cli.js alone, while cli.js requires ./curator-spot-check-event.js at load, so
// every remote `purplemux` command (`note list` first) died with MODULE_NOT_FOUND.

const BIN = path.resolve('bin');
const run = promisify(execFile);
const readBin = (name: string) => fs.readFile(path.join(BIN, name), 'utf-8');

describe('the remote kit\'s CLI modules (story 36)', () => {
  it('reads the local ./x.js modules a source requires, and nothing else', () => {
    expect(cliLocalRequires("const a = require('./a.js');\nconst fs = require('fs');\nrequire(\"./b-c.js\");\nrequire('../up.js');"))
      .toEqual(['a.js', 'b-c.js']);
  });

  it('takes bin/cli.js and every local module it requires, transitively', async () => {
    const modules = await readRemoteCliModules(readBin);
    expect(Object.keys(modules ?? {}).sort()).toEqual(['cli.js', 'curator-spot-check-event.js']);
    expect(await readRemoteCliModules(async (name) => (name === 'cli.js' ? readBin(name) : Promise.reject(new Error('ENOENT'))))).toBeNull();
    expect(await readRemoteCliModules(async () => Promise.reject(new Error('ENOENT')))).toBeNull();
  });

  it('writes each module under bin/, and the kit\'s CLI loads from a bare directory', async () => {
    const cli = await readRemoteCliModules(readBin);
    const files = remoteKitFiles({ tmuxConf: '', cli, prompt: null });
    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining(['bin/cli.js', 'bin/curator-spot-check-event.js', 'bin/purplemux']));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-kit-cli-'));
    try {
      for (const file of files.filter((f) => f.path.startsWith('bin/'))) {
        await fs.mkdir(path.dirname(path.join(dir, file.path)), { recursive: true });
        await fs.writeFile(path.join(dir, file.path), file.content);
      }
      const { stdout } = await run(process.execPath, [path.join(dir, 'bin/cli.js'), 'help'], { env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: dir } });
      expect(stdout).toContain('owner messages -w WS');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Review r1 finding 6: `require('./x')` without .js, and a require inside a function, are the kit's modules too.
  it('takes extensionless, lazy and template-literal requires, transitively, and the fixture kit runs from a bare directory', async () => {
    expect(cliLocalRequires("require('./a'); const b = () => require(\"./b.js\"); require(`./c`); require('./d.json'); require('fs');"))
      .toEqual(['a.js', 'b.js', 'c.js', 'd.json']);
    const fixture = path.resolve('tests/fixtures/remote-kit-cli');
    const cli = await readRemoteCliModules((name) => fs.readFile(path.join(fixture, name), 'utf-8'));
    expect(Object.keys(cli ?? {}).sort()).toEqual(['cli.js', 'deep.js', 'greet.js', 'late.js', 'lazy-helper.js']);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-kit-fixture-'));
    try {
      for (const file of remoteKitFiles({ tmuxConf: '', cli, prompt: null }).filter((f) => f.path.startsWith('bin/'))) {
        await fs.mkdir(path.dirname(path.join(dir, file.path)), { recursive: true });
        await fs.writeFile(path.join(dir, file.path), file.content);
      }
      const { stdout } = await run(process.execPath, [path.join(dir, 'bin/cli.js')], { env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: dir } });
      expect(stdout).toBe('hello cli.js! lazy late\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('ships no CLI when cli.js cannot be read', () => {
    expect(remoteKitFiles({ tmuxConf: '', cli: null, prompt: null }).some((file) => file.path.startsWith('bin/'))).toBe(false);
  });
});

// Story 12: nothing checked that the shipped CLI runs, so a missing module surfaced later, inside a worker's turn.
// These run the probe lines the create script carries through a real `sh -s`, against a kit on disk.
describe('the remote kit probe (harness-flow-loop-2 story 12)', () => {
  /** A scratch HOME with the kit's bin/ files and a stand-in login shell that answers `command -v node`. */
  const scratchKit = async (cli: Record<string, string> | null, shellAnswer: string = process.execPath) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-kit-probe-'));
    const kit = path.join(home, 'kit');
    const files = remoteKitFiles({ tmuxConf: '', cli, prompt: null }).filter((f) => f.path.startsWith('bin/'));
    for (const file of files) {
      await fs.mkdir(path.dirname(path.join(kit, file.path)), { recursive: true });
      await fs.writeFile(path.join(kit, file.path), file.content, { mode: file.mode });
    }
    // The stand-in reads its stdin (a probe that left it attached would eat the rest of the script), prints a
    // profile banner on stdout and noise on stderr, then the answer: as an nvm profile and an interactive bash do.
    const shell = path.join(home, 'login-shell');
    await fs.writeFile(shell, `#!/bin/sh\ncat >/dev/null\necho 'welcome banner'\necho 'bash: no job control in this shell' >&2\n${shellAnswer ? `echo '${shellAnswer}'\n` : ''}`, { mode: 0o700 });
    return { home, kit, files, shell };
  };

  /** The probe lines in a `sh -s` script, followed by 128 KiB of padding and a marker the probe must not swallow. */
  const runProbe = (scratch: { home: string; kit: string; files: IRemoteKitFile[]; shell: string }) => {
    const modules = scratch.files.map((f) => f.path).filter((p) => /\.(?:c?js|json)$/.test(p));
    const script = ['set -e', `d='${scratch.kit}'`, ...remoteKitProbeLines(modules), `# ${'x'.repeat(128 * 1024)}`, 'echo after-probe', ''].join('\n');
    // No node on this PATH: the probe must find it through the login shell, as on a pool host.
    return spawnSync('sh', ['-s'], { input: script, encoding: 'utf-8', env: { NODE_ENV: 'test', HOME: scratch.home, SHELL: scratch.shell, PATH: '/usr/bin:/bin' } });
  };

  it('passes for the real CLI kit, finds node through the login shell, and leaves the rest of the script on stdin', async () => {
    const scratch = await scratchKit(await readRemoteCliModules(readBin));
    try {
      const result = runProbe(scratch);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('after-probe\n');
    } finally {
      await fs.rm(scratch.home, { recursive: true, force: true });
    }
  });

  it('a module missing on the host: exit 18 before the rest of the script, naming the module', async () => {
    const scratch = await scratchKit(await readRemoteCliModules(readBin));
    try {
      await fs.rm(path.join(scratch.kit, 'bin/curator-spot-check-event.js'));
      const result = runProbe(scratch);
      expect(result.status).toBe(REMOTE_KIT_BROKEN_EXIT);
      expect(result.stdout).toBe('');
      expect(remoteKitProbeFailureLine(result.stderr)).toBe("Error: Cannot find module './curator-spot-check-event.js'");
    } finally {
      await fs.rm(scratch.home, { recursive: true, force: true });
    }
  });

  it('a lazy module that cannot load fails the probe, although `help` alone never requires it', async () => {
    // A CLI whose lazy module only a command body would load: `help` alone passes with the broken module.
    const cli = {
      'cli.js': "'use strict';\nconst lazy = () => require('./lazy-helper.js');\nif (require.main === module) process.stdout.write('usage\\n');\nmodule.exports = { lazy };\n",
      'lazy-helper.js': "'use strict';\nmodule.exports = {\n",
    };
    expect(Object.keys((await readRemoteCliModules(async (name) => cli[name as keyof typeof cli])) ?? {}).sort()).toEqual(['cli.js', 'lazy-helper.js']);
    const scratch = await scratchKit(cli);
    try {
      expect(spawnSync(process.execPath, [path.join(scratch.kit, 'bin/cli.js'), 'help'], { encoding: 'utf-8' }).status).toBe(0);
      const result = runProbe(scratch);
      expect(result.status).toBe(REMOTE_KIT_BROKEN_EXIT);
      expect(remoteKitProbeFailureLine(result.stderr)).toMatch(/^SyntaxError: /);
    } finally {
      await fs.rm(scratch.home, { recursive: true, force: true });
    }
  });

  it.each([
    ['prints nothing', ''],
    ['prints a function name, not a path', 'node'],
    ['prints a path that is not an executable', '/nonexistent/bin/node'],
  ])('a login shell that %s: exit 18, naming node', async (_label, answer) => {
    const scratch = await scratchKit(await readRemoteCliModules(readBin), answer);
    try {
      const result = runProbe(scratch);
      expect(result.status).toBe(REMOTE_KIT_BROKEN_EXIT);
      expect(remoteKitProbeFailureLine(result.stderr)).toBe('node is not an executable on PATH in a login shell on this host');
    } finally {
      await fs.rm(scratch.home, { recursive: true, force: true });
    }
  });

  it('the failure line: Node\'s error line over a stack position, the first probe line otherwise, never another line of the script', () => {
    const stack = [
      'mkdir: noise from another step',
      'pmux-kit-probe: node:internal/modules/cjs/loader:1228',
      'pmux-kit-probe:   throw err;',
      'pmux-kit-probe: ',
      "pmux-kit-probe: Error: Cannot find module './x.js'",
      'pmux-kit-probe: Require stack:',
    ].join('\n');
    expect(remoteKitProbeFailureLine(stack)).toBe("Error: Cannot find module './x.js'");
    expect(remoteKitProbeFailureLine('pmux-kit-probe: \npmux-kit-probe: sh: 1: exec: node: Permission denied\n')).toBe('sh: 1: exec: node: Permission denied');
    expect(remoteKitProbeFailureLine('other: Error: not ours\n')).toBe('the kit\'s CLI exited with no output');
    expect(remoteKitProbeFailureLine(`pmux-kit-probe: TypeError: ${'y'.repeat(400)}`)).toHaveLength(300);
  });

  it('every create script carries the probe after the last kit file and before the pre-trust and the session; no CLI, no script', async () => {
    const cli = await readRemoteCliModules(readBin);
    const files = remoteKitFiles({ tmuxConf: '', cli, prompt: null, trustSeed: true });
    const trust = { cwd: '/w/a', workspaceDirectory: '/w' };
    const lines = buildRemoteCreateScript({ nonce: 'N0nce', files, session: 'pt-ws-a-pane-p-tab-r', cols: 80, rows: 24, launch: 'sh -l', trust }).split('\n');
    const lastPut = lines.map((l, i) => (l.startsWith('put ') ? i : -1)).filter((i) => i >= 0).at(-1)!;
    const probe = lines.findIndex((l) => l.startsWith('pmux_node=$('));
    const lastProbe = lines.findIndex((l) => l.startsWith('if ! pmux_probe=$('));
    expect(probe).toBe(lastPut + 1);
    expect(lines[lastProbe]).toContain('"$d/bin/cli.js" "$d/bin/curator-spot-check-event.js"');
    expect(lastProbe).toBeLessThan(lines.findIndex((l) => l.startsWith('if command -v python3')));
    expect(lastProbe).toBeLessThan(lines.findIndex((l) => l.includes("'new-session'")));
    expect(() => buildRemoteCreateScript({ nonce: 'N0nce', files: remoteKitFiles({ tmuxConf: '', cli: null, prompt: null }), session: 's', cols: 80, rows: 24, launch: 'sh -l' }))
      .toThrow("a remote create needs the kit's CLI: missing=[bin/cli.js, bin/purplemux]");
  });
});
