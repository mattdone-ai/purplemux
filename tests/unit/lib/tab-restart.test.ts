import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILayoutData, ITab } from '@/types/terminal';
import type { IRestartTabInput } from '@/lib/tab-restart';
import type { IAgentLaunchTarget } from '@/lib/agent-launch';
import type { IAgentProvider } from '@/lib/providers/types';
import { agentLaunchOptionsForTab } from '@/lib/agent-launch-policy';

// ADR-0028 (story 04): a restart kills and relaunches a tab's processes under
// the same tab id, without the close events that drop what is keyed on it.

const mockHome = vi.hoisted(() => ({ value: '' }));
const REAP = { reaper: 'linux', envMarker: 'present', killed: [{ pid: 4242, comm: 'claude', args: 'claude --resume' }], survivors: [] };
const tmux = vi.hoisted(() => ({
  killSession: vi.fn(),
  hasSession: vi.fn(async (_name: string) => false),
  hasSessionOrUnreachable: vi.fn(async (_name: string) => true),
  createSession: vi.fn(async (name: string, _cols: number, _rows: number, _cwd?: string, identity?: { workspaceId: string; tabId: string }) => {
    // The real createSession hands the tab its token through ensureTabToken.
    if (identity) await (await import('@/lib/tab-token')).ensureTabToken(identity, name);
  }),
  resolveExistingDir: vi.fn(async (cwd?: string) => cwd),
  sessionPresence: vi.fn(async (_name: string): Promise<'present' | 'absent' | 'unknown'> => 'absent'),
}));
const pty = vi.hoisted(() => ({ exits: [] as Array<(e: { exitCode: number; signal?: number }) => void> }));
const status = vi.hoisted(() => ({
  states: new Map<string, string>(),
  markAgentLaunch: vi.fn(),
}));
const launcher = vi.hoisted(() => ({
  launchAgentInTab: vi.fn(),
  confirmCodexLaunch: vi.fn(),
}));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/tmux', () => ({
  ...tmux,
  listSessions: vi.fn(async () => []),
  sendKeys: vi.fn(async () => {}),
  defaultSessionName: () => 'pt-x-y-z',
  exitCopyMode: vi.fn(async () => {}),
  observeTabSessionsStrict: vi.fn(async () => ({ state: 'absent' })),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));
vi.mock('@/lib/workspace-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-store')>()),
  getWorkspaceById: vi.fn(async (id: string) => (id === 'ws-r' ? { id, name: 'r', directories: ['/srv/r'] } : null)),
}));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({
    getTabAgentState: (tabId: string) => (status.states.has(tabId) ? { cliState: status.states.get(tabId), isAgent: true } : null),
    markAgentLaunch: status.markAgentLaunch,
  }),
}));
vi.mock('@/lib/agent-launch', () => launcher);
vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 7, write: vi.fn(), resize: vi.fn(), kill: vi.fn(), pause: vi.fn(), resume: vi.fn(),
    onData: () => ({ dispose: vi.fn() }),
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => { pty.exits.push(cb); return { dispose: vi.fn() }; },
  }),
}));
vi.mock('@/lib/agent-prompt-delivery', () => ({ sessionUsesTypedDelivery: async () => false }));
vi.mock('@/lib/terminal-input', () => ({ withRecordedTerminalInput: async (_s: string, _d: string, work: () => Promise<void>) => work() }));

const WS = 'ws-r';
const SESSION_ID = '0b5c3a3e-6a8e-4c39-9f1e-2a5f3c1d9e70';
const session = (tabId: string) => `pt-${WS}-pane-a-${tabId}`;

const claudeTab = (over: Partial<ITab> = {}): ITab => ({
  id: 'tab-t',
  sessionName: session('tab-t'),
  name: 'worker',
  order: 0,
  cwd: '/srv/r',
  panelType: 'claude-code',
  agentLaunchConfig: { model: 'claude-opus-5-5', effort: 'high' },
  scope: ['src/**'],
  agentState: { providerId: 'claude', sessionId: SESSION_ID, jsonlPath: null, summary: null },
  ...over,
});

const writeLayout = async (tabs: ITab[]) => {
  const store = await import('@/lib/layout-store');
  const layout: ILayoutData = {
    root: { type: 'pane', id: 'pane-a', activeTabId: tabs[0].id, tabs },
    activePaneId: 'pane-a',
    updatedAt: '2026-10-26T00:00:00.000Z',
  };
  await store.writeLayoutFile(layout, store.resolveLayoutFile(WS));
};

