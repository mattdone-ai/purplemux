import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const statusManager = vi.hoisted(() => ({
  applyAgentHookMeta: vi.fn(),
  handleToolActivity: vi.fn(),
  handleProviderEvent: vi.fn(),
  poll: vi.fn(async () => {}),
}));

vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => statusManager }));
vi.mock('@/lib/cli-token', () => ({ verifyCliToken: () => true }));
vi.mock('@/lib/access-filter', () => ({ isRequestAllowed: () => true }));

const post = async (body: unknown, query: Record<string, string> = {}) => {
  const { default: handler } = await import('@/pages/api/status/hook');
  const res = {
    status() { return this; },
    json() { return this; },
    setHeader() { return this; },
    end() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', query, body, socket: { remoteAddress: '127.0.0.1' }, headers: {} } as unknown as NextApiRequest, res);
};

describe('POST /api/status/hook (Claude): SessionStart source (L30)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('passes a known source through to the status manager', async () => {
    await post({ event: 'session-start', session: 'pt-ws-1-pane-a-tab-w', source: 'compact' });
    expect(statusManager.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-ws-1-pane-a-tab-w', { kind: 'session-start', source: 'compact' }, undefined, { replayed: false });
  });

  it('preserves occurrence time for delayed live hooks and leaves legacy hooks unattributed', async () => {
    const at = Date.now() - 1000;
    await post({ event: 'stop', session: 'pt-ws-1-pane-a-tab-w' }, { occurredAt: String(at) });
    expect(statusManager.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-ws-1-pane-a-tab-w', { kind: 'stop' }, at, { replayed: false });
  });

  it('drops an unknown source and keeps the event', async () => {
    await post({ event: 'session-start', session: 'pt-ws-1-pane-a-tab-w', source: 'weird' });
    expect(statusManager.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-ws-1-pane-a-tab-w', { kind: 'session-start' }, undefined, { replayed: false });
  });
});
