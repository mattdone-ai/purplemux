import fs from 'fs/promises';
import path from 'path';
import {
  CURATOR_MODEL, CURATOR_SHADOW_MS, CURATOR_SOURCE_HORIZON_MS, KODIT_RATE_LIMIT_MS, SPOT_CHECK_SIZE, promoteVerdict, type ICuratorShadowRow,
  type IPromoteVerdict,
} from '@/lib/curator';
import { CuratorClient, type ICuratorJob } from '@/lib/curator-client';
import { isFiledOrderItem } from '@/lib/curator-filed-order';
import { CURATOR_EVAL_WORKSPACE, runCuratorEval, scoreLabels, type TCuratorSplit } from '@/lib/curator-eval';
import { KODIT_LOG_PATH, KODIT_WINDOW_MS, KODIT_NOT_CONFIGURED, koditCheckConfig, koditDrop, koditLogHost, koditNeedsRateLimit, koditRate, parseKoditLog } from '@/lib/curator-kodit';
import { queueAdditions, queueView, validateImport, type IShadowCall } from '@/lib/curator-labels';
import { findTwin, missionAskText, resolveLabelledText, transcriptUserEntries, workspaceTranscripts } from '@/lib/curator-sources';
import { SPOT_CHECK_ITEM_PREFIX, buildSpotCheckQuestion, drawMatchSpotCheck, drawSpotCheck, isSpotCheckItem, readSpotCheckAnswer } from '@/lib/curator-spot-check';
import {
  appendShadowEvidence, ensureLiveSince, ensureShadowSince, evalDir, readCuratorState, readEvalResult, readLabelQueue, readLabelledSet,
  readShadowEvidence, readSpotCheckFile, updateCuratorState, writeEvalResult, writeLabelQueue, writeLabelledSet, writeSpotCheckFile,
  type ILabelledItem,
} from '@/lib/curator-store';
import {
  CURATOR_LABEL_TASK_IDS, CURATOR_TASKS, CURATOR_TASK_IDS, NOT_COVERED, endingAsksSomething, isLabelTask, servedVersion, type ICuratorStandingOrderRef,
} from '@/lib/curator-tasks';
import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { createLogger } from '@/lib/logger';
import { readMessageHistory } from '@/lib/message-history-store';
import type {
  ICuratorAgreement, ICuratorBoard, ICuratorCallRecord, ICuratorEvalProgress, ICuratorEvalResult, ICuratorTaskStatus, ISpotCheckFile, TCuratorLabelTask,
  TCuratorTask, TSpotCheckVerdict,
} from '@/types/curator';

const log = createLogger('curator');

/** Fleet keys (ADR-0038; admin-only, ADR-0019): routing opts in per workspace, and the client can be switched off. */
export const CURATOR_KEYS = {
  routingWorkspaces: 'curator.routing.workspaces',
  minIntervalMs: 'curator.min-interval-ms',
  enabled: 'curator.enabled',
} as const;

export const CURATOR_PROBE_MS = 60_000;
export const KODIT_CHECK_MS = 6 * 60 * 60_000;
const AGREEMENT_CACHE_MS = 60_000;
const OWNER_MESSAGE_TAB = '-';

const g = globalThis as unknown as {
  __ptCuratorShadowMarked?: Set<string>;
  /** The order set `readOrders` last read: the matcher's version key needs it synchronously (confirm R2). */
  __ptCuratorOrders?: ICuratorStandingOrderRef[];
  __ptCuratorAsksSeen?: Set<string>;
  __ptCuratorSpotDrafts?: Map<TCuratorLabelTask, { file: ISpotCheckFile; question: ReturnType<typeof buildSpotCheckQuestion> }>;
  __ptCuratorClient?: CuratorClient;
  __ptCuratorTimers?: NodeJS.Timeout[];
  __ptCuratorEvals?: Map<TCuratorTask, ICuratorEvalProgress>;
  __ptCuratorAgreement?: Map<string, { at: number; value: ICuratorAgreement[] | null }>;
};
if (!g.__ptCuratorEvals) g.__ptCuratorEvals = new Map();
if (!g.__ptCuratorShadowMarked) g.__ptCuratorShadowMarked = new Set();
if (!g.__ptCuratorAsksSeen) g.__ptCuratorAsksSeen = new Set();
if (!g.__ptCuratorSpotDrafts) g.__ptCuratorSpotDrafts = new Map();
if (!g.__ptCuratorAgreement) g.__ptCuratorAgreement = new Map();

const fleetValue = async (key: string): Promise<string | null> => valueOf(await readFleetConfig(), key)?.value ?? null;

export const parseRoutingWorkspaces = (value: string | null): string[] =>
  (value ?? '').split(',').map((ws) => ws.trim()).filter(Boolean);

