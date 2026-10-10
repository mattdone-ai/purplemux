import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { readFleetConfig, valueOf } from '@/lib/fleet-config-store';
import type { IReapedProcess, IReapResult } from '@/lib/tab-reaper';

/**
 * Remote tabs (ADR-0022): a tab whose tmux session runs on another host, driven
 * from this server over ssh. This module owns the host registry, the ssh
 * invocation and the scripts that run on the remote host; `tmux.ts` decides
 * which calls go there.
 */

export const REMOTE_HOSTS_KEY = 'remote.hosts';

// An ssh alias, never an option: no leading '-', no whitespace, no shell syntax.
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const isValidRemoteHostName = (value: unknown): value is string =>
  typeof value === 'string' && HOST_NAME.test(value);

export const parseRemoteHosts = (raw: string | null | undefined): string[] =>
  [...new Set((raw ?? '').split(',').map((h) => h.trim()).filter(isValidRemoteHostName))];

/** The registered hosts. Throws when the fleet config is unreadable (ADR-0019: never read as empty). */
export const readRemoteHosts = async (): Promise<string[]> =>
  parseRemoteHosts(valueOf(await readFleetConfig(), REMOTE_HOSTS_KEY)?.value);

export const REMOTE_CALLBACK_URL_KEY = 'remote.callback-url';

const CALLBACK_URL = /^(https?):\/\/([A-Za-z0-9.-]+)(?::\d{1,5})?$/;

/** A host an http callback may name: loopback, a Tailscale address or name, or a bare (MagicDNS) name. */
const TAILNET_LOOKING = (host: string): boolean => {
  if (host === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/\.ts\.net$/i.test(host)) return true;
  const ip = host.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ip) return Number(ip[1]) === 100 && Number(ip[2]) >= 64 && Number(ip[2]) <= 127;
  return !host.includes('.');
};

/**
 * Why a callback URL is refused, or null (review r3 nit 4). A tab's token rides
 * every hook and CLI call to it: plain http only to a loopback or tailnet-looking
 * host (WireGuard carries it there); anything else must be https.
 */
export const callbackUrlRefusal = (value: unknown): string | null => {
  const m = typeof value === 'string' ? value.match(CALLBACK_URL) : null;
  if (!m) return `${REMOTE_CALLBACK_URL_KEY} must be http(s)://host[:port]`;
  if (m[1] === 'http' && !TAILNET_LOOKING(m[2])) return `${REMOTE_CALLBACK_URL_KEY} over plain http must name a loopback or tailnet host (100.64.0.0/10, *.ts.net, a bare MagicDNS name); use https otherwise`;
  return null;
};

export const isValidCallbackUrl = (value: unknown): value is string => callbackUrlRefusal(value) === null;

const serverPort = (): string => {
  if (process.env.PORT && /^\d{1,5}$/.test(process.env.PORT)) return process.env.PORT;
  try {
    const port = readFileSync(path.join(os.homedir(), '.purplemux', 'port'), 'utf-8').trim();
    if (/^\d{1,5}$/.test(port)) return port;
  } catch {
    // no port file: the default below
  }
  return '8022';
};

/**
 * Where a remote tab's hooks and CLI reach this server: fleet config
 * `remote.callback-url`, else `http://<this hostname>:<port>` (a Tailscale
 * name answers on the tailnet). Throws when the fleet config is unreadable.
 */
export const resolveCallbackUrl = async (): Promise<string> => {
  const configured = valueOf(await readFleetConfig(), REMOTE_CALLBACK_URL_KEY)?.value;
  const url = configured ?? `http://${os.hostname()}:${serverPort()}`;
  const refusal = callbackUrlRefusal(url);
  if (refusal) throw new Error(`${refusal} (${configured === undefined ? 'the default from this hostname' : 'fleet config'}: ${JSON.stringify(url)})`);
  return url;
};

/** This server's name on a remote host: it keys the remote socket and config directory. */
export const originName = (): string => {
  const name = os.hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return name || 'origin';
};

/**
 * Never `purple`: the remote host may run its own purplemux on that socket, and
 * its scans must not see this server's sessions.
 */
export const remoteSocketName = (): string => `pmux-${originName()}`;

export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const remoteTmuxCommand = (args: readonly string[]): string =>
  ['tmux', '-L', remoteSocketName(), ...args].map(shQuote).join(' ');

/** The remote script exits with this when the session name is already taken: never touch that session. */
export const REMOTE_SESSION_EXISTS_EXIT = 17;

/**
 * Guards of a remote create (ADR-0022 §8). A name that already exists is never
 * replaced; the created session carries this call's nonce, and a failed create
 * kills a session only when it carries that nonce, so a failure can never end
 * a live session of the same name (review r1, B2).
 */