const readTabs = async (): Promise<ITab[]> => {
  const store = await import('@/lib/layout-store');
  const layout = await store.readLayoutFile(store.resolveLayoutFile(WS));
  return store.collectAllTabs(layout!.root);
};

const input = (over: Partial<IRestartTabInput> = {}): IRestartTabInput => ({
  workspaceId: WS,
  tabId: 'tab-t',
  clear: false,
  interrupt: false,
  by: { kind: 'agent', workspaceId: WS, tabId: 'tab-orch', identity: 'launch' },
  ...over,
});

const auditLines = async (): Promise<Array<Record<string, unknown>>> => {
  const raw = await fs.readFile(path.join(mockHome.value, '.purplemux', 'audit', 'coordination.jsonl'), 'utf-8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === 'tab-restart');
};

const restartIds: Array<{ restartId: string; phase: string }> = [];

/** Every `restarting` has exactly one end event with its restart id. */
const endsPerRestart = () => {
  const ids = [...new Set(restartIds.map((e) => e.restartId))];
  return ids.map((id) => restartIds.filter((e) => e.restartId === id).map((e) => e.phase));
};

const lifecycleEvents = async () => {
  const lifecycle = await import('@/lib/tab-lifecycle');
  const events: string[] = [];
  lifecycle.onTabRestart((e) => {
    events.push(`restart:${e.tabId}:${e.phase}`);
    restartIds.push({ restartId: e.restartId, phase: e.phase });
  });
  lifecycle.onTabClosing((e) => events.push(`closing:${e.tabId}:${e.phase}`));
  lifecycle.onTabClosed((e) => events.push(`closed:${e.tabId}`));
  return events;
};

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled', '__ptLayoutContentCache', '__ptLayoutLock', '__ptOrchestrationMappingGates', '__ptCoordinationAuditLock', '__ptSessionTabsSeen']) delete g[key];
};

