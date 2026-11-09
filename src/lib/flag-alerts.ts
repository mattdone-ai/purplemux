import { alertFor, isOrchestratorTab } from '@/lib/alert-policy';
import { FINDER_STALE_MS, cachedFinderResults } from '@/lib/constraint-tick';
import type { TAlertDraft } from '@/lib/alert-policy';
import { DEFAULT_FLOW_THRESHOLDS, deriveFlowFlags } from '@/lib/flow-flags';
import {
  EMPTY_ROUTE_TABLE, LEDGER_ALARM_KEYS, alarmFor, alarmOpening, alarmText, parseRouteTable, resolveThresholds, routeFor,
} from '@/lib/ledger-alarms';
import type { ILedgerAlarm, IRouteTable, TAlarmThresholds } from '@/lib/ledger-alarms';
import { createLogger } from '@/lib/logger';
import type { IAlertContext } from '@/lib/notification-dispatcher';
import type { ITabEventRoute, ITabEventRouteResult } from '@/lib/tab-event-router';
import { classifyWake } from '@/lib/wake-class';
import type { IFinderResult } from '@/types/constraint';
import type { IFleetRow, IFleetView } from '@/types/fleet-status';
import type { IFlowRecord, IFlowThresholds } from '@/types/flow';
import type { IPortfolioSelection } from '@/types/portfolio';
import type { IAlertFlag, TAlertProviderId } from '@/types/status';
import type { IWorkspace } from '@/types/terminal';

// Flag alerts (ADR-0032): a 60 s tick reads the fleet flags, the derived flow flags and the
// constraint finder's breached anomalies and the items waiting past their thresholds (ADR-0034, source
// `ledger`), and sends one `flag` alert when a flag is raised. A ledger flag goes to the tab its
// `ledger.route.<ws>` names (ADR-0032 §5 amended, story 13) through the tab event router. Each flag names the reads it rests on: any of them failing
// keeps it from clearing, and the narrower set whose failure could make it false keeps it from
// raising. A flag first seen in a source with no good read since the start, or since the switch came
// back on, is recorded and sends nothing, so a deploy or a read that recovers replays nothing.

const log = createLogger('flag-alerts');

export const FLAG_ALERT_CONFIG_KEYS = {
  enabled: 'alerts.flags',
  repeatMinutes: 'alerts.flag-repeat-minutes',
} as const;

export const DEFAULT_FLAG_REPEAT_MINUTES = 60;
export const FLAG_ALERT_TICK_MS = 60_000;
export const FLAG_ALERT_SLOW_TICK_MS = 5_000;

const REPEAT_MIN = 1;
const REPEAT_MAX = 10_080;

/** Source ids: the reads a flag rests on. */
export const FLAG_SOURCES = {
  fleetView: 'fleet-view',
  smInbox: 'sm-inbox',
  waits: 'waits',
  layout: (workspaceId: string) => `layout:${workspaceId}`,
  tab: (workspaceId: string, tabId: string) => `tab:${workspaceId}/${tabId}`,
  flow: (workspaceId: string) => `flow:${workspaceId}`,
  ledger: (workspaceId: string) => `ledger:${workspaceId}`,
  ledgerSubject: (workspaceId: string, id: string, subject: string) => `ledger:${workspaceId}/${id}/${subject}`,
  /** The pool paths the fleet view carries (vel-RETRO-R2), and one host's path among them. */
  pool: 'pool',
  poolHost: (host: string) => `pool:${host}`,
} as const;

/** A pool flag belongs to no workspace: its key keeps this fixed part, so a Scrum Master reselection re-raises nothing. */
export const POOL_FLAG_WORKSPACE = 'fleet';

/**
 * One key per host, whatever the rule (review r1 L4): a path that flaps relayed, slow, relayed alerts once per repeat
 * window, and a raised flag that changes rule is the same raise.
 */
export const poolFlagKey = (host: string): string => `pool:${POOL_FLAG_WORKSPACE}:tailnet-path:${host}`;

/** A finder answer older than two ticks is not a read (`FINDER_STALE_MS`). */
export const LEDGER_STALE_MS = FINDER_STALE_MS;

export interface IRaisedFlag extends IAlertFlag {
  key: string;
  workspaceId: string;
  /** The flagged tab; null for a workspace-level flag, which goes to the workspace's orchestrator. */
  tabId: string | null;
  /** Every read the flag rule can depend on: while one fails, the flag is not cleared. */
  sources: string[];
  /** The reads whose failure could make this flag false: while one fails, it is not raised. */
  raiseSources: string[];
  /** A ledger item waiting past its threshold (story 13): its rule is the reason, its subject the item. */
  alarm?: ILedgerAlarm;
  /**
   * Alert on the first good read too (review r1 M1): a standing condition nobody was told of is the alert itself, so
   * the start-up baseline does not swallow it. The repeat window still holds.
   */
  alertAtFirstRead?: true;
}

export interface IFlagScan {
  flags: IRaisedFlag[];
  /** Sources read well this tick. */
  read: Set<string>;
  /** Sources that could not be read this tick: a flag resting on one is unknown. */
  failed: Set<string>;
}

interface IFlagAlertEntry {
  flag: IRaisedFlag;
  /** null while the flag is not raised. */
  raisedAt: number | null;
  lastAlertAt: number | null;
}

export interface IFlagAlertState {
  /** Sources with a good read since the start or the last switch-on. */
  readSources: Set<string>;
  entries: Map<string, IFlagAlertEntry>;
  /** Per ledger alarm key, when a copy was last routed to each tab: the repeat anchor while it stands. */
  alarmSends: Map<string, Map<string, number>>;
}

export interface IFlagAlertConfig {
  enabled: boolean;
  repeatMinutes: number;
}

export const flagKey = (flag: Pick<IRaisedFlag, 'source' | 'workspaceId' | 'rule' | 'subject'>): string =>
  `${flag.source}:${flag.workspaceId}:${flag.rule}:${flag.subject}`;

const raised = (flag: Omit<IRaisedFlag, 'key'>): IRaisedFlag => ({ ...flag, key: flagKey(flag) });