/** The gap from a call's end to the next start: the kodit rule's limit, or the fleet's, whichever is longer. */
const minIntervalMs = async (): Promise<number> => {
  const [state, fleet] = await Promise.all([readCuratorState(), fleetValue(CURATOR_KEYS.minIntervalMs)]);
  const configured = fleet !== null && /^\d{1,6}$/.test(fleet) ? Number(fleet) : 0;
  return Math.max(state.rateLimitMs, configured);
};

/**
 * Every call into `tab_events` (AC 2): class `log`, kind `curator`, the record as JSON, never the input text. A live
 * model call (outside the evaluation; not a drop, which never reached the model; of a known served version) of a
 * version that never ran starts that version's 72 h clock.
 */
const recordCall = (job: ICuratorJob, record: ICuratorCallRecord, at: number): void => {
  const clock = `${record.task}\0${record.promptVersion}`;
  const modelCall = record.outcome !== 'dropped' && record.modelDigest !== null;
  if (job.workspaceId !== CURATOR_EVAL_WORKSPACE && modelCall && !g.__ptCuratorShadowMarked!.has(clock)) {
    g.__ptCuratorShadowMarked!.add(clock);
    void ensureShadowSince(record.task, record.promptVersion, at)
      .catch((err: unknown) => log.warn({ task: record.task }, `curator: shadow clock unwritable (${err instanceof Error ? err.message : String(err)})`));
  }
  void import('@/lib/ledger-store').then(({ getLedgerStore }) => {
    getLedgerStore().tabEvents.append({
      workspaceId: job.workspaceId, tabId: job.tabId, at, class: 'log', kind: 'curator', text: JSON.stringify(record),
    });
  }).catch((err: unknown) => log.warn({ task: record.task }, `curator: tab_events write failed (${err instanceof Error ? err.message : String(err)})`));
};

export const getCuratorClient = (): CuratorClient => {
  if (!g.__ptCuratorClient) {
    g.__ptCuratorClient = new CuratorClient({
      fetch: (...args) => fetch(...args),
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      minIntervalMs,
      record: recordCall,
    });
  }
  return g.__ptCuratorClient;
};

export const curatorEnabled = async (): Promise<boolean> => (await fleetValue(CURATOR_KEYS.enabled))?.trim() !== 'off';

const readOrders = async (): Promise<ICuratorStandingOrderRef[]> => {
  let orders: ICuratorStandingOrderRef[];
  try {
    const raw = JSON.parse(await fs.readFile(path.join(evalDir(), 'match-standing-order.orders.json'), 'utf-8')) as unknown;
    orders = Array.isArray(raw)
      ? raw.flatMap((o: { id?: unknown; text?: unknown }) => (typeof o.id === 'string' && typeof o.text === 'string' ? [{ id: o.id, text: o.text }] : []))
      : [];
  } catch {
    orders = [];
  }
  g.__ptCuratorOrders = orders;
  return orders;
};

/**
 * The version key H the gate, clocks, evidence and routing use now (confirm R2): the static prompt version, the served
 * model digest and (matcher) the order set. null while the digest or (matcher) the order set is unknown.
 */
const liveVersion = (task: TCuratorTask): string | null =>
  servedVersion(task, getCuratorClient().digest(), task === 'match-standing-order' ? g.__ptCuratorOrders ?? null : null);

/** The same, after reading the order file and, when no digest is known yet, probing the model once. */
export const liveVersionNow = async (task: TCuratorTask): Promise<string | null> => {
  if (task === 'match-standing-order') await readOrders();
  if (getCuratorClient().digest() === null && (await curatorEnabled())) await getCuratorClient().probe();
  return liveVersion(task);
};

export const DIGEST_UNKNOWN = 'served model digest unknown: no probe of the curator has answered with gemma4:26b\'s digest';

// The kodit rule (ADR-0038 §7): 72 h before the client went live against the 72 h after, once, then held.
const checkKodit = async (now: number): Promise<void> => {
  const state = await readCuratorState();
  if (state.liveSince === null || (state.kodit?.after && state.kodit.after.docsPerHour !== null)) return;
  const host = koditLogHost();
  if (host === null) {
    // Visible twice: this warning, and `koditCheck` in the curator status (`purplemux curator status`).
    log.warn(`curator: ${KODIT_NOT_CONFIGURED}`);
    return;
  }
  const { runSsh } = await import('@/lib/remote-host');
  const { stdout } = await runSsh(host, `cat ${KODIT_LOG_PATH}`, { timeoutMs: 10_000 });
  const samples = parseKoditLog(stdout);
  const before = koditRate(samples, state.liveSince - KODIT_WINDOW_MS, state.liveSince);
  const after = now >= state.liveSince + KODIT_WINDOW_MS ? koditRate(samples, state.liveSince, state.liveSince + KODIT_WINDOW_MS) : null;
  const drop = after ? koditDrop(before, after) : null;
  await updateCuratorState((s) => {
    s.kodit = { before, after, drop, measuredAt: now };
    if (koditNeedsRateLimit(drop)) s.rateLimitMs = KODIT_RATE_LIMIT_MS;
  });
  if (koditNeedsRateLimit(drop)) log.warn({ drop }, 'curator: kodit enrichment fell over 20% after the client went live; one call per 10 s');
};

