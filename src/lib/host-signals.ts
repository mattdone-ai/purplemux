import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import type { IHostSignalsValue, THostSignals } from '@/types/coordination';

// Host signals (story 20): the JSON printed by the optional `hostSignalCommand`
// in ~/.purplemux/config.json, run every 5 minutes with a 10 s timeout and
// validated against the schema pinned in architecture.md ("Host-signal JSON").
// A failing command shows its error, never zeros; a result older than 15
// minutes is marked stale. Story 21 writes the Acme script that fills it.

const log = createLogger('host-signals');

export const HOST_SIGNALS_INTERVAL_MS = 5 * 60 * 1000;
export const HOST_SIGNALS_TIMEOUT_MS = 10 * 1000;
export const HOST_SIGNALS_STALE_MS = 15 * 60 * 1000;
export const HOST_SIGNALS_OUTPUT_MAX_BYTES = 256 * 1024;
/** After a timeout the process group gets SIGTERM, then SIGKILL this long after. */
export const HOST_SIGNALS_KILL_GRACE_MS = 2 * 1000;
/** The latest valid stamp `new Date()` can render (ECMAScript time value limit). */
const MAX_TIME_VALUE = 8.64e15;
/** 2001-09-09 in epoch ms: a smaller stamp is epoch SECONDS, which would render as January 1970. */
const MIN_EPOCH_MS = 1e12;

/** Unknown keys are ignored; a missing required key is a validation error. */
export const HOST_SIGNALS_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  stampedAt: z.number().int().min(MIN_EPOCH_MS, 'must be epoch milliseconds').max(MAX_TIME_VALUE, 'must be epoch milliseconds'),
  gateSlots: z.object({
    total: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
    holders: z.array(z.object({ pid: z.number().int(), log: z.string() })),
  }),
  worktrees: z.array(z.object({ repo: z.string(), count: z.number().int().nonnegative(), byEpic: z.record(z.string(), z.number()) })),
  tmpInodesPct: z.number().finite(),
});

