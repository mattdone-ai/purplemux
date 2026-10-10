import { spawnSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022 slice (b), review r3 nits 2, 3, 6: remote hook events no server answered come over in
// bounded batches, only from hosts that own a tab, only for a remote session of THAT host.

const remote = vi.hoisted(() => ({ lines: [] as string[], commands: [] as string[], fail: false, hosts: ['ai-server'] as string[], hold: null as Promise<void> | null }));
const audit = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/lib/remote-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/remote-host')>()),
  runSsh: async (host: string, command: string) => {
    remote.commands.push(`${host}: ${command}`);
    if (remote.hold) await remote.hold;
    if (remote.fail) throw Object.assign(new Error('failed'), { code: 255, stderr: 'ssh: connect to host ai-server port 22: Connection timed out' });
    if (command === 'sh -s') return { stdout: remote.lines.map((l) => `${l}\n`).join(''), stderr: '' };
    return { stdout: '', stderr: '' };
  },
}));
vi.mock('@/lib/session-host', () => ({
  remoteHostsInUse: async () => remote.hosts,
  sessionHostOf: async (s: string) => (s === 'pt-ws-a-pane-p-tab-r' ? 'ai-server' : s === 'pt-ws-a-pane-p-tab-g' ? 'gpu2' : null),
}));
vi.mock('@/lib/coordination-audit', () => ({ appendCoordinationAudit: audit }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, hostname: () => 'mdserver1' }, hostname: () => 'mdserver1' };
});

const spooled = (session: string, query: string, at = 1791660000123) =>
  Buffer.from(JSON.stringify({ v: 1, at, session, query, body: { session_id: 'x' } })).toString('base64');
const file = (name: string, session: string, query: string) => `file\t${name}\t${spooled(session, query)}`;
const R = 'pt-ws-a-pane-p-tab-r';

describe('pulling remote hook spools (ADR-0022)', () => {
  let dir: string;
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__ptRemoteSpoolBackoff;
    delete (globalThis as Record<string, unknown>).__ptRemoteSpoolPull;
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-remote-spool-'));
    remote.lines = [];
    remote.commands = [];
    remote.fail = false;
    remote.hosts = ['ai-server'];
    audit.mockClear();
  });
  afterEach(async () => fs.rm(dir, { recursive: true, force: true }));

  it('takes a file only for a remote session of the host it came from, and deletes every listed file there', async () => {
    remote.lines = [
      file('1791660000123-4242-0a1b2c3d.json', R, `remote=claude&event=stop&session=${R}&occurredAt=1791660000123`),
      file('1791660000150-4246-0a1b2c41.json', 'pt-ws-a-pane-p-tab-g', 'remote=claude&event=stop&session=pt-ws-a-pane-p-tab-g'),
      file('1791660000200-4243-0a1b2c3e.json', 'pt-ws-a-pane-p-tab-local', 'remote=claude&event=stop&session=pt-ws-a-pane-p-tab-local'),
      file('1791660000300-4244-0a1b2c3f.json', R, `event=stop&session=${R}`),
      file('1791660000400-4245-0a1b2c40.json', R, 'remote=claude&event=stop&session=pt-ws-a-pane-p-tab-other'),
      file('not-a-spool-name.json', R, `remote=claude&session=${R}`),
    ];
    const { pullRemoteHookSpools } = await import('@/lib/remote-spool');
    const [pull] = await pullRemoteHookSpools(dir);
    expect(pull).toEqual({ host: 'ai-server', taken: 1, dropped: 4, quarantined: 0 });
    expect(await fs.readdir(dir)).toEqual(['1791660000123-r4242-0a1b2c3d.json']);
    expect(remote.commands.at(-1)).toBe(`ai-server: cd "$HOME/.purplemux-remote/mdserver1/hook-spool" && rm -f -- '1791660000123-4242-0a1b2c3d.json' '1791660000150-4246-0a1b2c41.json' '1791660000200-4243-0a1b2c3e.json' '1791660000300-4244-0a1b2c3f.json' '1791660000400-4245-0a1b2c40.json'`);
  });

  it('audits and logs an oversize file the host moved aside', async () => {
    remote.lines = ['oversize\t1791660000123-4242-0a1b2c3d.json\t13000000'];
    const { pullRemoteHookSpools } = await import('@/lib/remote-spool');
    expect(await pullRemoteHookSpools(dir)).toEqual([{ host: 'ai-server', taken: 0, dropped: 0, quarantined: 1 }]);
    expect(audit).toHaveBeenCalledWith({ event: 'remote-hook-spool-quarantined', host: 'ai-server', file: '1791660000123-4242-0a1b2c3d.json', bytes: 13000000 });
  });

  it('asks only hosts that own a tab, and skips a failed host for 30 s', async () => {
    remote.hosts = [];
    const { pullRemoteHookSpools } = await import('@/lib/remote-spool');
    await pullRemoteHookSpools(dir);
    expect(remote.commands).toEqual([]);
    remote.hosts = ['ai-server'];
    remote.fail = true;
    let t = 1_000_000;
    const now = () => t;
    expect(await pullRemoteHookSpools(dir, now)).toEqual([{ host: 'ai-server', taken: 0, dropped: 0, quarantined: 0 }]);
    t += 10_000;
    await pullRemoteHookSpools(dir, now);
    expect(remote.commands).toHaveLength(1);
    t += 25_000;
    await pullRemoteHookSpools(dir, now);
    expect(remote.commands).toHaveLength(2);
  });

  it('the drain never waits for a slow host, and runs one pull at a time', async () => {
    let release!: () => void;
    remote.hold = new Promise<void>((r) => { release = r; });
    const { drainHookSpoolsWithRemotePull } = await import('@/lib/remote-spool');
    const started = Date.now();
    await drainHookSpoolsWithRemotePull(async () => {});
    await drainHookSpoolsWithRemotePull(async () => {});
    expect(Date.now() - started).toBeLessThan(2000);
    expect(remote.commands.filter((c) => c.endsWith('sh -s'))).toHaveLength(1);
    release();
    remote.hold = null;
  });
});

