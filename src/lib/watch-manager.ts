import os from 'os';
import { SsoConfigError, findSsoProfile, readSsoToken, type TSsoTokenState } from '@/lib/aws-sso-cache';
import type { ICaller } from '@/lib/caller';
import { RATE_LIMIT_MAX_HOLD_MS, boundRetryAt, runGhApi, type IGhRate, type TGhResult } from '@/lib/gh-api';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import type { IWatchFields } from '@/lib/inbox-templates';
import { createLogger } from '@/lib/logger';
import {
  WATCH_FAILURES_BEFORE_NOTICE,
  WatchError,
  authProfile,
  checkCaps,
  checkSpec,
  createWatch,
  isDue,
  isGithub,
  isWatchId,
  mutateWatches,
  newWatchId,
  parsePr,
  parseRef,
  readWatches,
  type IWatchSpec,
} from '@/lib/watch-store';
import type { IInboxItem } from '@/types/inbox';
import type { IWatch, IWatchesState, IWatchView, TWatchFailure } from '@/types/watch';

// Evaluates harness watches (ADR-0015) and reports each outcome to the owner tab
// through the inbox. GitHub reads use the server's own `gh` (reads need no
// identity pin); a lease watch reads the local lease store.

const log = createLogger('watches');

export const WATCH_TICK_MS = 15_000;
/** A watch whose notice cannot be queued is dropped this long after its expiry. */
export const PENDING_GRACE_MS = 24 * 60 * 60 * 1000;
export { GH_TIMEOUT_MS, classifyGhError, type IGhRate, type TGhResult } from '@/lib/gh-api';

export interface IWatchDeps {
  now: () => number;
  newId: () => string;
  runGh: (args: string[]) => Promise<TGhResult>;
  /** True when no unexpired record of the lease exists: an acquire by anyone would succeed. */
  leaseFree: (name: string) => Promise<boolean>;
  /**
   * An auth watch's proof (ADR-0041): the profile's AWS SSO cache file, read as a file. Throws
   * SsoConfigError when the profile is not an SSO profile or a file is unreadable. Never runs `aws`.
   */
  ssoToken: (profile: string, now: number) => Promise<TSsoTokenState>;
  /** Refuses a profile the AWS config does not define as SSO, at creation. */
  ssoProfile: (profile: string) => Promise<unknown>;
  /**
   * The remote host a tab runs on (null: a local tab): an auth watch reads only this server's ~/.aws. `known: false`
   * when the layout cannot be read or does not hold the tab: never taken for a local tab (confirm NIT 4).
   */
  tabHost: (workspaceId: string, tabId: string) => Promise<{ known: false } | { known: true; host: string | null }>;
  /** This server's host name, for the refusal of a remote tab's auth watch. */
  hostName: () => string;
  /** Live tabs, and the workspaces whose layout could not be read (their tabs are unknown, not closed). */
  liveTabs: () => Promise<{ tabs: ReadonlyArray<{ workspaceId: string; tabId: string }>; uncertainWorkspaceIds: ReadonlySet<string> }>;
  enqueue: (req: IEnqueueRequest<'watch'>) => Promise<{ item: IInboxItem }>;
  onFired?: (watch: IWatch, fields: Record<string, unknown>) => Promise<void>;
  read: () => Promise<IWatchesState>;
  mutate: typeof mutateWatches;
}

type TFired = Omit<IWatchFields, 'watchId' | 'target'>;

type TOutcome =
  | { type: 'fire'; fields: TFired }
  /** `baseline`: the first read of a watch made while GitHub was rate-limited (its baseline was pending). */
  | { type: 'wait'; baseline?: string }
  /** `retryAt` on `rate-limited` only: GitHub's own reset, when the lane reads again. */
  | { type: 'fail'; code: TWatchFailure; message: string; retryAt?: number };

type TGhFailure = Extract<TGhResult, { ok: false }>;

const failOf = (r: TGhFailure): TOutcome => ({ type: 'fail', code: r.code, message: r.message, ...(r.retryAt !== undefined ? { retryAt: r.retryAt } : {}) });

/**
 * A pull request in one GraphQL read (PMUX-WATCH-403): its state, its head and the check rollup of that head. A
 * watch spends one point of the GraphQL budget per check, never the REST budget every `gh` and `gh api` of the
 * shared account spends (on 2026-11-14 at 03:56Z that REST budget reached 0 and `watch pr` failed http-403).
 * The variables go as `-f` (a string) except the number: `-F` reads a value that starts with `@` as a file.
 */
export const PR_QUERY = 'query($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) '
  + '{ pullRequest(number: $number) { merged state headRefOid commits(last: 1) { nodes { commit { oid statusCheckRollup '
  + '{ contexts(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { __typename '
  + '... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } } } } }';

/** A ref's commit in one GraphQL read; an annotated tag names its target commit, as REST `commits/<ref>` does. */
export const REF_QUERY = 'query($owner: String!, $name: String!, $expression: String!) { repository(owner: $owner, name: $name) '
  + '{ object(expression: $expression) { __typename oid ... on Tag { target { __typename oid } } } } }';

