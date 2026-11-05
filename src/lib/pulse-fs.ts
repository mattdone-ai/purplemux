import { readFileSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';

// The pulse's filesystem calls (ADR-0034 §9, story 12 architect CONCERN C1). Node's async fs runs
// on a libuv threadpool of 4 workers shared by the whole server (tab status, session parsing,
// static files). A read on an sshfs mount that hangs keeps its worker blocked in the kernel even
// after the caller's deadline abandons the promise, so unbounded pulse reads on the `_output` mount
// could pin every worker while ai-server is unreachable. Paths under a `fuse.sshfs` mount therefore
// go through one process-wide limiter (at most 2 in flight, a slot freed only when the call
// returns) and a breaker per mount (after a timeout no new read is issued there until one probe
// `stat` of the mount returns). Local paths are called directly.

export const PULSE_FS_MAX_IN_FLIGHT = 2;
/** An issued call slower than this, timed from when it left the queue, opens its mount's breaker. */
export const PULSE_FS_CALL_TIMEOUT_MS = 5_000;
/** A call still queued after this is never issued and fails "busy"; a wait in the queue never opens the breaker. */
export const PULSE_FS_QUEUE_TIMEOUT_MS = 5_000;
/**
 * The mount list is re-read when older than this (confirm r2, F1): the server may start before the sshfs mount
 * is up, or the mount unit may remount it. Reading `/proc/mounts` never touches the sshfs mount itself.
 */
export const PULSE_FS_MOUNTS_TTL_MS = 60_000;

/** The mount could not serve the read now; never absence (`orAbsent` rethrows it). */
export class PulseFsUnavailableError extends Error {}

/** A mount the breaker holds open: the sources that read it are "not measured: <mount> not answering since <time>". */
export class MountNotAnsweringError extends PulseFsUnavailableError {
  readonly mount: string;
  readonly since: number;

  constructor(mount: string, since: number) {
    super(`${mount} not answering since ${new Date(since).toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
    this.name = 'MountNotAnsweringError';
    this.mount = mount;
    this.since = since;
  }
}

/** Both slots stayed busy for the whole queue timeout: the call was never issued, and the mount is not judged (F2). */
export class MountBusyError extends PulseFsUnavailableError {
  readonly mount: string;

  constructor(mount: string) {
    super(`${mount} busy: no read slot free in ${Math.round(state.queueTimeoutMs / 100) / 10} s`);
    this.name = 'MountBusyError';
    this.mount = mount;
  }
}

interface IBreaker {
  openSince: number | null;
  probing: boolean;
}

interface IPulseFsState {
  inFlight: number;
  waiters: Array<() => void>;
  breakers: Map<string, IBreaker>;
  mounts: string[] | null;
  mountsReadAt: number;
  readMounts: () => string;
  now: () => number;
  callTimeoutMs: number;
  queueTimeoutMs: number;
  /** Calls issued on guarded mounts, per mount, since the last reset: the measure of what the pulse costs a mount. */
  issued: Map<string, number>;
}

const readProcMounts = (): string => readFileSync('/proc/mounts', 'utf8');

const g = globalThis as unknown as { __ptPulseFs?: IPulseFsState };
if (!g.__ptPulseFs) {
  g.__ptPulseFs = {
    inFlight: 0, waiters: [], breakers: new Map(), mounts: null, mountsReadAt: 0, readMounts: readProcMounts, now: Date.now,
    callTimeoutMs: PULSE_FS_CALL_TIMEOUT_MS, queueTimeoutMs: PULSE_FS_QUEUE_TIMEOUT_MS, issued: new Map(),
  };
}
const state = g.__ptPulseFs;

/** `/proc/mounts` lines of type `fuse.sshfs`: their mount points (octal escapes decoded). */
export const parseSshfsMounts = (text: string): string[] =>
  text.split('\n').flatMap((line) => {
    const [, point, type] = line.split(' ');
    return type === 'fuse.sshfs' && point ? [point.replace(/\\(\d{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)))] : [];
  });

const mounts = (): string[] => {
  const now = state.now();
  if (state.mounts === null || now - state.mountsReadAt >= PULSE_FS_MOUNTS_TTL_MS) {
    try {
      state.mounts = parseSshfsMounts(state.readMounts());
    } catch {
      // Unreadable: keep the last list (none before the first read), retried at the next period.
      state.mounts ??= [];
    }
    state.mountsReadAt = now;
  }
  return state.mounts;
};

/** The guarded mount a path lies under (the longest match), or null for a local path. */
export const mountOf = (target: string): string | null => {
  const resolved = path.resolve(target);
  let best: string | null = null;
  for (const point of mounts()) {
    if ((resolved === point || resolved.startsWith(`${point}/`)) && (best === null || point.length > best.length)) best = point;
  }
  return best;
};

const breakerOf = (mount: string): IBreaker => {
  let breaker = state.breakers.get(mount);
  if (!breaker) state.breakers.set(mount, breaker = { openSince: null, probing: false });
  return breaker;
};

const TIMED_OUT = 'pulse fs call timed out';
const timeoutError = (): Error => new Error(TIMED_OUT);
const QUEUED = 'pulse fs queue timed out';

/** Open the mount's breaker (once) and name it: every later read there is refused until a probe returns. */
const notAnswering = (mount: string): MountNotAnsweringError => {
  const breaker = breakerOf(mount);
  if (breaker.openSince === null) breaker.openSince = Date.now();
  return new MountNotAnsweringError(mount, breaker.openSince);
};

/** A slot within the call timeout, or a timeout: a call that never got a slot is never issued. */
const acquire = (): Promise<void> => new Promise((resolve, reject) => {
  if (state.inFlight < PULSE_FS_MAX_IN_FLIGHT) {
    state.inFlight += 1;
    resolve();
    return;
  }
  let waiting = true;
  const grant = () => {
    if (!waiting) return;
    waiting = false;
    clearTimeout(timer);
    state.inFlight += 1;
    resolve();
  };
  const timer = setTimeout(() => {
    waiting = false;
    state.waiters = state.waiters.filter((waiter) => waiter !== grant);
    reject(new Error(QUEUED));
  }, state.queueTimeoutMs);
  timer.unref?.();
  state.waiters.push(grant);
});

const release = (): void => {
  state.inFlight -= 1;
  state.waiters.shift()?.();
};

/**
 * Run one fs call under the limiter. The slot is held until the call itself settles, however long
 * after the caller stopped waiting; past the timeout the caller gets an error and the mount's
 * breaker opens.
 */
const issue = async <T>(mount: string, call: () => Promise<T>): Promise<T> => {
  try {
    await acquire();
  } catch {
    // Only the queue waited: the mount may be slow but healthy (a cold start), so it is busy, not "not answering" (F2).
    throw new MountBusyError(mount);
  }
  state.issued.set(mount, (state.issued.get(mount) ?? 0) + 1);
  const pending = call();
  void pending.then(release, release);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), state.callTimeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, deadline]);
  } catch (err) {
    if (err instanceof Error && err.message === TIMED_OUT) throw notAnswering(mount);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

/** While a mount's breaker is open, one probe `stat` of the mount at a time; it closes the breaker when it returns. */
const probe = (mount: string, breaker: IBreaker): void => {
  if (breaker.probing) return;
  breaker.probing = true;
  issue(mount, () => fs.stat(mount)).then(() => {
    breaker.openSince = null;
  }, () => undefined).finally(() => {
    breaker.probing = false;
  });
};

const guarded = async <T>(target: string, call: () => Promise<T>): Promise<T> => {
  const mount = mountOf(target);
  if (!mount) return call();
  const breaker = breakerOf(mount);
  if (breaker.openSince !== null) {
    probe(mount, breaker);
    throw new MountNotAnsweringError(mount, breaker.openSince);
  }
  return issue(mount, call);
};

/** A fallback for an absent path (ENOENT and the like), never for a mount that does not answer: that is not absence. */
export const orAbsent = <T>(fallback: T) => (err: unknown): T => {
  if (err instanceof PulseFsUnavailableError) throw err;
  return fallback;
};

export const pulseFs = {
  stat: (target: string) => guarded(target, () => fs.stat(target)),
  readdir: (target: string) => guarded(target, () => fs.readdir(target)),
  readdirTypes: (target: string) => guarded(target, () => fs.readdir(target, { withFileTypes: true })),
  readFile: (target: string) => guarded(target, () => fs.readFile(target, 'utf8')),
  /** The last `bytes` of a file: open, stat and read under one slot, the handle always closed. */
  tail: (target: string, bytes: number) => guarded(target, async () => {
    const handle = await fs.open(target, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  }),
};

/** Calls issued on each guarded mount since the last reset (for measurement). */
export const pulseFsIssued = (): ReadonlyMap<string, number> => state.issued;
export const resetPulseFsIssued = (): void => state.issued.clear();

/**
 * Tests only: the guarded mounts, either fixed (`mounts`) or read from `readMounts` (a `/proc/mounts` text) on the
 * real 60 s period against `now`; and short timeouts.
 */
export const configurePulseFsForTests = (options: {
  mounts?: string[]; readMounts?: () => string; now?: () => number; callTimeoutMs?: number; queueTimeoutMs?: number;
}): void => {
  state.readMounts = options.readMounts ?? readProcMounts;
  state.now = options.now ?? Date.now;
  state.mounts = options.mounts ? options.mounts.map((mount) => path.resolve(mount)) : null;
  state.mountsReadAt = options.mounts ? Number.POSITIVE_INFINITY : 0;
  state.callTimeoutMs = options.callTimeoutMs ?? PULSE_FS_CALL_TIMEOUT_MS;
  state.queueTimeoutMs = options.queueTimeoutMs ?? options.callTimeoutMs ?? PULSE_FS_QUEUE_TIMEOUT_MS;
  state.breakers.clear();
  state.issued.clear();
};

export const pulseFsInFlight = (): number => state.inFlight;

export const resetPulseFsForTests = (): void => {
  state.mounts = null;
  state.mountsReadAt = 0;
  state.readMounts = readProcMounts;
  state.now = Date.now;
  state.callTimeoutMs = PULSE_FS_CALL_TIMEOUT_MS;
  state.queueTimeoutMs = PULSE_FS_QUEUE_TIMEOUT_MS;
  state.breakers.clear();
  state.issued.clear();
};
