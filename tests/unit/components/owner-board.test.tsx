import fs from 'fs';
import path from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import type { NextRouter } from 'next/router';
import { SWRConfig } from 'swr';
import { describe, expect, it } from 'vitest';
import OwnerBoard, { BOARD_REFRESH_MS, BOARD_URL, OwnerBoardContent, PULSE_URL } from '@/components/features/mission-control/owner-board';
import {
  aedtTime, ageText, barSegments, blockedText, boardItemOf, boardViewOf, defaultWorkspace, sectionAge, stallLabel,
} from '@/components/features/mission-control/board-model';
import { deriveConstraint } from '@/lib/constraint';
import { derivePulse } from '@/lib/pulse';
import { FLOW_LIST_URL } from '@/components/features/mission-control/flow-panel';
import MissionControlPage from '@/pages/mission-control';
import type { IBoard, IMissionBoardListResponse } from '@/types/constraint';
import type { IMissionPulseListResponse, IPulse, IPulseSourceRead } from '@/types/pulse';
import type { ILedgerItem } from '@/types/ledger';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 6, 30, 0);

const item = (key: string, extra: Partial<ILedgerItem> = {}): ILedgerItem => ({
  workspaceId: 'ws-a', itemKey: key, itemType: 'range', openedAt: NOW - 5 * HOUR, closedAt: null, state: null, stateSince: null,
  waitReason: null, waitSince: null, holder: null, clearInput: null, parentKey: null, attrs: {}, lastEventAt: NOW - HOUR, lastSeq: 1, ...extra,
});

const boardOf = (over: Partial<IBoard> = {}, ledger = true): IBoard => ({
  ...deriveConstraint(ledger ? {
    intervals: [], lastProducer: {}, firstEventAt: NOW - 30 * 24 * HOUR, tabWakes: null, ownerIssueSource: null,
    items: [
      item('range:a:1', { waitReason: 'not-armed', waitSince: NOW - 3 * HOUR, holder: 'lane-a', clearInput: 'arm the receipt', attrs: { critical: true } }),
      item('range:b:1', { waitReason: 'owner', waitSince: NOW - 2 * HOUR, holder: 'owner', parentKey: 'mc-item:mc-1' }),
    ],
  } : null, null, null, null, NOW),
  workspaceId: 'ws-a', stuckTotal: 2, ageMs: 0, staleSince: null, experiments: [], curator: null,
  needsYou: [
    { id: 'mc-1', title: 'Pick a port', createdAt: NOW - 5 * HOUR, blocked: { items: 1, hours: 2, critical: false } },
    { id: 'mc-2', title: 'Approve QA', createdAt: NOW - HOUR, blocked: null },
  ],
  ...over,
});

const read = (id: IPulseSourceRead['id'], ats: number[]): IPulseSourceRead => ({ id, events: ats.map((at) => ({ at })), reason: null, from: [] });

const pulseOf = (workspaceId: string, reads: IPulseSourceRead[], count = 1): IPulse => derivePulse({
  workspaceId, now: NOW, reads, oldestStuck: { kind: 'mc-item', id: 'mc-1', label: 'Mission Control: Pick a port', since: NOW - 5 * HOUR },
  wip: { count, basis: 'agent-tabs', basisReason: '1 agent tab working or waiting for input', sources: { ledger: 'no-events', agentTabs: 'measured', missionControl: 'measured' } },
  priority: { basis: 'constraint', needsYou: 2, text: 'not armed to land: owner lane-a, clears when arm the receipt · needs you: 2' },
  staleSince: null,
});

const render = (props: Partial<Parameters<typeof OwnerBoardContent>[0]> = {}) => renderToStaticMarkup(
  <SWRConfig value={{ provider: () => new Map() as never }}>
    <OwnerBoardContent
      pulses={{ pulses: [pulseOf('ws-a', [read('commits', [NOW - 4 * HOUR])])] }}
      boards={{ boards: [boardOf()] }}
      pulseError={null} boardError={null} loading={false} names={{ 'ws-a': 'Audit' }} selected={null} onSelect={() => {}} onRetry={() => {}} now={NOW}
      {...props}
    />
  </SWRConfig>,
);

