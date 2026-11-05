import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collapse, findTwin, missionAskText, readMissionAsks, resolveLabelledText, sha16, transcriptTurnEnds, transcriptUserEntries, userText, workspaceTranscripts,
} from '@/lib/curator-sources';
import { resolveLayoutDir } from '@/lib/layout-store';
import { ensureLiveSince, readCuratorState, readEvalResult, readLabelledSet, updateCuratorState, writeEvalResult, writeLabelledSet } from '@/lib/curator-store';
import { isHeldOut } from '@/lib/curator';

// AC 4: the sets hold ids and labels; the text is read at evaluation time from history, transcripts and MC.

const HISTORY_WS = 'ws-curator-test';
const SESSION = '0f6e2a3c-1111-4222-8333-944455556666';
let directory = '';
let home: ReturnType<typeof vi.spyOn>;

const write = (rel: string, body: string) => {
  const file = path.join(directory, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
};

const assistant = (uuid: string, text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', uuid, timestamp: '2026-11-02T01:00:00Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'first' }, { type: 'text', text }] }, ...extra,
});

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-curator-sources-'));
  home = vi.spyOn(os, 'homedir').mockReturnValue(directory);
  delete (globalThis as Record<string, unknown>).__ptCuratorStateLock;
  // message-history-store resolves its directory once, from the test process's isolated HOME (tests/setup).
  fs.mkdirSync(resolveLayoutDir(HISTORY_WS), { recursive: true });
  fs.writeFileSync(path.join(resolveLayoutDir(HISTORY_WS), 'message-history.json'),
    JSON.stringify({ entries: [{ id: 'm1', message: 'from now on use AEDT', sentAt: '2026-11-01T00:00:00Z' }] }));
  write(`.purplemux/workspaces/ws-a/claude-home/projects/-home-x/${SESSION}.jsonl`, [
    JSON.stringify({ type: 'user', uuid: 'q1', timestamp: '2026-11-02T00:59:00Z', message: { content: 'Context first.\nfrom now on   use AEDT, please' } }),
    JSON.stringify({ type: 'user', uuid: 'q2', timestamp: '2026-11-02T00:59:30Z', message: { content: [{ type: 'tool_result', content: 'from now on use AEDT' }] } }),
    assistant('u1', `${'x'.repeat(700)}Shall I merge?`),
    assistant('u2', 'tool step', { message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'tool step' }] } }),
    assistant('u3', 'side', { isSidechain: true }),
    'not json "end_turn"',
  ].join('\n'));
  write('.purplemux/workspaces/ws-a/claude-home/projects/-home-x/not-a-session.jsonl', assistant('u9', 'ignored'));
  const db = new Database(write('.purplemux/mission-control.sqlite', ''));
  db.exec(`CREATE TABLE attention_items (id TEXT, workspace_id TEXT, question_json TEXT, human_review_json TEXT, created_at INTEGER)`);
  db.prepare('INSERT INTO attention_items VALUES (?, ?, ?, ?, ?)').run('mc-1', 'ws-a',
    JSON.stringify({ title: 'Approve PR #5?', decision: 'Merge PR #5 now?', context: 'It is green.' }), JSON.stringify({ humanNeed: 'approval' }), 1);
  db.prepare('INSERT INTO attention_items VALUES (?, ?, ?, ?, ?)').run('curator-spot-check-owner-2026-11-03', 'ws-a',
    JSON.stringify({ decision: 'Which of these 30 message labels are wrong?', context: '1. x' }), JSON.stringify({ humanNeed: 'decision' }), 2);
  db.close();
});

