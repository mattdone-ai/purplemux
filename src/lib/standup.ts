// Browser-safe standup helpers: the report parser and the schema hint embedded
// in orchestrator prompts. No node-only imports — the sidebar renders standups
// client-side and the CLI API route validates reports server-side from the same code.
import type {
  IStandupBlocker,
  IStandupItem,
  IWorkspaceStandup,
  TStandupItemStatus,
  TStandupState,
} from '@/types/status';

// After this long without a tick the panel labels the standup stale — the
// orchestrator posts on every nudge it handles, and the idle keeper beats every
// ORCH_IDLE_HEARTBEAT_MS (10 min), so 2× that means the loop has gone quiet.
export const STANDUP_STALE_MS = 20 * 60 * 1000;

export const MAX_STANDUP_HISTORY = 50;

/**
 * Story hfl2-10: the orchestrator's digest says a standup is due when its newest one is this old. Fleet config key
 * `standup.dueMin` (ADR-0019; admin token only) overrides the default; `0` turns the line off.
 */
export const STANDUP_DUE_CONFIG_KEY = 'standup.dueMin';
export const STANDUP_DUE_DEFAULT_MS = 45 * 60 * 1000;
const STANDUP_DUE_MAX_MINUTES = 24 * 60;

/** The `tab_events` kind of the due line: the one digest kind that makes a digest due at once (ADR-0035 §3). */
export const STANDUP_DUE_KIND = 'standup-due';

/**
 * The due age in ms for a fleet value, or null when it is not minutes in [0, 1440]. `0` (off) is a valid value.
 * Decimals are allowed (0.05 = 3 s), so an acceptance run can prove the line without a 45 min wait.
 */
export const parseStandupDueMinutes = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const minutes = Number(value.trim());
  if (!(minutes >= 0) || minutes > STANDUP_DUE_MAX_MINUTES) return null;
  return Math.round(minutes * 60 * 1000);
};

/**
 * The due bucket an age falls in: `dueMs`, then each doubling of it (45, 90, 180 ... min). The line goes out once
 * per bucket. Null when the line is off (`dueMs` 0) or the age is below the first bucket.
 */
export const standupDueBucketMs = (ageMs: number, dueMs: number): number | null => {
  if (!(dueMs > 0) || !Number.isFinite(ageMs) || ageMs < dueMs) return null;
  let bucket = dueMs;
  while (bucket * 2 <= ageMs) bucket *= 2;
  return bucket;
};

/**
 * The one due line. `lastPostedAt` null: the workspace has no standup, and the age counts from the run's start;
 * the line then says that none was posted, never a "last posted" time that does not exist.
 */
export const buildStandupDueLine = (workspaceId: string, ageMs: number, lastPostedAt: number | null): string => {
  const minutes = Math.floor(ageMs / 60_000);
  const age = lastPostedAt === null ? `none posted in the ${minutes} min since the run started` : `last posted ${minutes} min ago`;
  return `standup due: ${age} (purplemux standup report -w ${workspaceId})`;
};

const STANDUP_STATES: TStandupState[] = ['on-track', 'at-risk', 'blocked', 'awaiting-human', 'done'];
const ITEM_STATUSES: TStandupItemStatus[] = ['done', 'active', 'blocked', 'todo'];

const MAX_ITEMS = 30;
const MAX_BLOCKERS = 10;
const MAX_NEXT = 10;
const MAX_TEXT = 200;

// One line, single-quoted-shell safe, kept in lock-step with parseStandupReport.
// Embedded in the kickoff template, the CLI prompts, and the api-guide.
export const STANDUP_SCHEMA_HINT =
  '{"state":"on-track|at-risk|blocked|awaiting-human|done","headline":"<one line: where things stand>","items":[{"label":"<task>","status":"done|active|blocked|todo","note":"<short, optional>"}],"blockers":[{"what":"<blocker>","needs":"<the exact input that clears it>"}],"needsHuman":false,"next":["<upcoming step>"]}';

const clampText = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TEXT ? `${trimmed.slice(0, MAX_TEXT - 1)}…` : trimmed;
};

const parseItems = (raw: unknown): IStandupItem[] => {
  if (!Array.isArray(raw)) return [];
  const items: IStandupItem[] = [];
  for (const entry of raw.slice(0, MAX_ITEMS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { label, status, note } = entry as Record<string, unknown>;
    const clampedLabel = clampText(label);
    if (!clampedLabel) continue;
    if (!ITEM_STATUSES.includes(status as TStandupItemStatus)) continue;
    const item: IStandupItem = { label: clampedLabel, status: status as TStandupItemStatus };
    const clampedNote = clampText(note);
    if (clampedNote) item.note = clampedNote;
    items.push(item);
  }
  return items;
};

const parseBlockers = (raw: unknown): IStandupBlocker[] => {
  if (!Array.isArray(raw)) return [];
  const blockers: IStandupBlocker[] = [];
  for (const entry of raw.slice(0, MAX_BLOCKERS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { what, needs } = entry as Record<string, unknown>;
    const clampedWhat = clampText(what);
    if (!clampedWhat) continue;
    blockers.push({ what: clampedWhat, needs: clampText(needs) ?? 'unspecified' });
  }
  return blockers;
};

const parseNext = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_NEXT)
    .map(clampText)
    .filter((s): s is string => s !== null);
};

/**
 * Validate an orchestrator's standup report. Forgiving on purpose — malformed
 * rows are dropped and long strings clamped rather than rejecting the tick,
 * because a slightly sloppy standup still beats a silent one. Only a missing
 * state or headline rejects the report outright.
 */
export const parseStandupReport = (raw: unknown, workspaceId: string, at: number): IWorkspaceStandup | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;

  if (!STANDUP_STATES.includes(body.state as TStandupState)) return null;
  const state = body.state as TStandupState;
  const headline = clampText(body.headline);
  if (!headline) return null;

  const blockers = parseBlockers(body.blockers);
  const needsHuman = typeof body.needsHuman === 'boolean'
    ? body.needsHuman
    : state === 'blocked' || state === 'awaiting-human';

  return {
    workspaceId,
    at,
    state,
    headline,
    items: parseItems(body.items),
    blockers,
    needsHuman,
    next: parseNext(body.next),
  };
};
