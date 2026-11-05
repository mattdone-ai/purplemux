import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSpendView } from '@/lib/spend/spend-model';
import type { ISpendUsage } from '@/types/spend';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const DAY = 86_400_000;
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const D2 = utc(Date.now() - 2 * DAY);
const D3 = utc(Date.now() - 3 * DAY);

interface ILine { id?: string; uuid?: string; session?: string; day?: string; time?: string; model?: string; input?: number; output?: number;
  cacheRead?: number; cc5m?: number; cc1h?: number; sidechain?: boolean }

const assistant = ({ id, uuid, session = 's-main', day = D2, time = '12:00:00.000', model = 'claude-opus-4-6', input = 10, output = 5, cacheRead = 100,
  cc5m = 20, cc1h = 0, sidechain = false }: ILine): string => JSON.stringify({
  type: 'assistant', timestamp: `${day}T${time}Z`, sessionId: session, isSidechain: sidechain, ...(uuid ? { uuid } : {}),
  message: { ...(id ? { id } : {}), model, content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead,
      cache_creation_input_tokens: cc5m + cc1h, cache_creation: { ephemeral_5m_input_tokens: cc5m, ephemeral_1h_input_tokens: cc1h } } },
});
const user = (session = 's-main', day = D2) => JSON.stringify({ type: 'user', timestamp: `${day}T11:59:00.000Z`, sessionId: session,
  message: { role: 'user', content: 'mentions "type":"assistant" in text' } });

const home = () => mockHome.value;
const wsProjects = (ws: string) => path.join(home(), '.purplemux', 'workspaces', ws, 'claude-home', 'projects', '-proj');
const globalProjects = () => path.join(home(), '.claude', 'projects', '-proj');
const indexFile = () => path.join(home(), '.purplemux', 'stats', 'spend-index.json');

const write = async (file: string, lines: string[], newline = true) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join('\n') + (newline ? '\n' : ''));
};

const resetGlobals = () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of ['__ptSpendIndexer', '__ptSpendIndexWriteLock', '__ptCodexStatsCache', '__ptSessionTabsSeen']) delete g[key];
};

const load = async () => {
  vi.resetModules();
  return import('@/lib/spend/spend-index');
};

const tokens = (usage: ISpendUsage[], filter: (u: ISpendUsage) => boolean = () => true) =>
  usage.filter(filter).reduce((sum, u) => sum + u.input + u.output + u.cacheRead + u.cacheCreation, 0);

const LINE_TOKENS = 10 + 5 + 100 + 20;

