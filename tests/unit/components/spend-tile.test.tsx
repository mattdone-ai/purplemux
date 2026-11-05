import { renderToStaticMarkup } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { describe, expect, it } from 'vitest';
import SpendTile, { SpendTileContent, spendTileScope, spendUrl } from '@/components/features/mission-control/spend-tile';
import type { ISpendRow, ISpendView } from '@/types/spend';

const spendRow = (key: string, overrides: Partial<ISpendRow> = {}): ISpendRow => ({
  key, label: `${key} name`, providerId: 'claude', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2_000_000,
  cacheCreationTokens: 3000, totalTokens: 2_004_500, sidechainTokens: 0, costUsd: 1.25, unpricedTokens: 0, cacheReadCostUsd: null, ...overrides,
});

const view = (overrides: Partial<ISpendView> = {}): ISpendView => ({
  workspaceId: 'all', from: '2026-10-20', to: '2026-10-26', by: 'tab', generatedAt: 1,
  totals: spendRow('total', { label: 'Total', totalTokens: 12_400_000, sidechainTokens: 3_100_000, costUsd: 42.5, cacheReadCostUsd: 17 }),
  rows: ['tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5', 'tab-6'].map((key) => spendRow(key)),
  unattributed: spendRow('unattributed', { label: 'Not bound to a tab', totalTokens: 900_000 }),
  dayBasis: { claude: 'message', codex: 'session-start', grok: 'session-start' },
  index: { state: 'ready', filesIndexed: 10, filesTotal: 10, indexedThrough: Date.parse('2026-10-26T10:00:00Z') },
  ...overrides,
});

const WORKSPACES = [{ id: 'ws-a', name: 'Alpha' }];

const render = (props: Partial<Parameters<typeof SpendTileContent>[0]>) =>
  renderToStaticMarkup(<SpendTileContent workspaceId="all" workspaces={WORKSPACES} loading={false} error={null} {...props} />);

