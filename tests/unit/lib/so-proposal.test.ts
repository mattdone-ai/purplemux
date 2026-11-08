import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import type { ITabEventRoute } from '@/lib/tab-event-router';
import type { IMissionBinding, TMissionProducerEvent } from '@/types/mission-control';

// ADR-0041 §1 amendment D7 (harness-flow-loop-2 story 02), "Tests the follow-on epic writes" 2-10 and 14: the selected
// portfolio manager proposes a fleet standing order, the server opens a `confirm` item of class `scope` with no default
// through the events route's own batch function, and the owner's Yes files exactly one fleet order. The REAL Mission
// Control store, the REAL batch path and the REAL order files (under a temporary HOME) run here. Authority (test 1)
// runs against the real `selectedScrumMasterScope` in so-proposal-authority.test.ts.

const live = vi.hoisted(() => ({
  store: null as unknown,
  home: '',
  identity: null as null | Omit<IMissionBinding, 'generation'>,
}));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => live.home }, homedir: () => live.home };
});
vi.mock('@/lib/mission-control-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mission-control-store')>();
  return { ...actual, getMissionControlStore: () => live.store };
});
vi.mock('@/lib/mission-control-runtime', () => ({
  resolveMissionTargetIdentity: vi.fn(async (_ws: string, tabId: string) => (tabId === live.identity?.tabId ? live.identity : null)),
}));
vi.mock('@/lib/workspace-store', () => ({
  getWorkspaceById: vi.fn(async (id: string) => ({ id, orchestration: { enabled: true, orchestratorTabId: id === 'ws-sm' ? 'tab-sm' : `tab-${id}` } })),
}));
vi.mock('@/lib/mission-question-config', () => ({ readQuestionMinVersion: vi.fn(async () => 2) }));
const attention = vi.hoisted(() => ({ alert: vi.fn(async (_input: unknown) => []) }));
vi.mock('@/lib/attention-alerts', () => ({ alertOpenedAttention: attention.alert }));
vi.mock('@/lib/curator-service', () => ({ curatorOnMissionEvents: vi.fn() }));
// The withdrawal hook imports the service from the batch path; this file drives the step itself.
const hook = vi.hoisted(() => ({ settled: [] as string[] }));
vi.mock('@/lib/so-proposal-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/so-proposal-service')>();
  return { ...actual, settleProposalSoon: (itemId: string) => { hook.settled.push(itemId); } };
});

import { MissionControlStore } from '@/lib/mission-control-store';
import { autoAnswerRefusal } from '@/lib/mission-control-auto-answer';
import { applyMissionEventBatch } from '@/lib/mission-control-events';
import { SO_PROPOSAL_EVENT_PREFIX, SO_PROPOSAL_ITEM_PREFIX, parseMissionEventBatch } from '@/lib/mission-control-validation';
import { validateMissionQuestion } from '@/lib/mission-question-format';
import { EXPIRED_REASON, SO_PROPOSAL_TTL_MS, proposalItemId, proposalOrderSource } from '@/lib/so-proposal';
import {
  proposeStandingOrder, runSoProposalPass, settleProposal, type ISoProposalDeps,
} from '@/lib/so-proposal-service';
import { addFleetOrderOnce, addStandingOrder } from '@/lib/standing-orders-service';
import { FLEET, orderFilePath, readAllOrderFiles, readOrderFile } from '@/lib/standing-orders-store';

const T0 = Date.UTC(2026, 10, 5, 4, 0, 0);
const SM: Omit<IMissionBinding, 'generation'> = { tabId: 'tab-sm', providerId: 'claude', sessionId: 'sess-sm', runtimeGeneration: 'launch-1' };
const SELECTION = { managerWorkspaceId: 'ws-sm', managerTabId: 'tab-sm', workspaceIds: ['ws-a', 'ws-b'] };
const ADMIN = { scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true } as unknown as ICaller;
const smCaller = { scope: { type: 'workspace', workspaceId: 'ws-sm', tabId: 'tab-sm', tabVerified: true }, workspaceId: 'ws-sm', tabId: 'tab-sm',
  tabName: 'portfolio-sm', verified: true, identity: 'launch', admin: false } as unknown as ICaller;
const RULE = 'Every owner question is a Mission Control item first; the note to the Portfolio Scrum Master carries its id.';

let directory = '';
let store: MissionControlStore;

