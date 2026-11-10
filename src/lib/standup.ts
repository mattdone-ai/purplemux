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
