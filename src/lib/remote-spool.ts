import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import { HOOK_SPOOL_DIR, HOOK_SPOOL_BAD_DIRNAME, drainHookSpool, parseSpooledHook, spooledHookQuery, type IHookSpoolDrainResult } from '@/lib/hook-spool';
import type { IHookDelivery } from '@/lib/hook-dispatch';
import { describeRemoteFailure, runSsh, shQuote } from '@/lib/remote-host';
import { remoteKitPath } from '@/lib/remote-kit';
import { remoteHostsInUse, sessionHostOf } from '@/lib/session-host';

/**
 * Remote hook events no server answered (ADR-0022, slice b). The remote hook
 * spools beside itself in the ADR-0020 file format; each drain moves those
 * files into this server's own spool, where the one drain replays them in time
 * order against each tab's floor. A file is taken only for a remote session of
 * the host it came from, as a remote delivery; anything else is deleted unread.
 *
 * Bounded (review r3, nits 2 and 6): only hosts that own a tab are asked; a
 * pull moves at most `REMOTE_SPOOL_BATCH` files and `REMOTE_SPOOL_BATCH_BYTES`
 * per host, so a backlog comes over in several drains; a file over
 * `REMOTE_SPOOL_FILE_MAX` is moved to the host's `hook-spool/bad/` and audited;
 * a host that fails is skipped for 30 s; and the pull runs beside the local
 * replay, never in front of it.
 */

const log = createLogger('hooks');

const REMOTE_SPOOL_NAME = /^(\d{1,16})-(\d{1,10})-([0-9a-f]{0,16})\.json$/;
/** Files per host per pull. */
export const REMOTE_SPOOL_BATCH = 200;
/** Bytes per host per pull, before base64: well inside the ssh output buffer (16 MiB). */
export const REMOTE_SPOOL_BATCH_BYTES = 4 * 1024 * 1024;
/** A hook spools at most a 256 KiB body plus metadata; a larger file is not a hook's. */
export const REMOTE_SPOOL_FILE_MAX = 512 * 1024;
const REMOTE_SPOOL_TIMEOUT_MS = 10_000;
const REMOTE_SPOOL_BACKOFF_MS = 30_000;

/**
 * One line per file: `file\t<name>\t<base64>` or `oversize\t<name>\t<bytes>`
 * (that file moved to `bad/`). The batch ends at the count or byte bound.
 */
export const remoteSpoolListScript = (): string => `d=${remoteKitPath('hook-spool')}
[ -d "$d" ] || exit 0
n=0; total=0
for f in "$d"/[0-9]*.json; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f")
  name=\${f##*/}
  if [ "$size" -gt ${REMOTE_SPOOL_FILE_MAX} ]; then
    mkdir -p -m 700 "$d/${HOOK_SPOOL_BAD_DIRNAME}" && mv -f "$f" "$d/${HOOK_SPOOL_BAD_DIRNAME}/$name"
    printf 'oversize\\t%s\\t%s\\n' "$name" "$size"
    continue
  fi
  n=$((n + 1)); total=$((total + size))
  if [ "$n" -gt ${REMOTE_SPOOL_BATCH} ] || { [ "$n" -gt 1 ] && [ "$total" -gt ${REMOTE_SPOOL_BATCH_BYTES} ]; }; then break; fi
  printf 'file\\t%s\\t' "$name"
  base64 -w0 < "$f"
  printf '\\n'
done
`;

export interface IRemoteSpoolPull {
  host: string;
  taken: number;
  dropped: number;
  quarantined: number;
}

