import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';
import { STATUSLINE_SCRIPT_PATH, STATUSLINE_SCRIPT_CONTENT } from '@/lib/statusline-script';
import {
  CLAUDE_HOOK_TIMEOUT_SECONDS,
  CODEX_HOOK_SCRIPT_CONTENT,
  GROK_HOOK_SCRIPT_CONTENT,
  HOOK_SCRIPT_CONTENT,
  writeScriptAtomic,
} from '@/lib/hook-scripts';
import { ensureGrokHookFiles } from '@/lib/providers/grok/hook-config';
import { GROK_HOOK_SCRIPT_PATH as GROK_HOOK_SCRIPT } from '@/lib/providers/grok/paths';

const log = createLogger('hooks');
const codexLog = createLogger('codex-hook');
const grokLog = createLogger('grok-hook');

const BASE_DIR = path.join(os.homedir(), '.purplemux');
const HOOKS_FILE = path.join(BASE_DIR, 'hooks.json');
const PORT_FILE = path.join(BASE_DIR, 'port');
const HOOK_SCRIPT = path.join(BASE_DIR, 'status-hook.sh');
const CODEX_HOOK_SCRIPT = path.join(BASE_DIR, 'codex-hook.sh');

export const HOOK_SETTINGS_PATH = HOOKS_FILE;
export const CODEX_HOOK_SCRIPT_PATH = CODEX_HOOK_SCRIPT;
export const GROK_HOOK_SCRIPT_PATH = GROK_HOOK_SCRIPT;
export { HOOK_SCRIPT_CONTENT, GROK_HOOK_SCRIPT_CONTENT };

const hookEntry = (script: string, event: string, timeout = CLAUDE_HOOK_TIMEOUT_SECONDS, matcher = '') => [
  {
    matcher,
    hooks: [
      {
        type: 'command',
        command: `sh "${script}" ${event}`,
        timeout,
      },
    ],
  },
];

// Only the tools that can produce a signal. Read/Grep/Glob dominate a session's
// tool calls and can never put an edit out of scope or fail repeatedly, so
// matching them would multiply hook invocations for nothing.
const SIGNAL_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit|Bash';

/** The Claude hook events, each running `script` with its event word. */
export const claudeHookEvents = (script: string) => ({
  SessionStart: hookEntry(script, 'session-start'),
  UserPromptSubmit: hookEntry(script, 'prompt-submit'),
  Notification: hookEntry(script, 'notification'),
  Stop: hookEntry(script, 'stop'),
  StopFailure: hookEntry(script, 'stop'),
  PreCompact: hookEntry(script, 'pre-compact'),
  PostCompact: hookEntry(script, 'post-compact'),
  PostToolUse: hookEntry(script, 'post-tool', 2, SIGNAL_TOOLS),
});

const buildHookSettings = () => ({
  hooks: claudeHookEvents(HOOK_SCRIPT),
  statusLine: {
    type: 'command' as const,
    command: `sh "${STATUSLINE_SCRIPT_PATH}"`,
  },
});

export interface IEnsureHookSettingsResult {
  codexHookInstallFailed: boolean;
  grokHookInstallFailed: boolean;
}

export const ensureHookSettings = async (port: number): Promise<IEnsureHookSettingsResult> => {
  await fs.mkdir(BASE_DIR, { recursive: true });

  await fs.writeFile(PORT_FILE, String(port), { mode: 0o600 });

  await writeScriptAtomic(HOOK_SCRIPT, HOOK_SCRIPT_CONTENT, 0o755);
  await writeScriptAtomic(STATUSLINE_SCRIPT_PATH, STATUSLINE_SCRIPT_CONTENT, 0o755);

  let codexHookInstallFailed = false;
  try {
    await writeScriptAtomic(CODEX_HOOK_SCRIPT, CODEX_HOOK_SCRIPT_CONTENT, 0o700);
  } catch (err) {
    codexHookInstallFailed = true;
    codexLog.error({ err }, 'codex-hook script write failed');
  }

  let grokHookInstallFailed = false;
  try {
    await writeScriptAtomic(GROK_HOOK_SCRIPT, GROK_HOOK_SCRIPT_CONTENT, 0o700);
    await ensureGrokHookFiles(GROK_HOOK_SCRIPT);
  } catch (err) {
    grokHookInstallFailed = true;
    grokLog.error({ err }, 'grok hook install failed');
  }

  const settings = buildHookSettings();
  const content = JSON.stringify(settings, null, 2) + '\n';

  try {
    const existing = await fs.readFile(HOOKS_FILE, 'utf-8');
    if (existing === content) return { codexHookInstallFailed, grokHookInstallFailed };
  } catch {
    // file doesn't exist yet
  }

  await fs.writeFile(HOOKS_FILE, content, { mode: 0o600 });
  log.debug(`${HOOKS_FILE} created`);
  return { codexHookInstallFailed, grokHookInstallFailed };
};

export const removePortFile = async (): Promise<void> => {
  try {
    await fs.unlink(PORT_FILE);
  } catch {
    // already removed
  }
};
