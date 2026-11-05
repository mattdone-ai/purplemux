import { createLogger } from '@/lib/logger';
import { collectAllTabs } from '@/lib/layout-tree';
import { getProviderByPanelType } from '@/lib/providers';
import { toSessionHistoryProvider } from '@/lib/agent-panel-types';
import { getSessionHistory } from '@/lib/session-history';
import { getWorkspaces } from '@/lib/workspace-store';
import { readWorkspaceLayout } from '@/lib/workspace-layout-read';
import { readSessionTabs, seedSessionTabs, SessionTabsStoreError } from '@/lib/spend/session-tabs-store';
import type { ISessionTabSighting } from '@/lib/spend/session-tabs-store';
import { loadSpendIndex, spendIndexStatus, spendIndexUsage, startSpendIndexer, stopSpendIndexer } from '@/lib/spend/spend-index';
import {
  addUtcDays, buildSpendView, isUtcDay, landingMetric, MAX_SPEND_RANGE_DAYS, rangeDays, spendFloor, tokensByDay, utcDay,
} from '@/lib/spend/spend-model';
import type { ISpendBindingRef, ISpendWorkspaceRef, TSpendLandedRead } from '@/lib/spend/spend-model';
import { buildSpendHoldings, ledgerHorizon } from '@/lib/spend/spend-phase';
import type { ISpendHoldings } from '@/lib/spend/spend-phase';
import { getLedgerStore } from '@/lib/ledger-store';
import type { IFinderSpendAll } from '@/types/constraint';
import type {
  ISpendLandingMetric, ISpendPhasesView, ISpendTokensByDay, ISpendView, TSpendBy, TSpendPeriod,
} from '@/types/spend';

const log = createLogger('spend');

const CLI_BY: readonly TSpendBy[] = ['tab', 'day', 'model', 'role', 'seat', 'phase', 'item'];
const MISSION_BY: readonly TSpendBy[] = [...CLI_BY, 'workspace'];
const LEDGER_BY: readonly TSpendBy[] = ['phase', 'item'];
/**
 * `by=phase|item` replays the ledger synchronously from `since − 7 d`: at most 7 UTC days, so a request
 * reads at most 14 days of events (04-F1: 99 days measured ~8-9 s and over 1 GB on the synthetic peak).
 */
export const MAX_LEDGER_BY_DAYS = 7;

const ledgerRangeError = (by: TSpendBy, days: number): string | null =>
  LEDGER_BY.includes(by) && days > MAX_LEDGER_BY_DAYS
    ? `range: saw ${days} days, expected at most ${MAX_LEDGER_BY_DAYS} for by=${by} (the ledger replay is bounded)` : null;
const DAY_MS = 86_400_000;
const PERIOD_DAYS: Record<TSpendPeriod, number> = { today: 1, '7d': 7, '30d': 30 };
const DEFAULT_DAYS = 7;

export interface ISpendQuery {
  workspaceId: string | 'all';
  from: string;
  to: string;
  by: TSpendBy;
}

export type TSpendQueryResult = { ok: true; query: ISpendQuery } | { ok: false; error: string };

const single = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

const parseBy = (raw: string | undefined, allowed: readonly TSpendBy[]): TSpendBy | null => {
  const by = raw ?? 'tab';
  return (allowed as readonly string[]).includes(by) ? (by as TSpendBy) : null;
};

/** `GET /api/cli/spend`: `since`/`until` are UTC days; the default is the last 7 UTC days, `by=tab`. */
export const parseCliSpendQuery = (query: Record<string, string | string[] | undefined>, now = Date.now()): TSpendQueryResult => {
  const workspaceId = single(query.workspaceId);
  if (!workspaceId) return { ok: false, error: 'workspaceId is required' };
  const by = parseBy(single(query.by), CLI_BY);
  if (!by) return { ok: false, error: `by: saw ${JSON.stringify(single(query.by))}, expected one of ${CLI_BY.join(', ')}` };
  const since = single(query.since);
  const until = single(query.until);
  for (const [name, value] of [['since', since], ['until', until]] as const) {
    if (value !== undefined && !isUtcDay(value)) return { ok: false, error: `${name}: saw ${JSON.stringify(value)}, expected a UTC day YYYY-MM-DD` };
  }
  const to = until ?? utcDay(now);
  const from = since ?? addUtcDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) return { ok: false, error: `since ${from} is after until ${to}` };
  const days = rangeDays(from, to);
  if (days > MAX_SPEND_RANGE_DAYS) return { ok: false, error: `range: saw ${days} days, expected at most ${MAX_SPEND_RANGE_DAYS}` };
  const ledgerRange = ledgerRangeError(by, days);
  if (ledgerRange) return { ok: false, error: ledgerRange };
  const floor = spendFloor(now);
  if (from < floor) {
    return { ok: false, error: `since: saw ${from}, expected a day on or after ${floor} (spend keeps the last ${MAX_SPEND_RANGE_DAYS} UTC days)` };
  }
  return { ok: true, query: { workspaceId, from, to, by } };
};

