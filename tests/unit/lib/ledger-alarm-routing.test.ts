import { describe, expect, it, vi } from 'vitest';
import type { IBoardStuckItem, IFinderResult } from '@/types/constraint';
import type { IFleetRow, IFleetView } from '@/types/fleet-status';
import type { IWorkspace } from '@/types/terminal';
import { memoryTabEvents } from './tab-events-harness';

// Story 13: a ledger item past its threshold reaches the seat its route names, through the tab event router
// (ADR-0035), once on the raise edge and again at most once per repeat window while it stands, never while a copy
// still waits in that seat's digest (consult ruling 13).

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const { createFlagAlertState, ledgerFlagTargets, parseLedgerRouting, runFlagAlertTick } = await import('@/lib/flag-alerts');
const { TabEventRouter } = await import('@/lib/tab-event-router');
const { DEFAULT_FLOW_THRESHOLDS } = await import('@/lib/flow-flags');
const { V2_DEFAULT_ROUTE, parseRouteTable } = await import('@/lib/ledger-alarms');
type IFlagAlertDeps = import('@/lib/flag-alerts').IFlagAlertDeps;
type IFlagAlertState = import('@/lib/flag-alerts').IFlagAlertState;

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 3, 0, 0, 0);
const WS = 'ws-ldhziO';
const ITEM = 'range:visa:abcdef012345';

const row = (tabId: string, tabName: string, extra: Partial<IFleetRow> = {}): IFleetRow => ({
  workspaceId: WS, workspaceName: 'Acme-ledger v2', tabId, tabName, panelType: 'claude-code', providerId: 'claude', epic: null,
  state: 'idle', rawCliState: 'idle', since: T0, lastActivityAt: T0, waits: [], lastLine: null, endLineUnknown: false,
  inbox: null, flags: [], ...extra,
});

const ROWS = [row('tab-orch', 'v2-orchestrator'), row('tab-visa', 'v2-w-visa'), row('tab-mc', 'v2-w-mc'), row('tab-kit', 'v2-kit')];
const WORKSPACE: IWorkspace = { id: WS, name: 'Acme-ledger v2', directories: ['/work/v2'], orchestration: { enabled: true, orchestratorTabId: 'tab-orch' } } as IWorkspace;

const stuckItem = (extra: Partial<IBoardStuckItem> = {}): IBoardStuckItem => ({
  key: ITEM, itemType: 'range', holder: 'v2-w-visa', reason: 'not-armed', since: T0, clearInput: 'arm visa', critical: false,
  reasonLabel: 'not armed to land', ...extra,
});

const finderAt = (at: number, stuck: IBoardStuckItem[]): IFinderResult => ({
  generatedAt: at, onTrack: { state: 'at-risk', goal: null, goalState: 'none', itemsLeft: null, throughputPerDay: null, p50At: null, p90At: null, reason: null }, constraint: null, stuck, ownerBlocks: null,
  windows: [], anomalies: [], unknownShare: null, flowLocks: null, pool: null, line: '',
  inputs: {
    ledger: { state: 'ok', reason: null, at }, flow: { state: 'unknown', reason: null, at: null },
    spend: { state: 'unknown', reason: null, at: null }, pool: { state: 'unknown', reason: null, at: null },
  },
});

