import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_EXIT_FILE_GRACE_MS,
  LivenessManager,
  REMOTE_JOB_BACKOFF_MS,
  REMOTE_JOB_REARM_MS,
  REMOTE_JOB_UNREACHABLE_BOUND,
  type ILivenessManagerDeps,
} from '@/lib/liveness-manager';
import { jobHoldsWork } from '@/lib/background-job-state';
import {
  REMOTE_JOB_PROBE_SCRIPT,
  parseRemoteJobProbe,
  remoteJobProbeCommand,
  type TRemoteJobReading,
} from '@/lib/remote-job-probe';
import type { IBackgroundJob, TLivenessEvent } from '@/types/liveness';

const store = vi.hoisted(() => ({ saved: [] as IBackgroundJob[] }));

vi.mock('@/lib/liveness-store', () => ({
  readAllLiveness: vi.fn(async () => ({ probes: [], jobs: store.saved })),
  upsertProbe: vi.fn(async () => {}),
  removeProbes: vi.fn(async () => 0),
  upsertJob: vi.fn(async () => {}),
  removeJobs: vi.fn(async () => 0),
  removeTabEntries: vi.fn(async () => {}),
}));

const REMOTE = 'host-b-lan';

const job = (overrides: Partial<IBackgroundJob> = {}): IBackgroundJob => ({
  workspaceId: 'ws-1',
  tabId: 'tab-1',
  pid: 157985,
  label: 'gate',
  registeredAt: 0,
  ...overrides,
});

const alive: TRemoteJobReading = { state: 'alive' };
const exited = (exitCodeRaw: string | null, stderrRaw: string | null = null): TRemoteJobReading => ({ state: 'exited', exitCodeRaw, stderrRaw });

type TProbe = (host: string, jobs: readonly IBackgroundJob[]) => Promise<TRemoteJobReading[]>;

const harness = (opts: { probe?: TProbe; resolveJobHost?: ILivenessManagerDeps['resolveJobHost'] } = {}) => {
  let now = 1_000_000;
  const deps = {
    runCommand: vi.fn(async () => ({ stdout: '0\n', stderr: '', exitCode: 0 })),
    isPidAlive: vi.fn<(pid: number) => boolean>(() => false),
    readTail: vi.fn<(file: string, maxBytes: number) => Promise<string | null>>(async () => null),
    resolveCwd: async () => '/tmp',
    now: () => now,
    probeRemoteJobs: vi.fn<TProbe>(opts.probe ?? (async (_host, jobs) => jobs.map(() => alive))),
    ...(opts.resolveJobHost ? { resolveJobHost: opts.resolveJobHost } : {}),
  };
  const manager = new LivenessManager(deps);
  const events: TLivenessEvent[] = [];
  return {
    manager,
    deps,
    events,
    tick: () => manager.tick((e) => events.push(e)),
    advance: (ms: number) => { now += ms; },
    statusOf: async (tabId = 'tab-1') => (await manager.statusForTab(tabId)).backgroundJobs,
  };
};

const fail: TProbe = async () => { throw new Error('ssh to host-b-lan failed (exit 255)'); };

