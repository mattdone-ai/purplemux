// Watches the WORK, not the pane. A tab that is idle-holding while its
// background job is dead looks identical to an idle healthy one — these
// registrations are how the watchdog tells them apart.
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import fs from 'fs/promises';
import { createLogger } from '@/lib/logger';
import {
  readAllLiveness,
  upsertProbe,
  removeProbes,
  upsertJob,
  removeJobs,
  removeTabEntries,
} from '@/lib/liveness-store';
import type { TRemoteJobReading } from '@/lib/remote-job-probe';
import type {
  IBackgroundJob,
  IBackgroundJobStatus,
  ILivenessProbe,
  IProbeStatus,
  TBackgroundJobState,
  TLivenessEvent,
} from '@/types/liveness';

const log = createLogger('liveness');

export const PROBE_TIMEOUT_MS = 15_000;
export const PROBE_FAILURE_ALERT_THRESHOLD = 3;
export const STDERR_TAIL_BYTES = 2_048;
export const STDERR_TAIL_LINES = 10;
export const BACKGROUND_EXIT_FILE_GRACE_MS = 2_000;
export const BACKGROUND_EXIT_CODE_MAX_BYTES = 64;
/** Failed probes of a remote job's host, each from its own pass, before one "host unreachable" report. */
export const REMOTE_JOB_UNREACHABLE_BOUND = 3;
/** A host whose probe failed is not asked again for this long; a skipped pass counts as neither success nor failure. */
export const REMOTE_JOB_BACKOFF_MS = 30_000;
/** A host must answer for this long after an outage before its jobs may report "unreachable" again. */
export const REMOTE_JOB_REARM_MS = 10 * 60_000;

export interface IProbeRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ILivenessManagerDeps {
  runCommand: (command: string, cwd: string | undefined, timeoutMs: number) => Promise<IProbeRunResult>;
  isPidAlive: (pid: number) => boolean;
  readTail: (file: string, maxBytes: number) => Promise<string | null>;
  resolveCwd: (workspaceId: string) => Promise<string | undefined>;
  now: () => number;
  /**
   * Judge one host's jobs there, in one exec: one reading per job, in order.
   * Rejects when the host gives no usable reply. Absent: no remote job can be
   * judged, and each stays unknown.
   */
  probeRemoteJobs?: (host: string, jobs: readonly IBackgroundJob[]) => Promise<TRemoteJobReading[]>;
  /**
   * The host of a tab, for a saved job written before jobs named their host
   * (no `host` key at all): the alias, or null for a local or unknown tab.
   * Throws when the layout is unreadable. Absent: every such job is local.
   */
  resolveJobHost?: (workspaceId: string, tabId: string) => Promise<string | null>;
}

/**
 * Seconds-since-last-progress from a probe's stdout. The last non-empty line
 * must consist entirely of one finite, nonnegative number.
 */
export const parseProbeAge = (stdout: string): number | null => {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  if (!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(last)) return null;
  const age = Number(last);
  return Number.isFinite(age) && age >= 0 ? age : null;
};

export const parseBackgroundExitCode = (raw: string | null): number | null => {
  const value = raw?.trim();
  if (!value || !/^-?\d+$/.test(value)) return null;
  const exitCode = Number(value);
  return Number.isSafeInteger(exitCode) ? exitCode : null;
};

export const tailLines = (raw: string, maxLines: number): string =>
  raw.split('\n').filter((l) => l.trim().length > 0).slice(-maxLines).join('\n');

interface IProbeRuntime {
  lastRunAt: number | null;
  lastAgeS: number | null;
  stale: boolean;
  consecutiveFailures: number;
  lastError: string | null;
  /** Age at the last stalled alert; re-alerts one threshold later so an ignored stall stays loud. */
  lastAlertAgeS: number | null;
  failureAlerted: boolean;
  running: boolean;
}

interface IJobRuntime {
  deadSince: number | null;
  /** A remote job's last verdict; `pending` until its host first answers. */
  remote: 'pending' | 'unknown' | TRemoteJobReading;
  /** When the probe behind `remote` started: its file bytes were read no earlier. */
  remoteReadAt: number;
  unreachableAlerted: boolean;
}

