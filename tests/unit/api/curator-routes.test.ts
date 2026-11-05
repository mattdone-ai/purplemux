import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, drainRouteLocks, resetRouteGlobals, writeFixture } from './leases-harness';

// The curator routes (ADR-0038) with the real token checks: promote is the admin token's alone.

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});
vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(async () => true),
  listSessions: vi.fn(async () => []),
  workspaceSessionName: (wsId: string, paneId: string, tabId: string) => `pt-${wsId}-${paneId}-${tabId}`,
}));
vi.mock('@/lib/sync-server', () => ({ broadcastSync: vi.fn() }));

type THandler = Parameters<typeof callRoute>[0];

describe('curator routes', () => {
  let tabA = '';
  let admin = '';
  const route = async (name: string) => (await import(`@/pages/api/cli/curator/${name}`)).default as THandler;

  beforeEach(async () => {
    vi.resetModules();
    resetRouteGlobals();
    for (const key of ['__ptCuratorClient', '__ptCuratorEvals', '__ptCuratorStateLock']) delete (globalThis as Record<string, unknown>)[key];
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-curator-routes-'));
    await writeFixture(mockHome.value, [{ id: 'ws-a', name: 'alpha', tabs: [{ id: 'tab-a1', name: 'orchestrator a' }], orchestratorTabId: 'tab-a1' }]);
    tabA = await (await import('@/lib/tab-token')).ensureTabToken({ workspaceId: 'ws-a', tabId: 'tab-a1' }, 'pt-ws-a-pane-1-tab-a1');
    admin = (await import('@/lib/cli-token')).getCliToken();
    // No route test reaches a real Ollama: the probe finds nothing listening.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11435') }); }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await drainRouteLocks();
    resetRouteGlobals();
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('status: any CLI token reads every task in shadow before anything is promoted', async () => {
    const res = await callRoute(await route('index'), { method: 'GET', headers: { 'x-pmux-token': tabA } });
    expect(res.status).toBe(200);
    expect((res.body as { tasks: Array<{ state: string }> }).tasks.map((t) => t.state)).toEqual(['shadow', 'shadow', 'shadow', 'shadow']);
    expect((await callRoute(await route('index'), { method: 'GET', headers: {} })).status).toBe(403);
  });

  it('promote: a tab token is refused 403; the admin token is refused 409 with every unmet condition', async () => {
    const promote = await route('promote');
    const tab = await callRoute(promote, { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { task: 'flag-owner-question' } });
    expect(tab).toMatchObject({ status: 403, body: { code: 'forbidden' } });
    const refused = await callRoute(promote, { method: 'POST', headers: { 'x-pmux-token': admin }, body: { task: 'flag-owner-question' } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'curator-gate-refused', ok: false });
    const version = `${(await import('@/lib/curator-tasks')).CURATOR_TASKS['flag-owner-question'].promptVersion}~unknown`;
    const { DIGEST_UNKNOWN } = await import('@/lib/curator-service');
    expect((refused.body as { refusals: string[] }).refusals).toEqual([
      DIGEST_UNKNOWN,
      `shadow has not started for ${version}: no live call of this prompt yet`,
      `shadow evidence for ${version}: question-to-owner precision 0/0, needs n >= 30 and >= 0.95`,
      'no evaluation: run `purplemux curator eval --task flag-owner-question`',
    ]);
  });

  it('a task outside the four is a 400 that lists them', async () => {
    const res = await callRoute(await route('eval'), { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { task: 'summarise-board' } });
    expect(res).toMatchObject({ status: 400, body: { code: 'curator-task-invalid' } });
    expect((res.body as { error: string }).error).toContain('classify-owner-message, flag-owner-question, match-standing-order, reshape-question');
  });

  it('a classifier-only route refuses reshape-question, which has no labelled set (story 23)', async () => {
    const res = await callRoute(await route('label-queue'), { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { task: 'reshape-question' } });
    expect(res).toMatchObject({ status: 400, body: { code: 'curator-task-invalid' } });
    expect((res.body as { error: string }).error).toContain('reshape-question has no labelled set');
  });

  it('eval with no labelled set answers 503 with the reason; GET reads no result yet', async () => {
    const evalRoute = await route('eval');
    const started = await callRoute(evalRoute, { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { task: 'flag-owner-question' } });
    expect(started).toMatchObject({ status: 503, body: { code: 'curator-unavailable' } });
    expect((started.body as { error: string }).error).toContain('no labelled set for flag-owner-question');
    expect(await callRoute(evalRoute, { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { task: 'flag-owner-question' } }))
      .toMatchObject({ status: 200, body: { progress: null, result: null } });
  });

  it('spot-check: a tab drafts for its own workspace only; GET reads unanswered before any draft', async () => {
    const spot = await route('spot-check');
    const task = 'classify-owner-message';
    expect(await callRoute(spot, { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { task, workspaceId: 'ws-b' } }))
      .toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(await callRoute(spot, { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { task } }))
      .toMatchObject({ status: 400, body: { code: 'curator-workspace-invalid' } });
    expect(await callRoute(spot, { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { workspaceId: 'ws-a' } }))
      .toMatchObject({ status: 400, body: { code: 'curator-task-invalid' } });
    expect(await callRoute(spot, { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { task, workspaceId: 'ws-a', commit: 'curator-spot-check-owner-x' } }))
      .toMatchObject({ status: 409, body: { code: 'curator-refused' } });
    expect(await callRoute(spot, { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { task } }))
      .toMatchObject({ status: 200, body: { itemId: null, verdict: { state: 'unanswered' } } });
  });

  it('label-import is the admin token\'s alone; label-queue answers ids only', async () => {
    const importRoute = await route('label-import');
    expect(await callRoute(importRoute, { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { task: 'flag-owner-question', labels: [] } }))
      .toMatchObject({ status: 403, body: { code: 'forbidden' } });
    expect(await callRoute(importRoute, { method: 'POST', headers: { 'x-pmux-token': admin }, body: { task: 'flag-owner-question', labels: [{ id: 'x', label: 'not-a-question' }] } }))
      .toMatchObject({ status: 409, body: { code: 'curator-refused' } });
    const queue = await callRoute(await route('label-queue'), { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { task: 'flag-owner-question' } });
    expect(queue).toMatchObject({ status: 409, body: { code: 'curator-refused', error: expect.stringMatching(/^served model digest unknown/) } });
  });

  it('reshape-pairs and judge-import are the admin token\'s alone, and refuse with no reshape evaluation (story 23 AC 4)', async () => {
    expect(await callRoute(await route('reshape-pairs'), { method: 'GET', headers: { 'x-pmux-token': tabA } })).toMatchObject({ status: 403 });
    expect(await callRoute(await route('reshape-pairs'), { method: 'GET', headers: { 'x-pmux-token': admin } }))
      .toMatchObject({ status: 409, body: { code: 'curator-refused', error: expect.stringMatching(/^no reshape evaluation/) } });
    expect(await callRoute(await route('judge-import'), { method: 'POST', headers: { 'x-pmux-token': tabA }, body: { runId: 'r', verdicts: [] } })).toMatchObject({ status: 403 });
    expect(await callRoute(await route('judge-import'), { method: 'POST', headers: { 'x-pmux-token': admin }, body: { runId: 'r', verdicts: [] } }))
      .toMatchObject({ status: 409, body: { code: 'curator-refused', error: expect.stringMatching(/^no reshape evaluation to judge/) } });
  });

  it('judge-import writes the verdicts bound to the run; pairs need the drafts this server holds', async () => {
    const { writeReshapeResult, readReshapeJudge } = await import('@/lib/curator-store');
    await writeReshapeResult({
      task: 'reshape-question', runId: 'run-1', promptVersion: 'v', model: 'm', startedAt: 1, finishedAt: 2, target: 100, candidates: 1, replied: 1, clean: 1,
      nonReplies: 0, unresolved: 0, unreshapable: 0, labels: {}, outcomes: {}, latency: { p50: null, p90: null }, refused: null,
      rows: [{ id: 'ws-a/mc/q', outcome: 'labelled', label: 'reshaped', draftSha: 'abc', defects: [], latencyMs: 1 }],
    });
    const res = await callRoute(await route('judge-import'), { method: 'POST', headers: { 'x-pmux-token': admin }, body: { runId: 'run-1', verdicts: [{ id: 'ws-a/mc/q', sha: 'abc', verdict: 'same' }] } });
    expect(res).toMatchObject({ status: 200, body: { runId: 'run-1', imported: 1, same: 1 } });
    expect(await readReshapeJudge()).toMatchObject({ runId: 'run-1', promptVersion: 'v', judge: 'claude-opus-5-5 at high', verdicts: [{ id: 'ws-a/mc/q', sha: 'abc', verdict: 'same' }] });
    expect(await callRoute(await route('reshape-pairs'), { method: 'GET', headers: { 'x-pmux-token': admin } }))
      .toMatchObject({ status: 409, body: { error: expect.stringContaining('the drafts of run run-1 are not held by this server') } });
  });

  it('message: a tab reads its own workspace\'s owner message by id, never another workspace\'s', async () => {
    const { addMessageHistory } = await import('@/lib/message-history-store');
    const entry = await addMessageHistory('ws-a', 'From now on use AEDT');
    const msg = await route('message');
    expect(await callRoute(msg, { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { workspaceId: 'ws-a', entryId: entry.id } }))
      .toMatchObject({ status: 200, body: { workspaceId: 'ws-a', entryId: entry.id, message: 'From now on use AEDT' } });
    expect(await callRoute(msg, { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { workspaceId: 'ws-b', entryId: entry.id } })).toMatchObject({ status: 403 });
    expect(await callRoute(msg, { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { workspaceId: 'ws-a', entryId: 'nope' } })).toMatchObject({ status: 404 });
    const secret = await addMessageHistory('ws-a', 'use token=ghp_abcdefghijklmnopqrstuvwxyz0123 for the push');
    const refused = await callRoute(msg, { method: 'GET', headers: { 'x-pmux-token': tabA }, query: { workspaceId: 'ws-a', entryId: secret.id } });
    expect(refused).toMatchObject({ status: 409, body: { code: 'curator-refused' } });
    expect(JSON.stringify(refused.body)).not.toContain('ghp_');
  });
});
