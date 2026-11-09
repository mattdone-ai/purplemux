import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITabStatusEntry } from '@/types/status';
import type { TCliState } from '@/types/timeline';
import type { ITab } from '@/types/terminal';

// vel-D61: the watchdog told the orchestrator "worker … is INACTIVE (agent process gone). Respawn the tab"
// for remote tabs whose claude was alive, over a link where one ssh took 18-25 s. ADR-0022 §19: a scan that did
// not read the host is unknown, and no inactive transition acts on the tab. Here the real pane scan, the real
// process proof and the real ssh error classification run; only the ssh process itself is simulated.
// Review r1 F1: the proofs never hold the poll. The poll reads what an earlier proof answered.

const HOST = 'host-b';
const HOST2 = 'host-a';
const SESSION = 'pt-ws-1-pane-a-tab-r';
const LOCAL_SESSION = 'pt-ws-1-pane-l-tab-local';

type TReply = { stdout?: string; stderr?: string; code?: number | null; killed?: boolean; signal?: string };
interface ISshCall { host: string; remote: string; input?: string; session?: string }

const ssh = vi.hoisted(() => ({
  calls: [] as ISshCall[],
  scan: (_host: string): TReply | Promise<TReply> => ({ killed: true, code: null, signal: 'SIGTERM' }),
  proof: (_session: string): TReply | Promise<TReply> => ({ killed: true, code: null, signal: 'SIGTERM' }),
  localPanes: '',
  /** Any other ssh call (not a scan, not a proof). */
  other: (_remote: string): TReply | Promise<TReply> => ({ killed: true, code: null, signal: 'SIGTERM' }),
  /** A local pgrep (the pane's descendants, for a local terminal tab's ports); null answers "no children". */
  pgrep: null as null | (() => TReply | Promise<TReply>),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  type TCallback = (err: Error | null, stdout: string, stderr: string) => void;
  const execFile = (cmd: string, args: string[], _opts: unknown, cb: TCallback) => {
    let reply: TReply | Promise<TReply> = { code: 1, stderr: 'no server running on /tmp/tmux-0/purple' };
    const call: ISshCall = { host: '', remote: '' };
    if (cmd === 'tmux' && args.includes('list-panes') && ssh.localPanes) reply = { stdout: ssh.localPanes };
    if (cmd === 'pgrep' && ssh.pgrep) reply = ssh.pgrep();
    if (cmd === 'ssh') {
      call.host = args[args.indexOf('--') + 1] ?? '';
      call.remote = args[args.indexOf('--') + 2] ?? '';
      ssh.calls.push(call);
      if (call.remote.includes("'list-panes' '-a'")) {
        reply = ssh.scan(call.host);
      } else if (call.remote.startsWith("'sh' '-s'")) {
        call.session = call.remote.split(' ')[4]?.replace(/'/g, '');
        reply = ssh.proof(call.session ?? '');
      } else {
        reply = ssh.other(call.remote);
      }
    }
    void Promise.resolve(reply).then((r) => {
      if (r.code !== undefined || r.killed) {
        cb(Object.assign(new Error('failed'), { code: r.code, killed: !!r.killed, signal: r.signal ?? null }), r.stdout ?? '', r.stderr ?? '');
      } else {
        cb(null, r.stdout ?? '', r.stderr ?? '');
      }
    });
    return { stdin: { on: () => {}, end: (input: string) => { call.input = input; } } };
  };
  Object.assign(execFile, {
    [promisify.custom]: (cmd: string, args: string[], opts: unknown) => new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
    }),
  });
  return { ...actual, default: { ...actual, execFile }, execFile };
});
// This host's /proc never answers for a test pane: a local pane's descendants come from pgrep, which the
// child_process mock above answers (and can hold).
vi.mock('@/lib/process-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/process-utils')>()),
  readProcChildren: async () => null,
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, hostname: () => 'control-host' }, hostname: () => 'control-host' };
});

