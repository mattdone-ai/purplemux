import { isAgentPanelType } from '@/lib/agent-panel-types';
import { collectAllTabs } from '@/lib/layout-tree';
import { LeasePolicyError, resolveTtl } from '@/lib/lease-policy';
import { acquireChosenLease, listLeases, releaseLease, type ILeaseAuthority } from '@/lib/lease-store';
import { createLogger } from '@/lib/logger';
import {
  POOL_GATE_HOST_KEY_PREFIX,
  POOL_LEASE_KIND,
  buildPoolView,
  freeSlotNumber,
  hostState,
  isPoolKind,
  parsePoolLeaseName,
  placeWork,
  poolHostId,
  poolLeaseName,
  poolLeaseNote,
  type IPoolHostState,
  type TConfigValue,
} from '@/lib/pool';
import { getPoolReader } from '@/lib/pool-read';
import { isValidRemoteHostName } from '@/lib/remote-host';
import type { ILease, ILeaseHolder, ILeaseState } from '@/types/lease';
import type { IPoolAcquireResult, IPoolPlacementRequest, IPoolView, TPoolHostRead, TPoolPlacement, TPoolRefusalReason } from '@/types/pool';

// The pool's operations (ADR-0039): the view the board and `pool show` read,
// slot leases on the ADR-0011 store, and the placement `tab create --host auto` asks.

const log = createLogger('pool');

export const MEM_GB_MAX = 1024;

