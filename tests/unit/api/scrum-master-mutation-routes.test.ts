import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PortfolioStore } from '@/lib/portfolio-store';
import type { TCliScope } from '@/lib/workspace-token';

// ADR-0046 at route level: the real authorization (cli-utils, scrum-master-access and a real PortfolioStore
// selection) in front of each route, with only the runtime behind the route mocked. The selected Scrum Master
// (tab-root in ws-root) manages ws-a.

const state = vi.hoisted(() => ({ scope: null as TCliScope | null }));
const audit = vi.hoisted(() => ({ entries: [] as Record<string, unknown>[] }));
const runtime = vi.hoisted(() => ({
  restartTab: vi.fn(),
  closeTab: vi.fn(),
  deliverPrompt: vi.fn(async (_session: string, _content: string) => {}),
  awaitSendReadiness: vi.fn(),
  registerJob: vi.fn(async (_job: unknown) => {}),
  issueLedgerToken: vi.fn(() => ({ token: 'secret' })),
  reportStandup: vi.fn(async () => {}),
  readStandups: vi.fn(async () => []),
  appendDelivered: vi.fn(),
}));

vi.mock('@/lib/workspace-token', () => ({ resolveCliScope: () => state.scope }));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: async (id: string) => ({ id, name: id, directories: ['/repo'], allowedPeers: [],
    orchestration: { enabled: true, orchestratorTabId: id === 'ws-root' ? 'tab-root' : `tab-orch-${id}` } }),
  updateWorkspaceOrchestration: vi.fn(),
  getWorkspaceStrict: vi.fn(),
}));
// The selection check reads the manager's layout through layout-store; findTab reads through workspace-layout-read.
vi.mock('@/lib/layout-store', () => ({
  resolveLayoutFile: (id: string) => id,
  readLayoutFile: async (id: string) => ({ root: { id } }),
  collectAllTabs: (root: { id: string }) => (root.id === 'ws-root' ? [{ id: 'tab-root', sessionName: 'session-ws-root' }] : []),
  getLayout: vi.fn(),
  closeTab: runtime.closeTab,
  setTabReportOn: vi.fn(),
  setTabReportsTo: vi.fn(),
  updateTabAgentLaunchConfig: vi.fn(),
}));
const layouts = vi.hoisted(() => ({
  'ws-root': { root: { type: 'pane', id: 'pane-root', tabs: [
    { id: 'tab-root', name: 'scrum-master', order: 0, sessionName: 'session-ws-root', panelType: 'claude-code' },
  ] } },
  'ws-a': { root: { type: 'pane', id: 'pane-a', tabs: [
    { id: 'tab-a', name: 'worker', order: 0, sessionName: 'session-a', panelType: 'terminal', host: 'host-b' },
  ] } },
} as Record<string, unknown>));
vi.mock('@/lib/workspace-layout-read', () => ({ readWorkspaceLayout: async (id: string) => layouts[id] ?? null }));
vi.mock('@/lib/tab-token', () => ({ tabIdentityOf: () => 'launch',
  getTabTokenRecord: () => ({ workspaceId: 'ws-root', sessionName: 'session-ws-root' }) }));
vi.mock('@/lib/tmux', () => ({
  hasSession: async () => true,
  hasSessionOrUnreachable: async () => true,
  capturePaneContent: async () => '',
  isContentPendingInComposer: async () => false,
  isPaneShowingPendingLine: () => false,
  pressEnter: async () => {},
}));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: async (entry: Record<string, unknown>) => {
  audit.entries.push(entry);
  return true;
} }));
vi.mock('@/lib/grant-store', () => ({ grantsSnapshot: () => ({ grants: [] }), findActiveDriveGrant: () => null,
  findActiveOwnerGrant: () => null }));
vi.mock('@/lib/caller', () => ({ resolveCaller: async () => (state.scope?.type === 'workspace'
  ? { scope: state.scope, workspaceId: state.scope.workspaceId, tabId: state.scope.tabId ?? null,
    verified: state.scope.tabVerified === true, identity: 'launch', admin: false, tabName: null }
  : null) }));
vi.mock('@/lib/tab-restart', async (original) => ({ ...await original<typeof import('@/lib/tab-restart')>(),
  restartTab: runtime.restartTab }));
vi.mock('@/lib/tab-send', async (original) => ({ ...await original<typeof import('@/lib/tab-send')>(),
  awaitSendReadiness: runtime.awaitSendReadiness }));
vi.mock('@/lib/agent-dispatch-policy', () => ({
  withAgentDispatchThen: async (_ws: string, _tab: unknown,
    work: (check: () => Promise<{ ok: boolean }>) => Promise<unknown>, after: (typed: unknown) => Promise<unknown>) =>
    after(await work(async () => ({ ok: true }))),
}));
vi.mock('@/lib/agent-prompt-delivery', () => ({ deliverPrompt: runtime.deliverPrompt }));
vi.mock('@/lib/tab-event-router', () => ({ appendDelivered: runtime.appendDelivered }));
vi.mock('@/lib/ledger-store', async (original) => ({ ...await original<typeof import('@/lib/ledger-store')>(),
  getLedgerStore: () => ({ tabEvents: {}, openExperiment: vi.fn(), closeExperiment: vi.fn(), extendExperiment: vi.fn(),
    experiments: () => [] }) }));
