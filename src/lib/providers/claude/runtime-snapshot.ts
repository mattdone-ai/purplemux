import fs from 'fs/promises';
import { INTERRUPT_PREFIX, summarizeToolCall } from '@/lib/session-parser';
import type { IAgentRuntimeSnapshot, IRuntimeSnapshotOptions, ITurnError } from '@/lib/providers/types';
import { TURN_TAIL_CHARS } from '@/lib/turn-end';
import {
  latestBackgroundActivityAt,
  openBackgroundTasks,
  readBackgroundLedger,
} from '@/lib/providers/claude/background-ledger';
import type { ICurrentAction } from '@/types/status';
import type { TToolName } from '@/types/timeline';

const JSONL_TAIL_SIZE = 8192;
const JSONL_EXTENDED_TAIL_SIZE = 131_072;
const STALE_MS_INTERRUPTED = 20_000;
const STALE_MS_AWAITING_API = 90_000;
const MAX_JSONL_CACHE = 256;
const MAX_SNIPPET_LENGTH = 200;

interface IJsonlIdleCache {
  mtimeMs: number;
  idle: boolean;
  stale: boolean;
  needsStaleRecheck: boolean;
  staleMs: number;
  lastAssistantSnippet: string | null;
  lastAssistantTail: string | null;
  lastAssistantUuid: string | null;
  lastTurnError: ITurnError | null;
  currentAction: ICurrentAction | null;
  reset: boolean;
  lastEntryTs: number | null;
  interrupted: boolean;
}

interface IAssistantExtract {
  lastAssistantSnippet: string | null;
  lastAssistantTail: string | null;
  lastAssistantUuid: string | null;
  lastTurnError: ITurnError | null;
  currentAction: ICurrentAction | null;
  reset: boolean;
}

interface IScanResult {
  matched: boolean;
  idle: boolean;
  stale: boolean;
  needsStaleRecheck: boolean;
  staleMs: number;
  lastEntryTs: number | null;
  interrupted: boolean;
}

const g = globalThis as unknown as { __ptClaudeRuntimeSnapshotCache?: Map<string, IJsonlIdleCache> };
if (!g.__ptClaudeRuntimeSnapshotCache) g.__ptClaudeRuntimeSnapshotCache = new Map();
const jsonlIdleCache = g.__ptClaudeRuntimeSnapshotCache;

const emptySnapshot = (): IAgentRuntimeSnapshot => ({
  idle: false,
  stale: false,
  lastAssistantSnippet: null,
  lastAssistantTail: null,
  lastAssistantUuid: null,
  lastTurnError: null,
  currentAction: null,
  reset: false,
  lastEntryTs: null,
  staleMs: 0,
  interrupted: false,
});

const toCurrentAction = (block: { name?: string; input?: Record<string, unknown> }): ICurrentAction => {
  const toolName = (block.name ?? 'Tool') as TToolName;
  const input = (block.input ?? {}) as Record<string, unknown>;
  return { toolName, summary: summarizeToolCall(toolName, input) };
};

// Claude Code writes a provider failure as a synthetic assistant entry flagged
// `isApiErrorMessage` with an `error` code (measured 2026-09-26: `server_error`
// "API Error: Server error mid-response…", `authentication_failed`). Only a code
// measured as transient is resumed; every other code is `other` (today's
// READY nudge, nothing typed). No usage-limit entry has been observed, so none
// is classified as one: the halt stays with the human-facing READY nudge.
const CLAUDE_RESUMABLE_ERRORS: ReadonlySet<string> = new Set(['server_error']);
const MAX_TURN_ERROR_TEXT = 300;

const turnErrorOf = (entry: { isApiErrorMessage?: unknown; error?: unknown; uuid?: unknown; message?: { content?: unknown } }): ITurnError | null => {
  if (entry.isApiErrorMessage !== true) return null;
  const code = typeof entry.error === 'string' && entry.error ? entry.error : 'unknown';
  const content = Array.isArray(entry.message?.content) ? entry.message!.content as Array<{ text?: unknown }> : [];
  const text = content.map((b) => (typeof b.text === 'string' ? b.text : '')).join(' ').trim().slice(0, MAX_TURN_ERROR_TEXT);
  return {
    class: CLAUDE_RESUMABLE_ERRORS.has(code) ? 'api-error' : 'other',
    code,
    text,
    turnId: typeof entry.uuid === 'string' ? entry.uuid : '',
  };
};