/** `GET /api/mission-control/spend`: `workspaceId=WS|all`, `period=today|7d|30d`; `by=workspace` only with `all`. */
export const parseMissionSpendQuery = (query: Record<string, string | string[] | undefined>, now = Date.now()): TSpendQueryResult => {
  const workspaceId = single(query.workspaceId);
  if (!workspaceId) return { ok: false, error: 'workspaceId is required (a workspace id or all)' };
  const period = single(query.period) ?? '7d';
  if (!Object.hasOwn(PERIOD_DAYS, period)) return { ok: false, error: `period: saw ${JSON.stringify(period)}, expected today, 7d or 30d` };
  const by = parseBy(single(query.by), MISSION_BY);
  if (!by) return { ok: false, error: `by: saw ${JSON.stringify(single(query.by))}, expected one of ${MISSION_BY.join(', ')}` };
  if (by === 'workspace' && workspaceId !== 'all') return { ok: false, error: 'by=workspace needs workspaceId=all' };
  if (LEDGER_BY.includes(by) && workspaceId === 'all') return { ok: false, error: `by=${by} needs one workspace: the ledger is per workspace` };
  const ledgerRange = ledgerRangeError(by, PERIOD_DAYS[period as TSpendPeriod]);
  if (ledgerRange) return { ok: false, error: ledgerRange };
  const to = utcDay(now);
  return { ok: true, query: { workspaceId, from: addUtcDays(to, -(PERIOD_DAYS[period as TSpendPeriod] - 1)), to, by } };
};

const loadWorkspaceRefs = async (): Promise<ISpendWorkspaceRef[]> => {
  const { workspaces } = await getWorkspaces();
  return Promise.all(workspaces.map(async (workspace) => {
    const layout = await readWorkspaceLayout(workspace.id).catch(() => null);
    const tabs: Record<string, string> = {};
    for (const tab of layout ? collectAllTabs(layout.root) : []) tabs[tab.id] = tab.name || tab.id;
    return {
      id: workspace.id,
      name: workspace.name,
      orchestratorTabId: workspace.orchestration?.enabled ? workspace.orchestration.orchestratorTabId : null,
      tabs,
    };
  }));
};

export const workspaceExists = async (workspaceId: string): Promise<boolean> =>
  (await getWorkspaces()).workspaces.some((workspace) => workspace.id === workspaceId);

const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/**
 * The ledger's holdings for `by=phase|item` over [from, to]. A ledger that cannot be read attributes
 * no phase (every slot is before its history) and says why; it never fails the spend answer.
 */
const loadHoldings = (workspaceId: string, from: string, to: string, now: number): { holdings: Record<string, ISpendHoldings>; error: string | null } => {
  try {
    const replay = getLedgerStore().phaseReplay(workspaceId, dayStart(from), Math.min(now, dayStart(to) + DAY_MS));
    return { holdings: { [workspaceId]: buildSpendHoldings(replay, ledgerHorizon(replay.firstOpenedAt, now)) }, error: null };
  } catch (error) {
    log.warn(`spend phase: ledger not read for ${workspaceId}: ${(error as Error).message}`);
    return { holdings: {}, error: `ledger.sqlite unreadable (${(error as Error).message}); no usage is attributed to a phase or item` };
  }
};