describe('board model', () => {
  it('?view=board is the default; ?item= opens the answers view on that item', () => {
    expect(boardViewOf({})).toBe('board');
    expect(boardViewOf({ view: 'board' })).toBe('board');
    expect(boardViewOf({ view: 'answers' })).toBe('answers');
    expect(boardViewOf({ view: 'portfolio' })).toBe('portfolio');
    expect(boardViewOf({ view: 'constructor' })).toBe('board');
    expect(boardViewOf({ item: 'mc-1' })).toBe('answers');
    expect(boardItemOf({ item: ['mc-1', 'mc-2'] })).toBe('mc-1');
  });

  it('times in AEDT, ages, section freshness and stale words', () => {
    expect(aedtTime(NOW)).toBe('Tue 3 Nov 17:30 AEDT');
    expect(aedtTime(Date.UTC(2026, 5, 3, 6, 30))).toBe('Wed 3 June 16:30 AEST');
    expect([ageText(59_000), ageText(3 * HOUR + 5 * 60_000), ageText(50 * HOUR)]).toEqual(['0m', '3h 05m', '2d 2h']);
    expect(sectionAge(NOW - 90_000, null, NOW)).toEqual({ text: 'updated 1m ago', stale: false });
    expect(sectionAge(NOW - 9 * 60_000, NOW - 9 * 60_000, NOW)).toEqual({ text: 'stale since Tue 3 Nov 17:21 AEDT', stale: true });
    expect(sectionAge(null, null, NOW).text).toBe('not measured');
  });

  it('labels are prototype-safe with a neutral fallback; blocked text says not measured, never 0', () => {
    expect(stallLabel('stalled')).toEqual({ word: 'No movement', tone: 'red' });
    expect(stallLabel('toString')).toEqual({ word: 'State not in the label map', tone: 'dashed' });
    expect(blockedText(null)).toBe('no ledger item links to this item');
    expect(blockedText(null, 'ledger unreadable')).toBe('blocked cost not measured: ledger unreadable');
    expect(blockedText({ items: 1, hours: 2, critical: false }, 'ledger unreadable')).toBe('blocked cost not measured: ledger unreadable');
    expect(blockedText({ items: 2, hours: 4.5, critical: true })).toBe('blocks 2 items · 4.5 h waiting · critical path');
  });

  it('bars stack failed and passed gates under the other movement; the board opens on a stalled workspace', () => {
    expect(barSegments({ start: 0, total: 4, bySource: {}, gatesFailed: 1, gatesPassed: 1 }, 8)).toEqual({ failed: 12.5, passed: 12.5, other: 25 });
    const moving = pulseOf('ws-b', [read('commits', [NOW - 60_000])]);
    const stalled = pulseOf('ws-c', [read('commits', [NOW - 5 * HOUR])]);
    expect(defaultWorkspace([moving, stalled])).toBe('ws-c');
    expect(defaultWorkspace([moving])).toBe('ws-b');
    expect(defaultWorkspace([])).toBeNull();
  });
});