describe('remote background jobs are judged on their own host (D63)', () => {
  it('remote alive: alive on its host though this server has no such pid, and never read from this host', async () => {
    const h = harness();
    await h.manager.registerJob(job({ host: REMOTE }));
    await h.tick();
    expect(h.events).toEqual([]);
    expect(h.deps.probeRemoteJobs).toHaveBeenCalledWith(REMOTE, [expect.objectContaining({ pid: 157985 })]);
    expect(h.deps.isPidAlive).not.toHaveBeenCalled();
    expect(h.deps.readTail).not.toHaveBeenCalled();
    expect(await h.statusOf()).toEqual([expect.objectContaining({ pid: 157985, host: REMOTE, alive: true, state: 'alive' })]);
  });

  it('remote exited with a code: completed for 0, failed with the remote stderr tail otherwise', async () => {
    const h = harness({
      probe: async (_host, jobs) => jobs.map((j) => (j.pid === 1 ? exited('0\n') : exited('3\n', 'boom\nlast line\n'))),
    });
    await h.manager.registerJob(job({ host: REMOTE, pid: 1, exitCodeFile: '/r/1.exit' }));
    await h.manager.registerJob(job({ host: REMOTE, pid: 2, exitCodeFile: '/r/2.exit', stderrFile: '/r/2.err' }));
    await h.tick();
    expect(h.events.map((e) => e.kind)).toEqual(['bg-completed', 'bg-failed']);
    expect(h.events[1]).toMatchObject({ exitCode: 3, stderrTail: 'boom\nlast line' });
    expect(h.deps.readTail).not.toHaveBeenCalled();
    expect(h.deps.probeRemoteJobs).toHaveBeenCalledTimes(1);
    expect(await h.statusOf()).toEqual([]);
  });

  it('remote exited with no code: unknown at once with no exit file, after the grace when its exit file is missing', async () => {
    const h = harness({ probe: async (_host, jobs) => jobs.map(() => exited(null)) });
    await h.manager.registerJob(job({ host: REMOTE, pid: 1 }));
    await h.manager.registerJob(job({ host: REMOTE, pid: 2, exitCodeFile: '/r/2.exit' }));
    await h.tick();
    expect(h.events.map((e) => [e.kind, 'job' in e && e.job.pid])).toEqual([['bg-exited-unknown', 1]]);
    h.advance(BACKGROUND_EXIT_FILE_GRACE_MS);
    await h.tick();
    expect(h.events.map((e) => [e.kind, 'job' in e && e.job.pid])).toEqual([['bg-exited-unknown', 1], ['bg-exited-unknown', 2]]);
  });

  it('an oversized remote exit file is not a code', async () => {
    const h = harness({ probe: async (_host, jobs) => jobs.map(() => exited(`${' '.repeat(64)}0`)) });
    await h.manager.registerJob(job({ host: REMOTE, exitCodeFile: '/r/x.exit' }));
    await h.tick();
    h.advance(BACKGROUND_EXIT_FILE_GRACE_MS);
    await h.tick();
    expect(h.events.map((e) => e.kind)).toEqual(['bg-exited-unknown']);
  });

  it('a pid live on this server but registered by a remote tab never reads alive (the host routing)', async () => {
    const h = harness({ probe: async (_host, jobs) => jobs.map(() => exited('0\n')) });
    h.deps.isPidAlive.mockReturnValue(true);
    await h.manager.registerJob(job({ host: REMOTE, exitCodeFile: '/r/x.exit' }));
    expect((await h.statusOf())[0]).toMatchObject({ alive: false, state: 'unknown' });
    await h.tick();
    expect(h.events.map((e) => e.kind)).toEqual(['bg-completed']);
    expect(h.deps.isPidAlive).not.toHaveBeenCalled();
  });

  it('a pid dead on this server is not exited when its host says it runs, and a local job keeps this host\'s verdict', async () => {
    const h = harness();
    await h.manager.registerJob(job({ host: REMOTE, pid: 7 }));
    await h.manager.registerJob(job({ pid: 8 }));
    await h.tick();
    expect(h.events.map((e) => [e.kind, 'job' in e && e.job.pid])).toEqual([['bg-exited-unknown', 8]]);
    expect(h.deps.isPidAlive.mock.calls.map(([pid]) => pid)).toEqual([8]);
    expect(h.deps.probeRemoteJobs.mock.calls.map(([, jobs]) => jobs.map((j) => j.pid))).toEqual([[7]]);
  });
});

