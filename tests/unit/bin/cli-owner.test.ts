import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Story 36 (D8): `purplemux owner messages -w WS [--since ISO] [--json]` through the installed entry point.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

const LIST = {
  workspaceId: 'ws-a', since: null, messages: [
    { id: '9EEpM5DSm02jNyl09boys', sentAt: '2026-11-04T01:28:58.000Z', tabId: 'tab-o', message: 'ok done\nand ship it', withheld: false },
    { id: 'W4KCp7NrTHpPkNnjgEaG1', sentAt: '2026-11-04T01:40:00.000Z', tabId: null, message: 'from the phone', withheld: false },
    { id: 'k3', sentAt: '2026-11-04T01:50:00.000Z', tabId: 'tab-o', message: null, withheld: true },
  ],
};

describe('purplemux owner messages (story 36, D8)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let urls: string[] = [];
  let answer: unknown = LIST;

  beforeEach(async () => {
    urls = [];
    answer = LIST;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-owner-'));
    server = http.createServer((req, res) => {
      urls.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const cli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, 'owner', ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TAB_TOKEN: 'tab-token' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
  };

  it('prints each prompt: id, time and tab, then its text indented; no tab is a dash; a withheld one says so', async () => {
    const result = await cli(['messages', '-w', 'ws-a']);
    expect(result.code).toBe(0);
    expect(urls).toEqual(['/api/cli/owner/messages?workspaceId=ws-a']);
    expect(result.stdout).toBe([
      '9EEpM5DSm02jNyl09boys  2026-11-04T01:28:58.000Z  tab-o',
      '  ok done',
      '  and ship it',
      'W4KCp7NrTHpPkNnjgEaG1  2026-11-04T01:40:00.000Z  —',
      '  from the phone',
      'k3  2026-11-04T01:50:00.000Z  tab-o',
      '  (withheld: it looks like it holds a credential; read it in the owner\'s own history)',
      '',
    ].join('\n'));
  });

  it('--since passes the time; --json prints the body; an empty list says so', async () => {
    await cli(['messages', '-w', 'ws-a', '--since', '2026-11-04T01:30:00Z']);
    expect(urls.at(-1)).toBe('/api/cli/owner/messages?workspaceId=ws-a&since=2026-11-04T01%3A30%3A00Z');
    expect(JSON.parse((await cli(['messages', '-w', 'ws-a', '--json'])).stdout)).toEqual(LIST);
    answer = { workspaceId: 'ws-a', since: '2026-11-04T01:30:00.000Z', messages: [] };
    expect((await cli(['messages', '-w', 'ws-a', '--since', '2026-11-04T01:30:00Z'])).stdout).toBe('no owner messages in ws-a since 2026-11-04T01:30:00.000Z\n');
  });

  it('refuses a bad --since or a missing subcommand with exit 2, before any request', async () => {
    expect((await cli(['messages', '-w', 'ws-a', '--since', 'yesterday'])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
    expect(urls).toEqual([]);
  });
});