export const createFlagAlertState = (): IFlagAlertState => ({ readSources: new Set(), entries: new Map(), alarmSends: new Map() });

/**
 * `alerts.flags` is off only when it reads `off`. `alerts.flag-repeat-minutes` is a plain decimal
 * in 1..10080; any other value reads as the default, and `reason` says why.
 */
export const parseFlagAlertConfig = (
  enabledRaw: string | null,
  repeatRaw: string | null,
): { config: IFlagAlertConfig; reason: string | null } => {
  const enabled = enabledRaw?.trim() !== 'off';
  if (repeatRaw === null) return { config: { enabled, repeatMinutes: DEFAULT_FLAG_REPEAT_MINUTES }, reason: null };
  const text = repeatRaw.trim();
  const value = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || value < REPEAT_MIN || value > REPEAT_MAX) {
    return {
      config: { enabled, repeatMinutes: DEFAULT_FLAG_REPEAT_MINUTES },
      reason: `${FLAG_ALERT_CONFIG_KEYS.repeatMinutes} is ${JSON.stringify(repeatRaw)}, not a number in ${REPEAT_MIN}..${REPEAT_MAX}; default ${DEFAULT_FLAG_REPEAT_MINUTES}`,
    };
  }
  return { config: { enabled, repeatMinutes: value }, reason: null };
};

/** Fleet view error scopes with no flag input. */
const FLAG_NEUTRAL_SCOPES = new Set(['leases', 'WIP cap']);

/**
 * The fleet view sources each error makes unreadable. A workspace's layout error carries its
 * `workspaceId`; an error with neither a workspace nor a known scope makes the whole view unknown.
 */
const fleetFailures = (view: IFleetView): Set<string> => {
  const failed = new Set<string>();
  for (const error of view.errors) {
    if (error.workspaceId !== undefined) failed.add(FLAG_SOURCES.layout(error.workspaceId));
    else if (error.scope === 'SM inbox') failed.add(FLAG_SOURCES.smInbox);
    else if (error.scope === 'watches' || error.scope === 'jobs') failed.add(FLAG_SOURCES.waits);
    else if (error.scope === 'pool paths') failed.add(FLAG_SOURCES.pool);
    else if (!FLAG_NEUTRAL_SCOPES.has(error.scope)) failed.add(FLAG_SOURCES.fleetView);
  }
  return failed;
};

const RULE_SOURCES: Record<string, string> = { unanswered: FLAG_SOURCES.smInbox, stall: FLAG_SOURCES.waits };

/**
 * Of a row flag's rule sources, the ones its present reason rests on. Only the idle STALL? needs the
 * registered waits (`fleet-status.ts` refuses it without them); only the inbox clause of an
 * UNANSWERED needs the SM inbox, and the row's inbox counts it.
 */
const rowRaiseSources = (row: IFleetRow, rule: string): string[] => {
  if (rule === 'stall' && (row.state === 'idle' || row.state === 'ready-for-review')) return [FLAG_SOURCES.waits];
  if (rule === 'unanswered' && (row.inbox?.unanswered ?? 0) > 0) return [FLAG_SOURCES.smInbox];
  return [];
};

/**
 * The fleet flags (ADR-0023) of one view. A tab flag's subject is the tab; an unattributed
 * UNANSWERED is workspace-level and its subject is the workspace. A null view is a failed read.
 */
export const fleetFlagScan = (view: IFleetView | null, workspaces: Array<Pick<IWorkspace, 'id'>>): IFlagScan => {
  if (!view) return { flags: [], read: new Set(), failed: new Set([FLAG_SOURCES.fleetView]) };
  const failed = fleetFailures(view);
  const ruleSource = (rule: string) => (RULE_SOURCES[rule] ? [RULE_SOURCES[rule]] : []);
  const flags: IRaisedFlag[] = [
    ...view.rows.flatMap((row) => row.flags.map((f) => {
      const base = [FLAG_SOURCES.fleetView, FLAG_SOURCES.layout(row.workspaceId), FLAG_SOURCES.tab(row.workspaceId, row.tabId)];
      return raised({
        source: 'fleet', workspaceId: row.workspaceId, rule: f.flag, subject: row.tabId, text: f.reason, tabId: row.tabId,
        sources: [...base, ...ruleSource(f.flag)],
        raiseSources: [...base, ...rowRaiseSources(row, f.flag)],
      });
    })),
    ...view.unattributed.flatMap((line) => line.flags.map((f) => {
      // The layout decides which items are unattributed: an unread layout makes its items look unattributed.
      const sources = [FLAG_SOURCES.fleetView, FLAG_SOURCES.layout(line.workspaceId), ...ruleSource(f.flag)];
      return raised({
        source: 'fleet', workspaceId: line.workspaceId, rule: f.flag, subject: line.workspaceId, text: f.reason, tabId: null,
        sources, raiseSources: sources,
      });
    })),
  ];
  for (const row of view.rows) if (row.state === 'unknown') failed.add(FLAG_SOURCES.tab(row.workspaceId, row.tabId));
  const read = new Set<string>();
  if (!failed.has(FLAG_SOURCES.fleetView)) {
    read.add(FLAG_SOURCES.fleetView);
    for (const source of [FLAG_SOURCES.smInbox, FLAG_SOURCES.waits]) if (!failed.has(source)) read.add(source);
    for (const w of workspaces) if (!failed.has(FLAG_SOURCES.layout(w.id))) read.add(FLAG_SOURCES.layout(w.id));
    for (const row of view.rows) if (row.state !== 'unknown') read.add(FLAG_SOURCES.tab(row.workspaceId, row.tabId));
  }
  return { flags, read, failed };
};

/**
 * The tailnet path flags (vel-RETRO-R2): one per remote host whose path is relayed (`tailnet-relayed`, which wins) or
 * slow (`tailnet-slow`), keyed by the host alone (`poolFlagKey`). A host already relayed at its first read alerts,
 * inside the repeat window: a restart and a new host are the retro case (review r1 M1). A host whose path is unknown, or not measured within the read's staleness, is an unread
 * source: its flag neither raises nor clears. The fleet view carries the paths of the last pool read; no tick measures.
 */