const extractAssistantInfo = (lines: string[]): IAssistantExtract => {
  let userMessageSeen = false;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.isSidechain) continue;

      if (entry.type === 'user') {
        const c = entry.message?.content;
        const isToolResult = Array.isArray(c) && c.some((b: unknown) => (b as { type?: string }).type === 'tool_result');
        if (!isToolResult) userMessageSeen = true;
        continue;
      }

      if (entry.type !== 'assistant' || !entry.message?.content) continue;

      if (userMessageSeen) return { lastAssistantSnippet: null, lastAssistantTail: null, lastAssistantUuid: null, lastTurnError: null, currentAction: null, reset: true };

      const content = entry.message.content;
      if (!Array.isArray(content)) continue;

      let lastAssistantSnippet: string | null = null;
      let lastAssistantTail: string | null = null;
      let currentAction: ICurrentAction | null = null;

      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block.type === 'tool_use') {
          currentAction = toCurrentAction(block);
          break;
        }
        if (block.type === 'text' && block.text?.trim()) {
          const text = block.text.trim();
          currentAction = {
            toolName: null,
            summary: text.length > MAX_SNIPPET_LENGTH ? text.slice(0, MAX_SNIPPET_LENGTH) + '…' : text,
          };
          break;
        }
      }

      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j].type === 'text' && content[j].text?.trim()) {
          const text = content[j].text.trim();
          lastAssistantSnippet = text.length > MAX_SNIPPET_LENGTH
            ? text.slice(0, MAX_SNIPPET_LENGTH) + '…'
            : text;
          // The turn-end marker is the message's LAST line; the snippet is its head.
          lastAssistantTail = text.slice(-TURN_TAIL_CHARS);
          break;
        }
      }

      return {
        lastAssistantSnippet, lastAssistantTail, lastAssistantUuid: lastAssistantTail !== null && typeof entry.uuid === 'string' ? entry.uuid : null,
        lastTurnError: turnErrorOf(entry), currentAction, reset: false,
      };
    } catch { continue; }
  }
  return { lastAssistantSnippet: null, lastAssistantTail: null, lastAssistantUuid: null, lastTurnError: null, currentAction: null, reset: false };
};

const scanLines = (lines: string[], elapsed: number): IScanResult => {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);

      if (entry.isSidechain) continue;

      const entryTs: number | null = entry.timestamp ? new Date(entry.timestamp).getTime() : null;

      if (entry.type === 'system' && (entry.subtype === 'stop_hook_summary' || entry.subtype === 'turn_duration')) {
        return { matched: true, idle: true, stale: false, needsStaleRecheck: false, staleMs: 0, lastEntryTs: entryTs, interrupted: false };
      }

      if (entry.type === 'assistant') {
        const stopReason = entry.message?.stop_reason;
        if (!stopReason) {
          const idle = elapsed > STALE_MS_INTERRUPTED;
          return { matched: true, idle, stale: true, needsStaleRecheck: !idle, staleMs: STALE_MS_INTERRUPTED, lastEntryTs: entryTs, interrupted: false };
        }
        return { matched: true, idle: stopReason !== 'tool_use', stale: false, needsStaleRecheck: false, staleMs: 0, lastEntryTs: entryTs, interrupted: false };
      }

      if (entry.type === 'user') {
        const content = entry.message?.content;
        if (Array.isArray(content) && content.length === 1 && typeof content[0]?.text === 'string' && content[0].text.startsWith(INTERRUPT_PREFIX)) {
          return { matched: true, idle: true, stale: false, needsStaleRecheck: false, staleMs: 0, lastEntryTs: entryTs, interrupted: true };
        }
        const idle = elapsed > STALE_MS_AWAITING_API;
        return { matched: true, idle, stale: true, needsStaleRecheck: !idle, staleMs: STALE_MS_AWAITING_API, lastEntryTs: entryTs, interrupted: false };
      }
    } catch {
      continue;
    }
  }

  return { matched: false, idle: elapsed > STALE_MS_AWAITING_API, stale: true, needsStaleRecheck: elapsed <= STALE_MS_AWAITING_API, staleMs: STALE_MS_AWAITING_API, lastEntryTs: null, interrupted: false };
};

/**
 * Open background work comes from the whole transcript (the ledger), never
 * from the tail window: on 2026-09-26 every start lay beyond the 8 KB tail and
 * all 108 replayed READY nudges read 0 open tasks. It is recomputed on every
 * call, cache hit included, because a task ends without the tail changing.
 */
