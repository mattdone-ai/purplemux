import { createHash } from 'crypto';
import { COVERED, NOT_COVERED } from '@/lib/curator-tasks';

export { replySchema } from '@/lib/curator-tasks';
import type {
  ICuratorClassScore, ICuratorEvalResult, ICuratorEvalRow, ICuratorGateCheck, ICuratorScore, TCuratorLabelTask, TSpotCheckVerdict,
} from '@/types/curator';

// The curator's pure rules (ADR-0038): input bounds, the reply contract, the evaluation gate and promotion.

export { CURATOR_MODEL } from '@/lib/curator-tasks';
export const CURATOR_BASE_URL = 'http://127.0.0.1:11435';
export const CURATOR_TIMEOUT_MS = 30_000;
/** A queued call older than this drops to the rules (ADR-0038 §6). */
export const CURATOR_QUEUE_MAX_WAIT_MS = 10 * 60_000;
/** The model's context is 8,192 tokens; an input keeps its last 6,000 (ADR-0038 §2). */
export const CURATOR_MAX_INPUT_TOKENS = 6_000;
/**
 * Characters per token, set below the measured rate so the cut errs short: gemma4:26b counted 2,398 prompt
 * tokens for 8,000 characters of markdown (3.34) and 712 for 2,000 (2.81) through the tunnel, 2026-11-03.
 */
export const CURATOR_CHARS_PER_TOKEN = 2.75;
export const CURATOR_SHADOW_MS = 72 * 60 * 60_000;
export const CURATOR_HOLDOUT_SHARE = 0.3;
/** The kodit rule (ADR-0038 §7): a fall above this share rate-limits the client to one call per 10 s. */
export const KODIT_DROP_LIMIT = 0.2;
export const KODIT_RATE_LIMIT_MS = 10_000;
/** The owner's spot check fails above this share of wrong labels among those judged (consult ruling 6). */
export const SPOT_CHECK_MAX_WRONG = 0.1;
export const SPOT_CHECK_SIZE = 30;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CURATOR_CHARS_PER_TOKEN);

/** The last `maxTokens` of a text, cut at a line or word boundary where one is near; `cutTokens` says what went. */
export const cutToLastTokens = (text: string, maxTokens = CURATOR_MAX_INPUT_TOKENS): { text: string; cutTokens: number } => {
  const keep = Math.floor(maxTokens * CURATOR_CHARS_PER_TOKEN);
  if (text.length <= keep) return { text, cutTokens: 0 };
  let start = text.length - keep;
  const boundary = text.slice(start, start + 200).search(/\s/);
  if (boundary >= 0) start += boundary + 1;
  const kept = text.slice(start);
  return { text: kept, cutTokens: estimateTokens(text) - estimateTokens(kept) };
};

const squash = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();

export const spanOccurs = (span: string | null, input: string): boolean =>
  span !== null && span.trim() !== '' && squash(input).includes(squash(span));

export type TReplyParse = { ok: true; label: string; span: string | null } | { ok: false; error: string };

/** The model's JSON reply: a label it was offered, and a quoted span (optional, checked separately). */
export const parseCuratorReply = (content: string, labels: readonly string[]): TReplyParse => {
  let parsed: unknown;
  // An error names what was wrong, never the reply itself: it may quote the input (review r1 F2).
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: `reply is not JSON (${content.length} chars)` };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'reply is not an object' };
  const { label, span } = parsed as { label?: unknown; span?: unknown };
  if (typeof label !== 'string' || !labels.includes(label)) {
    return { ok: false, error: `label is ${typeof label === 'string' ? 'not one offered' : 'not a string'} (offered: ${labels.join(', ')})` };
  }
  return { ok: true, label, span: typeof span === 'string' && span.trim() ? span.slice(0, 240) : null };
};

/** 30% of every set is held out, by a hash of the id: stable across runs and machines, and the set file holds no split. */
export const isHeldOut = (id: string): boolean =>
  createHash('sha256').update(id).digest().readUInt32BE(0) / 0x1_0000_0000 < CURATOR_HOLDOUT_SHARE;

