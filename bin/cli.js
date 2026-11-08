#!/usr/bin/env node
// purplemux CLI — workspace-scoped HTTP API wrapper
// Falls back to ~/.purplemux/{port,cli-token} when env vars absent.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const readFileOrNull = (file) => {
  try {
    return fs.readFileSync(file, 'utf-8').trim() || null;
  } catch {
    return null;
  }
};

// A remote tab (ADR-0022) reaches its server by URL; everything else by the local port.
const URL_OVERRIDE = (process.env.PMUX_URL || '').replace(/\/+$/, '') || null;
const PORT = process.env.PMUX_PORT || readFileOrNull(path.join(os.homedir(), '.purplemux', 'port'));
const TAB_TOKEN = process.env.PMUX_TAB_TOKEN || null;
const ENV_TOKEN = process.env.PMUX_TOKEN || null;
const ADMIN_TOKEN = readFileOrNull(path.join(os.homedir(), '.purplemux', 'cli-token'));
const BASE = URL_OVERRIDE || `http://localhost:${PORT}`;
const SERVER_LABEL = URL_OVERRIDE ? `at ${URL_OVERRIDE}` : `on port ${PORT}`;

/**
 * The token to present for a request against `requestPath`.
 *
 * Workspace mutations accept ONLY a token scoped to the target workspace, so
 * that a tab cannot type into another epic's worker. That rule would also
 * catch a human shell, which holds the global token and belongs to no
 * workspace — so when nothing scoped us, resolve the token of the workspace
 * the command already named in `-w` and present that.
 *
 * The order is the whole point: `PMUX_TAB_TOKEN` > `PMUX_TOKEN` > the `-w`
 * workspace's token on disk > the global token. The first two are set exactly
 * when a command runs INSIDE a tab. The tab token names the tab as well as its
 * workspace (ADR-0010); both stay confined to their own workspace and never
 * pick up a neighbour's token from disk. The lookup below is reached only by a
 * caller that was never scoped to begin with.
 */
const workspaceTokenFor = (workspaceId) => {
  if (!workspaceId) return null;
  try {
    const file = path.join(os.homedir(), '.purplemux', 'workspace-tokens.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'))[workspaceId] || null;
  } catch {
    return null;
  }
};

const tokenFor = (requestPath, body, method) => {
  if (TAB_TOKEN) return TAB_TOKEN;
  if (ENV_TOKEN) return ENV_TOKEN;
  const match = /[?&]workspaceId=([^&]+)/.exec(requestPath || '');
  const pathMatch = !['GET', 'HEAD', 'OPTIONS'].includes(method)
    ? /^\/api\/cli\/workspaces\/([^/?]+)(?:\/|$)/.exec(requestPath || '') : null;
  const workspaceId = match ? decodeURIComponent(match[1])
    : pathMatch ? decodeURIComponent(pathMatch[1])
      : typeof body?.workspaceId === 'string' ? body.workspaceId : null;
  return workspaceTokenFor(workspaceId) || ADMIN_TOKEN;
};

let ownSession;
/** The tmux session this command runs in, or null outside tmux. Asked of tmux once per process. */
const ownSessionName = () => {
  if (ownSession !== undefined) return ownSession;
  ownSession = null;
  if (!process.env.TMUX) return ownSession;
  try {
    const name = require('child_process')
      .execFileSync('tmux', ['display-message', '-p', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim();
    ownSession = name || null;
  } catch {
    ownSession = null;
  }
  return ownSession;
};

/**
 * `X-Pmux-Session` lets the server name the calling tab for a workspace token
 * (tabs created before tab tokens existed). The server trusts it only inside
 * the token's own workspace, and a tab token makes it redundant.
 */
const headersFor = (requestPath, extra, body, method) => {
  const headers = { 'X-Pmux-Token': tokenFor(requestPath, body, method), ...(extra || {}) };
  const session = TAB_TOKEN ? null : ownSessionName();
  if (session) headers['X-Pmux-Session'] = session;
  return headers;
};

// Exit-code contract (docs/adr/0016-cli-exit-codes-and-tab-owned-processes.md).
// A caller branches on the exit code, so a failure it must never retry (the tab
// is gone) and one it may retry (the agent is still booting) cannot share one.
// A relay loop once retried `tab send` into a closed tab for more than a day
// because both exited 1.
const EXIT = Object.freeze({
  UNEXPECTED: 1,
  USAGE: 2,
  CONFLICT: 3,
  GONE: 4,
  NOT_READY: 5,
  UNREACHABLE: 6,
  NOT_FOUND: 7,
});

const EXIT_HINT = Object.freeze({
  [EXIT.UNEXPECTED]: 'unexpected — investigate',
  [EXIT.USAGE]: 'usage error — fix the command',
  [EXIT.CONFLICT]: 'conflict — retry only after the state changes',
  [EXIT.GONE]: 'permanent — the target is gone; do not retry',
  [EXIT.NOT_READY]: 'not ready yet — retry, bounded',
  [EXIT.UNREACHABLE]: 'server unreachable — retry, bounded',
  [EXIT.NOT_FOUND]: 'not found',
});

// The one code → exit table. A server route adds its `code` here, never a
// table of its own. A code absent from the table exits 1.
const CODE_EXIT = Object.freeze(Object.assign(Object.create(null), {
  'invalid-request': EXIT.USAGE,
  conflict: EXIT.CONFLICT,
  unauthorized: EXIT.CONFLICT,
  'not-found': EXIT.NOT_FOUND,
  'gh-unavailable': EXIT.UNEXPECTED,
  'outcome-unknown': EXIT.UNEXPECTED,
  'close-not-confirmed': EXIT.UNEXPECTED,
  'restart-unsupported': EXIT.USAGE,
  'tab-busy': EXIT.CONFLICT,
  'restart-not-confirmed': EXIT.UNEXPECTED,
  'lease-policy': EXIT.USAGE,
  'watch-invalid': EXIT.USAGE,
  'reports-to-invalid': EXIT.USAGE,
  'report-on-invalid': EXIT.USAGE,
  'remote-host-invalid': EXIT.USAGE,
  'remote-type-unsupported': EXIT.USAGE,
  'cwd-missing': EXIT.USAGE,
  'note-too-large': EXIT.USAGE,
  'deploy-invalid': EXIT.USAGE,
  'config-invalid': EXIT.USAGE,
  'invalid-burndown': EXIT.USAGE,
  'burndown-too-large': EXIT.USAGE,
  'orchestration-precondition-required': EXIT.USAGE,
  'orchestration-invalid': EXIT.USAGE,
  'orchestration-conflict': EXIT.CONFLICT,
  'orchestrator-state-unknown': EXIT.CONFLICT,
  'orchestrator-live': EXIT.CONFLICT,
  'orchestrator-candidate-invalid': EXIT.CONFLICT,
  'orchestration-work-remains': EXIT.CONFLICT,
  'orchestration-recovery-required': EXIT.CONFLICT,
  'note-target-missing': EXIT.USAGE,
  'note-invalid': EXIT.USAGE,
  'lease-held': EXIT.CONFLICT,
  'note-cap': EXIT.CONFLICT,
  'lease-held-by-other': EXIT.CONFLICT,
  'watch-cap': EXIT.CONFLICT,
  forbidden: EXIT.CONFLICT,
  'inbox-not-held': EXIT.CONFLICT,
  'grant-tab-unverified': EXIT.CONFLICT,
  'config-version-conflict': EXIT.CONFLICT,
  'caller-unresolved': EXIT.CONFLICT,
  'grant-password-invalid': EXIT.CONFLICT,
  'grant-locked': EXIT.CONFLICT,
  'grant-owner-active': EXIT.CONFLICT,
  'tab-not-found': EXIT.GONE,
  'session-not-running': EXIT.GONE,
  'target-changed': EXIT.GONE,
  'readiness-timeout': EXIT.NOT_READY,
  'startup-prompt': EXIT.NOT_READY,
  'server-unreachable': EXIT.UNREACHABLE,
  'routes-absent': EXIT.UNREACHABLE,
  'remote-host-unreachable': EXIT.UNREACHABLE,
  'lease-not-found': EXIT.NOT_FOUND,
  'note-not-found': EXIT.NOT_FOUND,
  'watch-not-found': EXIT.NOT_FOUND,
  'inbox-not-found': EXIT.NOT_FOUND,
  'deploy-not-found': EXIT.NOT_FOUND,
  'config-not-found': EXIT.NOT_FOUND,
  'wip-cap': EXIT.CONFLICT,
  'config-store-unreadable': EXIT.CONFLICT,
  'flow-invalid': EXIT.USAGE,
  'flow-too-large': EXIT.USAGE,
  'flow-unreadable': EXIT.UNEXPECTED,
  'flow-not-found': EXIT.NOT_FOUND,
  'question-invalid': EXIT.USAGE,
  'ledger-event-invalid': EXIT.USAGE,
  'ledger-reason-invalid': EXIT.USAGE,
  'ledger-experiment-invalid': EXIT.USAGE,
  'ledger-query-invalid': EXIT.USAGE,
  'ledger-token-invalid': EXIT.USAGE,
  'ledger-too-large': EXIT.USAGE,
  'ledger-type-reserved': EXIT.USAGE,
  'ledger-event-conflict': EXIT.CONFLICT,
  'ledger-experiment-cap': EXIT.CONFLICT,
  'ledger-experiment-closed': EXIT.CONFLICT,
  'ledger-experiment-extended': EXIT.CONFLICT,
  'ledger-experiment-not-found': EXIT.NOT_FOUND,
  'event-invalid': EXIT.USAGE,
  'event-scope-invalid': EXIT.USAGE,
  'event-refused': EXIT.CONFLICT,
  'event-out-of-scope': EXIT.CONFLICT,
  'event-stale': EXIT.CONFLICT,
  'event-no-recipient': EXIT.NOT_READY,
  'event-check-unavailable': EXIT.CONFLICT,
  'pool-invalid': EXIT.USAGE,
  'pool-full': EXIT.CONFLICT,
  'pool-unreadable': EXIT.CONFLICT,
  'pool-timeout': EXIT.UNREACHABLE,
  'pool-queued': EXIT.CONFLICT,
  'pool-ticket-gone': EXIT.CONFLICT,
  'curator-task-invalid': EXIT.USAGE,
  'curator-workspace-invalid': EXIT.USAGE,
  'curator-gate-refused': EXIT.CONFLICT,
  'curator-unavailable': EXIT.CONFLICT,
  'curator-refused': EXIT.CONFLICT,
  'so-invalid': EXIT.USAGE,
  'so-too-large': EXIT.USAGE,
  'so-not-found': EXIT.NOT_FOUND,
  'so-unreadable': EXIT.CONFLICT,
  'so-struck': EXIT.CONFLICT,
  'so-proposal-refused': EXIT.CONFLICT,
  'steer-reason-invalid': EXIT.USAGE,
  'terminal-not-command-line': EXIT.USAGE,
}));

// Where the class alone does not tell the caller what happened.
const CODE_HINT = Object.freeze(Object.assign(Object.create(null), {
  'tab-not-found': 'permanent — the tab is closed; do not retry',
  'session-not-running': "the tab's session is dead; do not retry — a person must restart the tab",
  'target-changed': 'permanent — the tab was replaced while the command waited; do not retry',
  'routes-absent': 'no such route on this server (an older server, a foreign server, or a malformed id) — retrying cannot help',
  'remote-host-unreachable': 'the remote host did not answer over ssh — retry, bounded, once it answers',
  'remote-kit-broken': "the CLI kit does not run on the remote host; no agent started — a retry fails the same way until a person repairs the kit or the host",
  'wip-cap': "refused by state — close an agent tab first; only the workspace's orchestrator may pass --over-cap --reason",
  'tab-busy': 'the tab is mid-turn — retry when it is idle, or restart with --interrupt to abandon the turn',
  'restart-not-confirmed': 'a process or the session outlived the reap; nothing was relaunched — inspect the tab before a retry',
  'pool-timeout': 'the pool did not answer in 2 s — do what you do without the pool and log it (a repository in gate.no-local-fallback queues on the gate host or is REFUSED-REMOTE, never runs here); a lease the late answer took expires at its TTL',
  'pool-full': 'no host has the budget, the memory or the disk — wait for a release, or ask with --queue; a repository in gate.no-local-fallback queues on the gate host or is REFUSED-REMOTE, never runs here',
  'pool-queued': 'the request still waits in the pool queue — re-run with --ticket TICKET within 120 s to keep the place, or with a longer --wait; do not start the work without the pool',
  'pool-ticket-gone': 'the ticket expired or was released — ask again without --ticket (the place is lost)',
}));

const exitFor = (code) => (code && Object.hasOwn(CODE_EXIT, code) ? CODE_EXIT[code] : EXIT.UNEXPECTED);

const hintFor = (code, detail) => {
  if (code === 'readiness-timeout' && Number.isFinite(detail?.waitedMs)) {
    const state = detail.cliState ? `, cliState ${detail.cliState}` : '';
    return `not ready after ${detail.waitedMs} ms${state} — retry, bounded`;
  }
  // The server names the dialog and the fix (D14); a retry cannot help until someone answers it.
  if (code === 'startup-prompt') {
    const served = typeof detail?.detail === 'string' && detail.detail ? detail.detail : 'the agent waits at a Claude Code startup prompt';
    return `${served} — nothing was typed; a retry cannot help until the prompt is answered`;
  }
  if (code && Object.hasOwn(CODE_HINT, code)) return CODE_HINT[code];
  return EXIT_HINT[exitFor(code)];
};

/**
 * Report a failure and exit through the code → exit table. `code` is the
 * server's machine code (or a client-side one such as `server-unreachable`);
 * null means the failure carries no code and exits 1.
 */
const fail = (code, message, detail) => {
  const hint = hintFor(code, detail);
  const line = code
    ? `${code} (${hint})${message && message !== code ? ` — ${message}` : ''}`
    : `${message} (${hint})`;
  process.stderr.write(`error: ${line}\n`);
  process.exit(exitFor(code));
};

// A usage error: the command itself is wrong, so nothing was sent (exit 2).
const die = (msg) => {
  process.stderr.write(`error: ${msg} (${EXIT_HINT[EXIT.USAGE]})\n`);
  process.exit(EXIT.USAGE);
};

const requireEnv = () => {
  if (!PORT && !URL_OVERRIDE) fail('server-unreachable', 'PMUX_URL and PMUX_PORT not set and ~/.purplemux/port missing (is the server running?)');
  if (!TAB_TOKEN && !ENV_TOKEN && !ADMIN_TOKEN) fail('server-unreachable', 'PMUX_TAB_TOKEN and PMUX_TOKEN not set and ~/.purplemux/cli-token missing (is the server running?)');
};

// Failures that happen before the request reaches the server: retrying cannot
// repeat an effect the server never saw.
const CONNECT_ERRORS = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const causeCode = (err) => {
  const cause = err?.cause;
  return cause?.code || cause?.errors?.find((e) => e?.code)?.code || err?.code || null;
};

/**
 * A request that never got an answer. A read, or a request that never
 * connected, is safe to repeat: exit 6. A write that lost its connection after
 * connecting may have taken effect, so it exits 1 and says the outcome is
 * unknown — a blind retry of `tab send` could type the prompt twice.
 */
const networkFailure = (method, requestPath, err) => {
  const cause = causeCode(err);
  // undici reports a network failure as `fetch failed` (no answer) or
  // `terminated` (the body stopped), with a coded cause. Anything else — a
  // malformed URL or header, a port fetch refuses — is deterministic and was
  // never sent: retrying cannot help, and no write can have taken effect.
  const network = (err?.message === 'fetch failed' || err?.message === 'terminated') && cause;
  if (!network) {
    const detail = err?.cause?.message ? ` (${err.cause.message})` : '';
    return fail(null, `request not sent: ${err?.message || String(err)}${detail}`);
  }
  const reason = cause;
  if (CONNECT_ERRORS.has(cause) || method === 'GET' || method === 'HEAD') {
    return fail('server-unreachable', `${BASE} (${reason})`);
  }
  return fail(
    'outcome-unknown',
    `connection lost during ${method} ${requestPath.split('?')[0]} (${reason}); outcome unknown — check the state before retrying`,
  );
};

const request = async (method, requestPath, init) => {
  try {
    return await fetch(`${BASE}${requestPath}`, { ...init, method });
  } catch (err) {
    return networkFailure(method, requestPath, err);
  }
};

const readBody = async (method, requestPath, resp, as) => {
  try {
    return await resp[as]();
  } catch (err) {
    if (!(err instanceof SyntaxError)) return networkFailure(method, requestPath, err);
    // An error status still has a status to report; a success does not.
    if (!resp.ok) return null;
    return fail(null, `HTTP ${resp.status} with a body that is not valid JSON`);
  }
};

// Servers built before the contract carry the same facts without `code`; a
// rollback must not turn a closed tab back into a retryable exit 1.
const legacyCode = (body) => {
  if (body.error === 'Tab not found') return 'tab-not-found';
  if (body.error === 'Tab session is not running' || body.error === 'session not found') return 'session-not-running';
  if (body.error === 'agent-target-changed') return 'target-changed';
  if (body.error === 'agent-not-ready' && typeof body.detail === 'string') return body.detail;
  return null;
};

const defectLines = (defects) => defects.map((d) => `  ${d.eventId ? `${d.eventId} ` : ''}${d.message}`).join('\n');

const failFromResponse = (resp, body) => {
  if (!body || typeof body !== 'object') return fail(null, `HTTP ${resp.status}`);
  if (Array.isArray(body.defects) && body.defects.length) process.stderr.write(`question defects:\n${defectLines(body.defects)}\n`);
  const code = typeof body.code === 'string' ? body.code : legacyCode(body);
  const message = typeof body.error === 'string' ? body.error : `HTTP ${resp.status}`;
  return fail(code, code ? message : `${message} (HTTP ${resp.status})`, body);
};

const out = (body) => {
  process.stdout.write(JSON.stringify(body, null, 2) + '\n');
};

const isJson = (resp) => (resp.headers.get('content-type') || '').includes('json');

/**
 * Every CLI route answers errors as JSON with a `code`. A 404 WITHOUT a JSON
 * body is the framework's own not-found page: the running server has no such
 * route (it predates this CLI). That exits 6 like any absent capability, and
 * the `routes-absent` code tells a caller (deploy-live.sh, bash-guard) that
 * the server answered, which `server-unreachable` does not.
 */
const failIfRouteAbsent = (resp, requestPath) => {
  if (resp.status === 404 && !isJson(resp) && requestPath.startsWith('/api/cli/')) {
    fail('routes-absent', `${requestPath.split('?')[0]} is not served by the purplemux ${SERVER_LABEL}`);
  }
};

const api = async (method, path, data) => {
  const opts = {
    method,
    headers: headersFor(path, { 'Content-Type': 'application/json' }, data, method),
  };
  if (data !== undefined) opts.body = JSON.stringify(data);
  const resp = await request(method, path, opts);
  failIfRouteAbsent(resp, path);
  const body = isJson(resp) ? await readBody(method, path, resp, 'json') : null;
  if (!resp.ok) failFromResponse(resp, body);
  // Every CLI route answers JSON; a success without it is not a purplemux
  // answer (another server on the port), and printing `null` would pass it off
  // as one.
  if (!isJson(resp)) fail(null, `HTTP ${resp.status} without a JSON body — is purplemux the server ${SERVER_LABEL}?`);
  return { resp, body };
};

const apiRaw = async (method, path) => {
  const resp = await request(method, path, { headers: headersFor(path, undefined, undefined, method) });
  failIfRouteAbsent(resp, path);
  if (!resp.ok) failFromResponse(resp, isJson(resp) ? await readBody(method, path, resp, 'json') : null);
  return resp;
};

const cmdWorkspaces = async () => {
  requireEnv();
  const { body } = await api('GET', '/api/cli/workspaces');
  out(body);
};

const cmdTabList = async (args) => {
  requireEnv();
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  const qs = wsId ? `?workspaceId=${encodeURIComponent(wsId)}` : '';
  const { body } = await api('GET', `/api/cli/tabs${qs}`);
  out(body);
};

const cmdWorkspaceDirs = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  const path = `/api/cli/workspaces/${wsId}/directories`;
  if (sub === 'show') {
    const { body } = await api('GET', path);
    return out(body);
  }
  if (sub === 'set') {
    // Resolve here, not server-side: a relative path would otherwise be
    // resolved against the server's cwd rather than the caller's.
    const directories = stripFlags(rest, ['--workspace', '-w']).map((d) => require('path').resolve(d));
    if (!directories.length) die('at least one DIR is required');
    const { body } = await api('PATCH', path, { directories });
    return out(body);
  }
  die('usage: workspace dirs show|set -w WS [DIR...]');
};

const WORKSPACE_CREATE_USAGE = 'usage: workspace create -n NAME -d DIR [-d DIR ...] [--json]';

/**
 * Parse `workspace create` arguments. Returns { name, directories, json } or a
 * usage error string. DIRs are resolved against the caller's cwd, as
 * `workspace dirs set` does; the first is the primary.
 */
const parseWorkspaceCreateArgs = (args, cwd = process.cwd()) => {
  let name = null;
  const directories = [];
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '-n' || arg === '--name') {
      if (i + 1 >= args.length) return `${arg} needs a value`;
      if (name !== null) return `${arg} given more than once`;
      name = args[++i];
    } else if (arg === '-d' || arg === '--dir') {
      if (i + 1 >= args.length) return `${arg} needs a value`;
      const dir = args[++i];
      if (!dir.trim()) return `${arg} needs a non-empty path`;
      directories.push(path.resolve(cwd, dir));
    } else {
      return `unexpected argument: ${arg}. ${WORKSPACE_CREATE_USAGE}`;
    }
  }
  if (name === null || !name.trim()) return `-n NAME is required. ${WORKSPACE_CREATE_USAGE}`;
  if (!directories.length) return `at least one -d DIR is required. ${WORKSPACE_CREATE_USAGE}`;
  return { name: name.trim(), directories, json };
};

const cmdWorkspaceCreate = async (args) => {
  const parsed = parseWorkspaceCreateArgs(args);
  if (typeof parsed === 'string') die(parsed);
  requireEnv();
  const { body } = await api('POST', '/api/cli/workspaces', { name: parsed.name, directories: parsed.directories });
  if (parsed.json) return out(body);
  process.stdout.write(`${body.id}\n`);
};

const cmdWorkspacePeers = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  const path = `/api/cli/workspaces/${wsId}/peers`;
  if (sub === 'show') {
    const { body } = await api('GET', path);
    return out(body);
  }
  if (sub === 'set') {
    const allowedPeers = stripFlags(rest, ['--workspace', '-w']);
    const { body } = await api('PATCH', path, { allowedPeers });
    return out(body);
  }
  die('usage: workspace peers show|set -w WS [PEER_WS_ID...]');
};

/**
 * `PMUX_TAB_ID` is the tab's layout id; the server adopts an orphan session
 * under the id its token was minted for, so the two stay equal. The
 * session-name parse remains for tabs created before `PMUX_TAB_ID` existed.
 */
const deriveOwnTabId = () => {
  if (process.env.PMUX_TAB_ID) return process.env.PMUX_TAB_ID;
  const session = ownSessionName();
  const m = session ? session.match(/^pt-ws-.*-(tab-.+)$/) : null;
  return m ? m[1] : null;
};

const cmdOrchestration = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  if (sub === 'status') {
    const { body } = await api('GET', `/api/cli/workspaces/${wsId}/orchestration`);
    return out(body);
  }
  if (['on', 'off', 'recover', 'handoff'].includes(sub)) {
    const positional = stripFlags(rest, ['--workspace', '-w']);
    const tabId = positional[0] || deriveOwnTabId();
    if (sub !== 'off' && !tabId) die('TAB_ID required (or run inside a purplemux tab)');
    const endpoint = `/api/cli/workspaces/${wsId}/orchestration`;
    const current = (await api('GET', endpoint)).body.orchestration;
    if (!Number.isSafeInteger(current?.revision) || current.revision < 0) die('Server did not return a valid orchestration revision');
    const patch = sub === 'off' ? { enabled: false } : { enabled: true, orchestratorTabId: tabId };
    const { body } = await api('PATCH', endpoint, { ...patch, expectedRevision: current.revision,
      mode: sub === 'handoff' ? 'handoff' : sub === 'recover' || sub === 'on' ? 'recover' : 'update' });
    return out(body);
  }
  die('usage: orchestration status|on|off|recover|handoff -w WS [TAB_ID]');
};

const cmdStandup = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  if (sub === 'show') {
    const { body } = await api('GET', `/api/cli/workspaces/${wsId}/standup`);
    return out(body);
  }
  if (sub === 'report') {
    const raw = flagValue(rest, '--json') || await readStdin();
    let report;
    try { report = JSON.parse(raw); } catch { die("standup report must be valid JSON — pass --json '{...}' or pipe JSON on stdin"); }
    const { body } = await api('POST', `/api/cli/workspaces/${wsId}/standup`, report);
    return out(body);
  }
  die("usage: standup report -w WS --json '{...}' | standup show -w WS");
};

// Mirrors MAX_BURNDOWN_HISTORY (src/lib/burndown.ts). The generator's history file only grows;
// trimming here keeps the request under the route's body limit long after the server cap applies.
const BURNDOWN_HISTORY_ROWS = 2000;

const readJsonFlag = async (rest, what) => {
  const value = flagValue(rest, '--json');
  let raw;
  if (value && value.startsWith('@')) {
    try { raw = fs.readFileSync(value.slice(1), 'utf8'); } catch (err) { die(`${what}: cannot read ${value.slice(1)}: ${err.code || err.message}`); }
  } else {
    raw = value || await readStdin();
  }
  try { return JSON.parse(raw); } catch { return die(`${what} must be valid JSON — pass --json @FILE, --json '{...}', or pipe JSON on stdin`); }
};

