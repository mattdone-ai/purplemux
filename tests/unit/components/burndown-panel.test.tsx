import { renderToStaticMarkup } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { describe, expect, it } from 'vitest';
import BurndownPanel, { BurndownChart, BurndownPanelContent, stepPath, tokenDaysInSpan } from '@/components/features/mission-control/burndown-panel';
import { BURNDOWN_STALE_MS } from '@/lib/burndown';
import type { IBurndownEpic, IBurndownHistoryRow, IMissionBurndownResponse } from '@/types/burndown';

const GENERATED = '2026-10-09T22:36:41Z';
const NOW = Date.parse(GENERATED) + 5 * 60_000;

const epic = (slug: string, overrides: Partial<IBurndownEpic> = {}): IBurndownEpic => ({
  slug, name: `${slug} name`, stories: 9, unpointed: 0, total: 16, burned: 8, remaining: 8, pct: 50,
  in_progress: 3, blocked: 0, done_events: [], undated_burned: 8, ...overrides,
});

const row = (slug: string, at: string, remaining: number, total = 16): IBurndownHistoryRow => ({
  at, slug, total, burned: total - remaining, remaining, pct: Math.round(((total - remaining) / total) * 1000) / 10,
  stories: 9, unpointed: 0,
});

const response = (epics: IBurndownEpic[], history: IBurndownHistoryRow[] = [], generatedAt = GENERATED): IMissionBurndownResponse => ({
  workspaceId: 'ws-sm',
  burndown: { workspaceId: 'ws-sm', receivedAt: Date.parse(generatedAt), snapshot: { generated_at: generatedAt, epics, history } },
});

const render = (props: Partial<Parameters<typeof BurndownPanelContent>[0]>) =>
  renderToStaticMarkup(<BurndownPanelContent loading={false} error={null} now={NOW} {...props} />);

describe('burndown panel states', () => {
  it('shows loading, then a read error with retry', () => {
    expect(render({ loading: true })).toContain('Loading burndown');
    const failed = render({ error: 'burndown storage unreadable: the file is not JSON' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('burndown storage unreadable: the file is not JSON');
    expect(failed).toContain('Retry');
  });

  it('renders nothing before a Scrum Master is selected', () => {
    expect(render({ response: { workspaceId: null, burndown: null } })).toBe('');
  });

  it('names the publish command when nothing is published', () => {
    const html = render({ response: { workspaceId: 'ws-sm', burndown: null } });
    expect(html).toContain('No burndown published');
    expect(html).toContain('purplemux burndown publish -w ws-sm --json @burndown.json');
  });

  it('shows one epic with points, bar, counts and a chart', () => {
    const html = render({ response: response([epic('epic-a', { blocked: 1 })], [
      row('epic-a', '2026-10-09T10:00:00Z', 16), row('epic-a', '2026-10-09T16:00:00Z', 12), row('epic-a', GENERATED, 8),
    ]) });
    expect(html).toContain('epic-a name');
    expect(html).toContain('8 / 16 pts');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('8 remaining');
    expect(html).toContain('3 in progress');
    expect(html).toContain('1 blocked');
    expect(html).toContain('text-ui-red');
    expect(html).toContain('Remaining 8 of 16 points across 3 snapshots');
    expect(html).toContain('var(--ui-blue)');
    expect(html).toContain('var(--muted-foreground)');
    expect(html).not.toContain('Stale');
  });

  it('totals the fleet across many epics and hides epics without points', () => {
    const html = render({ response: response([
      epic('epic-a'),
      epic('epic-b', { total: 30, burned: 6, remaining: 24, pct: 20, blocked: 2, in_progress: 1, unpointed: 2 }),
      epic('epic-zero', { total: 0, burned: 0, remaining: 0, pct: 0, undated_burned: 0 }),
    ]) });
    expect(html).toContain('Fleet');
    expect(html).toContain('14 / 46 pts');
    expect(html).toContain('30.4%');
    expect(html).toContain('32 remaining');
    expect(html).toContain('2 epics');
    expect(html).toContain('1 epic without points hidden');
    expect(html).toContain('2 unpointed stories not counted');
    expect(html).not.toContain('epic-zero name');
    expect(html).toContain('No history yet');
  });

  it('says so when every epic lacks points', () => {
    const html = render({ response: response([epic('epic-zero', { total: 0, burned: 0, remaining: 0, pct: 0, undated_burned: 0 })]) });
    expect(html).toContain('No epic in the latest burndown has points');
    expect(html).not.toContain('Fleet');
  });

  it('marks a snapshot older than two hours as stale', () => {
    const fresh = render({ response: response([epic('epic-a')]), now: Date.parse(GENERATED) + BURNDOWN_STALE_MS });
    expect(fresh).not.toContain('Stale');
    const stale = render({ response: response([epic('epic-a')]), now: Date.parse(GENERATED) + BURNDOWN_STALE_MS + 60_000 });
    expect(stale).toContain('Stale');
    expect(stale).toContain('generated 2h 1m ago');
    expect(stale).toContain('text-ui-amber');
  });
});

describe('burndown chart', () => {
  it('draws step lines from the first to the last snapshot', () => {
    expect(stepPath([{ x: 0, y: 10 }, { x: 5, y: 6 }, { x: 9, y: 2 }])).toBe('M0 10H5V6H9V2');
    expect(stepPath([])).toBe('');
  });

  it('puts the endpoint dot on the latest remaining value', () => {
    const html = renderToStaticMarkup(<BurndownChart rows={[row('a', '2026-10-09T10:00:00Z', 16), row('a', GENERATED, 0)]} />);
    expect(html).toMatch(/<circle[^>]*cy="(\d+(\.\d+)?)"/);
    expect(html).toContain('Remaining 0 of 16 points across 2 snapshots');
  });

  it('draws a single snapshot as a dot without lines', () => {
    const html = renderToStaticMarkup(<BurndownChart rows={[row('a', GENERATED, 4)]} />);
    expect(html).toContain('<circle');
    expect(html).toContain('across 1 snapshot');
  });
});

describe('burndown panel through the SWR cache', () => {
  it('renders the cached response', () => {
    const html = renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map(), fallback: { '/api/mission-control/burndown': response([epic('epic-a')]) } }}>
        <BurndownPanel />
      </SWRConfig>,
    );
    expect(html).toContain('epic-a name');
  });
});

