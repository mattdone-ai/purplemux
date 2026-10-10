import { recordOrchestrationLaunch } from '@/lib/orchestration-activity';
import { withOrchestrationMappingRead } from '@/lib/orchestration-mapping-lock';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { watch, type FSWatcher } from 'fs';
import { existsSync, mkdirSync } from 'fs';
import { type ISessionWatcher } from '@/lib/providers/types';
import { readTailEntries, parseIncremental, parseJsonlContent } from './session-parser';
import { CodexParser, codexSessionIdFromJsonlPath, createCodexParser, parseCodexContent, readTailCodexEntries } from './session-parser-codex';
import { CODEX_PROVIDER_ID } from '@/lib/providers/codex';
import { findCodexSessionById } from '@/lib/providers/codex/session-detection';
import { GROK_PROVIDER_ID } from '@/lib/providers/grok';
import { findGrokSessionById } from '@/lib/providers/grok/session-store';
import { grokHomeFromJsonlPath } from '@/lib/providers/grok/paths';
import { workspaceIdForGrokHome } from '@/lib/grok-home';
import { GrokParser, createGrokParser, readTailGrokEntries } from './session-parser-grok';
import { isCodexJsonlPath, isGrokJsonlPath } from './path-validation';
import { open as fsOpen } from 'fs/promises';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { getSessionPanePid, checkTerminalProcess, sendKeys, getSessionCwd, getPaneTitle } from './tmux';
import { sessionHostOf } from './session-host';
import { cwdToProjectPath } from './session-list';
import { EMPTY_PENDING } from './buffer-lines';
import { buildSessionKey } from './session-key';
import { canLoadOlder } from './timeline-paging';
import { listSessionScopes, sessionScopeFor } from './session-scope';
import { readCodexSessionHead } from './codex-session-list';
import { workspaceIdFromSessionName } from './workspace-home';
import {
  updateTabAgentSessionId,
  updateTabAgentState,
  updateTabAgentSummary,
  updateTabLastUserMessage,
  parseSessionName,
} from './layout-store';
import { getStatusManager } from './status-manager';
import {
  prepareCodexManagedLaunch,
  submitCodexManagedLaunch,
  waitForCodexManagedLaunch,
} from './providers/codex/managed-launch';
import { getProviderByPanelType } from '@/lib/providers';
import type { IAgentProvider } from '@/lib/providers';
import { resolveAgentLaunchPolicyForSession } from '@/lib/agent-launch-policy';
import { extractSessionIdFromJsonlPath, readSessionStats } from './session-stats';
import { readCodexTimelineSessionStats } from './stats/jsonl-parser-codex';
import type { TTimelineServerMessage, IChunkReadResult, IInitMeta, ITimelineEntry, ISessionStats } from '@/types/timeline';
import path from 'path';
import { isAllowedJsonlPath } from './path-validation';
import { createLogger } from '@/lib/logger';

const log = createLogger('timeline');

const HEARTBEAT_INTERVAL = 30_000;
const HEARTBEAT_TIMEOUT = 90_000;
const DEBOUNCE_MS = 50;
const BACKPRESSURE_LIMIT = 1024 * 1024;
const MAX_WATCHERS = 32;
const MAX_CONNECTIONS = 32;
const MAX_WATCHER_RETRIES = 3;
const MAX_INIT_ENTRIES = 128;

const resolveAgentSummary = async (
  provider: IAgentProvider,
  sessionName: string,
  jsonlSummary: string | null | undefined,
): Promise<string | null> => {
  const paneTitle = await getPaneTitle(sessionName);
  return provider.parsePaneTitle(paneTitle) ?? jsonlSummary ?? null;
};

interface ITimelineConnection {
  ws: WebSocket;
  sessionName: string;
  panePid: number;
  provider: IAgentProvider;
  heartbeatTimer: ReturnType<typeof setInterval>;
  lastHeartbeat: number;
  currentJsonlPath: string | null;
  cleaned: boolean;
}

interface IFileWatcher {
  watcher: FSWatcher | null;
  jsonlPath: string;
  offset: number;
  pendingBuffer: Buffer;
  connections: Set<WebSocket>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  sessionName: string;
  provider: IAgentProvider;
  summaryResolved: boolean;
  processing: boolean;
  pendingChange: boolean;
  initOffsets: Map<WebSocket, number>;
  /**
   * Providers whose entry identity is not the Claude record `uuid` keep parse
   * state across reads: Codex correlates calls to results, grok counts update
   * ordinals and coalesces streamed chunks.
   */
  streamParser: CodexParser | GrokParser | null;
  isCodex: boolean;
  isGrok: boolean;
}

interface IJsonlWatcher {
  stop: () => void;
}

const gTimeline = globalThis as unknown as {
  __pmuxTimelineConnections?: Map<WebSocket, ITimelineConnection>;
  __pmuxTimelineFileWatchers?: Map<string, IFileWatcher>;
  __pmuxTimelineSessionWatchers?: Map<string, ISessionWatcher>;
  __pmuxTimelinePendingJsonlWatchers?: Map<string, IJsonlWatcher>;
};

