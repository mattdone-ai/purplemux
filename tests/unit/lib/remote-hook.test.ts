import { beforeEach, describe, expect, it, vi } from 'vitest';

// PMUX-REMOTE-RESILIENCE fix 5: a replayed remote event uses its drain's shared transcript sync; a live one syncs.

const calls = vi.hoisted(() => ({ sync: [] as string[], bind: 0, events: 0 }));
const SESSION = 'pt-ws-a-pane-p-tab-r';
const SID = '0f9e2c4a-1111-2222-3333-444455556666';
const PATH = `/home/u/.claude/projects/-home-u/${SID}.jsonl`;

vi.mock('@/lib/session-host', () => ({ sessionHostOf: async (s: string) => (s === SESSION ? 'host-b' : null) }));
vi.mock('@/lib/remote-transcript', () => ({
  isValidRemoteTranscriptPath: () => true,
  bindRemoteTranscript: async () => {
    calls.bind += 1;
    return '/local/copy.jsonl';
  },
  syncRemoteTranscript: async (session: string) => {
    calls.sync.push(session);
    return true;
  },
}));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ applyAgentHookMeta: () => {}, handleProviderEvent: () => { calls.events += 1; }, handleToolActivity: () => {} }),
}));

describe('handleRemoteClaudeHook transcript sync', () => {
  beforeEach(() => {
    calls.sync = [];
    calls.bind = 0;
    calls.events = 0;
  });

  const delivery = { query: { session: SESSION, event: 'stop', remote: 'claude' }, body: { session_id: SID, transcript_path: PATH } };

  it('a live event syncs its own copy', async () => {
    const { handleRemoteClaudeHook } = await import('@/lib/remote-hook');
    expect(await handleRemoteClaudeHook(delivery)).toEqual({ status: 204 });
    expect(calls.sync).toEqual([SESSION]);
    expect(calls.events).toBe(1);
  });

  it('a replayed event uses the drain\'s shared sync, with the session and the transcript it named', async () => {
    const { handleRemoteClaudeHook } = await import('@/lib/remote-hook');
    const shared = vi.fn(async () => true);
    expect(await handleRemoteClaudeHook({ ...delivery, replayedAt: 1, remoteTranscriptSync: shared })).toEqual({ status: 204 });
    expect(shared).toHaveBeenCalledWith(SESSION, PATH);
    expect(calls.sync).toEqual([]);
    expect(calls.bind).toBe(1);
  });
});