/** The flag tick and the real router over one in-memory `tab_events`, on one clock. */
const fleet = (options: { route?: string | null; thresholds?: Record<string, string> } = {}) => {
  let clock = T0;
  const table = memoryTabEvents();
  const atPrompt = new Set(ROWS.map((r) => r.tabId));
  const pasted: Array<{ tabId: string; message: string }> = [];
  const dispatched: Array<{ tabId: string; flag?: unknown }> = [];
  const router = new TabEventRouter({
    table, now: () => clock,
    deliver: async (_ws, tabId, message, whenReady) => {
      if (whenReady && !whenReady()) return false;
      pasted.push({ tabId, message });
      return true;
    },
    atPrompt: (tabId) => atPrompt.has(tabId),
  });
  const values: Record<string, { value: string }> = {};
  const route = options.route === undefined ? V2_DEFAULT_ROUTE : options.route;
  if (route !== null) values[`ledger.route.${WS}`] = { value: route };
  for (const [reason, value] of Object.entries(options.thresholds ?? {})) values[`ledger.threshold.${reason}`] = { value };
  const script = {
    stuck: [stuckItem()], rows: ROWS, anomalies: [] as IFinderResult['anomalies'],
    /** A finder answer frozen at this time: older than two ticks, it is an unread source. */
    frozenAt: null as number | null,
    enabled: true,
    routingDown: false,
    copiesDown: false,
    routeDown: false,
    dispatchDown: false,
  };
  const deps: IFlagAlertDeps = {
    config: async () => ({ enabled: script.enabled, repeatMinutes: 60 }),
    workspaces: async () => [WORKSPACE],
    fleetView: async (): Promise<IFleetView> => ({
      at: clock, thresholds: { stallMinutes: 30, waitingLongMinutes: 120, unansweredMinutes: 30, composerMinutes: 2 },
      rows: script.rows, unattributed: [], errors: [],
    }),
    flowThresholds: async () => DEFAULT_FLOW_THRESHOLDS,
    readFlow: async () => null,
    finderResults: () => new Map([[WS, { ...finderAt(script.frozenAt ?? clock, script.stuck), anomalies: script.anomalies }]]),
    dispatch: async (draft) => {
      if (script.dispatchDown) throw new Error('push down');
      dispatched.push(draft);
    },
    ledgerRouting: async () => {
      if (script.routingDown) throw new Error('EIO');
      return parseLedgerRouting(values).routing;
    },
    routeTabEvent: async (event) => {
      if (script.routeDown) throw new Error('router down');
      return router.route(event);
    },
    scrumMaster: async () => null,
    alarmCopies: async (workspaceId, tabId, opening, since) => {
      if (script.copiesDown) throw new Error('SQLITE_BUSY');
      return table().copies(workspaceId, tabId, 'alarm', opening, since);
    },
  };
  let state: IFlagAlertState = createFlagAlertState();
  /** One minute of the server: the flag tick, then the router's digest tick. */
  const minute = async (m: number) => {
    clock = T0 + m * MIN;
    await runFlagAlertTick(deps, state, clock);
    await router.tick();
  };
  const run = async (from: number, to: number) => {
    for (let m = from; m <= to; m += 1) await minute(m);
  };
  const alarms = (tabId: string) => table().list(WS, { tabId, since: 0, limit: 500 }).filter((e) => e.kind === 'alarm');
  const restart = () => {
    state = createFlagAlertState();
  };
  return { script, atPrompt, pasted, dispatched, run, alarms, restart, table, state: () => state };
};

const minutesOf = (events: Array<{ at: number }>) => events.map((e) => (e.at - T0) / MIN);

describe('review r1 probes', () => {
  it('P1: no repeat while the ledger source is unread (a stale finder answer)', async () => {
    const f = fleet();
    await f.run(0, 25);
    f.script.frozenAt = T0 + 25 * MIN;
    await f.run(26, 90);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([20]);
    f.script.frozenAt = null;
    await f.run(91, 91);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([20, 91]);
  });

  it('P2: a raise sends no second line while the first copy is still held', async () => {
    const f = fleet();
    f.atPrompt.delete('tab-visa');
    await f.run(0, 30);
    f.script.stuck = [];
    await f.run(31, 85);
    f.script.stuck = [stuckItem({ since: T0 + 66 * MIN })];
    await f.run(86, 90);
    expect(f.alarms('tab-visa').map((e) => [(e.at - T0) / MIN, e.deliveredAt])).toEqual([[20, null]]);
  });

  it('P3: the held guard holds for an item key with an astral character', async () => {
    const f = fleet();
    f.atPrompt.delete('tab-visa');
    f.script.stuck = [stuckItem({ key: 'range:visa:\u{1F680}1' })];
    await f.run(0, 150);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([20]);
  });

  // The probe expected the line at 20; with routing unreadable at 20 the raise waits (R4's fix), so it lands at 21.
  it('P4: with routing unreadable the raise waits for the next tick; the holder gets it, the orchestrator nothing', async () => {
    const f = fleet();
    await f.run(0, 19);
    f.script.routingDown = true;
    await f.run(20, 20);
    expect(f.table().list(WS, { since: 0, limit: 500 })).toEqual([]);
    f.script.routingDown = false;
    await f.run(21, 40);
    expect({ visa: minutesOf(f.alarms('tab-visa')), orch: minutesOf(f.alarms('tab-orch')) }).toEqual({ visa: [21], orch: [] });
  });

  it('P4: unreadable routing never applies default thresholds over a configured off', async () => {
    const f = fleet({ thresholds: { 'not-armed': 'off' } });
    f.script.routingDown = true;
    await f.run(0, 120);
    expect(f.table().list(WS, { since: 0, limit: 500 })).toEqual([]);
  });
});

