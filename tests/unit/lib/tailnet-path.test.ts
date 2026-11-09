import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POOL_PATH_SLOW_MS,
  ageTailnetPath,
  isIpLiteral,
  isTailnetIp,
  measureTailnetPath,
  parseGoDurationMs,
  parseSshHostname,
  parseTailscalePing,
  pathAlert,
  pathAlertText,
  pathView,
  RELAYED_READS_TO_ALERT,
  TAILNET_PATH_TTL_MS,
  followTailnetPath,
  isTailnetPathSettled,
  type ITailnetPathDeps,
} from '@/lib/tailnet-path';
import type { IPoolPathRead } from '@/types/pool';

const T0 = 1_800_000_000_000;

/** Measured from host-a on 2026-11-09 05:13Z; the command exited 1. */
const DERP_PONG = 'pong from control-host (2001:db8::1) via DERP(syd) in 147ms\ndirect connection not established\n';
const DERP_SIN = 'pong from control-host (2001:db8::1) via DERP(sin) in 1.17s\ndirect connection not established\n';
const DIRECT_PONG = 'pong from host-b (2001:db8::2) via 198.51.100.155:41641 in 3ms\n';
const PEER_RELAY_PONG = 'pong from exec-2 (2001:db8::3) via peer-relay(192.0.2.5:7777:vni:12) in 41ms\n';

const deps = (over: Partial<ITailnetPathDeps> = {}): ITailnetPathDeps => ({
  now: () => T0,
  sshConfig: async (alias) => `user agent\nhostname ${alias}.tailnet.example\nport 22\n`,
  resolve: async () => ['fd7a:115c:a1e0::1'],
  ping: async () => DERP_PONG,
  ...over,
});

const read = (over: Partial<IPoolPathRead> = {}): IPoolPathRead => ({
  kind: 'direct', alias: 'exec-1', address: 'exec-1', ip: 'fd7a:115c:a1e0::2', peer: 'exec-1', region: null, rttMs: 4, measuredAt: T0, reason: null, relayedReads: 0, ...over,
});

describe('parseSshHostname', () => {
  it('reads the hostname line of ssh -G, whatever its case', () => {
    expect(parseSshHostname('user agent\nhostname 198.51.100.155\nport 22\n')).toBe('198.51.100.155');
    expect(parseSshHostname('HostName exec-1.tailnet.example\n')).toBe('exec-1.tailnet.example');
  });

  it('answers null with no hostname line', () => {
    expect(parseSshHostname('user agent\nport 22\n')).toBeNull();
  });
});

/** A dotted IPv4 address from its octets: the boundaries of Tailscale's range (RFC 6598), no host's address. */
const dotted = (...octets: number[]): string => octets.join('.');

describe('isTailnetIp and isIpLiteral', () => {
  it.each([
    [dotted(100, 64, 0, 1), true], [dotted(100, 127, 255, 254), true], ['fd7a:115c:a1e0::1', true],
    [dotted(100, 63, 255, 255), false], [dotted(100, 128, 0, 1), false], ['198.51.100.155', false], ['192.0.2.1', false],
    ['fd7a:115c:a1e0::3', true], ['fd7a:115c:a1e1::1', false], ['::1', false], ['host-b-lan', false],
  ])('%s → %s', (ip, expected) => {
    expect(isTailnetIp(ip)).toBe(expected);
  });

  it('tells an IP literal from a name', () => {
    expect(isIpLiteral('198.51.100.155')).toBe(true);
    expect(isIpLiteral('fd7a:115c:a1e0::1')).toBe(true);
    expect(isIpLiteral('999.1.1.1')).toBe(false);
    expect(isIpLiteral('host-b-lan')).toBe(false);
    expect(isIpLiteral('deadbeef')).toBe(false);
  });
});

