import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { HOOK_SPOOL_DIRNAME } from '@/lib/hook-scripts';
import { HOOK_FLOORS_FILENAME } from '@/lib/hook-floors';
import type { IHookDelivery } from '@/lib/hook-dispatch';

const log = createLogger('hook-spool');

export const HOOK_SPOOL_DIR = path.join(os.homedir(), '.purplemux', HOOK_SPOOL_DIRNAME);
export const HOOK_SPOOL_BAD_DIRNAME = 'bad';
export const HOOK_SPOOL_MAX_FILES = 10_000;
/**
 * A spooled event older than this is dropped unreplayed (ADR-0020). A restart
 * gap is seconds to minutes; an older file may predate events that a server
 * without the spool applied live, and the poll and `resolveUnknown` recover the
 * state of a long outage from the process and the transcript instead.
 */
export const HOOK_REPLAY_WINDOW_MS = 60 * 60 * 1000;
/** `bad/` entries are evidence for a week, then pruned. */
export const HOOK_SPOOL_BAD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A hook's temporary file this old belongs to a hook that died before its rename. */
export const HOOK_SPOOL_TMP_MAX_AGE_MS = 10 * 60 * 1000;
/**
 * The longest one replayed event may take (ADR-0020). A replay is in-memory
 * work plus a layout read, milliseconds; one that has not finished by then
 * moves to `bad/` and the drain goes on, so N events that hang cost at most
 * N times this.
 */
export const HOOK_REPLAY_EVENT_TIMEOUT_MS = 5_000;
/**
 * The bound for a REMOTE tab's replayed event (PMUX-REMOTE-RESILIENCE fix 4). Its replay first brings the
 * tab's transcript copy up to date over ssh (ADR-0022): one bounded read of 10 s, more for a large backlog.
 * At 5 s a slow host timed events out, and the drain went on to their session's later events, so the late
 * apply landed under the tab's floor: history only, as if dropped.
 */
export const HOOK_REPLAY_REMOTE_EVENT_TIMEOUT_MS = 30_000;
/**
 * How long a session's later events wait for its abandoned replay (review r1): past this, a replay that never
 * settles no longer holds them, and one log line says so.
 */
export const HOOK_REPLAY_INFLIGHT_MAX_MS = 10 * 60_000;
/** Session → when its abandoned replay timed out; cleared when that replay settles. Shared by every drain. */
const abandonedReplays = new Map<string, number>();
/** Files replayed between two yields to the event loop. */
const DRAIN_BATCH = 50;

/** One event a hook script could not deliver (`spool_hook` in `hook-scripts.ts`). */
export interface ISpooledHook {
  at: number;
  session: string;
  query: string;
  body: unknown;
  /** The hook kept only the metadata: the body was over the spool's size limit. */
  bodyDropped: boolean;
  bodyLength: number | null;
  /** A remote hook's event: when this server pulled it from the host's spool (`remote-spool.ts`). */
  pulledAt: number | null;
}

export interface IHookSpoolDrainResult {
  applied: number;
  bad: number;
  /** Dispatched, but not finished within the per-event bound: moved to `bad/`, and counted in `bad` too. */
  timedOut: number;
  /** Left in the spool for the next drain: a later event of a session whose replay timed out in this drain. */
  deferred: number;
  /** Past the replay window or over the file bound: deleted, never dispatched. */
  dropped: number;
  /** Written without its body (too large): deleted, never dispatched. */
  metadataOnly: number;
  prunedBad: number;
  prunedTmp: number;
}

export interface IHookSpoolDrainOptions {
  dir?: string;
  now?: number;
  maxFiles?: number;
  maxAgeMs?: number;
  eventTimeoutMs?: number;
  remoteEventTimeoutMs?: number;
}

const SPOOL_FILE = /^(\d{1,16})-(r?)[^/]*\.json$/;

export const parseSpooledHook = (text: string): ISpooledHook | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { at, session, query, body, bodyDropped, bodyLength, pulledAt } = raw as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return null;
  if (typeof session !== 'string' || typeof query !== 'string' || !('body' in raw)) return null;
  return {
    at,
    session,
    query,
    body,
    bodyDropped: bodyDropped === true,
    bodyLength: typeof bodyLength === 'number' ? bodyLength : null,
    pulledAt: typeof pulledAt === 'number' && Number.isSafeInteger(pulledAt) && pulledAt > 0 ? pulledAt : null,
  };
};

