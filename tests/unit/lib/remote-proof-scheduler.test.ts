import { describe, expect, it, vi } from 'vitest';
import { RemoteProofScheduler, type IRemoteProofRequest } from '@/lib/remote-proof-scheduler';
import type { TStrictRuntimeObservation } from '@/lib/process-utils';

// vel-D61 review r1 F1: what the scheduler keeps, for how long, and what it never keeps.

const req = (tabId: string, key = 'k1', host = 'host-a'): IRemoteProofRequest =>
  ({ tabId, host, sessionName: `pt-ws-1-pane-a-${tabId}`, want: 'claude', key });

const make = (answer: () => TStrictRuntimeObservation | Promise<TStrictRuntimeObservation>) => {
  let now = 1_000_000;
  const observe = vi.fn(async (_sessionName: string, _want: string) => answer());
  const onUnknown = vi.fn();
  const scheduler = new RemoteProofScheduler({ observe, now: () => now, onUnknown });
  return { scheduler, observe, onUnknown, advance: (ms: number) => { now += ms; } };
};

describe('RemoteProofScheduler', () => {
  it('an absent answer is read once: a relaunch with the same key never meets it', async () => {
    const { scheduler } = make(() => ({ state: 'absent', reason: 'no claude process in the pane' }));
    await scheduler.schedule([req('tab-a')]);
    expect(scheduler.read(req('tab-a'))).toBe(false);
    expect(scheduler.read(req('tab-a'))).toBeNull();
  });

  it('a present answer is kept for its key only', async () => {
    const { scheduler } = make(() => ({ state: 'present', identity: 'x' }));
    await scheduler.schedule([req('tab-a')]);
    expect(scheduler.read(req('tab-a'))).toBe(true);
    expect(scheduler.read(req('tab-a'))).toBe(true);
    expect(scheduler.read(req('tab-a', 'k2'))).toBeNull();
    expect(scheduler.read(req('tab-a'))).toBeNull();
  });

  it('an unknown answer is not kept, backs the host off and names the reason; an observe that throws is unknown', async () => {
    const { scheduler, observe, onUnknown, advance } = make(() => { throw new Error('ssh died'); });
    await scheduler.schedule([req('tab-a')]);
    expect(scheduler.read(req('tab-a'))).toBeNull();
    expect(onUnknown).toHaveBeenCalledWith(expect.objectContaining({ tabId: 'tab-a' }), 'ssh died');
    await scheduler.schedule([req('tab-b')]);
    await scheduler.schedule([req('tab-c', 'k1', 'host-b')]);
    expect(observe.mock.calls.map((c) => c[0])).toEqual(['pt-ws-1-pane-a-tab-a', 'pt-ws-1-pane-a-tab-c']);
    advance(30_000);
    await scheduler.schedule([req('tab-b')]);
    expect(observe).toHaveBeenCalledTimes(3);
  });

  it('prove: one awaited proof through the cache and the backoff; an in-flight tab is not proven twice', async () => {
    let release: (o: TStrictRuntimeObservation) => void = () => {};
    const { scheduler, observe } = make(() => new Promise((resolve) => { release = resolve; }));
    const first = scheduler.prove(req('tab-a'));
    expect(await scheduler.prove(req('tab-a'))).toBeNull();
    release({ state: 'present', identity: 'x' });
    expect(await first).toBe(true);
    expect(await scheduler.prove(req('tab-a'))).toBe(true);
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it('forget drops a tab\'s answer and its rotation place', async () => {
    const { scheduler } = make(() => ({ state: 'present', identity: 'x' }));
    await scheduler.schedule([req('tab-a')]);
    scheduler.forget('tab-a');
    expect(scheduler.read(req('tab-a'))).toBeNull();
  });

  it('a host runs at most 4 proofs; a freed slot starts the next queued one at once, without a poll (r2 M1)', async () => {
    const releases = new Map<string, () => void>();
    const { scheduler, observe } = make(() => ({ state: 'present', identity: 'x' }));
    observe.mockImplementation((sessionName: string) => new Promise((resolve) => {
      releases.set(sessionName, () => resolve({ state: 'present', identity: 'x' }));
    }));
    const tabs = Array.from({ length: 10 }, (_, i) => req(`tab-${i}`));
    const drained = scheduler.schedule(tabs);
    expect(observe).toHaveBeenCalledTimes(4);
    releases.get('pt-ws-1-pane-a-tab-0')!();
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(5));
    for (let started = 5; started < 10; started += 1) {
      for (const [session, release] of releases) { releases.delete(session); release(); }
      await vi.waitFor(() => expect(observe.mock.calls.length).toBeGreaterThan(started));
    }
    for (const release of releases.values()) release();
    await drained;
    expect(observe).toHaveBeenCalledTimes(10);
    expect(tabs.every((t) => scheduler.read(t) === true)).toBe(true);
  });

  it('a tab whose key changed jumps the queue ahead of the least recently proven (r2 M1)', async () => {
    const order: string[] = [];
    let hold: (() => void) | null = null;
    const scheduler = new RemoteProofScheduler(
      {
        observe: async (sessionName) => {
          order.push(sessionName);
          if (sessionName.endsWith('tab-blocker')) await new Promise<void>((resolve) => { hold = resolve; });
          return { state: 'present', identity: 'x' };
        },
        now: () => 1_000_000 + order.length,
      },
      { ttlMs: 60_000, backoffMs: 30_000, perHostCap: 1 },
    );
    // tab-changed was proven under k1; tab-old and tab-new never were (least recently proven: never).
    await scheduler.prove(req('tab-changed', 'k1'));
    order.length = 0;
    const blocker = scheduler.schedule([req('tab-blocker')]);
    await vi.waitFor(() => expect(hold).not.toBeNull());
    const drained = scheduler.schedule([req('tab-old'), req('tab-new'), req('tab-changed', 'k2')]);
    expect(order).toEqual(['pt-ws-1-pane-a-tab-blocker']);
    hold!();
    await blocker;
    await drained;
    expect(order).toEqual(['pt-ws-1-pane-a-tab-blocker', 'pt-ws-1-pane-a-tab-changed', 'pt-ws-1-pane-a-tab-old', 'pt-ws-1-pane-a-tab-new']);
  });

  it('an absent answer has no TTL: read ten minutes later it is still false, once (review r3 C2)', async () => {
    const { scheduler, observe, advance } = make(() => ({ state: 'absent', reason: 'no claude process in the pane' }));
    await scheduler.schedule([req('tab-a')]);
    advance(10 * 60_000);
    await scheduler.schedule([req('tab-a')]);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(scheduler.read(req('tab-a'))).toBe(false);
    expect(scheduler.read(req('tab-a'))).toBeNull();
  });

  it('a present answer still expires after its TTL', async () => {
    const { scheduler, advance } = make(() => ({ state: 'present', identity: 'x' }));
    await scheduler.schedule([req('tab-a')]);
    advance(59_999);
    expect(scheduler.read(req('tab-a'))).toBe(true);
    advance(1);
    expect(scheduler.read(req('tab-a'))).toBeNull();
  });

  it('an unread absent expires after its own long limit, not the present TTL (vel-PMX-FU)', async () => {
    let now = 1_000_000;
    const scheduler = new RemoteProofScheduler({
      observe: async () => ({ state: 'absent', reason: 'no claude process in the pane' }),
      now: () => now,
      absentTtlMs: () => 300_000,
    });
    await scheduler.schedule([req('tab-a')]);
    now += 299_999;
    expect(scheduler.read(req('tab-a'))).toBe(false);
    await scheduler.schedule([req('tab-b')]);
    now += 300_000;
    expect(scheduler.read(req('tab-b'))).toBeNull();
  });
});
