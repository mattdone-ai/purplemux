import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ADR-0037 §3: `mc ask` checks the question before it posts; defects exit 2 with nothing posted. --fix (story 23) asks
// the curator: a reshape that routes is checked again and posted with the original kept; anything else exits 2.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRequest {
  url: string;
  body: unknown;
}

describe('purplemux mc ask (ADR-0037)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let checkAnswer: Record<string, unknown> = {};
  let checkAfterFix: Record<string, unknown> | null = null;
  let reshapeAnswer: Record<string, unknown> = {};

  beforeEach(async () => {
    requests = [];
    checkAfterFix = null;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-mc-ask-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        res.writeHead(200, { 'content-type': 'application/json' });
        const checks = requests.filter((r) => r.url.startsWith('/api/cli/mission-control/questions/check')).length;
        res.end(JSON.stringify(req.url?.startsWith('/api/cli/mission-control/questions/check')
          ? (checks > 1 && checkAfterFix ? checkAfterFix : checkAnswer)
          : req.url?.startsWith('/api/cli/mission-control/questions/reshape')
            ? reshapeAnswer
            : { events: [{ id: 'e-1' }], cursor: 1, replayed: false, lint: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const cli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TOKEN: 'ws-token' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
  };

  const event = {
    eventId: 'evt-ask-1', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-1', expectedRevision: 0, producerAt: 1, bindingGeneration: 1,
    type: 'attention.opened',
    payload: { itemId: 'q-1', formatVersion: 2, kind: 'question', title: 'T', decision: 'D?', whyNow: 'W', answerType: 'single',
      options: [{ id: 'a', label: 'A' }], storyIds: [], blockingScope: 'story', canContinue: true,
      humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-o' } },
  };
  const draftFile = async (content: unknown): Promise<string> => {
    const file = path.join(home, 'draft.json');
    await fs.writeFile(file, JSON.stringify(content));
    return file;
  };
  const defects = [{ field: 'options', measured: '1 option on answerType single', limit: 'needs 2-4', message: 'options: 1 option on answerType single, needs 2-4' }];
  const refused = { ok: false, formatVersion: 2, minVersion: 1, defects, lint: [], question: null,
    reshape: { enabled: false, reason: 'the curator reshape is not enabled on this server (harness-flow-loop story 23)' } };

  it('checks the question with its human review beside it (story 36), then posts the event unchanged', async () => {
    checkAnswer = { ok: true, formatVersion: 2, minVersion: 1, defects: [], lint: [], question: {}, reshape: refused.reshape };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', `@${await draftFile(event)}`]);
    expect(result.code).toBe(0);
    expect(requests.map((request) => request.url)).toEqual([
      '/api/cli/mission-control/questions/check?workspaceId=ws-a',
      '/api/cli/mission-control/events?workspaceId=ws-a',
    ]);
    const { itemId: _itemId, humanReview, ...question } = event.payload;
    expect(requests[0].body).toEqual({ question, humanReview });
    expect(requests[1].body).toEqual({ events: [event] });
  });

  it('prints a class: absent warning on stderr and still posts (story 36, D6)', async () => {
    const classAbsent = { field: 'class', measured: 'absent', limit: 'one of money, irreversible, scope, bookkeeping; without it the item sorts as Unclassified (ADR-0031)',
      message: 'class: absent, one of money, irreversible, scope, bookkeeping; without it the item sorts as Unclassified (ADR-0031)' };
    checkAnswer = { ok: true, formatVersion: 2, minVersion: 1, defects: [], lint: [classAbsent], question: {}, reshape: refused.reshape };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', `@${await draftFile(event)}`]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain(`question lint (accepted at min-version 1):\n  ${classAbsent.message}`);
    expect(requests.map((request) => request.url)).toEqual([
      '/api/cli/mission-control/questions/check?workspaceId=ws-a',
      '/api/cli/mission-control/events?workspaceId=ws-a',
    ]);
  });

  it('prints every defect and exits 2 with nothing posted', async () => {
    checkAnswer = refused;
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', `@${await draftFile({ events: [event] })}`]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('options: 1 option on answerType single, needs 2-4');
    expect(result.stderr).toContain('error: question-invalid');
    expect(requests).toHaveLength(1);
  });

  it('--fix where the reshape is in shadow: the defects and the reason print, nothing is posted, exit 2', async () => {
    checkAnswer = refused;
    reshapeAnswer = { outcome: 'shadow', reason: 'the curator reshape is in shadow here: it was logged, not returned; fix the defects in the draft' };
    const result = await cli(['mission', 'ask', '-w', 'ws-a', '--fix', '--json', `@${await draftFile(event)}`]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('options: 1 option on answerType single, needs 2-4');
    expect(result.stderr).toContain('--fix: the curator reshape is in shadow here');
    expect(requests.map((r) => r.url)).toEqual([
      '/api/cli/mission-control/questions/check?workspaceId=ws-a',
      '/api/cli/mission-control/questions/reshape?workspaceId=ws-a',
    ]);
    const { itemId: _itemId, humanReview: _review, ...question } = event.payload;
    expect(requests[1].body).toEqual({ question });
  });

  it('--fix where the reshape routes: the reshaped draft is checked again and posted in the same command, the original in source', async () => {
    checkAnswer = refused;
    const { itemId: _itemId, humanReview: _review, ...question } = event.payload;
    const reshaped = { ...question, options: [{ id: 'a', label: 'A', consequence: 'c', recommended: false, needsText: false }], source: question };
    reshapeAnswer = { outcome: 'reshaped', promptVersion: 'rsq-v1-0000~1111', question: reshaped };
    checkAfterFix = { ok: true, formatVersion: 2, minVersion: 1, defects: [], lint: [], question: reshaped, reshape: refused.reshape };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--fix', '--json', `@${await draftFile(event)}`]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('--fix: the curator reshaped the draft (prompt rsq-v1-0000~1111); the original is kept in question_json.source');
    expect(requests.map((r) => r.url)).toEqual([
      '/api/cli/mission-control/questions/check?workspaceId=ws-a',
      '/api/cli/mission-control/questions/reshape?workspaceId=ws-a',
      '/api/cli/mission-control/questions/check?workspaceId=ws-a',
      '/api/cli/mission-control/events?workspaceId=ws-a',
    ]);
    expect(requests[2].body).toEqual({ question: reshaped, humanReview: event.payload.humanReview });
    expect(requests[3].body).toEqual({ events: [{ ...event, payload: { itemId: 'q-1', humanReview: event.payload.humanReview, ...reshaped } }] });
  });

  it('--fix whose reshape the preservation check refused prints what moved and posts nothing', async () => {
    checkAnswer = refused;
    reshapeAnswer = { outcome: 'refused', label: 'not-preserved', promptVersion: 'v', defects: [
      { field: 'options.ids', measured: 'became ["b"]', limit: 'unchanged: was ["a"]', message: 'options.ids: became ["b"], unchanged: was ["a"]' },
    ] };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--fix', '--json', `@${await draftFile(event)}`]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--fix: the curator's reshape was refused (it moved a fixed field)");
    expect(result.stderr).toContain('options.ids: became ["b"], unchanged: was ["a"]');
    expect(requests).toHaveLength(2);
  });

  it('prints the lint of an accepted v1 question and posts it', async () => {
    checkAnswer = { ok: true, formatVersion: 1, minVersion: 1, defects: [], lint: [{ ...defects[0], message: 'formatVersion: absent (v1), formatVersion 2 adds decision, whyNow and answerType' }], question: {}, reshape: refused.reshape };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', JSON.stringify(event)]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('question lint (accepted at min-version 1)');
    expect(requests).toHaveLength(2);
  });

  it('refuses a draft that is not one attention event', async () => {
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', JSON.stringify({ ...event, type: 'run.started' })]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('mc ask takes one attention.opened or attention.updated event');
    expect(requests).toHaveLength(0);
  });
});

// ADR-0037 amendment D2: `mc ask --follows-up ID` puts the field on the event, the check reports a refused follow-up as a
// defect of field followsUp and the CLI exits by its code (0/2/3/7, no new code), and the answer prints on one line.
describe('purplemux mc ask --follows-up (ADR-0037 amendment D2)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let replies: Record<string, Array<{ status: number; body: unknown }>> = {};

  const route = (url: string): string => url.split('?')[0].replace('/api/cli/mission-control/', '');

  beforeEach(async () => {
    requests = [];
    replies = {};
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-mc-follow-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        requests.push({ url: req.url ?? '', body: raw ? JSON.parse(raw) : null });
        const queue = replies[route(req.url ?? '')] ?? [];
        const reply = queue.length > 1 ? queue.shift() : queue[0];
        res.writeHead(reply?.status ?? 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply?.body ?? { error: 'no reply', code: 'routes-absent' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const cli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TOKEN: 'ws-token' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
  };

  const event = {
    eventId: 'evt-follow-1', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-1', expectedRevision: 0, producerAt: 1, bindingGeneration: 1,
    type: 'attention.opened',
    payload: { itemId: 'q-2', formatVersion: 2, kind: 'question', title: 'T', decision: 'D?', whyNow: 'W', answerType: 'single',
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], storyIds: [], blockingScope: 'story', canContinue: true,
      humanReview: { humanNeed: 'decision', humanReason: 'r', handling: 'h', reviewerTabId: 'tab-o' } },
  };
  const draft = async (content: unknown = event): Promise<string> => {
    const file = path.join(home, 'draft.json');
    await fs.writeFile(file, JSON.stringify(content));
    return `@${file}`;
  };
  const passed = { ok: true, formatVersion: 2, minVersion: 1, defects: [], lint: [], question: {}, reshape: { enabled: false, reason: 'off' } };
  const followUpDefect = (code: string, status: number, message: string) => ({
    ok: false, formatVersion: 2, minVersion: 1, lint: [], question: {}, reshape: { enabled: false, reason: 'off' },
    defects: [{ field: 'followsUp', measured: message, limit: 'an answered item', message: `followsUp: ${message}`, code, status }],
  });
  const followedUp = { itemId: 'q-1', answerId: 'ans-1', optionIds: ['keep'], optionLabels: ['Keep re-gating'], text: 'Keep it.', resolved: true };
  const urls = () => requests.map((request) => route(request.url));

  it('puts followsUp on the event, sends it to the check with the ids, and prints the answer on one line', async () => {
    replies = { 'questions/check': [{ status: 200, body: passed }], events: [{ status: 200, body: { events: [], cursor: 2, replayed: false, lint: [], followedUp } }] };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', await draft(), '--follows-up', 'q-1']);
    expect(result.code).toBe(0);
    expect(urls()).toEqual(['questions/check', 'events']);
    expect(requests[0].body).toMatchObject({ followsUp: 'q-1', itemId: 'q-2', runId: 'run-1', humanReview: event.payload.humanReview });
    expect((requests[0].body as { question: Record<string, unknown> }).question).not.toHaveProperty('followsUp');
    expect(requests[1].body).toEqual({ events: [{ ...event, payload: { ...event.payload, followsUp: 'q-1' } }] });
    expect(result.stderr).toContain('follows up q-1: the owner answered Keep re-gating: "Keep it." (answer ans-1); q-1 is resolved\n');
    expect(JSON.parse(result.stdout).followedUp).toEqual(followedUp);
  });

  it('says "text only" for an answer with no option, and that only the link was written for a resolved target', async () => {
    replies = { 'questions/check': [{ status: 200, body: passed }],
      events: [{ status: 200, body: { events: [], cursor: 2, replayed: false, lint: [], followedUp: { ...followedUp, optionIds: [], optionLabels: [], resolved: false } } }] };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', await draft(), '--follows-up', 'q-1']);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('follows up q-1: the owner answered text only: "Keep it." (answer ans-1); q-1 was already resolved; only the link was written');
  });

  it.each([
    ['conflict', 409, 3, 'follow-up target q-1 is not answered yet (state open): revise it with attention.updated'],
    ['forbidden', 403, 3, 'followsUp names an item outside this workspace'],
    ['not-found', 404, 7, 'follow-up target q-9 not found'],
    ['invalid-request', 400, 2, 'a follow-up must reach the owner'],
  ])('a check that refuses the follow-up with %s (HTTP %s) exits %s by its code, with nothing posted', async (code, status, exit, message) => {
    replies = { 'questions/check': [{ status: 200, body: followUpDefect(code, status, message) }] };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', await draft(), '--follows-up', 'q-1']);
    expect(result.code).toBe(exit);
    expect(result.stderr).toContain(`followsUp: ${message}`);
    expect(result.stderr).toContain(`error: ${code}`);
    expect(urls()).toEqual(['questions/check']);
  });

  it('a refusal from the events route after a passed check (a race) exits 3 with the server body', async () => {
    replies = { 'questions/check': [{ status: 200, body: passed }],
      events: [{ status: 409, body: { error: 'follow-up target q-1 is already followed up by q-3', code: 'conflict', followsUp: { reason: 'already-followed', followedBy: 'q-3', tip: 'q-4' } } }] };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--json', await draft(), '--follows-up', 'q-1']);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('already followed up by q-3');
  });

  it('--fix keeps followsUp on the reshaped event', async () => {
    const wording = { ...passed, ok: false, question: null, defects: [{ field: 'options', measured: 'x', limit: 'y', message: 'options: x, y' }] };
    const { itemId: _itemId, humanReview: _review, ...question } = event.payload;
    const reshaped = { ...question, decision: 'D, reworded?', source: question };
    replies = {
      'questions/check': [{ status: 200, body: wording }, { status: 200, body: passed }],
      'questions/reshape': [{ status: 200, body: { outcome: 'reshaped', promptVersion: 'v', question: reshaped } }],
      events: [{ status: 200, body: { events: [], cursor: 2, replayed: false, lint: [], followedUp } }],
    };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--fix', '--json', await draft(), '--follows-up', 'q-1']);
    expect(result.code).toBe(0);
    expect(urls()).toEqual(['questions/check', 'questions/reshape', 'questions/check', 'events']);
    expect(requests[2].body).toMatchObject({ followsUp: 'q-1', itemId: 'q-2', runId: 'run-1' });
    expect((requests[3].body as { events: Array<{ payload: Record<string, unknown> }> }).events[0].payload).toMatchObject({ followsUp: 'q-1', decision: 'D, reworded?' });
  });

  it('a refused follow-up is never sent to the reshape, even with --fix', async () => {
    const both = { ...followUpDefect('conflict', 409, 'not answered'), defects: [
      { field: 'options', measured: 'x', limit: 'y', message: 'options: x, y' },
      followUpDefect('conflict', 409, 'not answered').defects[0],
    ] };
    replies = { 'questions/check': [{ status: 200, body: both }] };
    const result = await cli(['mc', 'ask', '-w', 'ws-a', '--fix', '--json', await draft(), '--follows-up', 'q-1']);
    expect(result.code).toBe(2);
    expect(urls()).toEqual(['questions/check']);
  });

  it('refuses --follows-up on attention.updated, and without an id, before any request', async () => {
    const updated = await cli(['mc', 'ask', '-w', 'ws-a', '--json', await draft({ ...event, type: 'attention.updated', expectedRevision: 1 }), '--follows-up', 'q-1']);
    expect(updated.code).toBe(2);
    expect(updated.stderr).toContain('--follows-up applies to attention.opened only');
    const bare = await cli(['mc', 'ask', '-w', 'ws-a', '--json', await draft(), '--follows-up']);
    expect(bare.code).toBe(2);
    expect(requests).toHaveLength(0);
  });
});
