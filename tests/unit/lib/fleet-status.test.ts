import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FLEET_THRESHOLDS, deriveFleetRow, formatDuration, inboxOf, parseThresholdMinutes, sortFleetRows, unansweredFlag,
} from '@/lib/fleet-status';
import type { IFleetTabFacts } from '@/types/fleet-status';
import type { ITurnEndRecord } from '@/types/status';

// ADR-0023: the fleet status derivation — every state arm, every flag arm, and
// each threshold just below and at its limit.

const NOW = Date.parse('2026-10-16T12:00:00Z');
const MIN = 60_000;

const facts = (over: Partial<IFleetTabFacts> = {}, status: Partial<NonNullable<IFleetTabFacts['status']>> = {}): IFleetTabFacts => ({
  workspaceId: 'ws-1',
  workspaceName: 'Portfolio',
  tabId: 'tab-a',
  tabName: 'worker-a',
  panelType: 'claude-code',
  providerId: 'claude',
  epic: null,
  status: {
    cliState: 'busy',
    lastEvent: { name: 'prompt-submit', at: NOW - 5 * MIN, seq: 10 },
    busySince: NOW - 5 * MIN,
    readyForReviewAt: null,
    turnEnd: null,
    permissionRequest: null,
    ...status,
  },
  transcriptAt: NOW - MIN,
  stallReportedAt: null,
  inactiveSince: null,
  watches: [],
  liveJobs: [],
  composer: null,
  inbox: [],
  ...over,
});

const stop = (at: number, seq = 20) => ({ name: 'stop' as const, at, seq });
const turnEnd = (kind: ITurnEndRecord['kind'], at: number, extra: Partial<ITurnEndRecord> = {}): ITurnEndRecord => ({ kind, at, seq: 20, ...extra });
const flags = (f: IFleetTabFacts) => deriveFleetRow(f, NOW).flags.map((x) => x.flag);

