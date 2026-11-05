import { useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { AlertCircle, AlertTriangle, ArrowUpRight, RefreshCw } from 'lucide-react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import BurndownPanel from '@/components/features/mission-control/burndown-panel';
import FlowPanel from '@/components/features/mission-control/flow-panel';
import SpendTile from '@/components/features/mission-control/spend-tile';
import PulseRow from '@/components/features/mission-control/pulse-strip';
import {
  aedtTime, ageText, answerCardUrl, blockedText, defaultWorkspace, pulseAge, sectionAge,
} from '@/components/features/mission-control/board-model';
import type { ISectionAge } from '@/components/features/mission-control/board-model';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { stageLabel, trendLabel } from '@/lib/constraint-labels';
import { curatorTaskName } from '@/lib/curator-tasks';
import { cn } from '@/lib/utils';
import type { IBoard, IMissionBoardListResponse } from '@/types/constraint';
import type { IMissionPulseListResponse } from '@/types/pulse';

// The owner board (ADR-0034 §10, ADR-HFL-02 decision 2): the pulse first, then one workspace's
// board in the ADR's order. It reads only; every owner action is a Mission Control item (AC 4).

export const PULSE_URL = '/api/mission-control/pulse?workspaceId=all';
export const BOARD_URL = '/api/mission-control/board?workspaceId=all';
/** AC 8: the web view polls every 30 s while visible (SWR pauses a hidden tab's interval). */
export const BOARD_REFRESH_MS = 30_000;

const readJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || response.statusText || 'Request failed');
  }
  return response.json() as Promise<T>;
};

const POLL = { refreshInterval: BOARD_REFRESH_MS, refreshWhenHidden: false, revalidateOnFocus: true } as const;

const DAY_MS = 86_400_000;

const SectionFrame = ({ id, title, age, wide = false, count, children }: {
  id: string; title: string; age: ISectionAge; wide?: boolean; count?: number | string; children: ReactNode;
}) => (
  <section aria-labelledby={`board-${id}-heading`} className={cn('min-w-0 space-y-3 rounded-lg border bg-card/50 p-3 sm:p-4', wide && 'min-[600px]:col-span-2')}
    data-board-section={id}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 id={`board-${id}-heading`} className="flex items-center gap-2 text-sm font-semibold">
        {title}
        {count !== undefined && <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{count}</span>}
      </h3>
      <span className={cn('flex items-center gap-1 text-xs', age.stale ? 'text-ui-amber' : 'text-muted-foreground')} data-section-age>
        {age.stale && <AlertTriangle className="h-3.5 w-3.5" />}{age.text}
      </span>
    </div>
    {children}
  </section>
);

const Muted = ({ children }: { children: ReactNode }) => <p className="break-words text-sm text-muted-foreground">{children}</p>;

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <p className="break-words text-sm"><span className="text-muted-foreground">{label}: </span>{children}</p>
);

const ledgerUnknown = (board: IBoard): string | null =>
  (board.inputs.ledger.state === 'ok' ? null : `not measured: ${board.inputs.ledger.reason ?? board.inputs.ledger.state}`);

const OnTrackSection = ({ board, age }: { board: IBoard; age: ISectionAge }) => {
  const t = board.onTrack;
  return (
    <SectionFrame id="on-track" title="On track" age={age}>
      {t.goalState === 'unknown' ? (
        <p className="break-words text-sm text-ui-amber" data-on-track="unknown">Goal {t.reason ?? 'not measured'}.</p>
      ) : t.goal === null ? (
        <Muted>No goal set. The orchestrator sets one with <code>purplemux board goal set</code>.</Muted>
      ) : (
        <div className="space-y-1">
          <p className="break-words text-sm font-medium">{t.goal}</p>
          <Field label="Items left">{t.itemsLeft === null ? 'not measured' : t.itemsLeft}</Field>
          {t.p50At !== null && t.p90At !== null ? (
            <>
              <Field label="p50">{aedtTime(t.p50At)}</Field>
              <Field label="p90">{aedtTime(t.p90At)}</Field>
            </>
          ) : <Field label="Forecast">none ({t.reason})</Field>}
          {t.throughputPerDay && <Field label="Closed per day, last 3 days">{t.throughputPerDay.join(', ')}</Field>}
          {/* A goal has no due date, so "on track" names a forecast, not a promise (round 2, F9). */}
          <p className={cn('text-sm font-medium', t.state === 'on-track' ? 'text-foreground/80' : 'text-ui-amber')} data-on-track={t.state}>
            {t.state === 'on-track' ? 'Forecast (no due date set)' : `At risk${t.reason ? `: ${t.reason}` : ''}`}
          </p>
        </div>
      )}
    </SectionFrame>
  );
};

