import { STOP_PAYLOAD_CONFIG_KEY, TURN_END_SOURCE_CONFIG_KEY } from '@/lib/turn-end-row';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ICaller } from '@/lib/caller';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { ACTION_REASON_MAX, actionReason } from '@/lib/human-actions';
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
import { CHAIN_HOLDS_PREFIX, chainHoldsPathError } from '@/lib/chain-down-quiet';
import { LEDGER_WAIT_REASONS } from '@/lib/ledger';
import { leaseAuthority } from '@/lib/lease-http';
import { createLogger } from '@/lib/logger';
import { POOL_MODE_KEY, POOL_TAB_PLACE_MODES, TAB_PLACE_KEY, isPoolMode, isPoolNumberKey, isTabPlaceMode, poolNumberRefusal } from '@/lib/pool';
import { currentScrumMasterSelection, sameSelection, scrumMasterSnapshot, type IScrumMasterSnapshot } from '@/lib/scrum-master-access';
import type { IFleetConfigChange, IFleetConfigSetter, IFleetConfigState, IFleetConfigValue } from '@/types/fleet-config';
import {
  REMOTE_CALLBACK_ALLOW_HOSTS_KEY, REMOTE_CALLBACK_URL_KEY, REMOTE_HOSTS_KEY, REMOTE_TAILNET_SUFFIX_KEY, callbackUrlRefusal,
  isValidBareHostName, isValidRemoteHostName, isValidTailnetSuffix, parseCallbackAllowHosts, parseRemoteHosts, scrumMasterCallbackRefusal,
} from '@/lib/remote-host';
import { REMOTE_TIMEOUT_KEY, remoteTimeoutRefusal } from '@/lib/remote-timeouts';

const log = createLogger('fleet-config');

export interface IFleetConfigAuthority {
  isWorkspaceOrchestrator: (workspaceId: string, tabId: string) => Promise<boolean>;
  now: () => number;
  /** The selection that makes the caller the Portfolio Scrum Master (ADR-0045), else null; absent: no caller is. */
  scrumMaster?: (caller: ICaller) => Promise<IScrumMasterSnapshot | null>;
  /** The current selection, read synchronously inside the store lock; absent: no selection. */
  currentSelection?: () => IScrumMasterSnapshot | null;
}

const defaultAuthority: IFleetConfigAuthority = {
  isWorkspaceOrchestrator: leaseAuthority.isWorkspaceOrchestrator,
  now: () => Date.now(),
  scrumMaster: (caller) => scrumMasterSnapshot(caller.scope),
  currentSelection: currentScrumMasterSelection,
};

/** Who wrote a value and on what authority: the store's setter, the reason and, for the Portfolio Scrum Master, its selection. */
interface IWriter {
  setter: IFleetConfigSetter;
  reason: string | null;
  scrumMaster: { snapshot: IScrumMasterSnapshot; workspaceId: string | null } | null;
}

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
 * not set for every other workspace (ADR-0027 ruling R2). `standup.` stays here: since F6 no such key is read,
 * and every write of one is refused.
 */
export const ADMIN_ONLY_KEYS = /^(remote|tabs|attention|alerts|mission|pool|curator|standup|hook|turn-end|ledger\.chain-holds)\./;

const POOL_SLOTS_KEY = /^pool\.slots\.[a-z0-9._-]+\.(gate|build|mutation|browser|test-service|tab)$/;

/**
 * What the Portfolio Scrum Master's verified tab may write besides the admin token (ADR-0045): the WIP cap and the
 * plain-create mode of a workspace in its selection, a host's tab ceiling, and (ADR-0047, owner order) a known host's
 * callback URL, whose value names the tailnet only (`checkScrumMasterValue`). Not `pool.mode`, the gate and build
 * slots, the fleet-wide cap, `remote.tailnet-suffix`, `remote.hosts`, nor any reserve, budget or envelope key: those
 * stay with the admin token.
 */
