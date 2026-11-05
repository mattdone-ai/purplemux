import { describe, expect, it, vi } from 'vitest';
import type { ICuratorJob } from '@/lib/curator-client';
import { CURATOR_EVAL_WORKSPACE } from '@/lib/curator-eval';
import { RESHAPE_TARGET } from '@/lib/curator-reshape-gate';
import { liveReplyLabels, reshapeForAsk, runReshapeEval, type IReshapeAskDeps } from '@/lib/curator-reshape-service';
import { CURATOR_TASKS } from '@/lib/curator-tasks';
import type { ICuratorCallRecord, ICuratorResult, TCuratorOutcome } from '@/types/curator';

// Story 23 AC 3-5 (consult C2): `mc ask --fix` returns a reshape only where the task routes; elsewhere it logs and
// answers shadow at once. The evaluation scores the first 100 replies and refuses after more than 10 non-replies.

const v1 = {
  kind: 'question', title: 'Which window?', context: 'Friday is quiet; tonight has a rollback.', storyIds: [], recommendation: null,
  options: [{ id: 'a', label: 'Friday quiet window' }, { id: 'b', label: 'Tonight' }], blockingScope: 'story', canContinue: true,
};
const goodReply = JSON.stringify({
  title: 'Deploy window', decision: 'Pick the deploy window', whyNow: 'The change is ready.',
  options: { a: { label: 'Friday', consequence: 'Ships Friday.' }, b: { label: 'Tonight', consequence: 'Ships tonight.' } },
});
/** A reply with no whyNow: the merged draft is still invalid at format 2, so it is never returned. */
const invalidReply = JSON.stringify({ title: 'T', decision: 'D', whyNow: '', options: { a: { label: 'a', consequence: 'c' }, b: { label: 'b', consequence: 'c' } } });

const record = (job: ICuratorJob, outcome: TCuratorOutcome, label: string | null, draftSha?: string): ICuratorCallRecord => ({
  task: job.task, model: 'gemma4:26b', promptVersion: 'rsq-v1-x~y', sourceId: null, modelDigest: 'd', outcome, label, rulesLabel: 'not-reshaped',
  span: null, spanFound: false, latencyMs: 10, waitedMs: 0, cutTokens: 0, promptTokens: 1, source: label === null ? 'rules' : 'curator',
  ...(draftSha ? { draftSha } : {}),
});

/** A classify that runs the task's real reader on a reply, as the client does. */
const replying = (content: (job: ICuratorJob) => string | TCuratorOutcome) => vi.fn(async (job: ICuratorJob): Promise<ICuratorResult> => {
  const reply = content(job);
  if (reply === 'timeout' || reply === 'dropped' || reply === 'down' || reply === 'error') return { record: record(job, reply, null), routed: 'not-reshaped' };
  const spec = CURATOR_TASKS['reshape-question'];
  const parsed = spec.parse!(reply, spec.prompt(job.input), job.input);
  if (!parsed.ok) return { record: record(job, 'unparsable', null), routed: 'not-reshaped' };
  return { record: record(job, 'labelled', parsed.label, 'sha'), routed: parsed.label, payload: parsed.payload };
});

const deps = (over: Partial<IReshapeAskDeps> = {}): IReshapeAskDeps => ({
  enabled: async () => true, routesIn: async () => true, routesOnVersion: async () => true, classify: replying(() => goodReply), live: () => true, ...over,
});

