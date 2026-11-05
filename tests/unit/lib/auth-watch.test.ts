import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// DEC-261: an auth watch reads files only. Every child_process entry point is recorded, so a test can
// prove that no `aws` process (and no process at all) starts while an auth watch is created and read.
const spawned = vi.hoisted(() => [] as string[]);
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const record = (name: string, fn: (...args: never[]) => unknown) => (...args: never[]) => {
    spawned.push(`${name} ${String(args[0])}`);
    return fn(...args);
  };
  const mocked = {
    ...actual,
    spawn: record('spawn', actual.spawn as never),
    spawnSync: record('spawnSync', actual.spawnSync as never),
    exec: record('exec', actual.exec as never),
    execSync: record('execSync', actual.execSync as never),
    execFile: record('execFile', actual.execFile as never),
    execFileSync: record('execFileSync', actual.execFileSync as never),
    fork: record('fork', actual.fork as never),
  };
  return { ...mocked, default: mocked };
});

const mockHome = vi.hoisted(() => ({ value: '' }));
const ledger = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('@/lib/ledger-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ledger-store')>();
  return { ...actual, getLedgerStore: () => ledger.store };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

import { findSsoProfile, parseSsoExpiry, readSsoToken, resolveSsoProfile, tokenState } from '@/lib/aws-sso-cache';
import { clearAuthWaits, namesProfile } from '@/lib/auth-waits';
import type { ICaller } from '@/lib/caller';
import type { IEnqueueRequest } from '@/lib/inbox-store';
import { renderInboxLine } from '@/lib/inbox-templates';
import { LedgerStore } from '@/lib/ledger-store';
import { SSO_MIN_VALIDITY_MS } from '@/lib/aws-sso-cache';
import { WatchManager, type IWatchDeps } from '@/lib/watch-manager';
import { WATCH_AUTH_INTERVAL_S, WatchError, checkSpec } from '@/lib/watch-store';
import type { IInboxItem } from '@/types/inbox';
import type { ILedgerEventInput } from '@/types/ledger';
import type { IWatch, IWatchesState } from '@/types/watch';

const T0 = Date.UTC(2026, 10, 3, 9, 0, 0);
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');

const CONFIG = `[default]
sso_session = corp

[profile dev]
sso_session = corp
sso_account_id = 111111111111
sso_role_name = Dev

[profile legacy]
sso_start_url = https://legacy.awsapps.com/start
sso_region = us-east-1

[profile static]
aws_access_key_id = AKIAEXAMPLE

[sso-session corp]
sso_start_url = https://corp.awsapps.com/start/#
sso_region = ap-southeast-2

[sso-session other]
sso_start_url = https://corp.awsapps.com/start/#
`;

