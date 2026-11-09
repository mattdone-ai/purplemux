import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022: every tmux call for a remote tab runs `ssh <host> tmux -L pmux-<origin> …`
// with the arguments a local call would use; no remote pid or path reaches local code.

interface ICall { cmd: string; args: string[]; input?: string }

const calls = vi.hoisted(() => ({ list: [] as ICall[] }));
const replies = vi.hoisted(() => ({
  fn: (_cmd: string, _args: string[]): { stdout?: string; stderr?: string; code?: number } => ({ stdout: '' }),
}));
const hostOf = vi.hoisted(() => ({ map: new Map<string, string>() }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  type TCallback = (err: Error | null, stdout: string, stderr: string) => void;
  const execFile = (cmd: string, args: string[], _opts: unknown, cb: TCallback) => {
    const call: ICall = { cmd, args };
    calls.list.push(call);
    const reply = replies.fn(cmd, args);
    queueMicrotask(() => {
      if (reply.code !== undefined) {
        cb(Object.assign(new Error('failed'), { code: reply.code, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' }), reply.stdout ?? '', reply.stderr ?? '');
      } else {
        cb(null, reply.stdout ?? '', reply.stderr ?? '');
      }
    });
    return { stdin: { on: () => {}, end: (input: string) => { call.input = input; } } };
  };
  // tmux.ts promisifies execFile for its local calls; the real one resolves { stdout, stderr }.
  Object.assign(execFile, {
    [promisify.custom]: (cmd: string, args: string[], opts: unknown) => new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
    }),
  });
  return { ...actual, default: { ...actual, execFile }, execFile };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, hostname: () => 'MdServer1' }, hostname: () => 'MdServer1' };
});
vi.mock('@/lib/session-host', () => ({
  sessionHostOf: async (name: string) => hostOf.map.get(name) ?? null,
  knownRemoteHosts: () => [...new Set(hostOf.map.values())],
  remoteHostsInUse: async () => [...new Set(hostOf.map.values())],
  registerSessionHost: (name: string, host: string | null) => { if (host) hostOf.map.set(name, host); },
  forgetSessionHost: (name: string) => { hostOf.map.delete(name); },
}));
const fleet = vi.hoisted(() => ({ hosts: null as string | null, callback: 'http://mdserver1:8022' }));
vi.mock('@/lib/fleet-config-store', () => ({
  readFleetConfig: async () => ({ values: {}, versions: {}, history: [] }),
  valueOf: (_state: unknown, key: string) => {
    if (key === 'remote.hosts') return fleet.hosts === null ? null : { value: fleet.hosts };
    if (key === 'remote.callback-url') return { value: fleet.callback };
    if (key === 'remote.callback-allow-hosts') return { value: 'mdserver1' };
    return null;
  },
}));
const workspaceDirs = vi.hoisted(() => ({ map: new Map<string, string[]>() }));
vi.mock('@/lib/workspace-home', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-home')>()),
  workspaceDirectories: async (wsId: string) => workspaceDirs.map.get(wsId) ?? [],
}));
const logs = vi.hoisted(() => ({ warn: [] as string[] }));
vi.mock('@/lib/logger', () => {
  const logger = {
    trace: () => {}, debug: () => {}, info: () => {}, error: () => {}, fatal: () => {},
    warn: (...args: unknown[]) => { logs.warn.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); },
    child: () => logger,
  };
  return { createLogger: () => logger };
});
const audit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));

const scanBackoff = () => (globalThis as unknown as { __ptRemoteScanBackoff?: Map<string, number> }).__ptRemoteScanBackoff;

const REMOTE = 'pt-ws-r-pane-p-tab-remote1';
const LOCAL = 'pt-ws-l-pane-p-tab-local1';

/** The remote command string of an ssh call: the last argument, after `--` and the host. */
const remoteCommand = (call: ICall): string => {
  const dash = call.args.indexOf('--');
  expect(call.args[dash + 1]).toBe('ai-server');
  return call.args[dash + 2];
};

