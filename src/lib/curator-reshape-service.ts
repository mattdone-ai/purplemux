import { randomUUID } from 'crypto';
import { CURATOR_CHARS_PER_TOKEN, CURATOR_MAX_INPUT_TOKENS, CURATOR_SOURCE_HORIZON_MS, percentile, type IPromoteVerdict } from '@/lib/curator';
import type { ICuratorJob } from '@/lib/curator-client';
import { CURATOR_EVAL_WORKSPACE } from '@/lib/curator-eval';
import { draftTooLong, liftDraft, structuralDefects, type TLiftedDraft, type TReshapeVerdict } from '@/lib/curator-reshape';
import {
  RESHAPE_MAX_NON_REPLIES, RESHAPE_TARGET, reshapeEvalOrder, reshapeGateVerdict, validateJudgeImport, type IReshapeEvalResult, type IReshapeEvalRow,
} from '@/lib/curator-reshape-gate';
import {
  CuratorRefusal, DIGEST_UNKNOWN, curatorEnabled, curatorRoutesIn, curatorRoutesOnVersion, getCuratorClient, isLive, liveVersionNow,
} from '@/lib/curator-service';
import { readCuratorState, readReshapeJudge, readReshapeResult, readReshapeSet, writeReshapeJudge, writeReshapeResult, type IReshapeSet } from '@/lib/curator-store';
import { CURATOR_MODEL } from '@/lib/curator-tasks';
import { createLogger } from '@/lib/logger';
import type { IMissionQuestionDefect } from '@/types/mission-control';
import type { ICuratorCallRecord, ICuratorEvalProgress, ICuratorResult } from '@/types/curator';

// The question reshape in the server (ADR-HFL-11 rule 3; story 23 AC 3-5, consult C2): `mc ask --fix`, the held-out
// evaluation, the judge's verdicts and the gate. Draft text never reaches a record: rows carry ids and sha256 only.

const log = createLogger('curator');
const TASK = 'reshape-question' as const;
/** `mc ask --fix` waits in the agent's turn: a reshape queued longer than this drops, and the agent fixes the draft. */
export const RESHAPE_ASK_MAX_WAIT_MS = 60_000;

interface IReshapeRun {
  progress: ICuratorEvalProgress;
  runId: string | null;
  /** The last run's drafts, by id, for the judge's stdout only: held in memory, never written. */
  drafts: Map<string, { original: unknown; reshaped: unknown }>;
}

const g = globalThis as unknown as { __ptCuratorReshapeRun?: IReshapeRun };

export type TReshapeAnswer =
  | { outcome: 'off'; reason: string }
  | { outcome: 'not-a-draft'; reason: string }
  | { outcome: 'not-reshapable'; defects: IMissionQuestionDefect[] }
  | { outcome: 'shadow'; reason: string }
  | { outcome: 'no-reply'; reason: string; promptVersion: string }
  | { outcome: 'refused'; label: 'not-preserved' | 'invalid'; defects: IMissionQuestionDefect[]; promptVersion: string }
  | { outcome: 'reshaped'; question: Record<string, unknown>; promptVersion: string };

const jobOf = (workspaceId: string, tabId: string, draft: TLiftedDraft, source: Record<string, unknown>, maxWaitMs?: number): ICuratorJob => ({
  task: TASK, workspaceId, tabId, sourceId: null, input: { text: JSON.stringify(source), draft, source }, ...(maxWaitMs ? { maxWaitMs } : {}),
});

const verdictOf = (result: ICuratorResult): TReshapeVerdict | null =>
  (result.record.outcome === 'labelled' && result.payload ? result.payload as TReshapeVerdict : null);

/** The outcomes that never reached a reply: reported, not scored. An unparsable reply or an error is a failed reply (review r1 F2). */
export const RESHAPE_NON_REPLIES: ReadonlySet<string> = new Set(['timeout', 'down', 'dropped']);

const tooLong = (source: unknown) => draftTooLong(source, CURATOR_MAX_INPUT_TOKENS, CURATOR_CHARS_PER_TOKEN);

export interface IReshapeAskDeps {
  enabled: () => Promise<boolean>;
  routesIn: (workspaceId: string) => Promise<boolean>;
  /** The task routes here on exactly this served version: the reply's, checked before it is returned (review r1 F6). */
  routesOnVersion: (workspaceId: string, version: string) => Promise<boolean>;
  classify: (job: ICuratorJob) => Promise<ICuratorResult>;
  /** Shadow calls run only in a started server (ADR-0038 §4). */
  live: () => boolean;
}

