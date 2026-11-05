import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultReaperDeps, environHasTabId, reapTabForClose, reapTabProcesses, REAP_GRACE_MS, type ITabReaperDeps } from '@/lib/tab-reaper';
import { getDescendantPids, getTmuxServerPid, killSession } from '@/lib/tmux';
import { auditFile } from '@/lib/coordination-audit';

const realDeps = () => defaultReaperDeps({ descendants: getDescendantPids, tmuxServerPid: getTmuxServerPid });
// In these tests the "pane" is a child of the test process, which plays the
// server; a real pane descends from the tmux server, never from the server.
const paneDeps = (): ITabReaperDeps => ({ ...realDeps(), serverDescendants: async () => [] });

const env = (...entries: string[]) => Buffer.from(entries.join('\0') + '\0');

describe('environHasTabId', () => {
  it('matches the exact entry only', () => {
    expect(environHasTabId(env('HOME=/h', 'PMUX_TAB_ID=tab-ab'), 'tab-ab')).toBe(true);
    expect(environHasTabId(env('PMUX_TAB_ID=tab-abc'), 'tab-ab')).toBe(false);
    expect(environHasTabId(env('PMUX_TAB_ID=tab-a'), 'tab-ab')).toBe(false);
    expect(environHasTabId(env('XPMUX_TAB_ID=tab-ab'), 'tab-ab')).toBe(false);
    expect(environHasTabId(env('NOTE=PMUX_TAB_ID=tab-ab'), 'tab-ab')).toBe(false);
  });
});