interface IRollupPage { runs: string[]; statuses: string[]; hasNextPage: boolean; endCursor: string | null }

/** A rollup page as the lines `settleChecks` reads: a check run `status\tconclusion`, a commit status its state. */
const rollupPage = (rollup: unknown): IRollupPage => {
  const contexts = (rollup as { contexts?: { pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown[] } } | null)?.contexts;
  const runs: string[] = [];
  const statuses: string[] = [];
  for (const node of contexts?.nodes ?? []) {
    const n = node as { __typename?: unknown; status?: unknown; conclusion?: unknown; state?: unknown };
    if (n.__typename === 'CheckRun') runs.push(`${String(n.status ?? '').toLowerCase()}\t${String(n.conclusion ?? '').toLowerCase()}`);
    // EXPECTED: a required status that has not reported yet, so it is still pending.
    else if (n.__typename === 'StatusContext') statuses.push(n.state === 'EXPECTED' ? 'pending' : String(n.state ?? '').toLowerCase());
  }
  return {
    runs,
    statuses,
    hasNextPage: contexts?.pageInfo?.hasNextPage === true,
    endCursor: typeof contexts?.pageInfo?.endCursor === 'string' ? contexts.pageInfo.endCursor : null,
  };
};

/** One watch read per GitHub watch an hour back, for the budget log line: who spent what. */
const SPEND_WINDOW_MS = 60 * 60 * 1000;
/** The budget log warns once per reset when this share of a budget is left. */
const BUDGET_LOW_SHARE = 0.1;
/** A hold ends this long after GitHub's reset: a reset read to the second is not yet a budget (r2 #2). */
export const RESUME_MARGIN_MS = 5_000;
/**
 * After a hold the GitHub watches resume one slot apart, in the order they were made, up to the last slot: never
 * every watch in the first pass after the reset (r2 #2).
 */
export const RESUME_STAGGER_MS = 2_000;
export const RESUME_STAGGER_MAX_MS = 60_000;

/** A time as ISO text, or `an unknown time` for a value no Date can hold: a log or a message never throws. */
const isoTime = (ms: number): string => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : 'an unknown time');

/** The server's `gh api` reads, with their status and rate-limit headers (`gh-api.ts`). */
export const runGhDefault = (args: string[]): Promise<TGhResult> => runGhApi(args);

const GREEN = new Set(['success', 'neutral', 'skipped']);

/** Settled when at least one check or status exists and none is still running or pending. */
export const settleChecks = (runs: string, statuses: string): { settled: boolean; green: number; red: number } => {
  let green = 0;
  let red = 0;
  let total = 0;
  let pending = false;
  for (const line of runs.split('\n').filter(Boolean)) {
    const [status, conclusion = ''] = line.split('\t');
    total++;
    if (status !== 'completed') pending = true;
    else if (GREEN.has(conclusion)) green++;
    else red++;
  }
  for (const state of statuses.split('\n').filter(Boolean)) {
    total++;
    if (state === 'pending') pending = true;
    else if (state === 'success') green++;
    else red++;
  }
  return { settled: total > 0 && !pending, green, red };
};

const SHA = /^[0-9a-f]{7,40}$/;

/** An auth watch's baseline: the valid token it was created under, or null when it was raised on none. */
export const authBaseline = (token: TSsoTokenState): string | null => (token.state === 'valid' ? `sso:${token.expiresAt}` : null);

export class WatchManager {
  constructor(private readonly deps: IWatchDeps) {}

  // ─── reads ──────────────────────────────────────────────────────────────

  // ─── the GitHub budget ──────────────────────────────────────────────────

  /** No GitHub read before this time: GitHub's own reset of a rate limit this server met (PMUX-WATCH-403). */
  private githubPausedUntil = 0;
  /** The last budget each resource reported. */
  private budgets = new Map<string, IGhRate>();
  /** The raw `X-RateLimit-Reset` a low-budget line was already logged for, per resource: one line per window. */
  private lowLogged = new Map<string, number>();
  /** One entry per watch read an hour back: which owner spent it. */
  private spend: Array<{ at: number; owner: string }> = [];

  /**
   * Hold every GitHub read until `retryAt` plus {@link RESUME_MARGIN_MS}; a later reset only lengthens the hold. The
   * time is bounded again here: never past {@link RATE_LIMIT_MAX_HOLD_MS} (one line logs a clamp, with the header
   * GitHub sent), and a value that is not a time after now holds for the fallback.
   */
  private pauseGithub(retryAt: number | undefined, now: number, header?: string, clampedAtSource = false): void {
    const bounded = boundRetryAt(retryAt ?? NaN, now);
    if (bounded.clamped || clampedAtSource) {
      log.warn({ header: header ?? 'unknown', maxHoldMs: RATE_LIMIT_MAX_HOLD_MS },
        `a GitHub rate-limit hold past ${RATE_LIMIT_MAX_HOLD_MS / 60_000} min was clamped to ${isoTime(bounded.at)}`);
    }
    this.githubPausedUntil = Math.max(this.githubPausedUntil, bounded.at + RESUME_MARGIN_MS);
  }

