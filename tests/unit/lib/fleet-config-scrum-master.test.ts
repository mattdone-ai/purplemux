import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { IScrumMasterSnapshot } from '@/lib/scrum-master-access';

// ADR-0045 (rulings 1-5): the Portfolio Scrum Master's verified tab writes the per-workspace cap and plain-create mode
// of a workspace in its selection, and a host's tab ceiling, with a reason and the version it read; every other
// admin-only key stays with the admin token, and a write is refused when the selection changes under it.

let directory = '';
let home: ReturnType<typeof vi.spyOn>;

const tabCaller = (workspaceId: string, tabId: string, verified = true): ICaller => ({
  scope: { type: 'workspace', workspaceId, tabId, ...(verified ? { tabVerified: true } : {}) } as ICaller['scope'],
  workspaceId, tabId, tabName: tabId, verified, identity: verified ? 'launch' : 'session', admin: false,
});
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const sm = tabCaller('ws-pm', 'tab-sm');

const selection = (over: Partial<IScrumMasterSnapshot> = {}): IScrumMasterSnapshot => ({
  actor: 'owner', updatedAt: 1000, selection: { managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm', workspaceIds: ['ws-a', 'ws-b'] }, ...over,
});

/** The real predicate's answer for a caller, as the test sets it: only the selection's manager tab, verified, is the SM. */
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

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-sm-keys-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
  current = selection();
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('the Portfolio Scrum Master writes its limit keys (ADR-0045)', () => {
  it.each([
    ['tabs.cap-per-workspace.ws-a', '12'],
    ['pool.tab-place.ws-b', 'place'],
    ['pool.slots.host-a.tab', '10'],
  ])('%s=%s with a reason and the version it read: written, in history with the reason, audited with the selection', async (key, value) => {
    const { putValue, readValues } = await import('@/lib/fleet-config-http');
    const got = await putValue(sm, key, { value, reason: 'shift tabs off the control host', expectedVersion: 0 }, authority());
    expect(got).toMatchObject({ key, version: 1, changed: true, value: { value, setBy: { workspaceId: 'ws-pm', tabId: 'tab-sm', admin: false, role: 'portfolio-scrum-master' } } });
    expect(await readValues({ history: '1' })).toMatchObject({ history: [{ key, newValue: value, reason: 'shift tabs off the control host', by: { role: 'portfolio-scrum-master' } }] });
    expect(auditLines()).toEqual([expect.objectContaining({
      event: 'fleet-config-set', key, newValue: value, reason: 'shift tabs off the control host',
      by: expect.objectContaining({ workspaceId: 'ws-pm', tabId: 'tab-sm', role: 'portfolio-scrum-master', verified: true, identity: 'launch' }),
      selection: { actor: 'owner', updatedAt: 1000, managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm' },
    })]);
  });

  it('an unset by the Scrum Master needs the same reason and version, and is audited', async () => {
    const { deleteValue, putValue } = await import('@/lib/fleet-config-http');
    await putValue(admin, 'pool.slots.host-a.tab', { value: '9' }, authority());
    await expect(deleteValue(sm, 'pool.slots.host-a.tab', { expectedVersion: 1 }, authority())).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('needs a reason') });
    const gone = await deleteValue(sm, 'pool.slots.host-a.tab', { expectedVersion: 1, reason: 'the measure decides now' }, authority());
    expect(gone.unset).toMatchObject({ newValue: null, reason: 'the measure decides now', by: { role: 'portfolio-scrum-master' } });
    expect(auditLines().at(-1)).toMatchObject({ event: 'fleet-config-unset', reason: 'the measure decides now' });
  });

  it.each([
    ['pool.mode', 'enforce'],
    ['pool.slots.host-a.gate', '2'],
    ['pool.slots.host-a.build', '2'],
    ['tabs.cap-per-workspace', '20'],
    ['pool.budget.host-a.reserve-threads', '0'],
    ['pool.budget.host-a.reserve-mem-gb', '0'],
    ['pool.budget.host-a.max-load', '99'],
    ['pool.envelope.tab.threads', '1'],
    ['remote.hosts', 'host-c'],
    ['mission.question-format.min-version', '2'],
  ])('%s stays with the admin token: 403 names the forms the Scrum Master writes', async (key, value) => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(sm, key, { value, reason: 'r', expectedVersion: 0 }, authority())).rejects.toMatchObject({
      code: 'forbidden', message: expect.stringContaining('the Portfolio Scrum Master writes tabs.cap-per-workspace.<workspaceId>, pool.tab-place.<workspaceId>'),
    });
    // Review r1: the refusal is audited, with the key, the code and kind and the reason; never the value.
    expect(auditLines()).toEqual([{
      at: expect.any(String), event: 'fleet-config-refused', action: 'set', key, code: 'forbidden', refusal: 'admin-only', reason: 'r', expectedVersion: 0,
      by: { workspaceId: 'ws-pm', tabId: 'tab-sm', verified: true, identity: 'launch', role: 'portfolio-scrum-master' },
      selection: { actor: 'owner', updatedAt: 1000, managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm' },
    }]);
    expect(JSON.stringify(auditLines())).not.toContain(`"${value}"`);
  });

  it('a workspace outside the portfolio selection is refused for the cap and the plain-create mode', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    for (const key of ['tabs.cap-per-workspace.ws-z', 'pool.tab-place.ws-z']) {
      await expect(putValue(sm, key, { value: key.startsWith('tabs') ? '3' : 'here', reason: 'r', expectedVersion: 0 }, authority())).rejects.toMatchObject({
        code: 'forbidden', message: expect.stringContaining('ws-z, which is not in the portfolio selection (ws-a, ws-b)'),
      });
    }
  });

  it('a write without a reason or without the version it read is 400, and nothing is written', async () => {
    const { putValue, readValues } = await import('@/lib/fleet-config-http');
    await expect(putValue(sm, 'pool.slots.host-a.tab', { value: '4', expectedVersion: 0 }, authority())).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('needs a reason') });
    await expect(putValue(sm, 'pool.slots.host-a.tab', { value: '4', reason: 'r' }, authority())).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('needs the version it read') });
    await expect(putValue(sm, 'pool.slots.host-a.tab', { value: '4', reason: '', expectedVersion: 0 }, authority())).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('reason must be 1..500') });
    await expect(putValue(sm, 'pool.slots.host-a.tab', { value: '4', reason: 'x'.repeat(501), expectedVersion: 0 }, authority())).rejects.toMatchObject({ code: 'config-invalid' });
    expect(await readValues({})).toEqual({ values: {} });
  });

  it('a stale version is a conflict: a Scrum Master write never overwrites an owner value it did not read', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await putValue(admin, 'tabs.cap-per-workspace.ws-a', { value: '6', reason: 'owner cap' }, authority());
    await expect(putValue(sm, 'tabs.cap-per-workspace.ws-a', { value: '12', reason: 'r', expectedVersion: 0 }, authority())).rejects.toMatchObject({ code: 'config-version-conflict' });
    expect(await putValue(sm, 'tabs.cap-per-workspace.ws-a', { value: '12', reason: 'r', expectedVersion: 1 }, authority())).toMatchObject({ version: 2 });
  });

  it('a forged or stale Scrum Master is not one: an unverified session, another orchestrator, a respawned tab', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    const body = { value: '4', reason: 'r', expectedVersion: 0 };
    await expect(putValue(tabCaller('ws-pm', 'tab-sm', false), 'pool.slots.host-a.tab', body, authority())).rejects.toMatchObject({
      code: 'forbidden', message: expect.stringContaining("the admin token or the Portfolio Scrum Master's verified tab"),
    });
    await expect(putValue(tabCaller('ws-a', 'tab-o'), 'pool.slots.host-a.tab', body, authority())).rejects.toMatchObject({ code: 'forbidden' });
    current = null;
    await expect(putValue(sm, 'pool.slots.host-a.tab', body, authority())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the selection changing between the check and the write refuses it inside the store lock', async () => {
    const { putValue, readValues } = await import('@/lib/fleet-config-http');
    const a = authority();
    a.scrumMaster.mockImplementationOnce(async () => {
      const snapshot = current;
      current = selection({ updatedAt: 2000 });
      return snapshot;
    });
    await expect(putValue(sm, 'pool.slots.host-a.tab', { value: '4', reason: 'r', expectedVersion: 0 }, a)).rejects.toMatchObject({
      code: 'forbidden', message: expect.stringContaining('the portfolio selection changed'),
    });
    current = selection();
    a.scrumMaster.mockImplementationOnce(async () => {
      const snapshot = current;
      current = selection({ selection: { managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm', workspaceIds: ['ws-b'] } });
      return snapshot;
    });
    await expect(putValue(sm, 'tabs.cap-per-workspace.ws-a', { value: '4', reason: 'r', expectedVersion: 0 }, a)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await readValues({})).toEqual({ values: {} });
  });

  it('the admin token is unchanged: no reason or version needed, a reason is kept when given', async () => {
    const { putValue, readValues } = await import('@/lib/fleet-config-http');
    expect(await putValue(admin, 'pool.mode', { value: 'enforce' }, authority())).toMatchObject({ version: 1 });
    await putValue(admin, 'pool.slots.host-a.tab', { value: '8', reason: 'owner ceiling' }, authority());
    expect(await readValues({ history: '1', key: 'pool.slots.host-a.tab' })).toMatchObject({ history: [{ reason: 'owner ceiling', by: { admin: true } }] });
    expect(auditLines().map((l) => l.by)).toEqual([expect.not.objectContaining({ role: expect.anything() }), expect.not.objectContaining({ role: expect.anything() })]);
  });

  it('a workspace orchestrator is unchanged: its own keys, never an admin-only one', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    const orchestrator = tabCaller('ws-a', 'tab-o');
    expect(await putValue(orchestrator, 'context.rotate-at-tokens', { value: '300000' }, authority())).toMatchObject({ version: 1 });
    await expect(putValue(orchestrator, 'tabs.cap-per-workspace.ws-a', { value: '9', reason: 'r', expectedVersion: 0 }, authority())).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('pool.tab-place is checked when written; remote.hosts may not name local', async () => {
    const { putValue } = await import('@/lib/fleet-config-http');
    await expect(putValue(admin, 'pool.tab-place.ws-a', { value: 'auto' }, authority())).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('here, advise, place') });
    await expect(putValue(admin, 'pool.tab-place.ws a', { value: 'here' }, authority())).rejects.toMatchObject({ code: 'config-invalid' });
    await expect(putValue(admin, 'remote.hosts', { value: 'host-b,local' }, authority())).rejects.toMatchObject({ code: 'config-invalid', message: expect.stringContaining('--host local') });
  });

  describe('every refused Scrum Master write is audited, one line per refusal (review r1)', () => {
    const refused = () => auditLines().filter((l) => l.event === 'fleet-config-refused');

    it.each<[string, () => Promise<unknown>, string, string, boolean]>([
      ['a forged, unverified caller presenting a Scrum Master key', async () => (await import('@/lib/fleet-config-http')).putValue(tabCaller('ws-pm', 'tab-sm', false), 'pool.slots.host-a.tab', { value: '4', reason: 'r', expectedVersion: 0 }, authority()), 'forbidden', 'not-scrum-master', false],
      ['another verified orchestrator on a Scrum Master key', async () => (await import('@/lib/fleet-config-http')).putValue(tabCaller('ws-a', 'tab-o'), 'pool.slots.host-a.tab', { value: '4', reason: 'r', expectedVersion: 0 }, authority()), 'forbidden', 'not-scrum-master', false],
      ['a workspace outside the selection', async () => (await import('@/lib/fleet-config-http')).putValue(sm, 'pool.tab-place.ws-z', { value: 'here', reason: 'r', expectedVersion: 0 }, authority()), 'forbidden', 'outside-selection', true],
      ['no reason', async () => (await import('@/lib/fleet-config-http')).putValue(sm, 'pool.slots.host-a.tab', { value: '4', expectedVersion: 0 }, authority()), 'config-invalid', 'reason-missing', true],
      ['a reason out of range', async () => (await import('@/lib/fleet-config-http')).putValue(sm, 'pool.slots.host-a.tab', { value: '4', reason: '', expectedVersion: 0 }, authority()), 'config-invalid', 'reason-invalid', false],
      ['no version', async () => (await import('@/lib/fleet-config-http')).putValue(sm, 'pool.slots.host-a.tab', { value: '4', reason: 'r' }, authority()), 'config-invalid', 'version-missing', true],
      ['a stale version (409)', async () => (await import('@/lib/fleet-config-http')).putValue(sm, 'pool.slots.host-a.tab', { value: '4', reason: 'r', expectedVersion: 3 }, authority()), 'config-version-conflict', 'version-conflict', true],
      ['an invalid value', async () => (await import('@/lib/fleet-config-http')).putValue(sm, 'pool.tab-place.ws-a', { value: 'auto', reason: 'r', expectedVersion: 0 }, authority()), 'config-invalid', 'invalid', true],
      ['an unset of a key that is not set', async () => (await import('@/lib/fleet-config-http')).deleteValue(sm, 'pool.slots.host-a.tab', { reason: 'r', expectedVersion: 0 }, authority()), 'config-not-found', 'not-found', true],
    ])('%s: refused, and one audit line names the key, the code, the kind and the reason', async (_name, write, code, refusal, asScrumMaster) => {
      await expect(write()).rejects.toMatchObject({ code });
      const lines = refused();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ code, refusal, key: expect.stringMatching(/^(pool|tabs)\./) });
      expect(lines[0]).not.toHaveProperty('value');
      expect(lines[0].by).toEqual(asScrumMaster ? expect.objectContaining({ role: 'portfolio-scrum-master' }) : expect.not.objectContaining({ role: expect.anything() }));
      expect(lines[0].reason).toBe(refusal === 'reason-missing' ? null : refusal === 'reason-invalid' ? '' : 'r');
    });

    it('the selection changing inside the store lock is audited with the selection it was judged on', async () => {
      const { putValue } = await import('@/lib/fleet-config-http');
      const a = authority();
      a.scrumMaster.mockImplementationOnce(async () => {
        const snapshot = current;
        current = selection({ updatedAt: 2000 });
        return snapshot;
      });
      await expect(putValue(sm, 'pool.slots.host-a.tab', { value: '4', reason: 'move room', expectedVersion: 0 }, a)).rejects.toMatchObject({ code: 'forbidden' });
      expect(refused()).toEqual([expect.objectContaining({
        refusal: 'selection-changed', key: 'pool.slots.host-a.tab', reason: 'move room', selection: expect.objectContaining({ updatedAt: 1000 }),
        by: expect.objectContaining({ role: 'portfolio-scrum-master' }),
      })]);
    });

    it('a same-value set by the Scrum Master answers changed:false and is audited with its reason', async () => {
      const { putValue } = await import('@/lib/fleet-config-http');
      await putValue(sm, 'pool.slots.host-a.tab', { value: '6', reason: 'first', expectedVersion: 0 }, authority());
      expect(await putValue(sm, 'pool.slots.host-a.tab', { value: '6', reason: 'still right', expectedVersion: 1 }, authority())).toMatchObject({ changed: false, version: 1 });
      expect(auditLines().at(-1)).toEqual({
        at: expect.any(String), event: 'fleet-config-unchanged', key: 'pool.slots.host-a.tab', value: '6', version: 1, reason: 'still right',
        by: { workspaceId: 'ws-pm', tabId: 'tab-sm', verified: true, identity: 'launch', role: 'portfolio-scrum-master' },
        selection: { actor: 'owner', updatedAt: 1000, managerWorkspaceId: 'ws-pm', managerTabId: 'tab-sm' },
      });
    });

    it('stays out: the admin token\'s refusals, an unverified caller on a key no Scrum Master writes, and an admin no-op', async () => {
      const { putValue } = await import('@/lib/fleet-config-http');
      await expect(putValue(admin, 'pool.tab-place.ws-a', { value: 'auto' }, authority())).rejects.toMatchObject({ code: 'config-invalid' });
      await expect(putValue(tabCaller('ws-a', 'tab-x', false), 'remote.hosts', { value: 'host-c' }, authority())).rejects.toMatchObject({ code: 'forbidden' });
      await putValue(admin, 'pool.mode', { value: 'shadow' }, authority());
      await putValue(admin, 'pool.mode', { value: 'shadow' }, authority());
      expect(auditLines().map((l) => l.event)).toEqual(['fleet-config-set']);
    });
  });
});