interface IHostRuntime {
  failures: number;
  backoffUntil: number;
  goodSince: number | null;
  probing: boolean;
}

const freshJobRuntime = (): IJobRuntime => ({ deadSince: null, remote: 'pending', remoteReadAt: 0, unreachableAlerted: false });

const freshRuntime = (): IProbeRuntime => ({
  lastRunAt: null,
  lastAgeS: null,
  stale: false,
  consecutiveFailures: 0,
  lastError: null,
  lastAlertAgeS: null,
  failureAlerted: false,
  running: false,
});

const probeKey = (p: Pick<ILivenessProbe, 'workspaceId' | 'tabId' | 'label'>): string =>
  `${p.workspaceId}/${p.tabId}/${p.label}`;
const jobKey = (j: Pick<IBackgroundJob, 'workspaceId' | 'tabId' | 'pid'>): string =>
  `${j.workspaceId}/${j.tabId}/${j.pid}`;

export class LivenessManager {
  private probes = new Map<string, { probe: ILivenessProbe; runtime: IProbeRuntime }>();
  private jobs = new Map<string, { job: IBackgroundJob; runtime: IJobRuntime }>();
  private hosts = new Map<string, IHostRuntime>();
  /**
   * Saved jobs with no `host` key whose tab's host is not read yet: unknown,
   * never judged here. Keyed by the job object, so a job `takeJobs` returned
   * keeps it into `isJobAlive` and a re-registration.
   */
  private unresolvedHosts = new WeakSet<IBackgroundJob>();
  private hydrated: Promise<void> | null = null;

  constructor(private deps: ILivenessManagerDeps) {}

  private ensureHydrated(): Promise<void> {
    if (!this.hydrated) {
      this.hydrated = readAllLiveness().then(async ({ probes, jobs }) => {
        for (const probe of probes) {
          if (!this.probes.has(probeKey(probe))) {
            this.probes.set(probeKey(probe), { probe, runtime: freshRuntime() });
          }
        }
        for (const job of jobs) {
          if (!this.jobs.has(jobKey(job))) {
            this.jobs.set(jobKey(job), { job, runtime: freshJobRuntime() });
            // Only a record with no host key is from before jobs named their host; `null` is a local registration.
            if (job.host === undefined) this.unresolvedHosts.add(job);
          }
        }
        await this.resolveSavedHosts();
      }).catch((err) => {
        log.warn(`hydrate failed: ${err instanceof Error ? err.message : err}`);
      });
    }
    return this.hydrated;
  }

  async registerProbe(probe: ILivenessProbe): Promise<void> {
    await this.ensureHydrated();
    this.probes.set(probeKey(probe), { probe, runtime: freshRuntime() });
    await upsertProbe(probe);
  }

  async unregisterProbes(workspaceId: string, tabId: string, label?: string): Promise<number> {
    await this.ensureHydrated();
    for (const [key, { probe }] of this.probes) {
      if (probe.workspaceId === workspaceId && probe.tabId === tabId && (label === undefined || probe.label === label)) {
        this.probes.delete(key);
      }
    }
    return removeProbes(workspaceId, tabId, label);
  }

  async registerJob(job: IBackgroundJob): Promise<void> {
    await this.ensureHydrated();
    this.jobs.set(jobKey(job), { job, runtime: freshJobRuntime() });
    await upsertJob(job);
  }

  /**
   * A job saved before jobs named their host gets its tab's host from the
   * layout (D63: the release itself must not judge a live remote job here). An
   * unreadable layout leaves it unresolved, tried again each pass.
   */
  private async resolveSavedHosts(): Promise<void> {
    for (const [key, { job, runtime }] of [...this.jobs]) {
      if (!this.unresolvedHosts.has(job)) continue;
      let host: string | null;
      try {
        host = this.deps.resolveJobHost ? await this.deps.resolveJobHost(job.workspaceId, job.tabId) : null;
      } catch (err) {
        log.warn({ tabId: job.tabId, pid: job.pid, err: err instanceof Error ? err.message : String(err) }, 'saved job\'s host unreadable; its state stays unknown');
        continue;
      }
      if (this.jobs.get(key)?.runtime !== runtime) continue;
      // In place, before it leaves the set: a pass holding this entry must never see it hostless and resolved.
      job.host = host;
      this.unresolvedHosts.delete(job);
      upsertJob(job).catch(() => {});
    }
  }

