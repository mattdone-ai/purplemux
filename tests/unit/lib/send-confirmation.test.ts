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
