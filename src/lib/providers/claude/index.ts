import path from 'path';
import {
  detectActiveSession as detectClaudeSession,
  isClaudeRunning,
  watchSessionsDir,
} from '@/lib/providers/claude/session-detection';
import {
  buildClaudeFlags,
  buildResumeCommand as buildClaudeResumeCommand,
  claudeCommand,
  isValidSessionId as isValidClaudeSessionId,
} from '@/lib/claude-command';
import { writeClaudePromptFile } from '@/lib/claude-prompt';
import { runClaudePreflight } from '@/lib/providers/claude/preflight';
import { readClaudeRuntimeSnapshot } from '@/lib/providers/claude/runtime-snapshot';
import { readClaudeSessionHistoryStats } from '@/lib/providers/claude/session-history-stats';
import type { IAgentProvider } from '@/lib/providers/types';
import type { ITab, IAgentState } from '@/types/terminal';

export const CLAUDE_PROVIDER_ID = 'claude';

type TAgentField = 'sessionId' | 'jsonlPath' | 'summary';

const LEGACY_KEY: Record<TAgentField, 'claudeSessionId' | 'claudeJsonlPath' | 'claudeSummary'> = {
  sessionId: 'claudeSessionId',
  jsonlPath: 'claudeJsonlPath',
  summary: 'claudeSummary',
};

const ensureAgentState = (tab: ITab): IAgentState => {
  if (tab.agentState?.providerId === CLAUDE_PROVIDER_ID) return tab.agentState;
  const seeded: IAgentState = {
    providerId: CLAUDE_PROVIDER_ID,
    sessionId: tab.claudeSessionId ?? null,
    jsonlPath: tab.claudeJsonlPath ?? null,
    summary: tab.claudeSummary ?? null,
  };
  tab.agentState = seeded;
  return seeded;
};

const readField = (tab: ITab, field: TAgentField): string | null => {
  if (tab.agentState?.providerId === CLAUDE_PROVIDER_ID) {
    const fromAgent = tab.agentState[field];
    if (fromAgent !== null) return fromAgent;
  }
  return tab[LEGACY_KEY[field]] ?? null;
};

const writeField = (tab: ITab, field: TAgentField, value: string | null | undefined) => {
  const v = value ?? null;
  ensureAgentState(tab)[field] = v;
  tab[LEGACY_KEY[field]] = v;
};

const CLAUDE_TITLE_RE = /^[✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠐⠈]\s+/;

const parsePaneTitle = (paneTitle: string | null): string | null => {
  if (!paneTitle) return null;
  if (!CLAUDE_TITLE_RE.test(paneTitle)) return null;
  const cleaned = paneTitle.replace(CLAUDE_TITLE_RE, '').trim();
  return cleaned || null;
};

const sessionIdFromJsonlPath = (jsonlPath: string | null | undefined): string | null => {
  if (!jsonlPath) return null;
  return path.basename(jsonlPath, '.jsonl');
};

export const claudeProvider: IAgentProvider = {
  id: CLAUDE_PROVIDER_ID,
  displayName: 'Claude Code',
  panelType: 'claude-code',

  matchesProcess: (commandName, args) => {
    if (commandName === 'claude') return true;
    if (commandName === 'node' && args?.some((a) => a.endsWith('claude.js') || a.endsWith('claude'))) return true;
    return false;
  },
  isValidSessionId: isValidClaudeSessionId,

  detectActiveSession: (panePid, childPids) => detectClaudeSession(panePid, childPids),
  isAgentRunning: (panePid, childPids) => isClaudeRunning(panePid, childPids),
  watchSessions: (panePid, onChange, options) => watchSessionsDir(panePid, onChange, options),

  buildResumeCommand: (sessionId, { workspaceId, model, effort, role, previewOrigin, pgService }) =>
    buildClaudeResumeCommand(sessionId, workspaceId, { model, effort, role, previewOrigin, pgService }),
  buildLaunchCommand: async ({ workspaceId, model, effort, role, previewOrigin, pgService }) => {
    const opts = { model, effort, role, previewOrigin, pgService };
    return claudeCommand(await buildClaudeFlags(workspaceId, opts), opts);
  },

  readSessionId: (tab) => readField(tab, 'sessionId'),
  writeSessionId: (tab, sessionId) => writeField(tab, 'sessionId', sessionId),
  readJsonlPath: (tab) => readField(tab, 'jsonlPath'),
  writeJsonlPath: (tab, jsonlPath) => writeField(tab, 'jsonlPath', jsonlPath),
  readSummary: (tab) => readField(tab, 'summary'),
  writeSummary: (tab, summary) => writeField(tab, 'summary', summary),

  parsePaneTitle,
  sessionIdFromJsonlPath,
  readRuntimeSnapshot: readClaudeRuntimeSnapshot,
  readSessionHistoryStats: readClaudeSessionHistoryStats,
  preflight: runClaudePreflight,
  writeWorkspacePrompt: writeClaudePromptFile,
};