describe('the default table on ranges (consult 13)', () => {
  it('sends an own-lane-order range with a tab holder one line at 60 min, to the holder only', async () => {
    const f = fleet();
    f.script.stuck = [stuckItem({ reason: 'own-lane-order', clearInput: 'range 3 of the visa chain lands' })];
    await f.run(0, 60);
    expect(f.alarms('tab-visa').map((e) => [(e.at - T0) / MIN, e.class, e.text]))
      .toEqual([[60, 'digest', `${ITEM} own-lane-order for 60 min (threshold 60 min); clear: range 3 of the visa chain lands`]]);
    expect(f.alarms('tab-orch')).toEqual([]);
  });

  it('sends a group-partner range one line at 30 min to the orchestrator, naming its keyed-group holder', async () => {
    const f = fleet();
    f.script.stuck = [stuckItem({ reason: 'group-partner', holder: 'keyed-group', clearInput: 'its group stages' })];
    await f.run(0, 30);
    const lines = f.alarms('tab-orch');
    expect(lines.map((e) => [(e.at - T0) / MIN, e.class])).toEqual([[30, 'digest']]);
    expect(lines[0].text).toMatch(/; holder keyed-group$/);
    expect(f.alarms('tab-visa')).toEqual([]);
  });

  // Keeps the holder defect visible (consult 13, Evidence 2.3): story 02 sends lane ids; v2 fixes it on the producer.
  it('sends a range whose holder is a lane id (E2) to the orchestrator, naming the lane', async () => {
    const f = fleet();
    f.script.stuck = [stuckItem({ holder: 'E2' })];
    await f.run(0, 20);
    expect(f.alarms('tab-orch').map((e) => e.text)).toEqual([`${ITEM} not-armed for 20 min (threshold 20 min); clear: arm visa; holder E2`]);
    expect(f.alarms('tab-visa')).toEqual([]);
  });
});

describe('failed reads and switches (review r1, R7)', () => {
  it('alerts.flags off: no line, and switching on starts a fresh baseline', async () => {
    const f = fleet();
    f.script.enabled = false;
    await f.run(0, 40);
    expect(f.table().list(WS, { since: 0, limit: 500 })).toEqual([]);
    f.script.enabled = true;
    await f.run(41, 100);
    expect(f.alarms('tab-visa')).toEqual([]);
    await f.run(101, 101);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([101]);
  });

  it('ledger.threshold.<reason> off: no alarm for that reason, others still raise', async () => {
    const f = fleet({ thresholds: { 'not-armed': 'off' } });
    f.script.stuck = [stuckItem(), stuckItem({ key: 'range:kit:000000000009', reason: 'chain-down', holder: null })];
    await f.run(0, 120);
    expect(f.alarms('tab-visa')).toEqual([]);
    expect(minutesOf(f.alarms('tab-kit'))).toEqual([10, 70]);
  });

  it('a rejected route: no line, the raise stays pending, the next good tick sends it', async () => {
    const f = fleet();
    await f.run(0, 19);
    f.script.routeDown = true;
    await f.run(20, 22);
    expect(f.alarms('tab-visa')).toEqual([]);
    expect(f.state().entries.size).toBeGreaterThan(0);
    f.script.routeDown = false;
    await f.run(23, 23);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([23]);
  });

  it('a rejected copies read: the raise is still sent; a repeat waits for a good read', async () => {
    const f = fleet();
    f.script.copiesDown = true;
    await f.run(0, 85);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([20]);
    f.script.copiesDown = false;
    await f.run(86, 86);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([20, 86]);
  });

  it('a rejected routing read keeps a standing alarm standing: no repeat that tick, no clear, no second raise', async () => {
    const f = fleet();
    const key = `ledger:${WS}:not-armed:${ITEM}`;
    await f.run(0, 79);
    const raisedAt = f.state().entries.get(key)?.raisedAt;
    expect(raisedAt).toBe(T0 + 20 * MIN);
    f.script.routingDown = true;
    await f.run(80, 80);
    expect(f.state().entries.get(key)?.raisedAt).toBe(raisedAt);
    await f.run(81, 81);
    expect(f.state().entries.get(key)?.raisedAt).toBe(raisedAt);
    f.script.routingDown = false;
    await f.run(82, 82);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([20, 82]);
  });
});

