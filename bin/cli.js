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
  'lease-policy': EXIT.USAGE,
  'watch-invalid': EXIT.USAGE,
  'reports-to-invalid': EXIT.USAGE,
  'remote-host-invalid': EXIT.USAGE,
  'remote-type-unsupported': EXIT.USAGE,
  'cwd-missing': EXIT.USAGE,
  'note-too-large': EXIT.USAGE,
  'deploy-invalid': EXIT.USAGE,
  'config-invalid': EXIT.USAGE,
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
  'tab-not-found': EXIT.GONE,
  'session-not-running': EXIT.GONE,
  'target-changed': EXIT.GONE,
  'readiness-timeout': EXIT.NOT_READY,
  'server-unreachable': EXIT.UNREACHABLE,
  'routes-absent': EXIT.UNREACHABLE,
  'remote-host-unreachable': EXIT.UNREACHABLE,
  'lease-not-found': EXIT.NOT_FOUND,
  'note-not-found': EXIT.NOT_FOUND,
  'watch-not-found': EXIT.NOT_FOUND,
  'inbox-not-found': EXIT.NOT_FOUND,
  'deploy-not-found': EXIT.NOT_FOUND,
  'config-not-found': EXIT.NOT_FOUND,
}));

// Where the class alone does not tell the caller what happened.
const CODE_HINT = Object.freeze(Object.assign(Object.create(null), {
  'tab-not-found': 'permanent — the tab is closed; do not retry',
  'session-not-running': "the tab's session is dead; do not retry — a person must restart the tab",
  'target-changed': 'permanent — the tab was replaced while the command waited; do not retry',
  'routes-absent': 'no such route on this server (an older server, a foreign server, or a malformed id) — retrying cannot help',
  'remote-host-unreachable': 'the remote host did not answer over ssh — retry, bounded, once it answers',
}));

const exitFor = (code) => (code && Object.hasOwn(CODE_EXIT, code) ? CODE_EXIT[code] : EXIT.UNEXPECTED);