const newestHistory = (snapshot) => {
  if (!snapshot || !Array.isArray(snapshot.history) || snapshot.history.length <= BURNDOWN_HISTORY_ROWS) return snapshot;
  const history = snapshot.history.map((row, index) => ({ row, index, at: Date.parse(row && row.at) }))
    .sort((a, b) => (a.at - b.at) || (a.index - b.index)).slice(-BURNDOWN_HISTORY_ROWS).map((entry) => entry.row);
  return { ...snapshot, history };
};

const cmdBurndown = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  if (sub === 'show') {
    const { body } = await api('GET', `/api/cli/workspaces/${wsId}/burndown`);
    return out(body);
  }
  if (sub === 'publish') {
    const snapshot = newestHistory(await readJsonFlag(rest, 'burndown'));
    const { body } = await api('POST', `/api/cli/workspaces/${wsId}/burndown`, snapshot);
    return out(body);
  }
  die('usage: burndown publish -w WS --json @burndown.json | burndown show -w WS');
};

// Mirrors MAX_FLOW_BYTES (src/lib/flow.ts): above it the route answers 413, and well above it
// the body limit answers without a code, so the CLI refuses before sending.
const FLOW_MAX_BYTES = 1024 * 1024;
const FLOW_HISTORY_MODES = ['all', 'window', 'none'];
const FLOW_USAGE = 'usage: flow publish -w WS --json @FILE | flow show -w WS [--json] [--history all|window|none]';

const durationText = (ms) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
};

// Mirrors flowDurationText and lockBusyPhrase (src/lib/flow-flags.ts): the derived flag text, the
// panel and this line say the same sentence; tests/unit/bin/cli-flow.test.ts pins the parity.
const flowMinutesText = (ms) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
};

// Mirrors SHARE_EPSILON (src/lib/flow-flags.ts): the shown percent floors, so it never shows a threshold the flag missed.
const FLOW_SHARE_EPSILON = 1e-9;

const flowLockBusyPhrase = (share, knownMinutes, windowMinutes) => {
  const window = flowMinutesText(windowMinutes * 60_000);
  const known = flowMinutesText(knownMinutes * 60_000);
  if (share === null) return `busy share unknown: ${known} known in the last ${window}`;
  const shown = `${Math.floor(share * 100 + FLOW_SHARE_EPSILON)}%`;
  return Math.round(knownMinutes * 60_000) >= Math.round(windowMinutes * 60_000)
    ? `held ${shown} of the last ${window}`
    : `held ${shown} of ${known} known in the last ${window}`;
};

const flowSection = (title, entries, line) => (entries.length ? [title, ...entries.map((entry) => `  ${line(entry)}`)] : [`${title}  none`]);

const flowText = (wsId, body, now) => {
  const { snapshot, receivedAt } = body.flow;
  const iso = (ms) => new Date(ms).toISOString();
  const lines = [`flow ${wsId}  source ${snapshot.source}  generated ${iso(snapshot.generatedAt)}  received ${iso(receivedAt)} (${durationText(now - receivedAt)} ago)`];
  if (body.stale) lines.push(`stale — last published ${durationText(now - receivedAt)} ago`);
  lines.push(...flowSection('queues', snapshot.queues, (queue) => {
    const length = queue.capacity === null ? `${queue.items.length}` : `${queue.items.length}/${queue.capacity}`;
    const oldest = queue.items.length ? durationText(now - Math.min(...queue.items.map((item) => item.since))) : '—';
    return `${queue.name}  ${length}  oldest ${oldest}`;
  }));
  const { derived } = body;
  // A server before story 02 sends no `derived`: the busy share is then left out, never shown as 0.
  const busy = (name) => {
    if (!derived || !Object.hasOwn(derived.lockBusyShare, name) || !Object.hasOwn(derived.lockKnownMinutes, name)) return '';
    return `  (${flowLockBusyPhrase(derived.lockBusyShare[name], derived.lockKnownMinutes[name], derived.windowMinutes)})`;
  };
  lines.push(...flowSection('locks', snapshot.locks, (lock) => {
    if (lock.heldBy === null) return `${lock.name}  free${busy(lock.name)}`;
    return lock.since === null
      ? `${lock.name}  held by ${lock.heldBy} (since unknown)${busy(lock.name)}`
      : `${lock.name}  held by ${lock.heldBy} since ${iso(lock.since)} (${durationText(now - lock.since)})${busy(lock.name)}`;
  }));
  lines.push(...flowSection('meters', snapshot.meters, (meter) => [
    `${meter.name}  ${meter.unit ? `${meter.value} ${meter.unit}` : meter.value}`,
    ...(meter.limit === null ? [] : [`limit ${meter.limit}`]),
    ...(meter.windowMinutes === null ? [] : [`window ${meter.windowMinutes}m`]),
  ].join('  ')));
  lines.push(...flowSection('flags', snapshot.flags, (flag) => `${flag.severity}  ${flag.text}`));
  if (derived) lines.push(...flowSection('derived flags', derived.flags, (flag) => `${flag.severity}  ${flag.rule}  ${flag.text}`));
  return `${lines.join('\n')}\n`;
};

const cmdFlow = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!['show', 'publish'].includes(sub)) die(FLOW_USAGE);
  if (!wsId) die('--workspace is required');
  if (sub === 'show') {
    const history = flagValue(rest, '--history') || 'all';
    if (!FLOW_HISTORY_MODES.includes(history)) die(`--history: saw ${history}, expected all, window or none`);
    requireEnv();
    const { body } = await api('GET', `/api/cli/workspaces/${encodeURIComponent(wsId)}/flow?history=${history}`);
    // Like `config get` for an unset key: absence is its own exit, never an empty board.
    if (!body.flow) return fail('flow-not-found', `no flow published for ${wsId}`);
    if (rest.includes('--json')) return out(body);
    process.stdout.write(flowText(wsId, body, Date.now()));
    return;
  }
  const snapshot = await readJsonFlag(rest, 'flow');
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > FLOW_MAX_BYTES) fail('flow-too-large', `saw ${bytes} bytes, expected at most ${FLOW_MAX_BYTES}; nothing was sent`);
  requireEnv();
  const { body } = await api('POST', `/api/cli/workspaces/${encodeURIComponent(wsId)}/flow`, snapshot);
  if (body.historyReset) {
    process.stderr.write('warning: history reset: the stored record did not validate and was kept aside (flow.json.corrupt-<receivedAt>)\n');
  }
  process.stdout.write(`ok ${body.receivedAt} ${body.historyRows}\n`);
};

const SPEND_USAGE = 'usage: spend show -w WS [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--by tab|day|model|role|seat|phase|item] [--json]'
  + ' | spend phases -w WS [--day YYYY-MM-DD] [--json]';
const SPEND_VALUE_FLAGS = { show: ['-w', '--workspace', '--since', '--until', '--by'], phases: ['-w', '--workspace', '--day'] };
const SPEND_BOOL_FLAGS = ['--json'];

// A cost the server could not price is null: it prints as "—", never as $0.
const spendCost = (row) => {
  const cost = row.costUsd === null ? '—' : `est. $${row.costUsd.toFixed(row.costUsd < 1 ? 4 : 2)}`;
  return row.unpricedTokens > 0 && row.costUsd !== null ? `${cost} (+${row.unpricedTokens} unpriced)` : cost;
};

// A row with no tokens has no share: "—", never 0%.
const cacheReadShare = (row) => (row.totalTokens > 0 ? `${Math.round((row.cacheReadTokens / row.totalTokens) * 100)}%` : '—');
// The cache reads' part of the estimated cost; "—" when the cost or its cache-read part is not known.
const cacheReadCostShare = (row) => (row.cacheReadCostUsd !== null && row.cacheReadCostUsd !== undefined && row.costUsd
  ? `est. ${Math.round((row.cacheReadCostUsd / row.costUsd) * 100)}%` : '—');

const writeTable = (table) => {
  const widths = table[0].map((_, i) => Math.max(...table.map((cells) => cells[i].length)));
  for (const cells of table) process.stdout.write(cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd() + '\n');
};

// The unattributed row, then (phase and item) one indented row per reason, which sum to it.
const unattributedRows = (view, line) => (view.unattributed
  ? [line(view.unattributed), ...(view.unattributedReasons || []).map((row) => line({ ...row, key: `  ${row.key}` }))] : []);

const phaseNote = (view) => {
  if (!view.phaseBasis) return;
  const { ledgerHorizon: horizon, ledgerReadable } = view.phaseBasis;
  const ledger = ledgerReadable === false ? 'the ledger could not be read, so no phase is known (see the error note)'
    : horizon === null ? 'the ledger holds no items for this workspace yet' : `no history before ${new Date(horizon).toISOString()}`;
  process.stdout.write(`note: phase is the ledger item the tab held at each message's 5-min slot; ${ledger}\n`);
};

const printSpend = (view) => {
  const columns = ['KEY', 'LABEL', 'INPUT', 'OUTPUT', 'CACHE-READ', 'CACHE-CREATE', 'TOTAL', 'CACHE-READ-SHARE', 'SUBAGENTS', 'COST',
    'CACHE-READ-COST-SHARE'];
  const line = (row) => [row.key, row.label, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens,
    row.totalTokens, cacheReadShare(row), row.sidechainTokens, spendCost(row), cacheReadCostShare(row)].map(String);
  process.stdout.write(`spend ${view.workspaceId} ${view.from}..${view.to} UTC by ${view.by} (cost is an estimate)\n`);
  writeTable([columns, ...view.rows.map(line), ...unattributedRows(view, line), line(view.totals)]);
  process.stdout.write(`cache reads: ${view.totals.cacheReadTokens} of ${view.totals.totalTokens} tokens (${cacheReadShare(view.totals)}); `
    + `${cacheReadCostShare(view.totals)} of the est. cost\n`);
  phaseNote(view);
  if (view.roleBasis === 'current-orchestrator') process.stdout.write('note: role uses the current orchestrator mapping, not the one at the time of use\n');
  process.stdout.write('note: Codex and Grok usage counts on the session start day\n');
  const index = view.index || {};
  if (index.state === 'indexing') process.stdout.write(`note: partial — indexing ${index.filesIndexed} of ${index.filesTotal} files\n`);
  else if (index.state !== 'ready') process.stdout.write(`note: spend index state ${index.state} is not one this CLI knows\n`);
  if (index.error) process.stdout.write(`note: ${index.error}\n`);
};

// Distinct 5-min slots with usage, as "1h 05m"; null (no message time) prints "—".
const wallTime = (ms) => {
  if (ms === null || ms === undefined) return '—';
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
};

const landingLine = (metric) => {
  const window = metric.window === 'day' ? 'day' : `7d (${metric.from}..${metric.to})`;
  const value = metric.value === null
    ? `— (${metric.reason}; ${metric.cacheReadTokens} cache reads)`
    : `${Math.round(metric.value)} (${metric.cacheReadTokens} cache reads / ${metric.landedItems} landed)`;
  return `cache_read_tokens_per_landed_item ${window}: ${value}\n`;
};

const printSpendPhases = (view) => {
  const columns = ['PHASE', 'LABEL', 'WALL', 'INPUT', 'OUTPUT', 'CACHE-READ', 'CACHE-CREATE', 'TOTAL', 'CACHE-READ-SHARE', 'COST',
    'CACHE-READ-COST-SHARE'];
  const line = (row) => [row.key, row.label, wallTime(row.wallMs), row.inputTokens, row.outputTokens, row.cacheReadTokens,
    row.cacheCreationTokens, row.totalTokens, cacheReadShare(row), spendCost(row), cacheReadCostShare(row)].map(String);
  process.stdout.write(`spend phases ${view.workspaceId} ${view.day} UTC (cost is an estimate)\n`);
  writeTable([columns, ...view.rows.map(line), ...unattributedRows(view, line), line(view.totals)]);
  process.stdout.write(landingLine(view.cacheReadPerLandedItem.day));
  process.stdout.write(landingLine(view.cacheReadPerLandedItem['7d']));
  phaseNote(view);
  process.stdout.write('note: wall = distinct 5-min slots with usage in the row; phases overlap, so the rows may sum above the total\n');
};

const cmdSpend = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub !== 'show' && sub !== 'phases') die(SPEND_USAGE);
  const positional = stripBooleanFlags(stripFlags(rest, SPEND_VALUE_FLAGS[sub]), SPEND_BOOL_FLAGS);
  if (positional.length) die(`unexpected argument: ${positional[0]} — ${SPEND_USAGE}`);
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  const qs = new URLSearchParams({ workspaceId: wsId });
  for (const name of SPEND_VALUE_FLAGS[sub].filter((flag) => flag.startsWith('--') && flag !== '--workspace').map((flag) => flag.slice(2))) {
    const value = flagValue(rest, `--${name}`);
    if (value !== null) qs.set(name, value);
  }
  requireEnv();
  const { body } = await api('GET', `/api/cli/spend${sub === 'phases' ? '/phases' : ''}?${qs}`);
  if (rest.includes('--json')) out(body);
  // An index that cannot be read has no numbers: its totals are zeros that mean nothing.
  if (body.index && body.index.state === 'unavailable') {
    return fail(null, `spend not available: ${body.index.error || 'the spend index cannot be read'}`);
  }
  if (rest.includes('--json')) return;
  if (sub === 'phases') printSpendPhases(body);
  else printSpend(body);
};

// A value printed inside a command an agent may copy into its shell: single-quoted unless plainly safe.
const shellArg = (value) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(String(value)) ? String(value) : `'${String(value).replace(/'/g, `'\\''`)}'`);

/**
 * Story 12: the one-line inbox notice no longer carries the ack arguments or the reconcile steps; they
 * are pulled here, from the same snapshot, by an agent that chooses to read them.
 */
const missionAckCommand = (wsId, answer, item, generation) => ['purplemux mission ack', '-w', shellArg(wsId), '--run', shellArg(answer.runId),
  '--answer', shellArg(answer.id), '--generation', String(generation), '--revision', String(item.revision),
  '--event-id', shellArg(`mission-ack-${answer.id}`.slice(0, 128)), '--producer-at', String(answer.createdAt)].join(' ');

// The key the notice line carries: the same hash the server makes (missionBootstrapKey).
const missionBootstrapKey = (bootstrapId, workspaceId, runId) =>
  `boot-${require('crypto').createHash('sha256').update(JSON.stringify([bootstrapId, workspaceId, runId])).digest('hex').slice(0, 32)}`;

const missionBootstrapSteps = (body, wsId) => {
  // Every pending entry of every bootstrap (a late notice belongs to its own bootstrap); an older
  // server that does not list them offers only the latest bootstrap.
  const pending = Array.isArray(body.pendingBootstrapEntries)
    ? body.pendingBootstrapEntries
    : (body.bootstrap ? body.bootstrap.entries.map((entry) => ({ bootstrapId: body.bootstrap.id, entry })) : []);
  return pending
    .filter(({ entry }) => entry.workspaceId === wsId && ['queued', 'dispatching', 'submitted'].includes(entry.state))
    .map(({ bootstrapId, entry }) => {
      const run = body.runs.find((candidate) => candidate.id === entry.runId);
      const candidates = body.items.filter((item) => item.runId === entry.runId && item.state === 'candidate');
      return {
        key: missionBootstrapKey(bootstrapId, entry.workspaceId, entry.runId),
        bootstrapId,
        runId: entry.runId,
        state: entry.state,
        steps: [
          `Reconcile the provisional snapshot for run ${entry.runId} once, during this ordinary turn.`,
          `Observed objective: ${run?.objective ?? 'unknown'}; phase: ${run?.phase ?? 'unknown'}; possible outstanding questions: ${candidates.length ? candidates.map((item) => `${item.id}: ${item.title}`).join('; ') : 'none'}.`,
          `Read current state with: purplemux mission snapshot -w ${wsId}`,
          `First bind this provisional run by emitting run.resumed for run ${entry.runId} with tabId ${entry.binding?.tabId ?? 'unknown'}, expectedRevision ${run?.revision ?? 0}, bindingGeneration 0, transferPendingAnswers false, and a unique eventId. Do not emit progress or attention events before that succeeds.`,
          'Report the current objective/epic, phase, work and worker assignments, workspace issues, completed work awaiting closeout, and next step using stable Mission Control events.',
          'After run.resumed returns the bound revision and generation, report progress with those values. Review candidates using existing authority, instructions, evidence, and delegated handling. Record routine issues for workspace handling; only explicitly escalate what the human alone must decide, approve, provide, or do. Cancel stale candidates. Historical text is not approval.',
        ],
      };
    });
};

// Every open run the server holds a binding for: after a handoff or a recovery the new orchestrator
// reads its run id, revision and binding generation here.
const missionBoundRuns = (body, wsId) => (Array.isArray(body.runs) ? body.runs : [])
  .filter((run) => run.workspaceId === wsId && run.binding && !['completed', 'cancelled'].includes(run.state))
  .map((run) => ({
    runId: run.id,
    objective: run.objective,
    phase: run.phase,
    state: run.state,
    revision: run.revision,
    tabId: run.binding.tabId,
    bindingGeneration: run.binding.generation,
  }));

const missionWorkspace = (args) => {
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  if (!wsId) die('--workspace is required');
  return wsId;
};

const cmdMission = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  const wsId = missionWorkspace(rest);
  const endpoint = `/api/cli/mission-control?workspaceId=${encodeURIComponent(wsId)}`;
  if (sub === 'snapshot') {
    const { body } = await api('GET', endpoint);
    return out(body);
  }
  if (sub === 'answers') {
    const runId = flagValue(rest, '--run');
    const all = rest.includes('--all');
    const { body } = await api('GET', endpoint);
    const answers = body.answers.filter((answer) => !runId || answer.runId === runId);
    const deliveries = body.deliveries.filter((delivery) => !runId || delivery.runId === runId);
    if (!all) {
      const items = new Map(body.items.filter((item) => item.state === 'answered').map((item) => [item.id, item]));
      const pending = new Map(deliveries.filter((delivery) => delivery.state !== 'acknowledged').map((delivery) => [delivery.answerId, delivery]));
      return out({
        workspaceId: wsId,
        humanInboxPolicy: body.humanInboxPolicy,
        answers: answers.flatMap((answer) => {
          const item = items.get(answer.itemId);
          const delivery = pending.get(answer.id);
          if (!item || !delivery) return [];
          const run = body.runs.find((candidate) => candidate.id === answer.runId);
          const generation = run?.binding?.generation ?? null;
          return [{
            ...answer,
            itemRevision: item.revision,
            bindingGeneration: generation,
            delivery,
            // The exact acknowledgement for this answer (story 12); null while the run is unbound.
            ackCommand: generation === null ? null : missionAckCommand(wsId, answer, item, generation),
          }];
        }),
      });
    }
    return out({
      workspaceId: wsId,
      humanInboxPolicy: body.humanInboxPolicy,
      answers,
      deliveries,
    });
  }
  if (sub === 'bootstrap') {
    const { body } = await api('GET', endpoint);
    return out({ workspaceId: wsId, entries: missionBootstrapSteps(body, wsId), runs: missionBoundRuns(body, wsId) });
  }
  if (sub === 'events') {
    const raw = flagValue(rest, '--json') || await readStdin();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { die("mission events must be valid JSON — pass --json '{\"events\":[...]}' or pipe JSON on stdin"); }
    const data = Array.isArray(parsed) ? { events: parsed } : parsed;
    const { body } = await api('POST', `/api/cli/mission-control/events?workspaceId=${encodeURIComponent(wsId)}`, data);
    return out(body);
  }
  if (sub === 'ack') {
    const runId = flagValue(rest, '--run');
    const answerId = flagValue(rest, '--answer');
    const generation = flagValue(rest, '--generation');
    const revision = flagValue(rest, '--revision');
    const eventId = flagValue(rest, '--event-id');
    const producerAt = flagValue(rest, '--producer-at');
    if (!runId || !answerId || !eventId) die('--run, --answer, and --event-id are required');
    if (!generation || !/^\d+$/.test(generation)) die('--generation must be a nonnegative integer');
    if (!revision || !/^\d+$/.test(revision)) die('--revision must be a nonnegative integer');
    if (!producerAt || !/^\d+$/.test(producerAt) || !Number.isSafeInteger(Number(producerAt))) {
      die('--producer-at must be a nonnegative safe integer copied from the answer command');
    }
    const event = {
      eventId,
      schemaVersion: 1,
      workspaceId: wsId,
      runId,
      expectedRevision: Number(revision),
      producerAt: Number(producerAt),
      bindingGeneration: Number(generation),
      type: 'answer.acknowledged',
      payload: { answerId },
    };
    const { body } = await api('POST', `/api/cli/mission-control/events?workspaceId=${encodeURIComponent(wsId)}`, { events: [event] });
    return out(body);
  }
  if (sub === 'ask') return missionAsk(rest, wsId);
  die('usage: mission snapshot|bootstrap|events|answers|ack|ask -w WS [options]');
};

// `mc ask` (ADR-0037 §3): the server's question check before the post, so an unreadable
// question is fixed in the same turn. --fix asks for the curator reshape, which story 23 enables.
const missionAsk = async (rest, wsId) => {
  const draft = await readJsonFlag(rest, 'mc ask draft');
  const events = draft && Array.isArray(draft.events) ? draft.events : [draft];
  const event = events.length === 1 ? events[0] : null;
  if (!event || !['attention.opened', 'attention.updated'].includes(event.type) || !event.payload || typeof event.payload !== 'object') {
    die('mc ask takes one attention.opened or attention.updated event (or { "events": [that event] })');
  }
  // --follows-up (ADR-0037 amendment D2): the new item links to the answered item and resolves it.
  const followsUp = flagValue(rest, '--follows-up');
  if (rest.includes('--follows-up') && !followsUp) die('--follows-up takes the id of the answered item that this question follows up');
  if (followsUp) {
    if (event.type !== 'attention.opened') die('--follows-up applies to attention.opened only: a link is set when an item opens and never changes');
    if (event.payload.followsUp !== undefined && event.payload.followsUp !== followsUp) {
      die(`--follows-up ${followsUp} differs from the draft's followsUp ${event.payload.followsUp}; keep one`);
    }
    event.payload = { ...event.payload, followsUp };
  }
  const body = await postAsk(event, wsId, rest.includes('--fix'));
  for (const entry of body.followedUps || (body.followedUp ? [body.followedUp] : [])) process.stderr.write(`${followedUpLine(entry)}\n`);
  return out(body);
};

// The answer the follow-up acknowledged (ADR-0037 amendment D2, rule 4), on one line.
const followedUpLine = (entry) => {
  const labels = Array.isArray(entry.optionLabels) && entry.optionLabels.length ? entry.optionLabels.join(', ') : 'text only';
  const state = entry.resolved ? `${entry.itemId} is resolved` : `${entry.itemId} was already resolved; only the link was written`;
  return `follows up ${entry.itemId}: the owner answered ${labels}: ${JSON.stringify(entry.text || '')} (answer ${entry.answerId}); ${state}`;
};

// `--fix` (story 23 AC 3): the curator's reshape, accepted only past the preservation check and the format-2 validator.
// The reshaped event goes back through the check and is posted in this same command; the original is in `source`.
const RESHAPE_OUTCOME_TEXT = {
  off: (r) => r.reason,
  'not-a-draft': (r) => `not reshaped: ${r.reason}`,
  'not-reshapable': (r) => `not reshaped: a reshape changes wording only, and these need a structural fix:\n${defectLines(r.defects)}`,
  shadow: (r) => r.reason,
  'no-reply': (r) => `the curator gave no reshape (${r.reason}); fix the defects in the draft`,
  refused: (r) => `the curator's reshape was refused (${r.label === 'not-preserved' ? 'it moved a fixed field' : 'still invalid'}):\n${defectLines(r.defects)}`,
};

const reshapeAsk = async (event, question, query) => {
  const { body: reshape } = await api('POST', `/api/cli/mission-control/questions/reshape?${query}`, { question });
  if (reshape.outcome === 'reshaped') {
    process.stderr.write(`--fix: the curator reshaped the draft (prompt ${reshape.promptVersion}); the original is kept in question_json.source\n`);
    const { itemId, humanReview, followsUp } = event.payload;
    // --fix keeps the fields beside the question (ADR-0037 amendment D2, rule 2).
    return { ...event, payload: { itemId, ...(humanReview ? { humanReview } : {}), ...(followsUp !== undefined ? { followsUp } : {}), ...reshape.question } };
  }
  const text = Object.hasOwn(RESHAPE_OUTCOME_TEXT, reshape.outcome) ? RESHAPE_OUTCOME_TEXT[reshape.outcome](reshape) : 'the curator answered an outcome this CLI does not know';
  process.stderr.write(`--fix: ${text}\n`);
  return null;
};

// The question check, then the event: what `mc ask` does with a draft, and what `curator spot-check open` posts.
const postAsk = async (event, wsId, fix) => {
  const { itemId, humanReview, followsUp, ...question } = event.payload;
  const query = `workspaceId=${encodeURIComponent(wsId)}`;
  // The review rides beside the question so the check names a missing class (story 36, D6); it is not a question field.
  // So does a follow-up, with the ids the store checks it against (ADR-0037 amendment D2, rule 2).
  const { body: check } = await api('POST', `/api/cli/mission-control/questions/check?${query}`, {
    question,
    ...(humanReview ? { humanReview } : {}),
    ...(followsUp !== undefined ? { followsUp, itemId, runId: event.runId } : {}),
  });
  if (!check.ok) {
    process.stderr.write(`question defects (${check.defects.length}, min-version ${check.minVersion}):\n${defectLines(check.defects)}\n`);
    // A refused follow-up is the store's refusal, not a wording defect: no reshape fixes it, and it exits by its own code.
    const followUp = check.defects.find((d) => d.field === 'followsUp' && typeof d.code === 'string');
    if (followUp && check.defects.length === 1) return fail(followUp.code, `${followUp.message}; nothing was posted`, followUp);
    if (fix && !followUp) {
      const reshaped = await reshapeAsk(event, question, query);
      if (reshaped) return postAsk(reshaped, wsId, false);
    }
    return fail('question-invalid', `${check.defects.length} defect${check.defects.length === 1 ? '' : 's'}; nothing was posted`);
  }
  if (check.lint.length) process.stderr.write(`question lint (accepted at min-version ${check.minVersion}):\n${defectLines(check.lint)}\n`);
  const { body } = await api('POST', `/api/cli/mission-control/events?${query}`, { events: [event] });
  return body;
};

