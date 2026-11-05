import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';
import type { ILayoutData, ITab } from '@/types/terminal';

// ADR-0036 §1 (AC 1): `tab create --handoff <path> --rotate-at <N|off>` through the real create route, layout store
// and token checks in a scratch HOME.

const mockHome = vi.hoisted(() => ({ value: '' }));
const status = vi.hoisted(() => ({ registerTab: vi.fn(), registerSeat: vi.fn(), markAgentLaunch: vi.fn(), getAllForClient: () => ({}) }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  createSession: vi.fn(async () => {}),
  hasSession: vi.fn(async () => true),
  killSession: vi.fn(async () => {}),
  listSessions: vi.fn(async () => []),
  sendKeys: vi.fn(async () => {}),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));
vi.mock('@/lib/agent-availability', () => ({ checkAgentAvailabilityForPanelType: vi.fn(async () => ({ ok: true })), toAgentAvailabilityError: vi.fn() }));
vi.mock('@/lib/agent-dispatch-policy', () => ({ checkAgentDispatchPolicy: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/agent-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-launch')>()),
  buildFreshLaunchCommand: vi.fn(async () => undefined),
}));

type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;

const layoutFile = () => path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-a', 'layout.json');

const readTabs = async (): Promise<ITab[]> => {
  const { collectAllTabs } = await import('@/lib/layout-tree');
  return collectAllTabs((JSON.parse(await fs.readFile(layoutFile(), 'utf-8')) as ILayoutData).root);
};

describe('POST /api/cli/tabs: a seat (ADR-0036 §1)', () => {
  let create: THandler;
  let token: string;
  const post = (body: Record<string, unknown>) =>
    callRoute(create, { method: 'POST', headers: { 'x-pmux-token': token }, body: { workspaceId: 'ws-a', panelType: 'claude-code', launch: false, ...body } });

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    status.registerSeat.mockClear();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-seat-'));
    await writeFixture(mockHome.value, [{ id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-o', name: 'orchestrator' }], orchestratorTabId: 'tab-o' }]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    token = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-o' }, 'pt-ws-a-pane-1-tab-o');
    create = (await import('@/pages/api/cli/tabs')).default;
  });

  afterEach(async () => {
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('stores the handoff path and the tab\'s threshold, answers them and opens the seat item', async () => {
    const r = await post({ name: 'v2-kit', handoff: '/srv/v2/.v2/seats/kit/../kit/handoff.md', rotateAt: '200000' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ handoffPath: '/srv/v2/.v2/seats/kit/handoff.md', rotateAt: 200_000 });
    const stored = (await readTabs()).find((tab) => tab.id === r.body.tabId)!;
    expect(stored).toMatchObject({ handoffPath: '/srv/v2/.v2/seats/kit/handoff.md', rotateAt: 200_000 });
    expect(status.registerSeat).toHaveBeenCalledWith(r.body.tabId);
    const off = await post({ handoff: '/srv/h.md', rotateAt: 'off' });
    expect(off.body).toMatchObject({ rotateAt: 'off' });
  });

  it('a tab without --handoff is no seat', async () => {
    const r = await post({ name: 'lane' });
    expect(r.status).toBe(201);
    expect(r.body.handoffPath).toBeUndefined();
    expect((await readTabs()).find((tab) => tab.id === r.body.tabId)?.handoffPath).toBeUndefined();
    expect(status.registerSeat).not.toHaveBeenCalled();
  });

  it.each([
    ['a relative path', { handoff: 'seats/kit/handoff.md' }, 'handoff must be an absolute path'],
    ['a path with a control character', { handoff: '/srv/h\u0007.md' }, 'one printable path'],
    ['--rotate-at without --handoff', { rotateAt: '200000' }, 'rotateAt needs handoff'],
    ['a threshold under 50,000', { handoff: '/srv/h.md', rotateAt: '49999' }, 'from 50000 to 900000'],
    ['a threshold over 900,000', { handoff: '/srv/h.md', rotateAt: 900_001 }, 'from 50000 to 900000'],
    ['a remote tab', { handoff: '/srv/h.md', host: 'ai-server' }, 'handoff is local only'],
  ])('refuses %s with 400 and nothing created', async (_label, body, error) => {
    const before = (await readTabs()).length;
    const r = await post(body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: 'invalid-request', error: expect.stringContaining(error) });
    expect((await readTabs()).length).toBe(before);
  });
});
