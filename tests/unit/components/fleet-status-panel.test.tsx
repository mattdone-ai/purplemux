import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoordinationErrorBoundary } from '@/components/features/mission-control/coordination-panel';
import { FleetStatusView, type IFleetFilter } from '@/components/features/mission-control/fleet-status-panel';
import type { TFleetSection } from '@/types/coordination';
import type { IFleetRow, IFleetView } from '@/types/fleet-status';

// ADR-0023: every state of the fleet status panel renders, and no state is a blank.

const AT = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;

const row = (over: Partial<IFleetRow> = {}): IFleetRow => ({
  workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-a', tabName: 'lfr-cat-regress',
  panelType: 'claude-code', providerId: 'claude', epic: null, state: 'working', rawCliState: 'busy',
  since: AT - 5 * MIN, lastActivityAt: AT - MIN, waits: [], lastLine: null, endLineUnknown: false,
  inbox: { open: 0, unanswered: 0, oldestAt: null }, flags: [], ...over,
});
const view = (over: Partial<IFleetView> = {}): IFleetView => ({
  at: AT, thresholds: { stallMinutes: 30, waitingLongMinutes: 120, unansweredMinutes: 30, composerMinutes: 2 },
  rows: [], unattributed: [], errors: [], ...over,
});
const FLAGGED_ONLY: IFleetFilter = { showAll: false, workspace: null };
const render = (fleet: TFleetSection | undefined, { error = null as string | null, loading = false, filter = FLAGGED_ONLY } = {}) =>
  renderToStaticMarkup(<FleetStatusView fleet={fleet} error={error} loading={loading} onRetry={() => {}} filter={filter} onFilter={() => {}} />);
const ok = (v: IFleetView): TFleetSection => ({ ok: true, view: v });

