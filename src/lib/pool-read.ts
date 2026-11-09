import { execFile } from 'child_process';
import dns from 'dns/promises';
import os from 'os';
import { promisify } from 'util';
import { readHostMetrics } from '@/lib/host-metrics';
import { createLogger } from '@/lib/logger';
import { describeRemoteFailure, originName, readRemoteHosts, runSsh } from '@/lib/remote-host';
import {
  TAILNET_PATH_TTL_MS, TAILSCALE_PING_TIMEOUT_S, ageTailnetPath, followTailnetPath, isTailnetPathSettled, measureTailnetPath,
  type ITailnetPathDeps,
} from '@/lib/tailnet-path';
import type {
  IPoolDisk, IPoolGpu, IPoolMetrics, IPoolPathRead, IPoolSweepState, IPoolUnitState, TPoolHostRead, TPoolSweepStatus,
} from '@/types/pool';

// The pool read model (ADR-0039 §1): this host through host-metrics, each
// registered remote host through one ssh read every 30 s. A read that fails
// marks the host unknown for 30 s; nothing reads it as zero.

const log = createLogger('pool');

export const POOL_READ_INTERVAL_MS = 30_000;
/** A hard ceiling on one remote read: ssh's ConnectTimeout does not cover a call that hangs after connecting. */
export const POOL_READ_TIMEOUT_MS = 5_000;
/** A known read older than this is unknown: the poller missed two cycles. */
export const POOL_READ_STALE_MS = 3 * POOL_READ_INTERVAL_MS;
/** A path measurement stands for its TTL, so it turns unknown only once it is that old and the reads stopped. */
export const POOL_PATH_STALE_MS = TAILNET_PATH_TTL_MS + POOL_READ_STALE_MS;

export const POOL_FALLBACK_KEY_PREFIX = 'pool.fallback.';

/**
 * One `sh -s` run per read. Sections are marked so a missing tool leaves its
 * own section empty instead of shifting the others. `/data` is read where it
 * exists (ai-server holds the build cache and Docker there).
 */
export const POOL_READ_SCRIPT = `echo @threads; nproc
echo @loadavg; cat /proc/loadavg
echo @meminfo; grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
echo @df; df -P -B1 / /data 2>/dev/null
echo @gpu; if command -v nvidia-smi >/dev/null 2>&1; then timeout 3 nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits || echo error; else echo absent; fi
echo @sweep; systemctl --user show -p LoadState,ActiveState,UnitFileState,Result hfl-sccache-sweep.timer hfl-sccache-sweep.service 2>/dev/null; true
echo @end
`;

export class PoolReadError extends Error {}

const sections = (stdout: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd();
    const marker = /^@([a-z]+)$/.exec(line);
    if (marker) {
      current = [];
      out.set(marker[1], current);
    } else if (current && line) current.push(line);
  }
  return out;
};

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '' || s.trim() === '[N/A]') return null;
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : null;
};

const parseDisks = (lines: string[]): IPoolDisk[] =>
  lines.slice(1).flatMap((line) => {
    const cols = line.split(/\s+/);
    if (cols.length < 6) return [];
    const used = num(cols[2]);
    const avail = num(cols[3]);
    if (used === null || avail === null) return [];
    const path = cols.slice(5).join(' ');
    const usedPct = used + avail > 0 ? Math.round((used / (used + avail)) * 1000) / 10 : null;
    return [{ path, usedPct, freeBytes: avail }];
  });

const parseGpus = (lines: string[]): IPoolGpu[] | null => {
  if (lines.length === 0 || lines[0] === 'absent' || lines[0] === 'error') return null;
  return lines.flatMap((line) => {
    const [index, name, util, used, total] = line.split(',').map((c) => c.trim());
    const i = num(index);
    return i === null || !name ? [] : [{ index: i, name, utilPct: num(util), memUsedMiB: num(used), memTotalMiB: num(total) }];
  });
};