vi.mock('@/lib/ledger-token', () => ({ issueLedgerToken: runtime.issueLedgerToken }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => ({ reportStandup: runtime.reportStandup,
  getAllForClient: () => ({}), isWaitingAtPrompt: () => false, getSubmitEvidence: () => null }) }));
vi.mock('@/lib/standup-store', () => ({ readStandups: runtime.readStandups }));
vi.mock('@/lib/liveness-manager', () => ({ getLivenessManager: () => ({ registerJob: runtime.registerJob }) }));
vi.mock('@/lib/providers/codex/launch-lifecycle');
vi.mock('@/lib/flow-store');
vi.mock('@/lib/burndown-store');
vi.mock('@/lib/board-goal-store');
vi.mock('@/lib/workspace-patch');

const manager: TCliScope = { type: 'workspace', workspaceId: 'ws-root', tabId: 'tab-root', tabVerified: true };

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;
const routes: Record<string, () => Promise<{ default: THandler }>> = {
  send: () => import('@/pages/api/cli/tabs/[tabId]/send'),
  tab: () => import('@/pages/api/cli/tabs/[tabId]/index'),
  restart: () => import('@/pages/api/cli/tabs/[tabId]/restart'),
  bg: () => import('@/pages/api/cli/tabs/[tabId]/bg'),
  tokens: () => import('@/pages/api/cli/workspaces/[workspaceId]/ledger/tokens'),
  standup: () => import('@/pages/api/cli/workspaces/[workspaceId]/standup'),
  flow: () => import('@/pages/api/cli/workspaces/[workspaceId]/flow'),
  burndown: () => import('@/pages/api/cli/workspaces/[workspaceId]/burndown'),
  boardGoal: () => import('@/pages/api/cli/workspaces/[workspaceId]/board-goal'),
  experimentOpen: () => import('@/pages/api/cli/workspaces/[workspaceId]/ledger/experiments/index'),
  experimentClose: () => import('@/pages/api/cli/workspaces/[workspaceId]/ledger/experiments/[id]'),
  experimentExtend: () => import('@/pages/api/cli/workspaces/[workspaceId]/ledger/experiments/[id]/extend'),
  orchestration: () => import('@/pages/api/cli/workspaces/[workspaceId]/orchestration'),
  directories: () => import('@/pages/api/cli/workspaces/[workspaceId]/directories'),
};

const call = async (route: string, method: string, query: Record<string, string>, body: unknown = {}) => {
  const out = { status: 0, body: undefined as unknown };
  const res = { headersSent: false, setHeader() { return this; }, status(code: number) { out.status = code; return this; },
    json(value: unknown) { out.body = value; return this; } } as unknown as NextApiResponse;
  const url = `/api/cli/${route}?${new URLSearchParams(query).toString()}`;
  await (await routes[route]()).default({ method, headers: {}, query, body, url } as unknown as NextApiRequest, res);
  return out;
};

// The route imports load tmux wrappers, the restart service and the ledger: setup, with its own budget.
beforeAll(async () => {
  for (const load of Object.values(routes)) await load();
}, 60_000);

