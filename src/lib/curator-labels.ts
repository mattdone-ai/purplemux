import { createHash } from 'crypto';
import type { ILabelQueue } from '@/lib/curator-store';
import { CURATOR_TASKS, NOT_COVERED } from '@/lib/curator-tasks';
import type { TCuratorTask } from '@/types/curator';

// The blind label pass over shadow calls (consult 16-promote-gate, ruling 1). The queue keeps each call's
// prediction; what a labeller sees is ids only, in an order that says nothing about the prediction.

export interface IShadowCall {
  sourceId: string;
  promptVersion: string;
  predicted: string | null;
  outcome: string;
  at: number;
}

/** The class a precision-only task predicts into; classify-owner-message has none (every row is queued). */
const isPositive = (task: TCuratorTask, predicted: string | null): boolean => {
  if (predicted === null) return false;
  if (task === 'flag-owner-question') return predicted === 'question-to-owner';
  if (task === 'match-standing-order') return predicted !== NOT_COVERED;
  return false;
};

/** mulberry32 over a seed hashed from text: the negatives drawn and the order shown are reproducible. */
const rng = (seed: string): (() => number) => {
  let a = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const shuffle = <T>(items: readonly T[], seed: string): T[] => {
  const out = [...items];
  const next = rng(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/**
 * The calls a queue gains: shadow calls of the live version with a source id, not labelled, not already queued. For a
 * precision-only task: every predicted positive and as many predicted negatives, drawn with a seed; a call with no
 * model label is left out (it counts for no precision). For classify-owner-message: every call, misses included.
 */
export const queueAdditions = (
  task: TCuratorTask,
  promptVersion: string,
  calls: readonly IShadowCall[],
  known: ReadonlySet<string>,
): ILabelQueue['items'] => {
  const fresh = [...new Map(calls.filter((c) => c.promptVersion === promptVersion && !known.has(c.sourceId)).map((c) => [c.sourceId, c])).values()]
    .sort((a, b) => a.at - b.at || a.sourceId.localeCompare(b.sourceId));
  const item = (c: IShadowCall) => ({ id: c.sourceId, predicted: c.predicted, outcome: c.outcome, at: c.at });
  if (task === 'classify-owner-message') return fresh.map(item);
  const positives = fresh.filter((c) => isPositive(task, c.predicted));
  const negatives = fresh.filter((c) => c.predicted !== null && !isPositive(task, c.predicted));
  const drawn = shuffle(negatives, `${promptVersion}:${negatives.map((c) => c.sourceId).join(',')}`).slice(0, positives.length);
  return [...positives, ...drawn].map(item);
};

/** What `curator label-queue` shows: ids only, shuffled, with the queue's size and its oldest call. */
export const queueView = (queue: ILabelQueue) => ({
  task: queue.task,
  promptVersion: queue.promptVersion,
  size: queue.items.length,
  oldestAt: queue.items.length ? Math.min(...queue.items.map((i) => i.at)) : null,
  ids: shuffle(queue.items.map((i) => i.id), `${queue.promptVersion}:view:${queue.items.length}`),
});

export type TImportVerdict =
  | { ok: true; accepted: Array<{ id: string; label: string }>; excluded: string[] }
  | { ok: false; error: string };

/**
 * `curator label-import`: every id must be in the queue and every label one the task allows. match-standing-order also
 * takes `exclude` for an ask that is no permission ask; it leaves the queue and joins no set.
 */
export const validateImport = (task: TCuratorTask, queue: ILabelQueue | null, entries: unknown, orderIds: readonly string[]): TImportVerdict => {
  if (!queue) return { ok: false, error: `no label queue for ${task}: run \`purplemux curator label-queue --task ${task}\`` };
  if (!Array.isArray(entries) || !entries.length) return { ok: false, error: 'the file must hold a non-empty array of { id, label }' };
  const queued = new Set(queue.items.map((i) => i.id));
  const allowed = task === 'match-standing-order' ? [...orderIds, NOT_COVERED, 'exclude'] : [...CURATOR_TASKS[task].labels];
  const notQueued: string[] = [];
  const badLabel: string[] = [];
  const accepted: Array<{ id: string; label: string }> = [];
  const excluded: string[] = [];
  for (const entry of entries as Array<{ id?: unknown; label?: unknown }>) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const label = typeof entry?.label === 'string' ? entry.label : '';
    if (!queued.has(id)) notQueued.push(id || JSON.stringify(entry?.id ?? null));
    else if (!allowed.includes(label)) badLabel.push(`${id}=${JSON.stringify(entry?.label ?? null)}`);
    else if (label === 'exclude') excluded.push(id);
    else accepted.push({ id, label });
  }
  if (notQueued.length) return { ok: false, error: `ids not in the ${task} queue: ${notQueued.slice(0, 10).join(', ')}${notQueued.length > 10 ? ` (+${notQueued.length - 10})` : ''}` };
  if (badLabel.length) return { ok: false, error: `labels not allowed (${allowed.join(', ')}): ${badLabel.slice(0, 10).join(', ')}` };
  return { ok: true, accepted, excluded };
};