export const remoteSessionExistsGuard = (session: string): string =>
  `if ${remoteTmuxCommand(['has-session', '-t', `=${session}`])} 2>/dev/null; then echo ${shQuote(`pmux: session ${session} already exists`)} >&2; exit ${REMOTE_SESSION_EXISTS_EXIT}; fi`;

/**
 * Appended to the `new-session` arguments: tmux runs it in the same client
 * command, so no dropped connection can leave the new session untagged
 * (review r2 nit 1).
 */
export const remoteTagArgs = (session: string, nonce: string): string[] =>
  [';', 'set-option', '-t', `=${session}:`, '@pmux-create', nonce];

export const remoteKillIfTagged = (session: string, nonce: string): string =>
  `[ "$(${remoteTmuxCommand(['show-options', '-qv', '-t', `=${session}:`, '@pmux-create'])} 2>/dev/null)" = ${shQuote(nonce)} ] && ${remoteTmuxCommand(['kill-session', '-t', `=${session}`])}; true`;

const TMUX_ABSENCE = /^(can't find (session|window)|no such session|no server running on |error connecting to .*\(No such file or directory\))/;

/**
 * tmux's own word that a session or server does not exist (exit 1), as opposed
 * to ssh or a timeout failing. Any stderr line counts: ssh or the remote
 * shell's start-up may print before it (review r2 nit 2).
 */
export const isTmuxAbsence = (err: unknown): boolean => {
  const e = err as IRemoteExecError | null;
  if (!e || e.code !== 1 || e.killed || e.signal) return false;
  return (e.stderr ?? '').split('\n').some((line) => TMUX_ABSENCE.test(line.trim()));
};

export const sshArgv = (host: string, remoteCommand: string, opts: { tty?: boolean } = {}): string[] => {
  if (!isValidRemoteHostName(host)) throw new Error(`invalid remote host name: ${JSON.stringify(host)}`);
  return [
    ...(opts.tty ? ['-tt'] : []),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // No ControlMaster (ADR-0022 §5): a first multiplexed connection exited 255 with no stderr in 1
    // of 10 fresh control directories, and a dead master stalls every call until ServerAlive gives up.
    '-o', 'ControlMaster=no',
    '-o', 'ControlPath=none',
    '--', host, remoteCommand,
  ];
};

/** ssh's own failure status. Not proof that nothing ran: a connection lost after the command started also ends in 255. */
export const SSH_FAILURE_EXIT = 255;

export interface IRemoteExecError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

/** What failed, without the command line (it can carry a whole script): exit status, timeout, stderr. */
export const describeRemoteFailure = (err: unknown): string => {
  const e = (err ?? {}) as IRemoteExecError;
  const status = e.killed ? 'timed out' : e.signal ? `signal ${e.signal}` : `exit ${e.code ?? 'unknown'}`;
  const stderr = e.stderr?.trim();
  return stderr ? `${status}: ${stderr.slice(-500)}` : status;
};

export const isSshFailure = (err: unknown): boolean => {
  const e = err as IRemoteExecError | null;
  return !!e && (e.code === SSH_FAILURE_EXIT || e.killed === true || typeof e.code === 'string');
};

/**
 * Run one command on `host`. Rejects like `execFile`: `code` is the remote exit
 * status, or 255 when ssh itself failed; `stdout`/`stderr` are attached.
 */
export const runSsh = (
  host: string,
  command: string,
  opts: { timeoutMs: number; input?: string },
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      sshArgv(host, command),
      { timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    child?.stdin?.on('error', () => {});
    child?.stdin?.end(opts.input ?? '');
  });

/** `runSsh` with stdout as bytes: a transcript chunk can end inside a multi-byte character. */
export const runSshBuffer = (
  host: string,
  command: string,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      sshArgv(host, command),
      { timeout: opts.timeoutMs, maxBuffer: opts.maxBytes + 64 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : String(stderr ?? '') }));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout)));
      },
    );
    child?.stdin?.on('error', () => {});
    child?.stdin?.end();
  });

export class RemoteHostError extends Error {
  constructor(readonly host: string, message: string) {
    super(message);
    this.name = 'RemoteHostError';
  }
}

/**
 * The close step on the remote host (ADR-0016 rules, ADR-0022 §9), as one
 * `sh -s -- SOCKET SESSION TAB KEEP` run. The tab-owned set is the pane's
 * descendants plus every process of the user whose environment holds exactly
 * `PMUX_TAB_ID=<TAB>`. Never signalled: this script, the remote tmux server and
 * pid 1. SIGTERM (+ SIGCONT), up to 3 s of grace, SIGKILL, one rescan for late
 * forks. `KEEP=1` signals the pane's process group only.
 *
 * Output, one line each: `marker\t<present|absent|unknown>`, then
 * `killed\t<pid>\t<comm>\t<args>` or `survivor\t…`, then `session\t<gone|present>`.
 */