export interface IGateThreshold {
  label: string;
  metric: 'precision' | 'recall';
  threshold: number;
}

/** ADR-0038 §5. */
export const CURATOR_GATES: Readonly<Record<TCuratorLabelTask, readonly IGateThreshold[]>> = {
  'classify-owner-message': [
    { label: 'standing-order', metric: 'precision', threshold: 0.9 },
    { label: 'standing-order', metric: 'recall', threshold: 0.8 },
    { label: 'product-rule', metric: 'precision', threshold: 0.9 },
    { label: 'product-rule', metric: 'recall', threshold: 0.8 },
  ],
  'flag-owner-question': [{ label: 'question-to-owner', metric: 'precision', threshold: 0.95 }],
  'match-standing-order': [{ label: COVERED, metric: 'precision', threshold: 0.98 }],
};

/** One-sided confidence of every gate bound (ADR-0038 §5; consult 16-promote-gate). */
export const CURATOR_GATE_CONFIDENCE = 0.95;
const GATE_ALPHA = 1 - CURATOR_GATE_CONFIDENCE;
/** Labelled shadow rows of the promoted prompt version, per gated check (consult 16-promote-gate, ruling 2). */
export const CURATOR_SHADOW_MIN_ROWS = 30;
/** Claude Code's cleanupPeriodDays default and the tab_events retention: a source older than this may be gone. */
export const CURATOR_SOURCE_HORIZON_MS = 30 * 24 * 60 * 60_000;
export const CURATOR_MAX_UNRESOLVED_SHARE = 0.1;

const logFactorials: number[] = [0];
const logFactorial = (n: number): number => {
  for (let i = logFactorials.length; i <= n; i += 1) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  return logFactorials[n];
};

/** P(X >= x) for X ~ Binomial(n, p). */
const upperTail = (x: number, n: number, p: number): number => {
  let sum = 0;
  for (let k = x; k <= n; k += 1) {
    sum += Math.exp(logFactorial(n) - logFactorial(k) - logFactorial(n - k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
  }
  return sum;
};

/** Exact (Clopper-Pearson) one-sided lower bound: the p at which P(X >= x | n, p) = alpha. null: no trials. */
export const binomialLowerBound = (successes: number, trials: number, alpha = GATE_ALPHA): number | null => {
  if (trials === 0) return null;
  if (successes === 0) return 0;
  if (successes === trials) return alpha ** (1 / trials);
  let lo = 0;
  let hi = successes / trials;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (upperTail(successes, trials, mid) < alpha) lo = mid;
    else hi = mid;
  }
  return lo;
};

/** The fewest trials a run with no error needs: alpha^(1/n) >= threshold. */
export const minTrialsAtZeroErrors = (threshold: number, alpha = GATE_ALPHA): number =>
  Math.ceil(Math.log(alpha) / Math.log(threshold));

const isOrderId = (label: string | null): boolean => label !== null && label !== NOT_COVERED;

export interface ICuratorClassCount {
  label: string;
  support: number;
  predicted: number;
  truePositives: number;
}

/**
 * Counts per class. A row with no model label (timeout, error) predicts nothing: it lowers recall and never
 * precision. For match-standing-order the classes are covered / not-covered, and a covered prediction is a true
 * positive only when it names the gold order.
 */
export const countRows = (task: TCuratorLabelTask, labels: readonly string[], rows: readonly Pick<ICuratorEvalRow, 'gold' | 'predicted'>[]): ICuratorClassCount[] =>
  labels.map((label) => {
    let support = 0;
    let predicted = 0;
    let truePositives = 0;
    for (const row of rows) {
      if (task === 'match-standing-order') {
        const goldIn = label === COVERED ? isOrderId(row.gold) : row.gold === NOT_COVERED;
        const predIn = label === COVERED ? isOrderId(row.predicted) : row.predicted === NOT_COVERED;
        if (goldIn) support += 1;
        if (predIn) predicted += 1;
        if (goldIn && predIn && (label === NOT_COVERED || row.gold === row.predicted)) truePositives += 1;
      } else {
        if (row.gold === label) support += 1;
        if (row.predicted === label) predicted += 1;
        if (row.gold === label && row.predicted === label) truePositives += 1;
      }
    }
    return { label, support, predicted, truePositives };
  });

/** Two count tables of one task added class by class: the gate's pool of held-out and shadow evidence. */
export const addCounts = (a: readonly ICuratorClassCount[], b: readonly ICuratorClassCount[]): ICuratorClassCount[] =>
  a.map((c) => {
    const o = b.find((x) => x.label === c.label);
    return o ? { label: c.label, support: c.support + o.support, predicted: c.predicted + o.predicted, truePositives: c.truePositives + o.truePositives } : c;
  });

/** Each check passes only when its 95% lower bound reaches the threshold (consult 16-promote-gate, ruling 1). */
export const scoreCounts = (task: TCuratorLabelTask, counts: readonly ICuratorClassCount[]): ICuratorScore => {
  const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);
  const classes: ICuratorClassScore[] = counts.map((c) => ({ ...c, precision: ratio(c.truePositives, c.predicted), recall: ratio(c.truePositives, c.support) }));
  const checks: ICuratorGateCheck[] = CURATOR_GATES[task].map((gate) => {
    const c = classes.find((x) => x.label === gate.label);
    const successes = c?.truePositives ?? 0;
    const trials = gate.metric === 'precision' ? c?.predicted ?? 0 : c?.support ?? 0;
    const lowerBound = binomialLowerBound(successes, trials);
    return {
      ...gate, measured: c?.[gate.metric] ?? null, successes, trials, lowerBound, minTrials: minTrialsAtZeroErrors(gate.threshold),
      pass: lowerBound !== null && lowerBound >= gate.threshold,
    };
  });
  return { classes, checks, pass: checks.every((check) => check.pass) };
};

