import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPoolMetrics } from '@/types/pool';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const {
  POOL_READ_INTERVAL_MS, POOL_READ_SCRIPT, POOL_READ_STALE_MS, POOL_READ_TIMEOUT_MS, PoolReader, parsePoolRead,
} = await import('@/lib/pool-read');

// ADR-0039 §1. The ai-server output below is the live read of 2026-11-03T07:20Z
// (`ssh ai-lan sh -s < POOL_READ_SCRIPT`, 0.36 s); the @sweep block is the live
// `systemctl --user show` answer of 07:45Z (review r2 F6). No test reaches a host.
const AI_SERVER = `@threads
64
@loadavg
89.27 51.36 43.67 16/8732 2782492
@meminfo
MemTotal:       391404916 kB
MemAvailable:   266610776 kB
@df
Filesystem                             1-blocks          Used     Available Capacity Mounted on
/dev/mapper/ubuntu--vg-ubuntu--lv 2012431163392 1348721274880  580794613760      70% /
/dev/nvme1n1p1                    1967846068224  893818077184 1074011213824      46% /data
@gpu
0, NVIDIA GeForce RTX 4090, 64, 23189, 24564
@sweep
LoadState=loaded
ActiveState=active
UnitFileState=enabled
Result=success

LoadState=loaded
ActiveState=inactive
UnitFileState=static
Result=success
@end
`;

const TIMER_OK = { loadState: 'loaded', activeState: 'active', unitFileState: 'enabled', result: 'success' };
const SERVICE_OK = { loadState: 'loaded', activeState: 'inactive', unitFileState: 'static', result: 'success' };
const sweepOf = (timer: string, service: string) =>
  AI_SERVER.replace(/@sweep\n[\s\S]*@end/, `@sweep\n${timer}\n\n${service}\n@end`);
const unit = (load: string, active: string, file: string, result: string) => `LoadState=${load}\nActiveState=${active}\nUnitFileState=${file}\nResult=${result}`;

describe('parsePoolRead', () => {
  it('reads threads, load 1 and 5, memory, / and /data, the GPU and the sweep timer', () => {
    expect(parsePoolRead(AI_SERVER)).toEqual({
      threads: 64,
      load1: 89.27,
      load5: 51.36,
      memTotalBytes: 391404916 * 1024,
      memAvailableBytes: 266610776 * 1024,
      disks: [
        { path: '/', usedPct: 69.9, freeBytes: 580794613760 },
        { path: '/data', usedPct: 45.4, freeBytes: 1074011213824 },
      ],
      gpus: [{ index: 0, name: 'NVIDIA GeForce RTX 4090', utilPct: 64, memUsedMiB: 23189, memTotalMiB: 24564 }],
      sccacheSweep: { state: 'active', failed: false, timer: TIMER_OK, service: SERVICE_OK },
    });
  });

  it.each([
    ['a failed last run', unit('loaded', 'active', 'enabled', 'success'), unit('loaded', 'failed', 'static', 'exit-code'), 'failed', true],
    ['a failed timer', unit('loaded', 'failed', 'enabled', 'success'), unit('loaded', 'inactive', 'static', 'success'), 'failed', true],
    ['a stopped timer', unit('loaded', 'inactive', 'enabled', 'success'), unit('loaded', 'inactive', 'static', 'success'), 'stopped', false],
    ['a disabled timer', unit('loaded', 'inactive', 'disabled', 'success'), unit('loaded', 'inactive', 'static', 'success'), 'stopped', false],
    ['no timer installed', unit('not-found', 'inactive', '', 'success'), unit('not-found', 'inactive', '', 'success'), 'not-installed', false],
  ])('the sweep (r2 F6): %s reads %s', (_name, timer, service, state, failed) => {
    expect(parsePoolRead(sweepOf(timer, service)).sccacheSweep).toMatchObject({ state, failed });
  });

  it('a stopped sweep is never read as not installed, and no systemctl answer is not read (null)', () => {
    expect(parsePoolRead(sweepOf(unit('loaded', 'inactive', 'disabled', 'success'), unit('loaded', 'inactive', 'static', 'success'))).sccacheSweep?.state).toBe('stopped');
    expect(parsePoolRead(AI_SERVER.replace(/@sweep\n[\s\S]*@end/, '@sweep\n@end')).sccacheSweep).toBeNull();
  });

  it('no nvidia-smi, or one that fails, is no GPU read (null), never an empty GPU list', () => {
    expect(parsePoolRead(AI_SERVER.replace('0, NVIDIA GeForce RTX 4090, 64, 23189, 24564', 'absent')).gpus).toBeNull();
    expect(parsePoolRead(AI_SERVER.replace('0, NVIDIA GeForce RTX 4090, 64, 23189, 24564', 'error')).gpus).toBeNull();
  });

  it('a host with no /data reports / alone', () => {
    const out = parsePoolRead(AI_SERVER.replace(/\/dev\/nvme1n1p1.*\n/, ''));
    expect(out.disks.map((d) => d.path)).toEqual(['/']);
  });

  it.each([
    ['a cut-off read', AI_SERVER.replace('@end\n', '')],
    ['no thread count', AI_SERVER.replace('@threads\n64', '@threads')],
    ['no load average', AI_SERVER.replace(/@loadavg\n.*\n/, '@loadavg\n')],
    ['no MemAvailable', AI_SERVER.replace(/MemAvailable.*\n/, '')],
  ])('%s is refused, never read as zero', (_name, out) => {
    expect(() => parsePoolRead(out)).toThrow();
  });

  it('the script marks every section the parser reads', () => {
    for (const marker of ['@threads', '@loadavg', '@meminfo', '@df', '@gpu', '@sweep', '@end']) expect(POOL_READ_SCRIPT).toContain(`echo ${marker}`);
  });
});

