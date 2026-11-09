import fs from 'fs';
import path from 'path';

// Claude Code's managed settings: a host-wide policy file that no user, project or CLAUDE_CONFIG_DIR setting can
// override, by design. When it wires a PreToolUse hook whose matcher takes a tool, every claude process on the host runs
// that hook before its own permission layer for that tool, a test's spawned CLI included. A test that proves which
// layer refuses a call of that tool cannot prove it there, so it skips with managedHookSkipNote. A hook on other tools
// alone does not skip it. The Linux path only: the evaluator tests run where the claude CLI is.

export const LINUX_MANAGED_SETTINGS_DIR = '/etc/claude-code';

/**
 * Whether a hook matcher selects a tool, in the forms the hook documentation names: an absent, empty or `*` matcher
 * selects every tool; a matcher of letters, digits, `_` and `|` is a list of exact names (`Edit|Write`); anything else
 * is a regular expression (`Notebook.*`), tested here unanchored against the tool name. A matcher that is not a valid
 * expression counts as selecting the tool: the fail-safe side is a skip with its reason, never a false failure.
 */
export const matcherSelects = (matcher: unknown, tool: string): boolean => {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return false;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(tool);
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return true;
  }
};

const wiresPreToolUseFor = (file: string, tool: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const entries = (parsed as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
  return Array.isArray(entries) && entries.some((entry) => {
    const { matcher, hooks } = (entry ?? {}) as { matcher?: unknown; hooks?: unknown };
    return Array.isArray(hooks) && hooks.length > 0 && matcherSelects(matcher, tool);
  });
};

/**
 * The managed settings files that wire a PreToolUse hook whose matcher selects `tool`: managed-settings.json, then
 * managed-settings.d/*.json in name order. A hook on Read alone never skips a Bash test.
 */
export const managedPreToolUseHookFiles = (
  tool: string,
  dir: string = LINUX_MANAGED_SETTINGS_DIR,
  platform: NodeJS.Platform = process.platform,
): string[] => {
  if (platform !== 'linux') return [];
  const files = [path.join(dir, 'managed-settings.json')];
  const dropIns = path.join(dir, 'managed-settings.d');
  try {
    files.push(...fs.readdirSync(dropIns).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(dropIns, name)));
  } catch {
    // No drop-in directory.
  }
  return files.filter((file) => fs.existsSync(file) && wiresPreToolUseFor(file, tool));
};

export const managedHookSkipNote = (files: readonly string[], tool = 'Bash'): string =>
  `managed ${tool} hooks on this host refuse first; the permission layer is proven on hosts without them (${files.join(', ')})`;
