import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Claude stop route (F6, F10 steps 1-2): the route decides, applies the stop and answers {}. No stop is held
// (party ruling SIMPLIFY, 2026-11-10).

const status = vi.hoisted(() => ({
  decideClaudeStop: vi.fn(),
  handleProviderEvent: vi.fn(() => true),
}));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));

const { dispatchHook } = await import('@/lib/hook-dispatch');

const BODY = { hook_event_name: 'Stop', session_id: 's-1', last_assistant_message: 'DONE: x', stop_hook_active: false };

describe('the Claude stop route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never answers a block; a scoped turn end with no row is applied', async () => {
    status.decideClaudeStop.mockResolvedValue({ kind: 'unreported', reason: 'no-row', turnId: 1 });
    const outcome = await dispatchHook({ query: { kind: 'stop', session: 'pt-s' }, body: BODY });
    expect(outcome).toEqual({ status: 200, body: {} });
    expect(status.decideClaudeStop).toHaveBeenCalledWith('pt-s', { hookEvent: 'Stop', sessionId: 's-1', message: 'DONE: x' }, undefined);
    expect(status.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-s', { kind: 'stop' }, undefined, { replayed: false });
  });

  it.each([
    [{ kind: 'row', row: {} }],
    [{ kind: 'classifier', why: 'unscoped' }],
    [{ kind: 'unreported', reason: 'no-row:remote' }],
  ])('applies the stop for %j and answers {}', async (decision) => {
    status.decideClaudeStop.mockResolvedValue(decision);
    expect(await dispatchHook({ query: { kind: 'stop', session: 'pt-s' }, body: BODY })).toEqual({ status: 200, body: {} });
    expect(status.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-s', { kind: 'stop' }, undefined, { replayed: false });
  });

  it('a replay is decided as replayed and applied at its own time; a dropped body still applies as a plain stop', async () => {
    status.decideClaudeStop.mockResolvedValue({ kind: 'unreported', reason: 'no-row:replayed' });
    await dispatchHook({ query: { kind: 'stop', session: 'pt-s' }, body: null, replayedAt: 1_700_000_000_000 });
    expect(status.decideClaudeStop).toHaveBeenCalledWith('pt-s', { hookEvent: null, sessionId: null, message: null }, 1_700_000_000_000);
    expect(status.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-s', { kind: 'stop' }, 1_700_000_000_000, { replayed: true });
  });

  it('a stop with no session in its query applies nothing', async () => {
    expect(await dispatchHook({ query: { kind: 'stop' }, body: BODY })).toEqual({ status: 200, body: {} });
    expect(status.decideClaudeStop).not.toHaveBeenCalled();
  });

  it('review round 2: a live hook with occurredAt is live; only the spool drain marks a replay', async () => {
    const occurredAt = Date.now() - 1_000;
    await dispatchHook({ query: { occurredAt: String(occurredAt) }, body: { event: 'notification', session: 'pt-s', notificationType: 'idle_prompt' } });
    expect(status.handleProviderEvent).toHaveBeenLastCalledWith('claude', 'pt-s', { kind: 'notification', notificationType: 'idle_prompt' },
      occurredAt, { replayed: false });
    await dispatchHook({ query: {}, body: { event: 'notification', session: 'pt-s', notificationType: 'idle_prompt' }, replayedAt: occurredAt });
    expect(status.handleProviderEvent).toHaveBeenLastCalledWith('claude', 'pt-s', { kind: 'notification', notificationType: 'idle_prompt' },
      occurredAt, { replayed: true });
  });
});
