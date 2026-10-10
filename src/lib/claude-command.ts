import { getDangerouslySkipPermissions } from '@/lib/config-store';
import { HOOK_SETTINGS_PATH } from '@/lib/hook-settings';
import { getClaudePromptPath } from '@/lib/claude-prompt';
import { isValidClaudeEffort, isValidModelName } from '@/lib/claude-command-shared';

export { CLAUDE_EFFORT_LEVELS, isValidClaudeEffort, isValidModelName } from '@/lib/claude-command-shared';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidSessionId = (id: unknown): id is string =>
  typeof id === 'string' && UUID_RE.test(id);

export const buildClaudeFlags = async (workspaceId?: string, opts?: { model?: string; effort?: string }): Promise<string> => {
  const skipPerms = await getDangerouslySkipPermissions();
  const parts = [`--settings ${HOOK_SETTINGS_PATH}`];
  if (workspaceId) {
    parts.push(`--append-system-prompt-file ${getClaudePromptPath(workspaceId)}`);
  }
  if (opts?.model && isValidModelName(opts.model)) parts.push(`--model ${opts.model}`);
  if (opts?.effort && isValidClaudeEffort(opts.effort)) parts.push(`--effort ${opts.effort}`);
  if (skipPerms) parts.push('--dangerously-skip-permissions');
  return parts.join(' ');
};

/** The Claude launch of a remote tab (ADR-0022): the kit's hooks, prompt and CLI on the host. */
export const buildRemoteClaudeLaunch = async (workspaceId: string, opts?: { model?: string; effort?: string }): Promise<string> => {
  const { buildRemoteClaudeCommand } = await import('@/lib/remote-kit');
  return buildRemoteClaudeCommand({
    workspaceId,
    ...(opts?.model && isValidModelName(opts.model) ? { model: opts.model } : {}),
    ...(opts?.effort && isValidClaudeEffort(opts.effort) ? { effort: opts.effort } : {}),
    skipPermissions: await getDangerouslySkipPermissions(),
  });
};

export const buildResumeCommand = async (
  sessionId: string,
  workspaceId?: string,
  opts?: { model?: string; effort?: string },
): Promise<string> => {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
  const flags = await buildClaudeFlags(workspaceId, opts);
  return `claude --resume ${sessionId} ${flags}`;
};
