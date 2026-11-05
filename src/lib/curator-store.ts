import { randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { isHeldOut } from '@/lib/curator';
import { isCuratorTask } from '@/lib/curator-tasks';
import type { IReshapeEvalResult, IReshapeJudgeFile } from '@/lib/curator-reshape-gate';
import type { ICuratorEvalResult, ICuratorState, ISpotCheckFile, TCuratorLabelTask, TCuratorTask } from '@/types/curator';

// `~/.purplemux/curator/` (ADR-0038): the task states, the labelled sets (ids and labels only, AC 4), the
// latest evaluation per task and the spot check's number map. No file here holds message text.

export const curatorDir = (): string => path.join(os.homedir(), '.purplemux', 'curator');
export const evalDir = (): string => path.join(curatorDir(), 'eval');
const stateFile = (): string => path.join(curatorDir(), 'state.json');
export const labelledSetFile = (task: TCuratorLabelTask): string => path.join(evalDir(), `${task}.json`);
/** The held-out run's counts at `<task>.json`; a train or whole-set run, with its per-id rows, beside it (review r1 F7). */
export const resultFile = (task: TCuratorLabelTask, split: ICuratorEvalResult['split'] = 'holdout'): string =>
  path.join(evalDir(), 'results', split === 'holdout' ? `${task}.json` : `${task}.${split}.json`);
const spotCheckFile = (task: TCuratorLabelTask): string => path.join(evalDir(), `spot-check.${task}.json`);
const shadowFile = (task: TCuratorLabelTask): string => path.join(evalDir(), `${task}.shadow.json`);
const queueFile = (task: TCuratorLabelTask): string => path.join(evalDir(), `${task}.queue.json`);

/** Where an owner message occurs in a transcript: offsets into the raw or whitespace-collapsed user text, and a hash. */
export interface ITwinLocator {
  ref: string;
  start: number;
  length: number;
  mode: 'raw' | 'collapsed';
  /** sha256 (16 hex) of the message in that mode: a hash, never the text (AC 4). */
  sha: string;
}

export interface ILabelledItem {
  id: string;
  label: string;
  /** When the source text was written (history sentAt, transcript timestamp, MC created_at), Unix ms. */
  at?: number;
  alt?: ITwinLocator;
}

/** The fields a labelled item may carry; anything else is dropped before a write (AC 4). */
export const labelledItemOf = ({ id, label, at, alt }: ILabelledItem): ILabelledItem => ({
  id, label,
  ...(typeof at === 'number' ? { at } : {}),
  ...(alt ? { alt: { ref: alt.ref, start: alt.start, length: alt.length, mode: alt.mode, sha: alt.sha } } : {}),
});

export interface ILabelledSet {
  task: TCuratorLabelTask;
  labelledBy: string;
  labelledAt: string;
  items: ILabelledItem[];
}

const EMPTY_STATE: ICuratorState = { version: 1, liveSince: null, tasks: {}, kodit: null, rateLimitMs: 0 };

const g = globalThis as unknown as { __ptCuratorStateLock?: Promise<unknown> };

const readJson = async <T>(file: string): Promise<T | null> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

const writeJson = async (file: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
};

export const readCuratorState = async (): Promise<ICuratorState> => {
  const raw = await readJson<Partial<ICuratorState>>(stateFile());
  if (!raw || raw.version !== 1) return { ...EMPTY_STATE, tasks: {} };
  return {
    version: 1,
    liveSince: typeof raw.liveSince === 'number' ? raw.liveSince : null,
    tasks: Object.fromEntries(Object.entries(raw.tasks ?? {}).filter(([task]) => isCuratorTask(task))),
    kodit: raw.kodit ?? null,
    rateLimitMs: typeof raw.rateLimitMs === 'number' && raw.rateLimitMs > 0 ? raw.rateLimitMs : 0,
  };
};

/** Read, change, write: serialised on one chain shared by the server and the API routes (CLAUDE.md §18). */
export const updateCuratorState = <T>(change: (state: ICuratorState) => T): Promise<T> => {
  const run = async (): Promise<T> => {
    const state = await readCuratorState();
    const result = change(state);
    await writeJson(stateFile(), state);
    return result;
  };
  const next = (g.__ptCuratorStateLock ?? Promise.resolve()).then(run, run);
  g.__ptCuratorStateLock = next.catch(() => undefined);
  return next;
};

/** The shadow clock starts at the first start of a server that carries the client, and never moves. */
export const ensureLiveSince = (now: number): Promise<number> =>
  updateCuratorState((state) => {
    if (state.liveSince === null) state.liveSince = now;
    return state.liveSince;
  });

/** A prompt version's 72 h clock starts at its first live call and never moves (consult 16-promote-gate, ruling 2). */
export const ensureShadowSince = (task: TCuratorTask, promptVersion: string, at: number): Promise<number> =>
  updateCuratorState((state) => {
    const entry = state.tasks[task] ?? { state: 'shadow', promotedAt: null, promotedPromptVersion: null };
    entry.shadowSince = { ...entry.shadowSince };
    if (entry.shadowSince[promptVersion] === undefined) entry.shadowSince[promptVersion] = at;
    state.tasks[task] = entry;
    return entry.shadowSince[promptVersion];
  });

export const readLabelledSet = async (task: TCuratorLabelTask): Promise<ILabelledSet | null> => {
  const raw = await readJson<ILabelledSet>(labelledSetFile(task));
  if (!raw) return null;
  return { ...raw, items: (raw.items ?? []).map(labelledItemOf) };
};

/** Ids, labels, source times and twin locators only (AC 4): any other field an item carries is dropped before the write. */
export const writeLabelledSet = (set: ILabelledSet): Promise<void> =>
  writeJson(labelledSetFile(set.task), {
    task: set.task, labelledBy: set.labelledBy, labelledAt: set.labelledAt, items: set.items.map(labelledItemOf),
  });

export const readEvalResult = (task: TCuratorLabelTask, split: ICuratorEvalResult['split'] = 'holdout'): Promise<ICuratorEvalResult | null> =>
  readJson<ICuratorEvalResult>(resultFile(task, split));

/**
 * No per-id prediction of a held-out id ever reaches disk (review r1 F7, confirm R1): the held-out run keeps counts
 * only, and a whole-set run keeps the rows of the training ids only. Its counts still cover every item it scored.
 */
export const writeEvalResult = (result: ICuratorEvalResult): Promise<void> => {
  const { rows, ...rest } = result;
  if (result.split === 'holdout') return writeJson(resultFile(result.task, result.split), rest);
  return writeJson(resultFile(result.task, result.split), { ...rest, rows: (rows ?? []).filter((row) => !isHeldOut(row.id)) });
};

export const readSpotCheckFile = (task: TCuratorLabelTask): Promise<ISpotCheckFile | null> => readJson<ISpotCheckFile>(spotCheckFile(task));

export const writeSpotCheckFile = (file: ISpotCheckFile): Promise<void> => writeJson(spotCheckFile(file.task), file);

/** One labelled shadow row's prediction (consult 16-promote-gate): ids and labels only; its gold is in the labelled set. */
export interface IShadowEvidence {
  id: string;
  promptVersion: string;
  predicted: string | null;
  outcome: string;
  at: number;
}

export const readShadowEvidence = async (task: TCuratorLabelTask): Promise<IShadowEvidence[]> =>
  (await readJson<{ rows?: IShadowEvidence[] }>(shadowFile(task)))?.rows ?? [];

export const appendShadowEvidence = async (task: TCuratorLabelTask, rows: readonly IShadowEvidence[]): Promise<void> => {
  const known = await readShadowEvidence(task);
  const seen = new Set(known.map((r) => `${r.promptVersion}\0${r.id}`));
  const fresh = rows.filter((r) => !seen.has(`${r.promptVersion}\0${r.id}`))
    .map(({ id, promptVersion, predicted, outcome, at }) => ({ id, promptVersion, predicted, outcome, at }));
  await writeJson(shadowFile(task), { rows: [...known, ...fresh] });
};

/** The blind label queue: the shadow calls a label pass may label, with the prediction kept here and never shown. */
export interface ILabelQueue {
  task: TCuratorLabelTask;
  promptVersion: string;
  items: Array<{ id: string; predicted: string | null; outcome: string; at: number }>;
  /** Ids a pass labelled `exclude` (no permission ask): ids only, kept known so they never return. */
  excluded?: string[];
}

export const readLabelQueue = (task: TCuratorLabelTask): Promise<ILabelQueue | null> => readJson<ILabelQueue>(queueFile(task));

export const writeLabelQueue = (queue: ILabelQueue): Promise<void> => writeJson(queueFile(queue.task), queue);

/** The reshape set (story 23 AC 4): historical Mission Control item ids, `<ws>/mc/<itemId>`, never their text. */
export interface IReshapeSet {
  task: 'reshape-question';
  builtBy: string;
  builtAt: string;
  items: Array<{ id: string; at?: number }>;
}

const reshapeSetFile = (): string => path.join(evalDir(), 'reshape-question.json');
const reshapeResultFile = (): string => path.join(evalDir(), 'results', 'reshape-question.json');
const reshapeJudgeFile = (): string => path.join(evalDir(), 'results', 'reshape-question.judge.json');

export const readReshapeSet = (): Promise<IReshapeSet | null> => readJson<IReshapeSet>(reshapeSetFile());
export const writeReshapeSet = (set: IReshapeSet): Promise<void> =>
  writeJson(reshapeSetFile(), { ...set, items: set.items.map(({ id, at }) => ({ id, ...(typeof at === 'number' ? { at } : {}) })) });
export const readReshapeResult = (): Promise<IReshapeEvalResult | null> => readJson<IReshapeEvalResult>(reshapeResultFile());
export const writeReshapeResult = (result: IReshapeEvalResult): Promise<void> => writeJson(reshapeResultFile(), result);
export const readReshapeJudge = (): Promise<IReshapeJudgeFile | null> => readJson<IReshapeJudgeFile>(reshapeJudgeFile());
export const writeReshapeJudge = (file: IReshapeJudgeFile): Promise<void> => writeJson(reshapeJudgeFile(), file);

/** Candidate lines already sent, by `<ws>/<entryId>` (review r1 F8): the last 500, so a restart never sends one twice. */
export const CANDIDATES_SENT_MAX = 500;
const candidatesSentFile = (): string => path.join(curatorDir(), 'candidates-sent.json');
const gc = globalThis as unknown as { __ptCuratorCandidatesLock?: Promise<unknown> };

export const candidateSent = async (key: string): Promise<boolean> =>
  ((await readJson<{ keys?: string[] }>(candidatesSentFile()))?.keys ?? []).includes(key);

export const markCandidateSent = (key: string): Promise<void> => {
  const run = async () => {
    const keys = (await readJson<{ keys?: string[] }>(candidatesSentFile()))?.keys ?? [];
    if (keys.includes(key)) return;
    await writeJson(candidatesSentFile(), { keys: [...keys, key].slice(-CANDIDATES_SENT_MAX) });
  };
  const next = (gc.__ptCuratorCandidatesLock ?? Promise.resolve()).then(run, run);
  gc.__ptCuratorCandidatesLock = next.catch(() => undefined);
  return next;
};
