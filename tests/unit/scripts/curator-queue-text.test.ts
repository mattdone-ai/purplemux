import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Review r2 F3: the label pass's text goes to stdout only; the script leaves no file behind, anywhere it can write.

const run = promisify(execFile);
let home = '';

const tree = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .map((entry) => path.join(entry.parentPath, entry.name)).sort();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-queue-text-'));
  const ws = path.join(home, '.purplemux', 'workspaces', 'ws-a');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'message-history.json'), JSON.stringify({ entries: [{ id: 'm1', message: 'from now on use AEDT', sentAt: '2026-11-03T00:00:00Z' }] }));
  const evalDir = path.join(home, '.purplemux', 'curator', 'eval');
  fs.mkdirSync(evalDir, { recursive: true });
  fs.writeFileSync(path.join(evalDir, 'classify-owner-message.queue.json'), JSON.stringify({
    task: 'classify-owner-message', promptVersion: 'v', items: [{ id: 'ws-a/m1', predicted: 'standing-order', outcome: 'labelled', at: 1 }, { id: 'ws-a/gone', predicted: null, outcome: 'timeout', at: 1 }],
  }));
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('scripts/curator/queue-text.ts', { timeout: 60_000 }, () => {
  it('prints the readable queued texts as JSON, never a prediction, and writes no file', async () => {
    const before = tree(home);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-queue-text-tmp-'));
    try {
      const { stdout } = await run(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/curator/queue-text.ts', 'classify-owner-message'], {
        env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: scratch, NODE_ENV: 'test' },
      });
      expect(JSON.parse(stdout)).toEqual([{ id: 'ws-a/m1', text: 'from now on use AEDT' }]);
      expect(stdout).not.toContain('standing-order');
      // The logger opens its daily file on load; it is the only addition, and it holds none of the text.
      const added = tree(home).filter((f) => !before.includes(f));
      expect(added.every((f) => f.includes(`${path.sep}.purplemux${path.sep}logs`))).toBe(true);
      for (const f of added.filter((x) => fs.statSync(x).isFile())) expect(fs.readFileSync(f, 'utf-8')).not.toContain('use AEDT');
      expect(tree(scratch).filter((f) => !f.includes('tsx'))).toEqual([]);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