describe('mc ask --fix (AC 3, AC 5)', () => {
  it('where the task routes: a clean reshape comes back as a valid format-2 draft with the original in source', async () => {
    const answer = await reshapeForAsk('ws-a', 'tab-1', v1, deps());
    expect(answer).toMatchObject({ outcome: 'reshaped', promptVersion: 'rsq-v1-x~y' });
    const question = (answer as { question: Record<string, unknown> }).question;
    expect(question).toMatchObject({ formatVersion: 2, answerType: 'multi', decision: 'Pick the deploy window', source: v1 });
  });

  it('where the task routes, the call waits at most 60 s in the queue (it is in the agent\'s turn)', async () => {
    const d = deps();
    await reshapeForAsk('ws-a', 'tab-1', v1, d);
    expect((d.classify as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ task: 'reshape-question', workspaceId: 'ws-a', tabId: 'tab-1', maxWaitMs: 60_000 });
  });

  it('anywhere else: shadow at once, the reshape queued in the background and nothing returned', async () => {
    let release: (r: ICuratorResult) => void = () => undefined;
    const classify = vi.fn((_job: ICuratorJob) => new Promise<ICuratorResult>((resolve) => { release = resolve; }));
    const answer = await reshapeForAsk('ws-ldhziO', 'tab-1', v1, deps({ routesIn: async () => false, classify }));
    expect(answer).toMatchObject({ outcome: 'shadow' });
    expect(answer).not.toHaveProperty('question');
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][0]).not.toHaveProperty('maxWaitMs');
    release({ record: record(classify.mock.calls[0][0], 'labelled', 'reshaped'), routed: 'reshaped' });
  });

  it('in shadow outside a started server, no call is made', async () => {
    const classify = vi.fn();
    expect(await reshapeForAsk('ws-a', 'tab-1', v1, deps({ routesIn: async () => false, live: () => false, classify }))).toMatchObject({ outcome: 'shadow' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('a reshape the checks refuse, no reply, a structural defect, a non-draft, and the curator off are each said, never posted', async () => {
    expect(await reshapeForAsk('ws-a', 't', v1, deps({ classify: replying(() => invalidReply) }))).toMatchObject({ outcome: 'refused', label: 'invalid' });
    expect(await reshapeForAsk('ws-a', 't', v1, deps({ classify: replying(() => 'timeout') }))).toMatchObject({ outcome: 'no-reply', reason: 'timeout' });
    expect(await reshapeForAsk('ws-a', 't', { ...v1, options: [v1.options[0]] }, deps())).toMatchObject({ outcome: 'not-reshapable' });
    expect(await reshapeForAsk('ws-a', 't', 'text', deps())).toMatchObject({ outcome: 'not-a-draft' });
    expect(await reshapeForAsk('ws-a', 't', v1, deps({ enabled: async () => false }))).toMatchObject({ outcome: 'off' });
  });
});

describe('the reshape evaluation (AC 4, consult C2 (i)-(ii))', () => {
  const set = (n: number) => ({ task: 'reshape-question' as const, builtBy: 't', builtAt: 't', items: Array.from({ length: n }, (_, i) => ({ id: `ws-a/mc/item-${i}` })) });
  const evalDeps = (classify: ReturnType<typeof replying>, question: (id: string) => unknown = () => v1) => ({
    classify, question, now: () => 1, model: 'gemma4:26b', promptVersion: 'rsq-v1-x~y', runId: 'run-1',
  });

  it('scores the first 100 replies of the held-out ids, in the evaluation workspace, and keeps ids and sha256 only', async () => {
    const classify = replying(() => goodReply);
    const { result, drafts } = await runReshapeEval(set(600), evalDeps(classify));
    expect(result).toMatchObject({ runId: 'run-1', replied: RESHAPE_TARGET, clean: RESHAPE_TARGET, nonReplies: 0, refused: null, labels: { reshaped: 100 } });
    expect(classify).toHaveBeenCalledTimes(RESHAPE_TARGET);
    expect(classify.mock.calls.every(([job]) => job.workspaceId === CURATOR_EVAL_WORKSPACE)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('Friday');
    expect(result.rows[0]).toEqual({ id: result.rows[0].id, outcome: 'labelled', label: 'reshaped', draftSha: 'sha', defects: [], latencyMs: 10 });
    expect(drafts.size).toBe(RESHAPE_TARGET);
  });

  it('a timeout is reported, not scored; more than 10 before the 100th reply refuses the run', async () => {
    let n = 0;
    const flaky = replying(() => { n += 1; return n % 12 === 0 ? 'timeout' : goodReply; });
    const ok = await runReshapeEval(set(600), evalDeps(flaky));
    expect(ok.result.refused).toBeNull();
    expect(ok.result.replied).toBe(RESHAPE_TARGET);
    expect(ok.result.nonReplies).toBe(9);
    const down = await runReshapeEval(set(600), evalDeps(replying(() => 'timeout')));
    expect(down.result.refused).toBe('11 non-replies before the 100th reply (limit 10)');
    expect(down.result.replied).toBe(0);
  });

  it('an invalid reply counts against the 100%, with its defect fields named', async () => {
    let n = 0;
    const { result } = await runReshapeEval(set(600), evalDeps(replying(() => { n += 1; return n === 3 ? invalidReply : goodReply; })));
    expect(result.clean).toBe(99);
    expect(result.rows.find((row) => row.label === 'invalid')?.defects).toEqual(['whyNow']);
  });

  it('an item Mission Control no longer holds, or one no reshape can fix, is reported and skipped', async () => {
    const { result } = await runReshapeEval(set(20), evalDeps(replying(() => goodReply), (id) => (id.endsWith('-1') ? null : { ...v1, options: [v1.options[0]] })));
    expect(result.replied).toBe(0);
    expect(result.unresolved + result.unreshapable).toBe(result.candidates);
  });
});

describe('review r1 fixes (round 2)', () => {
  const set = (n: number) => ({ task: 'reshape-question' as const, builtBy: 't', builtAt: 't', items: Array.from({ length: n }, (_, i) => ({ id: `ws-a/mc/item-${i}` })) });
  const evalDeps = (classify: ReturnType<typeof replying>, question: (id: string) => unknown = () => v1) => ({
    classify, question, now: () => 1, model: 'gemma4:26b', promptVersion: 'rsq-v1-x~y', runId: 'run-1',
  });

  it('F2: an unparsable reply and an error are failed replies that count against the 100%, never non-replies', async () => {
    let n = 0;
    const { result } = await runReshapeEval(set(600), evalDeps(replying(() => { n += 1; return n === 2 ? 'not json' : n === 5 ? 'error' : goodReply; })));
    expect(result).toMatchObject({ replied: RESHAPE_TARGET, clean: RESHAPE_TARGET - 2, nonReplies: 0, refused: null });
    expect(result.rows.filter((row) => row.label === null).map((row) => [row.outcome, row.defects])).toEqual([['unparsable', ['unparsable']], ['error', ['error']]]);
  });

  it('F2: a draft over 6,000 tokens is unreshapable before any call, in the evaluation and in --fix', async () => {
    const long = { ...v1, context: 'x'.repeat(7000), options: [{ id: 'a', label: 'y'.repeat(400) }, { id: 'b', label: 'z'.repeat(400) }] };
    const huge = { ...long, context: 'x'.repeat(8000), options: Array.from({ length: 2 }, (_, i) => ({ id: `o${i}`, label: 'w'.repeat(500), description: 'd'.repeat(4500) })) };
    const classify = replying(() => goodReply);
    const { result } = await runReshapeEval(set(20), evalDeps(classify, () => huge));
    expect(classify).not.toHaveBeenCalled();
    expect(result.unreshapable).toBe(result.candidates);
    const ask = await reshapeForAsk('ws-a', 't', huge, deps({ classify }));
    expect(ask).toMatchObject({ outcome: 'not-reshapable' });
    expect((ask as { defects: Array<{ message: string }> }).defects[0].message).toMatch(/^question: about \d+ tokens of JSON, at most 6000 for a reshape$/);
    expect(classify).not.toHaveBeenCalled();
  });

  it('F2: the live-shadow check counts an unparsable reply or an error as failed, and leaves out only timeout, down and dropped', () => {
    const rec = (outcome: string, label: string | null = null, promptVersion = 'H') => JSON.stringify({ task: 'reshape-question', promptVersion, outcome, label });
    expect(liveReplyLabels([
      rec('labelled', 'reshaped'), rec('unparsable'), rec('error'), rec('timeout'), rec('down'), rec('dropped'), rec('labelled', 'invalid'),
      rec('labelled', 'reshaped', 'other'), JSON.stringify({ task: 'classify-owner-message', promptVersion: 'H', outcome: 'labelled', label: 'one-off' }),
    ], 'H')).toEqual(['reshaped', 'unparsable', 'error', 'invalid']);
  });

  it('F6: a clean reshape whose reply came from a version that does not route here is not returned', async () => {
    const routesOnVersion = vi.fn(async () => false);
    const answer = await reshapeForAsk('ws-a', 'tab-1', v1, deps({ routesOnVersion }));
    expect(answer).toMatchObject({ outcome: 'shadow' });
    expect((answer as { reason: string }).reason).toContain('the reply came from rsq-v1-x~y, which does not route here');
    expect(answer).not.toHaveProperty('question');
    expect(routesOnVersion).toHaveBeenCalledWith('ws-a', 'rsq-v1-x~y');
  });

  it('F7: a draft whose options or evidence hold a non-object is not a draft, never silently trimmed', async () => {
    const v2 = { formatVersion: 2, kind: 'question', title: 'T', decision: 'D', answerType: 'single', storyIds: [], blockingScope: 'none', canContinue: true,
      options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
    expect(await reshapeForAsk('ws-a', 't', { ...v2, options: [{ id: 'a', label: 'A' }, 'b'] }, deps())).toMatchObject({ outcome: 'not-a-draft' });
    expect(await reshapeForAsk('ws-a', 't', { ...v2, evidence: [null] }, deps())).toMatchObject({ outcome: 'not-a-draft' });
    expect(await reshapeForAsk('ws-a', 't', { ...v2, evidence: 'https://x' }, deps())).toMatchObject({ outcome: 'not-a-draft' });
  });
});