// `owner messages` (story 36, D8): the owner's prompts of a workspace, oldest first, so a tab can cite one by its id.
const cmdOwner = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub !== 'messages') die('usage: owner messages -w WS [--since ISO] [--json]');
  const wsId = missionWorkspace(rest);
  const since = flagValue(rest, '--since');
  if (since !== null && since !== undefined && Number.isNaN(Date.parse(since))) die(`--since must be an ISO time such as 2026-11-04T01:30:00Z, got "${since}"`);
  requireEnv();
  const query = `workspaceId=${encodeURIComponent(wsId)}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
  const { body } = await api('GET', `/api/cli/owner/messages?${query}`);
  if (rest.includes('--json')) return out(body);
  if (!body.messages.length) {
    process.stdout.write(`no owner messages in ${body.workspaceId}${body.since ? ` since ${body.since}` : ''}\n`);
    return;
  }
  for (const m of body.messages) {
    const text = m.withheld ? "(withheld: it looks like it holds a credential; read it in the owner's own history)" : m.message;
    process.stdout.write(`${m.id}  ${m.sentAt}  ${m.tabId || '—'}\n${text.split('\n').map((line) => `  ${line}`).join('\n')}\n`);
  }
};

const cmdPortfolio = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'board') {
    const workspaceIds = flagValue(rest, '--workspaces');
    if (!workspaceIds) die('--workspaces requires a comma-separated explicit selection');
    const { body } = await api('GET', `/api/cli/portfolio?workspaces=${encodeURIComponent(workspaceIds)}`);
    return out(body);
  }
  if (sub === 'report' || sub === 'applied' || sub === 'resolved') {
    const workspaceId = missionWorkspace(rest);
    const raw = flagValue(rest, '--json') || await readStdin();
    let data;
    try { data = JSON.parse(raw); } catch { die('portfolio event must be valid JSON'); }
    if (!data || Array.isArray(data) || typeof data !== 'object' || data.workspaceId !== workspaceId) {
      die('portfolio event workspaceId must match -w');
    }
    if (sub === 'applied') data.type = 'applied';
    if (sub === 'resolved') data.type = 'resolved';
    const { body } = await api('POST', '/api/cli/portfolio/events', data);
    return out(body);
  }
  die('usage: portfolio board --workspaces WS,WS | portfolio report|applied|resolved -w WS --json JSON');
};

// ---- leases (ADR-0011) ----

const TTL_UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

/** `45m`, `3h`, `2d`, `90s`, `90` (seconds) or `none` (no expiry). */
const parseTtl = (raw) => {
  if (raw === 'none') return null;
  const m = /^(\d+)([smhd]?)$/.exec(raw || '');
  if (!m) die(`--ttl must be a duration such as 45m, 3h, 2d, 90s, or "none" — got "${raw}"`);
  return Number(m[1]) * TTL_UNITS[m[2] || 's'];
};

const age = (seconds) => {
  if (seconds === null || seconds === undefined) return '-';
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return `${seconds}s`;
};

const holderText = (h) => {
  if (h.admin) return 'admin';
  const ws = h.workspaceName ? `${h.workspaceId} (${h.workspaceName})` : h.workspaceId;
  const tab = h.tabName ? `${h.tabId} (${h.tabName})` : h.tabId;
  return `${ws} / ${tab}${h.verified ? '' : h.identity === 'hook' ? ' hook-identity' : ' unverified'}`;
};

const printLeases = (leases) => {
  if (!leases.length) {
    process.stdout.write('no leases\n');
    return;
  }
  for (const l of leases) {
    const parts = [
      l.name,
      `holder=${holderText(l.holder)}`,
      `state=${l.holderState}`,
      `age=${age(l.ageSeconds)}`,
      `expires-in=${age(l.expiresInSeconds)}`,
    ];
    if (l.epic) parts.push(`epic=${l.epic}`);
    if (l.note) parts.push(`note=${JSON.stringify(l.note)}`);
    process.stdout.write(parts.join('  ') + '\n');
  }
};

const LEASE_VALUE_FLAGS = ['--ttl', '--epic', '--note', '--prefix', '--reason', '--kind'];
const LEASE_BOOL_FLAGS = ['--mine', '--json'];

const leaseName = (args, what = 'NAME') => {
  const positional = stripBooleanFlags(stripFlags(args, LEASE_VALUE_FLAGS), LEASE_BOOL_FLAGS);
  if (positional.length !== 1) die(`exactly one ${what} is required`);
  return positional[0];
};

// Fleet config (ADR-0019): versioned values tools read at call time. A change
// is audited and sent to nobody.
const CONFIG_USAGE = 'usage: config get KEY | list [--json] | set KEY VALUE [--expect-version N] | unset KEY [--expect-version N] | history [KEY] [--json]';
const CONFIG_KEY = /^[a-z][A-Za-z0-9._-]{1,63}$/;

const configKey = (key) => {
  if (!key || !CONFIG_KEY.test(key)) die(`KEY must match ${CONFIG_KEY.source}, got ${JSON.stringify(key ?? '')}`);
  return key;
};

const expectVersion = (args) => {
  if (!args.includes('--expect-version')) return {};
  const raw = flagValue(args, '--expect-version');
  if (raw === null || !/^\d+$/.test(raw)) die(`--expect-version needs a whole number, got ${JSON.stringify(raw ?? '')}`);
  return { expectedVersion: Number(raw) };
};

const setterText = (by) => (by.admin ? 'admin' : `${by.workspaceId}/${by.tabId}`);

const cmdConfig = async (args) => {
  const sub = args[0];
  const positional = stripBooleanFlags(stripFlags(args.slice(1), ['--expect-version']), ['--json']);
  switch (sub) {
    case 'get': {
      if (positional.length !== 1) die(CONFIG_USAGE);
      const key = configKey(positional[0]);
      requireEnv();
      const { body } = await api('GET', `/api/cli/fleet-config?key=${encodeURIComponent(key)}`);
      // The bare value, so a script reads it with $(purplemux config get KEY).
      process.stdout.write(`${body.value}\n`);
      return;
    }
    case 'list': {
      if (positional.length) die(CONFIG_USAGE);
      requireEnv();
      const { body } = await api('GET', '/api/cli/fleet-config');
      if (args.includes('--json')) return out(body);
      const entries = Object.entries(body.values || {}).sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length) {
        process.stdout.write('no fleet config set\n');
        return;
      }
      for (const [key, v] of entries) {
        process.stdout.write(`${key}=${v.value}  v${v.version}  set ${new Date(v.setAt).toISOString()} by ${setterText(v.setBy)}\n`);
      }
      return;
    }
    case 'set': {
      if (positional.length !== 2) die(CONFIG_USAGE);
      const key = configKey(positional[0]);
      const data = { value: positional[1], ...expectVersion(args) };
      requireEnv();
      const { body } = await api('PUT', `/api/cli/fleet-config/${encodeURIComponent(key)}`, data);
      return out(body);
    }
    case 'unset': {
      if (positional.length !== 1) die(CONFIG_USAGE);
      const key = configKey(positional[0]);
      requireEnv();
      const { body } = await api('DELETE', `/api/cli/fleet-config/${encodeURIComponent(key)}`, expectVersion(args));
      return out(body);
    }
    case 'history': {
      if (positional.length > 1) die(CONFIG_USAGE);
      const key = positional.length ? configKey(positional[0]) : null;
      requireEnv();
      const { body } = await api('GET', `/api/cli/fleet-config?history=1${key ? `&key=${encodeURIComponent(key)}` : ''}`);
      if (args.includes('--json')) return out(body);
      const history = body.history || [];
      if (!history.length) {
        process.stdout.write('no changes\n');
        return;
      }
      for (const c of history) {
        const from = c.oldValue === null ? '(unset)' : c.oldValue;
        const to = c.newValue === null ? '(unset)' : c.newValue;
        process.stdout.write(`${new Date(c.at).toISOString()}  ${c.key}  ${from} -> ${to}  v${c.version}  by ${setterText(c.by)}\n`);
      }
      return;
    }
    default:
      die(CONFIG_USAGE);
  }
};

// Deploy announce (story 13, ADR-0017): the one broadcast path. The reason is
// stored and shown by `deploy status`; recipients get the inbox's fixed line.
const DEPLOY_USAGE = 'usage: deploy announce --in MINUTES --reason TEXT [--except-tab TAB_ID]... [--json] | deploy status ID [--json] | deploy withdraw ID';

const flagValues = (args, name) => {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      if (i + 1 >= args.length) die(`${name} needs a value`);
      values.push(args[i + 1]);
      i++;
    }
  }
  return values;
};

const cmdDeploy = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  const positional = stripBooleanFlags(stripFlags(rest, ['--in', '--reason', '--except-tab']), ['--json']);
  switch (sub) {
    case 'announce': {
      if (positional.length) die(DEPLOY_USAGE);
      const minutes = flagValue(rest, '--in');
      if (minutes === null || !/^\d+$/.test(minutes) || Number(minutes) < 1 || Number(minutes) > 60) die('--in needs whole minutes from 1 to 60');
      const reason = flagValue(rest, '--reason');
      if (!reason || !reason.trim()) die('--reason is required (at most 120 characters; shown by deploy status, never typed)');
      requireEnv();
      const { body } = await api('POST', '/api/cli/deploy/announce', {
        inMinutes: Number(minutes),
        reason,
        exceptTabIds: flagValues(rest, '--except-tab'),
      });
      if (rest.includes('--json')) return out(body);
      process.stdout.write(`DEPLOY ${body.id} restarts ~${new Date(body.restartAt).toISOString()} recipients=${body.recipients.length}\n`);
      for (const r of body.recipients) process.stdout.write(`  ${r.workspaceId}/${r.tabId}  ${r.reasons.join(', ')}\n`);
      return;
    }
    case 'status': {
      if (positional.length !== 1) die(DEPLOY_USAGE);
      requireEnv();
      const { body } = await api('GET', `/api/cli/deploy/status?id=${encodeURIComponent(positional[0])}`);
      if (rest.includes('--json')) return out(body);
      process.stdout.write(`DEPLOY ${body.id} restarts ~${new Date(body.restartAt).toISOString()} reason: ${body.reason}\n`);
      for (const r of body.recipients) {
        process.stdout.write(`  ${r.workspaceId}/${r.tabId}  ${r.state}  cliState=${r.cliState ?? '-'}  ${r.reasons.join(', ')}\n`);
      }
      return;
    }
    case 'withdraw': {
      if (positional.length !== 1) die(DEPLOY_USAGE);
      requireEnv();
      const { body } = await api('POST', '/api/cli/deploy/withdraw', { id: positional[0] });
      return out(body);
    }
    default:
      die(DEPLOY_USAGE);
  }
};

// Harness watches (ADR-0015): tab-owned, one-shot, server-evaluated. The
// notice reaches the owner tab through the inbox; the label is list-only.
const WATCH_USAGE = 'usage: watch pr OWNER/REPO#N --until merged|closed|head-moved|checks-settled | watch ref OWNER/REPO@REF --until moved | watch lease NAME --until free  [--ttl 24h] [--interval 120] [--label TEXT]; watch list [-w WS] [--json]; watch clear ID';
const WATCH_VALUE_FLAGS = ['--until', '--ttl', '--interval', '--label', '-w', '--workspace'];

const printWatches = (watches) => {
  if (!watches.length) {
    process.stdout.write('no watches\n');
    return;
  }
  for (const w of watches) {
    const parts = [
      w.id,
      `${w.kind} ${w.target} --until ${w.until}`,
      `owner=${w.workspaceId}/${w.tabId} (${w.owner}${w.verified === false ? (w.identity === 'hook' ? ', hook-identity' : ', unverified') : ''})`,
      `age=${age(w.ageSeconds)}`,
      `expires-in=${age(w.expiresInSeconds)}`,
      `last-check=${w.lastCheckedAt ? new Date(w.lastCheckedAt).toISOString() : 'never'}`,
    ];
    if (w.failures) parts.push(`failures=${w.failures}`);
    if (w.lastError) parts.push(`error=${w.lastError.code}: ${JSON.stringify(w.lastError.message)}`);
    if (w.label) parts.push(`label=${JSON.stringify(w.label)}`);
    process.stdout.write(parts.join('  ') + '\n');
  }
};

const cmdWatch = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  const positional = stripBooleanFlags(stripFlags(rest, WATCH_VALUE_FLAGS), ['--json']);
  switch (sub) {
    case 'pr':
    case 'ref':
    case 'lease': {
      if (positional.length !== 1) die(WATCH_USAGE);
      const until = flagValue(rest, '--until');
      if (!until) die('--until is required');
      const data = { kind: sub, target: positional[0], until };
      const ttl = flagValue(rest, '--ttl');
      if (ttl !== null) {
        const seconds = parseTtl(ttl);
        if (seconds === null) die('--ttl needs a duration (a watch always expires, at most 7d)');
        data.ttlSeconds = seconds;
      }
      const interval = flagValue(rest, '--interval');
      if (interval !== null) {
        if (!/^\d+$/.test(interval)) die('--interval needs whole seconds (60-3600)');
        data.intervalS = Number(interval);
      }
      const label = flagValue(rest, '--label');
      if (label !== null) data.label = label;
      requireEnv();
      const { body } = await api('POST', '/api/cli/watches', data);
      return out(body);
    }
    case 'list': {
      if (positional.length) die(WATCH_USAGE);
      const ws = flagValue(rest, '--workspace') || flagValue(rest, '-w');
      requireEnv();
      const { body } = await api('GET', `/api/cli/watches${ws ? `?workspaceId=${encodeURIComponent(ws)}` : ''}`);
      if (rest.includes('--json')) return out(body);
      return printWatches(body.watches || []);
    }
    case 'clear': {
      if (positional.length !== 1) die(WATCH_USAGE);
      requireEnv();
      const { body } = await api('DELETE', `/api/cli/watches/${encodeURIComponent(positional[0])}`);
      return out(body);
    }
    default:
      die(WATCH_USAGE);
  }
};

// Auth waits (ADR-0041): an auth watch on the owner's AWS sign-in. The server reads the SSO cache file
// every 60 s and starts no aws process (DEC-261); the notice reaches this tab through the inbox.
const WAIT_USAGE = 'usage: wait add --auth PROFILE [--item LEDGER_ITEM_KEY] [--ttl 24h] [--label TEXT] (list and clear with purplemux watch list|clear)';

const cmdWait = async (args) => {
  if (args[0] !== 'add') die(WAIT_USAGE);
  const rest = args.slice(1);
  if (stripFlags(rest, ['--auth', '--item', '--ttl', '--label']).length) die(WAIT_USAGE);
  const profile = flagValue(rest, '--auth');
  if (!profile) die(WAIT_USAGE);
  const data = { kind: 'auth', target: profile, until: 'signed-in' };
  const item = flagValue(rest, '--item');
  if (item !== null) data.ledgerItem = item;
  const ttl = flagValue(rest, '--ttl');
  if (ttl !== null) {
    const seconds = parseTtl(ttl);
    if (seconds === null) die('--ttl needs a duration (a wait always expires, at most 7d)');
    data.ttlSeconds = seconds;
  }
  const label = flagValue(rest, '--label');
  if (label !== null) data.label = label;
  requireEnv();
  const { body } = await api('POST', '/api/cli/watches', data);
  return out(body);
};

// Standing orders (ADR-0041): the owner's rules, written into every Claude tab's workspace prompt file.
const SO_USAGE = 'usage: so add (-w WS | --fleet) --text TEXT --source "OWNER MESSAGE ID, UTC DATE" [--scope S] [--check HOOK|TEST|prose]; so propose --text TEXT --why TEXT [--cites TEXT] [--scope S] [--check HOOK|TEST|prose]; so strike SO-N --reason TEXT; so list [-w WS] [--all] [--json]';

const printOrders = (orders) => {
  if (!orders.length) {
    process.stdout.write('no standing orders\n');
    return;
  }
  for (const o of orders) {
    const struck = o.state === 'struck' ? `  STRUCK ${o.struck}` : '';
    process.stdout.write(`${o.id}  [${o.owner}; scope ${o.scope}; check ${o.check}]  ${o.text}\n    source: ${o.source}${struck}\n`);
  }
};

const cmdSo = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  const ws = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  switch (sub) {
    case 'add': {
      const positional = stripBooleanFlags(stripFlags(rest, ['--text', '--source', '--scope', '--check', '-w', '--workspace']), ['--fleet', '--json']);
      if (positional.length) die(SO_USAGE);
      const fleet = rest.includes('--fleet');
      if (fleet === !!ws) die('so add needs exactly one of -w WS (a workspace order) or --fleet (admin token)');
      const text = flagValue(rest, '--text');
      const source = flagValue(rest, '--source');
      if (!text || !source) die(SO_USAGE);
      const data = { text, source };
      if (ws) data.workspaceId = ws;
      const scope = flagValue(rest, '--scope');
      if (scope !== null) data.scope = scope;
      const check = flagValue(rest, '--check');
      if (check !== null) data.check = check;
      requireEnv();
      const { body } = await api('POST', '/api/cli/standing-orders', data);
      if (rest.includes('--json')) return out(body);
      process.stdout.write(`${body.order.id} added (${body.owner}); its prompt section is ${body.bytes} bytes of 8192; ${body.promptsWritten} prompt file(s) rewritten, ${body.tabsNotified} live tab(s) told\n`);
      return;
    }
    case 'propose': {
      // The selected portfolio manager proposes a fleet order; the owner's Yes in Mission Control files it (ADR-0041 §1 amendment D7).
      const positional = stripBooleanFlags(stripFlags(rest, ['--text', '--why', '--cites', '--scope', '--check']), ['--json']);
      if (positional.length || ws) die(SO_USAGE);
      const text = flagValue(rest, '--text');
      const why = flagValue(rest, '--why');
      if (!text || !why) die(SO_USAGE);
      const data = { text, why };
      for (const flag of ['cites', 'scope', 'check']) {
        const value = flagValue(rest, `--${flag}`);
        if (value !== null) data[flag] = value;
      }
      requireEnv();
      const { body } = await api('POST', '/api/cli/standing-orders/proposals', data);
      if (rest.includes('--json')) return out(body);
      process.stdout.write(`${body.itemId} opened for the owner in Mission Control: Yes files the fleet order as quoted; it reaches ${body.workspaces} workspace(s) and ${body.liveTabs} live agent tab(s); the largest prompt section would be ${body.bytes} bytes of 8192\n`);
      return;
    }
    case 'strike': {
      const positional = stripBooleanFlags(stripFlags(rest, ['--reason']), ['--json']);
      const reason = flagValue(rest, '--reason');
      if (positional.length !== 1 || !reason) die(SO_USAGE);
      requireEnv();
      const { body } = await api('POST', `/api/cli/standing-orders/${encodeURIComponent(positional[0])}/strike`, { reason });
      if (rest.includes('--json')) return out(body);
      process.stdout.write(`${body.order.id} struck (${body.owner}); ${body.promptsWritten} prompt file(s) rewritten, ${body.tabsNotified} live tab(s) told\n`);
      return;
    }
    case 'list': {
      const positional = stripBooleanFlags(stripFlags(rest, ['-w', '--workspace']), ['--all', '--json']);
      if (positional.length) die(SO_USAGE);
      requireEnv();
      const query = [ws ? `workspaceId=${encodeURIComponent(ws)}` : '', rest.includes('--all') ? 'all=1' : ''].filter(Boolean).join('&');
      const { body } = await api('GET', `/api/cli/standing-orders${query ? `?${query}` : ''}`);
      if (rest.includes('--json')) return out(body);
      return printOrders(body.orders || []);
    }
    default:
      die(SO_USAGE);
  }
};

// Portfolio drive grants (ADR-0014) and the owner grant (ADR-0029): read-only here. A grant is
// created and revoked only in the web UI (a human session plus the purplemux password); no CLI token can do either.
const cmdGrant = async (args) => {
  if (args[0] !== 'list') die('usage: grant list [--json] (grants are created and revoked in the web UI only)');
  requireEnv();
  const { body } = await api('GET', '/api/cli/grants');
  // ADR-0029: one unreadable grant file still lists the other file's grants; the refused kind is
  // unknown, never "no grants", and the command exits 1 so a script sees the damage.
  const refused = Array.isArray(body.refused) ? body.refused : [];
  const reportRefused = () => {
    for (const r of refused) process.stderr.write(`error: grant-store-unreadable (${hintFor('grant-store-unreadable')}) — ${r.error}\n`);
    if (refused.length) process.exitCode = exitFor('grant-store-unreadable');
  };
  if (args.includes('--json')) {
    out(body);
    reportRefused();
    return;
  }
  const now = Date.now();
  const grants = Array.isArray(body.grants) ? body.grants : [];
  if (!grants.length && !refused.length) {
    process.stdout.write('no grants\n');
    return;
  }
  if (refused.length) {
    const refusedKinds = new Set(refused.map((r) => r.capability));
    for (const kind of ['drive', 'owner']) {
      if (!refusedKinds.has(kind) && !grants.some((g) => (g.capability ?? 'drive') === kind)) process.stdout.write(`no ${kind} grants\n`);
    }
  }
  for (const g of grants) {
    const state = g.revokedAt !== null ? `ended (${g.revokeReason})` : g.expiresAt <= now ? 'expired' : `active until ${new Date(g.expiresAt).toISOString()}`;
    const scope = g.capability === 'owner' ? `capability: owner workspaces: ${g.workspaces.join(',')}` : `reads ${g.workspaces.join(',')}`;
    process.stdout.write(`${g.id}  ${g.grantee.workspaceId}/${g.grantee.tabId} ${scope}  ${state}  "${g.reason}"\n`);
  }
  reportRefused();
};

// The inbox (ADR-0012): server notices queued for this workspace's tabs.
const cmdInbox = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = stripBooleanFlags(stripFlags(args.slice(1), ['--workspace', '-w']), ['--all']);
  switch (sub) {
    case 'list': {
      const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
      if (!wsId) die('usage: inbox list -w WS [--all]');
      const all = args.includes('--all') ? '&all=1' : '';
      const { body } = await api('GET', `/api/cli/inbox?workspaceId=${encodeURIComponent(wsId)}${all}`);
      return out(body);
    }
    case 'retry': {
      const id = rest[0];
      if (!id || !/^i-[A-Za-z0-9_-]{1,32}$/.test(id)) die('usage: inbox retry ID (an i-… inbox item id)');
      const { body } = await api('POST', `/api/cli/inbox/${id}/retry`, {});
      return out(body);
    }
    default:
      die('usage: inbox list -w WS [--all] | inbox retry ID');
  }
};

// Notes (ADR-0013): a body the recipient pulls; only the inbox's fixed line is typed.
const NOTE_BODY_MAX_BYTES = 16 * 1024;
const NOTE_USAGE = 'usage: note send (--to-epic SLUG | --to-workspace WS) --subject TEXT (-f FILE | -f -) [--from-epic SLUG]'
  + ' | note list [--open] [--to-me] [--from-me] [--epic SLUG] | note show ID | note ack ID [--comment TEXT]';
const NOTE_VALUE_FLAGS = ['--to-epic', '--to-workspace', '--subject', '--file', '-f', '--from-epic', '--epic', '--comment'];
const NOTE_BOOL_FLAGS = ['--open', '--to-me', '--from-me'];
const NOTE_ID = /^n-[A-Za-z0-9_-]{4,32}$/;

const noteId = (rest) => {
  const positional = stripBooleanFlags(stripFlags(rest, NOTE_VALUE_FLAGS), NOTE_BOOL_FLAGS);
  if (positional.length !== 1 || !NOTE_ID.test(positional[0])) die(`exactly one note id (n-…) is required — ${NOTE_USAGE}`);
  return positional[0];
};

const cmdNote = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'send': {
      const toEpic = flagValue(rest, '--to-epic');
      const toWorkspace = flagValue(rest, '--to-workspace');
      if ((toEpic === null) === (toWorkspace === null)) die(`exactly one of --to-epic or --to-workspace is required — ${NOTE_USAGE}`);
      const subject = flagValue(rest, '--subject');
      if (!subject) die(`--subject is required — ${NOTE_USAGE}`);
      const file = flagValue(rest, '--file') || flagValue(rest, '-f');
      if (!file) die(`the body comes from -f FILE or -f - (stdin) — ${NOTE_USAGE}`);
      const body = file === '-' ? await readStdin() : require('fs').readFileSync(file, 'utf8');
      const bytes = Buffer.byteLength(body, 'utf8');
      if (bytes > NOTE_BODY_MAX_BYTES) die(`note body is ${bytes} bytes; the limit is 16 KiB (${NOTE_BODY_MAX_BYTES} bytes)`);
      const data = { subject, body };
      if (toEpic !== null) data.toEpic = toEpic;
      if (toWorkspace !== null) data.toWorkspace = toWorkspace;
      const fromEpic = flagValue(rest, '--from-epic');
      if (fromEpic !== null) data.fromEpic = fromEpic;
      requireEnv();
      const { body: resp } = await api('POST', '/api/cli/notes', data);
      return out(resp);
    }
    case 'list': {
      const positional = stripBooleanFlags(stripFlags(rest, NOTE_VALUE_FLAGS), NOTE_BOOL_FLAGS);
      if (positional.length) die(`unexpected argument: ${positional[0]} — ${NOTE_USAGE}`);
      const qs = new URLSearchParams();
      if (rest.includes('--open')) qs.set('open', '1');
      if (rest.includes('--to-me')) qs.set('toMe', '1');
      if (rest.includes('--from-me')) qs.set('fromMe', '1');
      const epic = flagValue(rest, '--epic');
      if (epic !== null) qs.set('epic', epic);
      requireEnv();
      const query = qs.toString();
      const { body } = await api('GET', `/api/cli/notes${query ? `?${query}` : ''}`);
      return out(body);
    }
    case 'show': {
      const id = noteId(rest);
      requireEnv();
      const { body } = await api('GET', `/api/cli/notes/${id}`);
      return out(body);
    }
    case 'ack': {
      const id = noteId(rest);
      const comment = flagValue(rest, '--comment');
      requireEnv();
      const { body } = await api('POST', `/api/cli/notes/${id}/ack`, comment === null ? {} : { comment });
      return out(body);
    }
    default:
      die(NOTE_USAGE);
  }
};

// Typed worker events (ADR-0043): the server checks the evidence, then delivers the event as a note.
const EVENT_TYPES = ['review-ready', 'landed', 'blocked-on'];
const EVENT_USAGE = 'usage: event send --type review-ready|landed|blocked-on --to-epic SLUG (--json PAYLOAD | -f FILE | -f -)'
  + ' | event scope set --tab TAB --epic SLUG [--story KEY] [--depends-on A,B] [--attempt N]'
  + ' | event scope list | event scope clear --tab TAB';

const cmdEventScope = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'set': {
      const tabId = flagValue(rest, '--tab');
      const epic = flagValue(rest, '--epic');
      if (!tabId || !epic) die(`--tab and --epic are required — ${EVENT_USAGE}`);
      const data = { tabId, epic };
      const story = flagValue(rest, '--story');
      if (story !== null) data.story = story;
      const dependsOn = flagValue(rest, '--depends-on');
      if (dependsOn !== null) data.dependsOn = dependsOn.split(',').map((slug) => slug.trim()).filter(Boolean);
      const attempt = flagValue(rest, '--attempt');
      if (attempt !== null) {
        if (!/^[1-9][0-9]{0,6}$/.test(attempt)) die(`--attempt must be a whole number of at least 1 — ${EVENT_USAGE}`);
        data.attempt = Number(attempt);
      }
      requireEnv();
      const { body } = await api('PUT', '/api/cli/worker-events/scope', data);
      return out(body);
    }
    case 'list': {
      requireEnv();
      const { body } = await api('GET', '/api/cli/worker-events/scope');
      return out(body);
    }
    case 'clear': {
      const tabId = flagValue(rest, '--tab');
      if (!tabId) die(`--tab is required — ${EVENT_USAGE}`);
      requireEnv();
      const { body } = await api('DELETE', `/api/cli/worker-events/scope?tabId=${encodeURIComponent(tabId)}`);
      return out(body);
    }
    default:
      die(EVENT_USAGE);
  }
};

const cmdEvent = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'send': {
      const type = flagValue(rest, '--type');
      if (!EVENT_TYPES.includes(type)) die(`--type must be one of ${EVENT_TYPES.join(', ')} — ${EVENT_USAGE}`);
      const toEpic = flagValue(rest, '--to-epic');
      if (!toEpic) die(`--to-epic is required — ${EVENT_USAGE}`);
      const json = flagValue(rest, '--json');
      const file = flagValue(rest, '--file') || flagValue(rest, '-f');
      if ((json === null) === !file) die(`exactly one of --json PAYLOAD or -f FILE is required — ${EVENT_USAGE}`);
      const raw = json !== null ? json : file === '-' ? await readStdin() : require('fs').readFileSync(file, 'utf8');
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        die(`the payload is not JSON: ${err.message}`);
      }
      requireEnv();
      const { body } = await api('POST', '/api/cli/worker-events', { type, toEpic, payload });
      return out(body);
    }
    case 'scope':
      return cmdEventScope(rest);
    default:
      die(EVENT_USAGE);
  }
};

const LEASE_USAGE = 'usage: lease acquire|renew|release|list|check|break|release-epic ... (purplemux help)';

/**
 * `check` prints `{ held, mine, lease }` on stdout and exits 0 (caller holds),
 * 3 (another holds) or 7 (nobody holds). Its body is the contract bash-guard
 * parses; the exit code alone answers the common question.
 */
const cmdLease = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  const ttlRaw = flagValue(rest, '--ttl');
  switch (sub) {
    case 'acquire': {
      const name = leaseName(rest);
      const data = { name };
      if (ttlRaw !== null) data.ttlSeconds = parseTtl(ttlRaw);
      const epic = flagValue(rest, '--epic');
      const note = flagValue(rest, '--note');
      if (epic !== null) data.epic = epic;
      if (note !== null) data.note = note;
      requireEnv();
      const { body } = await api('POST', '/api/cli/leases/acquire', data);
      return out(body);
    }
    case 'renew': {
      const name = leaseName(rest);
      const data = { name };
      if (ttlRaw !== null) data.ttlSeconds = parseTtl(ttlRaw);
      requireEnv();
      const { body } = await api('POST', '/api/cli/leases/renew', data);
      return out(body);
    }
    case 'release': {
      const name = leaseName(rest);
      requireEnv();
      const { body } = await api('POST', '/api/cli/leases/release', { name });
      return out(body);
    }
    case 'break': {
      const name = leaseName(rest);
      const reason = flagValue(rest, '--reason');
      if (!reason || !reason.trim()) die('--reason is required');
      requireEnv();
      const { body } = await api('POST', '/api/cli/leases/break', { name, reason });
      return out(body);
    }
    case 'release-epic': {
      const epic = leaseName(rest, 'SLUG');
      const data = { epic };
      const kind = flagValue(rest, '--kind');
      if (kind !== null) data.kind = kind;
      requireEnv();
      const { body } = await api('POST', '/api/cli/leases/release-epic', data);
      return out(body);
    }
    case 'list': {
      const positional = stripBooleanFlags(stripFlags(rest, LEASE_VALUE_FLAGS), LEASE_BOOL_FLAGS);
      if (positional.length) die(`unexpected argument: ${positional[0]}`);
      const qs = new URLSearchParams();
      const prefix = flagValue(rest, '--prefix');
      if (prefix !== null) qs.set('prefix', prefix);
      if (rest.includes('--mine')) qs.set('mine', '1');
      requireEnv();
      const query = qs.toString();
      const { body } = await api('GET', `/api/cli/leases${query ? `?${query}` : ''}`);
      if (rest.includes('--json')) return out(body);
      return printLeases(body.leases || []);
    }
    case 'check': {
      const name = leaseName(rest);
      requireEnv();
      const { body } = await api('GET', `/api/cli/leases/check?name=${encodeURIComponent(name)}`);
      out(body);
      process.exitCode = body.mine ? 0 : body.held ? EXIT.CONFLICT : EXIT.NOT_FOUND;
      return;
    }
    default:
      die(LEASE_USAGE);
  }
};

// ---- pool (ADR-0039) ----

const POOL_KINDS = ['gate', 'build', 'mutation', 'browser', 'test-service', 'tab'];
const POOL_CLASSES = ['product', 'harness', 'control-plane'];
const POOL_USAGE = 'usage: pool show [--json] | acquire --kind gate|build|mutation|browser|test-service|tab [--mem GB] [--threads N] [--class product|harness|control-plane] [--queue [--wait SECONDS] | --ticket TICKET] [--ttl 60m] [--panel-type T] [--role R] | release LEASE|TICKET';
// vel-D4: a queued request waits here, re-asking with its ticket, up to --wait seconds (default 15 min).
const POOL_QUEUE_WAIT_DEFAULT_S = 900;
// The client rule: no answer in 2 s exits 6 (pool-timeout), and the caller falls back to its local slots and logs it.
const POOL_ACQUIRE_TIMEOUT_MS = 2000;

const poolRequest = async (method, requestPath, data) => {
  const opts = {
    method,
    headers: headersFor(requestPath, { 'Content-Type': 'application/json' }, data, method),
    signal: AbortSignal.timeout(POOL_ACQUIRE_TIMEOUT_MS),
  };
  if (data !== undefined) opts.body = JSON.stringify(data);
  const timedOut = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError';
  const late = () => fail('pool-timeout', `no answer from ${BASE} in ${POOL_ACQUIRE_TIMEOUT_MS} ms`);
  let resp;
  try {
    resp = await fetch(`${BASE}${requestPath}`, opts);
  } catch (err) {
    if (timedOut(err)) return late();
    return networkFailure(method, requestPath, err);
  }
  failIfRouteAbsent(resp, requestPath);
  let body = null;
  if (isJson(resp)) {
    try {
      body = await resp.json();
    } catch (err) {
      if (timedOut(err)) return late();
      if (!(err instanceof SyntaxError)) return networkFailure(method, requestPath, err);
    }
  }
  if (!resp.ok) failFromResponse(resp, body);
  if (!body) fail(null, `HTTP ${resp.status} without a JSON body — is purplemux the server ${SERVER_LABEL}?`);
  return body;
};

const GIB = 1024 ** 3;
const gib = (bytes) => (bytes === null || bytes === undefined ? '-' : `${(bytes / GIB).toFixed(1)}`);
const slotText = (s) => `${s.used}/${s.cap}`;

const queueWaitOf = (args) => {
  const raw = flagValue(args, '--wait');
  if (raw === null) {
    if (args.includes('--wait')) die('--wait needs whole seconds (0: answer at once)');
    return POOL_QUEUE_WAIT_DEFAULT_S;
  }
  if (!/^\d{1,6}$/.test(raw)) die(`--wait must be whole seconds, got "${raw}"`);
  return Number(raw);
};

/**
 * A queued answer pauses the caller and re-asks with its ticket (vel-D4). It prints one line when the
 * position or the reason changes, never on every ask, and ends with `pool-queued` (exit 3) and the ticket
 * on stdout when the wait runs out.
 */
const waitInQueue = async (first, ask, waitSeconds) => {
  const deadline = Date.now() + waitSeconds * 1000;
  let answer = first;
  let last = '';
  while (answer && answer.queued === true) {
    const line = `queued: ${answer.ticket} position ${answer.position} of ${answer.of} — ${answer.reason}`;
    if (line !== last) process.stderr.write(`${line}\n`);
    last = line;
    const retry = Number(answer.retryAfterSeconds);
    const pauseMs = Math.max(50, (Number.isFinite(retry) && retry >= 0 ? retry : 10) * 1000);
    if (Date.now() + pauseMs > deadline) {
      out(answer);
      fail('pool-queued', `${answer.ticket} still waits at position ${answer.position} of ${answer.of} after ${waitSeconds} s`, answer);
    }
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
    answer = await ask(answer.ticket);
  }
  return answer;
};

const printPool = (view) => {
  const t = view.totals;
  process.stdout.write(`pool ${t.knownHosts} known, ${t.unknownHosts} unknown: ${t.threads} threads, ${gib(t.memAvailableBytes)}/${gib(t.memTotalBytes)} GiB free, gate ${slotText(t.slots.gate)} build ${slotText(t.slots.build)} tab ${slotText(t.slots.tab)}${view.queue?.length ? `, ${view.queue.length} queued` : ''}\n`);
  const w = view.wouldRefuse;
  if (w) {
    const hosts = Object.entries(w.byHost).map(([host, c]) => `${host} ${c.total}`).join(', ');
    process.stdout.write(`mode ${w.mode === 'enforce' ? 'enforce' : 'shadow'}: ${w.total} admitted that enforce would refuse since ${w.since}${hosts ? ` (${hosts})` : ''}\n`);
  }
  for (const h of view.hosts) {
    const name = `${h.host}${h.local ? ' (this host)' : ''}`;
    if (!h.metrics) {
      process.stdout.write(`  ${name}: unknown — ${h.reason}; slots held gate ${h.slots.gate.used} build ${h.slots.build.used} tab ${h.slots.tab.used}\n`);
      continue;
    }
    const m = h.metrics;
    const disks = m.disks.map((d) => `${d.path} ${d.usedPct === null ? '-' : `${d.usedPct}%`}`).join(' ');
    const gpu = m.gpus ? ` gpu ${m.gpus.map((g) => `${g.name} ${g.utilPct ?? '-'}%`).join(', ') || 'none'}` : '';
    const sweep = m.sccacheSweep ? ` sccache-sweep ${m.sccacheSweep.state}` : '';
    const notPlaceable = h.placeable === false ? `; not placeable: ${h.reason}` : '';
    process.stdout.write(`  ${name}: ${m.threads} threads, load ${m.load1}/${m.load5} (${h.loadPerThread}/thread), ${gib(m.memAvailableBytes)}/${gib(m.memTotalBytes)} GiB free, ${disks}${gpu}${sweep}; gate ${slotText(h.slots.gate)} build ${slotText(h.slots.build)} tab ${slotText(h.slots.tab)}${h.via && h.via !== h.host ? ` via ${h.via}` : ''}${notPlaceable}\n`);
    const b = h.budget;
    if (b) {
      const workers = { threads: b.used.product.threads + b.used.harness.threads, memBytes: b.used.product.memBytes + b.used.harness.memBytes };
      const cp = b.used['control-plane'];
      process.stdout.write(`    budget: workers ${workers.threads}/${b.workerThreads} threads, ${gib(workers.memBytes)}/${gib(b.workerMemBytes)} GiB (harness ${b.used.harness.threads} threads, share ${b.harnessSharePct}%); control-plane reserve ${cp.threads}/${b.reserveThreads} threads, ${gib(cp.memBytes)}/${gib(b.reserveMemBytes)} GiB; max load ${b.maxLoad}\n`);
    }
  }
  for (const q of view.queue ?? []) {
    process.stdout.write(`  queued ${q.position}: ${q.ticket} ${q.class} ${q.envelope.threads} threads ${q.envelope.memGb} GiB, hosts ${q.hosts.join(',') || 'none placeable'}, holder ${q.holder}, since ${q.queuedAt}\n`);
  }
};

const cmdPool = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'show': {
      requireEnv();
      const { body } = await api('GET', '/api/cli/pool');
      if (rest.includes('--json')) return out(body);
      return printPool(body);
    }
    case 'acquire': {
      const kind = flagValue(rest, '--kind');
      if (!POOL_KINDS.includes(kind)) die(`--kind must be gate, build, mutation, browser, test-service or tab — ${POOL_USAGE}`);
      const data = { kind };
      const threads = flagValue(rest, '--threads');
      if (threads !== null || rest.includes('--threads')) {
        if (!/^\d{1,4}$/.test(threads ?? '') || Number(threads) < 1) die(`--threads must be a whole number 1..4096, got "${threads ?? ''}"`);
        data.threads = Number(threads);
      }
      const cls = flagValue(rest, '--class');
      if (cls !== null || rest.includes('--class')) {
        if (!POOL_CLASSES.includes(cls)) die(`--class must be product, harness or control-plane — ${POOL_USAGE}`);
        data.class = cls;
      }
      const ticket = flagValue(rest, '--ticket');
      if (rest.includes('--ticket') && !ticket) die(`--ticket needs the ticket a queued answer printed (pool-queue:<kind>-<n>) — ${POOL_USAGE}`);
      if (ticket) data.ticket = ticket;
      if (rest.includes('--queue')) data.queue = true;
      if (rest.includes('--wait') && !data.queue && !ticket) die('--wait goes with --queue or --ticket');
      const wait = queueWaitOf(rest);
      const mem = flagValue(rest, '--mem');
      if (mem !== null) {
        if (!/^\d+(\.\d+)?$/.test(mem)) die(`--mem must be a number of GiB, got "${mem}"`);
        data.memGb = Number(mem);
      }
      const ttl = flagValue(rest, '--ttl');
      if (ttl !== null) {
        const seconds = parseTtl(ttl);
        if (seconds === null) die('--ttl none is not allowed: a pool slot must expire');
        data.ttlSeconds = seconds;
      }
      const panelType = flagValue(rest, '--panel-type');
      if (panelType !== null) data.panelType = panelType;
      const role = flagValue(rest, '--role');
      if (role !== null) data.role = role;
      requireEnv();
      const first = await poolRequest('POST', '/api/cli/pool/acquire', data);
      return out(await waitInQueue(first, (t) => poolRequest('POST', '/api/cli/pool/acquire', { ...data, ticket: t }), wait));
    }
    case 'release': {
      const lease = rest.find((a) => !a.startsWith('-'));
      if (!lease) die(`release needs a LEASE (pool:<host>/<kind>-<n>) or a TICKET (pool-queue:<kind>-<n>) — ${POOL_USAGE}`);
      requireEnv();
      const { body } = await api('POST', '/api/cli/pool/release', { lease });
      return out(body);
    }
    default:
      die(POOL_USAGE);
  }
};

const OVER_CAP_REASON_MAX = 500;

const cmdTabCreate = async (args) => {
  requireEnv();
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  const name = flagValue(args, '--name') || flagValue(args, '-n');
  const panelType = flagValue(args, '--type') || flagValue(args, '-t');
  const model = flagValue(args, '--model') || flagValue(args, '-m');
  const reasoning = flagValue(args, '--reasoning') || flagValue(args, '-r');
  const noLaunch = args.includes('--no-launch');
  // Comma-separated path globs the tab is expected to edit. purplemux reports
  // edits outside them; it never infers the list.
  const scopeRaw = flagValue(args, '--scope');
  const scope = scopeRaw ? scopeRaw.split(',').map((s) => s.trim()).filter(Boolean) : null;
  // Nudges go to this live tab of the same workspace first (ADR-0018).
  const reportsTo = flagValue(args, '--reports-to');
  // The end-line markers whose nudges the target receives (ADR-0025); the server validates the names.
  const reportOn = flagValue(args, '--report-on');
  // The ssh alias of a registered remote host (ADR-0022), or `auto`: the pool places it (ADR-0039).
  const host = flagValue(args, '--host');
  // The tab's start directory: it must exist on the host the tab runs on.
  const cwd = flagValue(args, '--cwd');
  // A fixed tool configuration for the tab (ADR-0040); the server validates the name.
  const role = flagValue(args, '--role');
  const previewUrl = flagValue(args, '--preview-url');
  const pgService = flagValue(args, '--pg-service');
  // A seat (ADR-0036): rotate from this handoff file at the context threshold; the path is resolved against the cwd.
  const handoff = flagValue(args, '--handoff');
  const rotateAt = flagValue(args, '--rotate-at');
  // vel-D4: --host auto only. The pool class, a ticket a queued answer printed, and how long to wait in the queue.
  const poolClass = flagValue(args, '--class');
  const queueTicket = flagValue(args, '--ticket');
  if (!wsId) die('--workspace is required');
  if ((args.includes('--class') || args.includes('--ticket') || args.includes('--wait')) && host !== 'auto') die('--class, --ticket and --wait go with --host auto');
  if (args.includes('--class') && !POOL_CLASSES.includes(poolClass)) die('--class must be product, harness or control-plane');
  if (args.includes('--ticket') && !queueTicket) die('--ticket needs the ticket a queued answer printed (pool-queue:tab-<n>)');
  const queueWait = host === 'auto' ? queueWaitOf(args) : 0;
  if (args.includes('--handoff') && !handoff) die('--handoff needs the path of the seat\'s handoff file');
  if (args.includes('--rotate-at') && !rotateAt) die('--rotate-at needs a token count (50000..900000) or off');
  if (args.includes('--role') && !role) die('--role needs a role name (evaluator)');
  if (args.includes('--pg-service') && !pgService) die('--pg-service needs a ~/.pg_service.conf entry name');
  if (args.includes('--preview-url') && !previewUrl) die('--preview-url needs the http(s) URL of the preview the evaluator may browse');
  if (args.includes('--reports-to') && !reportsTo) die('--reports-to needs a tab id');
  if (args.includes('--report-on') && !reportOn) die('--report-on needs a comma-separated list of markers (DONE, BLOCKED, NEEDS-DECISION, READY-TO-MERGE, CHECKPOINTED) or all');
  if (args.includes('--host') && !host) die('--host needs a host name from fleet config remote.hosts, or auto (the pool places it)');
  if (args.includes('--cwd') && !cwd) die('--cwd needs an absolute directory on the tab\'s host');
  // Past the WIP cap (ADR-0027): only the workspace's enabled orchestrator, with a reason that is audited.
  const overCap = args.includes('--over-cap');
  const reason = flagValue(args, '--reason');
  if (overCap && reason === null) die('--over-cap needs --reason TEXT');
  if (!overCap && args.includes('--reason')) die('--reason goes with --over-cap');
  if (overCap && (reason.trim().length === 0 || reason.length > OVER_CAP_REASON_MAX)) die(`--reason needs 1..${OVER_CAP_REASON_MAX} characters`);
  const createBody = {
    workspaceId: wsId,
    ...(name ? { name } : {}),
    ...(panelType ? { panelType } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(noLaunch ? { launch: false } : {}),
    ...(scope && scope.length ? { scope } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(reportOn ? { reportOn } : {}),
    ...(host ? { host } : {}),
    ...(cwd ? { cwd } : {}),
    ...(role ? { role } : {}),
    ...(previewUrl ? { previewUrl } : {}),
    ...(pgService ? { pgService } : {}),
    ...(handoff ? { handoff: path.resolve(handoff) } : {}),
    ...(rotateAt ? { rotateAt } : {}),
    ...(overCap ? { overCap: { reason } } : {}),
    ...(poolClass ? { poolClass } : {}),
    ...(queueTicket ? { queueTicket } : {}),
  };
  const { body } = await api('POST', '/api/cli/tabs', createBody);
  const ask = async (ticket) => (await api('POST', '/api/cli/tabs', { ...createBody, queueTicket: ticket })).body;
  out(await waitInQueue(body, ask, queueWait));
};

/**
 * `handoff check <path>` (ADR-0036 §4): the file is read here and checked by the server's checkHandoff, the
 * function the rotation runs. PASS exits 0; refusals print one `handoff-check:` line each and exit 1, as v2's
 * tools/handoff-check.py did.
 */
const cmdHandoff = async (args) => {
  const [sub, file, ...rest] = args;
  if (sub !== 'check' || !file || file.startsWith('-')) die('usage: handoff check <path> [--rotate-requested-at UTC] [--now UTC] [--json]');
  const rotateRequestedAt = flagValue(rest, '--rotate-requested-at');
  const now = flagValue(rest, '--now');
  if (rest.includes('--rotate-requested-at') && !rotateRequestedAt) die('--rotate-requested-at needs a UTC time');
  if (rest.includes('--now') && !now) die('--now needs a UTC time');
  requireEnv();
  let text;
  try {
    // A BOM is kept, so it is refused as v2's checker refuses it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file));
  } catch (err) {
    process.stdout.write(`handoff-check: cannot read ${file}: ${err.message || err} (expected a readable UTF-8 handoff file)\n`);
    process.exit(1);
  }
  const { body } = await api('POST', '/api/cli/handoff/check', {
    text,
    ...(rotateRequestedAt ? { rotateRequestedAt } : {}),
    ...(now ? { now } : {}),
  });
  if (rest.includes('--json')) out(body);
  else if (body.ok) process.stdout.write(`handoff-check: PASS ${file}\n`);
  else process.stdout.write(body.reasons.map((reason) => `handoff-check: ${reason}\n`).join(''));
  if (!body.ok) process.exit(1);
};

const cmdTabCount = async (args) => {
  requireEnv();
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  if (!wsId) die('--workspace is required');
  const { body } = await api('GET', `/api/cli/workspaces/${encodeURIComponent(wsId)}/tab-count`);
  if (args.includes('--json')) return out(body);
  process.stdout.write(`${body.count} ${body.cap}\n`);
};

const cmdTabReportsTo = async (args) => {
  requireEnv();
  const clear = args.includes('--clear');
  // --on MARKERS narrows which end lines reach the target (ADR-0025); `--on all` lifts the filter.
  const on = flagValue(args, '--on');
  if (args.includes('--on') && !on) die('--on needs a comma-separated list of markers (DONE, BLOCKED, NEEDS-DECISION, READY-TO-MERGE, CHECKPOINTED) or all');
  const rest = stripBooleanFlags(stripFlags(args, ['--workspace', '-w', '--on']), ['--clear']);
  const [tabId, target] = rest;
  const usage = 'usage: tab reports-to -w WS TAB_ID (TARGET_TAB_ID | --clear) [--on MARKERS|all]  |  tab reports-to -w WS TAB_ID --on MARKERS|all';
  if (!tabId || (clear && target) || (!clear && !target && !on)) die(usage);
  const wsId = resolveWsForTab(args);
  const patch = {
    ...(clear ? { reportsTo: null } : target ? { reportsTo: target } : {}),
    ...(on ? { reportOn: on.toLowerCase() === 'all' ? null : on } : {}),
  };
  const { body } = await api(
    'PATCH',
    `/api/cli/tabs/${tabId}?workspaceId=${encodeURIComponent(wsId)}`,
    patch,
  );
  out(body);
};

const resolveWsForTab = (args) => {
  const wsId = flagValue(args, '--workspace') || flagValue(args, '-w');
  if (!wsId) die('--workspace is required');
  return wsId;
};

const readStdin = () => new Promise((resolve, reject) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
  process.stdin.on('error', reject);
});

/**
 * Flags for `tab send` and `tab steer` are read only BEFORE the content (story 14 r2). The first
 * word that is not a flag of the command is the tab ID; the next one starts the content, and from
 * there every word is content, byte for byte: `tab send T git log --raw` types `git log --raw`. A
 * literal `--` ends the flags at once (the word after it is the tab ID if none was given yet), so
 * content that starts with a dash still reaches the tab. A word after the content starts that
 * equals one of the command's flags is still sent as text; without `--`, stderr names it, because
 * the caller may have meant the flag.
 */
const parseLeadingArgs = (args, { values, booleans }) => {
  const flags = Object.create(null);
  let tabId = null;
  let terminated = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--') {
      terminated = true;
      i++;
      break;
    }
    if (values.includes(arg)) {
      if (!Object.hasOwn(flags, arg)) flags[arg] = i + 1 < args.length ? args[i + 1] : null;
      i += 2;
      continue;
    }
    if (booleans.includes(arg)) {
      flags[arg] = true;
      i++;
      continue;
    }
    if (tabId !== null) break;
    tabId = arg;
    i++;
  }
  if (terminated && tabId === null && i < args.length) tabId = args[i++];
  const contentWords = args.slice(i);
  const known = [...values, ...booleans];
  const textFlags = terminated ? [] : [...new Set(contentWords.filter((word) => known.includes(word)))];
  return {
    tabId,
    content: contentWords.join(' '),
    has: (...names) => names.some((name) => Object.hasOwn(flags, name)),
    value: (...names) => {
      for (const name of names) if (Object.hasOwn(flags, name)) return flags[name];
      return null;
    },
    textFlags,
  };
};

const noteTextFlags = (parsed) => {
  if (!parsed.textFlags.length) return;
  process.stderr.write(
    `note: ${parsed.textFlags.join(', ')} after the content went to the tab as text; flags are read only before the content (put \`--\` before the content to send such words without this note)\n`,
  );
};