if (!gTimeline.__pmuxTimelineConnections) gTimeline.__pmuxTimelineConnections = new Map();
if (!gTimeline.__pmuxTimelineFileWatchers) gTimeline.__pmuxTimelineFileWatchers = new Map();
if (!gTimeline.__pmuxTimelineSessionWatchers) gTimeline.__pmuxTimelineSessionWatchers = new Map();
if (!gTimeline.__pmuxTimelinePendingJsonlWatchers) gTimeline.__pmuxTimelinePendingJsonlWatchers = new Map();

const connections = gTimeline.__pmuxTimelineConnections;
const fileWatchers = gTimeline.__pmuxTimelineFileWatchers;
const sessionWatchers = gTimeline.__pmuxTimelineSessionWatchers;
const pendingJsonlWatchers = gTimeline.__pmuxTimelinePendingJsonlWatchers;

const canSend = (ws: WebSocket): boolean =>
  ws.readyState === WebSocket.OPEN && ws.bufferedAmount < BACKPRESSURE_LIMIT;

const sendJson = (ws: WebSocket, msg: TTimelineServerMessage) => {
  if (canSend(ws)) {
    ws.send(JSON.stringify(msg));
  }
};

const readTimelineSessionStats = async (
  jsonlPath: string,
  sessionId: string,
  isCodex: boolean,
): Promise<ISessionStats | null> => {
  if (isCodex) return readCodexTimelineSessionStats(jsonlPath);
  return sessionId ? readSessionStats(sessionId) : null;
};

export const broadcastSessionStats = (stats: ISessionStats) => {
  for (const fw of fileWatchers.values()) {
    if (extractSessionIdFromJsonlPath(fw.jsonlPath) !== stats.sessionId) continue;
    for (const ws of fw.connections) {
      sendJson(ws, { type: 'timeline:stats-update', sessionStats: stats });
    }
  }
};

const sendEmptyInit = (ws: WebSocket, sessionId = '', isClaudeStarting = false) => {
  sendJson(ws, {
    type: 'timeline:init',
    entries: [],
    sessionId,
    totalEntries: 0,
    startByteOffset: 0,
    hasMore: false,
    ...(isClaudeStarting && { isClaudeStarting: true }),
  });
};

const MAX_USER_MESSAGE_LENGTH = 200;

const findLastUserMessage = (entries: ITimelineEntry[]): string | null => {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'user-message' && entry.text.trim()) {
      const text = entry.text.trim();
      return text.length > MAX_USER_MESSAGE_LENGTH
        ? text.slice(0, MAX_USER_MESSAGE_LENGTH) + '…'
        : text;
    }
  }
  return null;
};

const subscribeAndUpdateSummary = async (
  ws: WebSocket,
  jsonlPath: string,
  sessionId: string | undefined,
  sessionName: string,
  provider: IAgentProvider,
) => {
  const jsonlSummary = await subscribeToFile(ws, jsonlPath, sessionId, sessionName, provider);
  const summary = await resolveAgentSummary(provider, sessionName, jsonlSummary);
  await updateTabAgentState(sessionName, provider, {
    sessionId: sessionId ?? provider.sessionIdFromJsonlPath(jsonlPath),
    jsonlPath,
    summary,
  }).catch(() => {});
};

const broadcastToWatcher = (watcherKey: string, msg: TTimelineServerMessage) => {
  const fw = fileWatchers.get(watcherKey);
  if (!fw) return;
  const str = JSON.stringify(msg);
  for (const ws of fw.connections) {
    if (canSend(ws)) {
      ws.send(str);
    }
  }
};

const readBoundedEntries = async (
  filePath: string, from: number, to: number,
): Promise<import('@/types/timeline').ITimelineEntry[]> => {
  const readSize = to - from;
  if (readSize <= 0) return [];
  const handle = await fsOpen(filePath, 'r');
  try {
    const buf = Buffer.alloc(readSize);
    await handle.read(buf, 0, readSize, from);
    const content = buf.toString('utf-8');
    return isCodexJsonlPath(filePath)
      ? parseCodexContent(content, from, codexSessionIdFromJsonlPath(filePath))
      : parseJsonlContent(content, from);
  } finally {
    await handle.close();
  }
};

/**
 * A new watcher's parser must END UP holding the state for the whole file, so
 * it reads the tail itself; a watcher that already exists is mid-stream and
 * must not be rewound, so a throwaway parse serves the joining client.
 */
const readInitEntries = async (
  fw: IFileWatcher,
  isNewWatcher: boolean,
  maxEntries: number,
): Promise<IChunkReadResult> => {
  const parser = fw.streamParser;
  if (!parser) return readTailEntries(fw.jsonlPath, maxEntries);
  if (isNewWatcher) return parser.parseTail(maxEntries);
  return fw.isCodex
    ? readTailCodexEntries(parser.path, maxEntries)
    : readTailGrokEntries(parser.path, maxEntries);
};

