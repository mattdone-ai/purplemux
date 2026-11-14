import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import { renderInboxLine } from '@/lib/inbox-templates';
import { RESUME_MARGIN_MS, RESUME_STAGGER_MS, WatchManager, classifyGhError, settleChecks, type IWatchDeps, type TGhResult } from '@/lib/watch-manager';
import { WATCH_DEFAULT_TTL_S, WATCH_GITHUB_CAP, WATCH_TAB_CAP, WatchError, checkSpec, isDue } from '@/lib/watch-store';
import type { IInboxItem } from '@/types/inbox';
import type { IWatchesState } from '@/types/watch';

const logs = vi.hoisted(() => ({ warn: [] as string[] }));
vi.mock('@/lib/logger', () => {
  const logger = {
    trace: () => {}, debug: () => {}, info: () => {}, error: () => {}, fatal: () => {},
    warn: (...args: unknown[]) => { logs.warn.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); },
    child: () => logger,
  };
  return { createLogger: () => logger };
});

const T0 = Date.UTC(2026, 8, 26, 12, 0, 0);
const MIN = 60_000;
const SHA_A = 'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa';
const SHA_B = 'bbbbbbbb22222222bbbbbbbb22222222bbbbbbbb';

const caller = (workspaceId: string | null, tabId: string | null, admin = false): ICaller =>
  ({ scope: {}, workspaceId, tabId, tabName: tabId, verified: true, admin } as unknown as ICaller);
const B = caller('ws-b', 'tab-b');
const LEGACY = { ...caller('ws-b', 'tab-b'), verified: false } as ICaller;
const ADMIN = caller(null, null, true);

/** A fake gh keyed by the api path; each answer is a queue, the last one repeats. */
class Fakes {
  now = T0;
  state: IWatchesState = { watches: [] };
  sent: Array<IEnqueueRequest<'watch'> & { line: string }> = [];
  gh = new Map<string, TGhResult[]>();
  ghCalls: string[][] = [];
  freeLeases = new Set<string>();
  live = new Set(['ws-a/tab-a', 'ws-b/tab-b']);
  uncertain = new Set<string>();
  private seq = 0;

  answer(pathPart: string, ...results: TGhResult[]) {
    this.gh.set(pathPart, results);
  }

  /**
   * A pull request as the GraphQL read answers it (PMUX-WATCH-403): `state` is the REST word (open, closed), and a
   * merged PR reads MERGED. `checks` is the head's rollup: check runs as [status, conclusion], commit statuses, and
   * `next` a cursor when another page follows; `oid` is the commit the rollup belongs to (the head by default).
   */
  pull(merged: boolean, state: string, head: string, checks?: { runs?: Array<[string, string | null]>; statuses?: string[]; next?: string; oid?: string }): TGhResult {
    const nodes = [
      ...(checks?.runs ?? []).map(([status, conclusion]) => ({ __typename: 'CheckRun', status, conclusion })),
      ...(checks?.statuses ?? []).map((st) => ({ __typename: 'StatusContext', state: st })),
    ];
    const rollup = checks ? { contexts: { pageInfo: { hasNextPage: checks.next !== undefined, endCursor: checks.next ?? null }, nodes } } : null;
    return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: {
      merged, state: merged ? 'MERGED' : state.toUpperCase(), headRefOid: head,
      commits: { nodes: [{ commit: { oid: checks?.oid ?? head, statusCheckRollup: rollup } }] },
    } } } }) };
  }

  /** A ref's commit as the GraphQL read answers it. */
  ref(sha: string): TGhResult {
    return { ok: true, stdout: JSON.stringify({ data: { repository: { object: { __typename: 'Commit', oid: sha } } } }) };
  }

  deps(): IWatchDeps {
    return {
      now: () => this.now,
      newId: () => `w-test${++this.seq}`,
      runGh: async (args) => {
        this.ghCalls.push(args);
        const key = [...this.gh.keys()].find((k) => args.some((a) => a.includes(k)));
        if (!key) return { ok: false, code: 'other', message: `no fake for ${args.join(' ')}` };
        const queue = this.gh.get(key)!;
        return queue.length > 1 ? queue.shift()! : queue[0];
      },
      leaseFree: async (name) => this.freeLeases.has(name),
      ssoToken: async () => ({ state: 'absent' }),
      ssoProfile: async () => null,
      tabHost: async () => ({ known: true, host: null }),
      hostName: () => 'host-a',
      liveTabs: async () => ({
        tabs: [...this.live].map((k) => ({ workspaceId: k.split('/')[0], tabId: k.split('/')[1] })),
        uncertainWorkspaceIds: new Set(this.uncertain),
      }),
      enqueue: async (req) => {
        this.sent.push({ ...req, line: renderInboxLine('watch', req.fields).line });
        return { item: { id: `i-${this.sent.length}` } as IInboxItem };
      },
      read: async () => this.state,
      mutate: async (fn) => {
        const { state, value } = await fn(this.state);
        this.state = state;
        return value;
      },
    };
  }
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'none';
  } catch (err) {
    return err instanceof WatchError ? err.code : `not a WatchError: ${String(err)}`;
  }
};

