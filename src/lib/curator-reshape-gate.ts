import { createHash } from 'crypto';
import { CURATOR_SHADOW_MS, isHeldOut } from '@/lib/curator';
import type { TCuratorOutcome } from '@/types/curator';

// The reshape gate (ADR-HFL-11 rule 3; story 23 consult C2). Pure: the evaluation's rows, the judge's verdicts and the
// live shadow replies of one served version H in, every unmet condition out with what it measured.

/** Replies the evaluation scores: the first 100 of the held-out ids in hash order. */
export const RESHAPE_TARGET = 100;
/** More non-replies than this before the 100th reply refuses the run (ADR-0038's 10% rule; consult C2 (i)). */
export const RESHAPE_MAX_NON_REPLIES = 10;
/** The judge's "same decision, same options" share the gate needs (ADR-HFL-11 rule 3). */
export const RESHAPE_JUDGE_MIN_SAME = 0.95;
export const RESHAPE_VERDICTS = ['same', 'different'] as const;
export type TReshapeJudgeVerdict = (typeof RESHAPE_VERDICTS)[number];

export interface IReshapeEvalRow {
  /** `<ws>/mc/<itemId>`. */
  id: string;
  outcome: TCuratorOutcome | 'unresolved' | 'unreshapable';
  /** reshaped, not-preserved or invalid; null with no reply. */
  label: string | null;
  /** sha256 of the reshaped draft the judge reads; null with no reply. */
  draftSha: string | null;
  /** The fields a refused reshape broke: names only, never values. */
  defects: string[];
  latencyMs: number | null;
}

export interface IReshapeEvalResult {
  task: 'reshape-question';
  runId: string;
  promptVersion: string;
  model: string;
  startedAt: number;
  finishedAt: number;
  target: number;
  /** Held-out ids in the set. */
  candidates: number;
  replied: number;
  /** Replies schema-valid at min-version 2 and preservation-clean (label `reshaped`). */
  clean: number;
  nonReplies: number;
  unresolved: number;
  unreshapable: number;
  labels: Record<string, number>;
  outcomes: Record<string, number>;
  latency: { p50: number | null; p90: number | null };
  refused: string | null;
  rows: IReshapeEvalRow[];
}

export interface IReshapeJudgeFile {
  runId: string;
  promptVersion: string;
  judge: string;
  importedAt: number;
  verdicts: Array<{ id: string; sha: string; verdict: TReshapeJudgeVerdict }>;
}

/** The evaluation's order: held-out ids only (never used for prompt work), by a hash of the id. */
export const reshapeEvalOrder = (ids: readonly string[]): string[] => {
  const key = (id: string) => createHash('sha256').update(`reshape\0${id}`).digest('hex');
  return ids.filter(isHeldOut).map((id) => ({ id, k: key(id) })).sort((a, b) => a.k.localeCompare(b.k)).map((x) => x.id);
};

export interface IReshapeGateInput {
  now: number;
  promptVersion: string;
  shadowSince: number | null;
  result: IReshapeEvalResult | null;
  judge: IReshapeJudgeFile | null;
  /** The labels of every live shadow reply of this version (outside the evaluation). */
  liveReplies: readonly string[];
}

export interface IReshapeGateVerdict {
  ok: boolean;
  refusals: string[];
  same: number | null;
  judged: number | null;
}

const hours = (ms: number): string => `${(ms / 3_600_000).toFixed(1)} h`;

