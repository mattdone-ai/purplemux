import { REMOTE_HOOK_SCRIPT_CONTENT } from '@/lib/hook-scripts';
import { claudeHookEvents } from '@/lib/hook-settings';
import { originName, remoteSessionExistsGuard, remoteSocketName, remoteTagArgs, shQuote } from '@/lib/remote-host';
import { buildRemoteLoginShellCommand } from '@/lib/shell-env';

/**
 * What a remote host holds for this server's tabs (ADR-0022, slice b), under
 * `$HOME/.purplemux-remote/<origin>/`: the tmux config, the Claude hook script
 * and its hooks.json, this server's CLI (`bin/purplemux`, so a worker's
 * `purplemux` reaches this server through `PMUX_URL`), each workspace's Claude
 * prompt, the seed script for Claude Code's trust and first-run state
 * (`trust-seed.py`), and a tab's one-shot env file. Pure text builders: `tmux.ts` sends
 * them in one `ssh … sh -s` run.
 */

/** A path in the kit, double-quoted for the remote shell, which expands `$HOME`. */
export const remoteKitPath = (relative = ''): string =>
  `"$HOME/.purplemux-remote/${originName()}${relative ? `/${relative}` : ''}"`;

const kitPathUnquoted = (relative: string): string => `$HOME/.purplemux-remote/${originName()}/${relative}`;

export const REMOTE_TRUST_SEED_RELATIVE = 'trust-seed.py';

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
 *
 * The first-run seed runs first, in the same typed line (`;`, so a seed that fails or a host without python3
 * still starts claude): a Claude process that exits writes its in-memory `~/.claude.json` back (measured
 * 2026-11-09), so a seed written at session create can be lost before this launch reads it. `$PWD` is the
 * pane's cwd when the line runs, which is the directory claude starts in.
 */
export const buildRemoteClaudeCommand = (opts: {
  workspaceId?: string;
  model?: string;
  effort?: string;
  skipPermissions?: boolean;
  /** The workspace's directories on this server's record: the seed trusts the cwd only under one of them. */
  workspaceDirectories?: readonly string[];
  /**
   * The cwd the tab's creator named (vel-PMX-FU): the seed takes it literally with `--named`, never `"$PWD"`, which
   * is wherever the pane's shell stands when the line is typed, a directory the agent may have chosen.
   */
  namedCwd?: string;
}): string => {
  if (opts.namedCwd !== undefined && !opts.namedCwd.startsWith('/')) {
    throw new Error(`a named cwd must be an absolute path: ${JSON.stringify(opts.namedCwd)}`);
  }
  const seed = [
    'python3', remoteKitPath(REMOTE_TRUST_SEED_RELATIVE), '--first-run',
    ...(opts.skipPermissions ? ['--bypass-permissions'] : []),
    ...(opts.namedCwd !== undefined ? ['--named', shQuote(opts.namedCwd)] : ['"$PWD"']),
    ...(opts.workspaceDirectories ?? []).map(shQuote),
  ].join(' ');
  const parts = [`PATH=${remoteKitPath('bin')}:"$PATH"`, 'claude', '--settings', remoteKitPath('hooks.json')];
  if (opts.workspaceId) parts.push('--append-system-prompt-file', remoteKitPath(remotePromptRelative(opts.workspaceId)));
  if (opts.model) parts.push('--model', opts.model);
  if (opts.effort) parts.push('--effort', opts.effort);
  if (opts.skipPermissions) parts.push('--dangerously-skip-permissions');
  return `command -v python3 >/dev/null 2>&1 && ${seed} >/dev/null 2>&1; ${parts.join(' ')}`;
};

