import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import dayjs from 'dayjs';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { isBurndownStale } from '@/lib/burndown';
import { formatTokenCount } from '@/lib/claude-tokens';
import { formatCacheReads } from '@/lib/spend/spend-model';
import type { IBurndownEpic, IBurndownHistoryRow, IMissionBurndownResponse } from '@/types/burndown';
import type { ISpendTokensByDay } from '@/types/spend';

const BURNDOWN_URL = '/api/mission-control/burndown';
const REFRESH_MS = 60_000;

const CHART_WIDTH = 240;
const CHART_HEIGHT = 64;
const CHART_PAD = 4;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const age = (at: number, now: number): string => {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const percentOf = (burned: number, total: number): number => (total ? Math.round((burned / total) * 1000) / 10 : 0);

const readBurndown = async (url: string): Promise<IMissionBurndownResponse> => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || response.statusText || 'Burndown unavailable');
  }
  return response.json() as Promise<IMissionBurndownResponse>;
};

/** Step-after path: each value holds until the next snapshot replaces it. */
export const stepPath = (points: Array<{ x: number; y: number }>): string =>
  points.map((point, index) => (index === 0 ? `M${point.x} ${point.y}` : `H${point.x}V${point.y}`)).join('');

const round = (value: number): number => Math.round(value * 10) / 10;

const DAY_MS = 86_400_000;

/** The days that overlap the chart's span, each placed at its UTC noon (clamped to the span). */
export const tokenDaysInSpan = (days: ISpendTokensByDay[], start: number, end: number) =>
  days.map((entry) => ({ entry, dayStart: Date.parse(`${entry.day}T00:00:00Z`) }))
    .filter(({ dayStart }) => Number.isFinite(dayStart) && dayStart + DAY_MS > start && dayStart <= end)
    .map(({ entry, dayStart }) => ({ entry, at: Math.min(end, Math.max(start, dayStart + DAY_MS / 2)) }));

export const BurndownChart = ({ rows, tokensByDay }: { rows: IBurndownHistoryRow[]; tokensByDay?: ISpendTokensByDay[] }) => {
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">No history yet</p>;
  const times = rows.map((row) => Date.parse(row.at));
  const start = times[0];
  const end = times[times.length - 1];
  const top = Math.max(1, ...rows.map((row) => row.total));
  const x = (at: number): number => round(end === start ? CHART_WIDTH - CHART_PAD
    : CHART_PAD + ((at - start) / (end - start)) * (CHART_WIDTH - 2 * CHART_PAD));
  const y = (value: number): number => round(CHART_HEIGHT - CHART_PAD - (value / top) * (CHART_HEIGHT - 2 * CHART_PAD));
  const remaining = rows.map((row, index) => ({ x: x(times[index]), y: y(row.remaining) }));
  const total = rows.map((row, index) => ({ x: x(times[index]), y: y(row.total) }));
  const last = rows[rows.length - 1];
  const endpoint = remaining[remaining.length - 1];
  const tokenDays = tokensByDay && rows.length > 1 ? tokenDaysInSpan(tokensByDay, start, end) : [];
  const topTokens = Math.max(1, ...tokenDays.map(({ entry }) => entry.totalTokens));
  const tokenPoints = tokenDays.map(({ entry, at }) => ({
    x: x(at), y: round(CHART_HEIGHT - CHART_PAD - (entry.totalTokens / topTokens) * (CHART_HEIGHT - 2 * CHART_PAD)),
  }));
  const tokenTotal = tokenDays.reduce((sum, { entry }) => sum + entry.totalTokens, 0);
  const cacheReads = formatCacheReads({ totalTokens: tokenTotal, cacheReadTokens: tokenDays.reduce((sum, { entry }) => sum + entry.cacheReadTokens, 0) });
  const label = `Remaining ${last.remaining} of ${last.total} points across ${plural(rows.length, 'snapshot', 'snapshots')}`
    + (tokenDays.length ? `; workspace ${formatTokenCount(tokenTotal)} tokens over ${plural(tokenDays.length, 'day', 'days')}, peak ${formatTokenCount(topTokens)} a day, ${cacheReads}` : '');

  return (
    <figure className="space-y-1">
      <svg role="img" aria-label={label} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} className="h-auto w-full overflow-visible">
        <title>{label}</title>
        {rows.length > 1 && <>
          <path d={stepPath(total)} fill="none" stroke="var(--muted-foreground)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <path d={stepPath(remaining)} fill="none" stroke="var(--ui-blue)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </>}
        {tokenPoints.length > 0 && <path data-series="tokens" d={tokenPoints.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join('')}
          fill="none" stroke="var(--ui-purple)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        <circle cx={endpoint.x} cy={endpoint.y} r={2.5} fill="var(--ui-blue)" />
      </svg>
      <figcaption className="flex justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{dayjs(start).format('MMM D HH:mm')}</span>
        <span className="flex gap-3">
          <span className="text-ui-blue">— Remaining</span>
          <span>- - Total</span>
          {tokenPoints.length > 0 && <span className="text-ui-purple">— Workspace tokens/day (own scale, peak {formatTokenCount(topTokens)}) · {cacheReads}</span>}
        </span>
        <span>{dayjs(end).format('MMM D HH:mm')}</span>
      </figcaption>
    </figure>
  );
};