describe('fleet status panel', () => {
  it('loading', () => {
    expect(render(undefined, { loading: true })).toContain('data-state="loading"');
  });

  it('error before any snapshot shows the error and a Retry button', () => {
    const html = render(undefined, { error: 'Request failed (502)' });
    expect(html).toContain('data-state="error"');
    expect(html).toContain('Fleet status unavailable: Request failed (502)');
    expect(html).toMatch(/<button[^>]*>Retry<\/button>/);
  });

  it('a server older than the panel says so, never a blank', () => {
    expect(render(undefined)).toContain('data-state="unsupported"');
  });

  it('a failed fleet section shows its served error and Retry', () => {
    const html = render({ ok: false, error: 'workspaces.json unreadable' });
    expect(html).toContain('Fleet status could not be read: workspaces.json unreadable');
    expect(html).toMatch(/>Retry</);
  });

  it('empty: no agent tabs', () => {
    const html = render(ok(view()));
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('0 flagged · 0 agent tabs');
  });

  it('no flags: flagged-only view says so and offers every tab', () => {
    const html = render(ok(view({ rows: [row(), row({ tabId: 'tab-b', tabName: 'ix-api' })] })));
    expect(html).toContain('data-state="no-flags"');
    expect(html).toContain('Show all 2 tabs');
    expect(html).not.toContain('data-fleet-row=');
  });

  it('shows the thresholds with their units', () => {
    expect(render(ok(view({ rows: [row()] })))).toContain(
      'STALL? after 30 min (composer text after 2 min) · WAITING-LONG after 120 min · UNANSWERED after 30 min',
    );
  });

  it('a flagged row shows its badge, state, time in state, last line, inbox and the reason', () => {
    const html = render(ok(view({ rows: [row({
      tabName: 'masspay-lineage-arch', epic: 'masspay', state: 'unsubmitted', rawCliState: 'idle', since: AT - 150 * MIN,
      lastLine: { text: 'CHECKPOINTED: brief read', at: AT - 151 * MIN },
      inbox: { open: 2, unanswered: 1, oldestAt: AT - 41 * MIN },
      flags: [
        { flag: 'stall', reason: 'text left unsubmitted in the composer for 2 h 30 min' },
        { flag: 'unanswered', reason: '1 SM-inbox item(s) unanswered; oldest open 41 min' },
      ],
    })] })));
    expect(html).toContain('1 flagged · 1 agent tabs');
    expect(html).toMatch(/data-flag="stall"[^>]*>STALL\?</);
    expect(html).toMatch(/data-flag="unanswered"[^>]*>UNANSWERED</);
    expect(html).toContain('text not submitted 2 h 30 min');
    expect(html).toContain('masspay');
    expect(html).toContain('CHECKPOINTED: brief read');
    expect(html).toContain('SM inbox 2 open · oldest 41 min');
    expect(html).toContain('STALL? text left unsubmitted in the composer for 2 h 30 min');
  });

  it('a waiting row names what it waits on', () => {
    const html = render(ok(view({ rows: [row({
      state: 'waiting', since: AT - 130 * MIN,
      waits: [{ kind: 'watch', label: 'o/r#12', detail: 'pr' }, { kind: 'job', label: 'gate' }, { kind: 'background', label: '2' }],
      flags: [{ flag: 'waiting-long', reason: 'waiting 2 h 10 min on watch o/r#12' }],
    })] })));
    expect(html).toContain('waiting 2 h 10 min');
    expect(html).toContain('on watch o/r#12 (pr), job gate, 2 background tasks');
  });

  it('an unknown state reads a neutral word with the raw value in a tooltip; an unmapped one reads "other"', () => {
    const flag = [{ flag: 'stall' as const, reason: 'x' }];
    const html = render(ok(view({ rows: [
      row({ tabId: 't1', state: 'unknown', rawCliState: 'teleporting', since: null, flags: flag }),
      row({ tabId: 't2', state: 'hibernating' as never, rawCliState: 'zzz', flags: flag }),
    ] })));
    expect(html).toMatch(/title="served state: teleporting"[^>]*>unknown /);
    expect(html).toMatch(/title="served state: zzz"[^>]*>other /);
    expect(html).not.toContain('>hibernating');
  });

  it('absence is absence: no last line, an unreadable inbox and no activity read "—"', () => {
    const html = render(ok(view({ rows: [row({ lastActivityAt: null, inbox: null, flags: [{ flag: 'stall', reason: 'x' }] })] })));
    expect(html).toContain('last line —');
    expect(html).toContain('SM inbox —');
    expect(html).toContain('last activity — ago');
  });

  it('a long last line is truncated, with the whole line in the tooltip', () => {
    const text = `DONE: ${'x'.repeat(300)}`;
    const html = render(ok(view({ rows: [row({ lastLine: { text, at: AT }, flags: [{ flag: 'stall', reason: 'x' }] })] })));
    expect(html).toContain(`title="${text}"`);
    expect(html).toContain('…');
  });

  it('unattributed SM-inbox items show on their workspace line with UNANSWERED', () => {
    const html = render(ok(view({
      rows: [row()],
      unattributed: [{ workspaceId: 'ws-1', workspaceName: 'Portfolio', inbox: { open: 3, unanswered: 2, oldestAt: AT - 70 * MIN }, flags: [{ flag: 'unanswered', reason: 'r' }] }],
    })));
    expect(html).toContain('data-fleet-unattributed="ws-1"');
    expect(html).toContain('SM inbox 3 open · oldest 1 h 10 min');
    expect(html).toContain('1 flagged · 1 agent tabs');
  });

  it('partial read errors are named above the rows; a failed refresh keeps the last view and offers Retry', () => {
    const html = render(ok(view({ rows: [row()], errors: [{ scope: 'watches', error: 'watches.json is malformed' }] })), { error: 'timeout' });
    expect(html).toContain('Could not read watches: watches.json is malformed');
    expect(html).toMatch(/data-state="refresh-error".*Last refresh failed: timeout.*>Retry</);
    expect(html).toContain('data-fleet-view=""');
  });

  it('the filter is controlled from outside: "Show all" lists every row and survives a new snapshot', () => {
    const rows = [row(), row({ tabId: 'tab-b', tabName: 'ix-api' })];
    const shown = { showAll: true, workspace: null };
    for (const at of [AT, AT + 15_000]) {
      const html = render(ok(view({ at, rows })), { filter: shown });
      expect(html).toContain('data-fleet-row="tab-a"');
      expect(html).toContain('data-fleet-row="tab-b"');
      expect(html).toContain('Flagged only');
    }
    const one = render(ok(view({ rows: [...rows, row({ workspaceId: 'ws-2', workspaceName: 'Billing', tabId: 'tab-z' })] })), { filter: { showAll: true, workspace: 'ws-2' } });
    expect(one).toContain('data-fleet-row="tab-z"');
    expect(one).not.toContain('data-fleet-row="tab-a"');
    // A kept filter naming a workspace with no rows this poll falls back to every workspace.
    const gone = render(ok(view({ rows: [row({ flags: [{ flag: 'stall', reason: 'x' }] })] })), { filter: { showAll: false, workspace: 'ws-deleted' } });
    expect(gone).toContain('data-fleet-row="tab-a"');
    expect(gone).not.toContain('data-state="no-flags"');
  });

  it('after a restart an unknown end line reads as unknown, never "no end line"', () => {
    const html = render(ok(view({ rows: [row({ state: 'ready-for-review', endLineUnknown: true, since: AT - 90 * MIN })] })), { filter: { showAll: true, workspace: null } });
    expect(html).toContain('idle, end line unknown after a restart 1 h 30 min');
    expect(html).toContain('last line unknown');
    expect(html).not.toContain('idle, no end line');
  });

  it('with no agent tabs, an unattributed SM-inbox line still shows', () => {
    const html = render(ok(view({
      unattributed: [{ workspaceId: 'ws-1', workspaceName: 'Portfolio', inbox: { open: 1, unanswered: 1, oldestAt: AT - 40 * MIN }, flags: [{ flag: 'unanswered', reason: 'r' }] }],
    })));
    expect(html).toContain('No agent tabs in any workspace.');
    expect(html).toContain('data-fleet-unattributed="ws-1"');
    expect(html).toContain('1 flagged · 0 agent tabs');
  });

  it('several workspaces get a filter with their flagged counts', () => {
    const html = render(ok(view({ rows: [row(), row({ workspaceId: 'ws-2', workspaceName: 'Billing', tabId: 'tab-z', flags: [{ flag: 'stall', reason: 'x' }] })] })));
    expect(html).toMatch(/>All</);
    expect(html).toMatch(/Billing<span[^>]*>1</);
  });

  it('the shared error boundary names this panel when it fails', () => {
    const boundary = new CoordinationErrorBoundary({ children: <p>child</p>, label: 'Fleet status' });
    boundary.state = { error: 'Invalid time value' };
    expect(renderToStaticMarkup(<>{boundary.render()}</>)).toContain('Fleet status failed to render: Invalid time value');
  });
});
