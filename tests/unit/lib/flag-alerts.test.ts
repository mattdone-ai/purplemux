import { readFileSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IFleetFlag, IFleetRow, IFleetView, TFleetFlag } from '@/types/fleet-status';
import type { IFlowHistoryRow, IFlowRecord, IFlowSnapshot } from '@/types/flow';
import type { IWorkspace } from '@/types/terminal';
import type { IFinderResult } from '@/types/constraint';
import type { TAlertDraft } from '@/lib/alert-policy';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: logs.info, warn: logs.warn, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const {
  DEFAULT_FLAG_REPEAT_MINUTES, FLAG_ALERT_CONFIG_KEYS, createFlagAlertState, flagKey, fleetFlagScan, flowFlagScan,
  parseFlagAlertConfig, poolFlagScan, pruneFlagSources, runFlagAlertTick, runScheduledFlagAlertTick, startFlagAlerts, stopFlagAlerts,
} = await import('@/lib/flag-alerts');
const { DEFAULT_FLOW_THRESHOLDS } = await import('@/lib/flow-flags');
const { resolveThresholds } = await import('@/lib/ledger-alarms');
type ITabEventRoute = import('@/lib/tab-event-router').ITabEventRoute;
type IFlagAlertDeps = import('@/lib/flag-alerts').IFlagAlertDeps;
type IFlagAlertConfig = import('@/lib/flag-alerts').IFlagAlertConfig;

const MIN = 60_000;
const T0 = 1_800_000_000_000;

const deriveFinderStub = (generatedAt: number, ledgerState: 'ok' | 'unknown', anomalies: IFinderResult['anomalies']): IFinderResult => ({
  generatedAt, onTrack: { state: 'at-risk', goal: null, goalState: 'none', itemsLeft: null, p50At: null, p90At: null, throughputPerDay: null, reason: 'no goal set' }, constraint: null, stuck: [], ownerBlocks: null,
  windows: [], anomalies, unknownShare: null, flowLocks: null, pool: null, line: '',
  inputs: {
    ledger: { state: ledgerState, reason: ledgerState === 'ok' ? null : 'ledger unreadable', at: null },
    flow: { state: 'unknown', reason: null, at: null }, spend: { state: 'unknown', reason: null, at: null }, pool: { state: 'unknown', reason: null, at: null },
  },
});

const workspace = (id: string, orchestratorTabId: string | null = 'tab-orch', enabled = true): IWorkspace => ({
  id,
  name: `name-${id}`,
  directories: [`/work/${id}`],
  orchestration: { enabled, orchestratorTabId },
});

const row = (workspaceId: string, tabId: string, flags: TFleetFlag[] = [], extra: Partial<IFleetRow> = {}): IFleetRow => ({
  workspaceId,
  workspaceName: `name-${workspaceId}`,
  tabId,
  tabName: `tab ${tabId}`,
  panelType: 'claude-code',
  providerId: 'codex',
  epic: null,
  state: 'working',
  rawCliState: 'busy',
  since: T0 - 40 * MIN,
  lastActivityAt: T0 - 40 * MIN,
  waits: [],
  lastLine: null,
  endLineUnknown: false,
  inbox: null,
  flags: flags.map((flag): IFleetFlag => ({ flag, reason: `${flag} reason on ${tabId}` })),
  ...extra,
});

const view = (rows: IFleetRow[], extra: Partial<IFleetView> = {}): IFleetView => ({
  at: T0,
  thresholds: { stallMinutes: 30, waitingLongMinutes: 120, unansweredMinutes: 30, composerMinutes: 2 },
  rows,
  unattributed: [],
  errors: [],
  ...extra,
});

const lockRow = (at: number): IFlowHistoryRow => ({ at, queues: {}, oldest: {}, locks: { landing: false }, meters: {} });

/** A fresh record whose `landing` queue holds `items` items (queue-long from 10 by default). */
const flowRecord = (workspaceId: string, items: number, receivedAt: number): IFlowRecord => {
  const snapshot: IFlowSnapshot = {
    schemaVersion: 1, generatedAt: receivedAt, source: 'v2-flow',
    queues: [{
      name: 'landing',
      capacity: null,
      items: Array.from({ length: items }, (_, i) => ({ id: `i${i}`, label: null, since: receivedAt - MIN, state: 'queued', pinned: false, holder: null })),
    }],
    locks: [{ name: 'landing', heldBy: null, since: null }],
    meters: [],
    flags: [],
  };
  return { workspaceId, receivedAt, snapshot, history: [lockRow(receivedAt - 400 * MIN), lockRow(receivedAt)] };
};

interface IScript {
  config: IFlagAlertConfig | Error;
  workspaces: IWorkspace[] | Error;
  view: IFleetView | Error;
  flows: Record<string, IFlowRecord | null | Error>;
  finder: Map<string, IFinderResult>;
  /** The portfolio Scrum Master selection (vel-RETRO-R2); an Error is an unreadable store. */
  seat: { managerWorkspaceId: string; managerTabId: string; workspaceIds: string[] } | null | Error;
}

const harness = (initial: Partial<IScript> = {}) => {
  const script: IScript = {
    config: { enabled: true, repeatMinutes: DEFAULT_FLAG_REPEAT_MINUTES },
    workspaces: [workspace('ws-a')],
    view: view([row('ws-a', 'tab-orch')]),
    flows: {},
    finder: new Map(),
    seat: null,
    ...initial,
  };
  const sent: Array<{ draft: TAlertDraft; workspaceDir: string | null | undefined }> = [];
  const reads = { fleet: 0, flow: [] as string[] };
  const routed: ITabEventRoute[] = [];
  const deps: IFlagAlertDeps = {
    config: async () => {
      if (script.config instanceof Error) throw script.config;
      return script.config;
    },
    workspaces: async () => {
      if (script.workspaces instanceof Error) throw script.workspaces;
      return script.workspaces;
    },
    fleetView: async () => {
      reads.fleet += 1;
      if (script.view instanceof Error) throw script.view;
      return script.view;
    },
    flowThresholds: async () => DEFAULT_FLOW_THRESHOLDS,
    readFlow: async (workspaceId) => {
      reads.flow.push(workspaceId);
      const value = script.flows[workspaceId] ?? null;
      if (value instanceof Error) throw value;
      return value;
    },
    finderResults: () => script.finder,
    dispatch: async (draft, ctx) => {
      sent.push({ draft, workspaceDir: ctx.workspaceDir });
    },
    ledgerRouting: async () => ({ routes: new Map(), thresholds: resolveThresholds(new Map()).thresholds }),
    routeTabEvent: async (event) => {
      routed.push(event);
      return { class: event.class, delivered: event.class === 'urgent', seq: routed.length, duplicate: false };
    },
    scrumMaster: async () => {
      if (script.seat instanceof Error) throw script.seat;
      return script.seat;
    },
    alarmCopies: async () => ({ held: false, lastDeliveredAt: null }),
  };
  const state = createFlagAlertState();
  const tick = (at: number) => runFlagAlertTick(deps, state, at);
  return { script, sent, reads, routed, deps, state, tick };
};

const keysOf = (drafts: Array<{ draft: TAlertDraft }>) => drafts.map(({ draft }) => draft.flag && flagKey({ ...draft.flag, workspaceId: draft.workspaceId }));

