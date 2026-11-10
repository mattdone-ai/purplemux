import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MountBusyError, MountNotAnsweringError, PULSE_FS_MAX_IN_FLIGHT, PULSE_FS_MOUNTS_TTL_MS, configurePulseFsForTests, mountOf, parseSshfsMounts,
  pulseFs, pulseFsInFlight, pulseFsIssued, resetPulseFsForTests,
} from '@/lib/pulse-fs';
import { clearVerdictCacheForTests, readGates } from '@/lib/pulse-sources';

// Architect CONCERN C1: a read that never returns on the sshfs mount must not take the server's
// libuv threadpool (4 workers) with it. Real never-returning reads: a FIFO opened with no writer.

const CALL_TIMEOUT_MS = 300;
let root: string;
let mount: string;
let local: string;

const release = (fifo: string): void => {
  // Opening the write end (non-blocking, a reader is waiting) and closing it gives every blocked reader EOF.
  try {
    fs.closeSync(fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
  } catch {
    // No reader left: nothing to release.
  }
};

const settlesWithin = async (ms: number, work: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await Promise.race([work(), new Promise((_, reject) => setTimeout(() => reject(new Error(`not settled in ${ms} ms`)), ms))]);
  return performance.now() - started;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-fs-'));
  mount = path.join(root, 'mount');
  local = path.join(root, 'local.txt');
  fs.mkdirSync(path.join(mount, '_output', 'epic', 'evidence', 'gates'), { recursive: true });
  fs.writeFileSync(local, 'local');
  configurePulseFsForTests({ mounts: [mount], callTimeoutMs: CALL_TIMEOUT_MS });
  clearVerdictCacheForTests();
});

afterEach(() => {
  resetPulseFsForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mounts', () => {
  it('reads fuse.sshfs mount points from /proc/mounts, octal escapes decoded; a local path has no mount', () => {
    expect(parseSshfsMounts([
      '/dev/mapper/vg-root / ext4 rw 0 0',
      'user@host-b:/srv/out /home/user/code/acme/_output fuse.sshfs rw,nosuid 0 0',
      'host:/x /mnt/with\\040space fuse.sshfs rw 0 0',
    ].join('\n'))).toEqual(['/home/user/code/acme/_output', '/mnt/with space']);
    expect(mountOf(path.join(mount, '_output', 'x'))).toBe(path.resolve(mount));
    expect(mountOf(local)).toBeNull();
  });
});

