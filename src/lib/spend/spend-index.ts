import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { readClaudeUsage } from '@/lib/stats/claude-usage-line';
import { collectJsonlFiles } from '@/lib/stats/stats-cache';
import { listAllCodexJsonlFiles, readCodexSessionStats } from '@/lib/stats/jsonl-parser-codex';
import { readGrokTurnTotals } from '@/lib/stats/grok-usage';
import { listAllGrokSessions, readGrokSummary } from '@/lib/providers/grok/session-store';
import { GROK_COST_TICKS_PER_USD } from '@/lib/session-parser-grok';
import { listClaudeProjectsDirs } from '@/lib/workspace-home';
import { GLOBAL_WORKSPACE_KEY, SPEND_SLOT_MS, spendFloor, utcDay } from '@/lib/spend/spend-model';
import type { ISpendIndexStatus, ISpendUsage } from '@/types/spend';

const log = createLogger('spend-index');

// A bump must carry gone entries forward (ADR-0030 §4 Retention): a refused version rebuilds the
// index from the disk, which has lost the transcripts behind them.
const INDEX_VERSION = 1;
const STATS_DIR = path.join(os.homedir(), '.purplemux', 'stats');
const INDEX_FILE = path.join(STATS_DIR, 'spend-index.json');
const WORKSPACES_DIR = path.join(os.homedir(), '.purplemux', 'workspaces');

export const SPEND_INDEX_DEFAULTS = Object.freeze({
  startDelayMs: 120_000,
  rescanMs: 300_000,
  writeEveryMs: 60_000,
  yieldEveryLines: 1_000,
  recentIds: 256,
});

const READ_CHUNK_BYTES = 1024 * 1024;
const ASSISTANT_MARKER = Buffer.from('"type":"assistant"');

interface IClaudeBucket {
  day: string;
  /** UTC 5-minute slot start (ms); absent on buckets indexed before slots existed. */
  slot?: number;
  model: string;
  sessionId: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
}

interface IClaudeFileEntry {
  kind: 'claude';
  workspaceId: string;
  /** A subagent transcript (`<project>/<sessionId>/subagents/*.jsonl`); its usage is `sidechainTokens`. */
  sidechain: boolean;
  size: number;
  mtimeMs: number;
  ino: number;
  /** The end of the last complete line read. */
  offset: number;
  recentIds: string[];
  buckets: IClaudeBucket[];
  /** Set when the transcript left the disk; its buckets stay until their days pass the spend floor. */
  goneAt?: number;
  /** Every bucket carries a slot. A live entry without it is read again from 0 once; a gone one keeps its day buckets. */
  slotted?: true;
}

interface ISessionFileEntry {
  kind: 'codex' | 'grok';
  size: number;
  mtimeMs: number;
  ino: number;
  usage: ISpendUsage | null;
  goneAt?: number;
}

type TIndexEntry = IClaudeFileEntry | ISessionFileEntry;

interface ISpendIndexFile {
  version: typeof INDEX_VERSION;
  indexedThrough: number | null;
  files: Record<string, TIndexEntry>;
}

interface ISpendFileRef {
  path: string;
  kind: 'claude' | 'codex' | 'grok';
  workspaceId: string | null;
  sidechain: boolean;
  sessionDir?: string;
}

interface IIndexerState {
  index: ISpendIndexFile | null;
  loading: Promise<void> | null;
  fatal: string | null;
  warning: string | null;
  passCompletedThisBoot: boolean;
  progress: { filesIndexed: number; filesTotal: number };
  running: Promise<IPassResult> | null;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
  /** Set by stop: a pass in flight ends after its current file and does not claim completion. */
  aborting: boolean;
  dirty: boolean;
  lastWriteAt: number;
  generation: number;
  flattened: { generation: number; usage: ISpendUsage[] } | null;
  parsedFiles: number;
}

export interface IPassResult {
  /** Transcripts on disk this pass. */
  filesTotal: number;
  filesParsed: number;
  /** Indexed transcripts that left the disk this pass; their usage is kept (ADR-0030 §4 Retention). */
  filesGone: number;
  /** Gone entries whose last day passed the spend floor and were deleted. */
  filesExpired: number;
}