describe('parseFlagAlertConfig', () => {
  it('reads the switch on unless it is `off`, and the repeat window in 1..10080 minutes', () => {
    expect(FLAG_ALERT_CONFIG_KEYS).toEqual({ enabled: 'alerts.flags', repeatMinutes: 'alerts.flag-repeat-minutes' });
    expect(parseFlagAlertConfig(null, null)).toEqual({ config: { enabled: true, repeatMinutes: 60 }, reason: null });
    expect(parseFlagAlertConfig('off', null).config.enabled).toBe(false);
    expect(parseFlagAlertConfig(' off ', null).config.enabled).toBe(false);
    for (const on of ['on', 'yes', 'OFF', '0', '']) expect(parseFlagAlertConfig(on, null).config.enabled, on).toBe(true);
    expect(parseFlagAlertConfig(null, '1')).toEqual({ config: { enabled: true, repeatMinutes: 1 }, reason: null });
    expect(parseFlagAlertConfig(null, '10080').config.repeatMinutes).toBe(10_080);
    expect(parseFlagAlertConfig(null, ' 7.5 ').config.repeatMinutes).toBe(7.5);
  });

  it('reads a value outside the grammar or the range as the default, and says which and why', () => {
    for (const bad of ['0', '0.5', '10081', '-5', 'soon', '1e3', '']) {
      const { config, reason } = parseFlagAlertConfig(null, bad);
      expect(config.repeatMinutes, bad).toBe(60);
      expect(reason).toBe(`alerts.flag-repeat-minutes is ${JSON.stringify(bad)}, not a number in 1..10080; default 60`);
    }
  });
});

describe('fleetFlagScan', () => {
  const workspaces = [workspace('ws-a'), workspace('ws-b')];

  it('keys a tab flag by its tab and an unattributed flag by its workspace, each with the reads it rests on', () => {
    const scan = fleetFlagScan(view([row('ws-a', 'tab-1', ['stall', 'waiting-long'])], {
      unattributed: [{
        workspaceId: 'ws-b', workspaceName: 'name-ws-b', inbox: { open: 1, unanswered: 1, oldestAt: T0 - 40 * MIN },
        flags: [{ flag: 'unanswered', reason: '1 SM-inbox item(s) unanswered; oldest open 40 min' }],
      }],
    }), workspaces);
    expect(scan.flags).toEqual([
      { key: 'fleet:ws-a:stall:tab-1', source: 'fleet', workspaceId: 'ws-a', rule: 'stall', subject: 'tab-1', text: 'stall reason on tab-1', tabId: 'tab-1',
        sources: ['fleet-view', 'layout:ws-a', 'tab:ws-a/tab-1', 'waits'], raiseSources: ['fleet-view', 'layout:ws-a', 'tab:ws-a/tab-1'] },
      { key: 'fleet:ws-a:waiting-long:tab-1', source: 'fleet', workspaceId: 'ws-a', rule: 'waiting-long', subject: 'tab-1',
        text: 'waiting-long reason on tab-1', tabId: 'tab-1', sources: ['fleet-view', 'layout:ws-a', 'tab:ws-a/tab-1'],
        raiseSources: ['fleet-view', 'layout:ws-a', 'tab:ws-a/tab-1'] },
      { key: 'fleet:ws-b:unanswered:ws-b', source: 'fleet', workspaceId: 'ws-b', rule: 'unanswered', subject: 'ws-b',
        text: '1 SM-inbox item(s) unanswered; oldest open 40 min', tabId: null, sources: ['fleet-view', 'layout:ws-b', 'sm-inbox'],
        raiseSources: ['fleet-view', 'layout:ws-b', 'sm-inbox'] },
    ]);
    expect([...scan.read].sort()).toEqual(['fleet-view', 'layout:ws-a', 'layout:ws-b', 'sm-inbox', 'tab:ws-a/tab-1', 'waits']);
    expect([...scan.failed]).toEqual([]);
  });

  it('ties a raise to the waits only for the idle STALL?, and to the SM inbox only for an UNANSWERED with an inbox clause', () => {
    const raiseOf = (r: IFleetRow) => fleetFlagScan(view([r]), workspaces).flags.map((f) => `${f.rule} ${f.raiseSources.slice(3).join(',')}`);
    for (const state of ['working', 'needs-input', 'inactive', 'unsubmitted', 'waiting'] as const) {
      expect(raiseOf(row('ws-a', 'tab-1', ['stall'], { state })), state).toEqual(['stall ']);
    }
    expect(raiseOf(row('ws-a', 'tab-1', ['stall'], { state: 'idle' }))).toEqual(['stall waits']);
    expect(raiseOf(row('ws-a', 'tab-1', ['stall'], { state: 'ready-for-review' }))).toEqual(['stall waits']);
    expect(raiseOf(row('ws-a', 'tab-1', ['unanswered'], { state: 'ended', inbox: null }))).toEqual(['unanswered ']);
    expect(raiseOf(row('ws-a', 'tab-1', ['unanswered'], { state: 'ended', inbox: { open: 2, unanswered: 0, oldestAt: T0 } }))).toEqual(['unanswered ']);
    expect(raiseOf(row('ws-a', 'tab-1', ['unanswered'], { inbox: { open: 1, unanswered: 1, oldestAt: T0 - 40 * MIN } }))).toEqual(['unanswered sm-inbox']);
    for (const r of [row('ws-a', 'tab-1', ['stall']), row('ws-a', 'tab-1', ['unanswered'])]) {
      expect(fleetFlagScan(view([r]), workspaces).flags[0].sources.slice(3)).toHaveLength(1);
    }
  });

  it('fails the sources each read error hides, by the structured workspaceId, never by a name match', () => {
    const failedOf = (errors: IFleetView['errors'], rows: IFleetRow[] = []) => [...fleetFlagScan(view(rows, { errors }), workspaces).failed].sort();
    expect(failedOf([{ scope: 'leases', error: 'x' }, { scope: 'WIP cap', error: 'y' }])).toEqual([]);
    expect(failedOf([{ scope: 'name-ws-b', error: 'workspace layout could not be read', workspaceId: 'ws-b' }])).toEqual(['layout:ws-b']);
    expect(failedOf([{ scope: 'SM inbox', error: 'x' }])).toEqual(['sm-inbox']);
    expect(failedOf([{ scope: 'watches', error: 'x' }, { scope: 'jobs', error: 'y' }])).toEqual(['waits']);
    expect(failedOf([{ scope: 'a scope this build does not know', error: 'x' }])).toEqual(['fleet-view']);
    expect(failedOf([], [row('ws-a', 'tab-1', [], { state: 'unknown' })])).toEqual(['tab:ws-a/tab-1']);
    expect([...fleetFlagScan(null, workspaces).failed]).toEqual(['fleet-view']);
    expect([...fleetFlagScan(null, workspaces).read]).toEqual([]);
  });

  it('a workspace named `leases` whose layout fails is that workspace, not the `leases` scope', () => {
    const named = [{ ...workspace('ws-l'), name: 'leases' }, workspace('ws-a')];
    const scan = fleetFlagScan(view([row('ws-a', 'tab-1')], {
      errors: [{ scope: 'leases', error: 'workspace layout could not be read', workspaceId: 'ws-l' }, { scope: 'leases', error: 'lease store unreadable' }],
    }), named);
    expect([...scan.failed]).toEqual(['layout:ws-l']);
    expect(scan.read.has('layout:ws-a')).toBe(true);
    expect(scan.read.has('layout:ws-l')).toBe(false);
  });
});