const processFileChange = async (fw: IFileWatcher) => {
  if (fw.processing) {
    fw.pendingChange = true;
    return;
  }
  fw.processing = true;
  try {
    const prevOffset = fw.offset;
    const { newEntries, newOffset, pendingBuffer } = fw.streamParser
      ? await fw.streamParser.parseIncremental()
      : await parseIncremental(fw.jsonlPath, fw.offset, fw.pendingBuffer);
    fw.pendingBuffer = pendingBuffer;
    if (fw.streamParser) fw.offset = newOffset;
    if (newEntries.length > 0) {
      fw.offset = newOffset;

      const msg: TTimelineServerMessage = { type: 'timeline:append', entries: newEntries };
      const str = JSON.stringify(msg);
      const partialReads: Promise<void>[] = [];
      for (const ws of fw.connections) {
        if (!canSend(ws)) continue;
        const initOffset = fw.initOffsets.get(ws);
        // A grok entry's identity is its update ordinal, so a client that joined
        // mid-stream cannot be served a byte window. It gets the whole batch and
        // upserts by (sessionKey, seq) — which is the contract, and which makes
        // a repeat of an entry it already holds a no-op.
        if (initOffset !== undefined && !fw.isGrok) {
          if (newOffset <= initOffset) {
            continue;
          }
          fw.initOffsets.delete(ws);
          if (prevOffset < initOffset) {
            partialReads.push(
              readBoundedEntries(fw.jsonlPath, initOffset, newOffset)
                .then((entries) => {
                  if (entries.length > 0 && canSend(ws)) {
                    const partialMsg: TTimelineServerMessage = { type: 'timeline:append', entries };
                    ws.send(JSON.stringify(partialMsg));
                  }
                })
                .catch(() => {}),
            );
            continue;
          }
        }
        ws.send(str);
      }
      if (partialReads.length > 0) {
        await Promise.all(partialReads);
      }

      const lastMsg = findLastUserMessage(newEntries);
      if (lastMsg) {
        await updateTabLastUserMessage(fw.sessionName, lastMsg).catch(() => {});
        getStatusManager().notifyLastUserMessage(fw.sessionName, lastMsg);
      }

      if (!fw.summaryResolved && newEntries.some((e) => e.type === 'assistant-message')) {
        fw.summaryResolved = true;
        const summary = await resolveAgentSummary(fw.provider, fw.sessionName, undefined);
        if (summary) {
          await updateTabAgentSummary(fw.sessionName, fw.provider, summary).catch(() => {});
        }
      }
    }

    if (fw.isCodex && newOffset !== prevOffset) {
      const sessionStats = await readCodexTimelineSessionStats(fw.jsonlPath).catch(() => null);
      if (sessionStats) {
        const msg: TTimelineServerMessage = { type: 'timeline:stats-update', sessionStats };
        const str = JSON.stringify(msg);
        for (const ws of fw.connections) {
          if (canSend(ws)) ws.send(str);
        }
      }
    }
  } finally {
    fw.processing = false;
    if (fw.pendingChange) {
      fw.pendingChange = false;
      processFileChange(fw);
    }
  }
};

const startFileWatch = (fw: IFileWatcher) => {
  try {
    fw.watcher = watch(fw.jsonlPath, () => {
      if (fw.debounceTimer) clearTimeout(fw.debounceTimer);
      fw.debounceTimer = setTimeout(() => processFileChange(fw), DEBOUNCE_MS);
    });

    fw.watcher.on('error', () => {
      if (fw.retryCount < MAX_WATCHER_RETRIES) {
        fw.retryCount++;
        if (fw.watcher) fw.watcher.close();
        fw.watcher = null;
        setTimeout(() => startFileWatch(fw), 1000);
      } else {
        broadcastToWatcher(fw.jsonlPath, {
          type: 'timeline:error',
          code: 'watcher-failed',
          message: 'File watch failed (retries exceeded)',
        });
      }
    });
  } catch {
    // File might not exist yet
  }
};

const removeFileWatcher = (jsonlPath: string) => {
  const fw = fileWatchers.get(jsonlPath);
  if (!fw) return;
  if (fw.watcher) fw.watcher.close();
  if (fw.debounceTimer) clearTimeout(fw.debounceTimer);
  fw.streamParser?.dispose();
  fileWatchers.delete(jsonlPath);
};

const readFirstTimestamp = async (filePath: string): Promise<string | null> => {
  try {
    const stream = createReadStream(filePath, { encoding: 'utf-8', start: 0, end: 4096 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.timestamp) {
          rl.close();
          stream.destroy();
          return new Date(obj.timestamp).toISOString();
        }
      } catch { /* skip malformed line */ }
      rl.close();
      stream.destroy();
      break;
    }
  } catch { /* file read error */ }
  return null;
};

