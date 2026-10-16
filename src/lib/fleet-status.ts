import type {
  IFleetFlag, IFleetInbox, IFleetRow, IFleetTabFacts, IFleetThresholds, IFleetWait, TFleetFlag, TFleetState,
} from '@/types/fleet-status';

// The pure half of the fleet status read model (ADR-0023): facts in, one row
// out. Every rule here is a threshold on a stamp the server already holds; no
// rule reads a transcript or a pane itself.

const MINUTE_MS = 60_000;

export const DEFAULT_FLEET_THRESHOLDS: IFleetThresholds = {
  stallMinutes: 30,
  waitingLongMinutes: 120,
  unansweredMinutes: 30,
  composerMinutes: 2,
};

/** A duration as "45 s", "37 min" or "2 h 14 min"; a negative or non-finite one reads "—". */
export const formatDuration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < MINUTE_MS) return `${Math.floor(ms / 1000)} s`;
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
};

const maxStamp = (values: Array<number | null | undefined>): number | null => {
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return finite.length > 0 ? Math.max(...finite) : null;
};

type TStatus = NonNullable<IFleetTabFacts['status']>;

/** The stop the tab's turnEnd classifies is still its latest event (ADR-0018). */
const turnEndIsCurrent = (status: TStatus): boolean => !!status.turnEnd
  && status.lastEvent?.name === 'stop'
  && status.turnEnd.seq !== undefined
  && status.turnEnd.seq === status.lastEvent.seq;

/**
 * The tab sits at its prompt: idle, stopped, or WAITING on its own registered work at an empty
 * composer (ADR-0018 ruling A′), where the inbox and `tab send` may still type into it.
 */
export const isAtPrompt = (status: TStatus | null): boolean => !!status && (
  status.cliState === 'idle' || status.cliState === 'ready-for-review' || status.cliState === 'cancelled'
  || (status.cliState === 'busy' && status.turnEnd?.kind === 'waiting' && turnEndIsCurrent(status)));

const lastLineOf = (status: TStatus | null): IFleetRow['lastLine'] => {
  const marker = status?.turnEnd?.marker;
  if (!status?.turnEnd || !marker || marker.length === 0) return null;
  const text = marker[marker.length - 1].trim();
  return text ? { text, at: status.turnEnd.at } : null;
};

const waitsOf = (facts: IFleetTabFacts): IFleetWait[] => {
  const waits: IFleetWait[] = (facts.watches ?? []).map((w) => ({ kind: 'watch', label: w.target, detail: w.kind }));
  for (const job of facts.liveJobs ?? []) waits.push({ kind: 'job', label: job.label || `pid ${job.pid}` });
  const open = facts.status?.turnEnd?.openBackgroundTasks;
  if (typeof open === 'number' && open > 0) waits.push({ kind: 'background', label: String(open) });
  return waits;
};

interface IStateResult {
  state: TFleetState;
  since: number | null;
}

const stateOf = (facts: IFleetTabFacts): IStateResult => {
  const status = facts.status;
  if (!status) return { state: 'unknown', since: null };
  const lastAt = status.lastEvent?.at ?? null;
  if (status.permissionRequest || status.cliState === 'needs-input') return { state: 'needs-input', since: lastAt };
  if (isAtPrompt(status) && facts.composer?.reading === 'text') return { state: 'unsubmitted', since: facts.composer.since };
  switch (status.cliState) {
    case 'busy':
      if (status.turnEnd?.kind === 'waiting' && turnEndIsCurrent(status)) return { state: 'waiting', since: status.turnEnd.at };
      // busySince spans a whole chain of WAITING turns; a later prompt starts the current one.
      return { state: 'working', since: maxStamp([status.busySince, status.lastEvent?.name === 'prompt-submit' ? lastAt : null]) ?? lastAt };
    case 'ready-for-review':
    case 'idle':
    case 'cancelled':
      if (status.turnEnd?.kind === 'turn-marker' && turnEndIsCurrent(status)) return { state: 'ended', since: status.turnEnd.at };
      if (status.cliState === 'ready-for-review') {
        return { state: 'ready-for-review', since: status.readyForReviewAt ?? status.turnEnd?.at ?? lastAt };
      }
      return { state: 'idle', since: lastAt };
    case 'inactive':
      // The move to inactive leaves lastEvent alone: only the observed transition dates it.
      return { state: 'inactive', since: facts.inactiveSince };
    default:
      return { state: 'unknown', since: lastAt };
  }
};

