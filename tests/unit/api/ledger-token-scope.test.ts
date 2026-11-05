import fs from 'fs/promises';
import { readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetRouteGlobals, writeFixture } from './leases-harness';

// AC 4: a ledger:emit token is refused (401 or 403) by every CLI route except the events route, and
// by the proxy in front of every other API route. Every route file is enumerated, so a new route is
// covered the day it lands.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/tmux')>(),
  hasSession: vi.fn(async () => true),
  listSessions: vi.fn(async () => []),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const CLI_ROOT = path.resolve('src/pages/api/cli');
const EVENTS_ROUTE = 'workspaces/[workspaceId]/ledger/events.ts';
const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

const routeFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? routeFiles(full) : entry.name.endsWith('.ts') ? [path.relative(CLI_ROOT, full)] : [];
});

const call = async (handler: (req: NextApiRequest, res: NextApiResponse) => unknown, method: string, token: string): Promise<number> => {
  let status = 200;
  const res = {
    status(code: number) { status = code; return res; },
    json() { return res; },
    send() { return res; },
    end() { return res; },
    setHeader() { return res; },
    write() { return true; },
    once() { return res; },
    on() { return res; },
    writeHead(code: number) { status = code; return res; },
  } as unknown as NextApiResponse;
  const req = {
    method, url: '/api/cli', headers: { 'x-pmux-token': token }, socket: { remoteAddress: '127.0.0.1' },
    query: { workspaceId: 'ws-a', tabId: 'tab-a1', id: 'x', key: 'x' },
    // Shaped so a route that checks its body before the caller (the codex launch routes) reaches the caller check.
    body: { workspaceId: 'ws-a', tabId: 'tab-a1', sessionName: 'pt-ws-a-pane-1-tab-a1', generation: 'g', launcherPid: 100, childPid: 101 },
    on() { return req; },
  } as unknown as NextApiRequest;
  await Promise.race([handler(req, res), new Promise((resolve) => setTimeout(resolve, 2000))]);
  return status;
};

describe('a ledger:emit token outside its one route (AC 4)', () => {
  let token: string;

  beforeAll(async () => {
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ledger-scope-'));
    resetRouteGlobals();
    delete (globalThis as Record<string, unknown>).__ptLedgerTokens;
    await writeFixture(mockHome.value, [{ id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' }]);
    token = (await import('@/lib/ledger-token')).issueLedgerToken('ws-a', 'v2', Date.now()).token;
  });

  afterAll(async () => {
    delete (globalThis as Record<string, unknown>).__ptLedgerTokens;
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('is no CLI scope and not the global token', async () => {
    const { resolveCliScope } = await import('@/lib/workspace-token');
    const { verifyTokenValue } = await import('@/lib/cli-token');
    expect(resolveCliScope({ headers: { 'x-pmux-token': token } } as unknown as NextApiRequest)).toBeNull();
    expect(verifyTokenValue(token)).toBe(false);
  });

  it('gets 401 or 403 from every other CLI route, for every method it serves', async () => {
    const files = routeFiles(CLI_ROOT).filter((file) => file !== EVENTS_ROUTE);
    expect(files.length).toBeGreaterThan(50);
    const served: string[] = [];
    const wrong: string[] = [];
    for (const file of files) {
      const handler = (await import(path.join(CLI_ROOT, file))).default;
      for (const method of METHODS) {
        const status = await call(handler, method, token);
        if (status === 405) continue;
        served.push(`${method} ${file}`);
        if (status !== 401 && status !== 403) wrong.push(`${method} ${file} -> ${status}`);
      }
    }
    expect(`wrong=[${wrong.join(', ')}]`).toBe('wrong=[]');
    expect(served.length).toBeGreaterThanOrEqual(files.length);
  }, 60_000);

  it('is refused by the proxy in front of the cookie-authenticated API routes', async () => {
    const { proxy } = await import('@/proxy');
    for (const [method, url] of [['GET', '/api/layout'], ['POST', '/api/tabs/t1/send'], ['GET', '/api/mission-control/flow']]) {
      const response = await proxy(new NextRequest(`http://localhost${url}`, { method, headers: { 'x-pmux-token': token } }));
      expect(response.status, `${method} ${url}`).toBe(401);
    }
  });
});