const parseUnits = (lines: string[]): IPoolUnitState[] => {
  const units: IPoolUnitState[] = [];
  let current: Record<string, string> | null = null;
  const flush = () => {
    if (current && current.LoadState !== undefined) {
      units.push({ loadState: current.LoadState, activeState: current.ActiveState ?? '', unitFileState: current.UnitFileState ?? '', result: current.Result ?? '' });
    }
    current = null;
  };
  for (const line of lines) {
    const kv = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === 'LoadState') flush();
    current = current ?? {};
    current[kv[1]] = kv[2];
  }
  flush();
  return units;
};

const unitFailed = (u: IPoolUnitState | null): boolean => !!u && (u.activeState === 'failed' || (u.result !== '' && u.result !== 'success'));

/** The timer block first, the service block second (the order of the `systemctl show` call). */
const parseSweep = (lines: string[]): IPoolSweepState | null => {
  const [timer, service = null] = parseUnits(lines);
  if (!timer) return null;
  if (timer.loadState === 'not-found') return { state: 'not-installed', failed: false, timer, service };
  const failed = unitFailed(timer) || unitFailed(service);
  const state: TPoolSweepStatus = failed ? 'failed' : timer.activeState === 'active' ? 'active' : 'stopped';
  return { state, failed, timer, service };
};

/** Throws when a section the placement needs (threads, load, memory) is missing or malformed. */
export const parsePoolRead = (stdout: string): IPoolMetrics => {
  const s = sections(stdout);
  if (!s.has('end')) throw new PoolReadError('the read ended early (no @end marker)');
  const threads = num(s.get('threads')?.[0]);
  const [l1, l5] = (s.get('loadavg')?.[0] ?? '').split(/\s+/).map((v) => num(v));
  const mem = (key: string) => {
    const line = (s.get('meminfo') ?? []).find((l) => l.startsWith(`${key}:`));
    const kb = line ? num(/(\d+)\s*kB/.exec(line)?.[1]) : null;
    return kb === null ? null : kb * 1024;
  };
  const memTotalBytes = mem('MemTotal');
  const memAvailableBytes = mem('MemAvailable');
  if (threads === null || threads < 1) throw new PoolReadError('no thread count');
  if (l1 === null || l1 === undefined || l5 === null || l5 === undefined) throw new PoolReadError('no load average');
  if (memTotalBytes === null || memAvailableBytes === null) throw new PoolReadError('no MemTotal/MemAvailable');
  return {
    threads,
    load1: l1,
    load5: l5,
    memTotalBytes,
    memAvailableBytes,
    disks: parseDisks(s.get('df') ?? []),
    gpus: parseGpus(s.get('gpu') ?? []),
    sccacheSweep: parseSweep(s.get('sweep') ?? []),
  };
};

/** This host, from host-metrics. No GPU read: the local GPU is integrated and runs no work (null). */
export const readLocalPoolMetrics = async (): Promise<IPoolMetrics | { error: string }> => {
  const m = await readHostMetrics();
  if (!m.available) return { error: m.reason };
  return {
    threads: os.cpus().length,
    load1: m.loadAverage[0],
    load5: m.loadAverage[1],
    memTotalBytes: os.totalmem(),
    memAvailableBytes: m.memAvailableBytes,
    disks: m.disks.map((d) => ({ path: d.path, usedPct: d.usedPct, freeBytes: d.freeBytes })),
    gpus: null,
    sccacheSweep: null,
  };
};

export interface IPoolReaderDeps {
  now: () => number;
  localName: () => string;
  remoteHosts: () => Promise<string[]>;
  /** The alias to try once when the host's own alias fails (fleet config `pool.fallback.<alias>`), else null. */
  fallbackOf: (alias: string) => Promise<string | null>;
  runRemote: (alias: string, script: string, timeoutMs: number) => Promise<string>;
  readLocal: () => Promise<IPoolMetrics | { error: string }>;
  /** The tailnet path to an alias (vel-RETRO-R2), a local measurement; absent: no path is measured. */
  measurePath?: (alias: string) => Promise<IPoolPathRead>;
}

const errorText = (err: unknown): string => (err instanceof PoolReadError ? err.message : describeRemoteFailure(err));

