import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandStubPath } from './command-stub-path';

// CI run 43560733268: a runner's /usr/bin held a dangling symlink and /bin was the same directory, so the old
// helper linked one name twice (EEXIST). The stub links only the commands it names, each once, from real files.
describe('commandStubPath', () => {
  let dir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-stub-path-'));
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('skips a dangling link and a directory listed twice, and links each named command once', () => {
    const broken = path.join(dir, 'broken');
    fs.mkdirSync(broken);
    fs.symlinkSync(path.join(dir, 'nowhere'), path.join(broken, 'cat'));
    process.env.PATH = [broken, savedPath, savedPath].join(path.delimiter);
    const stub = commandStubPath(path.join(dir, 'stub'), ['cat', 'sh']);

    expect(fs.readdirSync(stub).sort()).toEqual(['cat', 'sh']);
    expect(fs.existsSync(path.join(stub, 'cat'))).toBe(true);
    expect(fs.realpathSync(path.join(stub, 'cat'))).not.toContain('nowhere');
  });

  it('never names curl, and fails loudly on a command the host lacks', () => {
    expect(() => commandStubPath(path.join(dir, 'a'), ['sh', 'curl'])).toThrow(/cannot name curl/);
    expect(() => commandStubPath(path.join(dir, 'b'), ['no-such-command-x9'])).toThrow(/needs no-such-command-x9/);
  });
});
