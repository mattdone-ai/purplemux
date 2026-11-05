import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import { CURATOR_TASKS, servedVersion } from '@/lib/curator-tasks';
import type { ICuratorCallRecord, ICuratorEvalResult } from '@/types/curator';

// The served version keys (architect confirm R2) at the digest the fake Ollama serves by default.
const digestNow = { value: 'sha256:d1' };
const COM = servedVersion('classify-owner-message', 'sha256:d1')!;
const FOQ = servedVersion('flag-owner-question', 'sha256:d1')!;

// ADR-0038 in the server: routing per workspace (AC 3), the board's curator line (AC 8), shadow calls only in a
// started server, promote and demote (AC 5), the spot check's answer (AC 6), the kodit rule (AC 7).

const appended: Array<{ workspaceId: string; tabId: string; kind: string; class: string; text: string }> = [];
let curatorRows: string[] = [];
let allCalls: Array<{ workspaceId: string; at: number; text: string }> = [];
let latestAnswer: unknown = null;
let mcItems: Record<string, { state: string; questionJson: string }> = {};
let koditLog = '';

vi.mock('@/lib/ledger-store', () => ({
  getLedgerStore: () => ({ tabEvents: {
    append: (e: (typeof appended)[number]) => { appended.push(e); return 1; }, curatorCalls: () => curatorRows, curatorCallsSince: () => allCalls,
  } }),
}));
vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => ({
  latestAnswer: () => latestAnswer, itemQuestion: (_ws: string, id: string) => mcItems[id] ?? null,
}) }));
vi.mock('@/lib/remote-host', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/remote-host')>()),
  runSsh: vi.fn(async () => ({ stdout: koditLog, stderr: '' })),
}));

const HOUR = 3_600_000;
const admin: ICaller = { scope: { type: 'admin' } as ICaller['scope'], workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };
const authority = { isWorkspaceOrchestrator: vi.fn(async () => false), now: () => 1 };

let directory = '';
let home: ReturnType<typeof vi.spyOn>;
let fetchMock: ReturnType<typeof vi.fn>;

const g = globalThis as Record<string, unknown>;
const resetGlobals = () => {
  for (const key of ['__ptCuratorClient', '__ptCuratorTimers', '__ptCuratorEvals', '__ptCuratorAgreement', '__ptCuratorStateLock', '__ptFleetConfigLock',
    '__ptCuratorShadowMarked', '__ptCuratorAsksSeen', '__ptCuratorSpotDrafts']) delete g[key];
};

const load = async () => {
  vi.resetModules();
  return import('@/lib/curator-service');
};

const setFleet = async (key: string, value: string) => {
  const { putValue } = await import('@/lib/fleet-config-http');
  await putValue(admin, key, { value }, authority);
};

const writeState = (state: unknown) => {
  fs.mkdirSync(path.join(directory, '.purplemux/curator/eval/results'), { recursive: true });
  fs.writeFileSync(path.join(directory, '.purplemux/curator/state.json'), JSON.stringify(state));
};

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

