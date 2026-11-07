import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { resolveLayoutDir } from '@/lib/layout-store';
import { createLogger } from '@/lib/logger';
import { isValidRemoteHostName } from '@/lib/remote-host';
import type { IBackgroundJob, ILivenessProbe } from '@/types/liveness';

const log = createLogger('liveness-store');

const WORKSPACES_DIR = path.join(os.homedir(), '.purplemux', 'workspaces');

export interface ILivenessFile {
  probes: ILivenessProbe[];
  jobs: IBackgroundJob[];
}

export type TLivenessEvidence =
  | { known: true; data: ILivenessFile }
  | { known: false };

const g = globalThis as unknown as {
  __ptLivenessLocks?: Map<string, Promise<void>>;
};
if (!g.__ptLivenessLocks) g.__ptLivenessLocks = new Map();

const withLock = async <T>(wsId: string, fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptLivenessLocks!.get(wsId) ?? Promise.resolve();
  g.__ptLivenessLocks!.set(wsId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release!();
    if (g.__ptLivenessLocks!.get(wsId) === next) {
      g.__ptLivenessLocks!.delete(wsId);
    }
  }
};

const resolveLivenessPath = (wsId: string): string =>
  path.join(resolveLayoutDir(wsId), 'liveness.json');

const isFiniteNonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isProbe = (value: unknown): value is ILivenessProbe => {
  if (!value || typeof value !== 'object') return false;
  const probe = value as Record<string, unknown>;
  return typeof probe.workspaceId === 'string'
    && typeof probe.tabId === 'string'
    && typeof probe.label === 'string'
    && typeof probe.command === 'string'
    && isFiniteNonnegative(probe.stalenessThresholdS)
    && isFiniteNonnegative(probe.intervalS)
    && isFiniteNonnegative(probe.registeredAt);
};

const isJob = (value: unknown): value is IBackgroundJob => {
  if (!value || typeof value !== 'object') return false;
  const job = value as Record<string, unknown>;
  return typeof job.workspaceId === 'string'
    && typeof job.tabId === 'string'
    && Number.isSafeInteger(job.pid)
    && (job.pid as number) > 0
    && isFiniteNonnegative(job.registeredAt)
    && (job.host === undefined || job.host === null || isValidRemoteHostName(job.host))
    && (job.label === undefined || typeof job.label === 'string')
    && (job.stderrFile === undefined || typeof job.stderrFile === 'string')
    && (job.exitCodeFile === undefined || typeof job.exitCodeFile === 'string')
    && (job.notify === undefined || job.notify === 'self' || job.notify === 'orchestrator');
};

export const readLivenessEvidence = async (wsId: string): Promise<TLivenessEvidence> => {
  try {
    const parsed = JSON.parse(await fs.readFile(resolveLivenessPath(wsId), 'utf-8')) as Partial<ILivenessFile> | null;
    if (!Array.isArray(parsed?.probes)
      || !parsed.probes.every(isProbe)
      || !Array.isArray(parsed.jobs)
      || !parsed.jobs.every(isJob)
      || parsed.probes.some((probe) => probe.workspaceId !== wsId)
      || parsed.jobs.some((job) => job.workspaceId !== wsId)) return { known: false };
    return { known: true, data: { probes: parsed.probes, jobs: parsed.jobs } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { known: true, data: { probes: [], jobs: [] } };
    }
    return { known: false };
  }
};

const readFileAt = async (filePath: string): Promise<ILivenessFile> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ILivenessFile>;
    return {
      probes: Array.isArray(parsed.probes) ? parsed.probes : [],
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [],
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ err: e }, 'failed to read');
    }
    return { probes: [], jobs: [] };
  }
};

const writeFileAt = async (filePath: string, data: ILivenessFile): Promise<void> => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpFile = filePath + '.tmp';
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, filePath);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }
};

export const readLiveness = async (wsId: string): Promise<ILivenessFile> =>
  readFileAt(resolveLivenessPath(wsId));

const mutate = async (wsId: string, fn: (data: ILivenessFile) => void): Promise<void> =>
  withLock(wsId, async () => {
    const filePath = resolveLivenessPath(wsId);
    const data = await readFileAt(filePath);
    fn(data);
    await writeFileAt(filePath, data);
  });

export const upsertProbe = async (probe: ILivenessProbe): Promise<void> =>
  mutate(probe.workspaceId, (data) => {
    data.probes = data.probes.filter((p) => !(p.tabId === probe.tabId && p.label === probe.label));
    data.probes.push(probe);
  });

export const removeProbes = async (wsId: string, tabId: string, label?: string): Promise<number> => {
  let removed = 0;
  await mutate(wsId, (data) => {
    const before = data.probes.length;
    data.probes = data.probes.filter((p) => p.tabId !== tabId || (label !== undefined && p.label !== label));
    removed = before - data.probes.length;
  });
  return removed;
};

export const upsertJob = async (job: IBackgroundJob): Promise<void> =>
  mutate(job.workspaceId, (data) => {
    data.jobs = data.jobs.filter((j) => !(j.tabId === job.tabId && j.pid === job.pid));
    data.jobs.push(job);
  });

export const removeJobs = async (wsId: string, tabId: string, pid?: number): Promise<number> => {
  let removed = 0;
  await mutate(wsId, (data) => {
    const before = data.jobs.length;
    data.jobs = data.jobs.filter((j) => j.tabId !== tabId || (pid !== undefined && j.pid !== pid));
    removed = before - data.jobs.length;
  });
  return removed;
};

export const removeTabEntries = async (wsId: string, tabId: string): Promise<void> =>
  mutate(wsId, (data) => {
    data.probes = data.probes.filter((p) => p.tabId !== tabId);
    data.jobs = data.jobs.filter((j) => j.tabId !== tabId);
  });

/** Every workspace's registrations, straight off disk — the manager hydrates from this on boot. */
export const readAllLiveness = async (): Promise<ILivenessFile> => {
  let entries;
  try {
    entries = await fs.readdir(WORKSPACES_DIR, { withFileTypes: true });
  } catch {
    return { probes: [], jobs: [] };
  }
  const result: ILivenessFile = { probes: [], jobs: [] };
  await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const data = await readFileAt(path.join(WORKSPACES_DIR, e.name, 'liveness.json'));
        result.probes.push(...data.probes);
        result.jobs.push(...data.jobs);
      }),
  );
  return result;
};
