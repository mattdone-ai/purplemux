import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  SUBMIT_CONFIRM_LOCAL_MS,
  SUBMIT_CONFIRM_MAX_MS,
  SUBMIT_CONFIRM_POLL_MS,
  SUBMIT_CONFIRM_REMOTE_MS,
  SUBMIT_RETRY_AFTER_MS,
  confirmSubmission,
  hasPromptSubmitHook,
  hasSubmitProof,
  submitConfirmDeadlineMs,
  type ISubmitConfirmDeps,
  type ISubmitConfirmRequest,
  type TSubmitResult,
} from '@/lib/send-confirmation';
import { isPaneShowingPendingLine } from '@/lib/tmux';
import type { ISubmitEvidence } from '@/types/status';
import type { TPanelType } from '@/types/terminal';

const RULE = '─'.repeat(60);
const BRIEF = 'Run the owner-question party on the three open items and report one ruling each.\nItem 1: ...';

/** A Claude-shaped pane: the composer between the last two rules, the mode line under it. */
const claudePane = (composer: string): string =>
  ['● Earlier output of the agent', '', RULE, `❯ ${composer}`, RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');

const EMPTY = claudePane('');
const STRANDED = claudePane(BRIEF.split('\n')[0]);
const PLACEHOLDER = claudePane('[Pasted text #1 +42 lines]');
const FIXTURE_EMPTY = fs.readFileSync(path.resolve('tests/fixtures/panes/claude-empty-composer.ansi'), 'utf-8');

const evidence = (over: Partial<ISubmitEvidence> = {}): ISubmitEvidence => ({
  cliState: 'idle',
  eventSeq: 7,
  lastPromptSubmitSeq: 3,
  lastEventFromTool: false,
  ...over,
});

interface IScript {
  /** The evidence each read returns, by poll index (the last one repeats). */
  evidence?: (ISubmitEvidence | null)[];
  /** The pane each capture returns, by poll index (the last one repeats); null is a failed capture. */
  panes?: (string | null)[];
  /** After the extra Enter, these replace the scripts above. */
  afterEnter?: { evidence?: (ISubmitEvidence | null)[]; panes?: (string | null)[] };
  request?: Partial<ISubmitConfirmRequest>;
}

const run = async (script: IScript): Promise<{ result: TSubmitResult; enters: number[]; elapsed: number; polls: number; captures: number }> => {
  let clock = 0;
  let polls = 0;
  let captures = 0;
  let allCaptures = 0;
  const enters: number[] = [];
  let evidenceScript = script.evidence ?? [evidence()];
  let paneScript = script.panes ?? [STRANDED];
  const at = <T,>(list: T[], index: number): T => list[Math.min(index, list.length - 1)];
  const result = await confirmSubmission(
    {
      readEvidence: () => at(evidenceScript, polls++),
      capture: async () => {
        allCaptures += 1;
        const pane = at(paneScript, captures++);
        if (pane === null) throw new Error('capture failed');
        return pane;
      },
      isPendingLine: isPaneShowingPendingLine,
      pressEnter: async () => {
        enters.push(clock);
        polls = 0;
        captures = 0;
        evidenceScript = script.afterEnter?.evidence ?? evidenceScript;
        paneScript = script.afterEnter?.panes ?? paneScript;
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    {
      panelType: 'claude-code',
      remote: false,
      content: BRIEF,
      baseline: evidence(),
      screenEmptyAtGate: true,
      ...script.request,
    },
  );
  return { result, enters, elapsed: clock, polls, captures: allCaptures };
};

describe('hasPromptSubmitHook', () => {
  it.each<[TPanelType | undefined, boolean, boolean]>([
    ['claude-code', false, true],
    ['claude-code', true, true],
    ['codex-cli', false, true],
    ['grok-cli', false, true],
    ['codex-cli', true, false],
    ['grok-cli', true, false],
    ['terminal', false, false],
    [undefined, false, false],
  ])('%s, remote %s: %s', (panelType, remote, expected) => {
    expect(hasPromptSubmitHook(panelType, remote)).toBe(expected);
  });
});

describe('hasSubmitProof', () => {
  const baseline = evidence();

  it('takes a turn-starting submit after the baseline, whatever came after it (a fast stop)', () => {
    expect(hasSubmitProof(baseline, evidence({ cliState: 'ready-for-review', eventSeq: 9, lastPromptSubmitSeq: 8 }))).toBe(true);
  });

  it('refuses a submit at or before the baseline', () => {
    expect(hasSubmitProof(baseline, evidence({ lastPromptSubmitSeq: 7 }))).toBe(false);
  });

  it('takes busy from a state that was not busy', () => {
    expect(hasSubmitProof(baseline, evidence({ cliState: 'busy' }))).toBe(true);
  });

  it('refuses busy that a Codex tool event set', () => {
    expect(hasSubmitProof(baseline, evidence({ cliState: 'busy', eventSeq: 8, lastEventFromTool: true }))).toBe(false);
  });

  it('refuses busy when the baseline was busy already (a tab waiting at its prompt)', () => {
    expect(hasSubmitProof(evidence({ cliState: 'busy' }), evidence({ cliState: 'busy' }))).toBe(false);
  });

  it('refuses a tab whose status entry is gone', () => {
    expect(hasSubmitProof(baseline, null)).toBe(false);
  });
});

describe('confirmSubmission (vel-RETRO-R3)', () => {
  it('confirms at once on a prompt-submit after the typing, with no extra Enter', async () => {
    const { result, enters, elapsed } = await run({ evidence: [evidence({ cliState: 'busy', eventSeq: 8, lastPromptSubmitSeq: 8 })], panes: [EMPTY] });

    expect(result).toEqual({ submitted: true, confirmation: 'prompt-submit', resubmitted: false });
    expect(enters).toEqual([]);
    expect(elapsed).toBe(0);
  });

  it('confirms a hook that lands after a few polls', async () => {
    const { result } = await run({
      evidence: [evidence(), evidence(), evidence({ eventSeq: 8, lastPromptSubmitSeq: 8, cliState: 'busy' })],
      panes: [EMPTY],
    });

    expect(result).toEqual({ submitted: true, confirmation: 'prompt-submit', resubmitted: false });
  });

  it('presses Enter exactly once for text stranded in the composer, and reports typed-not-submitted at the deadline', async () => {
    const { result, enters, elapsed } = await run({ panes: [STRANDED] });

    expect(result).toEqual({ submitted: false, notSubmitted: 'typed-not-submitted', resubmitted: true });
    expect(enters).toEqual([SUBMIT_RETRY_AFTER_MS]);
    expect(elapsed).toBe(SUBMIT_CONFIRM_LOCAL_MS);
  });

  it('confirms when the one extra Enter submits the stranded text', async () => {
    const { result, enters } = await run({
      panes: [STRANDED],
      afterEnter: { evidence: [evidence({ cliState: 'busy', eventSeq: 8, lastPromptSubmitSeq: 8 })], panes: [EMPTY] },
    });

    expect(result).toEqual({ submitted: true, confirmation: 'prompt-submit', resubmitted: true });
    expect(enters).toHaveLength(1);
  });

  it('presses Enter once for a folded [Pasted text] placeholder when the gate saw an empty composer', async () => {
    const { result, enters } = await run({ panes: [PLACEHOLDER] });

    expect(enters).toEqual([SUBMIT_RETRY_AFTER_MS]);
    expect(result).toEqual({ submitted: false, notSubmitted: 'typed-not-submitted', resubmitted: true });
  });

  it('does not press Enter for text the gate did not see empty (needs-input), and calls it unconfirmed', async () => {
    const { result, enters } = await run({ panes: [PLACEHOLDER], request: { screenEmptyAtGate: false } });

    expect(enters).toEqual([]);
    expect(result).toEqual({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
  });

  it('never takes an empty composer as proof on a tab with a prompt-submit hook', async () => {
    const { result, enters } = await run({ panes: [EMPTY] });

    expect(result).toEqual({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
    expect(enters).toEqual([]);
  });

  it('never takes a failed capture as proof', async () => {
    const { result, enters } = await run({ panes: [null] });

    expect(result).toEqual({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
    expect(enters).toEqual([]);
  });

  it('never takes a Codex tool event as proof', async () => {
    const { result } = await run({
      evidence: [evidence({ cliState: 'busy', eventSeq: 8, lastEventFromTool: true })],
      panes: [EMPTY],
      request: { panelType: 'codex-cli' },
    });

    expect(result).toMatchObject({ submitted: false, notSubmitted: 'submit-unconfirmed' });
  });

  it('takes an empty composer as proof on a tab with no prompt-submit hook (Grok on a remote host)', async () => {
    const { result } = await run({ panes: [FIXTURE_EMPTY], request: { panelType: 'grok-cli', remote: true } });

    expect(result).toEqual({ submitted: true, confirmation: 'composer-empty', resubmitted: false });
  });

  it('waits 10 s for a remote tab and 5 s for a local one', async () => {
    const local = await run({ panes: [EMPTY] });
    const remote = await run({ panes: [EMPTY], request: { remote: true } });

    expect(local.elapsed).toBe(SUBMIT_CONFIRM_LOCAL_MS);
    expect(remote.elapsed).toBe(SUBMIT_CONFIRM_REMOTE_MS);
  });

  it('polls every 250 ms, and reads the hook evidence before and after each capture', async () => {
    const { polls, captures } = await run({ panes: [EMPTY] });

    expect(captures).toBe(SUBMIT_CONFIRM_LOCAL_MS / SUBMIT_CONFIRM_POLL_MS + 1);
    expect(polls).toBe(2 * captures);
  });

  it('reads the dim prompt suggestion of a real pane as an empty composer, not as stranded text', async () => {
    const { result, enters } = await run({ panes: [FIXTURE_EMPTY] });

    expect(enters).toEqual([]);
    expect(result).toMatchObject({ notSubmitted: 'submit-unconfirmed' });
  });

  it('reports the result even when the extra Enter itself fails', async () => {
    const result = await confirmSubmission(
      {
        readEvidence: () => evidence(),
        capture: async () => STRANDED,
        isPendingLine: isPaneShowingPendingLine,
        pressEnter: async () => { throw new Error('tmux gone'); },
        now: (() => { let t = 0; return () => (t += SUBMIT_CONFIRM_POLL_MS); })(),
        sleep: async () => {},
      },
      { panelType: 'claude-code', remote: false, content: BRIEF, baseline: evidence(), screenEmptyAtGate: true },
    );

    expect(result).toEqual({ submitted: false, notSubmitted: 'typed-not-submitted', resubmitted: true });
  });
});

/**
 * A remote capture is one ssh call that takes `captureMs` of the clock. The hook lands `hookAt` ms after the typing,
 * whether or not a capture runs then.
 */
const runSlow = async (opts: { captureMs: number; hookAt: number; pane: string; remoteTimeoutMs?: number }) => {
  let clock = 0;
  const enters: number[] = [];
  const reads: number[] = [];
  const deps: ISubmitConfirmDeps = {
    readEvidence: () => {
      reads.push(clock);
      return clock >= opts.hookAt ? evidence({ cliState: 'busy', eventSeq: 8, lastPromptSubmitSeq: 8 }) : evidence();
    },
    capture: async () => {
      clock += opts.captureMs;
      return opts.pane;
    },
    isPendingLine: isPaneShowingPendingLine,
    pressEnter: async () => {
      enters.push(clock);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const result = await confirmSubmission(deps, {
    panelType: 'claude-code',
    remote: true,
    content: BRIEF,
    baseline: evidence(),
    screenEmptyAtGate: true,
    ...(opts.remoteTimeoutMs !== undefined ? { remoteTimeoutMs: opts.remoteTimeoutMs } : {}),
  });
  return { result, enters, elapsed: clock, reads };
};

describe('confirmSubmission with slow remote captures (review r1 F1)', () => {
  it('takes a hook that lands during the last capture, after the deadline, as proof', async () => {
    // Captures end at 4 s, 8.25 s and 12.5 s; the hook lands at 11 s, inside the third, past the 10 s window.
    const { result, elapsed } = await runSlow({ captureMs: 4_000, hookAt: 11_000, pane: EMPTY });

    expect(elapsed).toBeGreaterThan(SUBMIT_CONFIRM_REMOTE_MS);
    expect(result).toEqual({ submitted: true, confirmation: 'prompt-submit', resubmitted: false });
  });

  it('still answers submit-unconfirmed when no hook lands by the end of the last capture', async () => {
    const { result } = await runSlow({ captureMs: 4_000, hookAt: Number.POSITIVE_INFINITY, pane: EMPTY });

    expect(result).toEqual({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
  });

  it('presses no extra Enter on a stale screen when the hook landed during the capture that read it', async () => {
    // The capture that ends at 4 s shows the text still stranded; the turn started at 3 s.
    const { result, enters } = await runSlow({ captureMs: 4_000, hookAt: 3_000, pane: STRANDED });

    expect(result).toEqual({ submitted: true, confirmation: 'prompt-submit', resubmitted: false });
    expect(enters).toEqual([]);
  });

  it('reads the evidence after the deadline capture, so the last read is at the end of that capture', async () => {
    const { reads, elapsed } = await runSlow({ captureMs: 4_000, hookAt: Number.POSITIVE_INFINITY, pane: EMPTY });

    expect(reads.at(-1)).toBe(elapsed);
  });
});

describe('submitConfirmDeadlineMs (review r1 F2)', () => {
  it.each<[boolean, number | undefined, number]>([
    [false, undefined, SUBMIT_CONFIRM_LOCAL_MS],
    [false, 30_000, SUBMIT_CONFIRM_LOCAL_MS],
    [true, undefined, SUBMIT_CONFIRM_REMOTE_MS],
    [true, 1_000, SUBMIT_CONFIRM_REMOTE_MS],
    [true, 5_000, SUBMIT_CONFIRM_REMOTE_MS],
    [true, 15_000, 30_000],
    [true, 30_000, SUBMIT_CONFIRM_MAX_MS],
    [true, 120_000, SUBMIT_CONFIRM_MAX_MS],
  ])('remote %s, remote.timeout-ms %s: %s ms', (remote, budget, expected) => {
    expect(submitConfirmDeadlineMs(remote, budget)).toBe(expected);
  });

  it('waits the scaled window on a remote tab whose host has a longer ssh budget', async () => {
    const { result, elapsed } = await run({ panes: [EMPTY], request: { remote: true, remoteTimeoutMs: 15_000 } });

    expect(result).toMatchObject({ submitted: false, notSubmitted: 'submit-unconfirmed' });
    expect(elapsed).toBe(30_000);
  });
});

// PMUX-REMOTE-SEND (2026-11-13): 16 remote briefs sat typed in the composer for up to 6 h; one Enter each submitted them.
describe('confirmSubmission on a remote tab (PMUX-REMOTE-SEND)', () => {
  const REMOTE = { remote: true, screenEmptyAtGate: false } as const;
  const SUBMITTED = evidence({ cliState: 'busy', eventSeq: 8, lastPromptSubmitSeq: 8 });
  const OPTION_LIST = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n';

  it('presses one Enter for text on the composer line the gate did not see empty, and confirms on the hook', async () => {
    const { result, enters } = await run({
      panes: [PLACEHOLDER],
      request: REMOTE,
      afterEnter: { evidence: [SUBMITTED], panes: [EMPTY] },
    });

    expect(enters).toEqual([SUBMIT_RETRY_AFTER_MS]);
    expect(result).toEqual({ submitted: true, confirmation: 'prompt-submit', resubmitted: true });
  });

  it('takes the composer clearing after it showed the text as proof when no hook crosses', async () => {
    const { result } = await run({
      panes: [PLACEHOLDER],
      request: REMOTE,
      afterEnter: { panes: [EMPTY] },
    });

    expect(result).toEqual({ submitted: true, confirmation: 'composer-empty', resubmitted: true });
  });

  it('takes a composer that cleared on its own after the text as proof, with no extra Enter', async () => {
    const { result, enters } = await run({ panes: [STRANDED, EMPTY], request: REMOTE });

    expect(enters).toEqual([]);
    expect(result).toEqual({ submitted: true, confirmation: 'composer-empty', resubmitted: false });
  });

  it('a composer that never showed the text is no proof, and gets no Enter', async () => {
    const { result, enters, elapsed } = await run({ panes: [EMPTY], request: REMOTE });

    expect(enters).toEqual([]);
    expect(elapsed).toBe(SUBMIT_CONFIRM_REMOTE_MS);
    expect(result).toEqual({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
  });

  it('never presses Enter on an option list or a failed capture', async () => {
    for (const pane of [OPTION_LIST, null]) {
      const { result, enters } = await run({ panes: [pane], request: REMOTE });

      expect(enters).toEqual([]);
      expect(result).toEqual({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
    }
  });

  it('text that stays after the one Enter: typed-not-submitted, and the text is never typed again', async () => {
    const { result, enters } = await run({ panes: [PLACEHOLDER], request: REMOTE });

    expect(enters).toHaveLength(1);
    expect(result).toEqual({ submitted: false, notSubmitted: 'typed-not-submitted', resubmitted: true });
  });

  it('text first seen at the deadline: Enter there, then one more look before the answer', async () => {
    const reads = Math.ceil(SUBMIT_CONFIRM_REMOTE_MS / SUBMIT_CONFIRM_POLL_MS);
    const { result, enters, elapsed } = await run({
      panes: [...Array<string>(reads).fill(EMPTY), PLACEHOLDER],
      request: REMOTE,
      afterEnter: { evidence: [SUBMITTED] },
    });

    expect(enters).toEqual([SUBMIT_CONFIRM_REMOTE_MS]);
    expect(elapsed).toBe(SUBMIT_CONFIRM_REMOTE_MS + SUBMIT_RETRY_AFTER_MS);
    expect(result).toEqual({ submitted: true, confirmation: 'prompt-submit', resubmitted: true });
  });

  it('a local tab keeps its rule: an empty composer after the text is no proof on a hook tab', async () => {
    const { result } = await run({ panes: [STRANDED, EMPTY] });

    expect(result).toMatchObject({ submitted: false, notSubmitted: 'submit-unconfirmed' });
  });
});

// PMUX-REMOTE-SEND r2 (CONFIRM concern): a menu that is not a Yes/No dialog shows its focused option as `❯ 1. …`,
// which read as composer text, so the remote extra Enter chose it and the "seen text" proof could be faked by it.
describe('confirmSubmission never presses Enter into a selectable list (PMUX-REMOTE-SEND r2)', () => {
  const REMOTE = { remote: true, screenEmptyAtGate: false } as const;
  const ASK_USER_QUESTION = [
    '● I need one decision before I go on.',
    '',
    ' ☐ Changes',
    '',
    'How should I handle the uncommitted changes?',
    '',
    '❯ 1. Review them first',
    '     Read both diffs and explain what changed.',
    '  2. Commit now',
    '     Write an English commit message and commit.',
    '  3. Leave them',
    '  4. Type something.',
    RULE,
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n');
  const THEME_PICKER = fs.readFileSync(path.resolve('tests/fixtures/panes/claude-onboarding-theme.ansi'), 'utf-8');
  const UNNUMBERED_PICKER = [
    'Resume a conversation',
    '',
    '❯ Fix the remote send verification',
    '  Review the pool read',
    '  Draft the release notes',
  ].join('\n');
  /** The bottom of the screen did not arrive: the transcript's user message is the last `❯` line. */
  const CUT_CAPTURE = ['● Earlier output of the agent', '', `❯ ${BRIEF.split('\n')[0]}`, '', '● Working on it'].join('\n');

  for (const [label, pane] of [
    ['an AskUserQuestion menu', ASK_USER_QUESTION],
    ['a theme picker', THEME_PICKER],
    ['an unnumbered picker', UNNUMBERED_PICKER],
    ['a capture cut above the input box', CUT_CAPTURE],
  ] as const) {
    it(`${label} on a remote tab: no extra Enter, no proof, unconfirmed`, async () => {
      const { result, enters } = await run({ panes: [pane], request: REMOTE });

      expect(enters).toEqual([]);
      expect(result).toEqual({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
    });

    it(`${label} on a local tab whose gate saw an empty composer: no extra Enter`, async () => {
      const { enters } = await run({ panes: [pane] });

      expect(enters).toEqual([]);
    });
  }

  it('a menu followed by an empty composer is no proof: the menu was never the send\'s text', async () => {
    const { result } = await run({ panes: [ASK_USER_QUESTION, EMPTY], request: REMOTE });

    expect(result).toEqual({ submitted: false, notSubmitted: 'submit-unconfirmed', resubmitted: false });
  });

  it('a brief that starts with a numbered list reads as a list: refused, never a wrong Enter', async () => {
    const numbered = ['● Earlier output', '', RULE, '❯ 1. Read the logs', '  2. Fix the probe', RULE, '  ⏵⏵ bypass permissions on'].join('\n');
    const { enters } = await run({ panes: [numbered], request: REMOTE });

    expect(enters).toEqual([]);
  });
});

// PMUX-SEND-R3: a long brief scrolls the box, so the first line of the text is off screen, and a numbered brief can
// open the box on `❯ 1. …`, which the r2 guard read as a picker: no Enter, `submit-unconfirmed`, `resubmitted: false`.
describe('confirmSubmission reads the whole input box for the send\'s own text (PMUX-SEND-R3)', () => {
  const fixture = (name: string): string => fs.readFileSync(path.resolve('tests/fixtures/panes', name), 'utf-8');
  const typed = (name: string): string => fixture(name.replace(/\.ansi$/, '.typed.txt'));
  const REMOTE = { remote: true, screenEmptyAtGate: false } as const;
  const SUBMITTED = evidence({ cliState: 'busy', eventSeq: 8, lastPromptSubmitSeq: 8 });

  for (const name of ['claude-composer-numbered-80x24.ansi', 'claude-composer-numbered-240x16.ansi']) {
    it(`${name} on a remote tab: one Enter, confirmed on the hook (no Enter on #82)`, async () => {
      const { result, enters } = await run({
        panes: [fixture(name)],
        request: { ...REMOTE, content: typed(name) },
        afterEnter: { evidence: [SUBMITTED], panes: [EMPTY] },
      });

      expect(enters).toEqual([SUBMIT_RETRY_AFTER_MS]);
      expect(result).toEqual({ submitted: true, confirmation: 'prompt-submit', resubmitted: true });
    });

    it(`${name} on a local tab: one Enter (no Enter on #82)`, async () => {
      const { enters } = await run({ panes: [fixture(name)], request: { content: typed(name) } });

      expect(enters).toEqual([SUBMIT_RETRY_AFTER_MS]);
    });
  }

  it('a wrapped brief whose first line is off screen: one Enter on a remote tab, and when no hook crosses the clearing is proof', async () => {
    const name = 'claude-composer-wrapped-80x24.ansi';
    const { result, enters } = await run({
      panes: [fixture(name)],
      request: { ...REMOTE, content: typed(name) },
      afterEnter: { panes: [FIXTURE_EMPTY] },
    });

    expect(enters).toEqual([SUBMIT_RETRY_AFTER_MS]);
    expect(result).toEqual({ submitted: true, confirmation: 'composer-empty', resubmitted: true });
  });

  it('a wrapped brief on a local tab the gate did not see empty: the box holds the send\'s text, so one Enter', async () => {
    const name = 'claude-composer-wrapped-80x24.ansi';
    const { enters } = await run({ panes: [fixture(name)], request: { content: typed(name), screenEmptyAtGate: false } });

    expect(enters).toEqual([SUBMIT_RETRY_AFTER_MS]);
  });

  it('a numbered box that is not the send\'s text keeps the r2 refusal: no Enter', async () => {
    const { enters } = await run({ panes: [fixture('claude-composer-numbered-240x16.ansi')], request: REMOTE });

    expect(enters).toEqual([]);
  });

  it('the text is never typed again: one Enter at most, typed-not-submitted when the box keeps it', async () => {
    const name = 'claude-composer-numbered-240x16.ansi';
    const { result, enters } = await run({ panes: [fixture(name)], request: { ...REMOTE, content: typed(name) } });

    expect(enters).toHaveLength(1);
    expect(result).toEqual({ submitted: false, notSubmitted: 'typed-not-submitted', resubmitted: true });
  });

  it('tells the caller what each screen read saw', async () => {
    const name = 'claude-composer-numbered-240x16.ansi';
    const reads: string[] = [];
    let captures = 0;
    const panes = [null, fixture('claude-onboarding-theme.ansi'), FIXTURE_EMPTY, STRANDED, fixture(name)];
    await confirmSubmission(
      {
        readEvidence: () => evidence(),
        capture: async () => {
          const pane = panes[Math.min(captures++, panes.length - 1)];
          if (pane === null) throw new Error('capture failed');
          return pane;
        },
        isPendingLine: isPaneShowingPendingLine,
        pressEnter: async () => undefined,
        onScreenRead: (read) => reads.push(read),
        now: () => captures * SUBMIT_CONFIRM_POLL_MS,
        sleep: async () => undefined,
      },
      { panelType: 'claude-code', remote: true, content: typed(name), baseline: evidence(), screenEmptyAtGate: false },
    );

    expect(reads.slice(0, 5)).toEqual(['failed', 'refused', 'empty', 'text', 'own-text']);
  });
});
