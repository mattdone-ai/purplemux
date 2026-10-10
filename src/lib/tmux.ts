import { execFile as execFileCb } from 'child_process';
import fs from 'fs/promises';
import { promisify } from 'util';
import path from 'path';
import { nanoid } from 'nanoid';
import { PRISTINE_ENV } from '@/lib/pristine-env';
import { buildRemoteShellLaunchCommand, buildShellLaunchCommand } from '@/lib/shell-env';
import { ensureWorkspaceGrokHome } from '@/lib/grok-home';
import { writeGrokHookFile } from '@/lib/providers/grok/hook-config';
import { GROK_HOOK_SCRIPT_PATH } from '@/lib/providers/grok/paths';
import { ensureWorkspaceClaudeHome, workspaceIdFromSessionName } from '@/lib/workspace-home';
import { getWorkspaceToken } from '@/lib/workspace-token';
import { ensureTabToken, type ITabIdentity } from '@/lib/tab-token';
import { createLogger } from '@/lib/logger';
import { isLinux } from '@/lib/platform';
import { getProcessArgs, readProcChildren, type TStrictRuntimeObservation } from '@/lib/process-utils';
import { PASTE_END, PASTE_START, TYPED_CHUNK_GAP_MS, planTypedInput } from '@/lib/typed-input';
import { defaultReaperDeps, reapTabForClose, type IReapResult } from '@/lib/tab-reaper';
import { appendCoordinationAudit } from '@/lib/coordination-audit';
import {
  REMOTE_SESSION_EXISTS_EXIT,
  RemoteHostError,
  describeRemoteFailure,
  isSshFailure,
  isTmuxAbsence,
  remoteKillIfTagged,
  parseRemoteReap,
  reapCommand,
  readRemoteHosts,
  remoteTmuxCommand,
  REMOTE_PROVIDER_SCRIPT,
  REMOTE_REAP_SCRIPT,
  parseRemoteProviderObservation,
  remoteSocketName,
  resolveCallbackUrl,
  shQuote,
  runSsh,
} from '@/lib/remote-host';
import { buildRemoteCreateScript, remoteKitFiles, remoteKitPath, remoteTabEnvFile, remoteTabEnvRelative } from '@/lib/remote-kit';
import { knownRemoteHosts, remoteHostsInUse, sessionHostOf } from '@/lib/session-host';

const log = createLogger('terminal');

const execFile = promisify(execFileCb);

const TMUX_SOCKET = 'purple';
const TMUX_CONFIG_PATH = path.join(process.env.__PMUX_APP_DIR_UNPACKED || process.env.__PMUX_APP_DIR || process.cwd(), 'src', 'config', 'tmux.conf');
const CLI_JS_PATH = path.join(process.env.__PMUX_APP_DIR_UNPACKED || process.env.__PMUX_APP_DIR || process.cwd(), 'bin', 'cli.js');
const CMD_TIMEOUT = 5000;
/** A remote close waits out the reap script's 3 s grace and settle on top of the ssh round trip. */
const REMOTE_REAP_TIMEOUT = 20_000;

/**
 * One tmux call for a session, wherever it runs (ADR-0022): the local `purple`
 * socket, or `ssh <host> tmux -L pmux-<origin>` with the same arguments.
 */
const runTmux = async (sessionName: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
  const host = await sessionHostOf(sessionName);
  if (host) return runSsh(host, remoteTmuxCommand(args), { timeoutMs: CMD_TIMEOUT });
  return execFile('tmux', ['-L', TMUX_SOCKET, ...args], { timeout: CMD_TIMEOUT });
};

export const listSessions = async (): Promise<string[]> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'ls', '-F', '#{session_name}'],
      { timeout: CMD_TIMEOUT },
    );
    return stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.startsWith('pt-'));
  } catch {
    return [];
  }
};

/**
 * Per-workspace environment for a pane's login shell.
 *
 * CLAUDE_CONFIG_DIR and GROK_HOME give the workspace its own session store per
 * agent, so two workspaces launched from the same directory no longer share
 * conversation history or resume lists. PMUX_TOKEN confines the CLI in this pane
 * to its own workspace — `bin/cli.js` already prefers the env var over the
 * global token file.
 *
 * The grok hook file is written here as well as at boot: a workspace created
 * after the server started has no home yet, and a pane that launched without
 * hooks would report no work state at all.
 */
const workspaceEnv = async (sessionName: string, identity?: ITabIdentity): Promise<Record<string, string>> => {
  const wsId = workspaceIdFromSessionName(sessionName);
  if (!wsId) return {};
  try {
    const [claudeHome, grokHome] = await Promise.all([
      ensureWorkspaceClaudeHome(wsId),
      ensureWorkspaceGrokHome(wsId),
    ]);
    await writeGrokHookFile(grokHome, GROK_HOOK_SCRIPT_PATH).catch((err) => {
      log.warn(`grok hook install for ${wsId} failed: ${err instanceof Error ? err.message : err}`);
    });
    return {
      CLAUDE_CONFIG_DIR: claudeHome,
      GROK_HOME: grokHome,
      PMUX_TOKEN: getWorkspaceToken(wsId),
      ...(await tabEnv(sessionName, identity)),
    };
  } catch (err) {
    // A pane that starts without isolation is far better than a pane that does
    // not start, but this must be visible — it is a silent loss of a guarantee.
    log.error(`workspace env for ${wsId} failed, launching unscoped: ${err instanceof Error ? err.message : err}`);
    return {};
  }
};