export const scoreRows = (task: TCuratorLabelTask, labels: readonly string[], rows: readonly Pick<ICuratorEvalRow, 'gold' | 'predicted'>[]): ICuratorScore =>
  scoreCounts(task, countRows(task, labels, rows));

export const percentile = (values: readonly number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** A labelled shadow row: one live call of the version, its prediction and the gold the blind pass gave it. */
export interface ICuratorShadowRow {
  id: string;
  gold: string;
  predicted: string | null;
}

export interface IPromoteInput {
  task: TCuratorLabelTask;
  now: number;
  promptVersion: string;
  labels: readonly string[];
  /** The first shadow call of THIS prompt version outside the evaluation; null: none yet. */
  shadowSince: number | null;
  result: ICuratorEvalResult | null;
  /** The labelled shadow rows of this prompt version. */
  shadowRows: readonly ICuratorShadowRow[];
  /** classify-owner-message and match-standing-order: the owner's spot check; undefined for flag-owner-question. */
  spotCheck?: TSpotCheckVerdict | null;
  /** classify-owner-message: the evaluation ran after the spot-check answer, with the disputed ids left out. */
  spotCheckApplied?: boolean;
}

export interface IShadowCheck {
  label: string;
  metric: 'precision' | 'recall';
  threshold: number;
  successes: number;
  trials: number;
  pass: boolean;
}

export interface IPromoteVerdict {
  ok: boolean;
  /** One line per unmet condition, each with what was measured and what was expected. */
  refusals: string[];
  /** The pool: held-out counts plus the labelled shadow rows. null when no usable evaluation exists. */
  score: ICuratorScore | null;
  shadow: IShadowCheck[];
}

const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)} h`;
const fixed = (value: number | null): string => (value === null ? 'not measured' : value.toFixed(3));

/** A bound is printed rounded DOWN to 4 decimals, so a bound just under its threshold never reads as reaching it (review r2 F5). */
export const boundText = (value: number | null): string => (value === null ? 'not measured' : (Math.floor(value * 1e4) / 1e4).toFixed(4));

export const checkRefusal = (check: ICuratorGateCheck): string =>
  `${check.label} ${check.metric} ${check.successes}/${check.trials} = ${fixed(check.measured)}; 95% lower bound ${boundText(check.lowerBound)}, `
  + `needs >= ${check.threshold.toFixed(2)} (0 errors needs >= ${check.minTrials})`;

const dedupeById = (rows: readonly ICuratorShadowRow[]): ICuratorShadowRow[] => [...new Map(rows.map((row) => [row.id, row])).values()];

/**
 * `curator promote` (AC 5, amended by consult 16-promote-gate): every check's 95% lower bound over the held-out and
 * labelled shadow rows of the live prompt version; 72 h since that version's first shadow call; 30 labelled shadow rows
 * per check at or above the threshold; a usable evaluation; and the owner's spot check where the task has one.
 */
export const promoteVerdict = (input: IPromoteInput): IPromoteVerdict => {
  const refusals: string[] = [];
  const version = input.promptVersion;
  if (input.shadowSince === null) refusals.push(`shadow has not started for ${version}: no live call of this prompt yet`);
  else if (input.now - input.shadowSince < CURATOR_SHADOW_MS) {
    refusals.push(`shadow of ${version} ${hours(input.now - input.shadowSince)} of 72.0 h (since ${new Date(input.shadowSince).toISOString()})`);
  }
  let shadowRows = dedupeById(input.shadowRows);
  if (input.task !== 'flag-owner-question') {
    const spot = input.spotCheck ?? { state: 'unanswered' };
    if (spot.state === 'unanswered') refusals.push(`spot-check unanswered: the owner checks the labels first (\`purplemux curator spot-check open --task ${input.task}\`)`);
    else if (spot.state === 'unreadable') refusals.push(`spot-check answer unreadable: ${spot.reason}`);
    else {
      if (spot.wrongShare > SPOT_CHECK_MAX_WRONG) {
        refusals.push(`gold set failed spot-check: ${spot.disputed.length} of ${spot.judged} wrong (limit ${SPOT_CHECK_MAX_WRONG * 100}%)`);
      }
      const disputed = new Set(spot.disputed);
      if (input.task === 'classify-owner-message') {
        // Gold the owner marked wrong leaves the set until it is labelled again (consult of 2026-11-03, ruling 6).
        shadowRows = shadowRows.filter((row) => !disputed.has(row.id));
        if (disputed.size && !input.spotCheckApplied) refusals.push('evaluation predates the spot-check answer: evaluate again so the disputed ids are left out');
      } else {
        // A covered match the owner marks wrong is a false positive: the curator agreed with a wrong gold (ruling 1).
        shadowRows = shadowRows.map((row) => (disputed.has(row.id) ? { ...row, gold: NOT_COVERED } : row));
      }
    }
  }
  const shadowCounts = countRows(input.task, input.labels, shadowRows);
  const shadowScore = scoreCounts(input.task, shadowCounts);
  const shadow: IShadowCheck[] = shadowScore.checks.map((c) => ({
    label: c.label, metric: c.metric, threshold: c.threshold, successes: c.successes, trials: c.trials,
    pass: c.trials >= CURATOR_SHADOW_MIN_ROWS && c.measured !== null && c.measured >= c.threshold,
  }));
  for (const c of shadow.filter((x) => !x.pass)) {
    refusals.push(`shadow evidence for ${version}: ${c.label} ${c.metric} ${c.successes}/${c.trials}, needs n >= ${CURATOR_SHADOW_MIN_ROWS} and >= ${c.threshold.toFixed(2)}`);
  }
  let score: ICuratorScore | null = null;
  const result = input.result;
  if (!result) refusals.push(`no evaluation: run \`purplemux curator eval --task ${input.task}\``);
  else if (result.promptVersion !== version) refusals.push(`evaluation is of prompt ${result.promptVersion}, the live prompt is ${version}: evaluate again`);
  else if (result.split !== 'holdout') refusals.push('evaluation ran outside the held-out 30%: the gate reads the held-out split');
  else if (result.refused) refusals.push(`evaluation refused: ${result.refused}`);
  else {
    score = scoreCounts(input.task, addCounts(result.counts, shadowCounts));
    for (const check of score.checks.filter((c) => !c.pass)) refusals.push(checkRefusal(check));
  }
  return { ok: refusals.length === 0, refusals, score, shadow };
};
