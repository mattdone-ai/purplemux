import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GIT_FACTS_SCRIPT,
  buildCheckpoint,
  checkpointDigest,
  checkpointId,
  compareFacts,
  firstMessageWithNotice,
  parseGitFacts,
  rotationCoverage,
  sha256,
} from '@/lib/rotation-checkpoint';
import { handoffFields } from '@/lib/handoff-check';
import type { ILedgerItem, TLedgerAttrValue } from '@/types/ledger';
import type { IGitFacts } from '@/types/rotation-checkpoint';

// vel-D5 AC2, AC4, AC6: the checkpoint's fields, the git probe, the resume comparison, the restore notice, coverage.

const HANDOFF = [
  '# Handoff: kit · updated 2026-11-08T10:00:00Z', '',
  '## Role', '/v2-lane kit', 'Lane worker for story 7.', '',
  '## In flight',
  '| item key | state | next action | waiting on |',
  '| --- | --- | --- | --- |',
  '| story-7 | reviewed | fix 2 findings | none |',
  '| gate:story-7 | green | none | none |', '',
  '## Open questions', '- MC-102 — rename the column?', '- `MC-103`: owner call on the cap', '',
  '## Standing rules', '- Land through tools/land.sh only. (source: DEC-58)', '- Pin gh writes. (source: lane ledger ORCH-1 2026-11-03T02:58:09Z)', '',
  '## Decisions in the last 24 h', '- Kept the old index (DEC-61).', '',
  '## Do not', '- Retry the flaky gate unchanged: it failed twice on the same seed.', '',
  '## Resume command', '/implement story-7 --fix-findings', '',
].join('\n');

const FACTS: IGitFacts = {
  kind: 'ok', cwd: '/srv/wt', worktree: '/srv/wt', branch: 'story/7', head: 'a'.repeat(40), baseRef: 'origin/main', base: 'b'.repeat(40), dirty: 1,
};

const checkpoint = (overrides: Partial<Parameters<typeof buildCheckpoint>[0]> = {}) => buildCheckpoint({
  taskId: 'seat:ws-a:kit', attempt: 3, workspaceId: 'ws-a', tabId: 'tab-kit', tabName: 'kit', host: 'host-b', createdAt: 1_000,
  handoffPath: '/srv/wt/.v2/seats/kit/handoff.md', handoffText: HANDOFF, facts: FACTS, sessionBefore: 'sess-1', ...overrides,
});