const EMPTY_PASS: IPassResult = { filesTotal: 0, filesParsed: 0, filesGone: 0, filesExpired: 0 };
const GONE_CODES = new Set(['ENOENT', 'ENOTDIR']);

export interface ISpendIndexerOptions {
  startDelayMs?: number;
  rescanMs?: number;
  beforeFirstPass?: () => Promise<void>;
}

const g = globalThis as unknown as { __ptSpendIndexer?: IIndexerState; __ptSpendIndexWriteLock?: Promise<void> };
if (!g.__ptSpendIndexer) {
  g.__ptSpendIndexer = {
    index: null, loading: null, fatal: null, warning: null, passCompletedThisBoot: false,
    progress: { filesIndexed: 0, filesTotal: 0 }, running: null, timer: null, stopped: true, aborting: false, dirty: false,
    lastWriteAt: 0, generation: 0, flattened: null, parsedFiles: 0,
  };
}
if (!g.__ptSpendIndexWriteLock) g.__ptSpendIndexWriteLock = Promise.resolve();
const state = g.__ptSpendIndexer;

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isEntry = (value: unknown): value is TIndexEntry => {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (!isFiniteNumber(e.size) || !isFiniteNumber(e.mtimeMs) || !isFiniteNumber(e.ino)) return false;
  if (e.goneAt !== undefined && !isFiniteNumber(e.goneAt)) return false;
  if (e.kind === 'claude') {
    return typeof e.workspaceId === 'string' && typeof e.sidechain === 'boolean' && isFiniteNumber(e.offset)
      && Array.isArray(e.recentIds) && Array.isArray(e.buckets);
  }
  return (e.kind === 'codex' || e.kind === 'grok') && (e.usage === null || typeof e.usage === 'object');
};

const parseIndex = (raw: string): ISpendIndexFile | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const data = parsed as Partial<ISpendIndexFile> | null;
  if (!data || data.version !== INDEX_VERSION || !data.files || typeof data.files !== 'object') return null;
  if (data.indexedThrough !== null && !isFiniteNumber(data.indexedThrough)) return null;
  if (!Object.values(data.files).every(isEntry)) return null;
  return { version: INDEX_VERSION, indexedThrough: data.indexedThrough ?? null, files: data.files };
};

const emptyIndex = (): ISpendIndexFile => ({ version: INDEX_VERSION, indexedThrough: null, files: {} });

const liveEntryCount = (index: ISpendIndexFile): number =>
  Object.values(index.files).filter((entry) => entry.goneAt === undefined).length;

/**
 * Read the persisted index once per process. A damaged file is moved aside and
 * rebuilt from the transcripts it was derived from; it is never read as empty
 * data that claims to be complete.
 */
export const loadSpendIndex = async (): Promise<void> => {
  if (state.index || state.fatal) return;
  if (!state.loading) {
    state.loading = (async () => {
      let raw: string | null = null;
      try {
        raw = await fs.readFile(INDEX_FILE, 'utf-8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          state.fatal = `spend-index.json unreadable: ${(error as Error).message}`;
          log.error(state.fatal);
          return;
        }
      }
      if (raw === null) {
        state.index = emptyIndex();
        return;
      }
      const parsed = parseIndex(raw);
      if (parsed) {
        state.index = parsed;
        // Until the first pass of this boot, the saved index is what is served: n of n, never 0 of 0.
        const saved = liveEntryCount(parsed);
        state.progress = { filesIndexed: saved, filesTotal: saved };
        return;
      }
      const aside = `${INDEX_FILE}.corrupt-${Date.now()}`;
      await fs.rename(INDEX_FILE, aside).catch(() => {});
      state.warning = `spend-index.json was damaged; moved to ${path.basename(aside)} and rebuilding`;
      log.warn(state.warning);
      state.index = emptyIndex();
    })().finally(() => { state.loading = null; });
  }
  await state.loading;
};

const writeIndex = async (): Promise<void> => {
  const index = state.index;
  if (!index || !state.dirty) return;
  let release: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  const prev = g.__ptSpendIndexWriteLock!;
  g.__ptSpendIndexWriteLock = next;
  await prev;
  const tmp = `${INDEX_FILE}.tmp`;
  try {
    state.dirty = false;
    await fs.mkdir(STATS_DIR, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(index), { mode: 0o600 });
    await fs.rename(tmp, INDEX_FILE);
    state.lastWriteAt = Date.now();
  } catch (error) {
    state.dirty = true;
    await fs.unlink(tmp).catch(() => {});
    log.warn(`spend-index.json not written: ${(error as Error).message}`);
  } finally {
    release!();
  }
};

