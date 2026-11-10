import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFleetView, FLEET_CONFIG_KEYS, readFleetView, type IFleetDeps } from '@/lib/fleet-status-snapshot';
import { readComposer } from '@/lib/composer-readiness';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// ADR-0023: the server half — facts gathered from each store, attribution of
// SM-inbox items to the tab that opened them, partial failures, and a pane is
// only ever captured, never written.

const NOW = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;

const tab = (id: string, over: Partial<ITab> = {}): ITab => ({
  id, sessionName: `pt-ws-1-pane-p-${id}`, name: `name-${id}`, order: 0, panelType: 'claude-code', ...over,
} as ITab);
const status = (cliState: IClientTabStatusEntry['cliState'], over: Partial<IClientTabStatusEntry> = {}): IClientTabStatusEntry => ({
  cliState, workspaceId: 'ws-1', tabName: '', lastEvent: { name: 'stop', at: NOW - 40 * MIN, seq: 3 }, ...over,
} as IClientTabStatusEntry);

const CLAUDE_EMPTY = '● done\n\n\x1b[38;5;244m────\x1b[39m\n❯ \n\x1b[38;5;244m────\x1b[39m\n  ⏵⏵ bypass permissions on';
const CLAUDE_TYPED = '● done\n\n────\n❯ Read and execute your brief: /x/brief.md\n────\n  ⏵⏵ bypass permissions on';

let deps: IFleetDeps;
let capture: ReturnType<typeof vi.fn<(sessionName: string) => Promise<string | null>>>;

beforeEach(() => {
  (globalThis as unknown as { __ptFleetComposerSeen?: Map<string, number> }).__ptFleetComposerSeen?.clear();
  capture = vi.fn(async (session: string): Promise<string | null> => (session.endsWith('tab-typed') ? CLAUDE_TYPED : CLAUDE_EMPTY));
  deps = {
    workspaces: async () => [{ id: 'ws-1', name: 'Portfolio' }],
    agentTabs: async () => [
      tab('tab-busy'), tab('tab-typed'), tab('tab-idle'), tab('tab-remote', { host: 'host-b' }),
    ],
    statuses: () => ({
      'tab-busy': status('busy', { busySince: NOW - 3 * MIN, lastEvent: { name: 'prompt-submit', at: NOW - 3 * MIN, seq: 9 } }),
      'tab-typed': status('idle'),
      'tab-idle': status('ready-for-review', { readyForReviewAt: NOW - 40 * MIN }),
      'tab-remote': status('idle'),
    }),
    serverFacts: (id) => ({ jsonlPath: id === 'tab-busy' ? '/t/busy.jsonl' : null, stallReportedAt: null, inactiveSince: null }),
    watches: async () => [{ workspaceId: 'ws-1', tabId: 'tab-busy', kind: 'pr', target: 'o/r#1' }],
    liveJobs: async () => [],
    leases: async () => [
      { name: 'epic:lfr', kind: 'epic', resource: 'lfr', holder: { workspaceId: 'ws-1', tabId: 'tab-busy' }, epic: null },
      { name: 'merge:o/r', kind: 'merge', resource: 'o/r', holder: { workspaceId: 'ws-1', tabId: 'tab-idle' }, epic: 'masspay' },
    ] as never,
    openers: () => [
      { workspaceId: 'ws-1', itemId: 'i-1', createdAt: NOW - 45 * MIN, reviewed: false, opener: { tabId: 'tab-idle', identity: 'launch' } },
      { workspaceId: 'ws-1', itemId: 'i-2', createdAt: NOW - 50 * MIN, reviewed: false, opener: null },
      { workspaceId: 'ws-1', itemId: 'i-3', createdAt: NOW - 70 * MIN, reviewed: false, opener: { tabId: 'tab-closed', identity: 'session' } },
    ],
    capture,
    mtime: async () => NOW - 2 * MIN,
    config: async () => null,
    providerId: () => 'claude',
  };
});

const row = (view: Awaited<ReturnType<typeof buildFleetView>>, tabId: string) => view.rows.find((r) => r.tabId === tabId)!;