describe('the checkpoint (AC2)', () => {
  it('reads the agent fields from the checked handoff sections', () => {
    expect(handoffFields(HANDOFF)).toEqual({
      role: ['/v2-lane kit', 'Lane worker for story 7.'],
      inFlight: [
        { itemKey: 'story-7', state: 'reviewed', nextAction: 'fix 2 findings', waitingOn: 'none' },
        { itemKey: 'gate:story-7', state: 'green', nextAction: 'none', waitingOn: 'none' },
      ],
      openQuestions: ['MC-102', 'MC-103'],
      standingRuleSources: ['DEC-58', 'lane ledger ORCH-1 2026-11-03T02:58:09Z'],
      decisions: ['Kept the old index (DEC-61).'],
      doNot: ['Retry the flaky gate unchanged: it failed twice on the same seed.'],
      resumeCommand: '/implement story-7 --fix-findings',
    });
    const none = HANDOFF.replace(/## In flight\n[\s\S]*?\n\n/, '## In flight\nnone\n\n').replace(/## Open questions\n[\s\S]*?\n\n/, '## Open questions\nnone\n\n');
    expect(handoffFields(none)).toMatchObject({ inFlight: [], openQuestions: [] });
  });

  it('carries the task, the attempt, the tool facts and the agent fields; its key names no session or account', () => {
    const cp = checkpoint();
    expect(cp).toMatchObject({
      id: 'seat:ws-a:kit#3', taskId: 'seat:ws-a:kit', attempt: 3, host: 'host-b', facts: FACTS,
      intendedNextAction: '/implement story-7 --fix-findings', outstandingDecisionIds: ['MC-102', 'MC-103'],
      failedApproaches: ['Retry the flaky gate unchanged: it failed twice on the same seed.'],
      evidenceRefs: ['DEC-58', 'lane ledger ORCH-1 2026-11-03T02:58:09Z'], rationale: ['Kept the old index (DEC-61).'],
      handoffDigest: sha256(HANDOFF), handoffText: HANDOFF, sessionBefore: 'sess-1',
    });
    expect(checkpointId('seat:ws-a:kit', 3)).toBe(cp.id);
    expect(cp.id).not.toContain('sess-1');
  });

  it('a digest depends on the content, never on the order the keys were built in', () => {
    const cp = checkpoint();
    const reordered = Object.fromEntries(Object.entries(cp).reverse()) as typeof cp;
    expect(checkpointDigest(reordered)).toBe(checkpointDigest(cp));
    expect(checkpointDigest(checkpoint({ attempt: 4 }))).not.toBe(checkpointDigest(cp));
    expect(checkpointDigest({ ...cp, facts: { ...FACTS, head: 'c'.repeat(40) } })).not.toBe(checkpointDigest(cp));
  });
});

describe('the git probe', () => {
  let root = '';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf-8' }).trim();
  const probe = (cwd: string, expected = '') => parseGitFacts(execFileSync('sh', ['-c', GIT_FACTS_SCRIPT, 'sh', cwd, expected], { encoding: 'utf-8' }), cwd);

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-gitfacts-'));
    const origin = path.join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = path.join(root, 'seed');
    git(root, 'clone', '-q', origin, seed);
    fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
    git(seed, 'add', 'a.txt');
    git(seed, 'commit', '-q', '-m', 'a');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    git(root, 'clone', '-q', origin, path.join(root, 'wt'));
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('reads the worktree, branch, head, base and dirty count from git', () => {
    const wt = path.join(root, 'wt');
    git(wt, 'checkout', '-q', '-b', 'story/7');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    git(wt, 'add', 'b.txt');
    git(wt, 'commit', '-q', '-m', 'b');
    fs.writeFileSync(path.join(wt, 'dirty.txt'), 'x\n');
    const facts = probe(wt);
    const main = git(wt, 'rev-parse', 'origin/main');
    expect(facts).toEqual({
      kind: 'ok', cwd: fs.realpathSync(wt), worktree: fs.realpathSync(wt), branch: 'story/7', head: git(wt, 'rev-parse', 'HEAD'),
      baseRef: 'origin/main', base: main, dirty: 1,
    });
    fs.rmSync(path.join(wt, 'dirty.txt'));
  });

  it('tells a head that moved on from one that was rewritten', () => {
    const wt = path.join(root, 'wt');
    const before = git(wt, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(wt, 'c.txt'), 'c\n');
    git(wt, 'add', 'c.txt');
    git(wt, 'commit', '-q', '-m', 'c');
    expect(probe(wt, before).containsExpected).toBe(true);
    git(wt, 'reset', '-q', '--hard', 'origin/main');
    expect(probe(wt, before).containsExpected).toBe(false);
  });

  it('the server\'s own checkpoint copy beside a tracked handoff is no uncommitted file', () => {
    const wt = path.join(root, 'wt');
    fs.mkdirSync(path.join(wt, 'seats'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'seats', 'handoff.md'), 'h\n');
    git(wt, 'add', 'seats/handoff.md');
    git(wt, 'commit', '-q', '-m', 'handoff');
    const before = probe(wt).dirty;
    fs.writeFileSync(path.join(wt, 'seats', 'handoff.md.checkpoint.json'), '{}\n');
    expect(probe(wt).dirty).toBe(before);
    fs.writeFileSync(path.join(wt, 'seats', 'notes.txt'), 'n\n');
    expect(probe(wt).dirty).toBe((before ?? 0) + 1);
    fs.rmSync(path.join(wt, 'seats', 'notes.txt'));
  });

  it('review r1 F5: a checkpoint copy under a path with a space is left out too, from a subdirectory as well', () => {
    const wt = path.join(root, 'wt');
    const dir = path.join(wt, 'my seats', 'kit one');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'handoff.md'), 'h\n');
    git(wt, 'add', '--', 'my seats/kit one/handoff.md');
    git(wt, 'commit', '-q', '-m', 'spaced handoff');
    const before = probe(wt).dirty;
    fs.writeFileSync(path.join(dir, 'handoff.md.checkpoint.json'), '{}\n');
    expect(probe(wt).dirty).toBe(before);
    expect(probe(dir).dirty).toBe(before);
    fs.writeFileSync(path.join(dir, 'notes two.txt'), 'n\n');
    expect(probe(dir).dirty).toBe((before ?? 0) + 1);
    fs.rmSync(path.join(dir, 'notes two.txt'));
  });

  it('review r2 N3: a git status that fails gives a dirty count that is not measured, never 0', () => {
    const broken = path.join(root, 'broken');
    git(root, 'clone', '-q', path.join(root, 'origin.git'), broken);
    expect(probe(broken).dirty).toBe(0);
    fs.writeFileSync(path.join(broken, '.git', 'index'), 'not an index');
    expect(() => execFileSync('git', ['status', '--porcelain'], { cwd: broken, stdio: 'pipe' })).toThrow();
    const facts = probe(broken);
    expect(facts).toMatchObject({ kind: 'ok', dirty: null });
    expect(compareFacts({ ...facts, dirty: 0 }, facts)).toEqual(['uncommitted files 0 → not measured']);
    expect(parseGitFacts('kind\tok\nworktree\t/w\ndirty\t?\n', null).dirty).toBeNull();
  });

  it('a directory outside git and a missing directory are answers, not failures', () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(probe(plain)).toMatchObject({ kind: 'no-repo', cwd: fs.realpathSync(plain), head: null });
    expect(probe(path.join(root, 'gone'))).toMatchObject({ kind: 'no-cwd', cwd: path.join(root, 'gone') });
    expect(probe('')).toMatchObject({ kind: 'no-cwd', cwd: '' });
  });

  it('parses only what it knows; an unknown kind is no directory', () => {
    expect(parseGitFacts('garbage\n', '/x')).toMatchObject({ kind: 'no-cwd', cwd: '/x', dirty: null });
    expect(parseGitFacts('kind\tok\nworktree\t/w\ndirty\tmany\n', null)).toMatchObject({ kind: 'ok', worktree: '/w', dirty: null, branch: null });
  });
});