class Harness {
  now = T0;
  audit: Array<Record<string, unknown>> = [];
  prompts: string[] = [];
  routed: ITabEventRoute[] = [];
  tabs = [{ workspaceId: 'ws-a', tabId: 'tab-a1' }, { workspaceId: 'ws-b', tabId: 'tab-b1' }, { workspaceId: 'ws-sm', tabId: 'tab-sm' }];
  selected = true;
  deps(): ISoProposalDeps {
    return {
      now: () => this.now,
      store: () => store,
      selection: async (caller) => (this.selected && caller.tabId === 'tab-sm' ? SELECTION : null),
      orchestratorTabId: async (ws) => (ws === 'ws-sm' ? 'tab-sm' : `tab-${ws}`),
      apply: (ws, events, opener, options) => applyMissionEventBatch(ws, events, opener, options),
      orders: {
        now: () => this.now,
        workspaceIds: async () => ['ws-a', 'ws-b', 'ws-sm'],
        refreshPrompt: async (ws) => { this.prompts.push(ws); },
        liveAgentTabs: (ws) => this.tabs.filter((t) => ws === null || t.workspaceId === ws),
        route: async (event) => {
          this.routed.push(event);
          return { class: event.class, delivered: true, seq: this.routed.length, duplicate: false };
        },
      },
      audit: async (entry) => { this.audit.push(entry); return true; },
    };
  }
  events(name: string) {
    return this.audit.filter((e) => e.event === name);
  }
}

const startRun = (): void => {
  live.identity = SM;
  const start: TMissionProducerEvent = {
    schemaVersion: 1, workspaceId: 'ws-sm', runId: 'run-sm', producerAt: 1, eventId: 'e-start', expectedRevision: 0, bindingGeneration: 0,
    type: 'run.started', payload: { objective: 'Portfolio', tabId: SM.tabId },
  };
  store.applyEvents([start], new Map([[start.eventId, SM]]));
};

const errorOf = async (p: Promise<unknown>): Promise<{ code?: string; reason?: string; message: string }> =>
  p.then(() => ({ code: 'none', message: '' }), (err: { code?: string; reason?: string; message: string }) => err);

const items = () => store.snapshot().items;
const fleetText = () => fs.readFileSync(orderFilePath(FLEET), 'utf-8');

const answer = (itemId: string, optionIds: string[], text = '', submissionId = `s-${itemId}-${optionIds.join('')}-${text.length}`) => {
  const item = store.attentionItem(itemId)!;
  return store.submitAnswer(itemId, { submissionId, expectedRevision: item.revision, optionIds, text, actionCompleted: false }, 'human:owner');
};

/** Add 300-character fleet orders until the next one is refused: the budget then has less than one more such order. */
const fillBudget = async (h: Harness): Promise<number> => {
  for (let i = 0; ; i += 1) {
    try {
      await addStandingOrder(h.deps().orders, ADMIN, FLEET, { text: `${i} ${'w'.repeat(296)}`, source: 's' });
    } catch (err) {
      expect((err as { code?: string }).code).toBe('so-too-large');
      return i;
    }
  }
};

const propose = (h: Harness, input: Record<string, unknown> = {}) =>
  proposeStandingOrder(h.deps(), smCaller, { text: RULE, why: 'The owner said this to three seats today.', cites: 'owner message havmSUlP of ws-zOfVyu, 2026-11-04T02:10Z', ...input });

beforeEach(async () => {
  vi.clearAllMocks();
  hook.settled = [];
  live.home = await fsp.mkdtemp(path.join(os.tmpdir(), 'pmux-so-proposal-'));
  directory = live.home;
  store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
  live.store = store;
  delete (globalThis as { __ptStandingOrdersLock?: unknown }).__ptStandingOrdersLock;
  delete (globalThis as { __ptSoProposeLock?: unknown }).__ptSoProposeLock;
  await readOrderFile(FLEET); // seeds SO-1..SO-7, so every "nothing written" check compares a real file
});

afterEach(async () => {
  store.close();
  await fsp.rm(directory, { recursive: true, force: true });
});

