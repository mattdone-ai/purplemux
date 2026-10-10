import fs from 'fs/promises';
import { readFileSync } from 'fs';
import os from 'os';

// A tab's processes die with the tab (ADR-0016, story 16). `killSession` signals
// only the pane shell's process group; jobs started with `&` have their own
// groups, and `disown`, `nohup` and `setsid` children survive the hang-up.
// Measured: a loop retried `tab send` to a closed tab for more than a day, and a
// poll outlived its merged PR by ~20 h.
//
// The tab-owned set is (a) every descendant of the pane pid and (b) every
// process of the server's uid whose environment holds exactly
// `PMUX_TAB_ID=<tabId>` (story 01 puts it in every tab's environment; it
// survives re-parenting). Never a pattern match (C-341).
//
// Never signalled, whatever they carry: pid 0 and 1, the server itself, its
// ancestors (a server started from inside a tab is a child of that tab's
// shell), its own descendants, and the tmux server. A pid whose start time changed between the scan
// and a signal is a different process (a reused pid) and is left alone.

export const REAP_GRACE_MS = 3_000;
const POLL_MS = 100;
/** How long a SIGKILLed process may take to leave /proc before it is listed as a survivor. */
const SETTLE_MS = 1_000;
const MAX_ARGS_CHARS = 200;

export interface IReapedProcess {
  pid: number;
  comm: string;
  args: string;
}

export interface IReapResult {
  /**
   * `unavailable` without /proc (macOS): only the pane group is signalled (NFR-7).
   * `remote`: the reap ran on the tab's remote host (ADR-0022 §9).
   * `remote-skipped`: the host was taken out of remote.hosts and did not answer; nothing was reaped.
   */
  reaper: 'linux' | 'unavailable' | 'remote' | 'remote-skipped';
  /** Whether the pane's own environment carries the tab marker (absent: a tab created before story 01). */
  envMarker: 'present' | 'absent' | 'unknown';
  killed: IReapedProcess[];
  survivors: IReapedProcess[];
  /** A remote reap only: tmux on the host reported the session gone after the kill. */
  sessionGone?: boolean;
}

export interface ITabReaperDeps {
  procAvailable: () => Promise<boolean>;
  listPids: () => Promise<number[]>;
  /** The raw NUL-separated environment, or null when it cannot be read. */
  readEnviron: (pid: number) => Promise<Buffer | null>;
  /** The owning uid, or null when the process is gone. */
  ownerUid: (pid: number) => Promise<number | null>;
  describe: (pid: number) => Promise<IReapedProcess>;
  descendants: (pid: number) => Promise<number[]>;
  /** The process group id, or null when the process is gone. */
  processGroup: (pid: number) => Promise<number | null>;
  /** Running or sleeping; a zombie (exited, not yet reaped by its parent) is not alive. */
  isAlive: (pid: number) => boolean;
  /** The process start time (/proc/<pid>/stat field 22), or null when it is gone: a pid's identity. */
  startTime: (pid: number) => Promise<string | null>;
  /** Pids never signalled: the server's ancestors and the tmux server. */
  protectedPids: () => Promise<number[]>;
  /**
   * The server's own descendants (terminal connections, tmux calls): never
   * a tab's, even when the server runs inside that tab's shell under nohup.
   */
  serverDescendants: () => Promise<number[]>;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  selfPid: number;
  uid: number;
}

/** Exact entry match: `PMUX_TAB_ID=tab-ab` never matches `PMUX_TAB_ID=tab-abc`. */
export const environHasTabId = (environ: Buffer, tabId: string): boolean => {
  const wanted = `PMUX_TAB_ID=${tabId}`;
  return environ.toString('utf-8').split('\0').includes(wanted);
};

/** The fields of /proc/<pid>/stat after the parenthesised comm, which may itself contain spaces. */
const statFields = (raw: string): string[] => raw.slice(raw.lastIndexOf(')') + 2).split(' ');

const readText = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return null;
  }
};

/** The parent pid (/proc/<pid>/stat field 4), or null. */
const parentPid = async (pid: number): Promise<number | null> => {
  const raw = await readText(`/proc/${pid}/stat`);
  const ppid = raw ? Number(statFields(raw)[1]) : NaN;
  return Number.isInteger(ppid) ? ppid : null;
};

/** Every ancestor of `pid` up to init. */
const ancestorsOf = async (pid: number): Promise<number[]> => {
  const found: number[] = [];
  let current = await parentPid(pid);
  while (current !== null && current > 1 && !found.includes(current)) {
    found.push(current);
    current = await parentPid(current);
  }
  return found;
};

export interface IDefaultReaperSources {
  descendants: (pid: number) => Promise<number[]>;
  /** The tmux server's pid, or null when it cannot be read. */
  tmuxServerPid: () => Promise<number | null>;
}

