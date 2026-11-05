// Browser-safe: ledger alarm routing (ADR-HFL-03 decision 1, ADR-0032 §5 amended 2026-11-03). Which seat hears
// of a stuck item (fleet config `ledger.route.<ws>`), after how long (`ledger.threshold.<reason>`), and the one
// line it reads. The flag tick (`flag-alerts.ts`) applies the raise edge and delivers through the tab event router.

import { FINDER_ANOMALY_IDS } from '@/lib/constraint';
import { LEDGER_INTERVAL_REASONS, LEDGER_WAIT_REASONS } from '@/lib/ledger';
import type { IBoardStuckItem } from '@/types/constraint';
import type { TLedgerWaitReason } from '@/types/ledger';

const MINUTE_MS = 60_000;

export const LEDGER_ALARM_KEYS = {
  routePrefix: 'ledger.route.',
  thresholdPrefix: 'ledger.threshold.',
  route: (workspaceId: string) => `ledger.route.${workspaceId}`,
  threshold: (reason: string) => `ledger.threshold.${reason}`,
} as const;

/** ADR-HFL-03 decision 1, in minutes. A reason with no threshold raises no alarm until one is set. */
export const DEFAULT_ALARM_THRESHOLD_MINUTES: Readonly<Partial<Record<TLedgerWaitReason, number>>> = {
  'red-main': 0,
  'chain-down': 10,
  'not-armed': 20,
  'group-partner': 30,
  'agent-idle': 30,
  'land-queue': 60,
  'own-lane-order': 60,
  owner: 120,
};

const THRESHOLD_MAX_MINUTES = 10_080;
export const THRESHOLD_OFF = 'off';

/**
 * The v2 default table (ADR-HFL-03 decision 1, amended by consult 13). `own-lane-order` goes to its holder, the lane's
 * own seat; `group-partner` to the orchestrator by name, since its clear is a `.v2/train-groups` edit or a stop of
 * another lane's unit and its holder (`keyed-group`) names no seat. `red-main` goes to its holder, the arming tab of
 * the last landed range (v2 note n-YQMUaheJdq), and the orchestrator; `owner` to the board only. A reason the table
 * does not name goes to the orchestrator.
 */
export const V2_DEFAULT_ROUTE = [
  '$holder=not-armed,own-lane-order,review-findings,rework,agent-idle',
  'v2-kit=land-queue,lock-wait,under-lock-gate,pre-flight-gate,gate-slot,host-load,chain-down',
  '$holder+$orchestrator=red-main',
  '$board=owner',
  '$orchestrator=group-partner,deploy-*',
].join(';');

export type TAlarmTarget =
  | { kind: 'holder' }
  | { kind: 'orchestrator' }
  /** Recorded and shown on the board; typed into no tab. */
  | { kind: 'board' }
  | { kind: 'tab'; name: string };

export interface IRouteEntry {
  /** A reason, an anomaly id, or a prefix ending in `*`. */
  pattern: string;
  targets: TAlarmTarget[];
}

export interface IRouteTable {
  entries: IRouteEntry[];
}

export const EMPTY_ROUTE_TABLE: IRouteTable = { entries: [] };
export const FALLBACK_TARGETS: readonly TAlarmTarget[] = [{ kind: 'orchestrator' }];

const TAB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SPECIAL_TARGETS: Readonly<Record<string, TAlarmTarget>> = {
  $holder: { kind: 'holder' },
  $orchestrator: { kind: 'orchestrator' },
  $board: { kind: 'board' },
};

const KNOWN_PATTERNS: ReadonlySet<string> = new Set<string>([...LEDGER_WAIT_REASONS, ...LEDGER_INTERVAL_REASONS, ...FINDER_ANOMALY_IDS]);

const parseTarget = (token: string): TAlarmTarget | string => {
  if (Object.prototype.hasOwnProperty.call(SPECIAL_TARGETS, token)) return SPECIAL_TARGETS[token];
  if (token.startsWith('$')) return `unknown target ${token} (one of $holder, $orchestrator, $board, or a tab name)`;
  return TAB_NAME.test(token) ? { kind: 'tab', name: token } : `target ${JSON.stringify(token)} is not a tab name`;
};

const knownPattern = (pattern: string): boolean => {
  if (!pattern.endsWith('*')) return KNOWN_PATTERNS.has(pattern);
  const prefix = pattern.slice(0, -1);
  return prefix.length > 0 && [...KNOWN_PATTERNS].some((reason) => reason.startsWith(prefix));
};

/**
 * `ledger.route.<ws>`: groups `<target>[+<target>]=<pattern>[,<pattern>]` joined by `;`. A pattern is a wait reason,
 * a derived reason, an anomaly id, or a prefix ending in `*` (`deploy-*`). Any malformed group refuses the whole
 * value: half a table would route the rest to the orchestrator without saying so.
 */
