import { describe, expect, it } from 'vitest';
import { HOOK_TMUX_TIMEOUT_SECONDS, STOP_HOOK_MAX_TIME_SECONDS } from '@/lib/hook-scripts';
import { claudeHookEvents } from '@/lib/hook-settings';

// F6 review nit 2: Stop and StopFailure both post through the stop route and wait for its answer, so Claude must not
// kill either hook before tmux (1 s) and the POST (--max-time 3) can end; the margin is the script's own start-up.

describe('the Claude stop hooks outlast their own bounds', () => {
  const events = claudeHookEvents('/x/status-hook.sh');
  const timeoutOf = (name: keyof typeof events) => events[name][0].hooks[0].timeout;

  it.each(['Stop', 'StopFailure'] as const)('%s waits longer than tmux plus the stop POST', (name) => {
    expect(timeoutOf(name)).toBeGreaterThan(HOOK_TMUX_TIMEOUT_SECONDS + STOP_HOOK_MAX_TIME_SECONDS);
    expect(events[name][0].hooks[0].command).toBe('sh "/x/status-hook.sh" stop');
  });

  it('the other events keep the short bound', () => {
    expect(timeoutOf('UserPromptSubmit')).toBeLessThan(timeoutOf('Stop'));
  });
});
