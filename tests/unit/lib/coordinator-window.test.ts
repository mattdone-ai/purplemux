import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COORDINATOR_WINDOW_MS,
  CoordinatorWindow,
  INBOX_HEADS_TTL_MS,
  WINDOWED_INBOX_KINDS,
  WINDOW_DEFERRAL,
  isWindowExempt,
} from '@/lib/coordinator-window';
import { InboxDispatcher, registerInboxPreflight, type IInboxDispatcherDeps } from '@/lib/inbox-dispatcher';
import { INBOX_MAX_REFUSALS, dueItems, enqueueInState, windowHeads } from '@/lib/inbox-store';
import { LedgerStore } from '@/lib/ledger-store';
import { TabEventRouter, appendDelivered, type ITabEventRoute } from '@/lib/tab-event-router';
import type { IInboxItem, IInboxState, TInboxKind } from '@/types/inbox';
import type { IClientTabStatusEntry } from '@/types/status';
import type { ITab } from '@/types/terminal';

// F6 change 3, as the design ruling corrected it (2026-11-10): a coordinator gets at most one window-governed wake per
// 10 min; five kinds skip the window; a deferral spends no refusal budget; the oldest waiter takes the next window.

const T0 = Date.UTC(2026, 10, 10, 0, 0, 0);
const MIN = 60_000;
const WS = 'ws-1';
const C = 'tab-c';
const W = 'tab-w';

describe('isWindowExempt (ruling Q1)', () => {
  it.each([
    ['turn-marker', ['BLOCKED: the gate is red'], true],
    ['turn-marker', ['NEEDS-DECISION: which of two'], true],
    ['turn-marker', ['READY-TO-MERGE: PR #1', 'DONE: shipped'], false],
    ['turn-marker', ['DONE: shipped; BLOCKED: is quoted, not the verdict'], false],
    ['turn-marker', ['CHECKPOINTED: handoff'], false],
    ['turn-marker', undefined, false],
    ['rotate', undefined, true],
    ['standing-order', undefined, true],
    ['mission', undefined, true],
    ['resume', undefined, true],
    ['note', undefined, false],
    ['watch', undefined, false],
    ['alarm', undefined, false],
    ['red-main', undefined, false],
    ['bg-completed', undefined, false],
    ['needs-input', undefined, false],
    ['tab-send', undefined, false],
  ] as const)('%s %j skips the window: %s', (kind, lines, exempt) => {
    expect(isWindowExempt(kind, lines)).toBe(exempt);
  });
});

describe('CoordinatorWindow', () => {
  const make = (over: Partial<{ ledger: number | null | (() => number | null); digest: number | null }> = {}) => {
    let now = T0;
    const window = new CoordinatorWindow({
      now: () => now,
      isCoordinator: async (_ws, tab) => tab === C,
      lastGoverned: () => (typeof over.ledger === 'function' ? over.ledger() : over.ledger ?? null),
      oldestDigestAt: () => over.digest ?? null,
    });
    return { window, at: (ms: number) => { now = ms; } };
  };

  it('is open with no governed paste, and opens 10 min after the later of the ledger row and the claim', () => {
    const { window, at } = make({ ledger: T0 - 4 * MIN });
    expect(window.openAt(WS, C)).toBe(T0 + 6 * MIN);
    expect(window.isOpen(WS, C)).toBe(false);
    at(T0 + 1 * MIN);
    window.claim(WS, C);
    expect(window.openAt(WS, C)).toBe(T0 + 11 * MIN);
    at(T0 + 11 * MIN);
    expect(window.isOpen(WS, C)).toBe(true);
    expect(make().window.isOpen(WS, C)).toBe(true);
  });

  it('reads only the claim when the ledger cannot be read', () => {
    const { window } = make({ ledger: () => { throw new Error('ledger locked'); } });
    expect(window.isOpen(WS, C)).toBe(true);
    window.claim(WS, C);
    expect(window.openAt(WS, C)).toBe(T0 + COORDINATOR_WINDOW_MS);
  });

  it('review nit 3: inbox heads the inbox stopped refreshing no longer hold the digest back', () => {
    const { window, at } = make({ digest: T0 + 5_000 });
    window.setInboxHeads(new Map([[`${WS}/${C}`, T0]]));
    expect(window.digestTurn(WS, C)).toBe(false);
    at(T0 + INBOX_HEADS_TTL_MS);
    expect(window.digestTurn(WS, C)).toBe(false);
    at(T0 + INBOX_HEADS_TTL_MS + 1);
    expect(window.digestTurn(WS, C)).toBe(true);
  });

  it('gives the next window to whichever waited longer: the digest, or the first inbox item (ruling 3)', () => {
    const { window } = make({ digest: T0 + 5_000 });
    expect(window.digestTurn(WS, C)).toBe(true);
    window.setInboxHeads(new Map([[`${WS}/${C}`, T0]]));
    expect(window.digestTurn(WS, C)).toBe(false);
    expect(window.inboxTurn(WS, C, T0)).toBe(true);
    expect(window.inboxTurn(WS, C, T0 + 6_000)).toBe(false);
    // A tie goes to the digest.
    window.setInboxHeads(new Map([[`${WS}/${C}`, T0 + 5_000]]));
    expect(window.digestTurn(WS, C)).toBe(true);
    expect(window.inboxTurn(WS, C, T0 + 5_000)).toBe(false);
  });
});

