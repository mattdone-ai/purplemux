import type { IPoolPathRead, IPoolPathView, TPoolPathAlert } from '@/types/pool';

// The tailnet path to each remote pool host (vel-RETRO-R2): measured from this host, where tailscale runs, beside each
// 30 s pool read. Retro 2026-11-09 R2: the exec hosts reached control-host only through a DERP relay (RTT ~1 s, ssh
// 18-25 s) for hours and no tool noticed. The pool reports the path; it never refuses a host for it.
// Design: docs/design/vel-retro-r2-tailnet-path.md. No Node imports: the fleet panel renders these lines in the
// browser (CLAUDE.md, host-warnings.ts); the exec deps are in `pool-read.ts`.

export const POOL_PATH_SLOW_KEY = 'pool.path.slow-ms';
/** About a quarter of the measured DERP RTT (0.85-1.17 s) and far above a LAN or direct tailnet hop. */
export const DEFAULT_POOL_PATH_SLOW_MS = 250;
export const TAILSCALE_PING_TIMEOUT_S = 2;
/**
 * A relayed path alerts only on this many consecutive relayed measurements (review r1 L3): `tailscale ping` to an
 * idle peer can answer with a DERP pong before the direct path is set up, and the ping itself warms the path.
 */
export const RELAYED_READS_TO_ALERT = 2;
/** How long a measurement stands for its host (review r1 L6); an unknown or an unconfirmed relayed one is retaken. */
export const TAILNET_PATH_TTL_MS = 5 * 60_000;

/** The address ssh dials for an alias: the `hostname` line of `ssh -G`. */
export const parseSshHostname = (stdout: string): string | null => {
  const line = stdout.split('\n').find((l) => /^hostname\s/i.test(l));
  const value = line?.replace(/^hostname\s+/i, '').trim();
  return value || null;
};

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A literal IP, as ssh would dial it without a lookup. */
export const isIpLiteral = (text: string): boolean => {
  const v4 = IPV4.exec(text);
  if (v4) return v4.slice(1).every((octet) => Number(octet) <= 255);
  return /^[0-9a-f:]+$/i.test(text) && text.includes(':');
};

/** Tailscale's CGNAT range (RFC 6598: first octet 100, second 64..127) and its ULA prefix fd7a:115c:a1e0::/48. */
export const isTailnetIp = (ip: string): boolean => {
  const v4 = IPV4.exec(ip);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127 && Number(v4[3]) <= 255 && Number(v4[4]) <= 255;
  return isIpLiteral(ip) && /^fd7a:115c:a1e0:/i.test(ip);
};

const DURATION_UNITS: Record<string, number> = { ns: 1e-6, 'µs': 1e-3, 'μs': 1e-3, us: 1e-3, ms: 1, s: 1_000, m: 60_000 };

/** A Go duration as `tailscale ping` prints it (`147ms`, `1.103s`, `850µs`, `1m2.5s`), in milliseconds. */
export const parseGoDurationMs = (text: string): number | null => {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ns|µs|μs|us|ms|s|m)/g)];
  if (!parts.length || parts.map((p) => p[0]).join('') !== text) return null;
  return Math.round(parts.reduce((sum, [, n, unit]) => sum + Number(n) * DURATION_UNITS[unit], 0) * 1000) / 1000;
};

export type TPingAnswer =
  | { ok: true; peer: string; transport: 'direct' | 'relayed'; region: string | null; rttMs: number }
  | { ok: false; reason: string };

/** The endpoint of a direct pong: `ip:port`, an IPv6 address in brackets. */
const DIRECT_ENDPOINT = /^(\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3}):\d{1,5}$/i;

/**
 * The first `pong from` line of `tailscale ping`. Its exit status says nothing about the path: after a DERP pong it
 * exits 1 with "direct connection not established" (measured 2026-11-09), which is the case this exists to see.
 */
export const parseTailscalePing = (stdout: string): TPingAnswer => {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = /^pong from (\S+) \([^)]*\) via (\S+) in (\S+)$/.exec(line);
    if (!m) continue;
    const rttMs = parseGoDurationMs(m[3]);
    if (rttMs === null) continue;
    const derp = /^DERP\(([^)]+)\)$/.exec(m[2]);
    if (derp) return { ok: true, peer: m[1], transport: 'relayed', region: derp[1], rttMs };
    if (/^peer-relay/.test(m[2])) return { ok: true, peer: m[1], transport: 'relayed', region: 'peer-relay', rttMs };
    if (DIRECT_ENDPOINT.test(m[2])) return { ok: true, peer: m[1], transport: 'direct', region: null, rttMs };
    // A form this parser does not know (a new tailscale version) is not measured, never `direct` (review r1 M2).
    return { ok: false, reason: `unrecognised path "via ${m[2]}"` };
  }
  return { ok: false, reason: lines.at(-1) ?? 'no answer' };
};

export interface ITailnetPathDeps {
  now: () => number;
  /** `ssh -G <alias>` stdout. */
  sshConfig: (alias: string) => Promise<string>;
  /** Every address the name resolves to, as getaddrinfo answers (the hosts file, then DNS, MagicDNS included). */
  resolve: (name: string) => Promise<string[]>;
  /** `tailscale ping` stdout whatever its exit status; throws only when it could not run. */
  ping: (ip: string) => Promise<string>;
}

