import fs from 'fs/promises';
import { statSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEDGER_ITEM_TYPES, LEDGER_WAIT_REASONS } from '@/lib/ledger';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';

// The ledger routes against the real store, the real token checks and a temporary HOME.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(async () => true),
  listSessions: vi.fn(async () => []),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

const MIN = 60_000;
type THandler = Parameters<typeof callRoute>[0];

const resetLedgerGlobals = async () => {
  const { resetLedgerStoreForTests } = await import('@/lib/ledger-store');
  resetLedgerStoreForTests();
  delete (globalThis as Record<string, unknown>).__ptLedgerTokens;
};

describe('ledger routes', () => {
  let tabA: string;
  let tabB: string;
  let admin: string;
  let producerA: string;
  let producerB: string;
  const routes: Record<string, THandler> = {};

  const call = (route: string, method: string, workspaceId: string, token: string | null,
    init: { body?: unknown; query?: Record<string, string> } = {}) =>
    callRoute(routes[route], {
      method, headers: token ? { 'x-pmux-token': token } : {}, query: { workspaceId, ...init.query }, body: init.body,
    });

  const event = (id: string, at: number, overrides: Record<string, unknown> = {}) => ({
    event_id: id, at, item_type: 'range', item_key: 'range:a:0123456789ab', kind: 'wait', wait_reason: 'not-armed', holder: 'lane-a',
    ...overrides,
  });

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-ledger-routes-'));
    await resetLedgerGlobals();
    await writeFixture(mockHome.value, [
      { id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' },
      { id: 'ws-b', name: 'beta', tabs: [{ id: 'tab-b1', name: 'orchestrator b' }], orchestratorTabId: 'tab-b1' },
    ]);
    const { ensureTabToken } = await import('@/lib/tab-token');
    tabA = await ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    tabB = await ensureTabToken({ workspaceId: 'ws-b', tabId: 'tab-b1' }, 'pt-ws-b-pane-1-tab-b1');
    admin = (await import('@/lib/cli-token')).getCliToken();
    const base = '@/pages/api/cli/workspaces/[workspaceId]/ledger';
    routes.events = (await import(`${base}/events`)).default as THandler;
    routes.items = (await import(`${base}/items`)).default as THandler;
    routes.waits = (await import(`${base}/waits`)).default as THandler;
    routes.experiments = (await import(`${base}/experiments/index`)).default as THandler;
    routes.experiment = (await import(`${base}/experiments/[id]`)).default as THandler;
    routes.extend = (await import(`${base}/experiments/[id]/extend`)).default as THandler;
    routes.tokens = (await import(`${base}/tokens`)).default as THandler;
    const issued = await call('tokens', 'POST', 'ws-a', tabA, { body: { producer: 'v2' } });
    expect(issued.status).toBe(200);
    producerA = issued.body.token as string;
    producerB = (await call('tokens', 'POST', 'ws-b', tabB, { body: { producer: 'v2' } })).body.token as string;
  });

  afterEach(async () => {
    await resetLedgerGlobals();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  describe('tokens (AC 4)', () => {
    it('issues a ledger:emit token for one workspace and keeps only its hash, 0600', async () => {
      const issued = await call('tokens', 'POST', 'ws-a', tabA, { body: { producer: 'ledger-feed' } });
      expect(issued.body).toMatchObject({ scope: 'ledger:emit', workspaceId: 'ws-a', producer: 'ledger-feed', token: expect.stringMatching(/^pmlg_[0-9a-f]{64}$/) });
      const file = path.join(mockHome.value, '.purplemux', 'ledger-tokens.json');
      const stored = await fs.readFile(file, 'utf-8');
      expect(stored).not.toContain(issued.body.token as string);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    });

    it('refuses the server\'s reserved producer name', async () => {
      const reserved = await call('tokens', 'POST', 'ws-a', tabA, { body: { producer: 'purplemux' } });
      expect(reserved).toMatchObject({ status: 400, body: { code: 'ledger-token-invalid', field: 'producer' } });
      expect(reserved.body.error).toContain('the reserved purplemux or purplemux:*');
      expect((await call('tokens', 'POST', 'ws-a', tabA, { body: { producer: 'purplemux:x' } })).status).toBe(400);
      expect((await call('tokens', 'POST', 'ws-a', tabA, { body: { producer: 'purplemux-feed' } })).status).toBe(200);
    });

    it('counts an event for an item never opened as an orphan and creates no item', async () => {
      const posted = await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('o1', Date.now())] } });
      expect(posted.body).toMatchObject({ accepted: 1, orphan: 1 });
      expect((await call('items', 'GET', 'ws-a', tabA)).body.items).toEqual([]);
    });

    it('refuses to issue into another workspace, with the admin token, or for an unsafe producer name', async () => {
      expect((await call('tokens', 'POST', 'ws-b', tabA, { body: { producer: 'v2' } })).status).toBe(403);
      expect((await call('tokens', 'POST', 'ws-a', admin, { body: { producer: 'v2' } })).status).toBe(403);
      const bad = await call('tokens', 'POST', 'ws-a', tabA, { body: { producer: '../etc' } });
      expect(bad).toMatchObject({ status: 400, body: { code: 'ledger-token-invalid', field: 'producer' } });
    });

    it('re-issuing a producer rotates its token', async () => {
      const second = (await call('tokens', 'POST', 'ws-a', tabA, { body: { producer: 'v2' } })).body.token as string;
      expect((await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e1', Date.now())] } })).status).toBe(401);
      expect((await call('events', 'POST', 'ws-a', second, { body: { events: [event('e1', Date.now())] } })).status).toBe(200);
    });

    it('takes only a ledger:emit token for its own workspace on the events route', async () => {
      const body = { events: [event('e1', Date.now())] };
      expect((await call('events', 'POST', 'ws-a', producerB, { body })).body).toMatchObject({ code: 'forbidden' });
      expect((await call('events', 'POST', 'ws-a', producerB, { body })).status).toBe(403);
      expect((await call('events', 'POST', 'ws-a', tabA, { body })).status).toBe(403);
      expect((await call('events', 'POST', 'ws-a', admin, { body })).status).toBe(403);
      expect((await call('events', 'POST', 'ws-a', 'pmlg_forged', { body })).status).toBe(401);
      expect((await call('events', 'POST', 'ws-a', null, { body })).status).toBe(401);
    });

    it('a ledger token reads nothing: the read and mutation routes refuse it', async () => {
      for (const route of ['items', 'waits', 'experiments']) {
        expect((await call(route, 'GET', 'ws-a', producerA)).status, route).toBe(403);
      }
      expect((await call('experiments', 'POST', 'ws-a', producerA, { body: {} })).status).toBe(403);
      expect((await call('experiment', 'POST', 'ws-a', producerA, { query: { id: 'EXP-1' }, body: {} })).status).toBe(403);
      expect((await call('tokens', 'POST', 'ws-a', producerA, { body: { producer: 'x' } })).status).toBe(403);
    });
  });

  describe('POST events (AC 2, AC 3)', () => {
    it('appends to ~/.purplemux/ledger.sqlite, apart from mission-control.sqlite', async () => {
      const posted = await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e1', Date.now() - MIN)] } });
      expect(posted).toMatchObject({ status: 200, body: { ok: true, workspaceId: 'ws-a', producer: 'v2', accepted: 1, duplicates: 0 } });
      expect(posted.headers['Cache-Control']).toBe('no-store');
      const file = path.join(mockHome.value, '.purplemux', 'ledger.sqlite');
      expect(statSync(file).mode & 0o777).toBe(0o600);
      await expect(fs.access(path.join(mockHome.value, '.purplemux', 'mission-control.sqlite'))).rejects.toThrow();
    });

    it('replaying the same batch twice gives identical items and intervals', async () => {
      const now = Date.now();
      const batch = { events: [
        event('e0', now - 30 * MIN, { kind: 'open', wait_reason: null }),
        event('e1', now - 30 * MIN),
        event('e2', now - 10 * MIN, { kind: 'clear', wait_reason: null }),
        event('e3', now - 5 * MIN, { kind: 'wait', wait_reason: 'review-queue' }),
      ] };
      const first = await call('events', 'POST', 'ws-a', producerA, { body: batch });
      const items = (await call('items', 'GET', 'ws-a', tabA)).body.items;
      const waits = await call('waits', 'GET', 'ws-a', tabA, { query: { since: String(now - 60 * MIN), until: String(now) } });
      const replay = await call('events', 'POST', 'ws-a', producerA, { body: batch });
      expect(first.body).toMatchObject({ accepted: 4, duplicates: 0, orphan: 0, intervals: 1 });
      expect(replay.body).toMatchObject({ accepted: 0, duplicates: 4, intervals: 0 });
      expect((await call('items', 'GET', 'ws-a', tabA)).body.items).toEqual(items);
      const again = await call('waits', 'GET', 'ws-a', tabA, { query: { since: String(now - 60 * MIN), until: String(now) } });
      expect(again.body.rows).toEqual(waits.body.rows);
    });

    it('refuses more than 500 events and more than 1 MiB', async () => {
      const many = Array.from({ length: 501 }, (_, i) => event(`e${i}`, Date.now()));
      expect((await call('events', 'POST', 'ws-a', producerA, { body: { events: many } })).body).toMatchObject({ code: 'ledger-event-invalid', field: 'events' });
      const big = Array.from({ length: 500 }, (_, i) => event(`e${i}-${'x'.repeat(120)}`, Date.now(), {
        attrs: Object.fromEntries(Array.from({ length: 8 }, (__, k) => [`k${k}`, 'v'.repeat(300)])),
      }));
      const refused = await call('events', 'POST', 'ws-a', producerA, { body: { events: big } });
      expect(refused.status).toBe(413);
      expect(refused.body).toMatchObject({ code: 'ledger-too-large', error: expect.stringMatching(/saw \d+ bytes, expected at most 1048576/) });
    });

    it('refuses an unknown item type, kind or wait reason naming the field, the value and the list; nothing is stored', async () => {
      const type = await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e1', Date.now()), event('e2', Date.now(), { item_type: 'story' })] } });
      expect(type).toMatchObject({ status: 400, body: { code: 'ledger-event-invalid', field: 'events[1].item_type', allowed: [...LEDGER_ITEM_TYPES] } });
      expect(type.body.error).toContain('events[1].item_type: saw "story", expected one of slice, range');
      const kind = await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e1', Date.now(), { kind: 'nap' })] } });
      expect(kind.body).toMatchObject({ code: 'ledger-event-invalid', field: 'events[0].kind' });
      const reason = await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e1', Date.now(), { wait_reason: 'lunch' })] } });
      expect(reason).toMatchObject({ status: 400, body: { code: 'ledger-reason-invalid', field: 'events[0].wait_reason', allowed: [...LEDGER_WAIT_REASONS] } });
      expect((await call('items', 'GET', 'ws-a', tabA)).body.items).toEqual([]);
    });

    it('refuses an at more than 5 min ahead and a bidi control in an identifier', async () => {
      const future = await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e1', Date.now() + 6 * MIN)] } });
      expect(future.body).toMatchObject({ code: 'ledger-event-invalid', field: 'events[0].at' });
      const bidi = await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e‮1', Date.now())] } });
      expect(bidi.body).toMatchObject({ code: 'ledger-event-invalid', field: 'events[0].event_id', error: expect.stringContaining('\\u{202E}') });
    });

    it('refuses server-owned item types from a producer, naming the type', async () => {
      const refused = await call('events', 'POST', 'ws-a', producerA, { body: { events: [
        event('e1', Date.now()), event('e2', Date.now(), { item_type: 'seat', item_key: 'seat:ws-a:orchestrator', kind: 'open', wait_reason: null }),
      ] } });
      expect(refused).toMatchObject({ status: 403, body: { code: 'ledger-type-reserved', field: 'events[1].item_type' } });
      expect(refused.body.error).toContain('seat items are written by the server only (experiment, seat, mc-item)');
      expect((await call('items', 'GET', 'ws-a', tabA)).body.items).toEqual([]);
    });

    it('answers 409 ledger-event-conflict for a reused event_id with another body', async () => {
      const at = Date.now();
      expect((await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e1', at)] } })).status).toBe(200);
      const conflict = await call('events', 'POST', 'ws-a', producerA, { body: { events: [event('e1', at, { holder: 'lane-b' })] } });
      expect(conflict).toMatchObject({ status: 409, body: { code: 'ledger-event-conflict', field: 'events[0].event_id' } });
    });

    it('answers 404 for a workspace that no longer exists', async () => {
      const file = path.join(mockHome.value, '.purplemux', 'workspaces.json');
      const data = JSON.parse(await fs.readFile(file, 'utf-8'));
      data.workspaces = data.workspaces.filter((ws: { id: string }) => ws.id !== 'ws-b');
      await fs.writeFile(file, JSON.stringify(data));
      resetRouteGlobals();
      expect((await call('events', 'POST', 'ws-b', producerB, { body: { events: [event('e1', Date.now())] } })).status).toBe(404);
    });
  });

  describe('reads (AC 9)', () => {
    beforeEach(async () => {
      const now = Date.now();
      await call('events', 'POST', 'ws-a', producerA, { body: { events: [
        event('e1', now - 50 * MIN, { kind: 'open', wait_reason: null }),
        event('e2', now - 40 * MIN),
        event('e3', now - 30 * MIN, { kind: 'clear', wait_reason: null }),
        event('e4o', now - 20 * MIN, { item_type: 'gate', item_key: 'gate:t:1', kind: 'open', wait_reason: null, holder: 'host-1' }),
        event('e4', now - 20 * MIN, { item_type: 'gate', item_key: 'gate:t:1', kind: 'wait', wait_reason: 'gate-slot', holder: 'host-1' }),
        event('e5o', now - 16 * MIN, { item_type: 'gate', item_key: 'gate:t:2', kind: 'open', wait_reason: null, holder: 'host-1' }),
        event('e5', now - 15 * MIN, { item_type: 'gate', item_key: 'gate:t:2', kind: 'close', wait_reason: null, holder: 'host-1' }),
      ] } });
    });

    it('lists items with open, type and holder filters, no-store', async () => {
      const all = await call('items', 'GET', 'ws-a', tabA);
      expect(all.headers['Cache-Control']).toBe('no-store');
      expect((all.body.items as Array<{ itemKey: string }>).map((item) => item.itemKey)).toEqual(['range:a:0123456789ab', 'gate:t:1', 'gate:t:2']);
      const open = await call('items', 'GET', 'ws-a', tabA, { query: { open: '1', type: 'gate', holder: 'host-1' } });
      expect(open.body.items).toEqual([expect.objectContaining({ itemKey: 'gate:t:1', waitReason: 'gate-slot', holder: 'host-1' })]);
      expect((await call('items', 'GET', 'ws-a', tabA, { query: { type: 'story' } })).body).toMatchObject({ code: 'ledger-query-invalid', field: 'type' });
      expect((await call('items', 'GET', 'ws-a', tabB)).status).toBe(403);
      expect((await call('items', 'GET', 'ws-a', admin)).status).toBe(200);
    });

    it('sums waits by reason with p50, p90 and open WIP, and the range item reads unknown after 10 silent min', async () => {
      const waits = await call('waits', 'GET', 'ws-a', tabA, { query: { by: 'reason' } });
      expect(waits.headers['Cache-Control']).toBe('no-store');
      expect(waits.body).toMatchObject({ workspaceId: 'ws-a', by: 'reason' });
      const rows = waits.body.rows as Array<{ key: string; waitedMs: number; finished: number; p50Ms: number | null; openItems: number }>;
      expect(rows.find((row) => row.key === 'not-armed')).toMatchObject({ waitedMs: 10 * MIN, finished: 1, p50Ms: 10 * MIN, openItems: 0 });
      expect(rows.find((row) => row.key === 'gate-slot')).toMatchObject({ finished: 0, openItems: 1 });
      expect(rows.find((row) => row.key === 'unknown')).toMatchObject({ finished: 0, openItems: 1 });
      expect((await call('waits', 'GET', 'ws-a', tabA, { query: { by: 'stage' } })).body.rows)
        .toEqual(expect.arrayContaining([expect.objectContaining({ key: 'land' }), expect.objectContaining({ key: 'unknown' })]));
      expect((await call('waits', 'GET', 'ws-a', tabA, { query: { by: 'colour' } })).body).toMatchObject({ code: 'ledger-query-invalid', field: 'by' });
      const gates = await call('waits', 'GET', 'ws-a', tabA, { query: { type: 'gate' } });
      expect(gates.body).toMatchObject({ type: 'gate' });
      expect((gates.body.rows as Array<{ key: string }>).map((row) => row.key)).toEqual(['gate-slot']);
      expect((await call('waits', 'GET', 'ws-a', tabA, { query: { type: 'story' } })).body).toMatchObject({ code: 'ledger-query-invalid', field: 'type' });
      expect((await call('waits', 'GET', 'ws-a', tabA, { query: { since: '2026-11-03', until: '2026-11-02' } })).status).toBe(400);
      expect((await call('waits', 'GET', 'ws-a', tabA, { query: { since: 'yesterday' } })).body).toMatchObject({ field: 'since' });
      const tooOld = await call('waits', 'GET', 'ws-a', tabA, { query: { since: String(Date.now() - 93 * 24 * 60 * MIN) } });
      expect(tooOld).toMatchObject({ status: 400, body: { code: 'ledger-query-invalid', field: 'since' } });
      expect(tooOld.body.error).toContain('92-day retention limit');
    });

    it('opens, lists and closes experiments', async () => {
      const opened = await call('experiments', 'POST', 'ws-a', tabA, { body: {
        hypothesis: 'one gate outside the lock', stage: 'land', reason: 'under-lock-gate', metric: 'lock-hours', min_days: 3, max_days: 7,
      } });
      expect(opened).toMatchObject({ status: 201, body: { experiment: { id: 'EXP-1', stage: 'land', verdict: null } } });
      const capped = await call('experiments', 'POST', 'ws-a', tabA, { body: { hypothesis: 'h', stage: 'land', metric: 'm', min_days: 1, max_days: 2 } });
      expect(capped).toMatchObject({ status: 409, body: { code: 'ledger-experiment-cap' } });
      expect((await call('experiments', 'POST', 'ws-a', tabA, { body: { hypothesis: 'h', stage: 'lunch', metric: 'm', min_days: 1, max_days: 2 } })).body)
        .toMatchObject({ code: 'ledger-experiment-invalid', field: 'stage' });
      const list = await call('experiments', 'GET', 'ws-a', tabA);
      expect(list.headers['Cache-Control']).toBe('no-store');
      expect(list.body).toMatchObject({ workspaceId: 'ws-a', experiments: [{ id: 'EXP-1' }] });
      expect((await call('experiment', 'POST', 'ws-a', tabA, { query: { id: 'EXP-1' }, body: { verdict: 'maybe', evidence: 'x' } })).body)
        .toMatchObject({ code: 'ledger-experiment-invalid', field: 'verdict' });
      const closed = await call('experiment', 'POST', 'ws-a', tabA, { query: { id: 'EXP-1' }, body: { verdict: 'keep', evidence: 'lock hours fell 40%' } });
      expect(closed).toMatchObject({ status: 200, body: { experiment: { id: 'EXP-1', verdict: 'keep', evidence: 'lock hours fell 40%' } } });
      expect((await call('experiment', 'POST', 'ws-a', tabA, { query: { id: 'EXP-1' }, body: { verdict: 'keep', evidence: 'x' } })).body)
        .toMatchObject({ code: 'ledger-experiment-closed' });
      expect((await call('experiment', 'POST', 'ws-a', tabA, { query: { id: 'EXP-7' }, body: { verdict: 'keep', evidence: 'x' } })).status).toBe(404);
      expect((await call('experiment', 'POST', 'ws-a', tabB, { query: { id: 'EXP-1' }, body: { verdict: 'keep', evidence: 'x' } })).status).toBe(403);
    });

    it('extends an active experiment once, within 90 days, and refuses the rest (story 22)', async () => {
      await call('experiments', 'POST', 'ws-a', tabA, { body: { hypothesis: 'h', stage: 'land', metric: 'm', min_days: 3, max_days: 80 } });
      const ext = (body: unknown, token = tabA, id = 'EXP-1') => call('extend', 'POST', 'ws-a', token, { query: { id }, body });
      expect((await ext({ days: 3, evidence: 'x', why: 'y' })).body).toMatchObject({ code: 'ledger-experiment-invalid', field: 'body.why' });
      expect((await ext({ days: 0, evidence: 'x' })).body).toMatchObject({ code: 'ledger-experiment-invalid', field: 'days' });
      expect((await ext({ days: 2.5, evidence: 'x' })).body).toMatchObject({ field: 'days' });
      expect((await ext({ days: 3, evidence: ' ' })).body).toMatchObject({ field: 'evidence' });
      expect(await ext({ days: 11, evidence: 'x' })).toMatchObject({ status: 409, body: { code: 'ledger-experiment-cap', field: 'days' } });
      expect((await ext({ days: 3, evidence: 'x' }, tabB)).status).toBe(403);
      expect((await ext({ days: 3, evidence: 'x' }, tabA, 'EXP-7')).status).toBe(404);
      const extended = await ext({ days: 10, evidence: 're-gates still noisy' });
      expect(extended).toMatchObject({ status: 200, body: { experiment: { id: 'EXP-1', maxDays: 90, extensionDays: 10 } } });
      expect(extended.headers['Cache-Control']).toBe('no-store');
      expect(await ext({ days: 1, evidence: 'x' })).toMatchObject({ status: 409, body: { code: 'ledger-experiment-extended' } });
      expect((await call('extend', 'GET', 'ws-a', tabA, { query: { id: 'EXP-1' } })).status).toBe(405);
    });
  });
});
