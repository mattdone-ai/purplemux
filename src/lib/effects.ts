import { FINDER_ANOMALY_IDS } from '@/lib/constraint';
import { LEDGER_WAIT_REASONS } from '@/lib/ledger';
import { thresholdReason } from '@/lib/ledger-alarms';
import type { TWakeOtherKind } from '@/lib/wake-class';
import type { IEffectRow, IEffectsResponse, ITabTurn, TEffectFamily } from '@/types/effects';
import type { TFleetFlag } from '@/types/fleet-status';
import type { TFlowRule } from '@/types/flow';
import type { TInboxKind } from '@/types/inbox';
import type { TOrchestrationNudgeKind } from '@/types/status';
import type { ITabDelivery, ITabEventCount } from '@/types/tab-events';

// Effect counts per component (story 15, ADR-0035 §7): of the times a component reached a tab, how often the tab's
// next turn made an acting call. A temporal count, not a causal one; the improvement seat (ADR-HFL-03) reads it.

export const EFFECTS_DEFAULT_DAYS = 7;

/** A paste reaches the agent as a prompt-submit a moment after the delivery is stamped; this much earlier still counts. */
export const PASTE_SLACK_MS = 5_000;

/**
 * The paste's own turn starts within this long of the paste; a later turn was started by another input. Measured live
 * by the story 15 reviewer, paste to turn start for 67 deliveries to idle tabs, 2026-11-02..03: 51% within 5 s, 58%
 * within 30 s, median 4.7 s, p90 1,118 s. The 42% past the bound read noTurn: a turn hundreds of seconds later is
 * another input's, and a wider bound would hand it to the paste.
 */
export const NEXT_TURN_BOUND_MS = 30_000;

/** A component is a deletion candidate only on at least this many deliveries with an observed turn, none followed. */
export const CANDIDATE_MIN_OBSERVED = 10;

export const EFFECTS_SOURCE = 'fired: tab_events rows recorded in the window, any class but the curator\'s call log (ADR-0038) (a firing debounced before the router, '
  + 'or routed to the board or phone only, is not recorded); delivered: those of class urgent or digest delivered in the window '
  + '(0 = never reached a tab, not never fired); followed: the recipient\'s next turn in tab_turns, started within 30 s of the '
  + 'paste, made an acting tool call (edit, write, shell): a count of what came next, not of what the delivery caused; '
  + 'per-probe effect is not measured, counts are per firing kind; all in ledger.sqlite';

// Records keyed by each union: the compiler refuses a kind added to the union and left out here.
const NUDGE_KINDS: Readonly<Record<TOrchestrationNudgeKind, TEffectFamily>> = {
  'needs-input': 'nudge', 'ready-for-review': 'nudge', 'turn-marker': 'nudge', 'idle-no-end-line': 'nudge', 'long-wait': 'nudge',
  'api-error': 'nudge', 'usage-limit': 'nudge', 'turn-ended': 'nudge', inactive: 'nudge', stuck: 'nudge', heartbeat: 'nudge',
  'off-scope': 'nudge', thrash: 'nudge', 'model-drift': 'nudge', 'bg-completed': 'nudge', 'bg-failed': 'nudge',
  'bg-exited-unknown': 'nudge', 'bg-died': 'nudge',
  // A registered liveness probe's two firings (`tab probe set`).
  stalled: 'probe', 'probe-failed': 'probe',
};
// `red-main` is left out: nothing routes an event of that kind; a red main reaches a tab as `alarm:red-main`.
const NOTICE_KINDS: Readonly<Record<TInboxKind | Exclude<TWakeOtherKind, 'flag' | 'alarm' | 'red-main'>, TEffectFamily>> = {
  note: 'notice', watch: 'notice', deploy: 'notice', mission: 'notice', resume: 'notice', 'tab-send': 'notice', rotate: 'notice',
  'standing-order': 'notice', 'curator-candidate': 'notice',
};
const FLOW_RULES: Readonly<Record<TFlowRule, true>> = {
  'lock-busy': true, 'queue-long': true, 'queue-old': true, 'queue-full': true, 'meter-over': true, stale: true,
};
const FLEET_FLAGS: Readonly<Record<TFleetFlag, true>> = { stall: true, unanswered: true, 'waiting-long': true };

const PHONE_ONLY = 'a phone alert (fleet ADR-0023, flow ADR-0032): never typed into a tab, so no turn can follow it';
const RULE_NOT_RECORDED = 'delivered before its rule was recorded with it: the rule cannot be named';

/** The kinds a tab is sent whose effect is counted per rule, from the `rule` column. */
const RULED_KINDS: ReadonlySet<string> = new Set(['flag', 'alarm']);

interface ICatalogEntry {
  family: TEffectFamily;
  /** A component no delivery can measure. */
  notMeasured?: string;
}