// ─── the inbox ───────────────────────────────────────────────────────────

const EMPTY_CLAUDE = 'output\n────────\n❯ \n────────\n';

const inbox = (opts: { coordinator?: boolean; busy?: boolean; digestAt?: number | null } = {}) => {
  const world = { clock: T0, state: { items: [] } as IInboxState, busy: opts.busy ?? false, digestAt: opts.digestAt ?? null as number | null, ledger: null as number | null };
  const window = new CoordinatorWindow({
    now: () => world.clock,
    isCoordinator: async (_ws, tab) => (opts.coordinator ?? true) && tab === C,
    lastGoverned: () => world.ledger,
    oldestDigestAt: () => world.digestAt,
  });
  const typed: string[] = [];
  const deps: IInboxDispatcherDeps = {
    now: () => world.clock,
    mutate: async (fn) => {
      const { state, value } = fn(world.state);
      world.state = state;
      return value;
    },
    findTab: async (_ws, tabId): Promise<ITab> => ({ id: tabId, name: tabId, order: 0, sessionName: `pt-${tabId}`, panelType: 'claude-code' }),
    tabGone: async () => false,
    hasSession: async () => true,
    status: () => ({ cliState: world.busy ? 'busy' : 'idle', permissionRequest: null, turnEnd: null } as unknown as IClientTabStatusEntry),
    waitingAtPrompt: () => false,
    halted: () => false,
    capture: async () => EMPTY_CLAUDE,
    withDispatchLock: async (_ws, _tab, work) => work(async () => ({ ok: true }) as never),
    deliver: async (_session, line) => { typed.push(line); },
    isPending: async () => false,
    window: () => window,
  };
  const dispatcher = new InboxDispatcher(deps);
  const add = (kind: TInboxKind, key: string, fields: Record<string, unknown>, target = C): IInboxItem => {
    const result = enqueueInState(world.state, { kind, targetWorkspaceId: WS, targetTabId: target, dedupeKey: key, fields } as never,
      world.clock, () => `i-${key}`);
    world.state = result.state;
    return result.item;
  };
  const watch = (key: string, target = C) => add('watch', key, { watchId: `w-${key}0000`, target: 'merge:o/r', notice: 'free' }, target);
  const resume = (key: string) => add('resume', key, { resumeId: `r-${key}0000` });
  const item = (id: string) => world.state.items.find((i) => i.id === id)!;
  return { world, window, dispatcher, typed, watch, resume, item };
};

