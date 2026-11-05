// The pulse (ADR-0034 §9): pure. The readers (`pulse-sources.ts`) find the events; this buckets them
// into clock hours and says whether work moves. No Node import, no I/O, no clock.
import { percentile } from '@/lib/ledger';
import type { IBoardStuckItem, IFinderResult } from '@/types/constraint';
import type {
  IPulse,
  IPulseHour,
  IPulseStall,
  IPulsePriority,
  IPulseSource,
  IPulseSourceRead,
  IPulseStuck,
  IPulseWip,
  TPulseSourceId,
} from '@/types/pulse';

const HOUR_MS = 3_600_000;

export const PULSE_HOURS = 48;
/** The usual rate is the median of the 7 days of complete clock hours before the current one. */
export const PULSE_BASELINE_HOURS = 7 * 24;
export const PULSE_LOOKBACK_MS = (PULSE_BASELINE_HOURS + 1) * HOUR_MS;
/** With work in progress, this long without a movement event is a stall (AC 10). */
export const PULSE_STALL_MS = 2 * HOUR_MS;

export const PULSE_SOURCE_LABELS: Readonly<Record<TPulseSourceId, string>> = {
  ledger: 'Ledger changes',
  commits: 'Commits',
  gates: 'Gates finished',
  reviews: 'Review rounds and confirmations',
  landed: 'v2 landings',
  answers: 'Mission Control answers',
};

export const PULSE_SOURCE_ORDER: readonly TPulseSourceId[] = ['ledger', 'commits', 'gates', 'reviews', 'landed', 'answers'];

/** The sources the files on disk give; without one of them, the ledger and MC answers alone never decide a stall (F4). */
export const FILE_BORN_SOURCES: readonly TPulseSourceId[] = ['commits', 'gates', 'reviews', 'landed'];

const hourStart = (at: number): number => Math.floor(at / HOUR_MS) * HOUR_MS;

const emptyHour = (start: number): IPulseHour => ({ start, total: 0, bySource: {}, gatesPassed: 0, gatesFailed: 0 });

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The 48 clock hours ending with the current one, from the measured reads only. */
export const pulseHours = (reads: readonly IPulseSourceRead[], now: number): IPulseHour[] => {
  const first = hourStart(now) - (PULSE_HOURS - 1) * HOUR_MS;
  const hours = Array.from({ length: PULSE_HOURS }, (_, i) => emptyHour(first + i * HOUR_MS));
  for (const read of reads) {
    for (const event of read.events ?? []) {
      if (event.at < first || event.at > now) continue;
      const hour = hours[Math.floor((event.at - first) / HOUR_MS)];
      hour.total += 1;
      hour.bySource[read.id] = (hour.bySource[read.id] ?? 0) + 1;
      if (event.outcome === 'pass') hour.gatesPassed += 1;
      if (event.outcome === 'fail') hour.gatesFailed += 1;
    }
  }
  return hours;
};

/**
 * The usual rate (round 3, F13): the median events per hour over the active hours (any event) among
 * the 168 complete clock hours before the current one. A median over every hour reads 0 for a
 * workspace idle most of the week, and "moving" would then mean nothing. Null with no active hour.
 */
export const baselineMedian = (reads: readonly IPulseSourceRead[], now: number): { median: number | null; activeHours: number } => {
  const current = hourStart(now);
  const first = current - PULSE_BASELINE_HOURS * HOUR_MS;
  const counts = new Array<number>(PULSE_BASELINE_HOURS).fill(0);
  for (const read of reads) {
    for (const event of read.events ?? []) {
      if (event.at >= first && event.at < current) counts[Math.floor((event.at - first) / HOUR_MS)] += 1;
    }
  }
  const active = counts.filter((count) => count > 0).sort((a, b) => a - b);
  return { median: percentile(active, 0.5), activeHours: active.length };
};

const sourceView = (read: IPulseSourceRead, now: number): IPulseSource => {
  const since = hourStart(now) - (PULSE_HOURS - 1) * HOUR_MS;
  const base = { id: read.id, label: PULSE_SOURCE_LABELS[read.id], from: read.from, sharedWith: read.sharedWith ?? null };
  if (read.events === null) return { ...base, state: 'unknown', reason: read.reason ?? 'not read', count: null, lastAt: null };
  const inStrip = read.events.filter((event) => event.at >= since && event.at <= now);
  const lastAt = read.events.reduce<number | null>((latest, event) => (event.at <= now && (latest === null || event.at > latest) ? event.at : latest), null);
  return { ...base, state: 'ok', reason: read.reason, count: inStrip.length, lastAt };
};

const quietText = (hours: number): string => (hours >= PULSE_BASELINE_HOURS ? 'no movement in 7 days' : `no movement for ${hours} h`);

export interface IPulseWipLedger {
  state: IPulseWip['sources']['ledger'];
  /** Open `range`, `slice`, `gate`, `review`, `landing` and `deploy` items. */
  openItems: number;
  oldest: IPulseStuck | null;
}