describe('owner board view (AC 2, 3, 4, 7, 10)', () => {
  it('an experiment line says "extended once" only after its one extension (story 22)', () => {
    const experiment = {
      workspaceId: 'ws-a', id: 'EXP-1', itemKey: 'experiment:EXP-1', hypothesis: 'one gate outside the lock', changeRef: null,
      stage: 'land' as const, reason: null, metric: 'lock-hours', baseline: null, target: null, guards: [], revertIf: null,
      minDays: 3, maxDays: 7, startedAt: NOW - 2 * 24 * HOUR, verdict: null, verdictAt: null, evidence: null,
      extendedAt: null, extensionDays: null, extensionEvidence: null,
    };
    const line = (html: string) => html.slice(html.indexOf('data-experiment="EXP-1"'), html.indexOf('</li>', html.indexOf('data-experiment="EXP-1"')));
    const plain = line(render({ boards: { boards: [boardOf({ experiments: [experiment] })] } }));
    expect(plain).toContain('ends by day 7');
    expect(plain).not.toContain('extended once');
    const extended = { ...experiment, maxDays: 10, extendedAt: NOW - HOUR, extensionDays: 3, extensionEvidence: 'noisy' };
    const after = line(render({ boards: { boards: [boardOf({ experiments: [extended] })] } }));
    expect(after).toContain('ends by day 10');
    expect(after).toContain('extended once, by 3 days');
  });

  it('the pulse comes first, then the sections in ADR-HFL-02 order', () => {
    const html = render();
    const order = ['pulse', 'on-track', 'constraint', 'needs-you', 'stuck', 'flow', 'experiments', 'seats', 'pool']
      .map((id) => html.indexOf(`data-board-section="${id}"`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('the pulse row: 48 bars, a red stall cap with the hours, the reason naming the oldest stuck item, priority now, source chips', () => {
    const html = render();
    expect(html.match(/data-pulse-hour=/g)).toHaveLength(48);
    expect(html).toContain('data-stall="stalled"');
    expect(html).toContain('data-stall="stalled">No movement for 4 h<');
    expect(html).toContain('no movement for 4 h · oldest stuck: Mission Control: Pick a port');
    expect(html).toContain('Priority now: </span>not armed to land: owner lane-a, clears when arm the receipt · needs you: 2');
    expect(html).toContain('data-source="commits" data-source-state="ok"');
    expect(html).toMatch(/data-source="gates" data-source-state="unknown"[^>]*>Gates: not measured \(no reader\)/);
    expect(html).toContain('role="img" aria-label="Audit: 1 movement events in 48 hours; no movement: no movement for 4 h');
  });

  it('a pulse with no source read shows no bars, only "not measured"', () => {
    const html = render({ pulses: { pulses: [pulseOf('ws-a', [])] } });
    expect(html).not.toContain('data-pulse-hour=');
    expect(html).toContain('Movement not measured: no source could be read');
    expect(html).toContain('data-stall="not-measured"');
  });

  it('needs you: each row with what it blocks, or not measured, and a link to its answer card; no acting button (AC 3, 4)', () => {
    const html = render();
    expect(html).toContain('blocks 1 item · 2.0 h waiting');
    expect(html).toContain('data-blocked="unlinked">no ledger item links to this item<');
    expect(html).toContain('href="/mission-control?view=answers&amp;item=mc-1"');
    expect(html).toContain('aria-label="Open the answer card for Pick a port"');
    const sections = html.slice(html.indexOf('data-board-section="on-track"'), html.indexOf('data-board-section="flow"'));
    expect(sections).not.toMatch(/<button/);
  });

  it('an unmeasured ledger says why the blocked cost is not measured, apart from "nothing links" (round 2, F8)', () => {
    const html = render({ boards: { boards: [boardOf({}, false)] } });
    expect(html.match(/blocked cost not measured: ledger unreadable/g)).toHaveLength(2);
    expect(html).not.toContain('no ledger item links to this item');
  });

  it('an unreadable goal says goal not measured, never "No goal set" (round 2, F7)', () => {
    const html = render({ boards: { boards: [boardOf({
      onTrack: { state: 'at-risk', goal: null, goalState: 'unknown', itemsLeft: null, p50At: null, p90At: null, throughputPerDay: null, reason: 'goal not measured: EACCES' },
    })] } });
    expect(html).toContain('Goal goal not measured: EACCES.');
    expect(html).not.toContain('No goal set');
  });

  it('the pulse header turns amber "stale since <time>" once an answer is older than 120 s (round 2, F5)', () => {
    const old = pulseOf('ws-a', [read('commits', [NOW - 4 * HOUR])]);
    const html = render({ pulses: { pulses: [{ ...old, generatedAt: NOW - 3 * 60_000 }] } });
    expect(html).toMatch(/text-ui-amber" data-section-age="true"><svg[^>]*>.*?<\/svg>stale since Tue 3 Nov 17:27 AEDT/);
    expect(render()).toContain('updated 0m ago');
  });

  it('a shared source is a dashed chip naming the workspaces, marked not counted (round 2, F1)', () => {
    const shared = derivePulse({ ...{ workspaceId: 'ws-a', now: NOW, oldestStuck: null, staleSince: null,
      wip: { count: 0, basis: 'agent-tabs' as const, basisReason: 'x', sources: { ledger: 'no-events' as const, agentTabs: 'measured' as const, missionControl: 'measured' as const } },
      priority: { basis: 'none' as const, needsYou: 0, text: 'x' } },
      reads: [read('commits', [NOW - HOUR]), { ...read('gates', [NOW - HOUR]), sharedWith: ['Audit', 'V1'] }] });
    expect(render({ pulses: { pulses: [shared] } })).toContain('data-source-state="shared"');
    expect(render({ pulses: { pulses: [shared] } })).toContain('Gates shared with Audit, V1: 1 (not counted)');
  });

  it('constraint and stuck: owner, clear input, critical marked in words', () => {
    const html = render();
    expect(html).toContain('not armed to land');
    expect(html).toContain('Owner seat: </span>lane-a');
    expect(html).toContain('Clears when: </span>arm the receipt');
    expect(html).toMatch(/data-stuck="range:a:1"[\s\S]*?critical<\/span>/);
  });

  it('an unmeasured ledger says not measured with its reason in every ledger section, never 0 or empty', () => {
    const html = render({ boards: { boards: [boardOf({}, false)] } });
    expect(html).toContain('Constraint not measured: ledger unreadable.');
    expect(html).toContain('Stuck items not measured: ledger unreadable.');
    expect(html).toContain('Flow by stage not measured: ledger unreadable.');
  });

  it('no goal says so; a goal shows p50 and p90 in AEDT (AC 5)', () => {
    expect(render()).toContain('No goal set.');
    const html = render({ boards: { boards: [boardOf({
      onTrack: { state: 'on-track', goal: 'Walking skeleton', goalState: 'set', itemsLeft: 3, p50At: NOW + 24 * HOUR, p90At: NOW + 48 * HOUR, throughputPerDay: [1, 2, 1], reason: null },
    })] } });
    expect(html).toContain('Walking skeleton');
    expect(html).toContain('p50: </span>Wed 4 Nov 17:30 AEDT');
    expect(html).toContain('p90: </span>Thu 5 Nov 17:30 AEDT');
    expect(html).toContain('data-on-track="on-track">Forecast (no due date set)<');
    expect(html).not.toMatch(/data-on-track="on-track">On track</);
  });

  it('each section shows its data age; a stale finder answer says "stale since <time>" in every ledger section (AC 7)', () => {
    const fresh = render();
    expect(fresh.match(/data-section-age/g)?.length).toBeGreaterThanOrEqual(9);
    const stale = render({ boards: { boards: [boardOf({ generatedAt: NOW - 10 * 60_000, staleSince: NOW - 10 * 60_000 })] } });
    expect(stale.match(/stale since Tue 3 Nov 17:20 AEDT/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('the pool and spend parts say not measured until their producers land', () => {
    const html = render();
    expect(html).toContain('Not measured: no pool published.');
    expect(html).toContain('Cost per day per seat: not measured (spend by seat and phase lands with story 04).');
  });

  it('a failed first load is an alert with Retry; a failed refresh keeps the last answer', () => {
    expect(render({ pulses: undefined, boards: undefined, pulseError: 'HTTP 502', boardError: 'HTTP 502' })).toContain('The pulse could not load: HTTP 502.');
    const kept = render({ pulseError: 'HTTP 502' });
    expect(kept).toContain('Live refresh failed: HTTP 502. Showing the last answer.');
    expect(kept).toContain('data-pulse-hour=');
  });

  it('loading shows skeletons with a screen-reader sentence, never an empty board', () => {
    const html = render({ pulses: undefined, boards: undefined, loading: true });
    expect(html).toContain('Loading the pulse…');
    expect(html).toContain('Loading the board…');
    expect(html).not.toContain('data-board-section="on-track"');
  });

  it('polls both reads every 30 s while visible (AC 8)', () => {
    expect(BOARD_REFRESH_MS).toBe(30_000);
    expect([PULSE_URL, BOARD_URL]).toEqual(['/api/mission-control/pulse?workspaceId=all', '/api/mission-control/board?workspaceId=all']);
    const source = fs.readFileSync(path.resolve(__dirname, '../../../src/components/features/mission-control/owner-board.tsx'), 'utf-8');
    expect(source).toMatch(/refreshInterval: BOARD_REFRESH_MS, refreshWhenHidden: false/);
    expect(source).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/);
  });

  it('one column below 600 px: the sections grid splits only from 600 px (AC 8)', () => {
    expect(render()).toContain('grid min-w-0 gap-4 min-[600px]:grid-cols-2');
  });
});

describe('Mission Control views (AC 1, AC 6)', () => {
  const page = (query: Record<string, string>, fallback: Record<string, unknown> = {}) => {
    const router = { pathname: '/mission-control', asPath: '/mission-control', query, push: async () => true } as unknown as NextRouter;
    return renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map() as never, fallback }}>
        <RouterContext.Provider value={router}><MissionControlPage /></RouterContext.Provider>
      </SWRConfig>,
    );
  };
  const data = {
    [PULSE_URL]: { pulses: [pulseOf('ws-a', [read('commits', [NOW - 60_000])])] } satisfies IMissionPulseListResponse,
    [BOARD_URL]: { boards: [boardOf()] } satisfies IMissionBoardListResponse,
    [FLOW_LIST_URL]: { workspaces: [], errors: [{ workspaceId: 'ws-a', error: 'flow-unreadable' }] },
  };

  it('the default view is the board; the answer list is one tap away', () => {
    const html = page({}, data);
    expect(html).toContain('data-owner-board');
    expect(html).not.toContain('id="needs-you-heading"');
    expect(html).toContain('href="/mission-control?view=answers"');
    expect(html).toMatch(/aria-current="page"[^>]*data-view-link="board"/);
  });

  it('the flow panel and the burndown live in the board\'s flow section and the spend tile in seats; no other view shows them', () => {
    const html = page({}, data);
    const flow = html.slice(html.indexOf('data-board-section="flow"'), html.indexOf('data-board-section="experiments"'));
    expect(flow).toContain('aria-label="Flow"');
    expect(flow).toContain('Flow record not measured: no flow record published.');
    expect(flow).toMatch(/[Bb]urndown/);
    const seats = html.slice(html.indexOf('data-board-section="seats"'), html.indexOf('data-board-section="pool"'));
    expect(seats).toMatch(/[Ss]pend/);
    for (const view of ['answers', 'portfolio']) {
      const other = page({ view }, { [FLOW_LIST_URL]: data[FLOW_LIST_URL] });
      expect(other).not.toContain('aria-label="Flow"');
      expect(other).not.toMatch(/[Bb]urndown/);
      expect(other).not.toContain('data-board-section');
    }
  });

  it('?item=<id> opens the answers view', () => {
    const html = page({ item: 'mc-1' });
    expect(html).toContain('id="needs-you-heading"');
    expect(html).toMatch(/aria-current="page"[^>]*data-view-link="answers"/);
  });

  it('OwnerBoard renders from the SWR cache with no request of its own in the markup', () => {
    const html = renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map() as never, fallback: data }}><OwnerBoard /></SWRConfig>,
    );
    expect(html).toContain('data-board="ws-a"');
  });
});

describe('the curator section (story 16 AC 8)', () => {
  const tasks = (state: 'shadow' | 'routing', routingHere = false) => (['classify-owner-message', 'flag-owner-question', 'match-standing-order'] as const)
    .map((task) => ({ task, state, routingHere, promptVersion: 'v1', shadowSince: NOW - HOUR, shadowEndsAt: NOW + 71 * HOUR, promotedAt: null, promotedPromptVersion: null }));
  const boardWith = (curator: IBoard['curator']) => render({ boards: { boards: [boardOf({ curator })] } });

  it('says "Curator down" with the reason and the time, and that the rules route', () => {
    const html = boardWith({ health: { state: 'down', reason: 'tunnel (connect ECONNREFUSED)', since: NOW - HOUR, checkedAt: NOW }, tasks: tasks('shadow'), agreement: [] });
    expect(html).toContain('data-board-section="curator"');
    expect(html).toContain('data-curator-health="down"');
    expect(html).toContain('Curator down: tunnel (connect ECONNREFUSED) since Tue 3 Nov 16:30 AEDT. The rules route; nothing waits.');
  });

  it('up: each task in its own words with its shadow end and agreement; never a wire token', () => {
    const html = boardWith({
      health: { state: 'up', reason: null, since: NOW - HOUR, checkedAt: NOW - 30_000 }, tasks: tasks('shadow'),
      agreement: [{ task: 'classify-owner-message', calls: 5, compared: 4, agreed: 3 }],
    });
    expect(html).toContain('data-curator-health="up"');
    expect(html).toContain('Owner message class: shadow (labels logged, nothing routed) · 72 h shadow ends Fri 6 Nov 16:30 AEDT · 3 of 4 labels agree with the rules (72 h)');
    expect(html).toContain('Unmarked question flag: shadow (labels logged, nothing routed) · 72 h shadow ends Fri 6 Nov 16:30 AEDT · no labelled calls in 72 h');
    expect(html).not.toMatch(/>[^<]*classify-owner-message/);
  });

  it('a routing task not opted in here says so; unread agreement and an unread curator are "not measured"', () => {
    expect(boardWith({ health: { state: 'unknown', reason: null, since: null, checkedAt: null }, tasks: tasks('routing'), agreement: null }))
      .toContain('Standing-order match: routing, not opted in here · agreement not measured');
    const fresh = tasks('shadow').map((t) => ({ ...t, shadowSince: null, shadowEndsAt: null }));
    expect(boardWith({ health: { state: 'up', reason: null, since: 1, checkedAt: null }, tasks: fresh, agreement: [] }))
      .toContain('Owner message class: shadow (labels logged, nothing routed) · no live call of this prompt yet · no labelled calls in 72 h');
    expect(boardWith({ health: { state: 'unknown', reason: null, since: null, checkedAt: null }, tasks: tasks('routing', true), agreement: [] }))
      .toContain('Curator not probed yet.');
    expect(boardWith(null)).toContain('Not measured: curator state unreadable.');
  });

  it('the question reshape names its gate instead of a rules agreement it does not have (story 23)', () => {
    const reshape = { ...tasks('shadow')[0], task: 'reshape-question' as const };
    expect(boardWith({ health: { state: 'up', reason: null, since: 1, checkedAt: null }, tasks: [reshape], agreement: [] }))
      .toContain('Question reshape: shadow (labels logged, nothing routed) · 72 h shadow ends Fri 6 Nov 16:30 AEDT · gated by its evaluation and judge, not by agreement');
  });
});
