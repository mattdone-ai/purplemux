import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHostMetrics, type IHostMetricsDeps } from '@/lib/host-metrics';
import {
  HOST_SIGNALS_INTERVAL_MS, HOST_SIGNALS_STALE_MS, hostSignalsView, parseHostSignals, readHostSignalCommand, resetHostSignals,
  runHostSignalsOnce, runShellBounded, startHostSignals, tickHostSignals, type IHostSignalsDeps,
} from '@/lib/host-signals';
import { hostWarnings } from '@/lib/host-warnings';

// Story 20: host pressure (statfs) and the optional host-signal command.

const GB = 1024 ** 3;
const fs = (usedPct: number, inodesPct = 10, total = 1000) => ({
  bsize: GB, blocks: total, bfree: total - (total * usedPct) / 100, bavail: total - (total * usedPct) / 100, files: 1000, ffree: 1000 - inodesPct * 10,
});
const deps = (over: Partial<IHostMetricsDeps> = {}): IHostMetricsDeps => ({
  platform: 'linux',
  statfs: async (p) => (p === '/' ? fs(99) : p === '/tmp' ? fs(5, 90) : fs(99)),
  deviceOf: async () => 1,
  loadavg: () => [1.5, 2, 3],
  meminfo: async () => 'MemTotal: 100 kB\nMemAvailable:   2048 kB\n',
  freemem: () => 1,
  purplemuxDir: '/home/u/.purplemux',
  ...over,
});

describe('host metrics', () => {
  it('reads disk %, free bytes and inodes; 99 % disk and 90 % /tmp inodes are warnings', async () => {
    const host = await readHostMetrics(deps());
    expect(host).toMatchObject({ available: true, disks: [{ path: '/', usedPct: 99, freeBytes: 10 * GB, inodesUsedPct: 10 }], tmpInodesUsedPct: 90, loadAverage: [1.5, 2, 3], memAvailableBytes: 2048 * 1024 });
    const warn = hostWarnings(host);
    expect([...warn.disks]).toEqual(['/']);
    expect(warn.tmpInodes).toBe(true);
    expect(warn.inodes.size).toBe(0);
  });

  it('lists the ~/.purplemux filesystem separately only when it is on another device', async () => {
    const statfs: IHostMetricsDeps['statfs'] = async (p) => (p === '/' ? fs(40) : p === '/tmp' ? fs(5) : fs(70));
    const other = await readHostMetrics(deps({ statfs, deviceOf: async (p) => (p === '/' ? 1 : 2) }));
    expect(other.available && other.disks.map((d) => [d.path, d.usedPct])).toEqual([['/', 40], ['/home/u/.purplemux', 70]]);
    expect([...hostWarnings(other).disks]).toEqual([]);
    // Same device: one row, even when two statfs reads of a busy disk differ.
    const same = await readHostMetrics(deps({ statfs, deviceOf: async () => 7 }));
    expect(same.available && same.disks.map((d) => d.path)).toEqual(['/']);
    // An unreadable ~/.purplemux is not listed.
    const gone = await readHostMetrics(deps({ statfs, deviceOf: async (p) => { if (p !== '/') throw new Error('ENOENT'); return 1; } }));
    expect(gone.available && gone.disks.map((d) => d.path)).toEqual(['/']);
  });

  it('a filesystem that reports zero blocks or inodes is unknown (null), never 0 %', async () => {
    const zero = { bsize: 4096, blocks: 0, bfree: 0, bavail: 0, files: 0, ffree: 0 };
    const host = await readHostMetrics(deps({ statfs: async () => zero }));
    expect(host.available && host.disks[0]).toMatchObject({ usedPct: null, inodesUsedPct: null });
    expect(host.available && host.tmpInodesUsedPct).toBeNull();
    expect(hostWarnings(host).disks.size).toBe(0);
  });

  it('thresholds: disk ≥ 90 % and inodes ≥ 85 % warn; just below does not', async () => {
    const at = await readHostMetrics(deps({ statfs: async () => fs(90, 85) }));
    expect(hostWarnings(at)).toMatchObject({ tmpInodes: true });
    expect([...hostWarnings(at).disks]).toEqual(['/']);
    expect([...hostWarnings(at).inodes]).toEqual(['/']);
    const below = await readHostMetrics(deps({ statfs: async () => fs(89.9, 84.9) }));
    expect(hostWarnings(below)).toMatchObject({ tmpInodes: false });
    expect(hostWarnings(below).disks.size + hostWarnings(below).inodes.size).toBe(0);
  });

  it('is unavailable off Linux (NFR-7), never zeros', async () => {
    expect(await readHostMetrics(deps({ platform: 'darwin' }))).toEqual({ available: false, reason: 'host metrics are Linux only (this host is darwin)' });
  });
});