/**
 * The tab's own identity (ADR-0010). The caller names the tab because every
 * caller creates the session BEFORE the tab reaches the layout, so the layout
 * cannot answer yet. A failure here costs the tab its verified identity, not
 * its workspace scope: the CLI falls back to `PMUX_TOKEN`.
 */
const tabEnv = async (sessionName: string, identity?: ITabIdentity): Promise<Record<string, string>> => {
  if (!identity) return {};
  try {
    return {
      PMUX_TAB_TOKEN: await ensureTabToken(identity, sessionName),
      PMUX_TAB_ID: identity.tabId,
      PMUX_WORKSPACE_ID: identity.workspaceId,
    };
  } catch (err) {
    log.error(`tab token for ${identity.tabId} failed, launching without tab identity: ${err instanceof Error ? err.message : err}`);
    return {};
  }
};

/**
 * A remote tab's session (ADR-0022 §8; slice b). One `ssh … sh -s` run writes
 * the kit (tmux.conf, the Claude hook and hooks.json, this server's CLI, the
 * workspace prompt) and the tab's one-shot env file, then starts the session.
 * The pane gets the reap marker, `PMUX_URL` and, through the env file only, its
 * own tab token: never the workspace token, never a claude or grok home.
 */
const createRemoteSession = async (
  host: string,
  name: string,
  cols: number,
  rows: number,
  cwd: string | undefined,
  identity: ITabIdentity | undefined,
): Promise<void> => {
  const env: Record<string, string> = {};
  let tabEnv: { tabId: string; content: string } | undefined;
  if (identity) {
    env.PMUX_TAB_ID = identity.tabId;
    env.PMUX_WORKSPACE_ID = identity.workspaceId;
    env.PMUX_URL = await resolveCallbackUrl();
    tabEnv = { tabId: identity.tabId, content: remoteTabEnvFile({ PMUX_TAB_TOKEN: await ensureTabToken(identity, name) }) };
  }
  const { getClaudePromptPath } = await import('@/lib/claude-prompt');
  const [tmuxConf, cliJs, prompt] = await Promise.all([
    fs.readFile(TMUX_CONFIG_PATH, 'utf-8'),
    fs.readFile(CLI_JS_PATH, 'utf-8').catch(() => null),
    identity ? fs.readFile(getClaudePromptPath(identity.workspaceId), 'utf-8').catch(() => null) : Promise.resolve(null),
  ]);
  const launch = buildRemoteShellLaunchCommand(env, tabEnv ? remoteKitPath(remoteTabEnvRelative(tabEnv.tabId)) : undefined);
  const nonce = nanoid(16);
  const script = buildRemoteCreateScript({
    nonce,
    files: remoteKitFiles({ tmuxConf, cliJs, workspaceId: identity?.workspaceId, prompt, tabEnv }),
    session: name,
    cols,
    rows,
    cwd,
    launch,
  });
  try {
    await runSsh(host, 'sh -s', { timeoutMs: CMD_TIMEOUT * 2, input: script });
  } catch (err) {
    // The guard runs before any file is written: a name that exists leaves everything as it was.
    if ((err as { code?: unknown }).code === REMOTE_SESSION_EXISTS_EXIT) {
      throw new Error(`remote session ${name} already exists on ${host}; it was left as it is`);
    }
    // The session may exist although the call failed (a later step, a lost answer). Only a session
    // that carries this call's nonce is killed: never a live one of the same name (review r1, B2);
    // and the token's env file goes too.
    const cleanup = [
      remoteKillIfTagged(name, nonce),
      ...(tabEnv ? [`rm -f ${remoteKitPath(remoteTabEnvRelative(tabEnv.tabId))}`] : []),
    ].join('; ');
    await runSsh(host, cleanup, { timeoutMs: CMD_TIMEOUT }).catch(() => {});
    if (isSshFailure(err)) throw new RemoteHostError(host, `remote host ${host} did not answer over ssh (${describeRemoteFailure(err)})`);
    throw new Error(`remote session ${name} on ${host} was not created (${describeRemoteFailure(err)})`);
  }
  log.debug(`remote tmux session created: ${name} on ${host} (cols: ${cols}, rows: ${rows})`);
};

