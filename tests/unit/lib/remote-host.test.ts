import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '', hostname: 'mdserver1' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const over = { homedir: () => mockHome.value, hostname: () => mockHome.hostname };
  return { ...actual, default: { ...actual, ...over }, ...over };
});

describe('remote host registry and ssh invocation (ADR-0022)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-remote-host-'));
    mockHome.hostname = 'mdserver1';
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('accepts ssh aliases and refuses anything ssh could read as an option or a shell could expand', async () => {
    const { isValidRemoteHostName, parseRemoteHosts } = await import('@/lib/remote-host');
    for (const ok of ['ai-server', 'ai_server.tail', 'H1']) expect(isValidRemoteHostName(ok)).toBe(true);
    for (const bad of ['-oProxyCommand=x', '', 'a b', 'a;b', '$(id)', 'a/b', 'x'.repeat(64), 7, null]) expect(isValidRemoteHostName(bad)).toBe(false);
    expect(parseRemoteHosts(' ai-server, -bad ,ai-server,gpu2 ')).toEqual(['ai-server', 'gpu2']);
    expect(parseRemoteHosts(undefined)).toEqual([]);
  });

  it('reads the registry from the fleet config key remote.hosts', async () => {
    const { readRemoteHosts } = await import('@/lib/remote-host');
    expect(await readRemoteHosts()).toEqual([]);
    const { mutateFleetConfig, setValue } = await import('@/lib/fleet-config-store');
    await mutateFleetConfig((state) => setValue(state, { key: 'remote.hosts', value: 'ai-server' }, { workspaceId: null, tabId: null, admin: true }, Date.now()));
    expect(await readRemoteHosts()).toEqual(['ai-server']);
  });

  it('names the remote socket after this host, never purple', async () => {
    mockHome.hostname = 'MD Server.local';
    const { remoteSocketName, remoteTmuxCommand } = await import('@/lib/remote-host');
    expect(remoteSocketName()).toBe('pmux-md-server-local');
    expect(remoteTmuxCommand(['has-session', '-t', "a'b"])).toBe(`'tmux' '-L' 'pmux-md-server-local' 'has-session' '-t' 'a'\\''b'`);
  });

  it('builds a non-interactive, non-multiplexed ssh argv with the host after --', async () => {
    const { sshArgv } = await import('@/lib/remote-host');
    const argv = sshArgv('ai-server', 'true');
    expect(argv.slice(-3)).toEqual(['--', 'ai-server', 'true']);
    expect(argv).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']));
    expect(argv[0]).not.toBe('-tt');
    expect(sshArgv('ai-server', 'x', { tty: true })[0]).toBe('-tt');
    expect(() => sshArgv('-oProxyCommand=sh', 'x')).toThrow(/invalid remote host/);
  });

  it('parses the reap report, keeping tabs inside args', async () => {
    const { parseRemoteReap } = await import('@/lib/remote-host');
    expect(parseRemoteReap('marker\tabsent\nkilled\t12\tsleep\tsleep\t300\nsurvivor\t13\tx\t\nsession\tpresent\n')).toEqual({
      reaper: 'remote', envMarker: 'absent', sessionGone: false,
      killed: [{ pid: 12, comm: 'sleep', args: 'sleep\t300' }],
      survivors: [{ pid: 13, comm: 'x', args: '' }],
    });
    expect(parseRemoteReap('garbage\nkilled\tnope\tx\t\n')).toEqual({ reaper: 'remote', envMarker: 'unknown', sessionGone: false, killed: [], survivors: [] });
  });

  it('classifies ssh failures apart from a remote command that exited non-zero', async () => {
    const { isSshFailure } = await import('@/lib/remote-host');
    expect(isSshFailure({ code: 255 })).toBe(true);
    expect(isSshFailure({ code: 1, killed: true })).toBe(true);
    expect(isSshFailure({ code: 'ENOENT' })).toBe(true);
    expect(isSshFailure({ code: 1 })).toBe(false);
  });

  it('tmux\'s absence is read from any stderr line: an ssh warning or shell start-up output before it changes nothing (review r2 nit 2)', async () => {
    const { isTmuxAbsence } = await import('@/lib/remote-host');
    const absent = (stderr: string) => isTmuxAbsence({ code: 1, stderr });
    expect(absent("Warning: Permanently added 'ai-server' (ED25519) to the list of known hosts.\ncan't find session: x")).toBe(true);
    expect(absent('welcome banner\nno server running on /tmp/tmux-1000/pmux-mdserver1\n')).toBe(true);
    expect(absent('some other failure')).toBe(false);
    expect(isTmuxAbsence({ code: 255, stderr: "can't find session: x" })).toBe(false);
    expect(isTmuxAbsence({ code: 1, killed: true, stderr: "can't find session: x" })).toBe(false);
  });

  it('the create tags the session in the same tmux command as new-session (review r2 nit 1)', async () => {
    const { buildRemoteCreateScript } = await import('@/lib/remote-kit');
    const script = buildRemoteCreateScript({ nonce: 'N0nce', files: [], session: 'pt-ws-a-pane-p-tab-r', cols: 80, rows: 24, launch: 'sh -l' });
    const line = script.split('\n').find((l) => l.includes("'new-session'"));
    expect(line).toMatch(/'new-session' .* 'sh -l' ';' 'set-option' '-t' '=pt-ws-a-pane-p-tab-r:' '@pmux-create' 'N0nce'$/);
    expect(script.split('\n').filter((l) => l.includes('@pmux-create'))).toHaveLength(1);
  });
});
