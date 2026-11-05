import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// AC 5: the statusline's context reading reaches the seat (ADR-0036 §1): the last request's input, cache writes
// and cache reads, keyed by the session it names.

const status = vi.hoisted(() => ({ recordContextReading: vi.fn() }));

vi.mock('@/lib/cli-token', () => ({ verifyCliToken: () => true }));
vi.mock('@/lib/rate-limits-cache', () => ({ writeProviderRateLimits: vi.fn(async () => {}) }));
vi.mock('@/lib/session-stats', () => ({ writeSessionStats: vi.fn(async () => {}), readSessionStats: vi.fn(async () => null) }));
vi.mock('@/lib/timeline-server', () => ({ broadcastSessionStats: vi.fn() }));
vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => status }));
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});

const post = async (body: unknown) => {
  const { default: handler } = await import('@/pages/api/status/statusline');
  const res = { status: () => res, end: () => res, send: () => res, json: () => res, setHeader: () => res } as unknown as NextApiResponse;
  await handler({ method: 'POST', headers: {}, body } as unknown as NextApiRequest, res);
};

describe('POST /api/status/statusline: the context reading', () => {
  beforeEach(() => {
    status.recordContextReading.mockClear();
  });

  it('records input + cache writes + cache reads for the session', async () => {
    await post({
      session_id: 'sess-1', workspace: { project_dir: '/nonexistent-project' },
      context_window: { current_usage: { input_tokens: 12, cache_creation_input_tokens: 3_000, cache_read_input_tokens: 290_000, output_tokens: 900 } },
    });
    expect(status.recordContextReading).toHaveBeenCalledWith('sess-1', 293_012);
  });

  it('records nothing without a session or a current usage', async () => {
    await post({ context_window: { current_usage: { input_tokens: 5 } }, workspace: { project_dir: '/nonexistent-project' } });
    await post({ session_id: 'sess-1', context_window: { used_percentage: 40 }, workspace: { project_dir: '/nonexistent-project' } });
    expect(status.recordContextReading).not.toHaveBeenCalled();
  });
});