describe('flowFlagScan', () => {
  it('derives the flags of every record from the record itself; no record is a good read, an unreadable one is failed', () => {
    const scan = flowFlagScan([
      { workspaceId: 'ws-a', record: flowRecord('ws-a', 12, T0 - MIN) },
      { workspaceId: 'ws-b', record: null },
      { workspaceId: 'ws-c', error: 'flow storage unreadable: the file is not JSON' },
    ], DEFAULT_FLOW_THRESHOLDS, T0);
    expect(scan.flags).toEqual([{
      key: 'flow:ws-a:queue-long:landing', source: 'flow', workspaceId: 'ws-a', rule: 'queue-long', subject: 'landing',
      text: 'landing holds 12 items (threshold 10)', tabId: null, sources: ['flow:ws-a'], raiseSources: ['flow:ws-a'],
    }]);
    expect([...scan.read]).toEqual(['flow:ws-a', 'flow:ws-b']);
    expect([...scan.failed]).toEqual(['flow:ws-c']);
  });

  it('raises only `stale` on a stale record, whatever else it holds', () => {
    const scan = flowFlagScan([{ workspaceId: 'ws-a', record: flowRecord('ws-a', 30, T0 - 11 * MIN) }], DEFAULT_FLOW_THRESHOLDS, T0);
    expect(scan.flags.map((f) => f.key)).toEqual(['flow:ws-a:stale:ws-a']);
    expect(scan.flags[0].text).toBe('no publish for 11 min');
  });
});

