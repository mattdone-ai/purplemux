import { describe, expect, it } from 'vitest';
import {
  AGENT_STALL_WINDOW_MS,
  IDLE_NUDGE_DEFAULT_MS,
  SHELL_STALL_BACKSTOP_MS,
  TURN_TAIL_CHARS,
  classifyTurnEnd,
  extractTurnMarker,
  holdsOffStall,
  isBackgroundWaitStalled,
  lastTurnLine,
  parseIdleNudgeMinutes,
  readTurnEnd,
} from '@/lib/turn-end';

const input = (tail: string | null | undefined, open = 0, jobs = 0, transcript = true, watches = 0) => ({
  tail,
  transcript,
  openBackgroundTasks: open,
  liveRegisteredJobs: jobs,
  armedWatches: watches,
});

describe('extractTurnMarker', () => {
  it.each(['DONE: shipped', 'BLOCKED: gate red — needs X', 'NEEDS-DECISION: a or b — options a/b', 'READY-TO-MERGE: repo#1 @ abc', 'CHECKPOINTED: /home/u/_output/x/HANDOFF.md'])(
    'returns the last line when it starts with a marker: %s',
    (line) => {
      expect(extractTurnMarker(`Report.\n\n${line}\n`)).toEqual([line]);
    },
  );

  // Story 09 AC 2 re-read: an EARLIER paragraph is never read. In ONE paragraph a marker first line now joins (R-09).
  it('ignores a marker that is not in the last paragraph', () => {
    expect(extractTurnMarker('DONE: earlier\n\nstill working on the rest')).toBeNull();
    expect(extractTurnMarker('DONE: earlier\n\nstill working\non the rest')).toBeNull();
    expect(extractTurnMarker('Intro.\n\nDONE: earlier\n\n> still working')).toBeNull();
  });

  it('ignores a marker word mid-line and lower-case forms', () => {
    expect(extractTurnMarker('the story is DONE: see above')).toBeNull();
    expect(extractTurnMarker('done: shipped')).toBeNull();
  });

  it('strips markdown emphasis and a quote marker around the line', () => {
    expect(extractTurnMarker('**DONE: shipped**')).toEqual(['DONE: shipped']);
    expect(extractTurnMarker('> `BLOCKED: x — needs y`')).toEqual(['BLOCKED: x — needs y']);
  });

  it('carries READY-TO-MERGE lines directly above DONE, at most five', () => {
    const ready = Array.from({ length: 7 }, (_, i) => `READY-TO-MERGE: repo#${i} @ sha${i}`);
    expect(extractTurnMarker(['intro', ...ready, 'DONE: all ready'].join('\n'))).toEqual([...ready.slice(2), 'DONE: all ready']);
    expect(extractTurnMarker(['READY-TO-MERGE: a#1', 'text between', 'DONE: x'].join('\n'))).toEqual(['DONE: x']);
  });

  it('caps a run that ends on READY-TO-MERGE at five lines in total', () => {
    const ready = Array.from({ length: 7 }, (_, i) => `READY-TO-MERGE: repo#${i}`);
    expect(extractTurnMarker(ready.join('\n'))).toEqual(ready.slice(2));
  });

  it('clips a marker line to 300 characters', () => {
    const [line] = extractTurnMarker(`DONE: ${'x'.repeat(400)}`)!;
    expect(line).toHaveLength(301);
    expect(line.endsWith('…')).toBe(true);
  });

  describe('a wrapped end line (story 09, R-09)', () => {
    // hfl-36's own end, 2026-11-04: the watchdog read no end line and sent idle-no-end-line.
    const HFL36_FIRST = 'DONE: story 36 carries done (asker notice, one id per line key, the push body at 400 code points);';
    const HFL36_SECOND = 'gate 36-r4 VALID TREE_START=4b1c0e9 TREE_END=4b1c0e9; not committed.';

    it('joins the first line of the last paragraph with its continuation lines, by one space (hfl-36 fixture)', () => {
      expect(extractTurnMarker(`Gate log read.\n\n${HFL36_FIRST}\n${HFL36_SECOND}\n`)).toEqual([`${HFL36_FIRST} ${HFL36_SECOND}`]);
      expect(classifyTurnEnd(input(`${HFL36_FIRST}\n${HFL36_SECOND}`))).toEqual({ kind: 'turn-marker', lines: [`${HFL36_FIRST} ${HFL36_SECOND}`] });
    });

    it('joins three lines, strips emphasis on each, and clips the joined line at 300 chars', () => {
      expect(extractTurnMarker('Report.\n\n**BLOCKED: gate red**\n  on lint\n_needs a rerun_')).toEqual(['BLOCKED: gate red on lint needs a rerun']);
      const [line] = extractTurnMarker(`Report.\n\nDONE: ${'x'.repeat(200)}\n${'y'.repeat(200)}`)!;
      expect(line).toHaveLength(301);
      expect(line.startsWith(`DONE: ${'x'.repeat(200)} y`)).toBe(true);
    });

    it('returns no marker when the first line of the last paragraph has none', () => {
      expect(extractTurnMarker('Report.\n\nThe gate is green and\nDONE is near.')).toBeNull();
      expect(extractTurnMarker('Report.\n\nnot yet: DONE: x\nmore text')).toBeNull();
    });

    it('keeps a marker on the last non-empty line exactly as before, with its READY-TO-MERGE ride-along', () => {
      expect(extractTurnMarker('Summary of the work\nDONE: x')).toEqual(['DONE: x']);
      expect(extractTurnMarker(['READY-TO-MERGE: a#1', 'READY-TO-MERGE: b#2', 'DONE: both'].join('\n'))).toEqual(['READY-TO-MERGE: a#1', 'READY-TO-MERGE: b#2', 'DONE: both']);
    });

    it('lets READY-TO-MERGE lines that open the paragraph ride along above a wrapped DONE', () => {
      expect(extractTurnMarker(['Report.', '', 'READY-TO-MERGE: a#1', 'READY-TO-MERGE: b#2', 'DONE: both PRs', 'are green.'].join('\n')))
        .toEqual(['READY-TO-MERGE: a#1', 'READY-TO-MERGE: b#2', 'DONE: both PRs are green.']);
      expect(extractTurnMarker(['READY-TO-MERGE: a#1', '', 'DONE: wrapped', 'line'].join('\n'))).toEqual(['READY-TO-MERGE: a#1', 'DONE: wrapped line']);
    });

    it('reads no marker from a paragraph that starts at the first character of a cut tail: its start may be missing', () => {
      // The message said "the story is not DONE: x …"; the 600-char cut happens to start at the marker word.
      const cut = `DONE: x ${'z'.repeat(TURN_TAIL_CHARS - 16)}\nwrapped`;
      expect(cut.length).toBe(TURN_TAIL_CHARS);
      expect(extractTurnMarker(cut)).toBeNull();
      expect(readTurnEnd('DONE: x\nwrapped')).toEqual({ kind: 'marker', lines: ['DONE: x wrapped'], complete: true });
      expect(readTurnEnd(`Report.\n\n${cut}`.slice(-TURN_TAIL_CHARS - 9))).toMatchObject({ kind: 'marker', complete: true });
    });

    it('gives lastTurnLine the joined line, unclipped', () => {
      const long = `NEEDS-DECISION: ${'which rule do we ship '.repeat(14)}`;
      expect(lastTurnLine(`Ok.\n\n${long}\n? (a) base (b) transaction`)).toEqual({ line: `${long.trim()} ? (a) base (b) transaction`, complete: true });
      expect(lastTurnLine('Ok.\n\nno marker here')).toEqual({ line: 'no marker here', complete: true });
    });
  });

  describe('one end line carries one marker, at its start (D28)', () => {
    // v2-scope, ws-ldhziO, 2026-11-05: this line opened owner item nd-cf48b3c9f54f03b198611166b93df723.
    const D28 = 'NEEDS-DECISION: is not mine to send — ORCH holds it. CHECKPOINTED: /home/user/.local/share/v2-scope/HANDOFF-SO9-1103.md …';

    it('reads the D28 line as no marker, and says why', () => {
      expect(extractTurnMarker(`Scope pass done.\n\n${D28}`)).toBeNull();
      expect(readTurnEnd(`Scope pass done.\n\n${D28}`)).toEqual({ kind: 'refused', reason: 'two-markers', line: D28 });
      expect(classifyTurnEnd(input(D28))).toEqual({ kind: 'ready-for-review', transcript: true });
    });

    it('refuses two markers on one end line when one of them is NEEDS-DECISION, also across a wrapped line', () => {
      expect(readTurnEnd('BLOCKED: x; NEEDS-DECISION: y?')).toMatchObject({ kind: 'refused', reason: 'two-markers' });
      expect(readTurnEnd('NEEDS-DECISION: ship it?\n(DONE: the rest)')).toMatchObject({ kind: 'refused', line: 'NEEDS-DECISION: ship it? (DONE: the rest)' });
    });

    // Review r1, finding 2: any other pair keeps the FIRST marker at the line start.
    it.each([
      ['DONE: story 9 done; NEEDS-DECISION: none open', null],
      ['DONE: 09 landed READY-TO-MERGE: PR #12', 'DONE: 09 landed READY-TO-MERGE: PR #12'],
      ['DONE: 09 gate VALID; the wrapped part\nnames BLOCKED: none', 'DONE: 09 gate VALID; the wrapped part names BLOCKED: none'],
      ['DONE: x; BLOCKED: none', 'DONE: x; BLOCKED: none'],
      ['DONE: a\nBLOCKED: b\nmore', 'DONE: a BLOCKED: b more'],
    ])('the review example %j reads as %j', (tail, line) => {
      expect(extractTurnMarker(`Report.\n\n${tail}`)).toEqual(line === null ? null : [line]);
    });

    it('does not count a marker word that is part of a longer token, nor a lower-case one', () => {
      expect(extractTurnMarker('DONE: renamed XDONE: and PRE-DONE: keys; done: lower')).toEqual(['DONE: renamed XDONE: and PRE-DONE: keys; done: lower']);
    });

    it('never counts a marker quoted mid-sentence', () => {
      expect(extractTurnMarker('The worker wrote NEEDS-DECISION: ship it?')).toBeNull();
      expect(readTurnEnd('I will not send the NEEDS-DECISION: ORCH holds it.')).toBeNull();
    });

    it('stops the READY-TO-MERGE ride-along at a line that holds a NEEDS-DECISION pair, and keeps any other pair', () => {
      expect(extractTurnMarker(['READY-TO-MERGE: a#1', 'READY-TO-MERGE: b#2 NEEDS-DECISION: merge?', 'DONE: x'].join('\n'))).toEqual(['DONE: x']);
      expect(extractTurnMarker(['READY-TO-MERGE: a#1', 'READY-TO-MERGE: b#2 DONE: soon', 'DONE: x'].join('\n')))
        .toEqual(['READY-TO-MERGE: a#1', 'READY-TO-MERGE: b#2 DONE: soon', 'DONE: x']);
    });

    // Review r1, finding 3.
    it('reads a marker after a list prefix at the line start', () => {
      expect(extractTurnMarker('Report.\n\n- DONE: shipped')).toEqual(['DONE: shipped']);
      expect(extractTurnMarker('Report.\n\n* BLOCKED: gate red')).toEqual(['BLOCKED: gate red']);
      expect(extractTurnMarker('Report.\n\n1. NEEDS-DECISION: ship it?')).toEqual(['NEEDS-DECISION: ship it?']);
      expect(extractTurnMarker('Report.\n\n2) CHECKPOINTED: /h.md')).toEqual(['CHECKPOINTED: /h.md']);
      expect(extractTurnMarker('> - **DONE: quoted list**')).toEqual(['DONE: quoted list']);
      expect(extractTurnMarker('- READY-TO-MERGE: a#1\n- DONE: wrapped\n  line')).toEqual(['READY-TO-MERGE: a#1', 'DONE: wrapped line']);
      // A minus or a number that is part of the text is not a list prefix.
      expect(extractTurnMarker('-DONE: x')).toBeNull();
      expect(extractTurnMarker('1.DONE: x')).toBeNull();
    });
  });

  it('returns null for an empty or missing tail', () => {
    expect(extractTurnMarker(null)).toBeNull();
    expect(extractTurnMarker(undefined)).toBeNull();
    expect(extractTurnMarker('\n  \n')).toBeNull();
  });
});