describe('restartTab (ADR-0028)', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    resetGlobals();
    status.states.clear();
    restartIds.length = 0;
    pty.exits = [];
    tmux.resolveExistingDir.mockImplementation(async (cwd?: string) => cwd);
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-tab-restart-'));
    tmux.killSession.mockResolvedValue(REAP);
    tmux.hasSession.mockResolvedValue(false);
    tmux.hasSessionOrUnreachable.mockResolvedValue(true);
    launcher.launchAgentInTab.mockImplementation(async (_target: unknown, options: { resumeSessionId: string | null }) => ({
      kind: 'command', resumed: options.resumeSessionId !== null,
    }));
  });

  afterEach(async () => {
    await (globalThis as { __ptTabTokenLock?: Promise<void> }).__ptTabTokenLock;
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('relaunches an evaluator tab with its role: dontAsk, the four built-ins, the preview allow-list and no bypass (ADR-0040)', async () => {
    await writeLayout([claudeTab({ role: 'evaluator', previewOrigin: 'http://localhost:3100', pgService: 'preview_42' })]);
    await (await import('@/lib/config-store')).updateConfig({ dangerouslySkipPermissions: true });
    const { restartTab } = await import('@/lib/tab-restart');

    expect((await restartTab(input())).status).toBe(200);
    const [target, options] = launcher.launchAgentInTab.mock.calls[0] as [IAgentLaunchTarget, { provider: IAgentProvider; resumeSessionId: string }];
    expect(target).toMatchObject({ role: 'evaluator', previewOrigin: 'http://localhost:3100', pgService: 'preview_42' });
    // The command launchAgentInTab builds from that target (agent-launch.ts).
    const command = await options.provider.buildResumeCommand(options.resumeSessionId, { workspaceId: WS, ...agentLaunchOptionsForTab(target) });
    expect(command).toMatch(/^PGSERVICE=preview_42 claude --resume /);
    expect(command).toContain('--permission-mode dontAsk');
    expect(command).toContain('--tools Read,Grep,Glob,Bash');
    expect(command).toContain('http://localhost:3100/*');
    expect(command).not.toContain('--dangerously-skip-permissions');
    const ordinary = await options.provider.buildResumeCommand(options.resumeSessionId, { workspaceId: WS });
    expect(ordinary).toContain('--dangerously-skip-permissions');
  });

  it('restarts an idle claude-code tab: reap, same session name, resume with the persisted launch settings', async () => {
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input());

    expect(result).toEqual({
      status: 200,
      body: { ok: true, workspaceId: WS, tabId: 'tab-t', resumed: true, identity: 'launch', reaped: { killed: 1, survivors: 0 } },
    });
    expect(tmux.killSession).toHaveBeenCalledWith(session('tab-t'), { tabId: 'tab-t' });
    expect(tmux.createSession).toHaveBeenCalledWith(session('tab-t'), 80, 24, '/srv/r', { workspaceId: WS, tabId: 'tab-t' });
    expect(launcher.launchAgentInTab).toHaveBeenCalledWith(
      { workspaceId: WS, tabId: 'tab-t', sessionName: session('tab-t'), panelType: 'claude-code', host: undefined, agentLaunchConfig: { model: 'claude-opus-5-5', effort: 'high' } },
      expect.objectContaining({ resumeSessionId: SESSION_ID, targetLockHeld: true, resetAgentSession: false, provider: expect.objectContaining({ id: 'claude' }) }),
    );
    const [tab] = await readTabs();
    expect(tab.id).toBe('tab-t');
    expect(tab.scope).toEqual(['src/**']);
    expect(typeof tab.lastRestartAt).toBe('number');
  });

  it('appends one tab-restart audit line with the caller, the flags and the reap counts', async () => {
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');
    await restartTab(input());
    expect(await auditLines()).toEqual([expect.objectContaining({
      event: 'tab-restart',
      workspaceId: WS,
      tabId: 'tab-t',
      by: { kind: 'agent', workspaceId: WS, tabId: 'tab-orch', identity: 'launch' },
      clear: false,
      interrupt: false,
      outcome: 'restarted',
      resumed: true,
      reaped: { killed: 1, survivors: 0 },
    })]);
  });

  it('Q4: keeps the tab id, fires no tab-closing or tab-closed, and leaves every store keyed on the tab as it was', async () => {
    const worker = claudeTab();
    const peer: ITab = { id: 'tab-peer', sessionName: session('tab-peer'), name: 'peer', order: 1, panelType: 'claude-code', reportsTo: 'tab-t' };
    await writeLayout([worker, peer]);
    // The stores that the close events empty for a tab (leases, watches, probes and jobs, notes, grants and owner
    // grants, the Mission Control run binding), and the spend session-to-tab bindings. A restart neither emits those
    // events nor writes these files; with a real launcher, a resume only refreshes the same tab's spend binding.
    const base = path.join(mockHome.value, '.purplemux');
    const stores: Record<string, string> = {
      'leases.json': JSON.stringify({ leases: [{ name: 'epic:flow', holder: { workspaceId: WS, tabId: 'tab-t' } }] }),
      'watches.json': JSON.stringify({ watches: [{ id: 'w-1', workspaceId: WS, tabId: 'tab-t' }] }),
      [`workspaces/${WS}/liveness.json`]: JSON.stringify({ probes: [{ workspaceId: WS, tabId: 'tab-t', label: 'gate' }], jobs: [] }),
      'notes.json': JSON.stringify({ notes: [{ id: 'n-1', deliveredTo: { workspaceId: WS, tabId: 'tab-t' } }] }),
      'grants.json': JSON.stringify({ grants: [{ granteeTabId: 'tab-t' }] }),
      'owner-grants.json': JSON.stringify({ grants: [{ id: 'g-owner', capability: 'owner', grantee: { workspaceId: WS, tabId: 'tab-t' }, workspaces: ['*'] }] }),
      'session-tabs.json': JSON.stringify({ version: 1, bindings: { [`claude:${SESSION_ID}`]: { workspaceId: WS, tabId: 'tab-t', firstSeenAt: 1, lastSeenAt: 1 } } }),
    };
    for (const [rel, content] of Object.entries(stores)) {
      await fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true });
      await fs.writeFile(path.join(base, rel), content);
    }
    // The Mission Control run binding: an open run bound to the tab keeps its row, keyed to the same tab.
    const { MissionControlStore } = await import('@/lib/mission-control-store');
    const mission = new MissionControlStore(path.join(base, 'mission-control.sqlite'));
    const identity = { tabId: 'tab-t', providerId: 'claude', sessionId: SESSION_ID, runtimeGeneration: 'launch-1' };
    mission.applyEvents([{
      eventId: 'event-start', schemaVersion: 1, workspaceId: WS, runId: 'run-1', expectedRevision: 0,
      producerAt: 1_700_000_000_000, bindingGeneration: 0, type: 'run.started', payload: { objective: 'Restart a worker', tabId: 'tab-t' },
    }], new Map([['event-start', identity]]));
    const bindingsBefore = mission.listOpenRunBindings(WS);
    expect(bindingsBefore).toEqual([expect.objectContaining({ runId: 'run-1', binding: expect.objectContaining({ tabId: 'tab-t' }) })]);
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');

    expect((await restartTab(input())).status).toBe(200);

    expect(mission.listOpenRunBindings(WS)).toEqual(bindingsBefore);
    mission.close();
    expect(events).toEqual(['restart:tab-t:restarting', 'restart:tab-t:restarted']);
    const tabs = await readTabs();
    expect(tabs.map((t) => t.id)).toEqual(['tab-t', 'tab-peer']);
    expect(tabs[1].reportsTo).toBe('tab-t');
    for (const [rel, content] of Object.entries(stores)) {
      expect(await fs.readFile(path.join(base, rel), 'utf-8')).toBe(content);
    }
  });

  it('replaces a hook-time identity with a fresh launch token', async () => {
    await writeLayout([claudeTab()]);
    const tokens = await import('@/lib/tab-token');
    const minted = await tokens.mintHookTabToken({ workspaceId: WS, tabId: 'tab-t' }, session('tab-t'));
    if (!minted.ok) throw new Error('hook token not minted');
    tokens.notePresented('tab-t', tokens.getTabTokenRecord('tab-t')!);
    expect(tokens.tabIdentityOf(WS, 'tab-t')).toBe('hook');
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input());

    expect(result.body).toMatchObject({ identity: 'launch' });
    expect(tokens.tabIdentityOf(WS, 'tab-t')).toBe('launch');
    expect(tokens.getTabTokenRecord('tab-t')!.token).not.toBe(minted.token);
  });

  it('keeps a launch token', async () => {
    await writeLayout([claudeTab()]);
    const tokens = await import('@/lib/tab-token');
    const before = await tokens.ensureTabToken({ workspaceId: WS, tabId: 'tab-t' }, session('tab-t'));
    const { restartTab } = await import('@/lib/tab-restart');
    await restartTab(input());
    expect(tokens.getTabTokenRecord('tab-t')!.token).toBe(before);
  });

  it('--clear starts a new session: no resume, and the answer says why', async () => {
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');
    const result = await restartTab(input({ clear: true }));
    expect(result.body).toMatchObject({ resumed: false, resumeSkipped: 'clear' });
    expect(launcher.launchAgentInTab).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeSessionId: null, resetAgentSession: true }));
  });

  it('--clear: the new session\'s hook binds it to the same tab id, beside the old session\'s binding (ADR-0030 §3)', async () => {
    await writeLayout([claudeTab()]);
    const store = await import('@/lib/layout-store');
    const { claudeProvider } = await import('@/lib/providers/claude');
    await store.updateTabAgentState(session('tab-t'), claudeProvider, { sessionId: SESSION_ID });
    const { restartTab } = await import('@/lib/tab-restart');

    expect((await restartTab(input({ clear: true }))).status).toBe(200);
    const fresh = '7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6';
    await store.updateTabAgentState(session('tab-t'), claudeProvider, { sessionId: null, jsonlPath: null });
    await store.updateTabAgentState(session('tab-t'), claudeProvider, { sessionId: fresh, jsonlPath: null });

    const { readSessionTabs } = await import('@/lib/spend/session-tabs-store');
    const bindings = await readSessionTabs();
    expect(bindings[`claude:${fresh}`]).toMatchObject({ workspaceId: WS, tabId: 'tab-t' });
    expect(bindings[`claude:${SESSION_ID}`]).toMatchObject({ workspaceId: WS, tabId: 'tab-t' });
    expect((await readTabs())[0].id).toBe('tab-t');
  });

  it('a tab with no agent session starts fresh: resumeSkipped no-session', async () => {
    await writeLayout([claudeTab({ agentState: undefined })]);
    const { restartTab } = await import('@/lib/tab-restart');
    expect((await restartTab(input())).body).toMatchObject({ resumed: false, resumeSkipped: 'no-session' });
  });

  it.each([
    ['cliState busy', () => { status.states.set('tab-t', 'busy'); }, {}],
    ['a pending turn', () => {}, { orchestrationActivity: { sessionName: session('tab-t'), runtimeGeneration: 'g', turn: { generation: 't', runtimeGeneration: 'g', at: 1 } } }],
    ['a pending launch', () => {}, { orchestrationActivity: { sessionName: session('tab-t'), runtimeGeneration: 'g', launch: { at: 1 } } }],
  ] as const)('a busy tab (%s) without --interrupt answers 409 tab-busy and changes nothing', async (_label, arrange, over) => {
    arrange();
    await writeLayout([claudeTab(over as Partial<ITab>)]);
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input());

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ code: 'tab-busy', tabId: 'tab-t' });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(launcher.launchAgentInTab).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(await auditLines()).toEqual([]);
    expect((await readTabs())[0].lastRestartAt).toBeUndefined();
  });

  it('--interrupt restarts a busy tab, records the abandoned turn, and clears the dead session\'s pending work', async () => {
    status.states.set('tab-t', 'busy');
    await writeLayout([claudeTab({ orchestrationActivity: { sessionName: session('tab-t'), runtimeGeneration: 'g', turn: { generation: 't', runtimeGeneration: 'g', at: 1 } } })]);
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input({ interrupt: true }));

    expect(result.status).toBe(200);
    expect(await auditLines()).toEqual([expect.objectContaining({ interrupt: true, abandoned: { cliState: 'busy', launch: false, turn: true } })]);
    expect((await readTabs())[0].orchestrationActivity).toBeUndefined();
  });

  it('interruptIf is read inside the lock on a busy tab: its answer decides, and the audit records it (ADR-0036)', async () => {
    status.states.set('tab-t', 'busy');
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');
    const seen: string[] = [];
    const refused = await restartTab(input({ interruptIf: (tab) => { seen.push(tab.id); return false; } }));
    expect(refused).toMatchObject({ status: 409, body: { code: 'tab-busy' } });
    expect(tmux.killSession).not.toHaveBeenCalled();
    const allowed = await restartTab(input({ interruptIf: (tab) => { seen.push(tab.id); return true; } }));
    expect(allowed.status).toBe(200);
    expect(seen).toEqual(['tab-t', 'tab-t']);
    expect(await auditLines()).toEqual([expect.objectContaining({ interrupt: true, abandoned: expect.objectContaining({ cliState: 'busy' }) })]);
    status.states.set('tab-t', 'idle');
    seen.length = 0;
    expect((await restartTab(input({ interruptIf: (tab) => { seen.push(tab.id); return true; } }))).status).toBe(200);
    expect(seen).toEqual([]);
  });

  it('abandoned work needs a proven reaper: a reap without /proc is not confirmed', async () => {
    status.states.set('tab-t', 'busy');
    tmux.killSession.mockResolvedValue({ ...REAP, reaper: 'unavailable' });
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');
    expect((await restartTab(input({ interrupt: true }))).body).toMatchObject({ code: 'restart-not-confirmed' });
    expect(launcher.launchAgentInTab).not.toHaveBeenCalled();
  });

  it('a remote tab restarts on the same host, fresh only', async () => {
    tmux.killSession.mockResolvedValue({ ...REAP, reaper: 'remote', sessionGone: true });
    // Present before the reap, gone after it, as the remote tmux answers.
    tmux.hasSessionOrUnreachable.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await writeLayout([claudeTab({ host: 'ai-server' })]);
    const { restartTab } = await import('@/lib/tab-restart');
    const { sessionHostOf } = await import('@/lib/session-host');

    const result = await restartTab(input());

    expect(result.body).toMatchObject({ ok: true, resumed: false, resumeSkipped: 'remote' });
    expect(await sessionHostOf(session('tab-t'))).toBe('ai-server');
    expect(tmux.hasSessionOrUnreachable).toHaveBeenCalledWith(session('tab-t'));
    expect(launcher.launchAgentInTab).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'ai-server' }),
      expect.objectContaining({ resumeSessionId: null }),
    );
    // The identity is what makes createRemoteSession rewrite the prompt file and ship it: a remote restart
    // loads the standing orders active at the restart (ADR-0041; architect ruling on story 14 AC 2).
    expect(tmux.createSession).toHaveBeenCalledWith(session('tab-t'), 80, 24, '/srv/r', { workspaceId: WS, tabId: 'tab-t' });
  });

  it('a remote host that does not answer kills nothing: 503 remote-host-unreachable', async () => {
    const { RemoteHostError } = await import('@/lib/remote-host');
    tmux.hasSessionOrUnreachable.mockRejectedValue(new RemoteHostError('ai-server', 'remote host ai-server did not answer over ssh'));
    await writeLayout([claudeTab({ host: 'ai-server' })]);
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input());

    expect(result).toEqual({ status: 503, body: { error: 'remote host ai-server did not answer over ssh', code: 'remote-host-unreachable', host: 'ai-server' } });
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('a remote reap that leaves the session is not confirmed', async () => {
    tmux.killSession.mockResolvedValue({ ...REAP, reaper: 'remote', sessionGone: false });
    await writeLayout([claudeTab({ host: 'ai-server' })]);
    const { restartTab } = await import('@/lib/tab-restart');
    expect((await restartTab(input())).body).toMatchObject({ code: 'restart-not-confirmed' });
  });

  it.each(['web-browser', 'diff', 'agent-sessions'] as const)('a %s tab answers 400 restart-unsupported', async (panelType) => {
    await writeLayout([claudeTab({ panelType })]);
    const { restartTab } = await import('@/lib/tab-restart');
    expect(await restartTab(input())).toEqual({
      status: 400,
      body: { error: `a ${panelType} tab has no process to restart`, code: 'restart-unsupported', panelType },
    });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  it('a terminal tab restarts its shell with no launch', async () => {
    await writeLayout([claudeTab({ panelType: 'terminal', agentState: undefined })]);
    const { restartTab } = await import('@/lib/tab-restart');
    const result = await restartTab(input());
    expect(result.body).toEqual({ ok: true, workspaceId: WS, tabId: 'tab-t', resumed: false, identity: 'launch', reaped: { killed: 1, survivors: 0 } });
    expect(tmux.createSession).toHaveBeenCalled();
    expect(launcher.launchAgentInTab).not.toHaveBeenCalled();
  });

  it('a survivor after the reap answers 500 restart-not-confirmed and relaunches nothing', async () => {
    tmux.killSession.mockResolvedValue({ ...REAP, survivors: [{ pid: 77, comm: 'sleep', args: 'sleep 600' }] });
    await writeLayout([claudeTab()]);
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input());

    expect(result).toEqual({
      status: 500,
      body: expect.objectContaining({ code: 'restart-not-confirmed', tabId: 'tab-t', reaped: { killed: 1, survivors: 1 } }),
    });
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(launcher.launchAgentInTab).not.toHaveBeenCalled();
    expect(events).toEqual(['restart:tab-t:restarting', 'restart:tab-t:failed']);
    expect(await auditLines()).toEqual([expect.objectContaining({ outcome: 'not-confirmed', reaped: { killed: 1, survivors: 1 } })]);
  });

  it('a session still present after the reap answers 500 restart-not-confirmed', async () => {
    tmux.hasSession.mockResolvedValue(true);
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');
    expect((await restartTab(input())).body).toMatchObject({ code: 'restart-not-confirmed' });
    expect(launcher.launchAgentInTab).not.toHaveBeenCalled();
  });

  it('no reap at all is not confirmed, and the answer says the counts are unknown', async () => {
    tmux.killSession.mockResolvedValue(null);
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');
    expect((await restartTab(input())).body).toMatchObject({ code: 'restart-not-confirmed', reaped: null });
  });

  it('a Codex launch is confirmed after the target lock is released', async () => {
    await writeLayout([claudeTab({ panelType: 'codex-cli', agentState: { providerId: 'codex', sessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f', jsonlPath: null, summary: null } })]);
    launcher.launchAgentInTab.mockResolvedValue({ kind: 'codex', resumed: true, outcome: { ok: true, generation: 'g-1', phase: 'submitted' } });
    const { withCodexTargetLock } = await import('@/lib/providers/codex/launch-lifecycle');
    launcher.confirmCodexLaunch.mockImplementation(async () => {
      // The activating hook takes this lock: it must be free now.
      await withCodexTargetLock(WS, 'tab-t', async () => {});
      return { ok: true, generation: 'g-1', phase: 'active' };
    });
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input());

    expect(launcher.launchAgentInTab).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ targetLockHeld: true }));
    expect(launcher.confirmCodexLaunch).toHaveBeenCalledWith(WS, 'tab-t', 'g-1');
    expect(result.body).toMatchObject({ resumed: true, launchState: 'active' });
  });

  it('a held Codex launch answers launchState held and resumed false', async () => {
    await writeLayout([claudeTab({ panelType: 'codex-cli', agentState: undefined })]);
    launcher.launchAgentInTab.mockResolvedValue({ kind: 'codex', resumed: false, outcome: { ok: false, step: 'submit', reason: 'terminal-not-ready:tmux', generation: 'g-2', phase: 'held' } });
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');
    const result = await restartTab(input());
    expect(result.body).toMatchObject({ ok: true, resumed: false, launchState: 'held' });
    expect(launcher.confirmCodexLaunch).not.toHaveBeenCalled();
    expect(events).toEqual(['restart:tab-t:restarting', 'restart:tab-t:failed']);
  });

  it('a launch that throws emits failed, audits it, and rethrows', async () => {
    await writeLayout([claudeTab()]);
    launcher.launchAgentInTab.mockRejectedValue(new Error('send-keys failed'));
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');
    await expect(restartTab(input())).rejects.toThrow('send-keys failed');
    expect(events).toEqual(['restart:tab-t:restarting', 'restart:tab-t:failed']);
    expect(await auditLines()).toEqual([expect.objectContaining({ outcome: 'failed', error: 'send-keys failed' })]);
  });

  it('sends exactly one end event per restart id on every path that sent restarting, and none on a refusal before it', async () => {
    await writeLayout([claudeTab()]);
    await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');

    await restartTab(input());
    tmux.killSession.mockResolvedValueOnce({ ...REAP, survivors: [{ pid: 9, comm: 'x', args: 'x' }] });
    await restartTab(input());
    launcher.launchAgentInTab.mockRejectedValueOnce(new Error('boom'));
    await restartTab(input()).catch(() => {});
    status.states.set('tab-t', 'busy');
    await restartTab(input());
    status.states.clear();
    await restartTab(input({ tabId: 'tab-gone' }));

    expect(endsPerRestart()).toEqual([['restarting', 'restarted'], ['restarting', 'failed'], ['restarting', 'failed']]);
  });

  it('a confirmCodexLaunch that throws still sends failed and writes the audit line', async () => {
    await writeLayout([claudeTab({ panelType: 'codex-cli', agentState: undefined })]);
    launcher.launchAgentInTab.mockResolvedValue({ kind: 'codex', resumed: false, outcome: { ok: true, generation: 'g-3', phase: 'submitted' } });
    launcher.confirmCodexLaunch.mockRejectedValue(new Error('layout unreadable'));
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');
    await expect(restartTab(input())).rejects.toThrow('layout unreadable');
    expect(events).toEqual(['restart:tab-t:restarting', 'restart:tab-t:failed']);
    expect(endsPerRestart()).toEqual([['restarting', 'failed']]);
    expect(await auditLines()).toEqual([expect.objectContaining({ outcome: 'failed', error: 'layout unreadable', reaped: { killed: 1, survivors: 0 } })]);
  });

  it('a lost cwd launches fresh in the fallback directory: resumeSkipped cwd-lost', async () => {
    tmux.resolveExistingDir.mockImplementation(async () => '/srv');
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');
    const result = await restartTab(input());
    expect(result.body).toMatchObject({ ok: true, resumed: false, resumeSkipped: 'cwd-lost' });
    expect(tmux.createSession).toHaveBeenCalledWith(session('tab-t'), 80, 24, '/srv', { workspaceId: WS, tabId: 'tab-t' });
    expect(launcher.launchAgentInTab).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeSessionId: null, resetAgentSession: true }));
  });

  it('a tab that leaves the layout after a confirmed reap answers restart-not-confirmed with the counts, audited as failed', async () => {
    await writeLayout([claudeTab(), { id: 'tab-other', sessionName: session('tab-other'), name: 'o', order: 1 }]);
    tmux.killSession.mockImplementation(async () => {
      await writeLayout([{ id: 'tab-other', sessionName: session('tab-other'), name: 'o', order: 1 }]);
      return REAP;
    });
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input());

    expect(result).toEqual({ status: 500, body: expect.objectContaining({ code: 'restart-not-confirmed', reaped: { killed: 1, survivors: 0 } }) });
    expect(launcher.launchAgentInTab).not.toHaveBeenCalled();
    // The layout write that removed the tab emits its own tab-closed; the restart adds none.
    expect(events.filter((e) => e.startsWith('restart:'))).toEqual(['restart:tab-t:restarting', 'restart:tab-t:failed']);
    expect(await auditLines()).toEqual([expect.objectContaining({ outcome: 'failed', reaped: { killed: 1, survivors: 0 } })]);
  });

  it('a remote host that stops answering after the kill is restart-not-confirmed (exit 1), never 503', async () => {
    const { RemoteHostError } = await import('@/lib/remote-host');
    tmux.killSession.mockResolvedValue({ ...REAP, reaper: 'remote', sessionGone: true });
    tmux.hasSessionOrUnreachable
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new RemoteHostError('ai-server', 'remote host ai-server did not answer over ssh'));
    await writeLayout([claudeTab({ host: 'ai-server' })]);
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');

    const result = await restartTab(input());

    expect(result).toEqual({ status: 500, body: { error: 'remote host ai-server did not answer over ssh', code: 'restart-not-confirmed', tabId: 'tab-t', reaped: { killed: 1, survivors: 0 } } });
    expect(events).toEqual(['restart:tab-t:restarting', 'restart:tab-t:failed']);
    expect(await auditLines()).toEqual([expect.objectContaining({ outcome: 'failed', error: 'remote host ai-server did not answer over ssh' })]);
  });

  it('a remote kill that fails over ssh is restart-not-confirmed with unknown counts', async () => {
    const { RemoteHostError } = await import('@/lib/remote-host');
    tmux.killSession.mockRejectedValue(new RemoteHostError('ai-server', 'could not close the session on ai-server'));
    await writeLayout([claudeTab({ host: 'ai-server' })]);
    const { restartTab } = await import('@/lib/tab-restart');
    expect(await restartTab(input())).toEqual({
      status: 500,
      body: { error: 'could not close the session on ai-server', code: 'restart-not-confirmed', tabId: 'tab-t', reaped: null },
    });
  });

  it('integration: a terminal attached to the tab sees 4002, never 1000; the tab stays and no tab-closing fires', async () => {
    await writeLayout([claudeTab()]);
    const { EventEmitter } = await import('events');
    const ws = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
    tmux.sessionPresence.mockResolvedValue('present');
    const { handleConnection } = await import('@/lib/terminal-server');
    await handleConnection(ws as never, { url: '/api/terminal' } as never, session('tab-t'));
    expect(pty.exits).toHaveLength(1);
    tmux.killSession.mockImplementation(async () => {
      // The reap ends the attach client: its exit arrives while the restart is open.
      pty.exits[0]({ exitCode: 0 });
      tmux.sessionPresence.mockResolvedValue('absent');
      return REAP;
    });
    const events = await lifecycleEvents();
    const { restartTab } = await import('@/lib/tab-restart');

    expect((await restartTab(input())).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));

    expect(ws.close).toHaveBeenCalledWith(4002, 'Tab restarting');
    expect(ws.close).not.toHaveBeenCalledWith(1000, expect.anything());
    expect((await readTabs()).map((t) => t.id)).toEqual(['tab-t']);
    expect(events.filter((e) => e.startsWith('closing') || e.startsWith('closed'))).toEqual([]);
  });

  it('an unknown tab answers 404 tab-not-found', async () => {
    await writeLayout([claudeTab()]);
    const { restartTab } = await import('@/lib/tab-restart');
    expect(await restartTab(input({ tabId: 'tab-gone' }))).toEqual({ status: 404, body: { error: 'Tab not found', code: 'tab-not-found' } });
  });
});

describe('parseRestartRequest', () => {
  it('reads the query and both flags', async () => {
    const { parseRestartRequest } = await import('@/lib/tab-restart');
    expect(parseRestartRequest({ workspaceId: WS, tabId: 'tab-t' }, { clear: true })).toEqual({ ok: true, workspaceId: WS, tabId: 'tab-t', clear: true, interrupt: false });
    expect(parseRestartRequest({ workspaceId: WS, tabId: 'tab-t' }, undefined)).toEqual({ ok: true, workspaceId: WS, tabId: 'tab-t', clear: false, interrupt: false });
  });

  it.each([
    [{ tabId: 'tab-t' }, {}, 'workspaceId is required'],
    [{ workspaceId: WS }, {}, 'tabId is required'],
    [{ workspaceId: WS, tabId: 'tab-t' }, { clear: 'yes' }, 'clear must be a boolean'],
    [{ workspaceId: WS, tabId: 'tab-t' }, { interrupt: 1 }, 'interrupt must be a boolean'],
  ])('refuses %j %j', async (query, body, error) => {
    const { parseRestartRequest } = await import('@/lib/tab-restart');
    expect(parseRestartRequest(query, body)).toEqual({ ok: false, error });
  });
});
