import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Story 14: `tab steer` sends --interrupt --reason / --no-interrupt / --raw as the route reads them,
// refuses a bad flag set with exit 2 before any request, and `tab send` sends --raw (D30). The two
// new server codes exit 2 (ADR-0016). The help states the defaults.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRequest { method: string; url: string; body: unknown }

describe('purplemux tab steer / tab send flags (story 14)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: { status: 'steered', interrupted: false } };

  beforeEach(async () => {
    requests = [];
    reply = { status: 200, body: { status: 'steered', interrupted: false } };
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-steer-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const cli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TOKEN: 'ws-token' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
  };

  const STEER_URL = '/api/cli/tabs/tab-t/steer?workspaceId=ws-a';

  it('sends no interrupt field without a flag: the server decides the default', async () => {
    const result = await cli(['tab', 'steer', '-w', 'ws-a', 'tab-t', 'stop', 'editing']);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'POST', url: STEER_URL, body: { content: 'stop editing' } }]);
  });

  it('sends interrupt: false for --no-interrupt', async () => {
    await cli(['tab', 'steer', '-w', 'ws-a', 'tab-t', '--no-interrupt', 'queue', 'this']);
    expect(requests[0].body).toEqual({ content: 'queue this', interrupt: false });
  });

  it('sends interrupt: true and the reason for --interrupt --reason, and keeps the content words', async () => {
    reply = { status: 200, body: { status: 'steered', interrupted: true } };
    const result = await cli(['tab', 'steer', '-w', 'ws-a', 'tab-t', '--interrupt', '--reason', 'owner ruled it out', 'stop', 'now']);
    expect(result.code).toBe(0);
    expect(requests[0].body).toEqual({ content: 'stop now', interrupt: true, reason: 'owner ruled it out' });
  });

  it('sends raw: true for --raw on steer and on send', async () => {
    await cli(['tab', 'steer', '-w', 'ws-a', 'tab-t', '--raw', 'ls']);
    expect(requests[0].body).toEqual({ content: 'ls', raw: true });
    reply = { status: 200, body: { status: 'sent', submitted: true, cliState: null } };
    await cli(['tab', 'send', '-w', 'ws-a', 'tab-t', '--raw', '--no-wait', 'ls']);
    expect(requests[1]).toEqual({ method: 'POST', url: '/api/cli/tabs/tab-t/send?workspaceId=ws-a', body: { content: 'ls', waitMs: 0, raw: true } });
  });

  it('send without --raw sends no raw field', async () => {
    reply = { status: 200, body: { status: 'sent', submitted: true, cliState: null } };
    await cli(['tab', 'send', '-w', 'ws-a', 'tab-t', 'ls']);
    expect(requests[0].body).toEqual({ content: 'ls' });
  });

  it.each([
    ['--interrupt without --reason', ['--interrupt', 'stop'], '--interrupt needs --reason'],
    ['--reason without --interrupt', ['--reason', 'why', 'stop'], '--reason is read only with --interrupt'],
    ['--interrupt with --no-interrupt', ['--interrupt', '--no-interrupt', '--reason', 'why', 'stop'], 'mutually exclusive'],
    ['a blank --reason', ['--interrupt', '--reason', '  ', 'stop'], '--reason needs a text'],
    ['--reason as the last token', ['stop', '--interrupt', '--reason'], '--reason needs a text'],
  ])('exits 2 for %s and sends nothing', async (_label, flags, text) => {
    const result = await cli(['tab', 'steer', '-w', 'ws-a', 'tab-t', ...flags]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(text);
    expect(requests).toEqual([]);
  });

  it('exits 2 for the server codes steer-reason-invalid and terminal-not-command-line', async () => {
    reply = { status: 400, body: { error: 'interrupt: true needs a reason', code: 'steer-reason-invalid' } };
    const steer = await cli(['tab', 'steer', '-w', 'ws-a', 'tab-t', 'x']);
    expect(steer.code).toBe(2);
    expect(steer.stderr).toContain('steer-reason-invalid');
    reply = { status: 400, body: { error: 'tab tab-t is a terminal tab', code: 'terminal-not-command-line', tabId: 'tab-t', panelType: 'terminal', lines: 2 } };
    const send = await cli(['tab', 'send', '-w', 'ws-a', 'tab-t', '--no-wait', 'x']);
    expect(send.code).toBe(2);
    expect(send.stderr).toContain('terminal-not-command-line');
    expect(send.stderr).toContain('terminal tab');
  });

  it('help states the steer defaults and the terminal-tab rule', async () => {
    const result = await cli(['help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('From an agent tab (claude-code,');
    expect(result.stdout).toContain('the default does NOT interrupt');
    expect(result.stdout).toContain('--interrupt --reason TEXT stops the turn first');
    expect(result.stdout).toContain('From any other caller the default interrupts');
    expect(result.stdout).toContain('--no-interrupt is accepted from every caller');
    expect(result.stdout).toContain('(terminal-not-command-line)');
  });
});