const withBackgroundWork = async (
  jsonlPath: string,
  snapshot: IAgentRuntimeSnapshot,
  options: IRuntimeSnapshotOptions,
): Promise<IAgentRuntimeSnapshot> => {
  try {
    const now = Date.now();
    const ledger = await readBackgroundLedger(jsonlPath, options.tasksSince);
    const open = openBackgroundTasks(ledger, now, options.tasksSince);
    const openBackgroundTaskKinds = { shell: 0, agent: 0, monitor: 0 };
    for (const task of open) openBackgroundTaskKinds[task.kind] += 1;
    const backgroundActivityAt = options.withActivity && open.length > 0
      ? await latestBackgroundActivityAt(jsonlPath, ledger, now, options.tasksSince)
      : null;
    return { ...snapshot, openBackgroundTasks: open.length, openBackgroundTaskKinds, backgroundActivityAt };
  } catch {
    return snapshot;
  }
};

const fromCache = (cached: IJsonlIdleCache, idle: boolean, stale: boolean): IAgentRuntimeSnapshot => ({
  idle,
  stale,
  lastAssistantSnippet: cached.lastAssistantSnippet,
  lastAssistantTail: cached.lastAssistantTail,
  lastAssistantUuid: cached.lastAssistantUuid,
  lastTurnError: cached.lastTurnError,
  currentAction: cached.currentAction,
  reset: cached.reset,
  lastEntryTs: cached.lastEntryTs,
  staleMs: cached.staleMs,
  interrupted: cached.interrupted,
});

const readTailSnapshot = async (
  jsonlPath: string,
  options: { force?: boolean },
): Promise<IAgentRuntimeSnapshot> => {
  const stat = await fs.stat(jsonlPath);
  if (stat.size === 0) return { ...emptySnapshot(), idle: true };

  const cached = jsonlIdleCache.get(jsonlPath);
  if (!options.force && cached && cached.mtimeMs === stat.mtimeMs) {
    jsonlIdleCache.delete(jsonlPath);
    jsonlIdleCache.set(jsonlPath, cached);
    if (cached.idle) return fromCache(cached, true, cached.stale);
    if (cached.needsStaleRecheck) return fromCache(cached, Date.now() - stat.mtimeMs > cached.staleMs, true);
    return fromCache(cached, false, false);
  }

  const handle = await fs.open(jsonlPath, 'r');
  try {
    const elapsed = Date.now() - stat.mtimeMs;
    const readLines = async (size: number): Promise<string[]> => {
      const readSize = Math.min(stat.size, size);
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, stat.size - readSize);
      return buffer.toString('utf-8').split('\n').filter((l) => l.trim());
    };

    const lines = await readLines(JSONL_TAIL_SIZE);
    let scan = scanLines(lines, elapsed);
    let extracted = extractAssistantInfo(lines);

    // Nothing parsed from the tail: a final message longer than the window
    // leaves its line cut, so the marker would be lost with it.
    const nothingExtracted = !extracted.lastAssistantSnippet && !extracted.currentAction && !extracted.reset;
    if ((!scan.matched || nothingExtracted) && stat.size > JSONL_TAIL_SIZE) {
      const extLines = await readLines(JSONL_EXTENDED_TAIL_SIZE);
      if (!scan.matched) scan = scanLines(extLines, elapsed);
      if (nothingExtracted) extracted = extractAssistantInfo(extLines);
    }

    if (jsonlIdleCache.size >= MAX_JSONL_CACHE) {
      jsonlIdleCache.delete(jsonlIdleCache.keys().next().value!);
    }
    const entry: IJsonlIdleCache = {
      mtimeMs: stat.mtimeMs,
      idle: scan.idle,
      stale: scan.stale,
      needsStaleRecheck: scan.needsStaleRecheck,
      staleMs: scan.staleMs,
      lastAssistantSnippet: extracted.lastAssistantSnippet,
      lastAssistantTail: extracted.lastAssistantTail,
      lastAssistantUuid: extracted.lastAssistantUuid,
      lastTurnError: extracted.lastTurnError,
      currentAction: extracted.currentAction,
      reset: extracted.reset,
      lastEntryTs: scan.lastEntryTs,
      interrupted: scan.interrupted,
    };
    jsonlIdleCache.set(jsonlPath, entry);
    return fromCache(entry, scan.idle, scan.stale);
  } finally {
    await handle.close();
  }
};

export const readClaudeRuntimeSnapshot = async (
  jsonlPath: string,
  options: IRuntimeSnapshotOptions = {},
): Promise<IAgentRuntimeSnapshot> => {
  let snapshot: IAgentRuntimeSnapshot;
  try {
    snapshot = { ...await readTailSnapshot(jsonlPath, options), transcriptRead: true };
  } catch {
    return { ...emptySnapshot(), transcriptRead: false };
  }
  return options.withBackground ? withBackgroundWork(jsonlPath, snapshot, options) : snapshot;
};

export const __testing = {
  extractAssistantInfo,
  scanLines,
};
