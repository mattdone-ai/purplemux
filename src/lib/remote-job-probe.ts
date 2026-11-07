import { randomBytes } from 'crypto';
import { describeRemoteFailure, runSsh, shQuote } from '@/lib/remote-host';
import type { IBackgroundJob } from '@/types/liveness';

/**
 * Background jobs a remote tab registered are judged on their own host
 * (D63): one `sh -s --` exec per host per pass, every job of that host in it.
 * The pid's procfs state, the exit-code file and the stderr tail are read
 * there; file bytes come back in base64, so no file can forge a reply line.
 */

/** Read from the tail of the exit-code file: one byte over the bound, so an oversized file is seen as one. */
export const REMOTE_EXIT_TAIL_BYTES = 65;
export const REMOTE_STDERR_TAIL_BYTES = 2_048;
export const REMOTE_JOB_PROBE_TIMEOUT_MS = 10_000;

/**
 * Arguments: NONCE, then PID EXIT_FILE STDERR_FILE per job (an empty file
 * argument names no file). Output: `begin\tNONCE`, then `<i>\talive` or
 * `<i>\texited\t<file>\t<file>` per job, where a file is `-` (not named or not
 * readable, or `tail` or `base64 -w0` failed there: their status comes back on
 * fd 3, so a failure never reads as an empty file) or `b<base64 of its
 * tail>`, then `end\tNONCE\t<count>`. A host with no procfs answers `noproc`
 * alone: there it cannot tell a live pid.
 */
export const REMOTE_JOB_PROBE_SCRIPT = `nonce=$1; shift
[ -d /proc/self ] || { printf 'noproc\\n'; exit 0; }
printf 'begin\\t%s\\n' "$nonce"
i=0
tailof() {
  [ -n "$1" ] && [ -r "$1" ] || { printf '%s' -; return 0; }
  r=$( { { tail -c "$2" -- "$1" 2>/dev/null; printf 't%s\\n' "$?" >&3; } | { d=$(base64 -w0 2>/dev/null) && printf 'd%s\\n' "$d" >&3 || printf 'x\\n' >&3; }; } 3>&1 )
  t=$(printf '%s\\n' "$r" | sed -n 's/^t//p'); d=$(printf '%s\\n' "$r" | grep '^d')
  if [ "$t" = 0 ] && [ -n "$d" ]; then printf 'b%s' "\${d#d}"; else printf '%s' -; fi
}
while [ $# -ge 3 ]; do
  pid=$1; ef=$2; sf=$3; shift 3
  st=$(sed 's/.*) //' "/proc/$pid/stat" 2>/dev/null | cut -d' ' -f1)
  if [ -n "$st" ] && [ "$st" != Z ] && [ "$st" != X ]; then
    printf '%s\\talive\\n' "$i"
  else
    printf '%s\\texited\\t%s\\t%s\\n' "$i" "$(tailof "$ef" ${REMOTE_EXIT_TAIL_BYTES})" "$(tailof "$sf" ${REMOTE_STDERR_TAIL_BYTES})"
  fi
  i=$((i + 1))
done
printf 'end\\t%s\\t%s\\n' "$nonce" "$i"
`;

export type TRemoteJobReading =
  | { state: 'alive' }
  /** `null`: no file named, or it could not be read on the host. */
  | { state: 'exited'; exitCodeRaw: string | null; stderrRaw: string | null };

export const remoteJobProbeCommand = (nonce: string, jobs: readonly IBackgroundJob[]): string =>
  ['sh', '-s', '--', nonce, ...jobs.flatMap((job) => [String(job.pid), job.exitCodeFile ?? '', job.stderrFile ?? ''])]
    .map(shQuote)
    .join(' ');

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const decodeFile = (field: string): string | null | undefined => {
  if (field === '-') return null;
  if (!field.startsWith('b')) return undefined;
  const b64 = field.slice(1);
  if (b64.length % 4 !== 0 || !BASE64.test(b64)) return undefined;
  return Buffer.from(b64, 'base64').toString('utf-8');
};

/**
 * The readings of one probe, in the order the jobs were sent, or why the reply
 * is refused. Only one complete frame carrying this probe's nonce counts; lines
 * outside it (a login banner) are ignored, and inside it the parse is strict.
 */
export const parseRemoteJobProbe = (
  stdout: string,
  nonce: string,
  count: number,
): { ok: true; readings: TRemoteJobReading[] } | { ok: false; reason: string } => {
  const lines = stdout.split('\n');
  if (lines.some((line) => line === 'noproc')) return { ok: false, reason: 'the host has no procfs' };
  const begins = lines.flatMap((line, i) => (line === `begin\t${nonce}` ? [i] : []));
  if (begins.length !== 1) return { ok: false, reason: begins.length === 0 ? 'no reply frame' : 'more than one reply frame' };
  const endAt = lines.findIndex((line, i) => i > begins[0] && line.startsWith(`end\t${nonce}\t`));
  if (endAt === -1) return { ok: false, reason: 'the reply frame never ended' };
  if (lines[endAt] !== `end\t${nonce}\t${count}`) return { ok: false, reason: `the reply counted ${lines[endAt].split('\t')[2]} jobs, ${count} were sent` };
  const readings: Array<TRemoteJobReading | undefined> = new Array(count).fill(undefined);
  for (const line of lines.slice(begins[0] + 1, endAt)) {
    const [index, verb, ...files] = line.split('\t');
    const i = /^\d+$/.test(index) ? Number(index) : -1;
    if (i < 0 || i >= count || readings[i]) return { ok: false, reason: `bad or repeated job index in ${JSON.stringify(line.slice(0, 40))}` };
    if (verb === 'alive' && files.length === 0) {
      readings[i] = { state: 'alive' };
      continue;
    }
    const [exitCodeRaw, stderrRaw] = files.map(decodeFile);
    if (verb !== 'exited' || files.length !== 2 || exitCodeRaw === undefined || stderrRaw === undefined) {
      return { ok: false, reason: `unreadable reply line ${JSON.stringify(line.slice(0, 40))}` };
    }
    readings[i] = { state: 'exited', exitCodeRaw, stderrRaw };
  }
  if (readings.some((r) => r === undefined)) return { ok: false, reason: 'the reply left out a job' };
  return { ok: true, readings: readings as TRemoteJobReading[] };
};

/** Judge `jobs` on `host` in one exec. Rejects when ssh fails or the reply is refused: the jobs' state is then unknown. */
export const probeRemoteJobs = async (host: string, jobs: readonly IBackgroundJob[]): Promise<TRemoteJobReading[]> => {
  const nonce = randomBytes(8).toString('hex');
  let stdout: string;
  try {
    ({ stdout } = await runSsh(host, remoteJobProbeCommand(nonce, jobs), { timeoutMs: REMOTE_JOB_PROBE_TIMEOUT_MS, input: REMOTE_JOB_PROBE_SCRIPT }));
  } catch (err) {
    throw new Error(`ssh to ${host} failed (${describeRemoteFailure(err)})`);
  }
  const parsed = parseRemoteJobProbe(stdout, nonce, jobs.length);
  if (!parsed.ok) throw new Error(`${host} gave no usable reply: ${parsed.reason}`);
  return parsed.readings;
};
