import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IPulseTargets } from '@/lib/pulse-scope';
import {
  VERDICT_CACHE_MAX,
  clearVerdictCacheForTests,
  parseCommitLines,
  parseGateShLog,
  parseLandedLines,
  parseV2GateVerdict,
  readCommits,
  readGates,
  readLanded,
  readReviews,
  rememberVerdict,
  v2GateStart,
  verdictCacheHas,
  verdictCacheSize,
} from '@/lib/pulse-sources';

const HOUR = 3_600_000;
const NOW = Date.now();
const SINCE = NOW - 169 * HOUR;

let root: string;

const write = (rel: string, text: string, mtime?: number): string => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
};

const stamp = (at: number): string => new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-sources-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parsers', () => {
  it('gate.sh logs: the verdict word up to a space or bracket; VALID with EXIT=0 passes, RED fails (round 2, F3)', () => {
    expect(parseGateShLog('END=2026-11-03T07:41:44Z\nSETTLED=yes\nEXIT=0\nVERDICT=VALID\n'))
      .toEqual({ at: Date.parse('2026-11-03T07:41:44Z'), outcome: 'pass' });
    expect(parseGateShLog('END=2026-11-03T07:41:44Z\nEXIT=0\nVERDICT=VALID (lanes in scope: lint,test)\n')?.outcome).toBe('pass');
    expect(parseGateShLog('EXIT=0\nVERDICT=VALID(reused)\n')?.outcome).toBe('pass');
    expect(parseGateShLog('END=2026-11-03T07:41:44Z\nEXIT=1\nVERDICT=RED (lanes in scope: lint,test,build — a lane after the failing one did not run)\n'))
      .toEqual({ at: Date.parse('2026-11-03T07:41:44Z'), outcome: 'fail' });
  });

  it('gate.sh logs: VOID, REFUSED, KILLED and STOPPED are not finished gates, never failed ones; no verdict is still running', () => {
    for (const verdict of ['VOID-UNSETTLED', 'REFUSED-LOAD (1-min load 99)', 'KILLED', 'KILLED-SIGTERM', 'STOPPED']) {
      expect(parseGateShLog(`EXIT=1\nVERDICT=${verdict}\n`)).toBeNull();
    }
    expect(parseGateShLog('EXIT=1\nVERDICT=VALID\n')).toBeNull();
    expect(parseGateShLog('START=2026-11-03T07:00:00Z\nrunning\n')).toBeNull();
  });

  it('v2 gate logs: only the verdict line naming this file counts, never a tools test stub', () => {
    const name = '20261103T071238Z-50aafa1b016f.log';
    const text = [
      '==> GATE PASS  51f61e2d4a6c50e1812a046c79248bc3eddacddd  (0 s)  log /tmp/stub.log',
      `FAIL: GATE FAIL  50aafa1b016f8f7015690a0994ebfc5421933194  (2202 s)  log /x/.v2/gate-logs/${name}`,
      '==> gate: kept db container v2db-repo',
    ].join('\n');
    expect(parseV2GateVerdict(text, name)).toBe('fail');
    expect(parseV2GateVerdict(`==> GATE PASS  abcdef1234567  (3 s)  log /x/${name}\n`, name)).toBe('pass');
    expect(parseV2GateVerdict(`==> GATE STEPS-PASS abcdef1234567  (steps a)  log /x/${name}\n`, name)).toBe('pass');
    expect(parseV2GateVerdict('==> GATE PASS  51f61e2d4a6c  (0 s)  log /tmp/stub.log\n', name)).toBeNull();
    expect(v2GateStart(name)).toBe(Date.UTC(2026, 10, 3, 7, 12, 38));
    expect(v2GateStart('ui1-land-waiter.log')).toBeNull();
  });

  it('LANDED lines at or after since, and whether the text reached back to since', () => {
    const text = [
      'partial line from a tail read',
      '2026-11-01T00:00:00Z\tLANDED\tkit\tabc',
      '2026-11-03T06:32:54Z\tLANDED\tscope\tdef',
      '2026-11-03T06:40:00Z\tHELD\tscope',
      '2026-11-03T07:33:52Z\tLANDED\tE3\tghi',
    ].join('\n');
    expect(parseLandedLines(text, Date.parse('2026-11-02T00:00:00Z'))).toEqual({
      ats: [Date.parse('2026-11-03T06:32:54Z'), Date.parse('2026-11-03T07:33:52Z')], reachedSince: true,
    });
    expect(parseLandedLines(text, Date.parse('2026-10-01T00:00:00Z')).reachedSince).toBe(false);
  });

  it('git log lines', () => {
    expect(parseCommitLines(`${'a'.repeat(40)} 1762150000\nnoise\n${'b'.repeat(40)} 1762150060\n`))
      .toEqual([{ sha: 'a'.repeat(40), at: 1762150000000 }, { sha: 'b'.repeat(40), at: 1762150060000 }]);
  });
});

