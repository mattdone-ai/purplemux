import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { BREAK_REASON_MAX, codePoints } from '@/lib/human-actions';
import { LeasePolicyError, parseLeaseName, policyFor, resolveEpic, resolveNote, resolveTtl } from '@/lib/lease-policy';
import type { ICaller } from '@/lib/caller';
import type {
  ILease,
  ILeaseHolder,
  ILeaseHumanBreaker,
  ILeaseState,
  ILeaseView,
  THolderState,
  TLeaseErrorCode,
  TLeaseReleaseReason,
} from '@/types/lease';

const log = createLogger('lease-store');

export class LeaseError extends Error {
  constructor(
    readonly code: TLeaseErrorCode,
    message: string,
    readonly lease: ILease | null = null,
  ) {
    super(message);
  }
}

export interface IReleasedLease {
  lease: ILease;
  reason: TLeaseReleaseReason;
}

// ─── pure state transitions ──────────────────────────────────────────────

const iso = (ms: number): string => new Date(ms).toISOString();

export const sameHolder = (a: ILeaseHolder, b: ILeaseHolder): boolean => {
  if (a.admin || b.admin) return a.admin && b.admin;
  return a.tabId !== null && a.tabId === b.tabId && a.workspaceId === b.workspaceId;
};

export const holderLabel = (h: ILeaseHolder): string =>
  h.admin ? 'admin' : `${h.workspaceId ?? '?'}/${h.tabId ?? 'no-tab'}${h.tabName ? ` (${h.tabName})` : ''}${h.verified ? '' : h.identity === 'hook' ? ' hook-identity' : ' unverified'}`;