describe('classifyTurnEnd', () => {
  it('lets a marker win over open background work', () => {
    expect(classifyTurnEnd(input('DONE: x', 2, 1))).toEqual({ kind: 'turn-marker', lines: ['DONE: x'] });
  });

  it('is waiting with no marker and an open provider task', () => {
    expect(classifyTurnEnd(input('Waiting on the gate.', 1))).toEqual({ kind: 'waiting', openBackgroundTasks: 1, liveRegisteredJobs: 0, armedWatches: 0 });
  });

  it('is waiting with no marker and a live registered tab bg job', () => {
    expect(classifyTurnEnd(input('Waiting.', 0, 1))).toEqual({ kind: 'waiting', openBackgroundTasks: 0, liveRegisteredJobs: 1, armedWatches: 0 });
  });

  it('is waiting with no marker and an armed purplemux watch (L49)', () => {
    expect(classifyTurnEnd(input('Watching the PR.', 0, 0, true, 1))).toEqual({ kind: 'waiting', openBackgroundTasks: 0, liveRegisteredJobs: 0, armedWatches: 1 });
  });

  it('lets a marker win over an armed watch', () => {
    expect(classifyTurnEnd(input('DONE: merged', 0, 0, true, 2))).toEqual({ kind: 'turn-marker', lines: ['DONE: merged'] });
  });

  it('is ready-for-review with no marker and nothing open', () => {
    expect(classifyTurnEnd(input('All good.'))).toEqual({ kind: 'ready-for-review', transcript: true });
  });

  it('marks the no-transcript fallback', () => {
    expect(classifyTurnEnd(input(undefined, 0, 0, false))).toEqual({ kind: 'ready-for-review', transcript: false });
  });
});

