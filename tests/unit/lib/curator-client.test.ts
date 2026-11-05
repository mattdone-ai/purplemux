import { describe, expect, it } from 'vitest';
import { CURATOR_QUEUE_MAX_WAIT_MS, CURATOR_TIMEOUT_MS } from '@/lib/curator';
import { CURATOR_DOWN_MAX_BACKOFF_MS, CURATOR_DOWN_RETRY_MS, CuratorClient, type ICuratorJob } from '@/lib/curator-client';
import { CURATOR_TASKS, servedVersion } from '@/lib/curator-tasks';
import type { ICuratorCallRecord } from '@/types/curator';

// ADR-0038 §1, §2, §6 against a fake Ollama and a fake clock.

interface IFake {
  client: CuratorClient;
  records: Array<{ job: ICuratorJob; record: ICuratorCallRecord }>;
  bodies: Array<Record<string, unknown>>;
  clock: { now: number };
  inFlight: { now: number; max: number };
  sleeps: number[];
}

type TReply = (body: Record<string, unknown>, url: string) => Promise<Response> | Response;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const label = (l: string, span = 'from now on') => json({ message: { content: JSON.stringify({ label: l, span }) }, prompt_eval_count: 42 });
const refused = () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11435') }); };
const tags = (models: string[], digest: string | null = 'sha256:d1') => json({ models: models.map((name) => ({ name, model: name, ...(digest ? { digest } : {}) })) });

const fake = (reply: TReply, opts: { minIntervalMs?: number; callMs?: number; ownTags?: boolean; urls?: string[] } = {}): IFake => {
  const clock = { now: 1_000_000 };
  const records: IFake['records'] = [];
  const bodies: IFake['bodies'] = [];
  const inFlight = { now: 0, max: 0 };
  const sleeps: number[] = [];
  const client = new CuratorClient({
    now: () => clock.now,
    sleep: async (ms) => { sleeps.push(ms); clock.now += ms; },
    minIntervalMs: async () => opts.minIntervalMs ?? 0,
    record: (job, record) => { records.push({ job, record }); },
    fetch: (async (url: string, init?: RequestInit) => {
      opts.urls?.push(url);
      // The probe answers at once with the model and its digest, unless the test serves /api/tags itself.
      if (url.endsWith('/api/tags') && !opts.ownTags) return tags(['gemma4:26b']);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (init?.body) bodies.push(body);
      inFlight.now += 1;
      inFlight.max = Math.max(inFlight.max, inFlight.now);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        clock.now += opts.callMs ?? 1500;
        return await reply(body, url);
      } finally {
        inFlight.now -= 1;
      }
    }) as unknown as typeof fetch,
  });
  return { client, records, bodies, clock, inFlight, sleeps };
};

const job = (text = 'from now on use AEDT', task: ICuratorJob['task'] = 'classify-owner-message'): ICuratorJob =>
  ({ task, workspaceId: 'ws-a', tabId: '-', input: { text } });

