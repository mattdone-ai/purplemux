import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HandoffRefused, SeatHostUnreachable } from '@/lib/context-lifecycle';
import { buildCheckpoint, GIT_FACTS_SCRIPT, sha256 } from '@/lib/rotation-checkpoint';
import { checkpointCopyPath, createSeatHostIo, HandoffTooLarge, resolveSeatPlace, type ISeatHostIoDeps } from '@/lib/seat-host-io';
import type { ISeatTab } from '@/types/context-lifecycle';
import type { ITab } from '@/types/terminal';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

// vel-D5 AC3: a seat's files and git facts on its own host. Only ssh itself failing is a wait (SeatHostUnreachable);
// a missing file is a refusal like a local one.

const sshFailure = () => Object.assign(new Error('ssh: connect to host ai-server port 22: Connection timed out'), { code: 255, stderr: 'Connection timed out' });
const remoteExit = (code: number, stderr: string) => Object.assign(new Error('command failed'), { code, stderr });

const TEXT = '# Handoff: kit · updated 2026-11-08T10:00:00Z\n\n## Resume command\n/v2-lane kit\n';

const checkpoint = (handoffPath: string) => buildCheckpoint({
  taskId: 'seat:ws-a:kit', attempt: 1, workspaceId: 'ws-a', tabId: 'tab-kit', tabName: 'kit', host: 'ai-server', createdAt: 1,
  handoffPath, handoffText: TEXT, facts: { kind: 'no-cwd', cwd: null, worktree: null, branch: null, head: null, baseRef: null, base: null, dirty: null },
  sessionBefore: 'sess-1',
});

