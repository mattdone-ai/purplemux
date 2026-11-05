import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ORDER_CANDIDATES, candidateLine, parseCandidateMap, routeOwnerMessage, type ICuratorRouteRecord, type IOwnerRoutingDeps,
} from '@/lib/curator-routing';
import type { ICuratorCallRecord, ICuratorResult } from '@/types/curator';

// Story 23 AC 2 and AC 5 (consult C1): a label routes only when the classifier is routing on the version that made it
// and the workspace opts in; v2's workspace files no SO-n, its SM gets a candidate; records carry ids, never text.

const H = 'com-v1-6eec31d7~aaaaaaaa';
const AT = Date.parse('2026-11-03T04:05:06Z');
const TEXT = 'From now on answer status asks with the board URL';

const result = (label: string | null, over: Partial<ICuratorCallRecord> = {}): ICuratorResult => ({
  record: {
    task: 'classify-owner-message', model: 'gemma4:26b', promptVersion: H, sourceId: 'ws-a/m1', modelDigest: 'd', outcome: label ? 'labelled' : 'timeout',
    label, rulesLabel: 'standing-order', span: label ? 'From now on' : null, spanFound: true, latencyMs: 1, waitedMs: 0, cutTokens: 0, promptTokens: 1,
    source: label ? 'curator' : 'rules', ...over,
  },
  routed: label ?? 'standing-order',
});

const fake = (over: Partial<IOwnerRoutingDeps> = {}) => {
  const records: ICuratorRouteRecord[] = [];
  const deps: IOwnerRoutingDeps = {
    routingOn: vi.fn(async (v: string) => v === H),
    optedIn: vi.fn(async (ws: string) => ws === 'ws-a'),
    candidateTabName: vi.fn(async (ws: string) => parseCandidateMap(null).get(ws) ?? null),
    sendCandidate: vi.fn(async () => true),
    findActiveOrder: vi.fn(async () => null),
    fileOrder: vi.fn(async (): Promise<{ orderId: string; itemId: string } | { orderId: null; reason: string } | { orderId: string; itemId: null; reason: string }> =>
      ({ orderId: 'SO-12', itemId: 'curator-so-12' })),
    queueProductRule: vi.fn(async () => undefined),
    linkAnswer: vi.fn(async () => 'q-7'),
    record: (_ws, r) => { records.push(r); },
    ...over,
  };
  return { deps, records };
};

const msg = (workspaceId = 'ws-a', text = TEXT) => ({ workspaceId, entryId: 'm1', text, at: AT });

describe('routing an owner message (AC 2)', () => {
  it('standing-order: filed as SO-n with its keep-or-strike item, from the whole message on one line', async () => {
    const { deps, records } = fake();
    const out = await routeOwnerMessage(deps, msg('ws-a', `${TEXT}\n  please`), result('standing-order'));
    expect(out).toMatchObject({ action: 'filed-order', target: 'SO-12', reason: 'item curator-so-12' });
    expect(deps.fileOrder).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'm1' }), `${TEXT} please`, H);
    expect(records).toEqual([out]);
    expect(JSON.stringify(records)).not.toContain('board URL');
  });

  it('product-rule: queued with the message id; answer: a suggested link, never an answer; status-ping and one-off: counted', async () => {
    const { deps } = fake();
    expect(await routeOwnerMessage(deps, msg(), result('product-rule'))).toMatchObject({ action: 'spec-queued', target: 'spec-queue.md' });
    expect(deps.queueProductRule).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'm1' }), TEXT);
    expect(await routeOwnerMessage(deps, msg(), result('answer'))).toMatchObject({ action: 'answer-linked', target: 'q-7' });
    expect(deps.linkAnswer).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'm1' }), 'From now on');
    expect(await routeOwnerMessage(deps, msg(), result('status-ping'))).toMatchObject({ action: 'counted' });
    expect(await routeOwnerMessage(deps, msg(), result('one-off'))).toMatchObject({ action: 'counted' });
    expect(deps.fileOrder).not.toHaveBeenCalled();
  });

  it('an answer with no open item awaiting the owner links nothing; a withheld span is never stored', async () => {
    const { deps } = fake({ linkAnswer: vi.fn(async () => null) });
    expect(await routeOwnerMessage(deps, msg(), result('answer', { span: null, withheld: true }))).toMatchObject({ action: 'answer-unmatched' });
    expect(deps.linkAnswer).toHaveBeenCalledWith(expect.anything(), null);
  });

  it('a credential-shaped message or an order over 600 characters is not filed', async () => {
    const { deps } = fake();
    expect(await routeOwnerMessage(deps, msg('ws-a', 'from now on use token=ghp_abcdefghijklmnopqrstuvwxyz0123'), result('standing-order')))
      .toMatchObject({ action: 'not-filed', reason: 'credential-shaped text is never filed' });
    expect(await routeOwnerMessage(deps, msg('ws-a', `from now on ${'x'.repeat(700)}`), result('standing-order')))
      .toMatchObject({ action: 'not-filed', reason: '712 chars, an order holds at most 600' });
    expect(deps.fileOrder).not.toHaveBeenCalled();
  });

  it('a failing action is recorded as failed with its reason, never thrown at the caller', async () => {
    const { deps } = fake({ queueProductRule: vi.fn(async () => { throw new Error('disk full'); }) });
    expect(await routeOwnerMessage(deps, msg(), result('product-rule'))).toMatchObject({ action: 'failed', reason: 'disk full' });
  });
});