export const poolFlagScan = (view: IFleetView | null): IFlagScan => {
  if (!view?.poolPaths || fleetFailures(view).has(FLAG_SOURCES.pool)) return { flags: [], read: new Set(), failed: new Set([FLAG_SOURCES.pool]) };
  const read = new Set<string>([FLAG_SOURCES.pool]);
  const failed = new Set<string>();
  const flags: IRaisedFlag[] = [];
  for (const { host, path, text } of view.poolPaths) {
    const source = FLAG_SOURCES.poolHost(host);
    if (!path || path.kind === 'unknown') {
      failed.add(source);
      continue;
    }
    read.add(source);
    if (!path.alert || !text) continue;
    flags.push({
      ...raised({
        source: 'pool', workspaceId: POOL_FLAG_WORKSPACE, rule: path.alert, subject: host, text, tabId: null, sources: [source], raiseSources: [source],
      }),
      key: poolFlagKey(host),
      alertAtFirstRead: true,
    });
  }
  return { flags, read, failed };
};

export type TFlowRead = { workspaceId: string; record: IFlowRecord | null } | { workspaceId: string; error: string };

/** The derived flow flags (ADR-0026) of every record read, each workspace-level. No record is a good read. */
export const flowFlagScan = (reads: TFlowRead[], thresholds: IFlowThresholds, now: number): IFlagScan => {
  const read = new Set<string>();
  const failed = new Set<string>();
  const flags: IRaisedFlag[] = [];
  for (const r of reads) {
    const source = FLAG_SOURCES.flow(r.workspaceId);
    if ('error' in r) {
      failed.add(source);
      continue;
    }
    read.add(source);
    if (!r.record) continue;
    for (const f of deriveFlowFlags(r.record, thresholds, now).flags) {
      flags.push(raised({
        source: 'flow', workspaceId: r.workspaceId, rule: f.rule, subject: f.subject, text: f.text, tabId: null, sources: [source], raiseSources: [source],
      }));
    }
  }
  return { flags, read, failed };
};

/**
 * The constraint finder's breached anomalies (ADR-0034) and every open wait past its threshold
 * (story 13), each routed by `ledger.route.<ws>`. A workspace the finder has not reached, whose
 * ledger it could not read, or whose answer is older than two ticks is an unread source: its flags
 * neither raise nor clear. Each anomaly subject is its own source, failed while its value cannot be
 * judged (`judged: false`), so an anomaly that turns unknown or unflaggable keeps its flag standing.
 */
export const ledgerFlagScan = (
  results: ReadonlyMap<string, IFinderResult>, workspaces: Array<Pick<IWorkspace, 'id'>>, now: number,
  thresholds: TAlarmThresholds | null = resolveThresholds(new Map()).thresholds,
): IFlagScan => {
  const read = new Set<string>();
  const failed = new Set<string>();
  const flags: IRaisedFlag[] = [];
  for (const { id } of workspaces) {
    const source = FLAG_SOURCES.ledger(id);
    const result = results.get(id);
    // No routing read (thresholds null): which alarms stand, and where they go, is unknown this tick.
    if (!thresholds || !result || result.inputs.ledger.state !== 'ok' || now - result.generatedAt > LEDGER_STALE_MS) {
      failed.add(source);
      continue;
    }
    read.add(source);
    for (const a of result.anomalies) {
      const subject = FLAG_SOURCES.ledgerSubject(id, a.id, a.subject);
      // A value that cannot be judged (unknown, no threshold, or too few to flag) can neither raise nor clear.
      if (a.judged) read.add(subject);
      else failed.add(subject);
      if (!a.breached) continue;
      flags.push(raised({
        source: 'ledger', workspaceId: id, rule: a.id, subject: a.subject, text: a.text, tabId: null,
        sources: [source, subject], raiseSources: [source],
      }));
    }
    for (const item of result.stuck) {
      const alarm = alarmFor(item, thresholds, now);
      if (!alarm) continue;
      flags.push(raised({
        source: 'ledger', workspaceId: id, rule: alarm.reason, subject: alarm.itemKey, text: alarmText(alarm, now, true), tabId: null,
        sources: [source], raiseSources: [source], alarm,
      }));
    }
  }
  return { flags, read, failed };
};

export const mergeFlagScans = (...scans: IFlagScan[]): IFlagScan => ({
  flags: scans.flatMap((scan) => scan.flags),
  read: new Set(scans.flatMap((scan) => [...scan.read])),
  failed: new Set(scans.flatMap((scan) => [...scan.failed])),
});

/**
 * Apply one scan to the raise-edge state and answer the flags to alert on: each one raised since
 * the previous scan, outside the repeat window of its last alert, whose every raise source read well
 * now and on an earlier tick (now only, for an `alertAtFirstRead` flag). A raised flag absent now clears only when none of its sources failed.
 * The caller records a sent alert with `markFlagAlerted`.
 */
export const stepFlagAlerts = (state: IFlagAlertState, scan: IFlagScan, now: number, repeatMs: number): IRaisedFlag[] => {
  const failedIn = (sources: string[]) => sources.some((source) => scan.failed.has(source));
  const current = new Map(scan.flags.filter((flag) => !failedIn(flag.raiseSources)).map((flag) => [flag.key, flag]));
  for (const [key, entry] of state.entries) {
    if (entry.raisedAt !== null && !current.has(key) && !failedIn(entry.flag.sources)) entry.raisedAt = null;
  }
  const raises: IRaisedFlag[] = [];
  for (const [key, flag] of current) {
    const entry = state.entries.get(key);
    if (entry && entry.raisedAt !== null) {
      entry.flag = flag;
      continue;
    }
    const lastAlertAt = entry?.lastAlertAt ?? null;
    state.entries.set(key, { flag, raisedAt: now, lastAlertAt });
    const seen = flag.alertAtFirstRead === true || flag.raiseSources.every((source) => state.readSources.has(source));
    if (seen && (lastAlertAt === null || now - lastAlertAt >= repeatMs)) raises.push(flag);
  }
  for (const source of scan.read) state.readSources.add(source);
  for (const [key, entry] of state.entries) {
    if (entry.raisedAt === null && (entry.lastAlertAt === null || now - entry.lastAlertAt >= repeatMs)) state.entries.delete(key);
  }
  for (const key of state.alarmSends.keys()) if (!state.entries.has(key)) state.alarmSends.delete(key);
  return raises;
};

