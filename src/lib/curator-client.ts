import { createHash } from 'crypto';
import {
  CURATOR_BASE_URL, CURATOR_MAX_INPUT_TOKENS, CURATOR_MODEL, CURATOR_QUEUE_MAX_WAIT_MS, CURATOR_TIMEOUT_MS, cutToLastTokens, estimateTokens,
  parseCuratorReply, replySchema, spanOccurs,
} from '@/lib/curator';
import { CURATOR_REQUEST_OPTIONS, CURATOR_TASKS, servedVersion, type ICuratorTaskInput, type TCuratorReplyParse } from '@/lib/curator-tasks';
import { createLogger } from '@/lib/logger';
import { looksLikeSecret } from '@/lib/secret-patterns';
import type { ICuratorCallRecord, ICuratorHealth, ICuratorResult, TCuratorOutcome, TCuratorTask } from '@/types/curator';

const log = createLogger('curator');

/**
 * After a down result (a call or a probe), the queue waits before it probes again: 30 s, doubling to at most 5 min, so a
 * model that /api/tags lists but /api/chat refuses never spins (review r1 F9). A queued call still drops to rules at 10 min.
 */
export const CURATOR_DOWN_RETRY_MS = 30_000;
export const CURATOR_DOWN_MAX_BACKOFF_MS = 5 * 60_000;
export const CURATOR_PROBE_TIMEOUT_MS = 5_000;

export interface ICuratorJob {
  task: TCuratorTask;
  workspaceId: string;
  /** The tab the text came from; `-` for an owner message, which belongs to the workspace. */
  tabId: string;
  input: ICuratorTaskInput;
  enqueuedAt?: number;
  /** The labelled-set id of the text (`<ws>/<entryId>`, `<ws>/<session>/<uuid>`, `<ws>/mc/<item>`): the label pass reads it. */
  sourceId?: string | null;
  /** How long the call may wait in the queue before it drops to the rules; 10 min when absent (ADR-0038 §6). */
  maxWaitMs?: number;
}

export interface ICuratorClientDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** The gap from one call's end to the next call's start: the kodit rule's or the fleet's, whichever is longer. */
  minIntervalMs: () => Promise<number>;
  /** Every finished call, in `tab_events` (AC 2). A failed write never fails the call. */
  record: (job: ICuratorJob, record: ICuratorCallRecord, at: number) => void;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

interface IQueued {
  job: ICuratorJob;
  enqueuedAt: number;
  resolve: (result: ICuratorResult) => void;
}

type TCall =
  | { kind: 'reply'; content: string; latencyMs: number; promptTokens: number | null }
  | { kind: 'timeout'; latencyMs: number }
  | { kind: 'down'; reason: 'tunnel' | 'model'; detail: string }
  | { kind: 'error'; detail: string; latencyMs: number };

const errorText = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
};

const isAbort = (err: unknown): boolean => err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');

/** The sha256 of a proposed draft: the record and the judge's verdict name the exact draft, never its text. */
export const draftSha = (draft: unknown): string => createHash('sha256').update(JSON.stringify(draft)).digest('hex');

