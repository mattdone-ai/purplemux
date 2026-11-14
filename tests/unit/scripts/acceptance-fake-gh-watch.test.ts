import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import { renderInboxLine } from '@/lib/inbox-templates';
import { WatchManager, runGhDefault, type IWatchDeps } from '@/lib/watch-manager';
import type { IInboxItem } from '@/types/inbox';
import type { IWatchesState } from '@/types/watch';

// PMUX-ACC-GRAPHQL: the deploy acceptance gate's fake gh and its wave-3 watch fixtures, driven by the server's REAL
// reads: WatchManager over runGhDefault (`gh api -i graphql …`, gh-api.ts's parse). #85 moved the watch reads to
// GraphQL while the fake answered REST only; `make precommit` stayed green and the gate failed 4 watch checks at deploy.
// This runs in the unit suite in about a second, so that drift fails here first.

const ROOT = path.resolve(__dirname, '../../..');
const wave3 = createRequire(import.meta.url)(path.join(ROOT, 'scripts/acceptance/checks-wave3.cjs'));
const REPO = 'acc-org/acc-test';
const MIN = 60_000;
const owner = { scope: {}, workspaceId: 'ws-a', tabId: 'tab-o', tabName: 'owner', verified: true, admin: false } as unknown as ICaller;

describe('the acceptance fake gh answers the server\'s own GraphQL watch reads', () => {
  let dir: string;
  let savedPath: string | undefined;
  let now: number;
  let state: IWatchesState;
  let sent: Array<IEnqueueRequest<'watch'> & { line: string }>;
  let m: WatchManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-acc-fake-gh-'));
    fs.mkdirSync(path.join(dir, 'bin'));
    savedPath = process.env.PATH;
    process.env.PATH = `${path.join(dir, 'bin')}:${savedPath}`;
    const gh = wave3.installFakeGh(dir);
    // The wave-3 fixtures, from the same function the gate calls.
    wave3.writeWatchFixtures(gh, REPO);
    now = Date.now();
    state = { watches: [] };
    sent = [];
    let seq = 0;
    const deps: IWatchDeps = {
      now: () => now,
      newId: () => `w-acc${++seq}`,
      runGh: runGhDefault,
      leaseFree: async () => false,
      ssoToken: async () => ({ state: 'absent' }),
      ssoProfile: async () => null,
      tabHost: async () => ({ known: true, host: null }),
      hostName: () => 'host-a',
      liveTabs: async () => ({ tabs: [{ workspaceId: 'ws-a', tabId: 'tab-o' }], uncertainWorkspaceIds: new Set() }),
      enqueue: async (req) => {
        sent.push({ ...req, line: renderInboxLine('watch', req.fields).line });
        return { item: { id: `i-${sent.length}` } as IInboxItem };
      },
      read: async () => state,
      mutate: async (fn) => {
        const r = await fn(state);
        state = r.state;
        return r.value;
      },
    };
    m = new WatchManager(deps);
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the 3 fixture watches and refuses the PR gh cannot find, as watch-create expects', async () => {
    await expect(m.create(owner, { kind: 'pr', target: `${REPO}#1`, until: 'merged', intervalS: 60 })).resolves.toMatchObject({ baseline: wave3.SHA_A });
    await expect(m.create(owner, { kind: 'pr', target: `${REPO}#2`, until: 'head-moved', intervalS: 60 })).resolves.toMatchObject({ baseline: wave3.SHA_A });
    await expect(m.create(owner, { kind: 'pr', target: `${REPO}#3`, until: 'checks-settled', intervalS: 60 })).resolves.toMatchObject({ baseline: wave3.SHA_C });
    await expect(m.create(owner, { kind: 'pr', target: `${REPO}#404`, until: 'merged', intervalS: 60 })).rejects.toMatchObject({ code: 'watch-invalid' });
  });

  it('fires the lines watch-merged, watch-head-moved and watch-checks-settled wait for', async () => {
    await m.create(owner, { kind: 'pr', target: `${REPO}#1`, until: 'merged', intervalS: 60 });
    await m.create(owner, { kind: 'pr', target: `${REPO}#2`, until: 'head-moved', intervalS: 60 });
    await m.create(owner, { kind: 'pr', target: `${REPO}#3`, until: 'checks-settled', intervalS: 60 });
    await m.tick();
    now += MIN + 1;
    await m.tick();
    const judged = (target: string, text: string) => sent.some((s) => wave3.judgeWatchLine(s.line, target, text).ok);
    expect(judged(`${REPO}#1`, 'is MERGED (aaaaaaaa)')).toBe(true);
    expect(judged(`${REPO}#2`, 'head moved aaaaaaaa -> bbbbbbbb')).toBe(true);
    expect(judged(`${REPO}#3`, 'checks settled at cccccccc: 3 green, 1 red')).toBe(true);
    expect(state.watches).toEqual([]);
  });

  it('prints what gh api -i prints: a status line, the rate-limit headers and Date, then the body', async () => {
    const { runGhApi } = await import('@/lib/gh-api');
    const r = await runGhApi(['api', 'graphql', '-f', 'query=q', '-f', 'owner=acc-org', '-f', 'name=acc-test', '-F', 'number=1']);
    expect(r).toMatchObject({ ok: true, rate: { resource: 'graphql', limit: 5000, remaining: 4999 } });
    expect(JSON.parse((r as { stdout: string }).stdout).data.repository.pullRequest.headRefOid).toBe(wave3.SHA_A);
  });
});