/**
 * The remote user's Claude Code state, written by one script (`trust-seed.py`) with an atomic read-modify-write
 * per file: a temporary in the same directory, then one rename, every other key kept. A remote tab has no claude
 * home of its own (ADR-0022), so its Claude reads `~/.claude.json` and `~/.claude/settings.json` there. Python, not
 * node: `ssh … sh -s` reads no login profile, and on the pool hosts `node` is on PATH only in a login shell
 * (measured on mdserver1).
 *
 * `trust-seed.py [--first-run] [--bypass-permissions] [--named] <cwd> [<workspace directory>...]`
 *
 * - Always: the pre-trust (D14, ruling R-05, story 05 consult ruling), the same keys as workspace-trust.ts for the
 *   cwd, its git root and its main repository root, each only when its REAL path is inside the deepest workspace
 *   directory that holds the cwd's real path.
 * - `--named`: the cwd is the one the tab's creator named (`tab create --cwd`), and D14 found no workspace directory
 *   for it (vel-PMX-FU consult ruling C). The trust key goes on the cwd only: Claude
 *   reads trust walking up from the cwd, so a key on a parent would trust every sibling. Only the cwd's real path
 *   is keyed: `abspath` collapses a `..` lexically, and `<link>/..` names a directory the tab never runs in. The
 *   main repository root
 *   gets the CLAUDE.md-include keys only (where Claude keys the imports approval), never the trust key. Refused,
 *   writing no project key: a cwd that is not a directory (exit 5); `/`, a top-level directory, the home or an
 *   ancestor of it, at either spelling (exit 6). A refused repository root is dropped and the cwd keys stay.
 * - `--first-run`: the onboarding a new host asks for before the first prompt (measured 2026-11-09 on two new
 *   hosts: the theme picker, then the project onboarding): `hasCompletedOnboarding`, a `theme` when none is set,
 *   and `hasCompletedProjectOnboarding` on each trusted project.
 * - `--bypass-permissions`: `skipDangerousModePermissionPrompt` in `~/.claude/settings.json`, for a launch with
 *   `--dangerously-skip-permissions` (the warning was the second stop on those hosts).
 *
 * Exit 0: written or nothing to change; 2: an unknown flag, nothing written; 3: the cwd is outside every workspace
 * directory and not named (the first-run keys are still written); 4: a file is unreadable and is left as it is (the
 * other file is still written); 5 and 6: the named refusals above (the first-run keys are still written); 7: a file
 * changed between the read and the write twice, so it is left as the other writer made it (review r1 C1: Claude
 * Code rewrites `~/.claude.json` from memory with no lock to share, so each write goes ahead only on the version it
 * read). Every caller ignores the exit: a lost seed shows the dialog, which the status reader reports as
 * `startup-prompt`.
 */