describe('the proposal item (D7 rule 4; test 2)', () => {
  it('opens format 2 confirm, class scope, no default, nothing recommended, the reserved id, on the SM run, owner-visible, with no opener row', async () => {
    startRun();
    const h = new Harness();
    const result = await propose(h);
    expect(result).toMatchObject({ workspaceId: 'ws-sm', runId: 'run-sm', workspaces: 3, liveTabs: 3 });
    expect(result.itemId).toBe(proposalItemId(RULE, T0));
    expect(result.itemId).toMatch(/^so-proposal-[0-9a-f]{16}[0-9a-f]{8}$/);
    const item = store.attentionItem(result.itemId)!;
    expect(item).toMatchObject({
      state: 'open', runId: 'run-sm', formatVersion: 2, kind: 'question', answerType: 'confirm', class: 'scope', defaultOptionId: null,
      decision: 'Add this fleet standing order? It reaches every Claude tab on this host.', whyNow: 'The owner said this to three seats today.',
      humanReview: { humanNeed: 'decision', reviewerTabId: 'tab-sm', binding: expect.objectContaining({ tabId: 'tab-sm' }) },
      proposal: { state: 'open', orderId: null, reason: null },
    });
    expect(item.options.map((o) => [o.id, o.recommended])).toEqual([['yes', false], ['no', false]]);
    expect(item.context).toContain(`\n${RULE}\n`);
    expect(item.context).toContain('Proposed by `ws-sm/tab-sm`');
    expect(item.context).toContain('owner message havmSUlP of ws-zOfVyu, 2026-11-04T02:10Z');
    expect(item.context).toContain('Reaches 3 workspaces and 3 live agent tabs');
    expect(item.context).toMatch(/Largest prompt section after the add: \d+ bytes of 8192/);
    expect(item.context.split('\n').at(-1)).toBe('Yes files the order exactly as quoted. No, text alone, or no answer in 72 h files nothing.');
    // No opener row: a NEEDS-DECISION line of the SM in the same turn still opens its own item (§2 reads this table).
    expect(store.itemsAskedByTab('ws-sm', 'tab-sm', 0)).toEqual([]);
    // The owner's attention-opened push runs for a server-opened item as for any other.
    expect(attention.alert).toHaveBeenCalledTimes(1);
    expect(attention.alert.mock.calls[0][0]).toMatchObject({ openerTabId: null });
    // The record is the item's, written in its transaction; the context quotes its text byte for byte.
    const record = store.soProposal(result.itemId)!;
    expect(record).toMatchObject({ workspaceId: 'ws-sm', proposerTabId: 'tab-sm', text: RULE, scope: 'fleet', checkName: 'prose', state: 'open' });
    expect(item.context).toContain(record.text);
    expect(h.events('so-proposal-opened')).toEqual([expect.objectContaining({ itemId: result.itemId, workspaceId: 'ws-sm', tabId: 'tab-sm', identity: 'launch' })]);
    expect(String(h.audit[0].textSha256)).toMatch(/^[0-9a-f]{64}$/);
    const { itemId: ignored, humanReview, ...question } = (store.eventsAfter(0, 50).events.find((e) => e.type === 'attention.opened')!.payload as Record<string, unknown>);
    void ignored; void humanReview;
    // The stored payload carries the normalizer's `routing` and `recommendation: null`, as the fixture test strips them.
    delete (question as Record<string, unknown>).routing;
    delete (question as Record<string, unknown>).recommendation;
    const verdict = validateMissionQuestion(question, 2);
    expect(verdict.ok ? [] : verdict.defects.map((d) => d.message)).toEqual([]);
  });

  it('quotes an order holding backticks inside a longer fence; every other item serves proposal null', async () => {
    startRun();
    const h = new Harness();
    const text = 'Run ```purplemux so list``` before you ask the owner.';
    const { itemId } = await propose(h, { text });
    expect(store.attentionItem(itemId)!.context.startsWith('````text\n')).toBe(true);
    expect(store.attentionItem(itemId)!.context).toContain(`\n${text}\n${'`'.repeat(4)}`);
    expect(store.snapshot().items.find((i) => i.id === itemId)?.proposal).toEqual({ state: 'open', orderId: null, reason: null });
  });
});

describe('checks before the item opens (D7 rule 3; test 3): no item, no record, nothing filed', () => {
  const nothingWritten = (before: string) => {
    expect(items()).toEqual([]);
    expect(store.openSoProposals()).toEqual([]);
    expect(fleetText()).toBe(before);
  };

  it('so-invalid names the field; so-too-large names the measured size', async () => {
    startRun();
    const h = new Harness();
    const before = fleetText();
    expect(await errorOf(propose(h, { text: '' }))).toMatchObject({ code: 'so-invalid', message: expect.stringMatching(/^text: /) });
    expect(await errorOf(propose(h, { why: 'x'.repeat(201) }))).toMatchObject({ code: 'so-invalid', message: 'why: 201 characters, at most 200' });
    expect(await errorOf(propose(h, { why: 'a\nb' }))).toMatchObject({ code: 'so-invalid', message: expect.stringMatching(/^why: /) });
    expect(await errorOf(propose(h, { cites: 'c'.repeat(301) }))).toMatchObject({ code: 'so-invalid', message: 'cites: 301 characters, at most 300' });
    expect(await errorOf(propose(h, { scope: 'fleet;rm' }))).toMatchObject({ code: 'so-invalid', message: expect.stringMatching(/^scope: /) });
    expect(await fillBudget(h)).toBeGreaterThan(5);
    const full = fleetText();
    const tooLarge = await errorOf(propose(h, { text: 'z'.repeat(590) }));
    expect(tooLarge).toMatchObject({ code: 'so-too-large', message: expect.stringMatching(/would be \d+ bytes, at most 8192/) });
    expect(items()).toEqual([]);
    expect(fleetText()).toBe(full);
    expect(before).toContain('SO-1');
  });

  it('duplicate names the active fleet order; open-proposal names the open item; no-orchestrator-run says to start the run', async () => {
    const h = new Harness();
    const before = fleetText();
    const seed = (await readOrderFile(FLEET)).orders[0];
    const dup = await errorOf(propose(h, { text: `${seed.text.toUpperCase()}.` }));
    expect(dup).toMatchObject({ code: 'so-proposal-refused', reason: 'duplicate', message: `duplicate: the active fleet order ${seed.id} already says this` });
    const noRun = await errorOf(propose(h));
    expect(noRun).toMatchObject({ code: 'so-proposal-refused', reason: 'no-orchestrator-run',
      message: expect.stringContaining('start or resume your Mission Control run, then propose again') });
    nothingWritten(before);
    startRun();
    const { itemId } = await propose(h);
    h.now += 5_000;
    const open = await errorOf(propose(h, { text: `${RULE.toLowerCase()} ` }));
    expect(open).toMatchObject({ code: 'so-proposal-refused', reason: 'open-proposal', message: expect.stringContaining(itemId) });
    expect(items()).toHaveLength(1);
    expect(h.events('so-proposal-opened')).toHaveLength(1);
  });
});

describe('reserved prefixes (D7 rule 4; test 4)', () => {
  const opened = (eventId: string, itemId: string, type: 'attention.opened' | 'attention.updated' = 'attention.opened', extra: Record<string, unknown> = {}) => [{
    eventId, schemaVersion: 1, workspaceId: 'ws-sm', runId: 'run-sm', expectedRevision: type === 'attention.opened' ? 0 : 1, producerAt: 2, bindingGeneration: 1, type,
    payload: { itemId, formatVersion: 2, kind: 'question', title: 't', decision: 'd?', whyNow: 'w', answerType: 'confirm',
      options: [{ id: 'yes', label: 'Yes', recommended: false, needsText: false }, { id: 'no', label: 'No', recommended: false, needsText: false }],
      context: 'c', storyIds: [], blockingScope: 'none', canContinue: true, ...extra },
  }];

  it('no tab or token opens or revises a so-proposal- item, nor one that only adds a default or changes the class', () => {
    const id = `${SO_PROPOSAL_ITEM_PREFIX}0123456789abcdef01234567`;
    for (const batch of [
      opened('e1', id), opened('e2', id, 'attention.updated'), opened('e3', id, 'attention.updated', { defaultOptionId: 'yes' }),
      opened('e4', id, 'attention.updated', { class: 'bookkeeping' }),
    ]) {
      expect(() => parseMissionEventBatch(batch, { questionMinVersion: 2 })).toThrow(/namespace only the server opens or revises/);
      expect(() => parseMissionEventBatch(batch, { questionMinVersion: 2, serverPrefix: 'system:curator-so:' })).toThrow(/namespace only the server/);
    }
    expect(() => parseMissionEventBatch(opened(`${SO_PROPOSAL_EVENT_PREFIX}x`, 'other-item'), { questionMinVersion: 2 })).toThrow(/reserved namespace/);
    // The SM's withdrawal is an attention.cancelled, which the prefix does not stop.
    expect(() => parseMissionEventBatch([{ eventId: 'c1', schemaVersion: 1, workspaceId: 'ws-sm', runId: 'run-sm', expectedRevision: 1, producerAt: 2,
      bindingGeneration: 1, type: 'attention.cancelled', payload: { itemId: id, reason: 'withdrawn' } }])).not.toThrow();
  });

  it('the store opens a so-proposal- item only with its record, and a record only with that item', () => {
    startRun();
    const [event] = parseMissionEventBatch(opened(`${SO_PROPOSAL_EVENT_PREFIX}open:x`, `${SO_PROPOSAL_ITEM_PREFIX}abc`), { questionMinVersion: 2, serverPrefix: SO_PROPOSAL_EVENT_PREFIX }).events;
    expect(() => store.applyEvents([event], new Map(), { questionMinVersion: 2 })).toThrow(/opens only with its proposal record/);
    const [other] = parseMissionEventBatch(opened('e-plain', 'plain-item'), { questionMinVersion: 2 }).events;
    expect(() => store.applyEvents([other], new Map(), { questionMinVersion: 2, soProposals: new Map([['e-plain', {
      proposerTabId: 'tab-sm', text: 't', scope: 'fleet', checkName: 'prose', cites: null }]]) })).toThrow(/opens only with its proposal record/);
    expect(items()).toEqual([]);
  });
});

describe('the ADR-0031 auto-answer never files a proposal (D7 rule 5; test 5)', () => {
  it('is never a candidate at 1 minute after any wait, and submitSystemAnswer is refused', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    const rule = { minutes: 1, version: 1 };
    expect(store.listAutoAnswerCandidates().map((i) => i.id)).not.toContain(itemId);
    const item = store.attentionItem(itemId)!;
    for (const wait of [60_000, 3_600_000, SO_PROPOSAL_TTL_MS - 1]) expect(autoAnswerRefusal(item, rule, item.updatedAt + wait)).not.toBeNull();
    expect(() => store.submitSystemAnswer(itemId, item.revision, rule, item.updatedAt + 3_600_000)).toThrow(/only a bookkeeping item is auto-answered/);
    expect(store.attentionItem(itemId)!.state).toBe('open');
    expect(await runSoProposalPass(h.deps())).toEqual([]);
  });
});

