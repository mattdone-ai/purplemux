import { describe, expect, it } from 'vitest';
import { CURATOR_SOURCE_HORIZON_MS, isHeldOut } from '@/lib/curator';
import type { ICuratorJob } from '@/lib/curator-client';
import { CURATOR_EVAL_WORKSPACE, runCuratorEval, type ICuratorEvalDeps } from '@/lib/curator-eval';
import type { ILabelledItem } from '@/lib/curator-store';
import type { ICuratorCallRecord, ICuratorResult } from '@/types/curator';

// AC 5 (amended): an evaluation over a split, through the client; durability per consult 16-promote-gate, ruling 3.

const NOW = Date.UTC(2026, 10, 10);
const DAY = 86_400_000;
const ids = Array.from({ length: 400 }, (_, i) => `ws-a/m${i}`);
const items: ILabelledItem[] = ids.map((id, i) => ({ id, label: i % 2 ? 'standing-order' : 'one-off', at: NOW - DAY }));
const set = { task: 'classify-owner-message' as const, labelledBy: 't', labelledAt: 't', items };
const held = items.filter((item) => isHeldOut(item.id));

const record = (label: string | null, outcome: ICuratorCallRecord['outcome'] = 'labelled'): ICuratorCallRecord => ({
  task: 'classify-owner-message', model: 'gemma4:26b', promptVersion: 'com-v1-x~d1', sourceId: null, modelDigest: 'd1', outcome, label, rulesLabel: 'one-off', span: null,
  spanFound: false, latencyMs: 1000, waitedMs: 0, cutTokens: 0, promptTokens: null, source: label ? 'curator' : 'rules',
});

const deps = (over: Partial<ICuratorEvalDeps> = {}): ICuratorEvalDeps & { jobs: ICuratorJob[] } => {
  const jobs: ICuratorJob[] = [];
  return {
    jobs,
    classify: async (job): Promise<ICuratorResult> => {
      jobs.push(job);
      const gold = items.find((i) => job.input.text === `text of ${i.id}`)?.label ?? 'one-off';
      return { record: record(gold), routed: gold };
    },
    resolveText: async (item) => `text of ${item.id}`,
    orders: async () => [],
    now: () => NOW,
    model: 'gemma4:26b',
    promptVersion: 'com-v1-x~d1',
    ...over,
  };
};

