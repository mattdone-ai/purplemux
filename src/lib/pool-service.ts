import { isAgentPanelType } from '@/lib/agent-panel-types';
import { collectAllTabs } from '@/lib/layout-tree';
import { LeasePolicyError, resolveTtl } from '@/lib/lease-policy';
import { LeaseError, acquireChosenLease, holderLabel, listLeases, releaseLease, sameHolder, type ILeaseAuthority } from '@/lib/lease-store';
import { createLogger } from '@/lib/logger';
import {
  NO_TABS,
  POOL_GATE_HOST_KEY_PREFIX,
  POOL_LEASE_KIND,
  POOL_QUEUE_LEASE_KIND,
  QUEUE_RETRY_SECONDS,
  QUEUE_TTL_SECONDS,
  TAB_START_TTL_SECONDS,
  buildPoolView,
  envelopeView,
  freeSlotNumber,
  freeTicketNumber,
  hostState,
  isPoolClass,
  isPoolKind,
  orderQueue,
  parsePoolLeaseName,
  parsePoolQueueName,
  parseTicket,
  pathSlowMsOf,
  placeWork,
  poolHostId,
  poolModeOf,
  poolLeaseName,
  poolLeaseNote,
  poolQueueName,
  poolQueueNote,
  requestEnvelope,
  type IPoolHostState,
  type IPoolHostTabs,
  type IPoolRecentStart,
  type IPoolTicket,
  type TConfigValue,
} from '@/lib/pool';
import { getPoolReader } from '@/lib/pool-read';
import { recentTabStarts, recordWouldRefuse, wouldRefuseView } from '@/lib/pool-runtime';
import { isValidRemoteHostName } from '@/lib/remote-host';
import { pathAlertText, pathView } from '@/lib/tailnet-path';
import type { ILease, ILeaseHolder } from '@/types/lease';
import type {
  IPoolAcquireResult, IPoolEnvelopeView, IPoolHostPath, IPoolPlacementRequest, IPoolQueuedResult, IPoolView, TPoolHostRead, TPoolPlacement,
  TPoolRefusalReason,
} from '@/types/pool';

// The pool's operations (ADR-0039, vel-D4): the view the board and `pool show` read,
// slot leases and queue tickets on the ADR-0011 store, and the tab starts `tab create --host auto` asks.

const log = createLogger('pool');

export const MEM_GB_MAX = 1024;
export const THREADS_MAX = 4096;

export class PoolError extends Error {
  constructor(
    readonly code: 'pool-full' | 'pool-invalid' | 'pool-ticket-gone',
    message: string,
    readonly refusal: TPoolRefusalReason | null = null,
  ) {
    super(message);
  }
}

export interface IPoolServiceDeps {
  /** Every host as last read; never waits on ssh. */
  reads: () => Promise<TPoolHostRead[]>;
  /** One fleet-config snapshot per operation; throws when the store is unreadable. */
  config: () => Promise<TConfigValue>;
  /** Agent tabs per pool host id (this host's tabs under its own name), the orchestrator tabs apart. */
  agentTabs: (localHost: string) => Promise<Map<string, IPoolHostTabs>>;
  /** Pool slots and queue tickets. */
  leases: () => Promise<ILease[]>;
  now: () => number;
  /** Tab starts the reads cannot show yet, per pool host id; the server's own record when absent. */
  recentStarts?: (now: number) => Map<string, IPoolRecentStart[]>;
}