/** -f FILE / -f - / the content words, and the workspace; each refusal says what it saw. */
const readTabInput = async (parsed) => {
  if (parsed.has('--workspace', '-w') && !parsed.value('--workspace', '-w')) die('--workspace: saw no value; expected a workspace ID');
  if (parsed.has('--file', '-f') && !parsed.value('--file', '-f')) die('--file: saw no value; expected a file path, or - for stdin');
  const wsId = parsed.value('--workspace', '-w');
  if (!wsId) die('--workspace is required');
  if (!parsed.tabId) die('tab ID is required');
  const file = parsed.value('--file', '-f');
  const content = file ? (file === '-' ? await readStdin() : require('fs').readFileSync(file, 'utf8')) : parsed.content;
  if (!content) die('content is required (args, -f FILE, or -f - for stdin)');
  return { wsId, tabId: parsed.tabId, content };
};

// Same shape as tab send, but it can interrupt the current turn first, so a busy worker reads the
// correction now (story 14). The server decides the default: an agent tab does not interrupt unless
// it passes --interrupt --reason; any other caller interrupts. The CLI refuses --interrupt without
// --reason (exit 2) for every caller.
const cmdTabSteer = async (args) => {
  requireEnv();
  const parsed = parseLeadingArgs(args, {
    values: ['--workspace', '-w', '--file', '-f', '--reason'],
    booleans: ['--no-interrupt', '--interrupt', '--raw'],
  });
  const interrupt = parsed.has('--interrupt');
  const noInterrupt = parsed.has('--no-interrupt');
  const reasonGiven = parsed.has('--reason');
  const reason = parsed.value('--reason');
  if (reasonGiven && (reason === null || !reason.trim())) {
    die(`--reason: saw ${reason === null ? 'no value' : 'a blank value'}; expected a text of 1..500 characters before the content`);
  }
  if (interrupt && noInterrupt) die('--interrupt and --no-interrupt: saw both; expected at most one');
  if (interrupt && !reasonGiven) die('--interrupt: saw no --reason; expected --interrupt --reason "<why the turn must stop>" before the content');
  if (reasonGiven && !interrupt) die('--reason: saw it without --interrupt; expected --interrupt --reason TEXT, or no --reason');
  const { wsId, tabId, content } = await readTabInput(parsed);
  noteTextFlags(parsed);
  const { body } = await api(
    'POST',
    `/api/cli/tabs/${tabId}/steer?workspaceId=${encodeURIComponent(wsId)}`,
    {
      content,
      ...(noInterrupt ? { interrupt: false } : interrupt ? { interrupt: true, reason } : {}),
      ...(parsed.has('--raw') ? { raw: true } : {}),
    },
  );
  out(body);
};

