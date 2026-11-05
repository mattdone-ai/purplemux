import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type {
  IFleetConfigChange,
  IFleetConfigSetter,
  IFleetConfigState,
  IFleetConfigValue,
  TFleetConfigErrorCode,
} from '@/types/fleet-config';

// Fleet config (ADR-0019): versioned string values that tools read at call time,
// so a change needs no message to anyone. Pure transitions first, then the one
// file store. This is not ~/.purplemux/config.json, which holds the UI settings
// and the auth secrets.

export class FleetConfigError extends Error {
  constructor(readonly code: TFleetConfigErrorCode, message: string) {
    super(message);
  }
}

/** The store file is unreadable or malformed: every read and write is refused until it is repaired. */
export class FleetConfigFileError extends Error {
  readonly code = 'config-store-unreadable';
}

// A workspace id (`ws-` + nanoid) carries upper case and `_` and may close a key (`tabs.cap-per-workspace.<id>`).
export const FLEET_KEY = /^[a-z][A-Za-z0-9._-]{1,63}$/;
export const FLEET_VALUE_MAX = 256;
export const FLEET_HISTORY_MAX = 200;

export const emptyFleetConfig = (): IFleetConfigState => ({ values: {}, versions: {}, history: [] });

export const checkKey = (raw: unknown): string => {
  if (typeof raw !== 'string' || !FLEET_KEY.test(raw)) {
    throw new FleetConfigError('config-invalid', `key must match ${FLEET_KEY.source}, got ${JSON.stringify(raw)}`);
  }
  return raw;
};

/**
 * A value is one line of text a caller parses. Control, format, surrogate,
 * private-use and unassigned characters (\p{C}) and the Unicode line and
 * paragraph separators are refused, not cleaned: a tool reading `config get`
 * must see exactly what was set (review round 1).
 */
export const checkValue = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw === '') throw new FleetConfigError('config-invalid', 'value must be non-empty text (use unset to remove a key)');
  const length = [...raw].length;
  if (length > FLEET_VALUE_MAX) throw new FleetConfigError('config-invalid', `value is ${length} characters; the limit is ${FLEET_VALUE_MAX}`);
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(raw)) throw new FleetConfigError('config-invalid', 'value must be one line of printable text (no control, format or separator characters)');
  return raw;
};

/** Absent means "no precondition"; otherwise a whole number, 0 meaning "never set". */
export const checkExpectedVersion = (raw: unknown): number | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    throw new FleetConfigError('config-invalid', `expectedVersion must be a whole number, got ${JSON.stringify(raw)}`);
  }
  return raw;
};

// Own-property lookups only: `constructor` is a valid key, and plain indexing would find the
// built-in Object on the store's plain objects (final confirmation).
export const versionOf = (state: IFleetConfigState, key: string): number =>
  (Object.hasOwn(state.versions, key) ? state.versions[key] : 0);

export const valueOf = (state: IFleetConfigState, key: string): IFleetConfigValue | null =>
  (Object.hasOwn(state.values, key) ? state.values[key] : null);

const requireVersion = (state: IFleetConfigState, key: string, expected: number | undefined): void => {
  const current = versionOf(state, key);
  if (expected !== undefined && expected !== current) {
    throw new FleetConfigError('config-version-conflict', `${key} is at version ${current}; expected ${expected}`);
  }
};

const record = (state: IFleetConfigState, change: IFleetConfigChange, value: IFleetConfigValue | null): IFleetConfigState => {
  const values = { ...state.values };
  if (value) values[change.key] = value;
  else delete values[change.key];
  return {
    values,
    versions: { ...state.versions, [change.key]: change.version },
    history: [...state.history, change].slice(-FLEET_HISTORY_MAX),
  };
};

export interface IFleetConfigResult {
  state: IFleetConfigState;
  /** null when the call changed nothing (the value was already set). */
  change: IFleetConfigChange | null;
}