describe('AC 6: a not-armed range over 20 min', () => {
  it('produces one digest line to its holder and none to the orchestrator', async () => {
    const f = fleet();
    await f.run(0, 79);
    const lines = f.alarms('tab-visa');
    expect(lines.map((e) => ({ at: (e.at - T0) / MIN, class: e.class, text: e.text }))).toEqual([
      { at: 20, class: 'digest', text: `${ITEM} not-armed for 20 min (threshold 20 min); clear: arm visa` },
    ]);
    expect(lines[0].deliveredAt).toBe(T0 + 20 * MIN);
    expect(f.pasted).toEqual([{
      tabId: 'tab-visa',
      message: [
        `DIGEST 1 since 2026-11-03T00:20:00Z`,
        `- 00:20Z alarm: ${ITEM} not-armed for 20 min (threshold 20 min); clear: arm visa`,
        `Full text: purplemux events show -w ${WS} tab-visa --since 2026-11-03T00:20:00Z`,
      ].join('\n'),
    }]);
    expect(f.table().list(WS, { tabId: 'tab-orch', since: 0, limit: 500 })).toEqual([]);
    expect(f.dispatched).toEqual([]);
  });

  it('is said again once an hour after its delivery while it stands, as a digest line', async () => {
    const f = fleet();
    await f.run(0, 140);
    expect(f.alarms('tab-visa').map((e) => [(e.at - T0) / MIN, e.class, e.deliveredAt === null ? null : (e.deliveredAt - T0) / MIN]))
      .toEqual([[20, 'digest', 20], [80, 'digest', 80], [140, 'digest', 140]]);
    expect(f.alarms('tab-orch')).toEqual([]);
  });

  it('is not said again while its copy waits in a busy holder digest; the hour runs from the delivery', async () => {
    const f = fleet();
    f.atPrompt.delete('tab-visa');
    await f.run(0, 150);
    expect(f.alarms('tab-visa').map((e) => (e.at - T0) / MIN)).toEqual([20]);
    f.atPrompt.add('tab-visa');
    await f.run(151, 151);
    expect(f.alarms('tab-visa')[0].deliveredAt).toBe(T0 + 151 * MIN);
    await f.run(152, 210);
    expect(f.alarms('tab-visa').map((e) => (e.at - T0) / MIN)).toEqual([20]);
    await f.run(211, 211);
    expect(f.alarms('tab-visa').map((e) => (e.at - T0) / MIN)).toEqual([20, 211]);
  });

  it('clears when the wait ends and raises again only after the repeat window', async () => {
    const f = fleet();
    await f.run(0, 25);
    f.script.stuck = [];
    await f.run(26, 30);
    f.script.stuck = [stuckItem({ since: T0 + 10 * MIN })];
    await f.run(31, 79);
    expect(f.alarms('tab-visa').map((e) => (e.at - T0) / MIN)).toEqual([20]);
    await f.run(80, 80);
    expect(f.alarms('tab-visa').map((e) => (e.at - T0) / MIN)).toEqual([20, 80]);
  });
});

describe('restart baseline', () => {
  it('records a standing alarm without a word; its first repeat comes an hour after the restart', async () => {
    const f = fleet();
    f.script.stuck = [stuckItem({ since: T0 - 30 * MIN })];
    await f.run(0, 59);
    expect(f.alarms('tab-visa')).toEqual([]);
    await f.run(60, 60);
    expect(f.alarms('tab-visa').map((e) => (e.at - T0) / MIN)).toEqual([60]);
  });

  it('does not double a copy still held when the server restarts', async () => {
    const f = fleet();
    f.atPrompt.delete('tab-visa');
    await f.run(0, 30);
    f.restart();
    await f.run(31, 200);
    expect(f.alarms('tab-visa').map((e) => (e.at - T0) / MIN)).toEqual([20]);
  });
});