describe('isBackgroundWaitStalled (architect ruling C)', () => {
  const now = 10_000_000_000;
  const kinds = (shell: number, agent: number, monitor: number) => ({ shell, agent, monitor });

  it('leaves a tab with nothing open to the default rule', () => {
    expect(isBackgroundWaitStalled(undefined, null, now)).toBeNull();
    expect(isBackgroundWaitStalled(kinds(0, 0, 0), now - 1, now)).toBeNull();
  });

  it('stalls an open agent after 15 min without any activity, not before', () => {
    expect(isBackgroundWaitStalled(kinds(0, 1, 0), now - AGENT_STALL_WINDOW_MS + 1, now)).toBe(false);
    expect(isBackgroundWaitStalled(kinds(0, 1, 0), now - AGENT_STALL_WINDOW_MS, now)).toBe(true);
  });

  it('judges a tab with an agent and a shell by the agent window', () => {
    expect(isBackgroundWaitStalled(kinds(1, 1, 0), now - AGENT_STALL_WINDOW_MS, now)).toBe(true);
  });

  it('never stalls a silent shell inside the 90 min backstop, and stalls it after', () => {
    expect(isBackgroundWaitStalled(kinds(1, 0, 0), now - 40 * 60 * 1000, now)).toBe(false);
    expect(isBackgroundWaitStalled(kinds(1, 0, 1), now - SHELL_STALL_BACKSTOP_MS, now)).toBe(true);
  });

  it('never stalls on Monitors alone', () => {
    expect(isBackgroundWaitStalled(kinds(0, 0, 2), now - 10 * SHELL_STALL_BACKSTOP_MS, now)).toBe(false);
  });

  it('treats unknown activity as silence', () => {
    expect(isBackgroundWaitStalled(kinds(0, 1, 0), null, now)).toBe(true);
  });
});