describe('an unreachable host leaves its jobs unknown, never exited (AC 3)', () => {
  it('below the bound: no event, the job unknown but holding its tab, not pending dead', async () => {
    const h = harness({ probe: fail });
    await h.manager.registerJob(job({ host: REMOTE }));
    for (let pass = 1; pass < REMOTE_JOB_UNREACHABLE_BOUND; pass += 1) {
      await h.tick();
      h.advance(REMOTE_JOB_BACKOFF_MS);
    }
    expect(h.events).toEqual([]);
    const [status] = await h.statusOf();
    expect(status).toMatchObject({ alive: false, state: 'unknown', host: REMOTE });
    expect(jobHoldsWork(status)).toBe(true);
    expect(await h.manager.reconcileJobs('tab-1', (e) => h.events.push(e))).toEqual({ reported: 0, pendingDead: 0 });
    expect(h.deps.isPidAlive).not.toHaveBeenCalled();
  });

  it('at the bound: one "host unreachable" report per job, none after; the job stays and its real exit is reported later', async () => {
    let reachable = false;
    const h = harness({ probe: async (host, jobs) => (reachable ? jobs.map(() => exited('0\n')) : fail(host, jobs)) });
    await h.manager.registerJob(job({ host: REMOTE, notify: 'self', exitCodeFile: '/r/x.exit' }));
    for (let pass = 0; pass < REMOTE_JOB_UNREACHABLE_BOUND + 2; pass += 1) {
      await h.tick();
      h.advance(REMOTE_JOB_BACKOFF_MS);
    }
    expect(h.events).toEqual([expect.objectContaining({ kind: 'bg-host-unreachable', host: REMOTE, failures: REMOTE_JOB_UNREACHABLE_BOUND })]);
    expect(h.events[0]).toMatchObject({ error: expect.stringContaining('exit 255') });
    expect(await h.statusOf()).toHaveLength(1);

    reachable = true;
    await h.tick();
    expect(h.events.map((e) => e.kind)).toEqual(['bg-host-unreachable', 'bg-completed']);
  });

  it('a pass inside the backoff is skipped and counted as neither', async () => {
    const h = harness({ probe: fail });
    await h.manager.registerJob(job({ host: REMOTE }));
    await h.tick();
    await h.tick();
    await h.tick();
    expect(h.deps.probeRemoteJobs).toHaveBeenCalledTimes(1);
    h.advance(REMOTE_JOB_BACKOFF_MS);
    await h.tick();
    await h.tick();
    expect(h.deps.probeRemoteJobs).toHaveBeenCalledTimes(2);
    expect(h.events).toEqual([]);
  });

  it('reconcileJobs never runs ssh, so it adds no failure to a pass', async () => {
    const h = harness({ probe: fail });
    await h.manager.registerJob(job({ host: REMOTE }));
    await h.tick();
    for (let i = 0; i < 5; i += 1) await h.manager.reconcileJobs('tab-1', (e) => h.events.push(e));
    expect(h.deps.probeRemoteJobs).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);
  });

  it('re-arms only after the host has stayed good for a while', async () => {
    let up = false;
    const h = harness({ probe: async (host, jobs) => (up ? jobs.map(() => alive) : fail(host, jobs)) });
    await h.manager.registerJob(job({ host: REMOTE }));
    const outage = async () => {
      up = false;
      for (let pass = 0; pass < REMOTE_JOB_UNREACHABLE_BOUND; pass += 1) {
        await h.tick();
        h.advance(REMOTE_JOB_BACKOFF_MS);
      }
    };
    await outage();
    expect(h.events).toHaveLength(1);

    up = true;
    await h.tick();
    await outage();
    expect(h.events).toHaveLength(1);

    up = true;
    await h.tick();
    h.advance(REMOTE_JOB_REARM_MS);
    await h.tick();
    await outage();
    expect(h.events.map((e) => e.kind)).toEqual(['bg-host-unreachable', 'bg-host-unreachable']);
  });

  it('the exit-file grace stands across an unknown pass and expires only on the host\'s answer', async () => {
    let reply: 'exited' | 'down' = 'exited';
    const h = harness({ probe: async (host, jobs) => (reply === 'exited' ? jobs.map(() => exited(null)) : fail(host, jobs)) });
    await h.manager.registerJob(job({ host: REMOTE, exitCodeFile: '/r/x.exit' }));
    await h.tick();
    expect(h.events).toEqual([]);
    reply = 'down';
    h.advance(REMOTE_JOB_BACKOFF_MS);
    await h.tick();
    expect(h.events).toEqual([]);
    expect(await h.manager.reconcileJobs('tab-1', (e) => h.events.push(e))).toEqual({ reported: 0, pendingDead: 0 });
    reply = 'exited';
    h.advance(REMOTE_JOB_BACKOFF_MS);
    await h.tick();
    expect(h.events.map((e) => e.kind)).toEqual(['bg-exited-unknown']);
  });

  it('a job registered while its host\'s probe is in flight gets no verdict from it', async () => {
    let release!: (r: TRemoteJobReading[]) => void;
    const h = harness({ probe: () => new Promise((resolve) => { release = resolve; }) });
    await h.manager.registerJob(job({ host: REMOTE, pid: 1 }));
    const pass = h.tick();
    await vi.waitFor(() => expect(h.deps.probeRemoteJobs).toHaveBeenCalledTimes(1));
    await h.manager.registerJob(job({ host: REMOTE, pid: 1 }));
    await h.manager.registerJob(job({ host: REMOTE, pid: 2 }));
    release([exited('0\n')]);
    await pass;
    expect(h.events).toEqual([]);
    expect((await h.statusOf()).map((s) => [s.pid, s.state])).toEqual([[1, 'unknown'], [2, 'unknown']]);
  });

  it('a server with no remote probe leaves a remote job unknown and never judges it here', async () => {
    const manager = new LivenessManager({
      runCommand: vi.fn(), isPidAlive: vi.fn(() => true), readTail: vi.fn(), resolveCwd: async () => undefined, now: () => 0,
    });
    await manager.registerJob(job({ host: REMOTE }));
    const events: TLivenessEvent[] = [];
    await manager.tick((e) => events.push(e));
    expect(events).toEqual([]);
    expect((await manager.statusForTab('tab-1')).backgroundJobs[0]).toMatchObject({ alive: false, state: 'unknown' });
  });
});

