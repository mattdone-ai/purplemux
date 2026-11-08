import { createLogger } from '@/lib/logger';
import { LOAD_LAG_MS, poolHostId, wouldRefuseLine, type IPoolRecentStart } from '@/lib/pool';
import type { IPoolEnvelopeView, IPoolWouldRefuse, IPoolWouldRefuseView, TPoolMode, TPoolShadowedRefusal } from '@/types/pool';

// The pool's in-process state (vel-D4 review r1): the shadow-mode would-refuse counter and the tab starts the
// host reads cannot show yet. Both live on globalThis: the pool routes write them and the pool view and the fleet
// view read them, from either module graph (CLAUDE.md §18). Both start empty at server start, by design: the
// counter is "since this server started", and a tab start older than LOAD_LAG_MS is in the next read.

const log = createLogger('pool');
const GIB = 1024 ** 3;

interface IHostCount {
  total: number;
  byRefusal: Partial<Record<TPoolShadowedRefusal, number>>;
}

interface IPoolRuntime {
  since: number;
  total: number;
  byHost: Map<string, IHostCount>;
  last: { at: number; line: string } | null;
  starts: Map<string, IPoolRecentStart[]>;
}

const g = globalThis as unknown as { __ptPoolRuntime?: IPoolRuntime };

const runtime = (): IPoolRuntime => {
  if (!g.__ptPoolRuntime) g.__ptPoolRuntime = { since: Date.now(), total: 0, byHost: new Map(), last: null, starts: new Map() };
  return g.__ptPoolRuntime;
};

/** One shadow admission: one log line with the figures, and the counter. */
export const recordWouldRefuse = (w: IPoolWouldRefuse, now: number = Date.now()): string => {
  const line = wouldRefuseLine(w);
  log.warn(line);
  const r = runtime();
  r.total += 1;
  const host = poolHostId(w.host);
  const count = r.byHost.get(host) ?? { total: 0, byRefusal: {} };
  count.total += 1;
  for (const refusal of w.refusals) count.byRefusal[refusal] = (count.byRefusal[refusal] ?? 0) + 1;
  r.byHost.set(host, count);
  r.last = { at: now, line };
  return line;
};

export const wouldRefuseView = (mode: TPoolMode): IPoolWouldRefuseView => {
  const r = runtime();
  return {
    mode,
    total: r.total,
    since: new Date(r.since).toISOString(),
    byHost: Object.fromEntries([...r.byHost].map(([host, c]) => [host, { total: c.total, byRefusal: { ...c.byRefusal } }])),
    last: r.last ? { at: new Date(r.last.at).toISOString(), line: r.last.line } : null,
  };
};

/** A tab start the server created on `host`: the measured checks count it until the reads can show it. */
export const recordTabStart = (host: string, envelope: IPoolEnvelopeView, now: number = Date.now()): void => {
  const starts = runtime().starts;
  const id = poolHostId(host);
  const kept = (starts.get(id) ?? []).filter((s) => s.at > now - 2 * LOAD_LAG_MS);
  kept.push({ at: now, threads: envelope.threads, memBytes: envelope.memGb * GIB });
  starts.set(id, kept);
};

/** Tab starts younger than twice the read lag, per pool host id; `hostState` keeps those the read cannot show. */
export const recentTabStarts = (now: number = Date.now()): Map<string, IPoolRecentStart[]> => {
  const out = new Map<string, IPoolRecentStart[]>();
  for (const [host, starts] of runtime().starts) {
    const kept = starts.filter((s) => s.at > now - 2 * LOAD_LAG_MS);
    if (kept.length) out.set(host, kept);
  }
  return out;
};
