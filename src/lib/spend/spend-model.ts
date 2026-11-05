import { calculateCost, formatModelDisplayName, formatTokenCount } from '@/lib/claude-tokens';
import type { ISpendHoldings } from '@/lib/spend/spend-phase';
import type {
  ISpendIndexStatus, ISpendLandingMetric, ISpendRow, ISpendTokensByDay, ISpendUsage, ISpendView, TSpendBy, TSpendPhase, TSpendProvider,
  TSpendUnattributedReason,
} from '@/types/spend';

export const GLOBAL_WORKSPACE_KEY = 'global';
export const UNATTRIBUTED_KEY = 'unattributed';
export const MAX_SPEND_RANGE_DAYS = 92;
/** Message-time resolution of a Claude bucket (harness-flow-loop 04 consult ruling: 5-min UTC slots). */
export const SPEND_SLOT_MS = 5 * 60_000;

export interface ISpendBindingRef {
  workspaceId: string;
  tabId: string;
  /** The tab's name when the binding was last recorded; names the seat of a tab closed since. */
  tabName?: string;
}

export interface ISpendWorkspaceRef {
  id: string;
  name: string;
  /** The enabled orchestrator now; null when orchestration is off. */
  orchestratorTabId: string | null;
  /** Tab id → display name for every tab in the layout now. */
  tabs: Record<string, string>;
}

export interface ISpendModelInput {
  usage: ISpendUsage[];
  /** Keyed `<provider>:<sessionId>` (session-tabs.json). */
  bindings: Record<string, ISpendBindingRef>;
  workspaces: ISpendWorkspaceRef[];
  workspaceId: string | 'all';
  from: string;
  to: string;
  by: TSpendBy;
  generatedAt: number;
  index: ISpendIndexStatus;
  /** `by=phase|item`: the ledger holdings per workspace; a workspace without one has no ledger history. */
  holdings?: Record<string, ISpendHoldings>;
  /** ledger.sqlite could not be read: slotted bound usage is `ledger-unreadable`, not before the ledger's history. */
  ledgerUnreadable?: boolean;
  /** Collect each row's distinct slots as `wallMs` (`spend phases`). */
  wall?: boolean;
}

interface IAccumulator {
  key: string;
  label: string;
  providers: Set<TSpendProvider>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  sidechainTokens: number;
  costUsd: number;
  priced: boolean;
  unpricedTokens: number;
  cacheReadCost: number;
  /** False once a priced usage reports one session cost (Codex, Grok): its cache-read part is not known. */
  cacheReadCostSplit: boolean;
  slots: Set<number> | null;
  slotless: boolean;
}

interface IResolvedUsage {
  usage: ISpendUsage;
  workspaceId: string | null;
  tabId: string | null;
  tabName: string | null;
}

const ROLE_LABELS: Record<string, string> = { orchestrator: 'Orchestrator', other: 'Other tabs' };
const PHASE_LABELS: Readonly<Record<TSpendPhase, string>> = {
  plan: 'Plan', build: 'Build', review: 'Review', evaluate: 'Evaluate', land: 'Land', coordinate: 'Coordinate',
  other: 'Other (held no ledger item)',
};
const PHASE_ORDER = Object.keys(PHASE_LABELS);
const REASON_LABELS: Readonly<Record<TSpendUnattributedReason, string>> = {
  'no-binding': 'Not bound to a tab',
  'no-workspace': 'Workspace not known',
  'no-message-time': 'No message time (Codex, Grok, or indexed before 5-min slots)',
  'ledger-unreadable': 'The ledger could not be read',
  'no-ledger-history': 'Before the ledger\'s history',
  'no-held-item': 'Held no ledger item',
};
const REASON_ORDER = Object.keys(REASON_LABELS);
const LEDGER_BY: readonly TSpendBy[] = ['phase', 'item'];

type TKey = { key: string } | { reason: TSpendUnattributedReason };

