import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// `purplemux event` (ADR-0043) through the installed entry point against a stub server: what it
// sends, and how each refusal code exits.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-cli-event-'));

interface IRecorded { method: string; url: string; body: unknown }

let server: http.Server;
let port = 0;
let reply: (res: http.ServerResponse) => void = (res) => json(res, 200, { ok: true });
const requests: IRecorded[] = [];

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const cli = async (args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const child = run(process.execPath, [ENTRY, ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TOKEN: 'test-token' },
    });
    if (input !== undefined) {
      child.child.stdin?.end(input);
    } else {
      child.child.stdin?.end();
    }
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failure = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  requests.length = 0;
  reply = (res) => json(res, 200, { ok: true });
});

const PAYLOAD = { repo: '/w/repo', branch: 'b', head: 'a'.repeat(40), base: 'b'.repeat(40), attempt: 1, key: 'c'.repeat(40) };

describe('event send', () => {
  it('posts the type, the target and the parsed payload, from --json or a file', async () => {
    const result = await cli(['event', 'send', '--type', 'landed', '--to-epic', 'beta', '--json', JSON.stringify(PAYLOAD)]);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'POST', url: '/api/cli/worker-events', body: { type: 'landed', toEpic: 'beta', payload: PAYLOAD } }]);
    const file = path.join(home, 'payload.json');
    fs.writeFileSync(file, JSON.stringify(PAYLOAD));
    expect((await cli(['event', 'send', '--type', 'landed', '--to-epic', 'beta', '-f', file])).code).toBe(0);
    expect((await cli(['event', 'send', '--type', 'landed', '--to-epic', 'beta', '-f', '-'], JSON.stringify(PAYLOAD))).code).toBe(0);
    expect(requests.map((r) => (r.body as { payload: unknown }).payload)).toEqual([PAYLOAD, PAYLOAD, PAYLOAD]);
  });

  it.each([
    ['an unknown type', ['--type', 'merged', '--to-epic', 'beta', '--json', '{}'], '--type must be one of'],
    ['no target', ['--type', 'landed', '--json', '{}'], '--to-epic is required'],
    ['no payload', ['--type', 'landed', '--to-epic', 'beta'], 'exactly one of --json PAYLOAD or -f FILE'],
    ['two payloads', ['--type', 'landed', '--to-epic', 'beta', '--json', '{}', '-f', 'x'], 'exactly one of --json PAYLOAD or -f FILE'],
    ['a payload that is not JSON', ['--type', 'landed', '--to-epic', 'beta', '--json', '{nope'], 'the payload is not JSON'],
  ])('exits 2 for %s and sends nothing', async (_name, args, message) => {
    const result = await cli(['event', 'send', ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(requests).toEqual([]);
  });

  it.each([
    ['event-invalid', 400, 2],
    ['event-refused', 422, 3],
    ['event-out-of-scope', 403, 3],
    ['event-stale', 409, 3],
    ['event-no-recipient', 503, 5],
    ['event-check-unavailable', 409, 3],
  ])('maps %s (HTTP %i) to exit %i', async (code, status, exit) => {
    reply = (res) => json(res, status, { error: `refused: ${code}`, code });
    const result = await cli(['event', 'send', '--type', 'landed', '--to-epic', 'beta', '--json', JSON.stringify(PAYLOAD)]);
    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(code);
    expect(result.stderr).toContain(`refused: ${code}`);
  });
});

describe('event scope', () => {
  it('sets a scope with split dependencies and a numeric attempt', async () => {
    const result = await cli(['event', 'scope', 'set', '--tab', 'tab-w1', '--epic', 'alpha', '--story', 's-1', '--depends-on', 'beta, gamma,,', '--attempt', '2']);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'PUT', url: '/api/cli/worker-events/scope', body: { tabId: 'tab-w1', epic: 'alpha', story: 's-1', dependsOn: ['beta', 'gamma'], attempt: 2 } }]);
  });

  it('lists and clears', async () => {
    expect((await cli(['event', 'scope', 'list'])).code).toBe(0);
    expect((await cli(['event', 'scope', 'clear', '--tab', 'tab-w1'])).code).toBe(0);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['GET /api/cli/worker-events/scope', 'DELETE /api/cli/worker-events/scope?tabId=tab-w1']);
  });

  it.each([
    [['set', '--tab', 'tab-w1'], '--tab and --epic are required'],
    [['set', '--tab', 'tab-w1', '--epic', 'a', '--attempt', '0'], '--attempt must be a whole number'],
    [['clear'], '--tab is required'],
    [['nope'], 'usage: event send'],
  ])('exits 2 for scope %j', async (args, message) => {
    const result = await cli(['event', 'scope', ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(requests).toEqual([]);
  });

  it('maps a coordinator-only refusal to exit 3', async () => {
    reply = (res) => json(res, 403, { error: 'only the coordinator', code: 'forbidden' });
    expect((await cli(['event', 'scope', 'set', '--tab', 'tab-w1', '--epic', 'alpha'])).code).toBe(3);
  });
});
