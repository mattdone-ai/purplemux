/**
 * Fleet-wide provider outage mode (PMUX-REMOTE-RESILIENCE fix 2). When `threshold` distinct tabs fail with one
 * failure key inside `windowMs`, the key is in outage: every tab that fails with it is held — no automatic
 * resume, no per-tab escalation — and the caller raises ONE alert at the start. A clean turn of a matching
 * provider (and host, for an auth key) that ended after the outage's last failure ends it and hands back the
 * held tabs. The same key in outage again within `realertMs` of its end is the same incident: it holds, but
 * raises no second alert.
 *
 * So that a fleet whose every tab is held still learns of the recovery, a non-auth outage offers one canary at
 * a time: after `quietMs` with no new failure, the longest-held tab is owed one probe resume. A canary that
 * fails again is a new failure, which restarts the quiet clock and doubles it, up to `maxQuietMs`; one that
 * ends cleanly is the recovery; one with no answer after `canaryTimeoutMs` frees the slot. An auth outage
 * offers none: a resume into a refused account fails the same way, and the person who signs it in again ends
 * the outage with their own next turn.
 */

export type TOutageClass = 'api-error' | 'rate-limit' | 'auth-failure';

export interface IFailureKey {
  cls: TOutageClass;
  provider: string;
  /** The tab's host; null for a local tab. Part of the key for an auth failure only: credentials are per host. */
  host: string | null;
  code: string;
}

export const failureKeyId = (key: IFailureKey): string => (key.cls === 'auth-failure'
  ? `auth-failure|${key.provider}|${key.host ?? 'local'}`
  : `${key.cls}|${key.provider}|${key.code}`);

/** The keys a clean turn of `provider` on `host` proves answered again. */
const recoversKey = (key: IFailureKey, provider: string, host: string | null): boolean =>
  key.provider === provider && (key.cls !== 'auth-failure' || (key.host ?? null) === (host ?? null));

export interface IProviderOutageOptions {
  threshold: number;
  windowMs: number;
  quietMs: number;
  maxQuietMs: number;
  now: () => number;
  realertMs?: number;
  canaryTimeoutMs?: number;
}

export const OUTAGE_THRESHOLD = 3;
export const OUTAGE_WINDOW_MS = 10 * 60_000;
export const OUTAGE_QUIET_MS = 5 * 60_000;
export const OUTAGE_MAX_QUIET_MS = 60 * 60_000;
export const OUTAGE_REALERT_MS = 30 * 60_000;
export const OUTAGE_CANARY_TIMEOUT_MS = 30 * 60_000;

interface IOutage {
  key: IFailureKey;
  since: number;
  lastFailureAt: number;
  quietMs: number;
  /** Tab → when it was first held; insertion order is the canary order. */
  held: Map<string, number>;
  canaryTabId: string | null;
  canaryAt: number;
}

export interface IFailureVerdict {
  /** The key is in outage: hold this tab. */
  active: boolean;
  /** This failure crossed the threshold: the outage starts now. */
  started: boolean;
  /** Raise the one alert: a start that is not the same key again within `realertMs` of its last end. */
  alert: boolean;
  /** Every tab held by the outage, in the order they failed (on a start: the tabs to withdraw resumes from). */
  held: string[];
}

export interface IRecovered {
  key: IFailureKey;
  id: string;
  held: string[];
  durationMs: number;
}

export class ProviderOutageTracker {
  private readonly failures = new Map<string, Map<string, number>>();
  private readonly keys = new Map<string, IFailureKey>();
  private readonly outages = new Map<string, IOutage>();
  private readonly endedAt = new Map<string, number>();

  constructor(private readonly opts: IProviderOutageOptions = {
    threshold: OUTAGE_THRESHOLD,
    windowMs: OUTAGE_WINDOW_MS,
    quietMs: OUTAGE_QUIET_MS,
    maxQuietMs: OUTAGE_MAX_QUIET_MS,
    now: () => Date.now(),
  }) {}

  private get realertMs(): number {
    return this.opts.realertMs ?? OUTAGE_REALERT_MS;
  }

  private get canaryTimeoutMs(): number {
    return this.opts.canaryTimeoutMs ?? OUTAGE_CANARY_TIMEOUT_MS;
  }

