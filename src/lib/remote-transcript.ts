import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { describeRemoteFailure, runSshBuffer, shQuote } from '@/lib/remote-host';
import { sessionHostOf } from '@/lib/session-host';
import { onTabClosed } from '@/lib/tab-lifecycle';

/**
 * A local copy of a remote tab's Claude transcript (ADR-0022, slice b). Every
 * reader of a transcript here — the stop classification (ADR-0018), the
 * background ledger, the timeline, the snippet — reads a local file. So the
 * remote transcript is mirrored into
 * `~/.purplemux/remote-transcripts/<tabId>/<sessionId>.jsonl` by bounded ssh
 * reads of the bytes past the copy's length, before each hook is applied and
 * before each stop is read. A `mirror.json` beside it names the remote file, so
 * a restarted server resumes the copy.
 */

const log = createLogger('remote-transcript');

/** Bytes per ssh read, and reads per sync: one sync copies at most 32 MiB. */
export const MIRROR_CHUNK_BYTES = 4 * 1024 * 1024;
const MIRROR_MAX_READS = 8;
const MIRROR_READ_TIMEOUT_MS = 10_000;

const WORKSPACE_SESSION = /^pt-(ws-.*?)-(pane-.*?)-(tab-.+)$/;
const SESSION_ID = /^[0-9A-Za-z-]{8,64}$/;

export const remoteTranscriptRoot = (): string => path.join(os.homedir(), '.purplemux', 'remote-transcripts');

/**
 * A Claude transcript the hook may name: `<abs>/projects/<project>/<sessionId>.jsonl`,
 * no `..`. Anything else is never read: the path comes from the remote host.
 */
export const isValidRemoteTranscriptPath = (remotePath: unknown, sessionId: unknown): remotePath is string => {
  if (typeof remotePath !== 'string' || typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return false;
  if (!remotePath.startsWith('/') || /[\0\n\r]/.test(remotePath) || remotePath.split('/').includes('..')) return false;
  const parts = remotePath.split('/');
  return parts.length >= 4 && parts.at(-1) === `${sessionId}.jsonl` && parts.at(-3) === 'projects';
};

interface IMirror {
  host: string;
  session: string;
  tabId: string;
  sessionId: string;
  remotePath: string;
}

const g = globalThis as unknown as {
  __ptRemoteMirrors?: Map<string, IMirror>;
  __ptRemoteMirrorLocks?: Map<string, Promise<unknown>>;
  __ptRemoteMirrorCleanup?: boolean;
};
if (!g.__ptRemoteMirrors) g.__ptRemoteMirrors = new Map();
if (!g.__ptRemoteMirrorLocks) g.__ptRemoteMirrorLocks = new Map();
const mirrors = g.__ptRemoteMirrors;
const locks = g.__ptRemoteMirrorLocks;

const tabIdOf = (session: string): string | null => session.match(WORKSPACE_SESSION)?.[3] ?? null;

export const mirrorPathFor = (tabId: string, sessionId: string): string =>
  path.join(remoteTranscriptRoot(), tabId, `${sessionId}.jsonl`);

const sidecarPath = (tabId: string): string => path.join(remoteTranscriptRoot(), tabId, 'mirror.json');

/** One sync or bind per session at a time: two appends must never interleave. */
const serialize = <T>(session: string, work: () => Promise<T>): Promise<T> => {
  const prior = locks.get(session) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(work);
  locks.set(session, next);
  return next.finally(() => {
    if (locks.get(session) === next) locks.delete(session);
  });
};

const loadSidecar = async (session: string): Promise<IMirror | null> => {
  const tabId = tabIdOf(session);
  if (!tabId) return null;
  try {
    const raw = JSON.parse(await fs.readFile(sidecarPath(tabId), 'utf-8')) as Partial<IMirror>;
    if (raw.session !== session || typeof raw.host !== 'string' || !isValidRemoteTranscriptPath(raw.remotePath, raw.sessionId)) return null;
    const mirror: IMirror = { host: raw.host, session, tabId, sessionId: raw.sessionId as string, remotePath: raw.remotePath };
    mirrors.set(session, mirror);
    return mirror;
  } catch {
    return null;
  }
};

/**
 * Bind a remote tab's session to the transcript its hook named, and return the
 * local copy's path. A new session id or remote path starts a new copy.
 */
export const bindRemoteTranscript = (input: { session: string; host: string; sessionId: string; remotePath: string }): Promise<string> =>
  serialize(input.session, async () => {
    const tabId = tabIdOf(input.session);
    if (!tabId) throw new Error(`not a workspace session: ${input.session}`);
    if (!isValidRemoteTranscriptPath(input.remotePath, input.sessionId)) throw new Error('not a Claude transcript path');
    const current = mirrors.get(input.session) ?? (await loadSidecar(input.session));
    const localPath = mirrorPathFor(tabId, input.sessionId);
    if (current && current.host === input.host && current.remotePath === input.remotePath && current.sessionId === input.sessionId) return localPath;
    const mirror: IMirror = { host: input.host, session: input.session, tabId, sessionId: input.sessionId, remotePath: input.remotePath };
    await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(sidecarPath(tabId), JSON.stringify(mirror), { mode: 0o600 });
    mirrors.set(input.session, mirror);
    return localPath;
  });

const localSize = async (file: string): Promise<number> => {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return 0;
  }
};

