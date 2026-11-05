import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveConstraint } from '@/lib/constraint';
import type { IFinderResult } from '@/types/constraint';

const NOW = Date.UTC(2026, 10, 3, 6, 0, 0);
const HOUR = 3_600_000;

const mc = vi.hoisted(() => ({ titles: vi.fn() }));
const finder = vi.hoisted(() => ({ result: null as unknown as IFinderResult }));

vi.mock('@/lib/logger', () => {
  const logger = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => logger };
  return { createLogger: () => logger };
});
vi.mock('@/lib/mission-control-store', () => ({ getMissionControlStore: () => ({ openItemTitles: mc.titles }) }));
vi.mock('@/lib/constraint-tick', () => ({ FINDER_STALE_MS: 120_000, readFinderResult: async () => finder.result }));

const { readBoard } = await import('@/lib/board');

beforeEach(() => {
  mc.titles.mockReset();
  finder.result = deriveConstraint({
    intervals: [], lastProducer: {}, firstEventAt: NOW - 30 * 24 * HOUR, tabWakes: null, ownerIssueSource: null,
    items: [
      { workspaceId: 'ws-a', itemKey: 'range:a:1', itemType: 'range', openedAt: NOW - 2 * HOUR, closedAt: null, state: null, stateSince: null,
        waitReason: 'not-armed', waitSince: NOW - 2 * HOUR, holder: 'lane-a', clearInput: null, parentKey: null, attrs: {}, lastEventAt: NOW - 2 * HOUR, lastSeq: 1 },
      { workspaceId: 'ws-a', itemKey: 'range:b:1', itemType: 'range', openedAt: NOW - HOUR, closedAt: null, state: null, stateSince: null,
        waitReason: 'lock-wait', waitSince: NOW - HOUR, holder: 'tab-b', clearInput: null, parentKey: null, attrs: {}, lastEventAt: NOW - HOUR, lastSeq: 2 },
    ],
  }, null, null, null, NOW - 30_000);
});

describe('readBoard', () => {
  it('adds the workspace, the finder age and Mission Control\'s open items', async () => {
    mc.titles.mockReturnValue([{ id: 'mc-1', title: 'Approve the QA deploy', createdAt: NOW - HOUR }]);
    const board = await readBoard('ws-a', NOW);
    expect(board).toMatchObject({
      workspaceId: 'ws-a', ageMs: 30_000, needsYou: [{ id: 'mc-1', title: 'Approve the QA deploy', createdAt: NOW - HOUR, blocked: null }],
    });
    expect(mc.titles).toHaveBeenCalledWith('ws-a');
  });

  it('marks an answer older than two ticks as stale since its generatedAt', async () => {
    mc.titles.mockReturnValue([]);
    expect((await readBoard('ws-a', NOW)).staleSince).toBeNull();
    expect((await readBoard('ws-a', NOW - 30_000 + 120_000)).staleSince).toBeNull();
    const stale = await readBoard('ws-a', NOW - 30_000 + 120_001);
    expect([stale.ageMs, stale.staleSince]).toEqual([120_001, NOW - 30_000]);
  });

  it('shows needs-you as unknown (null), never empty, when Mission Control cannot be read', async () => {
    mc.titles.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });
    const board = await readBoard('ws-a', NOW);
    expect(board.needsYou).toBeNull();
    expect(board.stuck).toHaveLength(2);
  });

  it('caps the stuck list at 50 after the holder filter, and says how many matched (F3)', async () => {
    mc.titles.mockReturnValue([]);
    const items = Array.from({ length: 60 }, (_, i) => ({
      workspaceId: 'ws-a', itemKey: `range:a:${String(i).padStart(12, '0')}`, itemType: 'range' as const, openedAt: NOW - (100 - i) * HOUR,
      closedAt: null, state: null, stateSince: null, waitReason: 'not-armed' as const, waitSince: NOW - (100 - i) * HOUR,
      holder: i >= 50 ? 'tab-me' : 'lane-x', clearInput: null, parentKey: null, attrs: {}, lastEventAt: NOW - HOUR, lastSeq: i,
    }));
    finder.result = deriveConstraint({ intervals: [], lastProducer: {}, firstEventAt: NOW - 30 * 24 * HOUR, tabWakes: null, ownerIssueSource: null, items }, null, null, null, NOW);
    const all = await readBoard('ws-a', NOW);
    expect([all.stuck.length, all.stuckTotal]).toEqual([50, 60]);
    expect(all.stuck[0].key).toBe('range:a:000000000000');
    const mine = await readBoard('ws-a', NOW, ['tab-me']);
    expect([mine.stuck.length, mine.stuckTotal]).toEqual([10, 10]);
    expect(mine.stuck.map((s) => s.key)).toEqual(items.slice(50).map((i) => i.itemKey));
  });

  it('keeps only the holders\' items for --mine, by tab name or id', async () => {
    mc.titles.mockReturnValue([]);
    expect((await readBoard('ws-a', NOW, ['lane-a', 'tab-x'])).stuck.map((s) => s.key)).toEqual(['range:a:1']);
    expect((await readBoard('ws-a', NOW, ['orchestrator', 'tab-b'])).stuck.map((s) => s.key)).toEqual(['range:b:1']);
  });

  it('each needs-you row carries what it blocks from the ledger (AC 3); no link is null, never 0', async () => {
    const owner = (key: string, mcId: string, since: number, attrs = {}) => ({
      workspaceId: 'ws-a', itemKey: key, itemType: 'range' as const, openedAt: since, closedAt: null, state: null, stateSince: null,
      waitReason: 'owner' as const, waitSince: since, holder: 'owner', clearInput: 'answer it', parentKey: `mc-item:${mcId}`, attrs,
      lastEventAt: since, lastSeq: 1,
    });
    finder.result = deriveConstraint({
      intervals: [], lastProducer: {}, firstEventAt: NOW - 30 * 24 * HOUR, tabWakes: null, ownerIssueSource: null,
      items: [
        owner('range:a:1', 'mc-1', NOW - 3 * HOUR), owner('range:b:1', 'mc-1', NOW - 90 * 60_000, { critical: true }),
        owner('range:c:1', 'mc-2', NOW - HOUR), { ...owner('range:d:1', 'mc-1', NOW - HOUR), closedAt: NOW - 1 },
        { ...owner('range:e:1', 'mc-3', NOW - HOUR), waitReason: 'not-armed' as const },
      ],
    }, null, null, null, NOW);
    mc.titles.mockReturnValue([
      { id: 'mc-1', title: 'Pick a port', createdAt: NOW - 4 * HOUR }, { id: 'mc-2', title: 'Approve', createdAt: NOW - 2 * HOUR },
      { id: 'mc-3', title: 'Unlinked', createdAt: NOW - HOUR }, { id: 'constructor', title: 'Prototype-named', createdAt: NOW },
    ]);
    const board = await readBoard('ws-a', NOW);
    expect(board.needsYou?.map((row) => [row.id, row.blocked])).toEqual([
      ['mc-1', { items: 2, hours: 4.5, critical: true }],
      ['mc-2', { items: 1, hours: 1, critical: false }],
      ['mc-3', null],
      ['constructor', null],
    ]);
  });

  it('an unmeasured ledger leaves every row\'s blocked cost null', async () => {
    finder.result = deriveConstraint(null, null, null, null, NOW);
    mc.titles.mockReturnValue([{ id: 'mc-1', title: 'Pick a port', createdAt: NOW }]);
    const board = await readBoard('ws-a', NOW);
    expect(board.ownerBlocks).toBeNull();
    expect(board.needsYou?.[0].blocked).toBeNull();
  });
});