const LOCAL: IPoolMetrics = {
  threads: 32, load1: 30, load5: 28, memTotalBytes: 91 * 1024 ** 3, memAvailableBytes: 30 * 1024 ** 3,
  disks: [{ path: '/', usedPct: 60, freeBytes: 1 }], gpus: null, sccacheSweep: null,
};

const sshFailure = (stderr: string) => Object.assign(new Error('Command failed'), { code: 255, stderr });

describe('PoolReader', () => {
  let now: number;
  let runRemote: ReturnType<typeof vi.fn>;
  let fallback: string | null;
  let hosts: string[];
  const reader = () => new PoolReader({
    now: () => now,
    localName: () => 'mdserver1',
    remoteHosts: async () => hosts,
    fallbackOf: async () => fallback,
    runRemote: runRemote as never,
    readLocal: async () => LOCAL,
  });

  beforeEach(() => {
    now = Date.parse('2026-11-03T07:00:00Z');
    runRemote = vi.fn(async () => AI_SERVER);
    fallback = 'ai-server';
    hosts = ['ai-lan'];
  });

  it('reads this host now and the remote host by one ssh read with a 5 s hard timeout', async () => {
    const r = reader();
    await r.refresh();
    expect(runRemote).toHaveBeenCalledTimes(1);
    expect(runRemote).toHaveBeenCalledWith('ai-lan', POOL_READ_SCRIPT, POOL_READ_TIMEOUT_MS);
    expect(POOL_READ_TIMEOUT_MS).toBe(5_000);
    const [local, remote] = await r.snapshot();
    expect(local).toMatchObject({ host: 'mdserver1', local: true, state: 'known', metrics: LOCAL });
    expect(remote).toMatchObject({ host: 'ai-lan', local: false, state: 'known', via: 'ai-lan', metrics: { threads: 64 } });
  });

  it('a host never read is unknown, and a snapshot never waits on ssh', async () => {
    const [, remote] = await reader().snapshot();
    expect(remote).toMatchObject({ state: 'unknown', reason: 'not read yet' });
    expect(runRemote).not.toHaveBeenCalled();
  });

  it('a failed LAN read tries the fallback alias once; it answering is known, via the fallback', async () => {
    runRemote.mockImplementation(async (alias: string) => {
      if (alias === 'ai-lan') throw sshFailure('Permission denied (publickey).');
      return AI_SERVER;
    });
    const r = reader();
    await r.refresh();
    expect(runRemote.mock.calls.map((c) => c[0])).toEqual(['ai-lan', 'ai-server']);
    expect((await r.snapshot())[1]).toMatchObject({ state: 'known', via: 'ai-server', primaryFailure: 'ai-lan: exit 255: Permission denied (publickey).' });
  });

  it('both aliases failing marks the host unknown for 30 s with both reasons; no metrics, never zero', async () => {
    runRemote.mockRejectedValue(Object.assign(new Error('timeout'), { killed: true, stderr: '' }));
    const r = reader();
    await r.refresh();
    const unknown = (await r.snapshot())[1];
    expect(unknown).toMatchObject({ state: 'unknown', retryAt: now + POOL_READ_INTERVAL_MS });
    expect(unknown).not.toHaveProperty('metrics');
    expect(unknown.state === 'unknown' && unknown.reason).toBe('read failed (ai-lan: timed out; ai-server: timed out)');
    expect(runRemote).toHaveBeenCalledTimes(2);

    now += POOL_READ_INTERVAL_MS - 1;
    await r.refresh();
    expect(runRemote).toHaveBeenCalledTimes(2);

    runRemote.mockResolvedValue(AI_SERVER);
    now += 1;
    await r.refresh();
    expect((await r.snapshot())[1]).toMatchObject({ state: 'known', via: 'ai-lan' });
  });

  it('no fallback configured: one alias, one try', async () => {
    fallback = null;
    runRemote.mockRejectedValue(sshFailure('ssh: connect to host ai-lan port 22: No route to host'));
    const r = reader();
    await r.refresh();
    expect(runRemote).toHaveBeenCalledTimes(1);
    expect((await r.snapshot())[1]).toMatchObject({ state: 'unknown', reason: expect.stringContaining('No route to host') });
  });

  it('a malformed answer is a failed read', async () => {
    fallback = null;
    runRemote.mockResolvedValue('@threads\n64\n');
    const r = reader();
    await r.refresh();
    expect((await r.snapshot())[1]).toMatchObject({ state: 'unknown', reason: expect.stringContaining('no @end marker') });
  });

  it('a known read older than three intervals is unknown', async () => {
    const r = reader();
    await r.refresh();
    now += POOL_READ_STALE_MS + 1;
    expect((await r.snapshot())[1]).toMatchObject({ state: 'unknown', reason: expect.stringContaining('last read 90 s ago') });
  });

  it('a host removed from remote.hosts leaves the model; concurrent refreshes share one read', async () => {
    const r = reader();
    await Promise.all([r.refresh(), r.refresh()]);
    expect(runRemote).toHaveBeenCalledTimes(1);
    hosts = [];
    await r.refresh();
    expect((await r.snapshot()).map((h) => h.host)).toEqual(['mdserver1']);
  });

  it('this host unreadable is unknown with its reason', async () => {
    const r = new PoolReader({
      now: () => now, localName: () => 'mdserver1', remoteHosts: async () => [], fallbackOf: async () => null,
      runRemote: runRemote as never, readLocal: async () => ({ error: 'host metrics are Linux only (this host is darwin)' }),
    });
    expect((await r.snapshot())[0]).toMatchObject({ host: 'mdserver1', state: 'unknown', reason: expect.stringContaining('Linux only') });
  });
});
