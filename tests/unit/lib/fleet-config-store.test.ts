import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FLEET_HISTORY_MAX,
  FleetConfigError,
  checkExpectedVersion,
  checkKey,
  checkValue,
  emptyFleetConfig,
  setValue,
  unsetValue,
} from '@/lib/fleet-config-store';
import type { IFleetConfigSetter, IFleetConfigState } from '@/types/fleet-config';

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const ORCH: IFleetConfigSetter = { workspaceId: 'ws-a', tabId: 'tab-o', admin: false };
const ADMIN: IFleetConfigSetter = { workspaceId: null, tabId: null, admin: true };

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof FleetConfigError ? err.code : `not a FleetConfigError: ${String(err)}`;
  }
};

const set = (s: IFleetConfigState, key: string, value: string, expectedVersion?: number, at = 1000) =>
  setValue(s, { key, value, expectedVersion }, ORCH, at);

describe('fleet config transitions (ADR-0019)', () => {
  it('versions each key from 1, records who and when, and keeps history with old and new values', () => {
    const one = set(emptyFleetConfig(), 'gate.slots', '4');
    const two = set(one.state, 'gate.slots', '6', 1, 2000);
    expect(two.state.values['gate.slots']).toEqual({ value: '6', version: 2, setAt: 2000, setBy: ORCH });
    expect(two.state.history).toEqual([
      { key: 'gate.slots', oldValue: null, newValue: '4', version: 1, at: 1000, by: ORCH },
      { key: 'gate.slots', oldValue: '4', newValue: '6', version: 2, at: 2000, by: ORCH },
    ]);
  });

  it('treats setting the held value as no change: same state, no history, no version', () => {
    const one = set(emptyFleetConfig(), 'gate.slots', '6');
    const again = set(one.state, 'gate.slots', '6');
    expect(again.change).toBeNull();
    expect(again.state).toBe(one.state);
  });

  it('refuses a stale expected version, and 0 means "never set"', () => {
    const one = set(emptyFleetConfig(), 'gate.slots', '4');
    expect(codeOf(() => set(one.state, 'gate.slots', '6', 0))).toBe('config-version-conflict');
    expect(codeOf(() => set(emptyFleetConfig(), 'gate.slots', '6', 1))).toBe('config-version-conflict');
    expect(set(emptyFleetConfig(), 'gate.slots', '6', 0).change?.version).toBe(1);
  });

  it('an unset raises the version, and a later set never repeats a version an --expect-version saw', () => {
    const one = set(emptyFleetConfig(), 'gate.slots', '4');
    const gone = unsetValue(one.state, { key: 'gate.slots' }, ADMIN, 1500);
    expect(gone.state.values['gate.slots']).toBeUndefined();
    expect(gone.change).toMatchObject({ oldValue: '4', newValue: null, version: 2, by: ADMIN });
    expect(codeOf(() => set(gone.state, 'gate.slots', '6', 1))).toBe('config-version-conflict');
    expect(set(gone.state, 'gate.slots', '6', 2).state.values['gate.slots'].version).toBe(3);
  });

  it('refuses to unset a key that is not set, and a stale version on unset', () => {
    expect(codeOf(() => unsetValue(emptyFleetConfig(), { key: 'gate.slots' }, ADMIN, 1))).toBe('config-not-found');
    const one = set(emptyFleetConfig(), 'gate.slots', '4');
    expect(codeOf(() => unsetValue(one.state, { key: 'gate.slots', expectedVersion: 7 }, ADMIN, 1))).toBe('config-version-conflict');
  });

  it('a key named like a built-in property (constructor) is an ordinary key', () => {
    expect(checkKey('constructor')).toBe('constructor');
    expect(codeOf(() => unsetValue(emptyFleetConfig(), { key: 'constructor' }, ADMIN, 1))).toBe('config-not-found');
    const one = set(emptyFleetConfig(), 'constructor', 'x', 0);
    expect(one.state.values.constructor).toEqual({ value: 'x', version: 1, setAt: 1000, setBy: ORCH });
    expect(one.state.versions.constructor).toBe(1);
    const gone = unsetValue(one.state, { key: 'constructor', expectedVersion: 1 }, ADMIN, 2);
    expect(gone.state.versions.constructor).toBe(2);
    expect(Object.hasOwn(gone.state.values, 'constructor')).toBe(false);
  });

  it(`keeps only the last ${FLEET_HISTORY_MAX} changes`, () => {
    let s = emptyFleetConfig();
    for (let i = 1; i <= FLEET_HISTORY_MAX + 5; i++) s = set(s, 'gate.slots', String(i)).state;
    expect(s.history).toHaveLength(FLEET_HISTORY_MAX);
    expect(s.history[0].newValue).toBe('6');
    expect(s.values['gate.slots'].version).toBe(FLEET_HISTORY_MAX + 5);
  });

  it('checks keys, values and expected versions', () => {
    expect(checkKey('gate.slots')).toBe('gate.slots');
    expect(checkKey('tabs.cap-per-workspace.ws-ldhziO')).toBe('tabs.cap-per-workspace.ws-ldhziO');
    expect(checkKey('tabs.cap-per-workspace.ws-a_B-9z')).toBe('tabs.cap-per-workspace.ws-a_B-9z');
    for (const bad of ['Gate.slots', '_gate', 'g', '1gate', 'gate slots', 'gate/slots', `g${'a'.repeat(64)}`, 7]) {
      expect(codeOf(() => checkKey(bad))).toBe('config-invalid');
    }
    expect(checkValue('x'.repeat(256))).toHaveLength(256);
    for (const bad of ['', 'x'.repeat(257), 'six\nseven', 'a\u202Eb', 'a\u2028b', 'a\u2029b', '\ud800', 'a\uE000', 6, null]) {
      expect(codeOf(() => checkValue(bad))).toBe('config-invalid');
    }
    expect(checkExpectedVersion(undefined)).toBeUndefined();
    expect(checkExpectedVersion(0)).toBe(0);
    for (const bad of [-1, 1.5, '3']) expect(codeOf(() => checkExpectedVersion(bad))).toBe('config-invalid');
  });
});