describe('fleet status: state', () => {
  it('busy mid-turn is working, since busySince', () => {
    const row = deriveFleetRow(facts(), NOW);
    expect(row.state).toBe('working');
    expect(row.since).toBe(NOW - 5 * MIN);
    expect(row.lastActivityAt).toBe(NOW - MIN);
  });

  it('busy on a current waiting stop is waiting, with every registered wait listed', () => {
    const row = deriveFleetRow(facts({
      watches: [{ kind: 'pr', target: 'o/r#12' }, { kind: 'lease', target: 'merge:o/r' }],
      liveJobs: [{ pid: 41, label: 'gate' }, { pid: 42 }],
    }, { lastEvent: stop(NOW - 37 * MIN), turnEnd: turnEnd('waiting', NOW - 37 * MIN, { openBackgroundTasks: 2 }) }), NOW);
    expect(row.state).toBe('waiting');
    expect(row.since).toBe(NOW - 37 * MIN);
    expect(row.waits).toEqual([
      { kind: 'watch', label: 'o/r#12', detail: 'pr' },
      { kind: 'watch', label: 'merge:o/r', detail: 'lease' },
      { kind: 'job', label: 'gate' },
      { kind: 'job', label: 'pid 42' },
      { kind: 'background', label: '2' },
    ]);
  });

  it('a waiting turnEnd that a newer event overtook is working again', () => {
    const row = deriveFleetRow(facts({}, {
      lastEvent: { name: 'prompt-submit', at: NOW - MIN, seq: 21 },
      turnEnd: turnEnd('waiting', NOW - 37 * MIN),
    }), NOW);
    expect(row.state).toBe('working');
  });

  it('a permission request is needs-input whatever the cliState', () => {
    const row = deriveFleetRow(facts({}, { permissionRequest: { id: 'p' } as never }), NOW);
    expect(row.state).toBe('needs-input');
  });

  it('ready-for-review on a current marker stop is ended, with the last line', () => {
    const row = deriveFleetRow(facts({}, {
      cliState: 'ready-for-review', lastEvent: stop(NOW - 3 * MIN), readyForReviewAt: NOW - 3 * MIN,
      turnEnd: turnEnd('turn-marker', NOW - 3 * MIN, { marker: ['READY-TO-MERGE: #1', '  DONE: shipped #12  '] }),
    }), NOW);
    expect(row.state).toBe('ended');
    expect(row.lastLine).toEqual({ text: 'DONE: shipped #12', at: NOW - 3 * MIN });
  });

  it('ready-for-review without a marker stays ready-for-review, since readyForReviewAt', () => {
    const row = deriveFleetRow(facts({}, {
      cliState: 'ready-for-review', lastEvent: stop(NOW - 9 * MIN), readyForReviewAt: NOW - 8 * MIN,
      turnEnd: turnEnd('ready-for-review', NOW - 9 * MIN),
    }), NOW);
    expect(row.state).toBe('ready-for-review');
    expect(row.since).toBe(NOW - 8 * MIN);
    expect(row.lastLine).toBeNull();
  });

  it('idle with no marker is idle since its last event; idle on a marker stop is ended', () => {
    expect(deriveFleetRow(facts({}, { cliState: 'idle', lastEvent: stop(NOW - 4 * MIN) }), NOW)).toMatchObject({ state: 'idle', since: NOW - 4 * MIN });
    expect(deriveFleetRow(facts({}, {
      cliState: 'idle', lastEvent: stop(NOW - 4 * MIN), turnEnd: turnEnd('turn-marker', NOW - 4 * MIN, { marker: ['BLOCKED: x'] }),
    }), NOW).state).toBe('ended');
  });

  it('text in the composer of a tab at its prompt is unsubmitted, since the composer stamp', () => {
    const row = deriveFleetRow(facts({ composer: { reading: 'text', since: NOW - 150 * MIN } }, { cliState: 'idle', lastEvent: stop(NOW - 151 * MIN) }), NOW);
    expect(row.state).toBe('unsubmitted');
    expect(row.since).toBe(NOW - 150 * MIN);
  });

  it('an empty or unreadable composer does not change the state', () => {
    for (const reading of ['empty', 'unreadable'] as const) {
      expect(deriveFleetRow(facts({ composer: { reading, since: null } }, { cliState: 'idle', lastEvent: stop(NOW) }), NOW).state).toBe('idle');
    }
  });

  it('inactive is inactive; an unknown or unmapped cliState is unknown with the raw value kept', () => {
    expect(deriveFleetRow(facts({}, { cliState: 'inactive' }), NOW).state).toBe('inactive');
    expect(deriveFleetRow(facts({}, { cliState: 'unknown' }), NOW)).toMatchObject({ state: 'unknown', rawCliState: 'unknown' });
    expect(deriveFleetRow(facts({}, { cliState: 'teleporting' as never }), NOW)).toMatchObject({ state: 'unknown', rawCliState: 'teleporting' });
    expect(deriveFleetRow(facts({ status: null }), NOW)).toMatchObject({ state: 'unknown', rawCliState: null, since: null });
  });
});