/** Every component the code can send, so one that never reached a tab shows a true 0, not an absence. */
export const effectCatalog = (): ReadonlyMap<string, ICatalogEntry> => {
  const catalog = new Map<string, ICatalogEntry>();
  for (const [kind, family] of Object.entries(NUDGE_KINDS)) catalog.set(kind, { family });
  for (const [kind, family] of Object.entries(NOTICE_KINDS)) catalog.set(kind, { family });
  for (const id of FINDER_ANOMALY_IDS) catalog.set(`flag:${id}`, { family: 'flag' });
  for (const reason of LEDGER_WAIT_REASONS) catalog.set(`alarm:${reason}`, { family: 'flag' });
  for (const rule of Object.keys(FLOW_RULES)) catalog.set(`flow:${rule}`, { family: 'phone', notMeasured: PHONE_ONLY });
  for (const flag of Object.keys(FLEET_FLAGS)) catalog.set(`fleet:${flag}`, { family: 'phone', notMeasured: PHONE_ONLY });
  return catalog;
};

/**
 * The component a delivery belongs to: its kind, `flag:<anomaly>`, or `alarm:<reason>` with a derived reason folded into
 * its parent (`land-queue/lock-busy` is `alarm:land-queue`), one row per reason as the thresholds and routes have.
 */
export const componentOf = (delivery: Pick<ITabDelivery, 'kind' | 'rule'>): string => {
  if (!RULED_KINDS.has(delivery.kind) || !delivery.rule) return delivery.kind;
  return `${delivery.kind}:${delivery.kind === 'alarm' ? thresholdReason(delivery.rule) : delivery.rule}`;
};

/** The index of the first turn, by end, that ends at or after `at`; `turns.length` when none does. */
const firstEndingAtOrAfter = (turns: readonly ITabTurn[], at: number): number => {
  let low = 0;
  let high = turns.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (turns[mid].endedAt < at) low = mid + 1;
    else high = mid;
  }
  return low;
};

type TOutcome = 'followed' | 'acted-not' | 'no-turn' | 'mid-turn' | 'pending' | 'closed' | 'unmeasured';

/** A turn still running in this server, by tab: its start, or null when the server did not see it. */
export type TOpenTurns = ReadonlyMap<string, number | null>;

/**
 * What the recipient did after one paste. Its turn is the one running at the paste or the first after it: the first
 * finished turn to end at or after the paste, else the turn still open. One that started more than PASTE_SLACK_MS
 * before the paste was already running (mid-turn); one that started more than NEXT_TURN_BOUND_MS after it was started
 * by something else, so the paste started none (no-turn, judged and not followed).
 */
export const outcomeOf = (
  turns: readonly ITabTurn[], open: number | null | undefined, deliveredAt: number, now: number, tabExists: boolean,
): TOutcome => {
  const turn = turns[firstEndingAtOrAfter(turns, deliveredAt)];
  if (turn || open !== undefined) {
    const startedAt = turn ? turn.startedAt : open ?? null;
    if (startedAt === null) return 'unmeasured';
    if (startedAt < deliveredAt - PASTE_SLACK_MS) return 'mid-turn';
    if (startedAt > deliveredAt + NEXT_TURN_BOUND_MS) return 'no-turn';
    if (!turn) return 'pending';
    if (turn.toolCalls === null) return 'unmeasured';
    return turn.toolCalls > 0 ? 'followed' : 'acted-not';
  }
  if (now < deliveredAt + NEXT_TURN_BOUND_MS) return 'pending';
  if (!tabExists) return 'closed';
  // A tab with no turn recorded in the window shows nothing of what it did: absence is not a measured no.
  return turns.length ? 'no-turn' : 'unmeasured';
};

type TCountKey = 'fired' | 'delivered' | 'inDigest' | 'followed' | 'judged' | 'noTurn' | 'midTurn' | 'pending' | 'closed' | 'unmeasured';

const unmeasuredRow = (component: string, family: TEffectFamily, reason: string): IEffectRow => ({
  component, family, fired: null, delivered: null, inDigest: null, followed: null, judged: null, noTurn: null, midTurn: null,
  pending: null, closed: null, unmeasured: null, candidate: null, candidateReason: null, notMeasured: reason,
});

const zeroRow = (component: string, family: TEffectFamily): IEffectRow => ({
  component, family, fired: 0, delivered: 0, inDigest: 0, followed: 0, judged: 0, noTurn: 0, midTurn: 0, pending: 0, closed: 0,
  unmeasured: 0, candidate: null, candidateReason: null, notMeasured: null,
});

/**
 * A deletion candidate rests on observed turns, never on absence: at least CANDIDATE_MIN_OBSERVED deliveries whose turn
 * was recorded (followed or not), and none followed. A noTurn delivery shows no turn, so it counts toward none.
 */
export const candidateOf = (row: IEffectRow): { candidate: boolean | null; reason: string | null } => {
  if (row.notMeasured !== null || row.judged === null || row.followed === null) return { candidate: null, reason: null };
  const observed = row.judged - (row.noTurn ?? 0);
  if (observed === 0) return { candidate: null, reason: `no observed turn: ${row.noTurn ?? 0} started none, ${row.unmeasured ?? 0} unmeasured` };
  if (observed < CANDIDATE_MIN_OBSERVED) {
    return { candidate: null, reason: `${observed} deliveries with an observed turn, ${CANDIDATE_MIN_OBSERVED} needed` };
  }
  return { candidate: row.followed === 0, reason: `${row.followed} of ${observed} observed turns acted` };
};