const state = vi.hoisted(() => ({ tabs: [] as ITab[] }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaces: vi.fn(async () => ({ workspaces: [{ id: 'ws-1', name: 'w', directories: ['/tmp'] }] })),
  getWorkspaceByIdCached: vi.fn(async () => undefined),
  getWorkspacesCached: vi.fn(async () => ({ workspaces: [] })),
}));
vi.mock('@/lib/layout-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/layout-store')>()),
  resolveLayoutFile: () => '/nonexistent/layout.json',
  readLayoutFile: vi.fn(async () => ({ root: {} })),
  collectAllTabs: () => state.tabs,
  findTabBySessionName: vi.fn(async (name: string) => state.tabs.find((t) => t.sessionName === name) ?? null),
  updateTabCliStatus: vi.fn(async () => {}),
  updateTabAgentSummary: vi.fn(async () => {}),
}));
vi.mock('@/lib/liveness-manager', () => ({
  getLivenessManager: () => ({ tick: vi.fn(async () => {}), removeTab: vi.fn(), statusForTab: vi.fn(async () => ({ probes: [], backgroundJobs: [] })) }),
}));
vi.mock('@/lib/lease-sweeper', () => ({ getLeaseSweeper: () => ({ sweep: vi.fn(async () => []) }), setLeaseAgentStateSource: vi.fn() }));
vi.mock('@/lib/notification-dispatcher', () => ({
  createStatusSocketChannel: vi.fn(() => ({})),
  createWebPushChannel: vi.fn(() => ({})),
  getNotificationDispatcher: () => ({ dispatch: vi.fn(async () => {}), register: vi.fn() }),
}));
vi.mock('@/lib/fcm-channel', () => ({ registerFcmChannel: vi.fn() }));
vi.mock('@/lib/session-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session-host')>()),
  sessionHostOf: async (s: string) => state.tabs.find((t) => t.sessionName === s)?.host ?? null,
  knownRemoteHosts: () => [HOST, HOST2],
  remoteHostsInUse: async () => [HOST, HOST2],
}));

await Promise.all([
  import('@/lib/providers'),
  import('@/lib/status-manager'),
]);

const scanBackoff = () => (globalThis as unknown as { __ptRemoteScanBackoff?: Map<string, number> }).__ptRemoteScanBackoff;
const paneLine = (session: string, command: string, pid = '4242'): string => `${session}\t${command}\t/home/user\t${pid}\t1794200000\n`;
const pane = (command: string): TReply => ({ stdout: paneLine(SESSION, command) });
const TIMED_OUT: TReply = { killed: true, code: null, signal: 'SIGTERM' };
const SSH_255: TReply = { code: 255, stderr: 'kex_exchange_identification: read: Connection reset by peer' };
const PRESENT: TReply = { stdout: 'present\t%3\t4242\t4300\t918273\n' };
const ABSENT: TReply = { stdout: 'absent\tno claude process in the pane\n' };
const T0 = new Date('2026-11-09T04:44:00Z').getTime();

interface IManager {
  poll: () => Promise<void>;
  registerTab: (id: string, entry: ITabStatusEntry) => void;
}
const internals = (manager: IManager) => manager as unknown as {
  tabs: Map<string, ITabStatusEntry>;
  remoteProofs: { settled: () => Promise<void> };
};
const proofCalls = () => ssh.calls.filter((c) => c.input?.includes('task/*/children'));
const scanCalls = () => ssh.calls.filter((c) => c.remote.includes("'list-panes' '-a'"));

const remoteTab = (id: string, sessionName: string, host = HOST): ITab =>
  ({ id, name: id, order: 0, sessionName, panelType: 'claude-code', host });

const resetWorld = () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  scanBackoff()?.clear();
  ssh.calls = [];
  ssh.scan = () => TIMED_OUT;
  ssh.proof = () => TIMED_OUT;
  ssh.localPanes = '';
  ssh.other = () => TIMED_OUT;
  ssh.pgrep = null;
  state.tabs = [remoteTab('tab-r', SESSION)];
};

