import fs from 'fs/promises';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILeaseHolder } from '@/types/lease';
import { drainLeaseLocks, makeHome, readAudit, resetLeaseGlobals } from './lease-test-home';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const tabA: ILeaseHolder = { workspaceId: 'ws1', tabId: 'tab-a', tabName: 'A', verified: true, admin: false };
const tabB: ILeaseHolder = { workspaceId: 'ws2', tabId: 'tab-b', tabName: 'B', verified: true, admin: false };
const tabA2: ILeaseHolder = { workspaceId: 'ws1', tabId: 'tab-a2', tabName: 'A2', verified: false, admin: false };
const admin: ILeaseHolder = { workspaceId: null, tabId: null, tabName: null, verified: false, admin: true };

let now = Date.now();
const orchestrators = new Set<string>();
const authority = {
  now: () => now,
  isWorkspaceOrchestrator: async (ws: string, tab: string) => orchestrators.has(`${ws}/${tab}`),
};

const store = () => import('@/lib/lease-store');

describe('lease store', () => {
  beforeEach(async () => {
    vi.resetModules();
    resetLeaseGlobals();
    mockHome.value = await makeHome();
    now = Date.now();
    orchestrators.clear();
  });

  afterEach(async () => {
    await drainLeaseLocks();
    resetLeaseGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('refuses a second holder with lease-held naming the workspace, tab and age (case-insensitive name)', async () => {
    const { acquireLease } = await store();
    await acquireLease({ name: 'merge:acme/acme-ledger-api' }, tabA, authority);
    now += 7 * 60 * 1000;

    const err = await acquireLease({ name: 'merge:Acme/acme-ledger-api' }, tabB, authority).catch((e) => e);
    expect(err.code).toBe('lease-held');
    expect(err.message).toBe('merge:acme/acme-ledger-api is held by ws1/tab-a (A) for 7m');
    expect(err.lease.holder).toMatchObject({ workspaceId: 'ws1', tabId: 'tab-a' });
  });

  it('renews on re-acquire by the holder and moves the expiry forward', async () => {
    const { acquireLease } = await store();
    const first = await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    now += 10 * 60 * 1000;
    const again = await acquireLease({ name: 'merge:x/y' }, tabA, authority);

    expect(first.outcome).toBe('acquired');
    expect(again.outcome).toBe('renewed');
    expect(Date.parse(again.lease.expiresAt!)).toBe(Date.parse(first.lease.expiresAt!) + 10 * 60 * 1000);
    expect(again.lease.acquiredAt).toBe(first.lease.acquiredAt);
  });

  it('treats another tab of the same workspace as another holder', async () => {
    const { acquireLease } = await store();
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    await expect(acquireLease({ name: 'merge:x/y' }, tabA2, authority)).rejects.toMatchObject({ code: 'lease-held' });
  });

  it('refuses policy violations with lease-policy naming the rule', async () => {
    const { acquireLease } = await store();
    await expect(acquireLease({ name: 'num:x/y:adr:0001' }, tabA, authority)).rejects.toMatchObject({ code: 'lease-policy', message: 'num leases require an epic' });
    await expect(acquireLease({ name: 'merge:x/y', ttlSeconds: 5 * 3600 }, tabA, authority)).rejects.toMatchObject({ code: 'lease-policy', message: 'merge leases allow at most 3h, got 5h' });
  });

  it('lets only the admin token or the workspace orchestrator tab take a deploy lease', async () => {
    const { acquireLease } = await store();
    await expect(acquireLease({ name: 'deploy:purplemux' }, tabA, authority)).rejects.toMatchObject({
      code: 'forbidden', message: "deploy leases need the admin token or the workspace's enabled orchestrator tab",
    });
    orchestrators.add('ws1/tab-a');
    expect((await acquireLease({ name: 'deploy:purplemux' }, tabA, authority)).outcome).toBe('acquired');
    await expect(acquireLease({ name: 'deploy:purplemux' }, admin, authority)).rejects.toMatchObject({ code: 'lease-held' });
  });

  it('lets the admin token take a deploy lease', async () => {
    const { acquireLease } = await store();
    const { lease } = await acquireLease({ name: 'deploy:purplemux' }, admin, authority);
    expect(lease.holder).toEqual(admin);
    expect(lease.ttlSeconds).toBe(30 * 60);
  });

  it('grants exactly one of 20 concurrent acquires', async () => {
    const { acquireLease, listLeases } = await store();
    const holders = Array.from({ length: 20 }, (_, i): ILeaseHolder => ({ workspaceId: `ws${i}`, tabId: `tab-${i}`, tabName: null, verified: true, admin: false }));
    const results = await Promise.allSettled(holders.map((h) => acquireLease({ name: 'merge:x/y' }, h, authority)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'lease-held')).toBe(true);
    expect(await listLeases()).toHaveLength(1);
  });

  it('persists to leases.json with mode 0600 and refuses a corrupt file rather than reading it as empty', async () => {
    const { acquireLease, leasesFile, listLeases } = await store();
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    expect((await fs.stat(leasesFile())).mode & 0o777).toBe(0o600);

    for (const bad of ['{broken', 'null', '{}', '[]', '{"leases":{}}']) {
      await fs.writeFile(leasesFile(), bad);
      await expect(listLeases()).rejects.toThrow('leases are refused until it is repaired or moved aside');
      await expect(acquireLease({ name: 'merge:x/y' }, tabB, authority)).rejects.toThrow('leases are refused');
    }
  });

  it('keeps shallowly filtered malformed rows unknown to strict diagnostic readers', async () => {
    const { leasesFile, listLeases, readLeaseEvidence } = await store();
    await fs.mkdir(path.dirname(leasesFile()), { recursive: true });
    await fs.writeFile(leasesFile(), JSON.stringify({
      leases: [{
        name: 'epic:damaged',
        kind: 'epic',
        acquiredAt: new Date(now).toISOString(),
        renewedAt: new Date(now).toISOString(),
        holder: { workspaceId: 'ws1' },
      }],
    }));

    expect(await listLeases('epic:', now)).toEqual([]);
    expect(await readLeaseEvidence(now)).toEqual({ known: false });
  });

  it('releases only for the holder', async () => {
    const { acquireLease, releaseLease, findLease } = await store();
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);

    await expect(releaseLease('merge:x/y', tabB, authority)).rejects.toMatchObject({ code: 'lease-held-by-other' });
    await expect(releaseLease('merge:x/z', tabA, authority)).rejects.toMatchObject({ code: 'lease-not-found' });
    await releaseLease('merge:x/y', tabA, authority);
    expect(await findLease('merge:x/y')).toBeNull();
  });

  it('renews for the holder only, keeping the TTL unless one is given', async () => {
    const { acquireLease, renewLease } = await store();
    await acquireLease({ name: 'merge:x/y', ttlSeconds: 600 }, tabA, authority);
    now += 60_000;
    const kept = await renewLease('merge:x/y', undefined, tabA, authority);
    expect(kept.ttlSeconds).toBe(600);
    expect(Date.parse(kept.expiresAt!)).toBe(now + 600_000);
    expect((await renewLease('merge:x/y', 1200, tabA, authority)).ttlSeconds).toBe(1200);
    await expect(renewLease('merge:x/y', undefined, tabB, authority)).rejects.toMatchObject({ code: 'lease-held-by-other' });
    await expect(renewLease('merge:x/y', 9 * 3600, tabA, authority)).rejects.toMatchObject({ code: 'lease-policy' });
  });

  it('finds by exact name only', async () => {
    const { acquireLease, findLease } = await store();
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    expect((await findLease('merge:x/y'))?.name).toBe('merge:x/y');
    expect(await findLease('merge:x/y-z')).toBeNull();
    expect(await findLease('MERGE:X/Y')).not.toBeNull();
  });

  it('breaks only with the admin token and a reason, and audits the reason', async () => {
    const { acquireLease, breakLease, findLease } = await store();
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);

    await expect(breakLease('merge:x/y', 'stuck', tabB, authority)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(breakLease('merge:x/y', '  ', admin, authority)).rejects.toMatchObject({ code: 'lease-policy' });
    await breakLease('merge:x/y', 'holder crashed mid-merge', admin, authority);

    expect(await findLease('merge:x/y')).toBeNull();
    await drainLeaseLocks();
    const last = (await readAudit(mockHome.value)).at(-1);
    expect(last).toMatchObject({ event: 'lease-release', name: 'merge:x/y', reason: 'broken', breakReason: 'holder crashed mid-merge', by: { admin: true } });
  });

  it('breaks for a human session with a 1..500 character reason and records the session subject (ADR-0029 §8)', async () => {
    const { acquireLease, breakLease, findLease } = await store();
    const released: string[] = [];
    (await store()).onLeaseReleased((lease, reason) => released.push(`${lease.name}:${reason}`));
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);

    await expect(breakLease('merge:x/y', '', { human: 'owner' }, authority)).rejects.toMatchObject({ code: 'lease-policy' });
    await expect(breakLease('merge:x/y', 'x'.repeat(501), { human: 'owner' }, authority)).rejects.toMatchObject({ code: 'lease-policy' });
    await expect(breakLease('merge:x/y', 'stuck', { human: '  ' }, authority)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await findLease('merge:x/y')).not.toBeNull();

    await breakLease('merge:x/y', 'x'.repeat(500), { human: 'owner' }, authority);
    expect(await findLease('merge:x/y')).toBeNull();
    expect(released).toEqual(['merge:x/y:broken']);
    await drainLeaseLocks();
    const last = (await readAudit(mockHome.value)).at(-1);
    expect(last).toMatchObject({ event: 'lease-release', name: 'merge:x/y', reason: 'broken', breakReason: 'x'.repeat(500), by: { human: 'owner' } });
    expect(last?.holder).toMatchObject({ workspaceId: 'ws1', tabId: 'tab-a' });
    await expect(breakLease('merge:x/y', 'again', { human: 'owner' }, authority)).rejects.toMatchObject({ code: 'lease-not-found' });
  });

  it('records a break reason cut by code points, never a lone surrogate (human 500 emoji kept whole, admin cut to 500)', async () => {
    const { acquireLease, breakLease } = await store();
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    await breakLease('merge:x/y', '😀'.repeat(500), { human: 'owner' }, authority);
    await acquireLease({ name: 'merge:x/z' }, tabA, authority);
    await breakLease('merge:x/z', '😀'.repeat(600), admin, authority);
    await acquireLease({ name: 'merge:x/q' }, tabA, authority);
    await breakLease('merge:x/q', 'y'.repeat(600), admin, authority);
    await drainLeaseLocks();
    const reasons = (await readAudit(mockHome.value)).filter((l) => l.reason === 'broken').map((l) => String(l.breakReason));
    expect(reasons).toEqual(['😀'.repeat(500), '😀'.repeat(500), 'y'.repeat(500)]);
    for (const r of reasons) expect(r).not.toMatch(loneSurrogate);
  });

  describe('release-epic', () => {
    const claim = async (name: string, holder: ILeaseHolder, epic = 'p4') => {
      const { acquireLease } = await store();
      return acquireLease({ name, epic }, holder, authority);
    };

    it('lets the epic holder release its survives-tab claims only', async () => {
      const { acquireLease, releaseEpicClaims, listLeases } = await store();
      await acquireLease({ name: 'epic:p4' }, tabB, authority);
      await claim('num:acme/acme-ledger-api:adr:0373', tabA);
      await claim('num:acme/acme-ledger-api:adr:0374', tabA);
      await claim('num:acme/acme-ledger-api:adr:0375', tabA, 'other');

      const released = await releaseEpicClaims('p4', tabB, authority);
      expect(released.map((l) => l.name).sort()).toEqual(['num:acme/acme-ledger-api:adr:0373', 'num:acme/acme-ledger-api:adr:0374']);
      expect((await listLeases()).map((l) => l.name)).toEqual(['epic:p4', 'num:acme/acme-ledger-api:adr:0375']);
    });

    it('lets a tab of the claims\' holder workspace release them', async () => {
      const { releaseEpicClaims } = await store();
      await claim('num:acme/acme-ledger-api:adr:0373', tabA);
      expect(await releaseEpicClaims('p4', tabA2, authority)).toHaveLength(1);
    });

    it('lets admin release them', async () => {
      const { releaseEpicClaims } = await store();
      await claim('num:acme/acme-ledger-api:adr:0373', tabA);
      expect(await releaseEpicClaims('p4', admin, authority)).toHaveLength(1);
    });

    it('refuses anyone else', async () => {
      const { releaseEpicClaims, listLeases } = await store();
      await claim('num:acme/acme-ledger-api:adr:0373', tabA);
      await expect(releaseEpicClaims('p4', tabB, authority)).rejects.toMatchObject({ code: 'forbidden' });
      expect(await listLeases()).toHaveLength(1);
    });

    it('filters by kind when asked', async () => {
      const { releaseEpicClaims } = await store();
      await claim('num:acme/acme-ledger-api:adr:0373', tabA);
      expect(await releaseEpicClaims('p4', admin, authority, 'other-kind')).toEqual([]);
      await expect(releaseEpicClaims('p4', admin, authority, 'Bad Kind')).rejects.toMatchObject({ code: 'lease-policy' });
    });
  });

  it('refuses a holder that is neither a tab nor admin with caller-unresolved', async () => {
    const { acquireLease, renewLease, releaseLease, releaseEpicClaims } = await store();
    const tabless: ILeaseHolder = { workspaceId: 'ws1', tabId: null, tabName: null, verified: false, admin: false };
    for (const op of [
      () => acquireLease({ name: 'merge:x/y', ttlSeconds: 60 }, tabless, authority),
      () => renewLease('merge:x/y', undefined, tabless, authority),
      () => releaseLease('merge:x/y', tabless, authority),
      () => releaseEpicClaims('p4', tabless, authority),
    ]) {
      await expect(op()).rejects.toMatchObject({ code: 'caller-unresolved' });
    }
  });

  it('keeps the TTL on a re-acquire without one (as renew does)', async () => {
    const { acquireLease } = await store();
    await acquireLease({ name: 'merge:x/y', ttlSeconds: 3 * 3600 }, tabA, authority);
    now += 10 * 60 * 1000;
    const { lease } = await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    expect(lease.ttlSeconds).toBe(3 * 3600);
    expect(Date.parse(lease.expiresAt!)).toBe(now + 3 * 3600 * 1000);
  });

  it('records the latest proof: an unverified renew clears verified', async () => {
    const { acquireLease } = await store();
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    const { lease } = await acquireLease({ name: 'merge:x/y' }, { ...tabA, verified: false }, authority);
    expect(lease.holder.verified).toBe(false);
  });

  it('treats an expired, unswept lease as absent: another caller acquires it, check and renew see nothing', async () => {
    const { acquireLease, findLease, renewLease, listLeases } = await store();
    await acquireLease({ name: 'merge:x/y', ttlSeconds: 60 }, tabA, authority);
    await acquireLease({ name: 'merge:x/z', ttlSeconds: 60 }, tabA, authority);
    now += 60_000;

    expect(await findLease('merge:x/y', now)).toBeNull();
    expect(await listLeases(undefined, now)).toEqual([]);
    await expect(renewLease('merge:x/z', undefined, tabA, authority)).rejects.toMatchObject({ code: 'lease-not-found' });
    expect((await acquireLease({ name: 'merge:x/y' }, tabB, authority)).outcome).toBe('acquired');

    await drainLeaseLocks();
    const audit = (await readAudit(mockHome.value)).slice(2);
    expect(audit.map((e) => [e.event, e.name, e.reason ?? null])).toEqual([
      ['lease-release', 'merge:x/y', 'expired'],
      ['lease-release', 'merge:x/z', 'expired'],
      ['lease-acquire', 'merge:x/y', null],
    ]);
  });

  it('emits audit lines and hooks in mutation order even when a sweep and an acquire race', async () => {
    const { acquireLease, onLeaseAcquired, onLeaseReleased, sweepLeases } = await store();
    await acquireLease({ name: 'smoke:a', ttlSeconds: 1 }, tabA, authority);
    await acquireLease({ name: 'smoke:b', ttlSeconds: 1 }, tabA, authority);
    await acquireLease({ name: 'merge:x/y', ttlSeconds: 1 }, tabA, authority);
    now += 1000;
    const seen: string[] = [];
    onLeaseAcquired((l) => seen.push(`acquired:${l.name}`));
    onLeaseReleased((l, r) => seen.push(`${r}:${l.name}`));

    await Promise.all([
      sweepLeases({ now, liveTabIds: new Set(['tab-a']), agentGone: () => false }),
      acquireLease({ name: 'merge:x/y' }, tabB, authority),
    ]);
    expect(seen.indexOf('expired:merge:x/y')).toBeLessThan(seen.indexOf('acquired:merge:x/y'));
  });

  describe('release-epic scoping', () => {
    const wsBTab: ILeaseHolder = { workspaceId: 'ws2', tabId: 'tab-b2', tabName: null, verified: true, admin: false };
    const seed = async () => {
      const { acquireLease } = await store();
      await acquireLease({ name: 'num:x/y:adr:0001', epic: 'p4' }, tabA, authority);
      await acquireLease({ name: 'num:x/y:adr:0002', epic: 'p4' }, tabB, authority);
    };

    it('releases only its own workspace\'s claims for a workspace-authorised tab', async () => {
      const { releaseEpicClaims, listLeases } = await store();
      await seed();
      expect((await releaseEpicClaims('p4', tabA2, authority)).map((l) => l.name)).toEqual(['num:x/y:adr:0001']);
      expect((await listLeases()).map((l) => l.name)).toEqual(['num:x/y:adr:0002']);
      expect((await releaseEpicClaims('p4', wsBTab, authority)).map((l) => l.name)).toEqual(['num:x/y:adr:0002']);
    });

    it('releases every claim for the epic holder', async () => {
      const { acquireLease, releaseEpicClaims } = await store();
      await seed();
      const owner: ILeaseHolder = { workspaceId: 'ws3', tabId: 'tab-o', tabName: null, verified: true, admin: false };
      await acquireLease({ name: 'epic:p4' }, owner, authority);
      expect(await releaseEpicClaims('p4', owner, authority)).toHaveLength(2);
    });

    it('answers an empty list, not a refusal, when there is nothing to release, and writes nothing', async () => {
      const { acquireLease, releaseLease, releaseEpicClaims, leasesFile } = await store();
      await acquireLease({ name: 'epic:p4' }, tabB, authority);
      await releaseLease('epic:p4', tabB, authority);
      const before = await fs.stat(leasesFile());
      expect(await releaseEpicClaims('p4', tabB, authority)).toEqual([]);
      expect(await releaseEpicClaims('never-claimed', tabA, authority)).toEqual([]);
      expect((await fs.stat(leasesFile())).mtimeMs).toBe(before.mtimeMs);
    });
  });

  it('fires acquire/release hooks and writes one audit line per transition', async () => {
    const { acquireLease, releaseLease, onLeaseAcquired, onLeaseReleased } = await store();
    const seen: string[] = [];
    onLeaseAcquired((l, outcome) => seen.push(`${outcome}:${l.name}`));
    onLeaseReleased((l, reason) => seen.push(`${reason}:${l.name}`));
    onLeaseAcquired(() => { throw new Error('listener bug'); });

    await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    await acquireLease({ name: 'merge:x/y' }, tabA, authority);
    await releaseLease('merge:x/y', tabA, authority);

    expect(seen).toEqual(['acquired:merge:x/y', 'renewed:merge:x/y', 'released:merge:x/y']);
    await drainLeaseLocks();
    expect((await readAudit(mockHome.value)).map((e) => e.event)).toEqual(['lease-acquire', 'lease-renew', 'lease-release']);
  });

  it('builds views with holder state and times', async () => {
    const { acquireLease, toLeaseView } = await store();
    const { lease } = await acquireLease({ name: 'merge:x/y', ttlSeconds: 600 }, tabA, authority);
    const facts = (live: string[], inactive: string[] = []) => ({
      now: now + 120_000,
      liveTabIds: new Set(live),
      agentInactive: (id: string) => inactive.includes(id),
      workspaceName: (id: string) => (id === 'ws1' ? 'Acme-ledger' : null),
    });

    expect(toLeaseView(lease, facts(['tab-a']))).toMatchObject({
      ageSeconds: 120, expiresInSeconds: 480, holderState: 'live', holder: { workspaceName: 'Acme-ledger', tabId: 'tab-a', verified: true, admin: false },
    });
    expect(toLeaseView(lease, facts(['tab-a'], ['tab-a'])).holderState).toBe('agent-gone');
    expect(toLeaseView(lease, facts([])).holderState).toBe('closed');
    expect(toLeaseView(lease, { ...facts([]), uncertainWorkspaceIds: new Set(['ws1']) }).holderState).toBe('live');
    const adminLease = (await acquireLease({ name: 'smoke:x' }, admin, authority)).lease;
    expect(toLeaseView(adminLease, facts([])).holderState).toBe('admin');
    expect(toLeaseView({ ...lease, expiresAt: null, ttlSeconds: null }, facts(['tab-a'])).expiresInSeconds).toBeNull();
  });

  it('keeps no human label anywhere: an admin holder is admin', async () => {
    const { acquireLease, holderLabel } = await store();
    const { lease } = await acquireLease({ name: 'smoke:x' }, admin, authority);
    expect(holderLabel(lease.holder)).toBe('admin');
    expect(JSON.stringify(await fs.readFile(path.join(mockHome.value, '.purplemux', 'leases.json'), 'utf-8'))).not.toMatch(/human/i);
  });

  it('derives a holder from a caller without inventing a tab for admin', async () => {
    const { holderFromCaller } = await store();
    expect(holderFromCaller({ scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true }))
      .toEqual({ ...admin, identity: 'none' });
    expect(holderFromCaller({ scope: { type: 'workspace', workspaceId: 'ws1' }, workspaceId: 'ws1', tabId: 'tab-a', tabName: 'A', verified: false, identity: 'session', admin: false }))
      .toEqual({ ...tabA, verified: false, identity: 'session' });
  });

  it('keeps how a holder was named, and labels a hook-time identity apart from an unverified one (story 36)', async () => {
    const { holderFromCaller, holderLabel } = await store();
    const hook = holderFromCaller({ scope: { type: 'workspace', workspaceId: 'ws1', tabId: 'tab-a', tabIdentity: 'hook' }, workspaceId: 'ws1', tabId: 'tab-a', tabName: 'A', verified: false, identity: 'hook', admin: false });
    expect(hook).toMatchObject({ verified: false, identity: 'hook' });
    expect(holderLabel(hook)).toBe('ws1/tab-a (A) hook-identity');
    expect(holderLabel({ ...hook, identity: 'session' })).toBe('ws1/tab-a (A) unverified');
    expect(holderLabel({ ...hook, identity: undefined })).toBe('ws1/tab-a (A) unverified');
  });
});