/** `~/.purplemux/workspaces/{ws}/claude-home/projects/...` names its workspace; anything else is `global`. */
export const workspaceOfTranscript = (file: string): string => {
  const relative = path.relative(WORKSPACES_DIR, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return GLOBAL_WORKSPACE_KEY;
  const [wsId, home, projects] = relative.split(path.sep);
  return wsId && home === 'claude-home' && projects === 'projects' ? wsId : GLOBAL_WORKSPACE_KEY;
};

const listDirs = async (dir: string): Promise<string[]> => {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

/** Every `.jsonl` below `dir`, at any depth. */
const collectJsonlBelow = async (dir: string): Promise<string[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collectJsonlBelow(full));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(full);
  }
  return files;
};

/**
 * Subagent transcripts: any `.jsonl` below `<projects>/<project>/<sessionId>/subagents/`,
 * including workflow agents (`subagents/workflows/<wf>/agent-*.jsonl`).
 */
export const collectClaudeSubagentFiles = async (): Promise<string[]> => {
  const files: string[] = [];
  for (const root of await listClaudeProjectsDirs()) {
    for (const project of await listDirs(root)) {
      for (const session of await listDirs(path.join(root, project))) {
        files.push(...await collectJsonlBelow(path.join(root, project, session, 'subagents')));
      }
    }
  }
  return files;
};

const listSpendFiles = async (): Promise<ISpendFileRef[]> => {
  const [main, subagents, codex, grok] = await Promise.all([
    collectJsonlFiles(), collectClaudeSubagentFiles(), listAllCodexJsonlFiles(), listAllGrokSessions(),
  ]);
  return [
    ...main.map((file) => ({ path: file, kind: 'claude' as const, workspaceId: workspaceOfTranscript(file), sidechain: false })),
    ...subagents.map((file) => ({ path: file, kind: 'claude' as const, workspaceId: workspaceOfTranscript(file), sidechain: true })),
    ...codex.map((file) => ({ path: file, kind: 'codex' as const, workspaceId: null, sidechain: false })),
    ...grok.map((ref) => ({ path: ref.jsonlPath, kind: 'grok' as const, workspaceId: ref.workspaceId, sidechain: false, sessionDir: ref.sessionDir })),
  ];
};

const bucketKey = (day: string, model: string, sessionId: string, slot: number | undefined): string =>
  `${day}\u0000${model}\u0000${sessionId}\u0000${slot ?? ''}`;

const slotOf = (at: number | null): number | undefined => (at === null ? undefined : Math.floor(at / SPEND_SLOT_MS) * SPEND_SLOT_MS);

const needsSlots = (entry: IClaudeFileEntry): boolean => entry.goneAt === undefined && entry.slotted !== true;

/**
 * Read a Claude transcript from its last complete line. Only lines that carry
 * the assistant marker are JSON-parsed; message ids already counted in this
 * file (the last few hundred are kept) are not counted again.
 */