describe('urgent and routed alarms', () => {
  it('types a red main at once to its lander and the orchestrator; its repeats are digest lines', async () => {
    const f = fleet();
    f.script.stuck = [];
    await f.run(0, 0);
    f.script.stuck = [stuckItem({ key: 'landing:1762128000', reason: 'red-main', holder: 'v2-w-mc', since: T0 + MIN, clearInput: 'main green' })];
    await f.run(1, 61);
    expect(f.alarms('tab-mc').map((e) => [(e.at - T0) / MIN, e.class])).toEqual([[1, 'urgent'], [61, 'digest']]);
    expect(f.alarms('tab-orch').map((e) => [(e.at - T0) / MIN, e.class, e.text])).toEqual([
      [1, 'urgent', 'landing:1762128000 red-main for 0 min (threshold 0 min); clear: main green; holder v2-w-mc'],
      [61, 'digest', 'landing:1762128000 red-main for 60 min (threshold 0 min); clear: main green; holder v2-w-mc'],
    ]);
    expect(f.pasted.slice(0, 2).map((p) => p.tabId).sort()).toEqual(['tab-mc', 'tab-orch']);
    expect(f.dispatched).toEqual([]);
  });

  it('makes a chain-down urgent at v2-kit only on the critical path', async () => {
    const f = fleet();
    f.script.stuck = [];
    await f.run(0, 0);
    f.script.stuck = [
      stuckItem({ key: 'range:a:000000000001', reason: 'chain-down', holder: null, critical: true }),
      stuckItem({ key: 'range:b:000000000002', reason: 'chain-down', holder: null, critical: false }),
    ];
    await f.run(1, 10);
    expect(f.alarms('tab-kit').map((e) => [e.text.split(' ')[0], e.class])).toEqual([['range:a:000000000001', 'urgent'], ['range:b:000000000002', 'digest']]);
    expect(f.alarms('tab-orch')).toEqual([]);
  });

  it('sends a holder that names no tab to the orchestrator, naming the holder', async () => {
    const f = fleet();
    f.script.stuck = [stuckItem({ holder: 'v2-w-gone' })];
    await f.run(0, 20);
    expect(f.alarms('tab-orch').map((e) => e.text)).toEqual([`${ITEM} not-armed for 20 min (threshold 20 min); clear: arm visa; holder v2-w-gone`]);
    // Story 15: the reason travels with the line, so its effect is counted per reason.
    expect(f.alarms('tab-orch').map((e) => e.rule)).toEqual(['not-armed']);
  });

  it('keeps an owner wait on the board: no tab line', async () => {
    const f = fleet();
    f.script.stuck = [stuckItem({ reason: 'owner', holder: 'v2-w-visa' })];
    await f.run(0, 240);
    expect(f.table().list(WS, { since: 0, limit: 500 })).toEqual([]);
  });

  it('routes every alarm to the orchestrator with no route table, and honours a threshold override', async () => {
    const f = fleet({ route: null, thresholds: { 'not-armed': '45' } });
    await f.run(0, 44);
    expect(f.alarms('tab-orch')).toEqual([]);
    await f.run(45, 45);
    expect(f.alarms('tab-orch').map((e) => (e.at - T0) / MIN)).toEqual([45]);
    expect(f.alarms('tab-visa')).toEqual([]);
  });

  it('does not let a copy held at a former holder block the new holder', async () => {
    const f = fleet();
    f.atPrompt.delete('tab-visa');
    await f.run(0, 30);
    f.script.stuck = [stuckItem({ holder: 'v2-w-mc' })];
    await f.run(31, 80);
    expect(f.alarms('tab-visa').map((e) => (e.at - T0) / MIN)).toEqual([20]);
    expect(f.alarms('tab-mc').map((e) => (e.at - T0) / MIN)).toEqual([80]);
  });
});

