import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ADR-0022: `tab create --host` sends the host; the remote codes map to exits (ADR-0016).

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRequest { method: string; url: string; body: unknown }

describe('purplemux tab create --host (ADR-0022)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let tokens: Array<string | undefined> = [];
  let reply: { status: number; body: unknown } = { status: 201, body: {} };
  let replies: Array<{ status: number; body: unknown }> = [];

  beforeEach(async () => {
    requests = [];
    replies = [];
    tokens = [];
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-host-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        tokens.push(req.headers['x-pmux-token'] as string | undefined);
        const r = replies.shift() ?? reply;
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
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

  it('sends the host with the create', async () => {
    reply = { status: 201, body: { tabId: 'tab-new', host: 'ai-server' } };
    const result = await cli(['tab', 'create', '-w', 'ws-a', '-n', 'w1', '--host', 'ai-server']);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'POST', url: '/api/cli/tabs', body: { workspaceId: 'ws-a', name: 'w1', host: 'ai-server' } }]);
    expect(JSON.parse(result.stdout)).toMatchObject({ host: 'ai-server' });
  });

  it('sends --host auto as given: the server places the tab (ADR-0039)', async () => {
    reply = { status: 201, body: { tabId: 'tab-new', host: 'ai-lan', placement: { host: 'ai-lan', local: false, reason: 'r', fallback: false } } };
    const result = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--host', 'auto']);
    expect(result.code).toBe(0);
    expect(requests[0].body).toEqual({ workspaceId: 'ws-a', panelType: 'claude-code', host: 'auto' });
    expect(JSON.parse(result.stdout)).toMatchObject({ placement: { host: 'ai-lan' } });
  });

  const queuedTab = (position: number) => ({
    status: 202,
    body: {
      code: 'pool-queued', queued: true, ticket: 'pool-queue:tab-3', kind: 'tab', class: 'product', position, of: 3, refusal: 'no-budget',
      reason: `queued: position ${position} of 3; mdserver1: budget threads 24/24 used, needs 2`, expiresAt: null, retryAfterSeconds: 0.05, envelope: { threads: 2, memGb: 4 },
    },
  });

  it('a queued --host auto start waits, re-asks with its ticket, prints a line only when the position changes, and creates when admitted (vel-D4)', async () => {
    replies = [queuedTab(2), queuedTab(2), queuedTab(1)];
    reply = { status: 201, body: { tabId: 'tab-new', host: 'ai-lan' } };
    const result = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--host', 'auto', '--class', 'harness']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ tabId: 'tab-new' });
    expect(requests.map((r) => (r.body as { queueTicket?: string }).queueTicket ?? null)).toEqual([null, 'pool-queue:tab-3', 'pool-queue:tab-3', 'pool-queue:tab-3']);
    expect(requests[0].body).toEqual({ workspaceId: 'ws-a', panelType: 'claude-code', host: 'auto', poolClass: 'harness' });
    expect(result.stderr.trim().split('\n')).toEqual([
      'queued: pool-queue:tab-3 position 2 of 3 — queued: position 2 of 3; mdserver1: budget threads 24/24 used, needs 2',
      'queued: pool-queue:tab-3 position 1 of 3 — queued: position 1 of 3; mdserver1: budget threads 24/24 used, needs 2',
    ]);
  });

  it('--wait 0 answers at once: exit 3 pool-queued with the ticket on stdout; --ticket resumes the place', async () => {
    reply = queuedTab(2);
    const result = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--host', 'auto', '--wait', '0']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ ticket: 'pool-queue:tab-3', position: 2 });
    expect(result.stderr).toContain('pool-queued');
    expect(result.stderr).toContain('re-run with --ticket TICKET');
    reply = { status: 201, body: { tabId: 'tab-new' } };
    await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--host', 'auto', '--ticket', 'pool-queue:tab-3']);
    expect(requests.at(-1)?.body).toMatchObject({ queueTicket: 'pool-queue:tab-3' });
  });

  it.each([
    [['--class', 'urgent', '--host', 'auto'], '--class must be'],
    [['--class', 'harness'], 'go with --host auto'],
    [['--ticket', 'pool-queue:tab-1', '--host', 'ai-server'], 'go with --host auto'],
    [['--host', 'auto', '--wait', 'soon'], '--wait must be whole seconds'],
  ])('%j is a usage error and sends nothing', async (extra, message) => {
    const result = await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', ...extra]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(requests).toEqual([]);
  });

  it('sends --cwd with the create', async () => {
    reply = { status: 201, body: { tabId: 'tab-new' } };
    await cli(['tab', 'create', '-w', 'ws-a', '-t', 'claude-code', '--host', 'ai-server', '--cwd', '/home/mdone/wt/x']);
    expect(requests[0].body).toEqual({ workspaceId: 'ws-a', panelType: 'claude-code', host: 'ai-server', cwd: '/home/mdone/wt/x' });
  });

  it('sends --role with the create; the server picks the type (ADR-0040)', async () => {
    reply = { status: 201, body: { tabId: 'tab-eval', panelType: 'claude-code', role: 'evaluator' } };
    const result = await cli(['tab', 'create', '-w', 'ws-a', '-n', 'eval', '--role', 'evaluator', '--preview-url', 'http://localhost:3100', '--pg-service', 'preview_42', '-m', 'claude-opus-5-5', '-r', 'xhigh']);
    expect(result.code).toBe(0);
    expect(requests[0].body).toEqual({ workspaceId: 'ws-a', name: 'eval', model: 'claude-opus-5-5', reasoning: 'xhigh', role: 'evaluator', previewUrl: 'http://localhost:3100', pgService: 'preview_42' });
  });

  it('a --role without a value is a usage error and sends nothing; a refused role exits 2', async () => {
    expect((await cli(['tab', 'create', '-w', 'ws-a', '--role'])).code).toBe(2);
    expect((await cli(['tab', 'create', '-w', 'ws-a', '--role', 'evaluator', '--preview-url'])).code).toBe(2);
    expect((await cli(['tab', 'create', '-w', 'ws-a', '--role', 'evaluator', '--preview-url', 'http://localhost:3100', '--pg-service'])).code).toBe(2);
    expect(requests).toEqual([]);
    reply = { status: 400, body: { error: 'role must be one of evaluator', code: 'invalid-request', role: 'x' } };
    const refused = await cli(['tab', 'create', '-w', 'ws-a', '--role', 'x']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('role must be one of evaluator');
  });

  it('a --host without a value is a usage error and sends nothing', async () => {
    const result = await cli(['tab', 'create', '-w', 'ws-a', '--host']);
    expect(result.code).toBe(2);
    expect(requests).toEqual([]);
  });

  it.each([
    [400, 'remote-host-invalid', 2],
    [400, 'remote-type-unsupported', 2],
    [503, 'remote-host-unreachable', 6],
    // Story 12: the kit's CLI does not run on the host; unmapped, so exit 1 (ADR-0016 item 10). Story 40 reads it.
    [502, 'remote-kit-broken', 1],
  ])('HTTP %i %s exits %i', async (status, code, exit) => {
    reply = { status, body: { error: 'refused', code } };
    const result = await cli(['tab', 'create', '-w', 'ws-a', '--host', 'ai-server']);
    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(code);
  });

  it('remote-kit-broken tells the caller a retry fails until the kit or the host is repaired', async () => {
    reply = { status: 502, body: { error: 'the CLI kit does not run on ai-server', code: 'remote-kit-broken', host: 'ai-server', line: "Error: Cannot find module './x.js'" } };
    const result = await cli(['tab', 'create', '-w', 'ws-a', '--host', 'ai-server']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('a retry fails the same way until a person repairs the kit or the host');
  });

  it('PMUX_URL sends every request to that server with the tab token, without a port file (ADR-0022)', async () => {
    reply = { status: 200, body: { tabs: [] } };
    try {
      const { stdout } = await run(process.execPath, [ENTRY, 'tab', 'list', '-w', 'ws-a'], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_URL: `http://127.0.0.1:${port}/`, PMUX_TAB_TOKEN: 'tab-secret' },
      });
      expect(JSON.parse(stdout)).toEqual({ tabs: [] });
    } catch (err) {
      throw new Error(String((err as { stderr?: string }).stderr));
    }
    expect(requests).toEqual([{ method: 'GET', url: '/api/cli/tabs?workspaceId=ws-a', body: null }]);
    expect(tokens).toEqual(['tab-secret']);
  });

  it('documents --host and --cwd in the usage text', async () => {
    const result = await cli(['help']);
    expect(result.stdout + result.stderr).toMatch(/--host HOST/);
    expect(result.stdout + result.stderr).toMatch(/--cwd DIR/);
    expect(result.stdout + result.stderr).toMatch(/PMUX_URL/);
  });
});