describe('the answer step (D7 rule 6; tests 6-9)', () => {
  it('Yes files exactly one fleet order from the record, the answer id in its source; prompts, lines, one audit row, item serves filed', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h, { scope: 'fleet, workers', check: 'tests/unit/lib/needs-decision.test.ts' });
    h.now += 60_000;
    const stored = answer(itemId, ['yes']);
    expect(await settleProposal(h.deps(), itemId)).toBe('filed');
    const fleet = await readOrderFile(FLEET);
    const filed = fleet.orders.filter((o) => o.text === RULE);
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ scope: 'fleet, workers', check: 'tests/unit/lib/needs-decision.test.ts', state: 'active',
      source: proposalOrderSource(stored.answer.id, itemId, stored.answer.createdAt, 'ws-sm', 'tab-sm') });
    expect(filed[0].source).toMatch(new RegExp(`^owner answer ${stored.answer.id} on MC item ${itemId} \\(\\d{4}-\\d{2}-\\d{2} UTC\\), proposed by ws-sm/tab-sm$`));
    expect(h.prompts.sort()).toEqual(['ws-a', 'ws-b', 'ws-sm']);
    expect(h.routed.map((r) => [r.tabId, r.kind, r.class])).toEqual([['tab-a1', 'standing-order', 'urgent'], ['tab-b1', 'standing-order', 'urgent'], ['tab-sm', 'standing-order', 'urgent']]);
    expect(h.routed[0].text).toContain(`${filed[0].id} added (fleet): ${RULE}`);
    expect(h.events('so-proposal-filed')).toEqual([expect.objectContaining({ itemId, orderId: filed[0].id, answerId: stored.answer.id, answerActor: 'human:owner' })]);
    expect(store.attentionItem(itemId)!.proposal).toEqual({ state: 'filed', orderId: filed[0].id, reason: null });
    expect(store.soProposal(itemId)).toMatchObject({ state: 'filed', answerId: stored.answer.id, orderId: filed[0].id });
  });

  it('one order for one answer: a replay, a crash after the add, and the route step racing the pass each file one', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    const request = { submissionId: 'owner-yes-1', expectedRevision: store.attentionItem(itemId)!.revision, optionIds: ['yes'], text: '', actionCompleted: false };
    const stored = store.submitAnswer(itemId, request, 'human:owner');
    expect(store.submitAnswer(itemId, request, 'human:owner').replayed).toBe(true);
    // The route step and the pass at the same time.
    const outcomes = await Promise.all([settleProposal(h.deps(), itemId), runSoProposalPass(h.deps()), settleProposal(h.deps(), itemId)]);
    expect(outcomes.flat().filter((o) => o === 'filed' || (typeof o === 'object' && o.outcome === 'filed'))).toHaveLength(1);
    expect((await readOrderFile(FLEET)).orders.filter((o) => o.source.includes(stored.answer.id))).toHaveLength(1);
    expect(h.events('so-proposal-filed')).toHaveLength(1);
    expect(await settleProposal(h.deps(), itemId)).toBe('none');

    // A crash after the add and before the record update: the pass finds the order by the answer id and files no second.
    h.now += 10_000;
    const second = await propose(h, { text: 'Name the data sources you checked before you say data is not available.' });
    const yes = answer(second.itemId, ['yes']);
    const record = store.soProposal(second.itemId)!;
    const crashed = await addFleetOrderOnce(h.deps().orders, ADMIN, { text: record.text, scope: record.scope, check: record.checkName,
      source: proposalOrderSource(yes.answer.id, second.itemId, yes.answer.createdAt, 'ws-sm', 'tab-sm') }, () => null);
    expect(store.soProposal(second.itemId)!.state).toBe('open');
    expect(await runSoProposalPass(h.deps())).toEqual([{ itemId: second.itemId, outcome: 'filed' }]);
    expect(store.soProposal(second.itemId)).toMatchObject({ state: 'filed', orderId: crashed.result!.order.id });
    expect((await readAllOrderFiles()).flatMap((f) => f.orders).filter((o) => o.source.includes(yes.answer.id))).toHaveLength(1);
  });

  it('Yes after the budget filled since the proposal: not-filed with the measured size, one line to the SM, one row, fleet file unchanged', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h, { text: `Keep this rule. ${'r'.repeat(560)}` });
    await fillBudget(h);
    const full = fleetText();
    h.routed = [];
    answer(itemId, ['yes']);
    expect(await settleProposal(h.deps(), itemId)).toBe('not-filed');
    expect(fleetText()).toBe(full);
    const record = store.soProposal(itemId)!;
    const reason = record.reason!;
    // The owner reads a sentence with the measured size; the code is recorded beside it and audited, never served.
    expect(reason).toMatch(/^Filing it would make the standing orders of (the fleet|ws-\S+) \d{4} bytes, past the 8192-byte budget\. Strike an order, then propose again\.$/);
    expect(reason).not.toMatch(/so-[a-z]/);
    expect(record.reasonCode).toBe('so-too-large');
    expect(store.attentionItem(itemId)!.proposal).toEqual({ state: 'not-filed', orderId: null, reason });
    expect(JSON.stringify(store.attentionItem(itemId)!.proposal)).not.toContain('so-too-large');
    expect(h.events('so-proposal-not-filed')[0]).toMatchObject({ reason, reasonCode: 'so-too-large',
      message: expect.stringMatching(/would be \d+ bytes, at most 8192/) });
    expect(h.routed).toEqual([{ workspaceId: 'ws-sm', tabId: 'tab-sm', kind: 'standing-order', class: 'urgent',
      text: `[purplemux standing order] proposal ${itemId} not filed: ${reason}: nothing filed` }]);
    expect(h.events('so-proposal-not-filed')).toHaveLength(1);
    expect(await runSoProposalPass(h.deps())).toEqual([]);
    expect(h.routed).toHaveLength(1);
  });

  it('a duplicate filed after the proposal: not-filed, naming the order', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    const admin = await addStandingOrder(h.deps().orders, ADMIN, FLEET, { text: RULE, source: 'owner message x' });
    answer(itemId, ['yes']);
    expect(await settleProposal(h.deps(), itemId)).toBe('not-filed');
    expect(store.soProposal(itemId)).toMatchObject({ reason: `The active fleet order ${admin.order.id} already says this.`, reasonCode: 'duplicate' });
    expect((await readOrderFile(FLEET)).orders.filter((o) => o.text === RULE)).toHaveLength(1);
  });

  it('No and text alone file nothing (declined); Yes with text files the quoted text unchanged', async () => {
    startRun();
    const h = new Harness();
    const a = await propose(h, { text: 'Rule A for every seat.' });
    const b = await propose(h, { text: 'Rule B for every seat.' });
    const c = await propose(h, { text: 'Rule C for every seat.' });
    answer(a.itemId, ['no']);
    answer(b.itemId, [], 'Make it say workers only, then ask again.');
    answer(c.itemId, ['yes'], 'Good, but I would have phrased it differently.');
    expect(await runSoProposalPass(h.deps())).toEqual([
      { itemId: a.itemId, outcome: 'declined' }, { itemId: b.itemId, outcome: 'declined' }, { itemId: c.itemId, outcome: 'filed' }]);
    const texts = (await readOrderFile(FLEET)).orders.map((o) => o.text);
    expect(texts).toContain('Rule C for every seat.');
    expect(texts.some((t) => t.startsWith('Rule A') || t.startsWith('Rule B') || t.includes('phrased'))).toBe(false);
    expect(h.events('so-proposal-declined').map((e) => e.itemId)).toEqual([a.itemId, b.itemId]);
    expect(store.attentionItem(a.itemId)!.proposal).toEqual({ state: 'declined', orderId: null, reason: null });
  });

  it('the owner\'s Yes files the order also when the selection moved or the SM cancelled the item after the answer', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    const stored = answer(itemId, ['yes']);
    h.selected = false;
    const item = store.attentionItem(itemId)!;
    await applyMissionEventBatch('ws-sm', [{ eventId: 'sm-cancel', schemaVersion: 1, workspaceId: 'ws-sm', runId: 'run-sm', expectedRevision: item.revision,
      producerAt: 3, bindingGeneration: 1, type: 'attention.cancelled', payload: { itemId, reason: 'changed my mind' } }], null);
    await vi.waitFor(() => expect(hook.settled).toEqual([itemId]));
    expect(await settleProposal(h.deps(), itemId)).toBe('filed');
    expect((await readOrderFile(FLEET)).orders.filter((o) => o.source.includes(stored.answer.id))).toHaveLength(1);
  });

  it('an answer from a system actor files nothing', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    const item = store.attentionItem(itemId)!;
    // Only the auto-answer tick answers as a system actor, and it refuses this item; force the row to prove the step's own guard.
    const db = new Database(path.join(directory, 'mission.sqlite'));
    answer(itemId, ['yes']);
    db.prepare('UPDATE answers SET actor = ? WHERE item_id = ?').run('system:auto-answer', itemId);
    db.close();
    expect(item.state).toBe('open');
    expect(await settleProposal(h.deps(), itemId)).toBe('not-filed');
    expect(store.soProposal(itemId)).toMatchObject({ reason: 'The answer did not come from the owner, so nothing was written.', reasonCode: 'system-actor' });
    expect(h.events('so-proposal-not-filed')[0]).toMatchObject({ message: expect.stringMatching(/came from system:auto-answer, not the owner/) });
    expect((await readOrderFile(FLEET)).orders.some((o) => o.text === RULE)).toBe(false);
  });
});