describe('spend index', () => {
  beforeEach(async () => {
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-spend-index-'));
  });
  afterEach(async () => {
    const index = await import('@/lib/spend/spend-index');
    await index.stopSpendIndexer();
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('indexes main and subagent transcripts, each under the workspace its path names', async () => {
    await write(path.join(wsProjects('ws-a'), 's-main.jsonl'), [user(), assistant({ id: 'm1' }), assistant({ id: 'm1' }), assistant({ id: 'm2', model: '<synthetic>' })]);
    await write(path.join(wsProjects('ws-a'), 's-main', 'subagents', 'agent-1.jsonl'), [assistant({ id: 'a1', sidechain: true })]);
    await write(path.join(globalProjects(), 'g.jsonl'), [assistant({ id: 'g1', session: 'g' })]);
    await write(path.join(wsProjects('ws-a'), 'agent-legacy.jsonl'), [assistant({ id: 'legacy' })]);
    const index = await load();
    const pass = await index.runSpendIndexPass();
    expect(pass).toEqual({ filesTotal: 3, filesParsed: 3, filesGone: 0, filesExpired: 0 });
    const usage = index.spendIndexUsage();
    expect(usage.map((u) => [u.workspaceId, u.sessionId, u.sidechain])).toEqual(expect.arrayContaining([
      ['ws-a', 's-main', false], ['ws-a', 's-main', true], ['global', 'g', false],
    ]));
    expect(tokens(usage, (u) => u.workspaceId === 'ws-a' && !u.sidechain)).toBe(LINE_TOKENS);
    expect(tokens(usage, (u) => u.sidechain)).toBe(LINE_TOKENS);
    expect(index.spendIndexStatus()).toMatchObject({ state: 'ready', filesIndexed: 3, filesTotal: 3 });
    expect((await fs.stat(indexFile())).mode & 0o777).toBe(0o600);
  });

  it('parses no transcript again when nothing changed, and a read parses nothing (NFR-7)', async () => {
    await write(path.join(wsProjects('ws-a'), 's-main.jsonl'), [assistant({ id: 'm1' })]);
    const index = await load();
    await index.runSpendIndexPass();
    const parsed = index.spendIndexParseCount();
    expect((await index.runSpendIndexPass()).filesParsed).toBe(0);
    index.spendIndexUsage();
    index.spendIndexStatus();
    expect(index.spendIndexParseCount()).toBe(parsed);
  });

  it('reads a grown file from its offset and counts a message split across the boundary once', async () => {
    const file = path.join(wsProjects('ws-a'), 's-main.jsonl');
    await write(file, [assistant({ id: 'm1' }), assistant({ id: 'm2' })]);
    const index = await load();
    await index.runSpendIndexPass();
    await fs.appendFile(file, `${assistant({ id: 'm2' })}\n${assistant({ id: 'm3' })}\n`);
    expect((await index.runSpendIndexPass()).filesParsed).toBe(1);
    expect(tokens(index.spendIndexUsage())).toBe(3 * LINE_TOKENS);
  });

  it('leaves a line still being written for the next pass, and counts a whole last line without its newline', async () => {
    const file = path.join(wsProjects('ws-a'), 's-main.jsonl');
    const line = assistant({ id: 'm2' });
    await write(file, [assistant({ id: 'm1' })]);
    await fs.appendFile(file, line.slice(0, 40));
    const index = await load();
    await index.runSpendIndexPass();
    expect(tokens(index.spendIndexUsage())).toBe(LINE_TOKENS);
    await fs.appendFile(file, line.slice(40));
    await index.runSpendIndexPass();
    expect(tokens(index.spendIndexUsage())).toBe(2 * LINE_TOKENS);
    await fs.appendFile(file, `\n${assistant({ id: 'm3' })}\n`);
    await index.runSpendIndexPass();
    expect(tokens(index.spendIndexUsage())).toBe(3 * LINE_TOKENS);
  });

  it('reads a shrunk file or a new inode again from the start', async () => {
    const file = path.join(wsProjects('ws-a'), 's-main.jsonl');
    await write(file, [assistant({ id: 'm1' }), assistant({ id: 'm2' }), assistant({ id: 'm3' })]);
    const index = await load();
    await index.runSpendIndexPass();
    await write(file, [assistant({ id: 'm1' })]);
    await index.runSpendIndexPass();
    expect(tokens(index.spendIndexUsage())).toBe(LINE_TOKENS);
    const replacement = `${file}.new`;
    await write(replacement, [assistant({ id: 'x1', input: 1000 }), assistant({ id: 'x2' })]);
    await fs.rename(replacement, file);
    await index.runSpendIndexPass();
    expect(tokens(index.spendIndexUsage())).toBe(LINE_TOKENS + 990 + LINE_TOKENS);
  });

  it('keeps the usage of a transcript that left the disk, inside the 92-day window', async () => {
    const D = utc(Date.now() - 40 * DAY);
    const main = path.join(wsProjects('ws-a'), 's-gone.jsonl');
    const sub = path.join(wsProjects('ws-a'), 's-gone', 'subagents', 'agent-g.jsonl');
    const kept = path.join(wsProjects('ws-b'), 's-live.jsonl');
    await write(main, [assistant({ id: 'g1', session: 's-gone', day: D })]);
    await write(sub, [assistant({ id: 'g2', session: 's-gone', day: D, sidechain: true, input: 400 })]);
    await write(kept, [assistant({ id: 'l1', session: 's-live', day: D2 })]);

    // 1. The stats cache freezes D; the index reads both files.
    vi.resetModules();
    const statsAt = async () => {
      vi.resetModules();
      const { getStatsCache } = await import('@/lib/stats/stats-cache');
      const day = (await getStatsCache()).dailyModelTokens.find((entry) => entry.date === D);
      return Object.values(day?.tokensByModel ?? {}).reduce((sum, t) => sum + t.input + t.output + t.cacheRead + t.cacheCreation, 0);
    };
    const statsD = await statsAt();
    expect(statsD).toBe(LINE_TOKENS);
    let index = await load();
    await index.runSpendIndexPass();
    const before = index.spendIndexUsage();

    // 2. Both transcripts leave the disk with the workspace home.
    await fs.rm(main);
    await fs.rm(sub);
    const { removeWorkspaceClaudeHome } = await import('@/lib/workspace-home');
    await removeWorkspaceClaudeHome('ws-a');
    expect(await index.runSpendIndexPass()).toMatchObject({ filesGone: 2, filesExpired: 0, filesTotal: 1 });
    expect(index.spendIndexUsage()).toEqual(before);
    expect(index.spendIndexStatus()).toMatchObject({ filesIndexed: 1, filesTotal: 1 });
    expect(await statsAt()).toBe(statsD);
    const service = await import('@/lib/spend/spend-service');
    const view = await service.getSpendView({ workspaceId: 'all', from: D, to: D, by: 'day' });
    expect(view.rows).toHaveLength(1);
    expect(view.rows[0].totalTokens - view.rows[0].sidechainTokens).toBe(statsD);
    expect(view.rows[0].sidechainTokens).toBe(400 + 5 + 100 + 20);
    const byDay = await service.getSpendTokensByDay('ws-a', D);
    expect(byDay?.find((entry) => entry.day === D)?.totalTokens).toBeGreaterThan(0);

    // 3. A restart keeps the gone entries without reading anything.
    resetGlobals();
    index = await load();
    await index.loadSpendIndex();
    expect(index.spendIndexUsage()).toEqual(before);
    expect((await index.runSpendIndexPass()).filesParsed).toBe(0);
    expect(index.spendIndexParseCount()).toBe(0);

    // 4. An I/O error on a live file changes no number and forces no reread.
    const realStat = fs.stat.bind(fs);
    const spy = vi.spyOn(fs, 'stat').mockImplementation((async (target: Parameters<typeof fs.stat>[0], ...rest: unknown[]) => {
      if (String(target) === kept) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return (realStat as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.stat);
    expect(await index.runSpendIndexPass()).toMatchObject({ filesParsed: 0, filesGone: 0, filesTotal: 0 });
    expect(spy.mock.calls.some(([target]) => String(target) === kept)).toBe(true);
    expect(index.spendIndexUsage()).toEqual(before);
    spy.mockImplementation((async (target: Parameters<typeof fs.stat>[0], ...rest: unknown[]) => {
      if (String(target) === kept) throw Object.assign(new Error('too many open files'), { code: 'EMFILE' });
      return (realStat as (...args: unknown[]) => unknown)(target, ...rest);
    }) as typeof fs.stat);
    expect(await index.runSpendIndexPass()).toMatchObject({ filesParsed: 0, filesGone: 0 });
    spy.mockRestore();
    expect((await index.runSpendIndexPass()).filesParsed).toBe(0);
    expect(index.spendIndexUsage()).toEqual(before);

    // 5. A gone path that is back is read from 0 and replaces the kept entry.
    await write(main, [assistant({ id: 'n1', session: 's-gone', day: D, input: 2000 })]);
    expect((await index.runSpendIndexPass()).filesParsed).toBe(1);
    expect(tokens(index.spendIndexUsage(), (u) => u.sessionId === 's-gone' && !u.sidechain)).toBe(LINE_TOKENS + 1990);

    // 6. Once D falls before the spend floor, the gone entries expire and the day is refused.
    await fs.rm(main);
    expect((await index.runSpendIndexPass()).filesGone).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 60 * DAY);
      expect(await index.runSpendIndexPass()).toMatchObject({ filesExpired: 2, filesGone: 0 });
      expect(index.spendIndexUsage().every((u) => u.sessionId === 's-live')).toBe(true);
      expect(service.parseCliSpendQuery({ workspaceId: 'ws-a', since: D, until: D })).toEqual({ ok: false,
        error: `since: saw ${D}, expected a day on or after ${utc(Date.now() - 91 * DAY)} (spend keeps the last 92 UTC days)` });
    } finally {
      vi.useRealTimers();
    }
  });

  it('trims only the days of a gone entry that passed the floor, never a live entry', async () => {
    const old = utc(Date.now() - 95 * DAY);
    const gone = path.join(wsProjects('ws-a'), 's-mixed.jsonl');
    const live = path.join(wsProjects('ws-a'), 's-old-live.jsonl');
    await write(gone, [assistant({ id: 'o1', session: 's-mixed', day: old }), assistant({ id: 'o2', session: 's-mixed', day: D2 })]);
    await write(live, [assistant({ id: 'o3', session: 's-old-live', day: old })]);
    const index = await load();
    await index.runSpendIndexPass();
    await fs.rm(gone);
    expect(await index.runSpendIndexPass()).toMatchObject({ filesGone: 1, filesExpired: 0 });
    const days = index.spendIndexUsage().map((u) => [u.sessionId, u.day]);
    expect(days).toEqual(expect.arrayContaining([['s-mixed', D2], ['s-old-live', old]]));
    expect(days).not.toContainEqual(['s-mixed', old]);
  });

  it('counts subagent transcripts at any depth below subagents/', async () => {
    const base = path.join(wsProjects('ws-a'), 's-main', 'subagents');
    await write(path.join(base, 'workflows', 'wf_1', 'agent-x.jsonl'), [assistant({ id: 'w1', sidechain: true })]);
    await write(path.join(base, 'workflows', 'wf_1', 'deeper', 'agent-y.jsonl'), [assistant({ id: 'w2', sidechain: true })]);
    await write(path.join(base, 'agent-z.jsonl'), [assistant({ id: 'w3', sidechain: true })]);
    const index = await load();
    expect((await index.collectClaudeSubagentFiles()).map((file) => path.relative(base, file)).sort())
      .toEqual(['agent-z.jsonl', path.join('workflows', 'wf_1', 'agent-x.jsonl'), path.join('workflows', 'wf_1', 'deeper', 'agent-y.jsonl')]);
    await index.runSpendIndexPass();
    expect(tokens(index.spendIndexUsage(), (u) => u.sidechain)).toBe(3 * LINE_TOKENS);
  });

  it('indexes Codex and Grok sessions on their start day and reads them again only when they change', async () => {
    const codex = path.join(home(), '.codex', 'sessions', '2026', '10', '20', 'rollout-c.jsonl');
    await write(codex, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-10-20T23:30:00.000Z', payload: { id: 'codex-1', timestamp: '2026-10-20T23:30:00.000Z', cwd: '/tmp' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.2-codex' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, total_tokens: 1050 }, model_context_window: 400000 } } }),
    ]);
    const grokDir = path.join(home(), '.purplemux', 'workspaces', 'ws-g', 'grok-home', 'sessions', encodeURIComponent('/tmp/g'), '01a008c1-bb96-71d1-9769-b63ff478fd9f');
    await fs.mkdir(grokDir, { recursive: true });
    for (const file of ['updates.jsonl', 'summary.json']) {
      await fs.copyFile(path.join(process.cwd(), 'tests', 'fixtures', 'grok-session', file), path.join(grokDir, file));
    }
    const index = await load();
    await index.runSpendIndexPass();
    const usage = index.spendIndexUsage();
    expect(usage.find((u) => u.providerId === 'codex')).toMatchObject({
      workspaceId: null, sessionId: 'codex-1', day: '2026-10-20', model: 'gpt-5.2-codex', input: 600, cacheRead: 400, output: 50,
    });
    expect(usage.find((u) => u.providerId === 'grok')).toMatchObject({
      workspaceId: 'ws-g', sessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f', day: '2026-08-16', input: 19427, output: 39, cacheRead: 128,
    });
    expect(usage.find((u) => u.providerId === 'grok')?.costUsd).toBeCloseTo(66123200 / 1e10, 12);
    expect((await index.runSpendIndexPass()).filesParsed).toBe(0);
  });

  it('buckets each message by its UTC 5-minute slot, inside its day (harness-flow-loop 04)', async () => {
    await write(path.join(wsProjects('ws-a'), 's-main.jsonl'), [
      assistant({ id: 'm1', time: '12:00:00.000' }), assistant({ id: 'm2', time: '12:04:59.999' }),
      assistant({ id: 'm3', time: '12:05:00.000' }), assistant({ id: 'm4', time: '23:59:59.000' }),
    ]);
    const index = await load();
    await index.runSpendIndexPass();
    const slots = index.spendIndexUsage().map((u) => [u.slot === undefined ? null : new Date(u.slot).toISOString(), tokens([u])]);
    expect(slots.sort()).toEqual([
      [`${D2}T12:00:00.000Z`, 2 * LINE_TOKENS], [`${D2}T12:05:00.000Z`, LINE_TOKENS], [`${D2}T23:55:00.000Z`, LINE_TOKENS],
    ]);
  });

  it('reads a live entry indexed without slots again from 0 once, with the same day totals', async () => {
    const file = path.join(wsProjects('ws-a'), 's-main.jsonl');
    await write(file, [assistant({ id: 'm1' }), assistant({ id: 'm2', time: '13:00:00.000' }), assistant({ id: 'm3', day: D3 })]);
    await (await load()).runSpendIndexPass();
    const saved = JSON.parse(await fs.readFile(indexFile(), 'utf-8'));
    const entry = saved.files[file];
    delete entry.slotted;
    const byDay = new Map<string, Record<string, number>>();
    for (const bucket of entry.buckets) {
      const key = `${bucket.day}\u0000${bucket.model}\u0000${bucket.sessionId}`;
      const merged = byDay.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation5m: 0, cacheCreation1h: 0 };
      for (const field of Object.keys(merged)) merged[field] += bucket[field];
      byDay.set(key, merged);
    }
    entry.buckets = [...byDay].map(([key, sums]) => {
      const [day, model, sessionId] = key.split('\u0000');
      return { day, model, sessionId, ...sums };
    });
    await fs.writeFile(indexFile(), JSON.stringify(saved));
    resetGlobals();
    const index = await load();
    await index.loadSpendIndex();
    const dayTotals = () => {
      const totals: Record<string, number> = {};
      for (const u of index.spendIndexUsage()) totals[u.day] = (totals[u.day] ?? 0) + tokens([u]);
      return totals;
    };
    const before = dayTotals();
    expect(index.spendIndexUsage().every((u) => u.slot === undefined)).toBe(true);
    expect((await index.runSpendIndexPass()).filesParsed).toBe(1);
    expect(dayTotals()).toEqual(before);
    expect(index.spendIndexUsage().every((u) => typeof u.slot === 'number')).toBe(true);
    expect((await index.runSpendIndexPass()).filesParsed).toBe(0);
  });

  it('keeps the index across a restart without reparsing, and is indexing until a pass has run', async () => {
    await write(path.join(wsProjects('ws-a'), 's-main.jsonl'), [assistant({ id: 'm1' })]);
    await (await load()).runSpendIndexPass();
    resetGlobals();
    const index = await load();
    await index.loadSpendIndex();
    expect(index.spendIndexStatus()).toMatchObject({ state: 'indexing', filesIndexed: 1, filesTotal: 1 });
    expect(tokens(index.spendIndexUsage())).toBe(LINE_TOKENS);
    expect((await index.runSpendIndexPass()).filesParsed).toBe(0);
    expect(index.spendIndexStatus().state).toBe('ready');
  });

  it('moves a damaged index aside and rebuilds instead of reading it as complete', async () => {
    await write(path.join(wsProjects('ws-a'), 's-main.jsonl'), [assistant({ id: 'm1' })]);
    await fs.mkdir(path.dirname(indexFile()), { recursive: true });
    await fs.writeFile(indexFile(), '{"version":1,"files":');
    const index = await load();
    await index.loadSpendIndex();
    expect(index.spendIndexStatus()).toMatchObject({ state: 'indexing', error: expect.stringContaining('moved to spend-index.json.corrupt-') });
    const aside = (await fs.readdir(path.dirname(indexFile()))).filter((name) => name.startsWith('spend-index.json.corrupt-'));
    expect(aside).toHaveLength(1);
    await index.runSpendIndexPass();
    expect(index.spendIndexStatus()).toMatchObject({ state: 'ready' });
    expect(index.spendIndexStatus().error).toBeUndefined();
  });

  it('reports an unreadable index as unavailable', async () => {
    await fs.mkdir(indexFile(), { recursive: true });
    const index = await load();
    await index.loadSpendIndex();
    expect(index.spendIndexStatus()).toMatchObject({ state: 'unavailable', error: expect.stringContaining('spend-index.json unreadable') });
    expect(await index.runSpendIndexPass()).toEqual({ filesTotal: 0, filesParsed: 0, filesGone: 0, filesExpired: 0 });
  });

  it('runs in the background after its start delay, seeds first, and stops', async () => {
    await write(path.join(wsProjects('ws-a'), 's-main.jsonl'), [assistant({ id: 'm1' })]);
    const index = await load();
    const seed = vi.fn(async () => {});
    await index.startSpendIndexer({ startDelayMs: 5, rescanMs: 60_000, beforeFirstPass: seed });
    await vi.waitFor(() => expect(index.spendIndexStatus().state).toBe('ready'), { timeout: 2000 });
    expect(seed).toHaveBeenCalledOnce();
    await index.stopSpendIndexer();
    expect(JSON.parse(await fs.readFile(indexFile(), 'utf-8')).indexedThrough).toEqual(expect.any(Number));
  });

  it('names the workspace from the transcript path', async () => {
    const index = await load();
    expect(index.workspaceOfTranscript(path.join(wsProjects('ws-x'), 'a.jsonl'))).toBe('ws-x');
    expect(index.workspaceOfTranscript(path.join(globalProjects(), 'a.jsonl'))).toBe('global');
    expect(index.workspaceOfTranscript(path.join(home(), '.purplemux', 'workspaces', 'ws-x', 'grok-home', 'a.jsonl'))).toBe('global');
  });
});

