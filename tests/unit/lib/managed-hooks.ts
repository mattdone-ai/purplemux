import fs from 'fs';
import path from 'path';

// Claude Code's managed settings: a host-wide policy file that no user, project or CLAUDE_CONFIG_DIR setting can
// override, by design. When it wires a PreToolUse hook, every claude process on the host runs that hook before its own
// permission layer, a test's spawned CLI included. A test that proves which layer refuses a tool call cannot prove it
// there, so it skips with managedHookSkipNote. The Linux path only: the evaluator tests run where the claude CLI is.

export const LINUX_MANAGED_SETTINGS_DIR = '/etc/claude-code';

const wiresPreToolUse = (file: string): boolean => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  const entries = (parsed as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
  return Array.isArray(entries)
    && entries.some((entry) => Array.isArray((entry as { hooks?: unknown } | null)?.hooks) && (entry as { hooks: unknown[] }).hooks.length > 0);
};

/** The managed settings files that wire at least one PreToolUse hook: managed-settings.json, then managed-settings.d/*.json in name order. */
export const managedPreToolUseHookFiles = (dir: string = LINUX_MANAGED_SETTINGS_DIR, platform: NodeJS.Platform = process.platform): string[] => {
  if (platform !== 'linux') return [];
  const files = [path.join(dir, 'managed-settings.json')];
  const dropIns = path.join(dir, 'managed-settings.d');
  try {
    files.push(...fs.readdirSync(dropIns).filter((name) => name.endsWith('.json')).sort().map((name) => path.join(dropIns, name)));
  } catch {
    // No drop-in directory.
  }
  return files.filter((file) => fs.existsSync(file) && wiresPreToolUse(file));
};

export const managedHookSkipNote = (files: readonly string[]): string =>
  `managed hooks on this host refuse first; the permission layer is proven on hosts without them (${files.join(', ')})`;