describe('idle nudge window (L49)', () => {
  it('defaults to 15 min', () => {
    expect(IDLE_NUDGE_DEFAULT_MS).toBe(15 * 60 * 1000);
  });

  it.each([
    ['15', 15 * 60 * 1000],
    ['5', 5 * 60 * 1000],
    [' 30 ', 30 * 60 * 1000],
    ['0.05', 3000],
    ['1440', 1440 * 60 * 1000],
  ])('reads %j minutes', (raw, ms) => {
    expect(parseIdleNudgeMinutes(raw)).toBe(ms);
  });

  it.each([null, undefined, '', '0', '0.0', '-5', '1441', 'abc', '15m', '1e3', 'Infinity', 'NaN'])('refuses %j (the caller keeps the default)', (raw) => {
    expect(parseIdleNudgeMinutes(raw)).toBeNull();
  });
});

describe('holdsOffStall (L49)', () => {
  it('holds while a registered job lives or a watch is armed, and not otherwise', () => {
    expect(holdsOffStall(1, 0)).toBe(true);
    expect(holdsOffStall(0, 1)).toBe(true);
    expect(holdsOffStall(0, 0)).toBe(false);
  });
});

describe('derived watchdog timers (review r1 findings 2 and 4)', () => {
  const stop = { name: 'stop', seq: 4 };
  const ready = { kind: 'ready-for-review', at: 1_000, seq: 4 };

  it('idle nudge: due once the window passed on the stop that is still the latest event, and not after it was sent', async () => {
    const { idleNudgeDue } = await import('@/lib/turn-end');
    expect(idleNudgeDue(ready, stop, 'ready-for-review', 900, 1_899)).toBe(false);
    expect(idleNudgeDue(ready, stop, 'ready-for-review', 900, 1_900)).toBe(true);
    expect(idleNudgeDue({ ...ready, idleNudgeSentSeq: 4 }, stop, 'ready-for-review', 900, 5_000)).toBe(false);
    expect(idleNudgeDue({ ...ready, idleNudgeSentSeq: 3 }, stop, 'ready-for-review', 900, 5_000)).toBe(true);
    expect(idleNudgeDue(ready, { name: 'prompt-submit', seq: 5 }, 'busy', 900, 5_000)).toBe(false);
    expect(idleNudgeDue(ready, { name: 'stop', seq: 5 }, 'ready-for-review', 900, 5_000)).toBe(false);
    expect(idleNudgeDue(ready, stop, 'idle', 900, 5_000)).toBe(false);
    expect(idleNudgeDue({ ...ready, kind: 'turn-marker' }, stop, 'ready-for-review', 900, 5_000)).toBe(false);
    expect(idleNudgeDue(null, stop, 'ready-for-review', 900, 5_000)).toBe(false);
  });

  it('long wait: due on a WAITING stop past the backstop, once per stop', async () => {
    const { longWaitDue } = await import('@/lib/turn-end');
    const waiting = { kind: 'waiting', at: 1_000, seq: 4 };
    expect(longWaitDue(waiting, stop, 'busy', 900, 1_899)).toBe(false);
    expect(longWaitDue(waiting, stop, 'busy', 900, 1_900)).toBe(true);
    expect(longWaitDue({ ...waiting, longWaitSentSeq: 4 }, stop, 'busy', 900, 9_000)).toBe(false);
    expect(longWaitDue(waiting, { name: 'prompt-submit', seq: 5 }, 'busy', 900, 9_000)).toBe(false);
  });

  it.each([['4', 4 * 3_600_000], ['0.5', 1_800_000], ['168', 168 * 3_600_000]])('reads %j backstop hours', async (raw, ms) => {
    const { parseWaitBackstopHours } = await import('@/lib/turn-end');
    expect(parseWaitBackstopHours(raw)).toBe(ms);
  });

  it.each([null, '', '0', '169', 'x', '-1'])('refuses %j backstop hours', async (raw) => {
    const { parseWaitBackstopHours, WAIT_BACKSTOP_DEFAULT_MS } = await import('@/lib/turn-end');
    expect(parseWaitBackstopHours(raw)).toBeNull();
    expect(WAIT_BACKSTOP_DEFAULT_MS).toBe(4 * 3_600_000);
  });
});