  /** Whether the GitHub lane holds its reads now. */
  githubPaused(now = this.deps.now()): boolean {
    return now < this.githubPausedUntil;
  }

  /**
   * What the watches spent, for the log line: the reads an hour back, and the owners that spent the most. A budget
   * that ran out while the watches spent little of it was spent by another caller of the account.
   */
  private spendSummary(now: number): { watchReads: number; topOwners: Array<{ owner: string; reads: number }> } {
    this.spend = this.spend.filter((e) => now - e.at < SPEND_WINDOW_MS);
    const byOwner = new Map<string, number>();
    for (const e of this.spend) byOwner.set(e.owner, (byOwner.get(e.owner) ?? 0) + 1);
    const topOwners = [...byOwner.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([owner, reads]) => ({ owner, reads }));
    return { watchReads: this.spend.length, topOwners };
  }

  /** One read of the GitHub API, counted against its owner, with the budget it reported logged. */
  private async gh(args: string[], owner: string): Promise<TGhResult> {
    const r = await this.deps.runGh(args);
    // The time after the read, as the read's own bound used (r3 #3): a hold the read bounded is never clamped again.
    const now = this.deps.now();
    // Pruned on every push, not only when read: the log holds one hour of reads, whatever reads it (r2 #4).
    this.spend.push({ at: now, owner });
    this.spend = this.spend.filter((e) => now - e.at < SPEND_WINDOW_MS);
    if (r.rate) {
      this.budgets.set(r.rate.resource, r.rate);
      log.debug({ resource: r.rate.resource, remaining: r.rate.remaining, limit: r.rate.limit, owner }, 'watch read: GitHub budget');
    }
    const rate = r.rate;
    const low = rate && rate.remaining <= rate.limit * BUDGET_LOW_SHARE && this.lowLogged.get(rate.resource) !== rate.resetEpochS;
    if (!r.ok && r.code === 'rate-limited') {
      this.pauseGithub(r.retryAt, now, r.retryHeader, r.retryClamped === true);
      log.warn({ ...rate, retryHeader: r.retryHeader, pausedUntil: this.githubPausedUntil, ...this.spendSummary(now) },
        `GitHub rate limit met by a watch read; GitHub watches wait until ${isoTime(this.githubPausedUntil)}`);
    } else if (low) {
      this.lowLogged.set(rate.resource, rate.resetEpochS);
      log.warn({ ...rate, ...this.spendSummary(now) }, `GitHub ${rate.resource} budget low: ${rate.remaining} of ${rate.limit} left until ${isoTime(rate.resetAt)}`);
    }
    return r;
  }

  /** The last budget each resource reported, and the watches' own spend an hour back. */
  budget(): { budgets: IGhRate[]; pausedUntil: number | null } & ReturnType<WatchManager['spendSummary']> {
    const now = this.deps.now();
    return { budgets: [...this.budgets.values()], pausedUntil: this.githubPaused(now) ? this.githubPausedUntil : null, ...this.spendSummary(now) };
  }

  // ─── reads ──────────────────────────────────────────────────────────────

  private async prPage(target: string, owner: string, cursor: string | null): Promise<
    { ok: true; merged: boolean; state: string; head: string; checksHead: string | null; page: IRollupPage } | TGhFailure> {
    const pr = parsePr(target)!;
    const r = await this.gh(['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `owner=${pr.owner}`, '-f', `name=${pr.repo}`,
      '-F', `number=${pr.number}`, ...(cursor ? ['-f', `cursor=${cursor}`] : [])], owner);
    if (!r.ok) return r;
    let node: { merged?: unknown; state?: unknown; headRefOid?: unknown; commits?: { nodes?: Array<{ commit?: { oid?: unknown; statusCheckRollup?: unknown } }> } } | null | undefined;
    try {
      node = (JSON.parse(r.stdout) as { data?: { repository?: { pullRequest?: typeof node } | null } }).data?.repository?.pullRequest;
    } catch {
      return { ok: false, code: 'other', message: 'gh api graphql returned a body that is not JSON' };
    }
    if (!node) return { ok: false, code: 'http-404', message: `${target} does not exist or is not visible to the server's gh` };
    const head = node.headRefOid;
    if (typeof head !== 'string' || !SHA.test(head)) return { ok: false, code: 'other', message: 'the pull request has no head sha' };
    const commit = node.commits?.nodes?.[0]?.commit;
    const state = node.state === 'MERGED' || node.state === 'CLOSED' ? 'closed' : String(node.state ?? '').toLowerCase();
    return {
      ok: true,
      merged: node.merged === true || node.state === 'MERGED',
      state,
      head,
      checksHead: typeof commit?.oid === 'string' ? commit.oid : null,
      page: rollupPage(commit?.statusCheckRollup ?? null),
    };
  }

  private async pull(target: string, owner: string): Promise<{ ok: true; merged: boolean; state: string; head: string } | TGhFailure> {
    const p = await this.prPage(target, owner, null);
    return p.ok ? { ok: true, merged: p.merged, state: p.state, head: p.head } : p;
  }