export const defaultReaperDeps = ({ descendants, tmuxServerPid }: IDefaultReaperSources): ITabReaperDeps => ({
  procAvailable: async () => {
    if (process.platform !== 'linux') return false;
    try {
      await fs.access('/proc/self/environ');
      return true;
    } catch {
      return false;
    }
  },
  listPids: async () => (await fs.readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number),
  readEnviron: async (pid) => {
    try {
      return await fs.readFile(`/proc/${pid}/environ`);
    } catch {
      return null;
    }
  },
  ownerUid: async (pid) => {
    try {
      return (await fs.stat(`/proc/${pid}`)).uid;
    } catch {
      return null;
    }
  },
  describe: async (pid) => {
    const comm = (await readText(`/proc/${pid}/comm`))?.trim() ?? '';
    const cmdline = (await readText(`/proc/${pid}/cmdline`)) ?? '';
    return { pid, comm, args: cmdline.split('\0').filter(Boolean).join(' ').slice(0, MAX_ARGS_CHARS) };
  },
  descendants,
  processGroup: async (pid) => {
    const raw = await readText(`/proc/${pid}/stat`);
    const pgid = raw ? Number(statFields(raw)[2]) : NaN;
    return Number.isInteger(pgid) ? pgid : null;
  },
  isAlive: (pid) => {
    try {
      const state = statFields(readFileSync(`/proc/${pid}/stat`, 'utf-8'))[0];
      return state !== 'Z' && state !== 'X';
    } catch {
      return false;
    }
  },
  startTime: async (pid) => {
    const raw = await readText(`/proc/${pid}/stat`);
    return raw ? statFields(raw)[19] ?? null : null;
  },
  serverDescendants: () => descendants(process.pid),
  protectedPids: async () => {
    const tmux = await tmuxServerPid().catch(() => null);
    return [...(await ancestorsOf(process.pid)), ...(tmux ? [tmux] : [])];
  },
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  selfPid: process.pid,
  uid: os.userInfo().uid,
});

/** Every same-uid pid whose environment carries this tab's marker. */
const SCAN_BATCH = 64;

const markedPids = async (deps: ITabReaperDeps, tabId: string): Promise<number[]> => {
  const found: number[] = [];
  const pids = (await deps.listPids()).filter((pid) => pid !== deps.selfPid);
  // A busy host has thousands of processes; read them in parallel batches so the
  // scan does not eat into the 3 s grace the close is bounded by.
  for (let i = 0; i < pids.length; i += SCAN_BATCH) {
    const batch = pids.slice(i, i + SCAN_BATCH);
    const hits = await Promise.all(batch.map(async (pid) => {
      if ((await deps.ownerUid(pid)) !== deps.uid) return null;
      const environ = await deps.readEnviron(pid);
      return environ && environHasTabId(environ, tabId) ? pid : null;
    }));
    for (const pid of hits) if (pid !== null) found.push(pid);
  }
  return found;
};

const signal = (deps: ITabReaperDeps, pid: number, sig: NodeJS.Signals): void => {
  try {
    deps.kill(pid, sig);
  } catch {
    // already gone
  }
};

/** C0, DEL, C1 and the Unicode line/paragraph separators: each ends a line for some reader. */
const isLineBreaking = (code: number): boolean =>
  code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;

/** Control characters out: one process is one CLI line, whatever its argv holds. */
const printable = (text: string): string =>
  Array.from(text, (ch) => (isLineBreaking(ch.charCodeAt(0)) ? ' ' : ch)).join('');

interface ITarget {
  entry: IReapedProcess;
  start: string;
}

/** Still the process the scan found: alive and the same start time. */
const isSameAlive = async (deps: ITabReaperDeps, pid: number, target: ITarget): Promise<boolean> =>
  deps.isAlive(pid) && (await deps.startTime(pid)) === target.start;

/** Signal only if the pid still names the scanned process (never a reused pid). */
const signalTarget = async (deps: ITabReaperDeps, pid: number, target: ITarget, sig: NodeJS.Signals): Promise<void> => {
  if ((await deps.startTime(pid)) === target.start) signal(deps, pid, sig);
};

const describeTargets = async (deps: ITabReaperDeps, pids: Iterable<number>, into: Map<number, ITarget>): Promise<number[]> => {
  const added: number[] = [];
  for (const pid of pids) {
    if (into.has(pid)) continue;
    const start = await deps.startTime(pid);
    if (start === null) continue; // gone before it was signalled
    const described = await deps.describe(pid);
    into.set(pid, { entry: { pid, comm: printable(described.comm), args: printable(described.args) }, start });
    added.push(pid);
  }
  return added;
};