describe('a job saved before jobs named their host (the release itself)', () => {
  it('gets its tab\'s host from the layout before the first pass and is judged there', async () => {
    store.saved = [job({ tabId: 'tab-n3saU6' })];
    const h = harness({ resolveJobHost: async (_ws, tabId) => (tabId === 'tab-n3saU6' ? REMOTE : null) });
    await h.tick();
    store.saved = [];
    expect(h.events).toEqual([]);
    expect(h.deps.isPidAlive).not.toHaveBeenCalled();
    expect(h.deps.probeRemoteJobs).toHaveBeenCalledWith(REMOTE, [expect.objectContaining({ pid: 157985, host: REMOTE })]);
    expect(await h.statusOf('tab-n3saU6')).toEqual([expect.objectContaining({ host: REMOTE, state: 'alive' })]);
  });

  it('stays unknown, never local, while the layout is unreadable, and resolves on a later pass', async () => {
    store.saved = [job()];
    let readable = false;
    const h = harness({ resolveJobHost: async () => { if (!readable) throw new Error('EACCES'); return null; } });
    await h.tick();
    store.saved = [];
    expect(h.events).toEqual([]);
    expect(h.deps.isPidAlive).not.toHaveBeenCalled();
    expect((await h.statusOf())[0]).toMatchObject({ state: 'unknown', alive: false });
    expect(await h.manager.reconcileJobs('tab-1', (e) => h.events.push(e))).toEqual({ reported: 0, pendingDead: 0 });

    readable = true;
    await h.tick();
    expect(h.events.map((e) => e.kind)).toEqual(['bg-exited-unknown']);
  });
});

describe('a local registration and a legacy record are told apart (review r1, finding 1)', () => {
  it('a caller-local pid registered against a remote tab (host null) is still judged here after a restart', async () => {
    store.saved = [job({ tabId: 'tab-remote', host: null })];
    const resolveJobHost = vi.fn(async () => REMOTE);
    const h = harness({ resolveJobHost });
    h.deps.isPidAlive.mockReturnValue(true);
    await h.tick();
    store.saved = [];
    expect(resolveJobHost).not.toHaveBeenCalled();
    expect(h.deps.probeRemoteJobs).not.toHaveBeenCalled();
    expect(h.deps.isPidAlive).toHaveBeenCalledWith(157985);
    expect(await h.statusOf('tab-remote')).toEqual([expect.objectContaining({ state: 'alive' })]);
    expect((await h.statusOf('tab-remote'))[0]).not.toHaveProperty('host');
  });

  it('a legacy record with no host key still fills in from the layout, local included', async () => {
    store.saved = [job({ tabId: 'tab-remote', pid: 1 }), job({ tabId: 'tab-local', pid: 2 })];
    const h = harness({ resolveJobHost: async (_ws, tabId) => (tabId === 'tab-remote' ? REMOTE : null) });
    h.deps.isPidAlive.mockReturnValue(true);
    await h.tick();
    const [remote, local] = store.saved;
    store.saved = [];
    expect(remote.host).toBe(REMOTE);
    expect(local.host).toBeNull();
    expect(h.deps.probeRemoteJobs.mock.calls.map(([host, jobs]) => [host, jobs.map((j) => j.pid)])).toEqual([[REMOTE, [1]]]);
    expect(h.deps.isPidAlive.mock.calls.map(([pid]) => pid)).toEqual([2]);
  });
});