describe('the resume comparison (AC4)', () => {
  it('a match has no difference', () => {
    expect(compareFacts(FACTS, { ...FACTS, containsExpected: true })).toEqual([]);
  });

  it('names each difference, and tells a head that moved on from a rewritten one', () => {
    const moved = compareFacts(FACTS, { ...FACTS, head: 'c'.repeat(40), containsExpected: true });
    expect(moved).toEqual([`head moved on ${'a'.repeat(12)} → ${'c'.repeat(12)} (${'a'.repeat(12)} is in its history)`]);
    expect(compareFacts(FACTS, { ...FACTS, head: 'c'.repeat(40), containsExpected: false })[0]).toContain('is not in its history (rewritten or reset)');
    expect(compareFacts(FACTS, { ...FACTS, head: 'c'.repeat(40) })[0]).toBe(`head ${'a'.repeat(12)} → ${'c'.repeat(12)}`);
    expect(compareFacts(FACTS, { ...FACTS, worktree: '/srv/other', branch: null, dirty: 0 })).toEqual([
      'worktree /srv/wt → /srv/other', 'branch story/7 → detached', 'uncommitted files 1 → 0',
    ]);
  });

  it('a worktree that is gone, or a plain directory that moved, is a difference', () => {
    expect(compareFacts(FACTS, { ...FACTS, kind: 'no-cwd', worktree: null, head: null })).toEqual([
      'the checkpoint saw worktree /srv/wt on branch story/7 at aaaaaaaaaaaa; now no directory at /srv/wt',
    ]);
    const plain: IGitFacts = { kind: 'no-repo', cwd: '/a', worktree: null, branch: null, head: null, baseRef: null, base: null, dirty: null };
    expect(compareFacts(plain, plain)).toEqual([]);
    expect(compareFacts(plain, { ...plain, cwd: '/b' })).toEqual(['directory /a → /b']);
  });
});

describe('the restore notice (AC4; coordinator input 2)', () => {
  it('a match keeps the ADR-0036 line first and says what is verified, covered and not restored', () => {
    const text = firstMessageWithNotice(checkpoint(), { differences: [], restored: false });
    expect(text).toBe('Read /srv/wt/.v2/seats/kit/handoff.md, then continue: /implement story-7 --fix-findings '
      + 'RESTORE NOTICE (checkpoint seat:ws-a:kit#3): verified worktree /srv/wt on branch story/7 at aaaaaaaaaaaa. '
      + 'It covers the handoff (resume command, 2 in-flight item(s), 2 open decision(s): MC-102, MC-103) and the git facts. '
      + 'Not restored: the earlier conversation, its shell cwd and environment, and its background jobs.');
  });

  it('a mismatch asks for reconciliation before the resume command, and says when the file was written back', () => {
    const text = firstMessageWithNotice(checkpoint(), { differences: ['branch story/7 → main', 'uncommitted files 1 → 0'], restored: true });
    expect(text).toBe('Read /srv/wt/.v2/seats/kit/handoff.md. RESTORE NOTICE (checkpoint seat:ws-a:kit#3): the worktree does not match '
      + 'the checkpoint: branch story/7 → main; uncommitted files 1 → 0. The handoff file was missing or changed; the server wrote it back '
      + 'from the checkpoint. Reconcile this before you continue: record in /srv/wt/.v2/seats/kit/handoff.md what changed and what you '
      + 'did about it, then continue: /implement story-7 --fix-findings It covers the handoff (resume command, 2 in-flight item(s), 2 open '
      + 'decision(s): MC-102, MC-103) and the git facts. Not restored: the earlier conversation, its shell cwd and environment, and its background jobs.');
    expect(text).not.toContain('then continue: /implement story-7 --fix-findings RESTORE');
  });

  it('is one line whatever a remote host names its branch', () => {
    const text = firstMessageWithNotice(checkpoint({ facts: { ...FACTS, branch: 'evil\nrm -rf /' } }), { differences: [], restored: false });
    expect(text).not.toMatch(/[\n\r]/);
  });
});

