import { REMOTE_HOOK_SCRIPT_CONTENT } from '@/lib/hook-scripts';
import { claudeHookEvents } from '@/lib/hook-settings';
import { originName, remoteSessionExistsGuard, remoteSocketName, remoteTagArgs, shQuote } from '@/lib/remote-host';

/**
 * What a remote host holds for this server's tabs (ADR-0022, slice b), under
 * `$HOME/.purplemux-remote/<origin>/`: the tmux config, the Claude hook script
 * and its hooks.json, this server's CLI (`bin/purplemux`, so a worker's
 * `purplemux` reaches this server through `PMUX_URL`), each workspace's Claude
 * prompt, and a tab's one-shot env file. Pure text builders: `tmux.ts` sends
 * them in one `ssh … sh -s` run.
 */

/** A path in the kit, double-quoted for the remote shell, which expands `$HOME`. */
export const remoteKitPath = (relative = ''): string =>
  `"$HOME/.purplemux-remote/${originName()}${relative ? `/${relative}` : ''}"`;

const kitPathUnquoted = (relative: string): string => `$HOME/.purplemux-remote/${originName()}/${relative}`;

export const REMOTE_CLI_WRAPPER = `#!/bin/sh
exec node "$(dirname "$0")/cli.js" "$@"
`;

export const remoteHooksJson = (): string =>
  `${JSON.stringify({ hooks: claudeHookEvents(kitPathUnquoted('status-hook.sh')) }, null, 2)}\n`;

export const remotePromptRelative = (workspaceId: string): string => `workspaces/${workspaceId}/claude-prompt.md`;

export const remoteTabEnvRelative = (tabId: string): string => `tabs/${tabId}.env`;

/**
 * The secrets of a pane, sourced once by its launch command and then deleted:
 * passed through ssh's stdin into a 0600 file, so no token is ever on a remote
 * command line or in tmux's `pane_start_command`.
 */
export const remoteTabEnvFile = (vars: Record<string, string>): string =>
  Object.entries(vars).map(([k, v]) => `${k}=${shQuote(v)}\n`).join('');

/**
 * The Claude launch for a remote tab: the kit's `bin` first on PATH (the
 * worker's `purplemux`), the kit's hooks.json, the workspace prompt when the
 * kit always has (empty when this host has none). Typed into the remote pane, whose shell expands `$HOME`.
 */
export const buildRemoteClaudeCommand = (opts: {
  workspaceId?: string;
  model?: string;
  effort?: string;
  skipPermissions?: boolean;
}): string => {
  const parts = [`PATH=${remoteKitPath('bin')}:"$PATH"`, 'claude', '--settings', remoteKitPath('hooks.json')];
  if (opts.workspaceId) parts.push('--append-system-prompt-file', remoteKitPath(remotePromptRelative(opts.workspaceId)));
  if (opts.model) parts.push('--model', opts.model);
  if (opts.effort) parts.push('--effort', opts.effort);
  if (opts.skipPermissions) parts.push('--dangerously-skip-permissions');
  return parts.join(' ');
};

export interface IRemoteKitFile {
  /** Relative to the kit directory; `[A-Za-z0-9._/-]` only. */
  path: string;
  content: string;
  mode: 0o600 | 0o700;
}

const SAFE_RELATIVE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

export const remoteKitFiles = (opts: {
  tmuxConf: string;
  cliJs: string | null;
  workspaceId?: string;
  prompt: string | null;
  tabEnv?: { tabId: string; content: string };
}): IRemoteKitFile[] => [
  { path: 'tmux.conf', content: opts.tmuxConf, mode: 0o600 },
  { path: 'status-hook.sh', content: REMOTE_HOOK_SCRIPT_CONTENT, mode: 0o700 },
  { path: 'hooks.json', content: remoteHooksJson(), mode: 0o600 },
  ...(opts.cliJs !== null
    ? [
        { path: 'bin/cli.js', content: opts.cliJs, mode: 0o600 as const },
        { path: 'bin/purplemux', content: REMOTE_CLI_WRAPPER, mode: 0o700 as const },
      ]
    : []),
  // Always present for a workspace tab: the launch names it whether or not this host wrote one yet.
  ...(opts.workspaceId ? [{ path: remotePromptRelative(opts.workspaceId), content: opts.prompt ?? '', mode: 0o600 as const }] : []),
  ...(opts.tabEnv ? [{ path: remoteTabEnvRelative(opts.tabEnv.tabId), content: opts.tabEnv.content, mode: 0o600 as const }] : []),
];

/**
 * One `sh -s` script: refuse a session name that exists (exit 17, before any
 * file is written), write every kit file (base64, a temporary, one rename),
 * create the session with the kit's tmux.conf and tag it with this call's nonce
 * in the same tmux command, and re-read the config into a server that already ran. Fed on stdin, so file
 * contents and secrets never reach a command line.
 */
export const buildRemoteCreateScript = (opts: {
  nonce: string;
  files: IRemoteKitFile[];
  session: string;
  cols: number;
  rows: number;
  cwd?: string;
  launch: string;
}): string => {
  const dirs = new Set(['bin', 'tabs', 'hook-spool']);
  for (const file of opts.files) {
    if (!SAFE_RELATIVE.test(file.path) || file.path.split('/').includes('..')) throw new Error(`unsafe kit path: ${file.path}`);
    const dir = file.path.split('/').slice(0, -1).join('/');
    if (dir) dirs.add(dir);
  }
  const sock = shQuote(remoteSocketName());
  const lines = [
    'set -e',
    remoteSessionExistsGuard(opts.session),
    `d=${remoteKitPath()}`,
    'umask 077',
    `mkdir -p ${[...dirs].map((dir) => `"$d/${dir}"`).join(' ')}`,
    'put() { printf \'%s\' "$2" | base64 -d > "$d/$1.tmp.$$"; chmod "$3" "$d/$1.tmp.$$"; mv -f "$d/$1.tmp.$$" "$d/$1"; }',
    ...opts.files.map((file) => `put ${shQuote(file.path)} ${shQuote(Buffer.from(file.content).toString('base64'))} ${file.mode.toString(8)}`),
    [
      shQuote('tmux'), shQuote('-u'), shQuote('-L'), sock, shQuote('-f'), '"$d/tmux.conf"',
      ...['new-session', '-d', '-s', opts.session, '-x', String(opts.cols), '-y', String(opts.rows), ...(opts.cwd ? ['-c', opts.cwd] : [])].map(shQuote),
      shQuote(opts.launch),
      ...remoteTagArgs(opts.session, opts.nonce).map(shQuote),
    ].join(' '),
    `${shQuote('tmux')} ${shQuote('-L')} ${sock} ${shQuote('source-file')} "$d/tmux.conf"`,
  ];
  return `${lines.join('\n')}\n`;
};
