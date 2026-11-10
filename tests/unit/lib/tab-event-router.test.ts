import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LedgerStore } from '@/lib/ledger-store';
import {
  DIGEST_INTERVAL_MS,
  DIGEST_MAX_BYTES,
  DIGEST_MAX_WAITING,
  DIGEST_SETTLE_MS,
  DIGEST_STALE_MS,
  DUPLICATE_WINDOW_MS,
  TAB_EVENT_TEXT_MAX,
  TabEventRouter,
  appendDelivered,
  renderDigest,
  type ITabEventRoute,
} from '@/lib/tab-event-router';
import type { ITabEvent } from '@/types/tab-events';

const T0 = Date.UTC(2026, 10, 3, 6, 0, 0);
const WS = 'ws-a';
const TAB = 'tab-o';

let store: LedgerStore;
let now: number;
let atPrompt: boolean;
let digestN: number;
const typed: Array<{ tabId: string; message: string }> = [];

const deliver = vi.fn(async (_ws: string, tabId: string, message: string, whenReady?: () => boolean) => {
  if (whenReady && !whenReady()) return false;
  typed.push({ tabId, message });
  return true;
});

const router = () => new TabEventRouter({
  table: () => store.tabEvents,
  now: () => now,
  deliver,
  atPrompt: () => atPrompt,
  newDigestId: () => `dg-${++digestN}`,
});

const checkpoint = (n: number, extra: Partial<ITabEventRoute> = {}): ITabEventRoute => ({
  workspaceId: WS,
  tabId: TAB,
  kind: 'turn-marker',
  class: 'digest',
  text: `[orchestrator-watchdog] worker tab-w${n} (lane-${n}) ended: CHECKPOINTED: handoff ${n} — read with: purplemux tab result -w ${WS} tab-w${n}`,
  sourceTabId: `tab-w${n}`,
  sourceTabName: `lane-${n}`,
  ...extra,
});

beforeEach(() => {
  store = new LedgerStore(':memory:');
  now = T0;
  atPrompt = true;
  digestN = 0;
  typed.length = 0;
  deliver.mockClear();
});

afterEach(() => store.close());

describe('urgent events (AC 2)', () => {
  it('are typed at once and recorded delivered at the time they were typed', async () => {
    atPrompt = false;
    const result = await router().route(checkpoint(1, { class: 'urgent', text: 'worker ended: DONE: shipped' }));
    expect(result).toMatchObject({ class: 'urgent', delivered: true, duplicate: false });
    expect(typed).toEqual([{ tabId: TAB, message: 'worker ended: DONE: shipped' }]);
    const [row] = store.tabEvents.list(WS, { since: 0, limit: 5 });
    expect(row).toMatchObject({ class: 'urgent', deliveredAt: T0, digestId: null, sourceTabId: 'tab-w1' });
  });

  it('keep only the episode filter: the same urgent text inside 15 min is typed again (consult ruling 2)', async () => {
    const r = router();
    await r.route(checkpoint(1, { class: 'urgent', text: 'ended: DONE: x' }));
    now += 60_000;
    expect((await r.route(checkpoint(1, { class: 'urgent', text: 'ended: DONE: x' }))).delivered).toBe(true);
    expect(typed).toHaveLength(2);
  });

  it('a delivery that fails stays recorded, undelivered', async () => {
    deliver.mockResolvedValueOnce(false);
    const result = await router().route(checkpoint(1, { class: 'urgent' }));
    expect(result.delivered).toBe(false);
    expect(store.tabEvents.list(WS, { since: 0, limit: 5 })[0].deliveredAt).toBeNull();
  });

  it('stay out of the history while their paste runs: an in-flight nudge never reads undelivered (09-fix)', async () => {
    let release!: (ok: boolean) => void;
    deliver.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const r = router();
    const routing = r.route(checkpoint(1, { class: 'urgent', text: 'BACKGROUND JOB FAILED' }));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(r.history(WS, 10)).toEqual([]);
    release(true);
    await expect(routing).resolves.toMatchObject({ delivered: true });
    expect(r.history(WS, 10)).toEqual([expect.objectContaining({ kind: 'turn-marker', deliveredAt: T0 })]);
  });

  it('enter the history undelivered when their paste fails, and when it throws', async () => {
    const r = router();
    deliver.mockResolvedValueOnce(false);
    await r.route(checkpoint(1, { class: 'urgent', text: 'first' }));
    deliver.mockRejectedValueOnce(new Error('tmux gone'));
    await expect(r.route(checkpoint(2, { class: 'urgent', text: 'second' }))).rejects.toThrow('tmux gone');
    expect(r.history(WS, 10).map((row) => [row.text, row.deliveredAt])).toEqual([['first', null], ['second', null]]);
  });

  it('carry their own readiness into the dispatch lock: a ROTATE for a tab that started a turn is not typed (ADR-0036 §2)', async () => {
    const rotate = { workspaceId: WS, tabId: TAB, kind: 'rotate', class: 'urgent' as const, text: 'ROTATE: bring /h.md up to date, then end your turn with HANDOFF-READY.' };
    const refused = await router().route({ ...rotate, whenReady: () => false });
    expect(refused).toMatchObject({ class: 'urgent', delivered: false });
    expect(typed).toEqual([]);
    const typedNow = await router().route({ ...rotate, whenReady: () => true });
    expect(typedNow.delivered).toBe(true);
    expect(store.tabEvents.list(WS, { since: 0, limit: 5 }).map((row) => [row.kind, row.class, row.deliveredAt])).toEqual([
      ['rotate', 'urgent', null], ['rotate', 'urgent', T0],
    ]);
  });
});