export const REMOTE_TRUST_SEED_SCRIPT = `import hashlib, json, os, sys, tempfile
INCLUDE_KEYS = ('hasClaudeMdExternalIncludesApproved', 'hasClaudeMdExternalIncludesWarningShown')
TRUST_KEYS = ('hasTrustDialogAccepted',) + INCLUDE_KEYS
FIRST_RUN_PROJECT_KEYS = ('hasCompletedProjectOnboarding',)
FLAGS = ('--first-run', '--bypass-permissions', '--named')
DEFAULT_THEME = 'dark'

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

def trust_keys(cwd, workspace_dirs):
    # Real paths only (review r1 BLOCK): a symlink inside the workspace that points out of it, or a
    # <ws>/link/.. form, leaves the workspace when the process resolves it; a lexical match never counts.
    real_cwd = os.path.realpath(cwd)
    if not os.path.isdir(real_cwd):
        return None
    holding = [real for real in (os.path.realpath(d) for d in workspace_dirs) if within(real_cwd, real)]
    if not holding:
        return None
    real_ws = max(holding, key=len)
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
    return keys

def refused(path, home):
    # '/', a top-level directory, or the home or one of its ancestors: a trust key there trusts every project below.
    return path == '/' or os.path.dirname(path) == '/' or within(home, path)

def named_entries(cwd):
    home = os.path.realpath(os.path.expanduser('~'))
    if not os.path.isabs(home):
        return 6
    given, real = os.path.abspath(cwd), os.path.realpath(cwd)
    if not os.path.isdir(real):
        return 5
    if refused(given, home) or refused(real, home):
        return 6
    # The real path only (review r1 C2): abspath collapses a ".." lexically, so "<link>/.." names the link's own
    # parent, a directory the process never stands in.
    entries = [(real, TRUST_KEYS)]
    current = real
    while not os.path.lexists(os.path.join(current, '.git')):
        parent = os.path.dirname(current)
        if parent == current:
            return entries
        current = parent
    root = main_repository_root(current)
    dot_git = os.path.join(root, '.git') if root else ''
    if root and os.path.isdir(dot_git) and not os.path.islink(dot_git) and not refused(root, home) and not refused(os.path.realpath(root), home):
        entries.append((root, INCLUDE_KEYS))
    return entries

def read_object(target):
    try:
        with open(target, encoding='utf-8') as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None

def stamp(target):
    # What identifies one version of the file: a rename (inode), an in-place write (mtime, size), and the bytes
    # themselves, since file times are only as fine as the kernel's clock tick and two same-size writes in one tick
    # look the same otherwise.
    try:
        st = os.stat(target)
        with open(target, 'rb') as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
    except FileNotFoundError:
        return None
    return (st.st_ino, st.st_mtime_ns, st.st_size, digest)

def write_object(target, data, mode, expected):
    # Replace the file only if it is still the version that was read (expected); False when it changed.
    # mode None keeps the file's own mode; a new file gets 0600.
    directory = os.path.dirname(target)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    if mode is None:
        try:
            mode = os.stat(target).st_mode & 0o777
        except FileNotFoundError:
            mode = 0o600
    fd, temporary = tempfile.mkstemp(prefix='.' + os.path.basename(target) + '.', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(data, handle, indent=2, ensure_ascii=False)
        os.chmod(temporary, mode)
        if stamp(target) != expected:
            os.unlink(temporary)
            return False
        os.replace(temporary, target)
        return True
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise

def update_object(target, edit, mode=None):
    # A read-modify-write that never puts back a stale copy (vel-PMX-FU review r1 C1): Claude Code rewrites this
    # file from memory and takes no lock this script could share, so the write goes ahead only when the file is
    # unchanged since the read, re-read and re-applied once, and otherwise nothing is written.
    for _ in range(2):
        before = stamp(target)
        data = read_object(target)
        if data is None:
            return 'unreadable'
        if not edit(data):
            return 'unchanged'
        if write_object(target, data, mode, before):
            return 'written'
    return 'raced'

def seed_state(entries, first_run):
    target = os.path.realpath(os.path.join(os.path.expanduser('~'), '.claude.json'))
    wanted = {}
    for key, names in entries:
        merged = wanted.setdefault(key, [])
        for name in names + (FIRST_RUN_PROJECT_KEYS if first_run else ()):
            if name not in merged:
                merged.append(name)

    def edit(data):
        changed = False
        if first_run:
            if data.get('hasCompletedOnboarding') is not True:
                data['hasCompletedOnboarding'] = True
                changed = True
            if not isinstance(data.get('theme'), str) or not data.get('theme'):
                data['theme'] = DEFAULT_THEME
                changed = True
        projects = data.get('projects')
        if not isinstance(projects, dict):
            projects = {}
        for key, names in wanted.items():
            entry = projects.get(key)
            if entry is not None and not isinstance(entry, dict):
                continue
            following = dict(entry or {})
            declined = following.get('hasClaudeMdExternalIncludesApproved') is False and following.get('hasClaudeMdExternalIncludesWarningShown') is True
            touched = entry is None
            for name in names:
                if following.get(name) is True or (declined and name == 'hasClaudeMdExternalIncludesApproved'):
                    continue
                following[name] = True
                touched = True
            if touched:
                projects[key] = following
                data['projects'] = projects
                changed = True
        return changed

    # 0600 whatever the file had: it holds the account.
    return update_object(target, edit, 0o600)

def seed_settings():
    target = os.path.realpath(os.path.join(os.path.expanduser('~'), '.claude', 'settings.json'))

    def edit(data):
        if data.get('skipDangerousModePermissionPrompt') is True:
            return False
        data['skipDangerousModePermissionPrompt'] = True
        return True

    return update_object(target, edit)

def main(argv):
    flags = []
    while argv and argv[0].startswith('--'):
        flags.append(argv.pop(0))
    if any(flag not in FLAGS for flag in flags) or not argv:
        return 2
    first_run, bypass, named = '--first-run' in flags, '--bypass-permissions' in flags, '--named' in flags
    keys = trust_keys(argv[0], argv[1:])
    if keys is not None:
        entries, code = [(key, TRUST_KEYS) for key in keys], 0
    elif named:
        found = named_entries(argv[0])
        entries, code = ([], found) if isinstance(found, int) else (found, 0)
    else:
        entries, code = [], 3
    results = [seed_state(entries, first_run)] + ([seed_settings()] if bypass else [])
    if 'unreadable' in results:
        return 4
    if 'raced' in results:
        return 7
    return code

sys.exit(main(sys.argv[1:]))
`;


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
  // Every kit: the Claude launch line runs it whether or not the create pre-trusted the cwd.
  { path: REMOTE_TRUST_SEED_RELATIVE, content: REMOTE_TRUST_SEED_SCRIPT, mode: 0o600 },
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
 * What a create pre-trusts on the host: the cwd, the workspace directories D14 checks it against, and whether the
 * tab's creator named this cwd (`--named`, vel-PMX-FU), which lets the seed trust it outside every workspace.
 */
export interface IRemoteTrustTarget {
  cwd: string;
  workspaceDirectories: readonly string[];
  named: boolean;
}

/**
 * The create script's pre-trust line: run only when python3 exists, every failure ignored, so a seed never
 * blocks a launch (story 05 AC 2). Runs after the kit files land and before the session starts.
 */
export const remoteTrustSeedLine = (trust: IRemoteTrustTarget, cwdExpression = shQuote(trust.cwd)): string =>
  `if command -v python3 >/dev/null 2>&1; then python3 "$d/${REMOTE_TRUST_SEED_RELATIVE}" ${[
    ...(trust.named ? [shQuote('--named')] : []),
    cwdExpression,
    ...trust.workspaceDirectories.map(shQuote),
  ].join(' ')} >/dev/null 2>&1 || :; fi`;

