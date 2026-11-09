import path from 'path';
import { getDangerouslySkipPermissions } from '@/lib/config-store';
import { HOOK_SETTINGS_PATH } from '@/lib/hook-settings';
import { getClaudePromptPath, writeClaudePromptFile } from '@/lib/claude-prompt';
import { createLogger } from '@/lib/logger';
import { isValidClaudeEffort, isValidModelName } from '@/lib/claude-command-shared';
import { evaluatorClaudeFlags, evaluatorEnvPrefix } from '@/lib/tab-role';
import type { TTabRole } from '@/types/terminal';

export { CLAUDE_EFFORT_LEVELS, isValidClaudeEffort, isValidModelName } from '@/lib/claude-command-shared';

const log = createLogger('claude-launch');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidSessionId = (id: unknown): id is string =>
  typeof id === 'string' && UUID_RE.test(id);

interface IClaudeFlagOptions {
  model?: string;
  effort?: string;
  role?: TTabRole;
  previewOrigin?: string;
  pgService?: string;
}

/** The one start of every local claude command: an evaluator's environment (ADR-0040), then `claude`. */
export const claudeCommand = (rest: string, opts?: IClaudeFlagOptions): string => `${evaluatorEnvPrefix(opts)}claude ${rest}`;

export const buildClaudeFlags = async (workspaceId?: string, opts?: IClaudeFlagOptions): Promise<string> => {
  // An evaluator's allow-list restricts nothing under bypass permissions (ADR-0040).
  const skipPerms = opts?.role !== 'evaluator' && await getDangerouslySkipPermissions();
  const parts = [`--settings ${HOOK_SETTINGS_PATH}`];
  if (workspaceId) {
    // The launch loads the file as it is now: the active standing orders go in first (ADR-0041). A write that
    // fails never blocks a launch: it loads the last file written (review r1, R6).
    try {
      await writeClaudePromptFile({ id: workspaceId });
    } catch (err) {
      log.error(`claude prompt for ${workspaceId} not rewritten before launch; it loads the last file written: ${err instanceof Error ? err.message : err}`);
    }
    parts.push(`--append-system-prompt-file ${getClaudePromptPath(workspaceId)}`);
  }
  if (opts?.model && isValidModelName(opts.model)) parts.push(`--model ${opts.model}`);
  if (opts?.effort && isValidClaudeEffort(opts.effort)) parts.push(`--effort ${opts.effort}`);
  if (opts?.role === 'evaluator') parts.push(...await evaluatorClaudeFlags(opts.previewOrigin));
  if (skipPerms) parts.push('--dangerously-skip-permissions');
  return parts.join(' ');
};

/**
 * The workspace's absolute directories, for the remote seed's trust check. A record that cannot be read gives
 * none: the launch then seeds the first run and trusts nothing, so the folder-trust dialog shows.
 */
const remoteSeedDirectories = async (workspaceId: string): Promise<string[]> => {
  const { workspaceDirectories } = await import('@/lib/workspace-home');
  try {
    return [...new Set((await workspaceDirectories(workspaceId)).filter((dir) => path.posix.isAbsolute(dir)).map((dir) => path.posix.resolve(dir)))];
  } catch (err) {
    log.warn(`remote seed for ${workspaceId} trusts no directory: ${err instanceof Error ? err.message : err}`);
    return [];
  }
};

/** The Claude launch of a remote tab (ADR-0022): the kit's first-run seed, then its hooks, prompt and CLI on the host. */
export const buildRemoteClaudeLaunch = async (workspaceId: string, opts?: { model?: string; effort?: string; trustCwd?: string }): Promise<string> => {
  const { buildRemoteClaudeCommand } = await import('@/lib/remote-kit');
  return buildRemoteClaudeCommand({
    workspaceId,
    ...(opts?.trustCwd ? { namedCwd: opts.trustCwd } : {}),
    ...(opts?.model && isValidModelName(opts.model) ? { model: opts.model } : {}),
    ...(opts?.effort && isValidClaudeEffort(opts.effort) ? { effort: opts.effort } : {}),
    skipPermissions: await getDangerouslySkipPermissions(),
    workspaceDirectories: await remoteSeedDirectories(workspaceId),
  });
};

export const buildResumeCommand = async (
  sessionId: string,
  workspaceId?: string,
  opts?: IClaudeFlagOptions,
): Promise<string> => {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Invalid session ID format: ${sessionId}`);
  }
  const flags = await buildClaudeFlags(workspaceId, opts);
  return claudeCommand(`--resume ${sessionId} ${flags}`, opts);
};
