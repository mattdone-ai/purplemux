import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scoreRows } from '@/lib/curator';
import { OWNER_MESSAGE_CLASSES } from '@/lib/curator-tasks';

// ADR-0038: `purplemux curator` through the installed entry point, against a stub server.

const ENTRY = path.resolve('bin/purplemux.js');
const run = promisify(execFile);

interface IRequest { method: string; url: string; body: unknown }
type TRoute = (req: IRequest) => { status: number; body: unknown };

const rows = [
  ...Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, gold: 'standing-order', predicted: 'standing-order', outcome: 'labelled', latencyMs: 900 })),
  { id: 'x', gold: 'one-off', predicted: 'standing-order', outcome: 'labelled', latencyMs: 1200 },
  { id: 'p', gold: 'product-rule', predicted: null, outcome: 'timeout', latencyMs: 30000 },
];
const RESULT = {
  task: 'classify-owner-message', promptVersion: 'com-v1-7f8e6a02', model: 'gemma4:26b', split: 'holdout', startedAt: 1000, finishedAt: 5000, n: 11,
  counts: [], unresolved: 2, agedOut: 1, unresolvedByClass: {}, excluded: { shadow: 3, disputed: 0 }, spotCheck: null, refused: null,
  outcomes: { labelled: 10, timeout: 1, unresolved: 2 }, latency: { p50: 900, p90: 1200 },
  score: scoreRows('classify-owner-message', OWNER_MESSAGE_CLASSES, rows as never),
  rules: scoreRows('classify-owner-message', OWNER_MESSAGE_CLASSES, rows.map((r) => ({ ...r, predicted: 'one-off' })) as never),
};