export class PoolReader {
  private readonly reads = new Map<string, TPoolHostRead>();
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: IPoolReaderDeps) {}

  /** The last measurement of each alias (review r1 L6): it stands for its TTL, so a host is not pinged every read. */
  private readonly paths = new Map<string, IPoolPathRead>();
  /** The pool host each measured alias was read for, so a host that leaves the pool takes its aliases along. */
  private readonly pathHosts = new Map<string, string>();

  /**
   * The path of the alias the read went through, else the host's own; a measurement that throws is `unknown`. It runs
   * after the host read and at most once per TTL per alias; an unknown measurement, or a relayed one not yet
   * confirmed by a second (L3), is taken again at the next read.
   */
  private async withPath(read: TPoolHostRead): Promise<TPoolHostRead> {
    const { measurePath } = this.deps;
    if (!measurePath) return read;
    const alias = read.via ?? read.host;
    const previous = this.paths.get(alias);
    if (previous && isTailnetPathSettled(previous, this.deps.now())) return { ...read, path: previous };
    const measured = await measurePath(alias).catch((err: unknown): IPoolPathRead => ({
      kind: 'unknown', alias, address: null, ip: null, peer: null, region: null, rttMs: null, measuredAt: this.deps.now(),
      reason: err instanceof Error ? err.message : String(err), relayedReads: 0,
    }));
    const path = followTailnetPath(previous, measured);
    this.paths.set(alias, path);
    this.pathHosts.set(alias, read.host);
    return { ...read, path };
  }

  private async readOne(host: string): Promise<TPoolHostRead> {
    return this.withPath(await this.readHost(host));
  }

  private async readHost(host: string): Promise<TPoolHostRead> {
    const previous = this.reads.get(host);
    const lastReadAt = previous?.readAt ?? null;
    const tried: string[] = [];
    const aliases = [host];
    const fallback = await this.deps.fallbackOf(host).catch(() => null);
    if (fallback && fallback !== host) aliases.push(fallback);
    for (const alias of aliases) {
      try {
        const stdout = await this.deps.runRemote(alias, POOL_READ_SCRIPT, POOL_READ_TIMEOUT_MS);
        const read: TPoolHostRead = { host, local: false, state: 'known', readAt: this.deps.now(), via: alias, metrics: parsePoolRead(stdout) };
        return tried.length ? { ...read, primaryFailure: tried.join('; ') } : read;
      } catch (err) {
        tried.push(`${alias}: ${errorText(err)}`);
      }
    }
    const now = this.deps.now();
    return { host, local: false, state: 'unknown', readAt: lastReadAt, via: null, reason: `read failed (${tried.join('; ')})`, retryAt: now + POOL_READ_INTERVAL_MS };
  }

  /** One read of every registered remote host whose retry time has come; concurrent callers share it. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const hosts = await this.deps.remoteHosts();
        for (const known of [...this.reads.keys()]) if (!hosts.includes(known)) this.reads.delete(known);
        for (const [alias, host] of [...this.pathHosts]) {
          if (hosts.includes(host)) continue;
          this.paths.delete(alias);
          this.pathHosts.delete(alias);
        }
        const now = this.deps.now();
        await Promise.all(hosts.map(async (host) => {
          const prev = this.reads.get(host);
          if (prev?.state === 'unknown' && prev.retryAt > now) return;
          const read = await this.readOne(host);
          if (read.state === 'unknown' && prev?.state !== 'unknown') log.warn(`pool host ${host} is unknown: ${read.reason}`);
          if (read.state === 'known' && prev?.state === 'unknown') log.info(`pool host ${host} answers again (via ${read.via})`);
          this.reads.set(host, read);
        }));
      } catch (err) {
        log.warn(`pool refresh failed: ${err instanceof Error ? err.message : err}`);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /**
   * Every host as last read, never waiting on ssh: this host is read now; a
   * remote host never read, read too long ago, or failed is unknown.
   */
  async snapshot(): Promise<TPoolHostRead[]> {
    const now = this.deps.now();
    const localName = this.deps.localName();
    const local = await this.deps.readLocal().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
    const localRead: TPoolHostRead = 'error' in local
      ? { host: localName, local: true, state: 'unknown', readAt: null, via: null, reason: local.error, retryAt: now }
      : { host: localName, local: true, state: 'known', readAt: now, via: null, metrics: local };
    const hosts = await this.deps.remoteHosts();
    const remote = hosts.map((host): TPoolHostRead => {
      const read = this.reads.get(host);
      if (!read) return { host, local: false, state: 'unknown', readAt: null, via: null, reason: 'not read yet', retryAt: now };
      const path = read.path ? { path: ageTailnetPath(read.path, now, POOL_PATH_STALE_MS) } : {};
      if (read.state === 'known' && now - read.readAt > POOL_READ_STALE_MS) {
        return { host, local: false, state: 'unknown', readAt: read.readAt, via: read.via, reason: `last read ${Math.round((now - read.readAt) / 1000)} s ago`, retryAt: now, ...path };
      }
      return { ...read, ...path };
    });
    return [localRead, ...remote];
  }
}

