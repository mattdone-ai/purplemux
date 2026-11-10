import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const WORKSPACE_A = 'ws-alpha';
const WORKSPACE_B = 'ws-beta';
const DIR_A = '/work/alpha';
const DIR_B = '/work/beta';
const CLAUDE_WS_SESSION = '11111111-1111-1111-1111-111111111111';
const CLAUDE_GLOBAL_SESSION = '22222222-2222-2222-2222-222222222222';
const CODEX_SESSION = '33333333-3333-3333-3333-333333333333';
const GROK_SESSION = '44444444-4444-4444-4444-444444444444';

interface ISearchHitBody {
  sessionKey: string;
  seq: number;
  entryId: string;
  type: string;
  timestamp: number;
  snippet: string;
  workspaceId: string;
  workspaceName: string;
}

interface ISearchBody {
  hits: ISearchHitBody[];
  total: number;
  truncated: boolean;
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

const claudeRecord = (index: number, type: 'user' | 'assistant', content: unknown) => JSON.stringify({
  uuid: `uuid-${type}-${index}`,
  sessionId: CLAUDE_WS_SESSION,
  timestamp: `2026-08-16T00:00:${String(index).padStart(2, '0')}.000Z`,
  type,
  message: { role: type, content },
});

const TOOL_OUTPUT = [
  'total 12',
  'drwxr-xr-x 2 me me 4096 settlement',
  'the chartreuse rollup landed',
  'done',
].join('\n');

const claudeConversation = (): string[] => [
  claudeRecord(0, 'user', 'find the chartreuse batch'),
  claudeRecord(1, 'assistant', [
    { type: 'thinking', thinking: 'chartreuse is only in my head here' },
    { type: 'text', text: 'The chartreuse rollup is ready to ship.' },
    { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'grep chartreuse /tmp/ledger.txt' } },
  ]),
  claudeRecord(2, 'user', [{ type: 'tool_result', tool_use_id: 'call-1', content: TOOL_OUTPUT }]),
  claudeRecord(3, 'user', 'unrelated follow-up about invoices'),
];

const globalConversation = (): string[] => [
  JSON.stringify({
    uuid: 'uuid-global-0',
    sessionId: CLAUDE_GLOBAL_SESSION,
    timestamp: '2026-08-16T01:00:00.000Z',
    type: 'user',
    message: { role: 'user', content: 'a chartreuse note in the unscoped home' },
  }),
];

const codexLine = (payload: Record<string, unknown>, type: string, second: number) => JSON.stringify({
  timestamp: `2026-08-16T00:00:${String(second).padStart(2, '0')}.000Z`,
  type,
  payload,
});

const codexConversation = (): string[] => [
  codexLine({ id: CODEX_SESSION, timestamp: '2026-08-16T00:00:00.000Z', cwd: DIR_A }, 'session_meta', 0),
  codexLine({ type: 'user_message', message: 'check the chartreuse invoice' }, 'event_msg', 1),
  codexLine(
    {
      type: 'function_call',
      call_id: 'call-c1',
      name: 'shell',
      arguments: JSON.stringify({ command: ['bash', '-lc', 'grep chartreuse ledger'] }),
    },
    'response_item',
    2,
  ),
  codexLine({ type: 'function_call_output', call_id: 'call-c1', output: `${TOOL_OUTPUT}\n` }, 'response_item', 3),
];

const setMtime = async (file: string, iso: string): Promise<void> => {
  const when = new Date(iso);
  await fs.utimes(file, when, when);
};

