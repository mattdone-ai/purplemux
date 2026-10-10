import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022 slice (b): remote hook events no server answered come over before each drain, as files
// in this server's own spool; only remote deliveries for a remote session of that host.

const remote = vi.hoisted(() => ({ files: {} as Record<string, string>, commands: [] as string[], fail: false }));

vi.mock('@/lib/remote-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/remote-host')>()),
  readRemoteHosts: async () => ['ai-server'],
  runSsh: async (_host: string, command: string) => {
    remote.commands.push(command);
    if (remote.fail) throw Object.assign(new Error('failed'), { code: 255 });
    if (command === 'sh -s') {
      return { stdout: Object.entries(remote.files).map(([n, c]) => `${n}\n${Buffer.from(c).toString('base64')}\n`).join(''), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  },
}));
vi.mock('@/lib/session-host', () => ({
  knownRemoteHosts: () => [],
  sessionHostOf: async (s: string) => (s === 'pt-ws-a-pane-p-tab-r' ? 'ai-server' : null),
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, hostname: () => 'mdserver1' }, hostname: () => 'mdserver1' };
});

const spooled = (session: string, query: string, at = 1791660000123) =>
  JSON.stringify({ v: 1, at, session, query, body: { session_id: 'x' } });

describe('pulling remote hook spools (ADR-0022)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-remote-spool-'));
    remote.files = {};
    remote.commands = [];
    remote.fail = false;
  });
  afterEach(async () => fs.rm(dir, { recursive: true, force: true }));

  it('moves a remote session\'s files into the local spool and deletes them on the host', async () => {
    remote.files = {
      '1791660000123-4242-0a1b2c3d.json': spooled('pt-ws-a-pane-p-tab-r', 'remote=claude&event=stop&session=pt-ws-a-pane-p-tab-r&occurredAt=1791660000123'),
      '1791660000200-4243-0a1b2c3e.json': spooled('pt-ws-a-pane-p-tab-local', 'remote=claude&event=stop&session=pt-ws-a-pane-p-tab-local'),
      '1791660000300-4244-0a1b2c3f.json': spooled('pt-ws-a-pane-p-tab-r', 'event=stop&session=pt-ws-a-pane-p-tab-r'),
      'not-a-spool-name.json': spooled('pt-ws-a-pane-p-tab-r', 'remote=claude&session=pt-ws-a-pane-p-tab-r'),
    };
    const { pullRemoteHookSpools } = await import('@/lib/remote-spool');
    const [pull] = await pullRemoteHookSpools(dir);
    expect(pull).toEqual({ host: 'ai-server', taken: 1, dropped: 2 });
    const local = await fs.readdir(dir);
    expect(local).toEqual(['1791660000123-r4242-0a1b2c3d.json']);
    const { parseSpooledHook } = await import('@/lib/hook-spool');
    expect(parseSpooledHook(await fs.readFile(path.join(dir, local[0]), 'utf-8'))).toMatchObject({ at: 1791660000123, session: 'pt-ws-a-pane-p-tab-r' });
    expect(remote.commands.at(-1)).toBe(`cd "$HOME/.purplemux-remote/mdserver1/hook-spool" && rm -f -- '1791660000123-4242-0a1b2c3d.json' '1791660000200-4243-0a1b2c3e.json' '1791660000300-4244-0a1b2c3f.json'`);
  });

  it('a host that does not answer keeps its files and the drain goes on', async () => {
    remote.fail = true;
    const { pullRemoteHookSpools } = await import('@/lib/remote-spool');
    expect(await pullRemoteHookSpools(dir)).toEqual([{ host: 'ai-server', taken: 0, dropped: 0 }]);
  });

  it('an empty remote spool deletes nothing', async () => {
    const { pullRemoteHookSpools } = await import('@/lib/remote-spool');
    await pullRemoteHookSpools(dir);
    expect(remote.commands).toEqual(['sh -s']);
  });
});
