import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IScrumMasterSnapshot } from '@/lib/scrum-master-access';

// ADR-0047 (owner order, PMUX-PSM-RIGHTS): the Portfolio Scrum Master's verified tab writes a known host's callback
// URL, with a reason and the version it read, and only a tailnet value. Every other tab is refused; the admin token
// writes any value it wrote before. The suffix and the addresses here are examples only.

let directory = '';
let home: ReturnType<typeof vi.spyOn>;

const SUFFIX = 'example-net.ts.net';
const tabCaller = (workspaceId: string, tabId: string, verified = true): ICaller => ({
  scope: { type: 'workspace', workspaceId, tabId, ...(verified ? { tabVerified: true } : {}) } as ICaller['scope'],
  workspaceId, tabId, tabName: tabId, verified, identity: verified ? 'launch' : 'session', admin: false,
});
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const sm = tabCaller('ws-pm', 'tab-sm');

let current: IScrumMasterSnapshot | null;
const authority = () => ({
  isWorkspaceOrchestrator: vi.fn(async (_ws: string, tabId: string) => tabId === 'tab-o' || tabId === 'tab-sm'),
  now: () => 5,
  scrumMaster: vi.fn(async (caller: ICaller) => (current && caller.verified && caller.workspaceId === current.selection.managerWorkspaceId
    && caller.tabId === current.selection.managerTabId ? current : null)),
  currentSelection: () => current,
});

const auditLines = (): Record<string, unknown>[] => {
  const file = path.join(directory, '.purplemux', 'audit', 'coordination.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

const KEY = 'remote.callback-url.host-b';
const write = (caller: ICaller, value: string, over: Record<string, unknown> = {}) => async () => {
  const { putValue } = await import('@/lib/fleet-config-http');
  return putValue(caller, KEY, { value, reason: 'hooks of host-b post live', expectedVersion: 0, ...over }, authority());
};

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-psm-callback-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
  current = { actor: 'owner', updatedAt: 1000, selection: { managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm', workspaceIds: ['ws-a'] } };
  const { putValue } = await import('@/lib/fleet-config-http');
  await putValue(admin, 'remote.hosts', { value: 'host-b,host-c' }, authority());
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

const setSuffix = async () => {
  const { putValue } = await import('@/lib/fleet-config-http');
  await putValue(admin, 'remote.tailnet-suffix', { value: SUFFIX }, authority());
};

describe('the Portfolio Scrum Master writes a known host\'s callback URL (ADR-0047)', () => {
  it('accepts <name>.<suffix>:<port> once the admin set the suffix: written with its role, audited with the selection', async () => {
    await setSuffix();
    const got = await write(sm, `http://control.${SUFFIX}:8022`)();
    expect(got).toMatchObject({ key: KEY, version: 1, changed: true, value: { value: `http://control.${SUFFIX}:8022`, setBy: { role: 'portfolio-scrum-master' } } });
    expect(auditLines().at(-1)).toMatchObject({
      event: 'fleet-config-set', key: KEY, reason: 'hooks of host-b post live',
      by: expect.objectContaining({ workspaceId: 'ws-pm', tabId: 'tab-sm', role: 'portfolio-scrum-master' }),
      selection: { actor: 'owner', updatedAt: 1000, managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm' },
    });
  });

  it('accepts a 100.64.0.0/10 address with a port, with or without the suffix set', async () => {
    expect(await write(sm, 'http://100.64.0.10:8022')()).toMatchObject({ version: 1 });
    await setSuffix();
    expect(await write(sm, 'https://100.127.255.1:8443', { expectedVersion: 1 })()).toMatchObject({ version: 2 });
  });

  it.each([
    ['an outside URL', 'https://pmux.example.com:8443', 'is not <name>.example-net.ts.net'],
    ['a name of another tailnet', 'http://control.other-net.ts.net:8022', 'is not <name>.example-net.ts.net'],
    ['a name two labels under the suffix', `http://a.control.${SUFFIX}:8022`, 'is not <name>.example-net.ts.net'],
    ['an address outside 100.64.0.0/10', 'https://192.0.2.10:8443', 'is not in 100.64.0.0/10'],
    ['a URL with no port', `https://control.${SUFFIX}`, 'with the port'],
  ])('refuses %s with a named reason, audited as outside-tailnet', async (_label, value, reason) => {
    await setSuffix();
    await expect(write(sm, value)()).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining(reason) });
    expect(auditLines().at(-1)).toMatchObject({ event: 'fleet-config-refused', key: KEY, refusal: 'outside-tailnet', by: { role: 'portfolio-scrum-master' } });
  });

  it('refuses a name while remote.tailnet-suffix is unset: no name form is accepted', async () => {
    await expect(write(sm, `http://control.${SUFFIX}:8022`)()).rejects.toMatchObject({
      code: 'config-invalid', message: expect.stringContaining('remote.tailnet-suffix is unset'),
    });
  });

  it('refuses a host the pool does not know', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(sm, 'remote.callback-url.host-z', { value: 'http://100.64.0.10:8022', reason: 'r', expectedVersion: 0 }, authority()))
      .rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('host-z, which is not on remote.hosts (host-b, host-c)') });
    expect(auditLines().at(-1)).toMatchObject({ refusal: 'unknown-host' });
  });

  it('refuses a write with no reason, and one with a stale version', async () => {
    await expect(write(sm, 'http://100.64.0.10:8022', { reason: undefined })()).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('needs a reason') });
    await expect(write(sm, 'http://100.64.0.10:8022', { expectedVersion: undefined })()).rejects.toMatchObject({ message: expect.stringContaining('needs the version it read') });
    await write(admin, 'http://100.64.0.11:8022', { reason: undefined, expectedVersion: undefined })();
    await expect(write(sm, 'http://100.64.0.10:8022', { expectedVersion: 0 })()).rejects.toMatchObject({ code: 'config-version-conflict' });
  });

  it.each([
    ['an orchestrator tab', tabCaller('ws-a', 'tab-o')],
    ['a worker tab', tabCaller('ws-a', 'tab-w')],
    ['the Scrum Master\'s tab unverified', tabCaller('ws-pm', 'tab-sm', false)],
  ])('refuses %s', async (_label, caller) => {
    await expect(write(caller, 'http://100.64.0.10:8022')()).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the admin token still writes any value it wrote before, with no reason or version', async () => {
    expect(await write(admin, 'https://pmux.example.com', { reason: undefined, expectedVersion: undefined })()).toMatchObject({ version: 1 });
    const { putValue } = await import('@/lib/fleet-config-http');
    expect(await putValue(admin, 'remote.callback-url.host-z', { value: 'https://pmux.example.com' }, authority())).toMatchObject({ version: 1 });
  });
});