const ConstraintSection = ({ board, age }: { board: IBoard; age: ISectionAge }) => {
  const c = board.constraint;
  const unknown = ledgerUnknown(board);
  let body: ReactNode;
  if (unknown) body = <Muted>Constraint {unknown}.</Muted>;
  else if (!c) body = <Muted>Nothing waited in the last 24 h.</Muted>;
  else {
    body = (
      <div className="space-y-1">
        <p className="break-words text-sm font-medium">{c.labels.reason} <span className="font-normal text-muted-foreground">({c.labels.stage})</span></p>
        <Field label="Waiting">{c.waitingHours.toFixed(1)} h in 24 h on {c.items} {c.basis === 'critical' ? 'critical ' : ''}item{c.items === 1 ? '' : 's'}</Field>
        <Field label="Trend">{c.labels.trend}</Field>
        <Field label="Owner seat">{c.ownerSeat ?? 'not recorded'}</Field>
        <Field label="Clears when">{c.clearInput ?? 'not recorded'}</Field>
      </div>
    );
  }
  return <SectionFrame id="constraint" title="Constraint now" age={age}>{body}</SectionFrame>;
};

const NeedsYouSection = ({ board, age, now }: { board: IBoard; age: ISectionAge; now: number }) => {
  const rows = board.needsYou;
  const unmeasured = board.inputs.ledger.state === 'ok' ? null : board.inputs.ledger.reason ?? board.inputs.ledger.state;
  return (
    <SectionFrame id="needs-you" title="Needs you" age={age} wide count={rows?.length ?? '—'}>
      {rows === null ? <Muted>Not measured: Mission Control could not be read.</Muted>
        : rows.length === 0 ? <Muted>No Mission Control item is open.</Muted> : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-1 py-2 min-[600px]:flex-row min-[600px]:items-center min-[600px]:gap-3" data-needs-you={row.id}>
                <span className="min-w-0 flex-1 break-words text-sm font-medium">{row.title || row.id}</span>
                <span className={cn('text-xs', row.blocked && !unmeasured ? 'text-ui-amber' : 'text-muted-foreground')}
                  data-blocked={unmeasured ? 'not-measured' : row.blocked ? 'measured' : 'unlinked'}>
                  {blockedText(row.blocked, unmeasured)}
                </span>
                <span className="text-xs text-muted-foreground">opened {ageText(now - row.createdAt)} ago</span>
                <Link href={answerCardUrl(row.id)} className="inline-flex items-center gap-0.5 text-xs font-medium text-ui-blue hover:underline"
                  aria-label={`Open the answer card for ${row.title || row.id}`}>
                  Answer <ArrowUpRight className="h-3 w-3" />
                </Link>
              </li>
            ))}
          </ul>
        )}
    </SectionFrame>
  );
};

