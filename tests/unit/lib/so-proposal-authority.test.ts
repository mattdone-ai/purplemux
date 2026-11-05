import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import { PortfolioStore } from '@/lib/portfolio-store';
import type { TCliScope } from '@/lib/workspace-token';

// ADR-0041 §1 amendment D7, test 1: only the launch tab of the selected portfolio manager proposes. The REAL
// `selectedScrumMasterScope` decides, over a real portfolio store; its layout, token and tmux reads are the fakes that
// scrum-master-access.test.ts uses. Every refused caller gets `forbidden`, no item opens and nothing is written.

const state = vi.hoisted(() => ({
  home: '',
  currentTab: 'tab-sm',
  live: true,
  identity: 'launch',
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => state.home }, homedir: () => state.home };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: async (id: string) => ({ id, orchestration: { enabled: true, orchestratorTabId: id === 'ws-sm' ? state.currentTab : `tab-${id}` } }),
}));
vi.mock('@/lib/layout-store', () => ({
  resolveLayoutFile: (id: string) => id,
  readLayoutFile: async (id: string) => ({ root: { id } }),
  collectAllTabs: (root: { id: string }) => [
    { id: root.id === 'ws-sm' ? state.currentTab : `tab-${root.id}`, sessionName: `session-${root.id}` },
    { id: 'tab-worker', sessionName: `session-${root.id}-worker` },
  ],
}));
vi.mock('@/lib/tab-token', () => ({
  tabIdentityOf: () => state.identity,
  getTabTokenRecord: (tabId: string) => ({ workspaceId: tabId === 'tab-a' ? 'ws-a' : 'ws-sm', sessionName: tabId === 'tab-a' ? 'session-ws-a' : 'session-ws-sm' }),
}));
vi.mock('@/lib/tmux', () => ({ hasSession: async () => state.live }));

import { selectedScrumMasterScope } from '@/lib/scrum-master-access';
import { proposeStandingOrder, type ISoProposalDeps } from '@/lib/so-proposal-service';
import { FLEET, orderFilePath, readOrderFile } from '@/lib/standing-orders-store';

const scopeOf = (workspaceId: string, tabId: string, tabVerified = true): TCliScope =>
  (tabVerified ? { type: 'workspace', workspaceId, tabId, tabVerified: true } : { type: 'workspace', workspaceId, tabId }) as TCliScope;
const callerOf = (scope: TCliScope, identity: 'launch' | 'hook' = 'launch'): ICaller => ({
  scope, workspaceId: scope.type === 'workspace' ? scope.workspaceId : null, tabId: scope.type === 'workspace' ? scope.tabId ?? null : null,
  tabName: null, verified: identity === 'launch', identity, admin: false,
} as ICaller);
const ADMIN = { scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true } as unknown as ICaller;

let portfolio: PortfolioStore;
const apply = vi.fn(async () => ({}));
const audit = vi.fn(async () => true);

const deps = (): ISoProposalDeps => ({
  now: () => Date.UTC(2026, 10, 5),
  store: () => ({
    openSoProposals: () => [], listOpenRunBindings: () => [], soProposal: () => null, attentionItem: () => null,
    answerById: () => null, settleSoProposal: () => false, expireSoProposal: () => false,
  }),
  selection: (caller) => selectedScrumMasterScope(caller.scope),
  orchestratorTabId: async (ws) => (ws === 'ws-sm' ? state.currentTab : `tab-${ws}`),
  apply,
  orders: {
    now: () => Date.UTC(2026, 10, 5), workspaceIds: async () => ['ws-sm', 'ws-a'], refreshPrompt: async () => {},
    liveAgentTabs: () => [], route: async (event) => ({ class: event.class, delivered: true, seq: 1, duplicate: false }),
  },
  audit,
});

const codeOf = async (caller: ICaller): Promise<{ code?: string; reason?: string }> =>
  proposeStandingOrder(deps(), caller, { text: 'A rule for every seat.', why: 'The owner said it twice.' })
    .then(() => ({ code: 'none' }), (err: { code?: string; reason?: string }) => err);

beforeEach(async () => {
  state.home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-so-proposal-auth-'));
  state.currentTab = 'tab-sm';
  state.live = true;
  state.identity = 'launch';
  delete (globalThis as { __ptStandingOrdersLock?: unknown }).__ptStandingOrdersLock;
  portfolio = new PortfolioStore(':memory:');
  (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore = portfolio;
  portfolio.select('human-a', { managerWorkspaceId: 'ws-sm', managerTabId: 'tab-sm', workspaceIds: ['ws-a'] });
  apply.mockClear();
  audit.mockClear();
  await readOrderFile(FLEET);
});

afterEach(async () => {
  portfolio.close();
  delete (globalThis as { __ptPortfolioStore?: PortfolioStore }).__ptPortfolioStore;
  await fs.rm(state.home, { recursive: true, force: true });
});

describe('who proposes a fleet standing order (D7 rule 1; test 1)', () => {
  it('the selected manager\'s launch tab passes the authority check and reaches the run check', async () => {
    expect(await codeOf(callerOf(scopeOf('ws-sm', 'tab-sm')))).toMatchObject({ code: 'so-proposal-refused', reason: 'no-orchestrator-run' });
  });

  it('refuses a worker tab of the SM workspace, another workspace\'s orchestrator, a hook tab, the SM after the selection moved, and admin', async () => {
    const fleet = await fs.readFile(orderFilePath(FLEET), 'utf-8');
    expect(await codeOf(callerOf(scopeOf('ws-sm', 'tab-worker')))).toMatchObject({ code: 'forbidden' });
    expect(await codeOf(callerOf(scopeOf('ws-a', 'tab-a')))).toMatchObject({ code: 'forbidden' });
    expect(await codeOf(callerOf(scopeOf('ws-sm', 'tab-sm', false), 'hook'))).toMatchObject({ code: 'forbidden' });
    state.identity = 'hook';
    expect(await codeOf(callerOf(scopeOf('ws-sm', 'tab-sm')))).toMatchObject({ code: 'forbidden' });
    state.identity = 'launch';
    portfolio.select('human-b', { managerWorkspaceId: 'ws-a', managerTabId: 'tab-a', workspaceIds: ['ws-sm'] });
    expect(await codeOf(callerOf(scopeOf('ws-sm', 'tab-sm')))).toMatchObject({ code: 'forbidden' });
    expect(await codeOf(ADMIN)).toMatchObject({ code: 'forbidden' });
    expect(apply).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(await fs.readFile(orderFilePath(FLEET), 'utf-8')).toBe(fleet);
  });

  it('refuses the SM whose session is gone, or whose orchestrator seat moved to another tab', async () => {
    state.live = false;
    expect(await codeOf(callerOf(scopeOf('ws-sm', 'tab-sm')))).toMatchObject({ code: 'forbidden' });
    state.live = true;
    state.currentTab = 'tab-new-orch';
    expect(await codeOf(callerOf(scopeOf('ws-sm', 'tab-sm')))).toMatchObject({ code: 'forbidden' });
  });
});