const writeWorkspaces = async (home: string): Promise<void> => {
  await fs.mkdir(path.join(home, '.purplemux'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.purplemux', 'workspaces.json'),
    JSON.stringify({
      workspaces: [
        { id: WORKSPACE_A, name: 'Alpha', directories: [DIR_A] },
        { id: WORKSPACE_B, name: 'Beta', directories: [DIR_B] },
      ],
    }),
    'utf-8',
  );
};

const writeWorkspaceClaudeSession = async (
  home: string,
  lines: string[],
  sessionId = CLAUDE_WS_SESSION,
): Promise<string> => {
  const dir = path.join(home, '.purplemux', 'workspaces', WORKSPACE_A, 'claude-home', 'projects', '-work-alpha');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
};

const writeGlobalClaudeSession = async (home: string, lines: string[]): Promise<string> => {
  const dir = path.join(home, '.claude', 'projects', '-home-me-notes');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${CLAUDE_GLOBAL_SESSION}.jsonl`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
};

const writeCodexSession = async (home: string, lines: string[]): Promise<string> => {
  const dir = path.join(home, '.codex', 'sessions', '2026', '08', '16');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-16T00-00-00-${CODEX_SESSION}.jsonl`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8');
  return file;
};

/**
 * An ACP `updates.jsonl` the way Grok Build writes one. `grokHome` selects the
 * store: `~/.grok` for an ad-hoc tab, a workspace `grok-home` for a scoped one.
 */
const grokUpdate = (update: Record<string, unknown>): string => JSON.stringify({
  timestamp: 1786853311,
  method: 'session/update',
  params: { sessionId: GROK_SESSION, update, _meta: { agentTimestampMs: 1786853311000 } },
});

const writeGrokStore = async (home: string, grokHome?: string): Promise<string> => {
  const root = grokHome ?? path.join(home, '.grok');
  const dir = path.join(root, 'sessions', encodeURIComponent(DIR_B), GROK_SESSION);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'updates.jsonl');
  await fs.writeFile(file, `${[
    grokUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'is the chartreuse ledger loaded?' } }),
    grokUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'chartreuse should not be searchable from a reasoning block' } }),
    grokUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Yes, loaded.' } }),
  ].join('\n')}\n`, 'utf-8');
  await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify({
    info: { id: GROK_SESSION, cwd: DIR_B },
    created_at: '2026-08-16T00:30:00.000Z',
    updated_at: '2026-08-16T00:30:00.000Z',
    num_messages: 3,
  }));
  return file;
};

type THandler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