describe('the sshfs limiter and breaker (C1)', () => {
  it('a never-returning read on the mount holds at most 2 workers; an unrelated local fs call settles at once', async () => {
    const gates = path.join(mount, '_output', 'epic', 'evidence', 'gates');
    const fifo = path.join(gates, '01-r1.log');
    execFileSync('mkfifo', [fifo]);
    try {
      const targets = { repos: [], libraryGateDirs: [gates], libraryReviewDirs: [], v2Dirs: [] };
      // Three pulses back to back, as three minutes of a board left open would issue them.
      for (let pulse = 0; pulse < 3; pulse++) {
        await readGates(targets, Date.now() - 7 * 86_400_000).catch(() => undefined);
        expect(pulseFsInFlight()).toBeLessThanOrEqual(PULSE_FS_MAX_IN_FLIGHT);
      }
      // The FIFO read still hangs in its worker, yet the server's own fs calls are not queued behind it.
      expect(await settlesWithin(100, () => fs.promises.stat(local))).toBeLessThan(100);
      expect(await settlesWithin(100, () => fs.promises.readFile(local, 'utf8'))).toBeLessThan(100);
      // A dead mount: both slots held by reads that never return. The breaker opens, its probe cannot get a slot,
      // and every later read is refused at once, naming the mount, and never issued.
      await Promise.all([pulseFs.readFile(fifo).catch(() => undefined), pulseFs.readFile(fifo).catch(() => undefined)]);
      expect(pulseFsInFlight()).toBe(PULSE_FS_MAX_IN_FLIGHT);
      const issued = pulseFsIssued().get(path.resolve(mount)) ?? 0;
      const refused = await pulseFs.stat(gates).catch((err: unknown) => err);
      expect(refused).toBeInstanceOf(MountNotAnsweringError);
      expect((refused as Error).message).toMatch(new RegExp(`^${path.resolve(mount)} not answering since \\d{4}-\\d{2}-\\d{2}T`));
      const read = await readGates(targets, Date.now() - 7 * 86_400_000).catch((err: unknown) => err);
      expect(read).toBeInstanceOf(MountNotAnsweringError);
      expect(pulseFsIssued().get(path.resolve(mount)) ?? 0).toBe(issued);
      expect(await settlesWithin(100, () => fs.promises.stat(local))).toBeLessThan(100);
    } finally {
      release(fifo);
    }
    // Once the hung reads return, a probe stat closes the breaker and reads are issued again.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await pulseFs.stat(path.join(mount, '_output')).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulseFsInFlight()).toBe(0);
    await expect(pulseFs.stat(path.join(mount, '_output'))).resolves.toBeTruthy();
  });

  it('a queued call that waits past the timeout is never issued', async () => {
    const fifo = path.join(mount, 'hang');
    execFileSync('mkfifo', [fifo]);
    try {
      const hung = [pulseFs.readFile(fifo).catch(() => 'timed out'), pulseFs.readFile(fifo).catch(() => 'timed out')];
      await new Promise((resolve) => setImmediate(resolve));
      const before = pulseFsIssued().get(path.resolve(mount)) ?? 0;
      expect(before).toBe(PULSE_FS_MAX_IN_FLIGHT);
      const queued = await pulseFs.stat(path.join(mount, '_output')).catch((err: unknown) => err);
      // Waiting in the queue alone is "busy" (confirm r2, F2); the hung reads themselves open the breaker.
      expect(queued).toBeInstanceOf(MountBusyError);
      expect(pulseFsIssued().get(path.resolve(mount)) ?? 0).toBe(before);
      expect(await Promise.all(hung)).toEqual(['timed out', 'timed out']);
    } finally {
      release(fifo);
    }
  });

  it('an absent path is absence; a local path never waits on the limiter', async () => {
    await expect(pulseFs.stat(path.join(mount, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await settlesWithin(100, () => pulseFs.stat(local))).toBeLessThan(100);
  });
});

describe('confirm r2 fixes', () => {
  it('F1: a mount absent at the first read and present later is guarded once the 60 s list expires', async () => {
    let clock = 1_000_000;
    let mountsText = '/dev/mapper/vg-root / ext4 rw 0 0\n';
    configurePulseFsForTests({ readMounts: () => mountsText, now: () => clock, callTimeoutMs: CALL_TIMEOUT_MS });
    const target = path.join(mount, '_output');
    expect(mountOf(target)).toBeNull();
    // The mount unit brings _output up after the server started.
    mountsText += `host-b:/srv/out ${path.resolve(mount)} fuse.sshfs rw,nosuid 0 0\n`;
    clock += PULSE_FS_MOUNTS_TTL_MS - 1;
    expect(mountOf(target)).toBeNull();
    clock += 1;
    expect(mountOf(target)).toBe(path.resolve(mount));
    // Later reads go through the limiter and the breaker.
    const fifo = path.join(mount, 'hang');
    execFileSync('mkfifo', [fifo]);
    try {
      await Promise.all([1, 2, 3].map(() => pulseFs.readFile(fifo).catch(() => undefined)));
      expect(pulseFsInFlight()).toBe(PULSE_FS_MAX_IN_FLIGHT);
      expect(await pulseFs.stat(target).catch((err: unknown) => err)).toBeInstanceOf(MountNotAnsweringError);
      expect(await settlesWithin(100, () => fs.promises.stat(local))).toBeLessThan(100);
    } finally {
      release(fifo);
    }
  });

  it('F2: a call that only waited in the queue is "busy", and never opens the breaker', async () => {
    configurePulseFsForTests({ mounts: [mount], callTimeoutMs: 1_000, queueTimeoutMs: 150 });
    const fifo = path.join(mount, 'slow');
    execFileSync('mkfifo', [fifo]);
    // Two healthy but slow calls hold both slots for 400 ms: well inside the 1 s call timeout.
    const slow = [pulseFs.readFile(fifo), pulseFs.readFile(fifo)];
    const releaser = setTimeout(() => release(fifo), 400);
    try {
      const queued = await pulseFs.stat(path.join(mount, '_output')).catch((err: unknown) => err);
      expect(queued).toBeInstanceOf(MountBusyError);
      expect(queued).not.toBeInstanceOf(MountNotAnsweringError);
      expect((queued as Error).message).toBe(`${path.resolve(mount)} busy: no read slot free in 0.2 s`);
      expect(await Promise.all(slow)).toEqual(['', '']);
      // The breaker stayed closed: the next read is issued and answers at once.
      expect(await settlesWithin(100, () => pulseFs.stat(path.join(mount, '_output')))).toBeLessThan(100);
    } finally {
      clearTimeout(releaser);
      release(fifo);
    }
  });

  it('a busy mount is never read as absence', async () => {
    const { orAbsent } = await import('@/lib/pulse-fs');
    expect(() => orAbsent(false)(new MountBusyError(path.resolve(mount)))).toThrow(MountBusyError);
    expect(orAbsent(false)(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))).toBe(false);
  });
});

