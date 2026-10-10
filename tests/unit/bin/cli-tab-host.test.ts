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
  let reply: { status: number; body: unknown } = { status: 201, body: {} };

  beforeEach(async () => {
    requests = [];
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-host-'));
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

  it('sends the host with the create', async () => {
    reply = { status: 201, body: { tabId: 'tab-new', host: 'ai-server' } };
    const result = await cli(['tab', 'create', '-w', 'ws-a', '-n', 'w1', '--host', 'ai-server']);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'POST', url: '/api/cli/tabs', body: { workspaceId: 'ws-a', name: 'w1', host: 'ai-server' } }]);
    expect(JSON.parse(result.stdout)).toMatchObject({ host: 'ai-server' });
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
  ])('HTTP %i %s exits %i', async (status, code, exit) => {
    reply = { status, body: { error: 'refused', code } };
    const result = await cli(['tab', 'create', '-w', 'ws-a', '--host', 'ai-server']);
    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(code);
  });

  it('documents --host in the usage text', async () => {
    const result = await cli(['help']);
    expect(result.stdout + result.stderr).toMatch(/--host HOST/);
  });
});
