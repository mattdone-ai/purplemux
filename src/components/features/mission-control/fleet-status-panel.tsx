import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatDuration } from '@/lib/fleet-status';
import { cn } from '@/lib/utils';
import type { TFleetSection } from '@/types/coordination';
import type { IFleetFlag, IFleetInbox, IFleetRow, IFleetUnattributed, IFleetView, IFleetWait } from '@/types/fleet-status';

// Mission Control fleet status (ADR-0023): one row per agent tab, its state and
// how long it has been in it, flagged rows first. Read only: nothing here sends
// input to a tab.

const STATE_LABEL: Record<string, string> = {
  working: 'working',
  waiting: 'waiting',
  'needs-input': 'needs input',
  ended: 'ended with a line',
  'ready-for-review': 'idle, no end line',
  idle: 'idle',
  unsubmitted: 'text not submitted',
  inactive: 'agent not running',
  unknown: 'unknown',
};
const FLAG_LABEL: Record<string, string> = { stall: 'STALL?', unanswered: 'UNANSWERED', 'waiting-long': 'WAITING-LONG' };
const FLAG_CLASS: Record<string, string> = {
  stall: 'border-ui-red/40 bg-ui-red/10 text-ui-red',
  unanswered: 'border-ui-amber/40 bg-ui-amber/10 text-ui-amber',
  'waiting-long': 'border-ui-amber/40 bg-ui-amber/10 text-ui-amber',
};
const FLAG_TEXT: Record<string, string> = { stall: 'text-ui-red', unanswered: 'text-ui-amber', 'waiting-long': 'text-ui-amber' };
const FLAG_BORDER: Record<string, string> = { stall: 'border-l-ui-red/50', unanswered: 'border-l-ui-amber/50', 'waiting-long': 'border-l-ui-amber/50' };
const WAIT_LABEL: Record<string, string> = { watch: 'watch', job: 'job', background: 'background tasks' };
const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', grok: 'Grok' };

const label = (map: Record<string, string>, token: string): string => (Object.hasOwn(map, token) ? map[token] : 'other');

const LINE_MAX = 160;
const truncate = (text: string, max = LINE_MAX): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const ago = (now: number, at: number | null): string => (at === null ? '—' : formatDuration(now - at));

const waitText = (wait: IFleetWait): string => wait.kind === 'background'
  ? `${wait.label} ${label(WAIT_LABEL, wait.kind)}`
  : `${label(WAIT_LABEL, wait.kind)} ${wait.label}${wait.detail ? ` (${wait.detail})` : ''}`;

const FlagBadge = ({ flag }: { flag: IFleetFlag }) => (
  <span
    className={cn('inline-flex shrink-0 rounded border px-1.5 py-px text-[10px] font-semibold tracking-wide', FLAG_CLASS[flag.flag] ?? 'border-foreground/20')}
    title={flag.reason}
    data-flag={flag.flag}
  >
    {label(FLAG_LABEL, flag.flag)}
  </span>
);

const InboxText = ({ inbox, now }: { inbox: IFleetInbox | null; now: number }) => {
  if (inbox === null) return <span data-inbox="unreadable">SM inbox —</span>;
  if (inbox.open === 0) return <span data-inbox="none">SM inbox 0</span>;
  return (
    <span data-inbox={inbox.open} className={cn(inbox.unanswered > 0 && 'text-ui-amber')}>
      SM inbox {inbox.open} open · oldest {ago(now, inbox.oldestAt)}
    </span>
  );
};

const stateTitle = (row: IFleetRow): string | undefined => (
  row.state === 'unknown' || !Object.hasOwn(STATE_LABEL, row.state)
    ? `served state: ${row.rawCliState ?? 'none'}`
    : undefined
);