afterEach(() => {
  home.mockRestore();
  fs.rmSync(resolveLayoutDir(HISTORY_WS), { recursive: true, force: true });
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('resolving a labelled id', () => {
  it('an owner message from message-history.json', async () => {
    expect(await resolveLabelledText(`${HISTORY_WS}/m1`)).toBe('from now on use AEDT');
    expect(await resolveLabelledText(`${HISTORY_WS}/gone`)).toBeNull();
  });

  it("a turn ending from the workspace transcript: the last text block's last 600 chars, as the watchdog reads it", async () => {
    const text = await resolveLabelledText(`ws-a/${SESSION}/u1`);
    expect(text).toHaveLength(600);
    expect(text!.endsWith('Shall I merge?')).toBe(true);
    expect(await resolveLabelledText(`ws-a/${SESSION}/u2`)).toBeNull();
    expect(await resolveLabelledText(`ws-a/${SESSION}/u3`)).toBeNull();
  });

  it('a Mission Control ask: the decision line, then the context', async () => {
    expect(await resolveLabelledText('ws-a/mc/mc-1')).toBe('Merge PR #5 now?\nIt is green.');
    expect(missionAskText(JSON.stringify({ title: 'T only' }))).toBe('T only');
    expect(await resolveLabelledText('ws-a/mc/curator-spot-check-owner-2026-11-03')).toBeNull();
    expect(readMissionAsks(null).map((a) => a.id)).toEqual(['mc-1']);
    expect(missionAskText('not json')).toBeNull();
  });

  it('a malformed or foreign id is never read', async () => {
    expect(await resolveLabelledText('../../etc/passwd')).toBeNull();
    expect(await resolveLabelledText('ws-a/not-a-session/u1')).toBeNull();
    expect(await resolveLabelledText('ws-a/a/b/c')).toBeNull();
  });

  it('lists only session-named transcripts and their main-thread end_turn entries', async () => {
    const files = await workspaceTranscripts('ws-a');
    expect(files.map((f) => path.basename(f))).toEqual([`${SESSION}.jsonl`]);
    expect((await transcriptTurnEnds('ws-a', files[0])).map((t) => t.id)).toEqual([`ws-a/${SESSION}/u1`]);
    expect(await workspaceTranscripts('../x')).toEqual([]);
  });
});

describe('the transcript twin of an owner message (consult 16-promote-gate, ruling 3)', () => {
  const entries = [
    { ref: 'ws-a/s/early', at: 1_000, text: 'from now on use AEDT' },
    { ref: 'ws-a/s/near', at: 9_000, text: 'from now on use AEDT' },
    { ref: 'ws-a/s/long', at: 10_000, text: 'Context.\nfrom now on use AEDT and stop' },
    { ref: 'ws-a/s/spaced', at: 10_000, text: 'pls  stop\n\nasking   me' },
  ];

  it('prefers an equal entry nearest the send time, then one holding the text, then a whitespace-collapsed match', () => {
    expect(findTwin('from now on use AEDT', 10_000, entries)).toEqual({ ref: 'ws-a/s/near', start: 0, length: 20, mode: 'raw', sha: sha16('from now on use AEDT') });
    expect(findTwin('use AEDT and', 10_000, entries)).toMatchObject({ ref: 'ws-a/s/long', start: 21, mode: 'raw' });
    expect(findTwin('stop asking me', 10_000, entries)).toEqual({ ref: 'ws-a/s/spaced', start: 4, length: 14, mode: 'collapsed', sha: sha16('stop asking me') });
    expect(findTwin('never typed', 10_000, entries)).toBeNull();
  });

  it('a user entry\'s text excludes tool results and sidechains', () => {
    expect(userText({ type: 'user', message: { content: 'hi' } })).toBe('hi');
    expect(userText({ type: 'user', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } })).toBe('a\nb');
    expect(userText({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBeNull();
    expect(userText({ type: 'user', isSidechain: true, message: { content: 'x' } })).toBeNull();
  });

  it('resolves through the twin once the history entry is gone, in raw and collapsed mode, verified by hash', async () => {
    const [file] = await workspaceTranscripts('ws-a');
    const users = await transcriptUserEntries('ws-a', file);
    expect(users.map((u) => u.ref)).toEqual([`ws-a/${SESSION}/q1`]);
    const raw = findTwin('Context first.', 0, users)!;
    expect(await resolveLabelledText({ id: 'ws-a/gone', alt: raw })).toBe('Context first.');
    const folded = findTwin('from now on use AEDT, please', 0, users)!;
    expect(folded.mode).toBe('collapsed');
    expect(await resolveLabelledText({ id: 'ws-a/gone', alt: folded })).toBe(collapse('from now on use AEDT, please'));
    expect(await resolveLabelledText({ id: 'ws-a/gone', alt: { ...raw, sha: '0000000000000000' } })).toBeNull();
    expect(await resolveLabelledText({ id: 'ws-a/gone', alt: { ...raw, ref: `ws-a/${SESSION}/missing` } })).toBeNull();
  });
});

describe('the curator store', () => {
  it('a labelled set keeps ids, labels, times and twin locators only: any text field is dropped before the write', async () => {
    const alt = { ref: 'ws-a/s/u', start: 0, length: 3, mode: 'raw' as const, sha: 'abc', text: 'hunter2' };
    await writeLabelledSet({
      task: 'classify-owner-message', labelledBy: 'test', labelledAt: '2026-11-03T00:00:00Z',
      items: [{ id: 'ws-a/m1', label: 'standing-order', text: 'my password is hunter2' } as never, { id: 'ws-a/m2', label: 'one-off', at: 5, alt } as never],
    });
    const raw = fs.readFileSync(path.join(directory, '.purplemux/curator/eval/classify-owner-message.json'), 'utf-8');
    expect(raw).not.toContain('hunter2');
    expect((await readLabelledSet('classify-owner-message'))!.items).toEqual([
      { id: 'ws-a/m1', label: 'standing-order' }, { id: 'ws-a/m2', label: 'one-off', at: 5, alt: { ref: 'ws-a/s/u', start: 0, length: 3, mode: 'raw', sha: 'abc' } },
    ]);
    expect(fs.statSync(path.join(directory, '.purplemux/curator/eval/classify-owner-message.json')).mode & 0o777).toBe(0o600);
  });

  it('a whole-set result keeps no row of a held-out id; its counts still cover every scored item (confirm R1)', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ id: `ws-a/m${i}`, gold: 'one-off', predicted: 'one-off', outcome: 'labelled' as const, latencyMs: 1 }));
    const held = rows.filter((r) => isHeldOut(r.id)).length;
    expect(held).toBeGreaterThan(5);
    const score = { classes: [], checks: [], pass: false };
    const base = {
      task: 'classify-owner-message' as const, promptVersion: 'v', model: 'm', startedAt: 0, finishedAt: 1, n: 60,
      counts: [{ label: 'one-off', support: 60, predicted: 60, truePositives: 60 }], unresolved: 0, agedOut: 0, unresolvedByClass: {},
      excluded: { shadow: 0, disputed: 0 }, spotCheck: null, refused: null, outcomes: {}, latency: { p50: 1, p90: 1 }, score, rules: score,
    };
    await writeEvalResult({ ...base, split: 'all', rows });
    const all = (await readEvalResult('classify-owner-message', 'all'))!;
    expect(all.rows!.some((r) => isHeldOut(r.id))).toBe(false);
    expect(all.rows).toHaveLength(60 - held);
    expect(all.counts).toEqual([{ label: 'one-off', support: 60, predicted: 60, truePositives: 60 }]);
    await writeEvalResult({ ...base, split: 'holdout', rows });
    expect(await readEvalResult('classify-owner-message')).not.toHaveProperty('rows');
  });

  it('the shadow clock starts once and never moves', async () => {
    expect(await ensureLiveSince(100)).toBe(100);
    expect(await ensureLiveSince(200)).toBe(100);
    expect((await readCuratorState()).liveSince).toBe(100);
  });

  it('serialises concurrent changes on one chain', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => updateCuratorState((s) => { s.rateLimitMs += i + 1; })));
    expect((await readCuratorState()).rateLimitMs).toBe(55);
  });

  it('an absent or foreign state file reads as empty, and unknown task keys are dropped', async () => {
    expect(await readCuratorState()).toEqual({ version: 1, liveSince: null, tasks: {}, kodit: null, rateLimitMs: 0 });
    write('.purplemux/curator/state.json', JSON.stringify({ version: 1, liveSince: 5, tasks: { nope: {}, 'flag-owner-question': { state: 'shadow' } } }));
    expect((await readCuratorState()).tasks).toEqual({ 'flag-owner-question': { state: 'shadow' } });
  });
});