let home: string;
const writeCache = (key: string, body: unknown) => {
  fs.writeFileSync(path.join(home, '.aws', 'sso', 'cache', `${key}.json`), typeof body === 'string' ? body : JSON.stringify(body));
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-auth-watch-'));
  mockHome.value = home;
  fs.mkdirSync(path.join(home, '.aws', 'sso', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aws', 'config'), CONFIG);
  spawned.length = 0;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the AWS SSO cache reader (ADR-0041)', () => {
  it('names the cache file the AWS CLI writes: sha1 of the sso-session, or of a legacy start URL', () => {
    expect(resolveSsoProfile(CONFIG, 'dev')).toEqual({ profile: 'dev', cacheKey: sha1('corp'), via: 'sso-session' });
    expect(resolveSsoProfile(CONFIG, 'default')?.cacheKey).toBe(sha1('corp'));
    expect(resolveSsoProfile(CONFIG, 'legacy')).toEqual({ profile: 'legacy', cacheKey: sha1('https://legacy.awsapps.com/start'), via: 'sso_start_url' });
    expect(resolveSsoProfile(CONFIG, 'static')).toBeNull();
    expect(resolveSsoProfile(CONFIG, 'missing')).toBeNull();
  });

  it('counts a token only with an accessToken and an expiry in the future; a client registration is no sign-in', () => {
    expect(tokenState({ accessToken: 'x', expiresAt: '2026-11-03T10:00:00Z' }, T0)).toEqual({ state: 'valid', expiresAt: Date.UTC(2026, 10, 3, 10) });
    expect(tokenState({ accessToken: 'x', expiresAt: '2026-11-03T08:00:00Z' }, T0)).toEqual({ state: 'expired', expiresAt: Date.UTC(2026, 10, 3, 8) });
    // At least 5 minutes left, or it is no sign-in to wake a tab for (review r1, R8).
    expect(SSO_MIN_VALIDITY_MS).toBe(300_000);
    expect(tokenState({ accessToken: 'x', expiresAt: '2026-11-03T09:05:00Z' }, T0).state).toBe('valid');
    expect(tokenState({ accessToken: 'x', expiresAt: '2026-11-03T09:04:59Z' }, T0).state).toBe('expired');
    expect(tokenState({ clientId: 'c', clientSecret: 's', expiresAt: '2027-01-13T04:54:08Z' }, T0)).toEqual({ state: 'absent' });
    expect(parseSsoExpiry('2026-11-03T10:00:00UTC')).toBe(Date.UTC(2026, 10, 3, 10));
    expect(parseSsoExpiry('soon')).toBeNull();
  });

  it('reads the one cache file of the profile; another session sharing the start URL is not this sign-in', async () => {
    expect(await readSsoToken('dev', T0)).toEqual({ state: 'absent' });
    writeCache(sha1('other'), { accessToken: 'x', expiresAt: '2026-11-03T12:00:00Z', startUrl: 'https://corp.awsapps.com/start/#' });
    expect(await readSsoToken('dev', T0)).toEqual({ state: 'absent' });
    writeCache(sha1('corp'), { accessToken: 'x', expiresAt: '2026-11-03T12:00:00Z' });
    expect(await readSsoToken('dev', T0)).toEqual({ state: 'valid', expiresAt: Date.UTC(2026, 10, 3, 12) });
    writeCache(sha1('corp'), '{"accessToken": "x", "expi');
    expect(await readSsoToken('dev', T0)).toEqual({ state: 'absent' });
  });

  it('refuses a profile that is not SSO, and an unreadable config, by name', async () => {
    await expect(findSsoProfile('static')).rejects.toThrow(/profile static has no sso_session or sso_start_url/);
    await expect(findSsoProfile('bad name')).rejects.toThrow(/a profile name is/);
    fs.rmSync(path.join(home, '.aws', 'config'));
    await expect(findSsoProfile('dev')).rejects.toThrow(/the AWS config is unreadable: ENOENT/);
  });
});

const caller = (workspaceId: string, tabId: string): ICaller =>
  ({ scope: {}, workspaceId, tabId, tabName: tabId, verified: true, admin: false } as unknown as ICaller);

class Harness {
  now = T0;
  state: IWatchesState = { watches: [] };
  sent: Array<IEnqueueRequest<'watch'> & { line: string }> = [];
  fired: IWatch[] = [];
  reads = 0;
  host: { known: false } | { known: true; host: string | null } = { known: true, host: null };

  deps(): IWatchDeps {
    return {
      now: () => this.now,
      newId: () => 'w-auth1',
      runGh: async () => { throw new Error('an auth watch reads no GitHub'); },
      leaseFree: async () => false,
      ssoToken: async (profile, now) => {
        this.reads += 1;
        return readSsoToken(profile, now);
      },
      ssoProfile: (profile) => findSsoProfile(profile),
      tabHost: async () => this.host,
      hostName: () => 'mdserver1',
      liveTabs: async () => ({ tabs: [{ workspaceId: 'ws-a', tabId: 'tab-a' }], uncertainWorkspaceIds: new Set() }),
      enqueue: async (req) => {
        this.sent.push({ ...req, line: renderInboxLine('watch', req.fields).line });
        return { item: { id: `i-${this.sent.length}` } as IInboxItem };
      },
      onFired: async (watch) => { this.fired.push(watch); },
      read: async () => this.state,
      mutate: async (fn) => {
        const { state, value } = await fn(this.state);
        this.state = state;
        return value;
      },
    };
  }
}

describe('watch kind auth (story 14 AC 5)', () => {
  it('validates the spec: aws-sso:<profile>, until signed-in, a 60 s default interval', () => {
    const spec = checkSpec({ kind: 'auth', target: 'dev', until: 'signed-in' });
    expect(spec).toMatchObject({ kind: 'auth', target: 'aws-sso:dev', until: 'signed-in', intervalS: WATCH_AUTH_INTERVAL_S, ledgerItem: null });
    expect(WATCH_AUTH_INTERVAL_S).toBe(60);
    expect(checkSpec({ kind: 'auth', target: 'aws-sso:dev', until: 'signed-in', ledgerItem: 'deploy:dev:abc123def456' }).ledgerItem).toBe('deploy:dev:abc123def456');
    expect(() => checkSpec({ kind: 'auth', target: 'dev', until: 'free' })).toThrow(/waits --until signed-in/);
    expect(() => checkSpec({ kind: 'auth', target: 'no spaces', until: 'signed-in' })).toThrow(/an AWS profile name/);
    expect(() => checkSpec({ kind: 'auth', target: 'dev', until: 'signed-in', ledgerItem: 'nope' })).toThrow(/ledgerItem is a ledger item key/);
    expect(() => checkSpec({ kind: 'lease', target: 'merge:a/b', until: 'free', ledgerItem: 'deploy:x' })).toThrow(/auth watch only/);
  });

  it('refuses at creation a profile the AWS config does not define as SSO', async () => {
    const manager = new WatchManager(new Harness().deps());
    await expect(manager.create(caller('ws-a', 'tab-a'), { kind: 'auth', target: 'static', until: 'signed-in' }))
      .rejects.toMatchObject({ code: 'watch-invalid' } satisfies Partial<WatchError>);
  });

  it('reads the cache every 60 s and wakes the waiter once when a valid token appears', async () => {
    const h = new Harness();
    const manager = new WatchManager(h.deps());
    await manager.create(caller('ws-a', 'tab-a'), { kind: 'auth', target: 'dev', until: 'signed-in', ledgerItem: 'deploy:dev:abc123def456' });
    await manager.tick();
    // One read at creation (the baseline), one on the first pass.
    expect(h.reads).toBe(2);
    expect(h.sent).toEqual([]);
    h.now += 15_000;
    await manager.tick();
    expect(h.reads).toBe(2);
    writeCache(sha1('corp'), { accessToken: 'x', expiresAt: '2026-11-03T17:00:00Z' });
    h.now = T0 + 60_000;
    await manager.tick();
    expect(h.reads).toBe(3);
    expect(h.sent.map((s) => s.line)).toEqual([
      '[purplemux watch w-auth1] aws-sso:dev is signed in: its SSO token is valid until 2026-11-03T17:00:00Z; retry the step that needed it — watch cleared',
    ]);
    expect(h.fired.map((w) => w.ledgerItem)).toEqual(['deploy:dev:abc123def456']);
    expect(h.state.watches).toEqual([]);
  });

  it('an expired token waits; an unreadable config is a failing watch, never a fired one', async () => {
    const h = new Harness();
    const manager = new WatchManager(h.deps());
    await manager.create(caller('ws-a', 'tab-a'), { kind: 'auth', target: 'dev', until: 'signed-in' });
    writeCache(sha1('corp'), { accessToken: 'x', expiresAt: '2026-11-03T08:00:00Z' });
    await manager.tick();
    expect(h.sent).toEqual([]);
    fs.rmSync(path.join(home, '.aws', 'config'));
    for (let i = 1; i <= 3; i++) {
      h.now = T0 + i * 60_000;
      await manager.tick();
    }
    expect(h.sent.map((s) => s.line)).toEqual([
      '[purplemux watch w-auth1] aws-sso:dev is failing: sso-config — purplemux watch list shows the error; still trying until it expires',
    ]);
    expect(h.state.watches[0].lastError?.message).toMatch(/the AWS config is unreadable/);
  });

  it('fires on a NEW sign-in: a token already valid at creation does not wake the tab; the next one does (R8)', async () => {
    const h = new Harness();
    const manager = new WatchManager(h.deps());
    writeCache(sha1('corp'), { accessToken: 'x', expiresAt: '2026-11-03T12:00:00Z' });
    const made = await manager.create(caller('ws-a', 'tab-a'), { kind: 'auth', target: 'dev', until: 'signed-in' });
    expect(made.baseline).toBe(`sso:${Date.UTC(2026, 10, 3, 12)}`);
    await manager.tick();
    expect(h.sent).toEqual([]);
    writeCache(sha1('corp'), { accessToken: 'y', expiresAt: '2026-11-03T20:00:00Z' });
    h.now = T0 + 60_000;
    await manager.tick();
    expect(h.sent.map((s) => s.line)).toEqual([expect.stringContaining('aws-sso:dev is signed in: its SSO token is valid until 2026-11-03T20:00:00Z')]);
  });

  it('refuses an auth wait from a remote tab, naming both hosts: its sign-in is not on this server', async () => {
    const h = new Harness();
    h.host = { known: true, host: 'ai-server' };
    const manager = new WatchManager(h.deps());
    await expect(manager.create(caller('ws-a', 'tab-a'), { kind: 'auth', target: 'dev', until: 'signed-in' }))
      .rejects.toThrow("an auth watch reads the SSO cache of this server's host (mdserver1); tab tab-a runs on ai-server, whose sign-in it cannot see");
    expect(h.state.watches).toEqual([]);
  });

  it('fails closed when the layout cannot say where the tab runs: caller-unresolved, no watch written (confirm NIT 4)', async () => {
    const h = new Harness();
    h.host = { known: false };
    const manager = new WatchManager(h.deps());
    await expect(manager.create(caller('ws-a', 'tab-a'), { kind: 'auth', target: 'dev', until: 'signed-in' })).rejects.toMatchObject({
      code: 'caller-unresolved',
      message: "the host of tab tab-a could not be read from the layout of ws-a; an auth watch reads only this server's SSO cache: retry",
    });
    expect(h.state.watches).toEqual([]);
  });

  it('the runtime tabHost answers known: false with no layout file, never a local answer (confirm NIT 4)', async () => {
    const { defaultWatchDeps } = await import('@/lib/watch-manager');
    const deps = await defaultWatchDeps();
    expect(await deps.tabHost('ws-nolayout', 'tab-a')).toEqual({ known: false });
  });

  it('starts no process at all while an auth watch is created, read and fired (DEC-261)', async () => {
    const h = new Harness();
    const manager = new WatchManager(h.deps());
    await manager.create(caller('ws-a', 'tab-a'), { kind: 'auth', target: 'dev', until: 'signed-in' });
    writeCache(sha1('corp'), { accessToken: 'x', expiresAt: '2026-11-03T17:00:00Z' });
    await manager.tick();
    expect(h.sent).toHaveLength(1);
    expect(spawned).toEqual([]);
    // The recorder itself works: a real child process is seen.
    const { execFileSync } = await import('child_process');
    execFileSync('true');
    expect(spawned).toEqual(['execFileSync true']);
  });
});

describe('a deploy-auth wait closes when its watch fires (story 14 AC 6)', () => {
  let ledgerDir: string;
  let store: LedgerStore;
  beforeEach(() => {
    ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-auth-ledger-'));
    store = new LedgerStore(path.join(ledgerDir, 'ledger.sqlite'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(ledgerDir, { recursive: true, force: true });
  });

  const event = (key: string, kind: ILedgerEventInput['kind'], at: number, extra: Partial<ILedgerEventInput> = {}): ILedgerEventInput => ({
    event_id: `${key}:${kind}:${at}`, at, item_type: 'deploy', item_key: key, kind, state: null, wait_reason: null,
    holder: null, clear_input: null, parent_key: null, attrs: null, ...extra,
  });
  const watch = (extra: Partial<IWatch> = {}): IWatch => ({
    id: 'w-auth1', workspaceId: 'ws-a', tabId: 'tab-a', kind: 'auth', target: 'aws-sso:dev', until: 'signed-in', baseline: null,
    intervalS: 60, createdAt: T0, expiresAt: T0 + 86_400_000, lastCheckedAt: null, failures: 0, failingNotified: false,
    lastError: null, label: null, verified: true, ...extra,
  });

  it('clears the named item and every wait whose clear input names the profile, and nothing else', () => {
    store.append('ws-a', 'v2', [
      event('deploy:dev:aaaaaaaaaaaa', 'open', T0),
      event('deploy:dev:aaaaaaaaaaaa', 'wait', T0 + 1, { wait_reason: 'deploy-auth', holder: 'owner', clear_input: 'owner signs in' }),
      event('deploy:dev:bbbbbbbbbbbb', 'open', T0),
      event('deploy:dev:bbbbbbbbbbbb', 'wait', T0 + 1, { wait_reason: 'deploy-auth', holder: 'owner', clear_input: 'aws sso login --profile dev' }),
      event('deploy:qa:cccccccccccc', 'open', T0),
      event('deploy:qa:cccccccccccc', 'wait', T0 + 1, { wait_reason: 'deploy-auth', holder: 'owner', clear_input: 'aws sso login --profile dev-qa' }),
      event('deploy:dev:dddddddddddd', 'open', T0),
      event('deploy:dev:dddddddddddd', 'wait', T0 + 1, { wait_reason: 'deploy-run', holder: 'gha', clear_input: 'profile dev run ends' }),
    ], T0 + 2);
    const at = T0 + 30 * 60_000;
    expect(clearAuthWaits(store, watch({ ledgerItem: 'deploy:dev:aaaaaaaaaaaa' }), at).sort())
      .toEqual(['deploy:dev:aaaaaaaaaaaa', 'deploy:dev:bbbbbbbbbbbb']);
    const items = new Map(store.items('ws-a', { open: true }, at).items.map((item) => [item.itemKey, item]));
    expect(items.get('deploy:dev:aaaaaaaaaaaa')?.waitReason).toBeNull();
    expect(items.get('deploy:dev:bbbbbbbbbbbb')?.waitReason).toBeNull();
    expect(items.get('deploy:qa:cccccccccccc')?.waitReason).toBe('deploy-auth');
    expect(items.get('deploy:dev:dddddddddddd')?.waitReason).toBe('deploy-run');
    expect(store.intervalsIn('ws-a', T0, at + 1).map((row) => [row.item_key, row.reason, row.start, row.end]).sort()).toEqual([
      ['deploy:dev:aaaaaaaaaaaa', 'deploy-auth', T0 + 1, at],
      ['deploy:dev:bbbbbbbbbbbb', 'deploy-auth', T0 + 1, at],
    ]);
    // A second fire of the same watch writes nothing new.
    expect(clearAuthWaits(store, watch({ ledgerItem: 'deploy:dev:aaaaaaaaaaaa' }), at + 1)).toEqual([]);
  });

  it('the runtime wiring links a fired auth watch to the ledger: defaultWatchDeps.onFired -> clearAuthWaits (R7)', async () => {
    ledger.store = store;
    store.append('ws-a', 'v2', [
      event('deploy:dev:eeeeeeeeeeee', 'open', T0),
      event('deploy:dev:eeeeeeeeeeee', 'wait', T0 + 1, { wait_reason: 'deploy-auth', holder: 'owner', clear_input: 'owner signs in' }),
    ], T0 + 2);
    const { defaultWatchDeps } = await import('@/lib/watch-manager');
    const deps = await defaultWatchDeps();
    await deps.onFired!(watch({ ledgerItem: 'deploy:dev:eeeeeeeeeeee' }), { notice: 'signed-in' });
    const item = store.items('ws-a', { open: true }, Date.now()).items.find((i) => i.itemKey === 'deploy:dev:eeeeeeeeeeee');
    expect(item?.waitReason).toBeNull();
    expect(store.intervalsIn('ws-a', T0, Date.now() + 1).map((row) => [row.item_key, row.reason])).toEqual([['deploy:dev:eeeeeeeeeeee', 'deploy-auth']]);
  });

  it('names a profile only as a whole word', () => {
    expect(namesProfile('aws sso login --profile dev', 'dev')).toBe(true);
    expect(namesProfile('aws sso login --profile dev-qa', 'dev')).toBe(false);
    expect(namesProfile('profile=dev.', 'dev')).toBe(false);
    expect(namesProfile(null, 'dev')).toBe(false);
  });
});
