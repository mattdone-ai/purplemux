import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 20: GET /api/mission-control/coordination — the human session only; each
// section is read on its own, so one failing store shows its error, not a blank panel.

const m = vi.hoisted(() => ({
  leases: vi.fn(),
  notes: vi.fn(),
  watches: vi.fn(),
  refusal: null as string | null,
  grants: [] as unknown[],
  inbox: vi.fn(),
  fleet: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  verifySessionToken: vi.fn(async (token: string) => (token === 'good-session' ? { sub: 'human' } : null)),
}));
vi.mock('@/lib/lease-store', () => ({ listLeases: vi.fn(async () => [{ name: 'merge:x/y' }]) }));
vi.mock('@/lib/lease-http', () => ({ viewsOf: m.leases }));
vi.mock('@/lib/notes-store', () => ({
  readNotesState: m.notes,
  OPEN_STATES: new Set(['queued', 'delivered', 'undeliverable']),
  viewOf: (n: Record<string, unknown>) => ({ ...n }),
}));
vi.mock('@/lib/watch-manager', () => ({ getWatchManager: async () => ({ list: m.watches }) }));
vi.mock('@/lib/grant-store', () => ({
  grantsRefusal: () => m.refusal,
  grantsSnapshot: () => ({ grants: m.grants }),
  isActive: (g: { revokedAt: number | null; expiresAt: number }, now: number) => g.revokedAt === null && g.expiresAt > now,
}));
vi.mock('@/lib/inbox-store', () => ({ readInboxState: m.inbox }));
vi.mock('@/lib/fleet-status-snapshot', () => ({ readFleetView: m.fleet }));
vi.mock('@/lib/host-metrics', () => ({ readHostMetrics: vi.fn(async () => ({ available: false, reason: 'test host' })) }));

const call = async (headers: Record<string, string>) => {
  const { default: handler } = await import('@/pages/api/mission-control/coordination');
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
  await handler({ method: 'GET', headers, query: {}, socket: {} } as unknown as NextApiRequest, res);
  return state as { status: number; body: Record<string, { ok?: boolean; items?: unknown[]; error?: string; state?: string }> };
};

describe('GET /api/mission-control/coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.leases.mockResolvedValue([{ name: 'merge:x/y', holderState: 'closed' }]);
    m.notes.mockResolvedValue({ notes: [
      { id: 'n-1', state: 'delivered', createdAt: Date.now() - 60_000 },
      { id: 'n-2', state: 'acked', createdAt: Date.now() },
    ] });
    m.watches.mockResolvedValue([{ id: 'w-1' }]);
    m.refusal = null;
    m.grants = [{ id: 'g-1', revokedAt: null, expiresAt: Date.now() + 1000 }, { id: 'g-2', revokedAt: 1, expiresAt: Date.now() + 1000 }];
    m.inbox.mockResolvedValue({ items: [{ id: 'i-1', state: 'held' }, { id: 'i-2', state: 'queued' }] });
    m.fleet.mockResolvedValue({ at: 1, thresholds: { stallMinutes: 30, waitingLongMinutes: 120, unansweredMinutes: 30, composerMinutes: 2 }, rows: [], unattributed: [], errors: [] });
  });

  it('refuses a valid CLI token without a human session (401) and reads no store', async () => {
    // Pin the token in memory so the test never touches ~/.purplemux/cli-token.
    (globalThis as unknown as { __ptCliToken?: string }).__ptCliToken = 'c'.repeat(64);
    const { getCliToken, verifyTokenValue } = await import('@/lib/cli-token');
    expect(verifyTokenValue(getCliToken())).toBe(true);
    expect((await call({ 'x-pmux-token': getCliToken() })).status).toBe(401);
    expect(m.leases).not.toHaveBeenCalled();
    expect(m.notes).not.toHaveBeenCalled();
    expect(m.watches).not.toHaveBeenCalled();
    expect(m.inbox).not.toHaveBeenCalled();
    expect(m.fleet).not.toHaveBeenCalled();
  });

  it('serves the fleet view (ADR-0023) as its own section', async () => {
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.fleet).toEqual({ ok: true, view: expect.objectContaining({ rows: [], unattributed: [], errors: [] }) });
  });

  it('a failing fleet read shows its error and the other sections still render', async () => {
    m.fleet.mockRejectedValue(new Error('workspaces.json unreadable'));
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.fleet).toEqual({ ok: false, error: 'workspaces.json unreadable' });
    expect(r.body.leases.ok).toBe(true);
  });

  it('serves every section to a human: closed lease kept, open notes with age, active grants, held deliveries', async () => {
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.leases).toEqual({ ok: true, items: [{ name: 'merge:x/y', holderState: 'closed' }] });
    expect(r.body.notes.items).toEqual([expect.objectContaining({ id: 'n-1', ageSeconds: expect.any(Number) })]);
    expect(r.body.watches.items).toHaveLength(1);
    expect(r.body.grants.items).toEqual([expect.objectContaining({ id: 'g-1' })]);
    expect(r.body.inboxHeld.items).toEqual([{ id: 'i-1', state: 'held' }]);
    expect(r.body.host).toEqual({ available: false, reason: 'test host' });
    expect(r.body.signals).toEqual({ state: 'not-configured' });
    // The watch list is read for every workspace (admin view).
    expect(m.watches).toHaveBeenCalledWith(expect.objectContaining({ admin: true }), null);
  });

  it('a failing store shows its own error and the other sections still render', async () => {
    m.notes.mockRejectedValue(new Error('notes.json is malformed'));
    m.refusal = 'grants.json is malformed; no grant is honoured';
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.notes).toEqual({ ok: false, error: 'notes.json is malformed' });
    expect(r.body.grants).toEqual({ ok: false, error: 'grants.json is malformed; no grant is honoured' });
    expect(r.body.leases.ok).toBe(true);
  });
});