describe('curator client (AC 2)', () => {
  it('labels a message and records model, prompt version, latency, label, rules label and the quoted span', async () => {
    const f = fake(() => label('standing-order'));
    const result = await f.client.classify(job());
    expect(result.routed).toBe('standing-order');
    expect(f.records).toHaveLength(1);
    expect(f.records[0].record).toMatchObject({
      task: 'classify-owner-message', model: 'gemma4:26b', promptVersion: servedVersion('classify-owner-message', 'sha256:d1'), modelDigest: 'sha256:d1',
      outcome: 'labelled', label: 'standing-order',
      rulesLabel: 'standing-order', span: 'from now on', spanFound: true, latencyMs: 1500, promptTokens: 42, cutTokens: 0, source: 'curator',
    });
    expect(f.records[0].job).toMatchObject({ workspaceId: 'ws-a', tabId: '-' });
  });

  it('asks Ollama for the enum labels with no keep_alive and no num_ctx, so kodit\'s model never reloads', async () => {
    const f = fake(() => label('one-off'));
    await f.client.classify(job('hello'));
    const body = f.bodies[0];
    expect(body).toMatchObject({ model: 'gemma4:26b', stream: false, think: false, options: { temperature: 0 } });
    expect(body).not.toHaveProperty('keep_alive');
    expect(body.options).not.toHaveProperty('num_ctx');
    expect((body.format as { properties: { label: { enum: string[] } } }).properties.label.enum).toHaveLength(5);
  });

  it('runs one request at a time', async () => {
    const f = fake(() => label('one-off'));
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => f.client.classify(job(`m${i}`))));
    expect(results).toHaveLength(5);
    expect(f.inFlight.max).toBe(1);
    expect(f.records.map((r) => r.record.waitedMs)).toEqual([0, 1500, 3000, 4500, 6000]);
  });

  it('a call with no reply in 30 s times out and the rules route', async () => {
    const f = fake(() => { throw new DOMException('timed out', 'TimeoutError'); }, { callMs: CURATOR_TIMEOUT_MS });
    const result = await f.client.classify(job('status?'));
    expect(result.routed).toBe('status-ping');
    expect(result.record).toMatchObject({ outcome: 'timeout', label: null, source: 'rules', latencyMs: CURATOR_TIMEOUT_MS, error: 'no reply in 30 s' });
    expect(f.client.health().state).toBe('up');
  });

  it('cuts a long input to its last 6,000 tokens and logs the cut', async () => {
    const f = fake(() => label('one-off'));
    const long = `${'old words '.repeat(5000)}THE END`;
    await f.client.classify(job(long));
    const sent = String((f.bodies[0].messages as Array<{ content: string }>)[1].content);
    expect(sent).toContain('THE END');
    expect(sent.length).toBeLessThan(long.length);
    expect(f.records[0].record.cutTokens).toBeGreaterThan(0);
  });

  it('a reply off the label list is unparsable and the rules route', async () => {
    const f = fake(() => json({ message: { content: '{"label":"maybe"}' } }));
    const result = await f.client.classify(job('fix it'));
    expect(result).toMatchObject({ routed: 'one-off', record: { outcome: 'unparsable', source: 'rules' } });
    expect(result.record.error).toBe('label is not one offered (offered: standing-order, product-rule, answer, status-ping, one-off)');
  });

  it('a span the model made up is kept but marked not found', async () => {
    const f = fake(() => label('standing-order', 'words nobody typed'));
    expect((await f.client.classify(job())).record).toMatchObject({ span: 'words nobody typed', spanFound: false });
  });

  it('an Ollama error status is an error outcome, the rules route, and the curator stays up', async () => {
    const f = fake(() => json({ error: 'busy' }, 500));
    expect((await f.client.classify(job('fix it'))).record).toMatchObject({ outcome: 'error', error: 'Ollama 500' });
    expect(f.client.health().state).toBe('up');
  });

  it('the kodit gap runs from the end of one call to the start of the next (review r1 F8)', async () => {
    const f = fake(() => label('one-off'), { minIntervalMs: 10_000, callMs: 1000 });
    await Promise.all([f.client.classify(job('a')), f.client.classify(job('b'))]);
    expect(f.sleeps).toEqual([10_000]);
  });

  it('carries the source id into the record', async () => {
    const f = fake(() => label('one-off'));
    await f.client.classify({ ...job('fix it'), sourceId: 'ws-a/m1' });
    expect(f.records[0].record.sourceId).toBe('ws-a/m1');
    await f.client.classify(job('again'));
    expect(f.records[1].record.sourceId).toBeNull();
  });

  it('withholds the span when the input or the span looks like a credential (review r1 F2)', async () => {
    const secretInput = 'deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123 from now on';
    const f = fake(() => label('standing-order', 'from now on'));
    const first = await f.client.classify(job(secretInput));
    expect(first.record).toMatchObject({ span: null, withheld: true, label: 'standing-order' });
    const g = fake(() => label('standing-order', 'password: hunter22'));
    expect((await g.client.classify(job('the password: hunter22 is the default from now on'))).record).toMatchObject({ span: null, withheld: true });
    const h = fake(() => label('standing-order', 'from now on'));
    expect((await h.client.classify(job())).record).not.toHaveProperty('withheld');
    expect(JSON.stringify([...f.records, ...g.records].map((r) => r.record))).not.toMatch(/ghp_|hunter22/);
  });

  it('never stores the raw reply in an error, which may quote the input (review r1 F2)', async () => {
    const f = fake(() => json({ message: { content: 'sure: AKIAABCDEFGHIJKLMNOP is the key' } }));
    const result = await f.client.classify(job('the key is AKIAABCDEFGHIJKLMNOP'));
    expect(result.record).toMatchObject({ outcome: 'unparsable', error: 'reply is not JSON (37 chars)' });
    expect(JSON.stringify(f.records.map((r) => r.record))).not.toContain('AKIA');
  });
});

