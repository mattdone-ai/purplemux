import type { ILeaseHolder } from '@/types/lease';

/**
 * Per-kind lifetime rules (ADR-0011, architecture.md "Lease kinds"). The kinds
 * differ only in lifetime and authority, which is why one store holds them all.
 */
export interface IKindPolicy {
  /** null: no expiry unless the caller gives one. */
  defaultTtlSeconds: number | null;
  maxTtlSeconds: number;
  survivesTab: boolean;
  requiresEpic: boolean;
  /** Acquirable only by the admin token or the workspace's enabled orchestrator tab. */
  orchestratorOnly: boolean;
  resourcePattern: RegExp | null;
  resourceForm: string;
}

const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const REPO = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
export const EPIC_SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export const LEASE_KINDS: Readonly<Record<string, IKindPolicy>> = Object.freeze({
  merge: { defaultTtlSeconds: 45 * MIN, maxTtlSeconds: 3 * HOUR, survivesTab: false, requiresEpic: false, orchestratorOnly: false, resourcePattern: REPO, resourceForm: '<owner>/<repo>' },
  'dev-deploy': { defaultTtlSeconds: 45 * MIN, maxTtlSeconds: 3 * HOUR, survivesTab: false, requiresEpic: false, orchestratorOnly: false, resourcePattern: REPO, resourceForm: '<owner>/<repo>' },
  'dev-write': { defaultTtlSeconds: 60 * MIN, maxTtlSeconds: 8 * HOUR, survivesTab: false, requiresEpic: false, orchestratorOnly: false, resourcePattern: null, resourceForm: '<env>' },
  deploy: { defaultTtlSeconds: 30 * MIN, maxTtlSeconds: 2 * HOUR, survivesTab: false, requiresEpic: false, orchestratorOnly: true, resourcePattern: null, resourceForm: '<service>' },
  epic: { defaultTtlSeconds: null, maxTtlSeconds: 7 * DAY, survivesTab: false, requiresEpic: false, orchestratorOnly: false, resourcePattern: EPIC_SLUG, resourceForm: `an epic slug (${EPIC_SLUG.source})` },
  // A pool slot (ADR-0039): placed and numbered by `pool acquire`; it ends with its holder tab or its TTL.
  pool: { defaultTtlSeconds: 60 * MIN, maxTtlSeconds: DAY, survivesTab: false, requiresEpic: false, orchestratorOnly: false, resourcePattern: /^[a-z0-9._-]+\/(gate|build|mutation|browser|test-service|tab)-[0-9]{1,3}$/, resourceForm: '<host>/<gate|build|mutation|browser|test-service|tab>-<n>' },
  // A queued pool request (vel-D4): its waiter re-asks within the TTL or the place is given up.
  'pool-queue': { defaultTtlSeconds: 2 * MIN, maxTtlSeconds: DAY, survivesTab: false, requiresEpic: false, orchestratorOnly: false, resourcePattern: /^(gate|build|mutation|browser|test-service|tab)-[0-9]{1,3}$/, resourceForm: '<gate|build|mutation|browser|test-service|tab>-<n>' },
  num: { defaultTtlSeconds: 14 * DAY, maxTtlSeconds: 30 * DAY, survivesTab: true, requiresEpic: true, orchestratorOnly: false, resourcePattern: /^[a-z0-9._-]+\/[a-z0-9._-]+:(adr|migration):[0-9]{1,6}$/, resourceForm: '<owner>/<repo>:<adr|migration>:<nnnn>' },
});

export const OTHER_KIND: IKindPolicy = Object.freeze({
  defaultTtlSeconds: 30 * MIN, maxTtlSeconds: DAY, survivesTab: false, requiresEpic: false, orchestratorOnly: false, resourcePattern: null, resourceForm: 'free-form',
});

export const LEASE_NAME = /^[a-z][a-z0-9-]{1,31}:[a-z0-9._/@#:+-]{1,200}$/;
export const NOTE_MAX = 500;

export const policyFor = (kind: string): IKindPolicy =>
  Object.hasOwn(LEASE_KINDS, kind) ? LEASE_KINDS[kind] : OTHER_KIND;

export class LeasePolicyError extends Error {
  readonly code = 'lease-policy' as const;
}

export interface IParsedLeaseName {
  name: string;
  kind: string;
  resource: string;
}

/** Lower-cases, then checks the grammar and the kind's resource form. */
export const parseLeaseName = (raw: unknown): IParsedLeaseName => {
  if (typeof raw !== 'string') throw new LeasePolicyError('name is required');
  const name = raw.trim().toLowerCase();
  if (!LEASE_NAME.test(name)) {
    throw new LeasePolicyError(`name "${name}" does not match ${LEASE_NAME.source} (<kind>:<resource>, lower case)`);
  }
  const i = name.indexOf(':');
  const kind = name.slice(0, i);
  const resource = name.slice(i + 1);
  const policy = policyFor(kind);
  if (policy.resourcePattern && !policy.resourcePattern.test(resource)) {
    throw new LeasePolicyError(`${kind} lease resource "${resource}" must be ${policy.resourceForm}`);
  }
  return { name, kind, resource };
};

const formatSeconds = (s: number): string =>
  s % DAY === 0 ? `${s / DAY}d` : s % HOUR === 0 ? `${s / HOUR}h` : s % MIN === 0 ? `${s / MIN}m` : `${s}s`;

/**
 * The TTL a lease gets. `undefined` takes the kind's default; `null` asks for
 * no expiry, which only a kind without a default allows, and only for a tab
 * holder — a holder with no tab has nothing else that ends the lease.
 */
export const resolveTtl = (kind: string, requested: number | null | undefined, holder: ILeaseHolder): number | null => {
  const policy = policyFor(kind);
  const ttl = requested === undefined ? policy.defaultTtlSeconds : requested;
  if (ttl === null) {
    if (policy.defaultTtlSeconds !== null) throw new LeasePolicyError(`${kind} leases must expire (default ${formatSeconds(policy.defaultTtlSeconds)})`);
    if (!holder.tabId) throw new LeasePolicyError(`${holder.admin ? 'an admin' : 'a tabless'} holder must give a TTL for ${kind} leases`);
    return null;
  }
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new LeasePolicyError(`ttlSeconds must be a positive whole number, got ${String(ttl)}`);
  if (ttl > policy.maxTtlSeconds) {
    throw new LeasePolicyError(`${kind} leases allow at most ${formatSeconds(policy.maxTtlSeconds)}, got ${formatSeconds(ttl)}`);
  }
  return ttl;
};

export const resolveEpic = (kind: string, raw: unknown): string | null => {
  if (raw === undefined || raw === null || raw === '') {
    if (policyFor(kind).requiresEpic) throw new LeasePolicyError(`${kind} leases require an epic`);
    return null;
  }
  if (typeof raw !== 'string') throw new LeasePolicyError('epic must be a string');
  const epic = raw.trim().toLowerCase();
  if (!EPIC_SLUG.test(epic)) throw new LeasePolicyError(`epic "${epic}" does not match ${EPIC_SLUG.source}`);
  return epic;
};

export const resolveNote = (raw: unknown): string | null => {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new LeasePolicyError('note must be a string');
  const note = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (note.length > NOTE_MAX) throw new LeasePolicyError(`note is ${note.length} characters; at most ${NOTE_MAX}`);
  return note || null;
};