describe('purplemux curator (ADR-0038)', { timeout: 30_000 }, () => {
  let server: http.Server;
  let port = 0;
  let home = '';
  let requests: IRequest[] = [];
  let routes: Record<string, TRoute> = {};

  beforeEach(async () => {
    requests = [];
    routes = {};
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-cli-curator-'));
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        const request = { method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null };
        requests.push(request);
        const route = routes[`${request.method} ${request.url.split('?')[0]}`];
        const { status, body } = route ? route(request) : { status: 404, body: { error: 'no route', code: 'routes-absent' } };
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });

  const cli = async (args: string[]) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [ENTRY, 'curator', ...args], {
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: home, NO_UPDATE_NOTIFIER: '1', PMUX_PORT: String(port), PMUX_TAB_TOKEN: 'tab-token' },
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const f = err as { code?: number; stdout?: string; stderr?: string };
      return { code: f.code ?? -1, stdout: f.stdout ?? '', stderr: f.stderr ?? '' };
    }
  };

  it('eval starts the run, waits for its result and prints precision and recall per class against the thresholds', async () => {
    let polls = 0;
    routes['POST /api/cli/curator/eval'] = () => ({ status: 202, body: { progress: { task: 'classify-owner-message', running: true, done: 0, total: 11, startedAt: 1000, error: null } } });
    routes['GET /api/cli/curator/eval'] = () => {
      polls += 1;
      return { status: 200, body: polls < 2
        ? { progress: { running: true, done: 5, total: 11, startedAt: 1000, error: null }, result: null }
        : { progress: { running: false, done: 11, total: 11, startedAt: 1000, error: null }, result: RESULT } };
    };
    const res = await cli(['eval', '--task', 'classify-owner-message']);
    expect(res.code, res.stderr).toBe(0);
    expect(requests[0]).toMatchObject({ method: 'POST', body: { task: 'classify-owner-message', split: 'holdout' } });
    expect(res.stdout).toContain('classify-owner-message · prompt com-v1-7f8e6a02 · gemma4:26b · holdout · 11 items (unresolved 2, aged out 1, left out: 3 shadow, 0 disputed)');
    expect(res.stdout).toContain('outcomes: labelled 10, timeout 1, unresolved 2 · latency p50 900 ms, p90 1200 ms');
    expect(res.stdout).toMatch(/standing-order +9 +10 +0\.900 +1\.000 +not measured +0\.000/);
    expect(res.stdout).toContain('  FAIL standing-order precision 9/10 = 0.900; 95% lower bound 0.6058 >= 0.90? (0 errors needs 29)\n');
    expect(res.stdout).toContain('  FAIL product-rule precision 0/0 = not measured; 95% lower bound not measured >= 0.90? (0 errors needs 29)\n');
    expect(res.stdout).toContain('  FAIL product-rule recall 0/1 = 0.000; 95% lower bound 0.0000 >= 0.80? (0 errors needs 14)\n');
    expect(res.stdout).toContain("gate: FAIL (promote also needs 72 h and 30 labelled shadow rows of this prompt, and the owner's spot check)");
  });

  it('a refused evaluation says so and prints no scores', async () => {
    routes['POST /api/cli/curator/eval'] = () => ({ status: 202, body: { progress: { running: true, startedAt: 1000 } } });
    routes['GET /api/cli/curator/eval'] = () => ({ status: 200, body: { progress: { running: false, error: null }, result: { ...RESULT, refused: '20 of 100 unresolved (20.0%), limit 10.0%' } } });
    const res = await cli(['eval', '--task', 'classify-owner-message', '--split', 'holdout']);
    expect(res.stdout).toContain('REFUSED: 20 of 100 unresolved (20.0%), limit 10.0% — no model call was made; promote reads this as no evaluation');
    expect(res.stdout).not.toContain('gate:');
    expect((await cli(['eval', '--task', 'classify-owner-message', '--split', 'secret'])).code).toBe(2);
  });

  it('a failed evaluation exits with its error; --no-wait prints the progress', async () => {
    routes['POST /api/cli/curator/eval'] = () => ({ status: 202, body: { progress: { running: true, startedAt: 1 } } });
    routes['GET /api/cli/curator/eval'] = () => ({ status: 200, body: { progress: { running: false, error: 'no labelled set' }, result: null } });
    const failed = await cli(['eval', '--task', 'flag-owner-question']);
    expect(failed.code).toBe(3);
    expect(failed.stderr).toContain('evaluation failed: no labelled set');
    const quick = await cli(['eval', '--task', 'flag-owner-question', '--no-wait', '--all']);
    expect(JSON.parse(quick.stdout)).toEqual({ progress: { running: true, startedAt: 1 } });
    expect(requests.at(-1)!.body).toEqual({ task: 'flag-owner-question', split: 'all' });
  });

  it('promote refused below threshold or before 72 h exits 3 with every reason', async () => {
    routes['POST /api/cli/curator/promote'] = () => ({ status: 409, body: {
      code: 'curator-gate-refused', error: 'match-standing-order stays in shadow: shadow 10.0 h of 72.0 h; covered precision 0.900, needs >= 0.98',
    } });
    const res = await cli(['promote', '--task', 'match-standing-order']);
    expect(res.code).toBe(3);
    expect(res.stderr).toContain('curator-gate-refused');
    expect(res.stderr).toContain('shadow 10.0 h of 72.0 h; covered precision 0.900, needs >= 0.98');
  });

  it('promote and demote post the task; a bad task is a usage error before anything is sent', async () => {
    routes['POST /api/cli/curator/promote'] = (req) => ({ status: 200, body: (req.body as { demote?: boolean }).demote ? { wasRouting: true } : { state: 'routing' } });
    expect((await cli(['promote', '--task', 'flag-owner-question'])).stdout).toBe('flag-owner-question: routing (every gate condition met)\n');
    expect((await cli(['demote', '--task', 'flag-owner-question'])).stdout).toBe('flag-owner-question: shadow (was routing)\n');
    expect(requests.map((r) => r.body)).toEqual([{ task: 'flag-owner-question' }, { task: 'flag-owner-question', demote: true }]);
    const bad = await cli(['promote', '--task', 'summarise-board']);
    expect(bad.code).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it('status names the health, each task state and the kodit measure', async () => {
    routes['GET /api/cli/curator'] = () => ({ status: 200, body: {
      model: 'gemma4:26b', health: { state: 'down', reason: 'tunnel (refused)', since: Date.UTC(2026, 10, 3, 6, 0), checkedAt: 1 }, queued: 2,
      liveSince: Date.UTC(2026, 10, 3, 6, 0), rateLimitMs: 10000,
      kodit: { before: { docsPerHour: 851.4, summariesPerHour: 4153.3, samples: 25 }, after: null, drop: null, measuredAt: 1 },
      koditCheck: { state: 'configured', host: 'host-b-lan' },
      tasks: [{
        task: 'classify-owner-message', state: 'shadow', promptVersion: 'com-v1-7f8e6a02', shadowEndsAt: Date.UTC(2026, 10, 6, 6, 0), promotedAt: null,
        queue: { size: 4, oldestAt: Date.UTC(2026, 10, 4, 0, 0) },
        gate: {
          checks: [{ label: 'standing-order', metric: 'precision', threshold: 0.9, measured: 1, successes: 5, trials: 5, lowerBound: 0.549, minTrials: 29, pass: false }],
          shadow: [{ label: 'standing-order', metric: 'precision', threshold: 0.9, successes: 2, trials: 2, pass: false }], refusals: [],
        },
      }, { task: 'flag-owner-question', state: 'shadow', promptVersion: 'foq-v1-x', shadowEndsAt: null, promotedAt: null, queue: { size: 0, oldestAt: null }, gate: { checks: null, shadow: [], refusals: [] } }],
      evals: [{ task: 'classify-owner-message', running: true, done: 3, total: 10 }],
    } });
    const res = await cli(['status']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('curator gemma4:26b · DOWN (tunnel (refused)) since 2026-11-03 17:00 AEDT: the rules route · queued 2 · 10 s between calls (kodit rule)');
    expect(res.stdout).toMatch(/classify-owner-message +shadow +com-v1-7f8e6a02 +2026-11-06 17:00 AEDT +— +4, oldest 2026-11-04 11:00 AEDT/);
    expect(res.stdout).toMatch(/flag-owner-question +shadow +foq-v1-x +no live call yet/);
    expect(res.stdout).toContain('  pool FAIL standing-order precision 5/5 = 1.000; 95% lower bound 0.5490 >= 0.90? (0 errors needs 29)\n');
    expect(res.stdout).toContain('  shadow standing-order precision 2/2 (needs n >= 30, >= 0.90): FAIL\n');
    expect(res.stdout).toContain('  pool: no usable held-out evaluation of this prompt\n');
    expect(res.stdout).toContain('kodit before: 851 docs/h, 4153 summaries/h (25 samples)');
    expect(res.stdout).toContain('kodit check: reads the log on host-b-lan\n');
    expect(res.stdout).toContain('eval classify-owner-message: running 3/10');
  });

  it('status says when the kodit check is not configured, and an older server without koditCheck prints no such line', async () => {
    const body = (koditCheck?: unknown) => ({
      model: 'gemma4:26b', health: { state: 'ok', checkedAt: 1 }, queued: 0, liveSince: null, rateLimitMs: 0, kodit: null, tasks: [], evals: [],
      ...(koditCheck ? { koditCheck } : {}),
    });
    const reason = 'PMUX_KODIT_LOG_HOST is not set in the server environment, so the kodit check (ADR-0038 §7) does not run';
    routes['GET /api/cli/curator'] = () => ({ status: 200, body: body({ state: 'not-configured', reason }) });
    const unset = await cli(['status']);
    expect(unset.code, unset.stderr).toBe(0);
    expect(unset.stdout).toContain(`kodit check: NOT CONFIGURED: ${reason}\n`);
    routes['GET /api/cli/curator'] = () => ({ status: 200, body: body() });
    const older = await cli(['status']);
    expect(older.code, older.stderr).toBe(0);
    expect(older.stdout).not.toContain('kodit check');
  });

  it('spot-check open drafts the item and posts it as the bound run\'s attention.opened, with the owner review', async () => {
    routes['GET /api/cli/mission-control'] = () => ({ status: 200, body: { runs: [
      { id: 'run-1', workspaceId: 'ws-a', state: 'running', revision: 7, binding: { tabId: 'tab-o', generation: 3 } },
    ] } });
    routes['POST /api/cli/curator/spot-check'] = (req) => ((req.body as { commit?: string }).commit
      ? { status: 200, body: { committed: true } }
      : { status: 200, body: {
        itemId: 'curator-spot-check-2026-11-06', perClass: { 'standing-order': 6 }, skippedSecret: 2,
        question: { formatVersion: 2, kind: 'question', title: 't', decision: 'Which of these 30 message labels are wrong?', answerType: 'multi', options: [] },
      } });
    routes['POST /api/cli/mission-control/questions/check'] = () => ({ status: 200, body: { ok: true, lint: [], minVersion: 1 } });
    routes['POST /api/cli/mission-control/events'] = () => ({ status: 200, body: { applied: 1 } });
    const res = await cli(['spot-check', 'open', '-w', 'ws-a']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain('drawn per class: standing-order 6 · skipped as credential-like: 2');
    const posted = requests.find((r) => r.url.startsWith('/api/cli/mission-control/events'))!.body as { events: Array<Record<string, unknown>> };
    expect(posted.events[0]).toMatchObject({
      type: 'attention.opened', eventId: 'curator:curator-spot-check-2026-11-06', schemaVersion: 1, workspaceId: 'ws-a', runId: 'run-1',
      expectedRevision: 0, bindingGeneration: 3,
      payload: { itemId: 'curator-spot-check-2026-11-06', answerType: 'multi', humanReview: { humanNeed: 'decision', reviewerTabId: 'tab-o' } },
    });
    const order = requests.map((r) => `${r.method} ${r.url.split('?')[0]}${(r.body as { commit?: string } | null)?.commit ? ' commit' : ''}`);
    expect(order).toEqual(['GET /api/cli/mission-control', 'POST /api/cli/curator/spot-check', 'POST /api/cli/mission-control/questions/check',
      'POST /api/cli/mission-control/events', 'POST /api/cli/curator/spot-check commit']);
    expect(requests[1].body).toEqual({ task: 'classify-owner-message', workspaceId: 'ws-a' });
  });

  it('spot-check open writes no map when the post fails: no commit is sent', async () => {
    routes['GET /api/cli/mission-control'] = () => ({ status: 200, body: { runs: [
      { id: 'run-1', workspaceId: 'ws-a', state: 'running', revision: 7, binding: { tabId: 'tab-o', generation: 3 } },
    ] } });
    routes['POST /api/cli/curator/spot-check'] = () => ({ status: 200, body: { itemId: 'i', perClass: {}, skippedSecret: 0, question: { formatVersion: 2 } } });
    routes['POST /api/cli/mission-control/questions/check'] = () => ({ status: 200, body: { ok: true, lint: [], minVersion: 1 } });
    routes['POST /api/cli/mission-control/events'] = () => ({ status: 409, body: { code: 'revision-conflict', error: 'stale revision' } });
    const res = await cli(['spot-check', 'open', '-w', 'ws-a', '--task', 'match-standing-order']);
    expect(res.code).not.toBe(0);
    expect(requests.filter((r) => (r.body as { commit?: string } | null)?.commit)).toEqual([]);
    expect(requests[1].body).toEqual({ task: 'match-standing-order', workspaceId: 'ws-a' });
  });

  it('label-queue prints ids only; label-import sends the file', async () => {
    routes['POST /api/cli/curator/label-queue'] = () => ({ status: 200, body: { task: 'flag-owner-question', promptVersion: 'foq-v1-x', size: 2, added: 1, oldestAt: null, ids: ['ws-a/s/u1', 'ws-a/s/u2'] } });
    expect((await cli(['label-queue', '--task', 'flag-owner-question'])).stdout).toBe('flag-owner-question · prompt foq-v1-x · 2 queued (1 new)\nws-a/s/u1\nws-a/s/u2\n');
    const file = path.join(home, 'labels.json');
    await fs.writeFile(file, JSON.stringify([{ id: 'ws-a/s/u1', label: 'not-a-question' }]));
    routes['POST /api/cli/curator/label-import'] = () => ({ status: 200, body: { imported: 1 } });
    expect(JSON.parse((await cli(['label-import', '--task', 'flag-owner-question', '--file', file])).stdout)).toEqual({ imported: 1 });
    expect(requests.at(-1)!.body).toEqual({ task: 'flag-owner-question', labels: [{ id: 'ws-a/s/u1', label: 'not-a-question' }] });
  });

  it('spot-check open with no single bound run names the runs and sends nothing else', async () => {
    routes['GET /api/cli/mission-control'] = () => ({ status: 200, body: { runs: [] } });
    const res = await cli(['spot-check', 'open', '-w', 'ws-a']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--run must name one bound run of ws-a: none is bound');
    expect(requests).toHaveLength(1);
  });

  it('spot-check show reads the verdict', async () => {
    routes['GET /api/cli/curator/spot-check'] = (req) => ({ status: req.url.includes('task=classify-owner-message') ? 200 : 400, body: {
      itemId: 'curator-spot-check-2026-11-06', workspaceId: 'ws-a', verdict: { state: 'answered', disputed: ['a', 'b'], unjudged: ['c'], judged: 29, wrongShare: 2 / 29 },
    } });
    expect((await cli(['spot-check', 'show'])).stdout).toBe('spot check curator-spot-check-2026-11-06 in ws-a: answered: 2 wrong of 29 judged (6.9%), 1 not judged\n');
  });

  it('eval --task reshape-question prints the reshape gate on the run alone (story 23 AC 4)', async () => {
    const reshapeResult = {
      task: 'reshape-question', runId: 'run-1', promptVersion: 'rsq-v1-x~y', model: 'gemma4:26b', startedAt: 1000, finishedAt: 2000, target: 100, candidates: 250,
      replied: 100, clean: 98, nonReplies: 3, unresolved: 0, unreshapable: 1, labels: { reshaped: 98, invalid: 2 }, outcomes: { labelled: 100, timeout: 3 },
      latency: { p50: 4000, p90: 9000 }, refused: null, rows: [],
    };
    routes['POST /api/cli/curator/eval'] = () => ({ status: 202, body: { progress: { task: 'reshape-question', running: true, done: 0, total: 100, startedAt: 1000, error: null } } });
    routes['GET /api/cli/curator/eval'] = () => ({ status: 200, body: { progress: { running: false, done: 100, total: 100, startedAt: 1000, error: null }, result: reshapeResult } });
    const res = await cli(['eval', '--task', 'reshape-question']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('replies 100/100 of 250 held-out ids · non-replies 3 · unresolved 0 · not reshapable 1');
    expect(res.stdout).toContain('FAIL schema-valid and preservation-clean 98/100 (needs 100/100)');
    expect(res.stdout).toContain('promote also needs the judge');
  });

  it('reshape-pairs prints the server\'s JSON; judge-import sends the run and the verdicts; message reads one owner message', async () => {
    routes['GET /api/cli/curator/reshape-pairs'] = () => ({ status: 200, body: { runId: 'run-1', promptVersion: 'v', pairs: [{ id: 'ws-a/mc/q', sha: 'abc', original: {}, reshaped: {} }] } });
    expect(JSON.parse((await cli(['reshape-pairs'])).stdout)).toMatchObject({ runId: 'run-1', pairs: [{ id: 'ws-a/mc/q', sha: 'abc' }] });
    routes['POST /api/cli/curator/judge-import'] = (r) => ({ status: 200, body: { echo: r.body } });
    const file = path.join(home, 'verdicts.json');
    await fs.writeFile(file, JSON.stringify({ runId: 'run-1', verdicts: [{ id: 'ws-a/mc/q', sha: 'abc', verdict: 'same' }] }));
    expect(JSON.parse((await cli(['judge-import', '--file', file, '--judge', 'opus high'])).stdout)).toEqual({
      echo: { runId: 'run-1', verdicts: [{ id: 'ws-a/mc/q', sha: 'abc', verdict: 'same' }], judge: 'opus high' },
    });
    expect((await cli(['judge-import'])).code).toBe(2);
    routes['GET /api/cli/curator/message'] = (r) => ({ status: 200, body: { workspaceId: 'ws-a', entryId: 'm1', sentAt: '2026-11-03T04:00:00Z', message: `read ${r.url}` } });
    const msg = await cli(['message', '-w', 'ws-a', 'm1']);
    expect(msg.stdout).toBe('ws-a/m1 at 2026-11-03T04:00:00Z:\nread /api/cli/curator/message?workspaceId=ws-a&entryId=m1\n');
    expect((await cli(['message', '-w', 'ws-a'])).code).toBe(2);
  });
});
