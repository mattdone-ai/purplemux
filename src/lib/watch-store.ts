import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { nanoid } from 'nanoid';
import { brandCodedError } from '@/lib/coded-error';
import { AWS_PROFILE } from '@/lib/aws-sso-cache';
import { LEASE_NAME } from '@/lib/lease-policy';
import { LEDGER_ITEM_TYPES } from '@/lib/ledger';
import type { IWatch, IWatchesState, TWatchErrorCode, TWatchKind, TWatchUntil } from '@/types/watch';
import type { TCallerIdentity } from '@/types/identity';

// Harness watches (ADR-0015): tab-owned, one-shot subscriptions the server
// evaluates. Pure validation first, then the one host file (one file makes the
// host-wide GitHub cap one atomic count).

export class WatchError extends Error {
  constructor(readonly code: TWatchErrorCode, message: string) {
    super(message);
    // The brand the routes check (`isCodedError`): the class itself differs across bundles.
    brandCodedError(this, 'WatchError');
  }
}

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const WATCH_DEFAULT_TTL_S = DAY;
export const WATCH_MAX_TTL_S = 7 * DAY;
export const WATCH_MIN_TTL_S = MIN;
export const WATCH_DEFAULT_INTERVAL_S = 120;
/** An auth watch reads the SSO cache every 60 s (ADR-HFL-05 decision 6). */
export const WATCH_AUTH_INTERVAL_S = 60;
export const AUTH_TARGET_PREFIX = 'aws-sso:';
export const WATCH_MIN_INTERVAL_S = 60;
export const WATCH_MAX_INTERVAL_S = HOUR;
/** Active pr and ref watches on the host. */
export const WATCH_GITHUB_CAP = 60;
/**
 * GitHub requests per hour all watches together may spend: 40 % of the 5,000/h user budget, which
 * every session's `gh` and `pr-poll.sh` share (review round 1: 60 checks-settled watches at 60 s
 * would ask for 10,800/h).
 */
export const WATCH_GITHUB_REQUESTS_PER_HOUR = 2_000;
/** A failing watch waits up to this many intervals between reads (doubling per failure). */
export const WATCH_BACKOFF_MAX = 8;
/** Watches one tab may hold, of any kind. */
export const WATCH_TAB_CAP = 30;
export const WATCH_FAILURES_BEFORE_NOTICE = 3;
export const WATCH_LABEL_MAX = 80;

const OWNER_REPO = '([A-Za-z0-9_.-]{1,100})/([A-Za-z0-9_.-]{1,100})';
const PR_TARGET = new RegExp(`^${OWNER_REPO}#(\\d{1,7})$`);
// A git ref name, conservatively: no spaces, no `..`, no control characters.
const REF_TARGET = new RegExp(`^${OWNER_REPO}@([A-Za-z0-9_./-]{1,100})$`);
const WATCH_ID = /^w-[A-Za-z0-9_-]{4,32}$/;

const UNTIL: Record<TWatchKind, readonly TWatchUntil[]> = {
  pr: ['merged', 'closed', 'head-moved', 'checks-settled'],
  ref: ['moved'],
  lease: ['free'],
  auth: ['signed-in'],
};
const LEDGER_ITEM_KEY = /^([a-z-]{1,16}):[^\s]{1,183}$/;

export const isWatchId = (v: unknown): v is string => typeof v === 'string' && WATCH_ID.test(v);
export const newWatchId = (): string => `w-${nanoid(10)}`;

export interface IPrTarget { owner: string; repo: string; number: number }
export interface IRefTarget { owner: string; repo: string; ref: string }

export const parsePr = (target: string): IPrTarget | null => {
  const m = PR_TARGET.exec(target);
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
};

export const parseRef = (target: string): IRefTarget | null => {
  const m = REF_TARGET.exec(target);
  if (!m || m[3].includes('..') || m[3].startsWith('/') || m[3].endsWith('/')) return null;
  return { owner: m[1], repo: m[2], ref: m[3] };
};

export interface IWatchSpec {
  kind: TWatchKind;
  target: string;
  until: TWatchUntil;
  ttlSeconds: number;
  intervalS: number;
  label: string | null;
  ledgerItem: string | null;
}

/** An auth watch's profile: its target without the `aws-sso:` prefix. */
export const authProfile = (target: string): string =>
  (target.startsWith(AUTH_TARGET_PREFIX) ? target.slice(AUTH_TARGET_PREFIX.length) : target);

