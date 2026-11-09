/**
 * The readiness probe's pane captures for remote tabs (vel-PMX-FU, the D61 CONFIRM follow-up): the poll never
 * awaits one. A probe that needs a remote pane's screen asks for it and reads nothing this poll; after the tab loop
 * each host's asked-for panes are captured in ONE background ssh, and the next poll takes the answer. A capture is
 * taken once and only while it is fresh (`maxAgeMs`), so no probe reads an old screen. A failed run backs that
 * host off `backoffMs`, as the pane scan does.
 */

export interface IRemotePaneCaptureDeps {
  capture: (host: string, sessions: readonly string[]) => Promise<Map<string, string | null>>;
  now: () => number;
  maxAgeMs: () => number;
  onFailure?: (host: string, reason: string) => void;
}

export const REMOTE_CAPTURE_BACKOFF_MS = 30_000;

export class RemotePaneCaptures {
  private readonly wanted = new Map<string, Set<string>>();
  private readonly results = new Map<string, { content: string | null; at: number }>();
  private readonly inFlight = new Set<string>();
  private readonly backoff = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly deps: IRemotePaneCaptureDeps, private readonly backoffMs = REMOTE_CAPTURE_BACKOFF_MS) {}

  /**
   * The pane's captured text, taken once: a string, null when tmux could not capture it, or undefined when no
   * fresh capture is waiting (the caller then asks for one and reads nothing).
   */
  take(sessionName: string): string | null | undefined {
    const result = this.results.get(sessionName);
    if (!result) return undefined;
    this.results.delete(sessionName);
    return this.deps.now() - result.at <= this.deps.maxAgeMs() ? result.content : undefined;
  }

  request(host: string, sessionName: string): void {
    const sessions = this.wanted.get(host) ?? new Set<string>();
    sessions.add(sessionName);
    this.wanted.set(host, sessions);
  }

  /** One background capture per host that asked, outside its backoff and with none running. Never awaited by the poll. */
  flush(): Promise<void> {
    const now = this.deps.now();
    for (const [host, sessions] of this.wanted) {
      if (this.inFlight.has(host) || (this.backoff.get(host) ?? 0) > now) continue;
      this.wanted.delete(host);
      const list = [...sessions];
      this.inFlight.add(host);
      const done: Promise<void> = this.deps.capture(host, list)
        .then((captured) => {
          const at = this.deps.now();
          for (const session of list) {
            if (captured.has(session)) this.results.set(session, { content: captured.get(session) ?? null, at });
          }
        }, (err: unknown) => {
          this.backoff.set(host, this.deps.now() + this.backoffMs);
          this.deps.onFailure?.(host, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          this.inFlight.delete(host);
          this.running.delete(done);
        });
      this.running.add(done);
    }
    return this.settled();
  }

  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  forget(sessionName: string): void {
    this.results.delete(sessionName);
    for (const sessions of this.wanted.values()) sessions.delete(sessionName);
  }
}