const createManager = async (cliState: TCliState) => {
  const { StatusManager } = await import('@/lib/status-manager');
  const manager = new StatusManager(undefined, vi.fn(async () => true), vi.fn(async () => {})) as unknown as IManager;
  for (const tab of state.tabs) {
    if (!tab.host) continue;
    manager.registerTab(tab.id, {
      cliState, workspaceId: 'ws-1', tabName: tab.name, tmuxSession: tab.sessionName, panelType: 'claude-code',
      lastEvent: { name: 'prompt-submit', at: T0 - 30 * 60_000, seq: 1 }, eventSeq: 1,
    });
    const entry = internals(manager).tabs.get(tab.id)!;
    entry.paneTitle = 'claude|/home/user';
    entry.currentProcess = 'claude';
  }
  const nudges = vi.spyOn(manager as unknown as { nudgeOrchestrator: (...a: unknown[]) => Promise<boolean> }, 'nudgeOrchestrator')
    .mockResolvedValue(true);
  const inactiveNudges = () => nudges.mock.calls.filter((c) => c[2] === 'inactive');
  const entry = (id = 'tab-r') => internals(manager).tabs.get(id)!;
  /** One poll, then the proofs it started end: the next poll reads their answers. */
  const pollAndSettle = async () => {
    await manager.poll();
    await internals(manager).remoteProofs.settled();
  };
  return { manager, entry, inactiveNudges, pollAndSettle };
};