const indexClaudeFile = async (ref: ISpendFileRef, previous: IClaudeFileEntry | null, stat: { size: number; mtimeMs: number; ino: number }): Promise<IClaudeFileEntry> => {
  const restart = !previous || previous.ino !== stat.ino || stat.size < previous.size || needsSlots(previous);
  const entry: IClaudeFileEntry = restart
    ? { kind: 'claude', workspaceId: ref.workspaceId ?? GLOBAL_WORKSPACE_KEY, sidechain: ref.sidechain, size: 0, mtimeMs: 0, ino: stat.ino, offset: 0, recentIds: [], buckets: [], slotted: true }
    : { ...previous, recentIds: [...previous.recentIds], buckets: previous.buckets.map((b) => ({ ...b })) };
  const buckets = new Map(entry.buckets.map((b) => [bucketKey(b.day, b.model, b.sessionId, b.slot), b]));
  const counted = new Set(entry.recentIds);
  const order = [...entry.recentIds];
  let lines = 0;

  const consume = (line: Buffer): void => {
    if (line.indexOf(ASSISTANT_MARKER) === -1) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString('utf-8'));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const usage = readClaudeUsage(parsed as Record<string, unknown>);
    if (!usage) return;
    if (usage.messageId) {
      if (counted.has(usage.messageId)) return;
      counted.add(usage.messageId);
      order.push(usage.messageId);
    }
    const slot = slotOf(usage.at);
    const key = bucketKey(usage.day, usage.model, usage.sessionId, slot);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { day: usage.day, ...(slot === undefined ? {} : { slot }), model: usage.model, sessionId: usage.sessionId, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 };
      buckets.set(key, bucket);
    }
    bucket.input += usage.input;
    bucket.output += usage.output;
    bucket.cacheRead += usage.cacheRead;
    bucket.cacheCreation += usage.cacheCreation;
    bucket.cacheCreation5m += usage.cacheCreation5m;
    bucket.cacheCreation1h += usage.cacheCreation1h;
  };

  const handle = await fs.open(ref.path, 'r');
  try {
    let position = entry.offset;
    let carry = Buffer.alloc(0);
    while (position < stat.size) {
      const length = Math.min(READ_CHUNK_BYTES, stat.size - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let newline = data.indexOf(0x0a, start); newline !== -1; newline = data.indexOf(0x0a, start)) {
        consume(data.subarray(start, newline));
        start = newline + 1;
        entry.offset = position - (data.length - start);
        lines += 1;
        if (lines % SPEND_INDEX_DEFAULTS.yieldEveryLines === 0) await yieldToLoop();
      }
      carry = Buffer.from(data.subarray(start));
    }
    // A last line without its newline counts once it is a whole JSON object; a
    // line still being written does not parse and is read again next pass.
    if (carry.length) {
      try {
        JSON.parse(carry.toString('utf-8'));
        consume(carry);
        entry.offset = position;
      } catch {
        // incomplete line: left for the next pass
      }
    }
  } finally {
    await handle.close();
  }

  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  entry.ino = stat.ino;
  entry.recentIds = order.slice(-SPEND_INDEX_DEFAULTS.recentIds);
  entry.buckets = [...buckets.values()];
  return entry;
};

const indexCodexFile = async (ref: ISpendFileRef): Promise<ISpendUsage | null> => {
  const stats = await readCodexSessionStats(ref.path);
  if (!stats) return null;
  return {
    providerId: 'codex',
    workspaceId: null,
    sessionId: stats.sessionId,
    day: utcDay(stats.startedAt),
    model: stats.model ?? 'unknown',
    sidechain: false,
    input: Math.max(0, stats.inputTokens - stats.cachedInputTokens),
    output: stats.outputTokens,
    cacheRead: stats.cachedInputTokens,
    cacheCreation: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    costUsd: stats.cost,
  };
};

const indexGrokFile = async (ref: ISpendFileRef, mtimeMs: number): Promise<ISpendUsage | null> => {
  const content = await fs.readFile(ref.path, 'utf-8');
  const totals = readGrokTurnTotals(content);
  const summary = ref.sessionDir ? await readGrokSummary(ref.sessionDir) : null;
  const startedAt = summary?.createdAt ? Date.parse(summary.createdAt) : NaN;
  const tokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  return {
    providerId: 'grok',
    workspaceId: ref.workspaceId,
    sessionId: path.basename(path.dirname(ref.path)),
    day: utcDay(Number.isFinite(startedAt) ? startedAt : mtimeMs),
    model: totals.model ?? summary?.model ?? 'unknown',
    sidechain: false,
    input: totals.inputTokens,
    output: totals.outputTokens,
    cacheRead: totals.cacheReadTokens,
    cacheCreation: totals.cacheCreationTokens,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    // Grok reports its own spend per turn; no ticks on a session with tokens is an unknown price, not $0.
    costUsd: totals.costTicks > 0 || tokens === 0 ? totals.costTicks / GROK_COST_TICKS_PER_USD : null,
  };
};

const indexFile = async (ref: ISpendFileRef, previous: TIndexEntry | undefined, stat: { size: number; mtimeMs: number; ino: number }): Promise<TIndexEntry> => {
  state.parsedFiles += 1;
  if (ref.kind === 'claude') {
    return indexClaudeFile(ref, previous?.kind === 'claude' ? previous : null, stat);
  }
  const usage = ref.kind === 'codex' ? await indexCodexFile(ref) : await indexGrokFile(ref, stat.mtimeMs);
  return { kind: ref.kind, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, usage };
};