describe('GET /api/timeline/search', () => {
  let home: string;
  let handler: THandler;

  const call = async (query: Record<string, string>): Promise<IFakeResponse> => {
    const response = fakeResponse();
    await handler({ method: 'GET', query } as unknown as NextApiRequest, response.res);
    return response;
  };

  const search = async (query: Record<string, string>): Promise<ISearchBody> => {
    const response = await call(query);
    expect(response.statusCode).toBe(200);
    return response.body as ISearchBody;
  };

  beforeEach(async () => {
    vi.resetModules();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-search-'));
    mockHome.value = home;
    await writeWorkspaces(home);
    ({ default: handler } = await import('@/pages/api/timeline/search'));
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('finds the term in messages, tool input and tool output but never in thinking', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());

    const { hits, total, truncated } = await search({ q: 'chartreuse' });

    expect(total).toBe(4);
    expect(truncated).toBe(false);
    expect(hits.map((hit) => hit.type)).toEqual([
      'user-message',
      'assistant-message',
      'tool-call',
      'tool-result',
    ]);
    expect(hits.every((hit) => hit.snippet.toLowerCase().includes('chartreuse'))).toBe(true);
    expect(hits.every((hit) => hit.entryId.length > 0)).toBe(true);
    expect(hits.map((hit) => hit.seq)).toEqual([...hits.map((hit) => hit.seq)].sort((a, b) => a - b));
    expect(hits[0].sessionKey).toBe(`claude:${WORKSPACE_A}:${CLAUDE_WS_SESSION}`);
    expect(hits[0].workspaceId).toBe(WORKSPACE_A);
    expect(hits[0].workspaceName).toBe('Alpha');
  });

  it('finds a term that only the raw tool output holds, past the entry summary', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());

    const { hits } = await search({ q: 'drwxr-xr-x' });

    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe('tool-result');
    expect(hits[0].snippet).toContain('drwxr-xr-x');
  });

  it('requires every term of a multi-word query and ignores case', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());

    expect((await search({ q: 'CHARTREUSE Rollup' })).total).toBe(2);
    expect((await search({ q: 'chartreuse mauve' })).total).toBe(0);
  });

  it('resolves the workspace of every corpus and labels the unscoped home global', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());
    await writeGlobalClaudeSession(home, globalConversation());
    await writeCodexSession(home, codexConversation());
    await writeGrokStore(home);

    const { hits } = await search({ q: 'chartreuse' });
    const byKey = new Map(hits.map((hit) => [hit.sessionKey.split(':')[0] + ':' + hit.workspaceId, hit]));

    expect(byKey.get(`claude:${WORKSPACE_A}`)?.workspaceName).toBe('Alpha');
    expect(byKey.get('claude:global')?.workspaceName).toBe('global');
    expect(byKey.get(`codex:${WORKSPACE_A}`)?.workspaceName).toBe('Alpha');
    expect(byKey.get(`grok:${WORKSPACE_B}`)?.workspaceName).toBe('Beta');
    // An ad-hoc grok tab runs against ~/.grok, so its key is global even though
    // the hit is attributed to Beta by cwd.
    expect(byKey.get(`grok:${WORKSPACE_B}`)?.sessionKey).toBe(`grok:global:${GROK_SESSION}`);
    expect(byKey.get('claude:global')?.sessionKey).toBe(`claude:global:${CLAUDE_GLOBAL_SESSION}`);
  });

  it('scans only the requested workspace', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());
    await writeGlobalClaudeSession(home, globalConversation());
    await writeCodexSession(home, codexConversation());
    await writeGrokStore(home);

    const alpha = await search({ q: 'chartreuse', workspaceId: WORKSPACE_A });
    expect(new Set(alpha.hits.map((hit) => hit.workspaceId))).toEqual(new Set([WORKSPACE_A]));
    expect(new Set(alpha.hits.map((hit) => hit.sessionKey.split(':')[0]))).toEqual(new Set(['claude', 'codex']));

    const global = await search({ q: 'chartreuse', workspaceId: 'global' });
    expect(global.hits.map((hit) => hit.sessionKey)).toEqual([`claude:global:${CLAUDE_GLOBAL_SESSION}`]);

    // The hit is ATTRIBUTED to Beta by cwd; the KEY comes from the store the
    // session sits in, which for an ad-hoc tab is the unscoped ~/.grok — the
    // same key the live socket and sessions-v2 produce.
    const beta = await search({ q: 'chartreuse', workspaceId: WORKSPACE_B });
    expect(beta.hits.map((hit) => hit.sessionKey)).toEqual([`grok:global:${GROK_SESSION}`]);
    expect(new Set(beta.hits.map((hit) => hit.workspaceId))).toEqual(new Set([WORKSPACE_B]));
  });

  it('scans only the requested provider', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());
    await writeCodexSession(home, codexConversation());
    await writeGrokStore(home);

    for (const provider of ['claude', 'codex', 'grok']) {
      const { hits } = await search({ q: 'chartreuse', provider });
      expect(hits.length).toBeGreaterThan(0);
      expect(new Set(hits.map((hit) => hit.sessionKey.split(':')[0]))).toEqual(new Set([provider]));
    }
  });

  it('orders sessions by last activity and pages deterministically', async () => {
    const older = await writeWorkspaceClaudeSession(home, claudeConversation());
    const newer = await writeGlobalClaudeSession(home, globalConversation());
    await setMtime(older, '2026-08-16T00:10:00.000Z');
    await setMtime(newer, '2026-08-16T09:00:00.000Z');

    const all = await search({ q: 'chartreuse', limit: '100' });
    expect(all.total).toBe(5);
    expect(all.hits[0].workspaceId).toBe('global');

    const pages: ISearchHitBody[] = [];
    for (const offset of ['0', '2', '4']) {
      const page = await search({ q: 'chartreuse', limit: '2', offset });
      expect(page.total).toBe(5);
      // ADR-0006 defines `truncated` as "the scan stopped on its budget", not
      // "more pages exist" — `total` already says that.
      expect(page.truncated).toBe(false);
      pages.push(...page.hits);
    }

    expect(pages.map((hit) => hit.entryId)).toEqual(all.hits.map((hit) => hit.entryId));
    expect(new Set(pages.map((hit) => hit.entryId)).size).toBe(5);
  });

  it('caps the page at the contract limit', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());

    expect((await search({ q: 'chartreuse', limit: '500' })).hits).toHaveLength(4);
    expect((await search({ q: 'chartreuse', limit: '1' })).hits).toHaveLength(1);
  });

  it('never returns a filesystem path', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());
    await writeCodexSession(home, codexConversation());

    const body = JSON.stringify(await search({ q: 'chartreuse' }));

    expect(body).not.toContain(home);
    expect(body).not.toContain('jsonlPath');
    expect(body).not.toContain('.jsonl');
  });

  it('rejects a query that is too short, too long or absent', async () => {
    for (const query of [{}, { q: '' }, { q: ' a ' }, { q: 'x'.repeat(201) }]) {
      const response = await call(query as Record<string, string>);
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ error: 'bad-query' });
    }

    expect((await call({ q: 'x'.repeat(200) })).statusCode).toBe(200);
  });

  it('rejects a malformed provider, limit, offset or workspace', async () => {
    const malformed: Record<string, string>[] = [
      { q: 'chartreuse', provider: 'gemini' },
      { q: 'chartreuse', limit: '0' },
      { q: 'chartreuse', limit: 'many' },
      { q: 'chartreuse', offset: '-1' },
      { q: 'chartreuse', workspaceId: '../escape' },
    ];

    for (const query of malformed) {
      const response = await call(query);
      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({ error: 'bad-request' });
    }
  });

  it('rejects anything but GET', async () => {
    const response = fakeResponse();
    await handler({ method: 'POST', query: {} } as unknown as NextApiRequest, response.res);
    expect(response.statusCode).toBe(405);
  });

  it('returns nothing for an unknown workspace rather than falling back to every corpus', async () => {
    await writeWorkspaceClaudeSession(home, claudeConversation());

    const { hits, total } = await search({ q: 'chartreuse', workspaceId: 'ws-missing' });

    expect(hits).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('finds a term whose raw record escapes it, where the byte pre-filter cannot help', async () => {
    await writeWorkspaceClaudeSession(home, [
      claudeRecord(0, 'user', 'the operator said "chartreuse" out loud'),
    ]);

    const { hits } = await search({ q: '"chartreuse"' });

    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain('"chartreuse"');
  });

  it('stops at the scan hit cap and says so', async () => {
    const { MAX_SCAN_HITS } = await import('@/lib/timeline-search');
    const lines = Array.from(
      { length: MAX_SCAN_HITS + 200 },
      (_unused, index) => claudeRecord(index, 'user', `chartreuse note ${index}`),
    );
    await writeWorkspaceClaudeSession(home, lines);

    const { total, truncated, hits } = await search({ q: 'chartreuse', limit: '100' });

    expect(total).toBeGreaterThanOrEqual(MAX_SCAN_HITS);
    expect(truncated).toBe(true);
    expect(hits).toHaveLength(100);
  });

  it('keys a workspace grok session by its GROK_HOME, not by its cwd', async () => {
    const grokHome = path.join(home, '.purplemux', 'workspaces', WORKSPACE_A, 'grok-home');
    await writeGrokStore(home, grokHome);

    const { hits } = await search({ q: 'chartreuse', provider: 'grok' });

    expect(hits.map((hit) => hit.sessionKey)).toEqual([`grok:${WORKSPACE_A}:${GROK_SESSION}`]);
    expect(hits.map((hit) => hit.workspaceId)).toEqual([WORKSPACE_A]);
  });

  it('charges a grok session real bytes so it consumes the scan budget', async () => {
    await writeGrokStore(home);
    const { collectSearchSources } = await import('@/lib/timeline-search');

    const sources = await collectSearchSources({
      terms: ['chartreuse'],
      workspaceId: null,
      provider: 'grok',
      limit: 10,
      offset: 0,
    });

    expect(sources).toHaveLength(1);
    expect(sources[0].sizeBytes).toBeGreaterThan(0);
  });

  it('sees an appended entry once the transcript grows', async () => {
    const file = await writeWorkspaceClaudeSession(home, claudeConversation());
    expect((await search({ q: 'chartreuse' })).total).toBe(4);

    await fs.appendFile(file, `${claudeRecord(9, 'user', 'one more chartreuse note')}\n`, 'utf-8');

    expect((await search({ q: 'chartreuse' })).total).toBe(5);
  });
});