describe('fleet config file store', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (globalThis as Record<string, unknown>).__ptFleetConfigLock;
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-fleet-config-'));
  });
  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('reads an absent file as empty and writes the file 0600', async () => {
    const store = await import('@/lib/fleet-config-store');
    expect(await store.readFleetConfig()).toEqual(emptyFleetConfig());
    await store.mutateFleetConfig((s) => store.setValue(s, { key: 'gate.slots', value: '6' }, ORCH, 1));
    const stat = await fs.stat(store.fleetConfigFile());
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await store.readFleetConfig()).values['gate.slots'].value).toBe('6');
  });

  it('refuses a malformed file rather than reading it as empty, and never overwrites it', async () => {
    const store = await import('@/lib/fleet-config-store');
    await fs.mkdir(path.dirname(store.fleetConfigFile()), { recursive: true });
    const good = (over: Record<string, unknown>) => JSON.stringify({
      values: { 'gate.slots': { value: '6', version: 2, setAt: 1, setBy: {} } }, versions: { 'gate.slots': 2 }, history: [], ...over,
    });
    for (const raw of [
      '{',
      '{"values":{}}',
      '{"values":{"Bad":{"value":"1","version":1,"setBy":{}}},"versions":{},"history":[]}',
      good({ versions: { 'gate.slots': '2' } }),
      good({ versions: {} }),
      good({ versions: { 'gate.slots': 1 } }),
      good({ history: ['x'] }),
    ]) {
      await fs.writeFile(store.fleetConfigFile(), raw);
      await expect(store.readFleetConfig()).rejects.toBeInstanceOf(store.FleetConfigFileError);
      await expect(store.mutateFleetConfig((s) => store.setValue(s, { key: 'gate.slots', value: '6' }, ORCH, 1)))
        .rejects.toBeInstanceOf(store.FleetConfigFileError);
      expect(await fs.readFile(store.fleetConfigFile(), 'utf-8')).toBe(raw);
    }
  });

  it('serialises concurrent writers: two sets with the same expected version, one wins', async () => {
    const store = await import('@/lib/fleet-config-store');
    const results = await Promise.allSettled(['5', '6'].map((value) =>
      store.mutateFleetConfig((s) => store.setValue(s, { key: 'gate.slots', value, expectedVersion: 0 }, ORCH, 1))));
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await store.readFleetConfig()).values['gate.slots'].version).toBe(1);
  });
});