describe('buildFleetView', () => {
  it('derives a row per agent tab with the epic from its leases and the transcript mtime', async () => {
    const view = await buildFleetView(deps, NOW);
    expect(view.rows).toHaveLength(4);
    expect(row(view, 'tab-busy')).toMatchObject({ state: 'working', epic: 'lfr', lastActivityAt: NOW - 2 * MIN, providerId: 'claude' });
    expect(row(view, 'tab-idle').epic).toBe('masspay');
    expect(view.errors).toEqual([]);
  });

  it('reads each tab\'s lastRestartAt from the layout as restartedAt (ADR-0028)', async () => {
    deps.agentTabs = async () => [tab('tab-busy', { lastRestartAt: NOW - 7 * MIN }), tab('tab-idle')];
    const view = await buildFleetView(deps, NOW);
    expect(row(view, 'tab-busy').restartedAt).toBe(NOW - 7 * MIN);
    expect(row(view, 'tab-idle').restartedAt).toBeNull();
  });

  it('also captures a tab WAITING at its prompt, never a tab mid-turn', async () => {
    deps.agentTabs = async () => [tab('tab-waiting'), tab('tab-busy')];
    deps.statuses = () => ({
      'tab-waiting': status('busy', { lastEvent: { name: 'stop', at: NOW - 5 * MIN, seq: 4 }, turnEnd: { kind: 'waiting', at: NOW - 5 * MIN, seq: 4 } }),
      'tab-busy': status('busy', { lastEvent: { name: 'prompt-submit', at: NOW - MIN, seq: 9 } }),
    });
    await buildFleetView(deps, NOW);
    expect(capture.mock.calls.map(([s]) => s)).toEqual(['pt-ws-1-pane-p-tab-waiting']);
  });

  it('captures only local tabs at their prompt, and reads typed text as unsubmitted', async () => {
    const view = await buildFleetView(deps, NOW);
    expect(capture.mock.calls.map(([s]) => s).sort()).toEqual(['pt-ws-1-pane-p-tab-idle', 'pt-ws-1-pane-p-tab-typed']);
    expect(row(view, 'tab-typed')).toMatchObject({ state: 'unsubmitted', since: NOW });
    expect(row(view, 'tab-remote').state).toBe('idle');
  });

  it('dates composer text from an automated submission made after the last hook event', async () => {
    deps.agentTabs = async () => [tab('tab-typed', {
      orchestrationActivity: { sessionName: 'pt-ws-1-pane-p-tab-typed', runtimeGeneration: 'g', turn: { generation: 't', runtimeGeneration: 'g', at: NOW - 150 * MIN } },
    })];
    deps.statuses = () => ({ 'tab-typed': status('idle', { lastEvent: { name: 'session-start', at: NOW - 151 * MIN, seq: 1 } }) });
    const view = await buildFleetView(deps, NOW);
    expect(row(view, 'tab-typed')).toMatchObject({ state: 'unsubmitted', since: NOW - 150 * MIN });
    expect(row(view, 'tab-typed').flags.map((f) => f.flag)).toEqual(['stall']);
  });

  it('keeps the first-seen stamp across polls and forgets it once the composer empties', async () => {
    deps.agentTabs = async () => [tab('tab-typed')];
    await buildFleetView(deps, NOW);
    expect(row(await buildFleetView(deps, NOW + 3 * MIN), 'tab-typed')).toMatchObject({ since: NOW });
    capture.mockResolvedValue(CLAUDE_EMPTY);
    await buildFleetView(deps, NOW + 4 * MIN);
    capture.mockResolvedValue(CLAUDE_TYPED);
    expect(row(await buildFleetView(deps, NOW + 5 * MIN), 'tab-typed')).toMatchObject({ since: NOW + 5 * MIN });
  });

  it('attributes inbox items to their opener; an unknown or closed opener goes on the workspace line', async () => {
    const view = await buildFleetView(deps, NOW);
    expect(row(view, 'tab-idle').inbox).toEqual({ open: 1, unanswered: 1, oldestAt: NOW - 45 * MIN });
    expect(row(view, 'tab-busy').inbox).toEqual({ open: 0, unanswered: 0, oldestAt: null });
    expect(view.unattributed).toEqual([{
      workspaceId: 'ws-1', workspaceName: 'Portfolio',
      inbox: { open: 2, unanswered: 2, oldestAt: NOW - 70 * MIN },
      flags: [{ flag: 'unanswered', reason: '2 SM-inbox item(s) unanswered; oldest open 1 h 10 min' }],
    }]);
  });

  it('a failing store is named; the rows still render and no flag is raised on the missing fact', async () => {
    deps.watches = async () => { throw new Error('watches.json is malformed'); };
    deps.openers = () => { throw new Error('database is locked'); };
    deps.liveJobs = async () => { throw new Error('liveness unreadable'); };
    const view = await buildFleetView(deps, NOW);
    expect(view.errors).toEqual(expect.arrayContaining([
      { scope: 'watches', error: 'watches.json is malformed' },
      { scope: 'SM inbox', error: 'database is locked' },
      { scope: 'jobs', error: 'registered jobs could not be read for some tabs' },
    ]));
    // 40 min idle with no end line would flag, but the wait stores are unreadable.
    expect(row(view, 'tab-idle')).toMatchObject({ inbox: null, flags: [] });
    expect(view.unattributed).toEqual([]);
  });

  it('an unreadable workspace layout is named and the other workspaces still render', async () => {
    deps.workspaces = async () => [{ id: 'ws-1', name: 'Portfolio' }, { id: 'ws-2', name: 'Broken' }];
    deps.agentTabs = async (id) => (id === 'ws-2' ? null : [tab('tab-busy')]);
    const view = await buildFleetView(deps, NOW);
    expect(view.rows.map((r) => r.tabId)).toEqual(['tab-busy']);
    expect(view.errors).toEqual([{ scope: 'Broken', error: 'workspace layout could not be read', workspaceId: 'ws-2' }]);
  });

  it('a layout that throws names its workspace by id too, so a workspace named like a scope stays a workspace', async () => {
    deps.workspaces = async () => [{ id: 'ws-1', name: 'Portfolio' }, { id: 'ws-2', name: 'leases' }];
    deps.agentTabs = async (id) => {
      if (id === 'ws-2') throw new Error('EACCES');
      return [tab('tab-busy')];
    };
    const view = await buildFleetView(deps, NOW);
    expect(view.errors).toEqual([{ scope: 'leases', error: 'EACCES', workspaceId: 'ws-2' }]);
  });

  it('a status entry of another workspace is not this tab\'s status', async () => {
    deps.statuses = () => ({ 'tab-busy': status('busy', { workspaceId: 'ws-other' }) });
    deps.agentTabs = async () => [tab('tab-busy')];
    expect(row(await buildFleetView(deps, NOW), 'tab-busy').state).toBe('unknown');
  });

  it('reads each threshold from fleet config, falling back on a bad value', async () => {
    deps.config = async (key) => ({ [FLEET_CONFIG_KEYS.stallMinutes]: '10', [FLEET_CONFIG_KEYS.unansweredMinutes]: 'soon' })[key] ?? null;
    const view = await buildFleetView(deps, NOW);
    expect(view.thresholds).toEqual({ stallMinutes: 10, waitingLongMinutes: 120, unansweredMinutes: 30, composerMinutes: 2 });
  });
});