describe('the remote list script, run for real', () => {
  let home: string;
  const spool = () => path.join(home, '.purplemux-remote', 'mdserver1', 'hook-spool');
  beforeEach(async () => {
    vi.resetModules();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-remote-spool-sh-'));
    await fs.mkdir(spool(), { recursive: true });
  });
  afterEach(async () => fs.rm(home, { recursive: true, force: true }));

  const list = async () => {
    const { remoteSpoolListScript } = await import('@/lib/remote-spool');
    const r = spawnSync('sh', ['-s'], { input: remoteSpoolListScript(), env: { HOME: home, PATH: '/usr/bin:/bin' } as unknown as NodeJS.ProcessEnv, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
  };

  it('moves a file over the size bound to bad/ and lists the rest', async () => {
    await fs.writeFile(path.join(spool(), '1791660000001-1-aa.json'), '{"v":1}');
    await fs.writeFile(path.join(spool(), '1791660000002-2-bb.json'), 'x'.repeat(600 * 1024));
    const lines = await list();
    expect(lines.map((l) => [l[0], l[1]])).toEqual([['file', '1791660000001-1-aa.json'], ['oversize', '1791660000002-2-bb.json']]);
    expect(Buffer.from(lines[0][2], 'base64').toString()).toBe('{"v":1}');
    expect(await fs.readdir(path.join(spool(), 'bad'))).toEqual(['1791660000002-2-bb.json']);
  });

  it('stops a batch at the byte bound, so a backlog comes over in several pulls', async () => {
    for (let i = 0; i < 10; i += 1) await fs.writeFile(path.join(spool(), `17916600000${10 + i}-${i}-aa.json`), 'y'.repeat(500 * 1024));
    const lines = await list();
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThan(10);
    expect(lines.length * 500 * 1024).toBeLessThanOrEqual(4 * 1024 * 1024);
  });

  it('deletes a quarantined file older than 14 days and keeps a newer one', async () => {
    const bad = path.join(spool(), 'bad');
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, 'old.json'), 'x');
    await fs.writeFile(path.join(bad, 'new.json'), 'y');
    const old = new Date(Date.now() - 20 * 24 * 3600 * 1000);
    await fs.utimes(path.join(bad, 'old.json'), old, old);
    await list();
    expect(await fs.readdir(bad)).toEqual(['new.json']);
  });
});
