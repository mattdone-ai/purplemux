import { describe, expect, it, vi } from 'vitest';
import { AutomatedPromptDispatcher, type IAutomatedPromptDispatcherDeps } from '@/lib/automated-prompt-dispatcher';
import type { ITab } from '@/types/terminal';

const target: ITab = {
  id: 'root',
  name: 'root',
  order: 0,
  sessionName: 'tmux-root',
  panelType: 'codex-cli',
  agentLaunchConfig: { model: 'gpt-6-astra', effort: 'medium' },
};

const policyLock = (
  checkPolicy: (...args: unknown[]) => Promise<{ ok: boolean; error?: string }>,
): IAutomatedPromptDispatcherDeps['withPolicyLock'] =>
  async (workspaceId, target, deliver) => deliver((options) => checkPolicy(workspaceId, target, options));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const request = (message: string) => ({
  workspaceId: 'ws-1',
  targetTabId: target.id,
  message,
});

describe('automated prompt delivery', () => {
  it('serializes prompts per target and rechecks policy when each reaches delivery', async () => {
    const firstPaste = deferred<void>();
    const paste = vi.fn(async (_session: string, message: string) => {
      if (message === 'first') await firstPaste.promise;
    });
    const checkPolicy = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'agent-model-mismatch' });
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async () => target),
      withPolicyLock: policyLock(checkPolicy),
      hasSession: vi.fn(async () => true),
      paste,
    });

    const first = dispatcher.dispatch(request('first'));
    const second = dispatcher.dispatch(request('second'));
    await vi.waitFor(() => expect(paste).toHaveBeenCalledTimes(1));
    expect(checkPolicy).toHaveBeenCalledTimes(1);
    firstPaste.resolve();

    await expect(first).resolves.toEqual({ delivered: true });
    await expect(second).resolves.toMatchObject({ delivered: false, reason: 'model-policy' });
    expect(paste).toHaveBeenCalledTimes(1);
    expect(checkPolicy).toHaveBeenLastCalledWith(
      'ws-1',
      target,
      { consumeBootstrapForTarget: true },
    );
  });

  it('allows different targets to deliver concurrently', async () => {
    const release = deferred<void>();
    const bothPasting = deferred<void>();
    let active = 0;
    const paste = vi.fn(async () => {
      active += 1;
      if (active === 2) bothPasting.resolve();
      await release.promise;
      active -= 1;
    });
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async (_workspaceId: string, tabId: string) => ({ ...target, id: tabId, sessionName: tabId })),
      withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
      hasSession: vi.fn(async () => true),
      paste,
    });

    const first = dispatcher.dispatch({ ...request('first'), targetTabId: 'root-a' });
    const second = dispatcher.dispatch({ ...request('second'), targetTabId: 'root-b' });
    await bothPasting.promise;
    expect(paste).toHaveBeenCalledTimes(2);
    release.resolve();
    await Promise.all([first, second]);
  });

  it('fails closed when policy inspection errors', async () => {
    const paste = vi.fn(async () => {});
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async () => target),
      withPolicyLock: policyLock(vi.fn(async () => { throw new Error('metadata unreadable'); })),
      hasSession: vi.fn(async () => true),
      paste,
    });

    await expect(dispatcher.dispatch(request('held'))).resolves.toMatchObject({
      delivered: false,
      reason: 'policy-error',
    });
    expect(paste).not.toHaveBeenCalled();
  });

  // L37 (27 Sep ~00:40Z): a nudge sat typed but unsubmitted in a worker's composer.
  it('types nothing when the readiness check fails inside the lock, and checks it after the policy (ADR-0035)', async () => {
    const paste = vi.fn(async () => {});
    const order: string[] = [];
    const dispatcher = new AutomatedPromptDispatcher({
      findTarget: vi.fn(async () => target),
      withPolicyLock: policyLock(async () => { order.push('policy'); return { ok: true }; }),
      hasSession: vi.fn(async () => true),
      paste,
    });
    const busy = await dispatcher.dispatch({ ...request('DIGEST 1 since x'), whenReady: () => { order.push('ready'); return false; } });
    expect(busy).toEqual({ delivered: false, reason: 'not-ready' });
    expect(paste).not.toHaveBeenCalled();
    expect(order).toEqual(['policy', 'ready']);
    expect(await dispatcher.dispatch({ ...request('DIGEST 1 since x'), whenReady: () => true })).toEqual({ delivered: true });
    expect(paste).toHaveBeenCalledTimes(1);
  });

  describe('the Enter a busy or booting agent swallowed (L37)', () => {
    const verified = (pending: boolean[]) => {
      const order: string[] = [];
      const isPending = vi.fn(async (_session: string, _message: string) => {
        order.push('check');
        return pending.shift() ?? false;
      });
      const pressEnter = vi.fn(async (_session: string) => { order.push('enter'); });
      const paste = vi.fn(async () => { order.push('paste'); });
      const settle = vi.fn(async (ms: number) => { order.push(`wait:${ms}`); });
      const dispatcher = new AutomatedPromptDispatcher({
        findTarget: vi.fn(async () => target),
        withPolicyLock: policyLock(vi.fn(async () => ({ ok: true as const }))),
        hasSession: vi.fn(async () => true),
        paste,
        isPending,
        pressEnter,
        settle,
      });
      return { dispatcher, isPending, pressEnter, order };
    };

    it('checks the composer after the Enter and presses nothing more when it is empty', async () => {
      const { dispatcher, isPending, pressEnter, order } = verified([false]);
      await expect(dispatcher.dispatch(request('nudge text'))).resolves.toEqual({ delivered: true });
      expect(isPending).toHaveBeenCalledWith('tmux-root', 'nudge text');
      expect(pressEnter).not.toHaveBeenCalled();
      expect(order).toEqual(['paste', 'wait:300', 'check']);
    });

    it('presses Enter once more when the text is still in the composer, and checks again', async () => {
      const { dispatcher, pressEnter, order } = verified([true, false]);
      await expect(dispatcher.dispatch(request('nudge text'))).resolves.toEqual({ delivered: true, resubmitted: true });
      expect(pressEnter).toHaveBeenCalledTimes(1);
      expect(pressEnter).toHaveBeenCalledWith('tmux-root');
      expect(order).toEqual(['paste', 'wait:300', 'check', 'enter', 'wait:300', 'check']);
    });

    it('presses Enter only once, and reports the text still pending, when the retry did not take', async () => {
      const { dispatcher, pressEnter } = verified([true, true]);
      await expect(dispatcher.dispatch(request('nudge text'))).resolves.toEqual({ delivered: true, resubmitted: true, stillPending: true });
      expect(pressEnter).toHaveBeenCalledTimes(1);
    });

    it('reads a failed pane check as submitted (a capture failure is not a stranded paste)', async () => {
      const { dispatcher, isPending, pressEnter } = verified([]);
      isPending.mockRejectedValueOnce(new Error('capture failed'));
      await expect(dispatcher.dispatch(request('nudge text'))).resolves.toEqual({ delivered: true });
      expect(pressEnter).not.toHaveBeenCalled();
    });

    it('keeps the delivery when the second Enter itself fails', async () => {
      const { dispatcher, pressEnter } = verified([true]);
      pressEnter.mockRejectedValueOnce(new Error('tmux gone'));
      await expect(dispatcher.dispatch(request('nudge text'))).resolves.toEqual({ delivered: true, stillPending: true });
    });

    it('wires the send API\'s composer check and a single Enter into the production dispatcher', async () => {
      const isLinePendingInComposer = vi.fn(async () => true);
      const pressEnter = vi.fn(async () => {});
      vi.resetModules();
      vi.doMock('@/lib/tmux', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/tmux')>()), isLinePendingInComposer, pressEnter }));
      try {
        const { AutomatedPromptDispatcher: Fresh } = await import('@/lib/automated-prompt-dispatcher');
        const deps = (new Fresh() as unknown as { deps: IAutomatedPromptDispatcherDeps }).deps;
        expect(await deps.isPending!('tmux-root', 'nudge text')).toBe(true);
        await deps.pressEnter!('tmux-root');
        expect(isLinePendingInComposer).toHaveBeenCalledWith('tmux-root', 'nudge text');
        expect(typeof deps.settle).toBe('function');
        expect(pressEnter).toHaveBeenCalledWith('tmux-root');
      } finally {
        vi.doUnmock('@/lib/tmux');
        vi.resetModules();
      }
    });

    it('treats a pane check that throws synchronously (a tmux mock without the export) as submitted', async () => {
      const { dispatcher, isPending, pressEnter } = verified([]);
      isPending.mockImplementationOnce(() => { throw new Error('No "isContentPendingInComposer" export'); });
      await expect(dispatcher.dispatch(request('nudge text'))).resolves.toEqual({ delivered: true });
      expect(pressEnter).not.toHaveBeenCalled();
    });
  });

  describe('the whole-line composer match (review r1 finding 5)', () => {
    const rule = '─'.repeat(60);
    const box = (...lines: string[]) => ['● earlier transcript line', rule, ...lines, rule, '  ? for shortcuts'].join('\n');
    const mine = '[orchestrator-watchdog] worker tab-w1 (w1) BACKGROUND JOB COMPLETED: "gate-ui" pid 4711 exited with code 0. Read it with: purplemux tab result -w ws-1 tab-w1';
    const other = '[orchestrator-watchdog] worker tab-w1 (w1) BACKGROUND JOB FAILED: "gate-api" pid 4712 exited with code 2. Read it with: purplemux tab result -w ws-1 tab-w1';

    it('matches the nudge itself, also when the TUI wrapped it across lines', async () => {
      const { isPaneShowingPendingLine } = await import('@/lib/tmux');
      expect(isPaneShowingPendingLine(box(`❯ ${mine}`), mine)).toBe(true);
      expect(isPaneShowingPendingLine(box(`❯ ${mine.slice(0, 70)}`, `  ${mine.slice(70)}`), mine)).toBe(true);
    });

    it('does not match a DIFFERENT stranded nudge from the same worker (same 40-character prefix)', async () => {
      const { isPaneShowingPendingLine, isPaneShowingPendingContent } = await import('@/lib/tmux');
      expect(mine.slice(0, 40)).toBe(other.slice(0, 40));
      // The send API's 40-character needle cannot tell them apart; the whole line can.
      expect(isPaneShowingPendingContent(box(`❯ ${other}`), mine)).toBe(true);
      expect(isPaneShowingPendingLine(box(`❯ ${other}`), mine)).toBe(false);
    });

    it('does not match an empty composer or the nudge echoed above the box', async () => {
      const { isPaneShowingPendingLine } = await import('@/lib/tmux');
      expect(isPaneShowingPendingLine(box('❯ '), mine)).toBe(false);
      expect(isPaneShowingPendingLine([`❯ ${mine}`, rule, '❯ ', rule].join('\n'), mine)).toBe(false);
    });
  });
});