let store: PortfolioStore;
beforeEach(() => {
  vi.clearAllMocks();
  store = new PortfolioStore(':memory:');
  (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore = store;
  store.select('human-a', { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-a'] });
  state.scope = manager;
  audit.entries.length = 0;
  runtime.restartTab.mockResolvedValue({ status: 200, body: { ok: true } });
  runtime.closeTab.mockResolvedValue({ ok: true, reap: null });
  runtime.awaitSendReadiness.mockResolvedValue({ ok: true, screenEmpty: false,
    target: { sessionName: 'session-a', panelType: 'terminal', cliState: 'idle', waitingAtPrompt: false, startupPrompt: null } });
});
afterEach(() => {
  store.close();
  delete (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore;
});

const admitted = (route: string) => ({ event: 'scrum-master-mutation-admitted', managerWorkspaceId: 'ws-root',
  managerTabId: 'tab-root', workspaceId: 'ws-a', route: `/api/cli/${route}` });

describe('the selected Scrum Master mutates tabs in a selected workspace (ADR-0046)', () => {
  it('sends to a tab', async () => {
    const out = await call('send', 'POST', { workspaceId: 'ws-a', tabId: 'tab-a' }, { content: 'run the gate' });
    expect(out).toMatchObject({ status: 200, body: { status: 'sent', submitted: true } });
    expect(runtime.deliverPrompt).toHaveBeenCalledWith('session-a', 'run the gate');
    expect(audit.entries).toEqual([admitted('send')]);
  });

  it('closes a tab', async () => {
    const out = await call('tab', 'DELETE', { workspaceId: 'ws-a', tabId: 'tab-a' });
    expect(out).toMatchObject({ status: 200, body: { ok: true } });
    expect(runtime.closeTab).toHaveBeenCalledWith('ws-a', 'pane-a', 'tab-a', { keepProcesses: false });
    expect(audit.entries).toEqual([admitted('tab')]);
  });

  it('restarts a tab, and the audit actor names the caller workspace and tab, not the target (F2)', async () => {
    const out = await call('restart', 'POST', { workspaceId: 'ws-a', tabId: 'tab-a' }, { clear: true });
    expect(out.status).toBe(200);
    expect(runtime.restartTab).toHaveBeenCalledWith({ workspaceId: 'ws-a', tabId: 'tab-a', clear: true, interrupt: false,
      by: { kind: 'agent', workspaceId: 'ws-root', tabId: 'tab-root', identity: 'launch' } });
    expect(audit.entries).toEqual([admitted('restart')]);
  });

  it('registers a bg job: the caller tab is found in the caller workspace, not the target (F4)', async () => {
    const out = await call('bg', 'POST', { workspaceId: 'ws-a', tabId: 'tab-a' }, { pid: 4242 });
    expect(out.status).toBe(200);
    // The caller tab (local, no host) wins over the target tab's host-b: the pid was taken where the caller runs.
    expect(runtime.registerJob).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-a', tabId: 'tab-a', pid: 4242, host: null }));
  });

  it('a bg registration from a caller tab that is gone from the caller workspace answers caller-tab-gone', async () => {
    const managerLayout = layouts['ws-root'];
    layouts['ws-root'] = { root: { type: 'pane', id: 'pane-root', tabs: [] } };
    try {
      const out = await call('bg', 'POST', { workspaceId: 'ws-a', tabId: 'tab-a' }, { pid: 4242 });
      expect(out).toMatchObject({ status: 409, body: { code: 'caller-tab-gone' } });
      expect(runtime.registerJob).not.toHaveBeenCalled();
    } finally {
      layouts['ws-root'] = managerLayout;
    }
  });

  it('mutates nothing in a workspace outside the selection', async () => {
    const out = await call('send', 'POST', { workspaceId: 'ws-b', tabId: 'tab-b' }, { content: 'hi' });
    expect(out.status).toBe(403);
    expect(runtime.deliverPrompt).not.toHaveBeenCalled();
    expect(audit.entries).toEqual([]);
  });
});

describe('own-workspace-only routes refuse the selected Scrum Master (ADR-0046 "What does not change")', () => {
  const excluded: [string, string, string, Record<string, string>?][] = [
    ['tokens', 'POST', 'A ledger producer token'],
    ['standup', 'POST', 'The standup'],
    ['flow', 'POST', 'The flow report'],
    ['burndown', 'POST', 'The burndown'],
    ['boardGoal', 'PUT', 'The board goal'],
    ['boardGoal', 'DELETE', 'The board goal'],
    ['experimentOpen', 'POST', 'An experiment'],
    ['experimentClose', 'POST', 'An experiment verdict', { id: 'exp-1' }],
    ['experimentExtend', 'POST', 'An experiment extension', { id: 'exp-1' }],
    ['orchestration', 'PATCH', 'The orchestration setting'],
    ['directories', 'PATCH', 'The workspace directories'],
  ];

  it.each(excluded)('%s %s: 403 own-workspace-only, and no audit line', async (route, method, surface, extra) => {
    const out = await call(route, method, { workspaceId: 'ws-a', ...extra }, { producer: 'gate', state: 'on-track', headline: 'x' });
    expect(out).toMatchObject({ status: 403, body: { code: 'forbidden', rule: 'own-workspace-only' } });
    expect((out.body as { error: string }).error).toContain(`${surface} is written only by the workspace's own tabs`);
    expect(audit.entries).toEqual([]);
  });

  it('F1: no ledger producer token is issued for a foreign workspace; the own workspace still gets one', async () => {
    expect((await call('tokens', 'POST', { workspaceId: 'ws-a' }, { producer: 'gate' })).status).toBe(403);
    expect(runtime.issueLedgerToken).not.toHaveBeenCalled();
    const own = await call('tokens', 'POST', { workspaceId: 'ws-root' }, { producer: 'gate' });
    expect(own.status).toBe(200);
    expect(runtime.issueLedgerToken).toHaveBeenCalledWith('ws-root', 'gate', expect.any(Number));
  });

  it('F3: a foreign standup never reaches the status manager; the selected Scrum Master still reads it', async () => {
    await call('standup', 'POST', { workspaceId: 'ws-a' }, { state: 'on-track', headline: 'all fine' });
    expect(runtime.reportStandup).not.toHaveBeenCalled();
    const read = await call('standup', 'GET', { workspaceId: 'ws-a' });
    expect(read).toMatchObject({ status: 200, body: { latest: null } });
    expect(runtime.readStandups).toHaveBeenCalledWith('ws-a');
  });

  it('F3: the own workspace still posts its standup', async () => {
    const own = await call('standup', 'POST', { workspaceId: 'ws-root' }, { state: 'on-track', headline: 'all fine' });
    expect(own.status).toBe(200);
    expect(runtime.reportStandup).toHaveBeenCalledTimes(1);
  });
});
