import {
  CURATOR_GATES, CURATOR_MAX_UNRESOLVED_SHARE, CURATOR_SOURCE_HORIZON_MS, countRows, isHeldOut, percentile, scoreCounts,
} from '@/lib/curator';
import type { ICuratorJob } from '@/lib/curator-client';
import type { ILabelledItem, ILabelledSet } from '@/lib/curator-store';
import { COVERED, CURATOR_TASKS, NOT_COVERED, type ICuratorStandingOrderRef } from '@/lib/curator-tasks';
import type { ICuratorEvalResult, ICuratorEvalRow, ICuratorResult, TCuratorLabelTask } from '@/types/curator';

/** Evaluation calls are logged like live ones, under a workspace key no real workspace can take. */
export const CURATOR_EVAL_WORKSPACE = '_curator-eval';

export type TCuratorSplit = 'holdout' | 'train' | 'all';

export interface ICuratorEvalDeps {
  classify: (job: ICuratorJob) => Promise<ICuratorResult>;
  resolveText: (item: ILabelledItem) => Promise<string | null>;
  /** match-standing-order: the orders the set was labelled against. */
  orders: () => Promise<ICuratorStandingOrderRef[]>;
  now: () => number;
  model: string;
  /** The served version H when the run starts: the result's version when no call ran (a refused run). */
  promptVersion: string;
  /** Ids a labelled shadow row of this version holds (the shadow row counts instead) and ids the owner disputed. */
  exclude?: { shadow: ReadonlySet<string>; disputed: ReadonlySet<string> };
  spotCheck?: { itemId: string; answeredAt: number } | null;
  onProgress?: (done: number, total: number) => void;
}

export const scoreLabels = (task: TCuratorLabelTask): readonly string[] =>
  task === 'match-standing-order' ? [COVERED, NOT_COVERED] : CURATOR_TASKS[task].labels;

/** The class a gold label is scored in: an order id is `covered` for match-standing-order. */
const scoredClass = (task: TCuratorLabelTask, gold: string): string =>
  (task === 'match-standing-order' ? (gold === NOT_COVERED ? NOT_COVERED : COVERED) : gold);

export const inSplit = (split: TCuratorSplit, id: string): boolean =>
  split === 'all' || (split === 'holdout' ? isHeldOut(id) : !isHeldOut(id));

/**
 * Ruling 3.4 of consult 16-promote-gate: more than 10% of the split unresolved inside the source horizon, or more than
 * 10% of any gated class's gold, and the run does not score: its sample would be the readable part, not the set.
 */
const refusalOf = (task: TCuratorLabelTask, inHorizon: number, unresolved: number, goldByClass: Record<string, number>, unresolvedByClass: Record<string, number>): string | null => {
  const share = (a: number, b: number) => (b === 0 ? 0 : a / b);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const limit = pct(CURATOR_MAX_UNRESOLVED_SHARE);
  if (share(unresolved, inHorizon) > CURATOR_MAX_UNRESOLVED_SHARE) return `${unresolved} of ${inHorizon} unresolved (${pct(share(unresolved, inHorizon))}), limit ${limit}`;
  for (const gated of new Set(CURATOR_GATES[task].map((g) => g.label))) {
    const s = share(unresolvedByClass[gated] ?? 0, goldByClass[gated] ?? 0);
    if (s > CURATOR_MAX_UNRESOLVED_SHARE) return `${gated}: ${unresolvedByClass[gated]} of ${goldByClass[gated]} unresolved (${pct(s)}), limit ${limit}`;
  }
  return null;
};

/**
 * One evaluation (AC 5): the split's items through the client, one at a time, the same queue live calls use. Text is
 * read first (history, transcript twin, transcript, MC). An unreadable item older than 30 days has aged out and leaves
 * every denominator; above 10% unresolved the run refuses before any model call. The held-out run keeps counts only.
 */
export const runCuratorEval = async (task: TCuratorLabelTask, set: ILabelledSet, split: TCuratorSplit, deps: ICuratorEvalDeps): Promise<ICuratorEvalResult> => {
  const spec = CURATOR_TASKS[task];
  const startedAt = deps.now();
  const excluded = { shadow: 0, disputed: 0 };
  const selected = set.items.filter((item) => {
    if (!inSplit(split, item.id)) return false;
    if (deps.exclude?.shadow.has(item.id)) { excluded.shadow += 1; return false; }
    if (deps.exclude?.disputed.has(item.id)) { excluded.disputed += 1; return false; }
    return true;
  });
  const orders = task === 'match-standing-order' ? await deps.orders() : undefined;
  const texts: Array<{ item: ILabelledItem; text: string }> = [];
  let unresolved = 0;
  let agedOut = 0;
  const unresolvedByClass: Record<string, number> = {};
  const goldByClass: Record<string, number> = {};
  for (const item of selected) {
    const text = await deps.resolveText(item);
    const cls = scoredClass(task, item.label);
    if (text !== null) {
      texts.push({ item, text });
      goldByClass[cls] = (goldByClass[cls] ?? 0) + 1;
    } else if (item.at !== undefined && startedAt - item.at > CURATOR_SOURCE_HORIZON_MS) {
      agedOut += 1;
    } else {
      unresolved += 1;
      unresolvedByClass[cls] = (unresolvedByClass[cls] ?? 0) + 1;
      goldByClass[cls] = (goldByClass[cls] ?? 0) + 1;
    }
  }
  const refused = refusalOf(task, selected.length - agedOut, unresolved, goldByClass, unresolvedByClass);
  const rows: ICuratorEvalRow[] = [];
  const rulesRows: Array<{ gold: string; predicted: string }> = [];
  const versions = new Set<string>();
  if (!refused) {
    for (const [index, { item, text }] of texts.entries()) {
      const input = { text, ...(orders ? { orders } : {}) };
      const { record } = await deps.classify({ task, workspaceId: CURATOR_EVAL_WORKSPACE, tabId: 'eval', input });
      if (record.outcome !== 'dropped') versions.add(record.promptVersion);
      rows.push({ id: item.id, gold: item.label, predicted: record.label, outcome: record.outcome, latencyMs: record.latencyMs });
      rulesRows.push({ gold: item.label, predicted: spec.rules(input) });
      deps.onProgress?.(index + 1, texts.length);
    }
  }
  const outcomes: ICuratorEvalResult['outcomes'] = {};
  for (const row of rows) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
  if (unresolved) outcomes.unresolved = unresolved;
  const latencies = rows.flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs]));
  const labels = scoreLabels(task);
  const counts = countRows(task, labels, rows);
  // One run, one version: a re-pull or an order edit mid-run makes its rows evidence for two prompts (confirm R2).
  const mixed = versions.size > 1 ? `the served model or the order set changed during the run (${[...versions].join(', ')})` : null;
  return {
    task, promptVersion: versions.size === 1 ? [...versions][0] : deps.promptVersion, model: deps.model, split, startedAt, finishedAt: deps.now(),
    n: rows.length, counts, ...(split === 'holdout' ? {} : { rows }),
    unresolved, agedOut, unresolvedByClass, excluded, spotCheck: deps.spotCheck ?? null, refused: refused ?? mixed, outcomes,
    latency: { p50: percentile(latencies, 50), p90: percentile(latencies, 90) },
    score: scoreCounts(task, counts),
    rules: scoreCounts(task, countRows(task, labels, rulesRows)),
  };
};
