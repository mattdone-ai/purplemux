import { describe, expect, it } from 'vitest';
import type { TComposerScreen } from '@/lib/composer-readiness';
import type { TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import {
  awaitSendReadiness,
  DEFAULT_SEND_READY_TIMEOUT_MS,
  MAX_SEND_READY_TIMEOUT_MS,
  REMOTE_CALL_DEFAULT_MS,
  SEND_READY_POLL_INTERVAL_MS,
  isComposerReadyCliState,
  resolveSendWaitMs,
  type ITabSendTarget,
  type TSendGate,
  type TSendReadiness,
} from '@/lib/tab-send';

const SESSION = 'pmux-ws-pane-1-tab-1';

interface IStep {
  cliState: TCliState | null;
  panelType?: TPanelType;
  alive?: boolean;
  waitingAtPrompt?: boolean;
  startupPrompt?: ITabSendTarget['startupPrompt'];
  /** What the screen half of the gate reads at this poll; absent means the caller passes no screen reader. */
  screen?: TComposerScreen | 'throws';
}

/**
 * One `IStep` per readiness poll, so a test reads as the sequence of tab states
 * the loop observes. `null` stands for a tab that vanished from the layout.
 */
const runReadiness = async (
  steps: (IStep | null)[],
  timeoutMs: number,
  gate: TSendGate = 'composer-ready',
): Promise<{ result: TSendReadiness; sleeps: number[]; polls: number; screenReads: string[] }> => {
  const sleeps: number[] = [];
  let clock = 0;
  let polls = 0;
  let current: IStep | null = null;
  const screened = steps.some((step) => step?.screen !== undefined);
  const screenReads: string[] = [];

  const result = await awaitSendReadiness(
    {
      findTarget: async (): Promise<ITabSendTarget | null> => {
        current = steps[Math.min(polls, steps.length - 1)];
        polls += 1;
        if (!current) return null;
        return {
          sessionName: SESSION, cliState: current.cliState, panelType: current.panelType, waitingAtPrompt: current.waitingAtPrompt,
          ...(current.startupPrompt !== undefined ? { startupPrompt: current.startupPrompt } : {}),
        };
      },
      hasSession: async () => current !== null && current.alive !== false,
      ...(screened ? {
        readScreen: async (target: ITabSendTarget): Promise<TComposerScreen> => {
          screenReads.push(String(target.cliState));
          const screen = current?.screen ?? { ok: true };
          if (screen === 'throws') throw new Error('capture failed');
          return screen;
        },
      } : {}),
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
    { workspaceId: 'ws', tabId: 'tab-1', timeoutMs, gate },
  );

  return { result, sleeps, polls, screenReads };
};

const agent = (cliState: TCliState | null, alive = true): IStep => ({
  cliState,
  panelType: 'claude-code',
  alive,
});

describe('awaitSendReadiness on the composer-ready gate', () => {
  it('is ready immediately when the agent already holds a composer', async () => {
    const { result, sleeps, polls } = await runReadiness([agent('idle')], 5_000);

    expect(result).toEqual({
      ok: true,
      target: { sessionName: SESSION, cliState: 'idle', panelType: 'claude-code' },
      screenEmpty: false,
    });
    expect(sleeps).toEqual([]);
    expect(polls).toBe(1);
  });

  it.each<TCliState>(['idle', 'ready-for-review', 'needs-input'])('accepts %s without waiting', async (state) => {
    const { result } = await runReadiness([agent(state)], 5_000);

    expect(result.ok).toBe(true);
  });

  it('waits for a booting agent and reports ready once it settles', async () => {
    const { result, sleeps, polls } = await runReadiness(
      [agent('busy'), agent('busy'), agent('idle')],
      5_000,
    );

    expect(result).toMatchObject({ ok: true, target: { cliState: 'idle' } });
    expect(sleeps).toEqual([SEND_READY_POLL_INTERVAL_MS, SEND_READY_POLL_INTERVAL_MS]);
    expect(polls).toBe(3);
  });

  it('gives up at the deadline and reports the state it last saw', async () => {
    const { result, sleeps } = await runReadiness([agent('busy')], 1_200);

    expect(result).toEqual({ ok: false, reason: 'readiness-timeout', cliState: 'busy', waitedMs: 1_200 });
    expect(sleeps).toEqual([500, 500, 200]);
  });

  it('never overshoots the deadline on the final sleep', async () => {
    const { result, sleeps } = await runReadiness([agent('unknown')], 700);

    expect(sleeps).toEqual([500, 200]);
    expect(result).toMatchObject({ reason: 'readiness-timeout', waitedMs: 700 });
  });

  it('answers without sleeping at all when the caller asked not to wait', async () => {
    const { result, sleeps, polls } = await runReadiness([agent('busy')], 0);

    expect(result).toEqual({ ok: false, reason: 'readiness-timeout', cliState: 'busy', waitedMs: 0 });
    expect(sleeps).toEqual([]);
    expect(polls).toBe(1);
  });

  it('reports a dead tmux session instead of waiting out the deadline', async () => {
    const { result, sleeps } = await runReadiness([agent('busy', false)], 60_000);

    expect(result).toEqual({ ok: false, reason: 'session-not-running', cliState: 'busy' });
    expect(sleeps).toEqual([]);
  });

  it('reports a session that dies while the wait is in flight', async () => {
    const { result } = await runReadiness([agent('busy'), agent('busy', false)], 5_000);

    expect(result).toMatchObject({ reason: 'session-not-running' });
  });

  it('reports a tab that is closed while the wait is in flight', async () => {
    const { result } = await runReadiness([agent('busy'), null], 5_000);

    expect(result).toEqual({ ok: false, reason: 'tab-not-found' });
  });

  it.each<TPanelType>(['terminal', 'web-browser', 'diff', 'agent-sessions'])(
    'skips the composer gate for a %s panel',
    async (panelType) => {
      const { result, sleeps } = await runReadiness([{ cliState: null, panelType }], 5_000);

      expect(result).toMatchObject({ ok: true, target: { panelType } });
      expect(sleeps).toEqual([]);
    },
  );

  it('still refuses a non-agent panel whose tmux session is gone', async () => {
    const { result } = await runReadiness([{ cliState: null, panelType: 'terminal', alive: false }], 5_000);

    expect(result).toEqual({ ok: false, reason: 'session-not-running', cliState: null });
  });

  it('gates every agent panel type, including the newest provider', async () => {
    for (const panelType of ['claude-code', 'codex-cli', 'grok-cli'] as const) {
      const { result } = await runReadiness([{ cliState: 'busy', panelType }], 0);

      expect(result).toMatchObject({ reason: 'readiness-timeout' });
    }
  });
});

describe('awaitSendReadiness on the live-session gate', () => {
  it.each<TCliState>(['idle', 'busy', 'inactive', 'startup-prompt', 'unknown', 'cancelled', 'ready-for-review', 'needs-input'])(
    'delivers to an agent in %s without waiting',
    async (state) => {
      const { result, sleeps, polls } = await runReadiness([agent(state)], 60_000, 'live-session');

      expect(result).toMatchObject({ ok: true, target: { cliState: state } });
      expect(sleeps).toEqual([]);
      expect(polls).toBe(1);
    },
  );

  it('delivers to a tab whose state is not known at all', async () => {
    const { result } = await runReadiness([agent(null)], 0, 'live-session');

    expect(result).toMatchObject({ ok: true });
  });

  it('still refuses a tab whose tmux session is not running', async () => {
    const { result, sleeps } = await runReadiness([agent('busy', false)], 60_000, 'live-session');

    expect(result).toEqual({ ok: false, reason: 'session-not-running', cliState: 'busy' });
    expect(sleeps).toEqual([]);
  });

  it('still refuses a tab that is not in the layout', async () => {
    const { result } = await runReadiness([null], 0, 'live-session');

    expect(result).toEqual({ ok: false, reason: 'tab-not-found' });
  });

  it('never reports a readiness timeout, whatever the deadline', async () => {
    const { result } = await runReadiness([agent('busy')], 0, 'live-session');

    expect(result).toMatchObject({ ok: true });
  });

  it.each<TPanelType>(['claude-code', 'codex-cli', 'grok-cli', 'terminal'])(
    'treats a %s panel the same way',
    async (panelType) => {
      const { result } = await runReadiness([{ cliState: 'busy', panelType }], 0, 'live-session');

      expect(result).toMatchObject({ ok: true, target: { panelType } });
    },
  );
});

describe('isComposerReadyCliState', () => {
  it.each<TCliState>(['idle', 'ready-for-review', 'needs-input'])('reports %s ready', (state) => {
    expect(isComposerReadyCliState(state)).toBe(true);
  });

  it.each<TCliState>(['busy', 'inactive', 'unknown', 'cancelled'])('reports %s not ready', (state) => {
    expect(isComposerReadyCliState(state)).toBe(false);
  });

  it('reports an absent state not ready', () => {
    expect(isComposerReadyCliState(null)).toBe(false);
    expect(isComposerReadyCliState(undefined)).toBe(false);
  });
});

describe('resolveSendWaitMs', () => {
  it('defaults when the caller says nothing', () => {
    expect(resolveSendWaitMs(undefined)).toBe(DEFAULT_SEND_READY_TIMEOUT_MS);
  });

  it('accepts zero as "answer now"', () => {
    expect(resolveSendWaitMs(0)).toBe(0);
  });

  it('accepts a bounded positive wait', () => {
    expect(resolveSendWaitMs(1_500)).toBe(1_500);
    expect(resolveSendWaitMs(MAX_SEND_READY_TIMEOUT_MS)).toBe(MAX_SEND_READY_TIMEOUT_MS);
  });

  it.each([-1, MAX_SEND_READY_TIMEOUT_MS + 1, 1.5, Number.NaN, '30000', null, {}])(
    'rejects %s',
    (value) => {
      expect(resolveSendWaitMs(value)).toBeNull();
    },
  );
});

describe('composer-ready gate and a WAITING worker (ADR-0018, ruling A′)', () => {
  it('accepts a busy agent flagged waitingAtPrompt on the first look', async () => {
    const { result, polls } = await runReadiness([{ cliState: 'busy', panelType: 'claude-code', waitingAtPrompt: true }], 1000);
    expect(result).toMatchObject({ ok: true });
    expect(polls).toBe(1);
  });

  it('keeps waiting on a busy agent without the flag, and times out', async () => {
    const { result } = await runReadiness([{ cliState: 'busy', panelType: 'claude-code', waitingAtPrompt: false }], 1000);
    expect(result).toMatchObject({ ok: false, reason: 'readiness-timeout' });
  });

  it('never lets the flag excuse a dead session', async () => {
    const { result } = await runReadiness([{ cliState: 'busy', panelType: 'claude-code', waitingAtPrompt: true, alive: false }], 1000);
    expect(result).toMatchObject({ ok: false, reason: 'session-not-running' });
  });
});

// D14 (story 05): a tab at a Claude Code startup dialog never reaches a composer on its own, and a paste
// would answer the dialog. The unattended gate refuses at once, with nothing typed and the dialog named.
describe('composer-ready gate and a startup prompt (story 05, D14)', () => {
  it.each(['folder-trust', 'external-imports'] as const)('refuses %s on the first look, with no wait', async (kind) => {
    const { result, sleeps, polls } = await runReadiness([{ ...agent('startup-prompt'), startupPrompt: kind }], DEFAULT_SEND_READY_TIMEOUT_MS);

    expect(result).toEqual({ ok: false, reason: 'startup-prompt', cliState: 'startup-prompt', startupPrompt: kind });
    expect(sleeps).toEqual([]);
    expect(polls).toBe(1);
  });

  it('refuses the moment a booting tab reaches the dialog, not at the deadline', async () => {
    const { result, sleeps } = await runReadiness(
      [agent('inactive'), agent('inactive'), { ...agent('startup-prompt'), startupPrompt: 'folder-trust' }],
      DEFAULT_SEND_READY_TIMEOUT_MS,
    );

    expect(result).toMatchObject({ ok: false, reason: 'startup-prompt', startupPrompt: 'folder-trust' });
    expect(sleeps).toEqual([SEND_READY_POLL_INTERVAL_MS, SEND_READY_POLL_INTERVAL_MS]);
  });

  it('names no dialog when the status carries none', async () => {
    const { result } = await runReadiness([agent('startup-prompt')], 0);
    expect(result).toEqual({ ok: false, reason: 'startup-prompt', cliState: 'startup-prompt', startupPrompt: null });
  });

  it('still reports a dead session first', async () => {
    const { result } = await runReadiness([{ ...agent('startup-prompt', false), startupPrompt: 'folder-trust' }], 5_000);
    expect(result).toMatchObject({ ok: false, reason: 'session-not-running' });
  });

  it('is not a composer-ready state', () => {
    expect(isComposerReadyCliState('startup-prompt')).toBe(false);
  });
});

describe('awaitSendReadiness reads the screen on the composer-ready gate (vel-RETRO-R3)', () => {
  const drawn: TComposerScreen = { ok: true };
  const notDrawn: TComposerScreen = { ok: false, reason: 'composer-unreadable' };
  const typed: TComposerScreen = { ok: false, reason: 'composer-not-empty' };

  it('is ready at once when the idle agent shows an empty composer, and says the screen was read', async () => {
    const { result, sleeps } = await runReadiness([{ ...agent('idle'), screen: drawn }], 5_000);

    expect(result).toMatchObject({ ok: true, screenEmpty: true });
    expect(sleeps).toEqual([]);
  });

  it('waits out an idle agent whose composer is not drawn yet (SessionStart before the TUI takes keys)', async () => {
    const { result, sleeps, polls } = await runReadiness(
      [{ ...agent('idle'), screen: notDrawn }, { ...agent('idle'), screen: notDrawn }, { ...agent('idle'), screen: drawn }],
      5_000,
    );

    expect(result).toMatchObject({ ok: true, screenEmpty: true });
    expect(sleeps).toEqual([SEND_READY_POLL_INTERVAL_MS, SEND_READY_POLL_INTERVAL_MS]);
    expect(polls).toBe(3);
  });

  it('times out on a composer that holds text, names the screen reading, and types nothing', async () => {
    const { result } = await runReadiness([{ ...agent('idle'), screen: typed }], 1_000);

    expect(result).toEqual({ ok: false, reason: 'readiness-timeout', cliState: 'idle', waitedMs: 1_000, screen: 'composer-not-empty' });
  });

  it('reads a capture that throws as not ready, never as an empty composer', async () => {
    const { result } = await runReadiness([{ ...agent('idle'), screen: 'throws' }], 500);

    expect(result).toMatchObject({ ok: false, reason: 'readiness-timeout', screen: 'composer-unreadable' });
  });

  it('answers at once with waitMs 0: one look, no sleep', async () => {
    const { result, sleeps } = await runReadiness([{ ...agent('idle'), screen: typed }], 0);

    expect(result).toMatchObject({ ok: false, reason: 'readiness-timeout', waitedMs: 0, screen: 'composer-not-empty' });
    expect(sleeps).toEqual([]);
  });

  it('screens ready-for-review and a busy tab waiting at its prompt, the states Mission Control screens', async () => {
    const review = await runReadiness([{ ...agent('ready-for-review'), screen: typed }], 0);
    const waiting = await runReadiness([{ ...agent('busy'), waitingAtPrompt: true, screen: typed }], 0);

    expect(review.result).toMatchObject({ ok: false, screen: 'composer-not-empty' });
    expect(waiting.result).toMatchObject({ ok: false, screen: 'composer-not-empty' });
  });

  it('leaves needs-input status-only: its option list is what the send answers (ADR-0007)', async () => {
    const { result, screenReads } = await runReadiness([{ ...agent('needs-input'), screen: typed }], 0);

    expect(result).toMatchObject({ ok: true, screenEmpty: false });
    expect(screenReads).toEqual([]);
  });

  it('never reads the screen of a terminal tab or on the live-session gate', async () => {
    const terminal = await runReadiness([{ cliState: null, panelType: 'terminal', screen: typed }], 0);
    const live = await runReadiness([{ ...agent('idle'), screen: typed }], 0, 'live-session');

    expect(terminal.result).toMatchObject({ ok: true, screenEmpty: false });
    expect(live.result).toMatchObject({ ok: true, screenEmpty: false });
    expect([...terminal.screenReads, ...live.screenReads]).toEqual([]);
  });

  it('drops a screen reading once the state leaves the screened set, so a timeout names the latest cause', async () => {
    const { result } = await runReadiness([{ ...agent('idle'), screen: typed }, { ...agent('busy'), screen: typed }], 500);

    expect(result).toEqual({ ok: false, reason: 'readiness-timeout', cliState: 'busy', waitedMs: 500 });
  });
});

/**
 * The gate over a remote tab whose captures each take `captureMs` of the clock. `reads` is the answer of each
 * capture in turn (the last one repeats); null is a capture that failed (an ssh timeout).
 */
const runRemote = async (opts: {
  captureMs: number[];
  reads: (TComposerScreen | null)[];
  timeoutMs: number;
  host?: string;
  remoteTimeoutMs?: number | 'throws';
}) => {
  let clock = 0;
  let captures = 0;
  const at = <T,>(list: T[], index: number): T => list[Math.min(index, list.length - 1)];
  const result = await awaitSendReadiness(
    {
      findTarget: async () => ({ sessionName: SESSION, cliState: 'idle', panelType: 'claude-code', ...(opts.host === undefined ? { host: 'host-a' } : opts.host ? { host: opts.host } : {}) }),
      hasSession: async () => true,
      readScreen: async () => {
        const index = captures++;
        clock += at(opts.captureMs, index);
        const read = at(opts.reads, index);
        return read ?? { ok: false, reason: 'composer-unreadable' };
      },
      ...(opts.remoteTimeoutMs === undefined ? {} : {
        remoteTimeoutMs: async () => {
          if (opts.remoteTimeoutMs === 'throws') throw new Error('fleet config unreadable');
          return opts.remoteTimeoutMs as number;
        },
      }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    },
    { workspaceId: 'ws', tabId: 'tab-1', timeoutMs: opts.timeoutMs, gate: 'composer-ready' },
  );
  return { result, captures, elapsed: clock };
};

describe('the composer-ready gate over a slow remote capture (review r1 F2)', () => {
  const drawn: TComposerScreen = { ok: true };

  it('reads again after a capture that ran over 5 s and failed, and passes on the fast one after it', async () => {
    const { result, captures } = await runRemote({ captureMs: [6_000, 200], reads: [null, drawn], timeoutMs: 10_000 });

    expect(result).toMatchObject({ ok: true, screenEmpty: true });
    expect(captures).toBe(2);
  });

  it('takes a capture that answers after the deadline: a slow reading still counts', async () => {
    const { result } = await runRemote({ captureMs: [12_000], reads: [drawn], timeoutMs: 10_000 });

    expect(result).toMatchObject({ ok: true, screenEmpty: true });
  });

  it('leaves room for a second capture after one that spent the whole budget, at the default budget', async () => {
    // waitMs 3 s is shorter than two 5 s budgets: the gate waits 10 s, so the 5 s failure is not the answer.
    const { result, elapsed } = await runRemote({ captureMs: [REMOTE_CALL_DEFAULT_MS, 100], reads: [null, drawn], timeoutMs: 3_000 });

    expect(result).toMatchObject({ ok: true, screenEmpty: true });
    expect(elapsed).toBeLessThan(2 * REMOTE_CALL_DEFAULT_MS);
  });

  it('scales the deadline with the host\'s remote.timeout-ms: two 30 s budgets', async () => {
    const { result, elapsed, captures } = await runRemote({ captureMs: [30_000], reads: [null], timeoutMs: 10_000, remoteTimeoutMs: 30_000 });

    expect(result).toMatchObject({ ok: false, reason: 'readiness-timeout', screen: 'composer-unreadable' });
    expect(captures).toBe(2);
    expect(elapsed).toBe(60_000 + SEND_READY_POLL_INTERVAL_MS);
  });

  it('passes on a 25 s capture that a 30 s budget lets finish, with a 10 s wait', async () => {
    const { result } = await runRemote({ captureMs: [25_000], reads: [drawn], timeoutMs: 10_000, remoteTimeoutMs: 30_000 });

    expect(result).toMatchObject({ ok: true, screenEmpty: true });
  });

  it('keeps a longer caller wait, and keeps waitMs 0 as one look', async () => {
    const longer = await runRemote({ captureMs: [1_000], reads: [null], timeoutMs: 20_000 });
    const once = await runRemote({ captureMs: [1_000], reads: [null], timeoutMs: 0 });

    expect(longer.elapsed).toBeGreaterThanOrEqual(20_000);
    expect(longer.elapsed).toBeLessThan(20_000 + 1_000 + SEND_READY_POLL_INTERVAL_MS);
    expect(once.result).toMatchObject({ ok: false, reason: 'readiness-timeout' });
    expect(once.captures).toBe(1);
  });

  it('uses the default budget when the fleet config cannot be read, never a shorter wait', async () => {
    const { elapsed } = await runRemote({ captureMs: [1_000], reads: [null], timeoutMs: 1_000, remoteTimeoutMs: 'throws' });

    expect(elapsed).toBeGreaterThanOrEqual(2 * REMOTE_CALL_DEFAULT_MS);
  });

  it('does not stretch the wait of a local tab', async () => {
    const { elapsed } = await runRemote({ captureMs: [100], reads: [null], timeoutMs: 1_000, host: '', remoteTimeoutMs: 30_000 });

    expect(elapsed).toBeLessThan(1_000 + 100 + SEND_READY_POLL_INTERVAL_MS);
  });
});
