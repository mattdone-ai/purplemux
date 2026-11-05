import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';
import { cliLocalRequires, readRemoteCliModules, remoteKitFiles } from '@/lib/remote-kit';

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