export const usageTokens = (usage: ISpendUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheCreation;

const usageCost = (usage: ISpendUsage): number | null => {
  if (usage.providerId !== 'claude') return usage.costUsd ?? null;
  return calculateCost(usage.model, usage.input, usage.output, usage.cacheCreation5m, usage.cacheCreation1h, usage.cacheRead);
};

const emptyAccumulator = (key: string, label: string, wall = false): IAccumulator => ({
  key, label, providers: new Set(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  sidechainTokens: 0, costUsd: 0, priced: false, unpricedTokens: 0, cacheReadCost: 0, cacheReadCostSplit: true,
  slots: wall ? new Set() : null, slotless: false,
});

const add = (acc: IAccumulator, usage: ISpendUsage): void => {
  const tokens = usageTokens(usage);
  acc.providers.add(usage.providerId);
  acc.inputTokens += usage.input;
  acc.outputTokens += usage.output;
  acc.cacheReadTokens += usage.cacheRead;
  acc.cacheCreationTokens += usage.cacheCreation;
  if (usage.sidechain) acc.sidechainTokens += tokens;
  if (acc.slots && usage.slot !== undefined) acc.slots.add(usage.slot);
  else if (acc.slots) acc.slotless = true;
  const cost = usageCost(usage);
  if (cost === null) {
    acc.unpricedTokens += tokens;
  } else {
    acc.costUsd += cost;
    acc.priced = true;
    if (usage.providerId === 'claude') acc.cacheReadCost += calculateCost(usage.model, 0, 0, 0, 0, usage.cacheRead) ?? 0;
    else acc.cacheReadCostSplit = false;
  }
};

const toRow = (acc: IAccumulator): ISpendRow => ({
  key: acc.key,
  label: acc.label,
  providerId: acc.providers.size === 1 ? [...acc.providers][0] : null,
  inputTokens: acc.inputTokens,
  outputTokens: acc.outputTokens,
  cacheReadTokens: acc.cacheReadTokens,
  cacheCreationTokens: acc.cacheCreationTokens,
  totalTokens: acc.inputTokens + acc.outputTokens + acc.cacheReadTokens + acc.cacheCreationTokens,
  sidechainTokens: acc.sidechainTokens,
  costUsd: acc.priced ? acc.costUsd : null,
  unpricedTokens: acc.unpricedTokens,
  cacheReadCostUsd: acc.priced && acc.cacheReadCostSplit ? acc.cacheReadCost : null,
  ...(acc.slots ? { wallMs: acc.slots.size === 0 && acc.slotless ? null : acc.slots.size * SPEND_SLOT_MS } : {}),
});

/**
 * The workspace comes from where the transcript lives when that names one; the
 * tab only from a binding in that same workspace. A session no binding names
 * stays unattributed: never guessed from a tab name, never dropped (ADR-0030).
 */
const resolve = (usage: ISpendUsage, bindings: Record<string, ISpendBindingRef>): IResolvedUsage => {
  const key = `${usage.providerId}:${usage.sessionId}`;
  const binding = Object.hasOwn(bindings, key) ? bindings[key] : null;
  const workspaceId = usage.workspaceId ?? binding?.workspaceId ?? null;
  const bound = binding && binding.workspaceId === workspaceId ? binding : null;
  return { usage, workspaceId, tabId: bound?.tabId ?? null, tabName: bound?.tabName ?? null };
};

/** The open tab's name, else the name recorded with the binding; null when neither is known. */
const seatName = (resolved: IResolvedUsage, workspaces: Map<string, ISpendWorkspaceRef>): string | null => {
  if (!resolved.tabId) return null;
  const workspace = resolved.workspaceId ? workspaces.get(resolved.workspaceId) : undefined;
  if (workspace && Object.hasOwn(workspace.tabs, resolved.tabId)) return workspace.tabs[resolved.tabId];
  return resolved.tabName;
};

const seatKey = (resolved: IResolvedUsage, workspaces: Map<string, ISpendWorkspaceRef>, scope: string | 'all'): string | null => {
  if (!resolved.tabId) return null;
  const name = seatName(resolved, workspaces);
  const seat = name ?? `tab:${resolved.tabId}`;
  return scope === 'all' ? `${resolved.workspaceId}/${seat}` : seat;
};

/** The ledger's answer for one usage: the item its tab held at the slot's midpoint, or why there is none. */
const heldFor = (
  resolved: IResolvedUsage,
  workspaces: Map<string, ISpendWorkspaceRef>,
  input: ISpendModelInput,
): { held: ReturnType<ISpendHoldings['heldBy']> } | { reason: TSpendUnattributedReason } => {
  if (!resolved.tabId) return { reason: 'no-binding' };
  if (resolved.usage.slot === undefined) return { reason: 'no-message-time' };
  if (input.ledgerUnreadable) return { reason: 'ledger-unreadable' };
  const { holdings } = input;
  const at = resolved.usage.slot + SPEND_SLOT_MS / 2;
  const ledger = resolved.workspaceId && holdings && Object.hasOwn(holdings, resolved.workspaceId) ? holdings[resolved.workspaceId] : null;
  if (!ledger || ledger.horizon === null || at < ledger.horizon) return { reason: 'no-ledger-history' };
  return { held: ledger.heldBy(resolved.tabId, seatName(resolved, workspaces), at) };
};

const keyFor = (
  resolved: IResolvedUsage,
  input: ISpendModelInput,
  workspaces: Map<string, ISpendWorkspaceRef>,
): TKey => {
  const orNoBinding = (key: string | null): TKey => (key === null ? { reason: 'no-binding' } : { key });
  switch (input.by) {
    case 'day': return { key: resolved.usage.day };
    case 'model': return { key: resolved.usage.model };
    case 'workspace': return resolved.workspaceId === null ? { reason: 'no-workspace' } : { key: resolved.workspaceId };
    case 'tab': return orNoBinding(resolved.tabId);
    case 'seat': return orNoBinding(seatKey(resolved, workspaces, input.workspaceId));
    case 'role': {
      if (!resolved.tabId) return { reason: 'no-binding' };
      const orchestrator = resolved.workspaceId ? workspaces.get(resolved.workspaceId)?.orchestratorTabId : null;
      return { key: orchestrator === resolved.tabId ? 'orchestrator' : 'other' };
    }
    case 'phase':
    case 'item': {
      const answer = heldFor(resolved, workspaces, input);
      if ('reason' in answer) return answer;
      if (input.by === 'phase') return { key: answer.held?.phase ?? 'other' };
      return answer.held ? { key: answer.held.itemKey } : { reason: 'no-held-item' };
    }
  }
};

const labelFor = (
  key: string,
  by: TSpendBy,
  resolved: IResolvedUsage,
  workspaces: Map<string, ISpendWorkspaceRef>,
  scope: string | 'all',
): string => {
  switch (by) {
    case 'seat': {
      const name = seatName(resolved, workspaces) ?? `${resolved.tabId} (closed, name not recorded)`;
      if (scope !== 'all') return name;
      const workspace = resolved.workspaceId ? workspaces.get(resolved.workspaceId)?.name ?? `${resolved.workspaceId} (removed)` : 'workspace not known';
      return `${name} · ${workspace}`;
    }
    case 'day': return key;
    case 'model': return resolved.usage.providerId === 'claude' ? formatModelDisplayName(key) : key;
    case 'role': return ROLE_LABELS[key] ?? key;
    case 'phase': return Object.hasOwn(PHASE_LABELS, key) ? PHASE_LABELS[key as TSpendPhase] : 'Unrecognised phase (not in the phase table)';
    case 'item': return key;
    case 'workspace':
      if (key === GLOBAL_WORKSPACE_KEY) return 'Outside every workspace';
      return workspaces.get(key)?.name ?? `${key} (removed)`;
    case 'tab': {
      const workspace = resolved.workspaceId ? workspaces.get(resolved.workspaceId) : undefined;
      const name = workspace && Object.hasOwn(workspace.tabs, key) ? workspace.tabs[key] : null;
      return name ?? `${key} (closed)`;
    }
  }
};

const compareRows = (by: TSpendBy) => (a: ISpendRow, b: ISpendRow): number => {
  if (by === 'day') return a.key.localeCompare(b.key);
  if (by === 'phase') return PHASE_ORDER.indexOf(a.key) - PHASE_ORDER.indexOf(b.key);
  return (b.totalTokens - a.totalTokens) || a.key.localeCompare(b.key);
};

export const isUtcDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addUtcDays = (day: string, days: number): string =>
  utcDay(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000);

/** The oldest UTC day spend serves: today − 91 (92 days, ADR-0030 §4 Retention). */
export const spendFloor = (now: number): string => addUtcDays(utcDay(now), -(MAX_SPEND_RANGE_DAYS - 1));

/** Inclusive length of a UTC day range. */
export const rangeDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

const UNATTRIBUTED_LABELS: Partial<Record<TSpendBy, string>> = {
  tab: REASON_LABELS['no-binding'],
  role: REASON_LABELS['no-binding'],
  seat: REASON_LABELS['no-binding'],
  workspace: REASON_LABELS['no-workspace'],
};

/**
 * Rows in, view out. Invariant per `by` and per token field: sum(rows) + unattributed = totals;
 * for `phase` and `item`, the reasons also sum to `unattributed`.
 */
export const buildSpendView = (input: ISpendModelInput): ISpendView => {
  const workspaces = new Map(input.workspaces.map((workspace) => [workspace.id, workspace]));
  const wall = input.wall === true;
  const ledgerBy = LEDGER_BY.includes(input.by);
  const totals = emptyAccumulator('total', 'Total', wall);
  const unattributed = emptyAccumulator(UNATTRIBUTED_KEY, UNATTRIBUTED_LABELS[input.by] ?? 'Not attributed', wall);
  const reasons = new Map<TSpendUnattributedReason, IAccumulator>();
  const rows = new Map<string, IAccumulator>();
  let unattributedCount = 0;

  for (const usage of input.usage) {
    if (usage.day < input.from || usage.day > input.to) continue;
    const resolved = resolve(usage, input.bindings);
    if (input.workspaceId !== 'all' && resolved.workspaceId !== input.workspaceId) continue;
    add(totals, usage);
    const key = keyFor(resolved, input, workspaces);
    if ('reason' in key) {
      add(unattributed, usage);
      unattributedCount += 1;
      let part = reasons.get(key.reason);
      if (!part) {
        part = emptyAccumulator(key.reason, REASON_LABELS[key.reason], wall);
        reasons.set(key.reason, part);
      }
      add(part, usage);
      continue;
    }
    let row = rows.get(key.key);
    if (!row) {
      row = emptyAccumulator(key.key, labelFor(key.key, input.by, resolved, workspaces, input.workspaceId), wall);
      rows.set(key.key, row);
    }
    add(row, usage);
  }
  if (ledgerBy && reasons.size === 1) unattributed.label = [...reasons.values()][0].label;
  const holdings = input.holdings ?? {};
  const scoped = input.workspaceId !== 'all' && Object.hasOwn(holdings, input.workspaceId) ? holdings[input.workspaceId] : null;

  return {
    workspaceId: input.workspaceId,
    from: input.from,
    to: input.to,
    by: input.by,
    generatedAt: input.generatedAt,
    totals: toRow(totals),
    rows: [...rows.values()].map(toRow).sort(compareRows(input.by)),
    unattributed: unattributedCount > 0 ? toRow(unattributed) : null,
    ...(input.by === 'role' ? { roleBasis: 'current-orchestrator' as const } : {}),
    ...(ledgerBy ? {
      unattributedReasons: [...reasons.values()].map(toRow).sort((a, b) => REASON_ORDER.indexOf(a.key) - REASON_ORDER.indexOf(b.key)),
      phaseBasis: { slotMs: SPEND_SLOT_MS, ledgerHorizon: scoped?.horizon ?? null, ledgerReadable: input.ledgerUnreadable !== true },
    } : {}),
    dayBasis: { claude: 'message', codex: 'session-start', grok: 'session-start' },
    index: input.index,
  };
};

/** Per-day tokens for one workspace, oldest first (the burndown's second axis). */
export const tokensByDay = (view: ISpendView): ISpendTokensByDay[] =>
  view.rows.map((row) => ({ day: row.key, totalTokens: row.totalTokens, sidechainTokens: row.sidechainTokens, cacheReadTokens: row.cacheReadTokens }));

/** Cache reads as a fraction of the row's tokens; null when the row has none (no share, never 0%). */
export const cacheReadShare = (row: Pick<ISpendRow, 'cacheReadTokens' | 'totalTokens'>): number | null =>
  row.totalTokens > 0 ? row.cacheReadTokens / row.totalTokens : null;

/** The cache reads' part of the estimated cost; null when the cost or its cache-read part is not known. */
export const cacheReadCostShare = (row: Partial<Pick<ISpendRow, 'cacheReadCostUsd' | 'costUsd'>>): number | null =>
  row.cacheReadCostUsd !== null && row.cacheReadCostUsd !== undefined && row.costUsd ? row.cacheReadCostUsd / row.costUsd : null;

/**
 * "4.5M cache reads (64% of tokens, est. 40% of cost)": the one wording every spend face uses beside
 * its total; the cost part only when the row carries a known split.
 */
export const formatCacheReads = (
  row: Pick<ISpendRow, 'cacheReadTokens' | 'totalTokens'> & Partial<Pick<ISpendRow, 'cacheReadCostUsd' | 'costUsd'>>,
): string => {
  const share = cacheReadShare(row);
  const cost = cacheReadCostShare(row);
  const parts = [
    ...(share === null ? [] : [`${Math.round(share * 100)}% of tokens`]),
    ...(cost === null ? [] : [`est. ${Math.round(cost * 100)}% of cost`]),
  ];
  return `${formatTokenCount(row.cacheReadTokens)} cache reads${parts.length ? ` (${parts.join(', ')})` : ''}`;
};

/** What the ledger said about a window's landings: a count, or why there is none. */
export type TSpendLandedRead = { state: 'read'; landed: number } | { state: 'empty' } | { state: 'unreadable' };

/**
 * `cache_read_tokens_per_landed_item` (harness-flow-loop 04 AC 4): the window's cache reads over the
 * ranges closed `landed` in it. Not measured, with the reason, when the ledger cannot be read or holds
 * no item for the workspace yet, when the index is partial, or when no range landed.
 */
export const landingMetric = (
  window: ISpendLandingMetric['window'], from: string, to: string, cacheReadTokens: number, landed: TSpendLandedRead,
  indexState: ISpendIndexStatus['state'],
): ISpendLandingMetric => {
  const reason = landed.state === 'unreadable' ? 'the ledger could not be read'
    : landed.state === 'empty' ? 'the ledger holds no items for this workspace yet'
      : indexState !== 'ready' ? `spend index ${indexState}: cache reads are partial`
        : landed.landed === 0 ? 'no range closed landed in the window' : null;
  const landedItems = landed.state === 'read' ? landed.landed : null;
  return {
    metric: 'cache_read_tokens_per_landed_item', window, from, to, cacheReadTokens, landedItems,
    value: reason === null && landedItems ? cacheReadTokens / landedItems : null, reason,
  };
};