describe('spend index parity with the stats cache (SC-5)', () => {
  beforeEach(async () => {
    resetGlobals();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-spend-parity-'));
  });
  afterEach(async () => {
    resetGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('sums the main transcripts to the stats cache Claude tokens for every UTC day, subagents reported apart', async () => {
    await write(path.join(wsProjects('ws-a'), 's1.jsonl'), [
      user('s1', D3), assistant({ id: 'a', session: 's1', day: D3 }), assistant({ id: 'a', session: 's1', day: D3 }),
      assistant({ uuid: 'u-1', session: 's1', day: D2, model: 'claude-sonnet-4-5', cc1h: 7 }), assistant({ session: 's1', day: D2 }),
      assistant({ session: 's1', day: D2 }), assistant({ id: 'syn', model: '<synthetic>', day: D2 }),
    ]);
    await write(path.join(wsProjects('ws-b'), 's2.jsonl'), [assistant({ id: 'b', session: 's2', day: D2, input: 999 })]);
    await write(path.join(globalProjects(), 's3.jsonl'), [assistant({ id: 'c', session: 's3', day: D3, output: 77 })]);
    await write(path.join(wsProjects('ws-a'), 's1', 'subagents', 'agent-x.jsonl'), [assistant({ id: 'sub', session: 's1', day: D2, sidechain: true, input: 5000 })]);

    vi.resetModules();
    const { getStatsCache } = await import('@/lib/stats/stats-cache');
    const stats = await getStatsCache();
    const statsByDay = new Map(stats.dailyModelTokens.map((day) => [day.date,
      Object.values(day.tokensByModel).reduce((sum, t) => sum + t.input + t.output + t.cacheRead + t.cacheCreation, 0)]));

    const index = await import('@/lib/spend/spend-index');
    await index.runSpendIndexPass();
    const view = buildSpendView({ usage: index.spendIndexUsage(), bindings: {}, workspaces: [], workspaceId: 'all',
      from: D3, to: D2, by: 'day', generatedAt: 0, index: index.spendIndexStatus() });

    expect(view.rows.map((row) => row.key)).toEqual([D3, D2]);
    for (const row of view.rows) {
      expect(row.totalTokens - row.sidechainTokens, row.key).toBe(statsByDay.get(row.key));
    }
    expect(view.totals.sidechainTokens).toBe(5000 + 5 + 100 + 20);
  });
});