describe('reapTabProcesses (fake /proc)', () => {
  const fake = (opts: {
    procs: Record<number, { environ?: string[]; uid?: number; pgid?: number; ignoresTerm?: boolean; stopped?: boolean }>;
    descendants?: number[];
    proc?: boolean;
    protectedPids?: number[];
    serverDescendants?: number[];
  }) => {
    const alive = new Set(Object.keys(opts.procs).map(Number));
    const starts = new Map([...alive].map((pid) => [pid, `start-${pid}`]));
    const stopped = new Set(Object.entries(opts.procs).filter(([, p]) => p.stopped).map(([pid]) => Number(pid)));
    let clock = 0;
    const signals: string[] = [];
    const deps: ITabReaperDeps = {
      procAvailable: async () => opts.proc ?? true,
      listPids: async () => [...alive],
      readEnviron: async (pid) => (alive.has(pid) && opts.procs[pid]?.environ ? env(...opts.procs[pid].environ!) : null),
      ownerUid: async (pid) => (alive.has(pid) ? opts.procs[pid]?.uid ?? 1000 : null),
      describe: async (pid) => ({ pid, comm: `p${pid}`, args: `cmd ${pid}` }),
      descendants: async () => opts.descendants ?? [],
      processGroup: async (pid) => opts.procs[pid]?.pgid ?? pid,
      isAlive: (pid) => alive.has(pid),
      startTime: async (pid) => (alive.has(pid) ? starts.get(pid) ?? null : null),
      protectedPids: async () => opts.protectedPids ?? [],
      serverDescendants: async () => opts.serverDescendants ?? [],
      kill: (pid, sig) => {
        signals.push(`${sig}:${pid}`);
        if (sig === 'SIGCONT') stopped.delete(pid);
        // A stopped job acts on SIGTERM only once continued; SIGKILL always.
        if (sig === 'SIGKILL' || (sig === 'SIGCONT' && !opts.procs[pid]?.ignoresTerm && signals.includes(`SIGTERM:${pid}`))
          || (sig === 'SIGTERM' && !opts.procs[pid]?.ignoresTerm && !stopped.has(pid))) alive.delete(pid);
      },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      selfPid: 1,
      uid: 1000,
    };
    return { deps, signals, alive, starts };
  };

  it('SIGTERMs descendants and marked processes, SIGKILLs a survivor after the grace, and reports both', async () => {
    const { deps, signals } = fake({
      procs: {
        1: { environ: ['PMUX_TAB_ID=tab-t'] }, // the server itself: never touched
        10: { environ: ['PMUX_TAB_ID=tab-t'] }, // the pane shell: goes with the session
        11: {}, // a pane descendant without the marker (pre-story-01 child)
        20: { environ: ['PMUX_TAB_ID=tab-t'] }, // setsid'd, re-parented away
        21: { environ: ['PMUX_TAB_ID=tab-t'], ignoresTerm: true },
        30: { environ: ['PMUX_TAB_ID=tab-tx'] }, // another tab whose id extends this one
        40: { environ: ['PMUX_TAB_ID=tab-t'], uid: 0 }, // another user's process
      },
      descendants: [11],
    });
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10 });
    expect(result.reaper).toBe('linux');
    expect(result.envMarker).toBe('present');
    expect(result.killed.map((p) => p.pid).sort()).toEqual([11, 20, 21]);
    expect(result.survivors).toEqual([]);
    expect(signals).toContain('SIGKILL:21');
    expect(signals.some((s) => /:(1|10|30|40)$/.test(s))).toBe(false);
  });

  it('keepProcesses signals only the pane group and skips the marker scan', async () => {
    const { deps } = fake({
      procs: { 10: { environ: ['PMUX_TAB_ID=tab-t'] }, 11: { pgid: 10 }, 12: { pgid: 12 }, 20: { environ: ['PMUX_TAB_ID=tab-t'] } },
      descendants: [11, 12],
    });
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10, keepProcesses: true });
    expect(result.killed.map((p) => p.pid)).toEqual([11]);
  });

  it('says envMarker absent for a tab created before per-tab identity, and still reaps its descendants', async () => {
    const { deps } = fake({ procs: { 10: { environ: ['HOME=/h'] }, 11: {} }, descendants: [11] });
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10 });
    expect(result).toMatchObject({ envMarker: 'absent', killed: [{ pid: 11 }] });
  });

  it('reports reaper unavailable without /proc and touches nothing', async () => {
    const { deps, signals } = fake({ procs: { 11: {} }, descendants: [11], proc: false });
    expect(await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10 })).toEqual({ reaper: 'unavailable', envMarker: 'unknown', killed: [], survivors: [] });
    expect(signals).toEqual([]);
  });

  it('lists a process that survives even SIGKILL as a survivor', async () => {
    const { deps } = fake({ procs: { 20: { environ: ['PMUX_TAB_ID=tab-t'] } } });
    deps.kill = () => {};
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(result.survivors.map((p) => p.pid)).toEqual([20]);
  });

  it('never signals the server\'s ancestors, the tmux server, or pid 0/1, even when they carry the marker (review r1 finding 3)', async () => {
    const { deps, signals } = fake({
      procs: {
        0: { environ: ['PMUX_TAB_ID=tab-t'] },
        1: { environ: ['PMUX_TAB_ID=tab-t'] },
        5: { environ: ['PMUX_TAB_ID=tab-t'] }, // pnpm dev: the server's parent, started in the tab
        6: { environ: ['PMUX_TAB_ID=tab-t'] }, // a tmux server the server started
        20: { environ: ['PMUX_TAB_ID=tab-t'] },
      },
      protectedPids: [5, 6],
    });
    deps.selfPid = 7;
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(result.killed.map((p) => p.pid)).toEqual([20]);
    expect(signals.every((s) => s.endsWith(':20'))).toBe(true);
  });

  it('never signals the server\'s own descendants, even marked ones in the pane\'s tree (architect CONCERN: a nohup server in a tab)', async () => {
    const { deps, signals } = fake({
      procs: {
        10: { environ: ['PMUX_TAB_ID=tab-t'] }, // the pane shell
        5: { environ: ['PMUX_TAB_ID=tab-t'] }, // the server, nohup'd in the tab
        50: { environ: ['PMUX_TAB_ID=tab-t'] }, // a terminal connection the server spawned
        20: { environ: ['PMUX_TAB_ID=tab-t'] }, // the tab's own job
      },
      descendants: [5, 50, 20],
      serverDescendants: [50],
    });
    deps.selfPid = 5;
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: 10 });
    expect(result.killed.map((p) => p.pid)).toEqual([20]);
    expect(signals.every((s) => s.endsWith(':20'))).toBe(true);
  });

  it('leaves a pid reused between the scan and SIGKILL alone, and lists it as killed (review r1 finding 4)', async () => {
    const { deps, signals, starts } = fake({ procs: { 21: { environ: ['PMUX_TAB_ID=tab-t'], ignoresTerm: true } } });
    const sleep = deps.sleep;
    let reused = false;
    deps.sleep = async (ms) => {
      if (!reused) {
        reused = true;
        starts.set(21, 'start-other-process'); // 21 exited; the pid now names another process
      }
      await sleep(ms);
    };
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(signals).not.toContain('SIGKILL:21');
    expect(result).toMatchObject({ killed: [{ pid: 21 }], survivors: [] });
  });

  it('never SIGTERMs a pid reused between the scan and the first signal', async () => {
    const { deps, signals, starts } = fake({ procs: { 20: { environ: ['PMUX_TAB_ID=tab-t'] } } });
    const describe = deps.describe;
    deps.describe = async (pid) => {
      const described = await describe(pid);
      starts.set(pid, 'start-other-process');
      return described;
    };
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(signals).toEqual([]);
    expect(result.survivors).toEqual([]);
  });

  it('continues a stopped job so it acts on SIGTERM inside the grace (nit)', async () => {
    const { deps, signals } = fake({ procs: { 22: { environ: ['PMUX_TAB_ID=tab-t'], stopped: true } } });
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(signals).toEqual(['SIGTERM:22', 'SIGCONT:22']);
    expect(result.killed.map((p) => p.pid)).toEqual([22]);
  });

  it('SIGKILLs a marked process forked during the grace (one rescan)', async () => {
    const { deps, signals, alive, starts } = fake({ procs: { 21: { environ: ['PMUX_TAB_ID=tab-t'], ignoresTerm: true } } });
    const readEnviron = deps.readEnviron;
    deps.readEnviron = async (pid) => (pid === 23 && alive.has(23) ? env('PMUX_TAB_ID=tab-t') : readEnviron(pid));
    const sleep = deps.sleep;
    deps.sleep = async (ms) => {
      if (!starts.has(23)) {
        alive.add(23);
        starts.set(23, 'start-23');
      }
      await sleep(ms);
    };
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(signals).toContain('SIGKILL:23');
    expect(result.killed.map((p) => p.pid).sort()).toEqual([21, 23]);
  });

  it('waits up to 1 s for a SIGKILLed process to leave before calling it a survivor (nit)', async () => {
    const { deps, alive } = fake({ procs: { 21: { environ: ['PMUX_TAB_ID=tab-t'], ignoresTerm: true } } });
    const kill = deps.kill;
    let killedAt: number | null = null;
    deps.kill = (pid, sig) => {
      if (sig === 'SIGKILL') killedAt = deps.now();
      else kill(pid, sig);
    };
    const sleep = deps.sleep;
    deps.sleep = async (ms) => {
      await sleep(ms);
      if (killedAt !== null && deps.now() - killedAt >= 500) alive.delete(21);
    };
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(result).toMatchObject({ killed: [{ pid: 21 }], survivors: [] });
  });

  it('reports one line per process: control characters in comm and args become spaces (review r1 finding 5)', async () => {
    const { deps } = fake({ procs: { 20: { environ: ['PMUX_TAB_ID=tab-t'] } } });
    deps.describe = async (pid) => ({ pid, comm: 'ba\tsh', args: 'bash -c \nkilled 1\r\nok\u0085a\u2028b\u2029c' });
    const result = await reapTabProcesses(deps, { tabId: 'tab-t', panePid: null });
    expect(result.killed).toEqual([{ pid: 20, comm: 'ba sh', args: 'bash -c  killed 1  ok a b c' }]);
  });
});

