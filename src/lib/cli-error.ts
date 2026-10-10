/**
 * Machine codes carried beside `error` on CLI route error bodies (ADR-0016):
 * `tab-not-found`, `session-not-running`, `readiness-timeout`,
 * `target-changed` and `forbidden` so far; later routes add their own.
 *
 * `bin/cli.js` maps each code to an exit code through one table, so a caller
 * can tell a failure it must never retry (the tab is gone) from one it may
 * retry (the agent is still booting). The `error` strings and the HTTP statuses
 * stay as they were: the web UI and the phone read them (ADR-0004, additive
 * wire changes only).
 */
export const TAB_NOT_FOUND_BODY = Object.freeze({ error: 'Tab not found', code: 'tab-not-found' as const });

/** A remote tab's host did not answer over ssh (ADR-0022): retryable, never "the tab is gone". */
export const remoteHostUnreachableBody = (err: { message: string; host: string }) => ({
  error: err.message,
  code: 'remote-host-unreachable' as const,
  host: err.host,
});

export const targetChangedBody = (tabId: string) => ({
  error: 'agent-target-changed' as const,
  code: 'target-changed' as const,
  tabId,
});