describe('harness watches (ADR-0015)', () => {
  let f: Fakes;
  let m: WatchManager;
  beforeEach(() => {
    f = new Fakes();
    m = new WatchManager(f.deps());
  });

  const tickAt = async (minutes: number) => {
    f.now += minutes * MIN;
    await m.tick();
  };

  it('records how the owner was named beside verified (story 36)', async () => {
    const hook = await m.create({ ...B, verified: false, identity: 'hook' } as ICaller, { kind: 'lease', target: 'merge:acme/x', until: 'free' });
    expect(hook).toMatchObject({ verified: false, identity: 'hook' });
  });

  it('merged false then true: exactly one notice reaches the owner tab and the watch is gone', async () => {
    f.answer('number=517', f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_A), f.pull(true, 'closed', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'Acme/acme-ledger-ui#517', until: 'merged' });
    expect(w).toMatchObject({ baseline: SHA_A, workspaceId: 'ws-b', tabId: 'tab-b', intervalS: 120, verified: true, lastCheckedAt: T0 });
    await m.tick();
    await tickAt(1); // the baseline read at creation was the first check: nothing due yet
    expect(f.ghCalls).toHaveLength(1);
    await tickAt(2);
    expect(f.sent).toEqual([]);
    expect(f.ghCalls).toHaveLength(2);
    await tickAt(2);
    expect(f.sent.map((s) => [s.targetWorkspaceId, s.targetTabId, s.line])).toEqual([
      ['ws-b', 'tab-b', `[purplemux watch ${w.id}] Acme/acme-ledger-ui#517 is MERGED (aaaaaaaa) — watch cleared`],
    ]);
    expect(f.state.watches).toEqual([]);
    await tickAt(5);
    expect(f.sent).toHaveLength(1);
  });

  it('closed reports MERGED when it merged and CLOSED when it did not', async () => {
    f.answer('number=1', f.pull(false, 'open', SHA_A), f.pull(false, 'closed', SHA_A));
    f.answer('number=2', f.pull(false, 'open', SHA_A), f.pull(true, 'closed', SHA_B));
    await m.create(B, { kind: 'pr', target: 'o/r#1', until: 'closed' });
    await m.create(B, { kind: 'pr', target: 'o/r#2', until: 'closed' });
    await tickAt(2);
    expect(f.sent.map((x) => x.line)).toEqual([
      expect.stringContaining('o/r#1 is CLOSED without a merge (aaaaaaaa)'),
      expect.stringContaining('o/r#2 is MERGED (bbbbbbbb)'),
    ]);
  });

  it('a merged watch on a PR closed without a merge reports CLOSED instead of waiting for expiry', async () => {
    f.answer('number=4', f.pull(false, 'open', SHA_A), f.pull(false, 'closed', SHA_A));
    await m.create(B, { kind: 'pr', target: 'o/r#4', until: 'merged' });
    await tickAt(2);
    expect(f.sent.map((x) => x.line)).toEqual([expect.stringContaining('o/r#4 is CLOSED without a merge')]);
    expect(f.state.watches).toEqual([]);
  });

  it('head-moved carries the old and the new sha', async () => {
    f.answer('number=9', f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_B));
    await m.create(B, { kind: 'pr', target: 'o/r#9', until: 'head-moved' });
    await tickAt(2);
    expect(f.sent).toEqual([]);
    await tickAt(2);
    expect(f.sent.map((s) => s.line)).toEqual([expect.stringContaining('o/r#9 head moved aaaaaaaa -> bbbbbbbb — watch cleared')]);
  });

  it('checks-settled: no notice while a check is pending; one with green/red counts once it completes', async () => {
    f.answer('number=5', f.pull(false, 'open', SHA_A),
      f.pull(false, 'open', SHA_A, { runs: [['COMPLETED', 'SUCCESS'], ['IN_PROGRESS', null]], statuses: ['SUCCESS'] }),
      f.pull(false, 'open', SHA_A, { runs: [['COMPLETED', 'SUCCESS'], ['COMPLETED', 'FAILURE'], ['COMPLETED', 'SKIPPED']], statuses: ['SUCCESS'] }));
    await m.create(B, { kind: 'pr', target: 'o/r#5', until: 'checks-settled' });
    await tickAt(2);
    expect(f.sent).toEqual([]);
    // One GraphQL read per check: the state, the head and the checks together, no REST read.
    expect(f.ghCalls).toHaveLength(2);
    expect(f.ghCalls.every((c) => c[0] === 'api' && c[1] === 'graphql')).toBe(true);
    await tickAt(2);
    expect(f.sent.map((s) => s.line)).toEqual([expect.stringContaining('o/r#5 checks settled at aaaaaaaa: 3 green, 1 red — watch cleared')]);
  });

  it('does not emit settled-check proof if the PR head changes between check pages', async () => {
    const green = { runs: [['COMPLETED', 'SUCCESS']] as Array<[string, string]>, statuses: ['SUCCESS'] };
    f.answer('number=51', f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_A, { ...green, next: 'page-2' }),
      f.pull(false, 'open', SHA_B, green), f.pull(false, 'open', SHA_B, green));
    await m.create(B, { kind: 'pr', target: 'o/r#51', until: 'checks-settled' });
    await tickAt(2);
    expect(f.sent).toEqual([]);
    expect(f.state.watches).toHaveLength(1);
    await tickAt(2);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].fields.sha).toBe(SHA_B);
  });

  it('waits when the rollup belongs to a commit that is not the head', async () => {
    f.answer('number=53', f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_A, { runs: [['COMPLETED', 'SUCCESS']], oid: SHA_B }));
    await m.create(B, { kind: 'pr', target: 'o/r#53', until: 'checks-settled' });
    await tickAt(2);
    expect(f.sent).toEqual([]);
    expect(f.state.watches).toHaveLength(1);
  });

  it('drops stale settled-check proof when the head changes after evaluation but before enqueue', async () => {
    f.answer('number=52', f.pull(false, 'open', SHA_A),
      f.pull(false, 'open', SHA_A, { runs: [['COMPLETED', 'SUCCESS']], statuses: ['SUCCESS'] }), f.pull(false, 'open', SHA_B));
    await m.create(B, { kind: 'pr', target: 'o/r#52', until: 'checks-settled' });
    await tickAt(2);
    expect(f.sent).toEqual([]);
    expect(f.state.watches[0].pendingNotice).toBeUndefined();
  });

  it('ref moved reports both shas', async () => {
    f.answer('expression=feature/x', f.ref(SHA_A), f.ref(SHA_B));
    await m.create(B, { kind: 'ref', target: 'o/r@feature/x', until: 'moved' });
    await tickAt(2);
    expect(f.sent[0].line).toContain('o/r@feature/x moved aaaaaaaa -> bbbbbbbb');
  });

  it('a lease watch fires on the release event of its own lease, and not on another lease', async () => {
    await m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free' });
    await m.tick('merge:p/q');
    f.freeLeases.add('merge:p/q');
    await m.tick('merge:p/q');
    expect(f.sent).toEqual([]);
    f.freeLeases.add('merge:x/y');
    await m.tick('merge:x/y');
    expect(f.sent.map((s) => s.line)).toEqual([expect.stringContaining('merge:x/y is free — watch cleared')]);
    expect(f.ghCalls).toEqual([]);
  });

  it('keeps a lease watch when it is reacquired between evaluation and notice routing', async () => {
    let checks = 0;
    let clearances = 0;
    const deps = f.deps();
    deps.leaseFree = async () => ++checks !== 2;
    deps.onFired = async () => { clearances++; };
    m = new WatchManager(deps);
    const watch = await m.create(B, { kind: 'lease', target: 'merge:race/release', until: 'free' });
    await m.tick('merge:race/release');
    expect(f.sent).toEqual([]);
    expect(clearances).toBe(0);
    expect(f.state.watches.map((entry) => entry.id)).toEqual([watch.id]);
    f.now += MIN;
    await m.tick('merge:race/release');
    expect(f.sent.map((entry) => entry.fields.notice)).toEqual(['free']);
    expect(clearances).toBe(1);
    expect(f.state.watches).toEqual([]);
  });

  it('three failures in a row send one failing notice with a server token; none again until it recovers and fails again', async () => {
    f.answer('number=7', f.pull(false, 'open', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'o/r#7', until: 'merged' });
    f.answer('number=7', { ok: false, code: 'http-403', message: 'HTTP 403: Resource not accessible by integration <script>' });
    // Reads back off (2x, 4x, 8x the interval): 20-minute steps pass every backed-off interval.
    for (let i = 0; i < 5; i++) await tickAt(20);
    expect(f.sent.map((s) => s.line)).toEqual([`[purplemux watch ${w.id}] o/r#7 is failing: http-403 — purplemux watch list shows the error; still trying until it expires`]);
    expect(f.state.watches[0]).toMatchObject({ failures: 5, lastError: { code: 'http-403', message: expect.stringContaining('not accessible') } });
    f.answer('number=7', f.pull(false, 'open', SHA_A));
    await tickAt(20);
    expect(f.state.watches[0]).toMatchObject({ failures: 0, failingNotified: false, lastError: null });
    f.answer('number=7', { ok: false, code: 'timeout', message: 'timed out' });
    for (let i = 0; i < 3; i++) await tickAt(20);
    expect(f.sent.map((s) => s.fields.code)).toEqual(['http-403', 'timeout']);
  });

  it('expires with one notice naming what it waited for', async () => {
    f.answer('number=3', f.pull(false, 'open', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'o/r#3', until: 'merged', ttlSeconds: 3600 });
    f.now = w.expiresAt;
    await m.tick();
    expect(f.sent.map((s) => s.line)).toEqual([`[purplemux watch ${w.id}] o/r#3 expired without merged — watch cleared`]);
    expect(f.state.watches).toEqual([]);
    expect(w.expiresAt - w.createdAt).toBe(3600_000);
    expect((await m.create(B, { kind: 'lease', target: 'merge:a/b', until: 'free' })).expiresAt - f.now).toBe(WATCH_DEFAULT_TTL_S * 1000);
  });

  it('the owner tab closing removes its watches; the boot pass drops watches of tabs confirmed gone', async () => {
    await m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free' });
    await m.create(caller('ws-a', 'tab-a'), { kind: 'lease', target: 'merge:x/y', until: 'free' });
    expect(await m.removeTab('ws-b', 'tab-b')).toBe(1);
    expect(f.state.watches.map((w) => w.tabId)).toEqual(['tab-a']);
    f.live.add('ws-c/tab-c');
    f.live.add('ws-d/tab-d');
    await m.create(caller('ws-c', 'tab-c'), { kind: 'lease', target: 'merge:x/y', until: 'free' });
    await m.create(caller('ws-d', 'tab-d'), { kind: 'lease', target: 'merge:x/y', until: 'free' });
    f.live.delete('ws-c/tab-c');
    f.live.delete('ws-d/tab-d');
    f.uncertain.add('ws-d');
    expect(await m.hydrate()).toBe(1);
    expect(f.state.watches.map((w) => w.tabId)).toEqual(['tab-a', 'tab-d']);
  });

  it('a tab that closes during creation gets no watch, and a watch that outlived its tab is swept by the next pass', async () => {
    const deps = f.deps();
    const closing = new WatchManager({
      ...deps,
      runGh: async (args) => {
        f.live.delete('ws-b/tab-b'); // closed during the baseline read; its removal found nothing
        return deps.runGh(args);
      },
    });
    f.answer('number=21', f.pull(false, 'open', SHA_A));
    expect(await code(closing.create(B, { kind: 'pr', target: 'o/r#21', until: 'merged' }))).toBe('caller-unresolved');
    expect(f.state.watches).toEqual([]);

    f.live.add('ws-b/tab-b');
    await m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free' });
    f.live.delete('ws-b/tab-b'); // the tab-closed removal failed or never ran
    await m.tick('merge:p/q'); // a release event for another lease: no sweep
    expect(f.state.watches).toHaveLength(1);
    await m.tick(); // the next full pass sweeps it
    expect(f.state.watches).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  it(`refuses the ${WATCH_GITHUB_CAP + 1}st GitHub watch on the host (watch-cap) but not a lease watch`, async () => {
    f.answer('number=', f.pull(false, 'open', SHA_A));
    for (let i = 0; i < WATCH_GITHUB_CAP; i++) {
      f.live.add(`ws-${i % 3}/tab-${i}`);
      await m.create(caller(`ws-${i % 3}`, `tab-${i}`), { kind: 'pr', target: `o/r#${i + 1}`, until: 'merged' });
    }
    const calls = f.ghCalls.length;
    expect(await code(m.create(B, { kind: 'pr', target: 'o/r#999', until: 'merged' }))).toBe('watch-cap');
    expect(f.ghCalls).toHaveLength(calls); // refused before the GitHub read
    expect(await code(m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free' }))).toBe('none');
  });

  it(`refuses a tab's ${WATCH_TAB_CAP + 1}st watch`, async () => {
    for (let i = 0; i < WATCH_TAB_CAP; i++) await m.create(B, { kind: 'lease', target: `merge:x/y${i}`, until: 'free' });
    expect(await code(m.create(B, { kind: 'lease', target: 'merge:x/z', until: 'free' }))).toBe('watch-cap');
  });

  it('creation: a missing PR is watch-invalid, an unreadable gh is gh-unavailable, and only a tab owns a watch', async () => {
    f.answer('number=404', { ok: false, code: 'http-404', message: 'HTTP 404: Not Found' });
    f.answer('number=500', { ok: false, code: 'gh-missing', message: 'spawn gh ENOENT' });
    expect(await code(m.create(B, { kind: 'pr', target: 'o/r#404', until: 'merged' }))).toBe('watch-invalid');
    expect(await code(m.create(B, { kind: 'pr', target: 'o/r#500', until: 'merged' }))).toBe('gh-unavailable');
    expect(await code(m.create(ADMIN, { kind: 'lease', target: 'merge:x/y', until: 'free' }))).toBe('caller-unresolved');
    expect(await code(m.create(caller('ws-b', null), { kind: 'lease', target: 'merge:x/y', until: 'free' }))).toBe('caller-unresolved');
    expect(f.state.watches).toEqual([]);
  });

  it('list is the caller\'s workspace with owner liveness; clear is the owner tab or admin', async () => {
    const mine = await m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free', label: 'wait for\nlanding' });
    await m.create(caller('ws-a', 'tab-a'), { kind: 'lease', target: 'merge:x/y', until: 'free' });
    f.live.delete('ws-b/tab-b');
    const listed = await m.list(caller('ws-b', 'tab-other'), null);
    expect(listed.map((w) => [w.id, w.owner, w.label])).toEqual([[mine.id, 'closed', 'wait for landing']]);
    expect(await code(m.list(caller('ws-b', 'tab-other'), 'ws-a'))).toBe('forbidden');
    expect((await m.list(ADMIN, null)).length).toBe(2);
    expect(await code(m.clear(caller('ws-b', 'tab-other'), mine.id))).toBe('forbidden');
    expect(await code(m.clear(B, mine.id))).toBe('none');
    expect(await code(m.clear(B, mine.id))).toBe('watch-not-found');
    expect(await code(m.clear(B, '../x'))).toBe('watch-not-found');
  });

  it('a failing watch reads at its interval until the failing notice, then backs off 2x, 4x, capped at 8x', () => {
    const w = { kind: 'pr', intervalS: 120, lastCheckedAt: T0, failures: 0, pendingNotice: null } as never;
    const at = (failures: number, seconds: number) => isDue({ ...(w as object), failures } as never, T0 + seconds * 1000);
    expect(at(0, 120)).toBe(true);
    expect(at(2, 120)).toBe(true); // the first three reads stay prompt: the notice is not delayed
    expect(at(3, 120)).toBe(false);
    expect(at(3, 240)).toBe(true);
    expect(at(4, 479)).toBe(false);
    expect(at(4, 480)).toBe(true);
    expect(at(9, 959)).toBe(false);
    expect(at(9, 960)).toBe(true);
  });

  it('a PR already merged when the watch is made is reported on the first pass, not an interval later', async () => {
    f.answer('number=11', f.pull(true, 'closed', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'o/r#11', until: 'merged' });
    expect(w.lastCheckedAt).toBeNull();
    await m.tick();
    expect(f.sent.map((x) => x.line)).toEqual([expect.stringContaining('o/r#11 is MERGED')]);
  });

  it('a condition that held but could not be queued is reported as itself after expiry, never as expired', async () => {
    f.answer('number=12', f.pull(false, 'open', SHA_A), f.pull(true, 'closed', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'o/r#12', until: 'merged', ttlSeconds: 600 });
    const deps = f.deps();
    let broken = true;
    const flaky = new WatchManager({ ...deps, enqueue: async (req) => { if (broken) throw new Error('refused'); return deps.enqueue(req); } });
    f.now += 3 * MIN;
    await flaky.tick();
    f.now = w.expiresAt + MIN;
    broken = false;
    await flaky.tick();
    expect(f.sent.map((x) => x.fields.notice)).toEqual(['merged']);
  });

  it('a notice still refused a day past expiry drops its watch', async () => {
    f.answer('number=13', f.pull(false, 'open', SHA_A), f.pull(true, 'closed', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'o/r#13', until: 'merged', ttlSeconds: 600 });
    const refusing = new WatchManager({ ...f.deps(), enqueue: async () => { throw new Error('refused'); } });
    f.now += 3 * MIN;
    await refusing.tick();
    f.now = w.expiresAt + 23 * 60 * MIN;
    await refusing.tick();
    expect(f.state.watches).toHaveLength(1);
    f.now = w.expiresAt + 24 * 60 * MIN;
    await refusing.tick();
    expect(f.state.watches).toEqual([]);
  });

  it('refuses a GitHub watch that would take the host past its request budget', async () => {
    f.answer('number=', f.pull(false, 'open', SHA_A));
    // One GraphQL read per check (PMUX-WATCH-403): 3600 / 60 = 60 requests/h each; 33 of them ask 1,980/h.
    for (let i = 0; i < 33; i++) {
      f.live.add(`ws-x/tab-${i}`);
      await m.create(caller('ws-x', `tab-${i}`), { kind: 'pr', target: `o/r#${i + 1}`, until: 'checks-settled', intervalS: 60 });
    }
    const refused = m.create(B, { kind: 'pr', target: 'o/r#99', until: 'checks-settled', intervalS: 60 });
    await expect(refused).rejects.toThrow(/requests\/h/);
    expect(await code(m.create(B, { kind: 'pr', target: 'o/r#99', until: 'checks-settled', intervalS: 3600 }))).toBe('none');
  });

  it('records whether the owner tab was verified', async () => {
    expect((await m.create(LEGACY, { kind: 'lease', target: 'merge:x/y', until: 'free' })).verified).toBe(false);
  });

  it('a notice whose enqueue fails is kept and retried alone, never with another GitHub read', async () => {
    f.answer('number=6', f.pull(false, 'open', SHA_A), f.pull(true, 'closed', SHA_A));
    const w = await m.create(B, { kind: 'pr', target: 'o/r#6', until: 'merged' });
    const deps = f.deps();
    let broken = true;
    const flaky = new WatchManager({
      ...deps,
      enqueue: async (req) => {
        if (broken) throw new Error('inbox.json unwritable');
        return deps.enqueue(req);
      },
    });
    f.now += 2 * MIN;
    await flaky.tick();
    expect(f.state.watches[0]).toMatchObject({ id: w.id, pendingNotice: { notice: 'merged' } });
    const reads = f.ghCalls.length;
    broken = false;
    await flaky.tick();
    expect(f.ghCalls).toHaveLength(reads);
    expect(f.sent.map((x) => x.line)).toEqual([expect.stringContaining('is MERGED')]);
    expect(f.state.watches).toEqual([]);
  });

  it('a lease notice never waits behind a slow GitHub read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    f.answer('number=8', f.pull(false, 'open', SHA_A));
    await m.create(B, { kind: 'pr', target: 'o/r#8', until: 'merged' });
    await m.create(B, { kind: 'lease', target: 'merge:x/y', until: 'free' });
    const deps = f.deps();
    const slow = new WatchManager({ ...deps, runGh: async (args) => { await gate; return deps.runGh(args); } });
    f.now += 3 * MIN;
    const github = slow.tick();
    f.freeLeases.add('merge:x/y');
    await slow.tick('merge:x/y');
    expect(f.sent.map((x) => x.line)).toEqual([expect.stringContaining('merge:x/y is free')]);
    release();
    await github;
  });

  it('a watch cleared while its GitHub read is in flight is not reported', async () => {
    const w = await (async () => {
      f.answer('number=8', f.pull(false, 'open', SHA_A));
      return m.create(B, { kind: 'pr', target: 'o/r#8', until: 'merged' });
    })();
    const deps = f.deps();
    const racing = new WatchManager({
      ...deps,
      runGh: async (_args) => {
        await m.clear(B, w.id);
        return f.pull(true, 'closed', SHA_A);
      },
    });
    f.now += 3 * MIN;
    await racing.tick();
    expect(f.sent).toEqual([]);
    expect(f.state.watches).toEqual([]);
  });

  it('never runs two passes of one lane at once; a pass asked for meanwhile runs once afterwards', async () => {
    let reads = 0;
    let running = 0;
    let most = 0;
    const deps = f.deps();
    const slow = new WatchManager({
      ...deps,
      read: async () => {
        reads++;
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 20));
        running--;
        return deps.read();
      },
    });
    await Promise.all([slow.tick('merge:x/y'), slow.tick('merge:x/y'), slow.tick('merge:p/q')]);
    expect(most).toBe(1);
    expect(reads).toBe(2);
  });
});