describe('buildFleetView: WIP per workspace (ADR-0027)', () => {
  it('counts each workspace\'s agent tabs against the fleet cap; an unread layout has no count', async () => {
    deps.workspaces = async () => [{ id: 'ws-1', name: 'Portfolio' }, { id: 'ws-2', name: 'Quiet' }, { id: 'ws-3', name: 'Broken' }];
    deps.agentTabs = async (id) => (id === 'ws-3' ? null : id === 'ws-2' ? [] : [tab('tab-a'), tab('tab-b', { host: 'host-b' }), tab('tab-c')]);
    deps.config = async (key) => (key === 'tabs.cap-per-workspace' ? '2' : null);
    const view = await buildFleetView(deps, NOW);
    expect(view.wip).toEqual({ 'ws-1': { count: 3, cap: 2, overCap: true }, 'ws-2': { count: 0, cap: 2, overCap: false } });
    expect(Object.keys(view.wip ?? {})).toEqual(['ws-1', 'ws-2']);
  });

  it('a workspace key overrides the fleet cap for that workspace only (story 17 AC 8)', async () => {
    deps.workspaces = async () => [{ id: 'ws-ldhziO', name: 'v2' }, { id: 'ws-2', name: 'Other' }];
    deps.agentTabs = async (id) => (id === 'ws-2' ? [tab('tab-x')] : [tab('tab-a'), tab('tab-b')]);
    deps.config = async (key) => ({ 'tabs.cap-per-workspace': '8', 'tabs.cap-per-workspace.ws-ldhziO': '14' })[key] ?? null;
    expect((await buildFleetView(deps, NOW)).wip).toEqual({ 'ws-ldhziO': { count: 2, cap: 14, overCap: false }, 'ws-2': { count: 1, cap: 8, overCap: false } });
  });

  it('defaults to a cap of 8', async () => {
    expect((await buildFleetView(deps, NOW)).wip).toEqual({ 'ws-1': { count: 4, cap: 8, overCap: false } });
  });

  it('a fleet config that cannot be read leaves wip out and names the error; the rows still render', async () => {
    deps.config = async () => { throw new Error('fleet-config.json is malformed'); };
    const view = await buildFleetView(deps, NOW);
    expect(view).not.toHaveProperty('wip');
    expect(view.errors).toContainEqual({ scope: 'WIP cap', error: 'fleet-config.json is malformed' });
    expect(view.rows).toHaveLength(4);
  });
});

