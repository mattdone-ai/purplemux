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
import { LEDGER_ALARM_KEYS, parseRouteTable, parseThresholdValue } from '@/lib/ledger-alarms';
import { LEDGER_WAIT_REASONS } from '@/lib/ledger';
import { leaseAuthority } from '@/lib/lease-http';
import { STANDUP_DUE_CONFIG_KEY, parseStandupDueMinutes } from '@/lib/standup';
import { createLogger } from '@/lib/logger';
import { POOL_MODE_KEY, isPoolMode, isPoolNumberKey, poolNumberRefusal } from '@/lib/pool';
import type { IFleetConfigChange, IFleetConfigSetter, IFleetConfigState, IFleetConfigValue } from '@/types/fleet-config';
import { REMOTE_CALLBACK_ALLOW_HOSTS_KEY, REMOTE_CALLBACK_URL_KEY, REMOTE_HOSTS_KEY, callbackUrlRefusal, isValidBareHostName, isValidRemoteHostName, parseCallbackAllowHosts } from '@/lib/remote-host';
import { REMOTE_TIMEOUT_KEY, remoteTimeoutRefusal } from '@/lib/remote-timeouts';

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
/**
 * The admin token only: keys that decide where tabs run and where their tokens
 * are sent (ADR-0022), and fleet-wide keys any one workspace's orchestrator must
 * not set for every other workspace (ADR-0027 ruling R2). `standup.` is one (story hfl2-10): the orchestrator
 * the due line nags must not turn it off for every workspace.
 */
export const ADMIN_ONLY_KEYS = /^(remote|tabs|attention|alerts|mission|pool|curator|standup)\./;

const POOL_SLOTS_KEY = /^pool\.slots\.[a-z0-9._-]+\.(gate|build|mutation|browser|test-service|tab)$/;
const POOL_ALIAS_KEY = /^pool\.(fallback|gate-host)\.[A-Za-z0-9._-]+$/;

const TAB_CAP_KEYS = /^tabs\.cap-per-workspace(\.[A-Za-z0-9_-]+)?$/;

/** The WIP cap and a workspace's own cap (ADR-0027, ADR-0039): an integer 1..200, as `parseTabCap` reads it. */
const checkTabCapValue = (key: string, value: string): void => {
  if (!key.startsWith('tabs.cap-per-workspace')) return;
  if (!TAB_CAP_KEYS.test(key)) throw new FleetConfigError('config-invalid', `${key} is not a cap key: tabs.cap-per-workspace or tabs.cap-per-workspace.<workspaceId>`);
  const text = value.trim();
  if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 200) {
    throw new FleetConfigError('config-invalid', `${key} must be an integer 1..200, got ${JSON.stringify(value)}`);
  }
};

/**
 * The pool's keys (ADR-0039, vel-D4): slot count caps are whole numbers 0..64; a fallback or gate host is an ssh
 * alias; the budget, envelope and share keys are numbers in their ranges (`poolNumberRefusal`).
 */
const checkPoolValue = (key: string, value: string): void => {
  if (!key.startsWith('pool.')) return;
  if (key === POOL_MODE_KEY) {
    if (!isPoolMode(value.trim())) throw new FleetConfigError('config-invalid', `${key} must be shadow or enforce, got ${JSON.stringify(value)}`);
    return;
  }
  if (isPoolNumberKey(key)) {
    const refusal = poolNumberRefusal(key, value);
    if (refusal) throw new FleetConfigError('config-invalid', refusal);
    return;
  }
  if (POOL_SLOTS_KEY.test(key)) {
    if (!/^\d{1,2}$/.test(value) || Number(value) > 64) throw new FleetConfigError('config-invalid', `${key} must be a whole number 0..64, got ${JSON.stringify(value)}`);
    return;
  }
  if (POOL_ALIAS_KEY.test(key)) {
    if (!isValidRemoteHostName(value)) throw new FleetConfigError('config-invalid', `${key} must be an ssh alias, got ${JSON.stringify(value)}`);
    return;
  }
  throw new FleetConfigError('config-invalid', `${key} is not a pool key: pool.slots.<host>.<kind>, pool.fallback.<alias>, pool.gate-host.<host>, `
    + 'pool.budget.<host>.<threads|mem-gb|reserve-threads|reserve-mem-gb|max-load>, pool.envelope.<kind>.<threads|mem-gb>, pool.harness-share-pct or pool.mode');
};

/** Values the remote keys must hold, checked at write time so a bad one never reaches a create. */
const checkRemoteValue = (key: string, value: string, state: IFleetConfigState): void => {
  if (key === REMOTE_CALLBACK_URL_KEY) {
    const refusal = callbackUrlRefusal(value, parseCallbackAllowHosts(valueOf(state, REMOTE_CALLBACK_ALLOW_HOSTS_KEY)?.value));
    if (refusal) throw new FleetConfigError('config-invalid', refusal);
  }
  if (key === REMOTE_CALLBACK_ALLOW_HOSTS_KEY) {
    const bad = value.split(',').map((h) => h.trim()).filter((h) => h && !isValidBareHostName(h));
    if (bad.length) throw new FleetConfigError('config-invalid', `${REMOTE_CALLBACK_ALLOW_HOSTS_KEY} takes bare lower-case host names (a letter first): ${bad.join(', ')}`);
  }
  if (key === REMOTE_HOSTS_KEY) {
    const bad = value.split(',').map((h) => h.trim()).filter((h) => h && !isValidRemoteHostName(h));
    if (bad.length) throw new FleetConfigError('config-invalid', `${REMOTE_HOSTS_KEY} names that are not ssh aliases: ${bad.join(', ')}`);
    if (value.split(',').some((h) => h.trim() === 'auto')) throw new FleetConfigError('config-invalid', `${REMOTE_HOSTS_KEY} cannot name a host "auto": \`tab create --host auto\` asks the pool (ADR-0039)`);
  }
  if (key === REMOTE_TIMEOUT_KEY || key.startsWith(`${REMOTE_TIMEOUT_KEY}.`)) {
    const host = key.slice(REMOTE_TIMEOUT_KEY.length + 1);
    if (key !== REMOTE_TIMEOUT_KEY && !isValidRemoteHostName(host)) {
      throw new FleetConfigError('config-invalid', `${key} is not a timeout key: ${REMOTE_TIMEOUT_KEY} or ${REMOTE_TIMEOUT_KEY}.<ssh alias>`);
    }
    const refusal = remoteTimeoutRefusal(key, value);
    if (refusal) throw new FleetConfigError('config-invalid', refusal);
  }
};