const askDeps = (): IReshapeAskDeps => ({
  enabled: curatorEnabled,
  routesIn: (workspaceId) => curatorRoutesIn(TASK, workspaceId),
  routesOnVersion: (workspaceId, version) => curatorRoutesOnVersion(TASK, workspaceId, version),
  classify: (job) => getCuratorClient().classify(job),
  live: isLive,
});

/**
 * `mc ask --fix` (AC 3, 5; consult C2 (iv)). Routing here: the curator reshapes in the agent's turn and the reply is
 * returned only when the preservation check and the format-2 validator pass. Anywhere else the answer is `shadow` at
 * once and the reshape runs in the background, logged (label, sha256), never returned or posted.
 */
export const reshapeForAsk = async (workspaceId: string, tabId: string, question: unknown, deps: IReshapeAskDeps = askDeps()): Promise<TReshapeAnswer> => {
  if (!(await deps.enabled())) return { outcome: 'off', reason: 'the curator is switched off (curator.enabled=off)' };
  const draft = liftDraft(question);
  if (!draft) return { outcome: 'not-a-draft', reason: 'not a v1 question or a formatVersion 2 draft with kind and answerType' };
  const fixed = structuralDefects(draft);
  if (fixed.length) return { outcome: 'not-reshapable', defects: fixed };
  const long = tooLong(question);
  if (long) return { outcome: 'not-reshapable', defects: [long] };
  const source = question as Record<string, unknown>;
  if (!(await deps.routesIn(workspaceId))) {
    if (deps.live()) void deps.classify(jobOf(workspaceId, tabId, draft, source)).catch((err: unknown) => log.warn(`curator: shadow reshape failed (${err instanceof Error ? err.message : String(err)})`));
    return { outcome: 'shadow', reason: 'the curator reshape is in shadow here: it was logged, not returned; fix the defects in the draft' };
  }
  const result = await deps.classify(jobOf(workspaceId, tabId, draft, source, RESHAPE_ASK_MAX_WAIT_MS));
  const promptVersion = result.record.promptVersion;
  const verdict = verdictOf(result);
  if (!verdict) return { outcome: 'no-reply', reason: `${result.record.outcome}${result.record.error ? `: ${result.record.error}` : ''}`, promptVersion };
  if (verdict.label !== 'reshaped') return { outcome: 'refused', label: verdict.label, defects: verdict.defects, promptVersion };
  // A reply from another version than the promoted one (a re-pull or a demote mid-call) is never returned.
  if (!(await deps.routesOnVersion(workspaceId, promptVersion))) {
    return { outcome: 'shadow', reason: `the reply came from ${promptVersion}, which does not route here: it was logged, not returned; fix the defects in the draft` };
  }
  return { outcome: 'reshaped', question: verdict.candidate, promptVersion };
};

// ── the evaluation (AC 4; consult C2 (i)-(ii)) ──

export interface IReshapeEvalDeps {
  classify: (job: ICuratorJob) => Promise<ICuratorResult>;
  /** The stored question JSON of `<ws>/mc/<itemId>`, or null when Mission Control no longer holds it. */
  question: (id: string) => unknown;
  now: () => number;
  model: string;
  promptVersion: string;
  runId: string;
  onProgress?: (done: number, total: number) => void;
}

/**
 * The first 100 replies over the held-out ids in hash order. A timeout, a down or a drop is a non-reply: reported, not
 * scored; more than 10 before the 100th reply refuses the run. Rows hold ids, labels, defect fields and sha256.
 */