const hintFor = (code, detail) => {
  if (code === 'readiness-timeout' && Number.isFinite(detail?.waitedMs)) {
    const state = detail.cliState ? `, cliState ${detail.cliState}` : '';
    return `not ready after ${detail.waitedMs} ms${state} — retry, bounded`;
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

const failFromResponse = (resp, body) => {
  if (!body || typeof body !== 'object') return fail(null, `HTTP ${resp.status}`);
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
  die('usage: mission snapshot|bootstrap|events|answers|ack -w WS [options]');
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
const CONFIG_KEY = /^[a-z][a-z0-9.-]{1,63}$/;

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

// Portfolio drive grants (ADR-0014): read-only here. A grant is created and revoked only in the
// web UI (a human session plus the purplemux password); no CLI token can do either.
const cmdGrant = async (args) => {
  if (args[0] !== 'list') die('usage: grant list [--json] (grants are created and revoked in the web UI only)');
  requireEnv();
  const { body } = await api('GET', '/api/cli/grants');
  if (args.includes('--json')) return out(body);
  const now = Date.now();
  const grants = Array.isArray(body.grants) ? body.grants : [];
  if (!grants.length) {
    process.stdout.write('no grants\n');
    return;
  }
  for (const g of grants) {
    const state = g.revokedAt !== null ? `ended (${g.revokeReason})` : g.expiresAt <= now ? 'expired' : `active until ${new Date(g.expiresAt).toISOString()}`;
    process.stdout.write(`${g.id}  ${g.grantee.workspaceId}/${g.grantee.tabId} reads ${g.workspaces.join(',')}  ${state}  "${g.reason}"\n`);
  }
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
  // The ssh alias of a registered remote host (ADR-0022); the tab's tmux runs there.
  const host = flagValue(args, '--host');
  // The tab's start directory: it must exist on the host the tab runs on.
  const cwd = flagValue(args, '--cwd');
  if (!wsId) die('--workspace is required');
  if (args.includes('--reports-to') && !reportsTo) die('--reports-to needs a tab id');
  if (args.includes('--host') && !host) die('--host needs a host name from fleet config remote.hosts');
  if (args.includes('--cwd') && !cwd) die('--cwd needs an absolute directory on the tab\'s host');
  const { body } = await api('POST', '/api/cli/tabs', {
    workspaceId: wsId,
    ...(name ? { name } : {}),
    ...(panelType ? { panelType } : {}),
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(noLaunch ? { launch: false } : {}),
    ...(scope && scope.length ? { scope } : {}),
    ...(reportsTo ? { reportsTo } : {}),
    ...(host ? { host } : {}),
    ...(cwd ? { cwd } : {}),
  });
  out(body);
};

const cmdTabReportsTo = async (args) => {
  requireEnv();
  const clear = args.includes('--clear');
  const rest = stripBooleanFlags(stripFlags(args, ['--workspace', '-w']), ['--clear']);
  const [tabId, target] = rest;
  if (!tabId || (clear ? target : !target)) die('usage: tab reports-to -w WS TAB_ID (TARGET_TAB_ID | --clear)');
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'PATCH',
    `/api/cli/tabs/${tabId}?workspaceId=${encodeURIComponent(wsId)}`,
    { reportsTo: clear ? null : target },
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

// Same shape as tab send, but interrupts the current turn first so a busy
// worker reads the correction now instead of after its tangent finishes.
const cmdTabSteer = async (args) => {
  requireEnv();
  const file = flagValue(args, '--file') || flagValue(args, '-f');
  const noInterrupt = args.includes('--no-interrupt');
  const rest = stripBooleanFlags(stripFlags(args, ['--workspace', '-w', '--file', '-f']), ['--no-interrupt']);
  const tabId = rest[0];
  let content = rest.slice(1).join(' ');
  if (!tabId) die('tab ID is required');
  if (file) {
    content = file === '-' ? await readStdin() : require('fs').readFileSync(file, 'utf8');
  }
  if (!content) die('content is required (args, -f FILE, or -f - for stdin)');
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'POST',
    `/api/cli/tabs/${tabId}/steer?workspaceId=${encodeURIComponent(wsId)}`,
    { content, ...(noInterrupt ? { interrupt: false } : {}) },
  );
  out(body);
};

// The send waits for the target to reach a state that can accept a turn. An
// agent TUI that is still booting swallows the Enter after the paste, so a
// send that does not wait can report success over an agent that never starts.
const MAX_CLI_WAIT_MS = 240_000;

const cmdTabSend = async (args) => {
  requireEnv();
  const file = flagValue(args, '--file') || flagValue(args, '-f');
  const waitMs = flagValue(args, '--wait-ms');
  const noWait = args.includes('--no-wait');
  const rest = stripBooleanFlags(
    stripFlags(args, ['--workspace', '-w', '--file', '-f', '--wait-ms']),
    ['--no-wait'],
  );
  const tabId = rest[0];
  let content = rest.slice(1).join(' ');
  if (!tabId) die('tab ID is required');
  if (file) {
    content = file === '-' ? await readStdin() : require('fs').readFileSync(file, 'utf8');
  }
  if (!content) die('content is required (args, -f FILE, or -f - for stdin)');
  const waitMsGiven = args.includes('--wait-ms');
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
  const wsId = resolveWsForTab(args);
  const { body } = await api(
    'POST',
    `/api/cli/tabs/${tabId}/send?workspaceId=${encodeURIComponent(wsId)}`,
    { content, ...(noWait ? { waitMs: 0 } : waitMs ? { waitMs: Number(waitMs) } : {}) },
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
             [--host HOST]                 Run the tab's tmux on HOST over ssh (ADR-0022): an ssh alias listed in
                                           fleet config remote.hosts. terminal and claude-code only; exit 2
                                           otherwise, exit 6 when HOST does not answer. The pane's purplemux
                                           reaches this server through PMUX_URL with the tab's own token
             [--cwd DIR]                   Start the tab in DIR, an absolute directory that must exist on the
                                           tab's host (cwd-missing, exit 2). A remote worker works in its own
                                           checkout or worktree on that host
             [-m MODEL] [-r EFFORT]        Agent tabs auto-launch their CLI (hooks wired). -m sets the model; -r sets the
             [--no-launch]                 reasoning effort — claude-code: low|medium|high|xhigh|max (claude --effort;
                                           omitted = the user's global default, so orchestrators should ALWAYS pin it);
                                           grok-cli: none|minimal|low|medium|high|xhigh|max (grok --effort);
                                           codex: minimal|low|medium|high. --no-launch keeps the old bare-shell behavior.
  tab reports-to -w WS TAB_ID TARGET       Route TAB_ID's nudges to TARGET while TARGET is live; --clear
                  [--clear]                restores the workspace orchestrator. Cleared when TARGET closes
  tab steer -w WS TAB_ID CONTENT...        Interrupt the current turn, then send CONTENT (use for a mid-turn correction; --no-interrupt to queue instead)
  tab send -w WS TAB_ID CONTENT...         Send input to a tab and press Enter. Waits up to 60s
                                           for an agent tab to be able to accept a turn; --wait-ms N (max
                                           240000) changes the budget, --no-wait answers immediately. On timeout nothing is
                                           pasted and the call exits 5 (readiness-timeout).
                                           Exit 4 (tab-not-found, session-not-running, target-changed) means
                                           the tab is gone: never retry it, and never loop on it.
           [-f FILE | -f -]                Send file contents (or stdin with '-') — use for multi-line briefs
  tab status -w WS TAB_ID                  Tab status (includes registered probes + background jobs)
  tab result -w WS TAB_ID                  Capture tab pane content. Dim text the agent shows on its composer line
             [--no-suggestions | --raw]    (a suggestion, never typed) reads "[suggestion] <text>" and is also in
                                           "suggestion"; --no-suggestions drops it; --raw keeps every escape
  tab close -w WS TAB_ID                   Close a tab; prints ok only when the server confirms the close, then
             [--keep-processes]            every process it reaped: the pane's descendants and every process whose
                                           environment carries PMUX_TAB_ID=TAB_ID (SIGTERM, 3 s, SIGKILL).
                                           --keep-processes signals only the pane group, as before
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
                                           strictly; history keeps the newest 2000 rows. Shown on the portfolio board
  burndown show -w WS                      The latest published burndown for a workspace
  mission snapshot -w WS                   Read the workspace Mission Control snapshot
  mission events -w WS --json '{...}'      Submit an atomic batch of up to 25 producer events (or pipe JSON)
  mission bootstrap -w WS                  Read the reconcile steps for this workspace's pending Mission Control bootstrap, and
                                           each open bound run with its revision, bound tab and binding generation
                                           (a handoff, recovery or replacement of the orchestrator moves the binding)
  mission answers -w WS [--run ID] [--all] Read unacknowledged answers for current answered items, each with its ackCommand; --all includes history
  mission ack -w WS --run ID --answer ID --generation N --revision N --event-id ID --producer-at MS
                                           Acknowledge one persisted answer after reading and applying it
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
  inbox list -w WS [--all]                 Server notices (notes, watches, deploys, Mission Control) queued or held
                                           for WS's tabs; --all adds delivered and dropped (kept 7 days)
  inbox retry ID                           Re-queue a held notice once (the target workspace, the note's sender, or admin).
                                           Exit 3 inbox-not-held, 7 inbox-not-found
  note send (--to-epic SLUG | --to-workspace WS) --subject TEXT (-f FILE | -f -) [--from-epic SLUG]
                                           A local note to the live epic holder, or a cross-workspace note between
                                           verified current orchestrators; body <= 16 KiB (exit 2). Only a fixed line is typed
                                           into the recipient; it pulls the body. --from-epic needs that epic lease (3)
  note list [--open] [--to-me] [--from-me] [--epic SLUG]
                                           Notes your workspace sent or receives (no bodies). Run --open --to-me at turn start
  note show ID                             The note and its body (recipient or sender workspace, or admin; else exit 3; 7 unknown)
  note ack ID [--comment TEXT]             Acknowledge a local note in your workspace, or a cross-workspace note as
                                           its verified currently routed coordinator (else exit 3)
  config get KEY                           Print a fleet config value bare (e.g. gate.slots); exit 7 when unset
  config list [--json]                     Every fleet config value with its version, time and setter
  config set KEY VALUE [--expect-version N]
                                           Set a value (admin token or the workspace's enabled orchestrator tab;
                                           else exit 3 forbidden). Nobody is messaged: tools read it at call time.
                                           A stale --expect-version exits 3 config-version-conflict
  config unset KEY [--expect-version N]    Remove a value (same authority); exit 7 when unset
  config history [KEY] [--json]            The last 200 changes: when, key, old -> new, version, who
  grant list [--json]                      Portfolio read grants held by or targeting your workspace (read-only; a human
                                           creates and revokes them in the web UI with the purplemux password)
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
  api-guide                                Print full HTTP API reference
  help                                     Show this usage

Mission event examples:
  Ordinary attention events create workspace candidates. Workers route blockers to the orchestrator; they do not open the human inbox directly.
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-open-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":0,"producerAt":1700000000001,"bindingGeneration":1,"type":"attention.opened","payload":{"itemId":"question-1","kind":"question","title":"Choose rollout","context":"Choose the production rollout strategy","storyIds":[],"options":[{"id":"gradual","label":"Gradual"}],"recommendation":"gradual","blockingScope":"story","canContinue":true}}]}'
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
    case 'lease':
      return cmdLease(args.slice(1));
    case 'mission':
      return cmdMission(args.slice(1));
    case 'portfolio':
      return cmdPortfolio(args.slice(1));
    case 'inbox':
      return cmdInbox(args.slice(1));
    case 'note':
      return cmdNote(args.slice(1));
    case 'grant':
      return cmdGrant(args.slice(1));
    case 'config':
      return cmdConfig(args.slice(1));
    case 'deploy':
      return cmdDeploy(args.slice(1));
    case 'watch':
      return cmdWatch(args.slice(1));
    case 'tab':
      switch (sub) {
        case 'list': return cmdTabList(rest);
        case 'create': return cmdTabCreate(rest);
        case 'send': return cmdTabSend(rest);
        case 'steer': return cmdTabSteer(rest);
        case 'status': return cmdTabStatus(rest);
        case 'result': return cmdTabResult(rest);
        case 'close': return cmdTabClose(rest);
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

main().catch((err) => {
  fail(null, err.message || String(err));
});
