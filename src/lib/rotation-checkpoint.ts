import crypto from 'crypto';
import { handoffFields } from '@/lib/handoff-check';
import type { ILedgerItem, TLedgerAttrValue } from '@/types/ledger';
import type { IGitFacts, IRotationCheckpoint, IRotationCoverage, IRotationSeatRow } from '@/types/rotation-checkpoint';
import type { TRotateAt } from '@/types/context-lifecycle';

// vel-D5: the durable checkpoint a rotation writes and reads back before it clears a session. The mechanical facts
// come from a git probe on the tab's own host; the agent's fields come from its checked handoff file. Pure, apart
// from the digest.

/** The task id is the seat item key; the attempt counts the checkpoints of that task. */
export const checkpointId = (taskId: string, attempt: number): string => `${taskId}#${attempt}`;

export const sha256 = (text: string): string => crypto.createHash('sha256').update(text, 'utf-8').digest('hex');

/** Keys sorted at every level, so a digest does not depend on the order a row was built in. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

export const checkpointDigest = (checkpoint: IRotationCheckpoint): string => sha256(canonical(checkpoint));

export interface ICheckpointInput {
  taskId: string;
  attempt: number;
  workspaceId: string;
  tabId: string;
  tabName: string;
  host: string | null;
  createdAt: number;
  handoffPath: string;
  handoffText: string;
  facts: IGitFacts;
  sessionBefore: string | null;
}

/** The checkpoint of a handoff that passed the check: tool facts as given, the agent's fields from its sections. */
export const buildCheckpoint = (input: ICheckpointInput): IRotationCheckpoint => {
  const fields = handoffFields(input.handoffText);
  return {
    id: checkpointId(input.taskId, input.attempt),
    taskId: input.taskId,
    attempt: input.attempt,
    workspaceId: input.workspaceId,
    tabId: input.tabId,
    tabName: input.tabName,
    host: input.host,
    createdAt: input.createdAt,
    handoffPath: input.handoffPath,
    handoffDigest: sha256(input.handoffText),
    handoffText: input.handoffText,
    facts: input.facts,
    intendedNextAction: fields.resumeCommand ?? '',
    inFlight: fields.inFlight,
    outstandingDecisionIds: fields.openQuestions,
    failedApproaches: fields.doNot,
    evidenceRefs: fields.standingRuleSources,
    rationale: fields.decisions,
    role: fields.role,
    sessionBefore: input.sessionBefore,
  };
};

/**
 * `sh -s -- <cwd> <expected head>` on the tab's host: one `key<TAB>value` line per fact. A missing directory and a
 * directory outside git are answers, not failures; only the transport (ssh) can fail. The dirty count leaves out
 * the server's own `<handoff>.checkpoint.json` copy, written after the checkpoint's probe and before the resume's,
 * by an exclude pathspec over the whole tree, so a quoted path (one with a space) is left out too (review r1 F5). A
 * `git status` that fails gives `?`: the count is not measured, never 0 (review r2 N3).
 */
export const GIT_FACTS_SCRIPT = `cwd=$1; want=$2
if [ -z "$cwd" ] || ! cd -- "$cwd" 2>/dev/null; then printf 'kind\\tno-cwd\\n'; exit 0; fi
printf 'cwd\\t%s\\n' "$PWD"
top=$(git rev-parse --show-toplevel 2>/dev/null) || { printf 'kind\\tno-repo\\n'; exit 0; }
printf 'kind\\tok\\nworktree\\t%s\\n' "$top"
printf 'branch\\t%s\\n' "$(git symbolic-ref -q --short HEAD 2>/dev/null)"
printf 'head\\t%s\\n' "$(git rev-parse -q --verify HEAD 2>/dev/null)"
ref=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null) || ref=$(git rev-parse -q --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null) || ref=
printf 'baseRef\\t%s\\n' "$ref"
if [ -n "$ref" ]; then printf 'base\\t%s\\n' "$(git merge-base HEAD "$ref" 2>/dev/null)"; fi
if st=$(git status --porcelain -- ':/' ':(top,exclude,glob)**/*.checkpoint.json' 2>/dev/null); then
  if [ -z "$st" ]; then printf 'dirty\\t0\\n'; else printf 'dirty\\t%s\\n' "$(printf '%s\\n' "$st" | wc -l | tr -d ' ')"; fi
else
  printf 'dirty\\t?\\n'
fi
if [ -n "$want" ]; then
  if git merge-base --is-ancestor "$want" HEAD 2>/dev/null; then printf 'contains\\t1\\n'; else printf 'contains\\t0\\n'; fi
fi
`;

