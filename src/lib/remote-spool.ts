import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '@/lib/logger';
import { HOOK_SPOOL_DIR, drainHookSpool, parseSpooledHook, spooledHookQuery, type IHookSpoolDrainResult } from '@/lib/hook-spool';
import type { IHookDelivery } from '@/lib/hook-dispatch';
import { describeRemoteFailure, readRemoteHosts, runSsh, shQuote } from '@/lib/remote-host';
import { remoteKitPath } from '@/lib/remote-kit';
import { knownRemoteHosts, sessionHostOf } from '@/lib/session-host';

/**
 * Remote hook events no server answered (ADR-0022, slice b). The remote hook
 * spools beside itself in the ADR-0020 file format; each drain first moves
 * those files into this server's own spool, where the one drain replays them
 * in time order against each tab's floor. A file is taken only for a remote
 * session of the host it came from, as a remote delivery; anything else is
 * deleted unread.
 */

const log = createLogger('hooks');

const REMOTE_SPOOL_NAME = /^(\d{1,16})-(\d{1,10})-([0-9a-f]{0,16})\.json$/;
/** Files per host per drain: a large backlog comes over in several drains. */
export const REMOTE_SPOOL_BATCH = 200;

const listScript = (): string => `d=${remoteKitPath('hook-spool')}
[ -d "$d" ] || exit 0
n=0
for f in "$d"/[0-9]*.json; do
  [ -f "$f" ] || continue
  n=$((n + 1))
  [ "$n" -gt ${REMOTE_SPOOL_BATCH} ] && break
  printf '%s\\n' "\${f##*/}"
  base64 -w0 < "$f"
  printf '\\n'
done
`;

export interface IRemoteSpoolPull {
  host: string;
  taken: number;
  dropped: number;
}

const pullHost = async (host: string, spoolDir: string): Promise<IRemoteSpoolPull> => {
  const result: IRemoteSpoolPull = { host, taken: 0, dropped: 0 };
  const { stdout } = await runSsh(host, 'sh -s', { timeoutMs: 20_000, input: listScript() });
  const lines = stdout.split('\n');
  const done: string[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const name = lines[i];
    const match = name.match(REMOTE_SPOOL_NAME);
    if (!match) continue;
    done.push(name);
    const hook = parseSpooledHook(Buffer.from(lines[i + 1], 'base64').toString('utf-8'));
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
    await runSsh(host, `cd ${remoteKitPath('hook-spool')} && rm -f -- ${done.map(shQuote).join(' ')}`, { timeoutMs: 10_000 });
  }
  return result;
};

/** Move every registered host's spooled remote hooks into this server's spool. A host that does not answer keeps its files. */
export const pullRemoteHookSpools = async (spoolDir = HOOK_SPOOL_DIR): Promise<IRemoteSpoolPull[]> => {
  const registered = await readRemoteHosts().catch(() => [] as string[]);
  const hosts = [...new Set([...registered, ...knownRemoteHosts()])];
  const pulls = await Promise.all(hosts.map(async (host) => {
    try {
      return await pullHost(host, spoolDir);
    } catch (err) {
      log.debug({ host, failure: describeRemoteFailure(err) }, 'remote hook spool not pulled');
      return { host, taken: 0, dropped: 0 };
    }
  }));
  for (const pull of pulls) {
    if (pull.taken + pull.dropped > 0) log.info(pull, `remote hook spool: ${pull.taken} taken, ${pull.dropped} dropped from ${pull.host}`);
  }
  return pulls;
};

/** The status manager's drain: remote spools come over first, then this server's spool replays (ADR-0020, ADR-0022). */
export const drainRemoteThenLocalHookSpools = async (apply: (delivery: IHookDelivery) => Promise<unknown>): Promise<IHookSpoolDrainResult> => {
  await pullRemoteHookSpools().catch(() => []);
  return drainHookSpool(apply);
};