describe('a remote claude tab and a host that does not answer (vel-D61, ADR-0022 §19)', () => {
  beforeEach(resetWorld);
  afterEach(() => vi.useRealTimers());

  /** Polls across the 30 s backoffs, so a fresh failure and a skipped host are both seen. */
  const pollAcrossBackoff = async (pollAndSettle: () => Promise<void>) => {
    for (const offset of [0, 10_000, 31_000, 62_000, 93_000]) {
      vi.setSystemTime(T0 + offset);
      await pollAndSettle();
    }
  };

  for (const cliState of ['idle', 'ready-for-review', 'needs-input', 'busy'] as const) {
    it(`a ${cliState} tab keeps ${cliState} and sends no inactive nudge while every scan times out`, async () => {
      const { entry, inactiveNudges, pollAndSettle } = await createManager(cliState);
      await pollAcrossBackoff(pollAndSettle);
      expect(entry().cliState).toBe(cliState);
      expect(entry().paneTitle).toBe('claude|/home/user');
      expect(inactiveNudges()).toEqual([]);
      expect(scanCalls().length).toBeGreaterThan(0);
    });
  }

  it('ssh exit 255 is unknown too: no transition, no nudge', async () => {
    ssh.scan = () => SSH_255;
    ssh.proof = () => SSH_255;
    const { entry, inactiveNudges, pollAndSettle } = await createManager('ready-for-review');
    await pollAcrossBackoff(pollAndSettle);
    expect(entry().cliState).toBe('ready-for-review');
    expect(inactiveNudges()).toEqual([]);
  });

  it('a host that answered once and then times out keeps the tab as it was', async () => {
    let answered = false;
    ssh.scan = () => (answered ? TIMED_OUT : ((answered = true), pane('claude')));
    const { entry, inactiveNudges, pollAndSettle } = await createManager('idle');
    await pollAcrossBackoff(pollAndSettle);
    expect(entry().cliState).toBe('idle');
    expect(inactiveNudges()).toEqual([]);
  });

  describe('an answered scan whose foreground command is not claude', () => {
    for (const command of ['node', '2.1.319', 'bash']) {
      it(`(${command}) with claude proven in the pane on the host: no inactive transition`, async () => {
        ssh.scan = () => pane(command);
        ssh.proof = () => PRESENT;
        const { entry, inactiveNudges, pollAndSettle } = await createManager('ready-for-review');
        await pollAcrossBackoff(pollAndSettle);
        expect(entry().cliState).toBe('ready-for-review');
        expect(inactiveNudges()).toEqual([]);
        expect(proofCalls().length).toBeGreaterThan(0);
      });
    }

    it('with a process proof that times out: unknown, no transition', async () => {
      ssh.scan = () => pane('bash');
      ssh.proof = () => TIMED_OUT;
      const { entry, inactiveNudges, pollAndSettle } = await createManager('idle');
      await pollAcrossBackoff(pollAndSettle);
      expect(entry().cliState).toBe('idle');
      expect(inactiveNudges()).toEqual([]);
    });

    it('with a proof that the host answered and that names no claude process: inactive at the next poll, one nudge', async () => {
      ssh.scan = () => pane('bash');
      ssh.proof = () => ABSENT;
      const { entry, inactiveNudges, pollAndSettle } = await createManager('idle');
      await pollAndSettle();
      expect(entry().cliState).toBe('idle');
      await pollAndSettle();
      expect(entry().cliState).toBe('inactive');
      expect(inactiveNudges()).toHaveLength(1);
    });

    it('an inactive tab at its shell runs no proof', async () => {
      ssh.scan = () => pane('bash');
      ssh.proof = () => ABSENT;
      const { pollAndSettle } = await createManager('inactive');
      await pollAcrossBackoff(pollAndSettle);
      expect(proofCalls()).toEqual([]);
    });
  });

  it('an answered scan without the session is absence: inactive, one nudge that names the host and the check', async () => {
    ssh.scan = () => ({ stdout: '' });
    const { entry, inactiveNudges, pollAndSettle } = await createManager('idle');
    await pollAndSettle();
    expect(entry().cliState).toBe('inactive');
    expect(inactiveNudges()).toHaveLength(1);
    const detail = String(inactiveNudges()[0][3]);
    expect(detail).toContain(HOST);
    expect(detail).toContain('purplemux tab status -w ws-1 tab-r');
    expect(detail).toContain('agentProcess "absent"');
    const { buildNudgeMessage } = await import('@/lib/orchestration');
    expect(buildNudgeMessage('inactive', 'tab-r', 'builder', 'ws-1', detail)).toContain(`is INACTIVE (agent process gone). Respawn the tab or mark its task blocked. It runs on ${HOST}`);
  });

  it('tmux on the host says no server: absence, inactive', async () => {
    ssh.scan = () => ({ code: 1, stderr: 'no server running on /tmp/tmux-1000/pmux-control-host\n' });
    const { entry, inactiveNudges, pollAndSettle } = await createManager('ready-for-review');
    await pollAndSettle();
    expect(entry().cliState).toBe('inactive');
    expect(inactiveNudges()).toHaveLength(1);
  });

  it('a claude foreground on an answered scan needs no process proof', async () => {
    ssh.scan = () => pane('claude');
    const { entry, pollAndSettle } = await createManager('idle');
    await pollAndSettle();
    expect(entry().cliState).toBe('idle');
    expect(proofCalls()).toEqual([]);
  });
});