/**
 * Copy the remote bytes past the local copy's length. A remote file shorter
 * than the copy (rewritten) restarts the copy. Answers whether a copy exists;
 * a local tab, or a remote one no hook has bound, answers false at once.
 */
export const syncRemoteTranscript = async (session: string): Promise<boolean> => {
  const host = await sessionHostOf(session);
  if (!host) return false;
  return serialize(session, async () => {
    const mirror = mirrors.get(session) ?? (await loadSidecar(session));
    if (!mirror || mirror.host !== host) return false;
    const localPath = mirrorPathFor(mirror.tabId, mirror.sessionId);
    await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 });
    let offset = await localSize(localPath);
    for (let read = 0; read < MIRROR_MAX_READS; read += 1) {
      const command = `p=${shQuote(mirror.remotePath)}; s=$(stat -c %s "$p" 2>/dev/null) || exit 3; echo "$s"; tail -c +${offset + 1} "$p" | head -c ${MIRROR_CHUNK_BYTES}`;
      let out: Buffer;
      try {
        out = await runSshBuffer(mirror.host, command, { timeoutMs: MIRROR_READ_TIMEOUT_MS, maxBytes: MIRROR_CHUNK_BYTES });
      } catch (err) {
        // Exit 3: Claude has not written the file yet (a session start before the first prompt).
        if ((err as { code?: unknown }).code !== 3) log.warn({ session, host: mirror.host, failure: describeRemoteFailure(err) }, 'remote transcript read failed');
        return offset > 0;
      }
      const newline = out.indexOf(0x0a);
      const remoteSize = Number(out.subarray(0, newline).toString('utf-8'));
      if (newline < 0 || !Number.isSafeInteger(remoteSize)) return offset > 0;
      if (remoteSize < offset) {
        log.info({ session, remoteSize, offset }, 'remote transcript is shorter than its copy; copying it again');
        await fs.writeFile(localPath, '', { mode: 0o600 });
        offset = 0;
        continue;
      }
      const chunk = out.subarray(newline + 1);
      if (chunk.length > 0) {
        await fs.appendFile(localPath, chunk, { mode: 0o600 });
        offset += chunk.length;
      } else if (offset === 0) {
        await fs.appendFile(localPath, '', { mode: 0o600 });
      }
      if (chunk.length < MIRROR_CHUNK_BYTES || offset >= remoteSize) return true;
    }
    return true;
  });
};

/** Drop a closed tab's copies. */
export const removeRemoteTranscripts = async (session: string): Promise<void> => {
  const tabId = tabIdOf(session);
  mirrors.delete(session);
  if (tabId) await fs.rm(path.join(remoteTranscriptRoot(), tabId), { recursive: true, force: true });
};

// Every close path (tab, pane, workspace, boot sweep) ends in one tab-closed event.
if (!g.__ptRemoteMirrorCleanup) {
  g.__ptRemoteMirrorCleanup = true;
  onTabClosed(({ sessionName }) => {
    removeRemoteTranscripts(sessionName).catch((err) => {
      log.warn({ sessionName, err: err instanceof Error ? err.message : String(err) }, 'remote transcript copy not removed');
    });
  });
}
