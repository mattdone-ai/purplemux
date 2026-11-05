import { createLogger } from '@/lib/logger';
import type { TPoolPlacement } from '@/types/pool';

// `tab create --host auto` (ADR-0039 §4). The pool picks a concrete host; the
// create then runs the same checks as a `--host H` create. The pool never
// blocks a create: no answer in 2 s, a refusal, or a cwd missing on the
// chosen host places the tab here, and the answer says why.

const log = createLogger('pool');

export const AUTO_HOST = 'auto';
export const AUTO_PLACE_TIMEOUT_MS = 2_000;

export interface IAutoPlacement {
  host: string;
  local: boolean;
  reason: string;
  /** True when the pool's own answer was not used (no answer, a refusal, the cwd). */
  fallback: boolean;
}

export interface IAutoHostDeps {
  place: (req: { kind: 'tab'; memGb: number; panelType: string; role?: string }) => Promise<TPoolPlacement>;
  cwdOnHost: (host: string, cwd: string) => Promise<boolean>;
  localName: () => string;
  timeoutMs?: number;
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no pool answer in ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

/**
 * `host` is undefined for this host, else the remote alias the create then checks as for `--host H`.
 * `cwdChecked`: the cwd was already proven a directory on that host, so the create need not probe it again.
 */
export const resolveAutoHost = async (
  input: { panelType: string; role?: string; cwd?: string },
  deps: IAutoHostDeps,
): Promise<{ host: string | undefined; cwdChecked?: boolean; placement: IAutoPlacement }> => {
  const local = (reason: string, fallback: boolean) => {
    if (fallback) log.warn(`tab create --host auto placed on this host: ${reason}`);
    return { host: undefined, placement: { host: deps.localName(), local: true, reason, fallback } };
  };
  let placed: TPoolPlacement;
  try {
    placed = await withTimeout(deps.place({ kind: 'tab', memGb: 0, panelType: input.panelType, ...(input.role ? { role: input.role } : {}) }), deps.timeoutMs ?? AUTO_PLACE_TIMEOUT_MS);
  } catch (err) {
    return local(`fallback: ${err instanceof Error ? err.message : String(err)}`, true);
  }
  if (!placed.ok) return local(`fallback: the pool refused (${placed.refusal}: ${placed.reason})`, true);
  if (placed.local) return local(placed.reason, false);
  if (input.cwd) {
    // An ssh failure is not an answer about the directory (review r2 F4): its reason names the host and the error.
    let present: boolean;
    try {
      present = await deps.cwdOnHost(placed.host, input.cwd);
    } catch (err) {
      return local(`fallback: ${placed.host} did not answer: ${err instanceof Error ? err.message : String(err)} (pool chose it: ${placed.reason})`, true);
    }
    if (!present) return local(`fallback: ${input.cwd} is not a directory on ${placed.host} (pool chose it: ${placed.reason})`, true);
  }
  return { host: placed.host, cwdChecked: !!input.cwd, placement: { host: placed.host, local: false, reason: placed.reason, fallback: false } };
};