const computeInitMeta = (entries: ITimelineEntry[], fileSize: number, createdAtOverride?: string | null, customTitle?: string): IInitMeta => {
  let createdAt: string | null = null;
  let updatedAt: string | null = null;
  let lastTimestamp = 0;
  let userCount = 0;
  let assistantCount = 0;

  for (const entry of entries) {
    if (!createdAt && entry.timestamp) {
      createdAt = new Date(entry.timestamp).toISOString();
    }
    if (entry.timestamp) {
      lastTimestamp = Math.max(lastTimestamp, entry.timestamp);
    }
    updatedAt = new Date(entry.timestamp).toISOString();

    if (entry.type === 'user-message') userCount++;
    else if (entry.type === 'assistant-message') assistantCount++;
  }

  return {
    createdAt: createdAtOverride ?? createdAt,
    updatedAt,
    lastTimestamp,
    fileSize,
    userCount,
    assistantCount,
    customTitle,
  };
};

const subscribeToFile = async (
  ws: WebSocket,
  jsonlPath: string,
  sessionId: string | undefined,
  sessionName: string,
  provider: IAgentProvider,
): Promise<string | undefined> => {
  if (!existsSync(jsonlPath)) {
    sendJson(ws, { type: 'timeline:init', entries: [], sessionId: sessionId ?? '', totalEntries: 0, startByteOffset: 0, hasMore: false, jsonlPath });
    return undefined;
  }

  let fw = fileWatchers.get(jsonlPath);
  const isNewWatcher = !fw;

  if (!fw) {
    if (fileWatchers.size >= MAX_WATCHERS) {
      sendJson(ws, { type: 'timeline:error', code: 'max-watchers', message: 'Too many active watchers' });
      return;
    }
    const isCodex = provider.id === CODEX_PROVIDER_ID || isCodexJsonlPath(jsonlPath);
    const isGrok = provider.id === GROK_PROVIDER_ID || isGrokJsonlPath(jsonlPath);
    fw = {
      watcher: null,
      jsonlPath,
      offset: 0,
      pendingBuffer: EMPTY_PENDING,
      connections: new Set(),
      debounceTimer: null,
      retryCount: 0,
      sessionName,
      provider,
      summaryResolved: false,
      processing: false,
      pendingChange: false,
      initOffsets: new Map(),
      streamParser: isCodex ? createCodexParser(jsonlPath) : isGrok ? createGrokParser(jsonlPath) : null,
      isCodex,
      isGrok,
    };
    fileWatchers.set(jsonlPath, fw);
  }

  fw.connections.add(ws);

  const result = await readInitEntries(fw, isNewWatcher, MAX_INIT_ENTRIES);

  if (result.errorCount > 0) {
    sendJson(ws, {
      type: 'timeline:error',
      code: 'parse-error',
      message: `JSONL parsing: ${result.errorCount} errors (lines skipped)`,
    });
  }

  if (isNewWatcher) {
    fw.offset = result.fileSize;
    startFileWatch(fw);
  }

  const firstTimestamp = result.hasMore ? await readFirstTimestamp(jsonlPath) : null;
  const meta = computeInitMeta(result.entries, result.fileSize, firstTimestamp, result.customTitle);

  const resolvedSessionId = sessionId ?? provider.sessionIdFromJsonlPath(jsonlPath) ?? '';
  // Codex keys its rollouts by cwd, so its scope comes from the transcript's own
  // `session_meta`, not from the tmux session name — the same input search and
  // sessions-v2 derive from, through the same function.
  const sessionKey = resolvedSessionId
    ? buildSessionKey({
      provider: provider.id,
      workspaceId: sessionScopeFor({
        provider: provider.id,
        scopes: fw.isCodex ? await listSessionScopes() : [],
        // grok isolates by GROK_HOME, and the transcript sits inside it, so the
        // owning workspace is read off the path rather than from the tmux name.
        workspaceId: provider.id === GROK_PROVIDER_ID
          ? workspaceIdForGrokHome(grokHomeFromJsonlPath(jsonlPath))
          : workspaceIdFromSessionName(sessionName),
        cwd: fw.isCodex ? (await readCodexSessionHead(jsonlPath)).cwd : null,
      }).workspaceId,
      sessionId: resolvedSessionId,
    })
    : undefined;
  const sessionStats = await readTimelineSessionStats(jsonlPath, resolvedSessionId, fw.isCodex);

  sendJson(ws, {
    type: 'timeline:init',
    entries: result.entries,
    sessionId: resolvedSessionId,
    sessionKey,
    totalEntries: result.entries.length,
    startByteOffset: result.startByteOffset,
    // F6: never advertise older entries the client cannot actually fetch. The
    // cursor is a byte offset for Claude and Codex and an update ordinal for
    // grok, and either is 0 when the init already starts at the first entry.
    hasMore: result.hasMore && canLoadOlder(jsonlPath, result.startByteOffset),
    jsonlPath,
    summary: result.summary,
    meta,
    sessionStats,
  });

  if (!isNewWatcher) {
    fw.initOffsets.set(ws, result.fileSize);
  }

  if (sessionName) {
    const lastMsg = findLastUserMessage(result.entries);
    if (lastMsg) {
      await updateTabLastUserMessage(sessionName, lastMsg).catch(() => {});
      getStatusManager().notifyLastUserMessage(sessionName, lastMsg);
    }
  }

  return result.summary;
};