/** Ranges closed `landed` in [from, to] (UTC days, `to` clipped to now), or why the ledger cannot say. */
const landedIn = (workspaceId: string, from: string, to: string, now: number): TSpendLandedRead => {
  try {
    const store = getLedgerStore();
    if (!store.holdsItems(workspaceId)) return { state: 'empty' };
    return { state: 'read', landed: store.landedRanges(workspaceId, dayStart(from), Math.min(now + 1, dayStart(to) + DAY_MS)) };
  } catch (error) {
    log.warn(`spend: landed ranges not read for ${workspaceId}: ${(error as Error).message}`);
    return { state: 'unreadable' };
  }
};

/** The one spend answer for the CLI and the human route. Reads the index in memory; never parses a transcript. */
export const getSpendView = async (query: ISpendQuery, now = Date.now(), options: { wall?: boolean } = {}): Promise<ISpendView> => {
  await loadSpendIndex();
  let bindings: Record<string, ISpendBindingRef> = {};
  let bindingError: string | null = null;
  try {
    bindings = await readSessionTabs();
  } catch (error) {
    if (!(error instanceof SessionTabsStoreError)) throw error;
    bindingError = `${error.message}; no usage is attributed to a tab`;
  }
  const ledger = LEDGER_BY.includes(query.by) && query.workspaceId !== 'all'
    ? loadHoldings(query.workspaceId, query.from, query.to, now) : { holdings: undefined, error: null };
  const index = spendIndexStatus();
  const error = [index.error, bindingError, ledger.error].filter(Boolean).join('; ');
  return buildSpendView({
    usage: spendIndexUsage(),
    bindings,
    workspaces: await loadWorkspaceRefs(),
    ...query,
    generatedAt: now,
    index: { ...index, ...(error ? { error } : {}) },
    holdings: ledger.holdings,
    ledgerUnreadable: ledger.error !== null,
    wall: options.wall,
  });
};

/** `GET /api/cli/spend/phases`: `day` is a UTC day from the spend floor to today; default today. */
export const parseSpendPhasesQuery = (
  query: Record<string, string | string[] | undefined>, now = Date.now(),
): { ok: true; workspaceId: string; day: string } | { ok: false; error: string } => {
  const workspaceId = single(query.workspaceId);
  if (!workspaceId) return { ok: false, error: 'workspaceId is required' };
  const today = utcDay(now);
  const day = single(query.day) ?? today;
  if (!isUtcDay(day)) return { ok: false, error: `day: saw ${JSON.stringify(day)}, expected a UTC day YYYY-MM-DD` };
  const floor = spendFloor(now);
  if (day < floor || day > today) return { ok: false, error: `day: saw ${day}, expected a day from ${floor} to ${today}` };
  return { ok: true, workspaceId, day };
};

/**
 * `cache_read_tokens_per_landed_item` for the UTC day `day` and the 7 UTC days ending on it (the
 * first clipped to the spend floor). The constraint finder reads it through `getFinderSpend`.
 */
export const getCacheReadPerLandedItem = async (
  workspaceId: string, day: string, now = Date.now(),
): Promise<{ day: ISpendLandingMetric; '7d': ISpendLandingMetric; week: ISpendView }> => {
  const floor = spendFloor(now);
  const weekFrom = addUtcDays(day, -6) < floor ? floor : addUtcDays(day, -6);
  const week = await getSpendView({ workspaceId, from: weekFrom, to: day, by: 'day' }, now);
  const dayCacheReads = week.rows.find((row) => row.key === day)?.cacheReadTokens ?? 0;
  return {
    day: landingMetric('day', day, day, dayCacheReads, landedIn(workspaceId, day, day, now), week.index.state),
    '7d': landingMetric('7d', weekFrom, day, week.totals.cacheReadTokens, landedIn(workspaceId, weekFrom, day, now), week.index.state),
    week,
  };
};

/** The per-phase table of one UTC day (`purplemux spend phases`): tokens by kind, est. cost and wall time per phase. */
export const getSpendPhases = async (workspaceId: string, day: string, now = Date.now()): Promise<ISpendPhasesView> => {
  const view = await getSpendView({ workspaceId, from: day, to: day, by: 'phase' }, now, { wall: true });
  const { week: _week, ...metric } = await getCacheReadPerLandedItem(workspaceId, day, now);
  return { ...view, day, cacheReadPerLandedItem: metric };
};