describe('reapTabForClose (the close step every path runs)', () => {
  const deps = (marked: boolean): ITabReaperDeps => {
    const alive = new Set(marked ? [20] : []);
    return {
      procAvailable: async () => true,
      listPids: async () => [...alive],
      readEnviron: async () => env('PMUX_TAB_ID=tab-t'),
      ownerUid: async () => 1000,
      describe: async (pid) => ({ pid, comm: 'sleep', args: 'sleep 120' }),
      descendants: async () => [],
      processGroup: async (pid) => pid,
      isAlive: (pid) => alive.has(pid),
      startTime: async (pid) => (alive.has(pid) ? 's' : null),
      protectedPids: async () => [],
      serverDescendants: async () => [],
      kill: (pid) => { alive.delete(pid); },
      sleep: async () => {},
      now: () => 0,
      selfPid: 1,
      uid: 1000,
    };
  };

  it('writes one tab-reap audit entry when it signalled anything, saying whether the session was alive', async () => {
    const audit = vi.fn(async () => {});
    await reapTabForClose(deps(true), audit, { tabId: 'tab-t', session: 's-t', sessionAlive: false, panePid: null });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith({
      event: 'tab-reap', tabId: 'tab-t', session: 's-t', sessionAlive: false, keepProcesses: false,
      killed: [{ pid: 20, comm: 'sleep', args: 'sleep 120' }], survivors: [],
    });
  });

  it('protects the pid the tmux-server source returns', async () => {
    const protectedPids = await defaultReaperDeps({ descendants: async () => [], tmuxServerPid: async () => 424242 }).protectedPids();
    expect(protectedPids).toContain(424242);
  });

  it('writes nothing when there was nothing to reap', async () => {
    const audit = vi.fn(async () => {});
    await reapTabForClose(deps(false), audit, { tabId: 'tab-t', session: 's-t', sessionAlive: true, panePid: 10 });
    expect(audit).not.toHaveBeenCalled();
  });
});