describe('parseGoDurationMs', () => {
  it.each([
    ['147ms', 147], ['1.17s', 1170], ['850µs', 0.85], ['850us', 0.85], ['1m2.5s', 62_500], ['3ms', 3],
  ])('%s → %s ms', (text, ms) => {
    expect(parseGoDurationMs(text)).toBe(ms);
  });

  it.each(['', 'fast', '12', '3msx', '-1ms'])('refuses %j', (text) => {
    expect(parseGoDurationMs(text)).toBeNull();
  });
});

describe('parseTailscalePing', () => {
  it('reads a DERP pong even though the command then says no direct connection (the retro case)', () => {
    expect(parseTailscalePing(DERP_PONG)).toEqual({ ok: true, peer: 'control-host', transport: 'relayed', region: 'syd', rttMs: 147 });
    expect(parseTailscalePing(DERP_SIN)).toEqual({ ok: true, peer: 'control-host', transport: 'relayed', region: 'sin', rttMs: 1170 });
  });

  it('reads a direct pong', () => {
    expect(parseTailscalePing(DIRECT_PONG)).toEqual({ ok: true, peer: 'host-b', transport: 'direct', region: null, rttMs: 3 });
  });

  it('reads a peer relay as relayed', () => {
    expect(parseTailscalePing(PEER_RELAY_PONG)).toMatchObject({ ok: true, transport: 'relayed', region: 'peer-relay', rttMs: 41 });
  });

  it('reads direct only for an ip:port endpoint, IPv6 in brackets (review r1 M2)', () => {
    expect(parseTailscalePing('pong from a (100.1.2.3) via [2001:db8::1]:41641 in 5ms\n')).toMatchObject({ ok: true, transport: 'direct' });
    expect(parseTailscalePing('pong from a (100.1.2.3) via 192.0.2.7:41641 in 5ms\n')).toMatchObject({ ok: true, transport: 'direct' });
  });

  it.each([
    'relay:192.0.2.5:7777',
    '192.0.2.5',
    'control-host:41641',
    'tcp-derp(sin)',
    '[fe80::1]',
  ])('reads an unrecognised path token (via %s) as not measured, never direct (review r1 M2)', (token) => {
    expect(parseTailscalePing(`pong from a (100.1.2.3) via ${token} in 5ms\n`)).toEqual({ ok: false, reason: `unrecognised path "via ${token}"` });
  });

  it('measures an unrecognised path token as unknown with its reason', async () => {
    const path = await measureTailnetPath(deps({ ping: async () => 'pong from a (100.1.2.3) via relay:192.0.2.5:7777 in 5ms\n' }), 'exec-1');

    expect(path).toMatchObject({ kind: 'unknown', reason: 'tailscale ping fd7a:115c:a1e0::1: unrecognised path "via relay:192.0.2.5:7777"' });
    expect(pathAlert(path, 250)).toBeNull();
  });

  it('answers the last line when no pong came', () => {
    expect(parseTailscalePing('timeout waiting for ping reply\n')).toEqual({ ok: false, reason: 'timeout waiting for ping reply' });
    expect(parseTailscalePing('')).toEqual({ ok: false, reason: 'no answer' });
  });

  it('never reads a pong line with an unreadable duration as a measurement', () => {
    expect(parseTailscalePing('pong from x (2001:db8::4) via DERP(sin) in soon\n')).toEqual({
      ok: false, reason: 'pong from x (2001:db8::4) via DERP(sin) in soon',
    });
  });
});