  /**
   * The pull request and every check of its head. The rollup belongs to the PR's last commit; a page read while the
   * head moved is reported as `moved`, and the caller waits for the next check.
   */
  private async pullWithChecks(target: string, owner: string): Promise<
    { ok: true; moved: boolean; head: string; runs: string; statuses: string } | TGhFailure> {
    let page = await this.prPage(target, owner, null);
    if (!page.ok) return page;
    const head = page.head;
    const runs: string[] = [];
    const statuses: string[] = [];
    for (;;) {
      if (page.head !== head || page.checksHead !== head) return { ok: true, moved: true, head, runs: '', statuses: '' };
      runs.push(...page.page.runs);
      statuses.push(...page.page.statuses);
      if (!page.page.hasNextPage || !page.page.endCursor) break;
      page = await this.prPage(target, owner, page.page.endCursor);
      if (!page.ok) return page;
    }
    return { ok: true, moved: false, head, runs: runs.map((l) => `${l}\n`).join(''), statuses: statuses.map((l) => `${l}\n`).join('') };
  }

  private async refSha(target: string, owner: string): Promise<{ ok: true; sha: string } | TGhFailure> {
    const ref = parseRef(target)!;
    const r = await this.gh(['api', 'graphql', '-f', `query=${REF_QUERY}`, '-f', `owner=${ref.owner}`, '-f', `name=${ref.repo}`,
      '-f', `expression=${ref.ref}`], owner);
    if (!r.ok) return r;
    let object: { __typename?: unknown; oid?: unknown; target?: { __typename?: unknown; oid?: unknown } } | null | undefined;
    try {
      object = (JSON.parse(r.stdout) as { data?: { repository?: { object?: typeof object } | null } }).data?.repository?.object;
    } catch {
      return { ok: false, code: 'other', message: 'gh api graphql returned a body that is not JSON' };
    }
    if (!object) return { ok: false, code: 'http-404', message: `${target} does not name a commit visible to the server's gh` };
    const sha = object.__typename === 'Tag' ? object.target?.oid : object.oid;
    return typeof sha === 'string' && SHA.test(sha) ? { ok: true, sha } : { ok: false, code: 'other', message: 'gh api graphql returned no commit sha' };
  }

  private async evaluate(w: IWatch): Promise<TOutcome> {
    if (w.kind === 'lease') return (await this.deps.leaseFree(w.target)) ? { type: 'fire', fields: { notice: 'free' } } : { type: 'wait' };
    if (w.kind === 'auth') {
      try {
        const token = await this.deps.ssoToken(authProfile(w.target), this.deps.now());
        // A sign-in is a change: the token valid at creation (its baseline) does not fire, a new one does (R8).
        return token.state === 'valid' && authBaseline(token) !== w.baseline
          ? { type: 'fire', fields: { notice: 'signed-in', expiresAt: token.expiresAt } }
          : { type: 'wait' };
      } catch (err) {
        if (err instanceof SsoConfigError) return { type: 'fail', code: 'sso-config', message: err.message };
        throw err;
      }
    }
    const owner = `${w.workspaceId}/${w.tabId}`;
    if (w.kind === 'ref') {
      const r = await this.refSha(w.target, owner);
      if (!r.ok) return failOf(r);
      // A watch made during a rate limit takes its baseline now: the move it waits for starts here.
      if (w.baselinePending) return { type: 'wait', baseline: r.sha };
      return r.sha !== w.baseline ? { type: 'fire', fields: { notice: 'moved', fromSha: w.baseline!, sha: r.sha } } : { type: 'wait' };
    }
    if (w.until === 'checks-settled') {
      const c = await this.pullWithChecks(w.target, owner);
      if (!c.ok) return failOf(c);
      const pending = w.baselinePending ? { baseline: c.head } : {};
      if (c.moved) return { type: 'wait', ...pending };
      const settled = settleChecks(c.runs, c.statuses);
      const successful = c.runs.split('\n').filter((line) => line === 'completed\tsuccess').length
        + c.statuses.split('\n').filter((state) => state === 'success').length;
      return settled.settled
        ? { type: 'fire', fields: { notice: 'checks-settled', sha: c.head, green: settled.green, red: settled.red, successful } }
        : { type: 'wait', ...pending };
    }
    const p = await this.pull(w.target, owner);
    if (!p.ok) return failOf(p);
    if (w.baselinePending && w.until === 'head-moved') return { type: 'wait', baseline: p.head };
    const pending = w.baselinePending ? { baseline: p.head } : {};
    // A PR closed without a merge will never satisfy `merged`: say so rather than wait for expiry
    // (review round 1; the abandoned-blocker half of pft-1385).
    if (w.until === 'merged') {
      if (p.merged) return { type: 'fire', fields: { notice: 'merged', sha: p.head } };
      return p.state === 'closed' ? { type: 'fire', fields: { notice: 'closed', sha: p.head } } : { type: 'wait', ...pending };
    }
    if (w.until === 'closed') {
      if (p.state !== 'closed') return { type: 'wait', ...pending };
      return { type: 'fire', fields: { notice: p.merged ? 'merged' : 'closed', sha: p.head } };
    }
    return p.head !== w.baseline ? { type: 'fire', fields: { notice: 'head-moved', fromSha: w.baseline!, sha: p.head } } : { type: 'wait' };
  }

