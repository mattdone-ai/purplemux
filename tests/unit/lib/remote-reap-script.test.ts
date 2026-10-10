import { execFile, execFileSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOTE_PROVIDER_SCRIPT, REMOTE_REAP_SCRIPT, parseRemoteProviderObservation, parseRemoteReap } from '@/lib/remote-host';
import { buildRemoteShellLaunchCommand } from '@/lib/shell-env';

// The remote close script and the remote pane launch command, run for real on
// this host's sh and tmux against a throwaway socket (ADR-0022 §8, §9). The
// remote host runs the same text over `ssh … sh -s`.

const run = promisify(execFile);

const hasTool = (cmd: string): boolean => {
  try {
    execFileSync(cmd, ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const supported = process.platform === 'linux' && hasTool('tmux');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const runScript = (args: string[], script = REMOTE_REAP_SCRIPT): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-s', '--', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(script);
  });

const markedPids = async (tab: string): Promise<number[]> => {
  const { stdout } = await run('sh', ['-c', `grep -lzx "PMUX_TAB_ID=${tab}" /proc/[0-9]*/environ 2>/dev/null || true`]);
  return stdout.split('\n').filter(Boolean).map((f) => Number(f.split('/')[2]));
};

describe.skipIf(!supported)('remote reap script, run for real (ADR-0022 §9)', { timeout: 30_000 }, () => {
  const sock = `pmux-reaptest-${process.pid}-${randomBytes(3).toString('hex')}`;
  const tab = `tab-reaptest${randomBytes(4).toString('hex')}`;
  const session = `pt-ws-reap-pane-p-${tab}`;

  afterEach(async () => {
    await run('tmux', ['-L', sock, 'kill-server']).catch(() => {});
    for (const pid of await markedPids(tab)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  const start = async () => {
    await run('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '80', '-y', '24',
      buildRemoteShellLaunchCommand({ PMUX_TAB_ID: tab, PMUX_WORKSPACE_ID: 'ws-reap' })]);
    await sleep(300);
    // A subshell job and a setsid job both leave the pane's process group: tmux's hang-up misses them.
    await run('tmux', ['-L', sock, 'send-keys', '-t', session, '-l', '--', '(sleep 300 &) ; setsid sleep 301 & echo started-$PMUX_TAB_ID']);
    await run('tmux', ['-L', sock, 'send-keys', '-t', session, 'Enter']);
    for (let i = 0; i < 40 && (await markedPids(tab)).length < 3; i += 1) await sleep(100);
  };

  it('starts the pane with the marker and the account values of the host it runs on', async () => {
    await start();
    const { stdout } = await run('tmux', ['-L', sock, 'capture-pane', '-p', '-t', session]);
    expect(stdout).toContain(`started-${tab}`);
    expect((await markedPids(tab)).length).toBeGreaterThanOrEqual(3);
  });

  it('kills the escaped jobs, ends the session and reports each process', async () => {
    await start();
    const before = await markedPids(tab);
    expect(before.length).toBeGreaterThanOrEqual(3);
    const reap = parseRemoteReap(await runScript([sock, session, tab, '0']));
    expect(reap.envMarker).toBe('present');
    expect(reap.sessionGone).toBe(true);
    expect(reap.survivors).toEqual([]);
    expect(reap.killed.map((p) => p.args).sort()).toEqual(expect.arrayContaining([expect.stringContaining('sleep 300'), expect.stringContaining('sleep 301')]));
    expect(await markedPids(tab)).toEqual([]);
  });

  it('keep-processes ends the pane group only and leaves the escaped jobs', async () => {
    await start();
    const reap = parseRemoteReap(await runScript([sock, session, tab, '1']));
    expect(reap.killed).toEqual([]);
    expect(reap.sessionGone).toBe(true);
    const left = await markedPids(tab);
    expect(left.length).toBeGreaterThanOrEqual(2);
  });

  it('a session already gone still has its marked processes reaped', async () => {
    await start();
    await run('tmux', ['-L', sock, 'kill-server']);
    const reap = parseRemoteReap(await runScript([sock, session, tab, '0']));
    expect(reap.envMarker).toBe('unknown');
    expect(reap.killed.length).toBeGreaterThanOrEqual(2);
    expect(await markedPids(tab)).toEqual([]);
  });

  it('a session tmux does not know is absent, never unknown (ADR-0022 slice b)', async () => {
    const missing = parseRemoteProviderObservation(await runScript([sock, 'pt-ws-none-pane-x-tab-none', 'claude'], REMOTE_PROVIDER_SCRIPT));
    expect(missing).toEqual({ state: 'absent', reason: 'session gone' });
  });

  it('finds a provider started in the pane, and only while it runs', async () => {
    await run('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '80', '-y', '24', 'sh -c "sleep 300"']);
    await sleep(300);
    const found = parseRemoteProviderObservation(await runScript([sock, session, 'sleep'], REMOTE_PROVIDER_SCRIPT));
    expect(found.state).toBe('present');
    if (found.state === 'present') expect(found.start).toMatch(/^\d+$/);
    expect(parseRemoteProviderObservation(await runScript([sock, session, 'claude'], REMOTE_PROVIDER_SCRIPT)).state).toBe('absent');
  });
});