export const createSession = async (
  name: string,
  cols: number,
  rows: number,
  cwd?: string,
  identity?: ITabIdentity,
): Promise<void> => {
  const host = await sessionHostOf(name);
  if (host) return createRemoteSession(host, name, cols, rows, cwd, identity);
  // tmux 서버 global env cache를 우회하기 위해 `env -i $SHELL -l`을 명령으로 직접 넘긴다.
  // execFile의 env 옵션은 tmux 서버가 이미 떠있는 경우 무시되므로 의존하지 않는다.
  const shellCmd = buildShellLaunchCommand(await workspaceEnv(name, identity));
  await execFile(
    'tmux',
    [
      '-u',
      '-L', TMUX_SOCKET,
      '-f', TMUX_CONFIG_PATH,
      'new-session', '-d',
      '-s', name,
      '-x', String(cols),
      '-y', String(rows),
      shellCmd,
    ],
    {
      timeout: CMD_TIMEOUT,
      cwd: cwd || PRISTINE_ENV.HOME || '/',
    },
  );
  await applyConfig();
  log.debug(`tmux session created: ${name} (cols: ${cols}, rows: ${rows})`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface IKillSessionOptions {
  /** The tab the session belongs to: its processes are reaped first (ADR-0016, story 16). */
  tabId?: string;
  /** Skip the environment-marker scan and signal only the pane group (today's behaviour). */
  keepProcesses?: boolean;
}

/** The tmux server's pid: never a tab's process, whatever environment it inherited. */
export const getTmuxServerPid = async (): Promise<number | null> => {
  try {
    const { stdout } = await execFile('tmux', ['-L', TMUX_SOCKET, 'display-message', '-p', '#{pid}'], { timeout: CMD_TIMEOUT });
    const pid = parseInt(stdout.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
};

/**
 * Close a remote tab's session with one reap script run on its host (ADR-0022
 * §9). An ssh failure throws: dropping the tab would leave its session running
 * where nobody sees it.
 */
const killRemoteSession = async (host: string, name: string, opts: IKillSessionOptions): Promise<IReapResult> => {
  let stdout: string;
  try {
    ({ stdout } = await runSsh(host, reapCommand(name, opts.tabId, !!opts.keepProcesses), {
      timeoutMs: REMOTE_REAP_TIMEOUT,
      input: REMOTE_REAP_SCRIPT,
    }));
  } catch (err) {
    // A host taken out of remote.hosts is a deliberate way out for a host that is gone for good.
    const registered = await readRemoteHosts().catch(() => null);
    if (registered && !registered.includes(host)) {
      log.warn({ host, session: name, failure: describeRemoteFailure(err) }, 'unregistered remote host did not answer; tab closed without a reap');
      if (opts.tabId) await appendCoordinationAudit({ event: 'tab-reap-skipped', tabId: opts.tabId, session: name, host, reason: 'host-unregistered-and-unreachable' });
      return { reaper: 'remote-skipped', envMarker: 'unknown', killed: [], survivors: [] };
    }
    throw new RemoteHostError(host, `could not close ${name} on ${host} (${describeRemoteFailure(err)}). The session may still run there; retry when the host answers, or remove ${host} from remote.hosts to drop the tab without a reap`);
  }
  const reap = parseRemoteReap(stdout);
  if (!reap.sessionGone) log.warn({ host, session: name }, 'remote tmux session still present after the reap');
  if (opts.tabId && (reap.killed.length > 0 || reap.survivors.length > 0)) {
    await appendCoordinationAudit({
      event: 'tab-reap',
      tabId: opts.tabId,
      session: name,
      host,
      keepProcesses: !!opts.keepProcesses,
      killed: reap.killed,
      survivors: reap.survivors,
    });
  }
  return reap;
};

/**
 * Kill a tab's tmux session. With a `tabId`, the tab's processes — every pane
 * descendant and every process carrying `PMUX_TAB_ID=<tabId>` — are reaped
 * first, while the environ scan still sees them; the result is returned and
 * every kill is audited. The marker outlives the session, so a tab whose
 * session already ended (its shell exited: the UI closes it itself) is still
 * reaped by the marker scan.
 */
export const killSession = async (name: string, opts: IKillSessionOptions = {}): Promise<IReapResult | null> => {
  const host = await sessionHostOf(name);
  if (host) return killRemoteSession(host, name, opts);
  const alive = await hasSession(name);
  if (!alive && !opts.tabId) return null;

  log.debug(`killSession start: ${name} (session ${alive ? 'alive' : 'gone'})`);
  const panePid = alive ? await getSessionPanePid(name) : null;
  let reap: IReapResult | null = null;
  if (opts.tabId) {
    reap = await reapTabForClose(
      defaultReaperDeps({ descendants: getDescendantPids, tmuxServerPid: getTmuxServerPid }),
      appendCoordinationAudit,
      { tabId: opts.tabId, session: name, sessionAlive: alive, panePid, keepProcesses: opts.keepProcesses },
    );
    if (reap.killed.length > 0 || reap.survivors.length > 0) {
      log.info({ tabId: opts.tabId, killed: reap.killed.map((p) => p.pid), survivors: reap.survivors.map((p) => p.pid) }, 'tab processes reaped');
    }
  }
  if (!alive) return reap;
  if (panePid) {
    try {
      log.debug(`SIGTERM → process group ${panePid}: ${name}`);
      process.kill(-panePid, 'SIGTERM');
    } catch {
      // process group already gone
    }
  }

  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'kill-session', '-t', name],
      { timeout: CMD_TIMEOUT },
    );
  } catch {
    // kill-session failed, will verify below
  }

  for (let i = 0; i < 5; i++) {
    if (!(await hasSession(name))) {
      log.debug(`killSession done (SIGTERM): ${name}`);
      return reap;
    }
    await sleep(200);
  }

  // Still alive — escalate to SIGKILL
  log.warn(`session survived SIGTERM, escalating to SIGKILL: ${name}`);
  if (panePid) {
    try {
      log.debug(`SIGKILL → process group ${panePid}: ${name}`);
      process.kill(-panePid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'kill-session', '-t', name],
      { timeout: CMD_TIMEOUT },
    );
  } catch {
    // already gone
  }

  for (let i = 0; i < 3; i++) {
    if (!(await hasSession(name))) {
      log.debug(`killSession done (SIGKILL): ${name}`);
      return reap;
    }
    await sleep(200);
  }

  log.warn(`tmux session still alive after kill: ${name}`);
  return reap;
};

export const resolveExistingDir = async (preferred?: string): Promise<string> => {
  const fallback = PRISTINE_ENV.HOME || '/';
  if (!preferred) return fallback;
  let candidate = preferred;
  while (true) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // walk up
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return fallback;
    candidate = parent;
  }
};