  async unregisterJobs(workspaceId: string, tabId: string, pid?: number): Promise<number> {
    await this.ensureHydrated();
    for (const [key, { job }] of this.jobs) {
      if (job.workspaceId === workspaceId && job.tabId === tabId && (pid === undefined || job.pid === pid)) {
        this.jobs.delete(key);
      }
    }
    return removeJobs(workspaceId, tabId, pid);
  }

  /**
   * Whether a job not registered here (one `takeJobs` returned) still runs. A
   * remote job is asked on its host; no answer keeps it, as it is not known to
   * have exited.
   */
  async isJobAlive(job: IBackgroundJob): Promise<boolean> {
    if (this.unresolvedHosts.has(job)) return true;
    if (!job.host) return this.deps.isPidAlive(job.pid);
    if (!this.deps.probeRemoteJobs) return true;
    try {
      const [reading] = await this.deps.probeRemoteJobs(job.host, [job]);
      return reading?.state !== 'exited';
    } catch {
      return true;
    }
  }

  /** A job's state from what is known now: a remote job reads its last verdict, never this host's procfs. */
  private jobState(job: IBackgroundJob, runtime: IJobRuntime): TBackgroundJobState {
    if (this.unresolvedHosts.has(job)) return 'unknown';
    if (!job.host) return this.deps.isPidAlive(job.pid) ? 'alive' : 'exited';
    return typeof runtime.remote === 'string' ? 'unknown' : runtime.remote.state;
  }

  /** Unregister the tab's jobs and return them, so a caller can register them again (a failed `tab restart`). */
  async takeJobs(workspaceId: string, tabId: string): Promise<IBackgroundJob[]> {
    await this.ensureHydrated();
    const taken = [...this.jobs.values()]
      .map(({ job }) => job)
      .filter((job) => job.workspaceId === workspaceId && job.tabId === tabId);
    await this.unregisterJobs(workspaceId, tabId);
    return taken;
  }

  removeTab(workspaceId: string, tabId: string): void {
    void this.ensureHydrated().then(() => {
      let had = false;
      for (const [key, { probe }] of this.probes) {
        if (probe.workspaceId === workspaceId && probe.tabId === tabId) {
          this.probes.delete(key);
          had = true;
        }
      }
      for (const [key, { job }] of this.jobs) {
        if (job.workspaceId === workspaceId && job.tabId === tabId) {
          this.jobs.delete(key);
          had = true;
        }
      }
      if (had) removeTabEntries(workspaceId, tabId).catch(() => {});
    });
  }

  async statusForTab(tabId: string): Promise<{ probes: IProbeStatus[]; backgroundJobs: IBackgroundJobStatus[] }> {
    await this.ensureHydrated();
    const now = this.deps.now();
    const probes: IProbeStatus[] = [];
    for (const { probe, runtime } of this.probes.values()) {
      if (probe.tabId !== tabId) continue;
      probes.push({
        label: probe.label,
        command: probe.command,
        stalenessThresholdS: probe.stalenessThresholdS,
        intervalS: probe.intervalS,
        lastRunAt: runtime.lastRunAt,
        lastAgeS: runtime.lastAgeS,
        stale: runtime.stale,
        consecutiveFailures: runtime.consecutiveFailures,
        lastError: runtime.lastError,
      });
    }
    const backgroundJobs: IBackgroundJobStatus[] = [];
    for (const { job, runtime } of this.jobs.values()) {
      if (job.tabId !== tabId) continue;
      const state = this.jobState(job, runtime);
      backgroundJobs.push({
        pid: job.pid,
        label: job.label,
        ...(job.host ? { host: job.host } : {}),
        alive: state === 'alive',
        state,
        registeredAt: job.registeredAt,
        ageS: Math.max(0, Math.round((now - job.registeredAt) / 1000)),
      });
    }
    return { probes, backgroundJobs };
  }

  /** One pass over every registration; emits at most one event per stall/death/failure episode. */
  async tick(emit: (event: TLivenessEvent) => void): Promise<void> {
    await this.ensureHydrated();
    await this.resolveSavedHosts();
    await this.probeRemoteHosts(emit);
    await this.checkJobs(emit);
    await this.checkProbes(emit);
  }