const unsubscribeFromFile = (ws: WebSocket, jsonlPath: string) => {
  const fw = fileWatchers.get(jsonlPath);
  if (!fw) return;
  fw.connections.delete(ws);
  fw.initOffsets.delete(ws);
  if (fw.connections.size === 0) {
    removeFileWatcher(jsonlPath);
  }
};

const getSessionConnections = (sessionName: string): ITimelineConnection[] => {
  const result: ITimelineConnection[] = [];
  for (const [, conn] of connections) {
    if (conn.sessionName === sessionName) {
      result.push(conn);
    }
  }
  return result;
};

const cancelJsonlWatcher = (sessionName: string) => {
  const w = pendingJsonlWatchers.get(sessionName);
  if (w) {
    w.stop();
    pendingJsonlWatchers.delete(sessionName);
  }
};

const watchForJsonlFile = (
  sessionName: string,
  sessionId: string,
  cwd: string,
  provider: IAgentProvider,
) => {
  cancelJsonlWatcher(sessionName);

  const projectDir = cwdToProjectPath(cwd, sessionName);
  const jsonlFilename = `${sessionId}.jsonl`;
  const expectedJsonlPath = path.join(projectDir, jsonlFilename);

  let dirWatcher: FSWatcher | null = null;
  let parentWatcher: FSWatcher | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (dirWatcher) { dirWatcher.close(); dirWatcher = null; }
    if (parentWatcher) { parentWatcher.close(); parentWatcher = null; }
  };

  const onJsonlFound = async () => {
    stop();
    pendingJsonlWatchers.delete(sessionName);
    await updateTabAgentSessionId(sessionName, provider, sessionId).catch(() => {});

    const wsConns = getSessionConnections(sessionName);
    for (const c of wsConns) {
      if (expectedJsonlPath !== c.currentJsonlPath) {
        if (c.currentJsonlPath) {
          unsubscribeFromFile(c.ws, c.currentJsonlPath);
        }
        c.currentJsonlPath = expectedJsonlPath;
        await subscribeAndUpdateSummary(c.ws, expectedJsonlPath, sessionId, sessionName, provider);
      }
    }
  };

  const watchProjectDir = () => {
    if (stopped) return;
    try {
      dirWatcher = watch(projectDir, (_event, filename) => {
        if (stopped) return;
        if (filename === jsonlFilename && existsSync(expectedJsonlPath)) {
          onJsonlFound();
        }
      });
      dirWatcher.on('error', () => {});
    } catch {
    }
  };

  if (existsSync(expectedJsonlPath)) {
    onJsonlFound();
    return;
  }

  if (existsSync(projectDir)) {
    watchProjectDir();
    // Re-check after watch setup: file may have been created between existsSync and watch()
    if (!stopped && existsSync(expectedJsonlPath)) {
      onJsonlFound();
    }
  } else {
    const projectsDir = path.dirname(projectDir);
    const projectDirName = path.basename(projectDir);
    try {
      mkdirSync(projectsDir, { recursive: true });
      parentWatcher = watch(projectsDir, (_event, filename) => {
        if (stopped) return;
        if (filename === projectDirName && existsSync(projectDir)) {
          if (parentWatcher) { parentWatcher.close(); parentWatcher = null; }
          if (existsSync(expectedJsonlPath)) {
            onJsonlFound();
          } else {
            watchProjectDir();
            if (!stopped && existsSync(expectedJsonlPath)) {
              onJsonlFound();
            }
          }
        }
      });
      parentWatcher.on('error', () => {});
    } catch {
    }
  }

  pendingJsonlWatchers.set(sessionName, { stop });
};

const cleanup = (conn: ITimelineConnection) => {
  if (conn.cleaned) return;
  conn.cleaned = true;

  clearInterval(conn.heartbeatTimer);
  connections.delete(conn.ws);

  if (conn.currentJsonlPath) {
    unsubscribeFromFile(conn.ws, conn.currentJsonlPath);
  }

  const wsKey = conn.sessionName;
  const hasOtherConn = getSessionConnections(conn.sessionName).length > 0;
  if (!hasOtherConn) {
    cancelJsonlWatcher(wsKey);
    const sw = sessionWatchers.get(wsKey);
    if (sw) {
      sw.stop();
      sessionWatchers.delete(wsKey);
    }
  }
};

const resolveJsonlPath = async (
  tmuxSession: string,
  sessionId: string,
  provider: IAgentProvider,
): Promise<string | null> => {
  if (provider.id === CODEX_PROVIDER_ID) {
    return (await findCodexSessionById(sessionId))?.jsonlPath ?? null;
  }
  if (provider.id === GROK_PROVIDER_ID) {
    return (await findGrokSessionById(sessionId))?.jsonlPath ?? null;
  }

  const cwd = await getSessionCwd(tmuxSession);
  if (!cwd) return null;
  const projectDir = cwdToProjectPath(cwd, tmuxSession);
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  return existsSync(jsonlPath) ? jsonlPath : null;
};