const errorText = (err: unknown): string => {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'ENOENT') return 'tailscale is not installed on this host';
  return e?.message?.split('\n')[0] ?? String(err);
};

/** One measurement of the path ssh takes to `alias`. Every failure is `unknown` with its reason, never `direct`. */
export const measureTailnetPath = async (deps: ITailnetPathDeps, alias: string): Promise<IPoolPathRead> => {
  const base = { alias, measuredAt: deps.now(), relayedReads: 0 };
  let address: string | null;
  try {
    address = parseSshHostname(await deps.sshConfig(alias));
  } catch (err) {
    return { ...base, kind: 'unknown', address: null, ip: null, peer: null, region: null, rttMs: null, reason: `ssh -G failed: ${errorText(err)}` };
  }
  if (!address) return { ...base, kind: 'unknown', address: null, ip: null, peer: null, region: null, rttMs: null, reason: 'ssh -G printed no hostname' };
  let ips: string[];
  try {
    ips = isIpLiteral(address) ? [address] : await deps.resolve(address);
  } catch (err) {
    return { ...base, kind: 'unknown', address, ip: null, peer: null, region: null, rttMs: null, reason: `${address} does not resolve: ${errorText(err)}` };
  }
  const ip = ips.find(isTailnetIp) ?? null;
  if (!ip) return { ...base, kind: 'not-tailnet', address, ip: ips[0] ?? null, peer: null, region: null, rttMs: null, reason: null };
  let answer: TPingAnswer;
  try {
    answer = parseTailscalePing(await deps.ping(ip));
  } catch (err) {
    answer = { ok: false, reason: errorText(err) };
  }
  if (!answer.ok) return { ...base, kind: 'unknown', address, ip, peer: null, region: null, rttMs: null, reason: `tailscale ping ${ip}: ${answer.reason}` };
  return {
    ...base, kind: answer.transport, address, ip, peer: answer.peer, region: answer.region, rttMs: answer.rttMs, reason: null,
    relayedReads: answer.transport === 'relayed' ? 1 : 0,
  };
};

/**
 * The measurement after `previous` of the same alias: a relayed one counts the relayed measurements in a row. An
 * unknown one says nothing about the path, so it neither adds to the count nor resets it.
 */
export const followTailnetPath = (previous: IPoolPathRead | undefined, next: IPoolPathRead): IPoolPathRead => {
  // A direct or off-tailnet measurement carries 0, so the count it hands on is the reset.
  if (next.kind === 'relayed') return { ...next, relayedReads: (previous?.relayedReads ?? 0) + 1 };
  if (next.kind === 'unknown') return { ...next, relayedReads: previous?.relayedReads ?? 0 };
  return { ...next, relayedReads: 0 };
};

/** A measurement that stands for its host until the TTL: known, and not a relayed one still to be confirmed. */
export const isTailnetPathSettled = (read: IPoolPathRead, now: number): boolean =>
  now - read.measuredAt < TAILNET_PATH_TTL_MS
  && read.kind !== 'unknown'
  && !(read.kind === 'relayed' && read.relayedReads < RELAYED_READS_TO_ALERT);

/**
 * The alert a path raises: a relayed path on its second relayed measurement in a row, which wins over a slow one; a
 * path that is not measured raises none, and neither does a first relayed measurement.
 */
export const pathAlert = (read: Pick<IPoolPathRead, 'kind' | 'rttMs' | 'relayedReads'>, slowMs: number): TPoolPathAlert | null => {
  if (read.kind === 'relayed') return read.relayedReads >= RELAYED_READS_TO_ALERT ? 'tailnet-relayed' : null;
  if (read.kind === 'direct' && read.rttMs !== null && read.rttMs >= slowMs) return 'tailnet-slow';
  return null;
};

/** A measurement older than `staleMs` is unknown: the reader no longer measures that host. */
export const ageTailnetPath = (read: IPoolPathRead, now: number, staleMs: number): IPoolPathRead =>
  now - read.measuredAt > staleMs
    ? { ...read, kind: 'unknown', reason: `last measured ${Math.round((now - read.measuredAt) / 1000)} s ago` }
    : read;

/** The path as the pool view serves it. */
export const pathView = (read: IPoolPathRead, slowMs: number): IPoolPathView => ({
  kind: read.kind,
  alert: pathAlert(read, slowMs),
  alias: read.alias,
  address: read.address,
  ip: read.ip,
  peer: read.peer,
  region: read.region,
  rttMs: read.rttMs,
  relayedReads: read.relayedReads,
  slowMs,
  measuredAt: new Date(read.measuredAt).toISOString(),
  reason: read.reason,
});

/** One line for the fleet panel and the alert. */
export const pathAlertText = (host: string, path: IPoolPathView): string => {
  const rtt = path.rttMs === null ? 'RTT unknown' : `RTT ${Math.round(path.rttMs)} ms`;
  if (path.alert === 'tailnet-relayed') {
    const via = path.region === 'peer-relay' ? 'a peer relay' : `DERP(${path.region ?? '?'})`;
    return `${host} tailnet path relayed via ${via}, ${rtt}`;
  }
  return `${host} tailnet path slow: ${rtt} (threshold ${path.slowMs} ms)`;
};
