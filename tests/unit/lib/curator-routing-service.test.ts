import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 23 AC 2 and ADR-HFL-06 "what proves it wrong": strike on a keep-or-strike item strikes the order the curator
// filed and counts as a correction; above 2% of a week's filings corrected, the classifier goes back to shadow.

const h = vi.hoisted(() => ({
  strike: vi.fn(async () => ({})),
  add: vi.fn(async () => ({ order: { id: 'SO-12' } })),
  files: {} as Record<string, { owner: string; orders: Array<{ id: string; text: string; source: string; state: string }> }>,
  apply: vi.fn(async () => ({})),
  orchestrator: 'tab-o' as string | null,
  runs: [{ runId: 'run-1', binding: { tabId: 'tab-o', generation: 2 } }] as unknown[],
  sent: new Set<string>(),
  marked: [] as string[],
  routed: [] as unknown[],
  live: [{ workspaceId: 'ws-ldhziO', tabId: 'tab-sm' }],
  demote: vi.fn(async () => true),
  appended: [] as Array<{ kind: string; text: string; workspaceId: string }>,
  routes: [] as string[],
}));
vi.mock('@/lib/standing-orders-store', () => ({
  FLEET: 'fleet',
  readOrderFile: vi.fn(async (owner: string) => h.files[owner] ?? { owner, orders: [] }),
}));
vi.mock('@/lib/curator-filed-order', async (original) => ({
  ...(await original<typeof import('@/lib/curator-filed-order')>()),
  filedOrderDeps: async () => ({ now: () => 1, orchestratorTabId: async () => h.orchestrator, openRuns: () => h.runs, apply: h.apply }),
}));
vi.mock('@/lib/curator-store', async (original) => ({
  ...(await original<typeof import('@/lib/curator-store')>()),
  candidateSent: vi.fn(async (key: string) => h.sent.has(key)),
  markCandidateSent: vi.fn(async (key: string) => { h.marked.push(key); h.sent.add(key); }),
}));
vi.mock('@/lib/status-manager', () => ({
  getStatusManager: () => ({ liveAgentTabs: () => h.live, routeTabEvent: vi.fn(async (e: unknown) => { h.routed.push(e); return { delivered: false }; }) }),
}));
vi.mock('@/lib/layout-store', () => ({
  readLayoutFile: vi.fn(async () => ({ root: {} })), resolveLayoutFile: (ws: string) => ws,
  collectAllTabs: () => [{ id: 'tab-sm', name: 'v2-scrum-master' }],
}));

vi.mock('@/lib/standing-orders-service', () => ({ strikeStandingOrder: h.strike, addStandingOrder: h.add }));
vi.mock('@/lib/standing-orders-http', () => ({ standingOrderDeps: () => ({}) }));
vi.mock('@/lib/curator-service', () => ({ demoteCuratorTask: h.demote, CURATOR_KEYS: { routingWorkspaces: 'curator.routing.workspaces' }, parseRoutingWorkspaces: () => [] }));
vi.mock('@/lib/ledger-store', () => ({
  getLedgerStore: () => ({ tabEvents: {
    append: (e: { kind: string; text: string; workspaceId: string }) => { h.appended.push(e); h.routes.push(e.text); return 1; },
    curatorRoutesSince: () => h.routes,
  } }),
}));

const filed = (n: number) => Array.from({ length: n }, () => JSON.stringify({ action: 'filed-order' }));

const ITEM_CONTEXT = '> x\n\nFrom your message at 2026-11-03 15:05 AEDT (`m1`). The curator labelled it a standing order (prompt `v`) and filed it as **SO-12**.';
const curatorOrder = (id: string, ws = 'ws-a', entry = 'm1') => ({ id, text: 't', state: 'active', source: `owner message ${ws}/${entry} (2026-11-03 UTC), filed by the curator` });