const readAgentTabs = async (localHost: string): Promise<Map<string, IPoolHostTabs>> => {
  const { getWorkspaces } = await import('@/lib/workspace-store');
  const { readWorkspaceLayout } = await import('@/lib/workspace-layout-read');
  const counts = new Map<string, IPoolHostTabs>();
  const { workspaces } = await getWorkspaces();
  await Promise.all(workspaces.map(async (ws) => {
    const layout = await readWorkspaceLayout(ws.id).catch((err: unknown) => {
      log.warn(`pool: layout of ${ws.id} unreadable, its tabs are not counted: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (!layout) return;
    const orchestrator = ws.orchestration?.enabled ? ws.orchestration.orchestratorTabId : null;
    for (const tab of collectAllTabs(layout.root)) {
      if (!isAgentPanelType(tab.panelType)) continue;
      const host = poolHostId(tab.host ?? localHost);
      const c = counts.get(host) ?? { worker: 0, controlPlane: 0 };
      if (tab.id === orchestrator) c.controlPlane += 1;
      else c.worker += 1;
      counts.set(host, c);
    }
  }));
  return counts;
};

export const defaultPoolServiceDeps = (): IPoolServiceDeps => ({
  reads: () => getPoolReader().snapshot(),
  config: async () => {
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    const state = await readFleetConfig();
    return (key) => valueOf(state, key)?.value ?? null;
  },
  agentTabs: readAgentTabs,
  leases: async () => [...await listLeases(`${POOL_LEASE_KIND}:`), ...await listLeases(`${POOL_QUEUE_LEASE_KIND}:`)],
  now: () => Date.now(),
});

interface IPoolFacts {
  reads: TPoolHostRead[];
  config: TConfigValue;
  tabs: Map<string, IPoolHostTabs>;
}

const gatherFacts = async (deps: IPoolServiceDeps): Promise<IPoolFacts> => {
  const reads = await deps.reads();
  const localHost = reads.find((r) => r.local)?.host ?? '';
  const [config, layoutTabs] = await Promise.all([deps.config(), deps.agentTabs(localHost)]);
  const tabs = new Map(layoutTabs);
  for (const [host, recentStarts] of (deps.recentStarts ?? recentTabStarts)(deps.now())) {
    tabs.set(host, { ...(tabs.get(host) ?? NO_TABS), recentStarts });
  }
  return { reads, config, tabs };
};

const statesOf = (facts: IPoolFacts, leases: readonly ILease[]): IPoolHostState[] =>
  facts.reads.map((read) => hostState(read, leases, facts.tabs.get(poolHostId(read.host)) ?? NO_TABS, facts.config));

const ticketsOf = (leases: readonly ILease[]): IPoolTicket[] =>
  leases.flatMap((l) => {
    const t = parseTicket(l);
    return t ? [t] : [];
  });

/** The pool model: `pool show`, `GET /api/cli/pool`, and the owner board's pool section (story 12). */
export const readPoolView = async (deps: IPoolServiceDeps = defaultPoolServiceDeps()): Promise<IPoolView> => {
  const [facts, leases] = await Promise.all([gatherFacts(deps), deps.leases()]);
  return buildPoolView(statesOf(facts, leases), deps.now(), ticketsOf(leases), wouldRefuseView(poolModeOf(facts.config)));
};

/**
 * Each remote host's tailnet path, as the last pool read measured it (vel-RETRO-R2): never a measurement of its own.
 * A fleet config that cannot be read judges slowness by the default threshold.
 */
export const readPoolPaths = async (deps: Pick<IPoolServiceDeps, 'reads' | 'config'> = defaultPoolServiceDeps()): Promise<IPoolHostPath[]> => {
  const [reads, config] = await Promise.all([deps.reads(), deps.config().catch((): TConfigValue => () => null)]);
  const slowMs = pathSlowMsOf(config);
  return reads.filter((r) => !r.local).map((r) => {
    const path = r.path ? pathView(r.path, slowMs) : null;
    return { host: r.host, path, text: path?.alert ? pathAlertText(r.host, path) : null };
  });
};

/** The counter the fleet view carries (review r1 F1); a fleet config that cannot be read reports shadow, the default. */
export const readPoolWouldRefuse = async (deps: Pick<IPoolServiceDeps, 'config'> = defaultPoolServiceDeps()): Promise<IPoolView['wouldRefuse']> => {
  const config = await deps.config().catch(() => null);
  return wouldRefuseView(config ? poolModeOf(config) : 'shadow');
};

const noteShadow = (placed: TPoolPlacement, now: number): void => {
  if (placed.ok && placed.wouldRefuse) recordWouldRefuse(placed.wouldRefuse, now);
};

/** A placement only, no lease (a caller that cannot hold one); the waiting tickets still come first. */
export const placeOnPool = async (req: IPoolPlacementRequest, deps: IPoolServiceDeps = defaultPoolServiceDeps()): Promise<TPoolPlacement> => {
  const [facts, leases] = await Promise.all([gatherFacts(deps), deps.leases()]);
  const placed = placeWork(statesOf(facts, leases), req, { queue: ticketsOf(leases) });
  noteShadow(placed, deps.now());
  return placed;
};

/**
 * Class control-plane is honoured only for the workspace's enabled orchestrator tab, resolved here from the
 * caller's own verified identity, never from the request (review r1 F3, r2 N1). Any other caller runs as
 * product, and the answer says why.
 */
export const resolvePoolClass = async (
  req: IPoolPlacementRequest,
  holder: ILeaseHolder,
  authority: Pick<ILeaseAuthority, 'isWorkspaceOrchestrator'>,
): Promise<{ req: IPoolPlacementRequest; downgrade: string | null }> => {
  if (req.class !== 'control-plane') return { req, downgrade: null };
  // Verified only, as the WIP-cap override (`isOverCapCaller`): an asserted session identity does not claim the reserve.
  const coordinator = !holder.admin && holder.verified && !!holder.tabId && !!holder.workspaceId
    && await authority.isWorkspaceOrchestrator(holder.workspaceId, holder.tabId);
  if (coordinator) return { req, downgrade: null };
  return {
    req: { ...req, class: 'product' },
    downgrade: `class control-plane is only for the workspace's verified, enabled orchestrator tab; ${holderLabel(holder)} is not, so it runs as product`,
  };
};

export interface IPoolAcquireInput {
  kind: unknown;
  memGb?: unknown;
  threads?: unknown;
  ttlSeconds?: unknown;
  panelType?: unknown;
  role?: unknown;
  class?: unknown;
  localOnly?: unknown;
  /** Queue when nothing fits now (vel-D4); without it a no-fit is `pool-full`, as before. */
  queue?: unknown;
  /** Re-ask as this waiting ticket. */
  ticket?: unknown;
}

const optionalText = (raw: unknown, field: string): string | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(raw)) throw new PoolError('pool-invalid', `${field} must be a lower-case name, got ${JSON.stringify(raw)}`);
  return raw;
};

const absent = (raw: unknown): boolean => raw === undefined || raw === null;

export const parsePoolRequest = (input: IPoolAcquireInput): IPoolPlacementRequest => {
  if (!isPoolKind(input.kind)) throw new PoolError('pool-invalid', `kind must be gate, build, mutation, browser, test-service or tab, got ${JSON.stringify(input.kind ?? null)}`);
  const memGb = absent(input.memGb) ? 0 : input.memGb;
  if (typeof memGb !== 'number' || !Number.isFinite(memGb) || memGb < 0 || memGb > MEM_GB_MAX) {
    throw new PoolError('pool-invalid', `memGb must be a number of GiB in 0..${MEM_GB_MAX}, got ${JSON.stringify(input.memGb)}`);
  }
  if (!absent(input.threads) && (!Number.isSafeInteger(input.threads) || (input.threads as number) < 1 || (input.threads as number) > THREADS_MAX)) {
    throw new PoolError('pool-invalid', `threads must be a whole number 1..${THREADS_MAX}, got ${JSON.stringify(input.threads)}`);
  }
  if (!absent(input.class) && !isPoolClass(input.class)) throw new PoolError('pool-invalid', `class must be product, harness or control-plane, got ${JSON.stringify(input.class)}`);
  if (input.class === 'control-plane' && input.kind !== 'tab') throw new PoolError('pool-invalid', 'class control-plane goes with kind tab only: jobs share the worker budget');
  const panelType = optionalText(input.panelType, 'panelType');
  const role = optionalText(input.role, 'role');
  if (input.kind !== 'tab' && (panelType || role || input.localOnly === true)) throw new PoolError('pool-invalid', 'panelType, role and localOnly go with kind tab only');
  if (input.kind === 'tab' && !isAgentPanelType(panelType ?? 'claude-code')) throw new PoolError('pool-invalid', `a ${panelType} tab has no envelope: only agent tabs reserve from the pool`);
  return {
    kind: input.kind,
    memGb,
    ...(absent(input.threads) ? {} : { threads: input.threads as number }),
    ...(isPoolClass(input.class) ? { class: input.class } : {}),
    ...(panelType ? { panelType } : {}),
    ...(role ? { role } : {}),
    ...(input.localOnly === true ? { localOnly: true } : {}),
  };
};

const gateHostOf = (config: TConfigValue, host: string): string | null => {
  const value = config(`${POOL_GATE_HOST_KEY_PREFIX}${poolHostId(host)}`)?.trim();
  return value && isValidRemoteHostName(value) ? value : null;
};

const ticketInput = (raw: unknown): string | null => {
  if (absent(raw) || raw === '') return null;
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!parsePoolQueueName(name)) throw new PoolError('pool-invalid', `ticket must be a pool queue ticket (pool-queue:<kind>-<n>), got ${JSON.stringify(raw)}`);
  return name;
};

/** A stand-in for the ticket a new request would take, so its position is counted before it is written. */
const pendingTicket = (name: string, req: IPoolPlacementRequest, holder: ILeaseHolder, now: number): IPoolTicket => {
  const at = new Date(now).toISOString();
  return {
    name, kind: req.kind, n: parsePoolQueueName(name)?.n ?? 0, req,
    lease: { name, kind: POOL_QUEUE_LEASE_KIND, resource: name.slice(name.indexOf(':') + 1), holder, epic: null, note: null, acquiredAt: at, renewedAt: at, ttlSeconds: QUEUE_TTL_SECONDS, expiresAt: null, survivesTab: false },
  };
};

type TAdmitted = Omit<IPoolAcquireResult, 'lease' | 'expiresAt' | 'gateHost'>;
type TChoice = { queued: false; admitted: TAdmitted } | { queued: true; result: IPoolQueuedResult };

/**
 * `pool acquire`: admit, then take the lowest free slot of the chosen host, both inside the lease lock. With
 * `queue`, a request that fits nowhere takes a ticket; a re-ask with the ticket is admitted in queue order and the
 * ticket becomes the slot in one transaction. A re-ask renews the ticket only when less than half its TTL is left,
 * so a waiter writes about once a minute, not on every ask. The reads and the fleet values are taken first (no ssh
 * ever runs under the lock); the lease state is the lock's own.
 */
export const acquirePoolSlot = async (
  input: IPoolAcquireInput,
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
  deps: IPoolServiceDeps = defaultPoolServiceDeps(),
): Promise<IPoolAcquireResult | IPoolQueuedResult> => {
  const resolved = await resolvePoolClass(parsePoolRequest(input), holder, authority);
  const asked = resolved.req;
  const downgrade = resolved.downgrade ? { downgrade: resolved.downgrade } : {};
  const ticketName = ticketInput(input.ticket);
  if (!absent(input.ttlSeconds) && typeof input.ttlSeconds !== 'number') throw new LeasePolicyError('ttlSeconds must be a number');
  const ttlSeconds = absent(input.ttlSeconds) ? undefined : resolveTtl(POOL_LEASE_KIND, input.ttlSeconds as number, holder) ?? undefined;
  const queue = input.queue === true || ticketName !== null;
  const facts = await gatherFacts(deps);
  const { lease, value } = await acquireChosenLease<TChoice>(holder, authority, (state, now) => {
    const states = statesOf(facts, state.leases);
    const tickets = ticketsOf(state.leases);
    let req = asked;
    let self: IPoolTicket | null = null;
    if (ticketName) {
      self = tickets.find((t) => t.name === ticketName) ?? null;
      if (!self) throw new PoolError('pool-ticket-gone', `${ticketName} is not waiting: its ${QUEUE_TTL_SECONDS} s TTL passed, it was released, or it was admitted; ask again without the ticket`);
      if (!sameHolder(self.lease.holder, holder)) throw new PoolError('pool-invalid', `${ticketName} is another caller's ticket`);
      if (self.kind !== asked.kind) throw new PoolError('pool-invalid', `${ticketName} is a ${self.kind} ticket, not ${asked.kind}`);
      req = self.req;
    }
    const placed = placeWork(states, req, { queue: tickets, ...(self ? { self: self.name } : {}) });
    const cls = req.class ?? 'product';
    const envelope = requestEnvelope(req, facts.config);
    if (placed.ok) {
      const chosen = states.find((s) => s.view.host === placed.host)!;
      const n = freeSlotNumber(chosen, req.kind);
      return {
        name: poolLeaseName(placed.host, req.kind, n),
        ttlSeconds,
        note: poolLeaseNote(envelope, cls),
        release: self ? [self.name] : [],
        value: {
          queued: false,
          admitted: {
            host: placed.host, local: placed.local, slot: `${req.kind}-${n}`, class: cls, envelope: envelopeView(envelope),
            reason: resolved.downgrade ? `${resolved.downgrade}; ${placed.reason}` : placed.reason,
            ...(placed.wouldRefuse ? { wouldRefuse: placed.wouldRefuse } : {}),
            ...downgrade,
          },
        },
      };
    }
    if (!queue || !placed.queueable) throw new PoolError('pool-full', placed.reason, placed.refusal);
    const name = self?.name ?? poolQueueName(req.kind, freeTicketNumber(tickets, req.kind));
    const renew = !self || self.lease.expiresAt === null || Date.parse(self.lease.expiresAt) - now < (QUEUE_TTL_SECONDS * 1000) / 2;
    const ordered = orderQueue(self ? tickets : [...tickets, pendingTicket(name, req, holder, now)], states, facts.config);
    const position = ordered.findIndex((t) => t.name === name) + 1;
    const result: IPoolQueuedResult = {
      queued: true, ticket: name, kind: req.kind, class: cls, position, of: ordered.length,
      reason: `queued: position ${position} of ${ordered.length}; ${resolved.downgrade ? `${resolved.downgrade}; ` : ''}${placed.reason}`,
      refusal: placed.refusal,
      expiresAt: renew ? new Date(now + QUEUE_TTL_SECONDS * 1000).toISOString() : self!.lease.expiresAt,
      retryAfterSeconds: QUEUE_RETRY_SECONDS,
      envelope: envelopeView(envelope),
      ...downgrade,
    };
    return renew
      ? { name, ttlSeconds: QUEUE_TTL_SECONDS, note: poolQueueNote(req), value: { queued: true, result } }
      : { name: null, value: { queued: true, result } };
  });
  if (value.queued) {
    // One warning per ticket: a waiter that re-asks is not a new escalation.
    if (!ticketName) log.warn(`pool: ${value.result.ticket} ${value.result.reason}`);
    return value.result;
  }
  if (value.admitted.wouldRefuse) recordWouldRefuse(value.admitted.wouldRefuse, deps.now());
  return {
    ...value.admitted,
    lease: lease!.name,
    expiresAt: lease!.expiresAt,
    gateHost: asked.kind === 'gate' && !value.admitted.local ? gateHostOf(facts.config, value.admitted.host) : null,
  };
};

export const releasePoolSlot = async (rawName: unknown, holder: ILeaseHolder, authority: ILeaseAuthority): Promise<ILease> => {
  const name = typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
  if (!parsePoolLeaseName(name) && !parsePoolQueueName(name)) {
    throw new PoolError('pool-invalid', `lease must be a pool slot (pool:<host>/<kind>-<n>) or a queue ticket (pool-queue:<kind>-<n>), got ${JSON.stringify(rawName ?? null)}`);
  }
  return releaseLease(name, holder, authority);
};

export interface ITabStartInput {
  panelType: string;
  role?: string;
  class?: unknown;
  ticket?: unknown;
  localOnly?: boolean;
}

export type TTabStart =
  | { state: 'admitted'; host: string; local: boolean; reason: string; lease: string | null; envelope: IPoolEnvelopeView | null; downgrade?: string }
  | { state: 'queued'; queued: IPoolQueuedResult }
  | { state: 'refused'; refusal: TPoolRefusalReason; reason: string };

/**
 * A tab start for `tab create --host auto` (vel-D4). An agent tab takes a tab lease (TTL 300 s) that holds its
 * envelope until the tab is in its layout; the caller releases it after the create. A start that fits no host
 * queues; it never falls back to this host. A caller that cannot hold a lease (no tab, no admin token) is placed
 * without one and cannot queue.
 */
export const startTabOnPool = async (
  input: ITabStartInput,
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
  deps: IPoolServiceDeps = defaultPoolServiceDeps(),
): Promise<TTabStart> => {
  if (!isAgentPanelType(input.panelType)) {
    const placed = await placeOnPool({ kind: 'tab', memGb: 0, panelType: input.panelType }, deps);
    if (!placed.ok) return { state: 'refused', refusal: placed.refusal, reason: placed.reason };
    return { state: 'admitted', host: placed.host, local: placed.local, reason: placed.reason, lease: null, envelope: null };
  }
  const req: IPoolAcquireInput = { kind: 'tab', panelType: input.panelType, role: input.role, class: input.class, localOnly: input.localOnly === true };
  try {
    const got = await acquirePoolSlot({ ...req, queue: true, ticket: input.ticket, ttlSeconds: TAB_START_TTL_SECONDS }, holder, authority, deps);
    if ('queued' in got) return { state: 'queued', queued: got };
    return { state: 'admitted', host: got.host, local: got.local, reason: got.reason, lease: got.lease, envelope: got.envelope, ...(got.downgrade ? { downgrade: got.downgrade } : {}) };
  } catch (err) {
    if (err instanceof PoolError && err.code === 'pool-full') return { state: 'refused', refusal: err.refusal ?? 'no-known-host', reason: err.message };
    if (!(err instanceof LeaseError) || err.code !== 'caller-unresolved') throw err;
  }
  const resolved = await resolvePoolClass(parsePoolRequest(req), holder, authority);
  const why = resolved.downgrade ? `${resolved.downgrade}; ` : '';
  const placed = await placeOnPool(resolved.req, deps);
  if (!placed.ok) return { state: 'refused', refusal: placed.refusal, reason: `${why}${placed.reason}; a queued start needs a tab or the admin token` };
  return {
    state: 'admitted', host: placed.host, local: placed.local, reason: `${why}${placed.reason}`, lease: null, envelope: placed.envelope,
    ...(resolved.downgrade ? { downgrade: resolved.downgrade } : {}),
  };
};

/** Best effort: a tab start's lease that is not released here ends at its 300 s TTL. */
export const releaseTabStart = async (lease: string | null, holder: ILeaseHolder, authority: ILeaseAuthority): Promise<void> => {
  if (!lease) return;
  await releasePoolSlot(lease, holder, authority).catch((err: unknown) => {
    log.warn(`pool: tab start lease ${lease} not released, it ends at its TTL: ${err instanceof Error ? err.message : err}`);
  });
};