// r2 #1/#2: the guard pinned value by value. Each refused value is refused by putValue (whichever check fires first)
// AND by the Scrum Master's own check called directly, so the guard holds without the general check in front of it.
describe('the value guard, pinned (ADR-0047 r2)', () => {
  it.each([
    ['no dot boundary before the suffix', `http://evil-${SUFFIX}:8022`],
    ['userinfo', `http://x@control.${SUFFIX}:8022`],
    ['an IPv6 literal', 'http://[fd00::1]:8022'],
    ['a trailing dot', `http://control.${SUFFIX}.:8022`],
    ['upper case', `http://Control.${SUFFIX}:8022`],
    ['a decimal IP form', 'http://1681915905:8022'],
    ['an octal IP form', 'http://0144.0100.0.1:8022'],
    ['a leading-zero octet', 'http://100.064.0.1:8022'],
    ['the address after the range', 'http://100.128.0.1:8022'],
    ['the address before the range', 'http://100.63.255.255:8022'],
    ['port 0', 'http://100.64.0.1:0'],
    ['port 65536', 'http://100.64.0.1:65536'],
    ['a path', 'http://100.64.0.1:8022/api'],
    ['a query', 'http://100.64.0.1:8022?x=1'],
  ])('refuses %s: %s', async (_label, value) => {
    await setSuffix();
    const { scrumMasterCallbackRefusal } = await import('@/lib/remote-host');
    expect(scrumMasterCallbackRefusal(value, SUFFIX)).not.toBeNull();
    await expect(write(sm, value)()).rejects.toMatchObject({ code: 'config-invalid' });
  });

  it.each(['http://100.64.0.0:8022', 'http://100.127.255.255:8022', 'https://100.100.1.1:1', 'http://100.64.0.1:65535'])('accepts the range end %s', async (value) => {
    const { scrumMasterCallbackRefusal } = await import('@/lib/remote-host');
    expect(scrumMasterCallbackRefusal(value, null)).toBeNull();
    expect(await write(sm, value)()).toMatchObject({ version: 1 });
  });

  it('refuses a leading-zero octet on its own, where the shared address test would take it (r2 #2)', async () => {
    const { isCanonicalTailnetAddress, isTailnetAddress, scrumMasterCallbackRefusal } = await import('@/lib/remote-host');
    expect(isTailnetAddress('100.064.0.1')).toBe(true);
    expect(isCanonicalTailnetAddress('100.064.0.1')).toBe(false);
    expect(scrumMasterCallbackRefusal('http://100.064.0.1:8022', null)).toContain('is not in 100.64.0.0/10');
  });
});

describe('remote.tailnet-suffix (ADR-0047)', () => {
  it('is admin-only: the Scrum Master is refused', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(sm, 'remote.tailnet-suffix', { value: SUFFIX, reason: 'r', expectedVersion: 0 }, authority())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it.each(['ts.net', 'net', 'Example.ts.net', 'a..ts.net', '-a.ts.net', '.example-net.ts.net'])('refuses %j', async (value) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, 'remote.tailnet-suffix', { value }, authority())).rejects.toMatchObject({ code: 'config-invalid' });
  });
});