describe('a remote exit-file grace ends only on a newer probe (review r1, finding 2)', () => {
  it('a reconcile after the grace reports nothing from the old bytes; a later probe that sees the file reports the real code', async () => {
    let exitRaw: string | null = null;
    const h = harness({ probe: async (_host, jobs) => jobs.map(() => exited(exitRaw)) });
    await h.manager.registerJob(job({ host: REMOTE, exitCodeFile: '/r/x.exit' }));
    await h.tick();
    h.advance(BACKGROUND_EXIT_FILE_GRACE_MS + 1_000);
    expect(await h.manager.reconcileJobs('tab-1', (e) => h.events.push(e))).toEqual({ reported: 0, pendingDead: 1 });
    expect(h.events).toEqual([]);
    exitRaw = '7\n';
    await h.tick();
    expect(h.events).toEqual([expect.objectContaining({ kind: 'bg-failed', exitCode: 7 })]);
  });
});

describe('one host\'s failures leave another host alone', () => {
  it('counts, backs off and alerts per host', async () => {
    const h = harness({ probe: async (host, jobs) => (host === REMOTE ? fail(host, jobs) : jobs.map(() => alive)) });
    await h.manager.registerJob(job({ host: REMOTE, pid: 1 }));
    await h.manager.registerJob(job({ host: 'gpu-1', pid: 2 }));
    for (let pass = 0; pass < REMOTE_JOB_UNREACHABLE_BOUND; pass += 1) {
      await h.tick();
      h.advance(REMOTE_JOB_BACKOFF_MS);
    }
    expect(h.events.map((e) => [e.kind, 'job' in e && e.job.pid])).toEqual([['bg-host-unreachable', 1]]);
    expect(h.deps.probeRemoteJobs.mock.calls.filter(([host]) => host === 'gpu-1')).toHaveLength(REMOTE_JOB_UNREACHABLE_BOUND);
    expect((await h.statusOf()).map((s) => [s.pid, s.state])).toEqual([[1, 'unknown'], [2, 'alive']]);
  });
});

describe('isJobAlive for a job taken by a restart', () => {
  it('a legacy job whose host is still unresolved is alive, never judged by this server\'s procfs', async () => {
    store.saved = [job()];
    const h = harness({ resolveJobHost: async () => { throw new Error('EACCES'); } });
    await h.tick();
    store.saved = [];
    const [taken] = await h.manager.takeJobs('ws-1', 'tab-1');
    expect(await h.manager.isJobAlive(taken)).toBe(true);
    expect(h.deps.isPidAlive).not.toHaveBeenCalled();
    await h.manager.registerJob(taken);
    expect((await h.statusOf())[0]).toMatchObject({ state: 'unknown' });
  });

  it('asks a remote job\'s host: exited is dead, no answer keeps it', async () => {
    let reply: 'alive' | 'exited' | 'down' = 'exited';
    const h = harness({ probe: async (host, jobs) => (reply === 'down' ? fail(host, jobs) : jobs.map(() => (reply === 'alive' ? alive : exited(null)))) });
    h.deps.isPidAlive.mockReturnValue(true);
    expect(await h.manager.isJobAlive(job({ host: REMOTE }))).toBe(false);
    reply = 'alive';
    expect(await h.manager.isJobAlive(job({ host: REMOTE }))).toBe(true);
    reply = 'down';
    expect(await h.manager.isJobAlive(job({ host: REMOTE }))).toBe(true);
    expect(await h.manager.isJobAlive(job())).toBe(true);
    expect(h.deps.isPidAlive).toHaveBeenCalledTimes(1);
  });
});