/** A served gemma4:26b at `digestNow`, answering every chat with `label`. */
const serveTags = (label = 'one-off') => fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/api/tags')
  ? json({ models: [{ name: 'gemma4:26b', digest: digestNow.value }] })
  : json({ message: { content: JSON.stringify({ label, span: 'x' }) } })));

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-curator-service-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  resetGlobals();
  appended.length = 0;
  curatorRows = [];
  allCalls = [];
  latestAnswer = null;
  mcItems = {};
  koditLog = '';
  digestNow.value = 'sha256:d1';
  fetchMock = vi.fn(async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11435') }); });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  const service = await import('@/lib/curator-service');
  service.stopCurator();
  resetGlobals();
  vi.unstubAllGlobals();
  home.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('routing is per workspace and opt-in (AC 3)', () => {
  it('a task routes only in state routing, on the prompt it was promoted on, in a workspace that opts in', async () => {
    serveTags();
    const service = await load();
    await service.getCuratorClient().probe();
    expect(await service.curatorRoutesIn('classify-owner-message', 'ws-a')).toBe(false);
    writeState({ version: 1, liveSince: 1, tasks: { 'classify-owner-message': { state: 'routing', promotedAt: 2, promotedPromptVersion: COM } }, kodit: null, rateLimitMs: 0 });
    expect(await service.curatorRoutesIn('classify-owner-message', 'ws-a')).toBe(false);
    await setFleet('curator.routing.workspaces', 'ws-a');
    expect(await service.curatorRoutesIn('classify-owner-message', 'ws-a')).toBe(true);
    expect(await service.curatorRoutesIn('classify-owner-message', 'ws-ldhziO')).toBe(false);
    expect(await service.curatorRoutesIn('flag-owner-question', 'ws-a')).toBe(false);
    writeState({ version: 1, liveSince: 1, tasks: { 'classify-owner-message': { state: 'routing', promotedAt: 2, promotedPromptVersion: 'com-v0-00000000' } }, kodit: null, rateLimitMs: 0 });
    expect(await service.curatorRoutesIn('classify-owner-message', 'ws-a')).toBe(false);
  });

  it('the routing list is empty by default: treasury-v2 is not in it', async () => {
    const service = await load();
    expect(service.parseRoutingWorkspaces(null)).toEqual([]);
    expect(service.parseRoutingWorkspaces(' ws-a , ,ws-b')).toEqual(['ws-a', 'ws-b']);
    expect(await service.curatorRoutesIn('classify-owner-message', 'ws-ldhziO')).toBe(false);
  });
});

describe('the board (AC 8)', () => {
  it('shows the curator down with the reason when the tunnel does not answer, and every task in shadow', async () => {
    const service = await load();
    await service.getCuratorClient().probe();
    const board = await service.readCuratorBoard('ws-a', Date.now());
    expect(board.health).toMatchObject({ state: 'down' });
    expect(board.health.reason).toMatch(/^tunnel down \(/);
    expect(board.tasks.map((t) => [t.task, t.state, t.routingHere])).toEqual([
      ['classify-owner-message', 'shadow', false], ['flag-owner-question', 'shadow', false], ['match-standing-order', 'shadow', false],
      ['reshape-question', 'shadow', false],
    ]);
  });

  it('up when the model is served; switched off reads as down with its reason', async () => {
    fetchMock.mockImplementation(async () => json({ models: [{ name: 'gemma4:26b', digest: digestNow.value }] }));
    const service = await load();
    await service.getCuratorClient().probe();
    expect((await service.readCuratorBoard('ws-a', Date.now())).health.state).toBe('up');
    await setFleet('curator.enabled', 'off');
    expect((await service.readCuratorBoard('ws-a', Date.now() + 120_000)).health)
      .toMatchObject({ state: 'down', reason: 'switched off (curator.enabled=off)' });
  });

  it('counts the shadow agreement with the rules from the workspace rows of the last 72 h', async () => {
    const rec = (task: string, label: string | null, rulesLabel: string, outcome = 'labelled') => JSON.stringify({ task, label, rulesLabel, outcome });
    curatorRows = [
      rec('classify-owner-message', 'one-off', 'one-off'), rec('classify-owner-message', 'standing-order', 'one-off'),
      rec('classify-owner-message', null, 'one-off', 'timeout'), rec('flag-owner-question', 'question-to-owner', 'question-to-owner'), 'not json',
    ];
    const service = await load();
    const board = await service.readCuratorBoard('ws-a', Date.now());
    expect(board.agreement).toEqual([
      { task: 'classify-owner-message', calls: 3, compared: 2, agreed: 1 },
      { task: 'flag-owner-question', calls: 1, compared: 1, agreed: 1 },
      { task: 'match-standing-order', calls: 0, compared: 0, agreed: 0 },
    ]);
  });
});

describe('shadow calls (ADR-0038 §2)', () => {
  it('make no call outside a started server', async () => {
    const service = await load();
    service.curatorOnOwnerMessage('ws-a', 'm1', 'from now on use AEDT');
    service.curatorOnUnmarkedTurnEnd('ws-a', 'tab-1', 'Shall I merge it?');
    service.curatorOnMissionEvents([{ type: 'attention.opened', workspaceId: 'ws-a', payload: { itemId: 'i1', humanReview: { humanNeed: 'approval' } } }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('in a started server: the owner message is classified and logged with its source id, the version clock starts, and an ending with no "?" is skipped', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/api/tags')
      ? json({ models: [{ name: 'gemma4:26b', digest: digestNow.value }] })
      : json({ message: { content: JSON.stringify({ label: 'standing-order', span: 'from now on' }) } })));
    const service = await load();
    await service.startCurator();
    service.curatorOnOwnerMessage('ws-a', 'm1', 'from now on use AEDT');
    service.curatorOnUnmarkedTurnEnd('ws-a', 'tab-1', 'All done. Merged.');
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    expect(appended[0]).toMatchObject({ workspaceId: 'ws-a', tabId: '-', class: 'log', kind: 'curator' });
    const record = JSON.parse(appended[0].text) as ICuratorCallRecord;
    expect(record).toMatchObject({ task: 'classify-owner-message', outcome: 'labelled', label: 'standing-order', span: 'from now on', sourceId: 'ws-a/m1', promptVersion: COM });
    expect(appended[0].text).not.toContain('use AEDT');
    await vi.waitFor(async () => expect((await service.readCuratorStatus()).tasks[0].shadowSince).toBeGreaterThan(0));
    const status = await service.readCuratorStatus();
    expect(status.tasks.map((t) => t.shadowSince === null)).toEqual([false, true, true, true]);
    expect(status.liveSince).toBeGreaterThan(0);
  });

  it('a flagged ending is then matched against the standing orders, both logged against the tab', async () => {
    fs.mkdirSync(path.join(directory, '.purplemux/curator/eval'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.purplemux/curator/eval/match-standing-order.orders.json'), JSON.stringify([{ id: 'SO-4', text: 'Reversible work needs no approval.' }]));
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/tags')) return json({ models: [{ name: 'gemma4:26b', digest: digestNow.value }] });
      const label = String(init?.body).includes('SO-4: Reversible') ? 'SO-4' : 'question-to-owner';
      return json({ message: { content: JSON.stringify({ label, span: 'Shall I redeploy dev?' }) } });
    });
    const service = await load();
    await service.startCurator();
    service.curatorOnUnmarkedTurnEnd('ws-a', 'tab-1', 'Fixed it.\nShall I redeploy dev?', 'ws-a/0f6e2a3c-1111-4222-8333-944455556666/u1');
    await vi.waitFor(() => expect(appended).toHaveLength(2));
    expect(appended.map((e) => {
      const r = JSON.parse(e.text) as ICuratorCallRecord;
      return [e.tabId, r.task, r.label, r.sourceId];
    })).toEqual([
      ['tab-1', 'flag-owner-question', 'question-to-owner', 'ws-a/0f6e2a3c-1111-4222-8333-944455556666/u1'],
      ['tab-1', 'match-standing-order', 'SO-4', 'ws-a/0f6e2a3c-1111-4222-8333-944455556666/u1'],
    ]);
  });

  it('an MC ask that needs the owner\'s approval or decision is matched once, in shadow; any other ask, and the curator\'s own spot check, is not', async () => {
    fs.mkdirSync(path.join(directory, '.purplemux/curator/eval'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.purplemux/curator/eval/match-standing-order.orders.json'), JSON.stringify([{ id: 'SO-4', text: 'Reversible work needs no approval.' }]));
    mcItems = { 'mc-1': { state: 'open', questionJson: JSON.stringify({ title: 'Redeploy dev?', context: 'Reversible.' }) } };
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/api/tags')
      ? json({ models: [{ name: 'gemma4:26b', digest: digestNow.value }] }) : json({ message: { content: JSON.stringify({ label: 'SO-4', span: 'Redeploy dev?' }) } })));
    const service = await load();
    await service.startCurator();
    const opened = { type: 'attention.opened', workspaceId: 'ws-a', payload: { itemId: 'mc-1', humanReview: { humanNeed: 'approval' } } };
    service.curatorOnMissionEvents([opened, { ...opened, type: 'attention.updated' }, { type: 'attention.opened', workspaceId: 'ws-a', payload: { itemId: 'mc-2', humanReview: { humanNeed: 'information' } } },
      { type: 'attention.opened', workspaceId: 'ws-a', payload: { itemId: 'curator-spot-check-owner-2026-11-03', humanReview: { humanNeed: 'decision' } } }]);
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(appended).toHaveLength(1);
    expect(JSON.parse(appended[0].text)).toMatchObject({ task: 'match-standing-order', label: 'SO-4', sourceId: 'ws-a/mc/mc-1' });
  });
});

const evalDirOf = () => path.join(directory, '.purplemux/curator/eval');
const writeEval = (name: string, value: unknown) => {
  fs.mkdirSync(path.join(evalDirOf(), 'results'), { recursive: true });
  fs.writeFileSync(path.join(evalDirOf(), name), JSON.stringify(value));
};

/** A held-out result as the store keeps it: counts only. */
const heldOut = (counts: ICuratorEvalResult['counts']): Omit<ICuratorEvalResult, 'rows'> => {
  const score = { classes: [], checks: [], pass: false };
  return {
    task: 'flag-owner-question', promptVersion: FOQ, model: 'gemma4:26b', split: 'holdout', startedAt: 0, finishedAt: 1, n: 0, counts, unresolved: 0, agedOut: 0,
    unresolvedByClass: {}, excluded: { shadow: 0, disputed: 0 }, spotCheck: null, refused: null, outcomes: {}, latency: { p50: null, p90: null }, score, rules: score,
  };
};

describe('promote and demote (AC 5, amended)', () => {
  it('with no probe answered, every check is refused first for the unknown digest, and nothing is attributed', async () => {
    const service = await load();
    const verdict = await service.promoteCuratorTask('flag-owner-question', Date.now());
    expect(verdict.refusals[0]).toBe(service.DIGEST_UNKNOWN);
    expect((await service.readCuratorStatus()).tasks[1]).toMatchObject({ state: 'shadow', promptVersion: `${CURATOR_TASKS['flag-owner-question'].promptVersion}~unknown`, shadowSince: null });
  });

  it('refuses with every unmet condition: the version clock, shadow rows, the evaluation', async () => {
    serveTags();
    const service = await load();
    const verdict = await service.promoteCuratorTask('flag-owner-question', Date.now());
    expect(verdict.ok).toBe(false);
    expect(verdict.refusals).toEqual([
      `shadow has not started for ${FOQ}: no live call of this prompt yet`,
      `shadow evidence for ${FOQ}: question-to-owner precision 0/0, needs n >= 30 and >= 0.95`,
      'no evaluation: run `purplemux curator eval --task flag-owner-question`',
    ]);
  });

  it('promotes when the pooled bound, 72 h of this version and 30 shadow rows hold; demote puts it back', async () => {
    serveTags();
    const now = Date.now();
    writeState({ version: 1, liveSince: 1, tasks: { 'flag-owner-question': { state: 'shadow', promotedAt: null, promotedPromptVersion: null, shadowSince: { [FOQ]: now - 80 * HOUR, 'foq-v0-00000000': 1 } } }, kodit: null, rateLimitMs: 0 });
    writeEval('results/flag-owner-question.json', heldOut([{ label: 'question-to-owner', support: 29, predicted: 29, truePositives: 29 }, { label: 'not-a-question', support: 0, predicted: 0, truePositives: 0 }]));
    const shadowIds = Array.from({ length: 30 }, (_, i) => `ws-a/s${i}`);
    writeEval('flag-owner-question.json', { task: 'flag-owner-question', labelledBy: 't', labelledAt: 't', items: shadowIds.map((id) => ({ id, label: 'question-to-owner' })) });
    writeEval('flag-owner-question.shadow.json', { rows: [
      ...shadowIds.map((id) => ({ id, promptVersion: FOQ, predicted: 'question-to-owner', outcome: 'labelled', at: 1 })),
      { id: 'ws-a/s0', promptVersion: 'foq-v0-00000000', predicted: 'not-a-question', outcome: 'labelled', at: 1 },
    ] });
    const service = await load();
    const status = await service.readCuratorStatus();
    expect(status.tasks[1].gate.checks![0]).toMatchObject({ successes: 59, trials: 59, minTrials: 59, pass: true });
    expect(status.tasks[1].gate.shadow[0]).toMatchObject({ successes: 30, trials: 30, pass: true });
    expect(await service.promoteCuratorTask('flag-owner-question', now)).toMatchObject({ ok: true, refusals: [] });
    expect((await service.readCuratorStatus()).tasks[1]).toMatchObject({ state: 'routing', promotedPromptVersion: FOQ, shadowSince: now - 80 * HOUR });
    expect(await service.demoteCuratorTask('flag-owner-question')).toBe(true);
    expect((await service.readCuratorStatus()).tasks[1]).toMatchObject({ state: 'shadow', shadowSince: now - 80 * HOUR });
  });

  it('a re-pull of the tag (a new digest) is a new version: a promoted task reads shadow and promote refuses its unstarted clock (R2)', async () => {
    serveTags();
    const now = Date.now();
    writeState({ version: 1, liveSince: 1, tasks: { 'flag-owner-question': { state: 'routing', promotedAt: 1, promotedPromptVersion: FOQ, shadowSince: { [FOQ]: now - 80 * HOUR } } }, kodit: null, rateLimitMs: 0 });
    const service = await load();
    await service.getCuratorClient().probe();
    expect((await service.readCuratorStatus()).tasks[1]).toMatchObject({ state: 'routing', promptVersion: FOQ });
    await setFleet('curator.routing.workspaces', 'ws-a');
    expect(await service.curatorRoutesIn('flag-owner-question', 'ws-a')).toBe(true);
    digestNow.value = 'sha256:d2';
    await service.getCuratorClient().probe();
    const repulled = servedVersion('flag-owner-question', 'sha256:d2')!;
    expect(repulled).not.toBe(FOQ);
    expect((await service.readCuratorStatus()).tasks[1]).toMatchObject({ state: 'shadow', promptVersion: repulled, shadowSince: null });
    expect(await service.curatorRoutesIn('flag-owner-question', 'ws-a')).toBe(false);
    expect((await service.promoteCuratorTask('flag-owner-question', now)).refusals[0]).toBe(`shadow has not started for ${repulled}: no live call of this prompt yet`);
  });

  it("an edited standing order is a new matcher version: the old version's evidence no longer counts (R2)", async () => {
    serveTags('SO-4');
    const orders = [{ id: 'SO-4', text: 'Reversible work needs no approval.' }];
    writeEval('match-standing-order.orders.json', orders);
    const v1 = servedVersion('match-standing-order', 'sha256:d1', orders)!;
    const ids = Array.from({ length: 40 }, (_, i) => `ws-a/mc/i${i}`);
    writeEval('match-standing-order.json', { task: 'match-standing-order', labelledBy: 't', labelledAt: 't', items: ids.map((id) => ({ id, label: 'SO-4' })) });
    writeEval('match-standing-order.shadow.json', { rows: ids.map((id) => ({ id, promptVersion: v1, predicted: 'SO-4', outcome: 'labelled', at: 1 })) });
    const service = await load();
    expect((await service.curatorGate('match-standing-order', Date.now())).shadow[0]).toMatchObject({ successes: 40, trials: 40 });
    writeEval('match-standing-order.orders.json', [{ id: 'SO-4', text: 'Reversible work in Dev needs no approval.' }]);
    const gate = await service.curatorGate('match-standing-order', Date.now());
    expect(gate.shadow[0]).toMatchObject({ successes: 0, trials: 0 });
    expect(gate.refusals[0]).toMatch(/^shadow has not started for mso-v1-[0-9a-f]{8}~[0-9a-f]{8}: /);
    expect(gate.refusals[0]).not.toContain(v1);
  });

  it('owner messages read the spot check from the Mission Control answer, by actor', async () => {
    writeEval('spot-check.classify-owner-message.json', {
      task: 'classify-owner-message', itemId: 'curator-spot-check-owner-2026-11-03', workspaceId: 'ws-a', openedAt: 1, perClass: {},
      numbers: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [String(i + 1), `ws-a/m${i + 1}`])),
    });
    latestAnswer = { optionIds: ['some-wrong'], text: '2, 9', actor: 'session:owner', createdAt: 5 };
    const service = await load();
    expect((await service.readSpotCheck('classify-owner-message')).verdict).toMatchObject({ state: 'answered', disputed: ['ws-a/m2', 'ws-a/m9'], judged: 30, answeredAt: 5 });
    latestAnswer = { optionIds: ['all-right'], text: '', actor: 'system:auto-answer', createdAt: 6 };
    expect((await service.readSpotCheck('classify-owner-message')).verdict).toMatchObject({ state: 'unreadable' });
  });
});

describe('evaluation exclusions (review r2 F2)', () => {
  it('leave out ids with shadow evidence of any prompt version, and the owner\'s disputed gold', async () => {
    writeEval('classify-owner-message.shadow.json', { rows: [
      { id: 'ws-a/old', promptVersion: 'com-v0-00000000', predicted: 'one-off', outcome: 'labelled', at: 1 },
      { id: 'ws-a/new', promptVersion: COM, predicted: 'one-off', outcome: 'labelled', at: 2 },
    ] });
    writeEval('spot-check.classify-owner-message.json', {
      task: 'classify-owner-message', itemId: 'curator-spot-check-owner-x', workspaceId: 'ws-a', openedAt: 1, perClass: {}, numbers: { 1: 'ws-a/m1', 2: 'ws-a/m2' },
    });
    latestAnswer = { optionIds: ['some-wrong'], text: '2', actor: 'session:owner', createdAt: 9 };
    const service = await load();
    const { exclude, spotCheck } = await service.curatorEvalExclusions('classify-owner-message');
    expect([...exclude.shadow].sort()).toEqual(['ws-a/new', 'ws-a/old']);
    expect([...exclude.disputed]).toEqual(['ws-a/m2']);
    expect(spotCheck).toEqual({ itemId: 'curator-spot-check-owner-x', answeredAt: 9 });
  });
});

describe('the blind label pass (consult 16-promote-gate, ruling 1)', () => {
  const rec = (sourceId: string, label: string) => JSON.stringify({ task: 'flag-owner-question', promptVersion: FOQ, sourceId, label, outcome: 'labelled' });

  it('queues the live version\'s calls as ids only; import adds the gold and the prediction, and refuses an id outside the queue', async () => {
    serveTags();
    allCalls = [
      { workspaceId: 'ws-a', at: 1001, text: rec('ws-a/s/p1', 'question-to-owner') }, { workspaceId: 'ws-a', at: 1002, text: rec('ws-a/s/n1', 'not-a-question') },
      { workspaceId: 'ws-a', at: 1003, text: rec('ws-a/s/n2', 'not-a-question') }, { workspaceId: 'ws-a', at: 1004, text: 'not json' },
      { workspaceId: 'ws-a', at: 1005, text: rec('ws-a/mc/curator-spot-check-match-2026-11-03', 'question-to-owner') },
    ];
    const service = await load();
    const view = await service.curatorLabelQueue('flag-owner-question', Date.now());
    expect(view).toMatchObject({ size: 2, added: 2, promptVersion: FOQ, oldestAt: 1001 });
    const queued = JSON.parse(fs.readFileSync(path.join(evalDirOf(), 'flag-owner-question.queue.json'), 'utf-8')) as { items: Array<{ id: string; at: number }> };
    expect(queued.items.find((i) => i.id === 'ws-a/s/p1')!.at).toBe(1001);
    expect(view.ids).toContain('ws-a/s/p1');
    expect(JSON.stringify(view)).not.toMatch(/question-to-owner|not-a-question/);
    expect((await service.curatorLabelQueue('flag-owner-question', Date.now())).added).toBe(0);
    await expect(service.curatorLabelImport('flag-owner-question', [{ id: 'ws-a/s/zz', label: 'not-a-question' }])).rejects.toThrow(/ids not in the flag-owner-question queue/);
    const negative = view.ids.find((id) => id !== 'ws-a/s/p1')!;
    expect(await service.curatorLabelImport('flag-owner-question', [{ id: 'ws-a/s/p1', label: 'question-to-owner' }, { id: negative, label: 'question-to-owner' }]))
      .toEqual({ task: 'flag-owner-question', imported: 2, excluded: 0, left: 0 });
    const set = JSON.parse(fs.readFileSync(path.join(evalDirOf(), 'flag-owner-question.json'), 'utf-8')) as { items: Array<Record<string, unknown>> };
    expect(set.items.map((i) => Object.keys(i).sort())).toEqual([['at', 'id', 'label'], ['at', 'id', 'label']]);
    const shadow = JSON.parse(fs.readFileSync(path.join(evalDirOf(), 'flag-owner-question.shadow.json'), 'utf-8')) as { rows: Array<Record<string, unknown>> };
    expect(shadow.rows.map((r) => [r.id, r.predicted])).toEqual([['ws-a/s/p1', 'question-to-owner'], [negative, 'not-a-question']]);
    expect(shadow.rows[0].at).toBe(1001);
    expect(set.items.find((i) => i.id === 'ws-a/s/p1')!.at).toBe(1001);
    expect(Object.keys(shadow.rows[0]).sort()).toEqual(['at', 'id', 'outcome', 'predicted', 'promptVersion']);
  });
});

describe('an excluded ask never comes back (confirm N2)', () => {
  it('ids a pass labelled exclude stay known to the queue', async () => {
    serveTags('SO-4');
    const orders = [{ id: 'SO-4', text: 'Reversible work needs no approval.' }];
    writeEval('match-standing-order.orders.json', orders);
    const v = servedVersion('match-standing-order', 'sha256:d1', orders)!;
    const rec = (sourceId: string, label: string) => JSON.stringify({ task: 'match-standing-order', promptVersion: v, sourceId, label, outcome: 'labelled' });
    allCalls = [{ workspaceId: 'ws-a', at: 5, text: rec('ws-a/mc/a', 'SO-4') }, { workspaceId: 'ws-a', at: 6, text: rec('ws-a/mc/b', 'not-covered') }];
    const service = await load();
    expect((await service.curatorLabelQueue('match-standing-order', Date.now())).size).toBe(2);
    expect(await service.curatorLabelImport('match-standing-order', [{ id: 'ws-a/mc/a', label: 'exclude' }, { id: 'ws-a/mc/b', label: 'exclude' }]))
      .toMatchObject({ imported: 0, excluded: 2, left: 0 });
    expect(await service.curatorLabelQueue('match-standing-order', Date.now())).toMatchObject({ size: 0, added: 0 });
  });
});

describe('the spot check is recorded only after its item exists (review r1 F1)', () => {
  const seedSet = () => writeEval('classify-owner-message.json', {
    task: 'classify-owner-message', labelledBy: 't', labelledAt: 't',
    items: ['standing-order', 'product-rule', 'answer', 'status-ping', 'one-off'].flatMap((label) => Array.from({ length: 6 }, (_, i) => ({ id: `ws-x/${label}-${i}`, label }))),
  });

  it('a draft writes nothing; commit refuses until Mission Control holds the item; then the map is written and a redraw is refused', async () => {
    seedSet();
    const service = await load();
    await expect(service.draftSpotCheck('classify-owner-message', 'ws-a', Date.now())).rejects.toThrow(/nothing to spot-check/);
    const sources = await import('@/lib/curator-sources');
    vi.spyOn(sources, 'resolveLabelledText').mockImplementation(async (item) => `text of ${typeof item === 'string' ? item : item.id}`);
    const draft = await service.draftSpotCheck('classify-owner-message', 'ws-a', Date.now());
    expect(draft.question.answerType).toBe('multi');
    const file = path.join(evalDirOf(), 'spot-check.classify-owner-message.json');
    expect(fs.existsSync(file)).toBe(false);
    await expect(service.commitSpotCheck('classify-owner-message', 'ws-a', draft.itemId)).rejects.toThrow(/holds no item/);
    expect(fs.existsSync(file)).toBe(false);
    mcItems[draft.itemId] = { state: 'open', questionJson: JSON.stringify({ ...draft.question, context: `${draft.question.context}\n31. "x" -> Answer to a question` }) };
    await expect(service.commitSpotCheck('classify-owner-message', 'ws-a', draft.itemId)).rejects.toThrow(/does not carry the drafted spot check \(context differ\); nothing written/);
    mcItems[draft.itemId] = { state: 'open', questionJson: JSON.stringify({ ...draft.question, options: draft.question.options.slice(0, 2) }) };
    await expect(service.commitSpotCheck('classify-owner-message', 'ws-a', draft.itemId)).rejects.toThrow(/\(options differ\)/);
    expect(fs.existsSync(file)).toBe(false);
    mcItems[draft.itemId] = { state: 'open', questionJson: JSON.stringify(draft.question) };
    expect(await service.commitSpotCheck('classify-owner-message', 'ws-a', draft.itemId)).toMatchObject({ committed: true });
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).numbers)).toHaveLength(30);
    await expect(service.draftSpotCheck('classify-owner-message', 'ws-a', Date.now())).rejects.toThrow(/stands \(open\); cancel it/);
    mcItems[draft.itemId] = { state: 'cancelled', questionJson: '{}' };
    expect((await service.draftSpotCheck('classify-owner-message', 'ws-a', Date.now())).itemId).toBe(draft.itemId);
    vi.restoreAllMocks();
  });

  it("the matcher's spot check refuses while the pool fails anything else", async () => {
    serveTags();
    const service = await load();
    writeEval('match-standing-order.json', { task: 'match-standing-order', labelledBy: 't', labelledAt: 't', items: [] });
    await expect(service.draftSpotCheck('match-standing-order', 'ws-a', Date.now())).rejects.toThrow(/opens once the pool passes everything else: shadow has not started/);
    await expect(service.draftSpotCheck('flag-owner-question', 'ws-a', Date.now())).rejects.toThrow('flag-owner-question has no spot check');
  });
});