beforeEach(() => {
  h.files = { 'ws-a': { owner: 'ws-a', orders: [curatorOrder('SO-12'), curatorOrder('SO-3'), curatorOrder('SO-5')] } };
  h.add.mockClear();
  h.apply.mockReset();
  h.apply.mockResolvedValue({});
  h.orchestrator = 'tab-o';
  h.runs = [{ runId: 'run-1', binding: { tabId: 'tab-o', generation: 2 } }];
  h.sent.clear();
  h.marked.length = 0;
  h.routed.length = 0;
  h.strike.mockClear();
  h.demote.mockClear();
  h.appended.length = 0;
  h.routes.length = 0;
});

describe('the owner\'s answer on a filed order (AC 2)', () => {
  it('strike strikes the order as the server, records the correction, and demotes when over 2% of the week\'s filings are struck', async () => {
    const { curatorOnMissionAnswer } = await import('@/lib/curator-routing-service');
    h.routes.push(...filed(10));
    await curatorOnMissionAnswer({ id: 'curator-so-12', workspaceId: 'ws-a', context: ITEM_CONTEXT }, { optionIds: ['strike'], actor: 'owner@example' }, 1);
    expect(h.strike).toHaveBeenCalledWith({}, expect.objectContaining({ admin: true }), 'SO-12', 'struck by the owner from Mission Control item curator-so-12');
    expect(h.appended).toEqual([expect.objectContaining({ kind: 'curator-route', workspaceId: 'ws-a' })]);
    expect(JSON.parse(h.appended[0].text)).toMatchObject({ action: 'order-struck', target: 'SO-12' });
    expect(h.demote).toHaveBeenCalledWith('classify-owner-message');
  });

  it('one strike in 60 filings (1.7%) leaves the classifier routing', async () => {
    const { curatorOnMissionAnswer } = await import('@/lib/curator-routing-service');
    h.routes.push(...filed(60));
    await curatorOnMissionAnswer({ id: 'curator-so-3', workspaceId: 'ws-a', context: ITEM_CONTEXT }, { optionIds: ['strike'], actor: 'owner@example' }, 1);
    expect(h.strike).toHaveBeenCalled();
    expect(h.demote).not.toHaveBeenCalled();
  });

  it('keep, another item, or the auto-answer rule change nothing', async () => {
    const { curatorOnMissionAnswer } = await import('@/lib/curator-routing-service');
    await curatorOnMissionAnswer({ id: 'curator-so-12', workspaceId: 'ws-a', context: ITEM_CONTEXT }, { optionIds: ['keep'], actor: 'owner@example' }, 1);
    await curatorOnMissionAnswer({ id: 'nd-1234', workspaceId: 'ws-a', context: ITEM_CONTEXT }, { optionIds: ['strike'], actor: 'owner@example' }, 1);
    await curatorOnMissionAnswer({ id: 'curator-so-12', workspaceId: 'ws-a', context: ITEM_CONTEXT }, { optionIds: ['strike'], actor: 'system:auto-answer' }, 1);
    expect(h.strike).not.toHaveBeenCalled();
    expect(h.appended).toEqual([]);
  });

  it('an order already struck by hand is not counted again', async () => {
    const { curatorOnMissionAnswer } = await import('@/lib/curator-routing-service');
    h.strike.mockRejectedValueOnce(new Error('SO-12 is already struck'));
    await curatorOnMissionAnswer({ id: 'curator-so-12', workspaceId: 'ws-a', context: ITEM_CONTEXT }, { optionIds: ['strike'], actor: 'owner@example' }, 1);
    expect(h.appended).toEqual([]);
    expect(h.demote).not.toHaveBeenCalled();
  });

  it('correctionShare counts filings and strikes and skips rows it did not write', async () => {
    const { correctionShare } = await import('@/lib/curator-routing-service');
    expect(correctionShare([...filed(3), JSON.stringify({ action: 'order-struck' }), 'not json', JSON.stringify({ action: 'counted' })])).toEqual({ filed: 3, struck: 1 });
  });
});