  record(key: IFailureKey, tabId: string): IFailureVerdict {
    const id = failureKeyId(key);
    const now = this.opts.now();
    this.keys.set(id, key);
    const outage = this.outages.get(id);
    if (outage) {
      if (!outage.held.has(tabId)) outage.held.set(tabId, now);
      outage.lastFailureAt = now;
      if (outage.canaryTabId === tabId) {
        outage.canaryTabId = null;
        outage.quietMs = Math.min(outage.quietMs * 2, this.opts.maxQuietMs);
      }
      return { active: true, started: false, alert: false, held: [...outage.held.keys()] };
    }
    const seen = this.failures.get(id) ?? new Map<string, number>();
    for (const [tab, at] of seen) if (now - at > this.opts.windowMs) seen.delete(tab);
    seen.set(tabId, now);
    this.failures.set(id, seen);
    if (seen.size < this.opts.threshold) return { active: false, started: false, alert: false, held: [] };
    const held = new Map([...seen.entries()].sort((a, b) => a[1] - b[1]));
    this.outages.set(id, { key, since: now, lastFailureAt: now, quietMs: this.opts.quietMs, held, canaryTabId: null, canaryAt: 0 });
    this.failures.delete(id);
    const lastEnd = this.endedAt.get(id);
    return { active: true, started: true, alert: lastEnd === undefined || now - lastEnd > this.realertMs, held: [...held.keys()] };
  }

  isHeld(tabId: string): boolean {
    for (const outage of this.outages.values()) if (outage.held.has(tabId)) return true;
    return false;
  }

  activeOutages(): Array<{ id: string; key: IFailureKey; since: number; held: string[] }> {
    return [...this.outages.entries()].map(([id, o]) => ({ id, key: o.key, since: o.since, held: [...o.held.keys()] }));
  }

  /**
   * A clean turn of `provider` on `host`, whose last entry is dated `cleanAt`: the outages it ends, each with the
   * tabs it held. A turn that ended before an outage's last failure proves nothing about it. Clears their window too.
   */
  recover(provider: string, host: string | null, cleanAt: number = this.opts.now()): IRecovered[] {
    const now = this.opts.now();
    const ended: IRecovered[] = [];
    for (const [id, outage] of this.outages) {
      if (!recoversKey(outage.key, provider, host) || cleanAt < outage.lastFailureAt) continue;
      this.outages.delete(id);
      this.endedAt.set(id, now);
      ended.push({ key: outage.key, id, held: [...outage.held.keys()], durationMs: now - outage.since });
    }
    for (const id of this.failures.keys()) {
      const key = this.keys.get(id);
      if (key && recoversKey(key, provider, host)) this.failures.delete(id);
    }
    return ended;
  }

  /** The canaries due now: per outage at most one, the longest-held tab, once its quiet period has passed. */
  dueCanaries(): Array<{ id: string; tabId: string }> {
    const now = this.opts.now();
    const due: Array<{ id: string; tabId: string }> = [];
    for (const [id, outage] of this.outages) {
      if (outage.key.cls === 'auth-failure') continue;
      // A canary that never answered (delivered, no stop since) frees its slot after the timeout.
      if (outage.canaryTabId !== null && now - outage.canaryAt >= this.canaryTimeoutMs) {
        outage.canaryTabId = null;
        outage.lastFailureAt = now;
      }
      if (outage.canaryTabId !== null || now - outage.lastFailureAt < outage.quietMs) continue;
      const tabId = outage.held.keys().next().value;
      if (tabId === undefined) continue;
      outage.canaryTabId = tabId;
      outage.canaryAt = now;
      // The canary goes to the back of the line: a second canary probes another tab.
      outage.held.delete(tabId);
      outage.held.set(tabId, now);
      due.push({ id, tabId });
    }
    return due;
  }

  /** The canary of `tabId` could not go out: the outage may offer the next one after a new quiet period. */
  canaryFailed(id: string, tabId: string): void {
    const outage = this.outages.get(id);
    if (!outage || outage.canaryTabId !== tabId) return;
    outage.canaryTabId = null;
    outage.lastFailureAt = this.opts.now();
  }

  isCanary(id: string, tabId: string): boolean {
    return this.outages.get(id)?.canaryTabId === tabId;
  }

  /** The tab left (closed, exited, ended its episode): it is held by nothing and counts toward no window. */
  forget(tabId: string): void {
    for (const [id, outage] of this.outages) {
      outage.held.delete(tabId);
      if (outage.canaryTabId === tabId) outage.canaryTabId = null;
      if (outage.held.size === 0) this.outages.delete(id);
    }
    for (const [id, seen] of this.failures) {
      seen.delete(tabId);
      if (seen.size === 0) this.failures.delete(id);
    }
  }
}
