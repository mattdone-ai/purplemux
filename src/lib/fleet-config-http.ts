import type { NextApiRequest, NextApiResponse } from 'next';
import type { ICaller } from '@/lib/caller';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import {
  FleetConfigError,
  FleetConfigFileError,
  checkExpectedVersion,
  checkKey,
  checkValue,
  mutateFleetConfig,
  readFleetConfig,
  setValue,
  unsetValue,
  valueOf,
} from '@/lib/fleet-config-store';
import { leaseAuthority } from '@/lib/lease-http';
import { createLogger } from '@/lib/logger';
import type { IFleetConfigChange, IFleetConfigSetter, IFleetConfigState, IFleetConfigValue } from '@/types/fleet-config';
import { REMOTE_CALLBACK_URL_KEY, REMOTE_HOSTS_KEY, callbackUrlRefusal, isValidRemoteHostName } from '@/lib/remote-host';

const log = createLogger('fleet-config');

export interface IFleetConfigAuthority {
  isWorkspaceOrchestrator: (workspaceId: string, tabId: string) => Promise<boolean>;
  now: () => number;
}

const defaultAuthority: IFleetConfigAuthority = {
  isWorkspaceOrchestrator: leaseAuthority.isWorkspaceOrchestrator,
  now: () => Date.now(),
};

const setterOf = (caller: ICaller): IFleetConfigSetter => ({
  workspaceId: caller.admin ? null : caller.workspaceId,
  tabId: caller.admin ? null : caller.tabId,
  admin: caller.admin,
});

/**
 * Cooperative authority, not a security boundary (C-312 class): every agent can
 * read the admin token. A write needs it, or the tab that is its workspace's
 * enabled orchestrator — the same rule as the deploy lease.
 */
/** Keys that decide where tabs run and where their tokens are sent (ADR-0022): the admin token only. */
const ADMIN_ONLY_KEYS = /^remote\./;

/** Values the remote keys must hold, checked at write time so a bad one never reaches a create. */
const checkRemoteValue = (key: string, value: string): void => {
  if (key === REMOTE_CALLBACK_URL_KEY) {
    const refusal = callbackUrlRefusal(value);
    if (refusal) throw new FleetConfigError('config-invalid', refusal);
  }
  if (key === REMOTE_HOSTS_KEY) {
    const bad = value.split(',').map((h) => h.trim()).filter((h) => h && !isValidRemoteHostName(h));
    if (bad.length) throw new FleetConfigError('config-invalid', `${REMOTE_HOSTS_KEY} names that are not ssh aliases: ${bad.join(', ')}`);
  }
};

const requireWriter = async (caller: ICaller, authority: IFleetConfigAuthority, key: string): Promise<void> => {
  if (caller.admin) return;
  if (ADMIN_ONLY_KEYS.test(key)) throw new FleetConfigError('forbidden', `${key} is written by the admin token only (ADR-0022)`);
  if (caller.workspaceId && caller.tabId && (await authority.isWorkspaceOrchestrator(caller.workspaceId, caller.tabId))) return;
  throw new FleetConfigError('forbidden', "fleet config is written by the admin token or the workspace's enabled orchestrator tab");
};

/** No broadcast, no nudge, no inbox notice (ADR-0019): tools read the value at call time. */
const audit = (change: IFleetConfigChange, caller: ICaller): Promise<void> =>
  appendCoordinationAudit({
    event: change.newValue === null ? 'fleet-config-unset' : 'fleet-config-set',
    key: change.key,
    oldValue: change.oldValue,
    newValue: change.newValue,
    version: change.version,
    by: { ...setterOf(caller), verified: caller.admin ? false : caller.verified, identity: caller.admin ? 'none' : caller.identity },
  });

export const putValue = async (
  caller: ICaller,
  rawKey: unknown,
  body: Record<string, unknown>,
  authority: IFleetConfigAuthority = defaultAuthority,
): Promise<{ key: string; version: number; value: IFleetConfigValue; changed: boolean }> => {
  const key = checkKey(rawKey);
  const value = checkValue(body.value);
  const expectedVersion = checkExpectedVersion(body.expectedVersion);
  await requireWriter(caller, authority, key);
  checkRemoteValue(key, value);
  const { state, change } = await mutateFleetConfig((s) => setValue(s, { key, value, expectedVersion }, setterOf(caller), authority.now()));
  if (change) await audit(change, caller);
  const stored = valueOf(state, key)!;
  return { key, version: stored.version, value: stored, changed: change !== null };
};

export const deleteValue = async (
  caller: ICaller,
  rawKey: unknown,
  body: Record<string, unknown>,
  authority: IFleetConfigAuthority = defaultAuthority,
): Promise<{ key: string; version: number; unset: IFleetConfigChange }> => {
  const key = checkKey(rawKey);
  const expectedVersion = checkExpectedVersion(body.expectedVersion);
  await requireWriter(caller, authority, key);
  const { change } = await mutateFleetConfig((s) => unsetValue(s, { key, expectedVersion }, setterOf(caller), authority.now()));
  await audit(change!, caller);
  return { key, version: change!.version, unset: change! };
};

/** `?key=` answers one value (404 when unset); `?history=1` the change log, optionally for one key. */
export const readValues = async (query: NextApiRequest['query']): Promise<Record<string, unknown>> => {
  const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const rawKey = one(query.key);
  const key = rawKey === undefined || rawKey === '' ? null : checkKey(rawKey);
  const state: IFleetConfigState = await readFleetConfig();
  if (one(query.history) === '1') {
    return { history: key ? state.history.filter((c) => c.key === key) : state.history };
  }
  if (key) {
    const value = valueOf(state, key);
    if (!value) throw new FleetConfigError('config-not-found', `${key} is not set`);
    return { key, ...value };
  }
  return { values: state.values };
};

const STATUS: Record<string, number> = {
  'config-invalid': 400,
  forbidden: 403,
  'config-not-found': 404,
  'config-version-conflict': 409,
};

/** Every refusal carries `code`, which the CLI maps to its exit (ADR-0016). */
export const sendFleetConfigError = (res: NextApiResponse, err: unknown): void => {
  if (err instanceof FleetConfigError) {
    res.status(STATUS[err.code] ?? 500).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof FleetConfigFileError) {
    // Fail closed: a store that cannot be read answers no question about a value.
    res.status(500).json({ error: err.message, code: err.code });
    return;
  }
  log.error(`fleet-config route failed: ${err instanceof Error ? err.message : err}`);
  res.status(500).json({ error: 'fleet config operation failed', code: 'config-internal' });
};