// The send waits for the target to reach a state that can accept a turn. An
// agent TUI that is still booting swallows the Enter after the paste, so a
// send that does not wait can report success over an agent that never starts.
const MAX_CLI_WAIT_MS = 240_000;

const cmdTabSend = async (args) => {
  requireEnv();
  const parsed = parseLeadingArgs(args, {
    values: ['--workspace', '-w', '--file', '-f', '--wait-ms'],
    booleans: ['--no-wait', '--raw'],
  });
  const noWait = parsed.has('--no-wait');
  const waitMsGiven = parsed.has('--wait-ms');
  const waitMs = parsed.value('--wait-ms');
  if (noWait && waitMsGiven) die('--no-wait and --wait-ms are mutually exclusive');
  // `--wait-ms` as the last token leaves no value to read; falling back to the
  // default would silently wait 60s for a caller that asked for something else.
  if (waitMsGiven && (waitMs === null || !/^\d+$/.test(waitMs))) {
    die('--wait-ms must be a whole number of milliseconds');
  }
  // Node's fetch stops waiting for response headers at 300 s. The server still
  // takes the dispatch lock and types the prompt after the wait, so the cap
  // leaves a minute for that; it narrows the outcome-unknown window, it does
  // not close it.
  if (waitMsGiven && Number(waitMs) > MAX_CLI_WAIT_MS) {
    die(`--wait-ms must be at most ${MAX_CLI_WAIT_MS} (the CLI's HTTP client stops waiting at 300 s)`);
  }
  const { wsId, tabId, content } = await readTabInput(parsed);
  noteTextFlags(parsed);
  const { body } = await api(
    'POST',
    `/api/cli/tabs/${tabId}/send?workspaceId=${encodeURIComponent(wsId)}`,
    {
      content,
      ...(noWait ? { waitMs: 0 } : waitMs ? { waitMs: Number(waitMs) } : {}),
      ...(parsed.has('--raw') ? { raw: true } : {}),
    },
  );
  out(body);
};

const cmdTabStatus = async (args) => {
  requireEnv();
  const rest = stripFlags(args, ['--workspace', '-w']);
  const tabId = rest[0];
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'GET',
    `/api/cli/tabs/${tabId}/status?workspaceId=${encodeURIComponent(wsId)}`,
  );
  out(body);
};

const cmdTabResult = async (args) => {
  requireEnv();
  const raw = args.includes('--raw');
  const noSuggestions = args.includes('--no-suggestions');
  const rest = stripBooleanFlags(stripFlags(args, ['--workspace', '-w']), ['--raw', '--no-suggestions']);
  const tabId = rest[0];
  if (!tabId) die('tab ID is required');
  if (raw && noSuggestions) die('--raw and --no-suggestions are exclusive');
  const wsId = resolveWsForTab(args);
  const mode = raw ? '&raw=1' : noSuggestions ? '&suggestions=0' : '';
  const { body } = await api(
    'GET',
    `/api/cli/tabs/${tabId}/result?workspaceId=${encodeURIComponent(wsId)}${mode}`,
  );
  out(body);
};

const cmdTabClose = async (args) => {
  requireEnv();
  const keep = args.includes('--keep-processes');
  const rest = stripBooleanFlags(stripFlags(args, ['--workspace', '-w']), ['--keep-processes']);
  const tabId = rest[0];
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'DELETE',
    `/api/cli/tabs/${tabId}?workspaceId=${encodeURIComponent(wsId)}${keep ? '&keepProcesses=1' : ''}`,
  );
  // A 200 is not a close: the server answers `ok: false` when the layout kept
  // the tab, and printing ok over that hides a tab that is still running.
  if (body?.ok !== true) return fail('close-not-confirmed', `the server answered ${JSON.stringify(body)}`);
  // `ok` stays the first line; what the close reaped follows (ADR-0016).
  const lines = ['ok'];
  for (const p of Array.isArray(body.killed) ? body.killed : []) lines.push(`killed ${p.pid} ${p.comm} ${p.args}`);
  for (const p of Array.isArray(body.survivors) ? body.survivors : []) lines.push(`survivor ${p.pid} ${p.comm} ${p.args}`);
  if (body.reaper === 'unavailable') lines.push('reaper: unavailable (no /proc): only the pane group was signalled');
  if (body.reaper === 'remote-skipped') lines.push('reaper: skipped (the host is out of remote.hosts and did not answer): nothing on it was reaped');
  if (body.envMarker === 'absent') lines.push('envMarker: absent (a tab created before per-tab identity): only its pane descendants were reaped');
  process.stdout.write(`${lines.join('\n')}\n`);
};

// A fresh agent process under the same tab id (ADR-0028): the server reaps the
// tab's processes, recreates its session and relaunches the agent with the
// tab's own launch settings. Leases, watches, probes and notes stay.
const cmdTabRestart = async (args) => {
  requireEnv();
  const clear = args.includes('--clear');
  const interrupt = args.includes('--interrupt');
  const asJson = args.includes('--json');
  const rest = stripBooleanFlags(stripFlags(args, ['--workspace', '-w']), ['--clear', '--interrupt', '--json']);
  const tabId = rest[0];
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'POST',
    `/api/cli/tabs/${encodeURIComponent(tabId)}/restart?workspaceId=${encodeURIComponent(wsId)}`,
    { clear, interrupt },
  );
  if (body?.ok !== true) return fail('restart-not-confirmed', `the server answered ${JSON.stringify(body)}`);
  if (asJson) return out(body);
  const lines = [`ok ${tabId} restarted (${body.resumed ? 'resumed' : 'fresh'})`];
  if (body.resumeSkipped) lines.push(`resume skipped: ${body.resumeSkipped}`);
  if (body.reaped) lines.push(`reaped: ${body.reaped.killed} killed, ${body.reaped.survivors} survivors`);
  if (body.identity) lines.push(`identity: ${body.identity}`);
  if (body.launchState === 'held') lines.push('launch: held (the Codex launch was not confirmed; see tab status)');
  process.stdout.write(`${lines.join('\n')}\n`);
};

// Liveness probes: the watchdog runs --cmd on an interval; its last non-empty
// stdout line must be a numeric seconds-since-last-progress value. Above --stale-after, the orchestrator
// gets a STALLED nudge and the human gets a push alert.
const cmdTabProbe = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = stripFlags(args.slice(1), ['--workspace', '-w', '--cmd', '--stale-after', '--interval', '--label']);
  const tabId = rest[0];
  if (!sub) die('probe subcommand required (set | list | clear)');
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const qs = `workspaceId=${encodeURIComponent(wsId)}`;

  switch (sub) {
    case 'set': {
      const command = flagValue(args, '--cmd');
      const staleAfter = flagValue(args, '--stale-after');
      const interval = flagValue(args, '--interval');
      const label = flagValue(args, '--label');
      if (!command) die('--cmd is required');
      if (!staleAfter || !/^\d+$/.test(staleAfter)) die('--stale-after SECS is required (whole seconds)');
      if (interval && !/^\d+$/.test(interval)) die('--interval must be whole seconds');
      const { body } = await api('POST', `/api/cli/tabs/${tabId}/probe?${qs}`, {
        command,
        stalenessThresholdS: Number(staleAfter),
        ...(interval ? { intervalS: Number(interval) } : {}),
        ...(label ? { label } : {}),
      });
      return out(body);
    }
    case 'list': {
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/probe?${qs}`);
      return out(body);
    }
    case 'clear': {
      const label = flagValue(args, '--label');
      const path = `/api/cli/tabs/${tabId}/probe?${qs}${label ? `&label=${encodeURIComponent(label)}` : ''}`;
      const { body } = await api('DELETE', path);
      return out(body);
    }
    default:
      die(`unknown probe subcommand: ${sub}. Use set | list | clear`);
  }
};

// Background job watch: when the pid exits, the orchestrator gets a completion,
// failure, or unknown-status nudge with a stderr tail when available.
const cmdTabBg = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = stripFlags(args.slice(1), ['--workspace', '-w', '--pid', '--label', '--stderr', '--exit-file', '--notify']);
  const tabId = rest[0];
  if (!sub) die('bg subcommand required (add | list | remove)');
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const qs = `workspaceId=${encodeURIComponent(wsId)}`;

  switch (sub) {
    case 'add': {
      const pid = flagValue(args, '--pid');
      const label = flagValue(args, '--label');
      const stderrFile = flagValue(args, '--stderr');
      const exitCodeFile = flagValue(args, '--exit-file');
      const notify = flagValue(args, '--notify');
      if (!pid || !/^\d+$/.test(pid)) die('--pid N is required');
      if (args.includes('--notify') && notify !== 'self' && notify !== 'orchestrator') die('--notify must be self or orchestrator');
      const { body } = await api('POST', `/api/cli/tabs/${tabId}/bg?${qs}`, {
        pid: Number(pid),
        ...(label ? { label } : {}),
        ...(stderrFile ? { stderrFile: require('path').resolve(stderrFile) } : {}),
        ...(exitCodeFile ? { exitCodeFile: require('path').resolve(exitCodeFile) } : {}),
        ...(notify ? { notify } : {}),
      });
      return out(body);
    }
    case 'list': {
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/bg?${qs}`);
      return out(body);
    }
    case 'remove': {
      const pid = flagValue(args, '--pid');
      if (pid && !/^\d+$/.test(pid)) die('--pid must be a whole number');
      const path = `/api/cli/tabs/${tabId}/bg?${qs}${pid ? `&pid=${pid}` : ''}`;
      const { body } = await api('DELETE', path);
      return out(body);
    }
    default:
      die(`unknown bg subcommand: ${sub}. Use add | list | remove`);
  }
};

const cmdTabBrowser = async (args) => {
  requireEnv();
  const sub = args[0];
  const rest = stripFlags(args.slice(1), ['--workspace', '-w', '-o', '--since', '--level', '--method', '--url', '--status', '--request', '--full']);
  const tabId = rest[0];
  if (!sub) die('browser subcommand required (url | screenshot | console | network | eval)');
  if (!tabId) die('tab ID is required');
  const wsId = resolveWsForTab(args);
  const qs = `workspaceId=${encodeURIComponent(wsId)}`;

  switch (sub) {
    case 'url': {
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/browser/url?${qs}`);
      out(body);
      return;
    }
    case 'screenshot': {
      const outPath = flagValue(args, '-o') || flagValue(args, '--output');
      const full = args.includes('--full') ? '1' : '0';
      const path = `/api/cli/tabs/${tabId}/browser/screenshot?${qs}&full=${full}`;
      if (outPath) {
        const resp = await apiRaw('GET', path);
        const buf = Buffer.from(await readBody('GET', path, resp, 'arrayBuffer'));
        fs.writeFileSync(outPath, buf);
        out({ saved: outPath, bytes: buf.byteLength });
      } else {
        const { body } = await api('GET', `${path}&format=base64`);
        out(body);
      }
      return;
    }
    case 'console': {
      const since = flagValue(args, '--since');
      const level = flagValue(args, '--level');
      const params = [qs];
      if (since) params.push(`since=${encodeURIComponent(since)}`);
      if (level) params.push(`level=${encodeURIComponent(level)}`);
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/browser/console?${params.join('&')}`);
      out(body);
      return;
    }
    case 'network': {
      const since = flagValue(args, '--since');
      const method = flagValue(args, '--method');
      const urlFilter = flagValue(args, '--url');
      const status = flagValue(args, '--status');
      const requestId = flagValue(args, '--request');
      const params = [qs];
      if (requestId) params.push(`requestId=${encodeURIComponent(requestId)}`);
      if (since) params.push(`since=${encodeURIComponent(since)}`);
      if (method) params.push(`method=${encodeURIComponent(method)}`);
      if (urlFilter) params.push(`url=${encodeURIComponent(urlFilter)}`);
      if (status) params.push(`status=${encodeURIComponent(status)}`);
      const { body } = await api('GET', `/api/cli/tabs/${tabId}/browser/network?${params.join('&')}`);
      out(body);
      return;
    }
    case 'eval': {
      const expression = rest.slice(1).join(' ');
      if (!expression) die('expression is required');
      const { body } = await api('POST', `/api/cli/tabs/${tabId}/browser/eval?${qs}`, { expression });
      out(body);
      return;
    }
    default:
      die(`unknown browser subcommand: ${sub}. Use url | screenshot | console | network | eval`);
  }
};

// ── ledger (ADR-0033) ────────────────────────────────────────────────────────
const LEDGER_USAGE = [
  'usage: ledger token issue -w WS --producer NAME [--out FILE]',
  '       ledger emit -w WS --token-file FILE [--json @FILE|@-|JSON]',
  '       ledger show -w WS [--open] [--type TYPE] [--holder H] [--json]',
  '       ledger waits -w WS [--since T] [--until T] [--by reason|holder|type|stage] [--type TYPE] [--json]',
  '       ledger experiment open -w WS --json @FILE | close -w WS EXP-n --verdict keep|revert --evidence TEXT | list -w WS [--json]',
  '       ledger experiment extend -w WS EXP-n --days N --evidence TEXT',
].join('\n');
// Mirrors src/lib/ledger.ts: the server refuses more, so the CLI never builds a batch it cannot take.
const LEDGER_MAX_EVENTS = 500;
const LEDGER_MAX_BYTES = 1000 * 1000;
const LEDGER_EMIT_TIMEOUT_MS = 5000;
const LEDGER_PRODUCER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const LEDGER_LOCK_WAIT_MS = 3000;
const LEDGER_LOCK_STALE_MS = 60_000;
const LEDGER_FILE_LOCK_STALE_MS = 10_000;

const ledgerWorkspace = (rest) => {
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  return wsId;
};

const ledgerPath = (wsId, route) => `/api/cli/workspaces/${encodeURIComponent(wsId)}/ledger/${route}`;

const writePrivateFile = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
};

const cmdLedgerTokenIssue = async (rest) => {
  const wsId = ledgerWorkspace(rest);
  const producer = flagValue(rest, '--producer');
  if (!producer || !LEDGER_PRODUCER.test(producer)) die(`--producer: saw ${JSON.stringify(producer)}, expected a name matching ${LEDGER_PRODUCER.source}`);
  const file = path.resolve(flagValue(rest, '--out') || path.join(os.homedir(), '.purplemux', 'ledger-tokens', wsId, `${producer}.json`));
  requireEnv();
  const { body } = await api('POST', ledgerPath(wsId, 'tokens'), { producer });
  writePrivateFile(file, `${JSON.stringify(body, null, 2)}\n`);
  process.stdout.write(`wrote ${file} (scope ${body.scope} on ${body.workspaceId} for producer ${body.producer}; an earlier token of this producer no longer works)\n`);
};

const readLedgerTokenFile = (file) => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return die(`--token-file: cannot read ${file}: ${err.code || err.message}`);
  }
  if (!parsed || typeof parsed.token !== 'string' || typeof parsed.workspaceId !== 'string' || !LEDGER_PRODUCER.test(parsed.producer || '')) {
    return die(`--token-file: ${file} is not a token file written by "ledger token issue"`);
  }
  return parsed;
};

/** A JSON array, a { "events": [...] } batch, one event object, or JSON Lines of events. */
const parseLedgerInput = (raw) => {
  const text = raw.trim();
  if (!text) return die('ledger emit: no events on input');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch {
      return die('ledger emit: input must be JSON (an event, an array, { "events": [...] }) or JSON Lines');
    }
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray(value.events)) return value.events;
  return [value];
};

/**
 * The spool as lines. A torn last line (a crash mid-append: no newline, not JSON) is counted and
 * dropped. Any other line that is not JSON stops the drain: `bad` is its 1-based line number.
 */
const readLedgerSpool = (file) => {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { events: [], lines: 0, bad: null };
    throw err;
  }
  const lines = text.split('\n');
  const tail = lines.pop();
  const events = [];
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    try { events.push(JSON.parse(lines[index])); } catch { return { events, lines: lines.length + (tail ? 1 : 0), bad: index + 1 }; }
  }
  if (tail && tail.trim()) {
    try { events.push(JSON.parse(tail)); } catch { /* torn by a crash mid-append */ }
  }
  return { events, lines: lines.length + (tail ? 1 : 0), bad: null };
};

/** The raw lines past the first `count`: what other emits appended while this one drained. */
const spoolLinesAfter = (file, count) => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(count).filter((line) => line.trim());
};

const toJsonLines = (events) => events.map((event) => `${JSON.stringify(event)}\n`).join('');

const rewriteLedgerSpool = (file, events, appendedLines) => {
  const text = toJsonLines(events) + appendedLines.map((line) => `${line}\n`).join('');
  if (text) writePrivateFile(file, text);
  else fs.rmSync(file, { force: true });
};

/**
 * A lock directory. Waits at most `waitMs`; a lock whose mtime is older than `staleMs` belongs to
 * a crashed emit and is taken over. Returns `{ release, touch }`, or null when it stayed busy.
 */
const takeLock = async (lockDir, waitMs, staleMs) => {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return {
        release: () => fs.rmSync(lockDir, { recursive: true, force: true }),
        touch: () => { try { const now = new Date(); fs.utimesSync(lockDir, now, now); } catch { /* released */ } },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs) fs.rmSync(lockDir, { recursive: true, force: true });
      } catch { /* the holder released it between the two calls */ }
      if (Date.now() > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
};

/**
 * Every change to a spool file happens under its short file lock: an append, the drainer's first
 * read and its final rewrite. The wait outlasts the stale age, so the lock is always taken.
 */
const withSpoolFile = async (spoolFile, fn) => {
  const lock = await takeLock(`${spoolFile}.lock`, LEDGER_FILE_LOCK_STALE_MS + 1000, LEDGER_FILE_LOCK_STALE_MS);
  try {
    return fn();
  } finally {
    lock?.release();
  }
};