/** The create script exits with this when the cwd its creator named is not a directory on the host (vel-PMX-FU). */
export const REMOTE_CWD_MISSING_EXIT = 19;

/**
 * A remote create refused because the cwd its creator named does not resolve to a directory on the host: the
 * session would otherwise start somewhere else, and its pre-trust would name a folder the pane never runs in.
 * Nothing was written and no session was started. 400 `cwd-missing`, as the route's own pre-check answers.
 */
export class RemoteCwdMissingError extends Error {
  constructor(readonly host: string, readonly cwd: string) {
    super(`${cwd} is not a directory on ${host}; create it there first (a remote worker uses its own checkout or worktree). No session was started`);
    this.name = 'RemoteCwdMissingError';
  }
}

/** What a create does when its cwd does not resolve on the host. */
export type TRemoteCwdMissing = 'refuse' | 'home';

/** The note a create prints when it starts the pane in HOME; the server logs it. */
export const REMOTE_CWD_FALLBACK_NOTE = 'the pane starts in HOME';

/**
 * The cwd resolved ON THE HOST, once, into `$pmux_cwd` (vel-PMX-FU, CI on PR #59): the trust seed and tmux's
 * `new-session -c` then get the same physical path, so they can never differ whatever tmux does with a symlink or a
 * "..". When it does not resolve:
 * - `refuse` (a fresh create of a cwd its creator named): exit 19 before any file is written.
 * - `home` (a revival, or the workspace default, a path on this server that a host often lacks): the pane starts in
 *   the remote HOME, as tmux used to by itself, with a note on stderr, and `$pmux_cwd_fallback` set so no seed runs.
 */
export const remoteCwdLines = (cwd: string, onMissing: TRemoteCwdMissing): string[] => [
  `pmux_cwd=$(cd -P -- ${shQuote(cwd)} 2>/dev/null && pwd -P) || pmux_cwd=''`,
  "pmux_cwd_fallback=''",
  onMissing === 'refuse'
    ? `if [ -z "$pmux_cwd" ]; then printf '%s\\n' ${shQuote(`pmux: cwd ${cwd} is not a directory on this host`)} >&2; exit ${REMOTE_CWD_MISSING_EXIT}; fi`
    : `if [ -z "$pmux_cwd" ]; then printf '%s\\n' ${shQuote(`pmux: cwd ${cwd} is not a directory on this host; ${REMOTE_CWD_FALLBACK_NOTE}`)} >&2; pmux_cwd="$HOME"; pmux_cwd_fallback=1; fi`,
];

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
 * `bin/purplemux`), pre-trust the cwd when it is inside a workspace directory or the creator named it (fail-open),
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
  /** Pre-trust the cwd (D14, and a named cwd, vel-PMX-FU): the kit files must include the trust-seed script. */
  trust?: IRemoteTrustTarget;
  /** When the cwd does not resolve on the host: refuse (a fresh named create) or start in HOME (default). */
  cwdMissing?: TRemoteCwdMissing;
}): string => {
  if (opts.trust && !opts.files.some((file) => file.path === REMOTE_TRUST_SEED_RELATIVE)) {
    throw new Error(`a pre-trust needs the kit file ${REMOTE_TRUST_SEED_RELATIVE}`);
  }
  const cliModules = kitCliModules(opts.files, 'a remote create');
  const sock = shQuote(remoteSocketName());
  const lines = [
    'set -e',
    remoteSessionExistsGuard(opts.session),
    ...(opts.cwd ? remoteCwdLines(opts.cwd, opts.cwdMissing ?? 'home') : []),
    ...kitWriteLines(opts.files, ['bin', 'tabs', 'hook-spool']),
    ...remoteKitProbeLines(cliModules),
    // No seed for a HOME fallback: the home is never trusted on a cwd's behalf (review r4).
    ...(opts.trust
      ? [opts.cwd ? `if [ -z "$pmux_cwd_fallback" ]; then ${remoteTrustSeedLine(opts.trust, '"$pmux_cwd"')}; fi` : remoteTrustSeedLine(opts.trust)]
      : []),
    [
      shQuote('tmux'), shQuote('-u'), shQuote('-L'), sock, shQuote('-f'), '"$d/tmux.conf"',
      ...['new-session', '-d', '-s', opts.session, '-x', String(opts.cols), '-y', String(opts.rows)].map(shQuote),
      ...(opts.cwd ? [shQuote('-c'), '"$pmux_cwd"'] : []),
      shQuote(opts.launch),
      ...remoteTagArgs(opts.session, opts.nonce).map(shQuote),
    ].join(' '),
    `${shQuote('tmux')} ${shQuote('-L')} ${sock} ${shQuote('source-file')} "$d/tmux.conf"`,
  ];
  return `${lines.join('\n')}\n`;
};
