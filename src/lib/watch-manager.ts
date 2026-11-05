import { execFile } from 'child_process';
import os from 'os';
import { SsoConfigError, findSsoProfile, readSsoToken, type TSsoTokenState } from '@/lib/aws-sso-cache';
import type { ICaller } from '@/lib/caller';
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
export const GH_TIMEOUT_MS = 20_000;

export type TGhResult = { ok: true; stdout: string } | { ok: false; code: TWatchFailure; message: string };

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
  | { type: 'wait' }
  | { type: 'fail'; code: TWatchFailure; message: string };

/** Classify a failed `gh` run into a server token; the raw text is kept for `watch list` only. */
export const classifyGhError = (err: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }, stderr: string): TWatchFailure => {
  if (err.code === 'ENOENT') return 'gh-missing';
  // A reply larger than maxBuffer also kills the child; it is not a timeout.
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'other';
  if (err.killed || err.signal === 'SIGTERM') return 'timeout';
  if (/HTTP 404/.test(stderr)) return 'http-404';
  if (/HTTP 401|gh auth login|authentication/i.test(stderr)) return 'auth';
  if (/HTTP 403/.test(stderr)) return 'http-403';
  return 'other';
};

export const runGhDefault = (args: string[]): Promise<TGhResult> =>
  new Promise((resolve) => {
    execFile('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, stdout });
      const message = `${String(stderr || err.message).trim().split('\n')[0]}`.slice(0, 300);
      resolve({ ok: false, code: classifyGhError(err as never, String(stderr ?? '')), message });
    });
  });

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

  private async gh(args: string[]): Promise<TGhResult> {
    return this.deps.runGh(args);
  }

  private async pull(target: string): Promise<{ ok: true; merged: boolean; state: string; head: string } | Extract<TGhResult, { ok: false }>> {
    const pr = parsePr(target)!;
    const r = await this.gh(['api', `repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`]);
    if (!r.ok) return r;
    try {
      const body = JSON.parse(r.stdout) as { merged?: unknown; state?: unknown; head?: { sha?: unknown } };
      const head = body.head?.sha;
      if (typeof head !== 'string' || !SHA.test(head)) return { ok: false, code: 'other', message: 'the pull request has no head sha' };
      return { ok: true, merged: body.merged === true, state: String(body.state), head };
    } catch {
      return { ok: false, code: 'other', message: 'gh api returned a body that is not JSON' };
    }
  }

  private async refSha(target: string): Promise<{ ok: true; sha: string } | Extract<TGhResult, { ok: false }>> {
    const ref = parseRef(target)!;
    const r = await this.gh(['api', `repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.ref)}`, '--jq', '.sha']);
    if (!r.ok) return r;
    const sha = r.stdout.trim();
    return SHA.test(sha) ? { ok: true, sha } : { ok: false, code: 'other', message: 'gh api returned no commit sha' };
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
    if (w.kind === 'ref') {
      const r = await this.refSha(w.target);
      if (!r.ok) return { type: 'fail', code: r.code, message: r.message };
      return r.sha !== w.baseline ? { type: 'fire', fields: { notice: 'moved', fromSha: w.baseline!, sha: r.sha } } : { type: 'wait' };
    }
    const p = await this.pull(w.target);
    if (!p.ok) return { type: 'fail', code: p.code, message: p.message };
    // A PR closed without a merge will never satisfy `merged`: say so rather than wait for expiry
    // (review round 1; the abandoned-blocker half of pft-1385).
    if (w.until === 'merged') {
      if (p.merged) return { type: 'fire', fields: { notice: 'merged', sha: p.head } };
      return p.state === 'closed' ? { type: 'fire', fields: { notice: 'closed', sha: p.head } } : { type: 'wait' };
    }
    if (w.until === 'closed') {
      if (p.state !== 'closed') return { type: 'wait' };
      return { type: 'fire', fields: { notice: p.merged ? 'merged' : 'closed', sha: p.head } };
    }
    if (w.until === 'head-moved') {
      return p.head !== w.baseline ? { type: 'fire', fields: { notice: 'head-moved', fromSha: w.baseline!, sha: p.head } } : { type: 'wait' };
    }
    const pr = parsePr(w.target)!;
    const base = `repos/${pr.owner}/${pr.repo}/commits/${p.head}`;
    const runs = await this.gh(['api', '--paginate', `${base}/check-runs?per_page=100`, '--jq', '.check_runs[] | [.status, (.conclusion // "")] | @tsv']);
    if (!runs.ok) return { type: 'fail', code: runs.code, message: runs.message };
    const statuses = await this.gh(['api', `${base}/status`, '--jq', '.statuses[] | .state']);
    if (!statuses.ok) return { type: 'fail', code: statuses.code, message: statuses.message };
    const c = settleChecks(runs.stdout, statuses.stdout);
    const successful = runs.stdout.split('\n').filter((line) => line === 'completed\tsuccess').length
      + statuses.stdout.split('\n').filter((state) => state === 'success').length;
    const current = await this.pull(w.target);
    if (!current.ok) return { type: 'fail', code: current.code, message: current.message };
    if (current.head !== p.head) return { type: 'wait' };
    return c.settled ? { type: 'fire', fields: { notice: 'checks-settled', sha: p.head, green: c.green, red: c.red, successful } } : { type: 'wait' };
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
        const current = await this.pull(w.target);
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
      return replace({ ...w, lastCheckedAt: now, failures: 0, failingNotified: false, lastError: w.kind === 'lease' ? w.lastError : null });
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

  /** The baseline sha, and whether the creation read already shows a PR merged or closed. */
  private async baseline(spec: IWatchSpec): Promise<{ sha: string | null; holds: boolean }> {
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
    const r = spec.kind === 'pr' ? await this.pull(spec.target) : await this.refSha(spec.target);
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
    const baseline = await this.baseline(spec);
    const watch = createWatch(spec, owner, baseline.sha, this.deps.now(), this.deps.newId(), baseline.holds);
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
