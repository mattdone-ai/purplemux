import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022 slice (b): the local copy of a remote tab's transcript, kept by bounded ssh reads.

const mockHome = vi.hoisted(() => ({ value: '', remote: '' }));
const ssh = vi.hoisted(() => ({ calls: [] as string[], fail: null as null | { code: number; stderr?: string } }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/session-host', () => ({
  sessionHostOf: async (s: string) => (s.includes('tab-r') ? 'ai-server' : null),
}));
vi.mock('@/lib/remote-host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/remote-host')>();
  return {
    ...actual,
    // The "remote" file is a local one; the command's offset and length are honoured as tail/head would.
    runSshBuffer: async (_host: string, command: string, opts: { maxBytes: number }) => {
      ssh.calls.push(command);
      if (ssh.fail) throw Object.assign(new Error('failed'), ssh.fail);
      const from = Number(command.match(/tail -c \+(\d+)/)?.[1]) - 1;
      const max = Number(command.match(/head -c (\d+)/)?.[1]);
      expect(max).toBeLessThanOrEqual(opts.maxBytes);
      const data = await fs.readFile(mockHome.remote);
      return Buffer.concat([Buffer.from(`${data.length}\n`), data.subarray(from, from + max)]);
    },
  };
});

const SESSION = 'pt-ws-a-pane-b-tab-r';
const SID = '0f9e2c4a-1111-2222-3333-444455556666';
const REMOTE_PATH = `/home/mdone/.claude/projects/-home-mdone-code/${SID}.jsonl`;

describe('remote transcript copy (ADR-0022)', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__ptRemoteMirrors;
    delete (globalThis as Record<string, unknown>).__ptRemoteMirrorLocks;
    delete (globalThis as Record<string, unknown>).__ptRemoteMirrorCleanup;
    delete (globalThis as Record<string, unknown>).__ptTabLifecycle;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-remote-transcript-'));
    mockHome.remote = path.join(mockHome.value, 'remote.jsonl');
    ssh.calls = [];
    ssh.fail = null;
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it.each([
    [REMOTE_PATH, SID, true],
    ['/home/mdone/.claude/projects/x/other.jsonl', SID, false],
    [`/home/mdone/.ssh/${SID}.jsonl`, SID, false],
    [`/home/mdone/.claude/projects/../../etc/${SID}.jsonl`, SID, false],
    [`relative/projects/x/${SID}.jsonl`, SID, false],
    [REMOTE_PATH, '../x', false],
  ])('accepts only a Claude transcript path: %s', async (p, sid, ok) => {
    const { isValidRemoteTranscriptPath } = await import('@/lib/remote-transcript');
    expect(isValidRemoteTranscriptPath(p, sid)).toBe(ok);
  });

  it('copies the remote bytes incrementally and keeps a multi-byte character whole across reads', async () => {
    await fs.writeFile(mockHome.remote, '{"a":"é"}\n');
    const { bindRemoteTranscript, syncRemoteTranscript, mirrorPathFor } = await import('@/lib/remote-transcript');
    const local = await bindRemoteTranscript({ session: SESSION, host: 'ai-server', sessionId: SID, remotePath: REMOTE_PATH });
    expect(local).toBe(mirrorPathFor('tab-r', SID));
    expect(await syncRemoteTranscript(SESSION)).toBe(true);
    expect(await fs.readFile(local, 'utf-8')).toBe('{"a":"é"}\n');
    await fs.appendFile(mockHome.remote, '{"b":2}\n');
    await syncRemoteTranscript(SESSION);
    expect(await fs.readFile(local, 'utf-8')).toBe('{"a":"é"}\n{"b":2}\n');
    expect(ssh.calls.at(-1)).toContain(`tail -c +${Buffer.byteLength('{"a":"é"}\n') + 1} "$p"`);
    expect(ssh.calls.at(-1)).toContain(`p='${REMOTE_PATH}'`);
  });

  it('restarts the copy when the remote file was rewritten shorter', async () => {
    await fs.writeFile(mockHome.remote, 'one\ntwo\nthree\n');
    const { bindRemoteTranscript, syncRemoteTranscript } = await import('@/lib/remote-transcript');
    const local = await bindRemoteTranscript({ session: SESSION, host: 'ai-server', sessionId: SID, remotePath: REMOTE_PATH });
    await syncRemoteTranscript(SESSION);
    await fs.writeFile(mockHome.remote, 'new\n');
    await syncRemoteTranscript(SESSION);
    expect(await fs.readFile(local, 'utf-8')).toBe('new\n');
  });

  it('a restarted server resumes the copy from mirror.json', async () => {
    await fs.writeFile(mockHome.remote, 'one\n');
    const first = await import('@/lib/remote-transcript');
    const local = await first.bindRemoteTranscript({ session: SESSION, host: 'ai-server', sessionId: SID, remotePath: REMOTE_PATH });
    await first.syncRemoteTranscript(SESSION);
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__ptRemoteMirrors;
    await fs.appendFile(mockHome.remote, 'two\n');
    const second = await import('@/lib/remote-transcript');
    expect(await second.syncRemoteTranscript(SESSION)).toBe(true);
    expect(await fs.readFile(local, 'utf-8')).toBe('one\ntwo\n');
  });

  it('a local session, an unbound remote one and a not-yet-written transcript read nothing', async () => {
    const { bindRemoteTranscript, syncRemoteTranscript } = await import('@/lib/remote-transcript');
    expect(await syncRemoteTranscript('pt-ws-a-pane-b-tab-local')).toBe(false);
    expect(await syncRemoteTranscript(SESSION)).toBe(false);
    expect(ssh.calls).toEqual([]);
    await bindRemoteTranscript({ session: SESSION, host: 'ai-server', sessionId: SID, remotePath: REMOTE_PATH });
    ssh.fail = { code: 3 };
    expect(await syncRemoteTranscript(SESSION)).toBe(false);
  });

  it('refuses to bind a path that is not a Claude transcript', async () => {
    const { bindRemoteTranscript } = await import('@/lib/remote-transcript');
    await expect(bindRemoteTranscript({ session: SESSION, host: 'ai-server', sessionId: SID, remotePath: '/etc/passwd' })).rejects.toThrow('not a Claude transcript path');
  });

  it('removing a closed tab drops its copies', async () => {
    await fs.writeFile(mockHome.remote, 'x\n');
    const { bindRemoteTranscript, syncRemoteTranscript, removeRemoteTranscripts, remoteTranscriptRoot } = await import('@/lib/remote-transcript');
    await bindRemoteTranscript({ session: SESSION, host: 'ai-server', sessionId: SID, remotePath: REMOTE_PATH });
    await syncRemoteTranscript(SESSION);
    await removeRemoteTranscripts(SESSION);
    await expect(fs.stat(path.join(remoteTranscriptRoot(), 'tab-r'))).rejects.toThrow();
  });

  it('a tab-closed event, from any close path, drops the tab\'s copies', async () => {
    await fs.writeFile(mockHome.remote, 'x\n');
    const { bindRemoteTranscript, syncRemoteTranscript, remoteTranscriptRoot } = await import('@/lib/remote-transcript');
    await bindRemoteTranscript({ session: SESSION, host: 'ai-server', sessionId: SID, remotePath: REMOTE_PATH });
    await syncRemoteTranscript(SESSION);
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    emitTabClosed({ workspaceId: 'ws-a', tabId: 'tab-r', sessionName: SESSION, reason: 'closed' } as never);
    await vi.waitFor(async () => expect(await fs.stat(path.join(remoteTranscriptRoot(), 'tab-r')).then(() => true, () => false)).toBe(false));
  });
});
