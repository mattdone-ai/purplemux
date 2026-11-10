import { describe, expect, it, vi } from 'vitest';
import type { ITabStartInput, TTabStart } from '@/lib/pool-service';

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const { AUTO_PLACE_TIMEOUT_MS, PoolTimeoutError, resolveAutoHost } = await import('@/lib/pool-tab-placement');

const remote: TTabStart = { state: 'admitted', host: 'host-b-lan', local: false, reason: 'most free memory', lease: 'pool:host-b-lan/tab-1', envelope: { threads: 2, memGb: 4 } };
const here: TTabStart = { state: 'admitted', host: 'host-a', local: true, reason: 'local-only: budget threads 4/24', lease: 'pool:host-a/tab-1', envelope: { threads: 2, memGb: 4 } };
const waiting: TTabStart = {
  state: 'queued',
  queued: {
    queued: true, ticket: 'pool-queue:tab-1', kind: 'tab', class: 'product', position: 2, of: 3, reason: 'queued: position 2 of 3; host-a: budget threads 24/24 used, needs 2',
    refusal: 'no-budget', expiresAt: null, retryAfterSeconds: 10, envelope: { threads: 2, memGb: 4 },
  },
};

const deps = (over: Partial<Parameters<typeof resolveAutoHost>[1]> = {}) => ({
  start: vi.fn(async (input: ITabStartInput): Promise<TTabStart> => (input.localOnly ? here : remote)),
  release: vi.fn(async () => {}),
  cwdOnHost: vi.fn(async () => true),
  localName: () => 'host-a',
  ...over,
});