describe('fleet status: flags', () => {
  it('STALL? on a working tab: quiet for N min flags, one minute less does not', () => {
    const at = (quietMin: number) => facts({ transcriptAt: NOW - quietMin * MIN }, { lastEvent: { name: 'prompt-submit', at: NOW - 90 * MIN, seq: 1 } });
    expect(flags(at(29))).toEqual([]);
    expect(flags(at(30))).toEqual(['stall']);
    expect(deriveFleetRow(at(30), NOW).flags[0].reason).toBe('busy with no activity for 30 min');
  });

  it('a working tab with no transcript stamp is judged only on the watchdog verdict', () => {
    const remote = (stallReportedAt: number | null) => facts({ transcriptAt: null, stallReportedAt }, { lastEvent: { name: 'prompt-submit', at: NOW - 300 * MIN, seq: 1 } });
    expect(flags(remote(null))).toEqual([]);
    expect(flags(remote(NOW - 10 * MIN))).toEqual(['stall']);
  });

  it('STALL? on a working tab the watchdog reported, until the tab shows activity after the report', () => {
    const quietSince = facts({ stallReportedAt: NOW - 4 * MIN, transcriptAt: NOW - 20 * MIN }, { lastEvent: { name: 'prompt-submit', at: NOW - 25 * MIN, seq: 1 } });
    expect(deriveFleetRow(quietSince, NOW).flags).toEqual([{ flag: 'stall', reason: 'the watchdog reported this tab as stalled 4 min ago' }]);
    // The latch is once per busy stretch: a tab that recovered (transcript written after it) is not stalled.
    const recovered = facts({ stallReportedAt: NOW - 60 * MIN, transcriptAt: NOW - MIN });
    expect(flags(recovered)).toEqual([]);
  });

  it('STALL? on a waiting tab the watchdog reported, before WAITING-LONG', () => {
    const waiting = (stallReportedAt: number | null, transcriptAt = NOW - 20 * MIN) => facts({ stallReportedAt, transcriptAt }, {
      lastEvent: stop(NOW - 20 * MIN), turnEnd: turnEnd('waiting', NOW - 20 * MIN, { openBackgroundTasks: 1 }),
    });
    expect(flags(waiting(null))).toEqual([]);
    expect(flags(waiting(NOW - 2 * MIN))).toEqual(['stall']);
    expect(flags(waiting(NOW - 2 * MIN, NOW - MIN))).toEqual([]);
  });

  it('after a restart with no persisted stop, the end line is unknown: no STALL?, never "no end line"', () => {
    for (const cliState of ['ready-for-review', 'idle'] as const) {
      const row = deriveFleetRow(facts({}, { cliState, lastEvent: null, readyForReviewAt: NOW - 90 * MIN, turnEnd: null }), NOW);
      expect(row).toMatchObject({ endLineUnknown: true, lastLine: null, flags: [] });
    }
    expect(deriveFleetRow(facts({}, { cliState: 'idle', lastEvent: stop(NOW - 90 * MIN) }), NOW).endLineUnknown).toBe(false);
    // Text in the composer is the state that matters; the label is not "end line unknown".
    const typed = deriveFleetRow(facts({ composer: { reading: 'text', since: NOW - 5 * MIN } }, { cliState: 'idle', lastEvent: null }), NOW);
    expect(typed).toMatchObject({ state: 'unsubmitted', endLineUnknown: false });
  });

  it('STALL? on a tab whose agent stopped running N min ago, timed from the transition, not the last event', () => {
    const dead = (min: number | null, marker?: string) => facts({ inactiveSince: min === null ? null : NOW - min * MIN }, {
      cliState: 'inactive', lastEvent: stop(NOW - 180 * MIN),
      turnEnd: marker ? turnEnd('turn-marker', NOW - 180 * MIN, { marker: [marker] }) : null,
    });
    expect(flags(dead(1))).toEqual([]);
    expect(deriveFleetRow(dead(30), NOW).flags).toEqual([{ flag: 'stall', reason: 'agent not running for 30 min' }]);
    expect(flags(dead(null))).toEqual([]);
    // Exited on purpose after finishing: no flag. Exited on its own question: still a stall.
    expect(flags(dead(60, 'DONE: shipped'))).toEqual([]);
    expect(flags(dead(60, 'BLOCKED: creds'))).toEqual(['stall']);
    // Crashed mid-turn after a DONE turn: that line belongs to an older stop, so it is no exemption.
    const crashed = facts({ inactiveSince: NOW - 40 * MIN }, {
      cliState: 'inactive', lastEvent: { name: 'prompt-submit', at: NOW - 50 * MIN, seq: 21 },
      turnEnd: turnEnd('turn-marker', NOW - 180 * MIN, { marker: ['DONE: shipped'] }),
    });
    expect(flags(crashed)).toEqual(['stall']);
  });

  it('a working tab counts from its latest prompt, not from the start of a WAITING chain', () => {
    const row = deriveFleetRow(facts({}, { busySince: NOW - 90 * MIN, lastEvent: { name: 'prompt-submit', at: NOW - 4 * MIN, seq: 5 } }), NOW);
    expect(row.since).toBe(NOW - 4 * MIN);
  });

  it('text left in the composer of a tab WAITING at its prompt is unsubmitted', () => {
    const row = deriveFleetRow(facts({ composer: { reading: 'text', since: NOW - 3 * MIN } }, {
      lastEvent: stop(NOW - 30 * MIN), turnEnd: turnEnd('waiting', NOW - 30 * MIN),
    }), NOW);
    expect(row.state).toBe('unsubmitted');
    expect(row.flags.map((f) => f.flag)).toEqual(['stall']);
  });

  it('STALL? on an idle tab without an end line or a registered wait, at N min', () => {
    const idle = (min: number, over: Partial<IFleetTabFacts> = {}) => facts(over, { cliState: 'ready-for-review', lastEvent: stop(NOW - min * MIN), readyForReviewAt: NOW - min * MIN });
    expect(flags(idle(29))).toEqual([]);
    expect(flags(idle(30))).toEqual(['stall']);
    expect(flags(idle(300, { watches: [{ kind: 'pr', target: 'o/r#1' }] }))).toEqual([]);
    expect(flags(idle(300, { liveJobs: [{ pid: 1 }] }))).toEqual([]);
    // An unreadable store is not proof of no wait: no flag on a guess.
    expect(flags(idle(300, { liveJobs: null }))).toEqual([]);
    expect(flags(idle(300, { watches: null }))).toEqual([]);
    expect(flags(facts({}, { cliState: 'idle', lastEvent: stop(NOW - 30 * MIN) }))).toEqual(['stall']);
  });

  it('no STALL? on a tab that ended with a line, however long ago', () => {
    expect(flags(facts({}, {
      cliState: 'ready-for-review', lastEvent: stop(NOW - 600 * MIN),
      turnEnd: turnEnd('turn-marker', NOW - 600 * MIN, { marker: ['DONE: x'] }),
    }))).toEqual([]);
  });

  it('STALL? on composer text left past the composer threshold (2 min by default)', () => {
    const typed = (min: number) => facts({ composer: { reading: 'text', since: NOW - min * MIN } }, { cliState: 'idle', lastEvent: stop(NOW - 200 * MIN) });
    expect(flags(typed(1))).toEqual([]);
    expect(flags(typed(2))).toEqual(['stall']);
    expect(deriveFleetRow(typed(150), NOW).flags[0].reason).toBe('text left unsubmitted in the composer for 2 h 30 min');
  });

  it('STALL? on needs-input past N min', () => {
    expect(flags(facts({}, { cliState: 'needs-input', lastEvent: { name: 'notification', at: NOW - 29 * MIN, seq: 3 } }))).toEqual([]);
    expect(flags(facts({}, { cliState: 'needs-input', lastEvent: { name: 'notification', at: NOW - 30 * MIN, seq: 3 } }))).toEqual(['stall']);
  });

  it('WAITING-LONG at M min, never STALL? while the wait is live', () => {
    const waiting = (min: number) => facts({ watches: [{ kind: 'pr', target: 'o/r#9' }] }, {
      lastEvent: stop(NOW - min * MIN), turnEnd: turnEnd('waiting', NOW - min * MIN),
    });
    expect(flags(waiting(119))).toEqual([]);
    expect(flags(waiting(120))).toEqual(['waiting-long']);
    expect(deriveFleetRow(waiting(120), NOW).flags[0].reason).toBe('waiting 2 h on watch o/r#9');
  });

  it('UNANSWERED counts only unreviewed items older than K min; a reviewed one never flags', () => {
    const inbox = (items: Array<[number, boolean]>) => facts({ inbox: items.map(([min, reviewed]) => ({ createdAt: NOW - min * MIN, reviewed })) });
    expect(flags(inbox([[29, false]]))).toEqual([]);
    expect(flags(inbox([[30, false]]))).toEqual(['unanswered']);
    expect(flags(inbox([[300, true]]))).toEqual([]);
    const row = deriveFleetRow(inbox([[45, false], [31, false], [5, false], [400, true]]), NOW);
    expect(row.inbox).toEqual({ open: 4, unanswered: 2, oldestAt: NOW - 400 * MIN });
    expect(row.flags[0].reason).toBe('2 SM-inbox item(s) unanswered; oldest open 6 h 40 min');
  });

  it('UNANSWERED on a tab still stopped on a BLOCKED or NEEDS-DECISION line for K min; not on DONE or CHECKPOINTED', () => {
    const ended = (line: string, min: number, inbox: IFleetTabFacts['inbox'] = []) => facts({ inbox }, {
      cliState: 'ready-for-review', lastEvent: stop(NOW - min * MIN), turnEnd: turnEnd('turn-marker', NOW - min * MIN, { marker: [line] }),
    });
    expect(flags(ended('NEEDS-DECISION: ix-api-q1', 29))).toEqual([]);
    expect(deriveFleetRow(ended('NEEDS-DECISION: ix-api-q1', 30), NOW).flags).toEqual([
      { flag: 'unanswered', reason: 'ended on NEEDS-DECISION 30 min ago with no reply' },
    ]);
    expect(flags(ended('**BLOCKED:** gate', 180))).toEqual(['unanswered']);
    expect(flags(ended('DONE: shipped', 180))).toEqual([]);
    expect(flags(ended('CHECKPOINTED: handoff.md', 180))).toEqual([]);
    // One flag per row: the line and the inbox reasons are joined.
    expect(deriveFleetRow(ended('BLOCKED: x', 60, [{ createdAt: NOW - 60 * MIN, reviewed: false }]), NOW).flags).toEqual([
      { flag: 'unanswered', reason: 'ended on BLOCKED 1 h ago with no reply; 1 SM-inbox item(s) unanswered; oldest open 1 h' },
    ]);
  });

  it('an unreadable SM inbox is null, never 0, and raises no flag', () => {
    const row = deriveFleetRow(facts({ inbox: null }), NOW);
    expect(row.inbox).toBeNull();
    expect(unansweredFlag(null, NOW)).toBeNull();
  });

  it('flags sort stall, unanswered, waiting-long', () => {
    const row = deriveFleetRow(facts({
      watches: [{ kind: 'pr', target: 'o/r#9' }], inbox: [{ createdAt: NOW - 60 * MIN, reviewed: false }],
    }, { lastEvent: stop(NOW - 200 * MIN), turnEnd: turnEnd('waiting', NOW - 200 * MIN) }), NOW);
    expect(row.flags.map((f) => f.flag)).toEqual(['unanswered', 'waiting-long']);
  });

  it('thresholds come from the caller', () => {
    const t = { ...DEFAULT_FLEET_THRESHOLDS, stallMinutes: 5 };
    expect(deriveFleetRow(facts({ transcriptAt: NOW - 5 * MIN }, { lastEvent: { name: 'prompt-submit', at: NOW - 6 * MIN, seq: 1 } }), NOW, t).flags.map((f) => f.flag)).toEqual(['stall']);
  });
});