const FAMILY_ORDER: readonly TEffectFamily[] = ['nudge', 'probe', 'flag', 'notice', 'other', 'phone'];

export interface IEffectsInput {
  workspaceId: string;
  requestedSince: number;
  /** The read time: the window's end. */
  until: number;
  measuredSince: number | null;
  /** The workspace's tab_events rows recorded in [since, until), counted by kind and rule. */
  fired: readonly ITabEventCount[];
  /** The workspace's deliveries in [since, until), where `since` is the clamped window start. */
  deliveries: readonly ITabDelivery[];
  /** The workspace's turns that ended at or after the clamped window start, oldest end first. */
  turns: readonly ITabTurn[];
  openTurns: TOpenTurns;
  tabExists: (tabId: string) => boolean;
}

/** The window actually counted: the asked one clamped to the first recorded turn; null when none of it is measured. */
export const effectWindowStart = (requestedSince: number, until: number, measuredSince: number | null): number | null =>
  measuredSince === null || measuredSince >= until ? null : Math.max(requestedSince, measuredSince);

const add = (row: IEffectRow, key: TCountKey, n = 1): void => {
  row[key] = (row[key] ?? 0) + n;
};

/**
 * One row per component. A delivery unit is one paste: an urgent event, or a digest counted once per component it
 * carried, and every event of a digest takes the digest's outcome.
 */
export const computeEffects = (input: IEffectsInput): IEffectsResponse => {
  const since = effectWindowStart(input.requestedSince, input.until, input.measuredSince);
  const catalog = effectCatalog();
  const rows = new Map<string, IEffectRow>();
  const header = {
    workspaceId: input.workspaceId, requestedSince: input.requestedSince, until: input.until, since, measuredSince: input.measuredSince,
    nextTurnBoundMs: NEXT_TURN_BOUND_MS, candidateMinObserved: CANDIDATE_MIN_OBSERVED, source: EFFECTS_SOURCE,
  };
  if (since === null) {
    const reason = input.measuredSince === null ? 'no turn recorded yet' : `turns recorded only from ${new Date(input.measuredSince).toISOString()}`;
    for (const [component, entry] of catalog) rows.set(component, unmeasuredRow(component, entry.family, entry.notMeasured ?? reason));
    return { ...header, rows: sortRows(rows) };
  }
  for (const [component, entry] of catalog) {
    rows.set(component, entry.notMeasured ? unmeasuredRow(component, entry.family, entry.notMeasured) : zeroRow(component, entry.family));
  }
  const rowFor = (component: string): IEffectRow => {
    let row = rows.get(component);
    if (!row) {
      row = RULED_KINDS.has(component)
        ? unmeasuredRow(component, 'flag', RULE_NOT_RECORDED)
        : zeroRow(component, catalog.get(component)?.family ?? 'other');
      rows.set(component, row);
    }
    return row;
  };
  for (const count of input.fired) {
    const row = rowFor(componentOf(count));
    if (row.notMeasured === null) add(row, 'fired', count.count);
  }
  const turnsByTab = new Map<string, ITabTurn[]>();
  for (const turn of input.turns) {
    const list = turnsByTab.get(turn.tabId) ?? [];
    list.push(turn);
    turnsByTab.set(turn.tabId, list);
  }
  const counted = new Set<string>();
  for (const delivery of input.deliveries) {
    if (delivery.deliveredAt < since || delivery.deliveredAt >= input.until) continue;
    const component = componentOf(delivery);
    const unit = delivery.digestId === null ? `e:${delivery.seq}` : `d:${delivery.digestId}`;
    if (counted.has(`${component}\0${unit}`)) continue;
    counted.add(`${component}\0${unit}`);
    const row = rowFor(component);
    if (row.notMeasured !== null) continue;
    const outcome = outcomeOf(turnsByTab.get(delivery.tabId) ?? [], input.openTurns.get(delivery.tabId), delivery.deliveredAt,
      input.until, input.tabExists(delivery.tabId));
    tally(row, outcome, delivery.digestId !== null);
  }
  for (const row of rows.values()) {
    const { candidate, reason } = candidateOf(row);
    row.candidate = candidate;
    row.candidateReason = reason;
  }
  return { ...header, rows: sortRows(rows) };
};

const OUTCOME_KEYS: Readonly<Record<TOutcome, readonly TCountKey[]>> = {
  followed: ['judged', 'followed'],
  'acted-not': ['judged'],
  'no-turn': ['judged', 'noTurn'],
  'mid-turn': ['midTurn'],
  pending: ['pending'],
  closed: ['closed'],
  unmeasured: ['unmeasured'],
};

const tally = (row: IEffectRow, outcome: TOutcome, inDigest: boolean): void => {
  add(row, 'delivered');
  if (inDigest) add(row, 'inDigest');
  for (const key of OUTCOME_KEYS[outcome]) add(row, key);
};

const sortRows = (rows: ReadonlyMap<string, IEffectRow>): IEffectRow[] =>
  [...rows.values()].sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || a.component.localeCompare(b.component));