describe('readFleetView', () => {
  it('reads at most once per 5 s; a failed read is not cached', async () => {
    const g = globalThis as unknown as { __ptFleetViewCache?: unknown };
    g.__ptFleetViewCache = undefined;
    const factory = vi.fn(async () => deps);
    await readFleetView(NOW, factory);
    await readFleetView(NOW + 4_999, factory);
    expect(factory).toHaveBeenCalledTimes(1);
    await readFleetView(NOW + 5_000, factory);
    expect(factory).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async (): Promise<IFleetDeps> => { throw new Error('boom'); });
    await expect(readFleetView(NOW + 20_000, failing)).rejects.toThrow('boom');
    await readFleetView(NOW + 20_001, factory);
    expect(factory).toHaveBeenCalledTimes(3);
    g.__ptFleetViewCache = undefined;
  });
});

describe('readComposer', () => {
  it('reads an empty composer, typed text, and a dim suggestion as empty', () => {
    expect(readComposer('claude-code', CLAUDE_EMPTY)).toBe('empty');
    expect(readComposer('claude-code', CLAUDE_TYPED)).toBe('text');
    expect(readComposer('claude-code', '────\n❯ \x1b[2mTry "fix lint"\x1b[22m\n────')).toBe('empty');
    expect(readComposer('codex-cli', '› \n')).toBe('empty');
    expect(readComposer('codex-cli', '› run the gate\n')).toBe('text');
  });

  it('finds the composer line of a typed brief that wraps over many lines', () => {
    const wrapped = ['────', '❯ Read and execute your brief', ...Array.from({ length: 30 }, (_, i) => `  line ${i}`), '────'].join('\n');
    expect(readComposer('claude-code', wrapped)).toBe('text');
  });

  it('no capture, no composer line, an open option list, or a shell is unreadable', () => {
    expect(readComposer('claude-code', null)).toBe('unreadable');
    expect(readComposer('claude-code', 'Loading…')).toBe('unreadable');
    expect(readComposer('claude-code', 'Do you want to proceed?\n❯ 1. Yes\n  2. No')).toBe('unreadable');
    expect(readComposer('terminal', '$ ')).toBe('unreadable');
  });
});

