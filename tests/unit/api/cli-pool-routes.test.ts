import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute } from './leases-harness';

// vel-POOL-ENF: the pool routes pass the ask token and the host pin through; the body is not a whitelist that drops them.

const pool = vi.hoisted(() => ({
  acquirePoolSlot: vi.fn(async (_input: Record<string, unknown>, _holder: unknown, _authority: unknown) => ({ host: 'control-host', lease: 'pool:control-host/gate-1' })),
  releasePoolSlot: vi.fn(async (_lease: unknown, _holder: unknown, _authority: unknown, _ask?: unknown) => ({ name: 'pool:control-host/gate-1' })),
  cancelPoolAsk: vi.fn(async (ask: string, _holder: unknown, _authority: unknown) => ({ released: ['pool:control-host/gate-1'], cancelled: ask })),
}));
const holder = { workspaceId: 'ws1', tabId: 'tab-a', tabName: 'a', verified: true, admin: false };

vi.mock('@/lib/pool-service', () => pool);
vi.mock('@/lib/pool-http', () => ({ sendPoolError: vi.fn(async (res: { status: (n: number) => { json: (b: unknown) => void } }, err: Error) => res.status(500).json({ error: err.message })) }));
vi.mock('@/lib/lease-http', () => ({
  bodyOf: (req: { body?: unknown }) => (req.body && typeof req.body === 'object' ? req.body : {}),
  holderOf: () => holder,
  leaseAuthority: { now: () => 0 },
  requireCaller: async () => ({ holder }),
  requireMethod: () => true,
  viewOf: async (lease: unknown) => lease,
}));

const T = '0123456789abcdef0123456789abcdef';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pool routes (vel-POOL-ENF)', () => {
  it('acquire passes ask and pin to the service', async () => {
    const { default: handler } = await import('@/pages/api/cli/pool/acquire');
    const pin = { hosts: ['control-host'], local: true, gateHosts: ['hosta'] };
    const r = await callRoute(handler, { method: 'POST', body: { kind: 'gate', ask: T, pin, unknown: 'dropped' } });
    expect(r.status).toBe(200);
    expect(pool.acquirePoolSlot).toHaveBeenCalledWith(expect.objectContaining({ kind: 'gate', ask: T, pin }), holder, expect.anything());
    expect(pool.acquirePoolSlot.mock.calls[0][0]).not.toHaveProperty('unknown');
  });

  it('release with a lease and a token releases by name with the token; a token alone cancels', async () => {
    const { default: handler } = await import('@/pages/api/cli/pool/release');
    expect((await callRoute(handler, { method: 'POST', body: { lease: 'pool:control-host/gate-1', ask: T } })).body).toEqual({ released: { name: 'pool:control-host/gate-1' } });
    expect(pool.releasePoolSlot).toHaveBeenCalledWith('pool:control-host/gate-1', holder, expect.anything(), T);
    expect((await callRoute(handler, { method: 'POST', body: { ask: T } })).body).toEqual({ released: ['pool:control-host/gate-1'], cancelled: T });
    expect(pool.cancelPoolAsk).toHaveBeenCalledWith(T, holder, expect.anything());
    expect(pool.releasePoolSlot).toHaveBeenCalledTimes(1);
  });

  it('release with a lease and no token is the release of before', async () => {
    const { default: handler } = await import('@/pages/api/cli/pool/release');
    await callRoute(handler, { method: 'POST', body: { lease: 'pool:control-host/gate-1' } });
    expect(pool.releasePoolSlot).toHaveBeenCalledWith('pool:control-host/gate-1', holder, expect.anything(), undefined);
    expect(pool.cancelPoolAsk).not.toHaveBeenCalled();
  });
});