describe('runFlagAlertTick — a scripted sequence', () => {
  beforeEach(() => {
    logs.warn.mockClear();
    logs.info.mockClear();
  });

  it('records the first tick as the baseline and sends nothing, then alerts once on each raise edge', async () => {
    const h = harness({
      view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]),
      flows: { 'ws-a': flowRecord('ws-a', 12, T0 - MIN) },
    });
    const first = await h.tick(T0);
    expect(first).toEqual({ baseline: true, sent: [], noTarget: [], targetUnknown: [], routed: [] });
    expect(h.sent).toEqual([]);

    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall', 'unanswered'])]);
    const second = await h.tick(T0 + MIN);
    expect(second.baseline).toBe(false);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-a:unanswered:tab-1']);

    await h.tick(T0 + 2 * MIN);
    await h.tick(T0 + 3 * MIN);
    expect(h.sent).toHaveLength(1);
  });

  it('sends the payload the contract names: kind flag, the flag object, the flagged tab', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]) });
    await h.tick(T0);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['waiting-long'])]);
    await h.tick(T0 + MIN);
    expect(h.sent).toEqual([{
      workspaceDir: '/work/ws-a',
      draft: {
        kind: 'flag',
        tabId: 'tab-1',
        workspaceId: 'ws-a',
        workspaceName: 'name-ws-a',
        tabName: 'tab tab-1',
        providerId: 'codex',
        isOrchestrator: false,
        title: 'Flag Raised',
        body: 'tab tab-1: waiting-long reason on tab-1',
        at: T0 + MIN,
        flag: { source: 'fleet', rule: 'waiting-long', subject: 'tab-1', text: 'waiting-long reason on tab-1' },
      },
    }]);
  });

  it('sends a flow flag and a workspace-level fleet flag to the enabled orchestrator tab', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch', [], { providerId: 'grok' })]) });
    await h.tick(T0);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0) };
    h.script.view = view([row('ws-a', 'tab-orch', [], { providerId: 'grok' })], {
      unattributed: [{ workspaceId: 'ws-a', workspaceName: 'name-ws-a', inbox: { open: 1, unanswered: 1, oldestAt: T0 - 40 * MIN },
        flags: [{ flag: 'unanswered', reason: '1 SM-inbox item(s) unanswered; oldest open 40 min' }] }],
    });
    await h.tick(T0 + MIN);
    expect(h.sent.map(({ draft }) => ({ tabId: draft.tabId, isOrchestrator: draft.isOrchestrator, providerId: draft.providerId, body: draft.body, flag: draft.flag })))
      .toEqual([
        { tabId: 'tab-orch', isOrchestrator: true, providerId: 'grok', body: '1 SM-inbox item(s) unanswered; oldest open 40 min',
          flag: { source: 'fleet', rule: 'unanswered', subject: 'ws-a', text: '1 SM-inbox item(s) unanswered; oldest open 40 min' } },
        { tabId: 'tab-orch', isOrchestrator: true, providerId: 'grok', body: 'landing holds 12 items (threshold 10)',
          flag: { source: 'flow', rule: 'queue-long', subject: 'landing', text: 'landing holds 12 items (threshold 10)' } },
      ]);
  });

  /** A finder answer computed at `at` with one re-gates anomaly: value null is unknown, above 0 is breached. */
  const finderResult = (at: number, value: number | null, ledgerState: 'ok' | 'unknown' = 'ok'): IFinderResult => {
    const text = value === null ? 're-gates: unknown (no gate item in the ledger) in 24h, threshold 0 gates' : `re-gates: ${value} gates in 24h, threshold 0 gates`;
    return deriveFinderStub(at, ledgerState, [{
      id: 're-gates', subject: 'workspace', value, unit: 'gates', threshold: 0, judged: value !== null, breached: value !== null && value > 0,
      window: '24h', text,
      reason: value === null ? 'no gate item in the ledger' : null,
    }]);
  };
  const finder = (at: number, value: number | null, ledgerState: 'ok' | 'unknown' = 'ok') => new Map([['ws-a', finderResult(at, value, ledgerState)]]);
  const LEDGER_KEY = 'ledger:ws-a:re-gates:workspace';

  it('sends a breached finder anomaly as source ledger to the enabled orchestrator (ADR-0034, AC 6)', async () => {
    const h = harness({ finder: finder(T0, 0) });
    expect((await h.tick(T0)).baseline).toBe(true);
    h.script.finder = finder(T0 + MIN, 3);
    await h.tick(T0 + MIN);
    expect(h.sent.map(({ draft }) => ({ tabId: draft.tabId, isOrchestrator: draft.isOrchestrator, flag: draft.flag }))).toEqual([{
      tabId: 'tab-orch', isOrchestrator: true,
      flag: { source: 'ledger', rule: 're-gates', subject: 'workspace', text: 're-gates: 3 gates in 24h, threshold 0 gates' },
    }]);
    expect(h.routed).toEqual([{ workspaceId: 'ws-a', tabId: 'tab-orch', kind: 'flag', text: 're-gates: 3 gates in 24h, threshold 0 gates', class: 'digest', rule: 're-gates' }]);
    h.script.finder = finder(T0 + 2 * MIN, 3);
    await h.tick(T0 + 2 * MIN);
    expect(h.sent).toHaveLength(1);
    expect(h.routed).toHaveLength(1);
  });

  it('neither raises nor clears a ledger flag while the finder has no answer or could not read the ledger', async () => {
    const h = harness();
    await h.tick(T0);
    h.script.finder = finder(T0 + MIN, 3, 'unknown');
    await h.tick(T0 + MIN);
    expect(h.sent).toEqual([]);
    h.script.finder = finder(T0 + 2 * MIN, 3);
    await h.tick(T0 + 2 * MIN);
    expect(h.sent).toEqual([]);
    h.script.finder = finder(T0 + 3 * MIN, 0);
    await h.tick(T0 + 3 * MIN);
    h.script.finder = finder(T0 + 4 * MIN, 3);
    await h.tick(T0 + 4 * MIN);
    expect(h.sent.map(({ draft }) => draft.flag?.source)).toEqual(['ledger']);
  });

  it('keeps a raised ledger flag standing while its anomaly reads unknown; a measured value clears it (F5)', async () => {
    const h = harness({ finder: finder(T0, 0) });
    await h.tick(T0);
    h.script.finder = finder(T0 + MIN, 3);
    await h.tick(T0 + MIN);
    expect(h.state.entries.get(LEDGER_KEY)?.raisedAt).toBe(T0 + MIN);
    h.script.finder = finder(T0 + 2 * MIN, null);
    await h.tick(T0 + 2 * MIN);
    expect(h.state.entries.get(LEDGER_KEY)?.raisedAt).toBe(T0 + MIN);
    h.script.finder = finder(T0 + 3 * MIN, 0);
    await h.tick(T0 + 3 * MIN);
    expect(h.state.entries.get(LEDGER_KEY)?.raisedAt).toBeNull();
    expect(h.sent).toHaveLength(1);
  });

  it('keeps a raised producer-silence flag while its threshold is unknown (fewer than 20 closed items)', async () => {
    const silence = (at: number, value: number, threshold: number | null) => new Map([['ws-a', deriveFinderStub(at, 'ok', [{
      id: 'producer-silence', subject: 'gate.sh', value, unit: 'min', threshold, judged: threshold !== null,
      breached: threshold !== null && value > threshold, window: 'now', reason: threshold === null ? 'fewer than 20 gate items closed in 7 d: not flagged' : null,
      text: `producer silence gate.sh: gate:t:1 silent for ${value} min (threshold ${threshold ?? 'unknown'})`,
    }])]]);
    const key = 'ledger:ws-a:producer-silence:gate.sh';
    const h = harness({ finder: silence(T0, 5, 30) });
    await h.tick(T0);
    h.script.finder = silence(T0 + MIN, 35, 30);
    await h.tick(T0 + MIN);
    expect(h.sent).toHaveLength(1);
    h.script.finder = silence(T0 + 2 * MIN, 36, null);
    await h.tick(T0 + 2 * MIN);
    expect(h.state.entries.get(key)?.raisedAt).toBe(T0 + MIN);
    h.script.finder = silence(T0 + 3 * MIN, 1, 30);
    await h.tick(T0 + 3 * MIN);
    expect(h.state.entries.get(key)?.raisedAt).toBeNull();
  });

  it('forgets an anomaly subject the finder no longer reports, and keeps one it reports as unknown', async () => {
    const h = harness({ finder: finder(T0, 0) });
    await h.tick(T0);
    const subject = 'ledger:ws-a/re-gates/workspace';
    expect(h.state.readSources.has(subject)).toBe(true);
    h.script.finder = finder(T0 + MIN, null);
    await h.tick(T0 + MIN);
    expect(h.state.readSources.has(subject)).toBe(true);
    h.script.finder = new Map([['ws-a', deriveFinderStub(T0 + 2 * MIN, 'ok', [])]]);
    await h.tick(T0 + 2 * MIN);
    expect(h.state.readSources.has(subject)).toBe(false);
    expect(h.state.readSources.has('ledger:ws-a')).toBe(true);
  });

  it('treats a finder answer older than two ticks as unread: it neither raises nor clears (F6)', async () => {
    const h = harness({ finder: finder(T0, 0) });
    await h.tick(T0);
    h.script.finder = finder(T0, 3);
    await h.tick(T0 + 2 * MIN + 1);
    expect(h.sent).toEqual([]);
    h.script.finder = finder(T0 + 3 * MIN, 3);
    await h.tick(T0 + 3 * MIN);
    expect(h.sent).toHaveLength(1);
    h.script.finder = finder(T0 + 3 * MIN, 0);
    await h.tick(T0 + 6 * MIN);
    expect(h.state.entries.get(LEDGER_KEY)?.raisedAt).toBe(T0 + 3 * MIN);
  });

  it('sends nothing for a workspace-level flag with no orchestrator, a disabled one, or one the fleet view does not show; it logs flag-alert-no-target', async () => {
    const h = harness({
      workspaces: [workspace('ws-none', null), workspace('ws-off', 'tab-orch', false), workspace('ws-gone', 'tab-closed')],
      view: view([row('ws-off', 'tab-orch'), row('ws-gone', 'tab-other')]),
    });
    await h.tick(T0);
    h.script.flows = Object.fromEntries(['ws-none', 'ws-off', 'ws-gone'].map((id) => [id, flowRecord(id, 12, T0)]));
    const result = await h.tick(T0 + MIN);
    expect(h.sent).toEqual([]);
    expect(result.noTarget).toEqual(['flow:ws-none:queue-long:landing', 'flow:ws-off:queue-long:landing', 'flow:ws-gone:queue-long:landing']);
    expect(result.targetUnknown).toEqual([]);
    for (const [workspaceId, reason] of [['ws-none', 'no-orchestrator'], ['ws-off', 'orchestrator-disabled'], ['ws-gone', 'tab-closed']]) {
      expect(logs.warn).toHaveBeenCalledWith({ key: `flow:${workspaceId}:queue-long:landing`, workspaceId, reason }, 'flag-alert-no-target');
    }
    expect(logs.warn.mock.calls.filter((call) => call[1] === 'flag-alert-no-target')).toHaveLength(3);

    await h.tick(T0 + 2 * MIN);
    expect(logs.warn.mock.calls.filter((call) => call[1] === 'flag-alert-no-target')).toHaveLength(3);
  });

  it('re-alerts a flag that clears and is raised again only once the repeat window since its last alert has passed', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]) });
    const flagged = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    const clear = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]);
    await h.tick(T0);
    h.script.view = flagged;
    await h.tick(T0 + MIN);
    expect(h.sent).toHaveLength(1);

    h.script.view = clear;
    await h.tick(T0 + 2 * MIN);
    h.script.view = flagged;
    await h.tick(T0 + 30 * MIN);
    expect(h.sent).toHaveLength(1);

    h.script.view = clear;
    await h.tick(T0 + 40 * MIN);
    h.script.view = flagged;
    await h.tick(T0 + 61 * MIN);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1].draft.at).toBe(T0 + 61 * MIN);
  });

  it('reads the repeat window from fleet config', async () => {
    const h = harness({ config: { enabled: true, repeatMinutes: 5 }, view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]) });
    const flagged = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    const clear = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]);
    await h.tick(T0);
    for (const [at, v] of [[1, flagged], [2, clear], [4, flagged], [5, clear], [6, flagged]] as const) {
      h.script.view = v;
      await h.tick(T0 + at * MIN);
    }
    expect(h.sent.map(({ draft }) => draft.at)).toEqual([T0 + MIN, T0 + 6 * MIN]);
  });

  it('alerts a new raise of a flag that never alerted (it stood at baseline) at once after it clears', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]) });
    await h.tick(T0);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]);
    await h.tick(T0 + MIN);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    await h.tick(T0 + 2 * MIN);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-a:stall:tab-1']);
  });

  it('switched off: sends nothing and reads nothing; switched on: starts from a fresh baseline', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]) });
    await h.tick(T0);
    h.script.config = { enabled: false, repeatMinutes: 60 };
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + MIN) };
    const reads = h.reads.fleet;
    expect(await h.tick(T0 + MIN)).toEqual({ skipped: 'off', baseline: false, sent: [], noTarget: [], targetUnknown: [], routed: [] });
    expect(h.reads.fleet).toBe(reads);
    expect(h.sent).toEqual([]);

    h.script.config = { enabled: true, repeatMinutes: 60 };
    expect((await h.tick(T0 + 2 * MIN)).baseline).toBe(true);
    expect(h.sent).toEqual([]);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall', 'waiting-long'])]);
    await h.tick(T0 + 3 * MIN);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-a:waiting-long:tab-1']);
  });

  it('an unreadable fleet config skips the tick and keeps the state', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]) });
    await h.tick(T0);
    h.script.config = new Error('fleet-config.json is not JSON');
    expect(await h.tick(T0 + MIN)).toEqual({ skipped: 'config-unreadable', baseline: false, sent: [], noTarget: [], targetUnknown: [], routed: [] });
    expect(logs.warn).toHaveBeenCalledWith('flag alert tick skipped: fleet config unreadable (fleet-config.json is not JSON)');
    h.script.config = { enabled: true, repeatMinutes: 60 };
    await h.tick(T0 + 2 * MIN);
    expect(h.sent).toEqual([]);
  });

  it('unreadable workspaces skip the tick', async () => {
    const h = harness({ workspaces: new Error('EACCES') });
    expect(await h.tick(T0)).toEqual({ skipped: 'workspaces-unreadable', baseline: false, sent: [], noTarget: [], targetUnknown: [], routed: [] });
    expect(h.state.readSources.size).toBe(0);
  });

  it('an unreadable store raises nothing and clears nothing: the flag it hid does not alert again when the read recovers', async () => {
    const h = harness({
      view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]),
      flows: { 'ws-a': flowRecord('ws-a', 12, T0) },
    });
    await h.tick(T0);

    h.script.view = new Error('status manager gone');
    h.script.flows = { 'ws-a': new Error('flow storage unreadable: EIO') };
    const blind = await h.tick(T0 + MIN);
    expect(blind.sent).toEqual([]);
    expect(blind.noTarget).toEqual([]);

    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + 2 * MIN) };
    await h.tick(T0 + 2 * MIN);
    expect(h.sent).toEqual([]);
  });

  it('a layout read error hides only its workspace; another workspace still alerts', async () => {
    const h = harness({
      workspaces: [workspace('ws-a'), workspace('ws-b')],
      view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall']), row('ws-b', 'tab-orch'), row('ws-b', 'tab-2')]),
    });
    await h.tick(T0);
    h.script.view = view([row('ws-b', 'tab-orch'), row('ws-b', 'tab-2', ['stall'])], {
      errors: [{ scope: 'name-ws-a', error: 'workspace layout could not be read', workspaceId: 'ws-a' }],
    });
    await h.tick(T0 + MIN);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-b:stall:tab-2']);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall']), row('ws-b', 'tab-orch'), row('ws-b', 'tab-2', ['stall'])]);
    await h.tick(T0 + 2 * MIN);
    expect(h.sent).toHaveLength(1);
  });

  it('a stale flow raises only its `stale` flag', async () => {
    const h = harness({ flows: { 'ws-a': flowRecord('ws-a', 2, T0) } });
    await h.tick(T0);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 30, T0 + MIN) };
    await h.tick(T0 + 12 * MIN);
    expect(keysOf(h.sent)).toEqual(['flow:ws-a:stale:ws-a']);
    expect(h.sent[0].draft.flag?.text).toBe('no publish for 11 min');
  });

  it('a source first read late records what stands in it: the fleet view down for 3 boot ticks, then 3 standing flags → no alert', async () => {
    const h = harness({ view: new Error('booting'), flows: { 'ws-a': flowRecord('ws-a', 2, T0) } });
    for (const at of [0, 1, 2]) await h.tick(T0 + at * MIN);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall', 'waiting-long']), row('ws-a', 'tab-2', ['unanswered'])]);
    const recovered = await h.tick(T0 + 3 * MIN);
    expect(recovered.baseline).toBe(false);
    expect(h.sent).toEqual([]);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + 4 * MIN) };
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall', 'waiting-long']), row('ws-a', 'tab-2', ['unanswered', 'stall'])]);
    await h.tick(T0 + 4 * MIN);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-a:stall:tab-2', 'flow:ws-a:queue-long:landing']);
  });

  it('per source: a flow record first readable late records its standing flags, while the fleet keeps alerting', async () => {
    const h = harness({ flows: { 'ws-a': new Error('flow storage unreadable: EIO') }, view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]) });
    for (const at of [0, 1, 2, 3]) await h.tick(T0 + at * MIN);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + 4 * MIN) };
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    await h.tick(T0 + 4 * MIN);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-a:stall:tab-1']);
  });

  it('a tab first known late, or an SM inbox first read late, records what stands', async () => {
    const h = harness({
      view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', [], { state: 'unknown' })], { errors: [{ scope: 'SM inbox', error: 'locked' }] }),
    });
    for (const at of [0, 1, 2, 3]) await h.tick(T0 + at * MIN);
    h.script.view = view([
      row('ws-a', 'tab-orch', ['unanswered'], { inbox: { open: 1, unanswered: 1, oldestAt: T0 - 40 * MIN } }),
      row('ws-a', 'tab-1', ['waiting-long']),
    ]);
    await h.tick(T0 + 4 * MIN);
    expect(h.sent).toEqual([]);
  });

  it('forgets the sources of a closed tab and a closed workspace', async () => {
    const h = harness({ workspaces: [workspace('ws-a'), workspace('ws-b')], view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1'), row('ws-b', 'tab-orch')]) });
    await h.tick(T0);
    expect(h.state.readSources.has('tab:ws-a/tab-1')).toBe(true);
    h.script.workspaces = [workspace('ws-a')];
    h.script.view = view([row('ws-a', 'tab-orch')]);
    await h.tick(T0 + MIN);
    expect([...h.state.readSources].sort()).toEqual(['fleet-view', 'flow:ws-a', 'layout:ws-a', 'sm-inbox', 'tab:ws-a/tab-orch', 'waits']);
    h.script.view = view([], { errors: [{ scope: 'name-ws-a', error: 'workspace layout could not be read', workspaceId: 'ws-a' }] });
    await h.tick(T0 + 2 * MIN);
    expect(h.state.readSources.has('tab:ws-a/tab-orch')).toBe(true);
  });

  it('a raise whose target cannot be checked (fleet view down) is retried: one alert on the next readable tick', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch')]) });
    await h.tick(T0);
    h.script.view = new Error('status manager busy');
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + MIN) };
    const pending = await h.tick(T0 + MIN);
    expect(pending.targetUnknown).toEqual(['flow:ws-a:queue-long:landing']);
    expect(pending.noTarget).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith({ key: 'flow:ws-a:queue-long:landing', workspaceId: 'ws-a', reason: 'fleet-view-unreadable' },
      'flag-alert-target-unknown');
    expect(h.sent).toEqual([]);
    h.script.view = view([row('ws-a', 'tab-orch')]);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + 2 * MIN) };
    await h.tick(T0 + 2 * MIN);
    await h.tick(T0 + 3 * MIN);
    expect(keysOf(h.sent)).toEqual(['flow:ws-a:queue-long:landing']);
    expect(h.sent[0].draft.at).toBe(T0 + 2 * MIN);
  });

  it('a raise on a tick whose workspace layout fails, or whose orchestrator row is in state unknown, is retried until it can be checked', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch')]) });
    await h.tick(T0);
    h.script.view = view([], { errors: [{ scope: 'name-ws-a', error: 'workspace layout could not be read', workspaceId: 'ws-a' }] });
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + MIN) };
    expect((await h.tick(T0 + MIN)).targetUnknown).toEqual(['flow:ws-a:queue-long:landing']);
    h.script.view = view([row('ws-a', 'tab-orch', [], { state: 'unknown' })]);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + 2 * MIN) };
    expect((await h.tick(T0 + 2 * MIN)).targetUnknown).toEqual(['flow:ws-a:queue-long:landing']);
    expect(logs.warn).toHaveBeenCalledWith({ key: 'flow:ws-a:queue-long:landing', workspaceId: 'ws-a', reason: 'layout-unreadable' }, 'flag-alert-target-unknown');
    expect(logs.warn).toHaveBeenCalledWith({ key: 'flow:ws-a:queue-long:landing', workspaceId: 'ws-a', reason: 'tab-state-unknown' }, 'flag-alert-target-unknown');
    h.script.view = view([row('ws-a', 'tab-orch')]);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + 3 * MIN) };
    await h.tick(T0 + 3 * MIN);
    await h.tick(T0 + 4 * MIN);
    expect(keysOf(h.sent)).toEqual(['flow:ws-a:queue-long:landing']);
  });

  it('an idle STALL? seen on a tick whose jobs store failed is not raised then; it alerts once on the next good read', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', [], { state: 'idle' })]) });
    await h.tick(T0);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'], { state: 'idle' })], { errors: [{ scope: 'jobs', error: 'registered jobs could not be read for some tabs' }] });
    expect((await h.tick(T0 + MIN)).sent).toEqual([]);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'], { state: 'idle' })]);
    await h.tick(T0 + 2 * MIN);
    await h.tick(T0 + 3 * MIN);
    expect(h.sent.map(({ draft }) => draft.at)).toEqual([T0 + 2 * MIN]);
  });

  it('a non-idle STALL? raises while the jobs store fails (the waits cannot make it false)', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1'), row('ws-a', 'tab-2', [], { state: 'needs-input' })]) });
    await h.tick(T0);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall']), row('ws-a', 'tab-2', ['stall'], { state: 'needs-input' })], {
      errors: [{ scope: 'jobs', error: 'registered jobs could not be read for some tabs' }, { scope: 'watches', error: 'x' }],
    });
    await h.tick(T0 + MIN);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-a:stall:tab-1', 'fleet:ws-a:stall:tab-2']);
  });

  it('while the SM inbox fails, a question-line UNANSWERED raises and an inbox-clause UNANSWERED does not', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1'), row('ws-a', 'tab-2')]) });
    await h.tick(T0);
    h.script.view = view([
      row('ws-a', 'tab-orch'),
      row('ws-a', 'tab-1', ['unanswered'], { state: 'ended', inbox: null }),
      row('ws-a', 'tab-2', ['unanswered'], { inbox: { open: 1, unanswered: 1, oldestAt: T0 - 40 * MIN } }),
    ], {
      errors: [{ scope: 'SM inbox', error: 'database is locked' }],
      unattributed: [{ workspaceId: 'ws-a', workspaceName: 'name-ws-a', inbox: { open: 1, unanswered: 1, oldestAt: T0 - 40 * MIN },
        flags: [{ flag: 'unanswered', reason: '1 SM-inbox item(s) unanswered; oldest open 40 min' }] }],
    });
    await h.tick(T0 + MIN);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-a:unanswered:tab-1']);
  });

  it('no flag clears on a failed read: a raised STALL? absent while the waits fail stays raised and does not alert again', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]) });
    await h.tick(T0);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    await h.tick(T0 + MIN);
    expect(h.sent).toHaveLength(1);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', [], { state: 'idle' })], { errors: [{ scope: 'watches', error: 'x' }] });
    await h.tick(T0 + 2 * MIN);
    expect(h.state.entries.get('fleet:ws-a:stall:tab-1')?.raisedAt).toBe(T0 + MIN);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'], { state: 'idle' })]);
    await h.tick(T0 + 70 * MIN);
    expect(h.sent).toHaveLength(1);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', [], { state: 'idle' })]);
    await h.tick(T0 + 71 * MIN);
    expect(h.state.entries.has('fleet:ws-a:stall:tab-1')).toBe(false);
  });

  it('a pending raise whose flag clears before the target can be checked sends nothing', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch')]) });
    await h.tick(T0);
    h.script.view = new Error('down');
    h.script.flows = { 'ws-a': flowRecord('ws-a', 12, T0 + MIN) };
    await h.tick(T0 + MIN);
    h.script.view = view([row('ws-a', 'tab-orch')]);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 2, T0 + 2 * MIN) };
    await h.tick(T0 + 2 * MIN);
    expect(h.sent).toEqual([]);
    expect(h.state.entries.size).toBe(0);
  });

  it('a dispatch that throws is logged and leaves the flag free to alert on its next raise', async () => {
    const h = harness({ view: view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]) });
    await h.tick(T0);
    const dispatch = h.deps.dispatch;
    h.deps.dispatch = async () => {
      throw new Error('socket closed');
    };
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    expect((await h.tick(T0 + MIN)).sent).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith('flag alert dispatch failed for fleet:ws-a:stall:tab-1: socket closed');
    h.deps.dispatch = dispatch;
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1')]);
    await h.tick(T0 + 2 * MIN);
    h.script.view = view([row('ws-a', 'tab-orch'), row('ws-a', 'tab-1', ['stall'])]);
    await h.tick(T0 + 3 * MIN);
    expect(keysOf(h.sent)).toEqual(['fleet:ws-a:stall:tab-1']);
  });

  it('a failed threshold read falls back to the default thresholds', async () => {
    const h = harness();
    h.deps.flowThresholds = async () => {
      throw new Error('boom');
    };
    await h.tick(T0);
    h.script.flows = { 'ws-a': flowRecord('ws-a', 10, T0 + MIN) };
    await h.tick(T0 + MIN);
    expect(keysOf(h.sent)).toEqual(['flow:ws-a:queue-long:landing']);
  });
});