// Real processes. Each test uses a random tab id, so the exact-match scan can
// only ever find the sleeps this test started.
describe.runIf(process.platform === 'linux')('reapTabProcesses (real processes, Linux)', () => {
  const started: number[] = [];
  const children: ChildProcess[] = [];
  // Cleanup kills ONLY real pids this test started: never 0 or negative, which
  // would signal the test runner's own process group.
  const killStarted = (pid: number) => {
    if (!Number.isInteger(pid) || pid <= 1) return;
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  };
  afterEach(() => {
    for (const pid of started.splice(0)) killStarted(pid);
    for (const child of children.splice(0)) {
      // The whole detached group (pgid = the child's pid), so a job the test
      // never read a pid for still dies; never a pgid <= 1.
      if (child.pid && child.pid > 1) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      }
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  });

  const tabId = () => `tab-reap${Math.random().toString(36).slice(2, 10)}`;
  const pidsFile = () => `/tmp/pmux-reap-${process.pid}-${Math.random().toString(36).slice(2)}`;

  /** A "pane": a detached bash (own process group) with the tab marker, starting the given jobs. */
  const pane = async (id: string | null, script: string): Promise<{ panePid: number; pids: Record<string, number> }> => {
    const file = pidsFile();
    const child = spawn('bash', ['-c', `${script}\nwait`], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...(id ? { PMUX_TAB_ID: id } : {}), PIDS_FILE: file },
    });
    children.push(child);
    started.push(child.pid!);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf-8').split('\n').includes('ready')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pids: Record<string, number> = {};
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const match = line.match(/^([a-z-]+) (\d+)$/);
      if (!match || Number(match[2]) <= 1) continue;
      pids[match[1]] = Number(match[2]);
      started.push(Number(match[2]));
    }
    fs.rmSync(file, { force: true });
    return { panePid: child.pid!, pids };
  };

  const alive = (pid: number) => {
    try {
      const state = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8').split(') ')[1][0];
      return state !== 'Z';
    } catch {
      return false;
    }
  };

  // setsid(1) calls setsid() after exec, so for a moment its child is still in the pane's group: under load the
  // reaper could scan in that window and rightly kill it as a group member. Wait until its session (field 6 of
  // /proc/<pid>/stat) is no longer the shell's before announcing ready.
  const SETSID_CHILD = 'setsid nohup sleep 120 >/dev/null 2>&1 & echo "setsid $!" >> "$PIDS_FILE"; '
    + 'for _ in $(seq 500); do [ "$(cut -d" " -f6 /proc/$!/stat)" != "$(cut -d" " -f6 /proc/$$/stat)" ] && break; sleep 0.01; done';

  const JOBS = [
    '( sleep 120 & echo "disowned $!" >> "$PIDS_FILE"; disown )',
    SETSID_CHILD,
    'bash -c \'trap "" TERM; for i in $(seq 120); do sleep 1; done\' & echo "ignores-term $!" >> "$PIDS_FILE"',
    'echo ready >> "$PIDS_FILE"',
  ].join('\n');

  it('reaps disowned, setsid-nohup and SIGTERM-ignoring children within 4 s; another tab with a longer id survives', { timeout: 15_000 }, async () => {
    const id = tabId();
    const mine = await pane(id, JOBS);
    const other = await pane(`${id}x`, 'sleep 120 & echo "other $!" >> "$PIDS_FILE"\necho ready >> "$PIDS_FILE"');
    const t0 = Date.now();
    const reaping = reapTabProcesses(paneDeps(), { tabId: id, panePid: mine.panePid });
    // The AC: the jobs are gone within 4 s (the call itself also rescans and settles).
    const jobs = ['disowned', 'setsid', 'ignores-term'].map((name) => mine.pids[name]);
    let goneAt: number | null = null;
    while (goneAt === null && Date.now() - t0 < 10_000) {
      if (jobs.every((pid) => !alive(pid))) goneAt = Date.now();
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const result = await reaping;
    expect(goneAt).not.toBeNull();
    expect(goneAt! - t0).toBeLessThan(REAP_GRACE_MS + 1000);
    const killed = result.killed.map((p) => p.pid);
    for (const name of ['disowned', 'setsid', 'ignores-term']) {
      expect(killed).toContain(mine.pids[name]);
      expect(alive(mine.pids[name])).toBe(false);
    }
    expect(result.envMarker).toBe('present');
    expect(result.survivors).toEqual([]);
    expect(alive(other.pids.other)).toBe(true);
  });

  it('keepProcesses: the setsid child survives and only the pane group is killed', { timeout: 15_000 }, async () => {
    const id = tabId();
    const mine = await pane(id, `sleep 120 & echo "group $!" >> "$PIDS_FILE"\n${SETSID_CHILD}\necho ready >> "$PIDS_FILE"`);
    const result = await reapTabProcesses(paneDeps(), { tabId: id, panePid: mine.panePid, keepProcesses: true });
    const killed = result.killed.map((p) => p.pid);
    expect(killed).toContain(mine.pids.group);
    expect(killed).not.toContain(mine.pids.setsid);
    expect(alive(mine.pids.setsid)).toBe(true);
  });

  it('a pane without the marker (created before per-tab identity) still has its descendants reaped', { timeout: 15_000 }, async () => {
    const mine = await pane(null, 'sleep 120 & echo "child $!" >> "$PIDS_FILE"\necho ready >> "$PIDS_FILE"');
    const result = await reapTabProcesses(paneDeps(), { tabId: tabId(), panePid: mine.panePid });
    expect(result.envMarker).toBe('absent');
    expect(result.killed.map((p) => p.pid)).toContain(mine.pids.child);
    expect(alive(mine.pids.child)).toBe(false);
  });

  it('killSession reaps by the marker when the tab\'s session is already gone (review r1 finding 1)', { timeout: 15_000 }, async () => {
    const id = tabId();
    const mine = await pane(id, 'setsid nohup sleep 120 >/dev/null 2>&1 & echo "orphan $!" >> "$PIDS_FILE"\necho ready >> "$PIDS_FILE"');
    // The "shell exited": the pane bash is gone, its setsid child lives on.
    process.kill(mine.panePid, 'SIGKILL');
    const session = `pmux-reaper-test-no-such-session-${id}`;
    const result = await killSession(session, { tabId: id });
    expect(result?.killed.map((p) => p.pid)).toContain(mine.pids.orphan);
    expect(alive(mine.pids.orphan)).toBe(false);
    // killSession writes the audit line itself (HOME is the test's own).
    const lines = fs.readFileSync(auditFile(), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((entry) => entry.event === 'tab-reap' && entry.tabId === id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ session, sessionAlive: false });
  });

  it('protects the server\'s own parent in the real /proc sources', async () => {
    expect(await realDeps().protectedPids()).toContain(process.ppid);
  });

  it('the real sources never reap a marked process the server itself started', { timeout: 15_000 }, async () => {
    const id = tabId();
    const own = spawn('sleep', ['120'], { detached: false, stdio: 'ignore', env: { ...process.env, PMUX_TAB_ID: id } });
    children.push(own);
    started.push(own.pid!);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const result = await reapTabProcesses(realDeps(), { tabId: id, panePid: null });
    expect(result.killed.map((p) => p.pid)).not.toContain(own.pid);
    expect(alive(own.pid!)).toBe(true);
  });
});