/** Server start: the kodit anchor, the health probe every minute, the kodit check every 6 h. */
export const startCurator = async (): Promise<void> => {
  if (g.__ptCuratorTimers) return;
  const client = getCuratorClient();
  await ensureLiveSince(Date.now()).catch((err: unknown) => log.warn(`curator: state unwritable (${err instanceof Error ? err.message : String(err)})`));
  const probe = () => { void curatorEnabled().then((on) => (on ? client.probe() : null)); };
  const kodit = () => { void checkKodit(Date.now()).catch((err: unknown) => log.warn(`curator: kodit check failed (${err instanceof Error ? err.message : String(err)})`)); };
  probe();
  kodit();
  g.__ptCuratorTimers = [setInterval(probe, CURATOR_PROBE_MS), setInterval(kodit, KODIT_CHECK_MS)];
  for (const timer of g.__ptCuratorTimers) timer.unref();
};

export const stopCurator = (): void => {
  for (const timer of g.__ptCuratorTimers ?? []) clearInterval(timer);
  g.__ptCuratorTimers = undefined;
};

/** Shadow calls run only in a started server: a test or a script that imports a hook never reaches the GPU. */
export const isLive = (): boolean => g.__ptCuratorTimers !== undefined;

const warn = (what: string) => (err: unknown) => log.warn(`curator: ${what} (${err instanceof Error ? err.message : String(err)})`);

const shadow = (job: ICuratorJob): void => {
  if (!isLive()) return;
  void curatorEnabled().then((on) => (on ? getCuratorClient().classify(job) : null)).catch(warn(`shadow call ${job.task} failed`));
};

/**
 * An owner message typed in purplemux (ADR-0038 §2; story 23 AC 1-2): classified after it is saved, with its history id
 * for the label pass, then routed where the label acts. Nothing here is awaited: delivery never waits on the curator.
 */
export const curatorOnOwnerMessage = (workspaceId: string, entryId: string, text: string, at: number = Date.now()): void => {
  if (!text.trim() || !isLive()) return;
  void curatorEnabled().then(async (on) => {
    if (!on) return;
    const result = await getCuratorClient().classify({
      task: 'classify-owner-message', workspaceId, tabId: OWNER_MESSAGE_TAB, sourceId: `${workspaceId}/${entryId}`, input: { text },
    });
    const [{ routeOwnerMessage }, { ownerRoutingDeps }] = await Promise.all([import('@/lib/curator-routing'), import('@/lib/curator-routing-service')]);
    await routeOwnerMessage(ownerRoutingDeps(), { workspaceId, entryId, text, at }, result);
  }).catch(warn(`owner message ${workspaceId}/${entryId} not classified`));
};

/**
 * A turn that ended with no marker: flagged in shadow when it may ask something (its last lines hold a '?'), then
 * matched against the standing orders. `sourceId` is `<ws>/<session>/<assistant uuid>` for a Claude tab, else null.
 */
export const curatorOnUnmarkedTurnEnd = (workspaceId: string, tabId: string, tail: string | null | undefined, sourceId: string | null = null): void => {
  if (!isLive() || !tail || !endingAsksSomething(tail)) return;
  void curatorEnabled().then(async (on) => {
    if (!on) return;
    const flagged = await getCuratorClient().classify({ task: 'flag-owner-question', workspaceId, tabId, sourceId, input: { text: tail } });
    if (flagged.routed !== 'question-to-owner') return;
    const orders = await readOrders();
    if (orders.length) shadow({ task: 'match-standing-order', workspaceId, tabId, sourceId, input: { text: tail, orders } });
  }).catch(warn(`turn-end shadow for ${tabId} failed`));
};

/**
 * An agent's Mission Control ask that the owner sees (humanNeed approval or decision): matched against the standing
 * orders in shadow, once per item (consult 16-promote-gate: 314 of the 384 labelled asks are MC items). Opens nothing.
 */
export const curatorOnMissionAsk = (workspaceId: string, itemId: string): void => {
  const key = `${workspaceId}/mc/${itemId}`;
  if (!isLive() || g.__ptCuratorAsksSeen!.has(key)) return;
  g.__ptCuratorAsksSeen!.add(key);
  void (async () => {
    const { getMissionControlStore } = await import('@/lib/mission-control-store');
    const item = getMissionControlStore().itemQuestion(workspaceId, itemId);
    const text = item ? missionAskText(item.questionJson) : null;
    const orders = text ? await readOrders() : [];
    if (text && orders.length) shadow({ task: 'match-standing-order', workspaceId, tabId: OWNER_MESSAGE_TAB, sourceId: key, input: { text, orders } });
  })().catch(warn(`MC ask shadow for ${key} failed`));
};

