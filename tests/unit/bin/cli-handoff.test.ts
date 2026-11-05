import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, serveLeaseRoutes, writeFixture } from '../api/leases-harness';

// `purplemux handoff check` (ADR-0036 §4, AC 6): the installed CLI against the real route and token checks, so the
// command and the rotation run one checker.

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

const handoff = (stamp: string, resume = '/v2-orchestrate') => [
  `# Handoff: orch · updated ${stamp}`, '',
  '## Role', '/v2-orchestrate', '',
  '## In flight', 'none', '',
  '## Open questions', 'none', '',
  '## Standing rules', '- Pin the identity on every gh write. (source: lane ledger ORCH-1027 2026-11-03T02:58:09Z)', '',
  '## Decisions in the last 24 h', '', '## Do not', '- nothing', '',
  '## Resume command', resume, '',
].join('\n');

interface IResult { code: number; stdout: string; stderr: string }
let cliHome: string;

const cli = async (args: string[], env: Record<string, string>): Promise<IResult> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: cliHome, NO_UPDATE_NOTIFIER: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const f = err as { code?: number; stdout?: string; stderr?: string };
    return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
  }
};

type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;

describe('purplemux handoff check (AC 6)', () => {
  let server: { port: number; close: () => Promise<void> } | null = null;
  let env: Record<string, string>;
  let route: THandler;
  let token: string;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-handoff-srv-'));
    cliHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-handoff-home-'));
    await writeFixture(mockHome.value, [{ id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orch' }] }]);
    route = (await import('@/pages/api/cli/handoff/check')).default as THandler;
    server = await serveLeaseRoutes({ '/api/cli/handoff/check': route });
    const { ensureTabToken } = await import('@/lib/tab-token');
    token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    env = { PMUX_PORT: String(server.port), PMUX_TAB_TOKEN: token };
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
    await fs.rm(cliHome, { recursive: true, force: true });
  });

  it('prints PASS and exits 0 for a file that passes', async () => {
    const file = path.join(cliHome, 'handoff.md');
    await fs.writeFile(file, handoff('2026-11-03T12:00:00Z'));
    const res = await cli(['handoff', 'check', file, '--now', '2026-11-03T12:01:00Z'], env);
    expect(res).toMatchObject({ code: 0, stdout: `handoff-check: PASS ${file}\n` });
  });

  it('prints one handoff-check line per refusal and exits 1; the rotate request is the stamp floor', async () => {
    const file = path.join(cliHome, 'handoff.md');
    await fs.writeFile(file, handoff('2026-11-03T11:00:00Z', ''));
    const res = await cli(['handoff', 'check', file, '--now', '2026-11-03T12:01:00Z', '--rotate-requested-at', '2026-11-03T11:55:00Z'], env);
    expect(res.code).toBe(1);
    expect(res.stdout.split('\n').filter(Boolean)).toEqual([
      'handoff-check: updated stamp 2026-11-03T11:00:00Z is older than the rotate request 2026-11-03T11:55:00Z (expected at or after it)',
      'handoff-check: ## Resume command has 0 non-empty lines (expected exactly 1)',
    ]);
    const json = await cli(['handoff', 'check', file, '--json', '--now', '2026-11-03T12:01:00Z'], env);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, seat: 'orch', resumeCommand: null, updatedAt: Date.UTC(2026, 10, 3, 11) });
  });

  it('refuses a missing or non-UTF-8 file with exit 1, as v2\'s checker did', async () => {
    const missing = path.join(cliHome, 'missing.md');
    const gone = await cli(['handoff', 'check', missing], env);
    expect(gone.code).toBe(1);
    expect(gone.stdout).toMatch(new RegExp(`^handoff-check: cannot read ${missing}: .*\\(expected a readable UTF-8 handoff file\\)\\n$`));
    const binary = path.join(cliHome, 'binary.md');
    await fs.writeFile(binary, Buffer.from([0xff, 0xfe]));
    const bad = await cli(['handoff', 'check', binary], env);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('(expected a readable UTF-8 handoff file)');
  });

  it('keeps a UTF-8 BOM and refuses the file, as v2\'s checker does (F6)', async () => {
    const file = path.join(cliHome, 'bom.md');
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(handoff('2026-11-03T12:00:00Z'))]));
    const res = await cli(['handoff', 'check', file, '--now', '2026-11-03T12:01:00Z'], env);
    expect(res.code).toBe(1);
    expect(res.stdout.split('\n')[0]).toBe('handoff-check: no title line: the first non-empty line is "\ufeff# Handoff: orch · updated 2026-11-03T12:00:00Z" (expected # Handoff: <seat> · updated <UTC ISO>)');
  });

  it('exits 2 on a usage error', async () => {
    for (const args of [['handoff'], ['handoff', 'lint', 'x'], ['handoff', 'check'], ['handoff', 'check', 'x', '--now']]) {
      expect((await cli(args, env)).code, args.join(' ')).toBe(2);
    }
    const res = await cli(['handoff', 'check', path.join(cliHome, 'x.md'), '--now', 'yesterday'], env);
    await fs.writeFile(path.join(cliHome, 'x.md'), handoff('2026-11-03T12:00:00Z'));
    const bad = await cli(['handoff', 'check', path.join(cliHome, 'x.md'), '--now', 'yesterday'], env);
    expect(res.code).toBe(1);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('now must be a UTC time');
  });

  it('the route refuses no scope, a wrong method and a body without text', async () => {
    expect((await callRoute(route, { method: 'POST', body: { text: 'x' } })).status).toBe(403);
    expect((await callRoute(route, { method: 'GET', headers: { 'x-pmux-token': token } })).status).toBe(405);
    expect((await callRoute(route, { method: 'POST', headers: { 'x-pmux-token': token }, body: {} })).body).toMatchObject({ code: 'invalid-request' });
    const ok = await callRoute(route, { method: 'POST', headers: { 'x-pmux-token': token }, body: { text: handoff('2026-11-03T12:00:00Z'), now: '2026-11-03T12:00:00Z' } });
    expect(ok).toMatchObject({ status: 200, body: { ok: true, reasons: [], resumeCommand: '/v2-orchestrate' } });
  });
});
