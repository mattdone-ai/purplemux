import { describe, expect, it } from 'vitest';
import { ProviderOutageTracker, failureKeyId, type IFailureKey } from '@/lib/provider-outage';

const clock = () => {
  const c = { t: 1_000_000, now: () => c.t };
  return c;
};
const tracker = (c: { now: () => number }, over: Partial<ConstructorParameters<typeof ProviderOutageTracker>[0]> = {}) =>
  new ProviderOutageTracker({ threshold: 3, windowMs: 600_000, quietMs: 300_000, maxQuietMs: 1_200_000, now: c.now, ...over });

const server: IFailureKey = { cls: 'api-error', provider: 'claude', host: null, code: 'server_error' };
const authLocal: IFailureKey = { cls: 'auth-failure', provider: 'claude', host: null, code: 'authentication_failed' };
const authRemote: IFailureKey = { cls: 'auth-failure', provider: 'claude', host: 'remote-a', code: 'other' };

describe('ProviderOutageTracker (PMUX-REMOTE-RESILIENCE fix 2)', () => {
  it('keys an auth failure by provider and host, any other class by provider and code', () => {
    expect(failureKeyId(server)).toBe('api-error|claude|server_error');
    expect(failureKeyId(authLocal)).toBe('auth-failure|claude|local');
    expect(failureKeyId({ ...authRemote, code: 'unauthorized' })).toBe('auth-failure|claude|remote-a');
  });

  it('starts an outage once, at the third distinct tab inside the window, and holds every later failure', () => {
    const c = clock();
    const t = tracker(c);
    expect(t.record(server, 'a')).toEqual({ active: false, started: false, alert: false, held: [] });
    expect(t.record(server, 'a')).toEqual({ active: false, started: false, alert: false, held: [] });
    c.t += 1000;
    expect(t.record(server, 'b').active).toBe(false);
    c.t += 1000;
    expect(t.record(server, 'c')).toEqual({ active: true, started: true, alert: true, held: ['a', 'b', 'c'] });
    expect(t.record(server, 'd')).toEqual({ active: true, started: false, alert: false, held: ['a', 'b', 'c', 'd'] });
    expect(t.isHeld('d')).toBe(true);
    expect(t.activeOutages()).toHaveLength(1);
  });

  it('forgets failures older than the window, and counts another code apart', () => {
    const c = clock();
    const t = tracker(c);
    t.record(server, 'a');
    t.record(server, 'b');
    c.t += 600_001;
    expect(t.record(server, 'c').active).toBe(false);
    expect(t.record({ ...server, code: 'overloaded_error' }, 'd').active).toBe(false);
    expect(t.record(server, 'e').active).toBe(false);
    expect(t.record(server, 'f').started).toBe(true);
  });

  it('ends an outage only on a clean turn of the same provider; an auth outage only on the same host', () => {
    const c = clock();
    const t = tracker(c, { threshold: 2 });
    t.record(server, 'a');
    t.record(server, 'b');
    t.record(authRemote, 'r1');
    t.record(authRemote, 'r2');
    expect(t.recover('codex', null)).toEqual([]);
    c.t += 5000;
    const local = t.recover('claude', null);
    expect(local.map((r) => [r.id, r.held, r.durationMs])).toEqual([['api-error|claude|server_error', ['a', 'b'], 5000]]);
    expect(t.isHeld('r1')).toBe(true);
    expect(t.recover('claude', 'remote-a').map((r) => r.held)).toEqual([['r1', 'r2']]);
    expect(t.activeOutages()).toEqual([]);
  });

  it('a recovery also clears the window: the next failures start counting again', () => {
    const c = clock();
    const t = tracker(c);
    t.record(server, 'a');
    t.record(server, 'b');
    t.recover('claude', null);
    expect(t.record(server, 'c').active).toBe(false);
  });

  it('offers one canary per quiet period, longest-held first, and doubles the quiet period when it fails', () => {
    const c = clock();
    const t = tracker(c);
    for (const tab of ['a', 'b', 'c']) t.record(server, tab);
    expect(t.dueCanaries()).toEqual([]);
    c.t += 300_000;
    expect(t.dueCanaries()).toEqual([{ id: 'api-error|claude|server_error', tabId: 'a' }]);
    // While the canary is out, no second one.
    c.t += 300_000;
    expect(t.dueCanaries()).toEqual([]);
    // The canary failed again: a new quiet period, twice as long, then the next tab.
    t.record(server, 'a');
    c.t += 300_000;
    expect(t.dueCanaries()).toEqual([]);
    c.t += 300_000;
    expect(t.dueCanaries()).toEqual([{ id: 'api-error|claude|server_error', tabId: 'b' }]);
  });

  it('caps the quiet period, and a canary that could not be queued frees the slot after a new quiet period', () => {
    const c = clock();
    const t = tracker(c, { maxQuietMs: 400_000 });
    for (const tab of ['a', 'b', 'c']) t.record(server, tab);
    c.t += 300_000;
    const [first] = t.dueCanaries();
    t.record(server, first.tabId);
    c.t += 400_000;
    const [second] = t.dueCanaries();
    expect(second.tabId).toBe('b');
    t.canaryFailed(second.id, 'a');
    expect(t.dueCanaries()).toEqual([]);
    t.canaryFailed(second.id, second.tabId);
    expect(t.dueCanaries()).toEqual([]);
    c.t += 400_000;
    expect(t.dueCanaries()).toHaveLength(1);
  });

  it('forget drops a tab from every outage and window; an outage with no tab left ends', () => {
    const c = clock();
    const t = tracker(c, { threshold: 2 });
    t.record(server, 'a');
    t.record(server, 'b');
    t.record(authLocal, 'x');
    t.forget('a');
    expect(t.isHeld('a')).toBe(false);
    t.forget('b');
    expect(t.activeOutages()).toEqual([]);
    t.forget('x');
    expect(t.record(authLocal, 'y').active).toBe(false);
  });

  it('ends an outage only on a clean turn that ended after its last failure (review r1 finding 4)', () => {
    const c = clock();
    const t = tracker(c, { threshold: 2 });
    t.record(server, 'a');
    c.t += 1000;
    t.record(server, 'b');
    const lastFailure = c.t;
    c.t += 5000;
    expect(t.recover('claude', null, lastFailure - 1)).toEqual([]);
    expect(t.isHeld('a')).toBe(true);
    expect(t.recover('claude', null, lastFailure)).toHaveLength(1);
  });

  it('the same key in outage again within the re-alert window holds but raises no second alert; after it, alerts again', () => {
    const c = clock();
    const t = tracker(c, { threshold: 2, realertMs: 1_800_000 });
    t.record(server, 'a');
    expect(t.record(server, 'b').alert).toBe(true);
    t.recover('claude', null);
    c.t += 60_000;
    t.record(server, 'a');
    expect(t.record(server, 'b')).toMatchObject({ active: true, started: true, alert: false });
    t.recover('claude', null);
    c.t += 1_800_001;
    t.record(server, 'a');
    expect(t.record(server, 'b').alert).toBe(true);
  });

  it('an auth outage offers no canary: a resume into a refused account fails the same way (review r1 finding 3)', () => {
    const c = clock();
    const t = tracker(c, { threshold: 2 });
    t.record(authLocal, 'a');
    t.record(authLocal, 'b');
    c.t += 10_000_000;
    expect(t.dueCanaries()).toEqual([]);
  });

  it('a canary with no answer frees its slot after the canary timeout, then the next canary follows a quiet period', () => {
    const c = clock();
    const t = tracker(c, { canaryTimeoutMs: 1_800_000 });
    for (const tab of ['a', 'b', 'c']) t.record(server, tab);
    c.t += 300_000;
    expect(t.dueCanaries()).toHaveLength(1);
    expect(t.isCanary('api-error|claude|server_error', 'a')).toBe(true);
    c.t += 1_799_999;
    expect(t.dueCanaries()).toEqual([]);
    c.t += 1;
    expect(t.dueCanaries()).toEqual([]);
    c.t += 300_000;
    expect(t.dueCanaries()).toEqual([{ id: 'api-error|claude|server_error', tabId: 'b' }]);
  });
});
