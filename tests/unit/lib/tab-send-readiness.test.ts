import { describe, expect, it } from 'vitest';
import type { TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import {
  awaitSendReadiness,
  DEFAULT_SEND_READY_TIMEOUT_MS,
  MAX_SEND_READY_TIMEOUT_MS,
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
}

/**
 * One `IStep` per readiness poll, so a test reads as the sequence of tab states
 * the loop observes. `null` stands for a tab that vanished from the layout.
 */
const runReadiness = async (
  steps: (IStep | null)[],
  timeoutMs: number,
  gate: TSendGate = 'composer-ready',
): Promise<{ result: TSendReadiness; sleeps: number[]; polls: number }> => {
  const sleeps: number[] = [];
  let clock = 0;
  let polls = 0;
  let current: IStep | null = null;

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
      now: () => clock,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
    { workspaceId: 'ws', tabId: 'tab-1', timeoutMs, gate },
  );

  return { result, sleeps, polls };
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