export const spooledHookQuery = (query: string): Record<string, string> =>
  Object.fromEntries(new URLSearchParams(query));

interface ISpoolEntry {
  name: string;
  at: number;
  /** Pulled from a remote host's spool (`<at>-r<pid>-<rand>.json`): its age is judged from the pull, after parse. */
  remote: boolean;
}

interface ISpoolListing {
  entries: ISpoolEntry[];
  unnamed: string[];
  temporaries: string[];
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

const listSpool = async (dir: string): Promise<ISpoolListing> => {
  let dirents: import('fs').Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return { entries: [], unnamed: [], temporaries: [] };
    throw err;
  }
  const listing: ISpoolListing = { entries: [], unnamed: [], temporaries: [] };
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    // The server's own floors file (ADR-0020) is neither an event nor a temporary.
    if (dirent.name === HOOK_FLOORS_FILENAME) continue;
    // Other dot files are temporaries, still being written or orphaned.
    if (dirent.name.startsWith('.')) {
      listing.temporaries.push(dirent.name);
      continue;
    }
    const match = SPOOL_FILE.exec(dirent.name);
    if (match) listing.entries.push({ name: dirent.name, at: Number(match[1]), remote: match[2] === 'r' });
    else listing.unnamed.push(dirent.name);
  }
  listing.entries.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return listing;
};

const quarantine = async (dir: string, name: string, reason: string): Promise<void> => {
  const badDir = path.join(dir, HOOK_SPOOL_BAD_DIRNAME);
  await fs.mkdir(badDir, { recursive: true, mode: 0o700 });
  await fs.rename(path.join(dir, name), path.join(badDir, name));
  log.warn({ file: name, reason }, `spooled hook event moved to ${HOOK_SPOOL_BAD_DIRNAME}/: ${reason}`);
};

/** Remove every entry of `dir` whose mtime is older than `maxAgeMs`; returns how many. */
const pruneOlderThan = async (dir: string, names: string[], now: number, maxAgeMs: number): Promise<number> => {
  let pruned = 0;
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      const stat = await fs.lstat(target);
      if (now - stat.mtimeMs <= maxAgeMs) continue;
      await fs.rm(target, { recursive: true, force: true });
      pruned += 1;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  }
  return pruned;
};

const pruneBad = async (dir: string, now: number): Promise<number> => {
  const badDir = path.join(dir, HOOK_SPOOL_BAD_DIRNAME);
  let names: string[];
  try {
    names = await fs.readdir(badDir);
  } catch (err) {
    if (isMissing(err)) return 0;
    throw err;
  }
  return pruneOlderThan(badDir, names, now, HOOK_SPOOL_BAD_MAX_AGE_MS);
};

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

const replayStillRunning = (session: string, now: number): boolean => {
  const since = abandonedReplays.get(session);
  if (since === undefined) return false;
  if (now - since <= HOOK_REPLAY_INFLIGHT_MAX_MS) return true;
  abandonedReplays.delete(session);
  log.warn({ session, sinceMs: now - since }, 'an abandoned replay never settled: its session\'s later events replay again');
  return false;
};

type TReplayOutcome = { kind: 'applied' } | { kind: 'threw'; err: unknown } | { kind: 'timed-out'; late: (quarantined: Promise<unknown>, onSettled: () => void) => void };

/**
 * Run one replay, bounded. A replay that has not settled within `timeoutMs` is
 * abandoned, never cancelled. Its file moves to `bad/`; when it settles later
 * one log line says how, and when, with the file's name. One that applied
 * leaves `bad/` again (PMUX-REMOTE-RESILIENCE fix 4): it is no bad event, and
 * an operator who re-injects a `bad/` file would apply it twice. One that
 * failed stays there. A late state change is ordered against the tab's floor
 * like any replay.
 */