/** The probe's output as facts; `cwd` is the directory asked for when the probe could not enter it. */
export const parseGitFacts = (stdout: string, askedCwd: string | null): IGitFacts => {
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab > 0) values.set(line.slice(0, tab), line.slice(tab + 1));
  }
  const text = (key: string): string | null => values.get(key) || null;
  const kind = values.get('kind');
  const known = kind === 'ok' || kind === 'no-repo' ? kind : 'no-cwd';
  const dirty = values.get('dirty');
  const contains = values.get('contains');
  return {
    kind: known,
    cwd: text('cwd') ?? askedCwd,
    worktree: known === 'ok' ? text('worktree') : null,
    branch: known === 'ok' ? text('branch') : null,
    head: known === 'ok' ? text('head') : null,
    baseRef: known === 'ok' ? text('baseRef') : null,
    base: known === 'ok' ? text('base') : null,
    dirty: known === 'ok' && dirty !== undefined && /^\d+$/.test(dirty) ? Number(dirty) : null,
    ...(contains === undefined ? {} : { containsExpected: contains === '1' }),
  };
};

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : 'none');

const where = (facts: IGitFacts): string => {
  if (facts.kind === 'ok') return `worktree ${facts.worktree} on ${facts.branch ? `branch ${facts.branch}` : 'a detached HEAD'} at ${short(facts.head)}`;
  if (facts.kind === 'no-repo') return `directory ${facts.cwd ?? 'unknown'} (not a git worktree)`;
  return facts.cwd ? `no directory at ${facts.cwd}` : 'no known working directory';
};

/** Each way the worktree now differs from the checkpoint, as one clause; empty when it matches. */
export const compareFacts = (expected: IGitFacts, actual: IGitFacts): string[] => {
  if (expected.kind !== actual.kind) return [`the checkpoint saw ${where(expected)}; now ${where(actual)}`];
  const differences: string[] = [];
  if (expected.kind !== 'ok') {
    if (expected.cwd !== actual.cwd) differences.push(`directory ${expected.cwd ?? 'unknown'} → ${actual.cwd ?? 'unknown'}`);
    return differences;
  }
  if (expected.worktree !== actual.worktree) differences.push(`worktree ${expected.worktree} → ${actual.worktree}`);
  if (expected.branch !== actual.branch) differences.push(`branch ${expected.branch ?? 'detached'} → ${actual.branch ?? 'detached'}`);
  if (expected.head !== actual.head) {
    const from = short(expected.head);
    const to = short(actual.head);
    if (actual.containsExpected === true) differences.push(`head moved on ${from} → ${to} (${from} is in its history)`);
    else if (actual.containsExpected === false) differences.push(`head ${from} → ${to}, and ${from} is not in its history (rewritten or reset)`);
    else differences.push(`head ${from} → ${to}`);
  }
  if (expected.dirty !== actual.dirty) differences.push(`uncommitted files ${expected.dirty ?? 'not measured'} → ${actual.dirty ?? 'not measured'}`);
  return differences;
};

/** One line: a paste must not carry a line break, and a name from a remote host must not carry a control character. */
const oneLine = (text: string): string => text.replace(/[\p{C}]+/gu, ' ');

const NOT_RESTORED = 'Not restored: the earlier conversation, its shell cwd and environment, and its background jobs.';

const covers = (checkpoint: IRotationCheckpoint): string => {
  const decisions = checkpoint.outstandingDecisionIds;
  const open = decisions.length ? `${decisions.length} open decision(s): ${decisions.join(', ')}` : 'no open decision';
  return `It covers the handoff (resume command, ${checkpoint.inFlight.length} in-flight item(s), ${open}) and the git facts.`;
};

export interface IResumeCheck {
  differences: string[];
  /** The server wrote the handoff file back from the checkpoint: it was missing or differed. */
  restored: boolean;
}

/**
 * The fresh session's first message (ADR-0036 §2 as amended by vel-D5). On a match it starts with the ADR-0036 line
 * `Read <path>, then continue: <resume>`; on a mismatch the resume command comes only after the reconciliation.
 */