describe('the kodit rule (AC 7)', () => {
  const line = (iso: string, docs: number) => `${iso} docs=${docs}/468828 summaries=${docs * 5}`;

  it('records the 3-day before at once and, 72 h after going live, a fall above 20% holds the client to one call per 10 s', async () => {
    const live = Date.parse('2026-11-03T12:00:00Z');
    const now = live + 73 * HOUR;
    vi.setSystemTime(now);
    writeState({ version: 1, liveSince: live, tasks: {}, kodit: null, rateLimitMs: 0 });
    koditLog = [
      line('2026-10-31T12:17:00Z', 300_000), line('2026-11-03T09:17:00Z', 360_000),
      line('2026-11-03T12:17:00Z', 361_000), line('2026-11-06T09:17:00Z', 400_000),
    ].join('\n');
    const service = await load();
    await service.startCurator();
    await vi.waitFor(async () => expect((await service.readCuratorStatus()).kodit?.after).toBeTruthy());
    const status = await service.readCuratorStatus();
    expect(status.kodit!.before.docsPerHour).toBeCloseTo(60_000 / 69, 1);
    expect(status.kodit!.drop).toBeGreaterThan(0.2);
    expect(status.rateLimitMs).toBe(10_000);
    vi.useRealTimers();
  });
});