describe('the proofs are bounded and never hold the poll (review r1 F1)', () => {
  beforeEach(resetWorld);
  afterEach(() => vi.useRealTimers());

  it('cache hit: a present proof is not asked again within 60 s for the same session, pane and command', async () => {
    ssh.scan = () => pane('node');
    ssh.proof = () => PRESENT;
    const { pollAndSettle } = await createManager('idle');
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(1);
    for (const offset of [15_000, 30_000, 59_000]) {
      vi.setSystemTime(T0 + offset);
      await pollAndSettle();
    }
    expect(proofCalls()).toHaveLength(1);
  });

  it('cache expiry and key change: after 60 s, or when the pane or its command changes, it proves again', async () => {
    let command = 'node';
    let pid = '4242';
    ssh.scan = () => ({ stdout: paneLine(SESSION, command, pid) });
    ssh.proof = () => PRESENT;
    const { entry, pollAndSettle } = await createManager('idle');
    await pollAndSettle();
    vi.setSystemTime(T0 + 61_000);
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(2);
    vi.setSystemTime(T0 + 62_000);
    command = '2.1.319';
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(3);
    vi.setSystemTime(T0 + 63_000);
    pid = '5151';
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(4);
    expect(entry().cliState).toBe('idle');
  });

  it('backoff after unknown: that host is not proven again for 30 s, then it is', async () => {
    ssh.scan = () => pane('node');
    ssh.proof = () => TIMED_OUT;
    const { entry, pollAndSettle } = await createManager('idle');
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(1);
    for (const offset of [5_000, 20_000, 29_000]) {
      vi.setSystemTime(T0 + offset);
      await pollAndSettle();
    }
    expect(proofCalls()).toHaveLength(1);
    vi.setSystemTime(T0 + 31_000);
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(2);
    expect(entry().cliState).toBe('idle');
  });

  it('20 tabs on a host whose proofs hang: the poll ends without them, at most 4 run, a local tab is read in the same poll, and the other host is proven alongside', async () => {
    const slow = Array.from({ length: 20 }, (_, i) => remoteTab(`tab-s${i}`, `pt-ws-1-pane-a-tab-s${i}`));
    const other = remoteTab('tab-o', 'pt-ws-1-pane-b-tab-o', HOST2);
    const local: ITab = { id: 'tab-local', name: 'local', order: 0, sessionName: LOCAL_SESSION, panelType: 'terminal' };
    state.tabs = [...slow, other, local];
    ssh.scan = (host) => ({ stdout: host === HOST ? slow.map((t) => paneLine(t.sessionName, 'node')).join('') : paneLine(other.sessionName, 'node') });
    const hung: Array<() => void> = [];
    ssh.proof = (session) => (session === other.sessionName ? PRESENT : new Promise<TReply>((resolve) => { hung.push(() => resolve(PRESENT)); }));
    ssh.localPanes = paneLine(LOCAL_SESSION, 'vim', '777');
    const { manager, entry } = await createManager('idle');

    await manager.poll();
    expect(proofCalls().filter((c) => c.host === HOST)).toHaveLength(4);
    expect(proofCalls().filter((c) => c.host === HOST2)).toHaveLength(1);
    expect(entry('tab-local').terminalStatus).toBe('running');

    vi.setSystemTime(T0 + 10_000);
    await manager.poll();
    expect(proofCalls().filter((c) => c.host === HOST)).toHaveLength(4);

    // Freed slots start the next queued proofs at once, never more than 4 on the host (r2 M1).
    const askedOnHost = () => proofCalls().filter((c) => c.host === HOST).map((c) => c.session);
    for (const release of hung.splice(0)) release();
    await vi.waitFor(() => expect(askedOnHost()).toHaveLength(8));
    expect(new Set(askedOnHost()).size).toBe(8);
    await vi.waitFor(() => expect(hung).toHaveLength(4));
    for (const expected of [12, 16, 20]) {
      for (const release of hung.splice(0)) release();
      await vi.waitFor(() => expect(askedOnHost()).toHaveLength(expected));
    }
    await vi.waitFor(() => expect(hung).toHaveLength(4));
    for (const release of hung.splice(0)) release();
    await internals(manager).remoteProofs.settled();
    expect(new Set(askedOnHost()).size).toBe(20);
    vi.setSystemTime(T0 + 20_000);
    await manager.poll();
    for (const tab of slow) expect(entry(tab.id).cliState).toBe('idle');
  });

  it('20 tabs on a fast host: all proven in one poll, at most 4 at once, and the next poll asks none (r2 M1)', async () => {
    const tabs = Array.from({ length: 20 }, (_, i) => remoteTab(`tab-f${i}`, `pt-ws-1-pane-a-tab-f${i}`));
    state.tabs = tabs;
    ssh.scan = (host) => ({ stdout: host === HOST ? tabs.map((t) => paneLine(t.sessionName, 'node')).join('') : '' });
    let running = 0;
    let peak = 0;
    ssh.proof = () => {
      running += 1;
      peak = Math.max(peak, running);
      return new Promise<TReply>((resolve) => setImmediate(() => { running -= 1; resolve(PRESENT); }));
    };
    const { entry, pollAndSettle } = await createManager('idle');
    await pollAndSettle();
    expect(new Set(proofCalls().map((c) => c.session)).size).toBe(20);
    // An upper bound: each proof reads its ssh budget before it spawns, so a fast one can end before the fourth
    // starts. The exact cap and the drain order are pinned in remote-proof-scheduler.test.ts.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
    vi.setSystemTime(T0 + 30_000);
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(20);
    for (const tab of tabs) expect(entry(tab.id).cliState).toBe('idle');
  });

  it('an in-place restart proves again: the launch stamp is in the key (r2)', async () => {
    ssh.scan = () => pane('node');
    ssh.proof = () => PRESENT;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(T0);
    const { manager, pollAndSettle } = await createManager('idle');
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(1);
    (manager as unknown as { markAgentLaunch: (id: string) => void }).markAgentLaunch('tab-r');
    vi.setSystemTime(T0 + 6_000);
    await pollAndSettle();
    expect(proofCalls()).toHaveLength(2);
    vi.clearAllTimers();
  });
});