const targets = (over: Partial<IPulseTargets> = {}): IPulseTargets => ({
  repos: [], libraryGateDirs: [], libraryReviewDirs: [], v2Dirs: [], ...over,
});

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

describe('readers', () => {
  it('targets with nothing to read are not measured, with the reason', async () => {
    const none = targets({ libraryGateDirs: [path.join(root, '_output/x/evidence/gates')], libraryReviewDirs: [path.join(root, '_output/x/reviews')], v2Dirs: [root], repos: [{ dir: root, refs: ['refs/heads/main'] }] });
    expect(await readCommits(none.repos, SINCE)).toMatchObject({ events: null, reason: "no git repository in this workspace's scope" });
    expect(await readCommits([], SINCE)).toMatchObject({ events: null, reason: "no repository in this workspace's scope" });
    expect((await readGates(none, SINCE)).events).toBeNull();
    expect((await readReviews(none, SINCE)).events).toBeNull();
    expect(await readLanded(none, SINCE)).toMatchObject({ events: null, reason: "no .v2/landings.log in this workspace's scope" });
  });

  it('commits on the scope\'s refs only, each repository once across its worktrees with refs merged', async () => {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { env: gitEnv });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'one');
    git('checkout', '-q', '-b', 'feature/epic');
    git('commit', '-q', '--allow-empty', '-m', 'two');
    git('checkout', '-q', '-b', 'lane/x');
    git('commit', '-q', '--allow-empty', '-m', 'lane rebase noise');
    git('checkout', '-q', 'feature/epic');
    git('worktree', 'add', '-q', '-b', 'story/x', path.join(root, 'wt'));
    execFileSync('git', ['-C', path.join(root, 'wt'), 'commit', '-q', '--allow-empty', '-m', 'three'], { env: gitEnv });
    const epic = await readCommits([{ dir: repo, refs: ['refs/heads/feature/epic'] }, { dir: path.join(root, 'wt'), refs: ['refs/heads/story'] }], SINCE);
    // feature/epic holds 'one' and 'two'; story/x adds 'three'; the lane branch is never read.
    expect(epic.events).toHaveLength(3);
    expect(epic.from).toEqual([expect.stringMatching(/repo \(feature\/epic, story\)$/)]);
    expect((await readCommits([{ dir: repo, refs: ['refs/heads/main'] }], SINCE)).events).toHaveLength(1);
    expect((await readCommits([{ dir: repo, refs: ['refs/heads/main'] }], NOW + HOUR)).events).toEqual([]);
  });

  it('gates: library and v2 logs, pass and fail, running gates and old logs left out', async () => {
    const end = new Date(NOW - 2 * HOUR).toISOString();
    write('_output/epic-a/evidence/gates/01-r1.log', `END=${end}\nEXIT=0\nVERDICT=VALID\n`);
    write('_output/epic-a/evidence/gates/01-r2.log', 'START=x\nstill running\n');
    write('_output/epic-a/evidence/gates/01-r3.log', 'EXIT=1\nVERDICT=VOID-UNSETTLED\n');
    write('_output/epic-a/evidence/gates/01-r1.log.exit', '0\n');
    const v2Name = `${stamp(NOW - 3 * HOUR)}-50aafa1b016f.log`;
    write(`.v2/gate-logs/${v2Name}`, `FAIL: GATE FAIL  50aafa1b016f  (9 s)  log /x/${v2Name}\n`, NOW - 90 * 60_000);
    const oldName = `${stamp(NOW - 30 * 24 * HOUR)}-aaaaaaaaaaaa.log`;
    write(`.v2/gate-logs/${oldName}`, `==> GATE PASS  aaaaaaaaaaaa  (9 s)  log /x/${oldName}\n`);
    const result = await readGates(targets({ libraryGateDirs: [path.join(root, '_output/epic-a/evidence/gates')], v2Dirs: [root] }), SINCE);
    expect(result.events).toEqual(expect.arrayContaining([
      { at: Date.parse(end), outcome: 'pass' },
      { at: Math.floor(NOW - 90 * 60_000), outcome: 'fail' },
    ]));
    expect(result.events).toHaveLength(2);
  });

  it('a finished gate log is never read again: no stat a minute per log on the mount (C1)', async () => {
    const dir = path.join(root, '_output/epic/evidence/gates');
    const file = write('_output/epic/evidence/gates/01-r1.log', `END=${new Date(NOW - HOUR).toISOString()}\nEXIT=0\nVERDICT=VALID\n`);
    expect((await readGates(targets({ libraryGateDirs: [dir] }), SINCE)).events).toEqual([expect.objectContaining({ outcome: 'pass' })]);
    // Rewritten in place: a second read would see RED. The cached verdict answers instead, so the log was not read.
    fs.writeFileSync(file, `END=${new Date(NOW - HOUR).toISOString()}\nEXIT=1\nVERDICT=RED\n`);
    expect((await readGates(targets({ libraryGateDirs: [dir] }), SINCE)).events).toEqual([expect.objectContaining({ outcome: 'pass' })]);
    clearVerdictCacheForTests();
    expect((await readGates(targets({ libraryGateDirs: [dir] }), SINCE)).events).toEqual([expect.objectContaining({ outcome: 'fail' })]);
  });

  it('reviews: v2 receipts and every *-out.md review record, rounds and confirmations (round 2, F6)', async () => {
    write('.v2/receipts/kit/abc.md', '# v2 review receipt\n', NOW - HOUR);
    write('.v2/receipts/kit/old.md', '# v2 review receipt\n', NOW - 30 * 24 * HOUR);
    write('_output/epic-a/reviews/03-x-confirm-out.md', 'CONFIRM', NOW - 2 * HOUR);
    write('_output/epic-a/reviews/03-x-r2-out.md', 'PASS-WITH-NITS', NOW - 3 * HOUR);
    write('_output/epic-a/reviews/03-worker-summary-r1.txt', 'summary', NOW - 2 * HOUR);
    const result = await readReviews(targets({ libraryReviewDirs: [path.join(root, '_output/epic-a/reviews')], v2Dirs: [root] }), SINCE);
    expect(result.events).toHaveLength(3);
  });

  it('v2 landings', async () => {
    const at = new Date(NOW - HOUR).toISOString().replace(/\.\d+Z$/, 'Z');
    write('.v2/landings.log', `2020-01-01T00:00:00Z\tLANDED\tkit\tx\n${at}\tLANDED\tE3\ty\n`);
    expect((await readLanded(targets({ v2Dirs: [root] }), SINCE)).events).toEqual([{ at: Date.parse(at) }]);
  });

  it('the verdict cache is an LRU bounded at 20,000 entries (round 2, F12)', async () => {
    clearVerdictCacheForTests();
    expect(VERDICT_CACHE_MAX).toBe(20_000);
    const dir = path.join(root, '_output/many/evidence/gates');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `g${i}.log`), 'EXIT=0\nVERDICT=VALID\n');
    await readGates(targets({ libraryGateDirs: [dir] }), SINCE);
    expect(verdictCacheSize()).toBe(30);
    clearVerdictCacheForTests();
    const entry = { size: 1, mtimeMs: 1, event: null };
    for (let i = 0; i < VERDICT_CACHE_MAX; i++) rememberVerdict(`/f${i}`, entry);
    rememberVerdict('/f0', entry);
    rememberVerdict('/new', entry);
    expect(verdictCacheSize()).toBe(VERDICT_CACHE_MAX);
    // /f0 was used again, so the oldest untouched entry, /f1, is the one evicted.
    expect([verdictCacheHas('/f0'), verdictCacheHas('/f1'), verdictCacheHas('/new')]).toEqual([true, false, true]);
    clearVerdictCacheForTests();
  });
});