describe('review r1 fixes', () => {
  it('finding 2: only a fleet order with exactly this answer\'s source counts as filed; a workspace order with that source does not', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    const stored = answer(itemId, ['yes']);
    const source = proposalOrderSource(stored.answer.id, itemId, stored.answer.createdAt, 'ws-sm', 'tab-sm');
    // A seat that learned the answer id writes the exact source on its own workspace order, and a near miss on the fleet.
    const spoof = await addStandingOrder(h.deps().orders, smCaller, 'ws-sm', { text: 'A workspace rule.', source });
    const near = await addStandingOrder(h.deps().orders, ADMIN, FLEET, { text: 'A fleet rule.', source: `${source} (copy)` });
    expect(await settleProposal(h.deps(), itemId)).toBe('filed');
    const filed = (await readOrderFile(FLEET)).orders.filter((o) => o.source === source);
    expect(filed.map((o) => o.text)).toEqual([RULE]);
    expect(store.soProposal(itemId)!.orderId).toBe(filed[0].id);
    expect([spoof.order.id, near.order.id]).not.toContain(filed[0].id);
  });

  it('finding 4: cites and check stay inside a fence, so a proposer\'s markdown never renders on the owner\'s card', async () => {
    startRun();
    const h = new Harness();
    const cites = 'see [the owner](https://evil.example/) and ```code``` and **bold**';
    const check = 'tests/a.test.ts` **x** `';
    const { itemId } = await propose(h, { cites, check });
    const context = store.attentionItem(itemId)!.context;
    const lines = context.split('\n');
    const open = lines.indexOf('````text');
    const shut = lines.indexOf('````', open + 1);
    expect(open).toBeGreaterThan(-1);
    expect(lines.slice(open + 1, shut)).toEqual(['scope: fleet', `check: ${check}`, `cites: ${cites}`]);
    expect(lines.filter((line, i) => (i < open || i > shut) && (line.includes('evil.example') || line.includes('**')))).toEqual([]);
  });

  it('finding 3: a failed audit write and a failed proposer line are retried once, then logged; the outcome stands', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h, { text: `Keep this rule. ${'r'.repeat(560)}` });
    h.now += 5_000;
    const second = await propose(h, { text: `Another rule for every seat. ${'q'.repeat(560)}` });
    await fillBudget(h);
    answer(itemId, ['yes']);
    const deps = h.deps();
    let audits = 0;
    let routes = 0;
    const flaky: ISoProposalDeps = {
      ...deps,
      audit: async (entry) => { audits += 1; if (audits === 1) return false; return deps.audit(entry); },
      orders: { ...deps.orders, route: async (event) => { routes += 1; if (routes === 1) throw new Error('router busy'); return deps.orders.route(event); } },
    };
    expect(await settleProposal(flaky, itemId)).toBe('not-filed');
    expect([audits, routes]).toEqual([2, 2]);
    expect(h.events('so-proposal-not-filed')).toHaveLength(1);
    expect(h.routed.filter((r) => r.tabId === 'tab-sm' && r.text.includes(itemId))).toHaveLength(1);

    answer(second.itemId, ['yes']);
    const dead: ISoProposalDeps = { ...deps, audit: async () => false, orders: { ...deps.orders, route: async () => { throw new Error('down'); } } };
    expect(await settleProposal(dead, second.itemId)).toBe('not-filed');
    expect(store.soProposal(second.itemId)!.state).toBe('not-filed');
  });
});