  /**
   * Report one tab's dead jobs now, before anyone judges the tab by them (the
   * watchdog's stall check). Measured 27 Sep: tab-peo88o's gate job was dead
   * while the status poll judged the tab, and the job's completion came after
   * a "possibly stalled" nudge. Returns the jobs still registered and dead: an
   * exit file inside its grace keeps its job unreported until a later pass.
   * Safe beside a running tick: each job reports once (the runtime check).
   * A remote job is judged on its host's last answer: this never runs ssh, and
   * a job whose host has not answered is not dead.
   */
  async reconcileJobs(tabId: string, emit: (event: TLivenessEvent) => void): Promise<{ reported: number; pendingDead: number }> {
    await this.ensureHydrated();
    let reported = 0;
    await this.checkJobs((event) => {
      reported += 1;
      emit(event);
    }, tabId);
    let pendingDead = 0;
    for (const { job, runtime } of this.jobs.values()) {
      if (job.tabId === tabId && this.jobState(job, runtime) === 'exited') pendingDead += 1;
    }
    return { reported, pendingDead };
  }

  /**
   * One exec per host that has jobs, every host at once. A host inside its
   * backoff is skipped. Verdicts land only on the jobs the probe was sent, and
   * only while their registration is the one probed.
   */
  private async probeRemoteHosts(emit: (event: TLivenessEvent) => void): Promise<void> {
    const byHost = new Map<string, Array<{ key: string; job: IBackgroundJob; runtime: IJobRuntime }>>();
    for (const [key, { job, runtime }] of this.jobs) {
      if (!job.host || this.unresolvedHosts.has(job)) continue;
      const list = byHost.get(job.host) ?? [];
      list.push({ key, job, runtime });
      byHost.set(job.host, list);
    }
    const now = this.deps.now();
    await Promise.all([...byHost].map(async ([host, listed]) => {
      const state = this.hosts.get(host) ?? { failures: 0, backoffUntil: 0, goodSince: null, probing: false };
      this.hosts.set(host, state);
      if (state.probing || state.backoffUntil > now) return;
      state.probing = true;
      let readings: TRemoteJobReading[] | null = null;
      let error = '';
      try {
        if (!this.deps.probeRemoteJobs) throw new Error('no remote job probe on this server');
        readings = await this.deps.probeRemoteJobs(host, listed.map(({ job }) => job));
        if (readings.length !== listed.length) throw new Error(`${readings.length} readings for ${listed.length} jobs`);
      } catch (err) {
        readings = null;
        error = err instanceof Error ? err.message : String(err);
      } finally {
        state.probing = false;
      }
      const current = listed.filter(({ key, runtime }) => this.jobs.get(key)?.runtime === runtime);
      const answeredAt = this.deps.now();
      if (readings) {
        state.failures = 0;
        state.goodSince ??= answeredAt;
        const rearm = answeredAt - state.goodSince >= REMOTE_JOB_REARM_MS;
        const answered = readings;
        listed.forEach((entry, i) => {
          if (!current.includes(entry)) return;
          entry.runtime.remote = answered[i];
          entry.runtime.remoteReadAt = now;
          if (rearm) entry.runtime.unreachableAlerted = false;
        });
        return;
      }
      state.failures += 1;
      state.backoffUntil = answeredAt + REMOTE_JOB_BACKOFF_MS;
      state.goodSince = null;
      log.warn({ host, failures: state.failures, jobs: listed.length, error }, 'remote job host did not answer; its jobs are unknown');
      for (const { job, runtime } of current) {
        runtime.remote = 'unknown';
        if (state.failures < REMOTE_JOB_UNREACHABLE_BOUND || runtime.unreachableAlerted) continue;
        runtime.unreachableAlerted = true;
        emit({ kind: 'bg-host-unreachable', job, host, failures: state.failures, error });
      }
    }));
  }

