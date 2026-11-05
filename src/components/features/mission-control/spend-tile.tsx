import { useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import dayjs from 'dayjs';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatCost, formatTokenCount } from '@/lib/claude-tokens';
import { formatCacheReads } from '@/lib/spend/spend-model';
import type { ISpendRow, ISpendView } from '@/types/spend';

const SPEND_URL = '/api/mission-control/spend';
const REFRESH_MS = 60_000;
const TOP_TABS = 5;
export const ALL_WORKSPACES = 'all';

const PROVIDER_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };

const providerLabel = (providerId: ISpendRow['providerId']): string => {
  if (providerId === null) return 'Mixed';
  return Object.hasOwn(PROVIDER_LABELS, providerId) ? PROVIDER_LABELS[providerId] : `Other agent (${providerId})`;
};

export interface ISpendWorkspaceOption {
  id: string;
  name: string;
}

interface IPortfolioSelectionRef {
  managerWorkspaceId: string;
  workspaceIds: string[];
}

/**
 * The portfolio board's tile: its options are the manager's and the managed workspaces, and it
 * opens on the selected (manager) workspace; "All workspaces" is the default only with no selection.
 */
export const spendTileScope = (
  selection: IPortfolioSelectionRef | null | undefined,
  workspaces: ISpendWorkspaceOption[],
): { workspaces: ISpendWorkspaceOption[]; initialWorkspaceId: string } => {
  if (!selection) return { workspaces, initialWorkspaceId: ALL_WORKSPACES };
  const options = workspaces.filter((workspace) => workspace.id === selection.managerWorkspaceId
    || selection.workspaceIds.includes(workspace.id)).map(({ id, name }) => ({ id, name }));
  const selected = options.some((workspace) => workspace.id === selection.managerWorkspaceId);
  return { workspaces: options, initialWorkspaceId: selected ? selection.managerWorkspaceId : ALL_WORKSPACES };
};

const readSpend = async (url: string): Promise<ISpendView> => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || response.statusText || 'Spend unavailable');
  }
  return response.json() as Promise<ISpendView>;
};

export const spendUrl = (workspaceId: string, period: 'today' | '7d'): string =>
  `${SPEND_URL}?${new URLSearchParams({ workspaceId, period, by: 'tab' })}`;

const Cost = ({ row }: { row: ISpendRow }) => (
  <span className="text-xs text-muted-foreground">
    {row.costUsd === null ? <>— <span>est. cost not known</span></> : <>est. {formatCost(row.costUsd)}</>}
    {row.unpricedTokens > 0 && row.costUsd !== null && <> · {formatTokenCount(row.unpricedTokens)} tokens without a price</>}
  </span>
);

const Figure = ({ title, view }: { title: string; view: ISpendView }) => (
  <div className="min-w-0 space-y-0.5">
    <p className="text-xs text-muted-foreground">{title}</p>
    <p className="text-xl font-semibold">{formatTokenCount(view.totals.totalTokens)} <span className="text-sm font-normal text-muted-foreground">tokens</span></p>
    <Cost row={view.totals} />
    <p className="text-xs text-muted-foreground">{formatCacheReads(view.totals)}</p>
    {view.totals.sidechainTokens > 0 && <p className="text-xs text-muted-foreground">{formatTokenCount(view.totals.sidechainTokens)} by subagents</p>}
  </div>
);

const indexNote = (view: ISpendView): string | null => {
  const { index } = view;
  if (index.state === 'ready') return null;
  if (index.state === 'indexing') return `Partial · indexing ${index.filesIndexed} of ${index.filesTotal} files`;
  return `Spend index state not recognised (${String(index.state)})`;
};

interface ISpendTileContentProps {
  workspaceId: string;
  workspaces: ISpendWorkspaceOption[];
  today?: ISpendView;
  week?: ISpendView;
  loading: boolean;
  error: string | null;
  onWorkspaceChange?: (workspaceId: string) => void;
  onRetry?: () => void;
}

export const SpendTileContent = ({ workspaceId, workspaces, today, week, loading, error, onWorkspaceChange, onRetry }: ISpendTileContentProps) => {
  let body;
  if ((!today || !week) && error) {
    body = (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-ui-red/30 bg-ui-red/5 p-3 text-sm text-ui-red">
        <span>Spend unavailable: {error}</span>
        <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry</Button>
      </div>
    );
  } else if (!today || !week) {
    body = <p className="text-sm text-muted-foreground">{loading ? 'Loading spend…' : 'Spend not loaded'}</p>;
  } else if (week.index.state === 'unavailable') {
    body = <p role="alert" className="text-sm text-ui-red">Spend not available: {week.index.error ?? 'the spend index cannot be read'}</p>;
  } else {
    const note = indexNote(week);
    const tabs = week.rows.slice(0, TOP_TABS);
    body = <>
      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-xs text-ui-red">
          <span>Stale: refresh failed ({error}). Showing the last spend read.</span>
          <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry</Button>
        </div>
      )}
      {note && <p role="status" className="flex items-center gap-1 text-xs font-medium text-ui-amber"><AlertTriangle className="h-3.5 w-3.5" /> {note}</p>}
      {week.index.error && <p role="alert" className="text-xs text-ui-red">{week.index.error}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Figure title="Today (UTC)" view={today} />
        <Figure title="Last 7 days" view={week} />
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium">Top tabs, last 7 days</p>
        {tabs.length === 0 ? <p className="text-xs text-muted-foreground">No usage is bound to a tab in this period.</p> : (
          <ol className="space-y-1">
            {tabs.map((row) => (
              <li key={row.key} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 truncate" title={row.key}>{row.label} <span className="text-muted-foreground">· {providerLabel(row.providerId)}</span></span>
                <span className="shrink-0 text-right">{formatTokenCount(row.totalTokens)} <Cost row={row} /></span>
              </li>
            ))}
          </ol>
        )}
        {week.unattributed && <p className="text-xs text-muted-foreground">{week.unattributed.label}: {formatTokenCount(week.unattributed.totalTokens)} tokens</p>}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Estimated from list prices. Codex and Grok count on their session start day.
        {week.index.indexedThrough !== null && <> Indexed through {dayjs(week.index.indexedThrough).format('MMM D HH:mm')}.</>}
      </p>
    </>;
  }

  return (
    <Card className="shadow-none" aria-label="Spend">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Spend</h2>
          <select aria-label="Spend workspace" className="rounded border bg-background px-2 py-1 text-xs" value={workspaceId}
            onChange={(event) => onWorkspaceChange?.(event.target.value)}>
            <option value={ALL_WORKSPACES}>All workspaces</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </div>
        {body}
      </CardContent>
    </Card>
  );
};

const SpendTile = ({ workspaces, initialWorkspaceId = ALL_WORKSPACES }: { workspaces: ISpendWorkspaceOption[]; initialWorkspaceId?: string }) => {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const today = useSWR(spendUrl(workspaceId, 'today'), readSpend, { refreshInterval: REFRESH_MS });
  const week = useSWR(spendUrl(workspaceId, '7d'), readSpend, { refreshInterval: REFRESH_MS });
  const failure = today.error ?? week.error;
  return <SpendTileContent workspaceId={workspaceId} workspaces={workspaces} today={today.data} week={week.data}
    loading={today.isLoading || week.isLoading} onWorkspaceChange={setWorkspaceId}
    error={failure ? (failure instanceof Error ? failure.message : 'Spend unavailable') : null}
    onRetry={() => { void today.mutate(); void week.mutate(); }} />;
};

export default SpendTile;