export const REMOTE_REAP_SCRIPT = `sock=$1; session=$2; tab=$3; keep=$4; origin=$5
[ -n "$tab" ] && [ -n "$origin" ] && rm -f "$HOME/.purplemux-remote/$origin/tabs/$tab.env"
srv=$(tmux -L "$sock" display-message -p '#{pid}' 2>/dev/null)
pane=$(tmux -L "$sock" display-message -p -t "=$session:" '#{pane_pid}' 2>/dev/null)
marker=unknown
if [ -n "$pane" ] && [ -n "$tab" ] && [ -r "/proc/$pane/environ" ]; then
  if grep -qzxF "PMUX_TAB_ID=$tab" "/proc/$pane/environ" 2>/dev/null; then marker=present; else marker=absent; fi
fi
descendants() {
  for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do echo "$c"; descendants "$c"; done
}
marked() {
  [ -n "$tab" ] || return 0
  grep -lzxF "PMUX_TAB_ID=$tab" /proc/[0-9]*/environ 2>/dev/null | sed 's#^/proc/##; s#/environ$##'
}
eligible() {
  case "$1" in ''|0|1|"$$"|"$srv"|"$pane") return 1 ;; esac
  case "$1" in *[!0-9]*) return 1 ;; esac
  return 0
}
alive() {
  st=$(sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1)
  [ -n "$st" ] && [ "$st" != Z ] && [ "$st" != X ]
}
targets=""
if [ "$keep" != 1 ]; then
  for p in $( [ -n "$pane" ] && descendants "$pane"; marked ); do
    eligible "$p" || continue
    case " $targets " in *" $p "*) continue ;; esac
    targets="$targets $p"
  done
fi
describe() {
  comm=$(cat "/proc/$1/comm" 2>/dev/null)
  args=$(tr '\\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | cut -c1-200)
  printf '%s\\t%s\\t%s' "$1" "$comm" "$args"
}
descs=""
for p in $targets; do descs="$descs$(describe "$p")
"; done
[ -n "$pane" ] && kill -TERM -- "-$pane" 2>/dev/null
for p in $targets; do kill -TERM "$p" 2>/dev/null; kill -CONT "$p" 2>/dev/null; done
tmux -L "$sock" kill-session -t "=$session" 2>/dev/null
i=0
left="$targets"
while [ -n "$left" ] && [ $i -lt 30 ]; do
  next=""
  for p in $left; do alive "$p" && next="$next $p"; done
  left="$next"
  [ -n "$left" ] && sleep 0.1
  i=$((i + 1))
done
for p in $left; do kill -KILL "$p" 2>/dev/null; done
if [ "$keep" != 1 ]; then
  for p in $(marked); do
    eligible "$p" || continue
    case " $targets " in *" $p "*) continue ;; esac
    descs="$descs$(describe "$p")
"
    targets="$targets $p"
    kill -KILL "$p" 2>/dev/null
  done
fi
[ -n "$targets" ] && sleep 0.3
printf 'marker\\t%s\\n' "$marker"
printf '%s' "$descs" | while IFS= read -r line; do
  [ -n "$line" ] || continue
  p=\${line%%\t*}
  if alive "$p"; then printf 'survivor\\t%s\\n' "$line"; else printf 'killed\\t%s\\n' "$line"; fi
done
if tmux -L "$sock" has-session -t "=$session" 2>/dev/null; then printf 'session\\tpresent\\n'; else printf 'session\\tgone\\n'; fi
`;

/**
 * The remote twin of `observeProviderProcess` (ADR-0021 strict identity,
 * ADR-0022 slice b), as one `sh -s -- SOCKET SESSION PROVIDER` run: the
 * session's one pane, then the pane's descendants (bounded at 512) for the
 * provider's executable, `comm`, or a node/bun entrypoint. Output, one line:
 * `present\t<pane id>\t<pane pid>\t<pid>\t<start time>`, `absent\t<reason>` or
 * `unknown\t<reason>`. tmux's own "no such session" is absent.
 */