const ledgerItemOf = (kind: TWatchKind, raw: unknown): string | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (kind !== 'auth') throw new WatchError('watch-invalid', 'ledgerItem belongs to an auth watch only');
  const m = typeof raw === 'string' ? LEDGER_ITEM_KEY.exec(raw) : null;
  if (!m || !(LEDGER_ITEM_TYPES as readonly string[]).includes(m[1])) {
    throw new WatchError('watch-invalid', `ledgerItem is a ledger item key <type>:<id> with a type of ${LEDGER_ITEM_TYPES.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return raw as string;
};

const whole = (raw: unknown, name: string, min: number, max: number, fallback: number): number => {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new WatchError('watch-invalid', `${name} must be a whole number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  }
  return raw;
};

export const checkSpec = (input: Record<string, unknown>): IWatchSpec => {
  const kind = input.kind;
  if (kind !== 'pr' && kind !== 'ref' && kind !== 'lease' && kind !== 'auth') {
    throw new WatchError('watch-invalid', `kind must be pr, ref, lease or auth, got ${JSON.stringify(kind)}`);
  }
  const raw = typeof input.target === 'string' ? input.target.trim() : '';
  const target = kind === 'auth' ? `${AUTH_TARGET_PREFIX}${authProfile(raw)}` : kind === 'lease' ? raw.toLowerCase() : raw;
  const valid = kind === 'pr' ? !!parsePr(target) : kind === 'ref' ? !!parseRef(target)
    : kind === 'lease' ? LEASE_NAME.test(target) : AWS_PROFILE.test(authProfile(raw));
  if (!valid) {
    const form = { pr: 'OWNER/REPO#N', ref: 'OWNER/REPO@REF', lease: 'a lease name (<kind>:<resource>)', auth: 'an AWS profile name (1-64 of A-Z a-z 0-9 . _ -)' }[kind];
    throw new WatchError('watch-invalid', `a ${kind} watch target is ${form}, got ${JSON.stringify(input.target)}`);
  }
  const until = input.until;
  if (!UNTIL[kind].includes(until as TWatchUntil)) {
    throw new WatchError('watch-invalid', `a ${kind} watch waits --until ${UNTIL[kind].join('|')}, got ${JSON.stringify(until)}`);
  }
  let label: string | null = null;
  if (input.label !== undefined && input.label !== null && input.label !== '') {
    if (typeof input.label !== 'string') throw new WatchError('watch-invalid', 'label must be text');
    label = input.label.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if ([...label].length > WATCH_LABEL_MAX) throw new WatchError('watch-invalid', `label is longer than ${WATCH_LABEL_MAX} characters`);
    label = label || null;
  }
  return {
    kind,
    target,
    until: until as TWatchUntil,
    ttlSeconds: whole(input.ttlSeconds, 'ttlSeconds', WATCH_MIN_TTL_S, WATCH_MAX_TTL_S, WATCH_DEFAULT_TTL_S),
    intervalS: whole(input.intervalS, 'intervalS', WATCH_MIN_INTERVAL_S, WATCH_MAX_INTERVAL_S,
      kind === 'auth' ? WATCH_AUTH_INTERVAL_S : WATCH_DEFAULT_INTERVAL_S),
    label,
    ledgerItem: ledgerItemOf(kind, input.ledgerItem),
  };
};

export const isGithub = (w: Pick<IWatch, 'kind'>): boolean => w.kind === 'pr' || w.kind === 'ref';

/** Reads per check: a PR, plus check runs and commit status for checks-settled; a ref, one. */
export const readsPerCheck = (w: Pick<IWatch, 'kind' | 'until'>): number => (w.kind === 'pr' && w.until === 'checks-settled' ? 3 : 1);

/** The GitHub requests per hour a watch asks for at its interval. */
export const requestsPerHour = (w: Pick<IWatch, 'kind' | 'until' | 'intervalS'>): number =>
  (isGithub(w) ? (readsPerCheck(w) * 3600) / w.intervalS : 0);

/** The caps, counted on the state the new watch joins. */
export const checkCaps = (state: IWatchesState, spec: IWatchSpec, owner: { workspaceId: string; tabId: string }): void => {
  if (isGithub(spec)) {
    const github = state.watches.filter(isGithub).length;
    if (github >= WATCH_GITHUB_CAP) {
      throw new WatchError('watch-cap', `the host holds ${github} GitHub watches; the cap is ${WATCH_GITHUB_CAP} (clear one with purplemux watch clear)`);
    }
    const rate = state.watches.reduce((sum, w) => sum + requestsPerHour(w), 0);
    const mine = requestsPerHour(spec);
    if (rate + mine > WATCH_GITHUB_REQUESTS_PER_HOUR) {
      throw new WatchError('watch-cap', `GitHub watches already ask for ${Math.round(rate)} requests/h; this one adds ${Math.round(mine)} and the budget is ${WATCH_GITHUB_REQUESTS_PER_HOUR} (a longer --interval asks for less)`);
    }
  }
  const mine = state.watches.filter((w) => w.workspaceId === owner.workspaceId && w.tabId === owner.tabId).length;
  if (mine >= WATCH_TAB_CAP) throw new WatchError('watch-cap', `this tab holds ${mine} watches; the cap is ${WATCH_TAB_CAP}`);
};