export const parseRouteTable = (raw: string | null): { table: IRouteTable; error: string | null } => {
  if (raw === null || raw.trim() === '') return { table: EMPTY_ROUTE_TABLE, error: null };
  const entries: IRouteEntry[] = [];
  const seen = new Set<string>();
  const refuse = (error: string) => ({ table: EMPTY_ROUTE_TABLE, error });
  for (const group of raw.split(';').map((part) => part.trim()).filter(Boolean)) {
    const eq = group.indexOf('=');
    if (eq <= 0 || eq !== group.lastIndexOf('=')) return refuse(`group ${JSON.stringify(group)} is not <target>=<reason>[,<reason>]`);
    const targets: TAlarmTarget[] = [];
    for (const token of group.slice(0, eq).split('+').map((part) => part.trim())) {
      const target = parseTarget(token);
      if (typeof target === 'string') return refuse(target);
      targets.push(target);
    }
    if (targets.some((t) => t.kind === 'board') && targets.length > 1) return refuse(`$board stands alone: ${JSON.stringify(group)}`);
    const patterns = group.slice(eq + 1).split(',').map((part) => part.trim());
    for (const pattern of patterns) {
      if (!pattern || !knownPattern(pattern)) {
        return refuse(`${JSON.stringify(pattern)} is not a wait reason, an anomaly id or a prefix of one ending in *: one of ${[...KNOWN_PATTERNS].join(', ')}`);
      }
      if (seen.has(pattern)) return refuse(`${pattern} is routed twice`);
      seen.add(pattern);
      entries.push({ pattern, targets });
    }
  }
  return { table: { entries }, error: null };
};

/**
 * The targets of a reason or anomaly id: its own entry, then its producer reason's (`land-queue` for
 * `land-queue/lock-busy`), then the longest matching prefix; else the orchestrator.
 */
export const routeFor = (table: IRouteTable, key: string): readonly TAlarmTarget[] => {
  const exact = (pattern: string) => table.entries.find((entry) => entry.pattern === pattern);
  const parent = key.includes('/') ? key.slice(0, key.indexOf('/')) : null;
  const direct = exact(key) ?? (parent ? exact(parent) : undefined);
  if (direct) return direct.targets;
  const prefixed = table.entries
    .filter((entry) => entry.pattern.endsWith('*') && key.startsWith(entry.pattern.slice(0, -1)))
    .sort((a, b) => b.pattern.length - a.pattern.length)[0];
  return prefixed?.targets ?? FALLBACK_TARGETS;
};

/** Minutes per producer reason; null is no alarm. */
export type TAlarmThresholds = ReadonlyMap<string, number | null>;

/** The threshold key of a counted reason: a derived `land-queue/...` reason uses `land-queue`'s. */
export const thresholdReason = (reason: string): string => (reason.includes('/') ? reason.slice(0, reason.indexOf('/')) : reason);

/** `off`, or a plain decimal number of minutes in 0..10080. */
export const parseThresholdValue = (raw: string): { minutes: number | null } | { error: string } => {
  const text = raw.trim();
  if (text === THRESHOLD_OFF) return { minutes: null };
  const value = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text) || value > THRESHOLD_MAX_MINUTES) {
    return { error: `must be ${THRESHOLD_OFF} or minutes in 0..${THRESHOLD_MAX_MINUTES}, got ${JSON.stringify(raw)}` };
  }
  return { minutes: value };
};

/**
 * The thresholds in force: the defaults, overridden by each `ledger.threshold.<reason>` set. An unreadable value
 * keeps the default and is named in `errors`.
 */
export const resolveThresholds = (values: ReadonlyMap<string, string>): { thresholds: TAlarmThresholds; errors: string[] } => {
  const thresholds = new Map<string, number | null>(Object.entries(DEFAULT_ALARM_THRESHOLD_MINUTES));
  const errors: string[] = [];
  for (const [reason, raw] of values) {
    const parsed = parseThresholdValue(raw);
    if ('error' in parsed) errors.push(`${LEDGER_ALARM_KEYS.threshold(reason)} ${parsed.error}; the default stands`);
    else thresholds.set(reason, parsed.minutes);
  }
  return { thresholds, errors };
};

/** `red-main` and a critical-path `chain-down` are urgent (ADR-HFL-03 decision 1); every other alarm is a digest line. */
export const alarmSeverity = (item: Pick<IBoardStuckItem, 'reason' | 'critical'>): 'warn' | 'block' =>
  item.reason === 'red-main' || (item.reason === 'chain-down' && item.critical) ? 'block' : 'warn';

export const formatAge = (ms: number): string => {
  const minutes = Math.floor(ms / MINUTE_MS);
  return minutes < 120 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
};

export interface ILedgerAlarm {
  itemKey: string;
  reason: string;
  holder: string | null;
  clearInput: string | null;
  since: number;
  thresholdMinutes: number;
  critical: boolean;
  severity: 'warn' | 'block';
}

/** An open wait over its threshold, or null. */
export const alarmFor = (item: IBoardStuckItem, thresholds: TAlarmThresholds, now: number): ILedgerAlarm | null => {
  const minutes = thresholds.get(thresholdReason(item.reason));
  if (minutes === undefined || minutes === null || now - item.since < minutes * MINUTE_MS) return null;
  return {
    itemKey: item.key, reason: item.reason, holder: item.holder, clearInput: item.clearInput, since: item.since,
    thresholdMinutes: minutes, critical: item.critical, severity: alarmSeverity(item),
  };
};

/** The fixed opening of an alarm's text, the item and the reason: the repeat guard finds its copies by it. */
export const alarmOpening = (alarm: Pick<ILedgerAlarm, 'itemKey' | 'reason'>): string => `${alarm.itemKey} ${alarm.reason} for `;

/**
 * The one line a seat reads (ADR-HFL-03 decision 5): item, reason, age, clear input. A seat that is not the holder
 * also reads who holds it.
 */
export const alarmText = (alarm: ILedgerAlarm, now: number, toHolder: boolean): string => {
  const holder = toHolder ? '' : `; holder ${alarm.holder ?? 'none named'}`;
  return `${alarmOpening(alarm)}${formatAge(now - alarm.since)} (threshold ${alarm.thresholdMinutes} min); `
    + `clear: ${alarm.clearInput ?? 'not named'}${holder}`;
};