describe('the scheduled tick', () => {
  const g = globalThis as unknown as { __ptFlagAlertState?: unknown; __ptFlagAlertTick?: { timer: unknown; running: unknown } };

  beforeEach(() => {
    logs.warn.mockClear();
    g.__ptFlagAlertState = createFlagAlertState();
  });

  afterEach(async () => {
    await stopFlagAlerts();
    vi.useRealTimers();
  });

  it('skips a tick while the previous one still runs, and logs a tick over 5 s with its duration', async () => {
    let release!: () => void;
    const h = harness();
    h.deps.fleetView = () => new Promise((resolve) => {
      release = () => resolve(view([]));
    });
    let clock = T0;
    const first = runScheduledFlagAlertTick(h.deps, () => clock);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await runScheduledFlagAlertTick(h.deps, () => clock)).toBeNull();
    expect(logs.warn).toHaveBeenCalledWith('flag alert tick skipped: the previous tick still runs');
    clock = T0 + 5_001;
    release();
    expect((await first)?.baseline).toBe(true);
    expect(logs.warn).toHaveBeenCalledWith({ durationMs: 5_001 }, 'flag alert tick took 5001 ms');
    expect(g.__ptFlagAlertTick?.running).toBeNull();
  });

  it('does not log a tick of 5 s or less', async () => {
    let clock = T0;
    const h = harness();
    h.deps.fleetView = async () => {
      clock += 5_000;
      return view([]);
    };
    await runScheduledFlagAlertTick(h.deps, () => clock);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('logs a tick that throws and frees the slot for the next one', async () => {
    const h = harness();
    h.deps.config = () => Promise.resolve({ enabled: true, repeatMinutes: 60 });
    h.deps.workspaces = () => Promise.resolve([workspace('ws-a')]);
    h.deps.fleetView = () => Promise.resolve(view([]));
    h.deps.readFlow = () => Promise.resolve(null);
    h.deps.dispatch = () => Promise.resolve();
    const state = g.__ptFlagAlertState as { entries: { set: unknown } };
    const set = state.entries.set;
    state.entries.set = () => {
      throw new Error('state broken');
    };
    h.script.view = view([row('ws-a', 'tab-1', ['stall'])]);
    h.deps.fleetView = () => Promise.resolve(view([row('ws-a', 'tab-1', ['stall'])]));
    expect(await runScheduledFlagAlertTick(h.deps)).toBeNull();
    expect(logs.warn).toHaveBeenCalledWith('flag alert tick failed: state broken');
    state.entries.set = set;
    expect(await runScheduledFlagAlertTick(h.deps)).not.toBeNull();
  });

  it('starts one interval per process and stops it, waiting for a tick in flight', async () => {
    vi.useFakeTimers();
    const h = harness();
    startFlagAlerts({ intervalMs: 60_000, deps: h.deps });
    startFlagAlerts({ intervalMs: 60_000, deps: h.deps });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.reads.fleet).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.reads.fleet).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.reads.fleet).toBe(2);
    await stopFlagAlerts();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.reads.fleet).toBe(2);
    expect(g.__ptFlagAlertTick?.timer).toBeNull();
  });
});

