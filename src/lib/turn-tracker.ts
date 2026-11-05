import type { ITabTurn } from '@/types/effects';

// A tab's turns as the hooks show them (story 15, ADR-0035 §7): a turn starts at prompt-submit, or at the first tool
// call after a stop (work a background job resumed), and ends at every stop or interrupt. Only a counter moves on a
// tool call; each stop writes one row.

/**
 * A Claude PostToolUse hook is posted detached (`hook-scripts.ts`), so the last tool call of a turn can reach the
 * server after the turn's stop. One that arrives this soon after the stop is counted on that turn.
 */
export const LATE_TOOL_MS = 3_000;

/**
 * The providers whose hooks report each tool call: Claude PostToolUse (matched to Edit|Write|MultiEdit|NotebookEdit|
 * Bash, `hook-settings.ts`), Grok `post_tool_use`, Codex PostToolUse. A turn of any other provider counts no tools.
 */
export const TOOL_FEED_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex', 'grok']);

/**
 * An acting call: an edit, a write or a shell command, the class Claude's matcher already sends. Grok and Codex
 * report every tool, so their reads (`read_file`, `grep`, `list_dir`, `web_search`) are filtered to the same class.
 */
const ACTING_TOOL = /(?:^|_)(?:bash|shell|exec|command|terminal|edit|multiedit|notebookedit|write|patch|replace|create|delete|move|rename)(?:_|$)/;

export const isActingTool = (tool: string): boolean => ACTING_TOOL.test(tool.trim().toLowerCase());

interface IOpenTurn {
  workspaceId: string;
  provider: string;
  startedAt: number | null;
  toolCalls: number | null;
}

export interface ITurnTrackerDeps {
  /** Write one finished turn; the row id, or null when it could not be written. */
  record: (turn: ITabTurn) => number | null;
  addToolCall: (id: number) => void;
}

export class TurnTracker {
  private readonly open = new Map<string, IOpenTurn>();
  /** The last turn each tab finished: a late tool hook's turn, and the mark that a later stop repeats it. */
  private readonly lastEnded = new Map<string, { id: number | null; endedAt: number }>();

  constructor(private readonly deps: ITurnTrackerDeps) {}

  /** A user prompt. One that arrives while a turn runs (a message queued behind it) continues it. */
  start(workspaceId: string, tabId: string, provider: string, at: number): void {
    if (this.open.has(tabId)) return;
    this.open.set(tabId, { workspaceId, provider, startedAt: at, toolCalls: TOOL_FEED_PROVIDERS.has(provider) ? 0 : null });
  }

  /**
   * An event that shows a turn is running without saying when it began (Codex PreToolUse and PostToolUse, which the
   * work-state machine reads as prompt-submit): an open turn goes on; otherwise a turn of unknown start opens.
   */
  running(workspaceId: string, tabId: string, provider: string): void {
    if (this.open.has(tabId)) return;
    this.open.set(tabId, { workspaceId, provider, startedAt: null, toolCalls: null });
  }

  /**
   * An acting tool call. With no turn open, it is a late hook of the last turn, or else a turn already running:
   * `continues` (Claude, Grok: work a background job resumed after a stop) starts it at the call when this server saw
   * the stop before it; otherwise its start, and so its count, are unknown.
   */
  toolCall(workspaceId: string, tabId: string, provider: string, at: number, continues = true): void {
    const turn = this.open.get(tabId);
    if (turn) {
      if (turn.toolCalls !== null) turn.toolCalls += 1;
      return;
    }
    const last = this.lastEnded.get(tabId);
    if (last && at - last.endedAt <= LATE_TOOL_MS) {
      if (last.id !== null) this.deps.addToolCall(last.id);
      return;
    }
    const seen = continues && last !== undefined;
    this.open.set(tabId, {
      workspaceId, provider, startedAt: seen ? at : null, toolCalls: seen && TOOL_FEED_PROVIDERS.has(provider) ? 1 : null,
    });
  }

  /** A stop or an interrupt. A second stop with no turn between is the same turn's, and writes nothing. */
  end(workspaceId: string, tabId: string, provider: string, at: number): void {
    const turn = this.open.get(tabId);
    if (!turn && this.lastEnded.has(tabId)) return;
    this.finish(tabId, turn ?? { workspaceId, provider, startedAt: null, toolCalls: null }, at);
  }

  /** A session start (a relaunch after the agent died mid-turn): the open turn ends there, its count unknown. */
  sessionStart(tabId: string, at: number): void {
    const turn = this.open.get(tabId);
    if (turn) this.finish(tabId, { ...turn, toolCalls: null }, at);
  }

  /** The turns still running, by tab, of one workspace: their start, or null when it was not seen. */
  openIn(workspaceId: string): Map<string, number | null> {
    const open = new Map<string, number | null>();
    for (const [tabId, turn] of this.open) if (turn.workspaceId === workspaceId) open.set(tabId, turn.startedAt);
    return open;
  }

  closed(tabId: string): void {
    this.open.delete(tabId);
    this.lastEnded.delete(tabId);
  }

  private finish(tabId: string, turn: IOpenTurn, at: number): void {
    this.open.delete(tabId);
    const id = this.deps.record({
      workspaceId: turn.workspaceId, tabId, provider: turn.provider, startedAt: turn.startedAt, endedAt: at, toolCalls: turn.toolCalls,
    });
    this.lastEnded.set(tabId, { id, endedAt: at });
  }
}