/** Each unmet condition, with its measure: 72 h of H, clean live replies, a 100-reply run of H, and the judge's 95%. */
export const reshapeGateVerdict = (input: IReshapeGateInput): IReshapeGateVerdict => {
  const refusals: string[] = [];
  const version = input.promptVersion;
  if (input.shadowSince === null) refusals.push(`shadow has not started for ${version}: no live \`mc ask --fix\` call of this prompt yet`);
  else if (input.now - input.shadowSince < CURATOR_SHADOW_MS) {
    refusals.push(`shadow of ${version} ${hours(input.now - input.shadowSince)} of 72.0 h (since ${new Date(input.shadowSince).toISOString()})`);
  }
  const dirty = input.liveReplies.filter((label) => label !== 'reshaped').length;
  if (dirty) refusals.push(`live shadow replies of ${version}: ${dirty} of ${input.liveReplies.length} not schema-valid and preservation-clean, needs 0`);
  const result = input.result;
  let same: number | null = null;
  let judged: number | null = null;
  if (!result) refusals.push('no evaluation: run `purplemux curator eval --task reshape-question`');
  else if (result.promptVersion !== version) refusals.push(`evaluation is of prompt ${result.promptVersion}, the live prompt is ${version}: evaluate again`);
  else if (result.refused) refusals.push(`evaluation refused: ${result.refused}`);
  else {
    if (result.replied < result.target) refusals.push(`evaluation has ${result.replied} replies, needs ${result.target}`);
    if (result.clean < result.replied) refusals.push(`schema-valid and preservation-clean ${result.clean}/${result.replied}, needs ${result.replied}/${result.replied}`);
    const judge = input.judge;
    if (!judge) refusals.push('no judge verdicts: `purplemux curator reshape-pairs` to the judge, then `purplemux curator judge-import --file F`');
    else if (judge.runId !== result.runId) refusals.push(`judge verdicts are of run ${judge.runId}, the evaluation is run ${result.runId}`);
    else if (judge.promptVersion !== version) refusals.push(`judge verdicts are of prompt ${judge.promptVersion}, the live prompt is ${version}`);
    else {
      const byId = new Map(judge.verdicts.map((v) => [v.id, v]));
      const drafted = result.rows.filter((row) => row.draftSha !== null);
      const mismatched = drafted.filter((row) => byId.has(row.id) && byId.get(row.id)!.sha !== row.draftSha).length;
      same = drafted.filter((row) => byId.get(row.id)?.sha === row.draftSha && byId.get(row.id)?.verdict === 'same').length;
      // Every reply is judged; a failed reply (unparsable, error) has no draft and counts as different.
      judged = result.replied;
      if (mismatched) refusals.push(`judge verdicts name ${mismatched} draft${mismatched === 1 ? '' : 's'} by another sha256 than the run's`);
      const needed = Math.ceil(RESHAPE_JUDGE_MIN_SAME * judged);
      if (same < needed) refusals.push(`judge "same decision, same options" ${same}/${judged}, needs >= ${needed} (${RESHAPE_JUDGE_MIN_SAME * 100}%; a missing verdict counts as different)`);
    }
  }
  return { ok: refusals.length === 0, refusals, same, judged };
};

export type TJudgeImport = { ok: true; verdicts: IReshapeJudgeFile['verdicts'] } | { ok: false; error: string };

/** `curator judge-import`: one verdict per replied row of the run, each naming the draft's sha256. */
export const validateJudgeImport = (result: IReshapeEvalResult | null, runId: unknown, entries: unknown): TJudgeImport => {
  if (!result) return { ok: false, error: 'no reshape evaluation to judge: run `purplemux curator eval --task reshape-question`' };
  if (runId !== result.runId) return { ok: false, error: `runId ${JSON.stringify(runId)} is not the evaluation's run ${result.runId}` };
  if (!Array.isArray(entries)) return { ok: false, error: 'verdicts must be a JSON array of { "id", "sha", "verdict" }' };
  const rows = new Map(result.rows.filter((row) => row.draftSha !== null).map((row) => [row.id, row]));
  const seen = new Set<string>();
  const verdicts: IReshapeJudgeFile['verdicts'] = [];
  for (const [index, entry] of entries.entries()) {
    const { id, sha, verdict } = (entry ?? {}) as { id?: unknown; sha?: unknown; verdict?: unknown };
    if (typeof id !== 'string' || !rows.has(id)) return { ok: false, error: `verdicts[${index}].id ${JSON.stringify(id ?? null)} is not a replied row of run ${result.runId}` };
    if (seen.has(id)) return { ok: false, error: `verdicts[${index}].id ${id} appears twice` };
    if (sha !== rows.get(id)!.draftSha) return { ok: false, error: `verdicts[${index}].sha does not match the run's draft of ${id}` };
    if (typeof verdict !== 'string' || !(RESHAPE_VERDICTS as readonly string[]).includes(verdict)) {
      return { ok: false, error: `verdicts[${index}].verdict must be one of ${RESHAPE_VERDICTS.join(', ')}` };
    }
    seen.add(id);
    verdicts.push({ id, sha: sha as string, verdict: verdict as TReshapeJudgeVerdict });
  }
  return { ok: true, verdicts };
};