describe('a seat mid-rotation (ADR-0036)', () => {
  it('ROTATE queued behind a digest waits: it is not typed inside the settle window of that delivery (F2)', async () => {
    const r = router();
    await r.route(checkpoint(1));
    await vi.waitFor(() => expect(typed).toHaveLength(1));
    const rotate = { workspaceId: WS, tabId: TAB, kind: 'rotate', class: 'urgent' as const, text: 'ROTATE: x', whenReady: () => true };
    now += DIGEST_SETTLE_MS - 1;
    expect((await r.route(rotate)).delivered).toBe(false);
    expect(typed).toHaveLength(1);
    // A refused paste typed nothing and stamps nothing: the window runs from the digest.
    now += 1;
    expect((await r.route(rotate)).delivered).toBe(true);
    expect(typed.at(-1)?.message).toBe('ROTATE: x');
  });

  it('holds digests while the seat says so; urgent events still go (F1, F4)', async () => {
    let hold = true;
    const r = new TabEventRouter({
      table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => atPrompt, newDigestId: () => `dg-${++digestN}`,
      holdDigest: () => hold,
    });
    await r.route(checkpoint(1));
    await r.tick();
    expect(typed).toEqual([]);
    expect((await r.route(checkpoint(2, { class: 'urgent', text: 'ended: DONE: x' }))).delivered).toBe(true);
    hold = false;
    now += DIGEST_SETTLE_MS;
    await r.tick();
    expect(typed.at(-1)?.message).toMatch(/^DIGEST 1 since /);
  });
});

describe('the urgent hold of a rotated seat (ADR-0036)', () => {
  it('records an urgent event undelivered while held and types the held ones in order on release, never a ROTATE', async () => {
    let hold = true;
    const r = new TabEventRouter({
      table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => atPrompt, newDigestId: () => `dg-${++digestN}`,
      holdUrgent: () => hold,
    });
    const urgent = (text: string, kind = 'turn-marker') => ({ workspaceId: WS, tabId: TAB, kind, class: 'urgent' as const, text });
    expect((await r.route(urgent('ended: DONE: one'))).delivered).toBe(false);
    now += 1;
    await r.route(urgent('ROTATE: stale', 'rotate'));
    now += 1;
    await r.route(urgent('ended: BLOCKED: two'));
    expect(typed).toEqual([]);
    hold = false;
    expect(await r.releaseHeldUrgent(WS, TAB, T0)).toBe(2);
    expect(typed.map((t) => t.message)).toEqual(['ended: DONE: one', 'ended: BLOCKED: two']);
    expect(store.tabEvents.list(WS, { since: 0, limit: 10 }).map((row) => [row.kind, row.deliveredAt !== null])).toEqual([
      ['turn-marker', true], ['rotate', false], ['turn-marker', true],
    ]);
    expect(await r.releaseHeldUrgent(WS, TAB, T0)).toBe(0);
  });
});

