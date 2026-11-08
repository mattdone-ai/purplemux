import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { HandoffRefused, SeatHostUnreachable } from '@/lib/context-lifecycle';
import { describeRemoteFailure, isSshFailure, runSsh, runSshBuffer, shQuote } from '@/lib/remote-host';
import { GIT_FACTS_SCRIPT, parseGitFacts, sha256 } from '@/lib/rotation-checkpoint';
import { HANDOFF_MAX_BYTES } from '@/lib/handoff-check';
import type { ISeatTab } from '@/types/context-lifecycle';
import type { IGitFacts, IRotationCheckpoint } from '@/types/rotation-checkpoint';
import type { ITab } from '@/types/terminal';

// vel-D5: a seat's files and git facts on the host the tab runs on. A local seat reads this host; a remote seat
// (ADR-0022) goes over ssh. Only the transport failing is `SeatHostUnreachable`; the rotation waits on it.

const execFileAsync = promisify(execFile);
const IO_TIMEOUT_MS = 15_000;
const MAX_FILE_BYTES = 1024 * 1024;

export const checkpointCopyPath = (handoffPath: string): string => `${handoffPath}.checkpoint.json`;

/** The checker's own size refusal (`handoff-check.ts`), for a remote file too long to read whole. */
export class HandoffTooLarge extends HandoffRefused {
  constructor() {
    super(`size over ${MAX_FILE_BYTES} bytes (expected at most ${HANDOFF_MAX_BYTES}, 12 KB)`);
    this.name = 'HandoffTooLarge';
  }
}

const MAX_BUFFER = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

export interface ISeatPlaceDeps {
  /** The tab in its workspace layout; null when the layout does not name it; throws when it cannot be read. */
  findTab: (sessionName: string, workspaceId: string) => Promise<ITab | null>;
  /** The live working directory of a local session. */
  sessionCwd: (sessionName: string) => Promise<string | null>;
}

/**
 * Where a seat runs and in which directory (review r1 F3). The seat's own host wins when it is known: a remote seat
 * never falls back to this host because a layout read failed. A seat whose host is not known (`undefined`, an entry
 * registered before its first poll) takes it from its layout; when that cannot be read the seat waits.
 */
export const resolveSeatPlace = async (seat: ISeatTab, sessionName: string | null, deps: ISeatPlaceDeps): Promise<{ host: string | null; cwd: string | null }> => {
  let tab: ITab | null = null;
  let layoutError: unknown = null;
  if (sessionName) {
    try {
      tab = await deps.findTab(sessionName, seat.workspaceId);
    } catch (err) {
      layoutError = err;
    }
  }
  let host: string | null;
  if (seat.host !== undefined) host = seat.host;
  else if (tab) host = tab.host ?? null;
  else {
    const why = layoutError instanceof Error ? layoutError.message : sessionName ? 'its layout does not name it' : 'it has no session';
    throw new SeatHostUnreachable(`the host of seat ${seat.tabName} is not known (${why})`);
  }
  const live = !host && sessionName ? await deps.sessionCwd(sessionName) : null;
  return { host, cwd: live ?? tab?.cwd ?? null };
};

export interface ISeatHostIoDeps {
  runSsh: typeof runSsh;
  runSshBuffer: typeof runSshBuffer;
  runLocal: (args: readonly string[]) => Promise<string>;
}

const realDeps: ISeatHostIoDeps = {
  runSsh,
  runSshBuffer,
  runLocal: async (args) => (await execFileAsync('sh', ['-c', GIT_FACTS_SCRIPT, 'sh', ...args], { timeout: IO_TIMEOUT_MS })).stdout,
};

// A BOM is kept, so the checker refuses it as v2's does (ADR-0036 F6).
const decode = (bytes: Uint8Array): string => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

const unreachable = (host: string, err: unknown): SeatHostUnreachable =>
  new SeatHostUnreachable(`remote host ${host} did not answer over ssh (${describeRemoteFailure(err)})`);