const unchanged = (entry: TIndexEntry | undefined, stat: { size: number; mtimeMs: number; ino: number }): boolean =>
  !!entry && entry.goneAt === undefined && entry.size === stat.size && entry.mtimeMs === stat.mtimeMs && entry.ino === stat.ino
  && !(entry.kind === 'claude' && needsSlots(entry));

type TStatOutcome =
  | { kind: 'file'; stat: { size: number; mtimeMs: number; ino: number } }
  | { kind: 'gone' }
  | { kind: 'unknown'; error: Error };

/** Only ENOENT or ENOTDIR on the exact path means gone; any other error says nothing about the file. */
const statTranscript = async (file: string): Promise<TStatOutcome> => {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? { kind: 'file', stat: { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino } } : { kind: 'gone' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && GONE_CODES.has(code) ? { kind: 'gone' } : { kind: 'unknown', error: error as Error };
  }
};

const markGone = (entry: TIndexEntry | undefined, now: number): boolean => {
  if (!entry || entry.goneAt !== undefined) return false;
  entry.goneAt = now;
  if (entry.kind === 'claude') entry.recentIds = [];
  return true;
};

/** Gone entries lose the days before the spend floor; an entry with nothing left is deleted. Live entries are never trimmed. */
const expireGone = (index: ISpendIndexFile, floor: string): { changed: boolean; expired: number } => {
  let changed = false;
  let expired = 0;
  for (const [file, entry] of Object.entries(index.files)) {
    if (entry.goneAt === undefined) continue;
    let empty: boolean;
    if (entry.kind === 'claude') {
      const kept = entry.buckets.filter((bucket) => bucket.day >= floor);
      if (kept.length !== entry.buckets.length) {
        entry.buckets = kept;
        changed = true;
      }
      empty = kept.length === 0;
    } else {
      empty = !entry.usage || entry.usage.day < floor;
    }
    if (empty) {
      delete index.files[file];
      changed = true;
      expired += 1;
    }
  }
  return { changed, expired };
};

const runPass = async (): Promise<IPassResult> => {
  await loadSpendIndex();
  const index = state.index;
  if (!index) return EMPTY_PASS;
  const startedAt = Date.now();
  const refs = await listSpendFiles();
  const listed = new Set(refs.map((ref) => ref.path));
  const live: Array<{ ref: ISpendFileRef; stat: { size: number; mtimeMs: number; ino: number } }> = [];
  let gone = 0;

  const settle = (file: string, outcome: TStatOutcome): void => {
    if (outcome.kind === 'gone' && markGone(index.files[file], startedAt)) gone += 1;
    if (outcome.kind === 'unknown') log.warn(`spend index kept ${file} as it was: ${outcome.error.message}`);
  };
  for (const ref of refs) {
    const outcome = await statTranscript(ref.path);
    if (outcome.kind === 'file') live.push({ ref, stat: outcome.stat });
    else settle(ref.path, outcome);
  }
  // A listing that missed a file proves nothing: only the file's own stat can mark it gone.
  for (const file of Object.keys(index.files)) {
    if (listed.has(file) || index.files[file].goneAt !== undefined) continue;
    const outcome = await statTranscript(file);
    if (outcome.kind !== 'file') settle(file, outcome);
  }
  const expiry = expireGone(index, spendFloor(startedAt));
  if (gone || expiry.changed) {
    state.dirty = true;
    state.generation += 1;
  }
  live.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const pending = live.filter(({ ref, stat }) => !unchanged(index.files[ref.path], stat));
  state.progress = { filesIndexed: live.length - pending.length, filesTotal: live.length };
  let parsed = 0;
  for (const { ref, stat } of pending) {
    if (state.aborting) break;
    // A gone path that is back is read again from 0; its new entry replaces the kept one.
    const previous = index.files[ref.path];
    try {
      index.files[ref.path] = await indexFile(ref, previous?.goneAt === undefined ? previous : undefined, stat);
      parsed += 1;
      state.dirty = true;
      state.generation += 1;
    } catch (error) {
      log.warn(`spend index skipped ${ref.path}: ${(error as Error).message}`);
    }
    state.progress.filesIndexed += 1;
    if (Date.now() - state.lastWriteAt >= SPEND_INDEX_DEFAULTS.writeEveryMs) await writeIndex();
    await yieldToLoop();
  }

  const result = { filesTotal: live.length, filesParsed: parsed, filesGone: gone, filesExpired: expiry.expired };
  if (state.aborting) {
    await writeIndex();
    return result;
  }
  index.indexedThrough = startedAt;
  state.dirty = true;
  state.passCompletedThisBoot = true;
  state.warning = null;
  await writeIndex();
  return result;
};