describe('spend tile', () => {
  it('shows today and 7 days in tokens and estimated cost, and the top 5 tabs', () => {
    const html = render({ today: view({ totals: spendRow('total', { totalTokens: 2_000_000, cacheReadTokens: 2_000_000, costUsd: 3.2 }) }), week: view() });
    expect(html).toContain('Today (UTC)');
    expect(html).toContain('2.0M');
    expect(html).toContain('est. $3.20');
    expect(html).toContain('Last 7 days');
    expect(html).toContain('12.4M');
    expect(html).toContain('est. $42.50');
    expect(html).toContain('3.1M by subagents');
    expect(html).toContain('2.0M cache reads (16% of tokens, est. 40% of cost)');
    expect(html).toContain('2.0M cache reads (100% of tokens)</p>');
    expect(html).toContain('tab-5 name');
    expect(html).not.toContain('tab-6 name');
    expect(html).toContain('Not bound to a tab: 900.0K tokens');
    expect(html).not.toContain('Partial');
  });

  it('renders an unknown cost as — and never $0, and names unpriced tokens', () => {
    const week = view({ totals: spendRow('total', { costUsd: null, unpricedTokens: 2_004_500 }),
      rows: [spendRow('tab-1', { costUsd: 0.5, unpricedTokens: 4000 })], unattributed: null });
    const html = render({ today: week, week });
    expect(html).toContain('— <span>est. cost not known</span>');
    expect(html).not.toContain('$0.0000');
    expect(html).toContain('est. $0.500');
    expect(html).toContain('4.0K tokens without a price');
    expect(html).not.toContain('Not bound to a tab');
  });

  it('shows no cache-read share for a period with no tokens, never 0%', () => {
    const empty = view({ totals: spendRow('total', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 0, costUsd: null }), rows: [], unattributed: null });
    const html = render({ today: empty, week: view() });
    expect(html).toContain('0 cache reads</p>');
    expect(html).not.toContain('0 cache reads (');
  });

  it('marks the numbers partial while the index builds', () => {
    const week = view({ index: { state: 'indexing', filesIndexed: 12, filesTotal: 300, indexedThrough: null } });
    const html = render({ today: week, week });
    expect(html).toContain('Partial · indexing 12 of 300 files');
    expect(html).not.toContain('Indexed through');
  });

  it('shows an unavailable index as a refusal, not as numbers', () => {
    const week = view({ index: { state: 'unavailable', filesIndexed: 0, filesTotal: 0, indexedThrough: null, error: 'spend-index.json unreadable: EACCES' } });
    const html = render({ today: week, week });
    expect(html).toContain('Spend not available: spend-index.json unreadable: EACCES');
    expect(html).not.toContain('Last 7 days');
  });

  it('labels an unknown index state and an unknown provider with the served value', () => {
    const week = view({ index: { state: 'paused' as never, filesIndexed: 0, filesTotal: 0, indexedThrough: null },
      rows: [spendRow('tab-1', { providerId: 'gemini' as never }), spendRow('tab-2', { providerId: null }), spendRow('tab-3', { providerId: 'toString' as never })] });
    const html = render({ today: week, week });
    expect(html).toContain('Spend index state not recognised (paused)');
    expect(html).toContain('Other agent (gemini)');
    expect(html).toContain('Mixed');
    expect(html).toContain('Other agent (toString)');
  });

  it('shows the binding error the server served', () => {
    const week = view({ index: { state: 'ready', filesIndexed: 1, filesTotal: 1, indexedThrough: 1, error: 'session-tabs.json unreadable: the file is not JSON; no usage is attributed to a tab' } });
    expect(render({ today: week, week })).toContain('no usage is attributed to a tab');
  });

  it('says so when no usage is bound to a tab', () => {
    const week = view({ rows: [] });
    expect(render({ today: week, week })).toContain('No usage is bound to a tab in this period.');
  });

  it('shows loading, then a read error with retry', () => {
    expect(render({ loading: true })).toContain('Loading spend');
    const failed = render({ error: 'Invalid spend request: by: saw "x"' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Spend unavailable: Invalid spend request: by: saw &quot;x&quot;');
    expect(failed).toContain('Retry');
  });

  it('keeps the last data after a failed refresh, marked stale with the served error and a retry', () => {
    const html = render({ today: view(), week: view(), error: 'Mission Control storage unavailable' });
    expect(html).toContain('Stale: refresh failed (Mission Control storage unavailable). Showing the last spend read.');
    expect(html).toContain('Retry');
    expect(html).toContain('12.4M');
    expect(render({ today: view(), week: view() })).not.toContain('Stale');
  });

  it('opens on the selected workspace, and on all workspaces only with no selection', () => {
    const all = [{ id: 'ws-sm', name: 'Scrum' }, { id: 'ws-a', name: 'Alpha' }, { id: 'ws-x', name: 'Other' }];
    expect(spendTileScope({ managerWorkspaceId: 'ws-sm', workspaceIds: ['ws-a'] }, all)).toEqual({
      initialWorkspaceId: 'ws-sm', workspaces: [{ id: 'ws-sm', name: 'Scrum' }, { id: 'ws-a', name: 'Alpha' }],
    });
    expect(spendTileScope(null, all)).toEqual({ initialWorkspaceId: 'all', workspaces: all });
    expect(spendTileScope({ managerWorkspaceId: 'ws-gone', workspaceIds: ['ws-a'] }, all).initialWorkspaceId).toBe('all');
    const html = renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map(), fallback: {} }}><SpendTile workspaces={all} initialWorkspaceId="ws-sm" /></SWRConfig>,
    );
    expect(html).toContain('<option value="ws-sm" selected="">Scrum</option>');
  });

  it('offers every workspace and each managed one', () => {
    const html = render({ workspaceId: 'ws-a', today: view(), week: view() });
    expect(html).toContain('<option value="all">All workspaces</option>');
    expect(html).toContain('<option value="ws-a" selected="">Alpha</option>');
  });

  it('reads today and 7 days by tab through SWR', () => {
    expect(spendUrl('ws-a', 'today')).toBe('/api/mission-control/spend?workspaceId=ws-a&period=today&by=tab');
    const html = renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map(), fallback: {
        [spendUrl('all', 'today')]: view({ totals: spendRow('total', { totalTokens: 1_000 }) }),
        [spendUrl('all', '7d')]: view(),
      } }}>
        <SpendTile workspaces={WORKSPACES} />
      </SWRConfig>,
    );
    expect(html).toContain('12.4M');
    expect(html).toContain('1.0K <span');
  });
});