const maxWait = (job: ICuratorJob): number => job.maxWaitMs ?? CURATOR_QUEUE_MAX_WAIT_MS;
const dropText = (job: ICuratorJob): string => {
  const ms = maxWait(job);
  return `queued over ${ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`}`;
};

/**
 * The curator client (ADR-0038 §1, §6): one request at a time, a 30 s timeout, a queue whose calls drop to the
 * rules after 10 min, and a health state the board reads. Nothing waits on it: every caller gets a result, the
 * model's label or the rules'.
 */
export class CuratorClient {
  private readonly queue: IQueued[] = [];
  private draining = false;
  private lastEndAt = 0;
  private modelDigest: string | null = null;
  private downStreak = 0;
  private healthState: ICuratorHealth = { state: 'unknown', reason: null, since: null, checkedAt: null };
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(private readonly deps: ICuratorClientDeps) {
    this.baseUrl = deps.baseUrl ?? CURATOR_BASE_URL;
    this.model = deps.model ?? CURATOR_MODEL;
    this.timeoutMs = deps.timeoutMs ?? CURATOR_TIMEOUT_MS;
  }

  health = (): ICuratorHealth => ({ ...this.healthState });

  /** The served model's digest from the last probe that found it; null before one. */
  digest = (): string | null => this.modelDigest;

  queued = (): number => this.queue.length;

  classify = (job: ICuratorJob): Promise<ICuratorResult> => new Promise((resolve) => {
    this.queue.push({ job, enqueuedAt: job.enqueuedAt ?? this.deps.now(), resolve });
    void this.drain();
  });

  /** `GET /api/tags`: no GPU work. No answer is the tunnel down; an answer without the model is the model down. */
  probe = async (): Promise<ICuratorHealth> => {
    try {
      const response = await this.deps.fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(CURATOR_PROBE_TIMEOUT_MS) });
      if (!response.ok) {
        this.setHealth('down', `model down (Ollama answered ${response.status})`);
      } else {
        const body = await response.json() as { models?: Array<{ name?: string; model?: string; digest?: string }> };
        const served = (body.models ?? []).find((m) => m.name === this.model || m.model === this.model);
        if (!served) this.setHealth('down', `model down (${this.model} not served)`);
        else if (typeof served.digest !== 'string' || !served.digest) this.setHealth('down', `model down (${this.model} served with no digest)`);
        else {
          this.modelDigest = served.digest;
          this.setHealth('up', null);
        }
      }
    } catch (err) {
      this.setHealth('down', `tunnel down (${errorText(err)})`);
    }
    return this.health();
  };

  private setHealth = (state: ICuratorHealth['state'], reason: string | null): void => {
    const at = this.deps.now();
    if (state !== this.healthState.state || reason !== this.healthState.reason) {
      if (state !== this.healthState.state) log.info({ from: this.healthState.state, to: state, reason }, `curator ${state}`);
      this.healthState = { state, reason, since: state === this.healthState.state ? this.healthState.since : at, checkedAt: at };
    } else {
      this.healthState.checkedAt = at;
    }
  };

  private drain = async (): Promise<void> => {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        this.dropExpired();
        const next = this.queue[0];
        if (!next) break;
        // No call runs without a known digest: a curator not yet probed (`unknown`) is probed first (confirm R2).
        if (this.healthState.state !== 'up' || this.downStreak > 0) {
          if (this.downStreak > 0) {
            await this.deps.sleep(Math.min(CURATOR_DOWN_MAX_BACKOFF_MS, CURATOR_DOWN_RETRY_MS * 2 ** (this.downStreak - 1)));
            this.dropExpired();
            if (!this.queue.length) break;
          }
          if ((await this.probe()).state === 'down') {
            this.downStreak += 1;
            continue;
          }
        }
        const head = this.queue.shift()!;
        const requeued = await this.run(head);
        if (requeued) {
          this.downStreak += 1;
          this.queue.unshift(head);
        } else {
          this.downStreak = 0;
        }
      }
    } finally {
      this.draining = false;
    }
  };

  private dropExpired = (): void => {
    const now = this.deps.now();
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      const queued = this.queue[i];
      if (now - queued.enqueuedAt <= maxWait(queued.job)) continue;
      this.queue.splice(i, 1);
      this.finish(queued, 'dropped', { waitedMs: now - queued.enqueuedAt, error: dropText(queued.job) });
    }
  };

  private finish = (
    queued: IQueued,
    outcome: TCuratorOutcome,
    extra: Partial<ICuratorCallRecord> & { waitedMs: number; payload?: unknown },
  ): void => {
    const spec = CURATOR_TASKS[queued.job.task];
    const rulesLabel = spec.rules(queued.job.input);
    const label = outcome === 'labelled' ? extra.label ?? null : null;
    // A span that is, or comes from a text that holds, a credential is never written (review r1 F2).
    const span = extra.span ?? null;
    const withheld = span !== null && (looksLikeSecret(queued.job.input.text) || looksLikeSecret(span));
    const record: ICuratorCallRecord = {
      task: queued.job.task, model: this.model, sourceId: queued.job.sourceId ?? null, modelDigest: this.modelDigest, outcome, label,
      // H, the served version; a call that never reached a known model keeps the static version with `~unknown`.
      promptVersion: servedVersion(queued.job.task, this.modelDigest, queued.job.input.orders) ?? `${spec.promptVersion}~unknown`,
      rulesLabel, span: withheld ? null : span, ...(withheld ? { withheld: true } : {}), spanFound: extra.spanFound ?? false, latencyMs: extra.latencyMs ?? null, waitedMs: extra.waitedMs,
      cutTokens: extra.cutTokens ?? 0, promptTokens: extra.promptTokens ?? null, source: label === null ? 'rules' : 'curator',
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.draftSha ? { draftSha: extra.draftSha } : {}),
    };
    try {
      this.deps.record(queued.job, record, this.deps.now());
    } catch (err) {
      log.warn({ task: record.task }, `curator: call not logged (${errorText(err)})`);
    }
    queued.resolve({ record, routed: label ?? rulesLabel, ...(extra.payload !== undefined && label !== null ? { payload: extra.payload } : {}) });
  };

  /** One call. True: the curator went down mid-call, so the job goes back to the head of the queue. */
  private run = async (queued: IQueued): Promise<boolean> => {
    const minInterval = await this.deps.minIntervalMs().catch(() => 0);
    const gap = this.lastEndAt + minInterval - this.deps.now();
    if (minInterval > 0 && gap > 0) await this.deps.sleep(gap);
    const startAt = this.deps.now();
    const waitedMs = startAt - queued.enqueuedAt;
    if (waitedMs > maxWait(queued.job)) {
      this.finish(queued, 'dropped', { waitedMs, error: dropText(queued.job) });
      return false;
    }
    const spec = CURATOR_TASKS[queued.job.task];
    if (spec.cut === false && estimateTokens(queued.job.input.text) > CURATOR_MAX_INPUT_TOKENS) {
      // A structure a cut would break (a question draft) is refused whole, before the model sees any of it.
      this.finish(queued, 'error', { waitedMs, error: `input of about ${estimateTokens(queued.job.input.text)} tokens is over ${CURATOR_MAX_INPUT_TOKENS} and is not cut` });
      return false;
    }
    const cut = spec.cut === false ? { text: queued.job.input.text, cutTokens: 0 } : cutToLastTokens(queued.job.input.text);
    if (cut.cutTokens > 0) log.info({ task: spec.task, cutTokens: cut.cutTokens }, 'curator: input cut to its last 6,000 tokens');
    const input = { ...queued.job.input, text: cut.text };
    const prompt = spec.prompt(input);
    const call = await this.call(prompt.system, prompt.user, spec.schema ? spec.schema(prompt, input) : replySchema(prompt.labels));
    this.lastEndAt = this.deps.now();
    const base = { waitedMs, cutTokens: cut.cutTokens };
    if (call.kind === 'down') {
      this.setHealth('down', `${call.reason} down (${call.detail})`);
      return true;
    }
    this.setHealth('up', null);
    if (call.kind === 'timeout') {
      this.finish(queued, 'timeout', { ...base, latencyMs: call.latencyMs, error: `no reply in ${this.timeoutMs / 1000} s` });
    } else if (call.kind === 'error') {
      this.finish(queued, 'error', { ...base, latencyMs: call.latencyMs, error: call.detail });
    } else {
      const parsed: TCuratorReplyParse = spec.parse ? spec.parse(call.content, prompt, input) : parseCuratorReply(call.content, prompt.labels);
      if (!parsed.ok) {
        this.finish(queued, 'unparsable', { ...base, latencyMs: call.latencyMs, promptTokens: call.promptTokens, error: parsed.error });
      } else {
        this.finish(queued, 'labelled', {
          ...base, latencyMs: call.latencyMs, promptTokens: call.promptTokens, label: parsed.label, span: parsed.span,
          spanFound: spanOccurs(parsed.span, cut.text), ...(parsed.payload !== undefined ? { payload: parsed.payload } : {}),
          ...(spec.draftOf && parsed.payload !== undefined ? { draftSha: draftSha(spec.draftOf(parsed.payload)) } : {}),
        });
      }
    }
    return false;
  };

  private call = async (system: string, user: string, format: object): Promise<TCall> => {
    const startedAt = this.deps.now();
    try {
      // No keep_alive and no num_ctx: kodit's 24 h and 8,192 stand, so a curator call never reloads the model.
      const response = await this.deps.fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model, ...CURATOR_REQUEST_OPTIONS, format,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const latencyMs = this.deps.now() - startedAt;
      if (response.status === 404) return { kind: 'down', reason: 'model', detail: (await response.text().catch(() => '')).slice(0, 200) || '404' };
      if (!response.ok) return { kind: 'error', detail: `Ollama ${response.status}`, latencyMs };
      const body = await response.json() as { message?: { content?: string }; prompt_eval_count?: number };
      return { kind: 'reply', content: body.message?.content ?? '', latencyMs, promptTokens: body.prompt_eval_count ?? null };
    } catch (err) {
      const latencyMs = this.deps.now() - startedAt;
      if (isAbort(err)) return { kind: 'timeout', latencyMs };
      if (err instanceof TypeError) return { kind: 'down', reason: 'tunnel', detail: errorText(err) };
      return { kind: 'error', detail: errorText(err), latencyMs };
    }
  };
}