export const firstMessageWithNotice = (checkpoint: IRotationCheckpoint, check: IResumeCheck): string => {
  const path = checkpoint.handoffPath;
  const head = `RESTORE NOTICE (checkpoint ${checkpoint.id}):`;
  const restored = check.restored ? ' The handoff file was missing or changed; the server wrote it back from the checkpoint.' : '';
  if (!check.differences.length) {
    return oneLine(`Read ${path}, then continue: ${checkpoint.intendedNextAction} ${head} verified ${where(checkpoint.facts)}.${restored} `
      + `${covers(checkpoint)} ${NOT_RESTORED}`);
  }
  return oneLine(`Read ${path}. ${head} the worktree does not match the checkpoint: ${check.differences.join('; ')}.${restored} `
    + `Reconcile this before you continue: record in ${path} what changed and what you did about it, then continue: `
    + `${checkpoint.intendedNextAction} ${covers(checkpoint)} ${NOT_RESTORED}`);
};

const numberOrNull = (attrs: Record<string, TLedgerAttrValue>, key: string): number | null => {
  const value = attrs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const textOrNull = (attrs: Record<string, TLedgerAttrValue>, key: string): string | null => {
  const value = attrs[key];
  return typeof value === 'string' && value ? value : null;
};

export interface ICoverageTab {
  workspaceId: string;
  handoffPath?: string | null;
  rotateAt?: TRotateAt | null;
}

/** AC6: how many workers rotate, how rotations went, and how long they waited; from the layouts and the seat items. */
export const rotationCoverage = (tabs: readonly ICoverageTab[], seatItems: readonly ILedgerItem[], now: number): IRotationCoverage => {
  const covered = tabs.filter((tab) => !!tab.handoffPath && tab.rotateAt !== 'off').length;
  const seats: IRotationSeatRow[] = seatItems
    .filter((item) => item.itemType === 'seat' && item.closedAt === null)
    .map((item) => {
      const dueAt = numberOrNull(item.attrs, 'rotationDueAt');
      // A due rotation waits in `watching` too, while the seat is busy or holds background work.
      const waiting = dueAt !== null && item.state !== 'rotation-alarm';
      return {
        workspaceId: item.workspaceId,
        itemKey: item.itemKey,
        holder: item.holder,
        phase: item.state,
        rotations: numberOrNull(item.attrs, 'rotations'),
        handoffRefusals: numberOrNull(item.attrs, 'handoffRefusals'),
        checkpointRefusals: numberOrNull(item.attrs, 'checkpointRefusals'),
        rotationTimeouts: numberOrNull(item.attrs, 'rotationTimeouts'),
        checkpointRefused: textOrNull(item.attrs, 'checkpointRefused'),
        checkpointMismatch: textOrNull(item.attrs, 'checkpointMismatch'),
        lastWaitToRotateMs: numberOrNull(item.attrs, 'lastWaitToRotateMs'),
        waitingMs: waiting ? Math.max(0, now - dueAt) : null,
      };
    })
    .sort((a, b) => a.workspaceId.localeCompare(b.workspaceId) || a.itemKey.localeCompare(b.itemKey));
  // Totals count every seat item the ledger keeps, closed ones too: a closed tab's rotations happened (r1 F8). A
  // counter no item ever wrote is not measured (null), never 0.
  const sum = (key: string): number | null => {
    const values = seatItems.filter((item) => item.itemType === 'seat').map((item) => numberOrNull(item.attrs, key)).filter((v): v is number => v !== null);
    return values.length ? values.reduce((total, value) => total + value, 0) : null;
  };
  const waited = sum('waitToRotateCount');
  const waitTotal = sum('waitToRotateTotalMs');
  return {
    workers: tabs.length,
    covered,
    coverage: tabs.length ? covered / tabs.length : null,
    rotations: sum('rotations'),
    handoffRefusals: sum('handoffRefusals'),
    checkpointRefusals: sum('checkpointRefusals'),
    rotationTimeouts: sum('rotationTimeouts'),
    waitToRotateTotalMs: waitTotal,
    waitToRotateMeanMs: waited && waitTotal !== null ? Math.round(waitTotal / waited) : null,
    seats,
  };
};