describe('the inbox under a coordinator window (ruling, changes 2, 5, 6)', () => {
  it('defers a windowed item while the window is shut: notBefore = window end, attempts unchanged, nothing typed', async () => {
    const { world, window, dispatcher, typed, watch, item } = inbox();
    window.claim(WS, C);
    const w = watch('a1');
    world.clock += 1 * MIN;
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item(w.id)).toMatchObject({ state: 'queued', attempts: 0, notBefore: T0 + 10 * MIN, lastRefusal: `${WINDOW_DEFERRAL}540s` });
    world.clock = T0 + 10 * MIN;
    await dispatcher.tick();
    expect(typed).toHaveLength(1);
    expect(item(w.id).state).toBe('delivered');
    // The delivery claimed the window: the next windowed item waits 10 min from it.
    const next = watch('a2');
    world.clock += 2_000;
    await dispatcher.tick();
    expect(item(next.id)).toMatchObject({ state: 'queued', attempts: 0, notBefore: T0 + 20 * MIN });
  });

  it('never holds an item for deferrals: 200 deferrals spend none of the 30-refusal budget', async () => {
    const { world, window, dispatcher, watch, item } = inbox();
    const w = watch('b1');
    for (let i = 0; i < 200; i++) {
      window.claim(WS, C);
      world.clock += 3_000;
      await dispatcher.tick();
    }
    expect(200).toBeGreaterThan(INBOX_MAX_REFUSALS);
    expect(item(w.id)).toMatchObject({ state: 'queued', attempts: 0 });
  });

  it('checks the window before the preflight: a note preflight is not called while the window is shut (adversarial 2)', async () => {
    const { world, window, dispatcher, typed, item } = inbox();
    const preflight = vi.fn(async () => ({ ok: true as const }));
    const unregister = registerInboxPreflight('note', preflight);
    try {
      window.claim(WS, C);
      const result = enqueueInState(world.state, {
        kind: 'note', targetWorkspaceId: WS, targetTabId: C, dedupeKey: 'note:n-go000001:delivered:tab-c',
        fields: { noteId: 'n-go000001', fromWorkspaceId: 'ws-zz', fromTabId: 'tab-sm', sentAt: T0, event: 'delivered' },
      }, world.clock, () => 'i-go');
      world.state = result.state;
      world.busy = true;
      for (let minute = 1; minute < 10; minute++) {
        world.clock = T0 + minute * MIN;
        await dispatcher.tick();
      }
      expect(preflight).not.toHaveBeenCalled();
      world.busy = false;
      world.clock = T0 + 10 * MIN;
      await dispatcher.tick();
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(typed).toHaveLength(1);
      expect(item('i-go').state).toBe('delivered');
    } finally {
      unregister();
    }
  });

  it('lets a resume (and a mission) skip the window and overtake a head that waits only on it', async () => {
    const { world, window, dispatcher, typed, watch, resume, item } = inbox();
    window.claim(WS, C);
    const w = watch('c1');
    world.clock += 2_000;
    await dispatcher.tick();
    expect(item(w.id).lastRefusal).toMatch(/^coordinator-window:/);
    const r = resume('c2');
    world.clock += 2_000;
    await dispatcher.tick();
    expect(typed).toEqual([expect.stringContaining('[purplemux resume')]);
    expect(item(r.id).state).toBe('delivered');
    expect(item(w.id).state).toBe('queued');
    // A skipping paste neither reads nor resets the window: the watch still opens at T0 + 10 min.
    world.clock = T0 + 10 * MIN;
    await dispatcher.tick();
    expect(item(w.id).state).toBe('delivered');
  });

  it('a later item never overtakes a head that waits on something else than the window', () => {
    const now = T0;
    let state: IInboxState = { items: [] };
    for (const [kind, key, fields] of [
      ['watch', 'd1', { watchId: 'w-d10000', target: 'merge:o/r', notice: 'free' }],
      ['resume', 'd2', { resumeId: 'r-d20000' }],
    ] as const) {
      state = enqueueInState(state, { kind, targetWorkspaceId: WS, targetTabId: C, dedupeKey: key, fields } as never, now, () => `i-${key}`).state;
    }
    state = { items: state.items.map((i) => (i.id === 'i-d1' ? { ...i, lastRefusal: 'composer-not-ready:busy', notBefore: now } : i)) };
    expect(dueItems(state, now, () => false).map((i) => i.id)).toEqual(['i-d1']);
    state = { items: state.items.map((i) => (i.id === 'i-d1' ? { ...i, lastRefusal: `${WINDOW_DEFERRAL}60s` } : i)) };
    expect(dueItems(state, now, () => false).map((i) => i.id)).toEqual(['i-d2']);
  });

  it('a digest that waited longer goes first; the item waits its turn without spending budget (ruling 3)', async () => {
    const { world, dispatcher, typed, watch, item } = inbox();
    world.digestAt = T0 - 1_000;
    const w = watch('e1');
    await dispatcher.tick();
    expect(typed).toEqual([]);
    expect(item(w.id)).toMatchObject({ attempts: 0, lastRefusal: `${WINDOW_DEFERRAL}digest-first` });
    // The digest went out (its row is no longer held) and its ledger row shuts the window.
    world.digestAt = null;
    world.ledger = T0 + 5_000;
    world.clock = T0 + 15_000;
    await dispatcher.tick();
    expect(item(w.id)).toMatchObject({ attempts: 0, notBefore: T0 + 5_000 + 10 * MIN });
  });

  it('defers nothing for a worker tab', async () => {
    const { dispatcher, typed, watch, window } = inbox();
    window.claim(WS, W);
    watch('f1', W);
    await dispatcher.tick();
    expect(typed).toHaveLength(1);
  });

  it('publishes each tab\'s oldest windowed item that waits only on the window, for the router', () => {
    const now = T0;
    let state: IInboxState = { items: [] };
    state = enqueueInState(state, { kind: 'watch', targetWorkspaceId: WS, targetTabId: C, dedupeKey: 'g1', fields: { watchId: 'w-g10000', target: 'merge:o/r', notice: 'free' } } as never, now, () => 'i-g1').state;
    state = enqueueInState(state, { kind: 'resume', targetWorkspaceId: WS, targetTabId: W, dedupeKey: 'g2', fields: { resumeId: 'r-g20000' } } as never, now, () => 'i-g2').state;
    expect(windowHeads(state, now)).toEqual(new Map([[`${WS}/${C}`, now]]));
    state = { items: state.items.map((i) => ({ ...i, lastRefusal: 'composer-not-ready:busy' })) };
    expect(windowHeads(state, now)).toEqual(new Map());
    expect(WINDOWED_INBOX_KINDS).toEqual(['note', 'watch', 'deploy']);
  });
});