/** The curator's keys (ADR-0038): routing opts in per workspace; a call gap in ms; an off switch. */
const checkCuratorValue = (key: string, value: string): void => {
  if (!key.startsWith('curator.')) return;
  const text = value.trim();
  if (key === 'curator.routing.workspaces') {
    const bad = text.split(',').map((ws) => ws.trim()).filter((ws) => ws && !/^ws-[A-Za-z0-9_-]+$/.test(ws));
    if (bad.length) throw new FleetConfigError('config-invalid', `${key} takes workspace ids (ws-...), comma-separated: ${bad.join(', ')}`);
    return;
  }
  if (key === 'curator.min-interval-ms') {
    if (!/^\d{1,6}$/.test(text) || Number(text) > 600_000) throw new FleetConfigError('config-invalid', `${key} must be whole milliseconds 0..600000, got ${JSON.stringify(value)}`);
    return;
  }
  if (key === 'curator.enabled') {
    if (text !== 'on' && text !== 'off') throw new FleetConfigError('config-invalid', `${key} must be on or off, got ${JSON.stringify(value)}`);
    return;
  }
  if (key === 'curator.standing-order.candidates') {
    if (text === 'none') return;
    const bad = text.split(',').map((pair) => pair.trim()).filter((pair) => pair && !/^ws-[A-Za-z0-9_-]+=\S(?:.*\S)?$/.test(pair));
    if (bad.length) {
      throw new FleetConfigError('config-invalid', `${key} takes ws-...=<tab name> pairs, comma-separated, or none: ${bad.join(', ')}. `
        + 'A value replaces the default ws-ldhziO=v2-scrum-master: keep that pair in it, or treasury-v2 files SO-n');
    }
    return;
  }
  throw new FleetConfigError('config-invalid',
    `${key} is not a curator key: curator.routing.workspaces, curator.min-interval-ms, curator.enabled or curator.standing-order.candidates`);
};

/** The standup key (story hfl2-10): minutes in [0, 1440], decimals allowed, 0 turning the due line off. */
const checkStandupValue = (key: string, value: string): void => {
  if (!key.startsWith('standup.')) return;
  if (key !== STANDUP_DUE_CONFIG_KEY) throw new FleetConfigError('config-invalid', `${key} is not a standup key: ${STANDUP_DUE_CONFIG_KEY}`);
  if (parseStandupDueMinutes(value) === null) {
    throw new FleetConfigError('config-invalid', `${key} must be minutes 0..1440 (0 turns the due line off), got ${JSON.stringify(value)}`);
  }
};

/** The alarm keys (ADR-HFL-03 decision 1): a route table parses whole; a threshold names a producer reason and holds minutes or `off`. */
const checkLedgerValue = (key: string, value: string): void => {
  if (key.startsWith(LEDGER_ALARM_KEYS.routePrefix)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key.slice(LEDGER_ALARM_KEYS.routePrefix.length))) {
      throw new FleetConfigError('config-invalid', `${key} names no workspace: ledger.route.<workspaceId>`);
    }
    const { error } = parseRouteTable(value);
    if (error) throw new FleetConfigError('config-invalid', `${key}: ${error}`);
    return;
  }
  if (key.startsWith(LEDGER_ALARM_KEYS.thresholdPrefix)) {
    const reason = key.slice(LEDGER_ALARM_KEYS.thresholdPrefix.length);
    if (!(LEDGER_WAIT_REASONS as readonly string[]).includes(reason)) {
      throw new FleetConfigError('config-invalid', `${key} names no wait reason: ledger.threshold.<${LEDGER_WAIT_REASONS.join('|')}>`);
    }
    const parsed = parseThresholdValue(value);
    if ('error' in parsed) throw new FleetConfigError('config-invalid', `${key} ${parsed.error}`);
  }
};

const requireWriter = async (caller: ICaller, authority: IFleetConfigAuthority, key: string): Promise<void> => {
  if (caller.admin) return;
  if (ADMIN_ONLY_KEYS.test(key)) throw new FleetConfigError('forbidden', `${key} is written by the admin token only (ADR-0022, ADR-0027, ADR-0037)`);
  if (caller.workspaceId && caller.tabId && (await authority.isWorkspaceOrchestrator(caller.workspaceId, caller.tabId))) return;
  throw new FleetConfigError('forbidden', "fleet config is written by the admin token or the workspace's enabled orchestrator tab");
};

/** No broadcast, no nudge, no inbox notice (ADR-0019): tools read the value at call time. */
const audit = (change: IFleetConfigChange, caller: ICaller): Promise<boolean> =>
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
  const { state, change } = await mutateFleetConfig((s) => {
    checkRemoteValue(key, value, s);
    checkPoolValue(key, value);
    checkTabCapValue(key, value);
    checkLedgerValue(key, value);
    checkCuratorValue(key, value);
    checkStandupValue(key, value);
    return setValue(s, { key, value, expectedVersion }, setterOf(caller), authority.now());
  });
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