export const createWatch = (
  spec: IWatchSpec,
  owner: { workspaceId: string; tabId: string; verified: boolean; identity?: TCallerIdentity },
  baseline: string | null,
  now: number,
  id: string,
  baselineHolds = false,
): IWatch => ({
  id,
  workspaceId: owner.workspaceId,
  tabId: owner.tabId,
  kind: spec.kind,
  target: spec.target,
  until: spec.until,
  baseline,
  intervalS: spec.intervalS,
  createdAt: now,
  expiresAt: now + spec.ttlSeconds * 1000,
  // The baseline read at creation is the first check of a GitHub watch, unless it already showed
  // the condition (a PR merged or closed): then the first pass reports it (review round 2).
  lastCheckedAt: !isGithub(spec) || baselineHolds ? null : now,
  failures: 0,
  failingNotified: false,
  lastError: null,
  label: spec.label,
  verified: owner.verified,
  identity: owner.identity,
  pendingNotice: null,
  ...(spec.ledgerItem ? { ledgerItem: spec.ledgerItem } : {}),
});

/**
 * A lease watch is evaluated every pass (a local read); a GitHub or auth watch when its interval is due.
 * Once the failing notice has gone out (WATCH_FAILURES_BEFORE_NOTICE failures), the interval doubles
 * per further failure up to WATCH_BACKOFF_MAX, so a broken watch does not hammer a rate-limited `gh`
 * while the first three reads stay prompt (review round 2). A pending notice is always due.
 */
export const isDue = (w: IWatch, now: number): boolean => {
  if (w.kind === 'lease' || w.lastCheckedAt === null || w.pendingNotice) return true;
  const beyond = w.failures - WATCH_FAILURES_BEFORE_NOTICE + 1;
  const backoff = beyond > 0 ? Math.min(2 ** beyond, WATCH_BACKOFF_MAX) : 1;
  return now - w.lastCheckedAt >= w.intervalS * 1000 * backoff;
};

// ─── the file store ───────────────────────────────────────────────────────

const g = globalThis as unknown as { __ptWatchLock?: Promise<void> };
if (!g.__ptWatchLock) g.__ptWatchLock = Promise.resolve();

export const watchesFile = (): string => path.join(os.homedir(), '.purplemux', 'watches.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptWatchLock!;
  g.__ptWatchLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isWatch = (v: unknown): v is IWatch => {
  if (!v || typeof v !== 'object') return false;
  const w = v as Record<string, unknown>;
  return isWatchId(w.id) && typeof w.workspaceId === 'string' && typeof w.tabId === 'string'
    && (w.kind === 'pr' || w.kind === 'ref' || w.kind === 'lease' || w.kind === 'auth') && typeof w.target === 'string'
    && Number.isSafeInteger(w.expiresAt) && Number.isSafeInteger(w.intervalS)
    && (w.pendingNotice === undefined || w.pendingNotice === null
      || (typeof w.pendingNotice === 'object' && typeof (w.pendingNotice as Record<string, unknown>).notice === 'string'));
};

/** Absent file = no watches; a malformed file is refused, never read as empty (the next write would erase it). */
export const readWatches = async (): Promise<IWatchesState> => {
  const file = watchesFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { watches: [] };
    throw err;
  }
  const list = (JSON.parse(raw) as { watches?: unknown } | null)?.watches;
  if (!Array.isArray(list) || !list.every(isWatch)) {
    throw new Error(`${file} is malformed; watches are refused until it is repaired or moved aside`);
  }
  return { watches: list };
};

const writeWatches = async (state: IWatchesState): Promise<void> => {
  const file = watchesFile();
  const tmp = `${file}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

export const mutateWatches = <T>(fn: (state: IWatchesState) => Promise<{ state: IWatchesState; value: T }>): Promise<T> =>
  withLock(async () => {
    const before = await readWatches();
    const { state, value } = await fn(before);
    if (state !== before) await writeWatches(state);
    return value;
  });