/** Setting the value a key already holds is not a change: no version, no history, no audit. */
export const setValue = (
  state: IFleetConfigState,
  input: { key: string; value: string; expectedVersion?: number },
  by: IFleetConfigSetter,
  now: number,
): IFleetConfigResult => {
  requireVersion(state, input.key, input.expectedVersion);
  const old = valueOf(state, input.key);
  if (old?.value === input.value) return { state, change: null };
  const version = versionOf(state, input.key) + 1;
  const change: IFleetConfigChange = { key: input.key, oldValue: old?.value ?? null, newValue: input.value, version, at: now, by };
  return { state: record(state, change, { value: input.value, version, setAt: now, setBy: by }), change };
};

export const unsetValue = (
  state: IFleetConfigState,
  input: { key: string; expectedVersion?: number },
  by: IFleetConfigSetter,
  now: number,
): IFleetConfigResult => {
  const old = valueOf(state, input.key);
  if (!old) throw new FleetConfigError('config-not-found', `${input.key} is not set`);
  requireVersion(state, input.key, input.expectedVersion);
  const change: IFleetConfigChange = { key: input.key, oldValue: old.value, newValue: null, version: versionOf(state, input.key) + 1, at: now, by };
  return { state: record(state, change, null), change };
};

// ─── the file store ───────────────────────────────────────────────────────

const g = globalThis as unknown as { __ptFleetConfigLock?: Promise<void> };
if (!g.__ptFleetConfigLock) g.__ptFleetConfigLock = Promise.resolve();

export const fleetConfigFile = (): string => path.join(os.homedir(), '.purplemux', 'fleet-config.json');

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => { release = r; });
  const prev = g.__ptFleetConfigLock!;
  g.__ptFleetConfigLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const isValue = (v: unknown): v is IFleetConfigValue =>
  isRecord(v) && typeof v.value === 'string' && Number.isSafeInteger(v.version) && isRecord(v.setBy);

/** Absent file = nothing set; a malformed value, version or history entry is refused, never read as empty. */
export const readFleetConfig = async (): Promise<IFleetConfigState> => {
  const file = fleetConfigFile();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFleetConfig();
    throw new FleetConfigFileError(`${file} is unreadable: ${err instanceof Error ? err.message : err}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  // The next write would erase whatever a malformed file still holds.
  const refuse = (why: string) => new FleetConfigFileError(`${file} ${why}; fleet config is refused until it is repaired or moved aside`);
  if (!isRecord(parsed) || !isRecord(parsed.values) || !isRecord(parsed.versions) || !Array.isArray(parsed.history)) {
    throw refuse('is not { values, versions, history }');
  }
  const bad = Object.entries(parsed.values).find(([k, v]) => !FLEET_KEY.test(k) || !isValue(v));
  if (bad) throw refuse(`has a malformed value for ${JSON.stringify(bad[0])}`);
  // Every set key has a version at least its value's, and every version is a whole number: a
  // hand-edited "4" would make the next version "41", a missing one would repeat a version.
  const versions = parsed.versions as Record<string, unknown>;
  const badVersion = Object.entries(versions).find(([k, v]) => !FLEET_KEY.test(k) || !Number.isSafeInteger(v) || (v as number) < 0)
    ?? Object.entries(parsed.values as Record<string, IFleetConfigValue>).find(([k, v]) => !Object.hasOwn(versions, k) || !Number.isSafeInteger(versions[k]) || (versions[k] as number) < v.version);
  if (badVersion) throw refuse(`has a malformed version for ${JSON.stringify(badVersion[0])}`);
  if (parsed.history.some((c) => !isRecord(c) || typeof c.key !== 'string' || !Number.isSafeInteger(c.version))) throw refuse('has a malformed history entry');
  return parsed as unknown as IFleetConfigState;
};

const writeFleetConfig = async (state: IFleetConfigState): Promise<void> => {
  const file = fleetConfigFile();
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

/** Read, transform, write under the one fleet-config lock; an unchanged state is not written. */
export const mutateFleetConfig = (fn: (state: IFleetConfigState) => IFleetConfigResult): Promise<IFleetConfigResult> =>
  withLock(async () => {
    const before = await readFleetConfig();
    const result = fn(before);
    if (result.state !== before) await writeFleetConfig(result.state);
    return result;
  });
