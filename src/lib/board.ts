import { STUCK_LIMIT } from '@/lib/constraint';
import { FINDER_STALE_MS, readFinderResult } from '@/lib/constraint-tick';
import { createLogger } from '@/lib/logger';
import type { IBoard, IBoardNeedsYou } from '@/types/constraint';
import type { ICuratorBoard } from '@/types/curator';
import type { ILedgerExperiment } from '@/types/ledger';

const log = createLogger('board');

type TOpenItem = Omit<IBoardNeedsYou, 'blocked'>;

const readOpenItems = async (workspaceId: string): Promise<TOpenItem[] | null> => {
  try {
    return (await import('@/lib/mission-control-store')).getMissionControlStore().openItemTitles(workspaceId);
  } catch (err) {
    log.warn({ workspaceId }, `board: Mission Control unreadable (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
};

/** Experiments with no verdict yet (ADR-HFL-03); null when the ledger cannot be read. */
const readExperiments = async (workspaceId: string): Promise<ILedgerExperiment[] | null> => {
  try {
    return (await import('@/lib/ledger-store')).getLedgerStore().experiments(workspaceId).filter((experiment) => experiment.verdict === null);
  } catch (err) {
    log.warn({ workspaceId }, `board: experiments unreadable (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
};

const readCurator = async (workspaceId: string, now: number): Promise<ICuratorBoard | null> => {
  try {
    return await (await import('@/lib/curator-service')).readCuratorBoard(workspaceId, now);
  } catch (err) {
    log.warn({ workspaceId }, `board: curator unreadable (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
};

/**
 * One workspace's board (ADR-0034): the finder's cached answer, Mission Control's open items with
 * what each blocks, and the running experiments. `holders` limits the stuck list to the items those
 * holders hold (`board show --mine`); the cap of 50 oldest applies after that filter, and
 * `stuckTotal` says how many matched.
 */
export const readBoard = async (workspaceId: string, now: number, holders: readonly string[] | null = null): Promise<IBoard> => {
  const [finder, open, experiments, curator] = await Promise.all([
    readFinderResult(workspaceId, now), readOpenItems(workspaceId), readExperiments(workspaceId), readCurator(workspaceId, now),
  ]);
  const stuck = holders ? finder.stuck.filter((item) => item.holder !== null && holders.includes(item.holder)) : finder.stuck;
  const blocks = finder.ownerBlocks;
  const needsYou = open?.map((item) => ({ ...item, blocked: blocks && Object.hasOwn(blocks, item.id) ? blocks[item.id] : null })) ?? null;
  const ageMs = Math.max(0, now - finder.generatedAt);
  return {
    ...finder, workspaceId, stuck: stuck.slice(0, STUCK_LIMIT), stuckTotal: stuck.length, needsYou, experiments, ageMs,
    staleSince: ageMs > FINDER_STALE_MS ? finder.generatedAt : null, curator,
  };
};