const FleetRow = ({ row, now }: { row: IFleetRow; now: number }) => (
  <li
    className={cn(
      'min-w-0 space-y-0.5 border-b border-foreground/5 py-2 last:border-0',
      row.flags.length > 0 && cn('border-l-2 pl-2', FLAG_BORDER[row.flags[0].flag] ?? 'border-l-foreground/30'),
    )}
    data-fleet-row={row.tabId}
    data-state={row.state}
  >
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {row.flags.map((flag) => <FlagBadge key={flag.flag} flag={flag} />)}
      <span className="truncate font-medium">{row.tabName}</span>
      <span className="text-muted-foreground">
        {row.providerId ? label(PROVIDER_LABEL, row.providerId) : '—'}
        {row.epic && <> · <span className="font-mono">{row.epic}</span></>}
        {' · '}{row.workspaceName}
      </span>
    </div>
    <div className="flex min-w-0 flex-wrap gap-x-2 text-muted-foreground">
      <span className="text-foreground" title={stateTitle(row)} data-state-label="">
        {row.endLineUnknown ? 'idle, end line unknown after a restart' : label(STATE_LABEL, row.state)}{' '}
        {row.since === null ? '' : formatDuration(now - row.since)}
      </span>
      {row.waits.length > 0 && <span className="min-w-0 break-words">on {row.waits.map(waitText).join(', ')}</span>}
      <span>last activity {ago(now, row.lastActivityAt)} ago</span>
      <InboxText inbox={row.inbox} now={now} />
    </div>
    <div className="min-w-0 text-muted-foreground">
      {row.lastLine ? (
        <span className="block truncate font-mono" title={row.lastLine.text} data-last-line="">
          {truncate(row.lastLine.text)} <span className="font-sans">· {ago(now, row.lastLine.at)} ago</span>
        </span>
      ) : <span data-last-line={row.endLineUnknown ? 'unknown' : 'none'}>last line {row.endLineUnknown ? 'unknown' : '—'}</span>}
    </div>
    {row.flags.length > 0 && (
      <ul>
        {row.flags.map((flag) => (
          <li key={flag.flag} className={cn('break-words', FLAG_TEXT[flag.flag])}>{label(FLAG_LABEL, flag.flag)} {flag.reason}</li>
        ))}
      </ul>
    )}
  </li>
);

const UnattributedRow = ({ line, now }: { line: IFleetUnattributed; now: number }) => (
  <li className="min-w-0 space-y-0.5 py-2" data-fleet-unattributed={line.workspaceId}>
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {line.flags.map((flag) => <FlagBadge key={flag.flag} flag={flag} />)}
      <span className="font-medium">{line.workspaceName}</span>
      <span className="text-muted-foreground">· SM-inbox items with no known posting tab</span>
    </div>
    <div className="text-muted-foreground"><InboxText inbox={line.inbox} now={now} /></div>
  </li>
);

const thresholdsText = (view: IFleetView): string => {
  const t = view.thresholds;
  return `STALL? after ${t.stallMinutes} min (composer text after ${t.composerMinutes} min) · WAITING-LONG after ${t.waitingLongMinutes} min · UNANSWERED after ${t.unansweredMinutes} min`;
};

export interface IFleetFilter {
  showAll: boolean;
  workspace: string | null;
}

/**
 * The filter lives above the panel's error boundary, which is keyed on each poll: kept inside,
 * every 15 s refresh would drop "Show all" and the workspace choice.
 */