const ageLabel = (lease: ILease, now: number): string => {
  const s = Math.max(0, Math.round((now - Date.parse(lease.acquiredAt)) / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
};

const heldError = (lease: ILease, now: number): LeaseError =>
  new LeaseError('lease-held', `${lease.name} is held by ${holderLabel(lease.holder)} for ${ageLabel(lease, now)}`, lease);

export interface IAcquireRequest {
  name: string;
  kind: string;
  resource: string;
  holder: ILeaseHolder;
  ttlSeconds: number | null;
  epic: string | null;
  note: string | null;
}

const expiryOf = (ttlSeconds: number | null, now: number): string | null =>
  ttlSeconds === null ? null : iso(now + ttlSeconds * 1000);

export const acquireInState = (
  state: ILeaseState,
  req: IAcquireRequest,
  now: number,
): { state: ILeaseState; lease: ILease; outcome: 'acquired' | 'renewed' } => {
  const existing = state.leases.find((l) => l.name === req.name);
  if (existing) {
    if (!sameHolder(existing.holder, req.holder)) throw heldError(existing, now);
    const lease: ILease = {
      ...existing,
      // The latest proof counts: an unverified renew does not keep an earlier verified flag.
      holder: { ...existing.holder, tabName: req.holder.tabName ?? existing.holder.tabName, verified: req.holder.verified, identity: req.holder.identity },
      epic: req.epic ?? existing.epic,
      note: req.note ?? existing.note,
      renewedAt: iso(now),
      ttlSeconds: req.ttlSeconds,
      expiresAt: expiryOf(req.ttlSeconds, now),
    };
    return { state: { leases: state.leases.map((l) => (l === existing ? lease : l)) }, lease, outcome: 'renewed' };
  }
  const lease: ILease = {
    name: req.name,
    kind: req.kind,
    resource: req.resource,
    holder: req.holder,
    epic: req.epic,
    note: req.note,
    acquiredAt: iso(now),
    renewedAt: iso(now),
    ttlSeconds: req.ttlSeconds,
    expiresAt: expiryOf(req.ttlSeconds, now),
    survivesTab: policyFor(req.kind).survivesTab,
  };
  return { state: { leases: [...state.leases, lease] }, lease, outcome: 'acquired' };
};

const findHeld = (state: ILeaseState, name: string, holder: ILeaseHolder, now: number): ILease => {
  const lease = state.leases.find((l) => l.name === name);
  if (!lease) throw new LeaseError('lease-not-found', `no lease named ${name}`);
  if (!sameHolder(lease.holder, holder)) {
    throw new LeaseError('lease-held-by-other', `${name} is held by ${holderLabel(lease.holder)} for ${ageLabel(lease, now)}`, lease);
  }
  return lease;
};

/** `ttlSeconds` undefined keeps the lease's own TTL. */
export const renewInState = (
  state: ILeaseState,
  name: string,
  holder: ILeaseHolder,
  ttlSeconds: number | null,
  now: number,
): { state: ILeaseState; lease: ILease } => {
  const existing = findHeld(state, name, holder, now);
  const lease: ILease = { ...existing, renewedAt: iso(now), ttlSeconds, expiresAt: expiryOf(ttlSeconds, now) };
  return { state: { leases: state.leases.map((l) => (l === existing ? lease : l)) }, lease };
};

export const releaseInState = (
  state: ILeaseState,
  name: string,
  holder: ILeaseHolder,
  now: number,
): { state: ILeaseState; lease: ILease } => {
  const lease = findHeld(state, name, holder, now);
  return { state: { leases: state.leases.filter((l) => l !== lease) }, lease };
};

export const removeInState = (state: ILeaseState, name: string): { state: ILeaseState; lease: ILease } => {
  const lease = state.leases.find((l) => l.name === name);
  if (!lease) throw new LeaseError('lease-not-found', `no lease named ${name}`);
  return { state: { leases: state.leases.filter((l) => l !== lease) }, lease };
};

/** The survives-tab claims of an epic (optionally one kind). */
export const epicClaims = (state: ILeaseState, epic: string, kind?: string): ILease[] =>
  state.leases.filter((l) => l.survivesTab && l.epic === epic && (!kind || l.kind === kind));

export interface ISweepFacts {
  /** Taken before the tab facts were gathered. */
  now: number;
  liveTabIds: ReadonlySet<string>;
  /** Workspaces whose layout could not be read: their tabs are unknown, never gone. */
  uncertainWorkspaceIds?: ReadonlySet<string>;
  /** True when the holder tab's agent has been inactive past the grace. */
  agentGone: (tabId: string) => boolean;
}

/** Pure: leases past their expiry leave the state before any operation looks at it. */
export const pruneExpired = (state: ILeaseState, now: number): { state: ILeaseState; expired: ILease[] } => {
  const expired = state.leases.filter((l) => l.expiresAt !== null && Date.parse(l.expiresAt) <= now);
  return expired.length ? { state: { leases: state.leases.filter((l) => !expired.includes(l)) }, expired } : { state, expired };
};

/**
 * Pure: which leases a sweep ends. Expiry applies to every lease. Only a
 * tab-bound lease with a holder tab dies with the tab or its agent; a
 * survives-tab lease and an admin lease end only by TTL or release.
 */
export const sweepState = (state: ILeaseState, facts: ISweepFacts): { state: ILeaseState; released: IReleasedLease[] } => {
  const released: IReleasedLease[] = [];
  const kept: ILease[] = [];
  for (const lease of state.leases) {
    const tabId = lease.holder.tabId;
    let reason: TLeaseReleaseReason | null = null;
    if (lease.expiresAt !== null && Date.parse(lease.expiresAt) <= facts.now) reason = 'expired';
    // A lease renewed after the facts were taken is judged by the next sweep:
    // its tab may have been created after the tab list was read.
    else if (!lease.survivesTab && tabId && !lease.holder.admin && Date.parse(lease.renewedAt) <= facts.now) {
      const uncertain = lease.holder.workspaceId !== null && !!facts.uncertainWorkspaceIds?.has(lease.holder.workspaceId);
      if (!facts.liveTabIds.has(tabId)) reason = uncertain ? null : 'holder-tab-gone';
      else if (facts.agentGone(tabId)) reason = 'holder-agent-gone';
    }
    if (reason) released.push({ lease, reason });
    else kept.push(lease);
  }
  return { state: { leases: kept }, released };
};

export const releaseTabInState = (state: ILeaseState, tabId: string): { state: ILeaseState; released: ILease[] } => {
  const released = state.leases.filter((l) => !l.survivesTab && !l.holder.admin && l.holder.tabId === tabId);
  return { state: { leases: state.leases.filter((l) => !released.includes(l)) }, released };
};

export interface IViewFacts {
  now: number;
  liveTabIds: ReadonlySet<string>;
  /** As in the sweep: a holder in an unreadable workspace is unknown, never shown closed. */
  uncertainWorkspaceIds?: ReadonlySet<string>;
  /** Currently inactive agent (no grace): what a reader should see now. */
  agentInactive: (tabId: string) => boolean;
  workspaceName: (workspaceId: string) => string | null;
}

export const holderStateOf = (lease: ILease, facts: IViewFacts): THolderState => {
  if (lease.holder.admin) return 'admin';
  const tabId = lease.holder.tabId;
  if (!tabId) return 'live';
  if (!facts.liveTabIds.has(tabId)) {
    return lease.holder.workspaceId !== null && facts.uncertainWorkspaceIds?.has(lease.holder.workspaceId) ? 'live' : 'closed';
  }
  return facts.agentInactive(tabId) ? 'agent-gone' : 'live';
};

export const toLeaseView = (lease: ILease, facts: IViewFacts): ILeaseView => ({
  ...lease,
  holder: { ...lease.holder, workspaceName: lease.holder.workspaceId ? facts.workspaceName(lease.holder.workspaceId) : null },
  ageSeconds: Math.max(0, Math.floor((facts.now - Date.parse(lease.acquiredAt)) / 1000)),
  expiresInSeconds: lease.expiresAt === null ? null : Math.max(0, Math.floor((Date.parse(lease.expiresAt) - facts.now) / 1000)),
  holderState: holderStateOf(lease, facts),
});

// ─── file store ──────────────────────────────────────────────────────────

type TLeaseEffect =
  | { type: 'acquired'; lease: ILease; outcome: 'acquired' | 'renewed' }
  | { type: 'released'; lease: ILease; reason: TLeaseReleaseReason; by: ILeaseHolder | ILeaseHumanBreaker | null; extra?: Record<string, unknown> };

const g = globalThis as unknown as {
  __ptLeaseLock?: Promise<void>;
  __ptLeaseListeners?: { acquired: Set<TLeaseAcquiredListener>; released: Set<TLeaseReleasedListener> };
};
if (!g.__ptLeaseLock) g.__ptLeaseLock = Promise.resolve();
if (!g.__ptLeaseListeners) g.__ptLeaseListeners = { acquired: new Set(), released: new Set() };

export const leasesFile = (): string => path.join(os.homedir(), '.purplemux', 'leases.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptLeaseLock!;
  g.__ptLeaseLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isLease = (value: unknown): value is ILease => {
  if (!value || typeof value !== 'object') return false;
  const l = value as Record<string, unknown>;
  return typeof l.name === 'string' && typeof l.kind === 'string' && typeof l.acquiredAt === 'string'
    && typeof l.renewedAt === 'string' && !!l.holder && typeof l.holder === 'object';
};

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

const isStrictLease = (value: unknown): value is ILease => {
  if (!value || typeof value !== 'object') return false;
  const lease = value as Record<string, unknown>;
  if (typeof lease.name !== 'string' || typeof lease.kind !== 'string' || typeof lease.resource !== 'string') return false;
  try {
    const parsed = parseLeaseName(lease.name);
    if (parsed.name !== lease.name || parsed.kind !== lease.kind || parsed.resource !== lease.resource) return false;
  } catch {
    return false;
  }
  if (!lease.holder || typeof lease.holder !== 'object') return false;
  const holder = lease.holder as Record<string, unknown>;
  const identity = holder.identity;
  const validIdentity = identity === undefined || identity === 'launch' || identity === 'hook'
    || identity === 'session' || identity === 'none';
  const acquiredAt = typeof lease.acquiredAt === 'string' ? Date.parse(lease.acquiredAt) : Number.NaN;
  const renewedAt = typeof lease.renewedAt === 'string' ? Date.parse(lease.renewedAt) : Number.NaN;
  const expiresAt = typeof lease.expiresAt === 'string' ? Date.parse(lease.expiresAt) : Number.NaN;
  const ttlValid = lease.ttlSeconds === null
    || (Number.isSafeInteger(lease.ttlSeconds) && (lease.ttlSeconds as number) > 0);
  return isNullableString(holder.workspaceId)
    && isNullableString(holder.tabId)
    && isNullableString(holder.tabName)
    && typeof holder.verified === 'boolean'
    && typeof holder.admin === 'boolean'
    && validIdentity
    && isNullableString(lease.epic)
    && isNullableString(lease.note)
    && Number.isFinite(acquiredAt)
    && Number.isFinite(renewedAt)
    && ttlValid
    && (lease.expiresAt === null || Number.isFinite(expiresAt))
    && ((lease.ttlSeconds === null) === (lease.expiresAt === null))
    && typeof lease.survivesTab === 'boolean';
};

export class LeaseFileError extends Error {
  readonly code = 'lease-store-unreadable' as const;
}

/**
 * Absent file = no leases. Anything else that is not `{ leases: [...] }` is
 * refused rather than read as empty: an empty read would hand every held
 * resource to the next caller.
 */
export const readLeaseState = async (): Promise<ILeaseState> => {
  const file = leasesFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { leases: [] };
    throw new LeaseFileError(`${file} unreadable: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new LeaseFileError(`${file} is not valid JSON (${err instanceof Error ? err.message : err}); leases are refused until it is repaired or moved aside`);
  }
  const leases = (parsed as { leases?: unknown } | null)?.leases;
  if (!Array.isArray(leases)) throw new LeaseFileError(`${file} has no "leases" array; leases are refused until it is repaired or moved aside`);
  return { leases: leases.filter(isLease) };
};

const writeLeaseState = async (state: ILeaseState): Promise<void> => {
  const file = leasesFile();
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

// ─── hooks ───────────────────────────────────────────────────────────────

export type TLeaseAcquiredListener = (lease: ILease, outcome: 'acquired' | 'renewed') => void;
export type TLeaseReleasedListener = (lease: ILease, reason: TLeaseReleaseReason) => void;

export const onLeaseAcquired = (listener: TLeaseAcquiredListener): (() => void) => {
  g.__ptLeaseListeners!.acquired.add(listener);
  return () => { g.__ptLeaseListeners!.acquired.delete(listener); };
};

export const onLeaseReleased = (listener: TLeaseReleasedListener): (() => void) => {
  g.__ptLeaseListeners!.released.add(listener);
  return () => { g.__ptLeaseListeners!.released.delete(listener); };
};

const notify = <A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A): void => {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch (err) {
      log.warn(`lease listener failed: ${err instanceof Error ? err.message : err}`);
    }
  }
};

const auditHolder = (h: ILeaseHolder) => ({ workspaceId: h.workspaceId, tabId: h.tabId, verified: h.verified, identity: h.identity, admin: h.admin });

const auditBreaker = (by: ILeaseHolder | ILeaseHumanBreaker) => ('human' in by ? { human: by.human } : auditHolder(by));

/** Runs inside the lock, so audit lines and hooks follow the order of the mutations. */
const applyEffects = async (effects: TLeaseEffect[]): Promise<void> => {
  for (const effect of effects) {
    if (effect.type === 'acquired') {
      const { lease, outcome } = effect;
      await appendCoordinationAudit({
        event: outcome === 'acquired' ? 'lease-acquire' : 'lease-renew',
        name: lease.name, holder: auditHolder(lease.holder), ttlSeconds: lease.ttlSeconds, epic: lease.epic,
      });
      notify(g.__ptLeaseListeners!.acquired, lease, outcome);
    } else {
      const { lease, reason, by, extra } = effect;
      await appendCoordinationAudit({
        event: 'lease-release', name: lease.name, reason, holder: auditHolder(lease.holder), by: by ? auditBreaker(by) : null, ...extra,
      });
      notify(g.__ptLeaseListeners!.released, lease, reason);
    }
  }
};

interface ITransaction<T> {
  state: ILeaseState;
  value: T;
  effects: TLeaseEffect[];
}

/**
 * Serialised read-modify-write. Expired leases are pruned first, in every
 * transaction, so an expired lease never refuses anyone between sweeps.
 * `fn` returns null to change nothing itself.
 */
const transact = <T>(
  now: number,
  fn: (state: ILeaseState) => ITransaction<T> | null,
  expiredExtra?: Record<string, unknown>,
): Promise<{ value: T | null; expired: ILease[] }> =>
  withLock(async () => {
    const pruned = pruneExpired(await readLeaseState(), now);
    const expiredEffects: TLeaseEffect[] = pruned.expired.map((lease) => ({ type: 'released', lease, reason: 'expired', by: null, extra: expiredExtra }));
    const result = fn(pruned.state);
    if (result || pruned.expired.length) await writeLeaseState(result ? result.state : pruned.state);
    await applyEffects([...expiredEffects, ...(result?.effects ?? [])]);
    return { value: result ? result.value : null, expired: pruned.expired };
  });

// ─── operations ──────────────────────────────────────────────────────────

export interface ILeaseAuthority {
  now: () => number;
  /** The workspace's orchestration is enabled and names this tab. */
  isWorkspaceOrchestrator: (workspaceId: string, tabId: string) => Promise<boolean>;
}

export const holderFromCaller = (caller: ICaller): ILeaseHolder => ({
  workspaceId: caller.admin ? null : caller.workspaceId,
  tabId: caller.admin ? null : caller.tabId,
  tabName: caller.admin ? null : caller.tabName,
  verified: caller.admin ? false : caller.verified,
  identity: caller.admin ? 'none' : caller.identity,
  admin: caller.admin,
});

/**
 * A lease holder is a tab or the admin token. A workspace token that names no
 * tab could take a lease it could never renew or release, and no tab event
 * would ever end it.
 */
const requireHolder = (holder: ILeaseHolder): void => {
  if (holder.admin) return;
  if (!holder.tabId || !holder.workspaceId) {
    throw new LeaseError('caller-unresolved', 'the caller names no tab: run the command from a purplemux tab (PMUX_TAB_TOKEN, or PMUX_TOKEN with X-Pmux-Session)');
  }
};

export interface IAcquireInput {
  name: unknown;
  ttlSeconds?: number | null;
  epic?: unknown;
  note?: unknown;
}

export const acquireLease = async (
  input: IAcquireInput,
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
): Promise<{ lease: ILease; outcome: 'acquired' | 'renewed' }> => {
  requireHolder(holder);
  const { name, kind, resource } = parseLeaseName(input.name);
  const requestedTtl = input.ttlSeconds === undefined ? undefined : resolveTtl(kind, input.ttlSeconds, holder);
  const epic = resolveEpic(kind, input.epic);
  const note = resolveNote(input.note);
  if (policyFor(kind).orchestratorOnly && !holder.admin) {
    const allowed = await authority.isWorkspaceOrchestrator(holder.workspaceId!, holder.tabId!);
    // An authority refusal, not a malformed request: `forbidden` (exit 3), as for fleet config.
    if (!allowed) throw new LeaseError('forbidden', `${kind} leases need the admin token or the workspace's enabled orchestrator tab`);
  }
  const now = authority.now();
  const result = await transact(now, (state) => {
    const existing = state.leases.find((l) => l.name === name);
    // A renew without a TTL keeps the lease's own, as `renew` does.
    const ttlSeconds = requestedTtl !== undefined
      ? requestedTtl
      : existing && sameHolder(existing.holder, holder) ? existing.ttlSeconds : resolveTtl(kind, undefined, holder);
    const r = acquireInState(state, { name, kind, resource, holder, ttlSeconds, epic, note }, now);
    return { state: r.state, value: r, effects: [{ type: 'acquired', lease: r.lease, outcome: r.outcome }] };
  });
  return { lease: result.value!.lease, outcome: result.value!.outcome };
};

/**
 * Acquire a lease whose name is chosen from the state inside the lock (a pool
 * slot: the placement and the free slot number are read and taken in one
 * transaction, so two callers can never take the same slot). `choose` throws
 * to refuse; nothing is written then. `name: null` writes nothing and returns
 * no lease. `release` names leases of the same holder that leave in the same
 * transaction (a pool ticket that becomes its slot).
 */
export type TChosenLease<T> =
  | { name: string; ttlSeconds?: number; note?: string; release?: readonly string[]; value: T }
  | { name: null; value: T };

export const acquireChosenLease = async <T>(
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
  choose: (state: ILeaseState, now: number) => TChosenLease<T>,
): Promise<{ lease: ILease | null; value: T }> => {
  requireHolder(holder);
  const now = authority.now();
  let unwritten: { lease: null; value: T } | null = null;
  const result = await transact(now, (state) => {
    const chosen = choose(state, now);
    if (chosen.name === null) {
      unwritten = { lease: null, value: chosen.value };
      return null;
    }
    const { name, kind, resource } = parseLeaseName(chosen.name);
    if (policyFor(kind).orchestratorOnly) throw new LeaseError('forbidden', `${kind} leases cannot be chosen by placement`);
    const ttlSeconds = resolveTtl(kind, chosen.ttlSeconds, holder);
    let next = state;
    const effects: TLeaseEffect[] = [];
    for (const gone of chosen.release ?? []) {
      const r = releaseInState(next, gone, holder, now);
      next = r.state;
      effects.push({ type: 'released', lease: r.lease, reason: 'released', by: holder });
    }
    const r = acquireInState(next, { name, kind, resource, holder, ttlSeconds, epic: null, note: resolveNote(chosen.note) }, now);
    effects.push({ type: 'acquired', lease: r.lease, outcome: r.outcome });
    return { state: r.state, value: { lease: r.lease as ILease | null, value: chosen.value }, effects };
  });
  return unwritten ?? result.value!;
};

export const renewLease = async (
  rawName: unknown,
  ttlSeconds: number | null | undefined,
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
): Promise<ILease> => {
  requireHolder(holder);
  const { name, kind } = parseLeaseName(rawName);
  const requested = ttlSeconds === undefined ? undefined : resolveTtl(kind, ttlSeconds, holder);
  const now = authority.now();
  const lease = await transact(now, (state) => {
    const existing = findHeld(state, name, holder, now);
    const r = renewInState(state, name, holder, requested === undefined ? existing.ttlSeconds : requested, now);
    return { state: r.state, value: r.lease, effects: [{ type: 'acquired', lease: r.lease, outcome: 'renewed' }] };
  });
  return lease.value!;
};

export const releaseLease = async (rawName: unknown, holder: ILeaseHolder, authority: ILeaseAuthority): Promise<ILease> => {
  requireHolder(holder);
  const { name } = parseLeaseName(rawName);
  const lease = await transact(authority.now(), (state) => {
    const r = releaseInState(state, name, holder, authority.now());
    return { state: r.state, value: r.lease, effects: [{ type: 'released', lease: r.lease, reason: 'released', by: holder }] };
  });
  return lease.value!;
};

/**
 * The admin token, or a human session from Mission Control (ADR-0029 §8), with a reason; audited.
 * Cooperative for the admin: the admin token is readable by every agent (C-312 class).
 * The admin's reason is cut to 500 code points; a human's longer reason is refused.
 */
export const breakLease = async (
  rawName: unknown,
  reason: unknown,
  breaker: ILeaseHolder | ILeaseHumanBreaker,
  authority: ILeaseAuthority,
): Promise<ILease> => {
  const human = 'human' in breaker;
  if (human ? !breaker.human.trim() : !breaker.admin) throw new LeaseError('forbidden', 'breaking a lease needs the admin token');
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (!text) throw new LeasePolicyError('break needs a reason');
  if (human && codePoints(text) > BREAK_REASON_MAX) {
    throw new LeasePolicyError(`the reason is ${codePoints(text)} characters; the limit is ${BREAK_REASON_MAX}`);
  }
  const { name } = parseLeaseName(rawName);
  const lease = await transact(authority.now(), (state) => {
    const r = removeInState(state, name);
    return { state: r.state, value: r.lease, effects: [{ type: 'released', lease: r.lease, reason: 'broken', by: breaker, extra: { breakReason: [...text].slice(0, BREAK_REASON_MAX).join('') } }] };
  });
  return lease.value!;
};

const KIND = /^[a-z][a-z0-9-]{1,31}$/;

/**
 * Release an epic's survives-tab claims. The `epic:<slug>` holder and admin
 * release all of them; a tab of a workspace holding claims releases only its
 * own workspace's. Nothing to release is not a refusal.
 */
export const releaseEpicClaims = async (
  rawEpic: unknown,
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
  rawKind?: unknown,
): Promise<ILease[]> => {
  requireHolder(holder);
  const epic = resolveEpic('epic', rawEpic);
  if (!epic) throw new LeasePolicyError('release-epic needs an epic slug');
  let kind: string | undefined;
  if (rawKind !== undefined && rawKind !== null && rawKind !== '') {
    kind = typeof rawKind === 'string' ? rawKind.trim().toLowerCase() : '';
    if (!KIND.test(kind)) throw new LeasePolicyError(`kind "${String(rawKind)}" does not match ${KIND.source}`);
  }
  const released = await transact(authority.now(), (state) => {
    const claims = epicClaims(state, epic, kind);
    if (claims.length === 0) return null;
    const owner = state.leases.find((l) => l.name === `epic:${epic}`);
    const all = holder.admin || (!!owner && sameHolder(owner.holder, holder));
    const mine = all ? claims : claims.filter((c) => c.holder.workspaceId === holder.workspaceId);
    if (mine.length === 0) {
      throw new LeaseError('forbidden', `release-epic ${epic} needs the epic:${epic} holder, a tab of a workspace holding its claims, or the admin token`);
    }
    return {
      state: { leases: state.leases.filter((l) => !mine.includes(l)) },
      value: mine,
      effects: mine.map((lease): TLeaseEffect => ({ type: 'released', lease, reason: 'release-epic', by: holder, extra: { epic } })),
    };
  });
  return released.value ?? [];
};

const unexpired = (leases: ILease[], now: number): ILease[] =>
  leases.filter((l) => l.expiresAt === null || Date.parse(l.expiresAt) > now);

export type TLeaseEvidence =
  | { known: true; leases: ILease[] }
  | { known: false };

/** Strict read-only evidence for diagnostics; normal lease API compatibility is unchanged. */
export const readLeaseEvidence = async (now: number = Date.now()): Promise<TLeaseEvidence> => {
  try {
    const parsed = JSON.parse(await fs.readFile(leasesFile(), 'utf-8')) as { leases?: unknown } | null;
    if (!Array.isArray(parsed?.leases) || !parsed.leases.every(isStrictLease)) return { known: false };
    return { known: true, leases: unexpired(parsed.leases, now) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { known: true, leases: [] };
    return { known: false };
  }
};

export const listLeases = async (prefix?: string, now: number = Date.now()): Promise<ILease[]> => {
  const { leases } = await readLeaseState();
  const p = prefix?.trim().toLowerCase();
  const live = unexpired(leases, now);
  return (p ? live.filter((l) => l.name.startsWith(p)) : live).sort((a, b) => a.name.localeCompare(b.name));
};

/** Exact name only: a prefix match would also answer for `merge:x/y-z`. An expired lease is not held. */
export const findLease = async (rawName: unknown, now: number = Date.now()): Promise<ILease | null> => {
  const { name } = parseLeaseName(rawName);
  const { leases } = await readLeaseState();
  return unexpired(leases, now).find((l) => l.name === name) ?? null;
};

export const releaseTabLeases = async (tabId: string, reason: TLeaseReleaseReason, now: number = Date.now()): Promise<ILease[]> => {
  const released = await transact(now, (state) => {
    const r = releaseTabInState(state, tabId);
    if (!r.released.length) return null;
    return { state: r.state, value: r.released, effects: r.released.map((lease): TLeaseEffect => ({ type: 'released', lease, reason, by: null })) };
  });
  return released.value ?? [];
};

/** Expiry is applied by the transaction's own prune; the sweep adds the tab and agent rules. */
export const sweepLeases = async (facts: ISweepFacts): Promise<IReleasedLease[]> => {
  const { value, expired } = await transact(facts.now, (state) => {
    const r = sweepState(state, facts);
    if (!r.released.length) return null;
    return {
      state: r.state,
      value: r.released,
      effects: r.released.map(({ lease, reason }): TLeaseEffect => ({ type: 'released', lease, reason, by: null, extra: { sweep: true } })),
    };
  }, { sweep: true });
  return [...expired.map((lease): IReleasedLease => ({ lease, reason: 'expired' })), ...(value ?? [])];
};