describe('resolveAutoHost (ADR-0039 §4, vel-D4)', () => {
  it('a remote admission is the host to create on; the cwd is checked there; the start lease goes with it', async () => {
    const d = deps();
    expect(await resolveAutoHost({ panelType: 'claude-code', cwd: '/home/user/pool/x' }, d)).toEqual({
      kind: 'placed', host: 'host-b-lan', cwdChecked: true, lease: 'pool:host-b-lan/tab-1',
      placement: { host: 'host-b-lan', local: false, reason: 'most free memory', fallback: false, envelope: { threads: 2, memGb: 4 } },
    });
    expect(d.cwdOnHost).toHaveBeenCalledWith('host-b-lan', '/home/user/pool/x');
    expect(d.release).not.toHaveBeenCalled();
  });

  it('a start that fits no host is queued, never placed here', async () => {
    const d = deps({ start: vi.fn(async () => waiting) });
    expect(await resolveAutoHost({ panelType: 'claude-code' }, d)).toEqual({ kind: 'queued', queued: waiting.state === 'queued' ? waiting.queued : null });
  });

  it('a refusal is a refusal, never a local create', async () => {
    const d = deps({ start: vi.fn(async (): Promise<TTabStart> => ({ state: 'refused', refusal: 'too-large', reason: 'larger than every host' })) });
    expect(await resolveAutoHost({ panelType: 'claude-code' }, d)).toEqual({ kind: 'refused', refusal: 'too-large', reason: 'larger than every host' });
  });

  it('no pool answer in 2 s places the tab here: that is not a capacity answer', async () => {
    vi.useFakeTimers();
    try {
      const pending = resolveAutoHost({ panelType: 'claude-code' }, deps({ start: vi.fn(() => new Promise<never>(() => {})) }));
      await vi.advanceTimersByTimeAsync(AUTO_PLACE_TIMEOUT_MS);
      expect(await pending).toEqual({
        kind: 'placed', host: undefined, lease: null, placement: { host: 'host-a', local: true, reason: 'fallback: no pool answer in 2000 ms', fallback: true, envelope: null },
      });
      expect(AUTO_PLACE_TIMEOUT_MS).toBe(2000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a cwd missing on the chosen host gives that start back and asks this host on its own budget', async () => {
    const d = deps({ cwdOnHost: vi.fn(async () => false) });
    const out = await resolveAutoHost({ panelType: 'claude-code', cwd: '/x' }, d);
    expect(d.release).toHaveBeenCalledWith('pool:host-b-lan/tab-1');
    expect(d.start).toHaveBeenLastCalledWith({ panelType: 'claude-code', localOnly: true });
    expect(out).toMatchObject({ kind: 'placed', host: undefined, lease: 'pool:host-a/tab-1', placement: { local: true, fallback: true, reason: expect.stringContaining('/x is not a directory on host-b-lan') } });
  });

  it('a cwd missing on the chosen host with this host full queues the local start', async () => {
    const d = deps({ cwdOnHost: vi.fn(async () => false), start: vi.fn(async (input: ITabStartInput) => (input.localOnly ? waiting : remote)) });
    expect(await resolveAutoHost({ panelType: 'claude-code', cwd: '/x' }, d)).toMatchObject({ kind: 'queued', queued: { ticket: 'pool-queue:tab-1' } });
  });

  it('a cwd check that fails over ssh names the ssh failure, never "not a directory" (r2 F4)', async () => {
    const out = await resolveAutoHost({ panelType: 'claude-code', cwd: '/x' }, deps({ cwdOnHost: vi.fn(async () => { throw new Error('remote host host-b-lan did not answer over ssh (timed out)'); }) }));
    expect(out).toMatchObject({ kind: 'placed', host: undefined, placement: { local: true, fallback: true } });
    const reason = out.kind === 'placed' ? out.placement.reason : '';
    expect(reason).toBe('fallback: host-b-lan did not answer: remote host host-b-lan did not answer over ssh (timed out) (pool chose it: most free memory); this host: local-only: budget threads 4/24');
    expect(reason).not.toContain('not a directory');
  });

  it('a cwd proven on the chosen host is marked checked; no cwd is not', async () => {
    expect(await resolveAutoHost({ panelType: 'claude-code', cwd: '/x' }, deps())).toMatchObject({ host: 'host-b-lan', cwdChecked: true });
    expect(await resolveAutoHost({ panelType: 'claude-code' }, deps())).toMatchObject({ host: 'host-b-lan', cwdChecked: false });
  });

  it('a role, a class and a ticket go to the pool with the request; a local re-ask drops the ticket', async () => {
    const d = deps({ cwdOnHost: vi.fn(async () => false) });
    await resolveAutoHost({ panelType: 'claude-code', role: 'evaluator', class: 'harness', ticket: 'pool-queue:tab-4', cwd: '/x' }, d);
    expect(d.start).toHaveBeenNthCalledWith(1, { panelType: 'claude-code', role: 'evaluator', class: 'harness', ticket: 'pool-queue:tab-4' });
    expect(d.start).toHaveBeenNthCalledWith(2, { panelType: 'claude-code', role: 'evaluator', class: 'harness', localOnly: true });
  });
});

describe('resolveAutoHost: only a first-ask timeout falls back (review r1 F4)', () => {
  const never = () => new Promise<never>(() => {});
  const timed = async <T>(run: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers();
    try {
      const pending = run();
      await vi.advanceTimersByTimeAsync(AUTO_PLACE_TIMEOUT_MS);
      return await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  it.each([
    ['a pool error (ticket gone)', Object.assign(new Error('pool-queue:tab-1 is not waiting'), { code: 'pool-ticket-gone' })],
    ['an invalid request', Object.assign(new Error('class must be product, harness or control-plane'), { code: 'pool-invalid' })],
    ['an unreadable store', new Error('leases.json is not valid JSON')],
  ])('%s on a first ask is an answer, never a local create', async (_name, error) => {
    const out = await resolveAutoHost({ panelType: 'claude-code' }, deps({ start: vi.fn(async () => { throw error; }) }));
    expect(out).toEqual({ kind: 'failed', error });
  });

  it('a timeout on a re-ask with a ticket creates nothing', async () => {
    const out = await timed(() => resolveAutoHost({ panelType: 'claude-code', ticket: 'pool-queue:tab-1' }, deps({ start: vi.fn(never) })));
    expect(out).toMatchObject({ kind: 'failed', error: expect.any(PoolTimeoutError) });
  });

  it('a timeout on the local re-ask after a missing --cwd creates nothing', async () => {
    const d = deps({ cwdOnHost: vi.fn(async () => false), start: vi.fn(async (input: ITabStartInput) => (input.localOnly ? never() : remote)) });
    const out = await timed(() => resolveAutoHost({ panelType: 'claude-code', cwd: '/x' }, d));
    expect(out).toMatchObject({ kind: 'failed', error: expect.any(PoolTimeoutError) });
    expect(d.release).toHaveBeenCalledWith('pool:host-b-lan/tab-1');
  });

  it('a late admission after a first-ask timeout gives its start lease back', async () => {
    let answer: (v: TTabStart) => void = () => {};
    const d = deps({ start: vi.fn(() => new Promise<TTabStart>((resolve) => { answer = resolve; })) });
    const out = await timed(() => resolveAutoHost({ panelType: 'claude-code' }, d));
    expect(out).toMatchObject({ kind: 'placed', placement: { fallback: true } });
    answer(remote);
    await vi.waitFor(() => expect(d.release).toHaveBeenCalledWith('pool:host-b-lan/tab-1'));
  });

  it('a late ticket after a first-ask timeout is given back; a late queued re-ask keeps the waiter\'s own ticket', async () => {
    let answer: (v: TTabStart) => void = () => {};
    const first = deps({ start: vi.fn(() => new Promise<TTabStart>((resolve) => { answer = resolve; })) });
    await timed(() => resolveAutoHost({ panelType: 'claude-code' }, first));
    answer(waiting);
    await vi.waitFor(() => expect(first.release).toHaveBeenCalledWith('pool-queue:tab-1'));
    const reask = deps({ start: vi.fn(() => new Promise<TTabStart>((resolve) => { answer = resolve; })) });
    await timed(() => resolveAutoHost({ panelType: 'claude-code', ticket: 'pool-queue:tab-1' }, reask));
    answer(waiting);
    await new Promise((r) => setTimeout(r, 10));
    expect(reask.release).not.toHaveBeenCalled();
  });
});