export const REMOTE_PROVIDER_SCRIPT = `sock=$1; session=$2; want=$3
out=$(tmux -L "$sock" list-panes -t "=$session:" -F '#{session_name}\t#{pane_id}\t#{pane_pid}' 2>&1)
rc=$?
if [ $rc -ne 0 ]; then
  case "$out" in *"can't find"*|*"no server running"*|*"No such file or directory"*) printf 'absent\tsession gone\n' ;; *) printf 'unknown\ttmux failed\n' ;; esac
  exit 0
fi
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ] || { printf 'unknown\tsession identity ambiguous\n'; exit 0; }
name=$(printf '%s' "$out" | cut -f1); pane=$(printf '%s' "$out" | cut -f2); root=$(printf '%s' "$out" | cut -f3)
[ "$name" = "$session" ] || { printf 'unknown\tsession identity changed\n'; exit 0; }
check() {
  comm=$(cat /proc/"$1"/comm 2>/dev/null)
  argv0=$(tr '\\0' '\\n' < /proc/"$1"/cmdline 2>/dev/null | sed -n 1p)
  entry=$(tr '\\0' '\\n' < /proc/"$1"/cmdline 2>/dev/null | sed -n 2p)
  exe=\${argv0##*/}
  match=0
  if [ "$exe" = "$want" ] || [ "$comm" = "$want" ]; then match=1; fi
  case "$exe" in node|bun) case "$entry" in */"$want".js|*/@anthropic-ai/claude-code/*) match=1 ;; esac ;; esac
  [ $match -eq 1 ] || return 0
  start=$(sed 's/.*) //' /proc/"$1"/stat 2>/dev/null | cut -d' ' -f20)
  [ -n "$start" ] || { printf 'unknown\tprocess start identity unavailable\n'; exit 0; }
  printf 'present\t%s\t%s\t%s\t%s\n' "$pane" "$root" "$1" "$start"
  exit 0
}
check "$root"
frontier=$root; seen=0
while [ -n "$frontier" ]; do
  next=""
  for p in $frontier; do
    for c in $(cat /proc/"$p"/task/*/children 2>/dev/null); do
      seen=$((seen + 1))
      [ $seen -gt 512 ] && { printf 'unknown\tprocess inventory bound exceeded\n'; exit 0; }
      next="$next $c"
      check "$c"
    done
  done
  frontier=$next
done
printf 'absent\tno %s process in the pane\n' "$want"
`;

export type TRemoteProviderObservation =
  | { state: 'present'; paneId: string; panePid: string; pid: string; start: string }
  | { state: 'absent' | 'unknown'; reason: string };

export const parseRemoteProviderObservation = (stdout: string): TRemoteProviderObservation => {
  const [kind, ...rest] = stdout.trim().split('\n').at(-1)?.split('\t') ?? [];
  if (kind === 'present' && rest.length === 4 && rest.every(Boolean)) {
    return { state: 'present', paneId: rest[0], panePid: rest[1], pid: rest[2], start: rest[3] };
  }
  if (kind === 'absent') return { state: 'absent', reason: rest.join(' ') || 'absent' };
  return { state: 'unknown', reason: kind === 'unknown' ? rest.join(' ') : 'unreadable remote observation' };
};

export const reapCommand = (session: string, tabId: string | undefined, keepProcesses: boolean): string =>
  ['sh', '-s', '--', remoteSocketName(), session, tabId ?? '', keepProcesses || !tabId ? '1' : '0', originName()].map(shQuote).join(' ');

/** Whether `dir` is a directory on `host`. Throws `RemoteHostError` when ssh fails. */
export const remoteDirExists = async (host: string, dir: string): Promise<boolean> => {
  try {
    await runSsh(host, `test -d ${shQuote(dir)}`, { timeoutMs: 10_000 });
    return true;
  } catch (err) {
    if (isSshFailure(err)) throw new RemoteHostError(host, `remote host ${host} did not answer over ssh (${describeRemoteFailure(err)})`);
    return false;
  }
};

export interface IRemoteReapResult extends IReapResult {
  sessionGone: boolean;
}


const toProcess = (fields: string[]): IReapedProcess | null => {
  const pid = Number(fields[0]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, comm: fields[1] ?? '', args: (fields.slice(2).join('\t') ?? '').trim() };
};

export const parseRemoteReap = (stdout: string): IRemoteReapResult => {
  const result: IRemoteReapResult = { reaper: 'remote', envMarker: 'unknown', killed: [], survivors: [], sessionGone: false };
  for (const line of stdout.split('\n')) {
    const [kind, ...rest] = line.split('\t');
    if (kind === 'marker' && (rest[0] === 'present' || rest[0] === 'absent')) result.envMarker = rest[0];
    else if (kind === 'killed' || kind === 'survivor') {
      const proc = toProcess(rest);
      if (proc) (kind === 'killed' ? result.killed : result.survivors).push(proc);
    } else if (kind === 'session') result.sessionGone = rest[0] === 'gone';
  }
  return result;
};