export interface IPulseWipTab {
  tabId: string;
  name: string;
  state: 'busy' | 'needs-input';
  /** The orchestrator counts only while it waits for the owner (C2); `question` is what it waits on. */
  role?: 'worker' | 'orchestrator';
  question?: string;
  /** busy: when its turn started; needs-input: when it began waiting. Null when the status manager does not know. */
  since: number | null;
}

export interface IPulseWipMcItem {
  id: string;
  title: string;
  createdAt: number;
}

export interface IPulseWipInput {
  ledger: IPulseWipLedger;
  /** Non-orchestrator agent tabs that are busy or need input; null when the tab status cannot be read. */
  agentTabs: readonly IPulseWipTab[] | null;
  /** Open Mission Control items; null when the store cannot be read. */
  mcItems: readonly IPulseWipMcItem[] | null;
}

const oldestOf = (items: readonly IPulseStuck[]): IPulseStuck | null =>
  items.reduce<IPulseStuck | null>((oldest, item) => (oldest === null || item.since < oldest.since ? item : oldest), null);

/**
 * Work in progress (consult 12, Q1): the ledger once it holds an event in 7 days; else the live agent
 * tabs and the open Mission Control items; else not measured. The two bases are never mixed.
 */
export const pulseWip = ({ ledger, agentTabs, mcItems }: IPulseWipInput): { wip: IPulseWip; oldestStuck: IPulseStuck | null } => {
  if (ledger.state === 'measured') {
    return {
      wip: {
        count: ledger.openItems, basis: 'ledger',
        sources: { ledger: 'measured', agentTabs: 'not-used', missionControl: 'not-used' },
        basisReason: `${plural(ledger.openItems, 'open ledger item')}`,
      },
      oldestStuck: ledger.oldest,
    };
  }
  const sources: IPulseWip['sources'] = {
    ledger: ledger.state,
    agentTabs: agentTabs === null ? 'unreadable' : 'measured',
    missionControl: mcItems === null ? 'unreadable' : 'measured',
  };
  const ledgerWhy = ledger.state === 'unreadable' ? 'the ledger cannot be read' : 'the ledger holds no work-item event for this workspace in 7 days';
  if (agentTabs === null && mcItems === null) {
    return {
      wip: { count: null, basis: 'none', sources, basisReason: `not measured: ${ledgerWhy}, and neither tab status nor Mission Control can be read` },
      oldestStuck: null,
    };
  }
  const unreadable = [agentTabs === null ? 'tab status' : null, mcItems === null ? 'Mission Control' : null].filter(Boolean);
  const parts = [
    agentTabs === null ? null : `${plural(agentTabs.length, 'agent tab')} working or waiting for input`,
    mcItems === null ? null : `${plural(mcItems.length, 'open Mission Control item')}`,
  ].filter(Boolean);
  const counted = (agentTabs?.length ?? 0) + (mcItems?.length ?? 0);
  // A busy tab is working, not stuck; a tab waiting for input is stuck from when it began waiting (F10).
  const named: IPulseStuck[] = [
    ...(agentTabs ?? []).filter((tab) => tab.state === 'needs-input' && tab.since !== null)
      .map((tab) => ({
        kind: 'agent-tab' as const, id: tab.tabId, since: tab.since!,
        label: tab.role === 'orchestrator' ? `orchestrator ${tab.name} waiting for you: ${tab.question ?? 'a prompt in its pane'}` : `tab ${tab.name} waiting for input`,
      })),
    ...(mcItems ?? []).map((item) => ({ kind: 'mc-item' as const, id: item.id, label: `Mission Control: ${item.title}`, since: item.createdAt })),
  ];
  return {
    wip: {
      // A source the basis rests on that cannot be read is unknown, never 0, unless the other one already counts work.
      count: unreadable.length && counted === 0 ? null : counted,
      basis: 'agent-tabs',
      sources,
      basisReason: `${parts.join(', ')} (${ledgerWhy}${unreadable.length ? `; ${unreadable.join(' and ')} unreadable` : ''})`,
    },
    oldestStuck: oldestOf(named),
  };
};

export interface IPulseStallInput {
  reads: readonly IPulseSourceRead[];
  wip: IPulseWip;
  oldestStuck: IPulseStuck | null;
  now: number;
}

/**
 * Red when work is in progress and nothing moved for 2 h; green when the last hour moved at or above
 * the 7-day hourly median; idle at a measured zero in progress; steady otherwise.
 */