const FleetView = ({ view, filter, onFilter }: { view: IFleetView; filter: IFleetFilter; onFilter: (next: IFleetFilter) => void }) => {
  const { showAll } = filter;
  // A kept filter can name a workspace this poll has no rows for (deleted, or its layout unread).
  const workspace = filter.workspace !== null && view.rows.some((row) => row.workspaceId === filter.workspace) ? filter.workspace : null;
  const now = view.at;
  const inScope = view.rows.filter((row) => workspace === null || row.workspaceId === workspace);
  const flagged = inScope.filter((row) => row.flags.length > 0);
  const rows = showAll ? inScope : flagged;
  const unattributed = view.unattributed.filter((line) => workspace === null || line.workspaceId === workspace);
  const workspaces = [...new Map(view.rows.map((row) => [row.workspaceId, row.workspaceName])).entries()];

  return (
    <div className="space-y-2 text-xs" data-fleet-view="" data-state={view.rows.length === 0 ? 'empty' : 'populated'}>
      <p className="text-muted-foreground" data-thresholds="">{thresholdsText(view)}</p>
      {view.errors.map((e) => (
        <p key={`${e.scope}:${e.error}`} className="text-destructive" data-state="partial-error">Could not read {e.scope}: {e.error}</p>
      ))}
      {view.rows.length === 0 ? (
        <p className="text-muted-foreground" data-state="empty">No agent tabs in any workspace.</p>
      ) : (
        <div className="flex max-w-full flex-wrap items-center gap-1">
          {workspaces.length > 1 && (
            <div className="flex max-w-full gap-1 overflow-x-auto pb-1">
              <Button type="button" size="sm" variant={workspace === null ? 'secondary' : 'ghost'} onClick={() => onFilter({ ...filter, workspace: null })} className="shrink-0">
                All
              </Button>
              {workspaces.map(([id, name]) => (
                <Button key={id} type="button" size="sm" variant={workspace === id ? 'secondary' : 'ghost'} onClick={() => onFilter({ ...filter, workspace: id })} className="shrink-0">
                  {name}
                  <span className="tabular-nums text-muted-foreground">{view.rows.filter((r) => r.workspaceId === id && r.flags.length > 0).length}</span>
                </Button>
              ))}
            </div>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={() => onFilter({ ...filter, showAll: !showAll })} className="shrink-0" data-toggle="show-all">
            {showAll ? 'Flagged only' : `Show all ${inScope.length} tabs`}
          </Button>
        </div>
      )}
      {rows.length === 0 && unattributed.length === 0 ? (
        view.rows.length > 0 && (
          <p className="text-muted-foreground" data-state="no-flags">
            No flags: every agent tab is working, waiting on registered work, or ended with a line.
          </p>
        )
      ) : (
        <ul data-state="rows">
          {unattributed.map((line) => <UnattributedRow key={line.workspaceId} line={line} now={now} />)}
          {rows.map((row) => <FleetRow key={`${row.workspaceId}/${row.tabId}`} row={row} now={now} />)}
        </ul>
      )}
    </div>
  );
};

const RetryButton = ({ onRetry }: { onRetry: () => void }) => (
  <Button type="button" size="sm" variant="outline" onClick={onRetry}>Retry</Button>
);

export const FleetStatusView = ({ fleet, error, loading, onRetry, filter, onFilter }: {
  /** undefined: no snapshot yet, or a server older than the panel. */
  fleet: TFleetSection | undefined;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  filter: IFleetFilter;
  onFilter: (next: IFleetFilter) => void;
}) => {
  let body: ReactNode;
  if (fleet === undefined) {
    body = error
      ? (
        <div className="space-y-2" data-state="error">
          <p className="text-destructive">Fleet status unavailable: {error}</p>
          <RetryButton onRetry={onRetry} />
        </div>
      )
      : loading
        ? <p className="text-muted-foreground" data-state="loading">Loading fleet status…</p>
        : <p className="text-muted-foreground" data-state="unsupported">This server does not report fleet status.</p>;
  } else if (!fleet.ok) {
    body = (
      <div className="space-y-2" data-state="error">
        <p className="text-destructive">Fleet status could not be read: {fleet.error}</p>
        <RetryButton onRetry={onRetry} />
      </div>
    );
  } else {
    body = (
      <>
        {error && (
          <div className="flex flex-wrap items-center gap-2" data-state="refresh-error">
            <p className="text-destructive">Last refresh failed: {error}</p>
            <RetryButton onRetry={onRetry} />
          </div>
        )}
        <FleetView view={fleet.view} filter={filter} onFilter={onFilter} />
      </>
    );
  }
  const flagged = fleet?.ok
    ? fleet.view.rows.filter((r) => r.flags.length > 0).length + fleet.view.unattributed.filter((u) => u.flags.length > 0).length
    : null;
  return (
    <Card className="border-foreground/10 shadow-none" data-fleet-panel="">
      <CardContent className="space-y-2 p-4 text-xs sm:p-5">
        {flagged !== null && fleet?.ok && (
          <p className="font-medium" data-flagged-count={flagged}>
            {flagged} flagged · {fleet.view.rows.length} agent tabs
          </p>
        )}
        {body}
      </CardContent>
    </Card>
  );
};