const SCRUM_MASTER_KEYS: readonly { re: RegExp; workspace: boolean }[] = [
  { re: /^tabs\.cap-per-workspace\.([A-Za-z0-9_-]+)$/, workspace: true },
  { re: TAB_PLACE_KEY, workspace: true },
  { re: /^pool\.slots\.[a-z0-9._-]+\.tab$/, workspace: false },
  { re: /^remote\.callback-url\.[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/, workspace: false },
];

export const SCRUM_MASTER_KEY_FORMS = 'tabs.cap-per-workspace.<workspaceId>, pool.tab-place.<workspaceId> (a workspace in the portfolio selection), '
  + 'pool.slots.<host>.tab or remote.callback-url.<host> (a host on remote.hosts, a tailnet URL)';

/** The key's Scrum Master form, and the workspace it names; null when the Scrum Master may not write it. */
export const scrumMasterKey = (key: string): { workspaceId: string | null } | null => {
  for (const form of SCRUM_MASTER_KEYS) {
    const m = form.re.exec(key);
    if (m) return { workspaceId: form.workspace ? m[1] : null };
  }
  return null;
};

export const REASON_MAX = ACTION_REASON_MAX;

/**
 * Why a write was refused, as the audit names it (ADR-0045 review r1): a refusal of the writer rule has its own kind;
 * any other refusal takes the kind of its code.
 */
export type TWriteRefusal =
  | 'admin-only' | 'not-scrum-master' | 'outside-selection' | 'reason-missing' | 'reason-invalid' | 'version-missing'
  | 'selection-changed' | 'not-writer' | 'version-conflict' | 'invalid' | 'not-found' | 'forbidden'
  | 'unknown-host' | 'outside-tailnet';

/** A writer-rule refusal: the store's error, with its kind and the selection it was judged on (when one was). */
class WriteRefusal extends FleetConfigError {
  constructor(
    code: ConstructorParameters<typeof FleetConfigError>[0],
    readonly refusal: TWriteRefusal,
    message: string,
    readonly snapshot: IScrumMasterSnapshot | null = null,
  ) {
    super(code, message);
  }
}

const refusalOf = (err: FleetConfigError): TWriteRefusal => {
  if (err instanceof WriteRefusal) return err.refusal;
  if (err.code === 'config-version-conflict') return 'version-conflict';
  if (err.code === 'config-invalid') return 'invalid';
  if (err.code === 'config-not-found') return 'not-found';
  return 'forbidden';
};

/** `reason` (ADR-0045): when given, trimmed and 1..500 code points (`actionReason`, ADR-0047); null when absent. */
const checkReason = (raw: unknown): string | null => {
  if (raw === undefined || raw === null) return null;
  const reason = actionReason(raw);
  if (reason === null) {
    throw new WriteRefusal('config-invalid', 'reason-invalid', `reason must be 1..${REASON_MAX} characters, got ${JSON.stringify(raw)}`);
  }
  return reason;
};
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
  if (TAB_PLACE_KEY.test(key)) {
    if (!isTabPlaceMode(value.trim())) throw new FleetConfigError('config-invalid', `${key} must be ${POOL_TAB_PLACE_MODES.join(', ')}, got ${JSON.stringify(value)}`);
    return;
  }
  throw new FleetConfigError('config-invalid', `${key} is not a pool key: pool.slots.<host>.<kind>, pool.fallback.<alias>, pool.gate-host.<host>, `
    + 'pool.budget.<host>.<threads|mem-gb|reserve-threads|reserve-mem-gb|max-load>, pool.envelope.<kind>.<threads|mem-gb>, pool.harness-share-pct, pool.path.slow-ms, '
    + 'pool.tab-place.<workspaceId> or pool.mode');
};

