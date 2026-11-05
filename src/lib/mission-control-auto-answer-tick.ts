import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import { createLogger } from '@/lib/logger';
import { AUTO_ANSWER_KEY, autoAnswerRefusal, parseAutoAnswerMinutes, type IAutoAnswerRule } from '@/lib/mission-control-auto-answer';
import { isMissionControlError } from '@/lib/mission-control-errors';
import { getMissionControlStore, type MissionControlStore } from '@/lib/mission-control-store';
import type { IFleetConfigValue } from '@/types/fleet-config';

// The bookkeeping rule's 60 s tick (ADR-0031 §6). It answers through the store's
// system path only; delivery to the agent is the normal Mission Control path.

const log = createLogger('mission-control-auto-answer');

const TICK_MS = 60_000;

export interface IAutoAnswerDeps {
  store: () => Pick<MissionControlStore, 'listAutoAnswerCandidates' | 'submitSystemAnswer'>;
  readRule: () => Promise<IAutoAnswerRule | null>;
  audit: (entry: Record<string, unknown>) => Promise<unknown>;
  now: () => number;
}

export interface IAutoAnswerOutcome {
  itemId: string;
  workspaceId: string;
  answerId: string;
}

const g = globalThis as unknown as {
  __ptAutoAnswerTick?: { timer: ReturnType<typeof setInterval>; running: Promise<unknown> | null };
  __ptAutoAnswerRuleLogged?: string;
};

const logOnce = (line: string): void => {
  if (g.__ptAutoAnswerRuleLogged === line) return;
  g.__ptAutoAnswerRuleLogged = line;
  log.warn(line);
};

/** Off when unset, invalid or unreadable: the rule never acts on a value it cannot trust. */
export const readAutoAnswerRule = async (read: () => Promise<IFleetConfigValue | null>): Promise<IAutoAnswerRule | null> => {
  let stored: IFleetConfigValue | null;
  try {
    stored = await read();
  } catch (err) {
    logOnce(`${AUTO_ANSWER_KEY} could not be read (${err instanceof Error ? err.message : String(err)}); the rule is off`);
    return null;
  }
  if (!stored) {
    g.__ptAutoAnswerRuleLogged = undefined;
    return null;
  }
  const { minutes, reason } = parseAutoAnswerMinutes(stored.value);
  if (minutes === null) {
    logOnce(reason ?? `${AUTO_ANSWER_KEY} is off`);
    return null;
  }
  g.__ptAutoAnswerRuleLogged = undefined;
  return { minutes, version: stored.version };
};

const defaultDeps: IAutoAnswerDeps = {
  store: getMissionControlStore,
  readRule: () => readAutoAnswerRule(async () => valueOf(await readFleetConfig(), AUTO_ANSWER_KEY)),
  audit: appendCoordinationAudit,
  now: () => Date.now(),
};

/** One pass: answer each eligible item with its stated default; a lost race or a refusal skips the item. */
export const runAutoAnswerPass = async (deps: IAutoAnswerDeps = defaultDeps): Promise<IAutoAnswerOutcome[]> => {
  const rule = await deps.readRule();
  if (!rule) return [];
  const store = deps.store();
  const outcomes: IAutoAnswerOutcome[] = [];
  for (const item of store.listAutoAnswerCandidates()) {
    const now = deps.now();
    if (autoAnswerRefusal(item, rule, now)) continue;
    try {
      const result = store.submitSystemAnswer(item.id, item.revision, rule, now);
      if (result.replayed) continue;
      outcomes.push({ itemId: item.id, workspaceId: item.workspaceId, answerId: result.answer.id });
      await deps.audit({
        event: 'attention-auto-answer',
        itemId: item.id,
        workspaceId: item.workspaceId,
        rule: AUTO_ANSWER_KEY,
        ruleVersion: rule.version,
        optionId: result.answer.optionIds[0],
        ageMs: now - item.updatedAt,
      });
    } catch (err) {
      if (isMissionControlError(err) && err.status === 409) {
        log.info({ itemId: item.id }, `auto-answer skipped: ${err.message}`);
        continue;
      }
      log.error({ err, itemId: item.id }, 'auto-answer failed');
    }
  }
  return outcomes;
};

/**
 * The tick's two passes: the bookkeeping rule, then the fleet standing-order proposals (ADR-0041 §1 amendment D7),
 * which run whatever the auto-answer key holds, so a crash or a restart after the owner's answer cannot lose a Yes.
 */
export const runTickPasses = async (
  autoAnswer: () => Promise<unknown> = () => runAutoAnswerPass(),
  proposals: () => Promise<unknown> = async () => {
    const m = await import('@/lib/so-proposal-service');
    return m.runSoProposalPass(await m.soProposalDeps());
  },
): Promise<void> => {
  await autoAnswer().catch((err) => log.error({ err }, 'auto-answer pass failed'));
  await proposals().catch((err) => log.error({ err }, 'standing-order proposal pass failed'));
};

/** One tick per process: a second start is a no-op, and a pass never overlaps the previous one. */
export const startAutoAnswerTick = (pass: () => Promise<unknown> = () => runTickPasses()): void => {
  if (g.__ptAutoAnswerTick) return;
  const tick: { timer: ReturnType<typeof setInterval>; running: Promise<unknown> | null } = {
    timer: setInterval(() => {
      if (tick.running) return;
      tick.running = pass()
        .catch((err) => log.error({ err }, 'auto-answer pass failed'))
        .finally(() => { tick.running = null; });
    }, TICK_MS),
    running: null,
  };
  tick.timer.unref?.();
  g.__ptAutoAnswerTick = tick;
};

export const stopAutoAnswerTick = async (): Promise<void> => {
  const tick = g.__ptAutoAnswerTick;
  if (!tick) return;
  g.__ptAutoAnswerTick = undefined;
  clearInterval(tick.timer);
  await tick.running;
};