  private async checkJobs(emit: (event: TLivenessEvent) => void, onlyTabId?: string): Promise<void> {
    for (const [key, { job, runtime }] of [...this.jobs]) {
      if (onlyTabId !== undefined && job.tabId !== onlyTabId) continue;
      const state = this.jobState(job, runtime);
      // Unknown keeps the exit-file grace as it stands: only an answer from the host moves it.
      if (state === 'unknown') continue;
      if (state === 'alive') {
        runtime.deadSince = null;
        continue;
      }

      // A remote job's files were read on its host, in the probe that found it exited.
      const remote = job.host ? runtime.remote as Extract<TRemoteJobReading, { state: 'exited' }> : null;
      let exitCode: number | null = null;
      if (job.exitCodeFile) {
        const raw = remote ? remote.exitCodeRaw : await this.deps.readTail(job.exitCodeFile, BACKGROUND_EXIT_CODE_MAX_BYTES + 1);
        exitCode = raw !== null && Buffer.byteLength(raw) <= BACKGROUND_EXIT_CODE_MAX_BYTES
          ? parseBackgroundExitCode(raw)
          : null;
        if (exitCode === null) {
          const now = this.deps.now();
          runtime.deadSince ??= now;
          if (now - runtime.deadSince < BACKGROUND_EXIT_FILE_GRACE_MS) continue;
          // A remote job's bytes are a probe's: only a probe begun after the grace started may end it.
          if (remote && runtime.remoteReadAt <= runtime.deadSince) continue;
        }
      }
      let stderrTail: string | null = null;
      if (job.stderrFile) {
        const raw = remote ? remote.stderrRaw : await this.deps.readTail(job.stderrFile, STDERR_TAIL_BYTES);
        if (raw && raw.trim()) stderrTail = tailLines(raw, STDERR_TAIL_LINES);
      }

      if (this.jobs.get(key)?.runtime !== runtime) continue;
      this.jobs.delete(key);
      removeJobs(job.workspaceId, job.tabId, job.pid).catch(() => {});
      if (exitCode === 0) {
        log.info({ tabId: job.tabId, pid: job.pid }, 'background job completed');
        emit({ kind: 'bg-completed', job, exitCode, stderrTail });
      } else if (exitCode !== null) {
        log.warn({ tabId: job.tabId, pid: job.pid, exitCode }, 'background job failed');
        emit({ kind: 'bg-failed', job, exitCode, stderrTail });
      } else {
        log.info({ tabId: job.tabId, pid: job.pid }, 'background job exited with unknown status');
        emit({ kind: 'bg-exited-unknown', job, stderrTail });
      }
    }
  }

  private async checkProbes(emit: (event: TLivenessEvent) => void): Promise<void> {
    const now = this.deps.now();
    const due = [...this.probes.values()].filter(({ probe, runtime }) =>
      !runtime.running && (runtime.lastRunAt === null || now - runtime.lastRunAt >= probe.intervalS * 1000));

    await Promise.all(due.map(async ({ probe, runtime }) => {
      runtime.running = true;
      try {
        const cwd = await this.deps.resolveCwd(probe.workspaceId);
        const result = await this.deps.runCommand(probe.command, cwd, PROBE_TIMEOUT_MS);
        runtime.lastRunAt = this.deps.now();

        const age = result.exitCode === 0 ? parseProbeAge(result.stdout) : null;
        if (age === null) {
          const reason = result.exitCode !== 0
            ? `exit ${result.exitCode}: ${tailLines(result.stderr || result.stdout, 3).slice(0, 300) || '(no output)'}`
            : `invalid age output: ${tailLines(result.stdout, 1).slice(0, 200) || '(empty)'}`;
          this.recordProbeFailure(probe, runtime, reason, emit);
          return;
        }

        runtime.consecutiveFailures = 0;
        runtime.failureAlerted = false;
        runtime.lastError = null;
        runtime.lastAgeS = age;
        runtime.stale = age > probe.stalenessThresholdS;

        if (!runtime.stale) {
          runtime.lastAlertAgeS = null;
          return;
        }
        // First alert of the episode, then again every further threshold-width
        // of silence — an ignored stall must not fade into the backlog.
        if (runtime.lastAlertAgeS === null || age >= runtime.lastAlertAgeS + probe.stalenessThresholdS) {
          runtime.lastAlertAgeS = age;
          log.info({ tabId: probe.tabId, label: probe.label, ageS: age }, 'probe reports stall');
          emit({ kind: 'stalled', probe, ageS: age });
        }
      } catch (err) {
        runtime.lastRunAt = this.deps.now();
        this.recordProbeFailure(probe, runtime, err instanceof Error ? err.message : String(err), emit);
      } finally {
        runtime.running = false;
      }
    }));
  }