/**
 * Forget the sources of what is gone: a closed workspace's, and a tab its workspace's layout no
 * longer shows. A source the view could not speak for is kept.
 */
export const pruneFlagSources = (state: IFlagAlertState, workspaces: Array<Pick<IWorkspace, 'id'>>, scan: IFlagScan): void => {
  const ids = new Set(workspaces.map((w) => w.id));
  for (const source of state.readSources) {
    const match = /^(layout|flow|ledger|tab):([^/]+)(\/.+)?$/.exec(source);
    if (!match) continue;
    const [, kind, workspaceId, rest] = match;
    // A tab the layout no longer shows, or an anomaly subject the finder no longer reports.
    const parent = kind === 'tab' ? FLAG_SOURCES.layout(workspaceId) : kind === 'ledger' && rest ? FLAG_SOURCES.ledger(workspaceId) : null;
    if (!ids.has(workspaceId)) state.readSources.delete(source);
    else if (parent && scan.read.has(parent) && !scan.read.has(source) && !scan.failed.has(source)) state.readSources.delete(source);
  }
  // A host the pool no longer lists, while the pool paths read well.
  if (!scan.read.has(FLAG_SOURCES.pool)) return;
  for (const source of state.readSources) {
    if (source.startsWith(`${FLAG_SOURCES.pool}:`) && !scan.read.has(source) && !scan.failed.has(source)) state.readSources.delete(source);
  }
};

export const markFlagAlerted = (state: IFlagAlertState, key: string, at: number): void => {
  const entry = state.entries.get(key);
  if (entry) entry.lastAlertAt = at;
};

/** A raise whose target could not be checked stays a raise for the next tick. */
export const deferFlagRaise = (state: IFlagAlertState, key: string): void => {
  const entry = state.entries.get(key);
  if (entry) entry.raisedAt = null;
};

/**
 * Switched off: forget what stands, what was read and where each alarm was last sent, so switching on starts from a
 * fresh baseline. The repeat window is kept.
 */
export const pauseFlagAlerts = (state: IFlagAlertState): void => {
  state.readSources.clear();
  for (const entry of state.entries.values()) entry.raisedAt = null;
  state.alarmSends.clear();
};

const toAlertProvider = (providerId: string | null): TAlertProviderId =>
  providerId === 'codex' || providerId === 'grok' ? providerId : 'claude';

export type TFlagTarget =
  | { ok: true; row: IFleetRow }
  | { ok: false; unknown: false; reason: 'no-orchestrator' | 'orchestrator-disabled' | 'tab-closed' }
  | { ok: false; unknown: true; reason: 'fleet-view-unreadable' | 'layout-unreadable' | 'tab-state-unknown' };

/**
 * The real tab an alert names (ADR-0032 decision 5): the flagged tab, or for a workspace-level
 * flag the workspace's enabled orchestrator. A tab the fleet view cannot vouch for this tick is
 * `unknown` (retry), never a missing target.
 */
export const flagAlertTarget = (flag: IRaisedFlag, workspace: IWorkspace | undefined, view: IFleetView | null): TFlagTarget => {
  let tabId = flag.tabId;
  if (tabId === null) {
    const orchestration = workspace?.orchestration;
    if (!orchestration?.orchestratorTabId) return { ok: false, unknown: false, reason: 'no-orchestrator' };
    if (!orchestration.enabled) return { ok: false, unknown: false, reason: 'orchestrator-disabled' };
    tabId = orchestration.orchestratorTabId;
  }
  if (!view) return { ok: false, unknown: true, reason: 'fleet-view-unreadable' };
  if (fleetFailures(view).has(FLAG_SOURCES.layout(flag.workspaceId))) return { ok: false, unknown: true, reason: 'layout-unreadable' };
  const row = view.rows.find((r) => r.workspaceId === flag.workspaceId && r.tabId === tabId);
  if (!row) return { ok: false, unknown: false, reason: 'tab-closed' };
  if (row.state === 'unknown') return { ok: false, unknown: true, reason: 'tab-state-unknown' };
  return { ok: true, row };
};

export type TLedgerTargets =
  | {
    ok: true;
    /** The routed tabs, each once. Empty when the route is the board only. */
    rows: IFleetRow[];
    /** A route target that named no tab of the workspace, so the orchestrator stood in. */
    fellBack: string[];
  }
  | { ok: false; unknown: boolean; reason: string };

const namesTab = (row: Pick<IFleetRow, 'tabId' | 'tabName'>, name: string | null): boolean =>
  name !== null && (row.tabId === name || row.tabName === name);

/**
 * The tabs a ledger flag goes to (ADR-0032 §5 amended, story 13): its `ledger.route.<ws>` targets, the workspace's
 * enabled orchestrator for a reason the table does not name, and the orchestrator in place of a holder or tab name
 * that names no tab of a readable layout. `$holder` is the item's holder, or an anomaly's subject seat. A tab the
 * fleet view cannot vouch for this tick is `unknown` (the raise is retried), never a missing target.
 */