describe('the gate and the opt-in (AC 5)', () => {
  it('in shadow nothing routes and no routing row is written: the call record is the log', async () => {
    const { deps, records } = fake({ routingOn: vi.fn(async () => false) });
    expect(await routeOwnerMessage(deps, msg(), result('standing-order'))).toMatchObject({ action: 'logged', reason: 'shadow' });
    expect(records).toEqual([]);
    expect(deps.fileOrder).not.toHaveBeenCalled();
  });

  it('a label of another version than the promoted one does not route', async () => {
    const { deps } = fake();
    expect(await routeOwnerMessage(deps, msg(), result('standing-order', { promptVersion: 'com-v1-6eec31d7~bbbbbbbb' }))).toMatchObject({ action: 'logged' });
    expect(deps.fileOrder).not.toHaveBeenCalled();
  });

  it('the rules\' label (the curator down) never routes', async () => {
    const { deps, records } = fake();
    expect(await routeOwnerMessage(deps, msg(), result(null))).toMatchObject({ action: 'logged' });
    expect(records).toEqual([]);
    expect(deps.routingOn).not.toHaveBeenCalled();
  });

  it('a workspace that has not opted in logs only, with the reason', async () => {
    const { deps, records } = fake();
    expect(await routeOwnerMessage(deps, msg('ws-b'), result('product-rule'))).toMatchObject({ action: 'logged', reason: 'workspace not in curator.routing.workspaces' });
    expect(records).toHaveLength(1);
    expect(deps.queueProductRule).not.toHaveBeenCalled();
  });
});

