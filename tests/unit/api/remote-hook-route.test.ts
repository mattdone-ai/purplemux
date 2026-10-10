import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ADR-0022 slice (b): a remote tab's hook is authorized by that tab's own token, for that
// tab's session only, and applied with its transcript copy brought up to date first.

const sm = vi.hoisted(() => ({
  applyAgentHookMeta: vi.fn(),
  handleProviderEvent: vi.fn(),
  handleToolActivity: vi.fn(),
  poll: vi.fn(async () => {}),
}));
const transcript = vi.hoisted(() => ({
  order: [] as string[],
  bindRemoteTranscript: vi.fn(async () => { transcript.order.push('bind'); return '/home/x/.purplemux/remote-transcripts/tab-r/0f9e2c4a-1111-2222-3333-444455556666.jsonl'; }),
  syncRemoteTranscript: vi.fn(async () => { transcript.order.push('sync'); return true; }),
}));
const tokens = vi.hoisted(() => ({
  map: {
    'tok-r': { tabId: 'tab-r', record: { token: 'tok-r', workspaceId: 'ws-a', sessionName: 'pt-ws-a-pane-p-tab-r', createdAt: '' } },
    'tok-l': { tabId: 'tab-l', record: { token: 'tok-l', workspaceId: 'ws-a', sessionName: 'pt-ws-a-pane-p-tab-l', createdAt: '' } },
  } as Record<string, unknown>,
}));

vi.mock('@/lib/status-manager', () => ({ getStatusManager: () => sm }));
vi.mock('@/lib/remote-transcript', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/remote-transcript')>()),
  bindRemoteTranscript: transcript.bindRemoteTranscript,
  syncRemoteTranscript: transcript.syncRemoteTranscript,
}));
vi.mock('@/lib/session-host', () => ({ sessionHostOf: async (s: string) => (s.endsWith('tab-r') ? 'ai-server' : null) }));
vi.mock('@/lib/tab-token', () => ({ resolveTabToken: (t: string) => tokens.map[t] ?? null }));
vi.mock('@/lib/cli-token', () => ({ verifyCliToken: (req: NextApiRequest) => req.headers['x-pmux-token'] === 'global' }));
vi.mock('@/lib/access-filter', () => ({ isRequestAllowed: () => true }));

const SID = '0f9e2c4a-1111-2222-3333-444455556666';
const R = 'pt-ws-a-pane-p-tab-r';

const post = async (query: Record<string, string>, token: string | undefined, body: unknown) => {
  const { default: handler } = await import('@/pages/api/status/hook');
  const state = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) { state.statusCode = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
    end() { return this; },
    setHeader() { return this; },
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', query, headers: token ? { 'x-pmux-token': token } : {}, body, socket: { remoteAddress: '100.106.29.22' } } as unknown as NextApiRequest, res);
  return state;
};

const stopBody = { session_id: SID, transcript_path: `/home/mdone/.claude/projects/-home-mdone/${SID}.jsonl`, hook_event_name: 'Stop' };

describe('remote Claude hooks on /api/status/hook (ADR-0022)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transcript.order = [];
  });

  it('applies a stop from the tab\'s own token after binding and syncing its transcript', async () => {
    sm.applyAgentHookMeta.mockImplementation(() => { transcript.order.push('meta'); });
    sm.handleProviderEvent.mockImplementation(() => { transcript.order.push('event'); return true; });
    const state = await post({ remote: 'claude', event: 'stop', session: R, occurredAt: '1791660000000' }, 'tok-r', stopBody);
    expect(state.statusCode).toBe(204);
    expect(transcript.order).toEqual(['bind', 'sync', 'meta', 'event']);
    expect(transcript.bindRemoteTranscript).toHaveBeenCalledWith({ session: R, host: 'ai-server', sessionId: SID, remotePath: stopBody.transcript_path });
    expect(sm.applyAgentHookMeta).toHaveBeenCalledWith('claude', R, { sessionId: SID, jsonlPath: expect.stringContaining(`${SID}.jsonl`) }, 1791660000000);
    expect(sm.handleProviderEvent).toHaveBeenCalledWith('claude', R, { kind: 'stop' }, 1791660000000);
  });

  it('maps a notification and a compaction session start like the local hook', async () => {
    await post({ remote: 'claude', event: 'notification', session: R }, 'tok-r', { notification_type: 'permission_prompt' });
    await post({ remote: 'claude', event: 'session-start', session: R }, 'tok-r', { source: 'compact' });
    expect(sm.handleProviderEvent.mock.calls.map((c) => c[2])).toEqual([
      { kind: 'notification', notificationType: 'permission_prompt' },
      { kind: 'session-start', source: 'compact' },
    ]);
  });

  it('feeds tool activity to the signal engine, not the work state', async () => {
    await post({ remote: 'claude', event: 'post-tool', kind: 'tool', session: R }, 'tok-r', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(sm.handleProviderEvent).not.toHaveBeenCalled();
  });

  it('a transcript path that is not a Claude transcript is never read; the event still applies', async () => {
    await post({ remote: 'claude', event: 'stop', session: R }, 'tok-r', { session_id: SID, transcript_path: '/home/mdone/.ssh/id_ed25519' });
    expect(transcript.bindRemoteTranscript).not.toHaveBeenCalled();
    expect(sm.handleProviderEvent).toHaveBeenCalledWith('claude', R, { kind: 'stop' }, undefined);
  });

  it.each([
    ['no token', undefined, R],
    ['the global CLI token', 'global', R],
    ['another tab\'s token', 'tok-l', R],
    ['a token for a local session', 'tok-l', 'pt-ws-a-pane-p-tab-l'],
    ['an unknown token', 'nope', R],
  ])('refuses %s', async (_label, token, session) => {
    const state = await post({ remote: 'claude', event: 'stop', session }, token, stopBody);
    expect(state.statusCode).toBe(403);
    expect(sm.handleProviderEvent).not.toHaveBeenCalled();
  });

  it('a tab token cannot reach the local hook paths, whose body names the session', async () => {
    expect((await post({}, 'tok-r', { event: 'stop', session: 'pt-ws-a-pane-p-tab-l' })).statusCode).toBe(403);
    expect((await post({ remote: 'codex', session: R }, 'tok-r', {})).statusCode).toBe(400);
    expect(sm.handleProviderEvent).not.toHaveBeenCalled();
  });

  it('the global token still drives the local hook as before', async () => {
    const state = await post({}, 'global', { event: 'stop', session: 'pt-ws-a-pane-p-tab-l' });
    expect(state.statusCode).toBe(204);
    expect(sm.handleProviderEvent).toHaveBeenCalledWith('claude', 'pt-ws-a-pane-p-tab-l', { kind: 'stop' }, undefined);
  });
});