export const handleResumeMessage = async (
  ws: WebSocket,
  conn: ITimelineConnection,
  payload: { sessionId: string; tmuxSession: string },
) => {
  const { sessionId } = payload;
  const tmuxSession = conn.sessionName;

  try {
    // A resume types this host's launch command; a remote tab's agent is launched by `tab create` only (ADR-0022).
    if (await sessionHostOf(tmuxSession)) {
      sendJson(ws, { type: 'timeline:resume-error', message: 'This tab runs on a remote host; resume is not available there. Close it and create a new remote tab.' });
      return;
    }
    const { isSafe, processName } = await checkTerminalProcess(tmuxSession);

    if (!isSafe) {
      sendJson(ws, {
        type: 'timeline:resume-blocked',
        reason: 'process-running',
        processName,
      });
      return;
    }

    const parsed = parseSessionName(tmuxSession);
    const launchPolicy = await resolveAgentLaunchPolicyForSession(tmuxSession);
    if (conn.provider.id === CODEX_PROVIDER_ID) {
      if (!parsed || !launchPolicy) throw new Error('Managed Codex tab not found');
      const prepared = await prepareCodexManagedLaunch(
        launchPolicy.workspaceId,
        launchPolicy.tabId,
        sessionId,
      );
      if (!prepared.ok) throw new Error(`Codex resume prepare failed: ${prepared.reason}`);
      const submitted = await submitCodexManagedLaunch(
        launchPolicy.workspaceId,
        launchPolicy.tabId,
        prepared.launch.generation,
      );
      if (!submitted.ok) throw new Error(`Codex resume submit failed: ${submitted.reason}`);
      const activated = await waitForCodexManagedLaunch(
        launchPolicy.workspaceId,
        launchPolicy.tabId,
        submitted.generation,
      );
      if (!activated.ok) throw new Error(`Codex resume confirmation failed: ${activated.reason}`);
      if (conn.currentJsonlPath) {
        unsubscribeFromFile(ws, conn.currentJsonlPath);
        conn.currentJsonlPath = null;
      }
      sendJson(ws, {
        type: 'timeline:resume-started',
        sessionId,
        jsonlPath: null,
      });
      return;
    }
    const submitResume = async () => {
      const resumeCmd = await conn.provider.buildResumeCommand(sessionId, {
        workspaceId: launchPolicy?.workspaceId ?? parsed?.wsId,
        ...launchPolicy?.options,
      });
      if (conn.currentJsonlPath) {
        unsubscribeFromFile(ws, conn.currentJsonlPath);
        conn.currentJsonlPath = null;
      }
      if (parsed) {
        await recordOrchestrationLaunch(parsed.wsId, parsed.tabId, tmuxSession);
        getStatusManager().markAgentLaunch(parsed.tabId, { resumeSessionId: sessionId });
      }
      await sendKeys(tmuxSession, resumeCmd);
      await updateTabAgentState(conn.sessionName, conn.provider, {
        sessionId,
        jsonlPath: null,
        summary: null,
        lastUserMessage: null,
      });

    };
    if (parsed) await withOrchestrationMappingRead(parsed.wsId, submitResume);
    else await submitResume();

    const jsonlPath = await resolveJsonlPath(tmuxSession, sessionId, conn.provider);

    sendJson(ws, {
      type: 'timeline:resume-started',
      sessionId,
      jsonlPath,
    });

    if (jsonlPath) {
      if (conn.currentJsonlPath) {
        unsubscribeFromFile(ws, conn.currentJsonlPath);
      }
      conn.currentJsonlPath = jsonlPath;
      await subscribeAndUpdateSummary(ws, jsonlPath, sessionId, conn.sessionName, conn.provider);
    } else {
      sendEmptyInit(ws, sessionId);
      const cwd = await getSessionCwd(tmuxSession);
      if (cwd) {
        watchForJsonlFile(conn.sessionName, sessionId, cwd, conn.provider);
      }
    }
  } catch (err) {
    sendJson(ws, {
      type: 'timeline:resume-error',
      message: err instanceof Error ? err.message : 'Error during resume',
    });
  }
};

