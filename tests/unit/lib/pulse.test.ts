import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { deriveConstraint } from '@/lib/constraint';
import { PULSE_HOURS, baselineMedian, derivePulse, pulseHours, pulsePriority, pulseStall, pulseWip } from '@/lib/pulse';
import type { IPulseSourceRead, IPulseWip } from '@/types/pulse';
import type { ILedgerItem } from '@/types/ledger';

const HOUR = 3_600_000;
// 06:30Z: half an hour into a clock hour.
const NOW = Date.UTC(2026, 10, 3, 6, 30, 0);

const read = (id: IPulseSourceRead['id'], ats: number[], outcome?: 'pass' | 'fail'): IPulseSourceRead =>
  ({ id, events: ats.map((at) => (outcome ? { at, outcome } : { at })), reason: null, from: [`/${id}`] });
const unread = (id: IPulseSourceRead['id'], reason = 'no repository'): IPulseSourceRead => ({ id, events: null, reason, from: [] });
/** Every source read, the commits holding `ats` and the rest empty: a stall reason then names no gap. */
const allRead = (ats: number[]): IPulseSourceRead[] =>
  (['ledger', 'commits', 'gates', 'reviews', 'landed', 'answers'] as const).map((id) => read(id, id === 'commits' ? ats : []));

const NO_LEDGER = { state: 'no-events' as const, openItems: 0, oldest: null };
const wipOf = (count: number | null, basis: IPulseWip['basis'] = 'agent-tabs'): IPulseWip => ({
  count, basis, basisReason: `${count} things`,
  sources: { ledger: 'no-events', agentTabs: 'measured', missionControl: 'measured' },
});

const item = (key: string, extra: Partial<ILedgerItem> = {}): ILedgerItem => ({
  workspaceId: 'ws-a', itemKey: key, itemType: 'range', openedAt: NOW - 5 * HOUR, closedAt: null, state: null, stateSince: null,
  waitReason: null, waitSince: null, holder: null, clearInput: null, parentKey: null, attrs: {}, lastEventAt: NOW - HOUR, lastSeq: 1, ...extra,
});

describe('pulse hours', () => {
  it('buckets 48 clock hours ending with the current one, from measured sources only', () => {
    const hours = pulseHours([read('commits', [NOW - 10 * 60_000, NOW - 47 * HOUR - 20 * 60_000, NOW - 49 * HOUR]),
      read('gates', [NOW - 5 * 60_000], 'fail'), read('gates', [NOW - 2 * HOUR], 'pass'), unread('landed')], NOW);
    expect(hours).toHaveLength(PULSE_HOURS);
    expect(hours[47].start).toBe(Date.UTC(2026, 10, 3, 6, 0, 0));
    expect(hours[0].start).toBe(Date.UTC(2026, 10, 1, 7, 0, 0));
    expect(hours[47]).toMatchObject({ total: 2, gatesFailed: 1, gatesPassed: 0, bySource: { commits: 1, gates: 1 } });
    expect(hours[45]).toMatchObject({ total: 1, gatesPassed: 1 });
    // 47 h 20 min ago is inside the first bar; 49 h ago is before the strip.
    expect(hours[0].total).toBe(1);
    expect(hours.reduce((sum, hour) => sum + hour.total, 0)).toBe(4);
  });

  it('the usual rate is the median of the active hours among 168 complete hours, the current hour left out (round 3, F13)', () => {
    const everyHour = Array.from({ length: 168 }, (_, i) => Date.UTC(2026, 10, 3, 6, 0, 0) - (i + 1) * HOUR + 60_000);
    expect(baselineMedian([read('commits', [...everyHour, ...everyHour.slice(0, 100)])], NOW)).toEqual({ median: 2, activeHours: 168 });
    expect(baselineMedian([read('commits', [NOW - 60_000, NOW - 120_000])], NOW)).toEqual({ median: null, activeHours: 0 });
  });
});