  // ─── the tick ───────────────────────────────────────────────────────────

  private notice(w: IWatch, fields: Omit<IWatchFields, 'watchId' | 'target'>): IEnqueueRequest<'watch'> {
    return {
      kind: 'watch',
      targetWorkspaceId: w.workspaceId,
      targetTabId: w.tabId,
      dedupeKey: `watch:${w.id}:${fields.notice}`,
      fields: { watchId: w.id, target: w.target, ...fields },
    };
  }

  /**
   * Two lanes, each one pass at a time: lease watches (a local read) and GitHub watches (reads of up
   * to 20 s each). A lease notice never waits behind a GitHub read (review round 1). A pass asked for
   * while its lane runs runs once afterwards; `onlyLease` runs the lease lane for one name.
   */
  private lanes: Record<'lease' | 'github', { running: Promise<void> | null; again: string | undefined | null }> = {
    lease: { running: null, again: null },
    github: { running: null, again: null },
  };

  async tick(onlyLease?: string): Promise<void> {
    const runs = [this.lane('lease', onlyLease)];
    if (onlyLease === undefined) runs.push(this.lane('github'));
    await Promise.all(runs);
  }

  private lane(name: 'lease' | 'github', onlyLease?: string): Promise<void> {
    const lane = this.lanes[name];
    if (lane.running) {
      lane.again = lane.again === null ? onlyLease : undefined;
      return lane.running;
    }
    lane.running = (async () => {
      try {
        let scope: string | undefined | null = onlyLease;
        while (scope !== null) {
          lane.again = null;
          await this.pass(name, scope);
          scope = lane.again;
        }
      } finally {
        lane.running = null;
      }
    })();
    return lane.running;
  }

