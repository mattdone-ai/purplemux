import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';
import type { ILayoutData, ITab, TPanelType } from '@/types/terminal';

// ADR-0027: the WIP cap on agent tab creation. The real layout store and its
// lock, the real fleet-config and audit stores, in a scratch HOME.

const mockHome = vi.hoisted(() => ({ value: '' }));
const tmux = vi.hoisted(() => ({ createSession: vi.fn(async (..._args: unknown[]) => {}) }));
const launch = vi.hoisted(() => ({ codex: vi.fn() }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  createSession: tmux.createSession,
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  sendKeys: vi.fn(async () => {}),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ registerTab: vi.fn(), markAgentLaunch: vi.fn(), getAllForClient: () => ({}) }),
}));
vi.mock('@/lib/agent-availability', () => ({ checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })), toAgentAvailabilityError: vi.fn() }));
vi.mock('@/lib/agent-dispatch-policy', () => ({ checkAgentDispatchPolicy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/human-mutation', () => ({ authorizeHumanMutation: vi.fn(async () => true) }));
vi.mock('@/lib/agent-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-launch')>()),
  buildFreshLaunchCommand: vi.fn(async () => undefined),
  launchCodexManaged: launch.codex,
}));

type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;

const base = () => path.join(mockHome.value, '.purplemux');
const layoutFile = (ws: string) => path.join(base(), 'workspaces', ws, 'layout.json');

const fixtureTab = (id: string, panelType: TPanelType | undefined, over: Partial<ITab> = {}): ITab => ({
  id, name: id, order: 0, sessionName: `pt-ws-a-pane-1-${id}`, ...(panelType ? { panelType } : {}), ...over,
});

/** ws-a: the orchestrator tab-o and worker tab-w (both claude-code), then `extra`, split over two panes. */
const writeLayout = async (extra: ITab[]) => {
  const tabs = [fixtureTab('tab-o', 'claude-code'), fixtureTab('tab-w', 'claude-code'), ...extra];
  const half = Math.ceil(tabs.length / 2);
  const layout: ILayoutData = {
    root: {
      type: 'split', orientation: 'horizontal', ratio: 50,
      children: [
        { type: 'pane', id: 'pane-1', activeTabId: 'tab-o', tabs: tabs.slice(0, half) },
        { type: 'pane', id: 'pane-2', activeTabId: null, tabs: tabs.slice(half) },
      ],
    },
    activePaneId: 'pane-1',
    updatedAt: '2026-10-26T00:00:00.000Z',
  } as ILayoutData;
  await fs.writeFile(layoutFile('ws-a'), JSON.stringify(layout));
};

const agents = (n: number, over: Partial<ITab> = {}) =>
  Array.from({ length: n }, (_, i) => fixtureTab(`tab-x${i}`, (['claude-code', 'codex-cli', 'grok-cli'] as const)[i % 3], over));

const readTabs = async (): Promise<ITab[]> => {
  const { collectAllTabs } = await import('@/lib/layout-tree');
  return collectAllTabs((JSON.parse(await fs.readFile(layoutFile('ws-a'), 'utf-8')) as ILayoutData).root);
};

const setCap = async (value: string | null) => {
  const file = path.join(base(), 'fleet-config.json');
  if (value === null) return fs.rm(file, { force: true });
  await fs.writeFile(file, JSON.stringify({
    values: { 'tabs.cap-per-workspace': { value, version: 1, setAt: 1, setBy: { workspaceId: null, tabId: null, admin: true } } },
    versions: { 'tabs.cap-per-workspace': 1 },
    history: [],
  }));
};

