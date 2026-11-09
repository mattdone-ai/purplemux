import { REMOTE_HOOK_SCRIPT_CONTENT } from '@/lib/hook-scripts';
import { claudeHookEvents } from '@/lib/hook-settings';
import { originName, remoteSessionExistsGuard, remoteSocketName, remoteTagArgs, shQuote } from '@/lib/remote-host';
import { buildRemoteLoginShellCommand } from '@/lib/shell-env';

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
 * passed through ssh's stdin into a 0600 file, so the token is never on the
 * create's command line or in tmux's `pane_start_command`. It then lives only
 * in the pane's environment; the hook hands it to curl on fd 3 (hook-scripts.ts),
 * and the CLI sends it in a request header, never in any process's argv.
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

/**
 * The remote half of the pre-trust (D14, ruling R-05, story 05 consult ruling): the same keys as
 * workspace-trust.ts (each key only when its REAL path is inside the workspace directory's real path),
 * written into the remote user's `~/.claude.json` for the tab's cwd by an atomic
 * read-modify-write (a temporary in the same directory, then one rename). A remote tab has no claude home
 * of its own (ADR-0022), so its Claude reads that file. Python, not node: `ssh … sh -s` reads no login
 * profile, and on the pool hosts `node` is on PATH only in a login shell (measured on mdserver1). Exit 0:
 * written or nothing to change; 3: the cwd is outside the workspace directory; 4: the file is unreadable
 * and is left as it is. The create script ignores every exit: a lost seed shows the dialog, which the
 * status reader reports as `startup-prompt`.
 */
export const REMOTE_TRUST_SEED_SCRIPT = `import json, os, sys, tempfile
TRUST_KEYS = ('hasTrustDialogAccepted', 'hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown')

def within(child, root):
    return child == root or child.startswith(root.rstrip('/') + '/')

def main_repository_root(git_root):
    dot_git = os.path.join(git_root, '.git')
    if os.path.isdir(dot_git) and not os.path.islink(dot_git):
        return git_root
    try:
        with open(dot_git, encoding='utf-8') as handle:
            pointer = next((line[len('gitdir:'):].strip() for line in handle if line.startswith('gitdir:')), '')
        if not pointer:
            return None
        git_dir = os.path.join(git_root, pointer)
        with open(os.path.join(git_dir, 'commondir'), encoding='utf-8') as handle:
            common = handle.read().strip()
    except OSError:
        return None
    if not common:
        return None
    common_dir = os.path.realpath(os.path.join(git_dir, common))
    return os.path.dirname(common_dir) if os.path.basename(common_dir) == '.git' else None

def main(cwd, workspace_dir):
    # Real paths only (review r1 BLOCK): a symlink inside the workspace that points out of it, or a
    # <ws>/link/.. form, leaves the workspace when the process resolves it; a lexical match never counts.
    real_cwd, real_ws = os.path.realpath(cwd), os.path.realpath(workspace_dir)
    if not os.path.isdir(real_cwd) or not within(real_cwd, real_ws):
        return 3
    candidates = [os.path.abspath(cwd), real_cwd]
    current = real_cwd
    while True:
        if os.path.lexists(os.path.join(current, '.git')):
            candidates.append(current)
            main_root = main_repository_root(current)
            if main_root:
                candidates.append(main_root)
            break
        parent = os.path.dirname(current)
        if current == real_ws or parent == current or not within(parent, real_ws):
            break
        current = parent
    keys = []
    for key in candidates:
        if key not in keys and os.path.exists(key) and within(os.path.realpath(key), real_ws):
            keys.append(key)
    target = os.path.realpath(os.path.join(os.path.expanduser('~'), '.claude.json'))
    try:
        with open(target, encoding='utf-8') as handle:
            data = json.load(handle)
    except FileNotFoundError:
        data = {}
    except (OSError, ValueError):
        return 4
    if not isinstance(data, dict):
        return 4
    projects = data.get('projects')
    if not isinstance(projects, dict):
        projects = {}
    changed = False
    for key in keys:
        entry = projects.get(key)
        if entry is not None and not isinstance(entry, dict):
            continue
        following = dict(entry or {})
        declined = following.get('hasClaudeMdExternalIncludesApproved') is False and following.get('hasClaudeMdExternalIncludesWarningShown') is True
        touched = entry is None
        for name in TRUST_KEYS:
            if following.get(name) is True or (declined and name == 'hasClaudeMdExternalIncludesApproved'):
                continue
            following[name] = True
            touched = True
        if touched:
            projects[key] = following
            changed = True
    if not changed:
        return 0
    data['projects'] = projects
    fd, temporary = tempfile.mkstemp(prefix='.claude.json.', dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
        os.chmod(temporary, 0o600)
        os.replace(temporary, target)
    except BaseException:
        os.unlink(temporary)
        raise
    return 0

sys.exit(main(sys.argv[1], sys.argv[2]))
`;