export const runReshapeEval = async (set: IReshapeSet, deps: IReshapeEvalDeps): Promise<{ result: IReshapeEvalResult; drafts: IReshapeRun['drafts'] }> => {
  const startedAt = deps.now();
  const order = reshapeEvalOrder(set.items.map((item) => item.id));
  const rows: IReshapeEvalRow[] = [];
  const drafts: IReshapeRun['drafts'] = new Map();
  const versions = new Set<string>();
  let replied = 0;
  let nonReplies = 0;
  let refused: string | null = null;
  for (const id of order) {
    if (replied >= RESHAPE_TARGET) break;
    const source = deps.question(id);
    if (source === null) {
      rows.push({ id, outcome: 'unresolved', label: null, draftSha: null, defects: [], latencyMs: null });
      continue;
    }
    const draft = liftDraft(source);
    if (!draft || structuralDefects(draft).length || tooLong(source)) {
      rows.push({ id, outcome: 'unreshapable', label: null, draftSha: null, defects: [], latencyMs: null });
      continue;
    }
    const result = await deps.classify(jobOf(CURATOR_EVAL_WORKSPACE, 'eval', draft, source as Record<string, unknown>));
    if (result.record.outcome !== 'dropped') versions.add(result.record.promptVersion);
    const verdict = verdictOf(result);
    const nonReply = RESHAPE_NON_REPLIES.has(result.record.outcome);
    if (verdict) drafts.set(id, { original: source, reshaped: verdict.candidate });
    if (nonReply) nonReplies += 1;
    else replied += 1;
    rows.push({
      id, outcome: result.record.outcome, label: verdict?.label ?? null, draftSha: verdict ? result.record.draftSha ?? null : null,
      // A failed reply (unparsable, error) names its outcome as its defect: it counts against the 100%.
      defects: verdict ? verdict.defects.map((d) => d.field) : nonReply ? [] : [result.record.outcome], latencyMs: result.record.latencyMs,
    });
    deps.onProgress?.(replied, RESHAPE_TARGET);
    if (nonReplies > RESHAPE_MAX_NON_REPLIES && replied < RESHAPE_TARGET) {
      refused = `${nonReplies} non-replies before the ${RESHAPE_TARGET}th reply (limit ${RESHAPE_MAX_NON_REPLIES})`;
      break;
    }
  }
  if (!refused && versions.size > 1) refused = `the served model changed during the run (${[...versions].join(', ')})`;
  const count = (key: (row: IReshapeEvalRow) => string | null) => {
    const out: Record<string, number> = {};
    for (const row of rows) {
      const k = key(row);
      if (k !== null) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const latencies = rows.flatMap((row) => (row.latencyMs === null ? [] : [row.latencyMs]));
  return {
    drafts,
    result: {
      task: TASK, runId: deps.runId, promptVersion: versions.size === 1 ? [...versions][0] : deps.promptVersion, model: deps.model,
      startedAt, finishedAt: deps.now(), target: RESHAPE_TARGET, candidates: order.length, replied,
      clean: rows.filter((row) => row.label === 'reshaped').length, nonReplies,
      unresolved: rows.filter((row) => row.outcome === 'unresolved').length,
      unreshapable: rows.filter((row) => row.outcome === 'unreshapable').length,
      labels: count((row) => row.label), outcomes: count((row) => row.outcome),
      latency: { p50: percentile(latencies, 50), p90: percentile(latencies, 90) }, refused, rows,
    },
  };
};

const missionQuestion = async (id: string): Promise<unknown> => {
  const [ws, mc, itemId] = id.split('/');
  if (!ws || mc !== 'mc' || !itemId) return null;
  const { getMissionControlStore } = await import('@/lib/mission-control-store');
  const item = getMissionControlStore().itemQuestion(ws, itemId);
  if (!item) return null;
  try {
    return JSON.parse(item.questionJson) as unknown;
  } catch {
    return null;
  }
};

const runState = (): IReshapeRun | undefined => g.__ptCuratorReshapeRun;

export const startReshapeEval = async (): Promise<ICuratorEvalProgress> => {
  const running = runState();
  if (running?.progress.running) return running.progress;
  const set = await readReshapeSet();
  if (!set || !set.items.length) throw new Error('no reshape set in ~/.purplemux/curator/eval/ (scripts/curator/reshape-set.ts builds it)');
  const version = await liveVersionNow(TASK);
  if (version === null) throw new CuratorRefusal(DIGEST_UNKNOWN);
  const progress: ICuratorEvalProgress = { task: TASK, running: true, done: 0, total: RESHAPE_TARGET, startedAt: Date.now(), error: null };
  const run: IReshapeRun = { progress, runId: null, drafts: new Map() };
  g.__ptCuratorReshapeRun = run;
  const questions = new Map<string, unknown>();
  for (const { id } of set.items) questions.set(id, await missionQuestion(id));
  const runId = randomUUID();
  void runReshapeEval(set, {
    classify: (job) => getCuratorClient().classify(job),
    question: (id) => questions.get(id) ?? null,
    now: () => Date.now(), model: CURATOR_MODEL, promptVersion: version, runId,
    onProgress: (done) => { progress.done = done; },
  }).then(async ({ result, drafts }) => {
    await writeReshapeResult(result);
    run.runId = runId;
    run.drafts = drafts;
    progress.running = false;
  }).catch((err: unknown) => {
    progress.running = false;
    progress.error = err instanceof Error ? err.message : String(err);
    log.warn(`curator: reshape evaluation failed (${progress.error})`);
  });
  return progress;
};

export const readReshapeEval = async (): Promise<{ progress: ICuratorEvalProgress | null; result: IReshapeEvalResult | null }> =>
  ({ progress: runState()?.progress ?? null, result: await readReshapeResult() });

/** The judge's input on stdout (consult C2 (iii)): each replied row's original and reshaped draft, with its sha256. */
export const reshapePairs = async () => {
  const result = await readReshapeResult();
  if (!result) throw new CuratorRefusal('no reshape evaluation: run `purplemux curator eval --task reshape-question`');
  const run = runState();
  if (!run || run.runId !== result.runId) {
    throw new CuratorRefusal(`the drafts of run ${result.runId} are not held by this server (it restarted since): evaluate again`);
  }
  return {
    runId: result.runId, promptVersion: result.promptVersion,
    pairs: result.rows.filter((row) => row.draftSha !== null && run.drafts.has(row.id))
      .map((row) => ({ id: row.id, sha: row.draftSha!, ...run.drafts.get(row.id)! })),
  };
};

/** `curator judge-import` (admin): the only writer of the verdict file. */
export const importReshapeJudge = async (runId: unknown, verdicts: unknown, judge: unknown, now: number) => {
  const result = await readReshapeResult();
  const checked = validateJudgeImport(result, runId, verdicts);
  if (!checked.ok) throw new CuratorRefusal(checked.error);
  const name = typeof judge === 'string' && judge.trim() && judge.length <= 80 ? judge.trim() : 'claude-opus-5-5 at high';
  await writeReshapeJudge({ runId: result!.runId, promptVersion: result!.promptVersion, judge: name, importedAt: now, verdicts: checked.verdicts });
  const same = checked.verdicts.filter((v) => v.verdict === 'same').length;
  return { runId: result!.runId, imported: checked.verdicts.length, same };
};

const parseRecord = (text: string): Partial<ICuratorCallRecord> | null => {
  try {
    return JSON.parse(text) as Partial<ICuratorCallRecord>;
  } catch {
    return null;
  }
};

/**
 * The labels of the live shadow replies of a version, from call records: a timeout, a down or a drop never replied; an
 * unparsable reply or an error is a failed reply, named by its outcome, never left out (review r1 F2).
 */
export const liveReplyLabels = (texts: readonly string[], version: string): string[] => texts.flatMap((text) => {
  const r = parseRecord(text);
  if (!r || r.task !== TASK || r.promptVersion !== version || typeof r.outcome !== 'string' || RESHAPE_NON_REPLIES.has(r.outcome)) return [];
  return [r.outcome === 'labelled' && typeof r.label === 'string' ? r.label : r.outcome];
});

/** Every workspace but the evaluation's, over the source horizon. */
const liveReplies = async (version: string, now: number): Promise<string[]> => {
  const { getLedgerStore } = await import('@/lib/ledger-store');
  return liveReplyLabels(getLedgerStore().tabEvents.curatorCallsSince(now - CURATOR_SOURCE_HORIZON_MS, CURATOR_EVAL_WORKSPACE).map(({ text }) => text), version);
};

/** The reshape's promote verdict (consult C2): 72 h of H, clean live replies, a 100-reply run of H and the judge's 95%. */
export const reshapeGate = async (now: number): Promise<IPromoteVerdict> => {
  const version = await liveVersionNow(TASK);
  const key = version ?? 'unknown';
  const [state, result, judge, replies] = await Promise.all([
    readCuratorState(), readReshapeResult(), readReshapeJudge(), version ? liveReplies(version, now) : Promise.resolve([]),
  ]);
  const shadowSince = version === null ? null : state.tasks[TASK]?.shadowSince?.[version] ?? null;
  const gate = reshapeGateVerdict({ now, promptVersion: key, shadowSince, result, judge, liveReplies: replies });
  const refusals = version === null ? [DIGEST_UNKNOWN, ...gate.refusals] : gate.refusals;
  return { ok: version !== null && gate.ok, refusals, score: null, shadow: [] };
};