  private async pass(lane: 'lease' | 'github', onlyLease?: string): Promise<void> {
    // Every full lease-lane pass also drops the watches of tabs confirmed closed: the backstop for a
    // tab-closed removal that failed or raced a create (final confirmation).
    if (lane === 'lease' && onlyLease === undefined) {
      await this.hydrate().catch((err) => log.warn(`closed-tab watch sweep failed: ${err instanceof Error ? err.message : err}`));
    }
    const now = this.deps.now();
    const { watches } = await this.deps.read();
    const outcomes = new Map<string, TOutcome | 'expired' | 'dropped'>();
    const githubSlot = new Map(watches.filter(isGithub).map((w, slot) => [w.id, slot]));
    // Evaluated outside the lock: a GitHub read may take its full timeout.
    for (const w of watches) {
      // The local lane holds every watch that reads no GitHub: leases and auth (ADR-0041).
      if (isGithub(w) !== (lane === 'github')) continue;
      if (onlyLease !== undefined && !(w.kind === 'lease' && w.target === onlyLease)) continue;
      if (now >= w.expiresAt && !w.pendingNotice) {
        outcomes.set(w.id, 'expired');
        continue;
      }
      // A notice the inbox keeps refusing does not keep its watch alive forever (review round 2).
      if (w.pendingNotice && now >= w.expiresAt + PENDING_GRACE_MS) {
        outcomes.set(w.id, 'dropped');
        continue;
      }
      if (!isDue(w, now)) continue;
      if (w.pendingNotice) {
        outcomes.set(w.id, { type: 'fire', fields: w.pendingNotice as TFired });
        continue;
      }
      // A rate limit holds every GitHub read until GitHub's reset: no read, no failure, the watch kept (PMUX-WATCH-403).
      // After the hold each watch waits its own slot, so they do not all read in the first pass (r2 #2).
      if (isGithub(w) && now < this.githubPausedUntil + Math.min((githubSlot.get(w.id) ?? 0) * RESUME_STAGGER_MS, RESUME_STAGGER_MAX_MS)) continue;
      try {
        outcomes.set(w.id, await this.evaluate(w));
      } catch (err) {
        outcomes.set(w.id, { type: 'fail', code: 'other', message: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!outcomes.size) return;
    await this.deps.mutate(async (state) => {
      let next = state.watches;
      for (const [id, outcome] of outcomes) {
        const w = next.find((x) => x.id === id);
        if (!w) continue; // cleared or removed with its tab meanwhile
        next = await this.apply(next, w, outcome, now);
      }
      return { state: next === state.watches ? state : { watches: next }, value: undefined };
    });
  }

  private async apply(list: IWatch[], w: IWatch, outcome: TOutcome | 'expired' | 'dropped', now: number): Promise<IWatch[]> {
    const without = () => list.filter((x) => x.id !== w.id);
    const replace = (x: IWatch) => list.map((y) => (y.id === w.id ? x : y));
    if (outcome === 'dropped') {
      log.error(`watch ${w.id} dropped: its ${String(w.pendingNotice?.notice)} notice could not be queued for a day past expiry`);
      return without();
    }
    if (outcome === 'expired' || outcome.type === 'fire') {
      const fields: TFired = outcome === 'expired' ? { notice: 'expired', until: w.until } : outcome.fields;
      // Evaluation happens outside the watch mutation lock. A lease may be reacquired
      // before this point; keep its watch so the next actual release can still fire it.
      if (w.kind === 'lease' && fields.notice === 'free' && !(await this.deps.leaseFree(w.target))) {
        return replace({ ...w, pendingNotice: undefined, lastCheckedAt: now });
      }
      if (w.kind === 'pr' && fields.notice === 'checks-settled') {
        // This re-check is a GitHub read like any other: during a hold it does not run, and the notice waits for the
        // hold's end (r3 #2). A notice that cannot queue must never read, or extend the hold, on every pass.
        if (this.githubPaused()) return w.pendingNotice ? list : replace({ ...w, pendingNotice: fields as Record<string, unknown> });
        const current = await this.pull(w.target, `${w.workspaceId}/${w.tabId}`);
        if (!current.ok) return replace({ ...w, lastCheckedAt: now, lastError: { code: current.code,
          message: current.message, at: now } });
        if (current.head !== fields.sha) return replace({ ...w, pendingNotice: undefined, lastCheckedAt: now });
      }
      try {
        await this.deps.enqueue(this.notice(w, fields));
        if (outcome !== 'expired' && this.deps.onFired) await this.deps.onFired(w, fields as Record<string, unknown>);
      } catch (err) {
        // The condition held; only the notice is missing. Keep it, and retry the enqueue alone.
        log.warn(`watch ${w.id} notice not queued: ${err instanceof Error ? err.message : err}`);
        return replace({ ...w, pendingNotice: fields as Record<string, unknown>, lastCheckedAt: now });
      }
      return without();
    }
    if (outcome.type === 'wait') {
      const baseline = w.baselinePending && outcome.baseline ? { baseline: outcome.baseline, baselinePending: false } : {};
      return replace({ ...w, ...baseline, lastCheckedAt: now, failures: 0, failingNotified: false, lastError: w.kind === 'lease' ? w.lastError : null });
    }
    // GitHub's rate limit is not the watch failing: it counts no failure, sends no failing notice, and the watch reads
    // again after the reset GitHub named (PMUX-WATCH-403).
    if (outcome.code === 'rate-limited') {
      const until = isoTime(this.githubPausedUntil);
      return replace({ ...w, lastError: { code: 'rate-limited', message: `${outcome.message} (reads again after ${until})`, at: now } });
    }
    const failures = w.failures + 1;
    let failingNotified = w.failingNotified;
    // One failing notice per run of failures: a broken watch is never silence, never a stream.
    if (failures >= WATCH_FAILURES_BEFORE_NOTICE && !failingNotified) {
      try {
        await this.deps.enqueue(this.notice(w, { notice: 'failing', code: outcome.code }));
        failingNotified = true;
      } catch (err) {
        log.warn(`watch ${w.id} failing notice not queued (retried on the next failure): ${err instanceof Error ? err.message : err}`);
      }
    }
    return replace({ ...w, lastCheckedAt: now, failures, failingNotified, lastError: { code: outcome.code, message: outcome.message, at: now } });
  }

  // ─── tab lifecycle ──────────────────────────────────────────────────────

  async removeTab(workspaceId: string, tabId: string): Promise<number> {
    return this.deps.mutate(async (state) => {
      const keep = state.watches.filter((w) => !(w.workspaceId === workspaceId && w.tabId === tabId));
      return { state: keep.length === state.watches.length ? state : { watches: keep }, value: state.watches.length - keep.length };
    });
  }

  /**
   * Drop the watches of tabs confirmed closed; an unreadable workspace keeps its own. Runs at boot and
   * on every full lease-lane pass.
   */
  async hydrate(): Promise<number> {
    const live = await this.deps.liveTabs();
    const open = new Set(live.tabs.map((t) => `${t.workspaceId}/${t.tabId}`));
    return this.deps.mutate(async (state) => {
      const keep = state.watches.filter((w) => open.has(`${w.workspaceId}/${w.tabId}`) || live.uncertainWorkspaceIds.has(w.workspaceId));
      return { state: keep.length === state.watches.length ? state : { watches: keep }, value: state.watches.length - keep.length };
    });
  }

  // ─── the API ────────────────────────────────────────────────────────────

  /**
   * The baseline sha, and whether the creation read already shows a PR merged or closed. While GitHub is rate-limited
   * (PMUX-WATCH-403) the watch is made with its baseline pending, never refused: the first read after GitHub's reset
   * takes it. `pendingUntil` is that reset.
   */
  private async baseline(spec: IWatchSpec, owner: string): Promise<{ sha: string | null; holds: boolean; pendingUntil?: number }> {
    if (spec.kind === 'lease') return { sha: null, holds: false };
    if (spec.kind === 'auth') {
      try {
        await this.deps.ssoProfile(authProfile(spec.target));
        return { sha: authBaseline(await this.deps.ssoToken(authProfile(spec.target), this.deps.now())), holds: false };
      } catch (err) {
        if (err instanceof SsoConfigError) throw new WatchError('watch-invalid', err.message);
        throw err;
      }
    }
    if (this.githubPaused()) return { sha: null, holds: false, pendingUntil: this.githubPausedUntil };
    const r = spec.kind === 'pr' ? await this.pull(spec.target, owner) : await this.refSha(spec.target, owner);
    if (!r.ok && r.code === 'rate-limited') return { sha: null, holds: false, pendingUntil: this.githubPausedUntil };
    if (r.ok) {
      if (!('head' in r)) return { sha: r.sha, holds: false };
      const holds = (spec.until === 'merged' || spec.until === 'closed') && (r.merged || r.state === 'closed');
      return { sha: r.head, holds };
    }
    if (r.code === 'http-404') throw new WatchError('watch-invalid', `${spec.target} does not exist or is not visible to the server's gh`);
    throw new WatchError('gh-unavailable', `gh could not read ${spec.target} (${r.code}): ${r.message}`);
  }

  async create(caller: ICaller, input: Record<string, unknown>): Promise<IWatch> {
    if (caller.admin || !caller.workspaceId || !caller.tabId) {
      throw new WatchError('caller-unresolved', 'a watch belongs to a tab: call from the tab that will receive its notice');
    }
    const spec = checkSpec(input);
    const owner = { workspaceId: caller.workspaceId, tabId: caller.tabId, verified: caller.verified, identity: caller.identity };
    if (spec.kind === 'auth') {
      const where = await this.deps.tabHost(owner.workspaceId, owner.tabId);
      if (!where.known) {
        throw new WatchError('caller-unresolved', `the host of tab ${owner.tabId} could not be read from the layout of ${owner.workspaceId}; an auth watch reads only this server's SSO cache: retry`);
      }
      if (where.host) {
        throw new WatchError('watch-invalid', `an auth watch reads the SSO cache of this server's host (${this.deps.hostName()}); tab ${owner.tabId} runs on ${where.host}, whose sign-in it cannot see`);
      }
    }
    // A cheap cap check before the GitHub read, then the binding one under the lock.
    checkCaps(await this.deps.read(), spec, owner);
    const baseline = await this.baseline(spec, `${owner.workspaceId}/${owner.tabId}`);
    const now = this.deps.now();
    const pending = baseline.pendingUntil !== undefined;
    const made = createWatch(spec, owner, baseline.sha, now, this.deps.newId(), baseline.holds, pending);
    const watch: IWatch = pending
      ? { ...made, lastError: { code: 'rate-limited', at: now,
        message: `GitHub was rate-limited at creation; the first read after ${isoTime(baseline.pendingUntil!)} takes the baseline` } }
      : made;
    await this.deps.mutate(async (state) => {
      checkCaps(state, spec, owner);
      // The tab may have closed during the baseline read, and its removal already ran: a watch is
      // never added for a tab confirmed closed (final confirmation). An unreadable workspace is kept.
      const live = await this.deps.liveTabs();
      const open = live.tabs.some((t) => t.workspaceId === owner.workspaceId && t.tabId === owner.tabId);
      if (!open && !live.uncertainWorkspaceIds.has(owner.workspaceId)) {
        throw new WatchError('caller-unresolved', `tab ${owner.workspaceId}/${owner.tabId} is closed; a watch belongs to an open tab`);
      }
      return { state: { watches: [...state.watches, watch] }, value: undefined };
    });
    return watch;
  }

  async list(caller: ICaller, workspaceId: string | null): Promise<IWatchView[]> {
    const ws = workspaceId ?? caller.workspaceId;
    if (!caller.admin && (!ws || ws !== caller.workspaceId)) throw new WatchError('forbidden', 'a workspace token reads its own workspace\'s watches');
    const [{ watches }, live] = await Promise.all([this.deps.read(), this.deps.liveTabs()]);
    const open = new Set(live.tabs.map((t) => `${t.workspaceId}/${t.tabId}`));
    const now = this.deps.now();
    return watches
      .filter((w) => ws === null || w.workspaceId === ws)
      .map((w) => ({
        ...w,
        ageSeconds: Math.max(0, Math.floor((now - w.createdAt) / 1000)),
        expiresInSeconds: Math.max(0, Math.floor((w.expiresAt - now) / 1000)),
        owner: open.has(`${w.workspaceId}/${w.tabId}`) ? 'live' as const : live.uncertainWorkspaceIds.has(w.workspaceId) ? 'unknown' as const : 'closed' as const,
      }));
  }

  /** The owner tab, or admin. */
  async clear(caller: ICaller, id: unknown): Promise<IWatch> {
    if (!isWatchId(id)) throw new WatchError('watch-not-found', `no watch ${String(id)}`);
    return this.deps.mutate(async (state) => {
      const w = state.watches.find((x) => x.id === id);
      if (!w) throw new WatchError('watch-not-found', `no watch ${id}`);
      if (!caller.admin && !(caller.workspaceId === w.workspaceId && caller.tabId === w.tabId)) {
        throw new WatchError('forbidden', `watch ${id} belongs to ${w.workspaceId}/${w.tabId}; only that tab or admin clears it`);
      }
      return { state: { watches: state.watches.filter((x) => x !== w) }, value: w };
    });
  }
}

// ─── runtime ──────────────────────────────────────────────────────────────

/** The runtime wiring; exported so a test can drive the real `onFired` link (review r1, R7). */
export const defaultWatchDeps = async (): Promise<IWatchDeps> => {
  const [leaseStore, tabLifecycle, inboxStore] = await Promise.all([
    import('@/lib/lease-store'),
    import('@/lib/tab-lifecycle'),
    import('@/lib/inbox-store'),
  ]);
  return {
    now: () => Date.now(),
    newId: newWatchId,
    runGh: runGhDefault,
    // Free means an acquire by another tab would succeed: no unexpired record. A dead holder is
    // released by the lease sweeper, which fires the release event (review round 1: holder state
    // `admin`, `agent-gone` or `closed` still refuses every other acquire).
    leaseFree: async (name) =>
      !leaseStore.pruneExpired(await leaseStore.readLeaseState(), Date.now()).state.leases.some((l) => l.name === name),
    liveTabs: tabLifecycle.readLiveTabs,
    enqueue: inboxStore.enqueueNotice,
    ssoToken: (profile, now) => readSsoToken(profile, now),
    ssoProfile: (profile) => findSsoProfile(profile),
    tabHost: async (workspaceId, tabId) => {
      const { collectAllTabs, readLayoutFile, resolveLayoutFile } = await import('@/lib/layout-store');
      const layout = await readLayoutFile(resolveLayoutFile(workspaceId));
      const tab = layout ? collectAllTabs(layout.root).find((t) => t.id === tabId) : undefined;
      return tab ? { known: true, host: tab.host ?? null } : { known: false };
    },
    hostName: () => os.hostname(),
    onFired: async (watch, fields) => {
      if (watch.kind === 'auth') {
        // The notice is out: a ledger that cannot be written must not send it twice.
        try {
          const [{ clearAuthWaits }, { getLedgerStore }] = await Promise.all([import('@/lib/auth-waits'), import('@/lib/ledger-store')]);
          const cleared = clearAuthWaits(getLedgerStore(), watch, Date.now());
          if (cleared.length) log.info({ watchId: watch.id, cleared }, 'deploy-auth waits cleared by a signed-in watch');
        } catch (err) {
          log.warn(`watch ${watch.id}: deploy-auth waits not cleared: ${err instanceof Error ? err.message : err}`);
        }
        return;
      }
      const { getPortfolioStore } = await import('@/lib/portfolio-store');
      getPortfolioStore().clearByWatch(watch, fields);
    },
    read: readWatches,
    mutate: mutateWatches,
  };
};

interface IWatchRuntime {
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: Array<() => void>;
}

const g = globalThis as unknown as { __ptWatchRuntime?: IWatchRuntime; __ptWatchManager?: WatchManager };

export const getWatchManager = async (): Promise<WatchManager> => {
  if (!g.__ptWatchManager) g.__ptWatchManager = new WatchManager(await defaultWatchDeps());
  return g.__ptWatchManager;
};

/**
 * Its own timer, not a slot in StatusManager.poll: a GitHub read may take 20 s, and the status
 * poll awaits each step, so 60 watches there would stall tab status for minutes.
 */
export const startWatches = async (options: { tickMs?: number } = {}): Promise<void> => {
  if (g.__ptWatchRuntime) return;
  const runtime: IWatchRuntime = { timer: null, unsubscribe: [] };
  g.__ptWatchRuntime = runtime;
  const manager = await getWatchManager();
  const [{ onLeaseReleased }, { onTabClosed }] = await Promise.all([import('@/lib/lease-store'), import('@/lib/tab-lifecycle')]);
  if (g.__ptWatchRuntime !== runtime) return;
  const tick = (onlyLease?: string) => {
    manager.tick(onlyLease).catch((err) => log.warn(`watch tick failed: ${err instanceof Error ? err.message : err}`));
  };
  runtime.unsubscribe.push(onLeaseReleased((lease) => tick(lease.name)));
  runtime.unsubscribe.push(onTabClosed(({ workspaceId, tabId }) => {
    manager.removeTab(workspaceId, tabId).then((n) => {
      if (n) log.info({ tabId, removed: n }, 'watches removed with their tab');
    }).catch((err) => log.warn(`watch removal failed for ${tabId}: ${err instanceof Error ? err.message : err}`));
  }));
  await manager.hydrate().then((n) => {
    if (n) log.info({ removed: n }, 'watch boot pass: owner tabs closed while down');
  }).catch((err) => log.warn(`watch boot pass skipped: ${err instanceof Error ? err.message : err}`));
  if (g.__ptWatchRuntime !== runtime) return;
  const timer = setInterval(() => tick(), options.tickMs ?? WATCH_TICK_MS);
  timer.unref?.();
  runtime.timer = timer;
  tick();
};

export const stopWatches = async (): Promise<void> => {
  const runtime = g.__ptWatchRuntime;
  if (!runtime) return;
  g.__ptWatchRuntime = undefined;
  if (runtime.timer) clearInterval(runtime.timer);
  for (const off of runtime.unsubscribe) off();
};