export const pulseStall = ({ reads, wip, oldestStuck, now }: IPulseStallInput): IPulseStall => {
  const counted = reads.filter((read) => !read.sharedWith);
  const measured = counted.filter((read) => read.events !== null);
  const unmeasured = PULSE_SOURCE_ORDER.filter((id) => !measured.some((read) => read.id === id))
    .map((id) => PULSE_SOURCE_LABELS[id].replace(/^(?!Mission Control)[A-Z]/, (first) => first.toLowerCase()));
  const gaps = unmeasured.length ? ` · not measured: ${unmeasured.join(', ')}` : '';
  const empty = { lastMovementAt: null, hoursSinceMovement: null, lastHour: null, medianPerHour: null, activeHours: null, oldestStuck: null };
  if (!measured.length) return { ...empty, state: 'not-measured', reason: 'not measured: no movement source could be read' };
  if (!measured.some((read) => FILE_BORN_SOURCES.includes(read.id))) {
    return { ...empty, state: 'not-measured', reason: `not measured: no file-born source (commits, gates, review rounds, landings) could be read${gaps}` };
  }
  const events = measured.flatMap((read) => read.events!).filter((event) => event.at <= now);
  const lastMovementAt = events.reduce<number | null>((latest, event) => (latest === null || event.at > latest ? event.at : latest), null);
  const quietMs = lastMovementAt === null ? PULSE_LOOKBACK_MS : now - lastMovementAt;
  const hoursSinceMovement = Math.min(PULSE_BASELINE_HOURS, Math.floor(quietMs / HOUR_MS));
  const lastHour = events.filter((event) => event.at > now - HOUR_MS).length;
  const { median: medianPerHour, activeHours } = baselineMedian(measured, now);
  const base = { lastMovementAt, hoursSinceMovement, lastHour, medianPerHour, activeHours, oldestStuck: null };
  const usual = medianPerHour === null ? 'no active hour in 7 days' : `median of active hours ${medianPerHour}/h`;
  const rate = `${plural(lastHour, 'event')} in the last hour, ${usual}`;
  if (quietMs >= PULSE_STALL_MS && wip.count !== null && wip.count > 0) {
    const stuck = oldestStuck ? `oldest stuck: ${oldestStuck.label}` : 'no stuck item measured';
    return { ...base, oldestStuck, state: 'stalled', reason: `${quietText(hoursSinceMovement)} · ${stuck}${gaps}` };
  }
  if (lastHour > 0 && lastHour >= (medianPerHour ?? 0)) return { ...base, state: 'moving', reason: `moving: ${rate}${gaps}` };
  if (wip.count === null) return { ...base, state: 'not-measured', reason: `work in progress not measured (${wip.basisReason})${gaps}` };
  if (wip.count === 0) return { ...base, state: 'idle', reason: `nothing in progress: ${wip.basisReason}${gaps}` };
  return { ...base, state: 'steady', reason: `${quietMs >= HOUR_MS ? `${quietText(hoursSinceMovement)} · ` : ''}${rate}${gaps}` };
};

const stuckSentence = (item: IBoardStuckItem): string =>
  `${item.key}: ${item.reasonLabel}, held by ${item.holder ?? 'no holder recorded'}, clears when ${item.clearInput ?? 'not recorded'}`;

export const needsYouText = (needsYou: number | null): string => (needsYou === null ? 'needs you: unknown (Mission Control unreadable)' : `needs you: ${needsYou}`);

/** The constraint with its owner and clear input; when unknown, the oldest stuck critical item; and the needs-you count. */
export const pulsePriority = (finder: Pick<IFinderResult, 'constraint' | 'stuck' | 'inputs'>, needsYou: number | null): IPulsePriority => {
  const tail = needsYouText(needsYou);
  const c = finder.constraint;
  if (c) {
    return {
      basis: 'constraint', needsYou,
      text: `${c.labels.reason}: owner ${c.ownerSeat ?? 'not recorded'}, clears when ${c.clearInput ?? 'not recorded'} · ${tail}`,
    };
  }
  if (finder.inputs.ledger.state !== 'ok') {
    return { basis: 'unknown', needsYou, text: `constraint unknown (${finder.inputs.ledger.reason ?? finder.inputs.ledger.state}) · ${tail}` };
  }
  const critical = finder.stuck.find((item) => item.critical);
  if (critical) return { basis: 'stuck-critical', needsYou, text: `${stuckSentence(critical)} · ${tail}` };
  return { basis: 'none', needsYou, text: `nothing waited in 24 h · ${tail}` };
};

export interface IPulseInputs {
  workspaceId: string;
  scope?: IPulse['scope'];
  reads: readonly IPulseSourceRead[];
  wip: IPulseWip;
  oldestStuck: IPulseStuck | null;
  priority: IPulsePriority;
  staleSince: number | null;
  now: number;
}

/** The six counted sources in order (an absent one reads "no reader"), then the shared ones, shown and never counted. */
export const derivePulse = ({ workspaceId, scope = { basis: 'directories', epics: [] }, reads, wip, oldestStuck, priority, staleSince, now }: IPulseInputs): IPulse => {
  const own = reads.filter((read) => !read.sharedWith);
  const ordered = PULSE_SOURCE_ORDER.map((id) => own.find((read) => read.id === id)
    ?? { id, events: null, reason: 'no reader', from: [] });
  const shared = reads.filter((read) => read.sharedWith);
  const measured = ordered.some((read) => read.events !== null);
  return {
    workspaceId,
    generatedAt: now,
    scope,
    hours: measured ? pulseHours(ordered, now) : null,
    sources: [...ordered, ...shared].map((read) => sourceView(read, now)),
    stall: pulseStall({ reads: ordered, wip, oldestStuck, now }),
    wip,
    priority,
    staleSince,
  };
};