export const hasSession = async (name: string): Promise<boolean> => {
  try {
    await runTmux(name, ['has-session', '-t', name]);
    return true;
  } catch {
    return false;
  }
};

export type TSessionPresence = 'present' | 'absent' | 'unknown';

/**
 * Whether a session exists, with a third answer for a remote host that did not
 * say (ADR-0022, review r1 B1/B2): only tmux's own "no such session" or "no
 * server" is absence; ssh failing or timing out is `unknown`. A local session
 * keeps `hasSession`'s answer.
 */
export const sessionPresence = async (name: string): Promise<TSessionPresence> => {
  const host = await sessionHostOf(name);
  if (!host) return (await hasSession(name)) ? 'present' : 'absent';
  try {
    await runSsh(host, remoteTmuxCommand(['has-session', '-t', `=${name}`]), { timeoutMs: CMD_TIMEOUT });
    return 'present';
  } catch (err) {
    return isTmuxAbsence(err) ? 'absent' : 'unknown';
  }
};

/**
 * `hasSession` for a decision that must not read an unanswered remote host as a
 * dead tab (send, status, result, restart): `unknown` throws `RemoteHostError`.
 */
export const hasSessionOrUnreachable = async (name: string): Promise<boolean> => {
  const presence = await sessionPresence(name);
  if (presence === 'unknown') {
    const host = (await sessionHostOf(name)) ?? 'unknown';
    throw new RemoteHostError(host, `remote host ${host} did not answer over ssh; ${name} may still run there`);
  }
  return presence === 'present';
};

/**
 * The provider process of a remote tab, with strict identity (ADR-0021 on
 * another host): the pane's id and pid and the provider's pid and start time,
 * read on the host by one script. ssh failing is `unknown`, never `absent`.
 */
export const observeRemoteProviderProcess = async (
  sessionName: string,
  provider: 'claude' | 'codex' | 'grok',
): Promise<TStrictRuntimeObservation> => {
  const host = await sessionHostOf(sessionName);
  if (!host) return { state: 'unknown', reason: 'not a remote session' };
  let stdout: string;
  try {
    ({ stdout } = await runSsh(host, ['sh', '-s', '--', remoteSocketName(), sessionName, provider].map(shQuote).join(' '), {
      timeoutMs: CMD_TIMEOUT,
      input: REMOTE_PROVIDER_SCRIPT,
    }));
  } catch (err) {
    return { state: 'unknown', reason: `remote host ${host} did not answer (${describeRemoteFailure(err)})` };
  }
  const observed = parseRemoteProviderObservation(stdout);
  if (observed.state !== 'present') return observed;
  return { state: 'present', identity: `remote:${host}:${sessionName}:${observed.paneId}:${observed.panePid}:${observed.pid}:${observed.start}:${provider}` };
};

/**
 * Every remote host of these sessions answers, checked before a close of
 * several tabs touches any of them (review r1, B3): a host that does not answer
 * refuses the whole close. A host taken out of remote.hosts is skipped; its
 * tabs then close without a reap (§9).
 */
export const assertRemoteHostsAnswer = async (sessionNames: readonly string[]): Promise<void> => {
  const hosts = new Set<string>();
  for (const name of sessionNames) {
    const host = await sessionHostOf(name);
    if (host) hosts.add(host);
  }
  if (hosts.size === 0) return;
  const registered = await readRemoteHosts().catch(() => null);
  for (const host of hosts) {
    if (registered && !registered.includes(host)) continue;
    try {
      await runSsh(host, 'true', { timeoutMs: CMD_TIMEOUT });
    } catch (err) {
      throw new RemoteHostError(host, `remote host ${host} did not answer over ssh (${describeRemoteFailure(err)}); nothing was closed`);
    }
  }
};

// tmux auto-cleans dead sessions when remain-on-exit is not set, no extra handling needed
export const cleanDeadSessions = async (): Promise<void> => {};

export const scanSessions = async (): Promise<void> => {
  await cleanDeadSessions();
  const sessions = await listSessions();
  if (sessions.length > 0) {
    sessions.forEach((name) => {
      log.debug(`existing tmux session found: ${name}`);
    });
  }
};

const readShellCwd = async (pid: number): Promise<string | null> => {
  if (isLinux) {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: CMD_TIMEOUT });
    const line = stdout.split('\n').find((l) => l.startsWith('n/'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
};

/**
 * The session's cwd as a directory on THIS host. A remote session has none
 * (ADR-0022 §7): its path names another machine's tree, and the git, diff and
 * sync routes would read or push the local checkout that shares the path.
 */
export const getSessionCwd = async (sessionName: string): Promise<string | null> => {
  if (await sessionHostOf(sessionName)) return null;
  const shellPid = await getSessionPanePid(sessionName);
  if (shellPid) {
    const cwd = await readShellCwd(shellPid);
    if (cwd) return cwd;
  }
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', sessionName, '#{pane_current_path}'],
      { timeout: CMD_TIMEOUT },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

/** The pane pid on THIS host; null for a remote session, whose pid names another host's process (ADR-0022 §6). */
export const getSessionPanePid = async (sessionName: string): Promise<number | null> => {
  if (await sessionHostOf(sessionName)) return null;
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', sessionName, '#{pane_pid}'],
      { timeout: CMD_TIMEOUT },
    );
    const pid = parseInt(stdout.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
};

export const applyConfig = async (): Promise<void> => {
  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'source-file', TMUX_CONFIG_PATH],
      { timeout: CMD_TIMEOUT },
    );
  } catch {
    // Server not running yet, config will be applied on first session
  }
};