const ProgressBar = ({ pct, label }: { pct: number; label: string }) => (
  <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 overflow-hidden rounded-full bg-muted">
    <div className="h-full rounded-full bg-ui-blue" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
  </div>
);

const Counts = ({ remaining, inProgress, blocked }: { remaining: number; inProgress: number; blocked: number }) => (
  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
    <span>{remaining} remaining</span>
    <span className="text-ui-blue">{inProgress} in progress</span>
    <span className={blocked > 0 ? 'font-medium text-ui-red' : 'text-muted-foreground'}>{blocked} blocked</span>
  </div>
);

const EpicCard = ({ epic, history, tokensByDay }: { epic: IBurndownEpic; history: IBurndownHistoryRow[]; tokensByDay?: ISpendTokensByDay[] }) => (
  <Card className="min-w-0 shadow-none">
    <CardContent className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-sm font-semibold">{epic.name}</h3>
          <p className="break-all text-xs text-muted-foreground">{epic.slug}</p>
        </div>
        <p className="shrink-0 text-right text-sm font-semibold">{epic.burned} / {epic.total} pts<br />
          <span className="text-xs font-normal text-muted-foreground">{epic.pct}%</span></p>
      </div>
      <ProgressBar pct={epic.pct} label={`${epic.name} points burned`} />
      <Counts remaining={epic.remaining} inProgress={epic.in_progress} blocked={epic.blocked} />
      {epic.unpointed > 0 && <p className="text-xs text-ui-amber">{plural(epic.unpointed, 'unpointed story', 'unpointed stories')} not counted</p>}
      <BurndownChart rows={history} tokensByDay={tokensByDay} />
    </CardContent>
  </Card>
);

interface IBurndownPanelContentProps {
  response?: IMissionBurndownResponse;
  loading: boolean;
  error: string | null;
  now: number;
  onRetry?: () => void;
}

export const BurndownPanelContent = ({ response, loading, error, now, onRetry }: IBurndownPanelContentProps) => {
  if (loading && !response) {
    return <p className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">Loading burndown…</p>;
  }
  if (error && !response) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-ui-red/30 bg-ui-red/5 p-3 text-sm text-ui-red">
        <span>Burndown unavailable: {error}</span>
        <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry</Button>
      </div>
    );
  }
  if (!response?.workspaceId) return null;
  if (!response.burndown) {
    return (
      <p className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
        No burndown published. The Scrum Master publishes one each sweep with{' '}
        <code className="rounded bg-muted px-1">purplemux burndown publish -w {response.workspaceId} --json @burndown.json</code>.
      </p>
    );
  }

  const { snapshot } = response.burndown;
  const generatedAt = Date.parse(snapshot.generated_at);
  const stale = isBurndownStale(snapshot.generated_at, now);
  const epics = snapshot.epics.filter((epic) => epic.total > 0);
  const hidden = snapshot.epics.length - epics.length;
  const fleet = epics.reduce((sum, epic) => ({
    total: sum.total + epic.total, burned: sum.burned + epic.burned, remaining: sum.remaining + epic.remaining,
    inProgress: sum.inProgress + epic.in_progress, blocked: sum.blocked + epic.blocked,
  }), { total: 0, burned: 0, remaining: 0, inProgress: 0, blocked: 0 });
  const fleetPct = percentOf(fleet.burned, fleet.total);

  return (
    <section className="space-y-3" aria-label="Epic burndown">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-sm font-semibold">Epic burndown</h2>
          <p className="text-xs text-muted-foreground">v1 story points burned, published by the Scrum Master each sweep.</p></div>
        {stale ? (
          <span className="flex items-center gap-1 rounded bg-ui-amber/10 px-2 py-1 text-xs font-medium text-ui-amber" role="status">
            <AlertTriangle className="h-3.5 w-3.5" /> Stale · generated {age(generatedAt, now)} ago
          </span>
        ) : <span className="text-xs text-muted-foreground">Generated {age(generatedAt, now)} ago</span>}
      </div>
      {error && <p role="alert" className="text-xs text-ui-red">Refresh failed: {error}. Showing the last published burndown.</p>}
      {epics.length === 0 ? (
        <p className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">No epic in the latest burndown has points.</p>
      ) : <>
        <Card className="shadow-none">
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold">Fleet · {plural(epics.length, 'epic', 'epics')}</p>
              <p className="text-xl font-semibold">{fleet.burned} / {fleet.total} pts <span className="text-sm font-normal text-muted-foreground">{fleetPct}%</span></p>
            </div>
            <ProgressBar pct={fleetPct} label="Fleet points burned" />
            <Counts remaining={fleet.remaining} inProgress={fleet.inProgress} blocked={fleet.blocked} />
            {hidden > 0 && <p className="text-xs text-muted-foreground">{plural(hidden, 'epic', 'epics')} without points hidden</p>}
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {epics.map((epic) => <EpicCard key={epic.slug} epic={epic} history={snapshot.history.filter((row) => row.slug === epic.slug)} tokensByDay={response.tokensByDay} />)}
        </div>
      </>}
    </section>
  );
};

const BurndownPanel = () => {
  const { data, error, isLoading, mutate } = useSWR(BURNDOWN_URL, readBurndown, { refreshInterval: REFRESH_MS });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  return <BurndownPanelContent response={data} loading={isLoading} now={now}
    error={error ? (error instanceof Error ? error.message : 'Burndown unavailable') : null} onRetry={() => void mutate()} />;
};

export default BurndownPanel;
