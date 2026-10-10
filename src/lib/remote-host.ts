import { execFile } from 'child_process';
import { mkdirSync } from 'fs';
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

/** Expanded by the remote shell; `originName` is `[a-z0-9-]` only. */
export const remoteBaseDir = (): string => `"$HOME"/.purplemux-remote/${originName()}`;

export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export const remoteTmuxCommand = (args: readonly string[]): string =>
  ['tmux', '-L', remoteSocketName(), ...args].map(shQuote).join(' ');

/** A unix socket path must fit sun_path (108 bytes); `%C` expands to 40 hex characters. */
const CONTROL_PATH_MAX = 100;
const NO_MULTIPLEX = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none'];

export const sshControlDir = (): string => path.join(os.homedir(), '.purplemux', 'ssh');

const controlOptions = (): string[] => {
  const dir = sshControlDir();
  if (dir.length + 1 + 40 > CONTROL_PATH_MAX) return NO_MULTIPLEX;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return NO_MULTIPLEX;
  }
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${dir}/%C`, '-o', 'ControlPersist=600'];
};

export const sshArgv = (host: string, remoteCommand: string, opts: { tty?: boolean } = {}): string[] => {
  if (!isValidRemoteHostName(host)) throw new Error(`invalid remote host name: ${JSON.stringify(host)}`);
  return [
    ...(opts.tty ? ['-tt'] : []),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    ...controlOptions(),
    '--', host, remoteCommand,
  ];
};

/** ssh itself failed (no connection, refused key): nothing ran on the remote host. */
export const SSH_FAILURE_EXIT = 255;

export interface IRemoteExecError extends Error {
  code?: number | string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}

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
export const REMOTE_REAP_SCRIPT = `sock=$1; session=$2; tab=$3; keep=$4
srv=$(tmux -L "$sock" display-message -p '#{pid}' 2>/dev/null)
pane=$(tmux -L "$sock" display-message -p -t "=$session:" '#{pane_pid}' 2>/dev/null)
marker=unknown
if [ -n "$pane" ] && [ -n "$tab" ] && [ -r "/proc/$pane/environ" ]; then
  if grep -qzx "PMUX_TAB_ID=$tab" "/proc/$pane/environ" 2>/dev/null; then marker=present; else marker=absent; fi
fi
descendants() {
  for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do echo "$c"; descendants "$c"; done
}
marked() {
  [ -n "$tab" ] || return 0
  grep -lzx "PMUX_TAB_ID=$tab" /proc/[0-9]*/environ 2>/dev/null | sed 's#^/proc/##; s#/environ$##'
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

export const reapCommand = (session: string, tabId: string | undefined, keepProcesses: boolean): string =>
  ['sh', '-s', '--', remoteSocketName(), session, tabId ?? '', keepProcesses || !tabId ? '1' : '0'].map(shQuote).join(' ');

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