const VALID = { schemaVersion: 1, stampedAt: 1790000000000, gateSlots: { total: 6, held: 2, holders: [{ pid: 123, log: '/abs/log' }] }, worktrees: [{ repo: 'acme-ledger-ui', count: 374, byEpic: { 'pft-1386-1397': 12 } }], tmpInodesPct: 41.2 };

describe('host signals', () => {
  afterEach(() => resetHostSignals());
  const clock = { now: 1_000_000 };
  const run = (command: string | null, out: { stdout: string } | { error: string }) =>
    runHostSignalsOnce({ now: () => clock.now, command: async () => command, run: async () => out });

  it('parses the pinned schema; unknown keys are ignored', () => {
    expect(parseHostSignals(JSON.stringify({ ...VALID, extra: 'x' }))).toMatchObject({ ok: true, value: { gateSlots: { total: 6, held: 2 } } });
  });

  it.each([
    ['not JSON', '{nope', /^not JSON/],
    ['a missing required key', JSON.stringify({ ...VALID, tmpInodesPct: undefined }), /^invalid: tmpInodesPct/],
    ['a wrong schema version', JSON.stringify({ ...VALID, schemaVersion: 2 }), /^invalid: schemaVersion/],
    ['a nanosecond stamp Date cannot render', JSON.stringify({ ...VALID, stampedAt: 1.79e18 }), /^invalid: stampedAt/],
    ['a seconds-with-fraction stamp', JSON.stringify({ ...VALID, stampedAt: 1790000000.5 }), /^invalid: stampedAt/],
    ['a negative stamp', JSON.stringify({ ...VALID, stampedAt: -1 }), /^invalid: stampedAt/],
    ['an epoch-seconds stamp (would render as January 1970)', JSON.stringify({ ...VALID, stampedAt: 1790000000 }), /^invalid: stampedAt — must be epoch milliseconds/],
  ])('refuses %s with the validation error', (_label, stdout, error) => {
    const r = parseHostSignals(stdout);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(error);
  });

  it('no command: "not configured"; a valid run: its values and stamp; stale after 15 min', async () => {
    await run(null, { stdout: '' });
    expect(hostSignalsView(clock.now)).toEqual({ state: 'not-configured' });
    await run('host-signals.py', { stdout: JSON.stringify(VALID) });
    expect(hostSignalsView(clock.now)).toMatchObject({ state: 'ok', ranAt: 1_000_000, stale: false, value: { tmpInodesPct: 41.2 } });
    expect(hostSignalsView(clock.now + HOST_SIGNALS_STALE_MS + 1)).toMatchObject({ state: 'ok', stale: true });
  });

  it('invalid JSON or a failing command shows the error, never zeros', async () => {
    await run('host-signals.py', { stdout: '{"schemaVersion":1}' });
    expect(hostSignalsView(clock.now)).toMatchObject({ state: 'error', error: expect.stringMatching(/^invalid: /) });
    await run('host-signals.py', { error: 'timed out after 10 s' });
    expect(hostSignalsView(clock.now)).toEqual({ state: 'error', error: 'command failed: timed out after 10 s', ranAt: 1_000_000, stale: false });
  });

  it('the real runner: a shell command\'s JSON is read; a failing command reports its exit code and first stderr line only', async () => {
    const { defaultHostSignalsDeps } = await import('@/lib/host-signals');
    const real = defaultHostSignalsDeps();
    await runHostSignalsOnce({ ...real, now: () => 5, command: async () => `printf '%s' '${JSON.stringify(VALID)}'` });
    expect(hostSignalsView(5)).toMatchObject({ state: 'ok', value: { gateSlots: { held: 2 } } });
    await runHostSignalsOnce({ ...real, now: () => 6, command: async () => 'printf "broken\\nTraceback line 2\\n" >&2; exit 3' });
    expect(hostSignalsView(6)).toEqual({ state: 'error', error: 'command failed: exit 3 — broken', ranAt: 6, stale: false });
  });

  it('a broken config.json is an error, a missing file or key is "not configured"', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pmux-hostsig-'));
    try {
      const file = path.join(dir, 'config.json');
      expect(await readHostSignalCommand(file)).toBeNull();
      await fsp.writeFile(file, JSON.stringify({ locale: 'en' }));
      expect(await readHostSignalCommand(file)).toBeNull();
      await fsp.writeFile(file, JSON.stringify({ hostSignalCommand: '  host-signals.py  ' }));
      expect(await readHostSignalCommand(file)).toBe('host-signals.py');
      await fsp.writeFile(file, JSON.stringify({ hostSignalCommand: 42 }));
      await expect(readHostSignalCommand(file)).rejects.toThrow('hostSignalCommand is not a string');
      await fsp.writeFile(file, '{ "hostSignalCommand": "x",');
      await expect(readHostSignalCommand(file)).rejects.toThrow(SyntaxError);
      await runHostSignalsOnce({ now: () => 9, command: () => readHostSignalCommand(file), run: async () => ({ stdout: '' }) });
      expect(hostSignalsView(9)).toMatchObject({ state: 'error', error: expect.stringMatching(/^config.json unreadable: /), ranAt: 9 });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
};

describe('the bounded shell runner', () => {
  const limits = { timeoutMs: 300, maxBytes: 1000, graceMs: 300 };

  it('times out, settles at once and kills the whole process group, grandchildren included', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pmux-hostsig-'));
    try {
      const pidFile = path.join(dir, 'pid');
      const started = Date.now();
      const r = await runShellBounded(`sleep 30 & echo $! > ${pidFile}; wait`, limits);
      expect(r).toEqual({ error: 'timed out after 0.3 s' });
      expect(Date.now() - started).toBeLessThan(2000);
      const grandchild = Number((await fsp.readFile(pidFile, 'utf-8')).trim());
      expect(await waitDead(grandchild, 3000)).toBe(true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('escalates to SIGKILL when the group ignores SIGTERM', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pmux-hostsig-'));
    try {
      const pidFile = path.join(dir, 'pid');
      const r = await runShellBounded(`trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`, limits);
      expect(r).toEqual({ error: 'timed out after 0.3 s' });
      const grandchild = Number((await fsp.readFile(pidFile, 'utf-8')).trim());
      expect(await waitDead(grandchild, 4000)).toBe(true);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses output past the byte cap', async () => {
    expect(await runShellBounded('head -c 5000 /dev/zero | tr "\\0" x', limits)).toEqual({ error: 'output exceeded 1000 bytes' });
  });

  it('a signal-killed command reports the signal', async () => {
    expect(await runShellBounded('kill -9 $$', limits)).toEqual({ error: 'signal SIGKILL' });
  });
});

describe('host-signal scheduling', () => {
  afterEach(() => {
    resetHostSignals();
    vi.useRealTimers();
  });

  it('runs at start and every 5 minutes; a second start adds no timer', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => ({ stdout: JSON.stringify(VALID) }));
    const d: IHostSignalsDeps = { now: () => Date.now(), command: async () => 'x', run };
    startHostSignals(d);
    startHostSignals(d);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOST_SIGNALS_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a tick while a run is still in flight is skipped; a late result never overlaps a newer run', async () => {
    let release: (v: { stdout: string }) => void = () => {};
    const run = vi.fn(() => new Promise<{ stdout: string }>((r) => { release = r; }));
    const d: IHostSignalsDeps = { now: () => 1, command: async () => 'x', run };
    const first = tickHostSignals(d);
    await new Promise((r) => setTimeout(r, 0));
    await tickHostSignals(d);
    expect(run).toHaveBeenCalledTimes(1);
    release({ stdout: JSON.stringify(VALID) });
    await first;
    expect(hostSignalsView(1)).toMatchObject({ state: 'ok' });
    const again = tickHostSignals(d);
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(2);
    release({ stdout: JSON.stringify(VALID) });
    await again;
  });
});