export const parseHostSignals = (stdout: string): { ok: true; value: IHostSignalsValue } | { ok: false; error: string } => {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (err) {
    return { ok: false, error: `not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const parsed = HOST_SIGNALS_SCHEMA.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data as IHostSignalsValue };
  const issue = parsed.error.issues[0];
  return { ok: false, error: `invalid: ${issue.path.join('.') || '(root)'} — ${issue.message}` };
};

interface IRunnerState {
  last: { ok: true; value: IHostSignalsValue; ranAt: number } | { ok: false; error: string; ranAt: number } | null;
  configured: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** A run in progress: a tick that finds one skips, so two runs never overlap. */
  inFlight: boolean;
}

const g = globalThis as unknown as { __ptHostSignals?: IRunnerState };
const state = (): IRunnerState => {
  if (!g.__ptHostSignals) g.__ptHostSignals = { last: null, configured: false, timer: null, inFlight: false };
  return g.__ptHostSignals;
};

/** The view the route serves: not configured, pending, or the last result with its stamp and staleness. */
export const hostSignalsView = (now: number): THostSignals => {
  const s = state();
  if (!s.configured) return { state: 'not-configured' };
  if (!s.last) return { state: 'pending' };
  const stale = now - s.last.ranAt > HOST_SIGNALS_STALE_MS;
  return s.last.ok
    ? { state: 'ok', value: s.last.value, ranAt: s.last.ranAt, stale }
    : { state: 'error', error: s.last.error, ranAt: s.last.ranAt, stale };
};

export interface IHostSignalsDeps {
  now: () => number;
  /** The configured command, or null when none is set. Throws when config.json cannot be read or parsed. */
  command: () => Promise<string | null>;
  run: (command: string) => Promise<{ stdout: string } | { error: string }>;
}

export interface IShellLimits {
  timeoutMs: number;
  maxBytes: number;
  graceMs: number;
}

const firstLine = (text: string): string => {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line ? ` — ${line.slice(0, 200)}` : '';
};

/**
 * Runs `command` under /bin/sh in its own process group. Past the timeout or the output cap the
 * whole group gets SIGTERM, then SIGKILL after the grace period, and the call settles at once, so
 * a child that ignores SIGTERM cannot hold a run open. The error names the exit code or signal and
 * the first stderr line only.
 */
export const runShellBounded = (command: string, limits: IShellLimits): Promise<{ stdout: string } | { error: string }> =>
  new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (result: { stdout: string } | { error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // ESRCH: the group has already exited.
      }
    };
    const stop = (why: string) => {
      if (settled) return;
      signalGroup('SIGTERM');
      // Release our ends of the pipes: a grandchild that left the group must not hold them open.
      child.stdout.destroy();
      child.stderr.destroy();
      setTimeout(() => signalGroup('SIGKILL'), limits.graceMs).unref?.();
      finish({ error: why });
    };
    const timer = setTimeout(() => stop(`timed out after ${limits.timeoutMs / 1000} s`), limits.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > limits.maxBytes) stop(`output exceeded ${limits.maxBytes} bytes`);
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf-8');
    });
    child.on('error', (err) => finish({ error: `could not start: ${err.message}` }));
    child.on('close', (code, signal) => {
      if (code === 0) finish({ stdout: Buffer.concat(out).toString('utf-8') });
      else finish({ error: `${code !== null ? `exit ${code}` : `signal ${signal}`}${firstLine(stderr)}` });
    });
  });

/** Reads `hostSignalCommand` from config.json itself: a missing file or key is "not configured", a broken file is an error. */
export const readHostSignalCommand = async (configFile: string): Promise<string | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(configFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const cmd = (JSON.parse(raw) as { hostSignalCommand?: unknown }).hostSignalCommand;
  if (cmd === undefined || cmd === null) return null;
  if (typeof cmd !== 'string') throw new Error('hostSignalCommand is not a string');
  return cmd.trim() || null;
};

export const defaultHostSignalsDeps = (): IHostSignalsDeps => ({
  now: () => Date.now(),
  command: () => readHostSignalCommand(path.join(os.homedir(), '.purplemux', 'config.json')),
  run: (command) => runShellBounded(command, {
    timeoutMs: HOST_SIGNALS_TIMEOUT_MS,
    maxBytes: HOST_SIGNALS_OUTPUT_MAX_BYTES,
    graceMs: HOST_SIGNALS_KILL_GRACE_MS,
  }),
});

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One run: re-reads the config each time, so a new or removed command takes effect at the next run. */
export const runHostSignalsOnce = async (deps: IHostSignalsDeps = defaultHostSignalsDeps()): Promise<void> => {
  const s = state();
  let command: string | null;
  try {
    command = await deps.command();
  } catch (err) {
    // A broken config.json is an error to show, never "not configured".
    s.configured = true;
    s.last = { ok: false, error: `config.json unreadable: ${describeError(err)}`, ranAt: deps.now() };
    log.warn(`host signal config unreadable: ${describeError(err)}`);
    return;
  }
  s.configured = command !== null;
  if (!command) {
    s.last = null;
    return;
  }
  const ranAt = deps.now();
  const out = await deps.run(command);
  if ('error' in out) {
    s.last = { ok: false, error: `command failed: ${out.error}`, ranAt };
    log.warn(`host signal command failed: ${out.error}`);
    return;
  }
  const parsed = parseHostSignals(out.stdout);
  s.last = parsed.ok ? { ok: true, value: parsed.value, ranAt } : { ok: false, error: parsed.error, ranAt };
};

/** One scheduled tick: skipped while the previous run is still in flight. */
export const tickHostSignals = async (deps: IHostSignalsDeps = defaultHostSignalsDeps()): Promise<void> => {
  const s = state();
  if (s.inFlight) return;
  s.inFlight = true;
  try {
    await runHostSignalsOnce(deps);
  } catch (err) {
    log.warn(`host signal run failed: ${describeError(err)}`);
  } finally {
    s.inFlight = false;
  }
};

export const startHostSignals = (deps: IHostSignalsDeps = defaultHostSignalsDeps()): void => {
  const s = state();
  if (s.timer) return;
  const tick = () => void tickHostSignals(deps);
  tick();
  s.timer = setInterval(tick, HOST_SIGNALS_INTERVAL_MS);
  s.timer.unref?.();
};

export const stopHostSignals = (): void => {
  const s = state();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
};

/** Tests only. */
export const resetHostSignals = (): void => {
  stopHostSignals();
  g.__ptHostSignals = undefined;
};