// ─── the digest router ─────────────────────────────────────────────────

describe('the digest router under a coordinator window (ruling, changes 1, 4; adversarial 1, 3)', () => {
  let store: LedgerStore;
  let now: number;
  let atPrompt: boolean;
  let typed: Array<{ tabId: string; message: string }>;
  let window: CoordinatorWindow;
  let inboxHeads: Map<string, number>;

  const deliver = vi.fn(async (_ws: string, tabId: string, message: string, whenReady?: () => boolean) => {
    if (whenReady && !whenReady()) return false;
    typed.push({ tabId, message });
    return true;
  });

  const router = (withWindow = true) => new TabEventRouter({
    table: () => store.tabEvents,
    now: () => now,
    deliver,
    atPrompt: () => atPrompt,
    window: withWindow ? () => window : undefined,
  });

  const nudge = (verdict: string, tabId = C, n = 1): ITabEventRoute => ({
    workspaceId: WS, tabId, kind: 'turn-marker', class: 'urgent', text: `[orchestrator-watchdog] worker tab-w${n} ended: ${verdict}`,
    sourceTabId: `tab-w${n}`, sourceTabName: `w${n}`, markerLines: [verdict],
  });

  beforeEach(() => {
    store = new LedgerStore(':memory:');
    now = T0;
    atPrompt = true;
    typed = [];
    deliver.mockClear();
    inboxHeads = new Map();
    window = new CoordinatorWindow({
      now: () => now,
      isCoordinator: async (_ws, tab) => tab === C,
      lastGoverned: (ws, tab) => store.tabEvents.lastGovernedDelivery(ws, tab, WINDOWED_INBOX_KINDS, now),
      oldestDigestAt: (ws, tab) => store.tabEvents.pending(ws, tab)[0]?.at ?? null,
    });
    window.setInboxHeads(inboxHeads);
  });

  afterEach(() => store.close());

  it('holds a DONE to a coordinator as a digest row; a worker still gets it at once', async () => {
    const r = router();
    atPrompt = false;
    expect(await r.route(nudge('DONE: shipped'))).toMatchObject({ class: 'digest', delivered: false });
    expect(await r.route(nudge('DONE: shipped', W))).toMatchObject({ class: 'urgent', delivered: true });
    expect(typed.map((t) => t.tabId)).toEqual([W]);
  });

  it('adversarial 1: BLOCKED inside the window is typed now, and does not move the window; DONE waits for it', async () => {
    const r = router();
    await r.route(nudge('DONE: first'));
    expect(typed).toHaveLength(1); // the first digest opens nothing: no governed paste before it
    expect(typed[0].message).toMatch(/^DIGEST 1 since/);
    now = T0 + 2 * MIN;
    expect(await r.route(nudge('BLOCKED: the gate is red', C, 2))).toMatchObject({ class: 'urgent', delivered: true });
    now = T0 + 3 * MIN;
    expect(await r.route(nudge('DONE: second', C, 3))).toMatchObject({ class: 'digest', delivered: false });
    now = T0 + 9 * MIN;
    await r.tick();
    expect(typed).toHaveLength(2);
    now = T0 + 10 * MIN;
    await r.tick();
    expect(typed).toHaveLength(3);
    expect(typed[2].message).toContain('DONE: second');
  });

  it('has no 20-event bypass for a coordinator: 25 held events wait for the window', async () => {
    const r = router();
    await r.route(nudge('DONE: first'));
    for (let i = 0; i < 25; i++) {
      now += 1_000;
      await r.route(nudge(`DONE: n${i}`, C, i + 2));
    }
    await r.tick();
    expect(typed).toHaveLength(1);
    now = T0 + 10 * MIN;
    await r.tick();
    expect(typed).toHaveLength(2);
    expect(typed[1].message).toMatch(/^DIGEST 25 since/);
  });

  it('ruling adversarial 1: worker sends every 4 min do not shut the window; the digest still goes out', async () => {
    const r = router();
    await r.route(nudge('DONE: first'));
    now = T0 + 1 * MIN;
    await r.route(nudge('DONE: held', C, 2));
    for (let minute = 2; minute <= 120; minute += 4) {
      now = T0 + minute * MIN;
      appendDelivered(store.tabEvents, { workspaceId: WS, tabId: C, kind: 'tab-send', class: 'urgent', text: `W -> ORCH: DONE: ${minute}` }, now);
      // The router's 5 s tick after the send: the settle window (review r2, F10) has passed, the 10-min window has not.
      now += 5_000;
      await r.tick();
      if (typed.length === 2) break;
    }
    expect(typed).toHaveLength(2);
    expect(now - T0).toBeLessThanOrEqual(20 * MIN);
  });

  it('gives the window to an inbox item that waited longer, then takes the next one', async () => {
    const r = router();
    await r.route(nudge('DONE: first'));
    now = T0 + 1 * MIN;
    await r.route(nudge('DONE: held', C, 2));
    inboxHeads.set(`${WS}/${C}`, T0 + 30_000);
    now = T0 + 10 * MIN;
    // The inbox republishes its heads every 2 s tick.
    window.setInboxHeads(inboxHeads);
    await r.tick();
    expect(typed).toHaveLength(1);
    // The inbox item went out (its ledger row), and the digest takes the window after it.
    appendDelivered(store.tabEvents, { workspaceId: WS, tabId: C, kind: 'watch', class: 'urgent', text: 'watch line' }, now);
    window.setInboxHeads(new Map());
    now = T0 + 19 * MIN;
    await r.tick();
    expect(typed).toHaveLength(1);
    now = T0 + 20 * MIN;
    await r.tick();
    expect(typed).toHaveLength(2);
  });

  it('a ROTATE in a shut window is pasted with its own readiness; a held digest stays held while the seat says so', async () => {
    const r = new TabEventRouter({
      table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => atPrompt, window: () => window, holdDigest: () => true,
    });
    window.claim(WS, C);
    await r.route(nudge('DONE: x'));
    now += 6_000;
    const rotate = await r.route({ workspaceId: WS, tabId: C, kind: 'rotate', class: 'urgent', text: 'ROTATE: bring /h.md up to date', whenReady: () => true });
    expect(rotate).toMatchObject({ class: 'urgent', delivered: true });
    now = T0 + 30 * MIN;
    await r.tick();
    expect(typed.map((t) => t.message)).toEqual(['ROTATE: bring /h.md up to date']);
  });

  it('re-reads the window inside the lock: a claim taken after the check stops the digest', async () => {
    const r = new TabEventRouter({
      table: () => store.tabEvents, now: () => now, atPrompt: () => atPrompt, window: () => window,
      deliver: async (wsId, tabId, message, whenReady) => {
        window.claim(wsId, tabId);
        return deliver(wsId, tabId, message, whenReady);
      },
    });
    atPrompt = false;
    await r.route(nudge('DONE: x'));
    atPrompt = true;
    await r.tick();
    expect(typed).toEqual([]);
    expect(store.tabEvents.pending(WS, C)).toHaveLength(1);
  });

  it('without a window wired, a coordinator keeps today\'s rules', async () => {
    const r = router(false);
    atPrompt = false;
    expect(await r.route(nudge('DONE: shipped'))).toMatchObject({ class: 'urgent', delivered: true });
  });
});