export const handleTimelineConnection = async (ws: WebSocket, request: IncomingMessage) => {
  if (connections.size >= MAX_CONNECTIONS) {
    ws.close(1013, 'Too many connections');
    return;
  }

  const url = new URL(request.url || '', 'http://localhost');
  const sessionName = url.searchParams.get('session') ?? '';

  if (!sessionName) {
    ws.close(1008, 'Missing session parameter');
    return;
  }

  const panelType = url.searchParams.get('panelType') ?? 'claude-code';
  const provider = getProviderByPanelType(panelType);
  if (!provider) {
    ws.close(1008, 'Unknown panel type');
    return;
  }

  const panePid = await getSessionPanePid(sessionName);
  if (!panePid) {
    sendEmptyInit(ws);
    ws.close(1000, 'Cannot resolve pane pid');
    return;
  }

  let lastHeartbeat = Date.now();

  const heartbeatTimer = setInterval(() => {
    if (Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT) {
      ws.close(1001, 'Heartbeat timeout');
      return;
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL);

  const conn: ITimelineConnection = {
    ws,
    sessionName,
    panePid,
    provider,
    heartbeatTimer,
    lastHeartbeat,
    currentJsonlPath: null,
    cleaned: false,
  };

  connections.set(ws, conn);

  ws.on('pong', () => {
    lastHeartbeat = Date.now();
    conn.lastHeartbeat = lastHeartbeat;
  });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'timeline:subscribe' && msg.jsonlPath) {
        if (!isAllowedJsonlPath(msg.jsonlPath)) {
          sendJson(ws, { type: 'timeline:error', code: 'forbidden-path', message: 'Not allowed path' });
          return;
        }
        if (conn.currentJsonlPath) {
          unsubscribeFromFile(ws, conn.currentJsonlPath);
        }
        conn.currentJsonlPath = msg.jsonlPath;
        await subscribeToFile(ws, msg.jsonlPath, undefined, conn.sessionName, conn.provider);
      } else if (msg.type === 'timeline:unsubscribe') {
        if (conn.currentJsonlPath) {
          unsubscribeFromFile(ws, conn.currentJsonlPath);
          conn.currentJsonlPath = null;
        }
      } else if (msg.type === 'timeline:resume' && msg.sessionId && msg.tmuxSession) {
        if (!conn.provider.isValidSessionId(msg.sessionId)) {
          sendJson(ws, { type: 'timeline:resume-error', message: 'Invalid session ID format' });
        } else {
          await handleResumeMessage(ws, conn, {
            sessionId: msg.sessionId,
            tmuxSession: msg.tmuxSession,
          });
        }
      }
    } catch (err) {
      log.error(`message handler error: ${err instanceof Error ? err.message : err}`);
    }
  });

  ws.on('close', () => cleanup(conn));
  ws.on('error', (err) => {
    log.error(`websocket error: ${err.message}`);
    cleanup(conn);
  });

  const hintSessionId = url.searchParams.get('agentSessionId') ?? url.searchParams.get('claudeSessionId');
  const sessionInfo = await provider.detectActiveSession(panePid);

  if (conn.cleaned) return;

  if (sessionInfo.status === 'not-installed') {
    sendJson(ws, { type: 'timeline:error', code: 'not-installed', message: `${provider.displayName} is not installed` });
    sendEmptyInit(ws);
    return;
  }

  // Check if agent process is running in pane before PID file is created
  const isAgentStarting = sessionInfo.status === 'not-running'
    && !hintSessionId
    && await provider.isAgentRunning(panePid);

  if (sessionInfo.status === 'running') {
    sendJson(ws, {
      type: 'timeline:session-changed',
      newSessionId: sessionInfo.sessionId ?? '',
      reason: 'session-waiting',
    });
  } else if (isAgentStarting) {
    sendJson(ws, {
      type: 'timeline:session-changed',
      newSessionId: '',
      reason: 'session-waiting',
    });
  }

  const effectiveSessionId = sessionInfo.sessionId ?? hintSessionId;

  if (sessionInfo.jsonlPath) {
    conn.currentJsonlPath = sessionInfo.jsonlPath;
    if (sessionInfo.sessionId) {
      await updateTabAgentSessionId(conn.sessionName, provider, sessionInfo.sessionId).catch(() => {});
    }
    await subscribeAndUpdateSummary(ws, sessionInfo.jsonlPath, sessionInfo.sessionId ?? undefined, conn.sessionName, provider);
  } else if (effectiveSessionId) {
    if (sessionInfo.sessionId) {
      await updateTabAgentSessionId(conn.sessionName, provider, sessionInfo.sessionId).catch(() => {});
    }
    const jsonlPath = await resolveJsonlPath(sessionName, effectiveSessionId, provider);
    if (jsonlPath) {
      conn.currentJsonlPath = jsonlPath;
      await subscribeAndUpdateSummary(ws, jsonlPath, effectiveSessionId, conn.sessionName, provider);
    } else {
      sendEmptyInit(ws, effectiveSessionId);
    }
  } else if (!isAgentStarting) {
    sendEmptyInit(ws, '', sessionInfo.status === 'running');
  }

  if (conn.cleaned) return;

  // Watch for new sessions — shared per session key
  const wsKey = sessionName;
  if (!sessionWatchers.has(wsKey)) {
    const sw = provider.watchSessions(panePid, async (newInfo) => {
      const wsConns = getSessionConnections(sessionName);

      for (const c of wsConns) {
        if (newInfo.jsonlPath && newInfo.jsonlPath !== c.currentJsonlPath) {
          cancelJsonlWatcher(sessionName);
          if (c.currentJsonlPath) {
            unsubscribeFromFile(c.ws, c.currentJsonlPath);
          }
          c.currentJsonlPath = newInfo.jsonlPath;

          if (newInfo.sessionId) {
            await updateTabAgentSessionId(sessionName, provider, newInfo.sessionId).catch(() => {});
          }

          sendJson(c.ws, {
            type: 'timeline:session-changed',
            newSessionId: newInfo.sessionId ?? '',
            reason: 'new-session-started',
          });

          await subscribeAndUpdateSummary(c.ws, newInfo.jsonlPath, newInfo.sessionId ?? undefined, sessionName, provider);
        } else if (!newInfo.jsonlPath && newInfo.status === 'not-running') {
          cancelJsonlWatcher(sessionName);
          if (c.currentJsonlPath) {
            unsubscribeFromFile(c.ws, c.currentJsonlPath);
            c.currentJsonlPath = null;
          }
          await updateTabAgentSessionId(sessionName, provider, null).catch(() => {});
          await updateTabAgentSummary(sessionName, provider, null).catch(() => {});
          sendJson(c.ws, {
            type: 'timeline:session-changed',
            newSessionId: '',
            reason: 'session-ended',
          });
        }
      }

      if (newInfo.status === 'running' && !newInfo.jsonlPath) {
        if (newInfo.sessionId) {
          await updateTabAgentSessionId(sessionName, provider, newInfo.sessionId).catch(() => {});
        }
        for (const c of wsConns) {
          if (c.currentJsonlPath) {
            const currentFile = path.basename(c.currentJsonlPath, '.jsonl');
            if (newInfo.sessionId && currentFile !== newInfo.sessionId) {
              unsubscribeFromFile(c.ws, c.currentJsonlPath);
              c.currentJsonlPath = null;
            } else {
              continue;
            }
          }
          if (pendingJsonlWatchers.has(sessionName)) continue;
          sendJson(c.ws, {
            type: 'timeline:session-changed',
            newSessionId: newInfo.sessionId ?? '',
            reason: 'session-waiting',
          });
        }
        if (newInfo.sessionId && newInfo.cwd) {
          const hasActiveSubscription = wsConns.some((c) => c.currentJsonlPath !== null);
          if (!hasActiveSubscription && wsConns.length > 0) {
            cancelJsonlWatcher(sessionName);
            watchForJsonlFile(sessionName, newInfo.sessionId, newInfo.cwd, provider);
          }
        }
      }
    }, { skipInitial: true, tmuxSession: sessionName });
    sessionWatchers.set(wsKey, sw);
  }

  // grok resolves its transcript from the session store rather than from the
  // cwd-encoded project dir this watcher expects, so it never enters here.
  if (
    provider.id !== GROK_PROVIDER_ID
    && sessionInfo.status === 'running'
    && !sessionInfo.jsonlPath
    && sessionInfo.sessionId
    && sessionInfo.cwd
  ) {
    watchForJsonlFile(sessionName, sessionInfo.sessionId, sessionInfo.cwd, provider);
  }

  // Race condition mitigation for isAgentStarting:
  // If PID file is created between detectActiveSession and isAgentRunning,
  // initial detection misses it and watchSessions won't fire for an existing file.
  // Re-check after watcher setup to cover this gap.
  if (isAgentStarting) {
    const recheckInfo = await provider.detectActiveSession(panePid);
    if (conn.cleaned) return;

    if (recheckInfo.status === 'running' && recheckInfo.sessionId && !conn.currentJsonlPath) {
      await updateTabAgentSessionId(sessionName, provider, recheckInfo.sessionId).catch(() => {});

      if (recheckInfo.jsonlPath) {
        conn.currentJsonlPath = recheckInfo.jsonlPath;
        sendJson(ws, {
          type: 'timeline:session-changed',
          newSessionId: recheckInfo.sessionId,
          reason: 'new-session-started',
        });
        await subscribeAndUpdateSummary(ws, recheckInfo.jsonlPath, recheckInfo.sessionId, sessionName, provider);
      } else if (recheckInfo.cwd) {
        sendJson(ws, {
          type: 'timeline:session-changed',
          newSessionId: recheckInfo.sessionId,
          reason: 'session-waiting',
        });
        sendEmptyInit(ws, recheckInfo.sessionId, true);
        watchForJsonlFile(sessionName, recheckInfo.sessionId, recheckInfo.cwd, provider);
      }
    } else {
      sendEmptyInit(ws, '', true);
    }
  }
};

export const gracefulTimelineShutdown = () => {
  for (const [, conn] of connections) {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.close(1001, 'Server shutting down');
    }
    cleanup(conn);
  }
  for (const [, sw] of sessionWatchers) {
    sw.stop();
  }
  sessionWatchers.clear();
  for (const [name] of pendingJsonlWatchers) {
    cancelJsonlWatcher(name);
  }
  for (const [jsonlPath] of fileWatchers) {
    removeFileWatcher(jsonlPath);
  }
};