describe('tmux calls for a remote tab go over ssh (ADR-0022)', () => {
  beforeEach(() => {
    calls.list = [];
    hostOf.map = new Map([[REMOTE, 'ai-server']]);
    replies.fn = () => ({ stdout: '' });
    audit.mockClear();
    fleet.hosts = 'ai-server';
    workspaceDirs.map = new Map();
    scanBackoff()?.clear();
  });

  it('session presence: tmux\'s own "no such session" is absent; ssh failing or timing out is unknown, never absent', async () => {
    const { sessionPresence, hasSessionOrUnreachable } = await import('@/lib/tmux');
    replies.fn = () => ({ stdout: '' });
    expect(await sessionPresence(REMOTE)).toBe('present');
    for (const stderr of [`can't find session: ${REMOTE}`, 'no server running on /tmp/tmux-1000/pmux-mdserver1', 'error connecting to /tmp/tmux-1000/pmux-mdserver1 (No such file or directory)']) {
      replies.fn = () => ({ code: 1, stderr });
      expect(await sessionPresence(REMOTE)).toBe('absent');
    }
    replies.fn = () => ({ code: 255, stderr: 'ssh: connect to host ai-server port 22: No route to host' });
    expect(await sessionPresence(REMOTE)).toBe('unknown');
    await expect(hasSessionOrUnreachable(REMOTE)).rejects.toMatchObject({ name: 'RemoteHostError', host: 'ai-server' });
    expect(remoteCommand(calls.list[0])).toBe(`'tmux' '-L' 'pmux-mdserver1' 'has-session' '-t' '=${REMOTE}'`);
  });

  it('a multi-tab close asks every remote host first; one that does not answer refuses, an unregistered one is skipped', async () => {
    const { assertRemoteHostsAnswer } = await import('@/lib/tmux');
    await assertRemoteHostsAnswer([LOCAL, REMOTE]);
    expect(calls.list.map(remoteCommand)).toEqual(['true']);
    replies.fn = () => ({ code: 255, stderr: 'Connection timed out' });
    await expect(assertRemoteHostsAnswer([REMOTE])).rejects.toThrow(/did not answer over ssh .*nothing was closed/);
    fleet.hosts = 'gpu2';
    calls.list = [];
    await assertRemoteHostsAnswer([REMOTE]);
    expect(calls.list).toEqual([]);
  });

  it('pane scans skip a host for 30 s after it fails, and ask no host that owns no tab (review r1 nit 2)', async () => {
    const { getAllPanesInfo } = await import('@/lib/tmux');
    replies.fn = (cmd) => (cmd === 'tmux' ? { stdout: '' } : { code: 255, stderr: 'timed out' });
    await getAllPanesInfo();
    await getAllPanesInfo();
    expect(calls.list.filter((c) => c.cmd === 'ssh')).toHaveLength(1);
    hostOf.map = new Map();
    calls.list = [];
    scanBackoff()?.clear();
    await getAllPanesInfo();
    expect(calls.list.filter((c) => c.cmd === 'ssh')).toEqual([]);
  });

  it('observes a remote provider process with the host, pane and process identity; ssh failing is unknown', async () => {
    const { observeRemoteProviderProcess } = await import('@/lib/tmux');
    replies.fn = () => ({ stdout: 'present\t%3\t4100\t4242\t98765\n' });
    expect(await observeRemoteProviderProcess(REMOTE, 'claude')).toEqual({ state: 'present', identity: `remote:ai-server:${REMOTE}:%3:4100:4242:98765:claude` });
    expect(remoteCommand(calls.list[0])).toBe(`'sh' '-s' '--' 'pmux-mdserver1' '${REMOTE}' 'claude'`);
    expect(calls.list[0].input).toContain('/task/*/children');
    replies.fn = () => ({ stdout: 'absent\tsession gone\n' });
    expect(await observeRemoteProviderProcess(REMOTE, 'claude')).toEqual({ state: 'absent', reason: 'session gone' });
    replies.fn = () => ({ code: 255, stderr: 'Connection timed out' });
    expect((await observeRemoteProviderProcess(REMOTE, 'claude')).state).toBe('unknown');
  });

  it('each scan carries the hosts it read: two concurrent scans, one failing, never read each other\'s answer (review r4)', async () => {
    let n = 0;
    replies.fn = (cmd) => {
      if (cmd === 'tmux') return { stdout: '' };
      n += 1;
      return n === 1 ? { code: 255, stderr: 'ssh: connect to host ai-server port 22: Connection timed out' } : { stdout: `${REMOTE}\tclaude\t/home/r\t999\t7\n` };
    };
    const { getAllPanesInfo } = await import('@/lib/tmux');
    const [failed, answered] = await Promise.all([getAllPanesInfo(), getAllPanesInfo()]);
    expect([...(failed.answeredRemoteHosts ?? [])]).toEqual([]);
    expect(failed.has(REMOTE)).toBe(false);
    expect([...(answered.answeredRemoteHosts ?? [])]).toEqual(['ai-server']);
    expect(answered.get(REMOTE)?.host).toBe('ai-server');
    replies.fn = () => ({ code: 1, stderr: 'no server running on /tmp/tmux-1000/pmux-mdserver1' });
    scanBackoff()?.clear();
    const empty = await getAllPanesInfo();
    expect([...(empty.answeredRemoteHosts ?? [])]).toEqual(['ai-server']);
  });

  it('a local session keeps the exact local argv', async () => {
    const { capturePaneContentAnsi } = await import('@/lib/tmux');
    await capturePaneContentAnsi(LOCAL);
    expect(calls.list).toEqual([{ cmd: 'tmux', args: ['-L', 'purple', 'capture-pane', '-p', '-e', '-J', '-t', LOCAL] }]);
  });

  it('a remote capture runs the same tmux arguments on the remote socket, BatchMode, never an option as host', async () => {
    replies.fn = () => ({ stdout: 'remote pane' });
    const { capturePaneContentAnsi } = await import('@/lib/tmux');
    expect(await capturePaneContentAnsi(REMOTE)).toBe('remote pane');
    expect(calls.list).toHaveLength(1);
    const [call] = calls.list;
    expect(call.cmd).toBe('ssh');
    expect(call.args).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes']));
    expect(remoteCommand(call)).toBe(`'tmux' '-L' 'pmux-mdserver1' 'capture-pane' '-p' '-e' '-J' '-t' '${REMOTE}'`);
  });

  it('send-keys text is shell-quoted for the remote shell', async () => {
    const { sendBracketedPasteText, sendKeys } = await import('@/lib/tmux');
    await sendKeys(REMOTE, "echo 'it''s' $HOME; rm -rf /");
    await sendBracketedPasteText(REMOTE, 'a\nb');
    const commands = calls.list.map(remoteCommand);
    expect(commands).toContain(`'tmux' '-L' 'pmux-mdserver1' 'send-keys' '-t' '${REMOTE}' 'echo '\\''it'\\'''\\''s'\\'' $HOME; rm -rf /' 'Enter'`);
    expect(commands.at(-1)).toBe(`'tmux' '-L' 'pmux-mdserver1' 'send-keys' '-t' '${REMOTE}' '-l' '--' '\x1b[200~a\nb\x1b[201~'`);
  });

  it('never hands a remote pane pid or a remote path to local code', async () => {
    const { getSessionPanePid, getSessionCwd, getLastCommand } = await import('@/lib/tmux');
    expect(await getSessionPanePid(REMOTE)).toBeNull();
    expect(await getSessionCwd(REMOTE)).toBeNull();
    expect(await getLastCommand(REMOTE)).toBeNull();
    expect(calls.list).toEqual([]);
  });

  it('pane detail keeps the remote cwd and command but drops the pid', async () => {
    replies.fn = () => ({ stdout: '/home/mdone/code\tbash\t4242\t80\t24\t1700000000\n' });
    const { getPaneDetailInfo } = await import('@/lib/tmux');
    expect(await getPaneDetailInfo(REMOTE)).toEqual({ cwd: '/home/mdone/code', command: 'bash', pid: null, width: 80, height: 24, sessionCreated: 1700000000 });
  });

  it('merges the remote panes into the pane map with pid 0 and the host', async () => {
    replies.fn = (cmd) => cmd === 'tmux'
      ? { stdout: `${LOCAL}\tbash\t/home/l\t111\t5\n` }
      : { stdout: `${REMOTE}\tclaude\t/home/r\t999\t7\nnot-ours\tbash\t/\t1\t1\n` };
    const { getAllPanesInfo } = await import('@/lib/tmux');
    const panes = await getAllPanesInfo();
    expect(panes.get(LOCAL)).toEqual({ command: 'bash', path: '/home/l', pid: 111, windowActivity: 5 });
    // paneRef is the remote pane pid as text, an opaque proof-cache identity (vel-D61), never a local pid.
    expect(panes.get(REMOTE)).toEqual({ command: 'claude', path: '/home/r', pid: 0, windowActivity: 7, host: hostOf.map.get(REMOTE), paneRef: '999' });
    expect(panes.has('not-ours')).toBe(false);
  });

  it('an unreachable host leaves only the local panes', async () => {
    replies.fn = (cmd) => cmd === 'tmux' ? { stdout: `${LOCAL}\tbash\t/home/l\t111\t5\n` } : { code: 255, stderr: 'ssh: connect to host ai-server port 22: No route to host' };
    const { getAllPanesInfo } = await import('@/lib/tmux');
    expect([...(await getAllPanesInfo()).keys()]).toEqual([LOCAL]);
  });

  it('hasSession answers false when ssh fails, true when the remote tmux has it', async () => {
    const { hasSession } = await import('@/lib/tmux');
    expect(await hasSession(REMOTE)).toBe(true);
    replies.fn = () => ({ code: 255 });
    expect(await hasSession(REMOTE)).toBe(false);
  });

  it('strict observation: a present remote session is unknown (no local identity), tmux-proven absence is absent, ssh failure is unknown', async () => {
    const { observeSessionStrict } = await import('@/lib/tmux');
    replies.fn = () => ({ stdout: `${REMOTE}\t%1\t4242\n` });
    expect((await observeSessionStrict(REMOTE)).state).toBe('unknown');
    replies.fn = () => ({ code: 1, stderr: `can't find session: ${REMOTE}\n` });
    expect((await observeSessionStrict(REMOTE)).state).toBe('absent');
    replies.fn = () => ({ code: 1, stderr: 'no server running on /tmp/tmux-1000/pmux-mdserver1\n' });
    expect((await observeSessionStrict(REMOTE)).state).toBe('absent');
    replies.fn = () => ({ code: 1, stderr: 'error connecting to /tmp/tmux-1000/pmux-mdserver1 (No such file or directory)\n' });
    expect((await observeSessionStrict(REMOTE)).state).toBe('absent');
    replies.fn = () => ({ code: 255, stderr: 'Connection closed' });
    expect((await observeSessionStrict(REMOTE)).state).toBe('unknown');
  });

  it('closes a remote tab with one reap script run on the remote host and never signals a local pid', async () => {
    const kill = vi.spyOn(process, 'kill');
    replies.fn = () => ({ stdout: 'marker\tpresent\nkilled\t500\tsleep\tsleep 300\nsurvivor\t501\tstubborn\tstubborn --x\nsession\tgone\n' });
    const { killSession } = await import('@/lib/tmux');
    const reap = await killSession(REMOTE, { tabId: 'tab-remote1' });
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
    expect(calls.list).toHaveLength(1);
    const command = remoteCommand(calls.list[0]);
    expect(command).toBe(`'sh' '-s' '--' 'pmux-mdserver1' '${REMOTE}' 'tab-remote1' '0' 'mdserver1'`);
    expect(calls.list[0].input).toContain('PMUX_TAB_ID=$tab');
    expect(reap).toEqual({
      reaper: 'remote', envMarker: 'present', sessionGone: true,
      killed: [{ pid: 500, comm: 'sleep', args: 'sleep 300' }],
      survivors: [{ pid: 501, comm: 'stubborn', args: 'stubborn --x' }],
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'tab-reap', tabId: 'tab-remote1', host: 'ai-server' }));
  });

  it('keep-processes asks the script for the pane group only', async () => {
    replies.fn = () => ({ stdout: 'marker\tunknown\nsession\tgone\n' });
    const { killSession } = await import('@/lib/tmux');
    await killSession(REMOTE, { tabId: 'tab-remote1', keepProcesses: true });
    expect(remoteCommand(calls.list[0])).toBe(`'sh' '-s' '--' 'pmux-mdserver1' '${REMOTE}' 'tab-remote1' '1' 'mdserver1'`);
  });

  it('a close that cannot reach the host throws, so the tab is not dropped with its session still running', async () => {
    replies.fn = () => ({ code: 255, stderr: 'ssh: connect to host ai-server port 22: Connection timed out' });
    const { killSession } = await import('@/lib/tmux');
    const closing = killSession(REMOTE, { tabId: 'tab-remote1' });
    await expect(closing).rejects.toMatchObject({ name: 'RemoteHostError', host: 'ai-server' });
    await expect(closing).rejects.toThrow('(exit 255: ssh: connect to host ai-server port 22: Connection timed out)');
  });

  it('a host taken out of remote.hosts that does not answer: the close goes ahead without a reap, audited', async () => {
    fleet.hosts = 'gpu2';
    replies.fn = () => ({ code: 255, stderr: 'ssh: Could not resolve hostname ai-server' });
    const { killSession } = await import('@/lib/tmux');
    expect(await killSession(REMOTE, { tabId: 'tab-remote1' })).toEqual({ reaper: 'remote-skipped', envMarker: 'unknown', killed: [], survivors: [] });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ event: 'tab-reap-skipped', host: 'ai-server' }));
  });

  it('a create that fails after reaching the host kills only the session carrying its nonce, removes its env file, and names the failure, not the script', async () => {
    replies.fn = (_cmd, args) => (args.at(-1) === 'sh -s' ? { code: 1, stderr: 'source-file: bad line' } : { stdout: '' });
    const { createSession } = await import('@/lib/tmux');
    const creating = createSession(REMOTE, 80, 24, undefined, { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    await expect(creating).rejects.toThrow(`remote session ${REMOTE} on ai-server was not created (exit 1: source-file: bad line)`);
    await expect(creating).rejects.not.toThrow(/new-session/);
    const nonce = calls.list[0].input?.match(/'@pmux-create' '([A-Za-z0-9_-]{16})'/)?.[1];
    expect(nonce).toBeDefined();
    expect(remoteCommand(calls.list[1])).toBe(`[ "$('tmux' '-L' 'pmux-mdserver1' 'show-options' '-qv' '-t' '=${REMOTE}:' '@pmux-create' 2>/dev/null)" = '${nonce}' ] && 'tmux' '-L' 'pmux-mdserver1' 'kill-session' '-t' '=${REMOTE}'; true; rm -f "$HOME/.purplemux-remote/mdserver1/tabs/tab-remote1.env"`);
  });

  // Story 12: the kit's CLI runs once on the host before any session starts; a CLI that does not run refuses the create.
  it('a kit whose CLI does not run on the host refuses the create with remote-kit-broken, naming the module and the host, and removes the env file', async () => {
    const stderr = "pmux-kit-probe: node:internal/modules/cjs/loader:1228\npmux-kit-probe:   throw err;\npmux-kit-probe: Error: Cannot find module './curator-spot-check-event.js'\npmux-kit-probe: Require stack:\n";
    replies.fn = (_cmd, args) => (args.at(-1) === 'sh -s' ? { code: 18, stderr } : { stdout: '' });
    const { createSession } = await import('@/lib/tmux');
    const creating = createSession(REMOTE, 80, 24, undefined, { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    await expect(creating).rejects.toMatchObject({ name: 'RemoteKitBrokenError', host: 'ai-server', line: "Error: Cannot find module './curator-spot-check-event.js'" });
    await expect(creating).rejects.toThrow("the CLI kit does not run on ai-server (Error: Cannot find module './curator-spot-check-event.js'); no agent started");
    expect(calls.list).toHaveLength(2);
    expect(remoteCommand(calls.list[1])).toContain('rm -f "$HOME/.purplemux-remote/mdserver1/tabs/tab-remote1.env"');
  });

  // Review r1 finding 1: the probe's own budget on the host gives a kit verdict, never 503 remote-host-unreachable.
  it('a probe that ran past its budget on the host is remote-kit-broken "timed out", never remote-host-unreachable', async () => {
    replies.fn = (_cmd, args) => (args.at(-1) === 'sh -s' ? { code: 18, stderr: 'pmux-kit-probe: kit probe timed out after 4 s\n' } : { stdout: '' });
    const { createSession } = await import('@/lib/tmux');
    const creating = createSession(REMOTE, 80, 24, undefined, { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    await expect(creating).rejects.toMatchObject({ name: 'RemoteKitBrokenError', host: 'ai-server', line: 'kit probe timed out after 4 s' });
    await expect(creating).rejects.not.toMatchObject({ name: 'RemoteHostError' });
  });

  // Review r1 finding 3: a restart probes the kit before it kills the old session.
  it('probeRemoteKit ships only the CLI and probes it in one sh -s run, and starts no session', async () => {
    const { probeRemoteKit } = await import('@/lib/tmux');
    await probeRemoteKit(REMOTE);
    expect(calls.list).toHaveLength(1);
    expect(remoteCommand(calls.list[0])).toBe('sh -s');
    const script = calls.list[0].input ?? '';
    expect([...script.matchAll(/^put '([^']+)'/gm)].map((m) => m[1])).toEqual(['bin/cli.js', 'bin/curator-spot-check-event.js', 'bin/purplemux']);
    expect(script).toContain('d="$HOME/.purplemux-remote/mdserver1"');
    expect(script).toContain('timeout -k 1 4 sh -c ');
    expect(script).not.toMatch(/new-session|kill-session|tabs\//);
  });

  it('probeRemoteKit: exit 18 is remote-kit-broken, an ssh failure is remote-host-unreachable that killed nothing, a local tab is never asked', async () => {
    const { probeRemoteKit } = await import('@/lib/tmux');
    replies.fn = () => ({ code: 18, stderr: "pmux-kit-probe: Error: Cannot find module './x.js'\n" });
    await expect(probeRemoteKit(REMOTE)).rejects.toMatchObject({ name: 'RemoteKitBrokenError', host: 'ai-server', line: "Error: Cannot find module './x.js'" });
    replies.fn = () => ({ code: 255, stderr: 'ssh: connect to host ai-server port 22: Connection timed out' });
    await expect(probeRemoteKit(REMOTE)).rejects.toMatchObject({ name: 'RemoteHostError', host: 'ai-server' });
    await expect(probeRemoteKit(REMOTE)).rejects.toThrow('nothing was killed');
    replies.fn = () => ({ code: 2, stderr: 'sh: 3: base64: not found' });
    await expect(probeRemoteKit(REMOTE)).rejects.toThrow(`the kit probe for ${REMOTE} on ai-server failed (exit 2: sh: 3: base64: not found); nothing was killed`);
    calls.list = [];
    await probeRemoteKit(LOCAL);
    expect(calls.list).toEqual([]);
  });

  it('a CLI this server cannot read refuses the create before anything reaches the host, naming the module', async () => {
    const fsModule = (await import('fs/promises')).default;
    const realRead = fsModule.readFile.bind(fsModule);
    const read = vi.spyOn(fsModule, 'readFile').mockImplementation(((file: Parameters<typeof realRead>[0], ...rest: unknown[]) => (
      String(file).endsWith('/bin/curator-spot-check-event.js')
        ? Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
        : (realRead as (...a: unknown[]) => Promise<unknown>)(file, ...rest)
    )) as typeof fsModule.readFile);
    try {
      const { createSession } = await import('@/lib/tmux');
      const creating = createSession(REMOTE, 80, 24, undefined, { workspaceId: 'ws-r', tabId: 'tab-remote1' });
      await expect(creating).rejects.toMatchObject({ name: 'RemoteKitBrokenError', host: 'ai-server', line: 'this server could not read its CLI to ship it: bin/curator-spot-check-event.js: ENOENT' });
      expect(calls.list.filter((c) => c.cmd === 'ssh')).toEqual([]);
    } finally {
      read.mockRestore();
    }
  });

  it('a name that already exists on the host is refused before any file is written, and that session is never touched (review r1 B2)', async () => {
    replies.fn = (_cmd, args) => (args.at(-1) === 'sh -s' ? { code: 17, stderr: `pmux: session ${REMOTE} already exists` } : { stdout: '' });
    const { createSession } = await import('@/lib/tmux');
    await expect(createSession(REMOTE, 80, 24)).rejects.toThrow(`remote session ${REMOTE} already exists on ai-server; it was left as it is`);
    expect(calls.list).toHaveLength(1);
    const lines = (calls.list[0].input ?? '').split('\n');
    expect(lines[1]).toBe(`if 'tmux' '-L' 'pmux-mdserver1' 'has-session' '-t' '=${REMOTE}' 2>/dev/null; then echo 'pmux: session ${REMOTE} already exists' >&2; exit 17; fi`);
    expect(lines.findIndex((l) => l.startsWith('put '))).toBeGreaterThan(1);
  });

  it('creates the remote session in one sh -s run: the kit on stdin, the token only in a one-shot env file, guard first, nonce tag after', async () => {
    const { createSession } = await import('@/lib/tmux');
    await createSession(REMOTE, 120, 40, '/home/mdone/code/nomupay', { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    expect(calls.list).toHaveLength(1);
    expect(remoteCommand(calls.list[0])).toBe('sh -s');
    const script = calls.list[0].input ?? '';
    const lines = script.trim().split('\n');
    const order = ['has-session', 'put ', 'if ! pmux_probe=$(', 'new-session', '@pmux-create', 'source-file'].map((word) => lines.findIndex((l) => l.includes(word)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The cwd is resolved on the host once, and tmux starts the pane in that same path (vel-PMX-FU).
    const { remoteSocketName: socketName } = await import('@/lib/remote-host');
    expect(script).toContain(`'tmux' '-u' '-L' '${socketName()}' '-f' "$d/tmux.conf" 'new-session' '-d' '-s' '${REMOTE}' '-x' '120' '-y' '40' '-c' "$pmux_cwd"`);
    expect(lines.findIndex((l) => l.startsWith('pmux_cwd=$(cd -P -- '))).toBeLessThan(lines.findIndex((l) => l.startsWith('put ')));
    expect(script).toContain('PMUX_TAB_ID=');
    expect(script).toContain('http://mdserver1:8022');
    expect(script).not.toMatch(/PMUX_TOKEN|CLAUDE_CONFIG_DIR|GROK_HOME|\/\.purplemux\/workspaces/);
    const put = (file: string) => {
      const m = script.match(new RegExp(`^put '${file.replace(/[./]/g, '\\$&')}' '([A-Za-z0-9+/=]*)' (\\d+)$`, 'm'));
      return m ? { content: Buffer.from(m[1], 'base64').toString('utf-8'), mode: m[2] } : null;
    };
    expect(put('tmux.conf')?.content).toContain('set -g status off');
    expect(put('status-hook.sh')?.mode).toBe('700');
    expect(put('hooks.json')?.content).toContain('$HOME/.purplemux-remote/mdserver1/status-hook.sh');
    const tabEnv = put('tabs/tab-remote1.env');
    expect(tabEnv?.mode).toBe('600');
    const { getTabTokenRecord } = await import('@/lib/tab-token');
    const token = getTabTokenRecord('tab-remote1')?.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tabEnv?.content).toBe(`PMUX_TAB_TOKEN='${token}'\n`);
    // The token appears in the stdin script only inside the base64 env file.
    expect(script.includes(token!)).toBe(false);
  });

  it('ships the prompt with the standing orders active at each create: an order added between two creates is in the second only (ADR-0041)', async () => {
    const { createSession } = await import('@/lib/tmux');
    const { addOrder } = await import('@/lib/standing-orders-store');
    const shippedPrompt = (script: string) => {
      const m = script.match(/^put 'workspaces\/ws-r\/claude-prompt\.md' '([A-Za-z0-9+/=]*)' \d+$/m);
      return m ? Buffer.from(m[1], 'base64').toString('utf-8') : null;
    };
    await createSession(REMOTE, 120, 40, '/srv/r', { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    const first = shippedPrompt(calls.list[0].input ?? '');
    expect(first).toContain('## Standing orders');
    expect(first).not.toContain('Ship the remote prompt with every create.');
    const { order } = await addOrder('ws-r', { text: 'Ship the remote prompt with every create.', source: 's' }, [], Date.now());
    calls.list = [];
    hostOf.map = new Map([[REMOTE, 'ai-server']]);
    await createSession(REMOTE, 120, 40, '/srv/r', { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    expect(shippedPrompt(calls.list[0].input ?? '')).toContain(`- **${order.id}** (ws-r; check: prose) Ship the remote prompt with every create.`);
  });

  it('D32: rewrites only the kit prompt copy on the host, over stdin, and starts or touches no session', async () => {
    const { pushRemotePrompt } = await import('@/lib/tmux');
    const prompt = '## Standing orders\n\nRendered 2026-11-09T02:00:00Z. `purplemux so list` is the authority.\n';
    await pushRemotePrompt('ai-server', 'ws-r', prompt);
    expect(calls.list).toHaveLength(1);
    expect(remoteCommand(calls.list[0])).toBe('sh -s');
    const script = calls.list[0].input ?? '';
    const puts = script.split('\n').filter((line) => line.startsWith('put '));
    expect(puts).toHaveLength(1);
    const m = puts[0].match(/^put 'workspaces\/ws-r\/claude-prompt\.md' '([A-Za-z0-9+/=]*)' 600$/);
    expect(m && Buffer.from(m[1], 'base64').toString('utf-8')).toBe(prompt);
    expect(script).toMatch(/^set -e\nd="\$HOME\/\.purplemux-remote\/[^"]+"\n/);
    expect(script).not.toMatch(/new-session|kill-session|send-keys|source-file/);
  });

  it('D32: a host that does not answer is named in the refusal', async () => {
    const { pushRemotePrompt } = await import('@/lib/tmux');
    replies.fn = () => ({ code: 255, stderr: 'ssh: connect to host ai-server port 22: Connection timed out' });
    await expect(pushRemotePrompt('ai-server', 'ws-r', 'x')).rejects.toThrow(/^the prompt copy of ws-r on ai-server was not written \(/);
  });

  // D14 (story 05 AC 2): the kit pre-trusts the cwd before the session starts, only inside a workspace directory.
  it('pre-trusts a cwd under a workspace directory: the seed script ships, and runs after the kit lands and before the session starts', async () => {
    workspaceDirs.map.set('ws-r', ['/home/mdone/code/nomupay', '/home/mdone/code/purplemux']);
    const { createSession } = await import('@/lib/tmux');
    const { REMOTE_TRUST_SEED_SCRIPT } = await import('@/lib/remote-kit');
    await createSession(REMOTE, 120, 40, '/home/mdone/code/purplemux/.worktrees/hfl2-05', { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    const script = calls.list[0].input ?? '';
    const lines = script.trim().split('\n');
    const seedLine = lines.findIndex((l) => l.includes('trust-seed.py') && l.includes('if command -v python3'));
    expect(lines[seedLine]).toBe(`if [ -z "$pmux_cwd_fallback" ]; then if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" "$pmux_cwd" '${workspaceDirs.map.get('ws-r')![1]}' >/dev/null 2>&1 || :; fi; fi`);
    const lastPut = lines.map((l, i) => (l.startsWith('put ') ? i : -1)).filter((i) => i >= 0).at(-1)!;
    const newSession = lines.findIndex((l) => l.includes('new-session'));
    expect(seedLine).toBeGreaterThan(lastPut);
    expect(seedLine).toBeLessThan(newSession);
    const shipped = script.match(/^put 'trust-seed\.py' '([A-Za-z0-9+/=]*)' 600$/m);
    expect(shipped && Buffer.from(shipped[1], 'base64').toString('utf-8')).toBe(REMOTE_TRUST_SEED_SCRIPT);
  });

  // vel-PMX-FU: the cwd the creator named is pre-trusted by name, outside every workspace directory.
  it('a named cwd outside every workspace directory: the seed runs with --named and every workspace directory', async () => {
    workspaceDirs.map.set('ws-r', ['/srv/ws-one', '/srv/ws-two']);
    const { createSession } = await import('@/lib/tmux');
    await createSession(REMOTE, 120, 40, '/srv/elsewhere/repo', { workspaceId: 'ws-r', tabId: 'tab-remote1' }, { trustCwd: '/srv/elsewhere/repo' });
    await createSession(REMOTE, 120, 40, '/srv/ws-one/sub', { workspaceId: 'ws-r', tabId: 'tab-remote1' }, { trustCwd: '/srv/ws-one/sub/' });
    const seedLines = calls.list.map((call) => (call.input ?? '').split('\n').find((l) => l.includes('"$d/trust-seed.py"')));
    expect(seedLines).toEqual([
      `if [ -z "$pmux_cwd_fallback" ]; then if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" '--named' "$pmux_cwd" '/srv/ws-one' '/srv/ws-two' >/dev/null 2>&1 || :; fi; fi`,
      `if [ -z "$pmux_cwd_fallback" ]; then if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" '--named' "$pmux_cwd" '/srv/ws-one' >/dev/null 2>&1 || :; fi; fi`,
    ]);
  });

  it('the cwd is resolved once on the host and the seed and tmux both get that result: "<link>/.." is never resolved here (CI on PR #59)', async () => {
    workspaceDirs.map.set('ws-r', ['/srv/ws-one']);
    const { createSession } = await import('@/lib/tmux');
    const cwd = '/srv/data/a/link/..';
    await createSession(REMOTE, 120, 40, cwd, { workspaceId: 'ws-r', tabId: 'tab-remote1' }, { trustCwd: cwd });
    const script = calls.list[0].input ?? '';
    const lines = script.split('\n');
    expect(lines).toContain(`pmux_cwd=$(cd -P -- '/srv/data/a/link/..' 2>/dev/null && pwd -P) || pmux_cwd=''`);
    expect(lines.find((l) => l.startsWith('if [ -z "$pmux_cwd" ]'))).toContain('exit 19');
    expect(lines.find((l) => l.includes('"$d/trust-seed.py"'))).toBe(
      `if [ -z "$pmux_cwd_fallback" ]; then if command -v python3 >/dev/null 2>&1; then python3 "$d/trust-seed.py" '--named' "$pmux_cwd" '/srv/ws-one' >/dev/null 2>&1 || :; fi; fi`);
    expect(lines.find((l) => l.includes('new-session'))).toContain(`'-c' "$pmux_cwd"`);
    expect(script).not.toContain("'/srv/data/a'");
  });

  it('a workspace-default cwd the host lacks starts in its HOME; a named one that does not resolve refuses by name', async () => {
    workspaceDirs.map.set('ws-r', ['/srv/ws-one']);
    const { createSession } = await import('@/lib/tmux');
    await createSession(REMOTE, 120, 40, '/srv/ws-one', { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    expect((calls.list[0].input ?? '').split('\n').find((l) => l.startsWith('if [ -z "$pmux_cwd" ]'))).toContain('pmux_cwd="$HOME"; pmux_cwd_fallback=1');
    replies.fn = (cmd) => (cmd === 'ssh' ? { code: 19, stderr: 'pmux: cwd /srv/gone is not a directory on this host' } : { stdout: '' });
    const { RemoteCwdMissingError } = await import('@/lib/remote-kit');
    const refused = await createSession(REMOTE, 120, 40, '/srv/gone', { workspaceId: 'ws-r', tabId: 'tab-remote1' }, { trustCwd: '/srv/gone' }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(RemoteCwdMissingError);
    expect((refused as Error).message).toMatch(/^\/srv\/gone is not a directory on /);
  });

  it('a fresh create of a named cwd refuses a missing one; a revival of the same tab starts in HOME (review r4)', async () => {
    workspaceDirs.map.set('ws-r', ['/srv/ws-one']);
    const { createSession } = await import('@/lib/tmux');
    await createSession(REMOTE, 120, 40, '/srv/elsewhere/repo', { workspaceId: 'ws-r', tabId: 'tab-remote1' }, { trustCwd: '/srv/elsewhere/repo' });
    await createSession(REMOTE, 120, 40, '/srv/elsewhere/repo', { workspaceId: 'ws-r', tabId: 'tab-remote1' }, { trustCwd: '/srv/elsewhere/repo', revival: true });
    const missing = calls.list.map((call) => (call.input ?? '').split('\n').find((l) => l.startsWith('if [ -z "$pmux_cwd" ]')) ?? '');
    expect(missing[0]).toContain('exit 19');
    expect(missing[1]).not.toContain('exit 19');
    expect(missing[1]).toContain('the pane starts in HOME');

    // The host printed the fallback note: the server logs it, naming the revival and the cwd.
    logs.warn = [];
    replies.fn = (cmd) => (cmd === 'ssh' ? { stdout: '', stderr: 'pmux: cwd /srv/elsewhere/repo is not a directory on this host; the pane starts in HOME\n' } : { stdout: '' });
    await createSession(REMOTE, 120, 40, '/srv/elsewhere/repo', { workspaceId: 'ws-r', tabId: 'tab-remote1' }, { trustCwd: '/srv/elsewhere/repo', revival: true });
    expect(logs.warn).toEqual([expect.stringMatching(/^remote revival of pt-\S+ on \S+: cwd \/srv\/elsewhere\/repo is not a directory on this host; the pane starts in HOME$/)]);
  });

  it('a cwd that is not the named one (the pane moved, or none was named) is not named', async () => {
    workspaceDirs.map.set('ws-r', ['/srv/ws-one']);
    const { createSession, remoteTrustTarget } = await import('@/lib/tmux');
    await createSession(REMOTE, 120, 40, '/srv/elsewhere/moved', { workspaceId: 'ws-r', tabId: 'tab-remote1' }, { trustCwd: '/srv/elsewhere/repo' });
    expect((calls.list[0].input ?? '').split('\n').filter((line) => line.includes('python3'))).toEqual([]);
    expect(await remoteTrustTarget(REMOTE, { workspaceId: 'ws-r', tabId: 'tab-remote1' }, '/srv/elsewhere/repo')).toBeNull();
    expect(await remoteTrustTarget(REMOTE, { workspaceId: 'ws-r', tabId: 'tab-remote1' }, '/srv/elsewhere/repo', 'relative/repo')).toBeNull();
  });

  // The kit always ships the script (the Claude launch line runs it); the create runs no seed line here.
  it('pre-trusts nothing for a cwd outside every workspace directory, or with no cwd', async () => {
    workspaceDirs.map.set('ws-r', ['/home/mdone/code/nomupay']);
    const { createSession } = await import('@/lib/tmux');
    await createSession(REMOTE, 120, 40, '/home/mdone/portfolio', { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    await createSession(REMOTE, 120, 40, undefined, { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    await createSession(REMOTE, 120, 40, '/home/mdone/code/nomupay-other', { workspaceId: 'ws-r', tabId: 'tab-remote1' });
    for (const call of calls.list) {
      expect(call.input ?? '').toMatch(/^put 'trust-seed\.py' /m);
      expect((call.input ?? '').split('\n').filter((line) => line.includes('python3'))).toEqual([]);
    }
  });
});