describe('review r1 fixes (round 2)', () => {
  const msg = { workspaceId: 'ws-a', entryId: 'm9', text: 'From now on use AEDT', at: Date.parse('2026-11-03T04:00:00Z') };

  it('F1: a strike on an order of another workspace or the fleet, or one the curator did not file from this message, is refused', async () => {
    const { curatorOnMissionAnswer } = await import('@/lib/curator-routing-service');
    h.files = {
      'ws-a': { owner: 'ws-a', orders: [{ ...curatorOrder('SO-7'), source: 'owner message 2026-11-01, typed by hand' }, curatorOrder('SO-8', 'ws-a', 'm-other')] },
      fleet: { owner: 'fleet', orders: [curatorOrder('SO-5')] },
      'ws-b': { owner: 'ws-b', orders: [curatorOrder('SO-6', 'ws-b')] },
    };
    for (const id of ['curator-so-5', 'curator-so-6', 'curator-so-7', 'curator-so-8']) {
      await curatorOnMissionAnswer({ id, workspaceId: 'ws-a', context: ITEM_CONTEXT }, { optionIds: ['strike'], actor: 'owner@example' }, 1);
    }
    await curatorOnMissionAnswer({ id: 'curator-so-12', workspaceId: 'ws-a', context: 'no message named here' }, { optionIds: ['strike'], actor: 'owner@example' }, 1);
    expect(h.strike).not.toHaveBeenCalled();
    expect(h.appended.map((a) => JSON.parse(a.text).reason)).toEqual([
      'SO-5 is not an order of ws-a', 'SO-6 is not an order of ws-a',
      "SO-7's source is not the curator's filing of ws-a/m1", "SO-8's source is not the curator's filing of ws-a/m1",
      'the item names no owner message',
    ]);
    expect(h.appended.every((a) => JSON.parse(a.text).action === 'strike-refused')).toBe(true);
  });

  it('F1: the genuine path still strikes', async () => {
    const { curatorOnMissionAnswer } = await import('@/lib/curator-routing-service');
    await curatorOnMissionAnswer({ id: 'curator-so-12', workspaceId: 'ws-a', context: ITEM_CONTEXT }, { optionIds: ['strike'], actor: 'owner@example' }, 1);
    expect(h.strike).toHaveBeenCalledWith({}, expect.objectContaining({ admin: true }), 'SO-12', expect.any(String));
  });

  it('F4: no orchestrator or no bound run: nothing is filed; an item that still fails to open strikes the order again', async () => {
    const { ownerRoutingDeps } = await import('@/lib/curator-routing-service');
    h.orchestrator = null;
    expect(await ownerRoutingDeps().fileOrder(msg, 'From now on use AEDT', 'v')).toEqual({ orderId: null, reason: 'no keep-or-strike item could open: no orchestrator' });
    h.orchestrator = 'tab-o';
    h.runs = [];
    expect(await ownerRoutingDeps().fileOrder(msg, 'From now on use AEDT', 'v')).toMatchObject({ orderId: null });
    expect(h.add).not.toHaveBeenCalled();
    h.runs = [{ runId: 'run-1', binding: { tabId: 'tab-o', generation: 2 } }];
    h.apply.mockRejectedValueOnce(new Error('stale generation'));
    const failed = await ownerRoutingDeps().fileOrder(msg, 'From now on use AEDT', 'v');
    expect(failed).toEqual({ orderId: null, reason: 'SO-12 struck again: its keep-or-strike item did not open (stale generation)' });
    expect(h.strike).toHaveBeenCalledWith({}, expect.objectContaining({ admin: true }), 'SO-12', 'its keep-or-strike item did not open (stale generation)');
    expect(await ownerRoutingDeps().fileOrder(msg, 'From now on use AEDT', 'v')).toEqual({ orderId: 'SO-12', itemId: 'curator-so-12' });
    expect(h.add).toHaveBeenLastCalledWith({}, expect.objectContaining({ admin: true }), 'ws-a', expect.objectContaining({
      source: 'owner message ws-a/m9 (2026-11-03 UTC), filed by the curator',
    }));
  });

  it('F3: an active order of the workspace or the fleet with the same normalised text is found; a struck one is not', async () => {
    const { ownerRoutingDeps } = await import('@/lib/curator-routing-service');
    h.files = {
      'ws-a': { owner: 'ws-a', orders: [{ id: 'SO-2', text: 'Answer in AEDT.', source: 's', state: 'active' }, { id: 'SO-4', text: 'Old rule', source: 's', state: 'struck' }] },
      fleet: { owner: 'fleet', orders: [{ id: 'SO-1', text: 'Never push to main', source: 's', state: 'active' }] },
    };
    const find = ownerRoutingDeps().findActiveOrder;
    expect(await find('ws-a', '  answer in   AEDT ')).toBe('SO-2');
    expect(await find('ws-a', 'NEVER push to main.')).toBe('SO-1');
    expect(await find('ws-a', 'old rule')).toBeNull();
  });

  it('F8: a candidate is sent once per message id, recorded only after the send', async () => {
    const { ownerRoutingDeps } = await import('@/lib/curator-routing-service');
    const v2 = { workspaceId: 'ws-ldhziO', entryId: 'm1', text: 't', at: 1 };
    expect(await ownerRoutingDeps().sendCandidate(v2, 'v2-scrum-master', 'line')).toBe(true);
    expect(await ownerRoutingDeps().sendCandidate(v2, 'v2-scrum-master', 'line again')).toBe(true);
    expect(h.routed).toHaveLength(1);
    expect(h.marked).toEqual(['ws-ldhziO/m1']);
    h.live = [];
    expect(await ownerRoutingDeps().sendCandidate({ ...v2, entryId: 'm2' }, 'v2-scrum-master', 'line')).toBe(false);
    expect(h.marked).toEqual(['ws-ldhziO/m1']);
    h.live = [{ workspaceId: 'ws-ldhziO', tabId: 'tab-sm' }];
  });

  it('F4 residue: the item does not open and the strike fails: fileOrder names the active order and does not throw', async () => {
    const { ownerRoutingDeps } = await import('@/lib/curator-routing-service');
    h.apply.mockRejectedValueOnce(new Error('db locked'));
    h.strike.mockRejectedValueOnce(new Error('EIO'));
    expect(await ownerRoutingDeps().fileOrder(msg, 'From now on use AEDT', 'v')).toEqual({
      orderId: 'SO-12', itemId: null, reason: expect.stringContaining('SO-12 is active with no keep-or-strike item'),
    });
  });

  it('the compensating strike\'s reason is one line the order store accepts', async () => {
    const { ownerRoutingDeps } = await import('@/lib/curator-routing-service');
    const { checkStrikeReason } = await vi.importActual<typeof import('@/lib/standing-orders')>('@/lib/standing-orders');
    h.apply.mockRejectedValueOnce(new Error('first\nsecond'));
    await ownerRoutingDeps().fileOrder(msg, 'From now on use AEDT', 'v');
    expect(h.strike).toHaveBeenCalledWith({}, expect.objectContaining({ admin: true }), 'SO-12', 'its keep-or-strike item did not open (first second)');
    expect(() => checkStrikeReason('its keep-or-strike item did not open (first second)')).not.toThrow();
  });

  it('F8: a candidate whose de-dup write fails after the send is still reported as sent', async () => {
    const { ownerRoutingDeps } = await import('@/lib/curator-routing-service');
    vi.mocked((await import('@/lib/curator-store')).markCandidateSent).mockRejectedValueOnce(new Error('EACCES'));
    expect(await ownerRoutingDeps().sendCandidate({ workspaceId: 'ws-ldhziO', entryId: 'm7', text: 't', at: 1 }, 'v2-scrum-master', 'line')).toBe(true);
    expect(h.routed).toHaveLength(1);
  });
});