export const ledgerFlagTargets = (
  flag: IRaisedFlag, table: IRouteTable, workspace: IWorkspace | undefined, view: IFleetView | null,
): TLedgerTargets => {
  if (!view) return { ok: false, unknown: true, reason: 'fleet-view-unreadable' };
  if (fleetFailures(view).has(FLAG_SOURCES.layout(flag.workspaceId))) return { ok: false, unknown: true, reason: 'layout-unreadable' };
  const rows = view.rows.filter((r) => r.workspaceId === flag.workspaceId);
  const holder = flag.alarm ? flag.alarm.holder : flag.subject;
  const picked: IFleetRow[] = [];
  const fellBack: string[] = [];
  let orchestrator = false;
  let board = false;
  for (const target of routeFor(table, flag.alarm?.reason ?? flag.rule)) {
    if (target.kind === 'board') board = true;
    else if (target.kind === 'orchestrator') orchestrator = true;
    else {
      const name = target.kind === 'holder' ? holder : target.name;
      const row = rows.find((r) => namesTab(r, name));
      if (row) picked.push(row);
      else {
        orchestrator = true;
        fellBack.push(target.kind === 'holder' ? `holder ${holder ?? 'none named'}` : `tab ${target.name}`);
      }
    }
  }
  if (orchestrator) {
    const target = flagAlertTarget({ ...flag, tabId: null }, workspace, view);
    if (target.ok) picked.push(target.row);
    else if (target.unknown) return target;
    else if (!picked.length && !board) return target;
  }
  if (picked.some((r) => r.state === 'unknown')) return { ok: false, unknown: true, reason: 'tab-state-unknown' };
  return { ok: true, rows: picked.filter((r, i) => picked.findIndex((p) => p.tabId === r.tabId) === i), fellBack };
};

export const flagAlertDraft = (flag: IRaisedFlag, target: IFleetRow, workspace: IWorkspace | undefined, at: number): TAlertDraft =>
  alertFor({
    kind: 'flag',
    tabId: target.tabId,
    workspaceId: flag.workspaceId,
    workspaceName: workspace?.name ?? target.workspaceName,
    tabName: target.tabName,
    providerId: toAlertProvider(target.providerId),
    isOrchestrator: isOrchestratorTab({ id: target.tabId }, workspace),
    at,
    detail: flag.tabId ? `${target.tabName}: ${flag.text}` : flag.text,
    flag: { source: flag.source, rule: flag.rule, subject: flag.subject, text: flag.text },
  });

export interface IFlagAlertDeps {
  /** Throws when the fleet config cannot be read. */
  config: () => Promise<IFlagAlertConfig>;
  workspaces: () => Promise<IWorkspace[]>;
  fleetView: (now: number) => Promise<IFleetView>;
  flowThresholds: () => Promise<IFlowThresholds>;
  readFlow: (workspaceId: string) => Promise<IFlowRecord | null>;
  /** The constraint finder's cached answers per workspace (ADR-0034). */
  finderResults: () => ReadonlyMap<string, IFinderResult>;
  dispatch: (draft: TAlertDraft, ctx: IAlertContext) => Promise<unknown>;
  /** `ledger.route.<ws>` and `ledger.threshold.<reason>`; throws when the fleet config cannot be read. */
  ledgerRouting: () => Promise<ILedgerRouting>;
  /** Hand an event to the tab event router (ADR-0035): urgent is typed at once, digest waits for the tab's digest. */
  routeTabEvent: (event: ITabEventRoute) => Promise<ITabEventRouteResult>;
  /** The portfolio Scrum Master seat a pool flag goes to (SO-10); null with no selection; throws when unreadable. */
  scrumMaster: () => Promise<IPortfolioSelection | null>;
  /** The copies of an alarm sent to a tab (`TabEventsTable.copies`); throws when the ledger cannot be read. */
  alarmCopies: (workspaceId: string, tabId: string, opening: string, since: number) => Promise<{ held: boolean; lastDeliveredAt: number | null }>;
}

export interface ILedgerRouting {
  routes: ReadonlyMap<string, IRouteTable>;
  thresholds: TAlarmThresholds;
}