describe('the pool would-refuse counter on the fleet view (vel-D4 review r1 F1)', () => {
  const counter = { mode: 'shadow' as const, total: 2, since: new Date(NOW - 60 * MIN).toISOString(), byHost: { 'host-b-lan': { total: 2, byRefusal: { overloaded: 2 } } }, last: null };

  it('carries the counter when it is read', async () => {
    expect((await buildFleetView({ ...deps, poolWouldRefuse: async () => counter }, NOW)).pool).toEqual(counter);
  });

  it('a counter that cannot be read is left out and named; the rows still render', async () => {
    const view = await buildFleetView({ ...deps, poolWouldRefuse: async () => { throw new Error('fleet-config.json unreadable'); } }, NOW);
    expect(view.pool).toBeUndefined();
    expect(view.errors).toContainEqual({ scope: 'pool', error: 'fleet-config.json unreadable' });
    expect(view.rows.length).toBeGreaterThan(0);
  });

  it('no counter dep (an older caller) carries no pool field, never 0', async () => {
    expect(await buildFleetView(deps, NOW)).not.toHaveProperty('pool');
  });
});

describe('the tailnet paths in the fleet view (vel-RETRO-R2)', () => {
  const paths = [{
    host: 'exec-1',
    path: {
      kind: 'relayed' as const, alert: 'tailnet-relayed' as const, alias: 'exec-1', address: 'exec-1.tailnet.example', ip: 'fd7a:115c:a1e0::2', peer: 'exec-1',
      region: 'sin', rttMs: 1170, relayedReads: 2, slowMs: 250, measuredAt: new Date(NOW).toISOString(), reason: null,
    },
    text: 'exec-1 tailnet path relayed via DERP(sin), RTT 1170 ms',
  }];

  it('carries the paths when they are read', async () => {
    expect((await buildFleetView({ ...deps, poolPaths: async () => paths }, NOW)).poolPaths).toEqual(paths);
  });

  it('paths that cannot be read are left out and named as their own scope; the rows still render', async () => {
    const view = await buildFleetView({ ...deps, poolPaths: async () => { throw new Error('pool reader down'); } }, NOW);
    expect(view.poolPaths).toBeUndefined();
    expect(view.errors).toContainEqual({ scope: 'pool paths', error: 'pool reader down' });
    expect(view.rows.length).toBeGreaterThan(0);
  });

  it('no paths dep (an older caller) carries no field', async () => {
    expect(await buildFleetView(deps, NOW)).not.toHaveProperty('poolPaths');
  });
});

describe('rotation coverage in the fleet view (vel-D5 AC6)', () => {
  const seat = (key: string, attrs: Record<string, number | string | null>) => ({
    workspaceId: 'ws-1', itemKey: key, itemType: 'seat' as const, openedAt: 0, closedAt: null, state: 'watching', stateSince: 0, waitReason: null,
    waitSince: null, holder: key.split(':')[2], clearInput: null, parentKey: null, attrs, lastEventAt: 0, lastSeq: 1,
  });

  it('reports workers covered, rotations, refusals and wait-to-rotate from the layouts and the seat items', async () => {
    deps.agentTabs = async () => [tab('tab-seat', { handoffPath: '/h/a.md' }), tab('tab-off', { handoffPath: '/h/b.md', rotateAt: 'off' }), tab('tab-plain')];
    deps.seatItems = async () => [seat('seat:ws-1:name-tab-seat', { rotations: 2, checkpointRefusals: 1, waitToRotateTotalMs: 60_000, waitToRotateCount: 2 })];
    const view = await buildFleetView(deps, NOW);
    expect(view.rotation).toMatchObject({ workers: 3, covered: 1, rotations: 2, checkpointRefusals: 1, waitToRotateMeanMs: 30_000 });
    expect(view.rotation?.coverage).toBeCloseTo(1 / 3);
  });

  it('a seat store that cannot be read is an error of its own; the rows still render', async () => {
    deps.seatItems = async () => {
      throw new Error('ledger locked');
    };
    const view = await buildFleetView(deps, NOW);
    expect(view.rotation).toBeUndefined();
    expect(view.errors).toContainEqual({ scope: 'rotation', error: 'ledger locked' });
    expect(view.rows).toHaveLength(4);
  });

  it('a server without the seat read has no section', async () => {
    expect((await buildFleetView(deps, NOW)).rotation).toBeUndefined();
  });
});