describe('timeout and withdrawal (D7 rule 7; test 10)', () => {
  it('at 72 h the pass cancels the item with the server event, the record is expired, a later answer is refused, one line to the SM', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    const opened = store.soProposal(itemId)!.createdAt;
    h.now = opened + SO_PROPOSAL_TTL_MS - 1;
    expect(await runSoProposalPass(h.deps())).toEqual([]);
    h.now = opened + SO_PROPOSAL_TTL_MS + 60_000;
    expect(await runSoProposalPass(h.deps())).toEqual([{ itemId, outcome: 'expired' }]);
    const item = store.attentionItem(itemId)!;
    expect(item).toMatchObject({ state: 'cancelled', resolution: EXPIRED_REASON, proposal: { state: 'expired', orderId: null, reason: EXPIRED_REASON } });
    expect(store.eventsAfter(0, 50).events.find((e) => e.id === `system:so-proposal:expire:${itemId}`)).toMatchObject({ type: 'attention.cancelled', entityId: itemId });
    expect(() => answer(itemId, ['yes'])).toThrow(/no longer open/);
    expect(h.routed.filter((r) => r.tabId === 'tab-sm')).toEqual([expect.objectContaining({ kind: 'standing-order',
      text: `[purplemux standing order] proposal ${itemId} expired after 72 h: nothing filed` })]);
    expect(h.events('so-proposal-expired')).toHaveLength(1);
    expect((await readOrderFile(FLEET)).orders.some((o) => o.text === RULE)).toBe(false);
    expect(await runSoProposalPass(h.deps())).toEqual([]);
  });

  it('the SM\'s cancel of an unanswered proposal is a withdrawal: nothing filed, no line, one row', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    const item = store.attentionItem(itemId)!;
    await applyMissionEventBatch('ws-sm', [{ eventId: 'sm-withdraw', schemaVersion: 1, workspaceId: 'ws-sm', runId: 'run-sm', expectedRevision: item.revision,
      producerAt: 3, bindingGeneration: 1, type: 'attention.cancelled', payload: { itemId, reason: 'the owner said it in a note instead' } }], null);
    await vi.waitFor(() => expect(hook.settled).toEqual([itemId]));
    expect(await runSoProposalPass(h.deps())).toEqual([{ itemId, outcome: 'withdrawn' }]);
    expect(store.attentionItem(itemId)!.proposal).toEqual({ state: 'withdrawn', orderId: null, reason: 'the owner said it in a note instead' });
    expect(h.routed).toEqual([]);
    expect(h.events('so-proposal-withdrawn')).toHaveLength(1);
    // A new proposal of the same text may open once this one closed.
    h.now += 2_000;
    expect((await propose(h)).itemId).not.toBe(itemId);
  });
});