/** Values the remote keys must hold, checked at write time so a bad one never reaches a create. */
const checkRemoteValue = (key: string, value: string, state: IFleetConfigState): void => {
  if (key === REMOTE_CALLBACK_URL_KEY || key.startsWith(`${REMOTE_CALLBACK_URL_KEY}.`)) {
    const host = key.slice(REMOTE_CALLBACK_URL_KEY.length + 1);
    if (key !== REMOTE_CALLBACK_URL_KEY && !isValidRemoteHostName(host)) {
      throw new FleetConfigError('config-invalid', `${key} is not a callback key: ${REMOTE_CALLBACK_URL_KEY} or ${REMOTE_CALLBACK_URL_KEY}.<ssh alias>`);
    }
    const refusal = callbackUrlRefusal(value, parseCallbackAllowHosts(valueOf(state, REMOTE_CALLBACK_ALLOW_HOSTS_KEY)?.value));
    if (refusal) throw new FleetConfigError('config-invalid', key === REMOTE_CALLBACK_URL_KEY ? refusal : `${key}: ${refusal}`);
  }
  if (key === REMOTE_TAILNET_SUFFIX_KEY && !isValidTailnetSuffix(value)) {
    throw new FleetConfigError('config-invalid', `${REMOTE_TAILNET_SUFFIX_KEY} takes a lower-case DNS suffix of two or more labels, not ts.net alone (e.g. example-net.ts.net), got ${JSON.stringify(value)}`);
  }
  if (key === REMOTE_CALLBACK_ALLOW_HOSTS_KEY) {
    const bad = value.split(',').map((h) => h.trim()).filter((h) => h && !isValidBareHostName(h));
    if (bad.length) throw new FleetConfigError('config-invalid', `${REMOTE_CALLBACK_ALLOW_HOSTS_KEY} takes bare lower-case host names (a letter first): ${bad.join(', ')}`);
  }
  if (key === REMOTE_HOSTS_KEY) {
    const bad = value.split(',').map((h) => h.trim()).filter((h) => h && !isValidRemoteHostName(h));
    if (bad.length) throw new FleetConfigError('config-invalid', `${REMOTE_HOSTS_KEY} names that are not ssh aliases: ${bad.join(', ')}`);
    if (value.split(',').some((h) => h.trim() === 'auto')) throw new FleetConfigError('config-invalid', `${REMOTE_HOSTS_KEY} cannot name a host "auto": \`tab create --host auto\` asks the pool (ADR-0039)`);
    if (value.split(',').some((h) => h.trim() === 'local')) throw new FleetConfigError('config-invalid', `${REMOTE_HOSTS_KEY} cannot name a host "local": \`tab create --host local\` is this host (ADR-0045)`);
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
        + 'A value replaces the default ws-ldhziO=v2-scrum-master: keep that pair in it, or acme-ledger-v2 files SO-n');
    }
    return;
  }
  throw new FleetConfigError('config-invalid',
    `${key} is not a curator key: curator.routing.workspaces, curator.min-interval-ms, curator.enabled or curator.standing-order.candidates`);
};

/**
 * No standup key is read (F6): the server's standup due line is deleted, and a coordinator posts its standup from its
 * status file at the end of its own turn. A `standup.*` value would change nothing, so it is refused.
 */
const checkStandupValue = (key: string, _value: string): void => {
  if (!key.startsWith('standup.')) return;
  throw new FleetConfigError('config-invalid', `${key} is not a key: the standup due line (standup.dueMin) was deleted by F6`);
};

/**
 * The F6 kill switches (F10 steps 1-2), admin token only: `turn-end.source` is `row` or `classifier` (the classifier
 * alone, nothing blocked); `hook.stop-payload` is `on` or `off` (the transcript tail again). Unset means row and on.
 */
const TURN_END_KEYS: Readonly<Record<string, readonly string[]>> = {
  [TURN_END_SOURCE_CONFIG_KEY]: ['row', 'classifier'],
  [STOP_PAYLOAD_CONFIG_KEY]: ['on', 'off'],
};
const checkTurnEndValue = (key: string, value: string): void => {
  if (!key.startsWith('hook.') && !key.startsWith('turn-end.')) return;
  const allowed = Object.hasOwn(TURN_END_KEYS, key) ? TURN_END_KEYS[key] : null;
  if (!allowed) throw new FleetConfigError('config-invalid', `${key} is not a key: ${Object.keys(TURN_END_KEYS).join(' or ')}`);
  if (!allowed.includes(value.trim())) {
    throw new FleetConfigError('config-invalid', `${key} must be ${allowed.join(' or ')}, got ${JSON.stringify(value)}`);
  }
};