const StuckSection = ({ board, age, now }: { board: IBoard; age: ISectionAge; now: number }) => {
  const unknown = ledgerUnknown(board);
  const count = unknown ? '—' : board.stuck.length < board.stuckTotal ? `${board.stuck.length} of ${board.stuckTotal}` : board.stuckTotal;
  return (
    <SectionFrame id="stuck" title="Stuck, oldest first" age={age} wide count={count}>
      {unknown ? <Muted>Stuck items {unknown}.</Muted> : board.stuck.length === 0 ? <Muted>Nothing waits in the ledger now.</Muted> : (
        <ul className="divide-y">
          {board.stuck.map((item) => (
            <li key={item.key} className="grid gap-x-3 gap-y-0.5 py-2 text-sm min-[600px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_5rem_minmax(0,0.8fr)_minmax(0,1fr)]"
              data-stuck={item.key}>
              <span className="min-w-0 break-all font-medium">
                {item.critical && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-ui-red align-middle" aria-hidden />}
                {item.key}{item.critical && <span className="ml-1 text-xs text-ui-red">critical</span>}
              </span>
              <span className="min-w-0 break-words">{item.reasonLabel}</span>
              <span className="tabular-nums text-muted-foreground">{ageText(now - item.since)}</span>
              <span className="min-w-0 break-words text-muted-foreground"><span className="min-[600px]:hidden">held by </span>{item.holder ?? 'no holder recorded'}</span>
              <span className="min-w-0 break-words text-muted-foreground"><span className="min-[600px]:hidden">clears when </span>{item.clearInput ?? 'not recorded'}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionFrame>
  );
};

const FlowSection = ({ board, age }: { board: IBoard; age: ISectionAge }) => {
  const unknown = ledgerUnknown(board);
  const day = board.windows.find((window) => window.window === '24h');
  return (
    <SectionFrame id="flow" title="Flow by stage, 24 h" age={age} wide>
      {unknown ? <Muted>Flow by stage {unknown}.</Muted> : !day || day.byStage.length === 0 ? <Muted>No stage waited in the last 24 h.</Muted> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr><th className="py-1 font-medium">Stage</th><th className="font-medium">WIP</th><th className="font-medium">Waiting</th>
                <th className="font-medium">p50</th><th className="font-medium">p90</th><th className="font-medium">Finished</th><th className="font-medium">Trend</th></tr>
            </thead>
            <tbody>
              {day.byStage.map((row) => (
                <tr key={row.key} className="border-t" data-stage={row.key}>
                  <td className="py-1">{stageLabel(row.key)}</td><td className="tabular-nums">{row.wip}</td>
                  <td className="tabular-nums">{row.waitingHours.toFixed(1)} h</td>
                  <td className="tabular-nums">{row.p50Hours === null ? '—' : `${row.p50Hours.toFixed(1)} h`}</td>
                  <td className="tabular-nums">{row.p90Hours === null ? '—' : `${row.p90Hours.toFixed(1)} h`}</td>
                  <td className="tabular-nums">{row.throughput}</td>
                  <td>{row.trend === null ? '—' : trendLabel(row.trend)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {board.inputs.flow.state !== 'ok' && (
        <Muted>Flow record {board.inputs.flow.state === 'stale' && board.inputs.flow.at !== null
          ? `stale since ${aedtTime(board.inputs.flow.at)}` : `not measured: ${board.inputs.flow.reason ?? board.inputs.flow.state}`}.</Muted>
      )}
      <FlowPanel />
      <BurndownPanel />
    </SectionFrame>
  );
};

const ExperimentsSection = ({ board, age, now }: { board: IBoard; age: ISectionAge; now: number }) => {
  const list = board.experiments;
  return (
    <SectionFrame id="experiments" title="Experiments running" age={age} count={list?.length ?? '—'}>
      {list === null ? <Muted>Not measured: the ledger could not be read.</Muted> : list.length === 0 ? <Muted>None running.</Muted> : (
        <ul className="space-y-2">
          {list.map((experiment) => (
            <li key={experiment.id} className="space-y-0.5 text-sm" data-experiment={experiment.id}>
              <p className="break-words font-medium">{experiment.id}: {experiment.hypothesis}</p>
              <p className="text-xs text-muted-foreground">
                {stageLabel(experiment.stage)} · metric {experiment.metric} · started {ageText(now - experiment.startedAt)} ago
                · ends by day {experiment.maxDays} ({Math.max(0, Math.ceil(experiment.maxDays - (now - experiment.startedAt) / DAY_MS))} days left)
                {experiment.extendedAt != null ? ` · extended once, by ${experiment.extensionDays} days` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </SectionFrame>
  );
};

const SEAT_ANOMALIES = new Set(['context-per-call', 'wakes-per-hour']);

const SeatsSection = ({ board, age, workspaceId }: { board: IBoard; age: ISectionAge; workspaceId: string }) => {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const seats = board.anomalies.filter((anomaly) => SEAT_ANOMALIES.has(anomaly.id));
  return (
    <SectionFrame id="seats" title="Seats" age={age}>
      {seats.length === 0 ? <Muted>No seat reported context or wakes.</Muted> : (
        <ul className="space-y-1 text-sm">
          {seats.map((anomaly) => (
            <li key={`${anomaly.id}/${anomaly.subject}`} className={cn('break-words', anomaly.breached && 'text-ui-red')} data-seat-anomaly={anomaly.id}>
              {anomaly.text}
            </li>
          ))}
        </ul>
      )}
      <Muted>Cost per day per seat: not measured (spend by seat and phase lands with story 04).</Muted>
      <SpendTile key={workspaceId} workspaces={workspaces.map(({ id, name }) => ({ id, name }))} initialWorkspaceId={workspaceId} />
    </SectionFrame>
  );
};

const PoolSection = ({ board, age }: { board: IBoard; age: ISectionAge }) => (
  <SectionFrame id="pool" title="Pool" age={age} wide>
    {!board.pool ? <Muted>Not measured: {board.inputs.pool.reason ?? 'no pool published'}.</Muted> : (
      <div className="space-y-1 text-sm">
        <p>{board.pool.slotsUsed} of {board.pool.slotsTotal} slots in use across {board.pool.hosts.length} host{board.pool.hosts.length === 1 ? '' : 's'}</p>
        <ul className="text-xs text-muted-foreground">
          {board.pool.hosts.map((host) => <li key={host.name}>{host.name}: {host.slotsUsed} of {host.slotsTotal}</li>)}
        </ul>
      </div>
    )}
  </SectionFrame>
);

const CURATOR_STATE_WORDS: Readonly<Record<string, string>> = { shadow: 'shadow (labels logged, nothing routed)', routing: 'routing' };

const CuratorSection = ({ board, age, now }: { board: IBoard; age: ISectionAge; now: number }) => {
  const curator = board.curator;
  return (
    <SectionFrame id="curator" title="Curator" age={age} wide>
      {!curator ? <Muted>Not measured: curator state unreadable.</Muted> : (
        <div className="space-y-2 text-sm">
          {curator.health.state === 'down' && (
            <p role="status" className="flex items-start gap-2 text-ui-red" data-curator-health="down">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">
                Curator down{curator.health.reason ? `: ${curator.health.reason}` : ''}
                {curator.health.since !== null ? ` since ${aedtTime(curator.health.since)}` : ''}. The rules route; nothing waits.
              </span>
            </p>
          )}
          {curator.health.state === 'up' && <p data-curator-health="up">Curator up{curator.health.checkedAt !== null ? `, checked ${ageText(now - curator.health.checkedAt)} ago` : ''}.</p>}
          {curator.health.state === 'unknown' && <Muted>Curator not probed yet.</Muted>}
          <ul className="space-y-1 text-xs text-muted-foreground">
            {curator.tasks.map((task) => {
              const agreement = curator.agreement?.find((a) => a.task === task.task);
              const stateWord = Object.hasOwn(CURATOR_STATE_WORDS, task.state) ? CURATOR_STATE_WORDS[task.state] : 'state not in the label map';
              const shadowEnds = task.state !== 'shadow' ? '' : task.shadowEndsAt !== null
                ? ` · 72 h shadow ends ${aedtTime(task.shadowEndsAt)}` : ' · no live call of this prompt yet';
              // A reshape has no rules' label to agree with: its gate is its evaluation and the judge (story 23).
              const agree = task.task === 'reshape-question' ? 'gated by its evaluation and judge, not by agreement'
                : !curator.agreement ? 'agreement not measured'
                : !agreement || agreement.compared === 0 ? 'no labelled calls in 72 h'
                  : `${agreement.agreed} of ${agreement.compared} labels agree with the rules (72 h)`;
              return (
                <li key={task.task} className="break-words" data-curator-task={task.task}>
                  {curatorTaskName(task.task)}: {stateWord}{task.state === 'routing' && !task.routingHere ? ', not opted in here' : ''}{shadowEnds} · {agree}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </SectionFrame>
  );
};

const BoardSections = ({ board, now }: { board: IBoard; now: number }) => {
  const finderAge = sectionAge(board.generatedAt, board.staleSince, now);
  const input = (state: IBoard['inputs']['ledger']): ISectionAge =>
    (board.staleSince !== null ? finderAge : state.state === 'stale' && state.at !== null
      ? { text: `stale since ${aedtTime(state.at)}`, stale: true } : finderAge);
  return (
    <div className="grid min-w-0 gap-4 min-[600px]:grid-cols-2" data-board={board.workspaceId}>
      <OnTrackSection board={board} age={finderAge} />
      <ConstraintSection board={board} age={input(board.inputs.ledger)} />
      <NeedsYouSection board={board} age={finderAge} now={now} />
      <StuckSection board={board} age={input(board.inputs.ledger)} now={now} />
      <FlowSection board={board} age={input(board.inputs.flow)} />
      <ExperimentsSection board={board} age={finderAge} now={now} />
      <SeatsSection board={board} age={input(board.inputs.spend)} workspaceId={board.workspaceId} />
      <PoolSection board={board} age={input(board.inputs.pool)} />
      <CuratorSection board={board} age={finderAge} now={now} />
    </div>
  );
};

const LoadFailure = ({ what, error, onRetry }: { what: string; error: string; onRetry: () => void }) => (
  <div role="alert" className="flex flex-col gap-3 rounded-lg border border-ui-red/20 bg-ui-red/5 px-4 py-3 text-sm text-ui-red sm:flex-row sm:items-center sm:justify-between">
    <span className="flex min-w-0 items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 break-words">{what} could not load: {error}.</span></span>
    <Button type="button" variant="outline" size="sm" onClick={onRetry} className="w-full shrink-0 sm:w-auto"><RefreshCw className="h-4 w-4" />Retry</Button>
  </div>
);

const RefreshFailed = ({ error }: { error: string }) => (
  <p role="status" className="flex items-start gap-2 rounded-md border border-ui-red/20 bg-ui-red/5 px-3 py-2 text-sm text-ui-red">
    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="min-w-0 break-words">Live refresh failed: {error}. Showing the last answer.</span>
  </p>
);

interface IOwnerBoardContentProps {
  pulses?: IMissionPulseListResponse;
  boards?: IMissionBoardListResponse;
  pulseError: string | null;
  boardError: string | null;
  loading: boolean;
  names: Record<string, string>;
  selected: string | null;
  onSelect: (workspaceId: string) => void;
  onRetry: () => void;
  now: number;
}

export const OwnerBoardContent = ({ pulses, boards, pulseError, boardError, loading, names, selected, onSelect, onRetry, now }: IOwnerBoardContentProps) => {
  const shown = selected ?? (pulses ? defaultWorkspace(pulses.pulses) : null) ?? boards?.boards[0]?.workspaceId ?? null;
  const board = boards?.boards.find((candidate) => candidate.workspaceId === shown) ?? null;
  const age = pulseAge(pulses?.pulses.map((pulse) => pulse.generatedAt) ?? [], now);
  return (
    <div className="space-y-5" data-owner-board>
      <section aria-labelledby="board-pulse-heading" className="space-y-3" data-board-section="pulse">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="board-pulse-heading" className="text-sm font-semibold">Pulse, last 48 h</h2>
            <p className="text-xs text-muted-foreground">One bar per hour: ledger changes, commits, gates (red failed, teal passed), review rounds, v2 landings and answers.</p>
          </div>
          <span className={cn('flex items-center gap-1 text-xs', age.stale ? 'text-ui-amber' : 'text-muted-foreground')} data-section-age>
            {age.stale && <AlertTriangle className="h-3.5 w-3.5" />}{age.text}
          </span>
        </div>
        {pulseError && pulses && <RefreshFailed error={pulseError} />}
        {pulses ? pulses.pulses.map((pulse) => (
          <PulseRow key={pulse.workspaceId} pulse={pulse} workspaceName={names[pulse.workspaceId] ?? pulse.workspaceId}
            selected={pulse.workspaceId === shown} onSelect={onSelect} />
        )) : pulseError ? <LoadFailure what="The pulse" error={pulseError} onRetry={onRetry} /> : (
          <div role="status" aria-live="polite" className="space-y-3"><span className="sr-only">Loading the pulse…</span><Skeleton className="h-24 w-full" /></div>
        )}
      </section>
      <section aria-labelledby="board-detail-heading" className="space-y-3">
        <h2 id="board-detail-heading" className="text-sm font-semibold">Board{shown ? `: ${names[shown] ?? shown}` : ''}</h2>
        {boardError && boards && <RefreshFailed error={boardError} />}
        {board ? <BoardSections board={board} now={now} />
          : boardError ? <LoadFailure what="The board" error={boardError} onRetry={onRetry} />
            : loading ? <div role="status" aria-live="polite"><span className="sr-only">Loading the board…</span><Skeleton className="h-40 w-full" /></div>
              : <Muted>No workspace to show.</Muted>}
      </section>
    </div>
  );
};

const errorText = (error: unknown): string | null => (error ? (error instanceof Error ? error.message : String(error)) : null);

const OwnerBoard = () => {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const [selected, setSelected] = useState<string | null>(null);
  const pulse = useSWR<IMissionPulseListResponse>(PULSE_URL, readJson, POLL);
  const board = useSWR<IMissionBoardListResponse>(BOARD_URL, readJson, POLL);
  const names = Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.name]));
  // The server's read time is the board's clock: ages read against the answer, not the browser's clock.
  const now = Math.max(0, ...(pulse.data?.pulses ?? []).map((p) => p.generatedAt), ...(board.data?.boards ?? []).map((b) => b.generatedAt + b.ageMs));
  return (
    <OwnerBoardContent pulses={pulse.data} boards={board.data} pulseError={errorText(pulse.error)} boardError={errorText(board.error)}
      loading={pulse.isLoading || board.isLoading} names={names} selected={selected} onSelect={setSelected}
      onRetry={() => { void pulse.mutate(); void board.mutate(); }} now={now} />
  );
};

export default OwnerBoard;