// PMUX-WATCH-403: on 2026-11-14 at 03:56Z the shared agent account's REST budget reached 0 (reset 04:12Z), and
// `watch pr` failed http-403. A rate limit now holds the GitHub lane until GitHub's reset; it is never a failure.
describe('GitHub rate limits (PMUX-WATCH-403)', () => {
  let f: Fakes;
  let m: WatchManager;
  beforeEach(() => {
    f = new Fakes();
    m = new WatchManager(f.deps());
  });
  const RESET = T0 + 16 * MIN;
  /** The hold ends a margin after GitHub's reset (r2 #2). */
  const RESUME = RESET + RESUME_MARGIN_MS;
  const limited = (retryAt = RESET): TGhResult => ({ ok: false, code: 'rate-limited', message: 'API rate limit exceeded for user ID 1', retryAt,
    rate: { resource: 'graphql', limit: 5000, remaining: 0, used: 5000, resetAt: retryAt, resetEpochS: Math.floor(retryAt / 1000) } });
  const tickTo = async (at: number) => {
    f.now = at;
    await m.tick();
  };

  it('a rate-limited read is no failure: no failing notice, the watch kept, and no GitHub read until the reset', async () => {
    f.answer('number=7', f.pull(false, 'open', SHA_A), limited(), f.pull(true, 'closed', SHA_A));
    f.answer('number=8', f.pull(false, 'open', SHA_A));
    const w7 = await m.create(B, { kind: 'pr', target: 'o/r#7', until: 'merged' });
    await m.create(B, { kind: 'pr', target: 'o/r#8', until: 'merged' });
    const created = f.ghCalls.length;

    await tickTo(T0 + 2 * MIN);
    // The first read met the limit; the second watch is not read in the same pass.
    expect(f.ghCalls).toHaveLength(created + 1);
    expect(m.githubPaused()).toBe(true);
    expect(f.state.watches.find((w) => w.id === w7.id)).toMatchObject({ failures: 0, failingNotified: false, lastError: { code: 'rate-limited' } });
    expect(f.state.watches.find((w) => w.id === w7.id)?.lastError?.message).toContain(new Date(RESUME).toISOString());

    // Every pass before the reset reads nothing, however long the hold.
    for (const at of [T0 + 6 * MIN, T0 + 10 * MIN, RESET, RESUME - 1]) await tickTo(at);
    expect(f.ghCalls).toHaveLength(created + 1);
    expect(f.sent).toEqual([]);
    expect(f.state.watches).toHaveLength(2);

    await tickTo(RESUME);
    expect(m.githubPaused()).toBe(false);
    expect(f.sent.map((x) => x.fields.notice)).toEqual(['merged']);
    expect(f.state.watches).toHaveLength(1);
  });

  it('many rate-limited passes never reach the failing notice', async () => {
    f.answer('number=9', f.pull(false, 'open', SHA_A), limited(T0 + 3 * MIN));
    await m.create(B, { kind: 'pr', target: 'o/r#9', until: 'merged' });
    for (let i = 1; i <= 10; i++) {
      f.answer('number=9', limited(T0 + (3 * i + 3) * MIN));
      await tickTo(T0 + 3 * i * MIN);
    }
    expect(f.sent).toEqual([]);
    expect(f.state.watches[0]).toMatchObject({ failures: 0, failingNotified: false });
  });

  it('watch pr during a rate limit makes the watch with its baseline pending, never refuses it', async () => {
    f.answer('number=11', limited());
    const w = await m.create(B, { kind: 'pr', target: 'o/r#11', until: 'head-moved' });
    expect(w).toMatchObject({ baseline: null, baselinePending: true, lastCheckedAt: null, lastError: { code: 'rate-limited' } });
    expect(w.lastError?.message).toContain(new Date(RESUME).toISOString());

    // A second create while the lane holds reads nothing at all.
    const calls = f.ghCalls.length;
    const w2 = await m.create(B, { kind: 'ref', target: 'o/r@main', until: 'moved' });
    expect(w2).toMatchObject({ baselinePending: true });
    expect(f.ghCalls).toHaveLength(calls);

    // The first read after the reset takes the baseline and fires nothing; a later move fires.
    f.answer('number=11', f.pull(false, 'open', SHA_A), f.pull(false, 'open', SHA_B));
    f.answer('expression=main', f.ref(SHA_A), f.ref(SHA_B));
    // Two held watches resume a slot apart: the first at the hold's end, the second one slot later (r2 #2).
    await tickTo(RESUME);
    expect(f.state.watches.find((x) => x.id === w2.id)).toMatchObject({ baselinePending: true });
    await tickTo(RESUME + RESUME_STAGGER_MS);
    expect(f.sent).toEqual([]);
    expect(f.state.watches.find((x) => x.id === w.id)).toMatchObject({ baseline: SHA_A, baselinePending: false, lastError: null });
    expect(f.state.watches.find((x) => x.id === w2.id)).toMatchObject({ baseline: SHA_A, baselinePending: false });
    await tickTo(RESUME + RESUME_STAGGER_MS + 2 * MIN);
    expect(f.sent.map((x) => x.line)).toEqual([
      expect.stringContaining('o/r#11 head moved aaaaaaaa -> bbbbbbbb'),
      expect.stringContaining('o/r@main moved aaaaaaaa -> bbbbbbbb'),
    ]);
  });

  it('a merged watch made during a rate limit fires on the first read after the reset when the PR merged meanwhile', async () => {
    f.answer('number=12', limited());
    await m.create(B, { kind: 'pr', target: 'o/r#12', until: 'merged' });
    f.answer('number=12', f.pull(true, 'closed', SHA_B));
    await tickTo(RESUME);
    expect(f.sent.map((x) => x.line)).toEqual([expect.stringContaining('o/r#12 is MERGED (bbbbbbbb)')]);
  });

  it('a missing PR is still watch-invalid when GitHub answers; only the rate limit makes a pending watch', async () => {
    f.answer('number=404', { ok: false, code: 'http-404', message: 'Could not resolve to a PullRequest' });
    expect(await code(m.create(B, { kind: 'pr', target: 'o/r#404', until: 'merged' }))).toBe('watch-invalid');
  });

  it('a hold a fake read asks for beyond the hour, or as no time at all, is bounded: nothing throws (r2 #1)', async () => {
    const absurd: TGhResult = { ok: false, code: 'rate-limited', message: 'API rate limit exceeded', retryAt: 1e300,
      rate: { resource: 'graphql', limit: 5000, remaining: 0, used: 5000, resetAt: 1e300, resetEpochS: 999999999999999 } };
    f.answer('number=31', absurd);
    const w = await m.create(B, { kind: 'pr', target: 'o/r#31', until: 'merged' });
    const held = T0 + 65 * MIN + RESUME_MARGIN_MS;
    expect(m.budget().pausedUntil).toBe(held);
    expect(w.lastError?.message).toContain(new Date(held).toISOString());

    const m2 = new WatchManager(f.deps());
    f.answer('number=32', { ok: false, code: 'rate-limited', message: 'limited', retryAt: NaN });
    await expect(m2.create(B, { kind: 'pr', target: 'o/r#32', until: 'merged' })).resolves.toMatchObject({ baselinePending: true });
    expect(m2.budget().pausedUntil).toBe(T0 + 60_000 + RESUME_MARGIN_MS);
    // A tick that meets the same answers logs and records them without a RangeError.
    f.now = held;
    f.answer('number=31', absurd);
    await expect(m.tick()).resolves.toBeUndefined();
  });

  it('two held watches do not both read in the first pass after the reset (r2 #2)', async () => {
    f.answer('number=41', f.pull(false, 'open', SHA_A), limited(), f.pull(false, 'open', SHA_A));
    f.answer('number=42', f.pull(false, 'open', SHA_A));
    await m.create(B, { kind: 'pr', target: 'o/r#41', until: 'merged' });
    await m.create(B, { kind: 'pr', target: 'o/r#42', until: 'merged' });
    await tickTo(T0 + 2 * MIN);
    const held = f.ghCalls.length;
    await tickTo(RESUME);
    expect(f.ghCalls).toHaveLength(held + 1);
    await tickTo(RESUME + RESUME_STAGGER_MS);
    expect(f.ghCalls).toHaveLength(held + 2);
  });

  it('the spend log keeps one hour of reads, pruned as reads land, never only when read (r2 #4)', async () => {
    f.answer('number=51', f.pull(false, 'open', SHA_A));
    await m.create(B, { kind: 'pr', target: 'o/r#51', until: 'merged', intervalS: 60 });
    const spend = () => (m as unknown as { spend: unknown[] }).spend.length;
    // Three hours of reads, one a minute, with no budget() call to prune them.
    for (let i = 1; i <= 180; i++) await tickTo(T0 + i * MIN);
    expect(spend()).toBeLessThanOrEqual(60);
    expect(spend()).toBeGreaterThan(50);
  });

  it('logs the low-budget warning once per budget window, though each answer\'s Date moves resetAt (r3 #1)', async () => {
    logs.warn = [];
    const resetEpochS = (T0 + 30 * MIN) / 1000;
    // Two reads in one window: the same X-RateLimit-Reset, a resetAt that moved by the 1 s Date and the local ms.
    const low = (resetAt: number): TGhResult => ({ ...f.pull(false, 'open', SHA_A),
      rate: { resource: 'graphql', limit: 5000, remaining: 300, used: 4700, resetAt, resetEpochS } } as TGhResult);
    f.answer('number=61', low(T0 + 30 * MIN - 437), low(T0 + 30 * MIN + 612), low(T0 + 30 * MIN - 88));
    await m.create(B, { kind: 'pr', target: 'o/r#61', until: 'merged' });
    f.now += 123;
    await tickTo(T0 + 2 * MIN + 123);
    await tickTo(T0 + 4 * MIN + 789);
    expect(logs.warn.filter((l) => l.includes('budget low'))).toHaveLength(1);
    // A new window warns again.
    f.answer('number=61', { ...f.pull(false, 'open', SHA_A),
      rate: { resource: 'graphql', limit: 5000, remaining: 200, used: 4800, resetAt: T0 + 90 * MIN, resetEpochS: resetEpochS + 3600 } } as TGhResult);
    await tickTo(T0 + 7 * MIN);
    expect(logs.warn.filter((l) => l.includes('budget low'))).toHaveLength(2);
  });

  it('a checks-settled notice that cannot queue makes no GitHub read during a hold and never moves it (r3 #2)', async () => {
    f.answer('number=71', f.pull(false, 'open', SHA_A),
      f.pull(false, 'open', SHA_A, { runs: [['COMPLETED', 'SUCCESS']] }), f.pull(false, 'open', SHA_A),
      f.pull(false, 'open', SHA_A), limited());
    f.answer('number=72', f.pull(false, 'open', SHA_A), limited());
    let refuse = true;
    const deps = f.deps();
    const enqueue = deps.enqueue;
    m = new WatchManager({ ...deps, enqueue: async (req) => {
      if (refuse && req.fields.notice === 'checks-settled') throw new Error('inbox refused');
      return enqueue(req);
    } });
    const w = await m.create(B, { kind: 'pr', target: 'o/r#71', until: 'checks-settled' });
    await m.create(B, { kind: 'pr', target: 'o/r#72', until: 'merged' });
    await tickTo(T0 + 2 * MIN);
    // The checks settled, the re-check read passed, the inbox refused: the notice is pending.
    expect(f.state.watches.find((x) => x.id === w.id)?.pendingNotice).toMatchObject({ notice: 'checks-settled' });
    // The other watch meets a rate limit: the hold begins.
    await tickTo(T0 + 4 * MIN);
    const held = m.budget().pausedUntil;
    expect(held).toBe(RESUME);
    const reads = f.ghCalls.length;
    // Every pass of the hold retries the notice; none reads GitHub, none moves the hold.
    for (const at of [T0 + 5 * MIN, T0 + 8 * MIN, T0 + 12 * MIN]) await tickTo(at);
    expect(f.ghCalls).toHaveLength(reads);
    expect(m.budget().pausedUntil).toBe(held);
    expect(f.state.watches.find((x) => x.id === w.id)?.pendingNotice).toMatchObject({ notice: 'checks-settled' });
    // After the hold the re-check reads once more and the notice goes out.
    refuse = false;
    await tickTo(RESUME);
    expect(f.sent.map((x) => x.fields.notice)).toContain('checks-settled');
  });

  it('a hold the read bounded at the limit is not clamped again: one clamp line, the hold as the read named it (r3 #3)', async () => {
    logs.warn = [];
    const deps = f.deps();
    // The read takes 1 s: its own bound used the time after it, as runGhApi does.
    m = new WatchManager({ ...deps, runGh: async (args) => {
      f.ghCalls.push(args);
      f.now += 1_000;
      return { ok: false, code: 'rate-limited', message: 'limited', retryAt: f.now + 65 * MIN, retryHeader: 'Retry-After: 999999999', retryClamped: true };
    } });
    await m.create(B, { kind: 'pr', target: 'o/r#81', until: 'merged' });
    expect(m.budget().pausedUntil).toBe(T0 + 1_000 + 65 * MIN + RESUME_MARGIN_MS);
    const clamps = logs.warn.filter((l) => l.includes('was clamped'));
    expect(clamps).toHaveLength(1);
    expect(clamps[0]).toContain('Retry-After: 999999999');
  });

  it('names who spent the budget: the last budget per resource, the watch reads an hour back, the top owners', async () => {
    const rate = { resource: 'graphql', limit: 5000, remaining: 4321, used: 679, resetAt: T0 + 30 * MIN, resetEpochS: (T0 + 30 * MIN) / 1000 };
    f.answer('number=21', { ...f.pull(false, 'open', SHA_A), rate } as TGhResult);
    f.answer('number=22', { ...f.pull(false, 'open', SHA_A), rate } as TGhResult);
    f.live.add('ws-a/tab-a');
    await m.create(B, { kind: 'pr', target: 'o/r#21', until: 'merged' });
    await m.create(B, { kind: 'pr', target: 'o/r#21', until: 'closed' });
    await m.create(caller('ws-a', 'tab-a'), { kind: 'pr', target: 'o/r#22', until: 'merged' });
    expect(m.budget()).toEqual({
      budgets: [rate],
      pausedUntil: null,
      watchReads: 3,
      topOwners: [{ owner: 'ws-b/tab-b', reads: 2 }, { owner: 'ws-a/tab-a', reads: 1 }],
    });
    f.now = T0 + 61 * MIN;
    expect(m.budget()).toMatchObject({ watchReads: 0, topOwners: [] });
  });
});