describe('owner-message routing in the server (story 23 AC 1, AC 2)', () => {
  it('AC 1: the hook returns at once while the curator call is still pending: delivery never waits on it', async () => {
    let answer: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (url: string) => (String(url).endsWith('/api/tags')
      ? json({ models: [{ name: 'gemma4:26b', digest: digestNow.value }] })
      : new Promise<Response>((resolve) => { answer = resolve; })));
    const service = await load();
    await service.startCurator();
    const started = Date.now();
    expect(service.curatorOnOwnerMessage('ws-a', 'm1', 'the board must show AEDT')).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(50);
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/chat'))).toBe(true));
    expect(appended).toHaveLength(0);
    answer(json({ message: { content: JSON.stringify({ label: 'one-off', span: 'AEDT' }) } }));
    await vi.waitFor(() => expect(appended).toHaveLength(1));
  });

  it('routing on the promoted version in an opted-in workspace: a product rule lands in the spec queue and one routing row is logged, with no text', async () => {
    serveTags('product-rule');
    writeState({ version: 1, liveSince: 1, tasks: { 'classify-owner-message': { state: 'routing', promotedAt: 2, promotedPromptVersion: COM } }, kodit: null, rateLimitMs: 0 });
    await setFleet('curator.routing.workspaces', 'ws-a');
    const service = await load();
    await service.startCurator();
    service.curatorOnOwnerMessage('ws-a', 'm7', 'The board must show AEDT times', Date.parse('2026-11-03T04:00:00Z'));
    await vi.waitFor(() => expect(appended.map((a) => a.kind)).toEqual(['curator', 'curator-route']));
    expect(JSON.parse(appended[1].text)).toEqual({
      task: 'classify-owner-message', sourceId: 'ws-a/m7', label: 'product-rule', promptVersion: COM, action: 'spec-queued', target: 'spec-queue.md',
    });
    expect(appended[1].text).not.toContain('AEDT times');
    const queue = fs.readFileSync(path.join(directory, '.purplemux/workspaces/ws-a/spec-queue.md'), 'utf-8');
    expect(queue).toContain('## m7\n- at: 2026-11-03T04:00:00Z\n- source: owner message ws-a/m7\n\n> The board must show AEDT times');
  });

  it('in shadow (no promotion) nothing is queued and only the call record is written', async () => {
    serveTags('product-rule');
    await setFleet('curator.routing.workspaces', 'ws-a');
    const service = await load();
    await service.startCurator();
    service.curatorOnOwnerMessage('ws-a', 'm8', 'The board must show AEDT times');
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(appended.map((a) => a.kind)).toEqual(['curator']);
    expect(fs.existsSync(path.join(directory, '.purplemux/workspaces/ws-a/spec-queue.md'))).toBe(false);
  });
});