const pullHost = async (host: string, spoolDir: string): Promise<IRemoteSpoolPull> => {
  const result: IRemoteSpoolPull = { host, taken: 0, dropped: 0, quarantined: 0 };
  const { stdout } = await runSsh(host, 'sh -s', { timeoutMs: REMOTE_SPOOL_TIMEOUT_MS, input: remoteSpoolListScript() });
  const done: string[] = [];
  for (const line of stdout.split('\n')) {
    const [kind, name, value] = line.split('\t');
    const match = name?.match(REMOTE_SPOOL_NAME);
    if (!match) continue;
    if (kind === 'oversize') {
      result.quarantined += 1;
      log.warn({ host, file: name, bytes: Number(value) }, 'remote hook spool file over the size bound, moved to bad/ on the host');
      await appendCoordinationAudit({ event: 'remote-hook-spool-quarantined', host, file: name, bytes: Number(value) });
      continue;
    }
    if (kind !== 'file') continue;
    done.push(name);
    const hook = parseSpooledHook(Buffer.from(value ?? '', 'base64').toString('utf-8'));
    const query = hook ? spooledHookQuery(hook.query) : null;
    if (!hook || query?.remote !== 'claude' || query.session !== hook.session || (await sessionHostOf(hook.session)) !== host) {
      result.dropped += 1;
      continue;
    }
    await fs.mkdir(spoolDir, { recursive: true, mode: 0o700 });
    const local = path.join(spoolDir, `${match[1]}-r${match[2]}-${match[3] || '0'}.json`);
    const tmp = path.join(spoolDir, `.${path.basename(local)}.tmp`);
    await fs.writeFile(tmp, JSON.stringify({ v: 1, at: hook.at, session: hook.session, query: hook.query, body: hook.body, ...(hook.bodyDropped ? { bodyDropped: true, bodyLength: hook.bodyLength } : {}) }), { mode: 0o600 });
    await fs.rename(tmp, local);
    result.taken += 1;
  }
  if (done.length > 0) {
    await runSsh(host, `cd ${remoteKitPath('hook-spool')} && rm -f -- ${done.map(shQuote).join(' ')}`, { timeoutMs: REMOTE_SPOOL_TIMEOUT_MS });
  }
  return result;
};

const g = globalThis as unknown as { __ptRemoteSpoolBackoff?: Map<string, number>; __ptRemoteSpoolPull?: Promise<IRemoteSpoolPull[]> | null };
if (!g.__ptRemoteSpoolBackoff) g.__ptRemoteSpoolBackoff = new Map();
const backoff = g.__ptRemoteSpoolBackoff;

/** Move the spooled remote hooks of every host that owns a tab into this server's spool. */
export const pullRemoteHookSpools = async (spoolDir = HOOK_SPOOL_DIR, now = Date.now): Promise<IRemoteSpoolPull[]> => {
  const hosts = (await remoteHostsInUse().catch(() => [] as string[])).filter((host) => (backoff.get(host) ?? 0) <= now());
  const pulls = await Promise.all(hosts.map(async (host) => {
    try {
      const pull = await pullHost(host, spoolDir);
      backoff.delete(host);
      return pull;
    } catch (err) {
      backoff.set(host, now() + REMOTE_SPOOL_BACKOFF_MS);
      log.warn({ host, failure: describeRemoteFailure(err) }, 'remote hook spool not pulled; host skipped for 30 s');
      return { host, taken: 0, dropped: 0, quarantined: 0 };
    }
  }));
  for (const pull of pulls) {
    if (pull.taken + pull.dropped + pull.quarantined > 0) {
      log.info(pull, `remote hook spool: ${pull.taken} taken, ${pull.dropped} dropped, ${pull.quarantined} quarantined from ${pull.host}`);
    }
  }
  return pulls;
};

/**
 * The status manager's drain. The remote pull runs beside it, one at a time,
 * and is never awaited: a slow host cannot hold the local replay. What a pull
 * moves here replays at the next drain (the boot's second drain comes 5 s after
 * the first; then every poll).
 */
export const drainHookSpoolsWithRemotePull = async (apply: (delivery: IHookDelivery) => Promise<unknown>): Promise<IHookSpoolDrainResult> => {
  if (!g.__ptRemoteSpoolPull) {
    g.__ptRemoteSpoolPull = pullRemoteHookSpools().finally(() => { g.__ptRemoteSpoolPull = null; });
  }
  return drainHookSpool(apply);
};