describe('burndown chart tokens line', () => {
  const history = [row('a', '2026-10-07T10:00:00Z', 16), row('a', '2026-10-08T10:00:00Z', 12), row('a', GENERATED, 8)];
  const tokens = [
    { day: '2026-10-06', totalTokens: 9_000_000, sidechainTokens: 0, cacheReadTokens: 8_000_000 },
    { day: '2026-10-07', totalTokens: 2_000_000, sidechainTokens: 500_000, cacheReadTokens: 1_000_000 },
    { day: '2026-10-08', totalTokens: 4_000_000, sidechainTokens: 0, cacheReadTokens: 3_000_000 },
    { day: '2026-10-09', totalTokens: 1_000_000, sidechainTokens: 0, cacheReadTokens: 500_000 },
  ];

  it('draws tokens per day on a second axis over the days the chart spans', () => {
    const html = renderToStaticMarkup(<BurndownChart rows={history} tokensByDay={tokens} />);
    expect(html).toContain('data-series="tokens"');
    expect(html).toContain('var(--ui-purple)');
    expect(html).toContain('workspace 7.0M tokens over 3 days, peak 4.0M a day, 4.5M cache reads (64% of tokens)');
    expect(html).toContain('Workspace tokens/day (own scale, peak 4.0M) · 4.5M cache reads (64% of tokens)');
    expect(html).not.toContain('right axis');
    const d = /data-series="tokens" d="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(d.match(/[ML]/g)).toHaveLength(3);
    expect(d).toContain(' 4');
  });

  it('draws the chart as before for a client or server without the field', () => {
    const before = renderToStaticMarkup(<BurndownChart rows={history} />);
    expect(before).not.toContain('data-series="tokens"');
    expect(before).not.toContain('tokens/day');
    expect(renderToStaticMarkup(<BurndownChart rows={history} tokensByDay={[]} />)).toBe(before);
  });

  it('places each overlapping day at its UTC noon, clamped to the span', () => {
    const start = Date.parse('2026-10-07T18:00:00Z');
    const end = Date.parse('2026-10-08T06:00:00Z');
    expect(tokenDaysInSpan(tokens, start, end).map(({ entry, at }) => [entry.day, new Date(at).toISOString()])).toEqual([
      ['2026-10-07', '2026-10-07T18:00:00.000Z'], ['2026-10-08', '2026-10-08T06:00:00.000Z'],
    ]);
  });

  it('passes the served tokens to every epic chart', () => {
    const html = render({ response: { ...response([epic('epic-a')], history.map((r) => ({ ...r, slug: 'epic-a' }))), tokensByDay: tokens } });
    expect(html).toContain('data-series="tokens"');
  });
});