describe('treasury-v2 (AC 5, consult C1)', () => {
  it('a standing-order label in ws-ldhziO goes to v2-scrum-master as a candidate once the task routes, without the opt-in, and files no SO-n', async () => {
    const { deps } = fake();
    const out = await routeOwnerMessage(deps, msg('ws-ldhziO'), result('standing-order'));
    expect(out).toMatchObject({ action: 'order-candidate', target: 'v2-scrum-master' });
    expect(deps.optedIn).not.toHaveBeenCalled();
    expect(deps.fileOrder).not.toHaveBeenCalled();
    const [sentFor, , line] = (deps.sendCandidate as ReturnType<typeof vi.fn>).mock.calls[0] as [{ entryId: string }, string, string];
    expect(sentFor.entryId).toBe('m1');
    expect(line).toContain('standing-order candidate for /v2-scope');
    expect(line).toContain('ws-ldhziO/m1');
    expect(line).toContain('"From now on"');
    expect(line).not.toContain('board URL');
  });

  it('even when ws-ldhziO opts in, a standing-order label is a candidate, never an SO-n', async () => {
    const { deps } = fake({ optedIn: vi.fn(async () => true) });
    expect(await routeOwnerMessage(deps, msg('ws-ldhziO'), result('standing-order'))).toMatchObject({ action: 'order-candidate' });
    expect(deps.fileOrder).not.toHaveBeenCalled();
  });

  it('in shadow no candidate is sent; with no live tab of that name it is candidate-undelivered and files nothing', async () => {
    const shadow = fake({ routingOn: vi.fn(async () => false) });
    await routeOwnerMessage(shadow.deps, msg('ws-ldhziO'), result('standing-order'));
    expect(shadow.deps.sendCandidate).not.toHaveBeenCalled();
    const gone = fake({ sendCandidate: vi.fn(async () => false) });
    expect(await routeOwnerMessage(gone.deps, msg('ws-ldhziO'), result('standing-order')))
      .toMatchObject({ action: 'candidate-undelivered', reason: 'no live tab named v2-scrum-master' });
    expect(gone.deps.fileOrder).not.toHaveBeenCalled();
  });

  it('every other label in ws-ldhziO stays log-only (it is not opted in)', async () => {
    const { deps } = fake();
    expect(await routeOwnerMessage(deps, msg('ws-ldhziO'), result('product-rule'))).toMatchObject({ action: 'logged' });
    expect(deps.queueProductRule).not.toHaveBeenCalled();
  });

  it('the candidate map: unset is the v2 default, none clears it, pairs parse', () => {
    expect(DEFAULT_ORDER_CANDIDATES).toBe('ws-ldhziO=v2-scrum-master');
    expect([...parseCandidateMap('none')]).toEqual([]);
    expect([...parseCandidateMap('ws-a=sm one, ws-b=other')]).toEqual([['ws-a', 'sm one'], ['ws-b', 'other']]);
    expect(candidateLine(msg('ws-ldhziO'), 'x', true)).toContain('withheld (credential-shaped)');
  });
});

describe('review r1 fixes (round 2)', () => {
  it('F3: a resend of a message already filed records "already filed SO-k" and files nothing; the fleet\'s orders count too', async () => {
    const filed: Array<{ id: string; owner: string; text: string }> = [{ id: 'SO-3', owner: 'fleet', text: 'Never push to main.' }];
    const { deps } = fake({
      findActiveOrder: vi.fn(async (ws: string, text: string) => {
        const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\s.!;,]+$/, '');
        return filed.find((o) => (o.owner === ws || o.owner === 'fleet') && norm(o.text) === norm(text))?.id ?? null;
      }),
      fileOrder: vi.fn(async (_m, text: string) => { filed.push({ id: 'SO-12', owner: 'ws-a', text }); return { orderId: 'SO-12', itemId: 'curator-so-12' }; }),
    });
    expect(await routeOwnerMessage(deps, msg(), result('standing-order'))).toMatchObject({ action: 'filed-order', target: 'SO-12' });
    const resent = await routeOwnerMessage(deps, { ...msg(), entryId: 'm2', text: `  ${TEXT.toUpperCase()}.  ` }, result('standing-order'));
    expect(resent).toMatchObject({ action: 'already-filed', target: 'SO-12', reason: 'already filed SO-12' });
    expect(await routeOwnerMessage(deps, msg('ws-a', 'never push to main'), result('standing-order'))).toMatchObject({ action: 'already-filed', target: 'SO-3' });
    expect(deps.fileOrder).toHaveBeenCalledTimes(1);
  });

  it('F4: when the keep-or-strike item cannot open, nothing is filed and the reason is recorded', async () => {
    const { deps, records } = fake({ fileOrder: vi.fn(async () => ({ orderId: null, reason: 'no keep-or-strike item could open: no orchestrator' })) });
    expect(await routeOwnerMessage(deps, msg(), result('standing-order')))
      .toMatchObject({ action: 'not-filed', target: null, reason: 'no keep-or-strike item could open: no orchestrator' });
    expect(records).toHaveLength(1);
  });

  it('F4 residue: an order filed with no item records filed-no-item and names the order', async () => {
    const { deps, records } = fake({ fileOrder: vi.fn(async () => ({ orderId: 'SO-9', itemId: null, reason: 'r' })) });
    expect(await routeOwnerMessage(deps, msg(), result('standing-order'))).toMatchObject({ action: 'filed-no-item', target: 'SO-9', reason: 'r' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ action: 'filed-no-item', target: 'SO-9', reason: 'r' });
  });
});