const auditLines = async (): Promise<Array<Record<string, unknown>>> => {
  await drainRouteLocks();
  const raw = await fs.readFile(path.join(base(), 'audit', 'coordination.jsonl'), 'utf-8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

// The first load of this module graph costs about 1 s alone and passed the 5 s test budget on a loaded gate
// (story hfl2-53). Load it once here, at collection, outside every test's budget. vi.resetModules() discards
// this instance; each test's own import evaluates again from the transform cache in milliseconds.
await Promise.all([
  import('@/lib/tab-token'),
  import('@/lib/cli-token'),
  import('@/lib/layout-tree'),
  import('@/pages/api/cli/tabs'),
  import('@/pages/api/cli/workspaces/[workspaceId]/tab-count'),
  import('@/pages/api/layout/pane/[paneId]/tabs/index'),
]);

describe('POST /api/cli/tabs: the WIP cap (ADR-0027)', () => {
  let create: THandler;
  let tabCount: THandler;
  let humanCreate: THandler;
  let tokens: Record<'orch' | 'worker' | 'other' | 'hookOrch' | 'admin', string>;

  const post = (token: string, body: Record<string, unknown>) =>
    callRoute(create, { method: 'POST', headers: { 'x-pmux-token': token }, body: { workspaceId: 'ws-a', ...body } });

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    tmux.createSession.mockClear();
    const g = globalThis as Record<string, unknown>;
    delete g.__ptTabCapLogged;
    delete g.__ptFleetConfigLock;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-wip-cap-'));
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-o', name: 'orchestrator' }], orchestratorTabId: 'tab-o' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b', name: 'b' }], orchestratorTabId: 'tab-b' },
      { id: 'ws-h', name: 'hook', tabs: [{ id: 'tab-h', name: 'h' }], orchestratorTabId: 'tab-h' },
    ]);
    await writeLayout([]);
    const { ensureTabToken, mintHookTabToken } = await import('@/lib/tab-token');
    const { getCliToken } = await import('@/lib/cli-token');
    const hook = await mintHookTabToken({ workspaceId: 'ws-h', tabId: 'tab-h' }, 'pt-ws-h-pane-1-tab-h');
    if (!hook.ok) throw new Error(hook.reason);
    tokens = {
      orch: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-o' }, 'pt-ws-a-pane-1-tab-o'),
      worker: await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-w' }, 'pt-ws-a-pane-1-tab-w'),
      other: await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b' }, 'pt-ws-b-pane-1-tab-b'),
      hookOrch: hook.token,
      admin: getCliToken(),
    };
    create = (await import('@/pages/api/cli/tabs')).default;
    const countRoute = (await import('@/pages/api/cli/workspaces/[workspaceId]/tab-count')).default;
    tabCount = (req, res) => countRoute(Object.assign(req, { query: { workspaceId: req.query.workspaceId ?? 'ws-a' } }), res);
    humanCreate = (await import('@/pages/api/layout/pane/[paneId]/tabs/index')).default;
  });

  afterEach(async () => {
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('below the cap an agent create answers 201 with the count after the add', async () => {
    await writeLayout(agents(5));
    const r = await post(tokens.worker, { panelType: 'claude-code', launch: false });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.wip).toEqual({ count: 8, cap: 8, overCap: false });
    expect((await readTabs()).length).toBe(8);
  });

  it.each(['claude-code', 'codex-cli', 'grok-cli'])('refuses a %s create at the cap with 409 wip-cap; no tab and no session', async (panelType) => {
    await writeLayout(agents(6));
    const r = await post(tokens.worker, { panelType, launch: false });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ code: 'wip-cap', error: 'ws-a holds 8 of 8 agent tabs', workspaceId: 'ws-a', count: 8, cap: 8, capSource: 'default' });
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect((await readTabs()).length).toBe(8);
  });

  it('counts remote agent tabs and agent tabs in every pane; terminal, web-browser, diff and agent-sessions do not count', async () => {
    await writeLayout([
      ...agents(5), fixtureTab('tab-remote', 'claude-code', { host: 'host-b' }),
      fixtureTab('t1', 'terminal'), fixtureTab('t2', 'web-browser'), fixtureTab('t3', 'diff'),
      fixtureTab('t4', 'agent-sessions'), fixtureTab('t5', undefined),
    ]);
    const refused = await post(tokens.worker, { panelType: 'claude-code', launch: false });
    expect(refused.body).toMatchObject({ code: 'wip-cap', count: 8 });
    const terminal = await post(tokens.worker, { panelType: 'terminal' });
    expect(terminal.status).toBe(201);
    expect(terminal.body).not.toHaveProperty('wip');
  });

  it.each([
    [500, { ok: false, step: 'prepare', reason: 'no shell' }, { error: 'Failed to prepare Codex launch', launchState: 'held' }],
    [500, { ok: false, step: 'submit', reason: 'paste refused', generation: 'g-1', phase: 'held' }, { error: 'Failed to submit Codex launch', launchState: 'held' }],
    [503, { ok: false, step: 'activate', reason: 'no session-start', generation: 'g-1', phase: 'submitted' }, { error: 'Codex launch was not confirmed', launchState: 'submitted' }],
  ] as const)('a counted Codex create whose launch fails answers %i with the tab and its wip', async (status, outcome, body) => {
    launch.codex.mockResolvedValueOnce(outcome);
    await writeLayout(agents(5));
    const r = await post(tokens.worker, { panelType: 'codex-cli' });
    expect(r.status, JSON.stringify(r.body)).toBe(status);
    expect(r.body).toMatchObject({ ...body, tabId: expect.any(String), wip: { count: 8, cap: 8, overCap: false } });
    expect((await readTabs()).map((t) => t.id)).toContain(r.body.tabId);
  });

  it('two creates at cap − 1 at the same time: exactly one wins', async () => {
    await writeLayout(agents(5));
    const results = await Promise.all([
      post(tokens.worker, { panelType: 'claude-code', launch: false }),
      post(tokens.worker, { panelType: 'codex-cli', launch: false }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body).toMatchObject({ code: 'wip-cap', count: 8, cap: 8 });
    expect((await readTabs()).length).toBe(8);
    expect(tmux.createSession).toHaveBeenCalledTimes(1);
  });

  it('the verified enabled orchestrator passes the cap with a reason: created, overCap true, one audit line', async () => {
    await writeLayout(agents(6));
    const r = await post(tokens.orch, { panelType: 'claude-code', launch: false, overCap: { reason: 'hotfix worker for the BC go-live' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.wip).toEqual({ count: 9, cap: 8, overCap: true });
    const lines = (await auditLines()).filter((line) => line.event === 'tab-over-cap');
    expect(lines).toEqual([expect.objectContaining({
      event: 'tab-over-cap', workspaceId: 'ws-a', tabId: r.body.tabId, count: 9, cap: 8,
      reason: 'hotfix worker for the BC go-live',
      by: { workspaceId: 'ws-a', tabId: 'tab-o', verified: true, identity: 'launch' },
    })]);
  });

  it('an orchestrator create with --over-cap below the cap is an ordinary create: no audit line', async () => {
    await writeLayout(agents(2));
    const r = await post(tokens.orch, { panelType: 'claude-code', launch: false, overCap: { reason: 'spare' } });
    expect(r.status).toBe(201);
    expect(r.body.wip).toEqual({ count: 5, cap: 8, overCap: false });
    expect((await auditLines()).filter((line) => line.event === 'tab-over-cap')).toEqual([]);
  });

  it('a worker tab, an unverified (hook) orchestrator, and a disabled orchestrator get forbidden', async () => {
    await writeLayout(agents(6));
    const worker = await post(tokens.worker, { panelType: 'claude-code', launch: false, overCap: { reason: 'please' } });
    expect(worker.status).toBe(403);
    expect(worker.body).toMatchObject({ code: 'forbidden', error: expect.stringContaining('orchestrator') });
    const hook = await callRoute(create, {
      method: 'POST', headers: { 'x-pmux-token': tokens.hookOrch },
      body: { workspaceId: 'ws-h', panelType: 'claude-code', launch: false, overCap: { reason: 'please' } },
    });
    expect(hook.status).toBe(403);
    expect(hook.body).toMatchObject({ code: 'forbidden' });
    const wsFile = path.join(base(), 'workspaces.json');
    const doc = JSON.parse(await fs.readFile(wsFile, 'utf-8'));
    doc.workspaces.find((w: { id: string }) => w.id === 'ws-a').orchestration.enabled = false;
    await fs.writeFile(wsFile, JSON.stringify(doc));
    resetRouteGlobals();
    vi.resetModules();
    create = (await import('@/pages/api/cli/tabs')).default;
    const disabled = await post(tokens.orch, { panelType: 'claude-code', launch: false, overCap: { reason: 'please' } });
    expect(disabled.status).toBe(403);
    expect((await readTabs()).length).toBe(8);
    expect(await auditLines()).toEqual([]);
  });

  it('a worker passing --over-cap is refused even below the cap', async () => {
    const r = await post(tokens.worker, { panelType: 'terminal', overCap: { reason: 'please' } });
    expect(r.status).toBe(403);
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it('the admin token cannot create a tab at all, with or without overCap (ADR-0021)', async () => {
    for (const body of [{ panelType: 'claude-code' }, { panelType: 'claude-code', overCap: { reason: 'admin' } }]) {
      const r = await post(tokens.admin, body);
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: 'forbidden' });
    }
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty reason', { reason: '' }],
    ['a blank reason', { reason: '   ' }],
    ['a reason over 500 characters', { reason: 'x'.repeat(501) }],
    ['no reason', {}],
    ['a string', 'reason'],
  ])('%s is 400 invalid-request', async (_label, overCap) => {
    const r = await post(tokens.orch, { panelType: 'claude-code', launch: false, overCap });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'invalid-request' });
  });

  it('a 500-character reason is accepted', async () => {
    await writeLayout(agents(6));
    const r = await post(tokens.orch, { panelType: 'claude-code', launch: false, overCap: { reason: 'x'.repeat(500) } });
    expect(r.status).toBe(201);
  });

  it.each([
    ['3', 3, 'fleet-config'],
    ['1', 1, 'fleet-config'],
    ['200', 200, 'fleet-config'],
    ['0', 8, 'default-invalid'],
    ['201', 8, 'default-invalid'],
    ['four', 8, 'default-invalid'],
    ['2.5', 8, 'default-invalid'],
  ])('fleet config %s reads as cap %d (%s)', async (value, cap, capSource) => {
    await setCap(value);
    const r = await callRoute(tabCount, { method: 'GET', headers: { 'x-pmux-token': tokens.worker } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ workspaceId: 'ws-a', count: 2, cap, capSource, overCap: 2 > cap });
  });

  it('the refusal carries the configured cap and its source', async () => {
    await setCap('2');
    const r = await post(tokens.worker, { panelType: 'claude-code', launch: false });
    expect(r.body).toMatchObject({ code: 'wip-cap', count: 2, cap: 2, capSource: 'fleet-config', error: 'ws-a holds 2 of 2 agent tabs' });
  });

  it('an unreadable fleet config refuses an agent create with 503 config-store-unreadable, never "no cap"', async () => {
    await fs.writeFile(path.join(base(), 'fleet-config.json'), '{"values":');
    const r = await post(tokens.worker, { panelType: 'claude-code', launch: false });
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: 'config-store-unreadable' });
    expect(tmux.createSession).not.toHaveBeenCalled();
    const terminal = await post(tokens.worker, { panelType: 'terminal' });
    expect(terminal.status).toBe(201);
    const count = await callRoute(tabCount, { method: 'GET', headers: { 'x-pmux-token': tokens.worker } });
    expect(count.status).toBe(503);
    expect(count.body).toMatchObject({ code: 'config-store-unreadable' });
  });

  it('the human create is never refused at or over the cap, and its agent answer carries wip', async () => {
    await writeLayout(agents(7));
    const req = (panelType: string) => callRoute(humanCreate, {
      method: 'POST', query: { workspace: 'ws-a', paneId: 'pane-2' }, body: { panelType },
    });
    const over = await req('claude-code');
    expect(over.status).toBe(200);
    expect(over.body).toMatchObject({ panelType: 'claude-code', wip: { count: 10, cap: 8, overCap: true } });
    const terminal = await req('terminal');
    expect(terminal.status).toBe(200);
    expect(terminal.body).not.toHaveProperty('wip');
  });

  it('the human create answers without wip when the cap cannot be read, and still creates', async () => {
    await fs.writeFile(path.join(base(), 'fleet-config.json'), '{"values":');
    const r = await callRoute(humanCreate, { method: 'POST', query: { workspace: 'ws-a', paneId: 'pane-1' }, body: { panelType: 'claude-code' } });
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('wip');
  });

  describe('GET /api/cli/workspaces/{ws}/tab-count', () => {
    const get = (token: string, workspaceId = 'ws-a') =>
      callRoute(tabCount, { method: 'GET', headers: { 'x-pmux-token': token }, query: { workspaceId } });

    it('answers the count, the cap and its source to the own workspace and the admin token', async () => {
      await writeLayout([...agents(7), fixtureTab('t1', 'terminal')]);
      for (const token of [tokens.worker, tokens.admin]) {
        const r = await get(token);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ workspaceId: 'ws-a', count: 9, cap: 8, capSource: 'default', overCap: true });
        expect(r.headers['Cache-Control']).toBe('no-store');
      }
    });

    it('refuses another workspace\'s token and no token; 404 for an unknown workspace; 405 for a write', async () => {
      expect((await get(tokens.other)).body).toMatchObject({ code: 'forbidden' });
      expect((await get('nope')).status).toBe(403);
      expect(await get(tokens.admin, 'ws-zz')).toMatchObject({ status: 404, body: { code: 'not-found' } });
      expect((await callRoute(tabCount, { method: 'POST', headers: { 'x-pmux-token': tokens.worker } })).status).toBe(405);
    });

    it('a workspace with no layout yet holds no tab', async () => {
      await fs.rm(path.join(base(), 'workspaces', 'ws-b', 'layout.json'));
      expect((await get(tokens.other, 'ws-b')).body).toMatchObject({ count: 0, overCap: false });
    });
  });
});