/** One full pass now; concurrent callers share the pass in flight. */
export const runSpendIndexPass = async (): Promise<IPassResult> => {
  if (state.fatal) return EMPTY_PASS;
  if (!state.running) state.running = runPass().finally(() => { state.running = null; });
  return state.running;
};

const schedule = (delayMs: number, options: Required<Pick<ISpendIndexerOptions, 'rescanMs'>> & ISpendIndexerOptions, first: boolean): void => {
  state.timer = setTimeout(() => {
    state.timer = null;
    void (async () => {
      try {
        if (first && options.beforeFirstPass) await options.beforeFirstPass();
        await runSpendIndexPass();
      } catch (error) {
        log.warn(`spend index pass failed: ${(error as Error).message}`);
      }
      if (!state.stopped) schedule(options.rescanMs, options, false);
    })();
  }, delayMs);
  state.timer.unref?.();
};

/** Start the background indexer: first pass after `startDelayMs`, then every `rescanMs`. */
export const startSpendIndexer = async (options: ISpendIndexerOptions = {}): Promise<void> => {
  if (!state.stopped) return;
  state.stopped = false;
  state.aborting = false;
  await loadSpendIndex();
  schedule(options.startDelayMs ?? SPEND_INDEX_DEFAULTS.startDelayMs,
    { ...options, rescanMs: options.rescanMs ?? SPEND_INDEX_DEFAULTS.rescanMs }, true);
};

export const stopSpendIndexer = async (): Promise<void> => {
  state.stopped = true;
  state.aborting = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  await state.running?.catch(() => undefined);
  await writeIndex();
  state.aborting = false;
};

export const spendIndexStatus = (): ISpendIndexStatus => {
  const indexedThrough = state.index?.indexedThrough ?? null;
  if (state.fatal) {
    return { state: 'unavailable', filesIndexed: 0, filesTotal: 0, indexedThrough: null, error: state.fatal };
  }
  const files = state.index ? liveEntryCount(state.index) : 0;
  const ready = state.passCompletedThisBoot && !state.warning;
  const progress = state.running || !ready ? state.progress : { filesIndexed: files, filesTotal: files };
  return {
    state: ready ? 'ready' : 'indexing',
    filesIndexed: progress.filesIndexed,
    filesTotal: Math.max(progress.filesTotal, progress.filesIndexed),
    indexedThrough,
    ...(state.warning ? { error: state.warning } : {}),
  };
};

/** Every indexed usage figure. Reads memory only: a request never parses a transcript. */
export const spendIndexUsage = (): ISpendUsage[] => {
  const index = state.index;
  if (!index) return [];
  if (state.flattened?.generation === state.generation) return state.flattened.usage;
  const usage: ISpendUsage[] = [];
  for (const entry of Object.values(index.files)) {
    if (entry.kind === 'claude') {
      for (const b of entry.buckets) {
        usage.push({ providerId: 'claude', workspaceId: entry.workspaceId, sessionId: b.sessionId, day: b.day,
          ...(b.slot === undefined ? {} : { slot: b.slot }), model: b.model,
          sidechain: entry.sidechain, input: b.input, output: b.output, cacheRead: b.cacheRead, cacheCreation: b.cacheCreation,
          cacheCreation5m: b.cacheCreation5m, cacheCreation1h: b.cacheCreation1h });
      }
    } else if (entry.usage) {
      usage.push(entry.usage);
    }
  }
  state.flattened = { generation: state.generation, usage };
  return usage;
};

/** Transcript files parsed since boot (NFR-7: a second request parses none). */
export const spendIndexParseCount = (): number => state.parsedFiles;
