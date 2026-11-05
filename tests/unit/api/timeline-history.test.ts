import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ITimelineEntry } from '@/types/timeline';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const WORKSPACE_ID = 'ws-history';
const CLAUDE_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const CODEX_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface IHistoryBody {
  entries: ITimelineEntry[];
  nextSeq: number;
  hasMore: boolean;
  sessionRevision: string;
}

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = { statusCode: 0, body: undefined, res: undefined as unknown as NextApiResponse };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

const userLine = (index: number) => JSON.stringify({
  uuid: `uuid-${index}`,
  sessionId: CLAUDE_SESSION_ID,
  timestamp: `2026-08-16T00:00:00.${String(index).padStart(3, '0')}Z`,
  type: 'user',
  message: { role: 'user', content: `message ${index}` },
});

const claudeConversation = (count: number, from = 0): string[] =>
  Array.from({ length: count }, (_, i) => userLine(from + i));

const codexLine = (payload: Record<string, unknown>, type: string, second: number) => JSON.stringify({
  timestamp: `2026-08-16T00:00:${String(second).padStart(2, '0')}.000Z`,
  type,
  payload,
});

const writeClaudeSession = async (home: string, lines: string[]): Promise<string> => {
  const projectDir = path.join(
    home, '.purplemux', 'workspaces', WORKSPACE_ID, 'claude-home', 'projects', '-home-me-proj',
  );
  await fs.mkdir(projectDir, { recursive: true });
  const file = path.join(projectDir, `${CLAUDE_SESSION_ID}.jsonl`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
};

const writeCodexSession = async (home: string, lines: string[]): Promise<string> => {
  const now = new Date();
  const dayDir = path.join(
    home, '.codex', 'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  );
  await fs.mkdir(dayDir, { recursive: true });
  const file = path.join(dayDir, `rollout-2026-08-16T00-00-00-${CODEX_SESSION_ID}.jsonl`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
};

const codexSession = (): string[] => [
  codexLine({ id: CODEX_SESSION_ID, timestamp: '2026-08-16T00:00:00.000Z', cwd: '/tmp/proj' }, 'session_meta', 0),
  codexLine({ type: 'user_message', message: 'read that file' }, 'event_msg', 1),
  codexLine(
    { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: JSON.stringify({ path: '/tmp/a.txt' }) },
    'response_item',
    2,
  ),
  codexLine({ type: 'function_call_output', call_id: 'call-1', output: 'contents' }, 'response_item', 3),
  codexLine({ type: 'agent_message', message: 'done' }, 'event_msg', 4),
];

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

describe('GET /api/timeline/history', () => {
  let home: string;
  let handler: THandler;

  const call = async (query: Record<string, string>): Promise<IFakeResponse> => {
    const response = fakeResponse();
    await handler({ method: 'GET', query } as unknown as NextApiRequest, response.res);
    return response;
  };

  const page = async (query: Record<string, string>): Promise<IHistoryBody> => {
    const response = await call(query);
    expect(response.statusCode).toBe(200);
    return response.body as IHistoryBody;
  };

  const claudeKey = `claude:${WORKSPACE_ID}:${CLAUDE_SESSION_ID}`;
  const codexKey = `codex:${WORKSPACE_ID}:${CODEX_SESSION_ID}`;

  beforeEach(async () => {
    vi.resetModules();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-history-'));
    mockHome.value = home;
    ({ default: handler } = await import('@/pages/api/timeline/history'));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('pages a workspace Claude session forward with no gap and no overlap', async () => {
    const file = await writeClaudeSession(home, claudeConversation(260));
    const { parseSessionFile } = await import('@/lib/session-parser');
    const whole = await parseSessionFile(file);

    const first = await page({ sessionKey: claudeKey, afterSeq: '-1', limit: '200' });

    expect(first.entries).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    expect(first.sessionRevision).not.toBe('');
    expect(first.nextSeq).toBe((first.entries[199].seq ?? 0) + 1);
    const seqs = first.entries.map((entry) => entry.seq ?? -1);
    expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1])).toBe(true);

    const second = await page({
      sessionKey: claudeKey,
      afterSeq: String(first.entries[199].seq),
      limit: '200',
    });

    expect(second.entries).toHaveLength(60);
    expect(second.hasMore).toBe(false);
    expect(second.sessionRevision).toBe(first.sessionRevision);
    expect([...first.entries, ...second.entries].map((entry) => entry.id))
      .toEqual(whole.entries.map((entry) => entry.id));
    expect([...first.entries, ...second.entries].map((entry) => entry.seq))
      .toEqual(whole.entries.map((entry) => entry.seq));
  });

  it('returns the same page whether the client echoes nextSeq or the last seq', async () => {
    await writeClaudeSession(home, claudeConversation(50));

    const first = await page({ sessionKey: claudeKey, afterSeq: '-1', limit: '20' });
    const byNextSeq = await page({ sessionKey: claudeKey, afterSeq: String(first.nextSeq), limit: '20' });
    const byLastSeq = await page({
      sessionKey: claudeKey,
      afterSeq: String(first.entries[19].seq),
      limit: '20',
    });

    expect(byNextSeq.entries.map((entry) => entry.id)).toEqual(byLastSeq.entries.map((entry) => entry.id));
    expect(byNextSeq.entries).toHaveLength(20);
    expect(byNextSeq.entries[0].id).toBe('uuid-20');
  });

  it('holds nextSeq still when the page is empty so polling cannot walk past an entry', async () => {
    await writeClaudeSession(home, claudeConversation(3));

    const all = await page({ sessionKey: claudeKey, afterSeq: '-1', limit: '200' });
    const empty = await page({ sessionKey: claudeKey, afterSeq: String(all.nextSeq), limit: '200' });
    const stillEmpty = await page({ sessionKey: claudeKey, afterSeq: String(empty.nextSeq), limit: '200' });

    expect(empty.entries).toHaveLength(0);
    expect(empty.hasMore).toBe(false);
    expect(stillEmpty.nextSeq).toBe(empty.nextSeq);
  });

  it('returns only the appended entries when the session grows', async () => {
    const file = await writeClaudeSession(home, claudeConversation(40));

    const before = await page({ sessionKey: claudeKey, afterSeq: '-1', limit: '500' });
    await fs.appendFile(file, `${claudeConversation(20, 40).join('\n')}\n`, 'utf-8');

    const after = await page({
      sessionKey: claudeKey,
      afterSeq: String(before.entries[39].seq),
      limit: '500',
    });

    expect(after.entries).toHaveLength(20);
    expect(after.entries[0].id).toBe('uuid-40');
    expect(after.entries[19].id).toBe('uuid-59');
    expect(after.hasMore).toBe(false);
  });

  it('keeps sessionRevision stable across an append', async () => {
    const file = await writeClaudeSession(home, claudeConversation(5));

    const before = await page({ sessionKey: claudeKey, afterSeq: '-1' });
    await fs.appendFile(file, `${claudeConversation(2, 5).join('\n')}\n`, 'utf-8');
    const after = await page({ sessionKey: claudeKey, afterSeq: String(before.nextSeq) });

    expect(after.sessionRevision).toBe(before.sessionRevision);
    expect(after.entries).toHaveLength(2);
  });

  it('changes sessionRevision when the file is truncated and re-appended', async () => {
    const file = await writeClaudeSession(home, claudeConversation(40));

    const before = await page({ sessionKey: claudeKey, afterSeq: '-1' });
    await fs.writeFile(file, `${claudeConversation(3, 100).join('\n')}\n`, 'utf-8');
    const after = await page({ sessionKey: claudeKey, afterSeq: String(before.nextSeq) });

    expect(after.sessionRevision).not.toBe(before.sessionRevision);

    const restarted = await page({ sessionKey: claudeKey, afterSeq: '-1' });
    expect(restarted.entries).toHaveLength(3);
    expect(restarted.entries[0].id).toBe('uuid-100');
  });

  it('changes sessionRevision when a compaction rewrites the file to the same first record', async () => {
    const file = await writeClaudeSession(home, claudeConversation(40));

    const before = await page({ sessionKey: claudeKey, afterSeq: '-1' });
    await fs.writeFile(file, `${claudeConversation(4).join('\n')}\n`, 'utf-8');
    const after = await page({ sessionKey: claudeKey, afterSeq: '-1' });

    expect(after.entries[0].id).toBe(before.entries[0].id);
    expect(after.sessionRevision).not.toBe(before.sessionRevision);
  });

  it('keeps ids, seqs and tool correlation stable when a Codex pair splits across pages', async () => {
    await writeCodexSession(home, codexSession());

    const whole = await page({ sessionKey: codexKey, afterSeq: '-1', limit: '500' });
    const callIndex = whole.entries.findIndex((entry) => entry.type === 'tool-call');
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(whole.entries.some((entry) => entry.type === 'tool-result')).toBe(true);

    const first = await page({ sessionKey: codexKey, afterSeq: '-1', limit: String(callIndex + 1) });
    expect(first.entries.at(-1)?.type).toBe('tool-call');
    expect(first.hasMore).toBe(true);

    const second = await page({ sessionKey: codexKey, afterSeq: String(first.nextSeq), limit: '500' });
    const paged = [...first.entries, ...second.entries];

    expect(paged.map((entry) => entry.id)).toEqual(whole.entries.map((entry) => entry.id));
    expect(paged.map((entry) => entry.seq)).toEqual(whole.entries.map((entry) => entry.seq));
    expect(second.sessionRevision).toBe(first.sessionRevision);

    const toolCall = first.entries.at(-1);
    const toolResult = second.entries.find((entry) => entry.type === 'tool-result');
    expect(toolCall && 'toolUseId' in toolCall ? toolCall.toolUseId : null).toBe('call-1');
    expect(toolResult && 'toolUseId' in toolResult ? toolResult.toolUseId : null).toBe('call-1');
  });

  it('pages a session too large to parse whole, window by window', async () => {
    const bulky = (index: number) => JSON.stringify({
      uuid: `uuid-${index}`,
      sessionId: CLAUDE_SESSION_ID,
      timestamp: '2026-08-16T00:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: `${index}:${'x'.repeat(40_000)}` },
    });
    await writeClaudeSession(home, Array.from({ length: 300 }, (_, i) => bulky(i)));

    const collected: ITimelineEntry[] = [];
    let cursor = -1;
    let calls = 0;
    let hasMore = true;
    while (hasMore && calls < 20) {
      const body = await page({ sessionKey: claudeKey, afterSeq: String(cursor), limit: '50' });
      collected.push(...body.entries);
      cursor = body.nextSeq;
      hasMore = body.hasMore;
      calls++;
    }

    expect(collected.map((entry) => entry.id)).toEqual(
      Array.from({ length: 300 }, (_, i) => `uuid-${i}`),
    );
    const cache = (globalThis as unknown as { __ptHistoryIndex: Map<string, unknown> }).__ptHistoryIndex;
    expect([...cache.keys()].some((key) => key.startsWith(home))).toBe(false);
    const windowed = collected.map((entry) => entry.seq ?? -1);
    expect(windowed.every((seq, index) => index === 0 || seq > windowed[index - 1])).toBe(true);
  });

  it('clamps limit to 500 and defaults afterSeq to the whole session', async () => {
    await writeClaudeSession(home, claudeConversation(520));

    const clamped = await page({ sessionKey: claudeKey, limit: '9000' });

    expect(clamped.entries).toHaveLength(500);
    expect(clamped.hasMore).toBe(true);
  });

  it('rejects a malformed query', async () => {
    await writeClaudeSession(home, claudeConversation(2));

    await expect(call({ afterSeq: '0' })).resolves.toMatchObject({ statusCode: 400 });
    await expect(call({ sessionKey: claudeKey, afterSeq: '-2' })).resolves.toMatchObject({ statusCode: 400 });
    await expect(call({ sessionKey: claudeKey, afterSeq: 'x' })).resolves.toMatchObject({ statusCode: 400 });
    await expect(call({ sessionKey: claudeKey, limit: '0' })).resolves.toMatchObject({ statusCode: 400 });
  });

  it('refuses a session id that carries a path separator or a traversal', async () => {
    await writeClaudeSession(home, claudeConversation(2));

    const traversal = await call({ sessionKey: `claude:${WORKSPACE_ID}:../../../etc/passwd` });
    expect(traversal).toMatchObject({ statusCode: 400, body: { error: 'bad-session-key' } });

    const dotdot = await call({ sessionKey: `claude:${WORKSPACE_ID}:..` });
    expect(dotdot).toMatchObject({ statusCode: 400, body: { error: 'bad-session-key' } });

    const unknownProvider = await call({ sessionKey: `gemini:${WORKSPACE_ID}:${CLAUDE_SESSION_ID}` });
    expect(unknownProvider).toMatchObject({ statusCode: 400, body: { error: 'bad-session-key' } });

    const shapeless = await call({ sessionKey: 'claude-only' });
    expect(shapeless).toMatchObject({ statusCode: 400, body: { error: 'bad-session-key' } });
  });

  it('reports session-not-found for an unknown workspace or session', async () => {
    await writeClaudeSession(home, claudeConversation(2));

    const noWorkspace = await call({ sessionKey: `claude:ws-missing:${CLAUDE_SESSION_ID}` });
    expect(noWorkspace).toMatchObject({ statusCode: 404, body: { error: 'session-not-found' } });

    const noSession = await call({ sessionKey: `claude:${WORKSPACE_ID}:99999999-0000-0000-0000-000000000000` });
    expect(noSession).toMatchObject({ statusCode: 404, body: { error: 'session-not-found' } });

    const noCodexSession = await call({ sessionKey: `codex:${WORKSPACE_ID}:${CODEX_SESSION_ID}` });
    expect(noCodexSession).toMatchObject({ statusCode: 404, body: { error: 'session-not-found' } });
  });

  it('never resolves a key to a transcript outside the allowed roots', async () => {
    const outside = path.join(home, 'elsewhere', 'projects', 'p');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, `${CLAUDE_SESSION_ID}.jsonl`), `${userLine(0)}\n`, 'utf-8');

    const { resolveSessionKey } = await import('@/lib/session-resolver');
    const resolution = await resolveSessionKey(claudeKey);

    expect(resolution).toEqual({ ok: false, error: 'session-not-found' });
  });

  it('rejects a non-GET method', async () => {
    const response = fakeResponse();
    await handler({ method: 'POST', query: {} } as unknown as NextApiRequest, response.res);
    expect(response.statusCode).toBe(405);
  });
});

describe('history auth', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-history-auth-'));
  });

  afterEach(async () => {
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('is covered by the proxy matcher, unlike the token-only /api/cli routes', async () => {
    const { config } = await import('@/proxy');
    const matcher = new RegExp(`^${config.matcher[0]}$`);

    expect(matcher.test('/api/timeline/history')).toBe(true);
    expect(matcher.test('/api/timeline/sessions-v2')).toBe(true);
    expect(matcher.test('/api/cli/tabs')).toBe(false);
  });

  it('lets the CLI token through without a cookie', async () => {
    const { NextRequest } = await import('next/server');
    const { getCliToken } = await import('@/lib/cli-token');
    const { proxy } = await import('@/proxy');

    const url = 'http://localhost:8022/api/timeline/history?sessionKey=claude:global:s';
    const authorized = await proxy(new NextRequest(url, {
      headers: { 'x-pmux-token': getCliToken() },
    }));
    const anonymous = await proxy(new NextRequest(url));

    expect(authorized.status).toBe(200);
    expect(anonymous.status).toBe(401);
  });
});