describe('busy remote tabs read their titles from the scan, never one ssh each (review r3 C1)', () => {
  beforeEach(resetWorld);
  afterEach(() => vi.useRealTimers());

  const busyFleet = (count: number) => {
    const tabs = Array.from({ length: count }, (_, i) => remoteTab(`tab-b${i}`, `pt-ws-1-pane-a-tab-b${i}`));
    const local: ITab = { id: 'tab-local', name: 'local', order: 0, sessionName: LOCAL_SESSION, panelType: 'terminal' };
    state.tabs = [...tabs, local];
    ssh.localPanes = paneLine(LOCAL_SESSION, 'vim', '777');
    // Every per-tab ssh would hang for ever: a poll that awaited one could not end.
    ssh.other = () => new Promise<TReply>(() => {});
    return tabs;
  };
  const titledLine = (session: string, title: string) => `${session}\tclaude\t/home/user\t4242\t1794200000\t${title}\n`;
  const otherSsh = () => ssh.calls.filter((c) => !c.remote.includes("'list-panes' '-a'") && !c.input?.includes('task/*/children'));

  for (const count of [5, 11]) {
    it(`${count} busy tabs on a slow host that answers its scan: no per-tab ssh, titles from the scan, the local tab read in the same poll`, async () => {
      const tabs = busyFleet(count);
      ssh.scan = (host) => ({ stdout: host === HOST ? tabs.map((t, i) => titledLine(t.sessionName, `\u2733 task ${i}`)).join('') : '' });
      const { manager, entry } = await createManager('busy');
      for (const tab of tabs) entry(tab.id).lastEvent = { name: 'prompt-submit', at: T0, seq: 1 };
      await manager.poll();
      expect(otherSsh()).toEqual([]);
      expect(entry('tab-b0').agentSummary).toBe('task 0');
      expect(entry(`tab-b${count - 1}`).agentSummary).toBe(`task ${count - 1}`);
      expect(entry('tab-local').currentProcess).toBe('vim');
    });

    it(`${count} busy tabs on a down host: no per-tab ssh, each keeps its summary, the local tab read in the same poll`, async () => {
      const tabs = busyFleet(count);
      ssh.scan = (host) => (host === HOST ? TIMED_OUT : { stdout: '' });
      const { manager, entry } = await createManager('busy');
      for (const tab of tabs) {
        entry(tab.id).lastEvent = { name: 'prompt-submit', at: T0, seq: 1 };
        entry(tab.id).agentSummary = 'earlier summary';
      }
      await manager.poll();
      vi.setSystemTime(T0 + 31_000);
      await manager.poll();
      expect(otherSsh()).toEqual([]);
      for (const tab of tabs) {
        expect(entry(tab.id).agentSummary).toBe('earlier summary');
        expect(entry(tab.id).cliState).toBe('busy');
      }
      expect(entry('tab-local').currentProcess).toBe('vim');
    });
  }
});

