import { describe, expect, it, vi } from 'vitest';
import { callRoute } from './leases-harness';

// ADR-0038 §2: an owner message typed in purplemux is handed to the curator, in shadow, after it is saved.

const hooks = vi.hoisted(() => ({ onOwnerMessage: vi.fn(), add: vi.fn() }));
vi.mock('@/lib/curator-service', () => ({ curatorOnOwnerMessage: hooks.onOwnerMessage }));
vi.mock('@/lib/message-history-store', () => ({
  addMessageHistory: hooks.add, readMessageHistory: vi.fn(async () => []), deleteMessageHistory: vi.fn(async () => true),
}));

describe('POST /api/message-history', () => {
  it('saves the message, then hands it to the curator with its workspace', async () => {
    hooks.add.mockResolvedValue({ id: 'm1', message: 'from now on use AEDT', sentAt: '2026-11-03T04:05:06.000Z' });
    const { default: handler } = await import('@/pages/api/message-history');
    const res = await callRoute(handler as never, { method: 'POST', body: { wsId: 'ws-a', message: 'from now on use AEDT' } });
    expect(res.status).toBe(201);
    expect(hooks.onOwnerMessage).toHaveBeenCalledWith('ws-a', 'm1', 'from now on use AEDT', Date.parse('2026-11-03T04:05:06.000Z'));
    expect(hooks.add).toHaveBeenCalledWith('ws-a', 'from now on use AEDT', null);
  });

  it('records the tab the prompt was sent to (story 36, D8); a tab id that is not a string is not recorded', async () => {
    hooks.add.mockResolvedValue({ id: 'm2', message: 'ship', sentAt: '2026-11-03T04:05:06.000Z', tabId: 'tab-1' });
    const { default: handler } = await import('@/pages/api/message-history');
    await callRoute(handler as never, { method: 'POST', body: { wsId: 'ws-a', message: 'ship', tabId: 'tab-1' } });
    expect(hooks.add).toHaveBeenLastCalledWith('ws-a', 'ship', 'tab-1');
    await callRoute(handler as never, { method: 'POST', body: { wsId: 'ws-a', message: 'ship', tabId: 42 } });
    expect(hooks.add).toHaveBeenLastCalledWith('ws-a', 'ship', null);
  });

  it('a failed save hands nothing to the curator', async () => {
    hooks.onOwnerMessage.mockClear();
    hooks.add.mockRejectedValue(new Error('disk full'));
    const { default: handler } = await import('@/pages/api/message-history');
    const res = await callRoute(handler as never, { method: 'POST', body: { wsId: 'ws-a', message: 'x' } });
    expect(res.status).toBe(500);
    expect(hooks.onOwnerMessage).not.toHaveBeenCalled();
  });
});
