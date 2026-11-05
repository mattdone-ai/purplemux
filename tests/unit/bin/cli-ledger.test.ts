import { execFile } from 'child_process';
import { statSync } from 'fs';
import fs from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import Database from 'better-sqlite3';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// The installed CLI against the real ledger routes, token checks and store.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(async () => true),
  listSessions: vi.fn(async () => []),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);
const MIN = 60_000;

interface IResult { code: number; stdout: string; stderr: string }
let cliHome: string;

const cli = async (args: string[], env: Record<string, string>, input?: string): Promise<IResult> => {
  try {
    const child = run(process.execPath, [ENTRY, ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    child.child.stdin?.end(input ?? '');
    const { stdout, stderr } = await child;
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

const event = (id: string, at: number, overrides: Record<string, unknown> = {}) => ({
  event_id: id, at, item_type: 'range', item_key: 'range:a:0123456789ab', kind: 'wait', wait_reason: 'not-armed', holder: 'lane-a',
  ...overrides,
});

const freePort = async (): Promise<number> => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

describe('purplemux ledger — the installed CLI against the real routes', () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let orchA: Record<string, string>;
  let tokenFile: string;
  const spoolFile = () => path.join(cliHome, '.purplemux', 'ledger-spool', 'v2.jsonl');
  const storedEventIds = (): string[] => {
    const db = new Database(path.join(mockHome.value, '.purplemux', 'ledger.sqlite'), { readonly: true });
    try {
      return (db.prepare('SELECT event_id FROM events ORDER BY seq').all() as Array<{ event_id: string }>).map((row) => row.event_id);
    } finally {
      db.close();
    }
  };

  const serve = async () => {
    type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;
    const base = '@/pages/api/cli/workspaces/[workspaceId]/ledger';
    const handlers: Record<string, THandler> = {
      events: (await import(`${base}/events`)).default,
      items: (await import(`${base}/items`)).default,
      waits: (await import(`${base}/waits`)).default,
      experiments: (await import(`${base}/experiments/index`)).default,
      experiment: (await import(`${base}/experiments/[id]`)).default,
      extend: (await import(`${base}/experiments/[id]/extend`)).default,
      tokens: (await import(`${base}/tokens`)).default,
    };
    const route = (handler: THandler, query: Record<string, string>): THandler => (req, res) => {
      req.query = { ...req.query, ...query };
      return handler(req, res);
    };
    const routes: Record<string, THandler> = {};
    for (const ws of ['ws-a', 'ws-b']) {
      const at = `/api/cli/workspaces/${ws}/ledger`;
      routes[`${at}/events`] = route(handlers.events, { workspaceId: ws });
      routes[`${at}/items`] = route(handlers.items, { workspaceId: ws });
      routes[`${at}/waits`] = route(handlers.waits, { workspaceId: ws });
      routes[`${at}/experiments`] = route(handlers.experiments, { workspaceId: ws });
      routes[`${at}/experiments/EXP-1`] = route(handlers.experiment, { workspaceId: ws, id: 'EXP-1' });
      routes[`${at}/experiments/EXP-1/extend`] = route(handlers.extend, { workspaceId: ws, id: 'EXP-1' });
      routes[`${at}/tokens`] = route(handlers.tokens, { workspaceId: ws });
    }
    server = await serveLeaseRoutes(routes);
    return server.port;
  };

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-ledger-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-ledger-home-'));
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    delete (globalThis as Record<string, unknown>).__ptLedgerTokens;
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b1', name: 'orchestrator b' }], orchestratorTabId: 'tab-b1' },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    const port = await serve();
    orchA = { PMUX_PORT: String(port), PMUX_TAB_TOKEN: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1') };
    tokenFile = path.join(cliHome, 'v2.token.json');
    const issued = await cli(['ledger', 'token', 'issue', '-w', 'ws-a', '--producer', 'v2', '--out', tokenFile], orchA);
    expect(issued.code, issued.stderr).toBe(0);
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    (await import('@/lib/ledger-store')).resetLedgerStoreForTests();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('token issue writes a 0600 file with the single scope ledger:emit on one workspace', async () => {
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(tokenFile, 'utf-8'))).toMatchObject({ scope: 'ledger:emit', workspaceId: 'ws-a', producer: 'v2' });
    const defaulted = await cli(['ledger', 'token', 'issue', '-w', 'ws-a', '--producer', 'feed'], orchA);
    expect(defaulted.stdout).toContain(path.join(cliHome, '.purplemux', 'ledger-tokens', 'ws-a', 'feed.json'));
    const foreign = await cli(['ledger', 'token', 'issue', '-w', 'ws-b', '--producer', 'v2', '--out', path.join(cliHome, 'b.json')], orchA);
    expect(foreign.code).toBe(3);
    expect(foreign.stderr).toContain('forbidden');
    expect((await cli(['ledger', 'token', 'issue', '-w', 'ws-a', '--producer', '../x'], orchA)).code).toBe(2);
  });

  it('emit spools with the server stopped and exits 0; the next emit drains the spool first, in order (AC 5)', async () => {
    const now = Date.now();
    const down = { PMUX_PORT: String(await freePort()) };
    const first = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile, '--json', '@-'], down,
      JSON.stringify([event('s1', now - 30 * MIN), event('s2', now - 20 * MIN, { kind: 'clear', wait_reason: null })]));
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/spooled 2 events to .*ledger-spool\/v2\.jsonl \(ECONNREFUSED\)/);
    const second = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], down,
      JSON.stringify(event('s3', now - 15 * MIN, { wait_reason: 'review-queue' })));
    expect(second.code).toBe(0);
    expect((await fs.readFile(spoolFile(), 'utf-8')).trim().split('\n').map((line) => JSON.parse(line).event_id)).toEqual(['s1', 's2', 's3']);
    expect(statSync(spoolFile()).mode & 0o777).toBe(0o600);

    const up = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA,
      `${JSON.stringify(event('n1', now - 5 * MIN, { kind: 'clear', wait_reason: null }))}\n`);
    expect(up.code, up.stderr).toBe(0);
    expect(up.stdout).toBe('ok accepted=4 duplicates=0 drained=3\n');
    expect(storedEventIds()).toEqual(['s1', 's2', 's3', 'n1']);
    await expect(fs.access(spoolFile())).rejects.toThrow();
    const replay = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA,
      JSON.stringify(event('n1', now - 5 * MIN, { kind: 'clear', wait_reason: null })));
    expect(replay.stdout).toBe('ok accepted=0 duplicates=1 drained=0\n');
    const reused = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA, JSON.stringify(event('n1', now - 5 * MIN)));
    expect(reused.code).toBe(3);
    expect(reused.stderr).toContain('ledger-event-conflict');
    expect(reused.stdout).toBe('ok accepted=0 duplicates=0 drained=0 rejected=1\n');
  });

  it('emit spools when the server gives no answer in 5 s', async () => {
    const silent = http.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      const started = Date.now();
      const hung = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], { PMUX_PORT: String((silent.address() as AddressInfo).port) },
        JSON.stringify(event('t1', Date.now())));
      expect(hung.code).toBe(0);
      expect(hung.stderr).toContain('spooled 1 events');
      expect(hung.stderr).toContain('no answer in 5000 ms');
      expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    } finally {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 20_000);

  const rejectedFile = () => path.join(path.dirname(spoolFile()), 'v2.rejected.jsonl');
  const writeSpool = async (text: string) => {
    await fs.mkdir(path.dirname(spoolFile()), { recursive: true });
    await fs.writeFile(spoolFile(), text);
  };

  it('a refused new event is set aside alone: the rest is delivered, the event kept in rejected.jsonl, exit 2', async () => {
    const now = Date.now();
    const refused = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA,
      JSON.stringify([event('g1', now), event('r1', now, { wait_reason: 'lunch' }), event('g2', now, { kind: 'clear', wait_reason: null })]));
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe('ok accepted=2 duplicates=0 drained=0 rejected=1\n');
    expect(refused.stderr).toContain('ledger-reason-invalid');
    expect(refused.stderr).toContain('events[1].wait_reason: saw "lunch", expected one of review-queue');
    expect(storedEventIds()).toEqual(['g1', 'g2']);
    expect((await fs.readFile(rejectedFile(), 'utf-8')).trim().split('\n').map((line) => JSON.parse(line).event_id)).toEqual(['r1']);
    await expect(fs.access(spoolFile())).rejects.toThrow();
  });

  it('one refused event in a spooled batch moves alone to rejected.jsonl; the rest drains in order', async () => {
    const now = Date.now();
    await writeSpool([event('s1', now - 3000), event('sbad', now - 2000, { kind: 'nap' }), event('s2', now - 1000, { kind: 'clear', wait_reason: null })]
      .map((e) => `${JSON.stringify(e)}\n`).join(''));
    const drained = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA, JSON.stringify(event('n1', now, { wait_reason: 'owner' })));
    expect(drained.code, drained.stderr).toBe(0);
    expect(drained.stdout).toBe('ok accepted=3 duplicates=0 drained=2 rejected=1\n');
    expect(storedEventIds()).toEqual(['s1', 's2', 'n1']);
    expect((await fs.readFile(rejectedFile(), 'utf-8')).trim().split('\n').map((line) => JSON.parse(line).event_id)).toEqual(['sbad']);
    await expect(fs.access(spoolFile())).rejects.toThrow();
  });

  it('a corrupt line inside the spool stops the drain and names the line; a torn last line is dropped', async () => {
    const now = Date.now();
    await writeSpool(`${JSON.stringify(event('s1', now))}\nnot json\n${JSON.stringify(event('s2', now))}\n`);
    const stopped = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA, JSON.stringify(event('n1', now)));
    expect(stopped.code).toBe(0);
    expect(stopped.stderr).toContain('line 2 is not JSON; nothing was drained and 1 events were appended');
    expect((await fs.readFile(spoolFile(), 'utf-8')).trim().split('\n')).toHaveLength(4);
    await expect(fs.access(path.join(mockHome.value, '.purplemux', 'ledger.sqlite'))).rejects.toThrow();

    await writeSpool(`${JSON.stringify(event('t1', now))}\n{"event_id":"tor`);
    const torn = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA, JSON.stringify(event('t2', now, { kind: 'clear', wait_reason: null })));
    expect(torn.code, torn.stderr).toBe(0);
    expect(torn.stdout).toBe('ok accepted=2 duplicates=0 drained=1\n');
    expect(storedEventIds()).toEqual(['t1', 't2']);
    await expect(fs.access(spoolFile())).rejects.toThrow();
  });

  it('an emit during a slow drain appends under the file lock and loses nothing', async () => {
    const now = Date.now();
    const { default: events } = await import('@/pages/api/cli/workspaces/[workspaceId]/ledger/events');
    const slow = await serveLeaseRoutes({
      '/api/cli/workspaces/ws-a/ledger/events': async (req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 4000));
        req.query = { ...req.query, workspaceId: 'ws-a' };
        return events(req, res);
      },
    });
    try {
      await writeSpool(`${JSON.stringify(event('s1', now - 4000))}\n`);
      const slowEnv = { PMUX_PORT: String(slow.port) };
      const draining = cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], slowEnv,
        JSON.stringify(event('a1', now - 3000, { kind: 'clear', wait_reason: null })));
      await new Promise((resolve) => setTimeout(resolve, 500));
      const during = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], slowEnv,
        JSON.stringify(event('b1', now - 2000, { wait_reason: 'owner' })));
      expect(during.code).toBe(0);
      expect(during.stderr).toContain('another emit of v2 is draining');
      const first = await draining;
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout).toBe('ok accepted=2 duplicates=0 drained=1\n');
      expect((await fs.readFile(spoolFile(), 'utf-8')).trim().split('\n').map((line) => JSON.parse(line).event_id)).toEqual(['b1']);
    } finally {
      await slow.close();
    }
    const last = await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA,
      JSON.stringify(event('c1', now - 1000, { kind: 'clear', wait_reason: null })));
    expect(last.stdout).toBe('ok accepted=2 duplicates=0 drained=1\n');
    expect(storedEventIds()).toEqual(['s1', 'a1', 'b1', 'c1']);
  }, 20_000);

  it('emit refuses a token file for another workspace before it sends', async () => {
    const wrong = await cli(['ledger', 'emit', '-w', 'ws-b', '--token-file', tokenFile], orchA, JSON.stringify(event('x', Date.now())));
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain('--token-file emits for ws-a, not ws-b');
  });

  it('show, waits and experiments read and write through the routes (AC 9)', async () => {
    const now = Date.now();
    await cli(['ledger', 'emit', '-w', 'ws-a', '--token-file', tokenFile], orchA, JSON.stringify([
      event('e0', now - 40 * MIN, { kind: 'open', wait_reason: null }),
      event('e1', now - 40 * MIN), event('e2', now - 10 * MIN, { kind: 'clear', wait_reason: null }),
      event('e3o', now - 5 * MIN, { item_type: 'gate', item_key: 'gate:t:1', kind: 'open', wait_reason: null, holder: 'host-1' }),
      event('e3', now - 5 * MIN, { item_type: 'gate', item_key: 'gate:t:1', wait_reason: 'gate-slot', holder: 'host-1' }),
    ]));
    const show = await cli(['ledger', 'show', '-w', 'ws-a', '--open'], orchA);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toMatch(/^ledger ws-a: 2 items\nITEM\s+TYPE\s+STATE\s+WAITING ON\s+FOR\s+HOLDER\s+CLOSED\n/);
    expect(show.stdout).toMatch(/gate:t:1\s+gate\s+—\s+gate-slot\s+5m\s+host-1\s+—/);
    const json = JSON.parse((await cli(['ledger', 'show', '-w', 'ws-a', '--type', 'gate', '--json'], orchA)).stdout);
    expect(json.items.map((item: { itemKey: string }) => item.itemKey)).toEqual(['gate:t:1']);
    const waits = await cli(['ledger', 'waits', '-w', 'ws-a', '--since', String(now - 60 * MIN)], orchA);
    expect(waits.code, waits.stderr).toBe(0);
    expect(waits.stdout).toMatch(/not-armed\s+30m\s+1\s+30m\s+30m\s+0\s+0m/);
    expect(waits.stdout).toMatch(/total\s+30m\s+1/);
    expect((await cli(['ledger', 'waits', '-w', 'ws-a', '--by', 'colour'], orchA)).code).toBe(2);

    const spec = path.join(cliHome, 'exp.json');
    await fs.writeFile(spec, JSON.stringify({ hypothesis: 'one gate outside the lock', stage: 'land', metric: 'lock-hours', min_days: 3, max_days: 7 }));
    const opened = await cli(['ledger', 'experiment', 'open', '-w', 'ws-a', '--json', `@${spec}`], orchA);
    expect(opened.stdout).toBe('opened EXP-1 (stage land, metric lock-hours)\n');
    expect((await cli(['ledger', 'experiment', 'open', '-w', 'ws-a', '--json', `@${spec}`], orchA)).code).toBe(3);
    expect((await cli(['ledger', 'experiment', 'list', '-w', 'ws-a'], orchA)).stdout).toMatch(/EXP-1\s+land\s+lock-hours\s+\S+\s+active\s+one gate/);
    const extend = ['ledger', 'experiment', 'extend', '-w', 'ws-a', 'EXP-1', '--days', '3', '--evidence', 'still noisy'];
    const extended = await cli(extend, orchA);
    expect(extended.stdout, extended.stderr).toBe('extended EXP-1 by 3 days: ends by day 10\n');
    expect((await cli(['ledger', 'experiment', 'list', '-w', 'ws-a'], orchA)).stdout).toMatch(/EXP-1\s+land\s+lock-hours\s+\S+\s+active, extended \+3d\s+one gate/);
    const twice = await cli(extend, orchA);
    expect(twice.code).toBe(3);
    expect(twice.stderr).toMatch(/extended once already/);
    expect((await cli(['ledger', 'experiment', 'extend', '-w', 'ws-a', 'EXP-1', '--days', 'x', '--evidence', 'e'], orchA)).code).toBe(2);
    expect((await cli(['ledger', 'experiment', 'extend', '-w', 'ws-a', 'EXP-1', '--days', '3'], orchA)).code).toBe(2);
    const closed = await cli(['ledger', 'experiment', 'close', '-w', 'ws-a', 'EXP-1', '--verdict', 'keep', '--evidence', 'lock hours fell'], orchA);
    expect(closed.stdout).toBe('closed EXP-1: keep\n');
    const list = JSON.parse((await cli(['ledger', 'experiments', '-w', 'ws-a', '--json'], orchA)).stdout);
    expect(list.experiments).toEqual([expect.objectContaining({ id: 'EXP-1', verdict: 'keep', evidence: 'lock hours fell' })]);
  });
});
