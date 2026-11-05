import { describe, expect, it } from 'vitest';
import { LATE_TOOL_MS, TurnTracker, isActingTool } from '@/lib/turn-tracker';
import type { ITabTurn } from '@/types/effects';

const WS = 'ws-t';
const TAB = 'tab-t';

const tracker = () => {
  const rows: Array<ITabTurn & { id: number }> = [];
  const t = new TurnTracker({
    record: (turn) => {
      rows.push({ ...turn, id: rows.length + 1 });
      return rows.length;
    },
    addToolCall: (id) => {
      const row = rows.find((r) => r.id === id)!;
      if (row.toolCalls !== null) row.toolCalls += 1;
    },
  });
  return { t, rows };
};

describe('isActingTool: edit, write and shell, on every provider', () => {
  it.each(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'shell', 'exec_command', 'apply_patch', 'search_replace', 'run_terminal_command', 'create_file'])(
    '%s acts', (tool) => expect(isActingTool(tool)).toBe(true),
  );
  it.each(['Read', 'Grep', 'Glob', 'read_file', 'grep', 'list_dir', 'web_search', 'update_plan', 'Agent'])(
    '%s only reads', (tool) => expect(isActingTool(tool)).toBe(false),
  );
});

describe('TurnTracker', () => {
  it('counts the tool calls between a prompt and its stop, in one row per turn', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'claude', 1_000);
    t.toolCall(WS, TAB, 'claude', 2_000);
    t.toolCall(WS, TAB, 'claude', 3_000);
    t.end(WS, TAB, 'claude', 4_000);
    t.start(WS, TAB, 'claude', 10_000);
    t.end(WS, TAB, 'claude', 11_000);
    expect(rows.map(({ startedAt, endedAt, toolCalls }) => [startedAt, endedAt, toolCalls])).toEqual([[1_000, 4_000, 2], [10_000, 11_000, 0]]);
  });

  it('continues the open turn on a prompt-submit inside it (a queued message, Codex per-tool events)', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'codex', 1_000);
    t.start(WS, TAB, 'codex', 2_000);
    t.toolCall(WS, TAB, 'codex', 2_500);
    t.end(WS, TAB, 'codex', 3_000);
    expect(rows).toMatchObject([{ startedAt: 1_000, toolCalls: 1 }]);
  });

  it('starts a turn at a tool call after a stop it saw: background work resumed', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'claude', 1_000);
    t.end(WS, TAB, 'claude', 2_000);
    t.toolCall(WS, TAB, 'claude', 2_000 + LATE_TOOL_MS + 1);
    t.end(WS, TAB, 'claude', 9_000);
    expect(rows[1]).toMatchObject({ startedAt: 2_000 + LATE_TOOL_MS + 1, endedAt: 9_000, toolCalls: 1 });
  });

  it('counts a tool hook that lands just after its stop on that turn (Claude posts it detached)', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'claude', 1_000);
    t.end(WS, TAB, 'claude', 2_000);
    t.toolCall(WS, TAB, 'claude', 2_000 + LATE_TOOL_MS);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolCalls).toBe(1);
  });

  it('records a turn whose start this server never saw with no start and no count, never 0', () => {
    const { t, rows } = tracker();
    t.toolCall(WS, TAB, 'claude', 1_000);
    t.end(WS, TAB, 'claude', 2_000);
    t.end(WS, 'tab-other', 'claude', 2_500);
    expect(rows).toMatchObject([
      { tabId: TAB, startedAt: null, endedAt: 2_000, toolCalls: null },
      { tabId: 'tab-other', startedAt: null, endedAt: 2_500, toolCalls: null },
    ]);
  });

  it('writes nothing for a second stop of the same turn', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'grok', 1_000);
    t.end(WS, TAB, 'grok', 2_000);
    t.end(WS, TAB, 'grok', 2_100);
    expect(rows).toHaveLength(1);
  });

  it('counts no tools for a provider whose hooks report none', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'other-cli', 1_000);
    t.toolCall(WS, TAB, 'other-cli', 1_500);
    t.end(WS, TAB, 'other-cli', 2_000);
    expect(rows[0].toolCalls).toBeNull();
  });

  it('forgets a closed tab: its open turn writes nothing, and its next life starts unseen', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'claude', 1_000);
    t.closed(TAB);
    t.toolCall(WS, TAB, 'claude', 5_000);
    t.end(WS, TAB, 'claude', 6_000);
    expect(rows).toMatchObject([{ startedAt: null, toolCalls: null }]);
  });

  it('ends an open turn at a session start as unmeasured: the agent was relaunched mid-turn (review R5)', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'claude', 1_000);
    t.toolCall(WS, TAB, 'claude', 1_500);
    t.sessionStart(TAB, 2_000);
    t.sessionStart(TAB, 2_500);
    t.start(WS, TAB, 'claude', 3_000);
    t.end(WS, TAB, 'claude', 4_000);
    expect(rows.map(({ startedAt, endedAt, toolCalls }) => [startedAt, endedAt, toolCalls])).toEqual([[1_000, 2_000, null], [3_000, 4_000, 0]]);
  });

  it('opens a turn of unknown start for a Codex tool event or tool call with none open (review R5)', () => {
    const { t, rows } = tracker();
    t.start(WS, TAB, 'codex', 1_000);
    t.end(WS, TAB, 'codex', 2_000);
    t.running(WS, TAB, 'codex');
    t.toolCall(WS, TAB, 'codex', 9_000, false);
    t.end(WS, TAB, 'codex', 10_000);
    t.toolCall(WS, TAB, 'codex', 20_000, false);
    t.end(WS, TAB, 'codex', 21_000);
    expect(rows.slice(1).map(({ startedAt, toolCalls }) => [startedAt, toolCalls])).toEqual([[null, null], [null, null]]);
  });

  it('keeps a running turn going on a Codex tool event, and lists the open turns of a workspace', () => {
    const { t } = tracker();
    t.start(WS, TAB, 'codex', 1_000);
    t.running(WS, TAB, 'codex');
    t.toolCall('ws-other', 'tab-x', 'claude', 5_000);
    expect([...t.openIn(WS)]).toEqual([[TAB, 1_000]]);
    expect([...t.openIn('ws-other')]).toEqual([['tab-x', null]]);
  });

  it('keeps no late-hook link to a row it could not write', () => {
    const rows: ITabTurn[] = [];
    const added: number[] = [];
    const t = new TurnTracker({ record: (turn) => (rows.push(turn), null), addToolCall: (id) => added.push(id) });
    t.start(WS, TAB, 'claude', 1_000);
    t.end(WS, TAB, 'claude', 2_000);
    t.toolCall(WS, TAB, 'claude', 2_500);
    expect(added).toEqual([]);
  });
});