describe('anomaly flags (consult ruling 13, b)', () => {
  it('keep their phone alert, naming the routed tab, and give that tab one digest line', async () => {
    const f = fleet({ route: `${V2_DEFAULT_ROUTE.replace('chain-down', 'chain-down,re-gates')}` });
    f.script.stuck = [];
    await f.run(0, 0);
    f.script.anomalies = [{
      id: 're-gates', subject: 'workspace', value: 2, unit: 'gates', threshold: 0, judged: true, breached: true, window: '24h',
      text: 're-gates: 2 gates in 24h, threshold 0 gates', reason: null,
    }];
    await f.run(1, 120);
    expect(f.dispatched.map((d) => ({ tabId: d.tabId, flag: d.flag }))).toEqual([{
      tabId: 'tab-kit', flag: { source: 'ledger', rule: 're-gates', subject: 'workspace', text: 're-gates: 2 gates in 24h, threshold 0 gates' },
    }]);
    expect(f.table().list(WS, { since: 0, limit: 500 }).map((e) => [e.tabId, e.kind, e.rule, e.class, e.text]))
      .toEqual([['tab-kit', 'flag', 're-gates', 'digest', 're-gates: 2 gates in 24h, threshold 0 gates']]);
  });
});

describe('architect confirmation (N2, S, R2, R3)', () => {
  const red = (since: number) => stuckItem({ key: 'landing:1', reason: 'red-main', holder: 'v2-w-mc', since, clearInput: 'main green' });
  const classes = (events: Array<{ at: number; class: string }>) => events.map((e) => [(e.at - T0) / MIN, e.class]);

  it('N2: a new red main is typed urgent although a digest repeat of the last one is still held', async () => {
    const f = fleet();
    f.script.stuck = [];
    await f.run(0, 0);
    f.script.stuck = [red(T0 + MIN)];
    await f.run(1, 60);
    f.atPrompt.delete('tab-mc');
    f.script.stuck = [red(T0 + MIN)];
    await f.run(61, 65);
    f.script.stuck = [];
    await f.run(66, 125);
    f.script.stuck = [red(T0 + 126 * MIN)];
    await f.run(126, 127);
    const want = [[1, 'urgent'], [61, 'digest'], [126, 'urgent']];
    expect(classes(f.alarms('tab-mc'))).toEqual(want);
    expect(classes(f.alarms('tab-orch'))).toEqual(want);
  });

  it('S: switching alerts.flags back on sends nothing on its first tick; the first repeat is one window later', async () => {
    const f = fleet();
    await f.run(0, 25);
    f.script.enabled = false;
    await f.run(26, 200);
    f.script.enabled = true;
    await f.run(201, 201);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([20]);
    await f.run(202, 261);
    expect(minutesOf(f.alarms('tab-visa'))).toEqual([20, 261]);
  });

  it('R2: after a restart both the lander and the orchestrator keep their hourly red-main repeats', async () => {
    const f = fleet();
    f.script.stuck = [];
    await f.run(0, 0);
    f.script.stuck = [red(T0 + MIN)];
    await f.run(1, 30);
    f.restart();
    await f.run(31, 300);
    const want = [[1, 'urgent'], [91, 'digest'], [151, 'digest'], [211, 'digest'], [271, 'digest']];
    expect(classes(f.alarms('tab-mc'))).toEqual(want);
    expect(classes(f.alarms('tab-orch'))).toEqual(want);
  });

  it('R3: a red main standing at the start reaches the orchestrator hourly from one window after the baseline', async () => {
    const f = fleet();
    f.script.stuck = [red(T0 - 5 * MIN)];
    await f.run(0, 200);
    expect(classes(f.alarms('tab-orch'))).toEqual([[60, 'digest'], [120, 'digest'], [180, 'digest']]);
  });
});

describe('anomaly phone dispatch (review r1, R8)', () => {
  const breach = (): IFinderResult['anomalies'] => [{
    id: 're-gates', subject: 'workspace', value: 2, unit: 'gates', threshold: 0, judged: true, breached: true, window: '24h',
    text: 're-gates: 2 gates in 24h, threshold 0 gates', reason: null,
  }];

  it('a failed phone dispatch leaves the anomaly free to alert on its next raise, as before story 13', async () => {
    const f = fleet();
    f.script.stuck = [];
    await f.run(0, 0);
    f.script.dispatchDown = true;
    f.script.anomalies = breach();
    await f.run(1, 1);
    f.script.dispatchDown = false;
    f.script.anomalies = [];
    await f.run(2, 2);
    f.script.anomalies = breach();
    await f.run(3, 3);
    expect(f.dispatched.map((d) => d.tabId)).toEqual(['tab-orch']);
  });
});