describe('seat host io', () => {
  let dir = '';
  let deps: ISeatHostIoDeps & { runSsh: ReturnType<typeof vi.fn>; runSshBuffer: ReturnType<typeof vi.fn>; runLocal: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-seat-io-'));
    deps = { runSsh: vi.fn(), runSshBuffer: vi.fn(), runLocal: vi.fn() } as never;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a remote handoff is read over ssh with the path quoted, a BOM kept', async () => {
    deps.runSshBuffer.mockResolvedValue(Buffer.from(`\ufeff${TEXT}`));
    const io = createSeatHostIo(deps);
    expect(await io.readFile('ai-server', "/srv/it's/handoff.md")).toBe(`\ufeff${TEXT}`);
    expect(deps.runSshBuffer.mock.calls[0][0]).toBe('ai-server');
    expect(deps.runSshBuffer.mock.calls[0][1]).toBe("head -c 1048577 -- '/srv/it'\\''s/handoff.md'");
  });

  it('review r1 F4: a file over the cap, or a full buffer, is the checker\'s size refusal, never a wait', async () => {
    const io = createSeatHostIo(deps);
    deps.runSshBuffer.mockResolvedValueOnce(Buffer.alloc(1024 * 1024 + 1, 0x61));
    const long = await io.readFile('ai-server', '/srv/h.md').catch((err) => err);
    expect(long).toBeInstanceOf(HandoffTooLarge);
    expect(long).toBeInstanceOf(HandoffRefused);
    expect(long).not.toBeInstanceOf(SeatHostUnreachable);
    expect(long.message).toBe('size over 1048576 bytes (expected at most 12288, 12 KB)');
    deps.runSshBuffer.mockRejectedValueOnce(Object.assign(new RangeError('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    await expect(io.readFile('ai-server', '/srv/h.md')).rejects.toBeInstanceOf(HandoffTooLarge);
    deps.runSshBuffer.mockResolvedValueOnce(Buffer.alloc(1024 * 1024, 0x61));
    expect((await io.readFile('ai-server', '/srv/h.md')).length).toBe(1024 * 1024);
  });

  it('ssh failing is SeatHostUnreachable; a file missing on the host is a plain refusal; bad UTF-8 is a refusal', async () => {
    const io = createSeatHostIo(deps);
    deps.runSshBuffer.mockRejectedValueOnce(sshFailure());
    await expect(io.readFile('ai-server', '/srv/h.md')).rejects.toBeInstanceOf(SeatHostUnreachable);
    deps.runSshBuffer.mockRejectedValueOnce(remoteExit(1, 'cat: /srv/h.md: No such file or directory'));
    const missing = await io.readFile('ai-server', '/srv/h.md').catch((err) => err);
    expect(missing).not.toBeInstanceOf(SeatHostUnreachable);
    expect(String(missing)).toContain('/srv/h.md cannot be read on ai-server (exit 1: cat: /srv/h.md: No such file or directory)');
    deps.runSshBuffer.mockResolvedValueOnce(Buffer.from([0xff, 0xfe]));
    await expect(io.readFile('ai-server', '/srv/h.md')).rejects.toThrow();
  });

  it('git facts run the one script: locally with sh, remotely on stdin with quoted arguments', async () => {
    deps.runLocal.mockResolvedValue('kind\tno-repo\ncwd\t/w\n');
    deps.runSsh.mockResolvedValue({ stdout: 'kind\tok\nworktree\t/srv/wt\nhead\tabc\ncontains\t1\n', stderr: '' });
    const io = createSeatHostIo(deps);
    expect(await io.gitFacts(null, '/w', null)).toMatchObject({ kind: 'no-repo', cwd: '/w', host: null });
    expect(deps.runLocal).toHaveBeenCalledWith(['/w', '']);
    expect(await io.gitFacts('ai-server', '/srv/wt', 'abc')).toMatchObject({ kind: 'ok', worktree: '/srv/wt', head: 'abc', containsExpected: true, host: 'ai-server' });
    expect(deps.runSsh).toHaveBeenCalledWith('ai-server', "sh -s -- '/srv/wt' 'abc'", { timeoutMs: 15_000, input: GIT_FACTS_SCRIPT });
    deps.runSsh.mockRejectedValueOnce(sshFailure());
    await expect(io.gitFacts('ai-server', '/srv/wt', null)).rejects.toBeInstanceOf(SeatHostUnreachable);
  });

  describe('review r1 F3: where a seat runs', () => {
    const seat = (host: string | null | undefined): ISeatTab => ({ workspaceId: 'ws-a', tabId: 'tab-kit', tabName: 'kit', handoffPath: '/srv/h.md', rotateAt: null, host });
    const tab = (over: Partial<ITab>): ITab => ({ id: 'tab-kit', name: 'kit', order: 0, sessionName: 'pt-ws-a-pane-1-tab-kit', ...over } as ITab);
    const placeDeps = (found: ITab | null | Error) => ({
      findTab: vi.fn(async () => {
        if (found instanceof Error) throw found;
        return found;
      }),
      sessionCwd: vi.fn(async () => '/live/cwd'),
    });

    it('a remote seat keeps its host even when the layout cannot be read or says local, and never asks a local cwd', async () => {
      const unreadable = placeDeps(new Error('EACCES'));
      expect(await resolveSeatPlace(seat('ai-server'), 'pt-ws-a-pane-1-tab-kit', unreadable)).toEqual({ host: 'ai-server', cwd: null });
      expect(unreadable.sessionCwd).not.toHaveBeenCalled();
      const stale = placeDeps(tab({ cwd: '/srv/wt' }));
      expect(await resolveSeatPlace(seat('ai-server'), 'pt-ws-a-pane-1-tab-kit', stale)).toEqual({ host: 'ai-server', cwd: '/srv/wt' });
    });

    it('a seat known local reads its live cwd, the layout cwd the fallback', async () => {
      expect(await resolveSeatPlace(seat(null), 's', placeDeps(tab({ cwd: '/layout' })))).toEqual({ host: null, cwd: '/live/cwd' });
      const none = { ...placeDeps(tab({ cwd: '/layout' })), sessionCwd: vi.fn(async () => null) };
      expect(await resolveSeatPlace(seat(null), 's', none)).toEqual({ host: null, cwd: '/layout' });
    });

    it('a seat whose host is not known takes it from the layout, and waits when the layout cannot say', async () => {
      expect(await resolveSeatPlace(seat(undefined), 's', placeDeps(tab({ host: 'ai-server', cwd: '/srv/wt' })))).toEqual({ host: 'ai-server', cwd: '/srv/wt' });
      expect(await resolveSeatPlace(seat(undefined), 's', placeDeps(tab({})))).toEqual({ host: null, cwd: '/live/cwd' });
      await expect(resolveSeatPlace(seat(undefined), 's', placeDeps(new Error('EACCES')))).rejects.toThrow(/host of seat kit is not known \(EACCES\)/);
      await expect(resolveSeatPlace(seat(undefined), 's', placeDeps(null))).rejects.toBeInstanceOf(SeatHostUnreachable);
      await expect(resolveSeatPlace(seat(undefined), null, placeDeps(null))).rejects.toThrow(/it has no session/);
    });
  });

  it('places the checkpoint beside a local handoff and writes the handoff back only when it is missing or differs', async () => {
    const io = createSeatHostIo(deps);
    const file = path.join(dir, 'seats', 'kit', 'handoff.md');
    const cp = checkpoint(file);
    expect(await io.placeCheckpoint(null, cp, false)).toEqual({ restored: false });
    expect(JSON.parse(await fs.readFile(checkpointCopyPath(file), 'utf-8'))).toEqual(cp);
    await expect(fs.stat(file)).rejects.toThrow();
    expect(await io.placeCheckpoint(null, cp, true)).toEqual({ restored: true });
    expect(await fs.readFile(file, 'utf-8')).toBe(TEXT);
    expect(await io.placeCheckpoint(null, cp, true)).toEqual({ restored: false });
    await fs.writeFile(file, 'edited\n');
    expect(await io.placeCheckpoint(null, cp, true)).toEqual({ restored: true });
    expect(sha256(await fs.readFile(file, 'utf-8'))).toBe(cp.handoffDigest);
  });

  it('a remote placement writes whole files over ssh and waits when the host does not answer', async () => {
    const io = createSeatHostIo(deps);
    const cp = checkpoint('/srv/wt/handoff.md');
    deps.runSsh.mockResolvedValue({ stdout: '', stderr: '' });
    deps.runSshBuffer.mockResolvedValue(Buffer.from(TEXT));
    expect(await io.placeCheckpoint('ai-server', cp, true)).toEqual({ restored: false });
    const [host, command, opts] = deps.runSsh.mock.calls[0];
    expect(host).toBe('ai-server');
    expect(command).toBe("umask 077; mkdir -p -- \"$(dirname -- '/srv/wt/handoff.md.checkpoint.json')\" && cat > '/srv/wt/handoff.md.checkpoint.json'.tmp.$$ && mv -f -- '/srv/wt/handoff.md.checkpoint.json'.tmp.$$ '/srv/wt/handoff.md.checkpoint.json'");
    expect(JSON.parse(opts.input)).toEqual(cp);
    deps.runSshBuffer.mockRejectedValueOnce(remoteExit(1, 'No such file'));
    expect(await io.placeCheckpoint('ai-server', cp, true)).toEqual({ restored: true });
    expect(deps.runSsh.mock.calls.at(-1)?.[2].input).toBe(TEXT);
    deps.runSsh.mockRejectedValueOnce(sshFailure());
    await expect(io.placeCheckpoint('ai-server', cp, true)).rejects.toBeInstanceOf(SeatHostUnreachable);
    deps.runSshBuffer.mockRejectedValueOnce(sshFailure());
    await expect(io.placeCheckpoint('ai-server', cp, true)).rejects.toBeInstanceOf(SeatHostUnreachable);
  });
});
