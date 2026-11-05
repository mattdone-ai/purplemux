import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('@/lib/layout-store', () => ({ resolveLayoutDir: (wsId: string) => path.join(home.dir, 'workspaces', wsId) }));

const { BoardGoalStoreError, clearBoardGoal, goalInputDefects, readBoardGoal, writeBoardGoal } = await import('@/lib/board-goal-store');

beforeEach(async () => {
  home.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-goal-'));
});
afterEach(async () => {
  await fs.rm(home.dir, { recursive: true, force: true });
});

describe('board goal store', () => {
  it('no goal reads null; a written goal reads back; clear removes it', async () => {
    expect(await readBoardGoal('ws-a')).toBeNull();
    const goal = await writeBoardGoal('ws-a', { label: ' Walking skeleton ', items: ['range:a:1', 'slice:b', 'range:a:1'] }, 'orch', 1_000);
    expect(goal).toEqual({ label: 'Walking skeleton', items: ['range:a:1', 'slice:b'], setAt: 1_000, setBy: 'orch' });
    expect(await readBoardGoal('ws-a')).toEqual(goal);
    expect(await readBoardGoal('ws-b')).toBeNull();
    expect((await fs.stat(path.join(home.dir, 'workspaces', 'ws-a', 'board-goal.json'))).mode & 0o777).toBe(0o600);
    expect(await clearBoardGoal('ws-a')).toBe(true);
    expect(await clearBoardGoal('ws-a')).toBe(false);
    expect(await readBoardGoal('ws-a')).toBeNull();
  });

  it('a file that holds no goal throws: it never reads as "no goal set"', async () => {
    const file = path.join(home.dir, 'workspaces', 'ws-a', 'board-goal.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{not json');
    await expect(readBoardGoal('ws-a')).rejects.toThrow(BoardGoalStoreError);
    await fs.writeFile(file, JSON.stringify({ label: 'x', items: [] }));
    await expect(readBoardGoal('ws-a')).rejects.toThrow('the file does not hold a goal');
  });

  it('every defect names its value and limit', () => {
    expect(goalInputDefects({ label: 'ok', items: ['range:a:1'] })).toEqual([]);
    expect(goalInputDefects({})).toEqual(['label: required, a non-empty string', 'items: required, at least one ledger item key']);
    expect(goalInputDefects({ label: 'x'.repeat(121), items: ['story-3', 'range:a:1'] })).toEqual([
      'label: 121 chars, at most 120',
      expect.stringMatching(/^items\[0\]: saw "story-3", expected <type>:<key> with type one of slice, range/),
    ]);
    expect(goalInputDefects({ label: 'x', items: Array.from({ length: 501 }, (_, i) => `range:a:${i}`) })).toEqual(['items: 501 keys, at most 500']);
  });
});
