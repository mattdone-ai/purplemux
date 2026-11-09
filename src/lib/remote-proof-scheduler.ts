import type { TStrictRuntimeObservation } from '@/lib/process-utils';

/**
 * The process proofs of remote agent panes (ADR-0022 §19, vel-D61), bounded so a slow host never holds the
 * status poll. The poll never awaits a proof: it reads the answer an earlier proof left, and queues the next
 * ones. Per host at most `perHostCap` proofs run at once, and a freed slot starts the next queued one at once
 * (review r2 M1), so a fast host clears its queue in seconds. The queue puts a tab whose key changed since its
 * last proof first (the likeliest death), then the least recently proven. Hosts run in parallel.
 *
 * - `present` is kept for `ttlMs` under its key (the session, the pane, its foreground command and the agent's
 *   launch): a new key proves again.
 * - `absent` is kept, with no TTL, until one read takes it: the transition it causes happens at that read, and
 *   a relaunch (a new key) never meets it.
 * - `unknown` (ssh failed or timed out) is never kept; that host's proofs back off `backoffMs` and its queue is
 *   dropped (the next poll asks again).
 */

export type TRemoteProofWant = 'claude' | 'codex' | 'grok';

export interface IRemoteProofRequest {
  tabId: string;
  host: string;
  sessionName: string;
  want: TRemoteProofWant;
  /** Changes when the session, its pane, the pane's foreground command or the agent's launch changes. */
  key: string;
}

export interface IRemoteProofDeps {
  observe: (sessionName: string, want: TRemoteProofWant) => Promise<TStrictRuntimeObservation>;
  now: () => number;
  onUnknown?: (req: IRemoteProofRequest, reason: string) => void;
}

export const REMOTE_PROOF_TTL_MS = 60_000;
export const REMOTE_PROOF_BACKOFF_MS = 30_000;
export const REMOTE_PROOF_PER_HOST_CAP = 4;

interface IResult {
  key: string;
  state: 'present' | 'absent';
  at: number;
}

export class RemoteProofScheduler {
  private readonly results = new Map<string, IResult>();
  /** Tab → the host of its running proof. */
  private readonly inFlight = new Map<string, string>();
  private readonly running = new Set<Promise<void>>();
  /** Host → its queued requests, by tab: a newer request for a tab replaces the older one. */
  private readonly queues = new Map<string, Map<string, IRemoteProofRequest>>();
  private readonly lastAsked = new Map<string, number>();
  /** Tab → the key of its last proof. */
  private readonly lastKey = new Map<string, string>();
  private readonly hostBackoff = new Map<string, number>();

  constructor(
    private readonly deps: IRemoteProofDeps,
    private readonly opts: { ttlMs: number; backoffMs: number; perHostCap: number } = {
      ttlMs: REMOTE_PROOF_TTL_MS,
      backoffMs: REMOTE_PROOF_BACKOFF_MS,
      perHostCap: REMOTE_PROOF_PER_HOST_CAP,
    },
  ) {}

  /** The answer for this key, without waiting: true, false (consumed), or null when no proof answered yet. */
  read(req: IRemoteProofRequest): boolean | null {
    const result = this.results.get(req.tabId);
    if (!result) return null;
    // An absent answer has no TTL: it waits for one read, however late the next poll comes (review r3 C2).
    if (result.key !== req.key || (result.state === 'present' && this.deps.now() - result.at >= this.opts.ttlMs)) {
      this.results.delete(req.tabId);
      return null;
    }
    if (result.state === 'present') return true;
    this.results.delete(req.tabId);
    return false;
  }

  /**
   * Queue the proofs these requests need and start them within each host's cap, outside its backoff. Never
   * awaited by the poll; the returned promise settles when the queues drain (tests).
   */
  schedule(requests: readonly IRemoteProofRequest[]): Promise<void> {
    const hosts = new Set<string>();
    for (const req of requests) {
      if (!this.needsProof(req)) continue;
      const queue = this.queues.get(req.host) ?? new Map<string, IRemoteProofRequest>();
      queue.set(req.tabId, req);
      this.queues.set(req.host, queue);
      hosts.add(req.host);
    }
    for (const host of hosts) this.pump(host);
    return this.settled();
  }

  /** One proof awaited by its caller (an off-poll read), through the same cache and backoff, outside the cap. */
  async prove(req: IRemoteProofRequest): Promise<boolean | null> {
    const cached = this.read(req);
    if (cached !== null) return cached;
    if (this.inFlight.has(req.tabId) || this.inBackoff(req.host)) return null;
    await this.run(req);
    return this.read(req);
  }

  /** Every proof started so far, and every one a freed slot started after it, has ended. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  forget(tabId: string): void {
    this.results.delete(tabId);
    this.lastAsked.delete(tabId);
    this.lastKey.delete(tabId);
    for (const queue of this.queues.values()) queue.delete(tabId);
  }

  private inBackoff(host: string): boolean {
    return (this.hostBackoff.get(host) ?? 0) > this.deps.now();
  }

  private needsProof(req: IRemoteProofRequest): boolean {
    if (this.inFlight.has(req.tabId) || this.inBackoff(req.host)) return false;
    const kept = this.results.get(req.tabId);
    return !(kept && kept.key === req.key && (kept.state === 'absent' || this.deps.now() - kept.at < this.opts.ttlMs));
  }

  /** Changed key first, then least recently proven. */
  private next(queue: Map<string, IRemoteProofRequest>): IRemoteProofRequest | undefined {
    const changed = (r: IRemoteProofRequest) => (this.lastKey.has(r.tabId) && this.lastKey.get(r.tabId) !== r.key ? 0 : 1);
    return [...queue.values()].sort((a, b) => changed(a) - changed(b)
      || (this.lastAsked.get(a.tabId) ?? 0) - (this.lastAsked.get(b.tabId) ?? 0))[0];
  }

  private pump(host: string): void {
    const queue = this.queues.get(host);
    if (!queue) return;
    if (this.inBackoff(host)) {
      this.queues.delete(host);
      return;
    }
    let running = [...this.inFlight.values()].filter((h) => h === host).length;
    while (running < this.opts.perHostCap && queue.size > 0) {
      const req = this.next(queue)!;
      queue.delete(req.tabId);
      if (!this.needsProof(req)) continue;
      running += 1;
      const done: Promise<void> = this.run(req).finally(() => {
        this.running.delete(done);
        this.pump(host);
      });
      this.running.add(done);
    }
    if (queue.size === 0) this.queues.delete(host);
  }

  private async run(req: IRemoteProofRequest): Promise<void> {
    this.inFlight.set(req.tabId, req.host);
    this.lastAsked.set(req.tabId, this.deps.now());
    this.lastKey.set(req.tabId, req.key);
    try {
      const observed = await this.deps.observe(req.sessionName, req.want).catch((err: unknown): TStrictRuntimeObservation => ({
        state: 'unknown', reason: err instanceof Error ? err.message : String(err),
      }));
      if (observed.state === 'unknown') {
        this.results.delete(req.tabId);
        this.hostBackoff.set(req.host, this.deps.now() + this.opts.backoffMs);
        this.deps.onUnknown?.(req, observed.reason);
        return;
      }
      this.results.set(req.tabId, { key: req.key, state: observed.state, at: this.deps.now() });
    } finally {
      this.inFlight.delete(req.tabId);
    }
  }
}