/** The alarm keys (ADR-HFL-03 decision 1): a route table parses whole; a threshold names a producer reason and holds minutes or `off`. */
const checkLedgerValue = (key: string, value: string): void => {
  if (key.startsWith(CHAIN_HOLDS_PREFIX)) {
    if (!/^[A-Za-z0-9_-]+$/.test(key.slice(CHAIN_HOLDS_PREFIX.length))) {
      throw new FleetConfigError('config-invalid', `${key} names no workspace: ${CHAIN_HOLDS_PREFIX}<workspaceId>`);
    }
    const error = chainHoldsPathError(value);
    if (error) throw new FleetConfigError('config-invalid', `${key} ${error}`);
    return;
  }
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

/**
 * The writer rule (ADR-0019, amended by ADR-0045). The admin token writes every key. An admin-only key is otherwise
 * written only by the Portfolio Scrum Master's verified tab, and only in its forms (`scrumMasterKey`), with a reason
 * and the version it read. Every other key is written by the workspace's enabled orchestrator tab.
 */
const requireWriter = async (caller: ICaller, authority: IFleetConfigAuthority, key: string, body: Record<string, unknown>): Promise<IWriter> => {
  const reason = checkReason(body.reason);
  if (caller.admin) return { setter: setterOf(caller), reason, scrumMaster: null };
  if (ADMIN_ONLY_KEYS.test(key)) {
    const form = scrumMasterKey(key);
    const snapshot = authority.scrumMaster ? await authority.scrumMaster(caller) : null;
    if (!form) {
      throw new WriteRefusal('forbidden', 'admin-only', snapshot
        ? `${key} is written by the admin token only (ADR-0022, ADR-0027, ADR-0037, ADR-0039); the Portfolio Scrum Master writes ${SCRUM_MASTER_KEY_FORMS} (ADR-0045)`
        : `${key} is written by the admin token only (ADR-0022, ADR-0027, ADR-0037, ADR-0039; ADR-0045 lets the Portfolio Scrum Master's verified tab write ${SCRUM_MASTER_KEY_FORMS})`, snapshot);
    }
    if (!snapshot) {
      throw new WriteRefusal('forbidden', 'not-scrum-master', `${key} is written by the admin token or the Portfolio Scrum Master's verified tab (the manager tab of the current portfolio selection, ADR-0045)`);
    }
    if (form.workspaceId && !snapshot.selection.workspaceIds.includes(form.workspaceId)) {
      throw new WriteRefusal('forbidden', 'outside-selection', `${key} names ${form.workspaceId}, which is not in the portfolio selection (${snapshot.selection.workspaceIds.join(', ') || 'none'}); the admin token writes it (ADR-0045)`, snapshot);
    }
    if (reason === null) throw new WriteRefusal('config-invalid', 'reason-missing', `a Portfolio Scrum Master write of ${key} needs a reason (--reason TEXT, 1..${REASON_MAX} characters, ADR-0045)`, snapshot);
    if (body.expectedVersion === undefined || body.expectedVersion === null) {
      throw new WriteRefusal('config-invalid', 'version-missing', `a Portfolio Scrum Master write of ${key} needs the version it read (--expect-version N: config get KEY --json; 0 only for a key never set, ADR-0045)`, snapshot);
    }
    return { setter: { ...setterOf(caller), role: 'portfolio-scrum-master' }, reason, scrumMaster: { snapshot, workspaceId: form.workspaceId } };
  }
  if (caller.workspaceId && caller.tabId && (await authority.isWorkspaceOrchestrator(caller.workspaceId, caller.tabId))) return { setter: setterOf(caller), reason, scrumMaster: null };
  throw new WriteRefusal('forbidden', 'not-writer', "fleet config is written by the admin token or the workspace's enabled orchestrator tab");
};

/**
 * A Portfolio Scrum Master's value (ADR-0047), inside the store lock: a callback URL names a host on `remote.hosts` and
 * the tailnet only (`scrumMasterCallbackRefusal`). The admin token never reaches this check.
 */
const checkScrumMasterValue = (writer: IWriter, key: string, value: string, state: IFleetConfigState): void => {
  if (!writer.scrumMaster || !key.startsWith(`${REMOTE_CALLBACK_URL_KEY}.`)) return;
  const { snapshot } = writer.scrumMaster;
  const host = key.slice(REMOTE_CALLBACK_URL_KEY.length + 1);
  const hosts = parseRemoteHosts(valueOf(state, REMOTE_HOSTS_KEY)?.value);
  if (!hosts.includes(host)) {
    throw new WriteRefusal('config-invalid', 'unknown-host', `${key} names ${host}, which is not on ${REMOTE_HOSTS_KEY} (${hosts.join(', ') || 'none'}); the admin token writes it (ADR-0047)`, snapshot);
  }
  const suffix = valueOf(state, REMOTE_TAILNET_SUFFIX_KEY)?.value ?? null;
  const refusal = scrumMasterCallbackRefusal(value, suffix);
  if (refusal) throw new WriteRefusal('config-invalid', 'outside-tailnet', `${key}: ${refusal} (ADR-0047)`, snapshot);
};

/**
 * Inside the store lock (ADR-0045, ruling 5): the selection the write was authorized on must still be the current one,
 * and must still name the key's workspace. The coordinator proof itself (a file read and a tmux check) ran before the
 * lock; a respawn of the manager tab between that proof and this compare is the remaining gap the ADR states.
 */
const recheckScrumMaster = (writer: IWriter, authority: IFleetConfigAuthority, key: string): void => {
  if (!writer.scrumMaster) return;
  const now = authority.currentSelection?.() ?? null;
  const { snapshot, workspaceId } = writer.scrumMaster;
  if (!sameSelection(now, snapshot) || (workspaceId && !now!.selection.workspaceIds.includes(workspaceId))) {
    throw new WriteRefusal('forbidden', 'selection-changed', `the portfolio selection changed while ${key} was written; nothing was written (ADR-0045)`, snapshot);
  }
};

/** No broadcast, no nudge, no inbox notice (ADR-0019): tools read the value at call time. */
const audit = (change: IFleetConfigChange, caller: ICaller, writer: IWriter): Promise<boolean> =>
  appendCoordinationAudit({
    event: change.newValue === null ? 'fleet-config-unset' : 'fleet-config-set',
    key: change.key,
    oldValue: change.oldValue,
    newValue: change.newValue,
    version: change.version,
    ...(writer.reason ? { reason: writer.reason } : {}),
    by: { ...writer.setter, verified: caller.admin ? false : caller.verified, identity: caller.admin ? 'none' : caller.identity },
    ...(writer.scrumMaster ? { selection: selectionOf(writer.scrumMaster.snapshot) } : {}),
  });

const selectionOf = (snapshot: IScrumMasterSnapshot) => ({
  actor: snapshot.actor,
  updatedAt: snapshot.updatedAt,
  managerWorkspaceId: snapshot.selection.managerWorkspaceId,
  managerTabId: snapshot.selection.managerTabId,
});

/** The caller as an audit line names it: never a token, never a value. */
const byOf = (caller: ICaller, snapshot: IScrumMasterSnapshot | null) => ({
  workspaceId: caller.workspaceId,
  tabId: caller.tabId,
  verified: caller.verified,
  identity: caller.identity,
  ...(snapshot ? { role: 'portfolio-scrum-master' as const } : {}),
});

interface IRefusalContext {
  action: 'set' | 'unset';
  caller: ICaller;
  key: string | null;
  body: Record<string, unknown>;
  writer: IWriter | null;
}

/**
 * Every refused write is audited (ADR-0045 review r1) when a launch-verified tab made it, or when it named a key the
 * Portfolio Scrum Master may write: the caller, the key, the refusal code and kind, and the reason given. The value is
 * never written: a refused value may be anything. The admin token's refusals and an unverified caller's refusal of
 * any other key stay out, as before. The original error is thrown again whatever the audit answers.
 */
const auditRefusal = async (err: unknown, ctx: IRefusalContext): Promise<void> => {
  if (!(err instanceof FleetConfigError) || ctx.caller.admin) return;
  if (!ctx.caller.verified && !(ctx.key !== null && scrumMasterKey(ctx.key) !== null)) return;
  const snapshot = err instanceof WriteRefusal ? err.snapshot : ctx.writer?.scrumMaster?.snapshot ?? null;
  const reason = typeof ctx.body.reason === 'string' ? ctx.body.reason.slice(0, REASON_MAX) : null;
  const expected = ctx.body.expectedVersion;
  await appendCoordinationAudit({
    event: 'fleet-config-refused',
    action: ctx.action,
    key: ctx.key,
    code: err.code,
    refusal: refusalOf(err),
    reason,
    ...(typeof expected === 'number' && Number.isSafeInteger(expected) ? { expectedVersion: expected } : {}),
    by: byOf(ctx.caller, snapshot),
    ...(snapshot ? { selection: selectionOf(snapshot) } : {}),
  });
};

/** A Portfolio Scrum Master set of the value a key already holds: no version, no history, but the reason is kept here. */
const auditUnchanged = (key: string, stored: IFleetConfigValue, caller: ICaller, writer: IWriter): Promise<boolean> =>
  appendCoordinationAudit({
    event: 'fleet-config-unchanged',
    key,
    value: stored.value,
    version: stored.version,
    reason: writer.reason,
    by: byOf(caller, writer.scrumMaster!.snapshot),
    selection: selectionOf(writer.scrumMaster!.snapshot),
  });

export const putValue = async (
  caller: ICaller,
  rawKey: unknown,
  body: Record<string, unknown>,
  authority: IFleetConfigAuthority = defaultAuthority,
): Promise<{ key: string; version: number; value: IFleetConfigValue; changed: boolean }> => {
  const ctx: IRefusalContext = { action: 'set', caller, key: null, body, writer: null };
  try {
    return await setChecked(caller, rawKey, body, authority, ctx);
  } catch (err) {
    await auditRefusal(err, ctx);
    throw err;
  }
};

const setChecked = async (
  caller: ICaller,
  rawKey: unknown,
  body: Record<string, unknown>,
  authority: IFleetConfigAuthority,
  ctx: IRefusalContext,
): Promise<{ key: string; version: number; value: IFleetConfigValue; changed: boolean }> => {
  const key = checkKey(rawKey);
  ctx.key = key;
  const value = checkValue(body.value);
  const expectedVersion = checkExpectedVersion(body.expectedVersion);
  const writer = await requireWriter(caller, authority, key, body);
  ctx.writer = writer;
  const { state, change } = await mutateFleetConfig((s) => {
    recheckScrumMaster(writer, authority, key);
    checkRemoteValue(key, value, s);
    checkScrumMasterValue(writer, key, value, s);
    checkPoolValue(key, value);
    checkTabCapValue(key, value);
    checkLedgerValue(key, value);
    checkCuratorValue(key, value);
    checkStandupValue(key, value);
    checkTurnEndValue(key, value);
    return setValue(s, { key, value, expectedVersion, ...(writer.reason ? { reason: writer.reason } : {}) }, writer.setter, authority.now());
  });
  const stored = valueOf(state, key)!;
  if (change) await audit(change, caller, writer);
  else if (writer.scrumMaster) await auditUnchanged(key, stored, caller, writer);
  return { key, version: stored.version, value: stored, changed: change !== null };
};

export const deleteValue = async (
  caller: ICaller,
  rawKey: unknown,
  body: Record<string, unknown>,
  authority: IFleetConfigAuthority = defaultAuthority,
): Promise<{ key: string; version: number; unset: IFleetConfigChange }> => {
  const ctx: IRefusalContext = { action: 'unset', caller, key: null, body, writer: null };
  try {
    return await unsetChecked(caller, rawKey, body, authority, ctx);
  } catch (err) {
    await auditRefusal(err, ctx);
    throw err;
  }
};

const unsetChecked = async (
  caller: ICaller,
  rawKey: unknown,
  body: Record<string, unknown>,
  authority: IFleetConfigAuthority,
  ctx: IRefusalContext,
): Promise<{ key: string; version: number; unset: IFleetConfigChange }> => {
  const key = checkKey(rawKey);
  ctx.key = key;
  const expectedVersion = checkExpectedVersion(body.expectedVersion);
  const writer = await requireWriter(caller, authority, key, body);
  ctx.writer = writer;
  const { change } = await mutateFleetConfig((s) => {
    recheckScrumMaster(writer, authority, key);
    return unsetValue(s, { key, expectedVersion, ...(writer.reason ? { reason: writer.reason } : {}) }, writer.setter, authority.now());
  });
  await audit(change!, caller, writer);
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
