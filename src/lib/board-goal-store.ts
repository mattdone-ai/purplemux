import fs from 'fs/promises';
import path from 'path';
import { resolveLayoutDir } from '@/lib/layout-store';
import { LEDGER_ITEM_TYPES } from '@/lib/ledger';
import type { IBoardGoal } from '@/types/constraint';

// The workspace's goal (ADR-0034 §10, `purplemux board goal set`): one file per workspace beside
// its flow and burndown records. The finder reads it on each tick; a set or clear drops the cached answer.

export const GOAL_LABEL_MAX = 120;
export const GOAL_ITEMS_MAX = 500;

export class BoardGoalStoreError extends Error {}

const g = globalThis as unknown as { __ptBoardGoalLocks?: Map<string, Promise<void>> };
if (!g.__ptBoardGoalLocks) g.__ptBoardGoalLocks = new Map();

const withLock = async <T>(wsId: string, fn: () => Promise<T>): Promise<T> => {
  const locks = g.__ptBoardGoalLocks!;
  let release: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prev = locks.get(wsId) ?? Promise.resolve();
  locks.set(wsId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release!();
    if (locks.get(wsId) === next) locks.delete(wsId);
  }
};

const goalPath = (wsId: string): string => path.join(resolveLayoutDir(wsId), 'board-goal.json');

const KEY_PATTERN = new RegExp(`^(${LEDGER_ITEM_TYPES.join('|')}):\\S+$`);

/** Every defect of a `board goal set` body, each with the value it measured and the limit; empty when valid. */
export const goalInputDefects = (body: unknown): string[] => {
  const input = (body ?? {}) as { label?: unknown; items?: unknown };
  const defects: string[] = [];
  if (typeof input.label !== 'string' || !input.label.trim()) defects.push('label: required, a non-empty string');
  else if (input.label.trim().length > GOAL_LABEL_MAX) defects.push(`label: ${input.label.trim().length} chars, at most ${GOAL_LABEL_MAX}`);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    defects.push('items: required, at least one ledger item key');
  } else {
    if (input.items.length > GOAL_ITEMS_MAX) defects.push(`items: ${input.items.length} keys, at most ${GOAL_ITEMS_MAX}`);
    input.items.forEach((key, i) => {
      if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
        defects.push(`items[${i}]: saw ${JSON.stringify(key)}, expected <type>:<key> with type one of ${LEDGER_ITEM_TYPES.join(', ')}`);
      }
    });
  }
  return defects;
};

const isGoal = (value: unknown): value is IBoardGoal => {
  const goal = value as IBoardGoal | null;
  return Boolean(goal) && goalInputDefects(goal).length === 0 && Number.isSafeInteger(goal!.setAt) && typeof goal!.setBy === 'string';
};

/** The workspace's goal, or null when none is set. A file that does not hold a goal throws: hiding it would read as "no goal". */
export const readBoardGoal = async (wsId: string): Promise<IBoardGoal | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(goalPath(wsId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BoardGoalStoreError(`goal storage unreadable: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BoardGoalStoreError('goal storage unreadable: the file is not JSON');
  }
  if (!isGoal(parsed)) throw new BoardGoalStoreError('goal storage unreadable: the file does not hold a goal');
  return parsed;
};

/** Replace the workspace's goal; keys are kept in the order given, duplicates once. */
export const writeBoardGoal = async (wsId: string, input: { label: string; items: string[] }, setBy: string, now: number): Promise<IBoardGoal> =>
  withLock(wsId, async () => {
    const goal: IBoardGoal = { label: input.label.trim(), items: [...new Set(input.items)], setAt: now, setBy };
    const filePath = goalPath(wsId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpFile = `${filePath}.tmp`;
    try {
      await fs.writeFile(tmpFile, JSON.stringify(goal), { mode: 0o600 });
      await fs.rename(tmpFile, filePath);
    } catch (err) {
      await fs.unlink(tmpFile).catch(() => {});
      throw err;
    }
    return goal;
  });

/** Clear the goal; true when one was set. */
export const clearBoardGoal = async (wsId: string): Promise<boolean> =>
  withLock(wsId, async () => fs.unlink(goalPath(wsId)).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }));