export const createSeatHostIo = (deps: ISeatHostIoDeps = realDeps) => {
  /** The file as UTF-8 text; throws when it is missing or not UTF-8, `SeatHostUnreachable` when ssh fails. */
  const readFile = async (host: string | null, file: string): Promise<string> => {
    if (!host) return decode(await fs.readFile(file));
    let bytes: Buffer;
    try {
      // One byte past the cap tells a file that is too long from one that fits, and never fills the buffer.
      bytes = await deps.runSshBuffer(host, `head -c ${MAX_FILE_BYTES + 1} -- ${shQuote(file)}`, { timeoutMs: IO_TIMEOUT_MS, maxBytes: MAX_FILE_BYTES + 1 });
    } catch (err) {
      // A full buffer is the file's size, not the network (review r1 F4).
      if ((err as { code?: unknown } | null)?.code === MAX_BUFFER) throw new HandoffTooLarge();
      if (isSshFailure(err)) throw unreachable(host, err);
      throw new Error(`${file} cannot be read on ${host} (${describeRemoteFailure(err)})`);
    }
    if (bytes.length > MAX_FILE_BYTES) throw new HandoffTooLarge();
    return decode(bytes);
  };

  /** Written whole or not at all: a temporary file beside it, then a rename. */
  const writeFile = async (host: string | null, file: string, content: string): Promise<void> => {
    if (!host) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp.${process.pid}`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, file);
      return;
    }
    const target = shQuote(file);
    try {
      await deps.runSsh(host, `umask 077; mkdir -p -- "$(dirname -- ${target})" && cat > ${target}.tmp.$$ && mv -f -- ${target}.tmp.$$ ${target}`,
        { timeoutMs: IO_TIMEOUT_MS, input: content });
    } catch (err) {
      if (isSshFailure(err)) throw unreachable(host, err);
      throw new Error(`${file} cannot be written on ${host} (${describeRemoteFailure(err)})`);
    }
  };

  const gitFacts = async (host: string | null, cwd: string | null, expectedHead: string | null): Promise<IGitFacts> => {
    const args = [cwd ?? '', expectedHead ?? ''];
    if (!host) return { ...parseGitFacts(await deps.runLocal(args), cwd), host: null };
    try {
      const { stdout } = await deps.runSsh(host, `sh -s -- ${args.map(shQuote).join(' ')}`, { timeoutMs: IO_TIMEOUT_MS, input: GIT_FACTS_SCRIPT });
      return { ...parseGitFacts(stdout, cwd), host };
    } catch (err) {
      if (isSshFailure(err)) throw unreachable(host, err);
      throw new Error(`git facts on ${host} failed (${describeRemoteFailure(err)})`);
    }
  };

  /**
   * The checkpoint as a plain file beside the handoff and, with `restoreHandoff`, the handoff written back when it is
   * missing or differs from the checkpoint's. Answers whether the handoff was written.
   */
  const placeCheckpoint = async (host: string | null, checkpoint: IRotationCheckpoint, restoreHandoff: boolean): Promise<{ restored: boolean }> => {
    await writeFile(host, checkpointCopyPath(checkpoint.handoffPath), `${JSON.stringify(checkpoint, null, 2)}\n`);
    if (!restoreHandoff) return { restored: false };
    let current: string | null;
    try {
      current = await readFile(host, checkpoint.handoffPath);
    } catch (err) {
      if (err instanceof SeatHostUnreachable) throw err;
      current = null;
    }
    if (current !== null && sha256(current) === checkpoint.handoffDigest) return { restored: false };
    await writeFile(host, checkpoint.handoffPath, checkpoint.handoffText);
    return { restored: true };
  };

  return { readFile, writeFile, gitFacts, placeCheckpoint };
};

export type TSeatHostIo = ReturnType<typeof createSeatHostIo>;