/** Append under the file lock; a torn last line is closed first, so it never swallows the new line. */
const appendLedgerSpool = (spoolFile, events) => withSpoolFile(spoolFile, () => {
  let prefix = '';
  try {
    const size = fs.statSync(spoolFile).size;
    if (size > 0) {
      const last = Buffer.alloc(1);
      const fd = fs.openSync(spoolFile, 'r');
      try { fs.readSync(fd, last, 0, 1, size - 1); } finally { fs.closeSync(fd); }
      if (last.toString() !== '\n') prefix = '\n';
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.appendFileSync(spoolFile, prefix + toJsonLines(events), { mode: 0o600 });
});

/** The leading entries of `rest` that fit one batch; a batch never mixes spooled and new events. */
const nextLedgerBatch = (rest) => {
  const batch = [];
  let bytes = 20;
  for (const entry of rest) {
    const size = Buffer.byteLength(JSON.stringify(entry.event)) + 1;
    if (batch.length && (entry.spooled !== batch[0].spooled || batch.length >= LEDGER_MAX_EVENTS || bytes + size > LEDGER_MAX_BYTES)) break;
    batch.push(entry);
    bytes += size;
  }
  return batch;
};

// A refusal no retry can change: the batch is wrong, not the ledger down.
const LEDGER_REFUSAL_CODES = new Set(['ledger-type-reserved', 'ledger-event-conflict']);

/** POST one batch; never exits. `delivered` false means the ledger could not take it now. */
const postLedgerBatch = async (wsId, token, events) => {
  if (!PORT && !URL_OVERRIDE) return { delivered: false, reason: 'no server port configured' };
  let resp;
  try {
    resp = await fetch(`${BASE}${ledgerPath(wsId, 'events')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pmux-Token': token },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(LEDGER_EMIT_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `no answer in ${LEDGER_EMIT_TIMEOUT_MS} ms` : (causeCode(err) || err?.message || String(err));
    return { delivered: false, reason };
  }
  let body = null;
  try { body = await resp.json(); } catch { body = null; }
  if (resp.ok && body && body.ok === true) return { delivered: true, body };
  if (resp.status === 400 || resp.status === 413 || LEDGER_REFUSAL_CODES.has(body?.code)) {
    return { delivered: false, refused: true, status: resp.status, body };
  }
  return { delivered: false, reason: `HTTP ${resp.status}${body?.code ? ` ${body.code}` : ''}` };
};

const ledgerEventIndex = (field) => {
  const match = typeof field === 'string' ? /^events\[(\d+)\]/.exec(field) : null;
  return match ? Number(match[1]) : null;
};

const cmdLedgerEmit = async (rest) => {
  const wsId = ledgerWorkspace(rest);
  const tokenFile = flagValue(rest, '--token-file');
  if (!tokenFile) die('--token-file is required (write one with "ledger token issue")');
  const credential = readLedgerTokenFile(tokenFile);
  if (credential.workspaceId !== wsId) die(`--token-file emits for ${credential.workspaceId}, not ${wsId}`);
  const value = flagValue(rest, '--json');
  const raw = value && value.startsWith('@') && value !== '@-'
    ? (() => { try { return fs.readFileSync(value.slice(1), 'utf8'); } catch (err) { return die(`cannot read ${value.slice(1)}: ${err.code || err.message}`); } })()
    : (value && value !== '@-' ? value : await readStdin());
  const fresh = parseLedgerInput(raw);
  const spoolDir = path.join(os.homedir(), '.purplemux', 'ledger-spool');
  const spoolFile = path.join(spoolDir, `${credential.producer}.jsonl`);
  const rejectedFile = path.join(spoolDir, `${credential.producer}.rejected.jsonl`);
  fs.mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const drain = await takeLock(path.join(spoolDir, `${credential.producer}.drain.lock`), LEDGER_LOCK_WAIT_MS, LEDGER_LOCK_STALE_MS);
  if (!drain) {
    await appendLedgerSpool(spoolFile, fresh);
    process.stderr.write(`warning: spooled ${fresh.length} events to ${spoolFile}: another emit of ${credential.producer} is draining\n`);
    return;
  }
  let refusedNew = null;
  try {
    const spool = await withSpoolFile(spoolFile, () => readLedgerSpool(spoolFile));
    if (spool.bad !== null) {
      await appendLedgerSpool(spoolFile, fresh);
      process.stderr.write(`warning: ${spoolFile} line ${spool.bad} is not JSON; nothing was drained and ${fresh.length} events were appended. `
        + 'Fix or remove that line; the next emit drains the spool\n');
      return;
    }
    let pending = [...spool.events.map((event) => ({ event, spooled: true })), ...fresh.map((event) => ({ event, spooled: false }))];
    const totals = { accepted: 0, duplicates: 0, drained: 0, rejected: 0 };
    while (pending.length) {
      drain.touch();
      const batch = nextLedgerBatch(pending);
      const result = await postLedgerBatch(wsId, credential.token, batch.map((entry) => entry.event));
      if (result.delivered) {
        totals.accepted += result.body.accepted;
        totals.duplicates += result.body.duplicates;
        if (batch[0].spooled) totals.drained += batch.length;
        pending = pending.slice(batch.length);
        continue;
      }
      if (result.refused) {
        // Only the refused event is set aside; the rest of its batch is sent again, in order.
        const index = ledgerEventIndex(result.body?.field);
        const refused = index !== null && index < batch.length ? [batch[index]] : batch;
        fs.appendFileSync(rejectedFile, toJsonLines(refused.map((entry) => entry.event)), { mode: 0o600 });
        process.stderr.write(`warning: kept ${refused.length} refused event(s) in ${rejectedFile}: ${result.body?.error || `HTTP ${result.status}`}\n`);
        if (refused.some((entry) => !entry.spooled)) refusedNew = result;
        totals.rejected += refused.length;
        pending = pending.filter((entry) => !refused.includes(entry));
        continue;
      }
      await withSpoolFile(spoolFile, () => rewriteLedgerSpool(spoolFile, pending.map((entry) => entry.event), spoolLinesAfter(spoolFile, spool.lines)));
      process.stderr.write(`warning: spooled ${pending.length} events to ${spoolFile} (${result.reason}); the next emit sends them first\n`);
      return;
    }
    await withSpoolFile(spoolFile, () => rewriteLedgerSpool(spoolFile, [], spoolLinesAfter(spoolFile, spool.lines)));
    process.stdout.write(`ok accepted=${totals.accepted} duplicates=${totals.duplicates} drained=${totals.drained}${totals.rejected ? ` rejected=${totals.rejected}` : ''}\n`);
  } finally {
    drain.release();
  }
  if (refusedNew) failFromResponse({ status: refusedNew.status }, refusedNew.body);
};

const dash = (value) => (value === null || value === undefined ? '—' : String(value));

const ledgerDuration = (ms) => {
  if (ms === null || ms === undefined) return '—';
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
};

const printTable = (columns, rows) => {
  const table = [columns, ...rows];
  const widths = columns.map((_, i) => Math.max(...table.map((cells) => cells[i].length)));
  for (const cells of table) process.stdout.write(cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd() + '\n');
};

// ── board (ADR-0034) ─────────────────────────────────────────────────────────
const BOARD_USAGE = 'usage: board show [-w WS] [--json|--line|--mine] | board pulse [-w WS] [--json]'
  + ' | board goal set -w WS --items KEY,KEY --label TEXT | board goal show|clear -w WS'
  + " (show and pulse default to this tab's workspace, PMUX_WORKSPACE_ID)";

// The owner reads times in AEDT/AEST (ADR-HFL-02); Intl names the offset that applies on the day.
const boardTime = (ms) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
};

// A finder answer older than two ticks says so on every face: a hung tick is not a fresh board.
// A down curator rides on the line too (ADR-0038 §6): the owner's bare status ask is answered with it.
const boardLineText = (board) => {
  const line = board.staleSince === null || board.staleSince === undefined ? board.line : `${board.line} · stale since ${boardTime(board.staleSince)}`;
  return board.curator && board.curator.health.state === 'down' ? `${line} · curator down` : line;
};

const boardInput = (name, input) => `${name} ${input.state}${input.reason ? ` (${input.reason})` : ''}`;

const boardMeasures = (board) => {
  const now = board.generatedAt + board.ageMs;
  const shown = board.stuck.length < board.stuckTotal ? `${board.stuck.length} of ${board.stuckTotal}` : String(board.stuckTotal);
  process.stdout.write(`stuck, oldest first: ${shown}\n`);
  if (board.stuck.length) {
    printTable(['ITEM', 'REASON', 'AGE', 'HOLDER', 'CLEARS'], board.stuck.map((item) => [
      `${item.critical ? '* ' : ''}${item.key}`, item.reasonLabel, ledgerDuration(now - item.since), dash(item.holder), dash(item.clearInput),
    ]));
  }
  const breached = board.anomalies.filter((a) => a.breached);
  process.stdout.write(`anomalies over threshold: ${breached.length}\n`);
  for (const a of breached) process.stdout.write(`  ${a.text}\n`);
};

const boardText = (board) => {
  const lines = [`board ${board.workspaceId} · finder ran ${ledgerDuration(board.ageMs)} ago`, boardLineText(board), goalText(board)];
  const c = board.constraint;
  lines.push(c
    ? `constraint: ${c.labels.reason} (${c.labels.stage}), ${c.waitingHours.toFixed(1)} h in 24 h on ${c.items} item(s), `
      + `${c.basis === 'critical' ? 'critical items' : 'all items'}, ${c.labels.trend}; owner ${dash(c.ownerSeat)}; clears: ${c.clearInput ?? 'not recorded'}`
    : `constraint: ${board.inputs.ledger.state === 'ok' ? 'none measured in 24 h' : 'unknown'}`);
  lines.push(board.needsYou === null ? 'needs you: unknown (Mission Control unreadable)' : `needs you: ${board.needsYou.length} open in Mission Control`);
  const ledgerUnknown = board.inputs.ledger.state === 'ok' ? null : (board.inputs.ledger.reason || board.inputs.ledger.state);
  for (const item of board.needsYou ?? []) {
    let blocked = 'no ledger item links to this item';
    if (ledgerUnknown) blocked = `blocked cost not measured: ${ledgerUnknown}`;
    else if (item.blocked) {
      blocked = `blocks ${item.blocked.items} item(s), ${item.blocked.hours.toFixed(1)} h waiting${item.blocked.critical ? ', critical path' : ''}`;
    }
    lines.push(`  ${item.id}  ${item.title} · ${blocked}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (ledgerUnknown) {
    // Not measured is not none: an unread ledger never prints as "0 stuck".
    process.stdout.write(`stuck: unknown (${ledgerUnknown})\nanomalies: unknown (${ledgerUnknown})\n`);
  } else {
    boardMeasures(board);
  }
  if (board.curator) {
    const agree = (task) => {
      if (task.task === 'reshape-question') return 'gated by its evaluation and judge';
      const a = (board.curator.agreement || []).find((x) => x.task === task.task);
      return a && a.compared ? `${a.agreed}/${a.compared} agree` : 'no labels in 72 h';
    };
    process.stdout.write(`curator: ${board.curator.health.state === 'down' ? 'curator down' : board.curator.health.state}`
      + `${board.curator.health.state === 'down' && board.curator.health.reason ? ` (${board.curator.health.reason}); the rules route` : ''}`
      + ` · ${board.curator.tasks.map((t) => `${t.task} ${t.state}${t.state === 'routing' && !t.routingHere ? ' (not here)' : ''}, ${agree(t)}`).join(' · ')}\n`);
  } else {
    process.stdout.write('curator: unknown (state unreadable)\n');
  }
  const { ledger, flow, spend, pool } = board.inputs;
  process.stdout.write(`inputs: ${[boardInput('ledger', ledger), boardInput('flow', flow), boardInput('spend', spend), boardInput('pool', pool)].join(' · ')}\n`);
};

// ── board pulse (ADR-0034 §9) ────────────────────────────────────────────────
const PULSE_BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const PULSE_STATE_WORDS = { stalled: 'STALLED', moving: 'moving', steady: 'steady', idle: 'idle', 'not-measured': 'not measured' };

// One character per clock hour, oldest left; a measured zero is '·', never a blank.
const pulseStrip = (hours) => {
  const max = Math.max(...hours.map((hour) => hour.total));
  return hours.map((hour) => (hour.total === 0 ? '·' : PULSE_BLOCKS[Math.min(7, Math.ceil((hour.total / max) * 8) - 1)])).join('');
};

const pulseText = (pulse) => {
  const scope = pulse.scope && pulse.scope.basis === 'epic' ? `epic ${pulse.scope.epics.join(', ')}` : 'its own directories';
  const lines = [`pulse ${pulse.workspaceId} (counts ${scope}) · read ${ledgerDuration(Date.now() - pulse.generatedAt)} ago`];
  lines.push(pulse.hours
    ? `last 48 h, one mark per hour, oldest left: ${pulseStrip(pulse.hours)}`
    : 'last 48 h: not measured (no movement source could be read)');
  if (pulse.hours) {
    const failed = pulse.hours.reduce((sum, hour) => sum + hour.gatesFailed, 0);
    const passed = pulse.hours.reduce((sum, hour) => sum + hour.gatesPassed, 0);
    lines.push(`gates in 48 h: ${passed} passed, ${failed} failed`);
  }
  const stateWord = Object.hasOwn(PULSE_STATE_WORDS, pulse.stall.state) ? PULSE_STATE_WORDS[pulse.stall.state] : 'state not in the label map';
  lines.push(pulse.stall.state === 'not-measured' ? pulse.stall.reason : `${stateWord}: ${pulse.stall.reason}`);
  lines.push(`priority now: ${pulse.priority.text}${pulse.staleSince === null ? '' : ` · stale since ${boardTime(pulse.staleSince)}`}`);
  lines.push(`work in progress: ${pulse.wip.basisReason}`);
  lines.push('sources:');
  process.stdout.write(`${lines.join('\n')}\n`);
  printTable(['  SOURCE', '48 H', 'LAST'], pulse.sources.map((source) => [
    `  ${source.label}${source.sharedWith ? ` (shared with ${source.sharedWith.join(', ')}; not counted)` : ''}`,
    source.state === 'ok' ? String(source.count) : `not measured (${source.reason})`,
    source.lastAt === null ? '—' : boardTime(source.lastAt),
  ]));
};

const goalText = (body) => {
  const t = body.onTrack;
  if (t && t.goalState === 'unknown') return `goal: ${t.reason || 'goal not measured'}`;
  if (!t || t.goal === null) return 'goal: no goal set';
  const forecast = t.p50At === null ? `no forecast (${t.reason})` : `p50 ${boardTime(t.p50At)}, p90 ${boardTime(t.p90At)}`;
  const rate = t.throughputPerDay ? ` · closed per day, last 3 days: ${t.throughputPerDay.join(', ')}` : '';
  return `goal: ${t.goal} · ${t.itemsLeft === null ? 'items left unknown' : `${t.itemsLeft} items left`} · ${forecast}${rate} · ${t.state}`;
};

const cmdBoardGoal = async (rest) => {
  const action = rest[0];
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w');
  if (!wsId) die('--workspace is required');
  const path = `/api/cli/workspaces/${encodeURIComponent(wsId)}/board-goal`;
  requireEnv();
  if (action === 'show') {
    const { body } = await api('GET', path);
    if (rest.includes('--json')) return out(body);
    const board = (await api('GET', `/api/cli/workspaces/${encodeURIComponent(wsId)}/board`)).body;
    process.stdout.write(`${goalText(board)}\n`);
    if (body.goal) process.stdout.write(`items: ${body.goal.items.join(', ')}\nset by ${body.goal.setBy} at ${boardTime(body.goal.setAt)}\n`);
    return;
  }
  if (action === 'clear') {
    const { body } = await api('DELETE', path);
    if (rest.includes('--json')) return out(body);
    process.stdout.write(body.cleared ? 'goal cleared\n' : 'no goal was set\n');
    return;
  }
  if (action !== 'set') die(BOARD_USAGE);
  const items = flagValue(rest, '--items');
  const label = flagValue(rest, '--label');
  if (!items) die('--items is required: ledger item keys, comma-separated (range:<lane>:<key12>, slice:<lane>, ...)');
  if (!label) die('--label is required');
  const { body } = await api('PUT', path, { label, items: items.split(',').map((key) => key.trim()).filter(Boolean) });
  if (rest.includes('--json')) return out(body);
  process.stdout.write(`${goalText(body)}\n`);
};

const cmdBoard = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'goal') return cmdBoardGoal(rest);
  if (sub !== 'show' && sub !== 'pulse') die(BOARD_USAGE);
  // A tab asks about its own workspace: seed order SO-7 runs `board show --line` with no -w (review r1, R4).
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w') || process.env.PMUX_WORKSPACE_ID;
  if (!wsId) die('--workspace is required outside a purplemux tab (PMUX_WORKSPACE_ID is not set)');
  if (sub === 'pulse') {
    requireEnv();
    const { body } = await api('GET', `/api/cli/workspaces/${encodeURIComponent(wsId)}/pulse`);
    if (rest.includes('--json')) return out(body);
    pulseText(body);
    return;
  }
  const modes = ['--json', '--line', '--mine'].filter((flag) => rest.includes(flag));
  if (rest.includes('--json') && rest.includes('--line')) die('--json and --line are exclusive');
  requireEnv();
  const query = modes.includes('--mine') ? '?mine=1' : '';
  const { body } = await api('GET', `/api/cli/workspaces/${encodeURIComponent(wsId)}/board${query}`);
  if (modes.includes('--json')) return out(body);
  if (modes.includes('--line')) {
    process.stdout.write(`${boardLineText(body)}\n`);
    return;
  }
  boardText(body);
};

// ── curator (ADR-0038) ───────────────────────────────────────────────────────
const CURATOR_TASKS = ['classify-owner-message', 'flag-owner-question', 'match-standing-order', 'reshape-question'];
const CURATOR_USAGE = 'usage: curator status [--json] | eval --task T [--split holdout|train|all] [--no-wait] [--json] | promote|demote --task T'
  + ' | label-queue --task T [--json] | label-import --task T --file F | spot-check open -w WS [--task T] [--run RUN] | spot-check show [--task T] [--json]'
  + ' | reshape-pairs | judge-import --file F [--judge NAME] | message -w WS ID';
const CURATOR_EVAL_POLL_MS = 5000;
const { spotCheckEvent } = require('./curator-spot-check-event.js');
const CURATOR_SPLITS = ['holdout', 'train', 'all'];

const curatorTask = (rest, fallback) => {
  const task = flagValue(rest, '--task') || fallback;
  if (!CURATOR_TASKS.includes(task)) die(`--task must be one of ${CURATOR_TASKS.join(', ')} — ${CURATOR_USAGE}`);
  return task;
};

const ratio = (value) => (value === null || value === undefined ? 'not measured' : value.toFixed(3));

const curatorHealthText = (health) => {
  if (health.state === 'up') return 'up';
  if (health.state === 'down') return `DOWN${health.reason ? ` (${health.reason})` : ''}${health.since ? ` since ${boardTime(health.since)}` : ''}: the rules route`;
  return 'not probed yet';
};

// The bound decides, the point estimate explains (consult 16-promote-gate, ruling 1).
// A bound is printed rounded down to 4 decimals: just under its threshold never reads as reaching it.
const boundText = (value) => (value === null || value === undefined ? 'not measured' : (Math.floor(value * 1e4) / 1e4).toFixed(4));
const curatorCheckText = (check) => `${check.pass ? 'PASS' : 'FAIL'} ${check.label} ${check.metric} ${check.successes}/${check.trials} = ${ratio(check.measured)}; `
  + `95% lower bound ${boundText(check.lowerBound)} >= ${check.threshold.toFixed(2)}? (0 errors needs ${check.minTrials})`;

const curatorEvalText = (result) => {
  const outcomes = Object.entries(result.outcomes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  process.stdout.write(`${result.task} · prompt ${result.promptVersion} · ${result.model} · ${result.split} · ${result.n} items`
    + ` (unresolved ${result.unresolved}, aged out ${result.agedOut}, left out: ${result.excluded.shadow} shadow, ${result.excluded.disputed} disputed)`
    + ` · ran ${boardTime(result.startedAt)} to ${boardTime(result.finishedAt)}\n`);
  if (result.refused) {
    process.stdout.write(`REFUSED: ${result.refused} — no model call was made; promote reads this as no evaluation\n`);
    return;
  }
  process.stdout.write(`outcomes: ${outcomes} · latency p50 ${result.latency.p50 ?? '—'} ms, p90 ${result.latency.p90 ?? '—'} ms\n`);
  printTable(['CLASS', 'SUPPORT', 'PREDICTED', 'PRECISION', 'RECALL', 'RULES P', 'RULES R'], result.score.classes.map((c) => {
    const rules = result.rules.classes.find((r) => r.label === c.label) || {};
    return [c.label, String(c.support), String(c.predicted), ratio(c.precision), ratio(c.recall), ratio(rules.precision), ratio(rules.recall)];
  }));
  process.stdout.write('gate on this run alone (ADR-0038 §5; promote adds the labelled shadow rows):\n');
  for (const check of result.score.checks) process.stdout.write(`  ${curatorCheckText(check)}\n`);
  process.stdout.write(`gate: ${result.score.pass ? 'PASS' : 'FAIL'} (promote also needs 72 h and 30 labelled shadow rows of this prompt`
    + `${result.task === 'flag-owner-question' ? '' : ', and the owner\'s spot check'})\n`);
};

// The reshape gate on this run alone (story 23 AC 4): 100 replies, every one valid and preserved; the judge and 72 h follow.
const reshapeEvalText = (result) => {
  const kv = (o) => Object.entries(o || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  process.stdout.write(`reshape-question · prompt ${result.promptVersion} · ${result.model} · run ${result.runId} · ran ${boardTime(result.startedAt)} to ${boardTime(result.finishedAt)}\n`);
  if (result.refused) {
    process.stdout.write(`REFUSED: ${result.refused} — promote reads this as no evaluation\n`);
    return;
  }
  process.stdout.write(`replies ${result.replied}/${result.target} of ${result.candidates} held-out ids · non-replies ${result.nonReplies}`
    + ` · unresolved ${result.unresolved} · not reshapable ${result.unreshapable} · latency p50 ${result.latency.p50 ?? '—'} ms, p90 ${result.latency.p90 ?? '—'} ms\n`);
  process.stdout.write(`labels: ${kv(result.labels)} · outcomes: ${kv(result.outcomes)}\n`);
  const pass = result.replied >= result.target && result.clean === result.replied;
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} schema-valid and preservation-clean ${result.clean}/${result.replied} (needs ${result.target}/${result.target})\n`);
  process.stdout.write('promote also needs the judge (curator reshape-pairs, then curator judge-import: >= 95% same decision, same options) and 72 h of clean live replies\n');
};

const curatorEval = async (rest) => {
  const task = curatorTask(rest);
  const split = flagValue(rest, '--split') || (rest.includes('--all') ? 'all' : 'holdout');
  if (!CURATOR_SPLITS.includes(split)) die(`--split must be one of ${CURATOR_SPLITS.join(', ')}`);
  requireEnv();
  const { body: started } = await api('POST', '/api/cli/curator/eval', { task, split });
  if (rest.includes('--no-wait')) return out(started);
  const since = started.progress.startedAt;
  for (;;) {
    const { body } = await api('GET', `/api/cli/curator/eval?task=${encodeURIComponent(task)}&split=${split}`);
    if (body.progress && body.progress.error) fail('curator-unavailable', `evaluation failed: ${body.progress.error}`);
    if (body.progress && !body.progress.running && body.result && body.result.startedAt >= since) {
      if (rest.includes('--json')) return out(body.result);
      return task === 'reshape-question' ? reshapeEvalText(body.result) : curatorEvalText(body.result);
    }
    if (body.progress && process.stderr.isTTY) process.stderr.write(`\r${task}: ${body.progress.done}/${body.progress.total || '?'}`);
    await new Promise((resolve) => setTimeout(resolve, CURATOR_EVAL_POLL_MS));
  }
};

const curatorStatusText = (body) => {
  process.stdout.write(`curator ${body.model} · ${curatorHealthText(body.health)} · queued ${body.queued}`
    + `${body.rateLimitMs ? ` · ${body.rateLimitMs / 1000} s between calls (kodit rule)` : ''}\n`);
  printTable(['TASK', 'STATE', 'PROMPT', 'SHADOW ENDS', 'PROMOTED', 'LABEL QUEUE'], body.tasks.map((t) => [
    t.task, t.state, t.promptVersion, t.shadowEndsAt ? boardTime(t.shadowEndsAt) : 'no live call yet', t.promotedAt ? boardTime(t.promotedAt) : '—',
    t.queue && t.queue.size ? `${t.queue.size}, oldest ${boardTime(t.queue.oldestAt)}` : '0',
  ]));
  for (const t of body.tasks) {
    const gate = t.gate || {};
    process.stdout.write(`${t.task} gate:\n`);
    if (t.task === 'reshape-question') {
      for (const r of gate.refusals || []) process.stdout.write(`  FAIL ${r}\n`);
      if (!(gate.refusals || []).length) process.stdout.write('  PASS every condition\n');
      continue;
    }
    if (gate.checks) for (const check of gate.checks) process.stdout.write(`  pool ${curatorCheckText(check)}\n`);
    else process.stdout.write('  pool: no usable held-out evaluation of this prompt\n');
    for (const c of gate.shadow || []) process.stdout.write(`  shadow ${c.label} ${c.metric} ${c.successes}/${c.trials} (needs n >= 30, >= ${c.threshold.toFixed(2)}): ${c.pass ? 'PASS' : 'FAIL'}\n`);
  }
  const k = body.kodit;
  if (!k) process.stdout.write('kodit: not measured yet\n');
  else {
    const rate = (w) => (w && w.docsPerHour !== null ? `${w.docsPerHour.toFixed(0)} docs/h, ${w.summariesPerHour.toFixed(0)} summaries/h (${w.samples} samples)` : 'not measured');
    process.stdout.write(`kodit before: ${rate(k.before)}\nkodit after: ${k.after ? rate(k.after) : `waits for 72 h live (from ${body.liveSince ? boardTime(body.liveSince + 72 * 3600000) : '—'})`}`
      + `${k.drop === null ? '' : ` · change ${(-k.drop * 100).toFixed(1)}%`}\n`);
  }
  for (const e of body.evals || []) process.stdout.write(`eval ${e.task}: ${e.running ? `running ${e.done}/${e.total}` : e.error ? `failed: ${e.error}` : 'finished'}\n`);
};

const curatorSpotCheckOpen = async (rest) => {
  const wsId = missionWorkspace(rest);
  const task = curatorTask(rest, 'classify-owner-message');
  requireEnv();
  const { body: snapshot } = await api('GET', `/api/cli/mission-control?workspaceId=${encodeURIComponent(wsId)}`);
  const runs = missionBoundRuns(snapshot, wsId);
  const runId = flagValue(rest, '--run');
  const run = runId ? runs.find((r) => r.runId === runId) : runs.length === 1 ? runs[0] : null;
  if (!run) die(`--run must name one bound run of ${wsId}: ${runs.map((r) => r.runId).join(', ') || 'none is bound'}`);
  const { body: draft } = await api('POST', '/api/cli/curator/spot-check', { task, workspaceId: wsId });
  process.stderr.write(`drawn per class: ${Object.entries(draft.perClass).map(([k, v]) => `${k} ${v}`).join(', ')} · skipped as credential-like: ${draft.skippedSecret}\n`);
  // A new item is revision 0 (review r1 F1); the number map is recorded only once the item exists.
  const posted = await postAsk(spotCheckEvent({ draft, run, workspaceId: wsId, task, now: Date.now() }), wsId, false);
  const { body: committed } = await api('POST', '/api/cli/curator/spot-check', { task, workspaceId: wsId, commit: draft.itemId });
  return out({ posted, committed });
};

const curatorLabelImport = async (rest) => {
  const task = curatorTask(rest);
  const file = flagValue(rest, '--file');
  if (!file) die('--file is required: a JSON array of { "id", "label" }');
  let labels;
  try { labels = JSON.parse(require('fs').readFileSync(file, 'utf-8')); } catch (e) { die(`--file ${file}: ${e.message}`); }
  requireEnv();
  const { body } = await api('POST', '/api/cli/curator/label-import', { task, labels });
  return out(body);
};

const cmdCurator = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === 'status') {
    requireEnv();
    const { body } = await api('GET', '/api/cli/curator');
    if (rest.includes('--json')) return out(body);
    return curatorStatusText(body);
  }
  if (sub === 'eval') return curatorEval(rest);
  if (sub === 'label-queue') {
    const task = curatorTask(rest);
    requireEnv();
    const { body } = await api('POST', '/api/cli/curator/label-queue', { task });
    if (rest.includes('--json')) return out(body);
    process.stdout.write(`${task} · prompt ${body.promptVersion} · ${body.size} queued (${body.added} new)`
      + `${body.oldestAt ? ` · oldest ${boardTime(body.oldestAt)}` : ''}\n${body.ids.join('\n')}${body.ids.length ? '\n' : ''}`);
    return;
  }
  if (sub === 'label-import') return curatorLabelImport(rest);
  if (sub === 'reshape-pairs') {
    // The judge's input, one JSON document on stdout: nothing is written to disk (consult C2 (iii)).
    requireEnv();
    const { body } = await api('GET', '/api/cli/curator/reshape-pairs');
    return out(body);
  }
  if (sub === 'judge-import') {
    const file = flagValue(rest, '--file');
    if (!file) die('--file is required: { "runId", "verdicts": [{ "id", "sha", "verdict": "same" | "different" }] }');
    let doc;
    try { doc = JSON.parse(require('fs').readFileSync(file, 'utf-8')); } catch (e) { die(`--file ${file}: ${e.message}`); }
    requireEnv();
    const { body } = await api('POST', '/api/cli/curator/judge-import', { runId: doc.runId, verdicts: doc.verdicts, judge: flagValue(rest, '--judge') || doc.judge });
    return out(body);
  }
  if (sub === 'message') {
    const wsId = missionWorkspace(rest);
    const entryId = rest.filter((a, i) => !a.startsWith('-') && rest[i - 1] !== '-w' && rest[i - 1] !== '--workspace')[0];
    if (!entryId) die('usage: curator message -w WS ID');
    requireEnv();
    const { body } = await api('GET', `/api/cli/curator/message?workspaceId=${encodeURIComponent(wsId)}&entryId=${encodeURIComponent(entryId)}`);
    if (rest.includes('--json')) return out(body);
    process.stdout.write(`${body.workspaceId}/${body.entryId} at ${body.sentAt}:\n${body.message}\n`);
    return;
  }
  if (sub === 'promote' || sub === 'demote') {
    const task = curatorTask(rest);
    requireEnv();
    const { body } = await api('POST', '/api/cli/curator/promote', { task, ...(sub === 'demote' ? { demote: true } : {}) });
    if (rest.includes('--json')) return out(body);
    process.stdout.write(sub === 'demote' ? `${task}: shadow${body.wasRouting ? ' (was routing)' : ''}\n` : `${task}: routing (every gate condition met)\n`);
    return;
  }
  if (sub === 'spot-check') {
    const action = rest[0];
    if (action === 'open') return curatorSpotCheckOpen(rest.slice(1));
    if (action === 'show') {
      const task = curatorTask(rest.slice(1), 'classify-owner-message');
      requireEnv();
      const { body } = await api('GET', `/api/cli/curator/spot-check?task=${encodeURIComponent(task)}`);
      if (rest.includes('--json')) return out(body);
      const v = body.verdict;
      const text = v.state === 'answered' ? `answered: ${v.disputed.length} wrong of ${v.judged} judged (${(v.wrongShare * 100).toFixed(1)}%), ${v.unjudged.length} not judged`
        : v.state === 'unreadable' ? `answer unreadable: ${v.reason}` : 'unanswered';
      process.stdout.write(`spot check ${body.itemId ?? '(not opened)'}${body.workspaceId ? ` in ${body.workspaceId}` : ''}: ${text}\n`);
      return;
    }
  }
  die(CURATOR_USAGE);
};

const cmdLedgerShow = async (rest) => {
  const wsId = ledgerWorkspace(rest);
  const qs = new URLSearchParams();
  if (rest.includes('--open')) qs.set('open', '1');
  for (const name of ['type', 'holder']) {
    const value = flagValue(rest, `--${name}`);
    if (value !== null) qs.set(name, value);
  }
  requireEnv();
  const { body } = await api('GET', `${ledgerPath(wsId, 'items')}?${qs}`);
  if (rest.includes('--json')) return out(body);
  process.stdout.write(`ledger ${wsId}: ${body.items.length} items${body.truncated ? ' (more match; narrow with --open, --type or --holder)' : ''}\n`);
  printTable(['ITEM', 'TYPE', 'STATE', 'WAITING ON', 'FOR', 'HOLDER', 'CLOSED'], body.items.map((item) => [
    item.itemKey, item.itemType, dash(item.state), dash(item.waitReason),
    item.waitSince === null ? '—' : ledgerDuration(body.now - item.waitSince), dash(item.holder),
    item.closedAt === null ? '—' : new Date(item.closedAt).toISOString(),
  ]));
};

const cmdLedgerWaits = async (rest) => {
  const wsId = ledgerWorkspace(rest);
  const qs = new URLSearchParams();
  for (const name of ['since', 'until', 'by', 'type']) {
    const value = flagValue(rest, `--${name}`);
    if (value !== null) qs.set(name, value);
  }
  requireEnv();
  const { body } = await api('GET', `${ledgerPath(wsId, 'waits')}?${qs}`);
  if (rest.includes('--json')) return out(body);
  process.stdout.write(`waits ${wsId} ${new Date(body.since).toISOString()}..${new Date(body.until).toISOString()} by ${body.by}${body.type ? ` type ${body.type}` : ''}\n`);
  const line = (key, row) => [key, ledgerDuration(row.waitedMs), String(row.finished), ledgerDuration(row.p50Ms), ledgerDuration(row.p90Ms),
    String(row.openItems), ledgerDuration(row.openWaitedMs)];
  printTable(['KEY', 'WAITED', 'FINISHED', 'P50', 'P90', 'OPEN', 'OPEN-WAITED'],
    [...body.rows.map((row) => line(row.key === null ? '(no holder)' : row.key, row)), line('total', body.totals)]);
};

const cmdLedgerExperiment = async (sub, rest) => {
  const wsId = ledgerWorkspace(rest);
  if (sub === 'list') {
    requireEnv();
    const { body } = await api('GET', ledgerPath(wsId, 'experiments'));
    if (rest.includes('--json')) return out(body);
    printTable(['ID', 'STAGE', 'METRIC', 'STARTED', 'VERDICT', 'HYPOTHESIS'], body.experiments.map((e) => [
      e.id, e.stage, e.metric, new Date(e.startedAt).toISOString(),
      e.verdict ? `${e.verdict} ${new Date(e.verdictAt).toISOString()}` : e.extendedAt ? `active, extended +${e.extensionDays}d` : 'active', e.hypothesis,
    ]));
    return;
  }
  if (sub === 'open') {
    const experiment = await readJsonFlag(rest, 'experiment');
    requireEnv();
    const { body } = await api('POST', ledgerPath(wsId, 'experiments'), experiment);
    process.stdout.write(`opened ${body.experiment.id} (stage ${body.experiment.stage}, metric ${body.experiment.metric})\n`);
    return;
  }
  if (sub === 'close') {
    const positional = stripFlags(rest, ['-w', '--workspace', '--verdict', '--evidence']);
    const id = positional[0];
    if (!id || positional.length > 1) die(LEDGER_USAGE);
    const verdict = flagValue(rest, '--verdict');
    const evidence = flagValue(rest, '--evidence');
    if (!verdict || !evidence) die('--verdict keep|revert and --evidence TEXT are required');
    requireEnv();
    const { body } = await api('POST', ledgerPath(wsId, `experiments/${encodeURIComponent(id)}`), { verdict, evidence });
    process.stdout.write(`closed ${body.experiment.id}: ${body.experiment.verdict}\n`);
    return;
  }
  if (sub === 'extend') {
    const positional = stripFlags(rest, ['-w', '--workspace', '--days', '--evidence']);
    const id = positional[0];
    if (!id || positional.length > 1) die(LEDGER_USAGE);
    const daysText = flagValue(rest, '--days');
    const evidence = flagValue(rest, '--evidence');
    if (!daysText || !/^\d+$/.test(daysText) || !evidence) die('--days N (a whole number of days) and --evidence TEXT are required');
    requireEnv();
    const { body } = await api('POST', ledgerPath(wsId, `experiments/${encodeURIComponent(id)}/extend`), { days: Number(daysText), evidence });
    process.stdout.write(`extended ${body.experiment.id} by ${body.experiment.extensionDays} days: ends by day ${body.experiment.maxDays}\n`);
    return;
  }
  die(LEDGER_USAGE);
};

const cmdLedger = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'token':
      if (rest[0] !== 'issue') die(LEDGER_USAGE);
      return cmdLedgerTokenIssue(rest.slice(1));
    case 'emit': return cmdLedgerEmit(rest);
    case 'show': return cmdLedgerShow(rest);
    case 'waits': return cmdLedgerWaits(rest);
    case 'experiment': return cmdLedgerExperiment(rest[0], rest.slice(1));
    case 'experiments': return cmdLedgerExperiment('list', rest);
    default: die(LEDGER_USAGE);
  }
};

// ── events (ADR-0035) ────────────────────────────────────────────────────────
const EVENTS_USAGE = [
  'usage: events show -w WS [TAB] [--since T] [--limit N] [--json]',
  '       events wakes -w WS [--since T] [--until T] [--by-day] [--json]',
  'T is an age (90s, 15m, 1h, 7d), Unix ms or ISO-8601',
].join('\n');

const eventsPath = (wsId, route, qs) => `/api/cli/workspaces/${encodeURIComponent(wsId)}/events${route ? `/${route}` : ''}?${qs}`;

const EVENT_TEXT_CHARS = 120;
const firstLine = (text) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > EVENT_TEXT_CHARS ? `${line.slice(0, EVENT_TEXT_CHARS - 1)}…` : line;
};

const eventDelivery = (event) => {
  if (event.deliveredAt === null) return event.class === 'digest' ? 'waiting' : event.class === 'log' ? 'logged' : 'not delivered';
  return `${new Date(event.deliveredAt).toISOString().slice(11, 19)}Z${event.digestId ? ` ${event.digestId}` : ''}`;
};

const cmdEventsShow = async (rest) => {
  const wsId = ledgerWorkspace(rest);
  const positional = stripFlags(rest, ['-w', '--workspace', '--since', '--limit']).filter((arg) => arg !== '--json');
  if (positional.length > 1) die(EVENTS_USAGE);
  const qs = new URLSearchParams({ since: flagValue(rest, '--since') ?? '1h' });
  if (positional[0]) qs.set('tab', positional[0]);
  const limit = flagValue(rest, '--limit');
  if (limit !== null) qs.set('limit', limit);
  requireEnv();
  const { body } = await api('GET', eventsPath(wsId, '', qs));
  if (rest.includes('--json')) return out(body);
  process.stdout.write(`events ${wsId}${body.tabId ? ` ${body.tabId}` : ''} since ${new Date(body.since).toISOString()}: ${body.events.length}`
    + `${body.truncated ? ' (newest shown; older ones match: narrow --since or raise --limit)' : ''}\n`);
  const at = (event) => new Date(event.at).toISOString().slice(0, 19) + 'Z';
  if (body.tabId) {
    // One tab: every event whole, the text a digest points to (ADR-0035 §3).
    for (const event of body.events) {
      process.stdout.write(`\n${at(event)}  ${event.class}  ${event.kind}  ${eventDelivery(event)}\n`);
      process.stdout.write(`${event.text.split('\n').map((line) => `  ${line}`).join('\n')}\n`);
    }
    return;
  }
  printTable(['AT', 'TAB', 'CLASS', 'KIND', 'DELIVERED', 'TEXT'], body.events.map((event) => [
    at(event), event.tabId, event.class, event.kind, eventDelivery(event), firstLine(event.text),
  ]));
};

const cmdEventsWakes = async (rest) => {
  const wsId = ledgerWorkspace(rest);
  const qs = new URLSearchParams({ since: flagValue(rest, '--since') ?? '24h', by: rest.includes('--by-day') ? 'day' : 'window' });
  const until = flagValue(rest, '--until');
  if (until !== null) qs.set('until', until);
  requireEnv();
  const { body } = await api('GET', eventsPath(wsId, 'wakes', qs));
  if (rest.includes('--json')) return out(body);
  process.stdout.write(`wakes ${wsId} ${new Date(body.since).toISOString()}..${new Date(body.until).toISOString()}`
    + `${body.hasEvents ? '' : ' (no tab events recorded for this workspace)'}\n`);
  printTable(['TAB', ...(body.by === 'day' ? ['DAY'] : []), 'WAKES', 'DIGESTS', 'URGENT', 'LOGGED'], body.rows.map((row) => [
    row.tabId, ...(body.by === 'day' ? [row.day] : []), String(row.wakes), String(row.digests), String(row.urgent), String(row.logged),
  ]));
};

const cmdEvents = async (args) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'show': return cmdEventsShow(rest);
    case 'wakes': return cmdEventsWakes(rest);
    default: die(EVENTS_USAGE);
  }
};

// ── effects (story 15, ADR-0035 §7) ─────────────────────────────────────────
const EFFECTS_USAGE = 'usage: effects show [-w WS] [--days N] [--json]   (N: 1 to 30, default 7; WS defaults to $PMUX_WORKSPACE_ID)';

const effectCount = (value) => (value === null ? '—' : String(value));

const cmdEffectsShow = async (rest) => {
  const wsId = flagValue(rest, '--workspace') || flagValue(rest, '-w') || process.env.PMUX_WORKSPACE_ID;
  if (!wsId) die(`--workspace is required outside a tab\n${EFFECTS_USAGE}`);
  if (stripFlags(rest, ['-w', '--workspace', '--days']).filter((arg) => arg !== '--json').length) die(EFFECTS_USAGE);
  const qs = new URLSearchParams({ days: flagValue(rest, '--days') ?? '7' });
  requireEnv();
  const { body } = await api('GET', `/api/cli/workspaces/${encodeURIComponent(wsId)}/effects?${qs}`);
  if (rest.includes('--json')) return out(body);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const window = `${iso(body.requestedSince)}..${iso(body.until)}`;
  const counted = body.since === null
    ? (body.measuredSince === null ? 'nothing measured: no turn recorded yet' : `nothing measured: turns recorded from ${iso(body.measuredSince)}`)
    : body.since > body.requestedSince ? `counted from ${iso(body.since)}, the first recorded turn` : 'all of it counted';
  process.stdout.write(`effects ${wsId} ${window}: ${counted}\nsource: ${body.source}\n`);
  const measured = body.rows.filter((row) => row.notMeasured === null);
  const share = (row) => (row.judged ? `${Math.round((100 * row.followed) / row.judged)}%` : '—');
  if (measured.length) {
    const candidate = (row) => (row.candidate === null ? '—' : row.candidate ? 'yes' : 'no');
    printTable(['COMPONENT', 'FAMILY', 'FIRED', 'DELIVERED', 'IN-DIGEST', 'FOLLOWED', 'JUDGED', 'SHARE', 'NO-TURN', 'MID-TURN', 'PENDING',
      'CLOSED', 'UNMEASURED', 'CANDIDATE'], measured.map((row) => [row.component, row.family,
      ...['fired', 'delivered', 'inDigest', 'followed', 'judged'].map((key) => effectCount(row[key])), share(row),
      ...['noTurn', 'midTurn', 'pending', 'closed', 'unmeasured'].map((key) => effectCount(row[key])), candidate(row)]));
    process.stdout.write(`\nCANDIDATE yes: at least ${body.candidateMinObserved} deliveries with an observed turn, none followed; — is not measured (--json gives candidateReason). `
      + 'Delivered 0 is never a candidate: it means the component reached no tab, not that it never fired.\n');
  }
  const unmeasured = body.rows.filter((row) => row.notMeasured !== null);
  if (unmeasured.length) {
    process.stdout.write(`${measured.length ? '\n' : ''}not measured:\n`);
    printTable(['COMPONENT', 'FAMILY', 'WHY'], unmeasured.map((row) => [row.component, row.family, row.notMeasured]));
  }
};

const cmdEffects = async (args) => {
  if (args[0] !== 'show') die(EFFECTS_USAGE);
  return cmdEffectsShow(args.slice(1));
};

const cmdApiGuide = async () => {
  requireEnv();
  const guidePath = '/api/cli/api-guide';
  const resp = await apiRaw('GET', guidePath);
  process.stdout.write((await readBody('GET', guidePath, resp, 'text')) + '\n');
};

const flagValue = (args, name) => {
  const idx = args.indexOf(name);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
};

// Boolean flags carry no value, so stripFlags — which drops a flag AND the
// token after it — would eat the first word of the content.
const stripBooleanFlags = (args, names) => args.filter((arg) => !names.includes(arg));

const stripFlags = (args, names) => {
  const result = [];
  let i = 0;
  while (i < args.length) {
    if (names.includes(args[i])) {
      i += 2;
    } else {
      result.push(args[i]);
      i++;
    }
  }
  return result;
};

const usage = () => {
  process.stdout.write(`purplemux CLI

Usage: purplemux <command> [args...]

Commands:
  workspaces                               List workspaces
  workspace create -n NAME -d DIR [-d DIR...] [--json]
                                           Create a workspace as the web UI does (its first tab, its own agent
                                           homes); prints the new id (--json: id, name, directories, defaultTabId).
                                           Every DIR must exist (no mkdir). The first DIR is the primary (the cwd of
                                           new tabs); later DIRs are navigation shortcuts. A name another workspace holds (case-insensitive)
                                           exits 3 conflict. Admin token only: run it from a shell outside every
                                           tab, else exit 3 forbidden (a tab's own tokens never create workspaces)
  workspace dirs show -w WS                Show a workspace's directories
  workspace dirs set -w WS DIR [DIR...]    Repoint a workspace. The first DIR is the primary: it is the cwd for
                                           new tabs and keys the agent chat store, and must be unique across
                                           workspaces. Later DIRs are navigation shortcuts and may overlap.
                                           Paths are resolved against your cwd; existing tabs keep their old cwd
  workspace peers show -w WS               Show which workspaces may read WS
  workspace peers set -w WS [PEER...]      Removed: manage read grants through authenticated human controls
  tab list [-w WS]                         List tabs (only those your token may act on)
  tab create -w WS [-n NAME] [-t TYPE] [--scope GLOBS]
                                           Create a tab in workspace (type: terminal | claude-code | codex-cli | grok-cli | agent-sessions | web-browser | diff)
                                           --scope takes comma-separated path globs the tab should edit, e.g. --scope 'src/**,tests/**'
             [--reports-to TAB_ID]         Send this tab's watchdog nudges to TAB_ID (a live tab of the SAME
                                           workspace) instead of the workspace orchestrator; exit 2 otherwise
             [--report-on MARKERS]         Forward only the end lines that start with one of these markers
                                           (comma-separated: DONE, BLOCKED, NEEDS-DECISION, READY-TO-MERGE,
                                           CHECKPOINTED). A turn ending on another marker is recorded but nudges
                                           nobody. Default: every marker; exit 2 on an unknown name
             [--host HOST]                 Run the tab's tmux on HOST over ssh (ADR-0022): an ssh alias listed in
                                           fleet config remote.hosts. terminal and claude-code only; exit 2
                                           otherwise, exit 6 when HOST does not answer. The pane's purplemux
                                           reaches this server through PMUX_URL with the tab's own token.
                                           --host auto: the pool places it (ADR-0039, vel-D4): a claude-code tab
                                           with no role may go to the known host with the most free memory; every
                                           other tab runs here. A start that fits no host's budget QUEUES: the
                                           CLI prints "queued: TICKET position N of M — reason" when it changes
                                           and re-asks until the start is admitted or --wait SECONDS (default
                                           900; 0 answers at once) runs out (exit 3 pool-queued, the ticket on
                                           stdout; re-run with --ticket TICKET within 120 s to keep the place).
                                           A pool refusal is exit 3 pool-full. --class control-plane runs a
                                           coordinator here on the reserve, never queued, but only when the caller
                                           is the workspace's enabled orchestrator tab; any other caller runs as
                                           product ("downgrade" says why). Only a first ask the pool does not
                                           answer in 2 s creates the tab here; every other pool error creates
                                           nothing. The answer's "placement" says where and why
             [--cwd DIR]                   Start the tab in DIR, an absolute directory that must exist on the
                                           tab's host (cwd-missing, exit 2). A remote worker works in its own
                                           checkout or worktree on that host
             [--role evaluator --preview-url URL [--pg-service NAME]]
                                           A claude-code tab (implied when -t is omitted) that cannot change the
                                           repository (ADR-0040). Tools: Read, Grep, Glob, Bash and the
                                           chrome-devtools MCP (headless Chrome 149+, URL's origin only); Bash runs
                                           Claude Code's read-only commands (not docker, ps, pgrep, lsof, ss)
                                           and ~/.purplemux/bin/evaluator-sql, which queries the libpq service
                                           NAME (exported as PGSERVICE; the service's SELECT-only role is the
                                           guard);
                                           credential paths (~/.purplemux, ~/.ssh, *token*, ...) are unreadable;
                                           anything else is denied, never prompted. Every relaunch keeps it; never
                                           an orchestrator. Exit 2 without --preview-url (an http(s) URL on a
                                           plain host, not purplemux's own port), for another type, a remote
                                           host, an unknown role or a headless Chrome under 149
             [-m MODEL] [-r EFFORT]        Agent tabs auto-launch their CLI (hooks wired). -m sets the model; -r sets the
             [--no-launch]                 reasoning effort — claude-code: low|medium|high|xhigh|max (claude --effort;
                                           omitted = the user's global default, so orchestrators should ALWAYS pin it);
                                           grok-cli: none|minimal|low|medium|high|xhigh|max (grok --effort);
                                           codex: minimal|low|medium|high. --no-launch keeps the old bare-shell behavior.
             [--handoff PATH [--rotate-at N|off]]
                                           A seat (ADR-0036): at its context threshold (fleet config
                                           context.rotate-at-tokens, default 300000; --rotate-at 50000..900000 or
                                           off for this tab), idle with no background work, it is sent ROTATE; on
                                           HANDOFF-READY the file at PATH is checked and the tab restarts --clear
                                           with "Read PATH, then continue: <resume command>". Local tabs only
             [--over-cap --reason TEXT]    An agent tab is refused at the WIP cap (fleet config tabs.cap-per-workspace,
                                           default 8): exit 3 wip-cap. Only the workspace's verified, enabled
                                           orchestrator tab passes it, with a reason (1-500 characters, else exit 2)
                                           that is audited; any other caller exits 3 forbidden. The answer's
                                           "wip" is { count, cap, overCap } after the create
  tab count -w WS [--json]                 Print "<count> <cap>": WS's agent tabs (claude-code, codex-cli, grok-cli)
                                           and the WIP cap (tabs.cap-per-workspace.<WS> wins over the fleet value);
                                           --json adds workspaceId, capSource, overCap. Hooks use it
                                           instead of counting tmux sessions
  tab reports-to -w WS TAB_ID TARGET       Route TAB_ID's nudges to TARGET while TARGET is live; --clear
                  [--clear] [--on MARKERS] restores the workspace orchestrator. Cleared when TARGET closes.
                                           --on MARKERS (alone or with a target) forwards only those end lines,
                                           e.g. --on DONE,BLOCKED,NEEDS-DECISION; --on all lifts the filter
  tab steer -w WS TAB_ID CONTENT...        Send CONTENT as a mid-turn correction. From an agent tab (claude-code,
           [--interrupt --reason TEXT]     codex-cli, grok-cli) the default does NOT interrupt: the text waits for
           [--no-interrupt] [--raw]        the turn to end. --interrupt --reason TEXT stops the turn first (Escape);
           [-f FILE | -f -]                --interrupt without --reason exits 2. From any other caller, or one that
                                           names no tab, the default interrupts, as before. --no-interrupt is
                                           accepted from every caller. The agent/other split is advisory: every
                                           interrupt writes one steer-interrupt audit line (the record). Into a
                                           terminal tab, text with more than one line exits 2
                                           (terminal-not-command-line) unless --raw. Flags go before the content;
                                           every word from the content on is sent as is, and -- ends the flags
  tab send -w WS TAB_ID CONTENT...         Send input to a tab and press Enter. Waits up to 60s
                                           for an agent tab to be able to accept a turn; --wait-ms N (max
                                           240000) changes the budget, --no-wait answers immediately. On timeout nothing is
                                           pasted and the call exits 5 (readiness-timeout). An agent at a
                                           Claude Code startup prompt (folder trust, external imports) is
                                           refused at once with exit 5 (startup-prompt): answer the prompt.
                                           Exit 4 (tab-not-found, session-not-running, target-changed) means
                                           the tab is gone: never retry it, and never loop on it.
           [-f FILE | -f -]                Send file contents (or stdin with '-') — use for multi-line briefs
           [--raw]                         Into a terminal tab, text with more than one line exits 2
                                           (terminal-not-command-line): a shell runs each line as a command.
                                           --raw types the text as is (a heredoc). Flags go before the
                                           content; every word from the content on is sent as is, and --
                                           ends the flags
  tab status -w WS TAB_ID                  Tab status (includes registered probes + background jobs)
  tab result -w WS TAB_ID                  Capture tab pane content. Dim text the agent shows on its composer line
             [--no-suggestions | --raw]    (a suggestion, never typed) reads "[suggestion] <text>" and is also in
                                           "suggestion"; --no-suggestions drops it; --raw keeps every escape
  tab close -w WS TAB_ID                   Close a tab; prints ok only when the server confirms the close, then
             [--keep-processes]            every process it reaped: the pane's descendants and every process whose
                                           environment carries PMUX_TAB_ID=TAB_ID (SIGTERM, 3 s, SIGKILL).
                                           --keep-processes signals only the pane group, as before
  tab restart -w WS TAB_ID                 Restart the tab's agent as a fresh process under the SAME tab id (ADR-0028):
             [--clear] [--interrupt]       reap its processes, recreate its session, relaunch with its own model,
             [--json]                      effort, cwd, scope, reports-to and host. Leases, watches, probes, notes and
                                           its token stay. Resumes the agent's last session where the provider can
                                           (a remote tab restarts fresh); --clear starts a new session. A tab
                                           mid-turn exits 3 (tab-busy) unless --interrupt abandons the turn.
                                           Prints "ok TAB_ID restarted (resumed|fresh)". web-browser, diff and
                                           agent-sessions tabs exit 2 (restart-unsupported); a process or session
                                           left after the reap exits 1 (restart-not-confirmed), nothing relaunched
  tab probe set -w WS TAB_ID --cmd CMD --stale-after SECS
                                           Register a liveness probe on a tab's delegated work. The watchdog runs
             [--interval SECS] [--label L] CMD (default every 60s); its last non-empty stdout line must be only a
                                           finite, nonnegative numeric count of seconds since
                                           the work last progressed. Age > --stale-after fires a STALLED nudge to
                                           the orchestrator (or the tab itself) and a push alert to the human.
                                           3 consecutive probe failures fire a PROBE FAILING nudge — a broken
                                           probe is never a green light.
  tab probe list -w WS TAB_ID              Show a tab's probes with last age / staleness / failures
  tab probe clear -w WS TAB_ID [--label L] Remove probes (all, or one label) — do this when the job completes
  tab bg add -w WS TAB_ID --pid N          Watch a background pid. A strict integer from --exit-file classifies exit 0
             [--label L] [--stderr FILE]   as COMPLETED and nonzero as FAILED; missing or malformed status becomes
             [--exit-file FILE]            EXITED with unknown status after a short grace. Nudges include the stderr
             [--notify self|orchestrator]  tail when available. Verify completed artifacts; inspect unknown exits
                                           before deciding. Launch pattern: ( cmd 2>err.log; echo $? > exit.code ) &
                                           --notify self wakes TAB_ID itself (a worker on its own gate); the default
                                           wakes its reports-to tab, else the orchestrator. A live job also holds
                                           the tab's turn end as WAITING: no READY nudge until it exits
  tab bg list -w WS TAB_ID                 Show watched background jobs (pid, alive, age)
  tab bg remove -w WS TAB_ID [--pid N]     Stop watching (all, or one pid)
  tab browser url -w WS TAB_ID             Current URL + title of a web-browser tab
  tab browser screenshot -w WS TAB_ID      Capture tab screenshot (PNG). Use -o FILE to save, --full for full page
                          [-o FILE] [--full]
  tab browser console -w WS TAB_ID         Read recent console entries (ring buffer, 500 entries)
                          [--since MS] [--level LEVEL]
  tab browser network -w WS TAB_ID         Read recent network entries, or with --request ID to fetch body
                          [--since MS] [--method M] [--url SUBSTR] [--status CODE] [--request ID]
  tab browser eval -w WS TAB_ID EXPR       Evaluate JS expression inside the tab; returns serialized value
  orchestration status -w WS               Orchestration config + recent watchdog nudges for a workspace
  orchestration on -w WS [TAB_ID]          Enable orchestration; TAB_ID omitted = self-designate the calling tab
  orchestration recover -w WS TAB_ID       Recover to a live local agent only when the incumbent is positively absent
  orchestration handoff -w WS TAB_ID       Verified incumbent explicitly transfers ownership to a local agent
  orchestration off -w WS                  Disable only after fresh work evidence proves completion (all writes use revision CAS)
  standup report -w WS --json '{...}'      Post a standup tick (or pipe JSON on stdin). Shown in the sidebar so
                                           the human can read progress at a glance. Shape:
                                           {"state":"on-track|at-risk|blocked|awaiting-human|done","headline":"...",
                                            "items":[{"label":"...","status":"done|active|blocked|todo","note":"..."}],
                                            "blockers":[{"what":"...","needs":"..."}],"needsHuman":false,"next":["..."]}
  standup show -w WS                       Latest standup + history for a workspace
  burndown publish -w WS --json @FILE      Publish the Scrum Master burndown.json (or '{...}', or pipe JSON). Validated
                                           strictly; history keeps the newest 2000 rows. Shown on the portfolio board.
                                           Exit 2 invalid-burndown (names the field) or burndown-too-large (over 1 MiB)
  burndown show -w WS                      The latest published burndown for a workspace
  flow publish -w WS --json @FILE          Publish the workspace's pipeline snapshot: queues, locks, meters, flags
                                           (ADR-0026; or '{...}', or pipe JSON). Own workspace only. Prints
                                           ok <receivedAt> <historyRows>; the server keeps the history. Exit 2
                                           flow-invalid (names the field) or flow-too-large (over 1 MiB)
  flow show -w WS [--json]                 The latest flow: queues (length, capacity, oldest age), locks (holder,
            [--history all|window|none]    since), meters, producer flags, and "stale" after 10 min without a
                                           publish. No record: "no flow published", exit 7 (flow-not-found);
                                           a damaged record: exit 1 (flow-unreadable)
  spend show -w WS [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--by tab|day|model|role|seat|phase|item] [--json]
                                           Tokens (input, output, cache read and its share, cache creation, subagents)
                                           and the estimated cost ("est."; "—" when no price is known) per tab, UTC
                                           day, model, role, seat (tab name), phase or held ledger item, plus the
                                           unattributed row (by phase/item: one row per reason) and the total, with
                                           the cache reads' share of tokens and of the est. cost. Default: the last 7
                                           UTC days by tab; at most 92 days (7 by phase or item), none before
                                           today - 91 (exit 2). Role uses the current orchestrator. An unreadable
                                           spend index exits 1. Read scope on WS (ADR-0030)
  spend phases -w WS [--day YYYY-MM-DD] [--json]
                                           One UTC day (default today) by phase: wall time (distinct 5-min slots),
                                           tokens by kind, est. cost, and cache_read_tokens_per_landed_item (landed
                                           ranges) for the day and the 7 days ending on it ("—" with the reason when
                                           it is not measured).
                                           Read scope on WS (ADR-0030 amendment, harness-flow-loop 04)
  board show [-w WS] [--json|--line|--mine] The constraint finder's board (ADR-0034, refreshed every 60 s; -w
                                           defaults to PMUX_WORKSPACE_ID): the
                                           constraint (24 h, critical items first), its trend, owner and clear
                                           input; Mission Control's open items; stuck items oldest first; anomalies
                                           over threshold; each input's state. --line: goal, items left,
                                           constraint, trend on one line. --mine: only the items the calling tab
                                           holds (needs PMUX_TAB_TOKEN). Read scope on WS
  board pulse [-w WS] [--json]             Hourly movement, last 48 h (ADR-0034 §9): one mark per hour from
                                           ledger changes, commits, gates (pass/fail), review rounds, v2 LANDED
                                           lines and Mission Control answers; stalled / moving / steady / idle;
                                           priority now; each source's own state ("not measured", never 0).
                                           Read scope on WS
  board goal set -w WS --items KEY,KEY --label TEXT
                                           Set the goal the on-track line forecasts (p50/p90 from 3-day
                                           throughput, AEDT). Own workspace only. board goal show|clear -w WS
  ledger token issue -w WS --producer NAME [--out FILE]
                                           Issue a producer token (scope ledger:emit on WS only) into a 0600 file,
                                           default ~/.purplemux/ledger-tokens/WS/NAME.json; rotates NAME's token
  ledger emit -w WS --token-file FILE [--json @FILE|@-|JSON]
                                           Append work-item events (ADR-0033): one event, an array, a batch or JSON
                                           Lines. Drains ~/.purplemux/ledger-spool/NAME.jsonl first, in order; on a
                                           failure or no answer in 5 s it spools and exits 0. A refused event: exit 2
  ledger show -w WS [--open] [--type TYPE] [--holder H] [--json]
                                           Work items: state, the reason each waits on and for how long
  ledger waits -w WS [--since T] [--until T] [--by reason|holder|type|stage] [--type TYPE] [--json]
                                           Summed waits, p50 and p90 of finished waits, and open WIP per group.
                                           Default: the last 7 days by reason. T is Unix ms or ISO-8601
  ledger experiment open -w WS --json @FILE | close -w WS EXP-n --verdict keep|revert --evidence TEXT
  ledger experiment list -w WS [--json]    Improvement experiments (ADR-HFL-03): one active per stage, two in all
  ledger experiment extend -w WS EXP-n --days N --evidence TEXT
                                           Extend an active experiment once: max_days grows by N, at most to 90; a
                                           second extension is refused (exit 3, ledger-experiment-extended)
  handoff check PATH [--rotate-requested-at UTC] [--now UTC] [--json]
                                           Check a seat handoff file against the ADR-0036 schema (the checker the
                                           rotation runs): PASS exits 0; each refusal prints a line, exit 1
  events show -w WS [TAB] [--since T] [--limit N] [--json]
                                           What each tab was sent (ADR-0035), whole for one TAB, one line each for
                                           the workspace: urgent typed at once, digest held for
                                           the tab's next DIGEST, log recorded only. Default: the last hour.
                                           T is an age (15m, 1h, 7d), Unix ms or ISO-8601; kept 30 days
  events wakes -w WS [--since T] [--until T] [--by-day] [--json]
                                           Wakes and digests per tab: one delivery is one wake, a digest counts once.
                                           Default: the last 24 h
  effects show [-w WS] [--days N] [--json] Per nudge kind, probe kind and flag rule: firings recorded, delivery units (an
                                           urgent paste, or a digest counted once per component) and how many were
                                           followed: the recipient's next turn, started within 30 s of the paste, made an
                                           acting tool call (edit, write, shell). Followed is what came next, not what the
                                           delivery caused. Delivered 0 = never reached a tab, not never fired. A paste
                                           into a running turn, a pending or closed tab and an unrecorded turn are counted
                                           apart. CANDIDATE yes needs 10 deliveries with an observed turn and none
                                           followed; otherwise it is not measured. Turns are recorded from the first one after this release;
                                           an earlier window is clamped. Per-probe effect is not measured. Default: 7 days
  mission snapshot -w WS                   Read the workspace Mission Control snapshot
  mission events -w WS --json '{...}'      Submit an atomic batch of up to 25 producer events (or pipe JSON)
                                           attention.opened/updated accept class (money|irreversible|scope|bookkeeping) and defaultOptionId
  mission bootstrap -w WS                  Read the reconcile steps for this workspace's pending Mission Control bootstrap, and
                                           each open bound run with its revision, bound tab and binding generation
                                           (a handoff, recovery or replacement of the orchestrator moves the binding)
  mission answers -w WS [--run ID] [--all] Read unacknowledged answers for current answered items, each with its ackCommand; --all includes history
  mission ack -w WS --run ID --answer ID --generation N --revision N --event-id ID --producer-at MS
                                           Acknowledge one persisted answer after reading and applying it
  mc ask -w WS --json @DRAFT [--follows-up ID] [--fix]
                                           Check one attention.opened/attention.updated event's question against the
                                           server's format rules (ADR-0037), then post it. Defects print one per line
                                           (field: measured, limit) and exit 2 with nothing posted; lint on an accepted
                                           v1 question prints to stderr. --fix asks the curator to reshape a refused
                                           draft: where reshape-question routes, a reshape that keeps every option id,
                                           count, order, recommended, answerType, class and evidence URL is checked and
                                           posted (the original kept in question_json.source); elsewhere it is logged,
                                           the defects print and it exits 2. --follows-up ID (attention.opened only,
                                           ADR-0037 D2) links the new item to the answered item ID and resolves ID in
                                           the same write; it prints "follows up ID: the owner answered ..." and refuses
                                           an unanswered (exit 3), followed-up (exit 3), foreign (exit 3) or unknown
                                           (exit 7) target with nothing posted. "mc" is "mission".
  portfolio board --workspaces WS,WS       Scoped release blockers for the explicitly selected workspaces (current manager tab and read grants)
  portfolio report -w WS --json '{...}'    Current orchestrator reports a revisioned blocker; see API guide for schema
  portfolio applied -w WS --json '{...}'   Current orchestrator records application of a routed note, not blocker resolution
  portfolio resolved -w WS --json '{...}'  Current orchestrator records structured capacity clearance evidence
  lease acquire NAME [--ttl 45m|none] [--epic SLUG] [--note TEXT]
                                           Take a held-resource lease (<kind>:<resource>, e.g. merge:owner/repo,
                                           epic:SLUG, num:owner/repo:adr:0373). Exit 0 acquired or renewed,
                                           2 policy (TTL/epic/name), 3 refused: stderr code lease-held (another
                                           holds it; the holder is named) or forbidden / caller-unresolved
  lease renew NAME [--ttl 45m]             Move the expiry forward (holder only)
  lease release NAME                       Release a lease you hold. Exit 0, 3 held by another, 7 not held
  lease list [--prefix P] [--mine] [--json]
                                           Every lease on the host: holder, state, age, expiry, epic, note
  lease check NAME                         Exact name only. Prints {held, mine, lease}; exit 0 you hold it,
                                           3 another holds it, 7 nobody holds it. Exit 3 WITHOUT a body on
                                           stdout is a refusal (bad token), not a holder
  lease break NAME --reason TEXT           Remove another holder's lease (admin token only; audited)
  lease release-epic SLUG [--kind num]     Release an epic's survives-tab claims (run it while you still hold
                                           epic:SLUG; a tab of a claiming workspace releases its own claims)
  curator status [--json]                  The local curator (ADR-0038): up or down, queue, each task's state
                                           (shadow | routing), the shadow clock and the kodit measure
  curator eval --task T [--split holdout|train|all] [--no-wait] [--json]
                                           Evaluate a task (held-out 30% by default: counts only): precision and
                                           recall per class, each check's 95% lower bound, and the rules' scores
  curator promote|demote --task T          Move a task to routing (refused below the 95% lower bound, before 72 h
                                           and 30 labelled shadow rows of the live prompt, or without the owner's
                                           spot check) or back to shadow; admin
  curator label-queue --task T | label-import --task T --file F
                                           The blind label pass: queue the live prompt's shadow calls (ids only);
                                           import their gold labels (admin)
  curator spot-check open -w WS [--task T] [--run RUN] | spot-check show [--task T] [--json]
                                           Open the owner's spot check as one Mission Control item; read it
  curator reshape-pairs | judge-import --file F [--judge NAME]
                                           The reshape gate's judge (story 23): print the last evaluation's
                                           original and reshaped drafts with their sha256 to stdout (admin);
                                           import the verdicts, bound to that run and each sha256 (admin)
  owner messages -w WS [--since ISO] [--json]
                                           The owner's prompts of WS, oldest first: id, time (UTC), tab and
                                           text; a re-send keeps its first id; a tab reads its own workspace's
  curator message -w WS ID [--json]        One owner message by its history id (a standing-order candidate
                                           names the id, never the text); a tab reads its own workspace's
  pool show [--json]                       The compute pool (ADR-0039): per host threads, load, free memory, disk,
                                           GPU, kind counts, the one budget (workers, harness share, control-plane
                                           reserve) and the queue; an unknown host shows no figures, never 0
  pool acquire --kind K [--mem GB] [--threads N] [--class product|harness] [--queue [--wait S] | --ticket T]
             [--ttl 60m] [--panel-type T] [--role R]
                                           K: gate, build, mutation, browser, test-service or tab. Admit the work on
                                           the shared host budget (vel-D4) and take a slot lease: prints {host,
                                           local, slot, lease, expiresAt, reason, gateHost, class, envelope}. Jobs
                                           go by load per thread, then memory; tabs by memory. Harness work holds at
                                           most its share. Exit 3 pool-full with the measured and expected figures;
                                           --queue waits in the queue instead (as tab create --host auto), exit 3
                                           pool-queued when --wait runs out. Exit 6 when no answer comes in 2 s:
                                           do what you do without the pool and log it (gate.no-local-fallback
                                           repositories never run here). A gate passes --ttl of at least its gate
                                           timeout. Pass the envelope to systemd-run or docker where you can
  pool release LEASE|TICKET                Release a slot you hold (pool:<host>/<kind>-<n>) or give up a queue place
                                           (pool-queue:<kind>-<n>); a slot also ends with its TTL (default 60m, at
                                           most 24h) or its holder tab
  inbox list -w WS [--all]                 Server notices (notes, watches, deploys, Mission Control) queued or held
                                           for WS's tabs; --all adds delivered and dropped (kept 7 days)
  inbox retry ID                           Re-queue a held notice once (the target workspace, the note's sender, or admin).
                                           Exit 3 inbox-not-held, 7 inbox-not-found
  note send (--to-epic SLUG | --to-workspace WS) --subject TEXT (-f FILE | -f -) [--from-epic SLUG]
                                           A local note to the live epic holder, or a cross-workspace note between
                                           verified current orchestrators; body <= 16 KiB (exit 2). Only a fixed line is typed
                                           into the recipient; it pulls the body. --from-epic needs that epic lease (3).
                                           The owner-granted tab sends to any workspace as owner (to its orchestrator)
  note list [--open] [--to-me] [--from-me] [--epic SLUG]
                                           Notes your workspace sent or receives (no bodies; fromLabel names the sender,
                                           e.g. "owner (WS/TAB)"). Run --open --to-me at turn start
  note show ID                             The note and its body (recipient or sender workspace, or admin; else exit 3; 7 unknown)
  note ack ID [--comment TEXT]             Acknowledge a local note in your workspace, or a cross-workspace note as
                                           its verified currently routed coordinator (else exit 3)
  event send --type review-ready|landed|blocked-on --to-epic SLUG (--json PAYLOAD | -f FILE | -f -)
                                           A verified worker tab announces a result inside its scope (ADR-0043). The
                                           server checks the evidence, then delivers it as a note to the epic's
                                           recipient. Every payload: repo, branch, head, base, attempt; review-ready adds
                                           key, gateLog, reviewDir, receipt? (absent on a first hand-off); landed adds key,
                                           gateLog, target? (default main); blocked-on adds reason, clearInput. Exit 2
                                           event-invalid; 3
                                           event-refused (the failed checks), event-out-of-scope, event-stale,
                                           event-check-unavailable (a remote tab, or no PMUX_EVENT_PATCH_ID_CMD on the
                                           server); 5 event-no-recipient
  event scope set --tab TAB --epic SLUG [--story KEY] [--depends-on A,B] [--attempt N]
                                           The workspace's verified coordinator declares what TAB may announce: its
                                           served epic (held in this workspace) and the story's dependency epics
  event scope list | event scope clear --tab TAB
                                           The scopes of your workspace; clear is the coordinator's
  config get KEY                           Print a fleet config value bare (e.g. gate.slots); exit 7 when unset
  config list [--json]                     Every fleet config value with its version, time and setter
  config set KEY VALUE [--expect-version N]
                                           Set a value (admin token or the workspace's enabled orchestrator tab;
                                           else exit 3 forbidden). Nobody is messaged: tools read it at call time.
                                           A stale --expect-version exits 3 config-version-conflict
  config unset KEY [--expect-version N]    Remove a value (same authority); exit 7 when unset
  config history [KEY] [--json]            The last 200 changes: when, key, old -> new, version, who
  grant list [--json]                      Portfolio read grants held by or targeting your workspace (read-only; a human
                                           creates and revokes them in the web UI with the purplemux password).
                                           An owner grant shows capability: owner workspaces: * (it reads every
                                           workspace and sends notes as owner; the web dialog refuses a second
                                           active owner grant). One unreadable grant file: the other file's grants
                                           print, the refusal goes to stderr, exit 1
  deploy announce --in MINUTES --reason TEXT [--except-tab TAB_ID]... [--json]
                                           Tell every enabled orchestrator and tab-bound lease holder that purplemux
                                           restarts in 1-60 min (admin token or the deploy:purplemux holder; else
                                           exit 3). Only a fixed inbox line is typed; the reason is shown by status
  deploy status ID [--json]                The reason and, per recipient, delivery state and cliState (7 unknown)
  deploy withdraw ID                       Take back the notices still waiting once the deploy is over (announcer
                                           authority); deploy-live.sh does this when it finishes
  watch pr OWNER/REPO#N --until merged|closed|head-moved|checks-settled [--ttl 24h] [--interval 120] [--label TEXT]
  watch ref OWNER/REPO@REF --until moved   (same options)
  watch lease NAME --until free            A one-shot watch owned by this tab: the server checks it (GitHub every
                                           120 s by default, a lease on each release) and sends ONE inbox line when
                                           it holds, then clears it. Expires (default 24h, max 7d) with a notice;
                                           3 failures in a row send one failing notice. Host cap 60 GitHub watches
                                           (exit 3 watch-cap); 2 bad target/until; 7 unknown id on clear
  watch list [-w WS] [--json]              Watches of your workspace: owner tab (live/closed), age, expiry, last check,
                                           the last error text
  watch clear ID                           Remove a watch (its owner tab or admin)
  wait add --auth PROFILE [--item KEY] [--ttl 24h] [--label TEXT]
                                           Wait on the owner's AWS SSO sign-in: the server reads that profile's SSO
                                           cache file every 60 s (no aws process, DEC-261) and sends ONE inbox line
                                           when its token is valid; a ledger deploy-auth wait on KEY, or naming the
                                           profile in its clear input, clears then. 2 a profile that is not SSO
  so add (-w WS | --fleet) --text TEXT --source "MESSAGE ID, UTC DATE" [--scope S] [--check NAME|prose]
                                           Add a standing order SO-<n>: written into the workspace prompt file of
                                           every Claude tab it reaches, and one urgent line to each live tab. A
                                           fleet order needs the admin token. Over 8192 bytes of active orders for
                                           one workspace is refused with the measured size (exit 2 so-too-large)
  so propose --text TEXT --why TEXT [--cites TEXT] [--scope S] [--check NAME|prose]
                                           The selected portfolio manager only: open a Mission Control item (confirm,
                                           class scope, no default) for a fleet order; the owner's Yes files it as
                                           quoted, No or 72 h files nothing. 3 so-proposal-refused: duplicate,
                                           open-proposal or no-orchestrator-run
  so strike SO-N --reason TEXT             Strike an order; it stays in its file, struck, and live tabs are told
  so list [-w WS] [--all] [--json]         The active orders you load (--all: struck ones too), with their sources
  api-guide                                Print full HTTP API reference
  help                                     Show this usage

Mission event examples:
  Ordinary attention events create workspace candidates. Workers route blockers to the orchestrator; they do not open the human inbox directly.
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-open-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":0,"producerAt":1700000000001,"bindingGeneration":1,"type":"attention.opened","payload":{"itemId":"question-1","kind":"question","title":"Choose rollout","context":"Choose the production rollout strategy","storyIds":[],"options":[{"id":"gradual","label":"Gradual"}],"recommendation":"gradual","blockingScope":"story","canContinue":true}}]}'
  A producer may set class (money|irreversible|scope|bookkeeping) and defaultOptionId (one of the item's option IDs; refused on an action item); a producer that cannot name the class omits it, and money, irreversible and scope items are never auto-answered.
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-open-2","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":0,"producerAt":1700000000003,"bindingGeneration":1,"type":"attention.opened","payload":{"itemId":"question-2","kind":"question","title":"Record the release note","context":"Add the rollout to the release notes","storyIds":[],"options":[{"id":"gradual","label":"Gradual"},{"id":"direct","label":"Direct"}],"recommendation":"gradual","blockingScope":"none","canContinue":true,"class":"bookkeeping","defaultOptionId":"gradual"}}]}'
  The configured orchestrator may promote that same item only after checking existing authority and identifying the remaining human-exclusive need.
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-review-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":1,"producerAt":1700000000002,"bindingGeneration":1,"type":"attention.updated","payload":{"itemId":"question-1","kind":"question","title":"Choose rollout","context":"Choose the production rollout strategy","storyIds":[],"options":[{"id":"gradual","label":"Gradual"}],"recommendation":"gradual","blockingScope":"story","canContinue":true,"humanReview":{"humanNeed":"decision","humanReason":"Choose the acceptable product rollout risk.","handling":"Existing rollout guidance does not choose product risk tolerance.","reviewerTabId":"tab-orchestrator"}}}]}'
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-resolve-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":2,"producerAt":1700000000004,"bindingGeneration":1,"type":"attention.resolved","payload":{"itemId":"question-1","resolution":"Applied the gradual rollout"}}]}'

Exit codes:
  exit  meaning                                                      retry?
     0  success                                                      —
     1  unexpected error (unmapped code, 5xx, write outcome unknown)  investigate first
     2  usage error (bad or missing argument, or a usage code)       fix the command
     3  conflict: held by another holder, or refused by state        only after the state changes
     4  target gone: tab-not-found, session-not-running,             never
        target-changed
     5  not ready yet: readiness-timeout                             yes, bounded
     6  server unreachable (refused, no port, read interrupted)      yes, bounded
        routes-absent: 404 without JSON — no such route (an older    no, until the cause
        server, a foreign server, or a malformed id)                 is fixed
     7  not found: the named lease, note or watch does not exist     —
  stderr names the code and its class, e.g.
    error: tab-not-found (permanent — the tab is closed; do not retry) — Tab not found

Environment:
  PMUX_URL           Server base URL, e.g. http://mdserver1:8022 (a remote tab's CLI; wins over PMUX_PORT)
  PMUX_PORT          Server port (falls back to ~/.purplemux/port)
  PMUX_TAB_TOKEN     This tab's own token; names the calling tab (set in every tab created by the server)
  PMUX_TOKEN         This tab's workspace token (ignored while PMUX_TAB_TOKEN is set; unset that to override)
  PMUX_TAB_ID        This tab's id; the default TAB_ID of "orchestration on"
  PMUX_WORKSPACE_ID  This tab's workspace id
  Token order: PMUX_TAB_TOKEN > PMUX_TOKEN > the -w workspace's token on disk > ~/.purplemux/cli-token
`);
};

const main = async () => {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];
  const rest = args.slice(2);

  switch (cmd) {
    case 'workspaces':
      return cmdWorkspaces();
    case 'workspace':
      switch (sub) {
        case 'create': return cmdWorkspaceCreate(rest);
        case 'dirs': return cmdWorkspaceDirs(rest);
        case 'peers': return cmdWorkspacePeers(rest);
        default: die(`unknown workspace command: ${sub || '(none)'}. Run 'purplemux help' for usage.`);
      }
      break;
    case 'orchestration':
      return cmdOrchestration(args.slice(1));
    case 'standup':
      return cmdStandup(args.slice(1));
    case 'burndown':
      return cmdBurndown(args.slice(1));
    case 'flow':
      return cmdFlow(args.slice(1));
    case 'spend':
      return cmdSpend(args.slice(1));
    case 'board':
      return cmdBoard(args.slice(1));
    case 'ledger':
      return cmdLedger(args.slice(1));
    case 'events':
      return cmdEvents(args.slice(1));
    case 'effects':
      return cmdEffects(args.slice(1));
    case 'lease':
      return cmdLease(args.slice(1));
    case 'pool':
      return cmdPool(args.slice(1));
    case 'curator':
      return cmdCurator(args.slice(1));
    case 'mission':
    case 'mc':
      return cmdMission(args.slice(1));
    case 'portfolio':
      return cmdPortfolio(args.slice(1));
    case 'owner':
      return cmdOwner(args.slice(1));
    case 'inbox':
      return cmdInbox(args.slice(1));
    case 'note':
      return cmdNote(args.slice(1));
    case 'event':
      return cmdEvent(args.slice(1));
    case 'grant':
      return cmdGrant(args.slice(1));
    case 'config':
      return cmdConfig(args.slice(1));
    case 'deploy':
      return cmdDeploy(args.slice(1));
    case 'watch':
      return cmdWatch(args.slice(1));
    case 'handoff':
      return cmdHandoff(args.slice(1));
    case 'wait':
      return cmdWait(args.slice(1));
    case 'so':
      return cmdSo(args.slice(1));
    case 'tab':
      switch (sub) {
        case 'list': return cmdTabList(rest);
        case 'create': return cmdTabCreate(rest);
        case 'count': return cmdTabCount(rest);
        case 'send': return cmdTabSend(rest);
        case 'steer': return cmdTabSteer(rest);
        case 'status': return cmdTabStatus(rest);
        case 'result': return cmdTabResult(rest);
        case 'close': return cmdTabClose(rest);
        case 'restart': return cmdTabRestart(rest);
        case 'probe': return cmdTabProbe(rest);
        case 'bg': return cmdTabBg(rest);
        case 'reports-to': return cmdTabReportsTo(rest);
        case 'browser': return cmdTabBrowser(rest);
        default: die(`unknown tab command: ${sub || '(none)'}. Run 'purplemux help' for usage.`);
      }
      break;
    case 'api-guide':
      return cmdApiGuide();
    case 'help':
    case '-h':
    case '--help':
      return usage();
    default:
      die(`unknown command: ${cmd}. Run 'purplemux help' for usage.`);
  }
};

const run = () => main().catch((err) => {
  fail(null, err.message || String(err));
});

// bin/purplemux.js requires this file and calls run(); a remote tab's kit runs it directly
// (ADR-0022). A test requires it for CODE_EXIT, so loading it alone runs nothing.
if (require.main === module) run();

module.exports = { CODE_EXIT, run };