const aliveAmong = async (deps: ITabReaperDeps, targets: Map<number, ITarget>, pids: number[]): Promise<number[]> => {
  const alive: number[] = [];
  for (const pid of pids) if (await isSameAlive(deps, pid, targets.get(pid)!)) alive.push(pid);
  return alive;
};

/** Poll until none of `pids` is alive or `ms` passes; returns the ones still alive. */
const waitGone = async (deps: ITabReaperDeps, targets: Map<number, ITarget>, pids: number[], ms: number): Promise<number[]> => {
  const deadline = deps.now() + ms;
  let alive = await aliveAmong(deps, targets, pids);
  while (alive.length > 0 && deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    alive = await aliveAmong(deps, targets, alive);
  }
  return alive;
};

/**
 * Reap the tab's processes. Called BEFORE its tmux session is killed, while the
 * environ scan still sees children whose parent is alive, and also when the
 * session is already gone (`panePid: null`): the marker outlives the session.
 * SIGTERM (+ SIGCONT for a stopped job), up to 3 s of grace, SIGKILL survivors,
 * then one rescan for anything a target forked meanwhile. `keepProcesses`
 * skips the environ scan (today's behaviour: the pane's process group only).
 */
export const reapTabProcesses = async (
  deps: ITabReaperDeps,
  opts: { tabId: string; panePid: number | null; keepProcesses?: boolean },
): Promise<IReapResult> => {
  const result: IReapResult = { reaper: 'unavailable', envMarker: 'unknown', killed: [], survivors: [] };
  if (!(await deps.procAvailable())) return result;
  result.reaper = 'linux';

  if (opts.panePid !== null) {
    const paneEnviron = await deps.readEnviron(opts.panePid);
    if (paneEnviron) result.envMarker = environHasTabId(paneEnviron, opts.tabId) ? 'present' : 'absent';
  }
  const candidates: number[] = [];
  if (opts.panePid !== null) {
    for (const pid of await deps.descendants(opts.panePid)) {
      // --keep-processes is today's behaviour: the pane's own process group only.
      if (opts.keepProcesses && (await deps.processGroup(pid)) !== opts.panePid) continue;
      candidates.push(pid);
    }
  }
  if (!opts.keepProcesses) candidates.push(...(await markedPids(deps, opts.tabId)));

  // Read AFTER the candidates: a server child started between the two reads is
  // then in the protected set, never a candidate the protection missed.
  const protectedSet = new Set<number>([deps.selfPid, ...(await deps.protectedPids()), ...(await deps.serverDescendants())]);
  // The pane shell goes with the session.
  if (opts.panePid !== null) protectedSet.add(opts.panePid);
  const eligible = (pid: number) => Number.isInteger(pid) && pid > 1 && !protectedSet.has(pid);

  const targets = new Map<number, ITarget>();
  const first = await describeTargets(deps, candidates.filter(eligible), targets);
  for (const pid of first) {
    await signalTarget(deps, pid, targets.get(pid)!, 'SIGTERM');
    await signalTarget(deps, pid, targets.get(pid)!, 'SIGCONT'); // a stopped job only sees SIGTERM once continued
  }
  for (const pid of await waitGone(deps, targets, first, REAP_GRACE_MS)) {
    await signalTarget(deps, pid, targets.get(pid)!, 'SIGKILL');
  }

  // Anything a target forked during the scan or the grace carries the marker too.
  if (!opts.keepProcesses) {
    const late = await describeTargets(deps, (await markedPids(deps, opts.tabId)).filter(eligible), targets);
    for (const pid of late) await signalTarget(deps, pid, targets.get(pid)!, 'SIGKILL');
  }

  const stillAlive = new Set(await waitGone(deps, targets, [...targets.keys()], SETTLE_MS));
  for (const [pid, target] of targets) {
    if (stillAlive.has(pid)) result.survivors.push(target.entry);
    else result.killed.push(target.entry);
  }
  return result;
};

export interface IReapAudit {
  (entry: Record<string, unknown>): Promise<void>;
}

/**
 * The close step every close path runs (ADR-0016): reap the tab, and write
 * one `tab-reap` audit entry when anything was signalled.
 */
export const reapTabForClose = async (
  deps: ITabReaperDeps,
  audit: IReapAudit,
  opts: { tabId: string; session: string; sessionAlive: boolean; panePid: number | null; keepProcesses?: boolean },
): Promise<IReapResult> => {
  const reap = await reapTabProcesses(deps, { tabId: opts.tabId, panePid: opts.panePid, keepProcesses: opts.keepProcesses });
  if (reap.killed.length > 0 || reap.survivors.length > 0) {
    await audit({
      event: 'tab-reap',
      tabId: opts.tabId,
      session: opts.session,
      sessionAlive: opts.sessionAlive,
      keepProcesses: !!opts.keepProcesses,
      killed: reap.killed,
      survivors: reap.survivors,
    });
  }
  return reap;
};