/** The MC event route's hook: an `attention.opened` / `attention.updated` whose review needs the owner's approval or decision. */
export const curatorOnMissionEvents = (events: ReadonlyArray<{ type: string; workspaceId: string; payload?: unknown }>): void => {
  for (const event of events) {
    if (event.type !== 'attention.opened' && event.type !== 'attention.updated') continue;
    const payload = event.payload as { itemId?: unknown; humanReview?: { humanNeed?: unknown } } | undefined;
    const need = payload?.humanReview?.humanNeed;
    // The curator's own items (a spot check, a keep-or-strike of an order it filed) are never matched against the orders.
    if (typeof payload?.itemId === 'string' && !isSpotCheckItem(payload.itemId) && !isFiledOrderItem(payload.itemId)
      && (need === 'approval' || need === 'decision')) {
      curatorOnMissionAsk(event.workspaceId, payload.itemId);
    }
  }
};

const taskStatus = (task: TCuratorTask, state: Awaited<ReturnType<typeof readCuratorState>>): ICuratorTaskStatus => {
  const entry = state.tasks[task];
  const version = liveVersion(task);
  const promptVersion = version ?? `${CURATOR_TASKS[task].promptVersion}~unknown`;
  // A prompt, a re-pulled model or an order edit since the gate passed is back in shadow: the gate was passed by
  // another version. An unknown digest is never routing.
  const routing = version !== null && entry?.state === 'routing' && entry.promotedPromptVersion === version;
  const shadowSince = version === null ? null : entry?.shadowSince?.[version] ?? null;
  return {
    task, promptVersion, state: routing ? 'routing' : 'shadow', shadowSince,
    shadowEndsAt: shadowSince === null ? null : shadowSince + CURATOR_SHADOW_MS,
    promotedAt: routing ? entry?.promotedAt ?? null : null, promotedPromptVersion: entry?.promotedPromptVersion ?? null,
  };
};

/** Whether a task's label routes in this workspace (ADR-0038 §5; consult v2 point 6): routing state and an opt-in. */
export const curatorRoutesIn = async (task: TCuratorTask, workspaceId: string): Promise<boolean> => {
  const [state, workspaces] = await Promise.all([readCuratorState(), fleetValue(CURATOR_KEYS.routingWorkspaces)]);
  return taskStatus(task, state).state === 'routing' && parseRoutingWorkspaces(workspaces).includes(workspaceId);
};

/** The same, and the served version the routing checks is exactly `version` (a reply's own; review r1 F6). */
export const curatorRoutesOnVersion = async (task: TCuratorTask, workspaceId: string, version: string): Promise<boolean> => {
  const [state, workspaces] = await Promise.all([readCuratorState(), fleetValue(CURATOR_KEYS.routingWorkspaces)]);
  const entry = state.tasks[task];
  return entry?.state === 'routing' && entry.promotedPromptVersion === version && parseRoutingWorkspaces(workspaces).includes(workspaceId);
};

const parseRecord = (text: string): Partial<ICuratorCallRecord> | null => {
  try {
    return JSON.parse(text) as Partial<ICuratorCallRecord>;
  } catch {
    return null;
  }
};

const readAgreement = async (workspaceId: string, now: number): Promise<ICuratorAgreement[] | null> => {
  const cached = g.__ptCuratorAgreement!.get(workspaceId);
  if (cached && now - cached.at < AGREEMENT_CACHE_MS) return cached.value;
  let value: ICuratorAgreement[] | null;
  try {
    const { getLedgerStore } = await import('@/lib/ledger-store');
    const rows = getLedgerStore().tabEvents.curatorCalls(workspaceId, now - CURATOR_SHADOW_MS);
    value = CURATOR_LABEL_TASK_IDS.map((task) => ({ task, calls: 0, compared: 0, agreed: 0 }));
    for (const text of rows) {
      const record = parseRecord(text);
      const row = record && value.find((a) => a.task === record.task);
      if (!record || !row) continue;
      row.calls += 1;
      if (record.outcome !== 'labelled' || typeof record.label !== 'string') continue;
      row.compared += 1;
      if (record.label === record.rulesLabel) row.agreed += 1;
    }
  } catch (err) {
    log.warn({ workspaceId }, `curator: agreement unreadable (${err instanceof Error ? err.message : String(err)})`);
    value = null;
  }
  g.__ptCuratorAgreement!.set(workspaceId, { at: now, value });
  return value;
};