const execFileP = promisify(execFile);
const LOCAL_EXEC_TIMEOUT_MS = 2_000;
const PING_EXEC_TIMEOUT_MS = (TAILSCALE_PING_TIMEOUT_S + 2) * 1_000;

export const defaultTailnetPathDeps = (): ITailnetPathDeps => ({
  now: () => Date.now(),
  sshConfig: async (alias) => (await execFileP('ssh', ['-G', '--', alias], { timeout: LOCAL_EXEC_TIMEOUT_MS })).stdout,
  resolve: async (name) => (await dns.lookup(name, { all: true })).map((a) => a.address),
  ping: async (ip) => {
    try {
      return (await execFileP('tailscale', ['ping', '-c', '1', '--timeout', `${TAILSCALE_PING_TIMEOUT_S}s`, ip], { timeout: PING_EXEC_TIMEOUT_MS })).stdout;
    } catch (err) {
      const e = err as { code?: unknown; stdout?: unknown; killed?: boolean };
      // A non-zero exit still prints the pong it got (a DERP pong exits 1); only a run that could not start or was
      // killed at its timeout is a failure.
      if (typeof e.code === 'number' && !e.killed && typeof e.stdout === 'string') return e.stdout;
      throw err;
    }
  },
});

export const defaultPoolReaderDeps = (): IPoolReaderDeps => ({
  now: () => Date.now(),
  localName: originName,
  remoteHosts: readRemoteHosts,
  fallbackOf: async (alias) => {
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    const value = valueOf(await readFleetConfig(), `${POOL_FALLBACK_KEY_PREFIX}${alias}`)?.value?.trim();
    const { isValidRemoteHostName } = await import('@/lib/remote-host');
    return value && isValidRemoteHostName(value) ? value : null;
  },
  runRemote: async (alias, script, timeoutMs) => (await runSsh(alias, 'sh -s', { timeoutMs, input: script })).stdout,
  readLocal: readLocalPoolMetrics,
  measurePath: (() => {
    const deps = defaultTailnetPathDeps();
    return (alias: string) => measureTailnetPath(deps, alias);
  })(),
});

const g = globalThis as unknown as { __ptPoolReader?: PoolReader; __ptPoolPoller?: { timer: NodeJS.Timeout | null } };

export const getPoolReader = (): PoolReader => {
  if (!g.__ptPoolReader) g.__ptPoolReader = new PoolReader(defaultPoolReaderDeps());
  return g.__ptPoolReader;
};

/** One poller per process: a read now, then every 30 s. */
export const startPoolPoller = (reader: PoolReader = getPoolReader()): void => {
  if (g.__ptPoolPoller) return;
  const state: { timer: NodeJS.Timeout | null } = { timer: null };
  g.__ptPoolPoller = state;
  const tick = async () => {
    await reader.refresh();
    if (g.__ptPoolPoller !== state) return;
    state.timer = setTimeout(tick, POOL_READ_INTERVAL_MS);
    state.timer.unref?.();
  };
  void tick();
};

export const stopPoolPoller = (): void => {
  const state = g.__ptPoolPoller;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  delete g.__ptPoolPoller;
};