const seatItem = (key: string, state: string, attrs: Record<string, TLedgerAttrValue>, closedAt: number | null = null): ILedgerItem => ({
  workspaceId: 'ws-a', itemKey: key, itemType: 'seat', openedAt: 0, closedAt, state, stateSince: 0, waitReason: null, waitSince: null,
  holder: key.split(':')[2], clearInput: null, parentKey: null, attrs, lastEventAt: 0, lastSeq: 1,
});

describe('rotation coverage (AC6)', () => {
  it('counts covered workers, rotations, refusals and wait-to-rotate from the layouts and the seat items', () => {
    const tabs = [
      { workspaceId: 'ws-a', handoffPath: '/h/a.md', rotateAt: null },
      { workspaceId: 'ws-a', handoffPath: '/h/b.md', rotateAt: 'off' as const },
      { workspaceId: 'ws-a' },
      { workspaceId: 'ws-b', handoffPath: '/h/c.md', rotateAt: 120_000 },
    ];
    const items = [
      seatItem('seat:ws-a:a', 'watching', { rotations: 3, handoffRefusals: 1, checkpointRefusals: 0, rotationTimeouts: 1, waitToRotateTotalMs: 90_000, waitToRotateCount: 3, lastWaitToRotateMs: 20_000 }),
      seatItem('seat:ws-a:c', 'handoff-ready', { rotations: 1, checkpointRefusals: 2, checkpointRefused: 'checkpoint seat:ws-a:c#2 is not durable: disk full', rotationDueAt: 400_000, waitToRotateTotalMs: 30_000, waitToRotateCount: 1 }),
      seatItem('seat:ws-a:gone', 'watching', { rotations: 9 }, 5),
      seatItem('seat:ws-a:busy', 'watching', { rotationDueAt: 900_000 }),
    ];
    const coverage = rotationCoverage(tabs, items, 1_000_000);
    // Review r1 F8: the closed seat's 9 rotations count; its row is not listed.
    expect(coverage).toMatchObject({
      workers: 4, covered: 2, coverage: 0.5, rotations: 13, handoffRefusals: 1, checkpointRefusals: 2, rotationTimeouts: 1,
      waitToRotateTotalMs: 120_000, waitToRotateMeanMs: 30_000,
    });
    expect(coverage.seats.map((s) => [s.itemKey, s.waitingMs, s.checkpointRefused])).toEqual([
      ['seat:ws-a:a', null, null],
      ['seat:ws-a:busy', 100_000, null],
      ['seat:ws-a:c', 600_000, 'checkpoint seat:ws-a:c#2 is not durable: disk full'],
    ]);
  });

  it('with no worker the coverage is unknown, not zero', () => {
    expect(rotationCoverage([], [], 0)).toMatchObject({ workers: 0, covered: 0, coverage: null, waitToRotateMeanMs: null });
  });

  it('review r1 F8: a counter no seat item wrote is not measured (null), never 0', () => {
    const coverage = rotationCoverage([{ workspaceId: 'ws-a', handoffPath: '/h/a.md' }], [seatItem('seat:ws-a:a', 'watching', { rotations: 2 })], 0);
    expect(coverage).toMatchObject({
      rotations: 2, handoffRefusals: null, checkpointRefusals: null, rotationTimeouts: null, waitToRotateTotalMs: null, waitToRotateMeanMs: null,
    });
    expect(coverage.seats[0]).toMatchObject({ rotations: 2, handoffRefusals: null, checkpointRefusals: null, rotationTimeouts: null });
    expect(rotationCoverage([], [seatItem('seat:ws-a:a', 'watching', { checkpointRefusals: 0 })], 0).checkpointRefusals).toBe(0);
  });
});