describe('the digest (AC 3)', () => {
  it('sends the first digest at once to a tab at its prompt, then waits 15 min for the next', async () => {
    const r = router();
    await r.route(checkpoint(1));
    await vi.waitFor(() => expect(typed).toHaveLength(1));
    expect(typed[0].message.split('\n')[0]).toBe('DIGEST 1 since 2026-11-03T06:00:00Z');

    now += 60_000;
    await r.route(checkpoint(2));
    await r.route(checkpoint(3));
    await r.tick();
    expect(typed).toHaveLength(1);
    now = T0 + DIGEST_INTERVAL_MS - 1;
    await r.tick();
    expect(typed).toHaveLength(1);
    now = T0 + DIGEST_INTERVAL_MS;
    await r.tick();
    expect(typed).toHaveLength(2);
    expect(typed[1].message.split('\n')[0]).toBe('DIGEST 2 since 2026-11-03T06:01:00Z');
    expect(store.tabEvents.pending(WS, TAB)).toEqual([]);
    const ids = new Set(store.tabEvents.list(WS, { since: 0, limit: 10 }).map((row) => row.digestId));
    expect(ids).toEqual(new Set(['dg-1', 'dg-2']));
  });

  it('goes out before 15 min when 20 events wait', async () => {
    const r = router();
    await r.route(checkpoint(0));
    await vi.waitFor(() => expect(typed).toHaveLength(1));
    now += DIGEST_SETTLE_MS;
    for (let i = 1; i < DIGEST_MAX_WAITING; i++) await r.route(checkpoint(i));
    await r.tick();
    expect(typed).toHaveLength(1);
    await r.route(checkpoint(DIGEST_MAX_WAITING));
    await vi.waitFor(() => expect(typed).toHaveLength(2));
    expect(typed[1].message.startsWith(`DIGEST ${DIGEST_MAX_WAITING} since`)).toBe(true);
  });

  it('is never typed into a busy tab, however long it waits or however many events wait', async () => {
    atPrompt = false;
    const r = router();
    for (let i = 0; i < DIGEST_MAX_WAITING + 5; i++) await r.route(checkpoint(i));
    now += 4 * DIGEST_INTERVAL_MS;
    await r.tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(store.tabEvents.pending(WS, TAB)).toHaveLength(DIGEST_MAX_WAITING + 5);
    atPrompt = true;
    await r.tick();
    expect(typed).toHaveLength(1);
    expect(typed[0].message.startsWith(`DIGEST ${DIGEST_MAX_WAITING + 5} since`)).toBe(true);
  });

  it('is not typed when the tab starts a turn between the check and the paste, and stays pending', async () => {
    const r = router();
    let checks = 0;
    const flip = new TabEventRouter({
      table: () => store.tabEvents, now: () => now, deliver, newDigestId: () => 'dg-x',
      // At prompt for the flush's check, busy by the time the dispatch lock re-checks.
      atPrompt: () => ++checks <= 1,
    });
    await flip.route(checkpoint(1));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await flip.tick();
    expect(typed).toEqual([]);
    expect(store.tabEvents.pending(WS, TAB)).toHaveLength(1);
    await r.tick();
    expect(typed).toHaveLength(1);
  });

  it('a tab at its prompt that had no events gets nothing', async () => {
    await router().tick();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('renderDigest', () => {
  const rows = (n: number, text = (i: number) => `[orchestrator-watchdog] worker tab-w${i} (lane) ended: CHECKPOINTED: handoff ${i} — read with: purplemux tab result -w ${WS} tab-w${i}`): ITabEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      seq: i + 1, workspaceId: WS, tabId: TAB, at: T0 + i * 60_000, class: 'digest', kind: 'turn-marker', text: text(i),
      sourceTabId: null, sourceTabName: null, rule: null, deliveredAt: null, digestId: null,
    }));

  it('one line per event without the watchdog prefix or its pane pointer, then the pointer to the full text', () => {
    expect(renderDigest(rows(2), WS, TAB)).toBe([
      'DIGEST 2 since 2026-11-03T06:00:00Z',
      '- 06:00Z turn-marker: worker tab-w0 (lane) ended: CHECKPOINTED: handoff 0',
      '- 06:01Z turn-marker: worker tab-w1 (lane) ended: CHECKPOINTED: handoff 1',
      `Full text: purplemux events show -w ${WS} ${TAB} --since 2026-11-03T06:00:00Z`,
    ].join('\n'));
  });

  it('stops at 2 KB and points to the rest', () => {
    const message = renderDigest(rows(40, (i) => `event ${i} ${'x'.repeat(400)}`), WS, TAB);
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    const lines = message.split('\n');
    expect(lines[0]).toBe('DIGEST 40 since 2026-11-03T06:00:00Z');
    const shown = lines.length - 2;
    expect(shown).toBeGreaterThan(5);
    expect(lines.at(-1)).toBe(`${40 - shown} more: purplemux events show -w ${WS} ${TAB} --since 2026-11-03T06:00:00Z`);
    expect(lines[1].length).toBeLessThanOrEqual(2 + 6 + 1 + 'turn-marker: '.length + 160);
  });

  it('counts bytes, not characters', () => {
    const message = renderDigest(rows(40, () => '漢'.repeat(150)), WS, TAB);
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
  });
});

describe('duplicates (AC 4)', () => {
  it('a copy of an event still held inside 15 min is logged, not delivered; after 15 min it is new', async () => {
    atPrompt = false;
    const r = router();
    await r.route(checkpoint(1));
    now += DUPLICATE_WINDOW_MS - 1;
    const dup = await r.route(checkpoint(1));
    expect(dup).toMatchObject({ class: 'log', delivered: false, duplicate: true });
    expect(store.tabEvents.pending(WS, TAB)).toHaveLength(1);
    now = T0 + DUPLICATE_WINDOW_MS + 1;
    expect((await r.route(checkpoint(1))).class).toBe('digest');
  });

  it('a delivered copy never suppresses a later one: the same text 8 min after it went out is held again (review r2, F3)', async () => {
    const r = router();
    const turnEnded = checkpoint(1, { kind: 'turn-ended', text: '[orchestrator-watchdog] worker tab-w1 (lane-1) finished its turn.' });
    await r.route(turnEnded);
    await vi.waitFor(() => expect(typed).toHaveLength(1));
    now += 8 * 60_000;
    const again = await r.route(turnEnded);
    expect(again).toMatchObject({ class: 'digest', duplicate: false });
    now = T0 + DIGEST_INTERVAL_MS;
    await r.tick();
    expect(typed).toHaveLength(2);
    expect(typed[1].message).toContain('finished its turn.');
  });

  it('another tab, kind or text is not a duplicate', async () => {
    atPrompt = false;
    const r = router();
    await r.route(checkpoint(1));
    expect((await r.route(checkpoint(1, { tabId: 'tab-p' }))).duplicate).toBe(false);
    expect((await r.route(checkpoint(1, { kind: 'stuck' }))).duplicate).toBe(false);
    expect((await r.route(checkpoint(2))).duplicate).toBe(false);
  });
});

describe('a ledger that cannot be opened', () => {
  it('holds nothing: urgent and digest events are typed at once, a log event is dropped', async () => {
    const r = new TabEventRouter({
      table: () => { throw new Error('unsupported ledger schema 9'); },
      now: () => now,
      deliver,
      atPrompt: () => false,
    });
    expect(await r.route(checkpoint(1))).toEqual({ class: 'digest', delivered: true, seq: null, duplicate: false });
    expect(await r.route(checkpoint(2, { class: 'log' }))).toEqual({ class: 'log', delivered: false, seq: null, duplicate: false });
    await r.tick();
    expect(typed).toHaveLength(1);
  });
});

describe('the kept text', () => {
  it('cuts an event another path typed to TAB_EVENT_TEXT_MAX characters and says how many it left out', () => {
    const long = 'b'.repeat(TAB_EVENT_TEXT_MAX + 10);
    appendDelivered(store.tabEvents, checkpoint(2, { kind: 'tab-send', text: long }), now);
    expect(store.tabEvents.list(WS, { since: 0, limit: 5 })[0].text).toBe(`${'b'.repeat(TAB_EVENT_TEXT_MAX)}… [10 more characters not kept]`);
  });

  it('never cuts an event it holds: a 20 KiB held message reads back whole, and a copy of it is a duplicate (review r2, F8)', async () => {
    atPrompt = false;
    const long = `${'b'.repeat(20 * 1024)} end`;
    await router().route(checkpoint(1, { kind: 'tab-send', text: long }));
    expect(store.tabEvents.pending(WS, TAB)[0].text).toBe(long);
    expect((await router().route(checkpoint(1, { kind: 'tab-send', text: long }))).duplicate).toBe(true);
  });
});

describe('a ledger write that fails (review r2, F1)', () => {
  const failing = (op: 'append' | 'hasSame' | 'markDelivered') => {
    const table = store.tabEvents;
    const proxy = new Proxy(table, {
      get: (target, key) => (key === op ? () => { throw new Error('SQLITE_FULL: database or disk is full'); } : Reflect.get(target, key)),
    });
    return new TabEventRouter({ table: () => proxy, now: () => now, deliver, atPrompt: () => atPrompt, newDigestId: () => `dg-${++digestN}` });
  };

  it.each(['append', 'hasSame'] as const)('a failing %s still types the event once, unlogged', async (op) => {
    atPrompt = false;
    // An urgent event is never checked for duplicates, so only a failing append leaves it unlogged.
    expect(await failing(op).route(checkpoint(1, { class: 'urgent' }))).toMatchObject({ class: 'urgent', delivered: true, duplicate: false });
    expect(await failing(op).route(checkpoint(2))).toEqual({ class: 'digest', delivered: true, seq: null, duplicate: false });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('a failing markDelivered after the paste never types it again', async () => {
    const r = failing('markDelivered');
    expect((await r.route(checkpoint(1, { class: 'urgent' }))).delivered).toBe(true);
    await r.route(checkpoint(2));
    now += DIGEST_INTERVAL_MS;
    await r.tick();
    await r.tick();
    expect(typed.map((t) => t.message.split('\n')[0])).toEqual([checkpoint(1).text, 'DIGEST 1 since 2026-11-03T06:00:00Z']);
  });
});

describe('the settle window (review r2, F10)', () => {
  it('sends no digest within 5 s of any delivery to the tab; the next tick after it does', async () => {
    const r = router();
    await r.route(checkpoint(1, { class: 'urgent', text: 'ended: DONE: x' }));
    await r.route(checkpoint(2));
    expect(typed).toHaveLength(1);
    now += DIGEST_SETTLE_MS - 1;
    await r.tick();
    expect(typed).toHaveLength(1);
    now += 1;
    await r.tick();
    expect(typed[1].message.startsWith('DIGEST 1 since')).toBe(true);
  });

  it('a notice another path typed counts as a delivery too', async () => {
    const r = router();
    appendDelivered(store.tabEvents, { workspaceId: WS, tabId: TAB, kind: 'note', class: 'digest', text: '[purplemux note] n-1' }, now);
    await r.route(checkpoint(1));
    expect(typed).toEqual([]);
    now += DIGEST_SETTLE_MS;
    await r.tick();
    expect(typed).toHaveLength(1);
  });
});

describe('the settle window inside the dispatch lock (post-review F10)', () => {
  it('a digest queued behind a slow urgent paste waits for the next tick', async () => {
    let tail: Promise<unknown> = Promise.resolve();
    let release!: () => void;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    // The dispatcher's per-tab queue: each delivery starts after the one before it, and reads whenReady in its turn.
    const queued = vi.fn((_ws: string, tabId: string, message: string, whenReady?: () => boolean) => {
      const run = tail.then(async () => {
        if (message.startsWith('ended: DONE')) await slow;
        if (whenReady && !whenReady()) return false;
        typed.push({ tabId, message });
        return true;
      });
      tail = run.catch(() => undefined);
      return run;
    });
    const r = new TabEventRouter({ table: () => store.tabEvents, now: () => now, deliver: queued, atPrompt: () => true, newDigestId: () => 'dg-q' });
    const urgent = r.route(checkpoint(1, { class: 'urgent', text: 'ended: DONE: x' }));
    const digest = r.route(checkpoint(2));
    release();
    expect((await urgent).delivered).toBe(true);
    expect((await digest).delivered).toBe(false);
    expect(typed.map((t) => t.message)).toEqual(['ended: DONE: x']);
    now += DIGEST_SETTLE_MS;
    await r.tick();
    expect(typed[1].message.startsWith('DIGEST 1 since')).toBe(true);
  });

  it('re-reads the window in the lock: a delivery another path recorded after the check stops the digest', async () => {
    const lockDeliver = vi.fn(async (_ws: string, tabId: string, message: string, whenReady?: () => boolean) => {
      // An inbox notice typed by its own path while this digest waited for the lock.
      appendDelivered(store.tabEvents, { workspaceId: WS, tabId, kind: 'note', class: 'digest', text: '[purplemux note] n-2' }, now);
      if (whenReady && !whenReady()) return false;
      typed.push({ tabId, message });
      return true;
    });
    const r = new TabEventRouter({ table: () => store.tabEvents, now: () => now, deliver: lockDeliver, atPrompt: () => true });
    expect((await r.route(checkpoint(1))).delivered).toBe(false);
    expect(typed).toEqual([]);
    expect(store.tabEvents.pending(WS, TAB)).toHaveLength(1);
  });
});

describe('a closed tab\'s backlog (post-review F12)', () => {
  it('is retired when the tab closes: no alert from this instance or from one after a restart', async () => {
    atPrompt = false;
    const onStale = vi.fn();
    const first = new TabEventRouter({ table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => atPrompt, onStale, isKnownTab: () => true });
    await first.route(checkpoint(1));
    first.retire(WS, TAB);
    expect(store.tabEvents.pending(WS, TAB)).toEqual([]);
    expect(store.tabEvents.list(WS, { since: 0, limit: 5 }).map((e) => e.class)).toEqual(['log']);
    now += DIGEST_STALE_MS;
    await first.tick();
    const restarted = new TabEventRouter({ table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => atPrompt, onStale, isKnownTab: () => true });
    await restarted.tick();
    expect(onStale).not.toHaveBeenCalled();
  });

  it('a tab closed while the server was down is retired on the first stale tick, never reported; a known one is reported once per instance', async () => {
    atPrompt = false;
    const onStale = vi.fn();
    const before = new TabEventRouter({ table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => atPrompt });
    await before.route(checkpoint(1));
    await before.route(checkpoint(2, { tabId: 'tab-live' }));
    now += DIGEST_STALE_MS;
    const after = new TabEventRouter({
      table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => atPrompt, onStale, isKnownTab: (tabId) => tabId === 'tab-live',
    });
    await after.tick();
    await after.tick();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-live', count: 1 }));
    expect(store.tabEvents.pending(WS, TAB)).toEqual([]);
    expect(store.tabEvents.pendingTabs().map((p) => p.tabId)).toEqual(['tab-live']);
  });
});

describe('held events (review r2, F6 and F9)', () => {
  it('reports a tab whose oldest held event is an hour old, once per backlog', async () => {
    atPrompt = false;
    const onStale = vi.fn();
    const r = new TabEventRouter({ table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => atPrompt, onStale });
    await r.route(checkpoint(1));
    await r.route(checkpoint(2));
    now += DIGEST_STALE_MS - 1;
    await r.tick();
    expect(onStale).not.toHaveBeenCalled();
    now += 1;
    await r.tick();
    await r.tick();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onStale).toHaveBeenCalledWith({ workspaceId: WS, tabId: TAB, count: 2, oldestAt: T0 });
  });

  it('hands the events a digest carried, now delivered, to onDigestDelivered', async () => {
    const onDigestDelivered = vi.fn();
    const r = new TabEventRouter({ table: () => store.tabEvents, now: () => now, deliver, atPrompt: () => true, onDigestDelivered, newDigestId: () => 'dg-z' });
    await r.route(checkpoint(1));
    expect(onDigestDelivered).toHaveBeenCalledWith([expect.objectContaining({ sourceTabId: 'tab-w1', deliveredAt: T0, digestId: 'dg-z' })]);
  });
});

describe('appendDelivered', () => {
  it('writes an event another path typed, delivered at once', () => {
    const seq = appendDelivered(store.tabEvents, { workspaceId: WS, tabId: TAB, kind: 'note', class: 'digest', text: '[purplemux note] n-1' }, now);
    expect(store.tabEvents.list(WS, { since: 0, limit: 5 })).toEqual([expect.objectContaining({ seq, kind: 'note', deliveredAt: T0, class: 'digest' })]);
    expect(store.tabEvents.pending(WS, TAB)).toEqual([]);
  });
});

describe('no kind skips the digest interval (F6 change 2 deletes the standup due line)', () => {
  it('a standup-due row held before F6 is a plain digest row: it waits 15 min like any other and reads as its kind', async () => {
    const r = router();
    await r.route(checkpoint(1));
    await vi.waitFor(() => expect(typed).toHaveLength(1));
    now += 60_000;
    await r.route({ workspaceId: WS, tabId: TAB, kind: 'standup-due', class: 'digest', text: 'standup due: last posted 47 min ago' });
    now += DIGEST_SETTLE_MS;
    await r.tick();
    expect(typed).toHaveLength(1);
    now = T0 + DIGEST_INTERVAL_MS;
    await r.tick();
    expect(typed).toHaveLength(2);
    expect(typed[1].message.split('\n')[1]).toMatch(/^- \d\d:\d\dZ standup-due: standup due: last posted 47 min ago$/);
  });
});
