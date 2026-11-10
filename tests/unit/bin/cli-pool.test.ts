import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ADR-0039: `purplemux pool` through the installed entry point, against a stub server.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);
const GIB = 1024 ** 3;

interface IRequest { method: string; url: string; body: unknown }

const VIEW = {
  at: '2026-11-03T07:00:00.000Z',
  hosts: [
    {
      host: 'host-a', local: true, state: 'known', readAt: '2026-11-03T07:00:00.000Z', via: null, reason: null, loadPerThread: 0.94, agentTabs: 6,
      metrics: { threads: 32, load1: 30, load5: 28, memTotalBytes: 91 * GIB, memAvailableBytes: 30 * GIB, disks: [{ path: '/', usedPct: 60, freeBytes: 1 }], gpus: null, sccacheSweep: null },
      slots: { gate: { used: 1, cap: 4, free: 3 }, build: { used: 0, cap: 4, free: 4 }, tab: { used: 6, cap: 11, free: 5 } },
    },
    {
      host: 'host-b-lan', local: false, state: 'unknown', readAt: null, via: null, reason: 'read failed (host-b-lan: timed out)', loadPerThread: null, agentTabs: 0, metrics: null,
      slots: { gate: { used: 2, cap: 0, free: 0 }, build: { used: 0, cap: 0, free: 0 }, tab: { used: 0, cap: 0, free: 0 } },
    },
  ],
  totals: { threads: 32, memTotalBytes: 91 * GIB, memAvailableBytes: 30 * GIB, knownHosts: 1, unknownHosts: 1, slots: { gate: { used: 1, cap: 4, free: 3 }, build: { used: 0, cap: 4, free: 4 }, tab: { used: 6, cap: 11, free: 5 } } },
};