describe('ledgerFlagTargets', () => {
  const table = parseRouteTable(V2_DEFAULT_ROUTE).table;
  const flag = (extra: Record<string, unknown> = {}) => ({
    key: 'k', source: 'ledger' as const, workspaceId: WS, rule: 'not-armed', subject: ITEM, text: 't', tabId: null, sources: [], raiseSources: [],
    alarm: { itemKey: ITEM, reason: 'not-armed', holder: 'v2-w-visa', clearInput: null, since: T0, thresholdMinutes: 20, critical: false, severity: 'warn' as const },
    ...extra,
  });
  const viewOf = (rows: IFleetRow[], errors: IFleetView['errors'] = []): IFleetView => ({
    at: T0, thresholds: { stallMinutes: 30, waitingLongMinutes: 120, unansweredMinutes: 30, composerMinutes: 2 }, rows, unattributed: [], errors,
  });

  it('stays pending while the fleet view, the layout or the tab cannot be checked (ADR-0032 §5)', () => {
    expect(ledgerFlagTargets(flag(), table, WORKSPACE, null)).toEqual({ ok: false, unknown: true, reason: 'fleet-view-unreadable' });
    expect(ledgerFlagTargets(flag(), table, WORKSPACE, viewOf(ROWS, [{ scope: 'layout', workspaceId: WS, error: 'x' }])))
      .toEqual({ ok: false, unknown: true, reason: 'layout-unreadable' });
    expect(ledgerFlagTargets(flag(), table, WORKSPACE, viewOf([row('tab-orch', 'v2-orchestrator'), row('tab-visa', 'v2-w-visa', { state: 'unknown' })])))
      .toEqual({ ok: false, unknown: true, reason: 'tab-state-unknown' });
  });

  it('names no target when neither the route nor the orchestrator names a tab', () => {
    const noOrchestrator = { ...WORKSPACE, orchestration: { enabled: true, orchestratorTabId: null } } as IWorkspace;
    expect(ledgerFlagTargets(flag({ alarm: { ...flag().alarm, holder: null } }), table, noOrchestrator, viewOf(ROWS)))
      .toEqual({ ok: false, unknown: false, reason: 'no-orchestrator' });
    expect(ledgerFlagTargets(flag(), table, noOrchestrator, viewOf(ROWS))).toMatchObject({ ok: true, rows: [{ tabId: 'tab-visa' }] });
  });

  it('routes an anomaly by its id, with its subject seat as the holder', () => {
    const anomaly = flag({ alarm: undefined, rule: 'context-per-call', subject: 'v2-kit' });
    const own = parseRouteTable('$holder=context-per-call').table;
    expect(ledgerFlagTargets(anomaly, own, WORKSPACE, viewOf(ROWS))).toMatchObject({ ok: true, rows: [{ tabId: 'tab-kit' }], fellBack: [] });
    expect(ledgerFlagTargets(anomaly, table, WORKSPACE, viewOf(ROWS))).toMatchObject({ ok: true, rows: [{ tabId: 'tab-orch' }] });
  });
});

describe('parseLedgerRouting', () => {
  it('reads each workspace table and the thresholds; a table that does not parse is named and routes to the orchestrator', () => {
    const { routing, errors } = parseLedgerRouting({
      [`ledger.route.${WS}`]: { value: V2_DEFAULT_ROUTE },
      'ledger.route.ws-bad': { value: '$lander=red-main' },
      'ledger.threshold.not-armed': { value: '30' },
      'alerts.flags': { value: 'on' },
    });
    expect([...routing.routes.keys()]).toEqual([WS]);
    expect(routing.thresholds.get('not-armed')).toBe(30);
    expect(errors).toEqual([expect.stringContaining('ledger.route.ws-bad: unknown target $lander')]);
  });
});