describe('parseRemoteJobProbe: only one complete frame with this nonce is a reply', () => {
  const frame = (body: string[], n = body.length, nonce = 'n1') => [`begin\t${nonce}`, ...body, `end\t${nonce}\t${n}`].join('\n');

  it('ignores a login banner outside the frame', () => {
    expect(parseRemoteJobProbe(`Welcome to host-b\n${frame(['0\talive', '1\texited\tbMAo=\t-'])}\nbye\n`, 'n1', 2)).toEqual({
      ok: true,
      readings: [alive, exited('0\n', null)],
    });
  });

  it.each([
    ['no frame', 'just a banner\n', 1],
    ['a wrong nonce', frame(['0\talive'], 1, 'other'), 1],
    ['a count that differs', frame(['0\talive'], 1), 2],
    ['a missing job', frame(['0\talive'], 2), 2],
    ['a repeated index', frame(['0\talive', '0\talive'], 2), 2],
    ['an out-of-range index', frame(['5\talive'], 1), 1],
    ['an unknown verb', frame(['0\tzombie'], 1), 1],
    ['bad base64', frame(['0\texited\tb!!!!\t-'], 1), 1],
    ['an unprefixed file field', frame(['0\texited\tMAo=\t-'], 1), 1],
    ['no procfs', 'noproc\n', 1],
    ['a frame that never ends', 'begin\tn1\n0\talive\n', 1],
    ['two frames', `${frame(['0\talive'])}\n${frame(['0\talive'])}`, 1],
  ])('refuses %s', (_name, stdout, count) => {
    expect(parseRemoteJobProbe(stdout, 'n1', count).ok).toBe(false);
  });
});

describe('REMOTE_JOB_PROBE_SCRIPT on a real procfs', () => {
  // Each stand-in fails the way the real tool does and reads only what the real tool reads. The probe runs as
  // `sh -s`, so its stdin is the script itself: where /bin/sh is bash (Amazon Linux 2023) the script is read
  // as it runs, and a stand-in `tail` that drained stdin would eat the rest of it, `end` line included. The
  // real `tail -c N -- FILE` never reads stdin; `base64` reads the pipe from tail, which its stand-in drains.
  it.each([
    ['tail', '#!/bin/sh\necho "tail: cannot read" >&2\nexit 1\n'],
    ['base64', '#!/bin/sh\ncat >/dev/null 2>&1\nexit 1\n'],
  ])('reads a file as unreadable, not empty, when %s fails on the host', (tool, body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-remote-job-'));
    try {
      const bin = path.join(dir, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, tool), body, { mode: 0o755 });
      fs.writeFileSync(path.join(dir, 'exit'), '0\n');
      const stdout = execFileSync('/bin/sh', ['-c', remoteJobProbeCommand('n9', [job({ pid: 2 ** 22 + 11, exitCodeFile: path.join(dir, 'exit') })])], {
        input: REMOTE_JOB_PROBE_SCRIPT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }).toString();
      expect(parseRemoteJobProbe(stdout, 'n9', 1)).toEqual({ ok: true, readings: [exited(null, null)] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });


  it('reads a live pid, a dead pid\'s exit file and stderr tail, and treats hostile paths as data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-remote-job-'));
    try {
      fs.writeFileSync(path.join(dir, 'exit'), '3\n');
      fs.writeFileSync(path.join(dir, 'err'), 'one\ntab\there \'quote\'\n');
      const marker = path.join(dir, 'pwned');
      const jobs = [
        job({ pid: process.pid }),
        job({ pid: 2 ** 22 + 7, exitCodeFile: path.join(dir, 'exit'), stderrFile: path.join(dir, 'err') }),
        job({ pid: 2 ** 22 + 9, exitCodeFile: `${dir}/x'; touch '${marker}`, stderrFile: `${dir}/$(touch ${marker})` }),
      ];
      const stdout = execFileSync('/bin/sh', ['-c', remoteJobProbeCommand('nonce42', jobs)], { input: REMOTE_JOB_PROBE_SCRIPT }).toString();
      expect(parseRemoteJobProbe(stdout, 'nonce42', 3)).toEqual({
        ok: true,
        readings: [alive, exited('3\n', 'one\ntab\there \'quote\'\n'), exited(null, null)],
      });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