describe('measureTailnetPath', () => {
  it('measures a relayed host: the alias resolves into the tailnet and the pong came through DERP', async () => {
    const pinged: string[] = [];
    const path = await measureTailnetPath(deps({ ping: async (ip) => { pinged.push(ip); return DERP_SIN; } }), 'exec-1');

    expect(path).toEqual({
      kind: 'relayed', alias: 'exec-1', address: 'exec-1.tailnet.example', ip: 'fd7a:115c:a1e0::1', peer: 'control-host',
      region: 'sin', rttMs: 1170, measuredAt: T0, reason: null, relayedReads: 1,
    });
    expect(pinged).toEqual(['fd7a:115c:a1e0::1']);
  });

  it('measures a direct host', async () => {
    const path = await measureTailnetPath(deps({ ping: async () => DIRECT_PONG }), 'host-b');

    expect(path).toMatchObject({ kind: 'direct', rttMs: 3, region: null });
  });

  it('calls a LAN alias not-tailnet and pings nothing', async () => {
    let pinged = false;
    const path = await measureTailnetPath(deps({
      sshConfig: async () => 'hostname 198.51.100.155\n',
      ping: async () => { pinged = true; return DIRECT_PONG; },
    }), 'host-b-lan');

    expect(path).toMatchObject({ kind: 'not-tailnet', address: '198.51.100.155', ip: '198.51.100.155', reason: null });
    expect(pinged).toBe(false);
  });

  it('takes the tailnet address of a name that resolves to several', async () => {
    const path = await measureTailnetPath(deps({ resolve: async () => ['198.51.100.6', 'fd7a:115c:a1e0::1'] }), 'control-host');

    expect(path).toMatchObject({ kind: 'relayed', ip: 'fd7a:115c:a1e0::1' });
  });

  it('reads every failure as unknown with its reason, never as direct', async () => {
    const sshFails = await measureTailnetPath(deps({ sshConfig: async () => { throw new Error('ssh: bad option'); } }), 'x');
    const noHost = await measureTailnetPath(deps({ sshConfig: async () => 'port 22\n' }), 'x');
    const noResolve = await measureTailnetPath(deps({ resolve: async () => { throw new Error('ENOTFOUND x'); } }), 'x');
    const noPong = await measureTailnetPath(deps({ ping: async () => 'timeout waiting for ping reply\n' }), 'x');
    const noTailscale = await measureTailnetPath(deps({ ping: async () => { throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }); } }), 'x');

    expect(sshFails).toMatchObject({ kind: 'unknown', reason: 'ssh -G failed: ssh: bad option' });
    expect(noHost).toMatchObject({ kind: 'unknown', reason: 'ssh -G printed no hostname' });
    expect(noResolve).toMatchObject({ kind: 'unknown', reason: 'x.tailnet.example does not resolve: ENOTFOUND x' });
    expect(noPong).toMatchObject({ kind: 'unknown', reason: 'tailscale ping fd7a:115c:a1e0::1: timeout waiting for ping reply' });
    expect(noTailscale).toMatchObject({ kind: 'unknown', reason: 'tailscale ping fd7a:115c:a1e0::1: tailscale is not installed on this host' });
  });
});

describe('pathAlert', () => {
  it('raises relayed for any relayed path on its second relayed read, even a fast one: relayed wins over slow', () => {
    expect(pathAlert(read({ kind: 'relayed', rttMs: 20, relayedReads: 2 }), 250)).toBe('tailnet-relayed');
    expect(pathAlert(read({ kind: 'relayed', rttMs: 1170, relayedReads: 3 }), 250)).toBe('tailnet-relayed');
  });

  it('raises nothing on one relayed read: a cold ping can pong through DERP first (review r1 L3)', () => {
    expect(RELAYED_READS_TO_ALERT).toBe(2);
    expect(pathAlert(read({ kind: 'relayed', rttMs: 1170, relayedReads: 1 }), 250)).toBeNull();
  });

  it('raises slow for a direct path at or above the threshold', () => {
    expect(pathAlert(read({ rttMs: 249 }), 250)).toBeNull();
    expect(pathAlert(read({ rttMs: 250 }), 250)).toBe('tailnet-slow');
  });

  it('raises nothing for a path that is not measured or not on the tailnet', () => {
    expect(pathAlert(read({ kind: 'unknown', rttMs: null }), 250)).toBeNull();
    expect(pathAlert(read({ kind: 'not-tailnet', rttMs: null }), 250)).toBeNull();
  });
});