/** The board's curator line (AC 8): up or down, each task's state here, and the shadow agreement over 72 h. */
export const readCuratorBoard = async (workspaceId: string, now: number): Promise<ICuratorBoard> => {
  const [state, workspaces, agreement, enabled] = await Promise.all([
    readCuratorState(), fleetValue(CURATOR_KEYS.routingWorkspaces), readAgreement(workspaceId, now), curatorEnabled(),
  ]);
  const routingHere = parseRoutingWorkspaces(workspaces).includes(workspaceId);
  const health = enabled
    ? getCuratorClient().health()
    : { state: 'down' as const, reason: `switched off (${CURATOR_KEYS.enabled}=off)`, since: null, checkedAt: null };
  return {
    health,
    tasks: CURATOR_TASK_IDS.map((task) => {
      const status = taskStatus(task, state);
      return { ...status, routingHere: status.state === 'routing' && routingHere };
    }),
    agreement,
  };
};

// ── the owner's spot check (AC 6; consult of 2026-11-03; consult 16-promote-gate ruling 1 for the matcher) ──

const SPOT_TASKS: readonly TCuratorLabelTask[] = ['classify-owner-message', 'match-standing-order'];

/** The owner's spot-check answer for a task, as promote reads it. */
export const readSpotCheck = async (task: TCuratorLabelTask = 'classify-owner-message'): Promise<{ itemId: string | null; workspaceId: string | null; verdict: TSpotCheckVerdict }> => {
  const file = await readSpotCheckFile(task);
  if (!file) return { itemId: null, workspaceId: null, verdict: { state: 'unanswered' } };
  const { getMissionControlStore } = await import('@/lib/mission-control-store');
  const answer = getMissionControlStore().latestAnswer(file.workspaceId, file.itemId);
  return {
    itemId: file.itemId, workspaceId: file.workspaceId,
    verdict: readSpotCheckAnswer(answer ? { optionIds: answer.optionIds, text: answer.text, actor: answer.actor, createdAt: answer.createdAt } : null, file.numbers),
  };
};

// ── the gate ──

const shadowRowsOf = async (task: TCuratorLabelTask, version: string, set: Awaited<ReturnType<typeof readLabelledSet>>): Promise<ICuratorShadowRow[]> => {
  const gold = new Map((set?.items ?? []).map((item) => [item.id, item.label]));
  return (await readShadowEvidence(task)).filter((row) => row.promptVersion === version && gold.has(row.id))
    .map((row) => ({ id: row.id, gold: gold.get(row.id)!, predicted: row.predicted }));
};

const labelGate = async (task: TCuratorLabelTask, now: number): Promise<IPromoteVerdict> => {
  const version = await liveVersionNow(task);
  const [state, result, set, spot] = await Promise.all([
    readCuratorState(), readEvalResult(task), readLabelledSet(task), SPOT_TASKS.includes(task) ? readSpotCheck(task) : Promise.resolve(null),
  ]);
  const key = version ?? `${CURATOR_TASKS[task].promptVersion}~unknown`;
  const shadowRows = await shadowRowsOf(task, key, set);
  const verdict = spot?.verdict;
  const spotCheckApplied = verdict?.state === 'answered' && result?.spotCheck?.itemId === spot?.itemId
    && result !== null && result.startedAt >= (verdict.answeredAt ?? Infinity);
  const gate = promoteVerdict({
    task, now, promptVersion: key, labels: scoreLabels(task), shadowSince: taskStatus(task, state).shadowSince, result, shadowRows,
    ...(spot ? { spotCheck: spot.verdict, spotCheckApplied } : {}),
  });
  return version === null ? { ...gate, ok: false, refusals: [DIGEST_UNKNOWN, ...gate.refusals] } : gate;
};

/** The promote verdict without writing anything: `curator status` shows it, `curator promote` acts on it. */
export const curatorGate = async (task: TCuratorTask, now: number): Promise<IPromoteVerdict> => {
  if (isLabelTask(task)) return labelGate(task, now);
  const { reshapeGate } = await import('@/lib/curator-reshape-service');
  return reshapeGate(now);
};

/** `curator promote` (AC 5, amended): every condition of `curatorGate`, refused with every reason. */
export const promoteCuratorTask = async (task: TCuratorTask, now: number): Promise<IPromoteVerdict> => {
  const verdict = await curatorGate(task, now);
  const version = liveVersion(task);
  if (verdict.ok && version !== null) {
    await updateCuratorState((s) => {
      s.tasks[task] = { ...s.tasks[task], state: 'routing', promotedAt: now, promotedPromptVersion: version };
    });
  }
  return verdict;
};

export const demoteCuratorTask = (task: TCuratorTask): Promise<boolean> =>
  updateCuratorState((s) => {
    const was = s.tasks[task]?.state === 'routing';
    s.tasks[task] = { ...s.tasks[task], state: 'shadow', promotedAt: null, promotedPromptVersion: null };
    return was;
  });