describe('the served version (architect confirm R2)', () => {
  it('probes before the first call: no call starts while health is unknown', async () => {
    const urls: string[] = [];
    const f = fake(() => label('one-off'), { urls });
    expect(f.client.health().state).toBe('unknown');
    await f.client.classify(job('hi'));
    expect(urls.map((u) => u.replace(/^http:\/\/[^/]+/, ''))).toEqual(['/api/tags', '/api/chat']);
  });

  it('a re-pull of the same tag (a new digest) gives the next record a new version', async () => {
    let digest = 'sha256:d1';
    const f = fake((_body, url) => (url.endsWith('/api/tags') ? tags(['gemma4:26b'], digest) : label('one-off')), { ownTags: true });
    await f.client.classify(job('a'));
    digest = 'sha256:d2';
    await f.client.probe();
    await f.client.classify(job('b'));
    const [a, b] = f.records.map((r) => r.record);
    expect(a).toMatchObject({ modelDigest: 'sha256:d1', promptVersion: servedVersion('classify-owner-message', 'sha256:d1') });
    expect(b).toMatchObject({ modelDigest: 'sha256:d2', promptVersion: servedVersion('classify-owner-message', 'sha256:d2') });
    expect(a.promptVersion).not.toBe(b.promptVersion);
    expect(a.promptVersion.startsWith(`${CURATOR_TASKS['classify-owner-message'].promptVersion}~`)).toBe(true);
  });

  it("the matcher's version follows its order set: one edited order text is a new version", async () => {
    const f = fake(() => json({ message: { content: JSON.stringify({ label: 'SO-4', span: 'redeploy' }) } }));
    const orders = [{ id: 'SO-4', text: 'Reversible work needs no approval.' }, { id: 'SO-1', text: 'Read v1 first.' }];
    await f.client.classify({ task: 'match-standing-order', workspaceId: 'ws-a', tabId: 't', input: { text: 'may I redeploy?', orders } });
    await f.client.classify({ task: 'match-standing-order', workspaceId: 'ws-a', tabId: 't', input: { text: 'may I redeploy?', orders: [...orders].reverse() } });
    await f.client.classify({ task: 'match-standing-order', workspaceId: 'ws-a', tabId: 't', input: { text: 'may I redeploy?', orders: [{ ...orders[0], text: 'Reversible work needs no approval in Dev.' }, orders[1]] } });
    const [v1, same, edited] = f.records.map((r) => r.record.promptVersion);
    expect(same).toBe(v1);
    expect(edited).not.toBe(v1);
  });

  it('a call dropped before any probe answered carries the static version marked unknown', async () => {
    const f = fake(() => refused(), { ownTags: true });
    const result = await f.client.classify(job('status?'));
    expect(result.record).toMatchObject({ outcome: 'dropped', modelDigest: null, promptVersion: `${CURATOR_TASKS['classify-owner-message'].promptVersion}~unknown` });
  });
});