describe('purplemux pool (ADR-0039)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let reply: { status: number; body: unknown; hang?: boolean } = { status: 200, body: {} };
  let replies: Array<{ status: number; body: unknown }> = [];

  beforeEach(async () => {
    requests = [];
    replies = [];
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-pool-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        const r = replies.shift() ?? reply;
        if ('hang' in r && r.hang) return;
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
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
    const started = Date.now();
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, 'pool', ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TAB_TOKEN: 'tab-token' },
      });
      return { code: 0, stdout, stderr, ms: Date.now() - started };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '', ms: Date.now() - started };
    }
  };

  it('acquire sends kind, memory in GiB, TTL in seconds and prints {host, slot, lease}', async () => {
    reply = { status: 200, body: { host: 'host-b-lan', local: false, slot: 'gate-1', lease: 'pool:host-b-lan/gate-1', expiresAt: null, reason: 'r', gateHost: 'gatehost-replica' } };
    const result = await cli(['acquire', '--kind', 'gate', '--mem', '8', '--ttl', '45m']);
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: 'POST', url: '/api/cli/pool/acquire', body: { kind: 'gate', memGb: 8, ttlSeconds: 2700 } }]);
    expect(JSON.parse(result.stdout)).toMatchObject({ host: 'host-b-lan', slot: 'gate-1', lease: 'pool:host-b-lan/gate-1' });
  });

  it('a tab acquire carries the panel type and role', async () => {
    reply = { status: 200, body: { host: 'host-a' } };
    await cli(['acquire', '--kind', 'tab', '--panel-type', 'codex-cli', '--role', 'evaluator']);
    expect(requests[0].body).toEqual({ kind: 'tab', panelType: 'codex-cli', role: 'evaluator' });
  });

  it('no answer in 2 s exits 6 pool-timeout and tells the caller to fall back to local', async () => {
    reply = { status: 200, body: {}, hang: true };
    const result = await cli(['acquire', '--kind', 'build']);
    expect(result.code).toBe(6);
    expect(result.stderr).toContain('pool-timeout');
    expect(result.stderr).toContain('do what you do without the pool and log it');
    expect(result.stderr).toContain('gate.no-local-fallback');
    expect(result.ms).toBeGreaterThanOrEqual(1900);
    expect(result.ms).toBeLessThan(6000);
  });

  it('no server exits 6', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await cli(['acquire', '--kind', 'gate']);
    expect(result.code).toBe(6);
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  it('pool-full exits 3 with the reason', async () => {
    reply = { status: 409, body: { code: 'pool-full', refusal: 'no-free-slot', error: 'every gate slot is in use (host-a 4/4, host-b-lan 8/8)' } };
    const result = await cli(['acquire', '--kind', 'gate']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('every gate slot is in use');
  });

  it('acquire --queue waits with its ticket until admitted (vel-D4); new kinds, threads and class are sent', async () => {
    const waiting = { queued: true, ticket: 'pool-queue:mutation-1', kind: 'mutation', class: 'harness', position: 1, of: 1, reason: 'queued: position 1 of 1; host-b-lan: harness holds threads 8/12', refusal: 'harness-share', expiresAt: null, retryAfterSeconds: 0.05, envelope: { threads: 8, memGb: 8 } };
    replies = [{ status: 202, body: waiting }];
    reply = { status: 200, body: { host: 'host-b-lan', lease: 'pool:host-b-lan/mutation-1' } };
    const result = await cli(['acquire', '--kind', 'mutation', '--threads', '8', '--class', 'harness', '--queue']);
    expect(result.code).toBe(0);
    expect(requests.map((r) => r.body)).toEqual([
      { kind: 'mutation', threads: 8, class: 'harness', queue: true },
      { kind: 'mutation', threads: 8, class: 'harness', queue: true, ticket: 'pool-queue:mutation-1' },
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ lease: 'pool:host-b-lan/mutation-1' });
    expect(result.stderr).toContain('queued: pool-queue:mutation-1 position 1 of 1');
  });

  it('acquire --queue --wait 0 exits 3 pool-queued with the ticket', async () => {
    reply = { status: 202, body: { queued: true, ticket: 'pool-queue:gate-2', position: 3, of: 4, reason: 'r', retryAfterSeconds: 10 } };
    const result = await cli(['acquire', '--kind', 'gate', '--queue', '--wait', '0']);
    expect(result.code).toBe(3);
    expect(JSON.parse(result.stdout)).toMatchObject({ ticket: 'pool-queue:gate-2' });
  });

  it('show prints each host\'s budget and the queue', async () => {
    const md = VIEW.hosts[0];
    const budget = {
      threads: 32, memBytes: 91 * GIB, reserveThreads: 8, reserveMemBytes: 14 * GIB, workerThreads: 24, workerMemBytes: 77 * GIB, maxLoad: 32, harnessSharePct: 25,
      used: { product: { threads: 20, memBytes: 40 * GIB }, harness: { threads: 2, memBytes: 4 * GIB }, 'control-plane': { threads: 4, memBytes: 8 * GIB } },
      free: { threads: 2, memBytes: 33 * GIB },
    };
    const queue = [{ ticket: 'pool-queue:tab-1', kind: 'tab', class: 'product', position: 1, envelope: { threads: 2, memGb: 4 }, hosts: ['host-a'], holder: 'ws-a/tab-o', queuedAt: '2026-11-03T06:59:00.000Z', expiresAt: null }];
    const wouldRefuse = { mode: 'shadow', total: 4, since: '2026-11-03T06:00:00.000Z', byHost: { 'host-a': { total: 4, byRefusal: { overloaded: 4 } } }, last: null };
    reply = { status: 200, body: { ...VIEW, hosts: [{ ...md, budget }], queue, wouldRefuse } };
    const text = (await cli(['show'])).stdout;
    expect(text).toContain(', 1 queued');
    expect(text).toContain('mode shadow: 4 admitted that enforce would refuse since 2026-11-03T06:00:00.000Z (host-a 4)');
    expect(text).toContain('    budget: workers 22/24 threads, 44.0/77.0 GiB (harness 2 threads, share 25%); control-plane reserve 4/8 threads, 8.0/14.0 GiB; max load 32');
    expect(text).toContain('  queued 1: pool-queue:tab-1 product 2 threads 4 GiB, hosts host-a, holder ws-a/tab-o, since 2026-11-03T06:59:00.000Z');
  });

  it.each([
    [['acquire'], '--kind must be gate, build, mutation, browser, test-service or tab'],
    [['acquire', '--kind', 'review'], '--kind must be gate, build, mutation, browser, test-service or tab'],
    [['acquire', '--kind', 'gate', '--threads', '0'], '--threads must be'],
    [['acquire', '--kind', 'gate', '--class', 'urgent'], '--class must be'],
    [['acquire', '--kind', 'gate', '--wait', '5'], '--wait goes with --queue or --ticket'],
    [['acquire', '--kind', 'gate', '--ticket'], '--ticket needs'],
    [['acquire', '--kind', 'gate', '--mem', 'lots'], '--mem must be a number'],
    [['acquire', '--kind', 'gate', '--ttl', 'none'], 'a pool slot must expire'],
    [['release'], 'release needs a LEASE'],
    [['acquire', '--kind', 'gate', '--ask', 'short'], '--ask must match'],
    [['acquire', '--kind', 'gate', '--ask', '0123456789ABCDEF0123456789ABCDEF'], '--ask must match'],
    [['acquire', '--kind', 'gate', '--pin-host', 'bad host'], '--pin-host must be'],
    [['acquire', '--kind', 'gate', '--pin-gate-host', '-x'], '--pin-gate-host must be'],
    [['acquire', '--kind', 'gate', '--pin-host'], '--pin-host needs a value'],
    [['release', '--ask', 'short'], '--ask must match'],
    [['nope'], 'usage: pool'],
  ])('%j is a usage error and sends nothing', async (args, message) => {
    const result = await cli(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
    expect(requests).toEqual([]);
  });

  it('release posts the lease', async () => {
    reply = { status: 200, body: { released: { name: 'pool:host-b-lan/gate-1' } } };
    expect((await cli(['release', 'pool:host-b-lan/gate-1'])).code).toBe(0);
    expect(requests).toEqual([{ method: 'POST', url: '/api/cli/pool/release', body: { lease: 'pool:host-b-lan/gate-1' } }]);
  });

  it('show prints "not placeable: <reason>" for a known host the pool will not place on (N2)', async () => {
    const md = VIEW.hosts[0];
    const fallbackOnly = {
      ...md, host: 'host-b-lan', local: false, via: 'host-b', placeable: false,
      reason: 'answers only through host-b; host-b-lan failed (host-b-lan: exit 255)',
    };
    reply = { status: 200, body: { ...VIEW, hosts: [{ ...md, placeable: true }, fallbackOnly] } };
    const lines = (await cli(['show'])).stdout.split('\n');
    expect(lines.find((l) => l.startsWith('  host-b-lan:'))).toMatch(/via host-b; not placeable: answers only through host-b; host-b-lan failed \(host-b-lan: exit 255\)$/);
    expect(lines.find((l) => l.startsWith('  host-a'))).not.toContain('not placeable');
  });

  it('show --json prints the model; show prints one line per host and an unknown host without figures', async () => {
    reply = { status: 200, body: VIEW };
    expect(JSON.parse((await cli(['show', '--json'])).stdout)).toEqual(VIEW);
    const text = (await cli(['show'])).stdout;
    expect(text).toContain('pool 1 known, 1 unknown: 32 threads, 30.0/91.0 GiB free, gate 1/4 build 0/4 tab 6/11');
    expect(text).toContain('host-a (this host): 32 threads, load 30/28 (0.94/thread), 30.0/91.0 GiB free, / 60%; gate 1/4 build 0/4 tab 6/11');
    expect(text).toContain('host-b-lan: unknown — read failed (host-b-lan: timed out); slots held gate 2 build 0 tab 0');
    expect(requests.every((r) => r.method === 'GET' && r.url === '/api/cli/pool')).toBe(true);
  });
  const T = '0123456789abcdef0123456789abcdef';

  it('acquire sends the ask token and the pin; no pin flag sends no pin (vel-POOL-ENF)', async () => {
    reply = { status: 200, body: { host: 'control-host', lease: 'pool:control-host/gate-1', ask: T, pin: { hosts: ['control-host'], local: true, gateHosts: ['hosta'] } } };
    expect((await cli(['acquire', '--kind', 'gate', '--ask', T, '--pin-host', 'Control-Host', '--pin-host', 'worker-host', '--pin-local', '--pin-gate-host', 'hosta', '--pin-gate-host', 'gate-host-b'])).code).toBe(0);
    await cli(['acquire', '--kind', 'gate', '--pin-local']);
    await cli(['acquire', '--kind', 'gate', '--ask', T]);
    expect(requests.map((r) => r.body)).toEqual([
      { kind: 'gate', ask: T, pin: { hosts: ['control-host', 'worker-host'], local: true, gateHosts: ['hosta', 'gate-host-b'] } },
      { kind: 'gate', pin: { hosts: [], local: true, gateHosts: [] } },
      { kind: 'gate', ask: T },
    ]);
  });

  it("release --ask alone cancels the token; release LEASE --ask releases only that ask's lease", async () => {
    reply = { status: 200, body: { released: [], cancelled: T } };
    expect((await cli(['release', '--ask', T])).code).toBe(0);
    reply = { status: 200, body: { released: { name: 'pool:worker-host/gate-1' } } };
    expect((await cli(['release', 'pool:worker-host/gate-1', '--ask', T])).code).toBe(0);
    expect(requests.map((r) => r.body)).toEqual([{ ask: T }, { lease: 'pool:worker-host/gate-1', ask: T }]);
  });

  it.each(['pool-no-pinned-host', 'pool-ask-cancelled', 'pool-ask-mismatch'])("%s exits 3 with the server's reason", async (code) => {
    reply = { status: 409, body: { code, error: `measured reason for ${code}` } };
    const result = await cli(['acquire', '--kind', 'gate', '--ask', T, '--pin-host', 'control-host']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(code);
    expect(result.stderr).toContain(`measured reason for ${code}`);
  });
});