export const defaultSessionName = (): string =>
  `pt-${nanoid(6)}-${nanoid(6)}-${nanoid(6)}`;

export const workspaceSessionName = (wsId: string, paneId: string, tabId: string): string =>
  `pt-${wsId}-${paneId}-${tabId}`;

export const getPaneCurrentCommand = async (
  sessionName: string,
): Promise<string | null> => {
  try {
    const { stdout } = await runTmux(sessionName, ['list-panes', '-t', sessionName, '-F', '#{pane_current_command}']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export interface IPaneInfo {
  command: string;
  path: string;
  /** The pane pid on THIS host; 0 for a remote pane (ADR-0022 §6). */
  pid: number;
  windowActivity: number;
  /** The remote host that runs this pane; absent for a local one. */
  host?: string;
}

const ALL_PANES_FORMAT = '#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{window_activity}';

const parsePanes = (stdout: string, host?: string): Map<string, IPaneInfo> => {
  const result = new Map<string, IPaneInfo>();
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const [session, command, path, pidStr, activityStr] = line.split('\t');
    if (!session || !command) continue;
    if (host && !session.startsWith('pt-')) continue;
    const pid = parseInt(pidStr, 10);
    const windowActivity = parseInt(activityStr, 10);
    result.set(session, {
      command,
      path: path || '',
      pid: host || Number.isNaN(pid) ? 0 : pid,
      windowActivity: Number.isNaN(windowActivity) ? 0 : windowActivity,
      ...(host ? { host } : {}),
    });
  }
  return result;
};

const localPanes = async (): Promise<Map<string, IPaneInfo>> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'list-panes', '-a', '-F', ALL_PANES_FORMAT],
      { timeout: CMD_TIMEOUT },
    );
    return parsePanes(stdout);
  } catch {
    return new Map();
  }
};

/** After a host fails to answer a pane scan, the scans skip it this long (review r1 nit 2). */
const REMOTE_SCAN_BACKOFF_MS = 30_000;

const gScan = globalThis as unknown as { __ptRemoteScanBackoff?: Map<string, number>; __ptRemoteScanAnswered?: Map<string, boolean> };
if (!gScan.__ptRemoteScanBackoff) gScan.__ptRemoteScanBackoff = new Map();
if (!gScan.__ptRemoteScanAnswered) gScan.__ptRemoteScanAnswered = new Map();
const scanBackoff = gScan.__ptRemoteScanBackoff;
const scanAnswered = gScan.__ptRemoteScanAnswered;

/**
 * Whether the last pane scan of `host` was answered (review r3 B1). A remote
 * session missing from an answered scan is gone; missing from an unanswered
 * one, or during the backoff, nothing is known about it.
 */
export const remotePaneScanAnswered = (host: string): boolean => scanAnswered.get(host) === true;

/** A host that does not answer contributes nothing: its tabs read as not running, never as local. */
const remotePanes = async (host: string): Promise<Map<string, IPaneInfo>> => {
  if ((scanBackoff.get(host) ?? 0) > Date.now()) return new Map();
  try {
    const { stdout } = await runSsh(host, remoteTmuxCommand(['list-panes', '-a', '-F', ALL_PANES_FORMAT]), { timeoutMs: CMD_TIMEOUT });
    scanBackoff.delete(host);
    scanAnswered.set(host, true);
    return parsePanes(stdout, host);
  } catch (err) {
    if (isTmuxAbsence(err)) {
      scanBackoff.delete(host);
      scanAnswered.set(host, true);
    } else {
      scanBackoff.set(host, Date.now() + REMOTE_SCAN_BACKOFF_MS);
      scanAnswered.set(host, false);
      log.warn({ host, failure: describeRemoteFailure(err) }, 'remote pane scan failed; host skipped for 30 s');
    }
    return new Map();
  }
};

export const getAllPanesInfo = async (): Promise<Map<string, IPaneInfo>> => {
  // Only hosts that own a tab are asked: a registered host with none costs nothing.
  const [local, ...remote] = await Promise.all([
    localPanes(),
    ...(await remoteHostsInUse().catch(() => knownRemoteHosts())).map(remotePanes),
  ]);
  for (const panes of remote) {
    for (const [session, info] of panes) if (!local.has(session)) local.set(session, info);
  }
  return local;
};

export const SAFE_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash']);

export const checkTerminalProcess = async (
  tmuxSession: string,
): Promise<{ isSafe: boolean; processName: string }> => {
  const command = await getPaneCurrentCommand(tmuxSession);
  if (!command) {
    return { isSafe: false, processName: 'unknown' };
  }
  return {
    isSafe: SAFE_SHELLS.has(command),
    processName: command,
  };
};