describe('an unread absent waits for its read (review r3 C2)', () => {
  beforeEach(resetWorld);
  afterEach(() => vi.useRealTimers());

  it('at a 60 s poll interval, a tick 62 s after the proof answered still reads absent: inactive', async () => {
    ssh.scan = () => pane('bash');
    ssh.proof = () => ABSENT;
    const { entry, inactiveNudges, pollAndSettle } = await createManager('idle');
    await pollAndSettle();
    expect(entry().cliState).toBe('idle');
    vi.setSystemTime(T0 + 62_000);
    await pollAndSettle();
    expect(entry().cliState).toBe('inactive');
    expect(inactiveNudges()).toHaveLength(1);
    expect(proofCalls()).toHaveLength(1);
  });
});

describe('a superseded poll writes nothing (review r3 C3)', () => {
  beforeEach(resetWorld);
  afterEach(() => vi.useRealTimers());

  it('a poll held inside a tab, past 10 intervals: the new poll writes, and the old one, released, writes nothing', async () => {
    const NO_SUCH_PID = '2147483646';
    const local: ITab = { id: 'tab-local', name: 'local', order: 0, sessionName: LOCAL_SESSION, panelType: 'terminal' };
    state.tabs = [local];
    ssh.localPanes = paneLine(LOCAL_SESSION, 'vim', NO_SUCH_PID);
    let releasePgrep: () => void = () => {};
    let heldOnce = false;
    ssh.pgrep = () => {
      if (heldOnce) return { code: 1, stderr: '' };
      heldOnce = true;
      return new Promise<TReply>((resolve) => { releasePgrep = () => resolve({ code: 1, stderr: '' }); });
    };
    const { manager, entry } = await createManager('idle');
    const writes = vi.spyOn(manager as unknown as { broadcastUpdate: (...a: unknown[]) => void }, 'broadcastUpdate');
    const stale = manager.poll();
    await vi.waitFor(() => expect(heldOnce).toBe(true));
    expect(entry('tab-local')).toBeUndefined();

    ssh.localPanes = paneLine(LOCAL_SESSION, 'bash', NO_SUCH_PID);
    vi.setSystemTime(T0 + 301_000);
    await manager.poll();
    expect(entry('tab-local').currentProcess).toBe('bash');
    const writesAfterNewPoll = writes.mock.calls.length;
    const snapshot = JSON.stringify(entry('tab-local'));

    releasePgrep();
    await stale;
    expect(entry('tab-local').currentProcess).toBe('bash');
    expect(JSON.stringify(entry('tab-local'))).toBe(snapshot);
    expect(writes.mock.calls.length).toBe(writesAfterNewPoll);
  });
});

