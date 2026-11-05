import type { IBoardBlocked } from '@/types/constraint';
import type { IPulse, IPulseHour, TPulseSourceId, TPulseStallState } from '@/types/pulse';

// The owner board's words and numbers (ADR-0034 §10). Pure: every face of the board reads its
// labels here, so a served token never reaches the owner and an unknown one reads as a word.

const MINUTE_MS = 60_000;

export type TBoardView = 'board' | 'answers' | 'portfolio';

/** `?view=board` is the default; `?item=<id>` opens the answers view on that item's card. */
export const boardViewOf = (query: { view?: string | string[]; item?: string | string[] }): TBoardView => {
  const view = Array.isArray(query.view) ? query.view[0] : query.view;
  if (view === 'answers' || view === 'portfolio') return view;
  if (view === undefined && (Array.isArray(query.item) ? query.item[0] : query.item)) return 'answers';
  return 'board';
};

export const boardItemOf = (query: { item?: string | string[] }): string | null => {
  const item = Array.isArray(query.item) ? query.item[0] : query.item;
  return item || null;
};

export const answerCardUrl = (itemId: string): string => `/mission-control?view=answers&item=${encodeURIComponent(itemId)}`;

const own = <T,>(map: Readonly<Record<string, T>>, key: string): T | null => (Object.hasOwn(map, key) ? map[key] : null);

export interface IStallLabel {
  word: string;
  tone: 'red' | 'teal' | 'neutral' | 'dashed';
}

const STALL_LABELS: Readonly<Record<TPulseStallState, IStallLabel>> = {
  stalled: { word: 'No movement', tone: 'red' },
  moving: { word: 'Moving', tone: 'teal' },
  steady: { word: 'Steady', tone: 'neutral' },
  idle: { word: 'Idle', tone: 'neutral' },
  'not-measured': { word: 'Not measured', tone: 'dashed' },
};

export const stallLabel = (state: string): IStallLabel => own(STALL_LABELS, state) ?? { word: 'State not in the label map', tone: 'dashed' };

const SOURCE_SHORT: Readonly<Record<TPulseSourceId, string>> = {
  ledger: 'Ledger', commits: 'Commits', gates: 'Gates', reviews: 'Review rounds and confirmations', landed: 'Landed', answers: 'Answers',
};

export const sourceShort = (id: string): string => own(SOURCE_SHORT, id) ?? 'Other source';

const SYDNEY = 'Australia/Sydney';

const parts = (ms: number, options: Intl.DateTimeFormatOptions): Record<string, string> =>
  Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: SYDNEY, hourCycle: 'h23', timeZoneName: 'short', ...options })
    .formatToParts(new Date(ms)).map((part) => [part.type, part.value]));

/** `Tue 3 Nov 17:35 AEDT`: the owner reads times in AEDT/AEST (ADR-HFL-02). */
export const aedtTime = (ms: number): string => {
  const p = parts(ms, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute} ${p.timeZoneName}`;
};

/** `17:00 AEDT`. */
export const aedtClock = (ms: number): string => {
  const p = parts(ms, { hour: '2-digit', minute: '2-digit' });
  return `${p.hour}:${p.minute} ${p.timeZoneName}`;
};

/** `0m`, `45m`, `3h 05m`, `2d 4h`. */
export const ageText = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / MINUTE_MS));
  if (minutes < 60) return `${minutes}m`;
  const hoursTotal = Math.floor(minutes / 60);
  if (hoursTotal < 48) return `${hoursTotal}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hoursTotal / 24)}d ${hoursTotal % 24}h`;
};

export interface ISectionAge {
  text: string;
  stale: boolean;
}

/** A section's data age: "stale since <time>" when its source says so, else "updated <age> ago"; no time is "not measured". */
export const sectionAge = (at: number | null, staleSince: number | null, now: number): ISectionAge => {
  if (staleSince !== null) return { text: `stale since ${aedtTime(staleSince)}`, stale: true };
  if (at === null) return { text: 'not measured', stale: false };
  return { text: `updated ${ageText(now - at)} ago`, stale: false };
};

/**
 * What a Needs you row blocks. An unmeasured ledger says why (round 2, F8); a measured ledger with no
 * item linked to this MC item says that, which is a different fact.
 */
export const blockedText = (blocked: IBoardBlocked | null, ledgerUnmeasured: string | null = null): string => {
  if (ledgerUnmeasured !== null) return `blocked cost not measured: ${ledgerUnmeasured}`;
  if (!blocked) return 'no ledger item links to this item';
  const items = `${blocked.items} item${blocked.items === 1 ? '' : 's'}`;
  return `blocks ${items} · ${blocked.hours.toFixed(1)} h waiting${blocked.critical ? ' · critical path' : ''}`;
};

/** The pulse is stale once its oldest answer is older than two finder ticks (round 2, F5). */
export const PULSE_STALE_MS = 120_000;

export const pulseAge = (generatedAts: readonly number[], now: number): ISectionAge => {
  if (!generatedAts.length) return { text: 'not measured', stale: false };
  const oldest = Math.min(...generatedAts);
  return sectionAge(Math.max(...generatedAts), now - oldest > PULSE_STALE_MS ? oldest : null, now);
};

export interface IBarSegments {
  /** Percent of the bar's full height. */
  failed: number;
  passed: number;
  other: number;
}

/** One hour's stacked bar against the strip's busiest hour. */
export const barSegments = (hour: IPulseHour, max: number): IBarSegments => {
  const scale = max > 0 ? 100 / max : 0;
  const other = hour.total - hour.gatesFailed - hour.gatesPassed;
  return { failed: hour.gatesFailed * scale, passed: hour.gatesPassed * scale, other: Math.max(0, other) * scale };
};

/** The bar's tooltip: `17:00 AEDT · 4 events (2 commits, 1 gates, 1 answers)`. */
export const barTitle = (hour: IPulseHour): string => {
  const detail = Object.entries(hour.bySource).map(([id, n]) => `${n} ${sourceShort(id).toLowerCase()}`).join(', ');
  return `${aedtClock(hour.start)} · ${hour.total} event${hour.total === 1 ? '' : 's'}${detail ? ` (${detail})` : ''}`;
};

/** The workspace the board opens on: the first that is stalled, else the first. */
export const defaultWorkspace = (pulses: readonly IPulse[]): string | null =>
  (pulses.find((pulse) => pulse.stall.state === 'stalled') ?? pulses[0])?.workspaceId ?? null;

/** The strip's summary for a screen reader. */
export const stripLabel = (name: string, pulse: IPulse): string => {
  if (!pulse.hours) return `${name}: movement not measured`;
  const total = pulse.hours.reduce((sum, hour) => sum + hour.total, 0);
  return `${name}: ${total} movement events in 48 hours; ${stallLabel(pulse.stall.state).word.toLowerCase()}: ${pulse.stall.reason}`;
};