describe('runCuratorEval', () => {
  it('takes its version from its calls, and refuses a run whose calls span two served versions (confirm R2)', async () => {
    let n = 0;
    const two = await runCuratorEval('classify-owner-message', set, 'holdout', deps({
      classify: async () => {
        n += 1;
        return { record: { ...record('one-off'), promptVersion: n < 5 ? 'com-v1-x~d1' : 'com-v1-x~d2' }, routed: 'one-off' };
      },
    }));
    expect(two.refused).toBe('the served model or the order set changed during the run (com-v1-x~d1, com-v1-x~d2)');
    const one = await runCuratorEval('classify-owner-message', set, 'holdout', deps({ promptVersion: 'start' }));
    expect(one).toMatchObject({ promptVersion: 'com-v1-x~d1', refused: null });
    const none = await runCuratorEval('classify-owner-message', set, 'holdout', deps({ promptVersion: 'start', resolveText: async () => null }));
    expect(none.promptVersion).toBe('start');
  });

  it('the held-out run sends only held-out items under the evaluation workspace and keeps counts, no per-id rows (F7)', async () => {
    const d = deps();
    const result = await runCuratorEval('classify-owner-message', set, 'holdout', d);
    expect(d.jobs).toHaveLength(held.length);
    expect(d.jobs.every((j) => j.workspaceId === CURATOR_EVAL_WORKSPACE && j.tabId === 'eval' && isHeldOut(`ws-a/${j.input.text.split('/')[1]}`))).toBe(true);
    expect(result).not.toHaveProperty('rows');
    expect(result).toMatchObject({ split: 'holdout', n: held.length, refused: null, unresolved: 0, agedOut: 0 });
    expect(result.counts.find((c) => c.label === 'standing-order')).toMatchObject({ predicted: result.counts.find((c) => c.label === 'standing-order')!.support });
    expect(result.score.checks.find((c) => c.label === 'standing-order' && c.metric === 'precision')).toMatchObject({ measured: 1 });
    expect(result.rules.classes.find((c) => c.label === 'standing-order')).toMatchObject({ predicted: 0, precision: null });
  });

  it('the train split is the complement of the held-out one and keeps its rows', async () => {
    const d = deps();
    const result = await runCuratorEval('classify-owner-message', set, 'train', d);
    expect(result.n).toBe(items.length - held.length);
    expect(result.rows).toHaveLength(items.length - held.length);
    expect(result.rows!.some((r) => isHeldOut(r.id))).toBe(false);
  });

  it('leaves out ids with a labelled shadow row and ids the owner disputed, and records the spot check applied', async () => {
    const d = deps({ exclude: { shadow: new Set([held[0].id]), disputed: new Set([held[1].id]) }, spotCheck: { itemId: 'sc', answeredAt: 5 } });
    const result = await runCuratorEval('classify-owner-message', set, 'holdout', d);
    expect(result.excluded).toEqual({ shadow: 1, disputed: 1 });
    expect(result.n).toBe(held.length - 2);
    expect(result.spotCheck).toEqual({ itemId: 'sc', answeredAt: 5 });
  });

  it('refuses above 10% unresolved inside the horizon, before any model call', async () => {
    const gone = new Set(held.slice(0, Math.ceil(held.length * 0.11)).map((i) => i.id));
    const d = deps({ resolveText: async (item) => (gone.has(item.id) ? null : 'x') });
    const result = await runCuratorEval('classify-owner-message', set, 'holdout', d);
    expect(d.jobs).toHaveLength(0);
    expect(result.refused).toMatch(new RegExp(`^${gone.size} of ${held.length} unresolved \\(1\\d\\.\\d%\\), limit 10\\.0%$`));
  });

  it('refuses when a gated class is over 10% unresolved even if the whole split is not: 2 of 12', async () => {
    const small: ILabelledItem[] = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, label: 'standing-order', at: NOW })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, label: 'product-rule', at: NOW })),
      ...Array.from({ length: 60 }, (_, i) => ({ id: `o${i}`, label: 'one-off', at: NOW })),
    ];
    const d = deps({ resolveText: async (item) => (item.id === 's0' || item.id === 's1' ? null : 'x') });
    const result = await runCuratorEval('classify-owner-message', { ...set, items: small }, 'all', d);
    expect(result.refused).toBe('standing-order: 2 of 12 unresolved (16.7%), limit 10.0%');
  });

  it('an unresolved item older than 30 days has aged out: reported, outside every denominator', async () => {
    const old = held.slice(0, 30).map((i) => i.id);
    const aged = new Set(old);
    const agedSet = { ...set, items: items.map((i) => (aged.has(i.id) ? { ...i, at: NOW - CURATOR_SOURCE_HORIZON_MS - DAY } : i)) };
    const result = await runCuratorEval('classify-owner-message', agedSet, 'holdout', deps({ resolveText: async (item) => (aged.has(item.id) ? null : `text of ${item.id}`) }));
    expect(result).toMatchObject({ agedOut: 30, unresolved: 0, refused: null, n: held.length - 30 });
  });

  it('match-standing-order passes the orders, and an unresolved covered ask counts in the covered class', async () => {
    const orders = [{ id: 'SO-4', text: 'Reversible work needs no approval.' }];
    const matchSet = { task: 'match-standing-order' as const, labelledBy: 't', labelledAt: 't', items: [{ id: 'a', label: 'SO-4' }, { id: 'b', label: 'not-covered' }] };
    const seen: ICuratorJob[] = [];
    const result = await runCuratorEval('match-standing-order', matchSet, 'all', {
      ...deps(), orders: async () => orders,
      classify: async (job) => { seen.push(job); return { record: { ...record('SO-4'), task: 'match-standing-order' }, routed: 'SO-4' }; },
    });
    expect(seen[0].input.orders).toEqual(orders);
    expect(result.score.classes.map((c) => [c.label, c.precision])).toEqual([['covered', 0.5], ['not-covered', null]]);
    const refused = await runCuratorEval('match-standing-order', matchSet, 'all', { ...deps(), resolveText: async (item) => (item.id === 'a' ? null : 'x') });
    expect(refused.refused).toMatch(/^1 of 2 unresolved/);
  });
});