export const getPaneTitle = async (sessionName: string): Promise<string | null> => {
  try {
    const { stdout } = await runTmux(sessionName, ['display-message', '-p', '-t', sessionName, '#{pane_title}']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export const exitCopyMode = async (sessionName: string): Promise<void> => {
  await runTmux(sessionName, ['copy-mode', '-q', '-t', sessionName]).catch(() => {});
};

/**
 * Send a bare Escape. Both agent CLIs read it as "stop this turn, keep the
 * session", which is what makes a mid-turn correction possible without an
 * agent-side control API.
 */
export const sendEscape = async (sessionName: string): Promise<void> => {
  await exitCopyMode(sessionName);
  await runTmux(sessionName, ['send-keys', '-t', sessionName, 'Escape']);
};

export const sendKeys = async (
  sessionName: string,
  command: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await runTmux(sessionName, ['send-keys', '-t', sessionName, command, 'Enter']);
};

// Send text and Enter as two separate tmux invocations split by 50ms.
// Codex (and possibly other TUIs) interprets a single send-keys "cmd Enter"
// burst as a paste containing a literal newline. Splitting forces the agent
// to commit text first, then receive Enter as a discrete keypress.
export const sendKeysSeparated = async (
  sessionName: string,
  text: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await runTmux(sessionName, ['send-keys', '-t', sessionName, text]);
  await sleep(50);
  await runTmux(sessionName, ['send-keys', '-t', sessionName, 'Enter']);
};

export const sendRawKeys = async (
  sessionName: string,
  keys: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await runTmux(sessionName, ['send-keys', '-t', sessionName, keys]);
};

/**
 * Send text via bracketed paste mode WITHOUT submitting it. The agent TUI keeps
 * it in the composer, so the operator (or a later Enter) decides when it goes.
 */
export const sendBracketedPasteText = async (
  sessionName: string,
  content: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await runTmux(sessionName, ['send-keys', '-t', sessionName, '-l', '--', `${PASTE_START}${content}${PASTE_END}`]);
};

/**
 * Send text as keystrokes WITHOUT submitting it — see `typed-input.ts` for why
 * a Claude Code composer must not receive its prompt as a paste.
 */
export const sendTypedText = async (
  sessionName: string,
  content: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  for (const step of planTypedInput(content)) {
    const keys = step.kind === 'newline' ? ['C-j'] : ['-l', '--', step.text];
    await runTmux(sessionName, ['send-keys', '-t', sessionName, ...keys]);
    await sleep(TYPED_CHUNK_GAP_MS);
  }
};

/** Press Enter once: the retry for a composer that kept its text (L37). */
export const pressEnter = async (sessionName: string): Promise<void> => {
  await runTmux(sessionName, ['send-keys', '-t', sessionName, 'Enter']);
};

/** Press Enter twice (handles Claude Code long input confirmation) */
export const submitComposer = async (sessionName: string): Promise<void> => {
  await runTmux(sessionName, ['send-keys', '-t', sessionName, 'Enter']);
  await sleep(600);
  await runTmux(sessionName, ['send-keys', '-t', sessionName, 'Enter']);
};

/** Send text via bracketed paste mode and submit it */
export const sendBracketedPaste = async (
  sessionName: string,
  content: string,
): Promise<void> => {
  await sendBracketedPasteText(sessionName, content);
  await submitComposer(sessionName);
};


export interface IPaneDetailInfo {
  cwd: string | null;
  command: string | null;
  pid: number | null;
  width: number | null;
  height: number | null;
  sessionCreated: number | null;
}

export const getPaneDetailInfo = async (
  sessionName: string,
): Promise<IPaneDetailInfo> => {
  try {
    const remote = !!(await sessionHostOf(sessionName));
    const { stdout } = await runTmux(sessionName, [
      'display-message', '-p', '-t', sessionName,
      '#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}\t#{pane_width}\t#{pane_height}\t#{session_created}',
    ]);
    const [cwdStr, command, pidStr, widthStr, heightStr, createdStr] = stdout.trim().split('\t');
    return {
      cwd: cwdStr || null,
      command: command || null,
      pid: !remote && pidStr ? parseInt(pidStr, 10) || null : null,
      width: widthStr ? parseInt(widthStr, 10) || null : null,
      height: heightStr ? parseInt(heightStr, 10) || null : null,
      sessionCreated: createdStr ? parseInt(createdStr, 10) || null : null,
    };
  } catch {
    return { cwd: null, command: null, pid: null, width: null, height: null, sessionCreated: null };
  }
};

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun']);

const cleanCommandLine = (raw: string): string => {
  const parts = raw.split(/\s+/);
  if (parts.length === 0) return raw;

  parts[0] = path.basename(parts[0]);

  if (INTERPRETERS.has(parts[0]) && parts.length > 1) {
    const scriptName = path.basename(parts[1]).replace(/\.(c|m)?js$/, '');
    parts.splice(0, 2, scriptName);
  }

  return parts.join(' ');
};

export const killServer = async (): Promise<void> => {
  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'kill-server'],
      { timeout: CMD_TIMEOUT },
    );
    log.debug('tmux server killed');
  } catch {
    // Server may not be running
  }
};

/** A TUI's horizontal box rule — `────────` in any of the dash characters. */
const COMPOSER_RULE = /^\s*[─━—\-_]{8,}\s*$/;

/**
 * The pane lines that belong to the input box, which is the region between the
 * LAST two box rules a TUI drew.
 *
 * Bottom-of-pane proximity is not enough on its own. An agent that queues a
 * prompt arriving mid-turn echoes it a line or two ABOVE its input box —
 * `❯ <the message>` with the marker and everything — and the box below still
 * holds only a placeholder. Read by proximity, that echo is indistinguishable
 * from a stranded paste; read by region, it is plainly outside the composer.
 *
 * Falls back to the bottom of the pane for a TUI that draws no rules at all.
 */