  private recordProbeFailure(
    probe: ILivenessProbe,
    runtime: IProbeRuntime,
    error: string,
    emit: (event: TLivenessEvent) => void,
  ): void {
    runtime.consecutiveFailures += 1;
    runtime.lastError = error;
    if (runtime.consecutiveFailures >= PROBE_FAILURE_ALERT_THRESHOLD && !runtime.failureAlerted) {
      runtime.failureAlerted = true;
      log.warn({ tabId: probe.tabId, label: probe.label, failures: runtime.consecutiveFailures, error }, 'probe failing');
      emit({ kind: 'probe-failed', probe, error, failures: runtime.consecutiveFailures });
    }
  }
}

const runCommandReal = (command: string, cwd: string | undefined, timeoutMs: number): Promise<IProbeRunResult> =>
  new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], { cwd, timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
      if (!err) {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
        return;
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      const exitCode = typeof e.code === 'number' ? e.code : 1;
      const extra = e.killed
        ? ` (killed${e.signal ? ` by ${e.signal}` : ''} — probe timeout after ${timeoutMs}ms?)`
        : typeof e.code === 'string' ? ` (${e.code})` : '';
      resolve({ stdout: stdout ?? '', stderr: `${stderr ?? ''}${extra}`, exitCode });
    });
  });

/**
 * The process state letter from `/proc/<pid>/stat` (the field after the
 * command name, which may itself hold spaces and parentheses), or null when it
 * cannot be read: no procfs, or the pid is gone.
 */
export const procStateOf = (stat: string): string | null => {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  return stat.slice(close + 1).trim().charAt(0) || null;
};

export const readProcState = (pid: number): string | null => {
  try {
    return procStateOf(readFileSync(`/proc/${pid}/stat`, 'utf-8'));
  } catch {
    return null;
  }
};

/**
 * Whether a registered pid is still running. `kill(pid, 0)` also succeeds for a
 * zombie — a process that exited and was never reaped by its parent — so the
 * procfs state decides: `Z` (zombie) and `X` (dead) are exits, and the job is
 * reported instead of holding its tab forever. Without procfs the kill verdict
 * stands.
 */
export const isPidAliveReal = (pid: number, procState: (pid: number) => string | null = readProcState): boolean => {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM means the pid exists but belongs to someone else — still alive.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  const state = procState(pid);
  return state !== 'Z' && state !== 'X';
};

const readTailReal = async (file: string, maxBytes: number): Promise<string | null> => {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - maxBytes);
      const length = size - start;
      if (length === 0) return '';
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, start);
      return buf.toString('utf-8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

const g = globalThis as unknown as { __ptLivenessManager?: LivenessManager };

export const getLivenessManager = (): LivenessManager => {
  if (!g.__ptLivenessManager) {
    g.__ptLivenessManager = new LivenessManager({
      runCommand: runCommandReal,
      isPidAlive: (pid) => isPidAliveReal(pid),
      readTail: readTailReal,
      resolveCwd: async (workspaceId) => {
        const { getWorkspaceByIdCached } = await import('@/lib/workspace-store');
        const ws = await getWorkspaceByIdCached(workspaceId);
        return ws?.directories[0];
      },
      now: () => Date.now(),
      probeRemoteJobs: async (host, jobs) => (await import('@/lib/remote-job-probe')).probeRemoteJobs(host, jobs),
      resolveJobHost: async (workspaceId, tabId) => {
        const [{ readWorkspaceLayout }, { collectAllTabs }] = await Promise.all([
          import('@/lib/workspace-layout-read'),
          import('@/lib/layout-tree'),
        ]);
        const layout = await readWorkspaceLayout(workspaceId);
        return (layout && collectAllTabs(layout.root).find((tab) => tab.id === tabId)?.host) || null;
      },
    });
  }
  return g.__ptLivenessManager;
};
