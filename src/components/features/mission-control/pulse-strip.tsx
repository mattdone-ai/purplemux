import { cn } from '@/lib/utils';
import {
  aedtTime, barSegments, barTitle, sourceShort, stallLabel, stripLabel,
} from '@/components/features/mission-control/board-model';
import type { IStallLabel } from '@/components/features/mission-control/board-model';
import type { IPulse, IPulseSource } from '@/types/pulse';

// The pulse (ADR-0034 §9, story 12 AC 10): one row per workspace, the last 48 hours one bar per
// hour, the stall marker at the end, priority now, and each source with its own state.

const TONES: Record<IStallLabel['tone'], string> = {
  red: 'border-ui-red/30 bg-ui-red/5 text-ui-red',
  teal: 'border-ui-teal/30 bg-ui-teal/5 text-ui-teal',
  neutral: 'border-border bg-muted text-foreground/80',
  dashed: 'border-dashed border-foreground/25 text-muted-foreground',
};

const PulseBars = ({ pulse, name }: { pulse: IPulse; name: string }) => {
  if (!pulse.hours) {
    return (
      <div className="flex h-10 items-center rounded border border-dashed border-foreground/20 px-3 text-xs text-muted-foreground min-[600px]:h-12">
        Movement not measured: no source could be read
      </div>
    );
  }
  const max = Math.max(1, ...pulse.hours.map((hour) => hour.total));
  return (
    <div className="min-w-0 flex-1">
      <div role="img" aria-label={stripLabel(name, pulse)} className="flex h-10 items-end gap-px min-[600px]:h-12" data-pulse-bars>
        {pulse.hours.map((hour) => {
          const segments = barSegments(hour, max);
          return (
            <div key={hour.start} title={barTitle(hour)} className="flex h-full min-w-0 flex-1 flex-col-reverse" data-pulse-hour={hour.total}>
              {hour.total === 0 ? (
                <div className="h-0.5 w-full bg-ui-gray/25" />
              ) : (
                <>
                  {segments.failed > 0 && <div className="w-full bg-ui-red" style={{ height: `${segments.failed}%` }} />}
                  {segments.passed > 0 && <div className="w-full bg-ui-teal" style={{ height: `${segments.passed}%` }} />}
                  {segments.other > 0 && <div className="w-full bg-ui-gray/60" style={{ height: `${segments.other}%` }} />}
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
        <span>48 h ago</span>
        <span>now</span>
      </div>
    </div>
  );
};

const StallCap = ({ pulse }: { pulse: IPulse }) => {
  const label = stallLabel(pulse.stall.state);
  const hours = pulse.stall.state === 'stalled' && pulse.stall.hoursSinceMovement !== null ? ` for ${pulse.stall.hoursSinceMovement} h` : '';
  return (
    <div role="status" className={cn('shrink-0 rounded-md border px-2.5 py-1.5 text-sm font-medium min-[600px]:w-36', TONES[label.tone])}
      data-stall={pulse.stall.state}>
      {label.word}{hours}
    </div>
  );
};

const SourceChip = ({ source }: { source: IPulseSource }) => {
  if (source.sharedWith) {
    return (
      <span className="rounded border border-dashed border-foreground/25 px-2 py-0.5 text-muted-foreground" data-source={source.id}
        data-source-state="shared" title="Read from a directory another workspace lists too: shown, not counted in the bars or the stall">
        {sourceShort(source.id)} shared with {source.sharedWith.join(', ')}: {source.count ?? 'not measured'} (not counted)
      </span>
    );
  }
  return source.state === 'ok' ? (
    <span className="rounded bg-muted px-2 py-0.5" data-source={source.id} data-source-state="ok">
      {sourceShort(source.id)} {source.count}
    </span>
  ) : (
    <span className="rounded border border-dashed border-foreground/25 px-2 py-0.5 text-muted-foreground" data-source={source.id}
      data-source-state="unknown" title={source.reason ?? undefined}>
      {sourceShort(source.id)}: not measured ({source.reason})
    </span>
  );
};

interface IPulseRowProps {
  pulse: IPulse;
  workspaceName: string;
  selected: boolean;
  onSelect: (workspaceId: string) => void;
}

export const PulseRow = ({ pulse, workspaceName, selected, onSelect }: IPulseRowProps) => {
  const failed = pulse.hours?.reduce((sum, hour) => sum + hour.gatesFailed, 0) ?? 0;
  return (
    <div className={cn('min-w-0 space-y-2 rounded-lg border p-3', selected && 'border-foreground/30 bg-muted/30')} data-pulse-row={pulse.workspaceId}>
      <button type="button" aria-pressed={selected} onClick={() => onSelect(pulse.workspaceId)}
        className="flex w-full min-w-0 items-baseline justify-between gap-2 text-left">
        <span className="min-w-0 truncate text-sm font-semibold">{workspaceName}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{selected ? 'shown below' : 'show below'}</span>
      </button>
      <div className="flex flex-col gap-2 min-[600px]:flex-row min-[600px]:items-start">
        <PulseBars pulse={pulse} name={workspaceName} />
        <StallCap pulse={pulse} />
      </div>
      <p className="break-words text-sm" data-stall-reason>{pulse.stall.reason}</p>
      <p className="break-words text-sm" data-priority>
        <span className="font-medium">Priority now: </span>{pulse.priority.text}
        {pulse.staleSince !== null && <span className="text-ui-amber"> · stale since {aedtTime(pulse.staleSince)}</span>}
      </p>
      <p className="break-words text-xs text-muted-foreground">Work in progress: {pulse.wip.basisReason}</p>
      <p className="break-words text-xs text-muted-foreground" data-pulse-scope={pulse.scope.basis}>
        {pulse.scope.basis === 'epic' ? `Counts epic ${pulse.scope.epics.join(', ')}: its records and repositories` : 'Counts this workspace\'s own directories'}
      </p>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {pulse.sources.map((source) => <SourceChip key={source.id} source={source} />)}
        {failed > 0 && <span className="rounded bg-ui-red/10 px-2 py-0.5 text-ui-red">{failed} gate{failed === 1 ? '' : 's'} failed</span>}
      </div>
    </div>
  );
};

export default PulseRow;