/** How far back the repeat guard looks for a held or delivered copy: the tab event log keeps 30 days. */
export const ALARM_COPY_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export interface IFlagAlertTickResult {
  /** Why the tick read no flag; absent when it did. */
  skipped?: 'config-unreadable' | 'off' | 'workspaces-unreadable';
  /** No source had a good read before this tick: everything it saw was recorded, nothing sent. */
  baseline: boolean;
  sent: TAlertDraft[];
  /** Keys raised with no tab to name: no orchestrator, a disabled one, or a closed tab. */
  noTarget: string[];
  /** Keys whose tab this tick could not check; they are retried on the next tick. */
  targetUnknown: string[];
  /** Ledger alarm lines handed to the router this tick, raises and repeats (story 13). */
  routed: ITabEventRoute[];
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One tick over `deps`. A failed read is logged and leaves the state it covers as it was. */
export const runFlagAlertTick = async (deps: IFlagAlertDeps, state: IFlagAlertState, now: number): Promise<IFlagAlertTickResult> => {
  const idle = (skipped: NonNullable<IFlagAlertTickResult['skipped']>): IFlagAlertTickResult =>
    ({ skipped, baseline: false, sent: [], noTarget: [], targetUnknown: [], routed: [] });
  let config: IFlagAlertConfig;
  try {
    config = await deps.config();
  } catch (err) {
    log.warn(`flag alert tick skipped: fleet config unreadable (${errorText(err)})`);
    return idle('config-unreadable');
  }
  if (!config.enabled) {
    pauseFlagAlerts(state);
    return idle('off');
  }
  let workspaces: IWorkspace[];
  try {
    workspaces = await deps.workspaces();
  } catch (err) {
    log.warn(`flag alert tick skipped: workspaces unreadable (${errorText(err)})`);
    return idle('workspaces-unreadable');
  }
  const [view, thresholds, reads, routing] = await Promise.all([
    deps.fleetView(now).catch((err) => {
      log.warn(`flag alert tick: fleet view unreadable (${errorText(err)})`);
      return null;
    }),
    deps.flowThresholds().catch(() => DEFAULT_FLOW_THRESHOLDS),
    Promise.all(workspaces.map(async (w): Promise<TFlowRead> => {
      try {
        return { workspaceId: w.id, record: await deps.readFlow(w.id) };
      } catch (err) {
        return { workspaceId: w.id, error: errorText(err) };
      }
    })),
    deps.ledgerRouting().catch((err): ILedgerRouting | null => {
      log.warn(`flag alert tick: ledger routing unreadable, ledger flags wait for the next tick (${errorText(err)})`);
      return null;
    }),
  ]);
  const baseline = state.readSources.size === 0;
  const scan = mergeFlagScans(
    fleetFlagScan(view, workspaces), flowFlagScan(reads, thresholds, now), ledgerFlagScan(deps.finderResults(), workspaces, now, routing?.thresholds ?? null),
    poolFlagScan(view),
  );
  const raises = stepFlagAlerts(state, scan, now, config.repeatMinutes * 60_000);
  pruneFlagSources(state, workspaces, scan);
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const result: IFlagAlertTickResult = { baseline, sent: [], noTarget: [], targetUnknown: [], routed: [] };
  const ledger: ILedgerDelivery = { deps, state, view, routes: routing?.routes ?? new Map(), result, now };
  for (const flag of raises) {
    const workspace = byId.get(flag.workspaceId);
    if (flag.source === 'ledger') {
      await deliverLedgerRaise(ledger, flag, workspace);
      continue;
    }
    if (flag.source === 'pool') {
      await deliverPoolRaise(ledger, flag, byId);
      continue;
    }
    const target = flagAlertTarget(flag, workspace, view);
    if (!target.ok) {
      if (target.unknown) {
        deferFlagRaise(state, flag.key);
        result.targetUnknown.push(flag.key);
        log.warn({ key: flag.key, workspaceId: flag.workspaceId, reason: target.reason }, 'flag-alert-target-unknown');
      } else {
        result.noTarget.push(flag.key);
        log.warn({ key: flag.key, workspaceId: flag.workspaceId, reason: target.reason }, 'flag-alert-no-target');
      }
      continue;
    }
    if (await dispatchFlag(deps, flag, target.row, workspace, now, result)) markFlagAlerted(state, flag.key, now);
  }
  const raisedNow = new Set(raises.map((flag) => flag.key));
  for (const entry of state.entries.values()) {
    // A repeat is a re-raise: a source that failed this tick neither raises nor clears (ADR-0032 §6).
    if (entry.flag.raiseSources.some((source) => scan.failed.has(source))) continue;
    if (entry.flag.alarm && entry.raisedAt !== null && !raisedNow.has(entry.flag.key)) {
      await repeatLedgerAlarm(ledger, entry, byId.get(entry.flag.workspaceId), config.repeatMinutes * 60_000);
    }
  }
  return result;
};

const dispatchFlag = async (
  deps: IFlagAlertDeps, flag: IRaisedFlag, row: IFleetRow, workspace: IWorkspace | undefined, now: number, result: IFlagAlertTickResult,
): Promise<boolean> => {
  const draft = flagAlertDraft(flag, row, workspace, now);
  try {
    await deps.dispatch(draft, { workspaceDir: workspace?.directories[0] ?? null });
    result.sent.push(draft);
    return true;
  } catch (err) {
    log.warn(`flag alert dispatch failed for ${flag.key}: ${errorText(err)}`);
    return false;
  }
};

const noTarget = (result: IFlagAlertTickResult, flag: IRaisedFlag, workspaceId: string, reason: string): void => {
  result.noTarget.push(flag.key);
  log.warn({ key: flag.key, workspaceId, reason }, 'flag-alert-no-target');
};

const targetUnknown = (state: IFlagAlertState, result: IFlagAlertTickResult, flag: IRaisedFlag, workspaceId: string, reason: string): void => {
  deferFlagRaise(state, flag.key);
  result.targetUnknown.push(flag.key);
  log.warn({ key: flag.key, workspaceId, reason }, 'flag-alert-target-unknown');
};

/**
 * A pool flag (vel-RETRO-R2, consult ruling) goes to the portfolio Scrum Master seat as one digest line, and to no
 * phone: under SO-10 that seat decides what reaches the owner. The seat is the manager workspace's enabled
 * orchestrator, and it must be the selected manager tab. A raise the router refuses stays a raise for the next tick.
 */
const deliverPoolRaise = async (ledger: ILedgerDelivery, flag: IRaisedFlag, byId: ReadonlyMap<string, IWorkspace>): Promise<void> => {
  const { deps, state, result, now } = ledger;
  let seat: IPortfolioSelection | null;
  try {
    seat = await deps.scrumMaster();
  } catch (err) {
    targetUnknown(state, result, flag, flag.workspaceId, `scrum-master-unreadable: ${errorText(err)}`);
    return;
  }
  if (!seat) {
    noTarget(result, flag, flag.workspaceId, 'no-scrum-master');
    return;
  }
  const target = flagAlertTarget({ ...flag, workspaceId: seat.managerWorkspaceId, tabId: null }, byId.get(seat.managerWorkspaceId), ledger.view);
  if (!target.ok) {
    if (target.unknown) targetUnknown(state, result, flag, seat.managerWorkspaceId, target.reason);
    else noTarget(result, flag, seat.managerWorkspaceId, target.reason);
    return;
  }
  if (target.row.tabId !== seat.managerTabId) {
    noTarget(result, flag, seat.managerWorkspaceId, 'scrum-master-not-current');
    return;
  }
  const event: ITabEventRoute = {
    workspaceId: seat.managerWorkspaceId, tabId: target.row.tabId, kind: 'flag', text: flag.text,
    class: classifyWake('flag', { severity: 'warn' }), rule: flag.rule,
  };
  try {
    await deps.routeTabEvent(event);
  } catch (err) {
    log.warn(`pool flag ${flag.key} not routed to ${target.row.tabId}: ${errorText(err)}`);
    deferFlagRaise(state, flag.key);
    return;
  }
  result.routed.push(event);
  markFlagAlerted(state, flag.key, now);
};

interface ILedgerDelivery {
  deps: IFlagAlertDeps;
  state: IFlagAlertState;
  view: IFleetView | null;
  routes: ReadonlyMap<string, IRouteTable>;
  result: IFlagAlertTickResult;
  now: number;
}

/** One line to one tab through the router; false when the router refused it. */
const routeLine = async (
  ledger: ILedgerDelivery, flag: IRaisedFlag, row: IFleetRow, kind: 'alarm' | 'flag', text: string, severity: 'warn' | 'block',
): Promise<boolean> => {
  const event: ITabEventRoute = {
    workspaceId: flag.workspaceId, tabId: row.tabId, kind, text, class: classifyWake(kind, { severity }), rule: flag.rule,
  };
  try {
    await ledger.deps.routeTabEvent(event);
  } catch (err) {
    log.warn(`ledger ${kind} for ${flag.key} not routed to ${row.tabId}: ${errorText(err)}`);
    return false;
  }
  ledger.result.routed.push(event);
  if (flag.alarm) {
    const sends = ledger.state.alarmSends.get(flag.key) ?? new Map<string, number>();
    sends.set(row.tabId, ledger.now);
    ledger.state.alarmSends.set(flag.key, sends);
  }
  return true;
};

const alarmLine = (alarm: ILedgerAlarm, row: IFleetRow, now: number): string => alarmText(alarm, now, namesTab(row, alarm.holder));

/**
 * A raised ledger flag goes to its routed tabs. An item alarm is a tab line only: urgent for `red-main` and a
 * critical-path `chain-down`, else a digest line (ADR-HFL-03 decision 1). An anomaly keeps its phone alert, now naming
 * its routed tab, and gives that tab a digest line (consult ruling 13, b).
 */
const deliverLedgerRaise = async (ledger: ILedgerDelivery, flag: IRaisedFlag, workspace: IWorkspace | undefined): Promise<void> => {
  const { state, result, now } = ledger;
  const targets = ledgerFlagTargets(flag, ledger.routes.get(flag.workspaceId) ?? EMPTY_ROUTE_TABLE, workspace, ledger.view);
  if (!targets.ok) {
    if (targets.unknown) {
      deferFlagRaise(state, flag.key);
      result.targetUnknown.push(flag.key);
      log.warn({ key: flag.key, workspaceId: flag.workspaceId, reason: targets.reason }, 'flag-alert-target-unknown');
    } else {
      result.noTarget.push(flag.key);
      log.warn({ key: flag.key, workspaceId: flag.workspaceId, reason: targets.reason }, 'flag-alert-no-target');
    }
    return;
  }
  if (targets.fellBack.length) {
    log.info({ key: flag.key, workspaceId: flag.workspaceId, fellBack: targets.fellBack }, 'ledger-flag-route-fallback');
  }
  if (!targets.rows.length) {
    markFlagAlerted(state, flag.key, now);
    return;
  }
  if (!flag.alarm) {
    // As before story 13, the phone alert alone marks the anomaly alerted: a failed dispatch leaves the next raise free.
    if (await dispatchFlag(ledger.deps, flag, targets.rows[0], workspace, now, result)) markFlagAlerted(state, flag.key, now);
    for (const row of targets.rows) await routeLine(ledger, flag, row, 'flag', flag.text, 'warn');
    return;
  }
  let alerted = false;
  for (const row of targets.rows) {
    // A digest line's copy still held in this tab's digest already says it (review r1, R2): the raise counts as alerted
    // there. An urgent raise is typed whatever the digest holds (confirmation N2).
    if (flag.alarm.severity === 'warn' && await heldAt(ledger, flag, flag.alarm, row, 'raise')) alerted = true;
    else if (await routeLine(ledger, flag, row, 'alarm', alarmLine(flag.alarm, row, now), flag.alarm.severity)) alerted = true;
  }
  if (alerted) markFlagAlerted(state, flag.key, now);
  else deferFlagRaise(state, flag.key);
};

/**
 * Whether a copy of the alarm still waits in the tab's digest. An unreadable log answers no on a raise (delivery
 * never depends on a ledger read, ADR-0035 §4) and yes on a repeat (no repeat on a guess).
 */
const heldAt = async (ledger: ILedgerDelivery, flag: IRaisedFlag, alarm: ILedgerAlarm, row: IFleetRow, path: 'raise' | 'repeat'): Promise<boolean> =>
  (await copiesAt(ledger, flag, alarm, row, path))?.held ?? path === 'repeat';

const copiesAt = async (
  ledger: ILedgerDelivery, flag: IRaisedFlag, alarm: ILedgerAlarm, row: IFleetRow, path: 'raise' | 'repeat',
): Promise<{ held: boolean; lastDeliveredAt: number | null } | null> => {
  try {
    return await ledger.deps.alarmCopies(flag.workspaceId, row.tabId, alarmOpening(alarm), ledger.now - ALARM_COPY_LOOKBACK_MS);
  } catch (err) {
    log.warn(`ledger alarm ${flag.key}: copies at ${row.tabId} unreadable on the ${path} (${errorText(err)})`);
    return null;
  }
};

/**
 * A standing item alarm is said again to each routed tab once the repeat window has passed since the later of its
 * last copy to that tab (or, with none, its last alert, or the tick that recorded it) and that copy's delivery; never
 * while a copy still waits in the tab's digest. A repeat is a digest line whatever the raise was (consult ruling 13, a).
 */
const repeatLedgerAlarm = async (
  ledger: ILedgerDelivery, entry: IFlagAlertEntry, workspace: IWorkspace | undefined, repeatMs: number,
): Promise<void> => {
  const { flag } = entry;
  const alarm = flag.alarm!;
  const targets = ledgerFlagTargets(flag, ledger.routes.get(flag.workspaceId) ?? EMPTY_ROUTE_TABLE, workspace, ledger.view);
  if (!targets.ok) return;
  const sends = ledger.state.alarmSends.get(flag.key);
  // Read once, before any send below moves lastAlertAt: a tab with no copy of its own never waits on a sibling's send.
  const keyAnchor = Math.max(entry.lastAlertAt ?? -Infinity, entry.raisedAt!);
  for (const row of targets.rows) {
    const lastSent = sends?.get(row.tabId) ?? keyAnchor;
    if (ledger.now - lastSent < repeatMs) continue;
    const copies = await copiesAt(ledger, flag, alarm, row, 'repeat');
    if (!copies || copies.held) continue;
    const anchor = Math.max(lastSent, copies.lastDeliveredAt ?? -Infinity);
    if (ledger.now - anchor < repeatMs) continue;
    if (await routeLine(ledger, flag, row, 'alarm', alarmLine(alarm, row, ledger.now), 'warn')) markFlagAlerted(ledger.state, flag.key, ledger.now);
  }
};

const realDeps = (): IFlagAlertDeps => ({
  config: async () => {
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    const state = await readFleetConfig();
    const { config, reason } = parseFlagAlertConfig(
      valueOf(state, FLAG_ALERT_CONFIG_KEYS.enabled)?.value ?? null,
      valueOf(state, FLAG_ALERT_CONFIG_KEYS.repeatMinutes)?.value ?? null,
    );
    if (g.__ptFlagAlertConfigLogged !== reason) {
      g.__ptFlagAlertConfigLogged = reason;
      if (reason) log.warn(reason);
    }
    return config;
  },
  workspaces: async () => (await (await import('@/lib/workspace-store')).getWorkspaces()).workspaces,
  fleetView: async (now) => (await import('@/lib/fleet-status-snapshot')).readFleetView(now),
  flowThresholds: async () => (await import('@/lib/flow-view')).readFlowThresholds(),
  readFlow: async (workspaceId) => (await import('@/lib/flow-store')).readFlow(workspaceId),
  finderResults: () => cachedFinderResults(),
  dispatch: async (draft, ctx) => (await import('@/lib/notification-dispatcher')).getNotificationDispatcher().dispatch(draft, ctx),
  ledgerRouting: async () => {
    const { readFleetConfig } = await import('@/lib/fleet-config-store');
    const { routing, errors } = parseLedgerRouting((await readFleetConfig()).values);
    const logged = errors.join('\n') || null;
    if (g.__ptLedgerRoutingLogged !== logged) {
      g.__ptLedgerRoutingLogged = logged;
      for (const error of errors) log.warn(error);
    }
    return routing;
  },
  routeTabEvent: async (event) => (await import('@/lib/status-manager')).getStatusManager().routeTabEvent(event),
  scrumMaster: async () => (await import('@/lib/portfolio-store')).getPortfolioStore().currentSelection()?.selection ?? null,
  alarmCopies: async (workspaceId, tabId, opening, since) => (await import('@/lib/ledger-store')).getLedgerStore()
    .tabEvents.copies(workspaceId, tabId, 'alarm', opening, since),
});

/**
 * The route tables and thresholds the fleet config holds. A route table that does not parse routes its workspace to
 * the orchestrator, as an unset one does, and is named in `errors`.
 */
export const parseLedgerRouting = (values: Readonly<Record<string, { value: string }>>): { routing: ILedgerRouting; errors: string[] } => {
  const routes = new Map<string, IRouteTable>();
  const thresholdValues = new Map<string, string>();
  const errors: string[] = [];
  for (const [key, { value }] of Object.entries(values)) {
    if (key.startsWith(LEDGER_ALARM_KEYS.routePrefix)) {
      const { table, error } = parseRouteTable(value);
      if (error) errors.push(`${key}: ${error}; the orchestrator gets every alarm of the workspace`);
      else routes.set(key.slice(LEDGER_ALARM_KEYS.routePrefix.length), table);
    } else if (key.startsWith(LEDGER_ALARM_KEYS.thresholdPrefix)) {
      thresholdValues.set(key.slice(LEDGER_ALARM_KEYS.thresholdPrefix.length), value);
    }
  }
  const { thresholds, errors: thresholdErrors } = resolveThresholds(thresholdValues);
  return { routing: { routes, thresholds }, errors: [...errors, ...thresholdErrors] };
};

interface IFlagAlertTimer {
  timer: ReturnType<typeof setInterval> | null;
  running: Promise<void> | null;
}

const g = globalThis as unknown as {
  __ptFlagAlertState?: IFlagAlertState;
  __ptFlagAlertTick?: IFlagAlertTimer;
  __ptFlagAlertConfigLogged?: string | null;
  __ptLedgerRoutingLogged?: string | null;
};
if (!g.__ptFlagAlertState) g.__ptFlagAlertState = createFlagAlertState();
if (!g.__ptFlagAlertTick) g.__ptFlagAlertTick = { timer: null, running: null };

export const flagAlertState = (): IFlagAlertState => g.__ptFlagAlertState!;

/**
 * One scheduled tick: skipped while the previous one still runs, and logged when it takes longer
 * than 5 s. `clock` is injectable for tests.
 */
export const runScheduledFlagAlertTick = async (
  deps: IFlagAlertDeps = realDeps(),
  clock: () => number = Date.now,
): Promise<IFlagAlertTickResult | null> => {
  const tick = g.__ptFlagAlertTick!;
  if (tick.running) {
    log.warn('flag alert tick skipped: the previous tick still runs');
    return null;
  }
  const started = clock();
  let result: IFlagAlertTickResult | null = null;
  const run = runFlagAlertTick(deps, flagAlertState(), started).then((r) => {
    result = r;
  }, (err) => {
    log.warn(`flag alert tick failed: ${errorText(err)}`);
  });
  tick.running = run;
  try {
    await run;
  } finally {
    tick.running = null;
    const durationMs = clock() - started;
    if (durationMs > FLAG_ALERT_SLOW_TICK_MS) log.warn({ durationMs }, `flag alert tick took ${durationMs} ms`);
  }
  return result;
};

/** Start the 60 s tick once per process (beside the Mission Control runtime). */
export const startFlagAlerts = (options: { intervalMs?: number; deps?: IFlagAlertDeps } = {}): void => {
  const tick = g.__ptFlagAlertTick!;
  if (tick.timer) return;
  const deps = options.deps ?? realDeps();
  tick.timer = setInterval(() => {
    void runScheduledFlagAlertTick(deps);
  }, options.intervalMs ?? FLAG_ALERT_TICK_MS);
  tick.timer.unref?.();
};

/** Stop the tick and wait for one in flight (`shutdownWs`). */
export const stopFlagAlerts = async (): Promise<void> => {
  const tick = g.__ptFlagAlertTick!;
  if (tick.timer) clearInterval(tick.timer);
  tick.timer = null;
  await tick.running?.catch(() => undefined);
};