/** Open items, the unreviewed ones older than the unanswered threshold, and the oldest open item. */
export const inboxOf = (items: Array<{ createdAt: number; reviewed: boolean }>, now: number, thresholds: IFleetThresholds): IFleetInbox => {
  const limit = thresholds.unansweredMinutes * MINUTE_MS;
  return {
    open: items.length,
    unanswered: items.filter((item) => !item.reviewed && now - item.createdAt >= limit).length,
    oldestAt: items.length > 0 ? Math.min(...items.map((item) => item.createdAt)) : null,
  };
};

/** The UNANSWERED flag of a line that holds SM-inbox items (a tab row or a workspace's unattributed line). */
export const unansweredFlag = (inbox: IFleetInbox | null, now: number): IFleetFlag | null => {
  if (!inbox || inbox.unanswered === 0) return null;
  const oldest = inbox.oldestAt === null ? null : now - inbox.oldestAt;
  return { flag: 'unanswered', reason: `${inbox.unanswered} SM-inbox item(s) unanswered; oldest open ${formatDuration(oldest)}` };
};

const FLAG_ORDER: Record<TFleetFlag, number> = { stall: 0, unanswered: 1, 'waiting-long': 2 };

const QUESTION_LINE = /^[*_`\s]*(BLOCKED|NEEDS-DECISION):/;

/**
 * The watchdog's `stuck` verdict holds until the tab shows activity after it: the latch it
 * sets is once per busy stretch, so a tab that recovered must not keep reading as stalled.
 */
const watchdogStall = (facts: IFleetTabFacts, lastActivityAt: number | null, now: number): IFleetFlag | null => {
  const at = facts.stallReportedAt;
  if (at === null || (lastActivityAt !== null && lastActivityAt > at)) return null;
  return { flag: 'stall', reason: `the watchdog reported this tab as stalled ${formatDuration(now - at)} ago` };
};

const flagsOf = (
  facts: IFleetTabFacts,
  { state, since }: IStateResult,
  lastLine: IFleetRow['lastLine'],
  waits: IFleetWait[],
  inbox: IFleetInbox | null,
  lastActivityAt: number | null,
  now: number,
  t: IFleetThresholds,
): IFleetFlag[] => {
  const flags: IFleetFlag[] = [];
  const stallMs = t.stallMinutes * MINUTE_MS;
  const inState = since === null ? null : now - since;
  if (state === 'working') {
    // Hook events alone go quiet through a long tool call: without a transcript
    // stamp (a remote tab, an unread file) only the watchdog's own verdict counts.
    const quiet = lastActivityAt === null || facts.transcriptAt === null ? null : now - lastActivityAt;
    const verdict = watchdogStall(facts, lastActivityAt, now);
    if (verdict) flags.push(verdict);
    else if (quiet !== null && quiet >= stallMs) flags.push({ flag: 'stall', reason: `busy with no activity for ${formatDuration(quiet)}` });
  } else if (state === 'unsubmitted') {
    if (inState !== null && inState >= t.composerMinutes * MINUTE_MS) {
      flags.push({ flag: 'stall', reason: `text left unsubmitted in the composer for ${formatDuration(inState)}` });
    }
  } else if ((state === 'idle' || state === 'ready-for-review') && !endLineUnknown(facts)) {
    // An unreadable liveness store is not proof that no job runs: no flag on a guess.
    const noRegisteredWait = facts.liveJobs !== null && facts.liveJobs.length === 0
      && facts.watches !== null && facts.watches.length === 0;
    if (noRegisteredWait && inState !== null && inState >= stallMs) {
      flags.push({ flag: 'stall', reason: `idle with no end line and no registered wait for ${formatDuration(inState)}` });
    }
  } else if (state === 'needs-input') {
    if (inState !== null && inState >= stallMs) flags.push({ flag: 'stall', reason: `waiting for input for ${formatDuration(inState)}` });
  } else if (state === 'inactive') {
    // An agent exited after it ended on DONE / CHECKPOINTED / READY-TO-MERGE finished on purpose.
    const finished = !!lastLine && !!facts.status && facts.status.turnEnd?.kind === 'turn-marker'
      && turnEndIsCurrent(facts.status) && !QUESTION_LINE.test(lastLine.text);
    if (!finished && inState !== null && inState >= stallMs) {
      flags.push({ flag: 'stall', reason: `agent not running for ${formatDuration(inState)}` });
    }
  } else if (state === 'waiting') {
    const verdict = watchdogStall(facts, lastActivityAt, now);
    if (verdict) flags.push(verdict);
    if (inState !== null && inState >= t.waitingLongMinutes * MINUTE_MS) {
      const on = waits.map((w) => w.kind === 'background' ? `${w.label} background task(s)` : `${w.kind} ${w.label}`).join(', ');
      flags.push({ flag: 'waiting-long', reason: `waiting ${formatDuration(inState)}${on ? ` on ${on}` : ''}` });
    }
  }
  const reasons: string[] = [];
  // A tab still stopped on its question has had no reply: the next prompt would have moved it on.
  const question = state === 'ended' && lastLine ? QUESTION_LINE.exec(lastLine.text)?.[1] : undefined;
  if (question && inState !== null && inState >= t.unansweredMinutes * MINUTE_MS) {
    reasons.push(`ended on ${question} ${formatDuration(inState)} ago with no reply`);
  }
  const inboxFlag = unansweredFlag(inbox, now);
  if (inboxFlag) reasons.push(inboxFlag.reason);
  if (reasons.length > 0) flags.push({ flag: 'unanswered', reason: reasons.join('; ') });
  return flags.sort((a, b) => FLAG_ORDER[a.flag] - FLAG_ORDER[b.flag]);
};

/**
 * A tab restored at its prompt by a server restart without a persisted stop has no latest
 * event: whether it ended on a line is unknown, which is not "no end line".
 */
const endLineUnknown = (facts: IFleetTabFacts): boolean => !!facts.status && !facts.status.lastEvent
  && (facts.status.cliState === 'idle' || facts.status.cliState === 'ready-for-review' || facts.status.cliState === 'cancelled');

export const deriveFleetRow = (facts: IFleetTabFacts, now: number, thresholds: IFleetThresholds = DEFAULT_FLEET_THRESHOLDS): IFleetRow => {
  const status = facts.status;
  const result = stateOf(facts);
  const waits = result.state === 'waiting' ? waitsOf(facts) : [];
  const inbox = facts.inbox === null ? null : inboxOf(facts.inbox, now, thresholds);
  const lastActivityAt = maxStamp([status?.lastEvent?.at, facts.transcriptAt]);
  const lastLine = lastLineOf(status);
  return {
    workspaceId: facts.workspaceId,
    workspaceName: facts.workspaceName,
    tabId: facts.tabId,
    tabName: facts.tabName,
    panelType: facts.panelType,
    providerId: facts.providerId,
    epic: facts.epic,
    state: result.state,
    rawCliState: status ? String(status.cliState) : null,
    since: result.since,
    lastActivityAt,
    waits,
    lastLine,
    endLineUnknown: (result.state === 'idle' || result.state === 'ready-for-review') && endLineUnknown(facts),
    inbox,
    flags: flagsOf(facts, result, lastLine, waits, inbox, lastActivityAt, now, thresholds),
  };
};

/** Flagged rows first (the most severe flag, then the longest in state); unflagged rows by workspace and name. */
export const sortFleetRows = (rows: IFleetRow[]): IFleetRow[] => [...rows].sort((a, b) => {
  const fa = a.flags.length > 0 ? FLAG_ORDER[a.flags[0].flag] : 99;
  const fb = b.flags.length > 0 ? FLAG_ORDER[b.flags[0].flag] : 99;
  if (fa !== fb) return fa - fb;
  if (fa !== 99) return (a.since ?? Infinity) - (b.since ?? Infinity);
  return a.workspaceName.localeCompare(b.workspaceName) || a.tabName.localeCompare(b.tabName) || a.tabId.localeCompare(b.tabId);
});

/** A fleet-config value in minutes: a plain decimal in (0, 10080] (the `turn-end.ts` grammar), else the default. */
export const parseThresholdMinutes = (raw: string | null | undefined, fallback: number): number => {
  if (raw === null || raw === undefined || !/^\d+(\.\d+)?$/.test(raw.trim())) return fallback;
  const value = Number(raw.trim());
  return value > 0 && value <= 10_080 ? value : fallback;
};
