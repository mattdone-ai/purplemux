import fs from 'fs/promises';
import { emptyFleetConfig, fleetConfigFile, readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { createLogger } from '@/lib/logger';
import type { IFleetConfigState } from '@/types/fleet-config';

const log = createLogger('remote');

/**
 * The ssh budget of one tmux call or host check on a remote host (ADR-0022 §5, vel-D61). Fleet-wide, or for one
 * host with `remote.timeout-ms.<host>`, which wins. Every other remote budget (create, close, transcript, spool,
 * job probe) and ssh's ConnectTimeout scale by the same ratio to the 5 s default, so unset changes nothing.
 */
export const REMOTE_TIMEOUT_KEY = 'remote.timeout-ms';
export const REMOTE_TIMEOUT_DEFAULT_MS = 5_000;
export const REMOTE_TIMEOUT_MAX_MS = 120_000;
/** ADR-0022 §5's ConnectTimeout, in seconds: the attach, which has no call budget. */
export const SSH_CONNECT_TIMEOUT_S = 5;

export const remoteTimeoutKeyFor = (host: string): string => `${REMOTE_TIMEOUT_KEY}.${host}`;

/** Whole milliseconds from the default (the floor) to the maximum, or null. */
export const parseRemoteTimeoutMs = (raw: string | null | undefined): number | null => {
  const text = (raw ?? '').trim();
  if (!/^\d{4,6}$/.test(text)) return null;
  const ms = Number(text);
  return ms >= REMOTE_TIMEOUT_DEFAULT_MS && ms <= REMOTE_TIMEOUT_MAX_MS ? ms : null;
};

export const remoteTimeoutRefusal = (key: string, value: string): string | null =>
  parseRemoteTimeoutMs(value) === null
    ? `${key} must be whole milliseconds ${REMOTE_TIMEOUT_DEFAULT_MS}..${REMOTE_TIMEOUT_MAX_MS} (the ${REMOTE_TIMEOUT_DEFAULT_MS} ms default is the floor), got ${JSON.stringify(value)}`
    : null;

/** The host's budget from a read store: its own key, else the fleet key, else the default. */
export const remoteTimeoutMsIn = (state: IFleetConfigState, host: string): number =>
  parseRemoteTimeoutMs(valueOf(state, remoteTimeoutKeyFor(host))?.value)
  ?? parseRemoteTimeoutMs(valueOf(state, REMOTE_TIMEOUT_KEY)?.value)
  ?? REMOTE_TIMEOUT_DEFAULT_MS;

const UNREADABLE_WARN_GAP_MS = 60_000;
let unreadableWarnedAt = 0;

const gCache = globalThis as unknown as { __ptRemoteTimeoutConfig?: { stamp: string; state: IFleetConfigState } };

/**
 * The fleet store for the ssh budget, read again only when the file changes (review r1 F3): one stat per ssh
 * call, not a read and a parse. The stamp holds the inode, so a write (tmp + rename) is seen even when the
 * filesystem's mtime is coarse.
 */
const fleetConfigForTimeouts = async (): Promise<IFleetConfigState> => {
  const file = fleetConfigFile();
  let stamp: string;
  try {
    const st = await fs.stat(file);
    stamp = `${file}:${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFleetConfig();
    throw err;
  }
  const cached = gCache.__ptRemoteTimeoutConfig;
  if (cached?.stamp === stamp) return cached.state;
  const state = await readFleetConfig();
  gCache.__ptRemoteTimeoutConfig = { stamp, state };
  return state;
};

/**
 * Read at call time (ADR-0019). A store that cannot be read gives the default, never a shorter budget: the call
 * then behaves as it did before this key existed.
 */
export const remoteTimeoutMs = async (host: string): Promise<number> => {
  try {
    return remoteTimeoutMsIn(await fleetConfigForTimeouts(), host);
  } catch (err) {
    if (Date.now() - unreadableWarnedAt > UNREADABLE_WARN_GAP_MS) {
      unreadableWarnedAt = Date.now();
      log.warn({ host, err: err instanceof Error ? err.message : String(err) }, 'fleet config unreadable; remote ssh budgets use the default');
    }
    return REMOTE_TIMEOUT_DEFAULT_MS;
  }
};

export interface IRemoteBudget {
  /** The call's own budget, scaled. */
  timeoutMs: number;
  connectTimeoutS: number;
}

/**
 * A call's budget on this host: `baseMs` is its budget at the default, as the caller names it. ssh's
 * ConnectTimeout stays a second under the call's own budget (review r1 F2), so ssh's connect failure, not the
 * kill, ends a call that cannot connect.
 */
export const remoteBudget = (baseMs: number, hostTimeoutMs: number): IRemoteBudget => {
  const timeoutMs = Math.ceil(baseMs * (hostTimeoutMs / REMOTE_TIMEOUT_DEFAULT_MS));
  return { timeoutMs, connectTimeoutS: Math.max(1, Math.floor(timeoutMs / 1000) - 1) };
};