describe('search helpers', () => {
  it('windows a snippet around the first match with ellipses on both cut ends', async () => {
    const { makeSnippet, SNIPPET_MAX_LENGTH } = await import('@/lib/timeline-search');
    const text = `${'a'.repeat(400)} chartreuse ${'b'.repeat(400)}`;

    const snippet = makeSnippet(text, ['chartreuse']);

    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_LENGTH);
    expect(snippet).toContain('chartreuse');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('leaves a short entry whole and collapses its whitespace', async () => {
    const { makeSnippet } = await import('@/lib/timeline-search');

    expect(makeSnippet('a  chartreuse\n  batch', ['chartreuse'])).toBe('a chartreuse batch');
  });

  it('marks only the cut end when the match sits at the start of a long entry', async () => {
    const { makeSnippet } = await import('@/lib/timeline-search');
    const snippet = makeSnippet(`chartreuse ${'c'.repeat(500)}`, ['chartreuse']);

    expect(snippet.startsWith('chartreuse')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('ranks by session activity first, then by seq inside a session', async () => {
    const { rankHits } = await import('@/lib/timeline-search');
    const hit = (sessionKey: string, seq: number, lastActivityMs: number) => ({
      sessionKey,
      seq,
      lastActivityMs,
      entryId: `${sessionKey}#${seq}`,
      type: 'user-message' as const,
      timestamp: 0,
      snippet: '',
      workspaceId: 'global',
      workspaceName: 'global',
    });

    const ranked = rankHits([hit('a', 5, 100), hit('b', 1, 200), hit('a', 2, 100), hit('b', 9, 200)]);

    expect(ranked.map((entry) => entry.entryId)).toEqual(['b#1', 'b#9', 'a#2', 'a#5']);
  });

  it('skips the raw pre-filter for a term the record would escape', async () => {
    const { canPrefilterRaw, rawContainsAll } = await import('@/lib/timeline-search');

    expect(canPrefilterRaw(['chartreuse', 'rollup'])).toBe(true);
    expect(canPrefilterRaw(['"chartreuse"'])).toBe(false);
    expect(canPrefilterRaw(['path\\to'])).toBe(false);
    expect(rawContainsAll('{"text":"a CHARTREUSE batch"}', ['chartreuse'])).toBe(true);
    expect(rawContainsAll('{"text":"a chartreuse batch"}', ['chartreuse', 'mauve'])).toBe(false);
  });

  it('matches an entry through the same field rules the scan uses', async () => {
    const { matchEntry } = await import('@/lib/timeline-search');
    const toolResult = {
      type: 'tool-result' as const,
      id: 'r1',
      seq: 3,
      timestamp: 4,
      toolUseId: 'call-1',
      isError: false,
      summary: '9 lines',
    };

    expect(matchEntry(toolResult, ['chartreuse'])).toBe(false);
    expect(matchEntry(toolResult, ['chartreuse'], () => ({ output: 'a chartreuse line' }))).toBe(true);
    expect(matchEntry({ type: 'thinking', id: 't', seq: 1, timestamp: 1, thinking: 'chartreuse' }, ['chartreuse']))
      .toBe(false);
  });
});

/**
 * The corpus this bound was written for is hundreds of sessions and hundreds of
 * megabytes on host-b. `PMUX_SEARCH_PERF_MB` shrinks it for a quick local
 * run; the committed default is the size the acceptance criterion names.
 */
const PERF_CORPUS_MB = Number(process.env.PMUX_SEARCH_PERF_MB ?? 200);
const PERF_WARM_BUDGET_MS = 1000;
const PERF_COLD_BUDGET_MS = 3000;
const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(12);

const buildPerfCorpus = async (home: string, megabytes: number): Promise<void> => {
  const dir = path.join(home, '.claude', 'projects', '-perf');
  await fs.mkdir(dir, { recursive: true });

  for (let file = 0; file < megabytes; file++) {
    const lines: string[] = [];
    let bytes = 0;
    let index = 0;
    while (bytes < 1024 * 1024) {
      const needle = index === 3 ? ' chartreuse' : '';
      const line = JSON.stringify({
        uuid: `u-${file}-${index}`,
        sessionId: `s-${file}`,
        timestamp: '2026-08-16T00:00:00.000Z',
        type: 'user',
        message: { role: 'user', content: `${FILLER}${needle}` },
      });
      lines.push(line);
      bytes += line.length + 1;
      index++;
    }
    const name = `${String(file).padStart(8, '0')}-0000-0000-0000-000000000000.jsonl`;
    await fs.writeFile(path.join(dir, name), `${lines.join('\n')}\n`, 'utf-8');
  }
};

describe('search performance', () => {
  let home: string;
  let handler: THandler;

  beforeEach(async () => {
    vi.resetModules();
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-search-perf-'));
    mockHome.value = home;
    ({ default: handler } = await import('@/pages/api/timeline/search'));
    (await import('@/lib/search-cache')).clearSearchCache();
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('answers a warm search over the whole corpus inside the budget', async () => {
    await buildPerfCorpus(home, PERF_CORPUS_MB);
    const { searchCacheStats } = await import('@/lib/search-cache');

    const run = async (q = 'chartreuse') => {
      const response = fakeResponse();
      const started = Date.now();
      await handler({ method: 'GET', query: { q, limit: '100' } } as unknown as NextApiRequest, response.res);
      return { elapsed: Date.now() - started, body: response.body as ISearchBody };
    };

    // Each pass spends its scan budget on sessions not yet extracted, so a
    // corpus larger than one budget warms over several passes and then holds.
    let warm = await run();
    for (let pass = 0; pass < 10 && warm.body.total < PERF_CORPUS_MB; pass++) warm = await run();

    expect(warm.body.total).toBe(PERF_CORPUS_MB);
    // Warm sources are charged nothing, so the last pass reaches the end of the
    // corpus: nothing was dropped, and `truncated` says so.
    expect(warm.body.truncated).toBe(false);
    expect(warm.body.hits).toHaveLength(100);
    expect(searchCacheStats().sources).toBe(PERF_CORPUS_MB);
    expect(warm.elapsed).toBeLessThanOrEqual(PERF_WARM_BUDGET_MS);

    const miss = await run('quixotropolis');
    expect(miss.body.total).toBe(0);
    expect(miss.elapsed).toBeLessThanOrEqual(PERF_COLD_BUDGET_MS);
  }, 300_000);
});
