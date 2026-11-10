import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseEpicStatus, readEpicInfo, resolvePulseScope } from '@/lib/pulse-scope';
import type { IPulseEpicInfo, IPulseEpicLease, IPulseWorkspaceRef } from '@/lib/pulse-scope';
import { readCommits, readEpicCommits, readGates } from '@/lib/pulse-sources';

const HOUR = 3_600_000;
const NOW = Date.now();
const SINCE = NOW - 169 * HOUR;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

let root: string;
const at = (rel: string) => path.join(root, rel);
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text);
};
const gate = (rel: string) => write(rel, `END=${new Date(NOW - HOUR).toISOString()}\nEXIT=0\nVERDICT=VALID\n`);
const repo = (rel: string, branches: string[]) => {
  fs.mkdirSync(at(rel), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', at(rel), ...args], { env: gitEnv });
  git('init', '-q', '-b', 'main');
  // Messages name the repository: identical empty commits in the same second would share a sha across repos.
  git('commit', '-q', '--allow-empty', '-m', `${rel} main`);
  for (const branch of branches) {
    git('checkout', '-q', '-b', branch);
    git('commit', '-q', '--allow-empty', '-m', `${rel} ${branch}`);
  }
  git('checkout', '-q', 'main');
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-scope-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('epic status parse', () => {
  it('reads repos[] with their integration branch, the top-level keys and story repos', () => {
    const parsed = parseEpicStatus([
      'epic: harness-flow-loop',
      'integration_branch: feature/x  # planned',
      'repos:',
      '  - key: harness',
      '    path: /code/purplemux',
      '    integration_branch: feature/harness-flow-loop',
      '  - key: acme-ledger-v2',
      '    path: /code/acme-ledger-v2',
      '    delivery: "briefs only"',
      'stories:',
      '  - id: s1',
      '    repo: acme-ledger/acme-ledger-common',
      '  - id: s2',
      '    repo: "engineering"',
    ].join('\n'));
    expect(parsed).toEqual({
      epic: 'harness-flow-loop', integrationBranch: 'feature/x',
      repos: [{ path: '/code/purplemux', integrationBranch: 'feature/harness-flow-loop' }, { path: '/code/acme-ledger-v2', integrationBranch: null }],
      storyRepos: ['acme-ledger/acme-ledger-common', 'engineering'], storyBranches: ['story/s1', 'story/s2'],
    });
    expect(parseEpicStatus('stories:\n  - key: "01-a"\n    branch: story/01-baseline\n  - key: "02-b"\n').storyBranches)
      .toEqual(['story/01-baseline', 'story/02-b']);
    expect(parseEpicStatus('pull_requests:\n  - {repo: Acme/acme-ledger-common, number: 878, story: 24a-qa-hardening, base: main}\nstories:\n  - key: "24-qa-stop-archive"\n').storyBranches)
      .toEqual(['story/24a-qa-hardening', 'story/24-qa-stop-archive']);
  });
});

describe('pulse scope (round 2, F1): every movement event belongs to exactly one workspace', () => {
  const layout = async () => {
    repo('purplemux', ['feature/harness-flow-loop', 'story/12-owner-board', 'lane/noise']);
    repo('acme/engineering', ['feature/harness-flow-loop']);
    repo('acme/acme-ledger-v2', ['lane/E3']);
    repo('acme/acme-ledger/acme-ledger-common', ['feature/acme-ledger-v1-decommission']);
    write('acme/acme-ledger-v2/.v2/status.yaml', 'epic: acme-ledger-v2-mvp\nlanes: {}\n');
    gate('acme/acme-ledger-v2/.v2/gate-logs/ignored-name.log');
    write('acme/_output/harness-flow-loop/status.yaml', [
      'epic: harness-flow-loop', 'repos:',
      `  - path: ${at('purplemux')}`, '    integration_branch: feature/harness-flow-loop',
      `  - path: ${at('acme/engineering')}`, '    integration_branch: feature/harness-flow-loop',
      `  - path: ${at('acme/acme-ledger-v2')}`, '    delivery: briefs only',
      'stories:', '  - key: "12-owner-board"', '    repo: harness',
    ].join('\n'));
    write('acme/_output/acme-ledger-v1-decommission/status.yaml', 'epic: acme-ledger-v1-decommission\nintegration_branch: feature/acme-ledger-v1-decommission\nstories:\n  - id: s1\n    repo: acme-ledger/acme-ledger-common\n');
    write('acme/_output/acme-ledger-v1-decommission/stories/s1b.md', '# sub-story\n');
    gate('acme/_output/harness-flow-loop/evidence/gates/12-r1.log');
    gate('acme/_output/acme-ledger-v1-decommission/evidence/gates/01-r1.log');
    gate('acme/_output/unowned-epic/evidence/gates/01-r1.log');
    const workspaces: IPulseWorkspaceRef[] = [
      { id: 'ws-v2', name: 'Acme-ledger v2', directories: [at('acme/acme-ledger-v2')] },
      { id: 'ws-audit', name: 'Audit', directories: [at('acme/acme-ledger-v2'), at('acme'), at('purplemux')] },
      { id: 'ws-safe', name: 'SafeGuarding', directories: [at('acme')] },
      { id: 'ws-v1', name: 'V1 decommission', directories: [at('acme')] },
    ];
    const leases: IPulseEpicLease[] = [
      { slug: 'acme-ledger-v2-mvp', workspaceId: 'ws-v2' },
      { slug: 'harness-flow-loop', workspaceId: 'ws-audit' },
      { slug: 'acme-ledger-v1-decommission', workspaceId: 'ws-v1' },
    ];
    const all = workspaces.flatMap((workspace) => workspace.directories);
    const epics = new Map<string, IPulseEpicInfo>();
    for (const lease of leases) epics.set(lease.slug, await readEpicInfo(lease.slug, all));
    const v2 = new Set([at('acme/acme-ledger-v2')]);
    return { scope: (id: string) => resolvePulseScope(id, workspaces, leases, epics, v2) };
  };

  it('Audit, holding epic:harness-flow-loop, counts purplemux and engineering integration and story commits and its own gates, not acme-ledger-v2\'s', async () => {
    const { scope } = await layout();
    const audit = scope('ws-audit');
    expect(audit).toMatchObject({ basis: 'epic', epics: ['harness-flow-loop'], shared: [] });
    expect(audit.own.repos.map((r) => r.dir)).toEqual([at('purplemux'), at('acme/engineering')]);
    expect(audit.own.repos[0]).toEqual({ dir: at('purplemux'), refs: ['refs/heads/feature/harness-flow-loop'], storyRefs: ['refs/heads/story/12-owner-board'] });
    expect(audit.own.v2Dirs).toEqual([]);
    // main is not the epic's: purplemux feature + story, engineering feature; the lane branch never counts.
    expect((await readCommits(audit.own.repos, SINCE)).events).toHaveLength(5);
    const gates = await readGates(audit.own, SINCE);
    expect(gates.events).toHaveLength(1);
    expect(gates.from).toEqual([at('acme/_output/harness-flow-loop/evidence/gates')]);
  });

  it('two workspaces share one _output: each epic\'s gate counts only for its holder', async () => {
    const { scope } = await layout();
    const v1 = scope('ws-v1');
    expect((await readGates(v1.own, SINCE)).from).toEqual([at('acme/_output/acme-ledger-v1-decommission/evidence/gates')]);
    expect(v1.own.repos).toEqual([{ dir: at('acme/acme-ledger/acme-ledger-common'), refs: ['refs/heads/feature/acme-ledger-v1-decommission'], storyRefs: ['refs/heads/story/s1', 'refs/heads/story/s1b'] }]);
    expect(v1.rivals.map((rival) => rival.name).sort()).toEqual(['Acme-ledger v2', 'Audit']);
    const v2 = scope('ws-v2');
    expect(v2.own).toMatchObject({ v2Dirs: [at('acme/acme-ledger-v2')], repos: [{ dir: at('acme/acme-ledger-v2'), refs: ['refs/heads/main'], storyRefs: [] }] });
  });

  it('a directory shared without a lease is labelled shared and never counted; its _output/* is never scanned (C1)', async () => {
    const { scope } = await layout();
    const safe = scope('ws-safe');
    expect(safe.basis).toBe('directories');
    expect(safe.own).toMatchObject({ repos: [], libraryGateDirs: [], libraryReviewDirs: [], v2Dirs: [] });
    expect(safe.shared).toHaveLength(1);
    expect(safe.shared[0].with).toEqual(['Audit', 'V1 decommission']);
    // Only the repository of the directory itself; not one of the unowned epics under its _output.
    expect(safe.shared[0].targets).toEqual({ repos: [{ dir: at('acme'), refs: ['refs/heads/main', 'refs/heads/master', 'refs/heads/feature'] }],
      libraryGateDirs: [], libraryReviewDirs: [], v2Dirs: [] });
    expect((await readGates(safe.shared[0].targets, SINCE)).events).toBeNull();
  });

  it('two leased epics share one repository: each story-branch commit counts only for its epic; a commit on both integration branches counts once, for neither (round 3, F1)', async () => {
    fs.mkdirSync(at('shared'));
    const git = (...args: string[]) => execFileSync('git', ['-C', at('shared'), ...args], { env: gitEnv });
    const commit = (message: string) => git('commit', '-q', '--allow-empty', '-m', message);
    git('init', '-q', '-b', 'main');
    commit('c0 base');
    git('checkout', '-q', '-b', 'feature/a'); commit('a integration');
    git('checkout', '-q', '-b', 'story/a1'); commit('a1 story');
    git('checkout', '-q', 'feature/a'); git('merge', '-q', '--ff-only', 'story/a1');
    git('checkout', '-q', 'main'); git('checkout', '-q', '-b', 'feature/b'); commit('b integration');
    git('checkout', '-q', '-b', 'story/b1'); commit('b1 story');
    git('checkout', '-q', 'feature/b'); git('merge', '-q', '--ff-only', 'story/b1');
    git('checkout', '-q', 'main'); commit('m on main');
    git('checkout', '-q', 'feature/a'); git('merge', '-q', '--no-ff', 'main', '-m', 'merge main into a');
    git('checkout', '-q', 'feature/b'); git('merge', '-q', '--no-ff', 'main', '-m', 'merge main into b');
    git('merge', '-q', '--no-ff', 'story/a1', '-m', 'merge a1 into b');
    git('checkout', '-q', 'main');
    const epicA = [{ dir: at('shared'), refs: ['refs/heads/feature/a'], storyRefs: ['refs/heads/story/a1'] }];
    const epicB = [{ dir: at('shared'), refs: ['refs/heads/feature/b'], storyRefs: ['refs/heads/story/b1'] }];
    const [ownA, ...sharedA] = await readEpicCommits(epicA, [{ name: 'Workspace B', repos: epicB }], SINCE);
    const [ownB, ...sharedB] = await readEpicCommits(epicB, [{ name: 'Workspace A', repos: epicA }], SINCE);
    // A: its integration commit, a1 (on its story branch, though B merged it) and its merge of main.
    expect(ownA.events).toHaveLength(3);
    // B: its integration commit, b1, its merge of main and its merge of a1; never a1 itself.
    expect(ownB.events).toHaveLength(4);
    // c0 and m sit on both integration branches (c0 on both story branches too): neither epic's, shown once as shared.
    expect(sharedA).toEqual([expect.objectContaining({ id: 'commits', sharedWith: ['Workspace B'] })]);
    expect(sharedA[0].events).toHaveLength(2);
    // B also reaches a1 and its ancestor 'a integration' through its merge of story/a1: A's story commits, shown to B
    // as shared (c0, m and those two), counted only for A.
    expect(sharedB[0]).toMatchObject({ sharedWith: ['Workspace A'] });
    expect(sharedB[0].events).toHaveLength(4);
    // No rival on the repository: every commit the epic's refs reach is its own.
    expect((await readEpicCommits(epicA, [], SINCE))).toEqual([expect.objectContaining({ id: 'commits' })]);
    expect((await readEpicCommits(epicA, [], SINCE))[0].events).toHaveLength(5);
  });
});

