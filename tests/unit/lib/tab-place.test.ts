import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0045: which plain creates the pool may place, the mode a workspace reads, and the record of each create.

const store = vi.hoisted(() => ({ values: {} as Record<string, string>, fail: false }));
vi.mock('@/lib/fleet-config-store', () => ({
  readFleetConfig: vi.fn(async () => {
    if (store.fail) throw new Error('fleet config unreadable');
    return { values: store.values };
  }),
  valueOf: (state: { values: Record<string, string> }, key: string) => (Object.hasOwn(state.values, key) ? { value: state.values[key] } : null),
}));

const { isPlainPlaceable, notePlainCreate, readTabPlaceMode } = await import('@/lib/tab-place');
const { tabPlaceView } = await import('@/lib/pool-runtime');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  store.values = {};
  store.fail = false;
  delete (globalThis as Record<string, unknown>).__ptPoolRuntime;
});

describe('tab-place (ADR-0045)', () => {
  it.each([
    ['claude-code', null, undefined, true],
    ['claude-code', 'evaluator', undefined, false],
    ['claude-code', null, 'control-plane', false],
    ['claude-code', null, 'product', false],
    ['codex-cli', null, undefined, false],
    ['grok-cli', null, undefined, false],
    ['terminal', null, undefined, false],
  ])('%s with role %s and class %s is placeable: %s', (panelType, role, poolClass, expected) => {
    expect(isPlainPlaceable(panelType, role, poolClass)).toBe(expected);
  });

  it('reads the workspace mode; unset is advise; an unreadable store is here, never a placement on a guess', async () => {
    expect(await readTabPlaceMode('ws-a')).toBe('advise');
    store.values = { 'pool.tab-place.ws-a': 'place' };
    expect(await readTabPlaceMode('ws-a')).toBe('place');
    store.fail = true;
    expect(await readTabPlaceMode('ws-a')).toBe('here');
  });

  it('records a remote placement, a fallback here, and a create here at no room', async () => {
    const placement = { mode: 'place' as const, host: 'host-b', local: false, applied: true, reason: 'most tab room: 3 more', envelope: null };
    notePlainCreate({ mode: 'place', workspaceId: 'ws-a', tabId: 'tab-1', placement }, Promise.resolve({ room: { host: 'host-b', local: false, reason: 'r' }, localFree: 2 }));
    notePlainCreate({ mode: 'place', workspaceId: 'ws-a', tabId: 'tab-2', placement: { ...placement, host: 'host-a', local: true, applied: false, reason: 'fallback: x' } }, Promise.resolve(null));
    notePlainCreate({ mode: 'advise', workspaceId: 'ws-a', tabId: 'tab-3', placement: null }, Promise.resolve({ room: { host: null, local: false, reason: 'no host can take the tab' }, localFree: 0 }));
    await flush();
    expect(tabPlaceView()).toMatchObject({
      advised: 1, placedRemote: 1, here: 2, hereAtNoRoom: 1,
      last: { line: 'pool tab-place: mode=advise workspace=ws-a tab=tab-3 outcome=here local_free=0 at-no-room | no room answer: no host can take the tab' },
    });
  });
});
