import { withAgentDispatchLock, type IAgentDispatchPolicyOptions } from '@/lib/agent-dispatch-policy';
import { findTab } from '@/lib/cli-utils';
import { hasSession, isLinePendingInComposer, pressEnter } from '@/lib/tmux';
import { deliverPrompt } from '@/lib/agent-prompt-delivery';
import { createLogger } from '@/lib/logger';
import type { ITab } from '@/types/terminal';

const log = createLogger('automated-prompt');

interface IPolicyResult {
  ok: boolean;
  error?: string;
}

export interface IAutomatedPromptRequest {
  workspaceId: string;
  targetTabId: string;
  message: string;
  /**
   * Checked inside the dispatch lock just before the paste: false types nothing (`not-ready`). A digest
   * passes the tab's at-prompt check, so a turn started since the caller looked is never typed into.
   */
  whenReady?: () => boolean;
}

export type TAutomatedPromptResult =
  /** `resubmitted`: the text was still in the composer after the Enter, so Enter was pressed once more (L37). */
  | { delivered: true; resubmitted?: true; stillPending?: true }
  | { delivered: false; reason: 'target-not-found' | 'session-not-found' | 'not-ready' | 'model-policy' | 'policy-error' | 'delivery-error'; error?: unknown; policy?: IPolicyResult };

export interface IAutomatedPromptDispatcherDeps {
  findTarget: (workspaceId: string, tabId: string) => Promise<ITab | null>;
  withPolicyLock: (
    workspaceId: string,
    target: ITab,
    deliver: (checkPolicy: (options?: IAgentDispatchPolicyOptions) => Promise<IPolicyResult>) => Promise<TAutomatedPromptResult>,
  ) => Promise<TAutomatedPromptResult>;
  hasSession: (sessionName: string) => Promise<boolean>;
  paste: (sessionName: string, message: string) => Promise<void>;
  /**
   * The post-submit pane check the send API uses ("a booting or mid-turn agent
   * swallows the Enter"). Absent: no check, today's behaviour.
   */
  isPending?: (sessionName: string, message: string) => Promise<boolean>;
  /** One Enter, for a message the check found still in the composer. */
  pressEnter?: (sessionName: string) => Promise<void>;
  /** The settle wait before the check, so the TUI has drawn the submit (review r1 finding 5). */
  settle?: (ms: number) => Promise<void>;
}

/** How long the TUI gets to clear its composer after the Enter before the check reads it. */
export const SUBMIT_SETTLE_MS = 300;

const defaultDeps: IAutomatedPromptDispatcherDeps = {
  findTarget: async (workspaceId, tabId) => (await findTab(workspaceId, tabId))?.tab ?? null,
  withPolicyLock: withAgentDispatchLock,
  hasSession,
  paste: deliverPrompt,
  // Resolved at call time: a module that mocks tmux without these keeps working.
  isPending: (sessionName, message) => isLinePendingInComposer(sessionName, message),
  pressEnter: (sessionName) => pressEnter(sessionName),
  settle: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
};

export class AutomatedPromptDispatcher {
  private tails = new Map<string, Promise<void>>();

  constructor(private deps: IAutomatedPromptDispatcherDeps = defaultDeps) {}

  async dispatch(request: IAutomatedPromptRequest): Promise<TAutomatedPromptResult> {
    const key = `${request.workspaceId}/${request.targetTabId}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    const delivery = previous.then(() => this.deliver(request));
    const tail = delivery.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    try {
      return await delivery;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  private async deliver(request: IAutomatedPromptRequest): Promise<TAutomatedPromptResult> {
    let target: ITab | null;
    try {
      target = await this.deps.findTarget(request.workspaceId, request.targetTabId);
    } catch (error) {
      return { delivered: false, reason: 'delivery-error', error };
    }
    if (!target) return { delivered: false, reason: 'target-not-found' };

    try {
      return await this.deps.withPolicyLock(request.workspaceId, target, async (checkPolicy) => {
        let current: ITab | null;
        try {
          current = await this.deps.findTarget(request.workspaceId, request.targetTabId);
        } catch (error) {
          return { delivered: false, reason: 'delivery-error', error };
        }
        if (!current) return { delivered: false, reason: 'target-not-found' };
        return this.submit(current, request, checkPolicy);
      });
    } catch (error) {
      return { delivered: false, reason: 'policy-error', error };
    }
  }

  private async submit(
    target: ITab,
    { message, whenReady }: IAutomatedPromptRequest,
    checkPolicy: (options?: IAgentDispatchPolicyOptions) => Promise<IPolicyResult>,
  ): Promise<TAutomatedPromptResult> {
    try {
      if (!await this.deps.hasSession(target.sessionName)) {
        return { delivered: false, reason: 'session-not-found' };
      }
    } catch (error) {
      return { delivered: false, reason: 'delivery-error', error };
    }

    let policy: IPolicyResult;
    try {
      policy = await checkPolicy({ consumeBootstrapForTarget: true });
    } catch (error) {
      return { delivered: false, reason: 'policy-error', error };
    }
    if (!policy.ok) return { delivered: false, reason: 'model-policy', policy };
    if (whenReady && !whenReady()) return { delivered: false, reason: 'not-ready' };

    try {
      await this.deps.paste(target.sessionName, message);
    } catch (error) {
      return { delivered: false, reason: 'delivery-error', error };
    }
    return this.confirmSubmitted(target, message);
  }

  /**
   * L37 (27 Sep ~00:40Z): a watchdog nudge sat typed but unsubmitted in a
   * worker's composer, because the Enter landed while the tab was finishing a
   * turn. The text was pasted either way, so every outcome here is `delivered`;
   * a stranded one gets ONE more Enter, and both are logged. The check waits
   * 300 ms for the TUI to draw, and matches the nudge's whole first line.
   */
  private async confirmSubmitted(target: ITab, message: string): Promise<TAutomatedPromptResult> {
    const { isPending, pressEnter: enter, settle } = this.deps;
    if (!isPending || !enter) return { delivered: true };
    await settle?.(SUBMIT_SETTLE_MS);
    // A failed pane check is not evidence of a stranded paste (the send API reads it the same way).
    const pending = async (): Promise<boolean> => {
      try {
        return await isPending(target.sessionName, message);
      } catch {
        return false;
      }
    };
    if (!(await pending())) return { delivered: true };
    try {
      await enter(target.sessionName);
    } catch (err) {
      log.warn({ tabId: target.id, err: String(err) }, 'automated prompt stranded in the composer; the second Enter failed');
      return { delivered: true, stillPending: true };
    }
    await settle?.(SUBMIT_SETTLE_MS);
    const still = await pending();
    log.warn({ tabId: target.id, stillPending: still }, 'automated prompt was still in the composer after Enter; pressed Enter once more');
    return still ? { delivered: true, resubmitted: true, stillPending: true } : { delivered: true, resubmitted: true };
  }
}