describe('ageTailnetPath, pathView and pathAlertText', () => {
  it('turns a measurement older than the staleness into unknown, with its age', () => {
    expect(ageTailnetPath(read(), T0 + 90_000, 90_000)).toEqual(read());
    expect(ageTailnetPath(read({ kind: 'relayed' }), T0 + 91_000, 90_000)).toMatchObject({ kind: 'unknown', reason: 'last measured 91 s ago' });
  });

  it('serves the alert, the threshold and the time', () => {
    expect(pathView(read({ kind: 'relayed', region: 'sin', rttMs: 1170, relayedReads: 2 }), DEFAULT_POOL_PATH_SLOW_MS)).toEqual({
      kind: 'relayed', alert: 'tailnet-relayed', alias: 'exec-1', address: 'exec-1', ip: 'fd7a:115c:a1e0::2', peer: 'exec-1',
      region: 'sin', rttMs: 1170, relayedReads: 2, slowMs: 250, measuredAt: new Date(T0).toISOString(), reason: null,
    });
  });

  it('writes one line per alert', () => {
    expect(pathAlertText('exec-1', pathView(read({ kind: 'relayed', region: 'sin', rttMs: 1170.4, relayedReads: 2 }), 250)))
      .toBe('exec-1 tailnet path relayed via DERP(sin), RTT 1170 ms');
    expect(pathAlertText('exec-2', pathView(read({ kind: 'relayed', region: 'peer-relay', rttMs: 41, relayedReads: 2 }), 250)))
      .toBe('exec-2 tailnet path relayed via a peer relay, RTT 41 ms');
    expect(pathAlertText('exec-3', pathView(read({ rttMs: 300 }), 250))).toBe('exec-3 tailnet path slow: RTT 300 ms (threshold 250 ms)');
  });
});

describe('followTailnetPath and isTailnetPathSettled (review r1 L3, L6)', () => {
  const relayed = read({ kind: 'relayed', region: 'sin', rttMs: 1170, relayedReads: 1 });

  it('counts relayed measurements in a row, and a direct or off-tailnet one resets the count', () => {
    const second = followTailnetPath(relayed, relayed);
    expect(second.relayedReads).toBe(2);
    expect(followTailnetPath(second, relayed).relayedReads).toBe(3);
    expect(followTailnetPath(second, read()).relayedReads).toBe(0);
    expect(followTailnetPath(second, read({ kind: 'not-tailnet', ip: '198.51.100.155' })).relayedReads).toBe(0);
    expect(followTailnetPath(undefined, relayed).relayedReads).toBe(1);
    expect(followTailnetPath(read(), relayed).relayedReads).toBe(1);
  });

  it('keeps the count across an unknown measurement, which says nothing about the path', () => {
    const unknown = followTailnetPath(relayed, read({ kind: 'unknown', rttMs: null, reason: 'timeout' }));
    expect(unknown).toMatchObject({ kind: 'unknown', relayedReads: 1 });
    expect(followTailnetPath(unknown, relayed).relayedReads).toBe(2);
  });

  it('lets a known measurement stand for its TTL, and retakes an unknown or an unconfirmed relayed one', () => {
    expect(isTailnetPathSettled(read(), T0 + TAILNET_PATH_TTL_MS - 1)).toBe(true);
    expect(isTailnetPathSettled(read(), T0 + TAILNET_PATH_TTL_MS)).toBe(false);
    expect(isTailnetPathSettled(read({ kind: 'not-tailnet' }), T0 + 1)).toBe(true);
    expect(isTailnetPathSettled(read({ kind: 'relayed', relayedReads: 2 }), T0 + 1)).toBe(true);
    expect(isTailnetPathSettled(relayed, T0 + 1)).toBe(false);
    expect(isTailnetPathSettled(read({ kind: 'unknown' }), T0 + 1)).toBe(false);
  });
});