export const readCuratorStatus = async () => {
  const state = await readCuratorState();
  const now = Date.now();
  const tasks = await Promise.all(CURATOR_TASK_IDS.map(async (task) => {
    const [gate, queue] = await Promise.all([curatorGate(task, now), isLabelTask(task) ? readLabelQueue(task) : Promise.resolve(null)]);
    return {
      ...taskStatus(task, state),
      gate: { checks: gate.score?.checks ?? null, shadow: gate.shadow, refusals: gate.refusals },
      queue: queue && queue.promptVersion === liveVersion(task) ? { size: queue.items.length, oldestAt: queueView(queue).oldestAt } : { size: 0, oldestAt: null },
    };
  }));
  return {
    model: CURATOR_MODEL,
    health: getCuratorClient().health(),
    queued: getCuratorClient().queued(),
    liveSince: state.liveSince,
    rateLimitMs: state.rateLimitMs,
    kodit: state.kodit,
    koditCheck: koditCheckConfig(),
    tasks,
    evals: [...g.__ptCuratorEvals!.values()],
  };
};

// ── evaluation ──

/**
 * What an evaluation leaves out: every id with shadow evidence of ANY prompt version (its prediction was seen by a label
 * pass, so it is no longer out-of-sample; review r2 F2), and (owner messages) the gold the owner disputed.
 */
export const curatorEvalExclusions = async (task: TCuratorLabelTask) => {
  const shadow = new Set((await readShadowEvidence(task)).map((row) => row.id));
  const spot = task === 'classify-owner-message' ? await readSpotCheck(task) : null;
  const answered = spot?.verdict.state === 'answered' ? spot.verdict : null;
  return {
    exclude: { shadow, disputed: new Set(answered?.disputed ?? []) },
    spotCheck: answered && spot?.itemId ? { itemId: spot.itemId, answeredAt: answered.answeredAt ?? 0 } : null,
  };
};

/** Start (or report) one task's evaluation, in the server through the same one-at-a-time queue. */
export const startCuratorEval = async (task: TCuratorTask, split: TCuratorSplit): Promise<ICuratorEvalProgress> => {
  if (isLabelTask(task)) return startLabelEval(task, split);
  const { startReshapeEval } = await import('@/lib/curator-reshape-service');
  return startReshapeEval();
};

const startLabelEval = async (task: TCuratorLabelTask, split: TCuratorSplit): Promise<ICuratorEvalProgress> => {
  const running = g.__ptCuratorEvals!.get(task);
  if (running?.running) return running;
  const set = await readLabelledSet(task);
  if (!set || !set.items.length) throw new Error(`no labelled set for ${task} in ~/.purplemux/curator/eval/`);
  const version = await liveVersionNow(task);
  if (version === null) throw new CuratorRefusal(DIGEST_UNKNOWN);
  const { exclude, spotCheck } = await curatorEvalExclusions(task);
  const progress: ICuratorEvalProgress = { task, running: true, done: 0, total: 0, startedAt: Date.now(), error: null };
  g.__ptCuratorEvals!.set(task, progress);
  const cache = new Map<string, Map<string, string>>();
  void runCuratorEval(task, set, split, {
    classify: (job) => getCuratorClient().classify(job),
    resolveText: (item) => resolveLabelledText(item, cache),
    orders: readOrders,
    now: () => Date.now(),
    model: CURATOR_MODEL,
    promptVersion: version,
    exclude,
    spotCheck,
    onProgress: (done, total) => { progress.done = done; progress.total = total; },
  }).then(writeEvalResult).then(() => { progress.running = false; }).catch((err: unknown) => {
    progress.running = false;
    progress.error = err instanceof Error ? err.message : String(err);
    log.warn({ task }, `curator: evaluation failed (${progress.error})`);
  });
  return progress;
};

export const readCuratorEval = async (task: TCuratorLabelTask, split: TCuratorSplit = 'holdout'): Promise<{ progress: ICuratorEvalProgress | null; result: ICuratorEvalResult | null }> =>
  ({ progress: g.__ptCuratorEvals!.get(task) ?? null, result: await readEvalResult(task, split) });

// ── the blind label pass (consult 16-promote-gate, ruling 1) ──