/**
 * The finder's one spend read per tick (ADR-0034; story 04 owns the join): one by-workspace view of the
 * last 7 UTC days, and per workspace its landed ranges and `cache_read_tokens_per_landed_item` over
 * the same days, from the one landed count (`ledger-store.landedRanges`).
 */
export const getFinderSpend = async (workspaceIds: readonly string[], now = Date.now()): Promise<IFinderSpendAll> => {
  const to = utcDay(now);
  const from = addUtcDays(to, -6);
  const view = await getSpendView({ workspaceId: 'all', from, to, by: 'workspace' }, now);
  const rows = new Map(view.rows.map((row) => [row.key, row]));
  return {
    index: view.index,
    since: dayStart(from),
    byWorkspace: new Map(workspaceIds.map((workspaceId) => {
      // A workspace with no row in the by-workspace view used no tokens in these days.
      const row = rows.get(workspaceId);
      const cacheReadTokens = row?.cacheReadTokens ?? 0;
      const landed = landedIn(workspaceId, from, to, now);
      return [workspaceId, {
        costUsd: row ? row.costUsd : 0,
        cacheReadTokens,
        landedRanges: landed.state === 'read' ? landed.landed : null,
        cacheReadTokensPerLandedItem: landingMetric('7d', from, to, cacheReadTokens, landed, view.index.state),
      }];
    })),
  };
};

/**
 * Tokens per UTC day for the burndown's workspace, gaps filled with 0. Absent
 * until a full index pass has run since boot: a partial count is never drawn.
 */
export const getSpendTokensByDay = async (workspaceId: string, from: string, now = Date.now()): Promise<ISpendTokensByDay[] | undefined> => {
  const to = utcDay(now);
  const start = from > to ? to : (rangeDays(from, to) > MAX_SPEND_RANGE_DAYS ? addUtcDays(to, -(MAX_SPEND_RANGE_DAYS - 1)) : from);
  const view = await getSpendView({ workspaceId, from: start, to, by: 'day' }, now);
  if (view.index.state !== 'ready') return undefined;
  const byDay = new Map(tokensByDay(view).map((row) => [row.day, row]));
  const days: ISpendTokensByDay[] = [];
  for (let day = start; day <= to; day = addUtcDays(day, 1)) {
    days.push(byDay.get(day) ?? { day, totalTokens: 0, sidechainTokens: 0, cacheReadTokens: 0 });
  }
  return days;
};

/** What session history and the layouts already know, so the store starts with every binding the server holds. */
export const seedSessionTabBindings = async (now = Date.now()): Promise<number> => {
  const sightings: ISessionTabSighting[] = [];
  for (const entry of await getSessionHistory().catch(() => [])) {
    if (!entry.agentSessionId || !entry.workspaceId || !entry.tabId) continue;
    sightings.push({ providerId: entry.providerId, sessionId: entry.agentSessionId, workspaceId: entry.workspaceId,
      tabId: entry.tabId, seenAt: entry.completedAt || entry.startedAt || now });
  }
  const { workspaces } = await getWorkspaces();
  for (const workspace of workspaces) {
    const layout = await readWorkspaceLayout(workspace.id).catch(() => null);
    for (const tab of layout ? collectAllTabs(layout.root) : []) {
      const provider = getProviderByPanelType(tab.panelType);
      const sessionId = provider?.readSessionId(tab);
      if (!provider || !sessionId) continue;
      sightings.push({ providerId: toSessionHistoryProvider(provider.id), sessionId, workspaceId: workspace.id, tabId: tab.id,
        ...(tab.name ? { tabName: tab.name } : {}), seenAt: now });
    }
  }
  return seedSessionTabs(sightings, now);
};

export const startSpend = (): Promise<void> => startSpendIndexer({
  beforeFirstPass: async () => {
    try {
      const seeded = await seedSessionTabBindings();
      log.info(`session-tabs seeded with ${seeded} binding(s)`);
    } catch (error) {
      log.warn(`session-tabs seed failed: ${(error as Error).message}`);
    }
  },
});

export const stopSpend = (): Promise<void> => stopSpendIndexer();