export const REMOTE_TRUST_SEED_RELATIVE = 'trust-seed.py';

export interface IRemoteKitFile {
  /** Relative to the kit directory; `[A-Za-z0-9._/-]` only. */
  path: string;
  content: string;
  mode: 0o600 | 0o700;
}

const SAFE_RELATIVE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

// `require('./x.js')`, `require("./x")` or require(`./x`), anywhere in the source: a lazy require in a function counts.
const LOCAL_REQUIRE = /require\(\s*(['"`])\.\/([A-Za-z0-9._-]+)\1\s*\)/g;
const HAS_EXTENSION = /\.(?:c?js|json)$/;

/** The sibling modules a CLI source loads, by file name; an extensionless one resolves as Node does first, to `.js`. */
export const cliLocalRequires = (source: string): string[] =>
  [...new Set([...source.matchAll(LOCAL_REQUIRE)].map((m) => (HAS_EXTENSION.test(m[2]) ? m[2] : `${m[2]}.js`)))];

/**
 * `bin/cli.js` and every sibling module it requires, transitively, by file name (story 36): the kit's CLI runs from
 * `bin/` on the remote host, so a module left out fails every command at load. Null when any of them cannot be read:
 * a CLI that cannot load is not shipped.
 */
export const readRemoteCliModules = async (read: (name: string) => Promise<string>): Promise<Record<string, string> | null> => {
  const modules: Record<string, string> = {};
  const queue = ['cli.js'];
  try {
    while (queue.length) {
      const name = queue.shift()!;
      if (Object.prototype.hasOwnProperty.call(modules, name)) continue;
      modules[name] = await read(name);
      queue.push(...cliLocalRequires(modules[name]));
    }
  } catch {
    return null;
  }
  return modules;
};

export const remoteKitFiles = (opts: {
  tmuxConf: string;
  /** File name to content, from `readRemoteCliModules`; null ships no CLI, and `buildRemoteCreateScript` then refuses the file set (story 12). */
  cli: Record<string, string> | null;
  workspaceId?: string;
  prompt: string | null;
  tabEnv?: { tabId: string; content: string };
  /** Ship the pre-trust script (a tab whose cwd is inside a workspace directory). */
  trustSeed?: boolean;
}): IRemoteKitFile[] => [
  { path: 'tmux.conf', content: opts.tmuxConf, mode: 0o600 },
  { path: 'status-hook.sh', content: REMOTE_HOOK_SCRIPT_CONTENT, mode: 0o700 },
  { path: 'hooks.json', content: remoteHooksJson(), mode: 0o600 },
  ...(opts.cli !== null
    ? [
        ...Object.entries(opts.cli).map(([name, content]) => ({ path: `bin/${name}`, content, mode: 0o600 as const })),
        { path: 'bin/purplemux', content: REMOTE_CLI_WRAPPER, mode: 0o700 as const },
      ]
    : []),
  // Always present for a workspace tab: the launch names it whether or not this host wrote one yet.
  ...(opts.workspaceId ? [{ path: remotePromptRelative(opts.workspaceId), content: opts.prompt ?? '', mode: 0o600 as const }] : []),
  ...(opts.tabEnv ? [{ path: remoteTabEnvRelative(opts.tabEnv.tabId), content: opts.tabEnv.content, mode: 0o600 as const }] : []),
  ...(opts.trustSeed ? [{ path: REMOTE_TRUST_SEED_RELATIVE, content: REMOTE_TRUST_SEED_SCRIPT, mode: 0o600 as const }] : []),
];

/** The create script exits with this when the kit's CLI does not run on the host (story 12): no session was started. */
export const REMOTE_KIT_BROKEN_EXIT = 18;

/** Each stderr line of a failed kit probe carries this prefix, so no other line of the script is read as its cause. */
export const REMOTE_KIT_PROBE_PREFIX = 'pmux-kit-probe: ';

const CLI_MODULE = /^bin\/[A-Za-z0-9._-]+\.(?:c?js|json)$/;

/**
 * The probe's own budget on the host, in seconds (story 12 review r1): inside the create's 10 s ssh deadline after a
 * 5 s `ConnectTimeout`, so a slow login shell reads as a kit verdict, never as a host that did not answer. Measured
 * 2026-11-05: the whole probe takes 0.35-0.37 s on ai-server at load 12.6.
 */
export const REMOTE_KIT_PROBE_BUDGET_S = 4;

// The probe itself, run as `sh -c BODY pmux-kit-probe <kit dir> <module>...`, so one bound covers every step. One line.
const probeBody = (): string => [
  'd=$1; shift',
  `pmux_node=$(${buildRemoteLoginShellCommand('command -v node')} 2>/dev/null | tail -n 1) || pmux_node=`,
  'case "$pmux_node" in /*) [ -x "$pmux_node" ] || pmux_node= ;; *) pmux_node= ;; esac',
  `if [ -z "$pmux_node" ]; then echo ${shQuote(`${REMOTE_KIT_PROBE_PREFIX}node is not an executable on PATH in a login shell on this host`)} >&2; exit ${REMOTE_KIT_BROKEN_EXIT}; fi`,
  `if ! pmux_probe=$( { PATH="\${pmux_node%/*}:$PATH" "$d/bin/purplemux" help >/dev/null && "$pmux_node" -e 'for (const file of process.argv.slice(1)) require(file)' "$@"; } 2>&1 </dev/null ); then printf '%s\\n' "$pmux_probe" | head -n 40 | sed ${shQuote(`s/^/${REMOTE_KIT_PROBE_PREFIX}/`)} >&2; exit ${REMOTE_KIT_BROKEN_EXIT}; fi`,
].join('; ');

/**
 * The kit probe (harness-flow-loop-2 story 12): after the kit lands and before any session starts, run the kit's
 * CLI as the pane will. `node` is found the way the pane's interactive login shell finds it, then `bin/purplemux help`
 * runs through the wrapper, and every shipped module is required once, so a lazy module that cannot load fails here
 * too. Loading `cli.js` runs nothing (`require.main`). A failure prints the output with the probe prefix (at most 40
 * lines). The probe runs as one child bounded on the host (review r1): `timeout -k 1 <budget>` where the host has
 * it (coreutils signals the probe's whole process group), else a shell watchdog that signals the probe's shell (dash
 * has no job control without a tty, so no group kill: a descendant of a hung probe can outlive it there). The probe
 * writes to a file in the kit, never to the script's stderr, so no descendant holds the ssh channel open past the
 * budget (measured: a `$(… | tail)` child kept it open 5 s). Exit 124, 137 or 143 reads as "kit probe timed out".
 * Any failure exits `REMOTE_KIT_BROKEN_EXIT`, so the script never
 * reaches `new-session` after a probe that failed or ran out of time. Every stdin is `/dev/null`: the rest of the
 * create script is on the shell's stdin.
 */
export const remoteKitProbeLines = (modules: readonly string[], budgetSeconds: number = REMOTE_KIT_PROBE_BUDGET_S): string[] => {
  if (!Number.isInteger(budgetSeconds) || budgetSeconds < 1) throw new Error(`kit probe budget must be a whole number of seconds: ${budgetSeconds}`);
  const run = `sh -c ${shQuote(probeBody())} pmux-kit-probe "$d" ${modules.map((module) => `"$d/${module}"`).join(' ')} </dev/null >/dev/null 2>"$pmux_probe_out"`;
  const watchdog = `( sleep ${budgetSeconds}; kill -TERM "$pmux_probe_pid" 2>/dev/null; sleep 1; kill -KILL "$pmux_probe_pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &`;
  return [
    'pmux_probe_rc=0; pmux_probe_out="$d/.kit-probe.$$"',
    `if command -v timeout >/dev/null 2>&1; then timeout -k 1 ${budgetSeconds} ${run} || pmux_probe_rc=$?; else ${run} & pmux_probe_pid=$!; ${watchdog} pmux_watch_pid=$!; wait "$pmux_probe_pid" || pmux_probe_rc=$?; kill "$pmux_watch_pid" 2>/dev/null || :; fi`,
    '[ "$pmux_probe_rc" -eq 0 ] || cat "$pmux_probe_out" >&2 2>/dev/null || :; rm -f "$pmux_probe_out"',
    `case "$pmux_probe_rc" in 124|137|143) echo ${shQuote(`${REMOTE_KIT_PROBE_PREFIX}kit probe timed out after ${budgetSeconds} s`)} >&2; exit ${REMOTE_KIT_BROKEN_EXIT} ;; 0) ;; *) exit ${REMOTE_KIT_BROKEN_EXIT} ;; esac`,
  ];
};

const PROBE_ERROR_LINE = /^(?:[A-Z][A-Za-z]*)?Error\b/;
const PROBE_LINE_MAX = 300;

/**
 * The line that names why the kit probe failed: Node's own error line (`Error: Cannot find module …`,
 * `SyntaxError: …`) when there is one, since a stack's first line is only a file position; else the first non-empty
 * probe line. Only lines with the probe prefix count.
 */
export const remoteKitProbeFailureLine = (stderr: string): string => {
  const lines = stderr.split('\n')
    .filter((line) => line.startsWith(REMOTE_KIT_PROBE_PREFIX))
    .map((line) => line.slice(REMOTE_KIT_PROBE_PREFIX.length).trim())
    .filter(Boolean);
  const line = lines.find((l) => PROBE_ERROR_LINE.test(l)) ?? lines[0] ?? 'the kit\'s CLI exited with no output';
  return line.length > PROBE_LINE_MAX ? `${line.slice(0, PROBE_LINE_MAX - 1)}…` : line;
};

/**
 * A remote create or restart refused because the CLI kit cannot run on the host (story 12): the probe failed or ran
 * out of time there, or this server could not read its own CLI. No agent started, and no session was touched. 502 `remote-kit-broken`, exit 1 (ADR-0016):
 * a retry fails the same way until the kit or the host is repaired.
 */
export class RemoteKitBrokenError extends Error {
  constructor(readonly host: string, readonly line: string) {
    super(`the CLI kit does not run on ${host} (${line}); no agent started and no session was touched. Repair the kit or the host, then try again`);
    this.name = 'RemoteKitBrokenError';
  }
}

/**
 * The create script's pre-trust line: run only when python3 exists, every failure ignored, so a seed never
 * blocks a launch (story 05 AC 2). Runs after the kit files land and before the session starts.
 */
export const remoteTrustSeedLine = (trust: { cwd: string; workspaceDirectory: string }): string =>
  `if command -v python3 >/dev/null 2>&1; then python3 "$d/${REMOTE_TRUST_SEED_RELATIVE}" ${shQuote(trust.cwd)} ${shQuote(trust.workspaceDirectory)} >/dev/null 2>&1 || :; fi`;

// Story 12 AC 3: no script starts a pane, or answers for the kit, without a CLI that ran.
const kitCliModules = (files: readonly IRemoteKitFile[], what: string): string[] => {
  const missing = ['bin/cli.js', 'bin/purplemux'].filter((name) => !files.some((file) => file.path === name));
  if (missing.length) throw new Error(`${what} needs the kit's CLI: missing=[${missing.join(', ')}]`);
  return files.map((file) => file.path).filter((p) => CLI_MODULE.test(p));
};

/** `d=<kit>`, its directories, and each file written by base64, a temporary and one rename. */
const kitWriteLines = (files: readonly IRemoteKitFile[], baseDirs: readonly string[]): string[] => {
  const dirs = new Set(baseDirs);
  for (const file of files) {
    if (!SAFE_RELATIVE.test(file.path) || file.path.split('/').includes('..')) throw new Error(`unsafe kit path: ${file.path}`);
    const dir = file.path.split('/').slice(0, -1).join('/');
    if (dir) dirs.add(dir);
  }
  return [
    `d=${remoteKitPath()}`,
    'umask 077',
    `mkdir -p ${[...dirs].map((dir) => `"$d/${dir}"`).join(' ')}`,
    'put() { printf \'%s\' "$2" | base64 -d > "$d/$1.tmp.$$"; chmod "$3" "$d/$1.tmp.$$"; mv -f "$d/$1.tmp.$$" "$d/$1"; }',
    ...files.map((file) => `put ${shQuote(file.path)} ${shQuote(Buffer.from(file.content).toString('base64'))} ${file.mode.toString(8)}`),
  ];
};

/**
 * The kit probe alone, for a restart (story 12 review r1, finding 3): a restart kills the old session before its
 * create runs, so it ships the CLI the create will ship and probes it first. A broken kit then leaves the old tab
 * alive. Writes only the CLI files (`bin/`), which the create rewrites with the same content; starts no session.
 */
export const buildRemoteKitProbeScript = (files: readonly IRemoteKitFile[]): string => {
  const cli = files.filter((file) => file.path.startsWith('bin/'));
  const cliModules = kitCliModules(cli, 'a remote kit probe');
  return `${['set -e', ...kitWriteLines(cli, ['bin']), ...remoteKitProbeLines(cliModules)].join('\n')}\n`;
};

/**
 * The workspace prompt alone (D32): a standing order changed, so the kit's copy is rewritten for the next launch on
 * the host. Writes one file (base64, a temporary, one rename); starts no session and touches no live one.
 */
export const buildRemotePromptScript = (workspaceId: string, prompt: string): string =>
  `${['set -e', ...kitWriteLines([{ path: remotePromptRelative(workspaceId), content: prompt, mode: 0o600 }], [])].join('\n')}\n`;

/**
 * One `sh -s` script: refuse a session name that exists (exit 17, before any
 * file is written), write every kit file (base64, a temporary, one rename),
 * run the kit's CLI once and refuse when it does not run (exit 18, story 12; the files must hold `bin/cli.js` and
 * `bin/purplemux`), pre-trust the cwd when it is inside a workspace directory (fail-open),
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
  /** Pre-trust the cwd (D14): the kit files must include the trust-seed script. */
  trust?: { cwd: string; workspaceDirectory: string };
}): string => {
  if (opts.trust && !opts.files.some((file) => file.path === REMOTE_TRUST_SEED_RELATIVE)) {
    throw new Error(`a pre-trust needs the kit file ${REMOTE_TRUST_SEED_RELATIVE}`);
  }
  const cliModules = kitCliModules(opts.files, 'a remote create');
  const sock = shQuote(remoteSocketName());
  const lines = [
    'set -e',
    remoteSessionExistsGuard(opts.session),
    ...kitWriteLines(opts.files, ['bin', 'tabs', 'hook-spool']),
    ...remoteKitProbeLines(cliModules),
    ...(opts.trust ? [remoteTrustSeedLine(opts.trust)] : []),
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