/** `curator label-queue`: the live version's unlabelled shadow calls of the last 30 days join the queue; ids only out. */
export const curatorLabelQueue = async (task: TCuratorLabelTask, now: number) => {
  const version = await liveVersionNow(task);
  if (version === null) throw new CuratorRefusal(DIGEST_UNKNOWN);
  const { getLedgerStore } = await import('@/lib/ledger-store');
  const calls: IShadowCall[] = getLedgerStore().tabEvents.curatorCallsSince(now - CURATOR_SOURCE_HORIZON_MS, CURATOR_EVAL_WORKSPACE).flatMap(({ at, text }) => {
    const r = parseRecord(text);
    return r && r.task === task && typeof r.sourceId === 'string' && typeof r.promptVersion === 'string' && !r.sourceId.includes(`/mc/${SPOT_CHECK_ITEM_PREFIX}`)
      ? [{ sourceId: r.sourceId, promptVersion: r.promptVersion, predicted: r.label ?? null, outcome: r.outcome ?? 'error', at }]
      : [];
  });
  const [set, evidence, prior] = await Promise.all([readLabelledSet(task), readShadowEvidence(task), readLabelQueue(task)]);
  // Ids a pass excluded (no permission ask) stay known across versions, so they never come back (confirm N2).
  const queue = prior && prior.promptVersion === version
    ? prior
    : { task, promptVersion: version, items: [], ...(prior?.excluded?.length ? { excluded: prior.excluded } : {}) };
  const known = new Set([
    ...(set?.items ?? []).map((i) => i.id), ...evidence.map((r) => r.id), ...queue.items.map((i) => i.id), ...(queue.excluded ?? []),
  ]);
  const added = queueAdditions(task, version, calls, known);
  queue.items.push(...added);
  await writeLabelQueue(queue);
  return { ...queueView(queue), added: added.length };
};

/**
 * The label pass's input: each queued id with its text, sorted by id, never its prediction. Returned, never written: the
 * caller streams it (review r2 F3), so no raw text is left on disk to delete.
 */
export const curatorQueueTexts = async (task: TCuratorLabelTask): Promise<Array<{ id: string; text: string }>> => {
  const queue = await readLabelQueue(task);
  if (!queue) throw new CuratorRefusal(`no label queue for ${task}: run \`purplemux curator label-queue --task ${task}\``);
  const cache = new Map<string, Map<string, string>>();
  const items = await Promise.all([...queue.items].sort((a, b) => a.id.localeCompare(b.id))
    .map(async ({ id }) => ({ id, text: await resolveLabelledText(id, cache) })));
  return items.flatMap((item) => (item.text === null ? [] : [{ id: item.id, text: item.text }]));
};

/** Where an owner message's text sits in its workspace's transcripts, read while its history entry exists. */
const ownerItem = async (id: string, label: string, transcripts: Map<string, Awaited<ReturnType<typeof transcriptUserEntries>>>): Promise<ILabelledItem> => {
  const [ws, entryId] = id.split('/');
  const entry = (await readMessageHistory(ws)).find((e) => e.id === entryId);
  if (!entry) return { id, label };
  const at = Date.parse(entry.sentAt);
  if (!transcripts.has(ws)) transcripts.set(ws, (await Promise.all((await workspaceTranscripts(ws)).map((f) => transcriptUserEntries(ws, f)))).flat());
  const alt = findTwin(entry.message, at, transcripts.get(ws)!);
  return { id, label, at, ...(alt ? { alt } : {}) };
};

/** `curator label-import` (admin): the labels join the set, the queued predictions become shadow evidence. */
export const curatorLabelImport = async (task: TCuratorLabelTask, entries: unknown) => {
  const [queue, orders] = await Promise.all([readLabelQueue(task), readOrders()]);
  const verdict = validateImport(task, queue, entries, orders.map((o) => o.id));
  if (!verdict.ok) throw new CuratorRefusal(verdict.error);
  const q = queue!;
  const byId = new Map(q.items.map((i) => [i.id, i]));
  const set = (await readLabelledSet(task)) ?? { task, labelledBy: 'curator label-import', labelledAt: new Date().toISOString(), items: [] };
  const transcripts = new Map<string, Awaited<ReturnType<typeof transcriptUserEntries>>>();
  const items = await Promise.all(verdict.accepted.map(({ id, label }) => (task === 'classify-owner-message'
    ? ownerItem(id, label, transcripts) : Promise.resolve({ id, label, at: byId.get(id)!.at }))));
  const present = new Set(set.items.map((i) => i.id));
  set.items.push(...items.filter((i) => !present.has(i.id)));
  await writeLabelledSet(set);
  await appendShadowEvidence(task, verdict.accepted.map(({ id }) => {
    const queued = byId.get(id)!;
    return { id, promptVersion: q.promptVersion, predicted: queued.predicted, outcome: queued.outcome, at: queued.at };
  }));
  const done = new Set([...verdict.accepted.map((a) => a.id), ...verdict.excluded]);
  await writeLabelQueue({
    ...q, items: q.items.filter((i) => !done.has(i.id)),
    ...(verdict.excluded.length || q.excluded?.length ? { excluded: [...new Set([...(q.excluded ?? []), ...verdict.excluded])] } : {}),
  });
  return { task, imported: verdict.accepted.length, excluded: verdict.excluded.length, left: q.items.length - done.size };
};

export class CuratorRefusal extends Error {}

/**
 * Draft a spot-check item. Nothing is written until `commitSpotCheck` sees the posted item in Mission Control, and a
 * redraw is refused while the task's last item stands (anything but cancelled). For the matcher it opens only when the
 * pool passes every other condition (consult 16-promote-gate, ruling 1).
 */