describe('server wiring (ADR-0032 decision 2)', () => {
  it('starts the tick beside the Mission Control runtime and stops it in shutdownWs before the runtime stops', () => {
    const server = readFileSync(new URL('../../../server.ts', import.meta.url), 'utf8');
    const shutdown = server.slice(server.indexOf('const shutdownWs'), server.indexOf('// --- Production'));
    expect(shutdown.indexOf('await stopFlagAlerts();')).toBeGreaterThan(-1);
    expect(shutdown.indexOf('await stopFlagAlerts();')).toBeLessThan(shutdown.indexOf('await getMissionControlRuntime().stop();'));
    const start = server.indexOf('await getMissionControlRuntime().start();');
    expect(server.indexOf('startFlagAlerts();', start)).toBeGreaterThan(start);
    expect(server.match(/startFlagAlerts\(\)/g)).toHaveLength(1);
  });
});

describe('pool path flags (vel-RETRO-R2)', () => {
  type TPoolHostPath = NonNullable<IFleetView['poolPaths']>[number];
  const SEAT = { managerWorkspaceId: 'ws-sm', managerTabId: 'tab-sm', workspaceIds: ['ws-a'] };
  const hostPath = (host: string, kind: 'relayed' | 'direct' | 'unknown', rttMs: number | null = kind === 'relayed' ? 1170 : 4, slowMs = 250): TPoolHostPath => {
    const alert = kind === 'relayed' ? 'tailnet-relayed' : kind === 'direct' && rttMs !== null && rttMs >= slowMs ? 'tailnet-slow' : null;
    return {
      host,
      path: {
        kind, alert, alias: host, address: `${host}.tailnet.example`, ip: 'fd7a:115c:a1e0::2', peer: host, region: kind === 'relayed' ? 'sin' : null,
        rttMs, relayedReads: kind === 'relayed' ? 2 : 0, slowMs, measuredAt: new Date(T0).toISOString(), reason: kind === 'unknown' ? 'timeout waiting for ping reply' : null,
      },
      text: alert === 'tailnet-relayed' ? `${host} tailnet path relayed via DERP(sin), RTT ${rttMs} ms` : alert ? `${host} tailnet path slow: RTT ${rttMs} ms (threshold ${slowMs} ms)` : null,
    };
  };
  const smView = (paths: TPoolHostPath[] | undefined, extra: Partial<IFleetView> = {}) =>
    view([row('ws-a', 'tab-orch'), row('ws-sm', 'tab-sm')], { ...(paths ? { poolPaths: paths } : {}), ...extra });
  const smHarness = (over: Parameters<typeof harness>[0] = {}) =>
    harness({ workspaces: [workspace('ws-a'), workspace('ws-sm', 'tab-sm')], seat: SEAT, view: smView([hostPath('exec-1', 'direct')]), ...over });
  const KEY = 'pool:fleet:tailnet-path:exec-1';

  describe('poolFlagScan', () => {
    it('raises a relayed host and a slow host, keyed by the fixed fleet part, and reads a direct host', () => {
      const scan = poolFlagScan(smView([hostPath('exec-1', 'relayed'), hostPath('exec-2', 'direct', 300), hostPath('host-b-lan', 'direct')]));
      expect(scan.flags.map((f) => [f.key, f.text])).toEqual([
        [KEY, 'exec-1 tailnet path relayed via DERP(sin), RTT 1170 ms'],
        ['pool:fleet:tailnet-path:exec-2', 'exec-2 tailnet path slow: RTT 300 ms (threshold 250 ms)'],
      ]);
      expect([...scan.read].sort()).toEqual(['pool', 'pool:exec-1', 'pool:exec-2', 'pool:host-b-lan']);
      expect([...scan.failed]).toEqual([]);
    });

    it('a relayed host raises one rule only: relayed wins over slow', () => {
      const scan = poolFlagScan(smView([hostPath('exec-1', 'relayed', 1170)]));
      expect(scan.flags.map((f) => f.rule)).toEqual(['tailnet-relayed']);
    });

    it('reads an unknown or unmeasured path as a failed source, never as a clear', () => {
      const scan = poolFlagScan(smView([hostPath('exec-1', 'unknown', null), { host: 'exec-2', path: null, text: null }]));
      expect(scan.flags).toEqual([]);
      expect([...scan.failed].sort()).toEqual(['pool:exec-1', 'pool:exec-2']);
    });

    it('fails the pool source when the view carries no paths or names their read error', () => {
      expect([...poolFlagScan(smView(undefined)).failed]).toEqual(['pool']);
      expect([...poolFlagScan(null).failed]).toEqual(['pool']);
      expect([...poolFlagScan(smView([], { errors: [{ scope: 'pool paths', error: 'read failed' }] })).failed]).toEqual(['pool']);
      expect(fleetFlagScan(smView([], { errors: [{ scope: 'pool paths', error: 'read failed' }] }), [workspace('ws-a')]).failed.has('fleet-view')).toBe(false);
    });
  });

  it('sends one digest line to the Scrum Master seat when a path turns relayed, and no phone alert', async () => {
    const h = smHarness();
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    const result = await h.tick(T0 + MIN);

    expect(h.routed).toEqual([{
      workspaceId: 'ws-sm', tabId: 'tab-sm', kind: 'flag', text: 'exec-1 tailnet path relayed via DERP(sin), RTT 1170 ms', class: 'digest', rule: 'tailnet-relayed',
    }]);
    expect(result.routed).toHaveLength(1);
    expect(h.sent).toEqual([]);

    await h.tick(T0 + 2 * MIN);
    expect(h.routed).toHaveLength(1);
  });

  it('alerts once for a path relayed at its first read: a restart, the retro case (review r1 M1)', async () => {
    const h = smHarness({ view: smView([hostPath('exec-1', 'relayed')]) });
    const first = await h.tick(T0);
    await h.tick(T0 + MIN);
    await h.tick(T0 + 61 * MIN);

    expect(first.baseline).toBe(true);
    expect(h.routed).toEqual([expect.objectContaining({ tabId: 'tab-sm', rule: 'tailnet-relayed', class: 'digest' })]);
    expect(h.sent).toEqual([]);
  });

  it('alerts once for a host the pool adds while it is relayed (review r1 M1)', async () => {
    const h = smHarness();
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'direct'), hostPath('exec-new', 'relayed')]);
    await h.tick(T0 + MIN);
    await h.tick(T0 + 2 * MIN);

    expect(h.routed.map((e) => e.text)).toEqual(['exec-new tailnet path relayed via DERP(sin), RTT 1170 ms']);
  });

  it('keeps the start-up baseline for every other flag: only a pool flag alerts at its first read', async () => {
    const scan = poolFlagScan(smView([hostPath('exec-1', 'relayed')]));
    expect(scan.flags.map((f) => f.alertAtFirstRead)).toEqual([true]);
    expect(fleetFlagScan(smView([hostPath('exec-1', 'relayed')]), [workspace('ws-a')]).flags.every((f) => f.alertAtFirstRead === undefined)).toBe(true);
  });

  it('a first-read alert still keeps the repeat window: a re-raise inside it says nothing', async () => {
    const h = smHarness({ view: smView([hostPath('exec-1', 'relayed')]) });
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'direct')]);
    await h.tick(T0 + MIN);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    await h.tick(T0 + 2 * MIN);
    expect(h.routed).toHaveLength(1);
  });

  it('alerts once per host per repeat window, whatever the rule: relayed, then slow, then relayed (review r1 L4)', async () => {
    const h = smHarness();
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    await h.tick(T0 + MIN);
    h.script.view = smView([hostPath('exec-1', 'direct', 400)]);
    await h.tick(T0 + 2 * MIN);
    h.script.view = smView([hostPath('exec-1', 'direct')]);
    await h.tick(T0 + 3 * MIN);
    h.script.view = smView([hostPath('exec-1', 'direct', 400)]);
    await h.tick(T0 + 4 * MIN);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    await h.tick(T0 + 5 * MIN);
    expect(h.routed.map((e) => e.rule)).toEqual(['tailnet-relayed']);

    h.script.view = smView([hostPath('exec-1', 'direct')]);
    await h.tick(T0 + 62 * MIN);
    h.script.view = smView([hostPath('exec-1', 'direct', 400)]);
    await h.tick(T0 + 63 * MIN);
    expect(h.routed.map((e) => e.rule)).toEqual(['tailnet-relayed', 'tailnet-slow']);
  });

  it('with no Scrum Master selection sends nothing and names the key as having no target', async () => {
    const h = smHarness({ seat: null });
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    const result = await h.tick(T0 + MIN);
    expect(result.noTarget).toEqual([KEY]);
    expect(h.routed).toEqual([]);
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ key: KEY, reason: 'no-scrum-master' }), 'flag-alert-no-target');
  });

  it('refuses a selected tab that is no longer its workspace orchestrator', async () => {
    const h = smHarness({ seat: { ...SEAT, managerTabId: 'tab-old' } });
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    const result = await h.tick(T0 + MIN);
    expect(result.noTarget).toEqual([KEY]);
    expect(logs.warn).toHaveBeenCalledWith(expect.objectContaining({ reason: 'scrum-master-not-current' }), 'flag-alert-no-target');
  });

  it('retries the raise on the next tick when the selection cannot be read', async () => {
    const h = smHarness({ seat: new Error('portfolio.db locked') });
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    expect((await h.tick(T0 + MIN)).targetUnknown).toEqual([KEY]);
    h.script.seat = SEAT;
    await h.tick(T0 + 2 * MIN);
    expect(h.routed.map((e) => e.tabId)).toEqual(['tab-sm']);
  });

  it('retries the raise on the next tick when the router refuses the line', async () => {
    const h = smHarness();
    let refuse = true;
    const route = h.deps.routeTabEvent;
    h.deps.routeTabEvent = async (event) => {
      if (refuse) throw new Error('ledger busy');
      return route(event);
    };
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    await h.tick(T0 + MIN);
    expect(h.routed).toEqual([]);
    refuse = false;
    await h.tick(T0 + 2 * MIN);
    expect(h.routed).toHaveLength(1);
  });

  it('an unknown path neither clears nor raises again; a flapping path says it once per repeat window', async () => {
    const h = smHarness();
    await h.tick(T0);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    await h.tick(T0 + MIN);
    h.script.view = smView([hostPath('exec-1', 'unknown', null)]);
    await h.tick(T0 + 2 * MIN);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    await h.tick(T0 + 3 * MIN);
    expect(h.routed).toHaveLength(1);

    h.script.view = smView([hostPath('exec-1', 'direct')]);
    await h.tick(T0 + 4 * MIN);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    await h.tick(T0 + 5 * MIN);
    expect(h.routed).toHaveLength(1);

    h.script.view = smView([hostPath('exec-1', 'direct')]);
    await h.tick(T0 + 70 * MIN);
    h.script.view = smView([hostPath('exec-1', 'relayed')]);
    await h.tick(T0 + 71 * MIN);
    expect(h.routed).toHaveLength(2);
  });

  it('forgets the source of a host the pool no longer lists', async () => {
    const h = smHarness();
    await h.tick(T0);
    expect(h.state.readSources.has('pool:exec-1')).toBe(true);
    h.script.view = smView([]);
    await h.tick(T0 + MIN);
    expect(h.state.readSources.has('pool:exec-1')).toBe(false);
  });

  it('keeps a host source while the pool paths could not be read', () => {
    const state = createFlagAlertState();
    state.readSources.add('pool:exec-1');
    pruneFlagSources(state, [workspace('ws-a')], poolFlagScan(smView(undefined)));
    expect(state.readSources.has('pool:exec-1')).toBe(true);
  });
});
