import { execFile as execFileCb } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { orAbsent, pulseFs } from '@/lib/pulse-fs';
import type { IPulseRepo, IPulseRival, IPulseTargets } from '@/lib/pulse-scope';
import type { IPulseEvent, IPulseSourceRead, TPulseGateOutcome } from '@/types/pulse';

// The pulse's file-born sources (ADR-0034 §9). Each reads only what already exists in the targets
// its workspace's scope names (`pulse-scope.ts`); none needs a new producer. A source with nothing
// to read is unknown with its reason.

const execFile = promisify(execFileCb);
const GIT_TIMEOUT_MS = 5_000;
const DAY_MS = 86_400_000;
/** A gate log is named for its start; a gate that started up to a day before the lookback can finish inside it. */
const GATE_START_SLACK_MS = DAY_MS;
const LANDINGS_TAIL_BYTES = 512 * 1024;
const GATE_TAIL_BYTES = 16 * 1024;

// Every fs call goes through `pulseFs` (the sshfs limiter and breaker, `pulse-fs.ts`); an absent
// path reads as absent, a mount that does not answer is never read as absence.
const exists = async (target: string): Promise<boolean> => pulseFs.stat(target).then(() => true, orAbsent(false));

const mtimeOf = async (target: string): Promise<number | null> => pulseFs.stat(target).then((stat) => stat.mtimeMs, orAbsent(null));

const tailOf = (file: string, bytes: number): Promise<string> => pulseFs.tail(file, bytes);

// ── commits ──────────────────────────────────────────────────────────────────

/** `<sha> <committer epoch s>` lines from `git log --format='%H %ct'`. */
export const parseCommitLines = (stdout: string): Array<{ sha: string; at: number }> =>
  stdout.split('\n').flatMap((line) => {
    const match = /^([0-9a-f]{40}) (\d+)$/.exec(line.trim());
    return match ? [{ sha: match[1], at: Number(match[2]) * 1000 }] : [];
  });

/**
 * Commits on the scope's refs (an epic's integration and `story/*` branches; v2's `main`; in the
 * fallback, `main`, `master` and `feature/*`), by committer time. Lane branches are never read: a
 * rebase re-creates their commits (on treasury-v2, 2,255 commits in 48 h across every branch against
 * 685 on main, 2026-11-03). Worktrees of one repository share its refs, so each repository is read
 * once (keyed by its common git dir, refs merged), and a commit reachable twice counts once.
 */