describe('rollback (test 14) and the admin path (test 11)', () => {
  it('SCHEMA_VERSION stays 4; a database holding mission_so_proposals reopens; a Yes stored with no step is filed by the pass', async () => {
    startRun();
    const h = new Harness();
    const { itemId } = await propose(h);
    answer(itemId, ['yes']);
    store.close();
    const raw = new Database(path.join(directory, 'mission.sqlite'));
    expect(raw.pragma('user_version', { simple: true })).toBe(4);
    expect(raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mission_so_proposals'`).get()).toBeTruthy();
    raw.close();
    store = new MissionControlStore(path.join(directory, 'mission.sqlite'));
    live.store = store;
    expect(store.soProposal(itemId)!.state).toBe('open');
    expect(await runSoProposalPass(h.deps())).toEqual([{ itemId, outcome: 'filed' }]);
  });

  it('a mission_so_proposals table from before reason_code gains the column, and its rows keep their state', () => {
    store.close();
    const file = path.join(directory, 'old.sqlite');
    const raw = new Database(file);
    raw.exec(`CREATE TABLE mission_so_proposals (item_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, proposer_tab_id TEXT NOT NULL,
      text TEXT NOT NULL, scope TEXT NOT NULL, check_name TEXT NOT NULL, cites TEXT, state TEXT NOT NULL, answer_id TEXT, order_id TEXT,
      reason TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
      INSERT INTO mission_so_proposals VALUES ('so-proposal-x','ws-sm','tab-sm','t','fleet','prose',NULL,'open',NULL,NULL,NULL,1,NULL);`);
    raw.close();
    store = new MissionControlStore(file);
    live.store = store;
    expect(store.soProposal('so-proposal-x')).toMatchObject({ state: 'open', reasonCode: null });
    expect(store.settleSoProposal('so-proposal-x', { state: 'not-filed', reason: 'r', reasonCode: 'so-invalid', decidedAt: 2 })).toBe(true);
    expect(store.soProposal('so-proposal-x')).toMatchObject({ state: 'not-filed', reason: 'r', reasonCode: 'so-invalid' });
  });

  it('the admin token still adds a fleet order with so add --fleet, and still cannot propose', async () => {
    const h = new Harness();
    expect((await addStandingOrder(h.deps().orders, ADMIN, FLEET, { text: 'admin rule', source: 'owner message y' })).owner).toBe(FLEET);
    expect(await errorOf(proposeStandingOrder(h.deps(), ADMIN, { text: 'x', why: 'y' }))).toMatchObject({ code: 'forbidden',
      message: expect.stringContaining('so add --fleet') });
  });
});