export const draftSpotCheck = async (task: TCuratorLabelTask, workspaceId: string, now: number) => {
  if (!SPOT_TASKS.includes(task)) throw new CuratorRefusal(`${task} has no spot check`);
  const prior = await readSpotCheckFile(task);
  if (prior) {
    const { getMissionControlStore } = await import('@/lib/mission-control-store');
    const item = getMissionControlStore().itemQuestion(prior.workspaceId, prior.itemId);
    if (item && item.state !== 'cancelled') throw new CuratorRefusal(`spot check ${prior.itemId} stands (${item.state}); cancel it in Mission Control before a redraw`);
  }
  const set = await readLabelledSet(task);
  if (!set) throw new CuratorRefusal(`no labelled set for ${task}`);
  const cache = new Map<string, Map<string, string>>();
  const withText = async (items: ReadonlyArray<{ id: string; label: string; alt?: ILabelledItem['alt'] }>) =>
    (await Promise.all(items.map(async (item) => {
      const text = await resolveLabelledText(item, cache);
      return text === null ? null : { id: item.id, label: item.label, text };
    }))).filter((c): c is NonNullable<typeof c> => c !== null);
  let draw;
  if (task === 'classify-owner-message') {
    draw = drawSpotCheck(await withText(set.items));
  } else {
    const gate = await curatorGate(task, now);
    const blocking = gate.refusals.filter((r) => !r.startsWith('spot-check'));
    if (blocking.length) throw new CuratorRefusal(`the matcher's spot check opens once the pool passes everything else: ${blocking.join('; ')}`);
    const rows = await shadowRowsOf(task, (await liveVersionNow(task))!, set);
    draw = drawMatchSpotCheck(await withText(rows.filter((r) => r.gold !== NOT_COVERED && r.predicted === r.gold).map((r) => ({ id: r.id, label: r.gold }))), SPOT_CHECK_SIZE);
  }
  if (!draw.picked.length) throw new CuratorRefusal(`nothing to spot-check for ${task}`);
  const itemId = `${SPOT_CHECK_ITEM_PREFIX}${task === 'classify-owner-message' ? 'owner' : 'match'}-${new Date(now).toISOString().slice(0, 10)}`;
  const question = buildSpotCheckQuestion(draw.picked, task === 'classify-owner-message' ? 'owner-messages' : 'standing-order-matches');
  g.__ptCuratorSpotDrafts!.set(task, {
    file: {
      task, itemId, workspaceId, openedAt: now, perClass: draw.perClass,
      numbers: Object.fromEntries(draw.picked.map((p, i) => [String(i + 1), p.id])),
    },
    question,
  });
  return { task, itemId, question, perClass: draw.perClass, skippedSecret: draw.skippedSecret };
};

/** The fields of a posted question that differ from the draft: the numbers the owner sees must be the map's (review r2 F6). */
const questionDiff = (draft: ReturnType<typeof buildSpotCheckQuestion>, questionJson: string): string[] => {
  let posted: Record<string, unknown>;
  try {
    posted = JSON.parse(questionJson) as Record<string, unknown>;
  } catch {
    return ['question'];
  }
  const ids = (options: unknown) => (Array.isArray(options) ? options.map((o: { id?: unknown }) => o?.id) : null);
  return [
    posted.decision !== draft.decision ? 'decision' : null,
    posted.answerType !== draft.answerType ? 'answerType' : null,
    JSON.stringify(ids(posted.options)) !== JSON.stringify(ids(draft.options)) ? 'options' : null,
    posted.context !== draft.context ? 'context' : null,
  ].filter((field): field is string => field !== null);
};

/**
 * After the caller posted the item: the number map is written only if Mission Control holds that item and it carries the
 * drafted question — the same decision, options and numbered lines (review r1 F1, r2 F6).
 */
export const commitSpotCheck = async (task: TCuratorLabelTask, workspaceId: string, itemId: string) => {
  const pending = g.__ptCuratorSpotDrafts!.get(task);
  if (!pending || pending.file.itemId !== itemId || pending.file.workspaceId !== workspaceId) throw new CuratorRefusal(`no drafted spot check ${itemId} for ${task} in ${workspaceId}`);
  const { getMissionControlStore } = await import('@/lib/mission-control-store');
  const item = getMissionControlStore().itemQuestion(workspaceId, itemId);
  if (!item) throw new CuratorRefusal(`Mission Control holds no item ${itemId}: post it first`);
  const differs = questionDiff(pending.question, item.questionJson);
  if (differs.length) throw new CuratorRefusal(`item ${itemId} does not carry the drafted spot check (${differs.join(', ')} differ); nothing written`);
  await writeSpotCheckFile(pending.file);
  g.__ptCuratorSpotDrafts!.delete(task);
  return { task, itemId, committed: true };
};