describe('fleet status: helpers', () => {
  it('sorts flagged rows first by severity then longest in state; the rest by workspace and name', () => {
    const row = (tabName: string, flag: string | null, since: number, workspaceName = 'W') => ({
      tabName, workspaceName, tabId: tabName, since, flags: flag ? [{ flag, reason: '' }] : [],
    }) as never;
    const sorted = sortFleetRows([
      row('b', null, 0), row('a', null, 0), row('w1', 'waiting-long', NOW), row('s-new', 'stall', NOW), row('s-old', 'stall', NOW - 1), row('u', 'unanswered', NOW),
      row('z', null, 0, 'A'),
    ]);
    expect(sorted.map((r: { tabName: string }) => r.tabName)).toEqual(['s-old', 's-new', 'u', 'w1', 'z', 'a', 'b']);
  });

  it('formats durations with units, and refuses nonsense', () => {
    expect(formatDuration(45_000)).toBe('45 s');
    expect(formatDuration(37 * MIN)).toBe('37 min');
    expect(formatDuration(134 * MIN)).toBe('2 h 14 min');
    expect(formatDuration(120 * MIN)).toBe('2 h');
    expect(formatDuration(50 * 60 * MIN)).toBe('2 d 2 h');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });

  it('parses a threshold in (0, 10080] minutes, else the default', () => {
    expect(parseThresholdMinutes('45', 30)).toBe(45);
    expect(parseThresholdMinutes('0.5', 30)).toBe(0.5);
    for (const bad of [null, undefined, '', '  ', '0', '-3', 'abc', '10081', 'Infinity', '0x1e', '1e1', '+30']) expect(parseThresholdMinutes(bad, 30)).toBe(30);
  });

  it('an empty inbox has no oldest item', () => {
    expect(inboxOf([], NOW, DEFAULT_FLEET_THRESHOLDS)).toEqual({ open: 0, unanswered: 0, oldestAt: null });
  });
});