export class PoolError extends Error {
  constructor(
    readonly code: 'pool-full' | 'pool-invalid',
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
  /** Agent tabs per pool host id (this host's tabs under its own name). */
  agentTabs: (localHost: string) => Promise<Map<string, number>>;
  leases: () => Promise<ILease[]>;
  now: () => number;
}

const readAgentTabs = async (localHost: string): Promise<Map<string, number>> => {
  const { getWorkspaces } = await import('@/lib/workspace-store');
  const { readWorkspaceLayout } = await import('@/lib/workspace-layout-read');
  const counts = new Map<string, number>();
  const { workspaces } = await getWorkspaces();
  await Promise.all(workspaces.map(async (ws) => {
    const layout = await readWorkspaceLayout(ws.id).catch((err: unknown) => {
      log.warn(`pool: layout of ${ws.id} unreadable, its tabs are not counted: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (!layout) return;
    for (const tab of collectAllTabs(layout.root)) {
      if (!isAgentPanelType(tab.panelType)) continue;
      const host = poolHostId(tab.host ?? localHost);
      counts.set(host, (counts.get(host) ?? 0) + 1);
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
  leases: () => listLeases(`${POOL_LEASE_KIND}:`),
  now: () => Date.now(),
});

interface IPoolFacts {
  reads: TPoolHostRead[];
  config: TConfigValue;
  tabs: Map<string, number>;
}

const gatherFacts = async (deps: IPoolServiceDeps): Promise<IPoolFacts> => {
  const reads = await deps.reads();
  const localHost = reads.find((r) => r.local)?.host ?? '';
  const [config, tabs] = await Promise.all([deps.config(), deps.agentTabs(localHost)]);
  return { reads, config, tabs };
};

const statesOf = (facts: IPoolFacts, leases: readonly ILease[]): IPoolHostState[] =>
  facts.reads.map((read) => hostState(read, leases, facts.tabs.get(poolHostId(read.host)) ?? 0, facts.config));

/** The pool model: `pool show`, `GET /api/cli/pool`, and the owner board's pool section (story 12). */
export const readPoolView = async (deps: IPoolServiceDeps = defaultPoolServiceDeps()): Promise<IPoolView> => {
  const [facts, leases] = await Promise.all([gatherFacts(deps), deps.leases()]);
  return buildPoolView(statesOf(facts, leases), deps.now());
};

/** A placement only, no lease: `tab create --host auto` (the created tab counts itself in the layout). */
export const placeOnPool = async (req: IPoolPlacementRequest, deps: IPoolServiceDeps = defaultPoolServiceDeps()): Promise<TPoolPlacement> => {
  const [facts, leases] = await Promise.all([gatherFacts(deps), deps.leases()]);
  return placeWork(statesOf(facts, leases), req);
};

export interface IPoolAcquireInput {
  kind: unknown;
  memGb?: unknown;
  ttlSeconds?: unknown;
  panelType?: unknown;
  role?: unknown;
}

const optionalText = (raw: unknown, field: string): string | undefined => {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(raw)) throw new PoolError('pool-invalid', `${field} must be a lower-case name, got ${JSON.stringify(raw)}`);
  return raw;
};

export const parsePoolRequest = (input: IPoolAcquireInput): IPoolPlacementRequest => {
  if (!isPoolKind(input.kind)) throw new PoolError('pool-invalid', `kind must be gate, build or tab, got ${JSON.stringify(input.kind ?? null)}`);
  const memGb = input.memGb === undefined || input.memGb === null ? 0 : input.memGb;
  if (typeof memGb !== 'number' || !Number.isFinite(memGb) || memGb < 0 || memGb > MEM_GB_MAX) {
    throw new PoolError('pool-invalid', `memGb must be a number of GiB in 0..${MEM_GB_MAX}, got ${JSON.stringify(input.memGb)}`);
  }
  const panelType = optionalText(input.panelType, 'panelType');
  const role = optionalText(input.role, 'role');
  if (input.kind !== 'tab' && (panelType || role)) throw new PoolError('pool-invalid', 'panelType and role go with kind tab only');
  return { kind: input.kind, memGb, ...(panelType ? { panelType } : {}), ...(role ? { role } : {}) };
};

const gateHostOf = (config: TConfigValue, host: string): string | null => {
  const value = config(`${POOL_GATE_HOST_KEY_PREFIX}${poolHostId(host)}`)?.trim();
  return value && isValidRemoteHostName(value) ? value : null;
};

/**
 * `pool acquire`: place, then take the lowest free slot of the chosen host,
 * both inside the lease lock. The reads and the fleet values are taken first
 * (no ssh ever runs under the lock); the lease state is the lock's own.
 */
export const acquirePoolSlot = async (
  input: IPoolAcquireInput,
  holder: ILeaseHolder,
  authority: ILeaseAuthority,
  deps: IPoolServiceDeps = defaultPoolServiceDeps(),
): Promise<IPoolAcquireResult> => {
  const req = parsePoolRequest(input);
  if (input.ttlSeconds !== undefined && input.ttlSeconds !== null && typeof input.ttlSeconds !== 'number') {
    throw new LeasePolicyError('ttlSeconds must be a number');
  }
  const ttlSeconds = input.ttlSeconds === undefined || input.ttlSeconds === null
    ? undefined
    : resolveTtl(POOL_LEASE_KIND, input.ttlSeconds as number, holder) ?? undefined;
  const facts = await gatherFacts(deps);
  const { lease, value } = await acquireChosenLease(holder, authority, (state: ILeaseState) => {
    const states = statesOf(facts, state.leases);
    const placed = placeWork(states, req);
    if (!placed.ok) throw new PoolError('pool-full', placed.reason, placed.refusal);
    const chosen = states.find((s) => s.view.host === placed.host)!;
    const n = freeSlotNumber(chosen, req.kind);
    return {
      name: poolLeaseName(placed.host, req.kind, n),
      ttlSeconds,
      note: poolLeaseNote(req.memGb),
      value: { host: placed.host, local: placed.local, slot: `${req.kind}-${n}`, reason: placed.reason },
    };
  });
  return {
    ...value,
    lease: lease.name,
    expiresAt: lease.expiresAt,
    gateHost: req.kind === 'gate' && !value.local ? gateHostOf(facts.config, value.host) : null,
  };
};

export const releasePoolSlot = async (rawName: unknown, holder: ILeaseHolder, authority: ILeaseAuthority): Promise<ILease> => {
  const name = typeof rawName === 'string' ? rawName.trim().toLowerCase() : '';
  if (!parsePoolLeaseName(name)) throw new PoolError('pool-invalid', `lease must be a pool slot (pool:<host>/<gate|build|tab>-<n>), got ${JSON.stringify(rawName ?? null)}`);
  return releaseLease(name, holder, authority);
};
