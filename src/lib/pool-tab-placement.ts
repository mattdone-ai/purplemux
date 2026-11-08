import { createLogger } from '@/lib/logger';
import type { ITabStartInput, TTabStart } from '@/lib/pool-service';
import type { IPoolEnvelopeView, IPoolQueuedResult, TPoolRefusalReason } from '@/types/pool';

// `tab create --host auto` (ADR-0039 §4, vel-D4). The pool admits a concrete host
// or queues the start; the create then runs the same checks as a `--host H`
// create. A start that fits no host queues: it never falls back to this host.
// Only a FIRST ask, with no ticket, that the pool does not answer in 2 s creates
// the tab here (review r1 F4). Every other failure is an answer, never a create.

const log = createLogger('pool');

export const AUTO_HOST = 'auto';
export const AUTO_PLACE_TIMEOUT_MS = 2_000;

/** The pool did not answer in time: the only failure a first ask may fall back on. */
export class PoolTimeoutError extends Error {
  readonly code = 'pool-timeout' as const;
}

export interface IAutoPlacement {
  host: string;
  local: boolean;
  reason: string;
  /** True when the pool's first answer was not used: no answer in time, or the --cwd missing on the chosen host. */
  fallback: boolean;
  /** What the start reserves; null for a tab with no envelope or an unanswered pool. */
  envelope: IPoolEnvelopeView | null;
}

export interface IAutoHostDeps {
  start: (input: ITabStartInput) => Promise<TTabStart>;
  release: (lease: string | null) => Promise<void>;
  cwdOnHost: (host: string, cwd: string) => Promise<boolean>;
  localName: () => string;
  timeoutMs?: number;
}

export type TAutoHost =
  | {
    kind: 'placed';
    /** undefined for this host, else the remote alias the create then checks as for `--host H`. */
    host: string | undefined;
    /** The cwd was already proven a directory on that host, so the create need not probe it again. */
    cwdChecked?: boolean;
    /** The start's tab lease; the create releases it once the tab is in its layout. */
    lease: string | null;
    placement: IAutoPlacement;
  }
  | { kind: 'queued'; queued: IPoolQueuedResult }
  | { kind: 'refused'; refusal: TPoolRefusalReason; reason: string }
  /** The pool failed or answered too late on an ask that may not fall back: the route answers the error, creates nothing. */
  | { kind: 'failed'; error: unknown };

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PoolTimeoutError(`no pool answer in ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

const fromStart = (started: Exclude<TTabStart, { state: 'admitted' }>): TAutoHost =>
  started.state === 'queued'
    ? { kind: 'queued', queued: started.queued }
    : { kind: 'refused', refusal: started.refusal, reason: started.reason };

export const resolveAutoHost = async (
  input: { panelType: string; role?: string; cwd?: string; class?: unknown; ticket?: unknown },
  deps: IAutoHostDeps,
): Promise<TAutoHost> => {
  const hasTicket = input.ticket !== undefined && input.ticket !== null && input.ticket !== '';
  /** A late answer is given back: no orphan start lease, and no orphan ticket for a waiter that never saw it. */
  const giveBack = async (late: TTabStart, reask: boolean): Promise<void> => {
    if (late.state === 'admitted' && late.lease) {
      log.warn(`tab create --host auto: a late pool answer took ${late.lease}; released`);
      await deps.release(late.lease);
    } else if (late.state === 'queued' && !reask) {
      log.warn(`tab create --host auto: a late pool answer queued ${late.queued.ticket}; released`);
      await deps.release(late.queued.ticket);
    }
  };
  const ask = async (localOnly: boolean): Promise<TTabStart | Error> => {
    const reask = !localOnly && hasTicket;
    const req: ITabStartInput = {
      panelType: input.panelType,
      ...(input.role ? { role: input.role } : {}),
      ...(input.class !== undefined ? { class: input.class } : {}),
      ...(reask ? { ticket: input.ticket } : {}),
      ...(localOnly ? { localOnly: true } : {}),
    };
    const pending = deps.start(req);
    try {
      return await withTimeout(pending, deps.timeoutMs ?? AUTO_PLACE_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof PoolTimeoutError) pending.then((late) => giveBack(late, reask)).catch(() => {});
      return err instanceof Error ? err : new Error(String(err));
    }
  };
  const here = (reason: string, lease: string | null, envelope: IPoolEnvelopeView | null, fallback: boolean): TAutoHost => {
    if (fallback) log.warn(`tab create --host auto placed on this host: ${reason}`);
    return { kind: 'placed', host: undefined, lease, placement: { host: deps.localName(), local: true, reason, fallback, envelope } };
  };
  const first = await ask(false);
  if (first instanceof Error) {
    // Not a capacity answer: the pool did not answer a first ask, so the create keeps ADR-0039 §4's rule.
    if (first instanceof PoolTimeoutError && !hasTicket) return here(`fallback: ${first.message}`, null, null, true);
    return { kind: 'failed', error: first };
  }
  if (first.state !== 'admitted') return fromStart(first);
  if (first.local) return here(first.reason, first.lease, first.envelope, false);
  if (input.cwd) {
    // An ssh failure is not an answer about the directory (review r2 F4): its reason names the host and the error.
    let missing: string | null = null;
    try {
      if (!(await deps.cwdOnHost(first.host, input.cwd))) missing = `${input.cwd} is not a directory on ${first.host}`;
    } catch (err) {
      missing = `${first.host} did not answer: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (missing) {
      // The remote start is given back, and this host is asked on its own budget: a missing cwd is never a free local start.
      await deps.release(first.lease);
      const local = await ask(true);
      const why = `${missing} (pool chose it: ${first.reason})`;
      if (local instanceof Error) return { kind: 'failed', error: local };
      if (local.state !== 'admitted') return fromStart(local);
      return here(`fallback: ${why}; this host: ${local.reason}`, local.lease, local.envelope, true);
    }
  }
  return { kind: 'placed', host: first.host, cwdChecked: !!input.cwd, lease: first.lease, placement: { host: first.host, local: false, reason: first.reason, fallback: false, envelope: first.envelope } };
};