const composerRegion = (lines: string[]): string[] => {
  const rules: number[] = [];
  for (let i = lines.length - 1; i >= 0 && rules.length < 2; i -= 1) {
    if (COMPOSER_RULE.test(lines[i])) rules.push(i);
  }
  if (rules.length < 2) return lines.slice(-8);
  const [bottom, top] = rules;
  return lines.slice(top + 1, bottom);
};

/**
 * Whether `content` is still sitting UNSUBMITTED in the composer of
 * `sessionName`, best-effort.
 *
 * `sendBracketedPaste` pastes and then presses Enter, but an agent TUI that is
 * mid-turn can swallow that Enter: the text stays in the composer and the send
 * reports success. What the operator sees later is a line they did not type
 * waiting in a worker's input box — and the next Enter from ANY source submits
 * it. That is how a stray `commit this` reaches a worker that was told never to
 * run git.
 *
 * Detection is deliberately narrow. It looks only inside the input box (see
 * {@link composerRegion}), and only at lines carrying a composer marker (`>`,
 * `❯`, or the box edge), so neither a transcript echo above nor a queued-message
 * echo just outside the box reads as pending. It answers false when it cannot
 * tell — a capture failure is not evidence of a stranded paste.
 */
export const isPaneShowingPendingContent = (pane: string, content: string): boolean => {
  // The first line is what a multi-line paste leaves visible on the prompt row.
  const needle = content.trim().split('\n')[0].trim().slice(0, 40);
  if (needle.length < 3) return false;
  return composerRegion(pane.split('\n'))
    .some((line) => /[>❯│|]/.test(line) && line.includes(needle));
};

const squash = (text: string): string => text.replace(/\s+/g, '');

/**
 * Whether the WHOLE first line of `content` sits unsubmitted in the input box
 * (review r1 finding 5). Every watchdog nudge starts
 * `[orchestrator-watchdog] worker tab-… (…)`, so the 40-character needle of
 * {@link isPaneShowingPendingContent} also matches a DIFFERENT stranded nudge
 * from the same worker. Here the box's lines are joined without their marker
 * and edge characters, and whitespace is ignored on both sides, so a line the
 * TUI wrapped still matches and a different line never does. With no drawn
 * box (fewer than two rules), one marker line must hold the whole line.
 */
export const isPaneShowingPendingLine = (pane: string, content: string): boolean => {
  const needle = squash(content.trim().split('\n')[0]);
  if (needle.length < 3) return false;
  const lines = pane.split('\n');
  const rules = lines.filter((line) => COMPOSER_RULE.test(line)).length;
  if (rules < 2) {
    return lines.slice(-8).some((line) => /[>❯│|]/.test(line) && squash(line).includes(needle));
  }
  const box = composerRegion(lines).map((line) => line.replace(/^[\s│|]*(?:[❯>][\s\u00a0]?)?/, '').replace(/[\s│|]*$/, ''));
  return squash(box.join('')).includes(needle);
};

/** The capture behind {@link isPaneShowingPendingLine}; false when the pane cannot be read. */
export const isLinePendingInComposer = async (sessionName: string, content: string): Promise<boolean> => {
  const pane = await capturePaneContent(sessionName);
  if (!pane) return false;
  return isPaneShowingPendingLine(pane, content);
};

export const isContentPendingInComposer = async (
  sessionName: string,
  content: string,
): Promise<boolean> => {
  const pane = await capturePaneContent(sessionName);
  if (!pane) return false;
  return isPaneShowingPendingContent(pane, content);
};

export interface ICaptureOptions {
  /** Keep the SGR escapes (`-e`), so a reader can tell dim suggestion text from typed text. */
  escapes?: boolean;
}

export const capturePaneContent = async (sessionName: string, opts: ICaptureOptions = {}): Promise<string | null> => {
  try {
    const { stdout } = await runTmux(sessionName, ['capture-pane', '-p', ...(opts.escapes ? ['-e'] : []), '-t', sessionName]);
    return stdout;
  } catch {
    return null;
  }
};

/** The visible pane with its SGR escapes (`-e`) and wrapped lines joined (`-J`). */
export const capturePaneContentAnsi = async (sessionName: string): Promise<string | null> => {
  try {
    const { stdout } = await runTmux(sessionName, ['capture-pane', '-p', '-e', '-J', '-t', sessionName]);
    return stdout;
  } catch {
    return null;
  }
};

export const capturePaneContentWithHistory = async (
  sessionName: string,
  historyLines: number,
  opts: ICaptureOptions = {},
): Promise<string | null> => {
  try {
    const { stdout } = await runTmux(sessionName, ['capture-pane', '-p', ...(opts.escapes ? ['-e'] : []), '-S', `-${historyLines}`, '-t', sessionName]);
    return stdout;
  } catch {
    return null;
  }
};

const getChildPidsOf = async (parentPids: number[]): Promise<number[]> => {
  if (isLinux) {
    const lists = await Promise.all(parentPids.map((pid) => readProcChildren(pid)));
    if (lists.every((list) => list !== null)) return lists.flat() as number[];
  }
  try {
    const { stdout } = await execFile('pgrep', ['-P', parentPids.join(',')], { timeout: CMD_TIMEOUT });
    return stdout.trim().split('\n').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
};

export const getDescendantPids = async (rootPid: number): Promise<number[]> => {
  const all: number[] = [];
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const children = await getChildPidsOf(frontier);
    if (children.length === 0) break;
    all.push(...children);
    frontier = children;
  }
  return all;
};