export const readCommits = async (repos: readonly IPulseRepo[], since: number): Promise<IPulseSourceRead> => {
  if (!repos.length) return { id: 'commits', events: null, reason: 'no repository in this workspace\'s scope', from: [] };
  const byRepo = new Map<string, { dir: string; refs: Set<string> }>();
  for (const repo of repos) {
    try {
      const { stdout } = await execFile('git', ['-C', repo.dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: GIT_TIMEOUT_MS });
      const common = stdout.trim();
      if (!common) continue;
      const entry = byRepo.get(common) ?? { dir: repo.dir, refs: new Set<string>() };
      for (const ref of [...repo.refs, ...(repo.storyRefs ?? [])]) entry.refs.add(ref);
      byRepo.set(common, entry);
    } catch {
      // Not a git work tree: nothing to count here.
    }
  }
  if (!byRepo.size) return { id: 'commits', events: null, reason: 'no git repository in this workspace\'s scope', from: [] };
  const seen = new Map<string, number>();
  const failed: string[] = [];
  const from: string[] = [];
  for (const [common, { dir, refs }] of byRepo) {
    from.push(`${path.dirname(common)} (${[...refs].map((ref) => ref.replace('refs/heads/', '')).join(', ')})`);
    try {
      const found = (await execFile('git', ['-C', dir, 'for-each-ref', '--format=%(refname)', ...refs], { timeout: GIT_TIMEOUT_MS }))
        .stdout.split('\n').filter(Boolean);
      if (!found.length) continue;
      const { stdout } = await execFile('git', ['-C', dir, 'log', ...found, `--since=@${Math.floor(since / 1000)}`, '--format=%H %ct'],
        { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      for (const { sha, at } of parseCommitLines(stdout)) if (at >= since) seen.set(sha, at);
    } catch (err) {
      failed.push(`${path.dirname(common)}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  if (failed.length === byRepo.size) return { id: 'commits', events: null, reason: `git log failed: ${failed.join('; ')}`, from };
  return {
    id: 'commits', events: [...seen.values()].map((at) => ({ at })), from,
    reason: failed.length ? `partial: git log failed for ${failed.join('; ')}` : null,
  };
};

const commonDirOf = async (dir: string): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: GIT_TIMEOUT_MS });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/** Commits the existing refs among `patterns` reach since `since`, sha -> committer time; empty when none exists. */
const reachable = async (dir: string, patterns: readonly string[], since: number): Promise<Map<string, number>> => {
  const reached = new Map<string, number>();
  if (!patterns.length) return reached;
  const refs = (await execFile('git', ['-C', dir, 'for-each-ref', '--format=%(refname)', ...patterns], { timeout: GIT_TIMEOUT_MS }))
    .stdout.split('\n').filter(Boolean);
  if (!refs.length) return reached;
  const { stdout } = await execFile('git', ['-C', dir, 'log', ...refs, `--since=@${Math.floor(since / 1000)}`, '--format=%H %ct'],
    { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  for (const { sha, at } of parseCommitLines(stdout)) if (at >= since) reached.set(sha, at);
  return reached;
};

interface IEpicRefs {
  name: string | null;
  refs: Set<string>;
  storyRefs: Set<string>;
}

const mergeRefs = (into: IEpicRefs, repo: IPulseRepo): void => {
  for (const ref of repo.refs) into.refs.add(ref);
  for (const ref of repo.storyRefs ?? []) into.storyRefs.add(ref);
};

/**
 * An epic workspace's commits when other workspaces' epics share its repositories (round 3, F1):
 * each commit counts for exactly one leased epic. A commit only this workspace's refs reach is its
 * own; one another epic's refs reach too is its own only when its story branches hold it and no
 * other epic's story branch does (the epic it was committed on). Any other such commit, a commit
 * on both integration branches for one, counts for neither and is returned once as shared with
 * the other epics' workspaces.
 */
export const readEpicCommits = async (repos: readonly IPulseRepo[], rivals: readonly IPulseRival[], since: number): Promise<IPulseSourceRead[]> => {
  if (!repos.length) return [{ id: 'commits', events: null, reason: 'no repository in this workspace\'s scope', from: [] }];
  const mine = new Map<string, { dir: string; epic: IEpicRefs }>();
  for (const repo of repos) {
    const common = await commonDirOf(repo.dir);
    if (!common) continue;
    const entry = mine.get(common) ?? { dir: repo.dir, epic: { name: null, refs: new Set<string>(), storyRefs: new Set<string>() } };
    mergeRefs(entry.epic, repo);
    mine.set(common, entry);
  }
  if (!mine.size) return [{ id: 'commits', events: null, reason: 'no git repository in this workspace\'s scope', from: [] }];
  const others = new Map<string, IEpicRefs[]>();
  for (const rival of rivals) {
    for (const repo of rival.repos) {
      const common = await commonDirOf(repo.dir);
      if (!common || !mine.has(common)) continue;
      const list = others.get(common) ?? [];
      let epic = list.find((candidate) => candidate.name === rival.name);
      if (!epic) list.push(epic = { name: rival.name, refs: new Set(), storyRefs: new Set() });
      mergeRefs(epic, repo);
      others.set(common, list);
    }
  }
  const own = new Map<string, number>();
  const shared = new Map<string, { at: number; with: Set<string> }>();
  const failed: string[] = [];
  const from: string[] = [];
  for (const [common, { dir, epic }] of mine) {
    const refs = [...epic.refs, ...epic.storyRefs];
    from.push(`${path.dirname(common)} (${epic.refs.size} integration and ${epic.storyRefs.size} story refs)`);
    try {
      const reached = await reachable(dir, refs, since);
      const myStories = await reachable(dir, [...epic.storyRefs], since);
      const rivalsHere = await Promise.all((others.get(common) ?? []).map(async (rival) => ({
        name: rival.name!, all: await reachable(dir, [...rival.refs, ...rival.storyRefs], since), stories: await reachable(dir, [...rival.storyRefs], since),
      })));
      for (const [sha, at] of reached) {
        const reachedBy = rivalsHere.filter((rival) => rival.all.has(sha));
        if (!reachedBy.length || (myStories.has(sha) && !rivalsHere.some((rival) => rival.stories.has(sha)))) {
          own.set(sha, at);
          continue;
        }
        const entry = shared.get(sha) ?? { at, with: new Set<string>() };
        for (const rival of reachedBy) entry.with.add(rival.name);
        shared.set(sha, entry);
      }
    } catch (err) {
      failed.push(`${path.dirname(common)}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  if (failed.length === mine.size) return [{ id: 'commits', events: null, reason: `git log failed: ${failed.join('; ')}`, from }];
  const reads: IPulseSourceRead[] = [{
    id: 'commits', events: [...own.values()].map((at) => ({ at })), from,
    reason: failed.length ? `partial: git log failed for ${failed.join('; ')}` : null,
  }];
  const byWith = new Map<string, number[]>();
  for (const { at, with: names } of shared.values()) {
    const key = [...names].sort().join('\u0000');
    byWith.set(key, [...(byWith.get(key) ?? []), at]);
  }
  for (const [key, ats] of byWith) {
    reads.push({ id: 'commits', events: ats.map((at) => ({ at })), reason: null, from, sharedWith: key.split('\u0000') });
  }
  return reads;
};

// ── gates ────────────────────────────────────────────────────────────────────

/**
 * A library `gate.sh` log (`EXIT=`, `VERDICT=`, `END=` lines). The verdict word is `VERDICT=` up to
 * the first space or bracket: `VALID` with `EXIT=0` is a pass, `RED` a fail. Any other word
 * (`VOID-UNSETTLED`, `REFUSED-*`, `KILLED*`, `STOPPED`) and a log with no verdict are not a
 * finished gate: null. `at` is its `END=` time.
 */
export const parseGateShLog = (text: string): { at: number | null; outcome: TPulseGateOutcome } | null => {
  const last = (key: string): string | null => {
    const matches = [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))];
    return matches.length ? matches[matches.length - 1][1].trim() : null;
  };
  const word = /^[^\s([]*/.exec(last('VERDICT') ?? '')?.[0] ?? '';
  let outcome: TPulseGateOutcome | null = null;
  if (word === 'VALID' && last('EXIT') === '0') outcome = 'pass';
  else if (word === 'RED') outcome = 'fail';
  if (!outcome) return null;
  const end = last('END');
  const at = end ? Date.parse(end) : NaN;
  return { at: Number.isFinite(at) ? at : null, outcome };
};

/**
 * A v2 `tools/gate.sh` log: its verdict is the last `GATE PASS|STEPS-PASS|FAIL <sha> ... log <path>`
 * line naming this very file (a tools test inside the log prints verdicts for stub logs); null when none.
 */
export const parseV2GateVerdict = (text: string, fileName: string): TPulseGateOutcome | null => {
  let outcome: TPulseGateOutcome | null = null;
  for (const match of text.matchAll(/^(?:==> |FAIL: )GATE (PASS|STEPS-PASS|FAIL) +[0-9a-f]{7,40}\b.* log (\S+)\s*$/gm)) {
    if (path.basename(match[2]) === fileName) outcome = match[1] === 'FAIL' ? 'fail' : 'pass';
  }
  return outcome;
};

/** `20261103T071817Z-<sha12>.log` -> its start in ms; null for any other name. */
export const v2GateStart = (fileName: string): number | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(fileName);
  return match ? Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]) : null;
};

export interface IGateVerdictCacheEntry {
  size: number;
  mtimeMs: number;
  event: IPulseEvent | null;
}

// A finished log does not change: its verdict is read once per (size, mtime), not once a minute.
// The map is an LRU (insertion order, a hit moves to the end), bounded so seven days of v2 gate logs
// (about 2,000 a week, 2026-11-03) fit many times over and an old log never pins memory.
export const VERDICT_CACHE_MAX = 20_000;
const g = globalThis as unknown as { __ptPulseGateVerdicts?: Map<string, IGateVerdictCacheEntry> };
if (!g.__ptPulseGateVerdicts) g.__ptPulseGateVerdicts = new Map();
const verdictCache = g.__ptPulseGateVerdicts;

export const rememberVerdict = (file: string, entry: IGateVerdictCacheEntry): void => {
  verdictCache.delete(file);
  verdictCache.set(file, entry);
  while (verdictCache.size > VERDICT_CACHE_MAX) verdictCache.delete(verdictCache.keys().next().value!);
};

/** Tests only. */
export const verdictCacheSize = (): number => verdictCache.size;
export const verdictCacheHas = (file: string): boolean => verdictCache.has(file);
export const clearVerdictCacheForTests = (): void => {
  verdictCache.clear();
  g2.__ptPulseRecordMtimes?.clear();
};

type TGateFormat = 'gate-sh' | 'v2';

const gateEvent = async (file: string, format: TGateFormat): Promise<IPulseEvent | null> => {
  // A log with a verdict is finished and never read again (no stat a minute per log on the mount).
  const finished = verdictCache.get(file);
  if (finished?.event) {
    rememberVerdict(file, finished);
    return finished.event;
  }
  const stat = await pulseFs.stat(file).catch(orAbsent(null));
  if (!stat) return null;
  const cached = verdictCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    rememberVerdict(file, cached);
    return cached.event;
  }
  let event: IPulseEvent | null = null;
  const text = await tailOf(file, GATE_TAIL_BYTES).catch(orAbsent(''));
  if (format === 'gate-sh') {
    const parsed = parseGateShLog(text);
    if (parsed) event = { at: parsed.at ?? stat.mtimeMs, outcome: parsed.outcome };
  } else {
    const outcome = parseV2GateVerdict(text, path.basename(file));
    // The verdict is printed as the gate ends; the cleanup lines after it take seconds.
    if (outcome) event = { at: stat.mtimeMs, outcome };
  }
  rememberVerdict(file, { size: stat.size, mtimeMs: stat.mtimeMs, event });
  return event;
};

/**
 * The scope's `<sub>` record directories (the leased epics' `_output/<slug>/<sub>`; nothing else under
 * `_output` is read). `found` lists those that exist; `recent` those changed since the lookback (a new
 * file changes its directory's mtime).
 */
const recordDirs = async (direct: readonly string[], since: number): Promise<{ found: string[]; recent: string[] }> => {
  const found: string[] = [];
  const recent: string[] = [];
  await Promise.all([...new Set(direct)].map(async (target) => {
    const mtime = await mtimeOf(target);
    if (mtime === null) return;
    found.push(target);
    if (mtime >= since - GATE_START_SLACK_MS) recent.push(target);
  }));
  return { found: found.sort(), recent: recent.sort() };
};

// A review record is written once: its mtime is read once per path, not once a minute.
const recordMtimes = new Map<string, number>();
const g2 = globalThis as unknown as { __ptPulseRecordMtimes?: Map<string, number> };
if (!g2.__ptPulseRecordMtimes) g2.__ptPulseRecordMtimes = recordMtimes;
const recordMtime = async (file: string): Promise<number | null> => {
  const known = g2.__ptPulseRecordMtimes!.get(file);
  if (known !== undefined) return known;
  const mtime = await mtimeOf(file);
  if (mtime !== null) {
    const cache = g2.__ptPulseRecordMtimes!;
    cache.set(file, mtime);
    while (cache.size > VERDICT_CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return mtime;
};

const v2Paths = async (dirs: readonly string[], rel: string): Promise<string[]> =>
  (await Promise.all([...new Set(dirs)].map(async (dir) => {
    const target = path.join(dir, '.v2', rel);
    return (await exists(target)) ? target : null;
  }))).filter((target): target is string => target !== null);

const recordsFrom = (library: { found: string[] }, v2: string[]): string[] => [...v2, ...library.found];

const filesIn = async (dir: string, accept: (name: string) => boolean): Promise<string[]> =>
  (await pulseFs.readdir(dir).catch(orAbsent([] as string[]))).filter(accept).map((name) => path.join(dir, name));

/**
 * Gates finished, pass or fail: library `gate.sh` logs in the scope's `_output/<epic>/evidence/gates/`
 * and v2 gate logs in its `.v2/gate-logs/`. A log with no finished verdict is a gate still running.
 */
export const readGates = async (targets: IPulseTargets, since: number): Promise<IPulseSourceRead> => {
  const library = await recordDirs(targets.libraryGateDirs, since);
  const v2Dirs = await v2Paths(targets.v2Dirs, 'gate-logs');
  if (!library.found.length && !v2Dirs.length) {
    return { id: 'gates', events: null, reason: 'no gate log directory (.v2/gate-logs or _output/<epic>/evidence/gates) in this workspace\'s scope', from: [] };
  }
  const jobs: Array<{ file: string; format: TGateFormat }> = [];
  for (const dir of library.recent) {
    for (const file of await filesIn(dir, (name) => name.endsWith('.log'))) jobs.push({ file, format: 'gate-sh' });
  }
  for (const dir of v2Dirs) {
    const started = (name: string): boolean => {
      const start = v2GateStart(name);
      return start !== null && start >= since - GATE_START_SLACK_MS;
    };
    for (const file of await filesIn(dir, (name) => name.endsWith('.log') && started(name))) jobs.push({ file, format: 'v2' });
  }
  const events = (await Promise.all(jobs.map((job) => gateEvent(job.file, job.format))))
    .filter((event): event is IPulseEvent => event !== null && event.at >= since);
  return { id: 'gates', events, reason: null, from: recordsFrom(library, v2Dirs) };
};

// ── reviews ──────────────────────────────────────────────────────────────────

/**
 * Review rounds and confirmations closed: v2 review receipts (`.v2/receipts/<lane>/<patch-id>.md`, one
 * per passed round) and library review records (`_output/<epic>/reviews/*-out.md`: rounds `*-rN-out.md`
 * and confirmations `*confirm*-out.md`), by mtime. A v2 round that ends BLOCK writes no receipt, so v2
 * BLOCK rounds are seen only once story 02's producers emit them.
 */
export const readReviews = async (targets: IPulseTargets, since: number): Promise<IPulseSourceRead> => {
  const library = await recordDirs(targets.libraryReviewDirs, since);
  const receiptRoots = await v2Paths(targets.v2Dirs, 'receipts');
  if (!library.found.length && !receiptRoots.length) {
    return { id: 'reviews', events: null, reason: 'no review record directory (.v2/receipts or _output/<epic>/reviews) in this workspace\'s scope', from: [] };
  }
  const laneDirs: string[] = [];
  for (const root of receiptRoots) {
    const lanes = await pulseFs.readdirTypes(root).catch(orAbsent([]));
    await Promise.all(lanes.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const lane = path.join(root, entry.name);
      if (((await mtimeOf(lane)) ?? 0) >= since) laneDirs.push(lane);
    }));
  }
  const files = [
    ...(await Promise.all(laneDirs.map((dir) => filesIn(dir, (name) => name.endsWith('.md'))))).flat(),
    ...(await Promise.all(library.recent.map((dir) => filesIn(dir, (name) => name.endsWith('-out.md'))))).flat(),
  ];
  const events = (await Promise.all(files.map(recordMtime)))
    .filter((at): at is number => at !== null && at >= since)
    .map((at) => ({ at }));
  return { id: 'reviews', events, reason: null, from: recordsFrom(library, receiptRoots) };
};

// ── v2 landings ──────────────────────────────────────────────────────────────

/** `<iso>\tLANDED\t...` lines of `.v2/landings.log` at or after `since`; `reachedSince` says a line before `since` was seen. */
export const parseLandedLines = (text: string, since: number): { ats: number[]; reachedSince: boolean } => {
  const ats: number[] = [];
  let reachedSince = false;
  for (const line of text.split('\n')) {
    const [stamp, kind] = line.split('\t');
    const at = Date.parse(stamp);
    if (!Number.isFinite(at)) continue;
    if (at < since) reachedSince = true;
    else if (kind === 'LANDED') ats.push(at);
  }
  return { ats, reachedSince };
};

/** v2 LANDED lines of the scope's `.v2/landings.log`; the tail is read first, the whole file only when the tail does not reach back far enough. */
export const readLanded = async (targets: IPulseTargets, since: number): Promise<IPulseSourceRead> => {
  const logs = await v2Paths(targets.v2Dirs, 'landings.log');
  if (!logs.length) return { id: 'landed', events: null, reason: 'no .v2/landings.log in this workspace\'s scope', from: [] };
  const events: IPulseEvent[] = [];
  for (const file of logs) {
    const { size } = await pulseFs.stat(file);
    let parsed = parseLandedLines(await tailOf(file, LANDINGS_TAIL_BYTES), since);
    if (!parsed.reachedSince && size > LANDINGS_TAIL_BYTES) parsed = parseLandedLines(await pulseFs.readFile(file), since);
    events.push(...parsed.ats.map((at) => ({ at })));
  }
  return { id: 'landed', events, reason: null, from: logs };
};