describe('watch spec and GitHub parsing', () => {
  it.each([
    [{ kind: 'pr', target: 'o/r', until: 'merged' }],
    [{ kind: 'pr', target: 'o/r#1', until: 'moved' }],
    [{ kind: 'ref', target: 'o/r@a..b', until: 'moved' }],
    [{ kind: 'ref', target: 'o/r@x y', until: 'moved' }],
    [{ kind: 'lease', target: 'not a lease', until: 'free' }],
    [{ kind: 'lease', target: 'merge:x/y', until: 'merged' }],
    [{ kind: 'pr', target: 'o/r#1', until: 'merged', intervalS: 30 }],
    [{ kind: 'pr', target: 'o/r#1', until: 'merged', ttlSeconds: 8 * 86400 }],
    [{ kind: 'pr', target: 'o/r#1', until: 'merged', label: 'x'.repeat(81) }],
    [{ kind: 'shell', target: 'x', until: 'done' }],
  ])('refuses %j (watch-invalid)', (input) => {
    expect(() => checkSpec(input)).toThrow(WatchError);
  });

  it('counts checks: settled needs at least one and none pending', () => {
    expect(settleChecks('', '')).toEqual({ settled: false, green: 0, red: 0 });
    expect(settleChecks('completed\tsuccess\n', 'pending\n').settled).toBe(false);
    expect(settleChecks('completed\tneutral\ncompleted\ttimed_out\ncompleted\tcancelled\n', 'success\nerror\n'))
      .toEqual({ settled: true, green: 2, red: 3 });
  });

  it('classifies a gh failure into a token, never its text', () => {
    const e = (over: Record<string, unknown>) => Object.assign(new Error('x'), over) as never;
    expect(classifyGhError(e({ code: 'ENOENT' }), '')).toBe('gh-missing');
    expect(classifyGhError(e({ killed: true }), '')).toBe('timeout');
    expect(classifyGhError(e({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }), '')).toBe('other');
    expect(classifyGhError(e({}), 'gh: Not Found (HTTP 404)')).toBe('http-404');
    expect(classifyGhError(e({}), 'HTTP 403: rate limit')).toBe('rate-limited');
    expect(classifyGhError(e({}), 'gh: Resource not accessible by integration (HTTP 403)')).toBe('http-403');
    expect(classifyGhError(e({}), 'To get started with GitHub CLI, please run:  gh auth login')).toBe('auth');
    expect(classifyGhError(e({}), 'something else')).toBe('other');
  });
});