const getListeningPortsLinux = async (pids: number[]): Promise<number[]> => {
  try {
    const pidSet = new Set(pids);
    const { stdout } = await execFile('ss', ['-tlnp'], { timeout: CMD_TIMEOUT });
    const ports = new Set<number>();
    for (const line of stdout.split('\n')) {
      const pidMatch = line.match(/pid=(\d+)/g);
      if (!pidMatch) continue;
      const hasPid = pidMatch.some((m) => pidSet.has(parseInt(m.replace('pid=', ''), 10)));
      if (!hasPid) continue;
      const portMatch = line.match(/:(\d+)\s/);
      if (portMatch) ports.add(parseInt(portMatch[1], 10));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
};

export const getListeningPorts = async (shellPid: number): Promise<number[]> => {
  const pids = await getDescendantPids(shellPid);
  if (pids.length === 0) return [];

  if (isLinux) return getListeningPortsLinux(pids);

  try {
    const { stdout } = await execFile(
      'lsof',
      ['-a', '-p', pids.join(','), '-i', '-sTCP:LISTEN', '-P', '-Fn'],
      { timeout: CMD_TIMEOUT },
    );
    const ports = new Set<number>();
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n')) {
        const match = line.match(/:(\d+)$/);
        if (match) ports.add(parseInt(match[1], 10));
      }
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
};

export const getLastCommand = async (sessionName: string): Promise<string | null> => {
  const shellPid = await getSessionPanePid(sessionName);
  if (!shellPid) return null;

  try {
    const { stdout: pgrepOut } = await execFile(
      'pgrep', ['-n', '-P', String(shellPid)],
      { timeout: CMD_TIMEOUT },
    );
    const childPid = pgrepOut.trim();
    if (!childPid) return null;

    const args = await getProcessArgs(childPid, { timeoutMs: CMD_TIMEOUT });
    if (!args) return null;

    return cleanCommandLine(args);
  } catch {
    return null;
  }
};

/** Exact target lookup; only tmux's explicit exact-target absence is positive absence. */
export const observeSessionStrict = async (sessionName: string): Promise<
  | { state: 'present'; panePid: number; identity: string }
  | { state: 'absent' | 'unknown'; reason: string }
> => {
  try {
    const host = await sessionHostOf(sessionName);
    const { stdout } = await runTmux(sessionName, ['list-panes', '-t', `=${sessionName}`, '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}']);
    // Its pid names another host's process: there is no local identity to prove (ADR-0022 §6).
    if (host) return { state: 'unknown', reason: `session runs on remote host ${host}; no local process identity` };
    const lines = stdout.trim().split('\n');
    const [name, pane, pid] = lines[0].split('\t');
    if (lines.length !== 1 || name !== sessionName || !pane || !/^\d+$/.test(pid) || Number(pid) <= 0) return { state: 'unknown', reason: 'session identity changed or is ambiguous' };
    return { state: 'present', panePid: Number(pid), identity: `${name}:${pane}:${pid}` };
  } catch (error) {
    // On a remote host the closed session can be the server's last: tmux then answers "no server
    // running on" (review r3 B2). Any of tmux's own absence lines, never an ssh failure, is absence.
    if (await sessionHostOf(sessionName)) {
      return isTmuxAbsence(error)
        ? { state: 'absent', reason: 'tmux on the remote host reported the session or its server absent' }
        : { state: 'unknown', reason: 'remote host did not answer or did not prove session absence' };
    }
    const failure = error as { code?: unknown; stderr?: string; killed?: boolean; signal?: unknown };
    const diagnostic = failure.stderr?.trim();
    if (failure.code === 1 && !failure.killed && !failure.signal
      && (diagnostic === `can't find session: ${sessionName}` || diagnostic === `can't find window: ${sessionName}`)) {
      return { state: 'absent', reason: 'tmux positively reported the exact target absent' };
    }
    return { state: 'unknown', reason: 'tmux unavailable, timed out, or did not prove session absence' };
  }
};

/**
 * A tab gone from the layout is closed only when no session of it survives.
 * Its pane is unknown, so every `pt-<ws>-<pane>-<tab>` session is a match;
 * only a readable listing (or tmux's explicit no-server reply) proves absence.
 */
export const observeTabSessionsStrict = async (wsId: string, tabId: string): Promise<
  | { state: 'absent' | 'unknown'; reason: string }
  | { state: 'present'; sessions: string[] }
> => {
  let names: string[];
  try {
    const { stdout } = await execFile('tmux', ['-L', TMUX_SOCKET, 'ls', '-F', '#{session_name}'], { timeout: CMD_TIMEOUT });
    names = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: string; killed?: boolean; signal?: unknown };
    if (failure.code === 1 && !failure.killed && !failure.signal && failure.stderr?.trim().startsWith('no server running on ')) {
      return { state: 'absent', reason: 'tmux positively reported no server' };
    }
    return { state: 'unknown', reason: 'tmux unavailable, timed out, or did not list sessions' };
  }
  const sessions = names.filter((name) => name.startsWith(`pt-${wsId}-`) && name.endsWith(`-${tabId}`));
  return sessions.length
    ? { state: 'present', sessions }
    : { state: 'absent', reason: 'no tmux session of the tab survives' };
};