describe('curator down (AC 8)', () => {
  it('a refused connection marks the tunnel down; the call waits in the queue and goes when it is back', async () => {
    // The first probe answers; the call then finds the tunnel gone; the next probe (after the backoff) finds it back.
    let probes = 0;
    let chats = 0;
    const f = fake((_body, url) => {
      if (url.endsWith('/api/tags')) { probes += 1; return tags(['gemma4:26b']); }
      chats += 1;
      if (chats === 1) refused();
      return label('one-off');
    }, { ownTags: true });
    let calls = 0;
    const original = f.client.probe;
    f.client.probe = async () => { calls += 1; return original(); };
    const result = await f.client.classify(job('fix it'));
    expect(result.record.outcome).toBe('labelled');
    expect(calls).toBe(2);
    expect([probes, chats]).toEqual([2, 2]);
    expect(f.sleeps).toEqual([CURATOR_DOWN_RETRY_MS]);
    expect(f.records).toHaveLength(1);
  });

  it('while down, a call queued over 10 min drops to the rules and the board reads down with the reason', async () => {
    const f = fake(() => refused(), { ownTags: true });
    const result = await f.client.classify(job('status?'));
    expect(result).toMatchObject({ routed: 'status-ping', record: { outcome: 'dropped', source: 'rules', error: 'queued over 10 min' } });
    expect(result.record.waitedMs).toBeGreaterThan(CURATOR_QUEUE_MAX_WAIT_MS);
    expect(f.sleeps.slice(0, 4)).toEqual([CURATOR_DOWN_RETRY_MS, 2 * CURATOR_DOWN_RETRY_MS, 4 * CURATOR_DOWN_RETRY_MS, 8 * CURATOR_DOWN_RETRY_MS]);
    expect(Math.max(...f.sleeps)).toBeLessThanOrEqual(CURATOR_DOWN_MAX_BACKOFF_MS);
    expect(f.client.health()).toMatchObject({ state: 'down' });
    expect(f.client.health().reason).toMatch(/^tunnel down \(fetch failed: connect ECONNREFUSED/);
    expect(f.client.queued()).toBe(0);
  });

  it('the probe: no answer is the tunnel down, an answer without the model is the model down, else up', async () => {
    const f = fake(() => refused(), { ownTags: true });
    expect((await f.client.probe()).state).toBe('down');
    const g = fake(() => tags(['qwen3-embedding:4b']), { ownTags: true });
    expect(await g.client.probe()).toMatchObject({ state: 'down', reason: 'model down (gemma4:26b not served)' });
    const h = fake(() => tags(['gemma4:26b']), { ownTags: true });
    expect(await h.client.probe()).toMatchObject({ state: 'up', reason: null });
    expect(h.client.digest()).toBe('sha256:d1');
    const k = fake(() => tags(['gemma4:26b'], null), { ownTags: true });
    expect(await k.client.probe()).toMatchObject({ state: 'down', reason: 'model down (gemma4:26b served with no digest)' });
  });

  it('a 404 on /api/chat while /api/tags lists the model backs off, doubling to 5 min, then drops to rules (review r1 F9)', async () => {
    let chats = 0;
    const f = fake((_body, url) => {
      if (url.endsWith('/api/tags')) return tags(['gemma4:26b']);
      chats += 1;
      return new Response('model "gemma4:26b" not found', { status: 404 });
    }, { ownTags: true });
    const result = await f.client.classify(job('status?'));
    expect(result.record).toMatchObject({ outcome: 'dropped', source: 'rules' });
    expect(f.sleeps).toEqual([30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(chats).toBe(5);
    expect(f.client.health()).toMatchObject({ state: 'down' });
    expect(f.client.health().reason).toMatch(/^model down \(/);
  });

  it('a call that comes back after a down result resets the backoff', async () => {
    let n = 0;
    const f = fake((_body, url) => {
      if (url.endsWith('/api/tags')) return tags(['gemma4:26b']);
      n += 1;
      return n === 1 ? new Response('not found', { status: 404 }) : label('one-off');
    }, { ownTags: true });
    await f.client.classify(job('a'));
    await f.client.classify(job('b'));
    expect(f.sleeps).toEqual([30_000]);
  });
;
});

describe('the reshape through the client (story 23 AC 3)', () => {
  const v1 = {
    kind: 'question', title: 'Which window?', context: 'Friday is quiet; tonight has a rollback.', storyIds: [], recommendation: null,
    options: [{ id: 'a', label: 'Friday quiet window' }, { id: 'b', label: 'Tonight' }], blockingScope: 'story', canContinue: true,
  };
  const reshapeJob = async (over: Partial<ICuratorJob> = {}): Promise<ICuratorJob> => {
    const { liftDraft } = await import('@/lib/curator-reshape');
    return { task: 'reshape-question', workspaceId: 'ws-a', tabId: 'tab-1', input: { text: JSON.stringify(v1), draft: liftDraft(v1)!, source: v1 }, ...over };
  };
  const reply = {
    title: 'Deploy window', decision: 'Pick the deploy window', whyNow: 'The change is ready.',
    options: { a: { label: 'Friday', consequence: 'Ships Friday.' }, b: { label: 'Tonight', consequence: 'Ships tonight.' } },
  };

  it('sends the task\'s own schema (one keyed entry per option id), returns the verdict, records the label and the draft sha256, never its text', async () => {
    const f = fake(() => json({ message: { content: JSON.stringify(reply) }, prompt_eval_count: 300 }));
    const result = await f.client.classify(await reshapeJob());
    expect((f.bodies[0].format as { properties: { options: { required: string[] } } }).properties.options.required).toEqual(['a', 'b']);
    expect(result.record).toMatchObject({ task: 'reshape-question', outcome: 'labelled', label: 'reshaped', span: null, source: 'curator', rulesLabel: 'not-reshaped' });
    expect(result.record.draftSha).toMatch(/^[0-9a-f]{64}$/);
    expect((result.payload as { candidate: { decision: string } }).candidate.decision).toBe('Pick the deploy window');
    expect(JSON.stringify(f.records[0].record)).not.toContain('Ships Friday');
    expect(JSON.stringify(f.records[0].record)).not.toContain('Friday quiet window');
  });

  it('a draft over 6,000 tokens is refused whole before any model call, never cut', async () => {
    const f = fake(() => json({ message: { content: JSON.stringify(reply) } }));
    const result = await f.client.classify(await reshapeJob({ input: { text: 'x'.repeat(20_000) } }));
    expect(result.record).toMatchObject({ outcome: 'error', cutTokens: 0 });
    expect(result.record.error).toMatch(/is over 6000 and is not cut$/);
    expect(f.bodies).toHaveLength(0);
    expect(result).not.toHaveProperty('payload');
  });

  it('a call with its own queue limit drops after it, and the record names that limit', async () => {
    const f = fake(() => refused(), { ownTags: true });
    const result = await f.client.classify(await reshapeJob({ maxWaitMs: 60_000 }));
    expect(result.record).toMatchObject({ outcome: 'dropped', error: 'queued over 1 min' });
    expect(result.record.waitedMs).toBeLessThan(CURATOR_QUEUE_MAX_WAIT_MS);
  });
});