describe('pulse stall (AC 10, consult 12 Q1)', () => {
  it('red after 2 h with no movement while work is in progress, naming the oldest stuck item', () => {
    const oldestStuck = { kind: 'ledger-item' as const, id: 'range:a:1', label: 'range:a:1 waits on not armed', since: NOW - 9 * HOUR };
    const stall = pulseStall({ reads: allRead([NOW - 3 * HOUR - 5 * 60_000]), wip: wipOf(2, 'ledger'), oldestStuck, now: NOW });
    expect(stall).toMatchObject({ state: 'stalled', hoursSinceMovement: 3, oldestStuck });
    expect(stall.reason).toBe('no movement for 3 h · oldest stuck: range:a:1 waits on not armed');
  });

  it('a stall with nothing to name says so', () => {
    const stall = pulseStall({ reads: allRead([]), wip: wipOf(1), oldestStuck: null, now: NOW });
    expect(stall.state).toBe('stalled');
    expect(stall.reason).toBe('no movement in 7 days · no stuck item measured');
  });

  it('green when the last hour is at or above the 7-day hourly median', () => {
    const history = Array.from({ length: 168 }, (_, i) => Date.UTC(2026, 10, 3, 6, 0, 0) - (i + 1) * HOUR + 60_000);
    const stall = pulseStall({ reads: allRead([...history, NOW - 60_000]), wip: wipOf(3), oldestStuck: null, now: NOW });
    expect(stall).toMatchObject({ state: 'moving', lastHour: 1, medianPerHour: 1, activeHours: 168 });
    expect(stall.reason).toBe('moving: 1 event in the last hour, median of active hours 1/h');
  });

  it('no movement in the last hour never reads as moving', () => {
    const stall = pulseStall({ reads: allRead([NOW - 90 * 60_000]), wip: wipOf(1), oldestStuck: null, now: NOW });
    expect(stall.state).toBe('steady');
    expect(stall.reason).toBe('no movement for 1 h · 0 events in the last hour, median of active hours 1/h');
  });

  it('a sparse workspace (median 0 over all hours) is moving only at its active-hour rate (round 3, F13)', () => {
    // Three busy hours in the week, six events each: a median over all 168 hours would be 0.
    const busy = [30, 60, 100].flatMap((hoursAgo) => Array.from({ length: 6 }, (_, i) => Date.UTC(2026, 10, 3, 6) - hoursAgo * HOUR + i * 60_000));
    const slow = pulseStall({ reads: allRead([...busy, NOW - 10 * 60_000, NOW - 20 * 60_000]), wip: wipOf(1), oldestStuck: null, now: NOW });
    expect(slow).toMatchObject({ state: 'steady', medianPerHour: 6, activeHours: 3 });
    expect(slow.reason).toBe('2 events in the last hour, median of active hours 6/h');
    const fast = pulseStall({ reads: allRead([...busy, ...Array.from({ length: 7 }, (_, i) => NOW - (i + 1) * 60_000)]), wip: wipOf(1), oldestStuck: null, now: NOW });
    expect(fast).toMatchObject({ state: 'moving', reason: 'moving: 7 events in the last hour, median of active hours 6/h' });
    const first = pulseStall({ reads: allRead([NOW - 60_000]), wip: wipOf(1), oldestStuck: null, now: NOW });
    expect(first).toMatchObject({ state: 'moving', medianPerHour: null, reason: 'moving: 1 event in the last hour, no active hour in 7 days' });
  });

  it('pinned: three idle lane tabs, an empty ledger, no MC item and 6 h quiet read idle on the agent-tab basis', () => {
    const { wip, oldestStuck } = pulseWip({ ledger: NO_LEDGER, agentTabs: [], mcItems: [] });
    expect(wip).toMatchObject({ count: 0, basis: 'agent-tabs' });
    expect(oldestStuck).toBeNull();
    const stall = pulseStall({ reads: [read('commits', [NOW - 6 * HOUR])], wip, oldestStuck, now: NOW });
    expect(stall.state).toBe('idle');
  });

  it('no WIP basis is not measured, never idle', () => {
    const { wip } = pulseWip({ ledger: { ...NO_LEDGER, state: 'unreadable' }, agentTabs: null, mcItems: null });
    expect(wip).toMatchObject({ count: null, basis: 'none' });
    const stall = pulseStall({ reads: [read('commits', [NOW - 6 * HOUR])], wip, oldestStuck: null, now: NOW });
    expect(stall.state).toBe('not-measured');
    expect(stall.reason).toMatch(/^work in progress not measured \(not measured: the ledger cannot be read/);
  });

  it('no movement source read is not measured', () => {
    const stall = pulseStall({ reads: [unread('commits'), unread('gates')], wip: wipOf(4), oldestStuck: null, now: NOW });
    expect(stall).toMatchObject({ state: 'not-measured', hoursSinceMovement: null, lastHour: null });
  });
});

describe('pulse stall on partial sources (round 2, F4)', () => {
  it('names every unmeasured source in the reason', () => {
    const stall = pulseStall({ reads: [read('commits', [NOW - 3 * HOUR]), unread('gates'), read('answers', [])], wip: wipOf(1), oldestStuck: null, now: NOW });
    expect(stall.state).toBe('stalled');
    expect(stall.reason).toBe('no movement for 3 h · no stuck item measured · not measured: ledger changes, gates finished, review rounds and confirmations, v2 landings');
  });

  it('without one file-born source read, the ledger and MC answers alone never decide a stall', () => {
    const stall = pulseStall({ reads: [read('ledger', [NOW - 5 * HOUR]), read('answers', []), unread('commits'), unread('gates')], wip: wipOf(3), oldestStuck: null, now: NOW });
    expect(stall).toMatchObject({ state: 'not-measured', hoursSinceMovement: null });
    expect(stall.reason).toMatch(/^not measured: no file-born source \(commits, gates, review rounds, landings\) could be read · not measured: /);
  });

  it('a shared source is shown, never counted in the bars or the stall (round 2, F1)', () => {
    const pulse = derivePulse({
      workspaceId: 'ws-s', now: NOW, oldestStuck: null, staleSince: null, wip: wipOf(1),
      priority: { basis: 'none', needsYou: 0, text: 'x' },
      reads: [read('commits', [NOW - 5 * HOUR]), { ...read('gates', [NOW - 60_000, NOW - 120_000]), sharedWith: ['Audit'] }],
    });
    expect(pulse.stall.state).toBe('stalled');
    expect(pulse.hours!.reduce((sum, hour) => sum + hour.total, 0)).toBe(1);
    expect(pulse.sources.find((source) => source.id === 'gates' && source.sharedWith === null)).toMatchObject({ state: 'unknown', reason: 'no reader' });
    expect(pulse.sources.at(-1)).toMatchObject({ id: 'gates', state: 'ok', count: 2, sharedWith: ['Audit'] });
  });
});

describe('pulse WIP (consult 12 Q1)', () => {
  it('the ledger is the only basis once it holds an event in 7 days', () => {
    const oldest = { kind: 'ledger-item' as const, id: 'range:a:1', label: 'range:a:1', since: NOW - HOUR };
    const { wip, oldestStuck } = pulseWip({
      ledger: { state: 'measured', openItems: 4, oldest },
      agentTabs: [{ tabId: 't1', name: 'w1', state: 'needs-input', since: NOW - 3 * HOUR }], mcItems: [],
    });
    expect(wip).toEqual({
      count: 4, basis: 'ledger', basisReason: '4 open ledger items',
      sources: { ledger: 'measured', agentTabs: 'not-used', missionControl: 'not-used' },
    });
    expect(oldestStuck).toBe(oldest);
  });

  it('else live agent tabs plus open MC items; the stall names the oldest of them', () => {
    const { wip, oldestStuck } = pulseWip({
      ledger: NO_LEDGER,
      agentTabs: [{ tabId: 't1', name: 'w1', state: 'busy', since: NOW - 5 * HOUR }, { tabId: 't2', name: 'w2', state: 'busy', since: null }],
      mcItems: [{ id: 'mc-1', title: 'Pick a port', createdAt: NOW - 2 * HOUR }],
    });
    expect(wip.count).toBe(3);
    expect(wip.basisReason).toBe('2 agent tabs working or waiting for input, 1 open Mission Control item (the ledger holds no work-item event for this workspace in 7 days)');
    // A busy tab is working, not stuck: the older busy turn is never named.
    expect(oldestStuck).toEqual({ kind: 'mc-item', id: 'mc-1', label: 'Mission Control: Pick a port', since: NOW - 2 * HOUR });
  });

  it('a tab waiting for input is stuck from when it began waiting and can be the oldest stuck item (round 2, F10)', () => {
    const { oldestStuck } = pulseWip({
      ledger: NO_LEDGER,
      agentTabs: [{ tabId: 't1', name: 'hfl-12', state: 'needs-input', since: NOW - 4 * HOUR }],
      mcItems: [{ id: 'mc-1', title: 'Pick a port', createdAt: NOW - 2 * HOUR }],
    });
    expect(oldestStuck).toEqual({ kind: 'agent-tab', id: 't1', label: 'tab hfl-12 waiting for input', since: NOW - 4 * HOUR });
  });

  it('an unreadable source WIP rests on is unknown, never 0', () => {
    expect(pulseWip({ ledger: NO_LEDGER, agentTabs: [], mcItems: null }).wip).toMatchObject({
      count: null, sources: { missionControl: 'unreadable', agentTabs: 'measured' },
    });
    expect(pulseWip({ ledger: NO_LEDGER, agentTabs: null, mcItems: [{ id: 'm', title: 't', createdAt: NOW }] }).wip.count).toBe(1);
  });
});

describe('pulse priority (AC 10)', () => {
  it('the constraint with owner and clear input, and the needs-you count', () => {
    const finder = deriveConstraint({
      intervals: [], lastProducer: {}, firstEventAt: NOW - 30 * 24 * HOUR, tabWakes: null, ownerIssueSource: null,
      items: [item('range:a:1', { waitReason: 'not-armed', waitSince: NOW - 2 * HOUR, holder: 'lane-a', clearInput: 'arm the receipt' })],
    }, null, null, null, NOW);
    expect(pulsePriority(finder, 2)).toEqual({
      basis: 'constraint', needsYou: 2, text: 'not armed to land: owner lane-a, clears when arm the receipt · needs you: 2',
    });
  });

  it('when the ledger is unknown it says so; Mission Control unreadable is unknown', () => {
    const finder = deriveConstraint(null, null, null, null, NOW);
    expect(pulsePriority(finder, null).text).toBe('constraint unknown (ledger unreadable) · needs you: unknown (Mission Control unreadable)');
  });

  it('with no constraint, the oldest stuck critical item', () => {
    const finder = { constraint: null, inputs: deriveConstraint(null, null, null, null, NOW).inputs, stuck: [
      { key: 'range:a:1', itemType: 'range' as const, holder: null, reason: 'not-armed' as const, since: NOW, clearInput: null, critical: false, reasonLabel: 'not armed' },
      { key: 'range:b:1', itemType: 'range' as const, holder: 'b', reason: 'lock-wait' as const, since: NOW, clearInput: 'lock free', critical: true, reasonLabel: 'lock wait' },
    ] };
    finder.inputs = { ...finder.inputs, ledger: { state: 'ok', reason: null, at: NOW } };
    expect(pulsePriority(finder, 0)).toMatchObject({ basis: 'stuck-critical', text: 'range:b:1: lock wait, held by b, clears when lock free · needs you: 0' });
  });
});

describe('derivePulse', () => {
  it('shows each source with its own state: an unread source is not measured, never a zero bar', () => {
    const pulse = derivePulse({
      workspaceId: 'ws-a', reads: [read('commits', [NOW - 60_000]), unread('landed', 'no .v2/landings.log in the workspace directories')],
      wip: wipOf(1), oldestStuck: null, priority: { basis: 'none', needsYou: 0, text: 'x' }, staleSince: null, now: NOW,
    });
    expect(pulse.sources.map((source) => source.id)).toEqual(['ledger', 'commits', 'gates', 'reviews', 'landed', 'answers']);
    expect(pulse.sources.find((source) => source.id === 'landed')).toMatchObject({ state: 'unknown', count: null, reason: 'no .v2/landings.log in the workspace directories' });
    expect(pulse.sources.find((source) => source.id === 'commits')).toMatchObject({ state: 'ok', count: 1, lastAt: NOW - 60_000 });
    expect(pulse.sources.find((source) => source.id === 'gates')).toMatchObject({ state: 'unknown', reason: 'no reader' });
  });

  it('no measured source: no bars at all', () => {
    const pulse = derivePulse({ workspaceId: 'ws-a', reads: [], wip: wipOf(null, 'none'), oldestStuck: null,
      priority: { basis: 'unknown', needsYou: null, text: 'x' }, staleSince: null, now: NOW });
    expect(pulse.hours).toBeNull();
    expect(pulse.stall.state).toBe('not-measured');
  });

  it('is pure: no Node import, no clock', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/lib/pulse.ts'), 'utf8');
    expect(source).not.toMatch(/from '(fs|path|os|child_process|node:[a-z]+)'/);
    expect(source).not.toMatch(/Date\.now|new Date\(/);
  });
});