describe('one poll at a time, coalesced, never wedged (review r1 F1 d, r2 M2 and L-M)', () => {
  beforeEach(resetWorld);
  afterEach(() => vi.useRealTimers());

  const holdFirstScan = () => {
    const release: { first: (reply: TReply) => void } = { first: () => {} };
    let held = false;
    ssh.scan = (host) => {
      if (host !== HOST) return { stdout: '' };
      if (held) return pane('claude');
      held = true;
      return new Promise<TReply>((resolve) => { release.first = resolve; });
    };
    return release;
  };
  const hostScans = () => scanCalls().filter((c) => c.host === HOST);
  /** A short real wait, for an assertion that something did NOT happen. */
  const quiet = () => new Promise<void>((resolve) => { setImmediate(() => setImmediate(() => resolve())); });

  it('a poll asked for while one runs waits for exactly one follow-up poll', async () => {
    const release = holdFirstScan();
    const { manager } = await createManager('idle');
    const first = manager.poll();
    await vi.waitFor(() => expect(hostScans()).toHaveLength(1));
    const second = manager.poll();
    await quiet();
    expect(hostScans()).toHaveLength(1);
    release.first(pane('claude'));
    await first;
    await second;
    expect(hostScans()).toHaveLength(2);
    await manager.poll();
    expect(hostScans()).toHaveLength(3);
  });

  it('the hook poll trigger and the 7 launch readiness timers during a slow poll: one follow-up serves all 8', async () => {
    const release = holdFirstScan();
    const { manager } = await createManager('idle');
    const first = manager.poll();
    await vi.waitFor(() => expect(hostScans()).toHaveLength(1));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    vi.setSystemTime(T0);
    const hookTrigger = manager.poll();
    (manager as unknown as { markAgentLaunch: (id: string) => void }).markAgentLaunch('tab-r');
    vi.advanceTimersByTime(12_000);
    expect(hostScans()).toHaveLength(1);
    release.first(pane('claude'));
    await first;
    await hookTrigger;
    await quiet();
    expect(hostScans()).toHaveLength(2);
  });

  it('a poll that throws frees the next one', async () => {
    ssh.scan = () => pane('claude');
    const { getWorkspaces } = await import('@/lib/workspace-store');
    const { manager } = await createManager('idle');
    vi.mocked(getWorkspaces).mockRejectedValueOnce(new Error('workspace store unreadable'));
    await expect(manager.poll()).rejects.toThrow('workspace store unreadable');
    await manager.poll();
    expect(hostScans()).toHaveLength(1);
  });

  it('a poll that hangs past 10 intervals is superseded: the next one runs, and the hung one applies nothing when it settles', async () => {
    const release = holdFirstScan();
    const { manager, entry } = await createManager('idle');
    const hung = manager.poll();
    await vi.waitFor(() => expect(hostScans()).toHaveLength(1));
    vi.setSystemTime(T0 + 299_000);
    const queued = manager.poll();
    await quiet();
    expect(hostScans()).toHaveLength(1);
    vi.setSystemTime(T0 + 301_000);
    await manager.poll();
    expect(hostScans()).toHaveLength(2);
    expect(entry().cliState).toBe('idle');
    await queued;
    expect(hostScans()).toHaveLength(3);
    // The hung scan finally answers "no session" (an absence): the superseded poll must not act on it.
    release.first({ stdout: '' });
    await hung;
    expect(entry().cliState).toBe('idle');
  });
});

describe('the orchestrator prompt and nudge for a remote INACTIVE (vel-D61)', () => {
  it('the kickoff tells the orchestrator to prove a remote tab dead before a respawn', async () => {
    const { DEFAULT_KICKOFF_TEMPLATE, resolveKickoffTemplate } = await import('@/lib/orchestration');
    const text = resolveKickoffTemplate(DEFAULT_KICKOFF_TEMPLATE, { workspaceId: 'ws-1', workspaceName: 'w' });
    const line = text.split('\n').find((l) => l.startsWith('- INACTIVE/DEAD:'))!;
    expect(line).toContain('A REMOTE tab');
    expect(line).toContain('purplemux tab status -w ws-1 <tabId>');
    expect(line).toContain('alive false or agentProcess "absent"');
    expect(line).toMatch(/On agentProcess "unknown" or exit 6 \(remote-host-unreachable\), do NOT respawn/);
  });

  it('a local tab\'s inactive nudge is unchanged', async () => {
    const { buildNudgeMessage } = await import('@/lib/orchestration');
    expect(buildNudgeMessage('inactive', 'tab-l', 'l', 'ws-1')).toBe('[orchestrator-watchdog] worker tab-l (l) is INACTIVE (agent process gone). Respawn the tab or mark its task blocked.');
  });
});