const replayBounded = async (run: () => Promise<unknown>, timeoutMs: number, file: string, badPath: string): Promise<TReplayOutcome> => {
  let timer: NodeJS.Timeout | undefined;
  const startedAt = Date.now();
  const replay = Promise.resolve().then(run);
  const late = (quarantined: Promise<unknown>, onSettled: () => void) => {
    void replay.then(() => {}, () => {}).then(onSettled);
    replay.then(async () => {
      const afterMs = Date.now() - startedAt;
      // The move to bad/ ends first, so the removal never races it.
      await quarantined.catch(() => {});
      const removed = await fs.rm(badPath).then(() => true, () => false);
      log.warn({ file, afterMs, removedFromBad: removed }, `abandoned replay of ${file} applied at +${afterMs} ms; ${removed ? `its file is removed from ${HOOK_SPOOL_BAD_DIRNAME}/` : `its file was not in ${HOOK_SPOOL_BAD_DIRNAME}/`}`);
    }, (err: unknown) => {
      const afterMs = Date.now() - startedAt;
      log.warn({ file, afterMs, err }, `abandoned replay of ${file} failed at +${afterMs} ms; its file stays in ${HOOK_SPOOL_BAD_DIRNAME}/`);
    });
  };
  const timeout = new Promise<TReplayOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed-out', late }), timeoutMs);
  });
  try {
    return await Promise.race([
      replay.then((): TReplayOutcome => ({ kind: 'applied' }), (err: unknown): TReplayOutcome => ({ kind: 'threw', err })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Replay the events hook scripts spooled while no server answered (ADR-0020).
 *
 * Oldest first, each through `apply` — the hook route's own dispatcher — with
 * its original time, and deleted once applied. A file that does not parse, or
 * whose replay throws, moves to `bad/` once and is never retried; so does one
 * whose replay has not finished within `eventTimeoutMs` (5 s; a remote tab's
 * `remoteEventTimeoutMs`, 30 s), and the drain goes on with the next file
 * of another session: that session's later files wait in the spool until the
 * abandoned replay settles (at most HOOK_REPLAY_INFLIGHT_MAX_MS), across drains. Files past
 * the replay window, then the oldest beyond `maxFiles`, are deleted without
 * dispatch, with one log line; so is a file whose body the hook dropped for
 * size. `bad/` entries older than 7 days and orphaned temporaries older than
 * 10 minutes are pruned. The drain yields to the event loop every 50 files,
 * so the server keeps answering while a large spool drains.
 */
export const drainHookSpool = async (
  apply: (delivery: IHookDelivery) => Promise<unknown>,
  options: IHookSpoolDrainOptions = {},
): Promise<IHookSpoolDrainResult> => {
  const dir = options.dir ?? HOOK_SPOOL_DIR;
  const now = options.now ?? Date.now();
  const maxFiles = options.maxFiles ?? HOOK_SPOOL_MAX_FILES;
  const maxAgeMs = options.maxAgeMs ?? HOOK_REPLAY_WINDOW_MS;
  const eventTimeoutMs = options.eventTimeoutMs ?? HOOK_REPLAY_EVENT_TIMEOUT_MS;
  const remoteEventTimeoutMs = options.remoteEventTimeoutMs ?? HOOK_REPLAY_REMOTE_EVENT_TIMEOUT_MS;
  const result: IHookSpoolDrainResult = {
    applied: 0, bad: 0, timedOut: 0, deferred: 0, dropped: 0, metadataOnly: 0, prunedBad: 0, prunedTmp: 0,
  };
  const deferredSessions = new Set<string>();

  const { entries, unnamed, temporaries } = await listSpool(dir);
  result.prunedTmp = await pruneOlderThan(dir, temporaries, now, HOOK_SPOOL_TMP_MAX_AGE_MS);
  result.prunedBad = await pruneBad(dir, now);
  if (result.prunedTmp > 0 || result.prunedBad > 0) {
    log.info({ prunedTmp: result.prunedTmp, prunedBad: result.prunedBad }, 'hook spool pruned');
  }
  for (const name of unnamed) {
    await quarantine(dir, name, 'name is not <epoch-ms>-<pid>-<rand>.json');
    result.bad += 1;
  }
  if (entries.length === 0) return result;

  // A remote event reaches this spool only when a pull takes it, however late (an unreachable host backs off):
  // its age is judged from that pull, once the file is read, never from the remote hook's own clock.
  const fresh = entries.filter((entry) => entry.remote || now - entry.at <= maxAgeMs);
  const kept = fresh.slice(Math.max(0, fresh.length - maxFiles));
  const keptNames = new Set(kept.map((entry) => entry.name));
  const dropped = entries.filter((entry) => !keptNames.has(entry.name));
  if (dropped.length > 0) {
    for (const entry of dropped) await fs.rm(path.join(dir, entry.name), { force: true });
    result.dropped = dropped.length;
    log.warn(
      { dropped: dropped.length, expired: entries.length - fresh.length, oldestAt: dropped[0].at, maxFiles, maxAgeMs },
      `hook spool: dropped ${dropped.length} event(s) past the replay window or the file bound, unreplayed`,
    );
  }

  let droppedBodyLength = 0;
  for (const [index, entry] of kept.entries()) {
    if (index > 0 && index % DRAIN_BATCH === 0) await yieldToEventLoop();
    const file = path.join(dir, entry.name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf-8');
    } catch (err) {
      // Another drain (a second process on the same home) took it first.
      if (isMissing(err)) continue;
      throw err;
    }
    const spooled = parseSpooledHook(text);
    if (!spooled) {
      await quarantine(dir, entry.name, 'not a spooled hook event (JSON with at, session, query, body)');
      result.bad += 1;
      continue;
    }
    if (entry.remote && now - (spooled.pulledAt ?? spooled.at) > maxAgeMs) {
      await fs.rm(file, { force: true });
      result.dropped += 1;
      log.warn({ file: entry.name, at: spooled.at, pulledAt: spooled.pulledAt, maxAgeMs }, 'hook spool: dropped a remote event pulled longer ago than the replay window, unreplayed');
      continue;
    }
    if (spooled.bodyDropped) {
      await fs.rm(file, { force: true });
      result.metadataOnly += 1;
      droppedBodyLength += spooled.bodyLength ?? 0;
      continue;
    }
    // The session's earlier event is still being applied, in this drain or since an earlier one: this one waits for
    // a later drain, so it does not land before it (and the late one does not land under this one's floor). The
    // wait ends at HOOK_REPLAY_INFLIGHT_MAX_MS: a replay that never settles holds the session no longer.
    if (deferredSessions.has(spooled.session) || replayStillRunning(spooled.session, now)) {
      deferredSessions.add(spooled.session);
      result.deferred += 1;
      continue;
    }
    // A hook clock ahead of the server's must not date an event in the future.
    const query = spooledHookQuery(spooled.query);
    const delivery = { query, body: spooled.body, replayedAt: Math.min(spooled.at, now) };
    const timeoutMs = query.remote ? remoteEventTimeoutMs : eventTimeoutMs;
    const badPath = path.join(dir, HOOK_SPOOL_BAD_DIRNAME, entry.name);
    const outcome = await replayBounded(() => apply(delivery), timeoutMs, entry.name, badPath);
    if (outcome.kind === 'threw') {
      const { err } = outcome;
      await quarantine(dir, entry.name, `replay threw: ${err instanceof Error ? err.message : String(err)}`);
      result.bad += 1;
      continue;
    }
    if (outcome.kind === 'timed-out') {
      const quarantined = quarantine(dir, entry.name, `replay did not finish within ${timeoutMs} ms`);
      const session = spooled.session;
      const marker = Date.now();
      abandonedReplays.set(session, marker);
      outcome.late(quarantined, () => {
        if (abandonedReplays.get(session) === marker) abandonedReplays.delete(session);
      });
      await quarantined;
      result.bad += 1;
      result.timedOut += 1;
      deferredSessions.add(spooled.session);
      continue;
    }
    await fs.rm(file, { force: true });
    result.applied += 1;
  }
  if (result.metadataOnly > 0) {
    log.info({ metadataOnly: result.metadataOnly, droppedBodyLength }, `hook spool: ${result.metadataOnly} event(s) spooled without their body (too large), not replayed`);
  }
  if (result.applied > 0) {
    log.info({ applied: result.applied, from: kept[0].at, to: kept[kept.length - 1].at }, `replayed ${result.applied} spooled hook event(s)`);
  }
  return result;
};
