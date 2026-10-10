import fs from 'fs/promises';
import { STATUSLINE_SCRIPT_CONTENT } from '@/lib/statusline-script';

/**
 * The hook scripts the server installs into `~/.purplemux/`. Pure: no logger,
 * no server state, so `scripts/install-hook-scripts.ts` can render a release's
 * scripts before that release's server starts (ADR-0020).
 *
 * Next routes import this module, so Turbopack traces every file operation in
 * it. The directory installer (`path.join(dir, name)` over the script list)
 * was a path the trace could not scope, and it took the whole project into
 * `.next/standalone`; it lives in `hook-scripts-install.ts`. Not every
 * argument-built path does this (hook-spool.ts and hook-floors.ts build some and
 * trace cleanly): the guard is `scripts/post-build.js`, which refuses a
 * whole-project standalone tree whatever caused it.
 */

export const HOOK_SPOOL_DIRNAME = 'hook-spool';
/** A body longer than this (a Write's content, a long Bash output) is spooled as metadata only. */
export const HOOK_SPOOL_MAX_BODY = 256 * 1024;
/**
 * The most one hook POST may take, connect included. A hook runs on the agent's critical
 * path: Codex waits for it on every tool call, with no timeout of its own, and Claude kills
 * a hook at `CLAUDE_HOOK_TIMEOUT_SECONDS`. Measured 2026-09-29, an unbounded POST held every
 * Codex tool call for minutes. The bound stays under Claude's timeout with room for the
 * script's own start-up, so a stalled server ends in curl's timeout, not Claude's kill. The
 * POST stays synchronous because the server applies live events in arrival order; a detached
 * PostToolUse could land after the Stop and mark a finished turn busy again.
 */
export const HOOK_MAX_TIME_SECONDS = 2;
/** The `timeout` hook-settings.ts gives Claude's hooks (post-tool: 2). */
export const CLAUDE_HOOK_TIMEOUT_SECONDS = 3;
/**
 * Bound on a `tmux display-message` in a hook: a wedged tmux server must not stall the agent
 * either. When it fires, SESSION is empty and the event is lost (the route needs a session), so
 * it sits far above a slow answer: measured 2026-09-29 at load 137, median 8 ms, p90 29 ms, max
 * 107 ms over 40 calls. It cannot grow much: tmux plus the POST must fit Claude's 3 s timeout.
 */
export const HOOK_TMUX_TIMEOUT_SECONDS = 1;

/**
 * Shared shell functions. `post_hook TARGET BODY [curl options]` POSTs one
 * event; when no server answers — no port file, a refused or timed-out
 * connect, or a 5xx — the event goes to `hook-spool/` as one JSON file, written
 * to a dot-named temporary and renamed, which the next server replays in time
 * order. A server that answered (2xx-4xx), or a timeout after the connect, is
 * never spooled: the server may have applied it. So is a connection the
 * server cut while it exited (curl 52/56): it may have applied the event, and a
 * replay would repeat it on a tab whose floor that server never persisted.
 * Only purplemux sessions (`pt-*`) spool, because the Codex hook is global and
 * also fires outside purplemux. `SPOOL_SKIP_EVENT` names a hook event never
 * spooled: Codex PreToolUse, one per tool call. It is not stateless (the receiver maps it to
 * prompt-submit and applies its session metadata, hook-payload.ts), but the PostToolUse that
 * follows each one carries the same transition and metadata and IS spooled, so a replay of the
 * PreToolUse adds nothing. A
 * body over `HOOK_SPOOL_MAX_BODY` is spooled as metadata only (`body: null`,
 * `bodyDropped`, `bodyLength`). Nothing retries: the hook stays one round trip,
 * bounded by `HOOK_MAX_TIME_SECONDS`. The token reaches curl on fd 3 from a
 * here-document, never on its command line: `/proc/<pid>/cmdline` is readable
 * by every process of the user, and a reap audit records a process's args
 * (ADR-0022 review r3).
 */
const SPOOL_FUNCTIONS = `json_escape() {
  printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'
}

spool_hook() {
  [ "\${EVENT:-}" = "poll" ] && return 0
  case "$SESSION" in pt-*) ;; *) return 0 ;; esac
  if [ -n "\${SPOOL_SKIP_EVENT:-}" ] \\
    && printf '%s' "$2" | grep -q "\\"hook_event_name\\"[[:space:]]*:[[:space:]]*\\"\${SPOOL_SKIP_EVENT}\\""; then
    return 0
  fi
  SPOOL_BODY="\${2:-null}"
  SPOOL_META=""
  if [ \${#SPOOL_BODY} -gt ${HOOK_SPOOL_MAX_BODY} ]; then
    SPOOL_META=",\\"bodyDropped\\":true,\\"bodyLength\\":\${#SPOOL_BODY}"
    SPOOL_BODY="null"
  fi
  SPOOL_DIR="\${HOOK_SPOOL_DIR:-$HOME/.purplemux/${HOOK_SPOOL_DIRNAME}}"
  mkdir -p -m 700 "$SPOOL_DIR" 2>/dev/null || return 0
  SPOOL_RAND=$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \\n')
  SPOOL_NAME="\${AT}-$$-\${SPOOL_RAND:-0}"
  SPOOL_TMP="$SPOOL_DIR/.\${SPOOL_NAME}.tmp"
  if { printf '{"v":1,"at":%s,"session":"%s","query":"%s"%s,"body":' "$AT" "$(json_escape "$SESSION")" "$(json_escape "$1")" "$SPOOL_META"
       printf '%s' "$SPOOL_BODY"
       printf '}\\n'; } > "$SPOOL_TMP" 2>/dev/null; then
    mv -f "$SPOOL_TMP" "$SPOOL_DIR/\${SPOOL_NAME}.json" 2>/dev/null || rm -f "$SPOOL_TMP"
  else
    rm -f "$SPOOL_TMP"
  fi
  return 0
}

post_hook() {
  case "$1" in *\\?*) HOOK_TARGET="$1&occurredAt=$AT" ;; *) HOOK_TARGET="$1?occurredAt=$AT" ;; esac
  HOOK_BODY="$2"
  shift 2
  case "$HOOK_TARGET" in *\\?*) HOOK_QUERY="\${HOOK_TARGET#*\\?}" ;; *) HOOK_QUERY="" ;; esac
  if [ -z "\${HOOK_BASE_URL:-$PORT}" ] || [ -z "$TOKEN" ]; then
    spool_hook "$HOOK_QUERY" "$HOOK_BODY"
    return 0
  fi
  HOOK_RESULT=$(printf '%s' "$HOOK_BODY" | curl -s -X POST -o /dev/null -w '%{http_code} %{time_connect}' \\
    --connect-timeout 1 --max-time ${HOOK_MAX_TIME_SECONDS} "$@" -H 'Content-Type: application/json' -H @/dev/fd/3 \\
    --data-binary @- "\${HOOK_BASE_URL:-http://localhost:\${PORT}}\${HOOK_TARGET}" 2>/dev/null 3<<HOOK_HEADERS
x-pmux-token: \${TOKEN}
HOOK_HEADERS
)
  HOOK_RC=$?
  HOOK_HTTP="\${HOOK_RESULT%% *}"
  case "$HOOK_RC:$HOOK_HTTP" in
    7:*|*:5[0-9][0-9]) spool_hook "$HOOK_QUERY" "$HOOK_BODY" ;;
    28:*) case "\${HOOK_RESULT#* }" in *[1-9]*) ;; *) spool_hook "$HOOK_QUERY" "$HOOK_BODY" ;; esac ;;
  esac
  return 0
}`;

/**
 * The prologue every script shares. The event time is taken first, so a
 * spooled event carries when it happened, not when the POST gave up. It is
 * `%s%N` cut to milliseconds, never `%3N`: uutils `date` (Ubuntu 26.04)
 * prints `%3N` as untruncated, unpadded nanoseconds. A `date` without `%N`
 * (BSD) falls back to whole seconds.
 */
const PROLOGUE = `PORT_FILE="$HOME/.purplemux/port"
TOKEN_FILE="$HOME/.purplemux/cli-token"
AT=$(date +%s%N 2>/dev/null)
case "$AT" in *[!0-9]*) AT="" ;; esac
if [ \${#AT} -eq 19 ]; then AT="\${AT%??????}"; else AT=$(( $(date +%s) * 1000 )); fi
PORT=""
TOKEN=""
SPOOL_SKIP_EVENT=""
HOOK_SPOOL_DIR=""
HOOK_BASE_URL=""
[ -f "$PORT_FILE" ] && PORT=$(cat "$PORT_FILE")
[ -f "$TOKEN_FILE" ] && TOKEN=$(cat "$TOKEN_FILE")
# \`timeout\` bounds tmux where coreutils has it (Linux); elsewhere tmux runs unbounded, as before.
HOOK_TIMEOUT=""
command -v timeout >/dev/null 2>&1 && HOOK_TIMEOUT="timeout ${HOOK_TMUX_TIMEOUT_SECONDS}"
SESSION=$($HOOK_TIMEOUT tmux display-message -p '#{session_name}' 2>/dev/null) || SESSION=""`;

export const HOOK_SCRIPT_CONTENT = `#!/bin/sh
EVENT="\${1:-poll}"
${PROLOGUE}

${SPOOL_FUNCTIONS}

# Tool activity feeds the signal engine, not the work-state machine. Forward the
# raw hook JSON so the server parses it — sed cannot survive a command string
# containing quotes. Detached, because this fires on every mutating tool call
# and no edit should wait on the round trip.
if [ "$EVENT" = "post-tool" ]; then
  BODY=$(cat)
  [ -n "$BODY" ] || exit 0
  # The background job drops the caller's stdin/stdout/stderr for good: a job that still held
  # them kept Claude waiting for its whole POST (measured 2 s against a stalled server).
  ( exec </dev/null >/dev/null 2>&1; post_hook "/api/status/hook?kind=tool&session=\${SESSION}" "$BODY" ) &
  exit 0
fi

NOTIFICATION_TYPE=""
if [ "$EVENT" = "notification" ]; then
  NOTIFICATION_TYPE=$(sed -n 's/.*"notification_type"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
fi

# SessionStart names why the session (re)started; after an auto-compaction it is
# "compact", which is not a turn end (L30). Only a plain word is forwarded.
SOURCE=""
if [ "$EVENT" = "session-start" ]; then
  SOURCE=$(sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\\([a-z]*\\)".*/\\1/p' | head -n 1)
fi

PAYLOAD="{\\"event\\":\\"\${EVENT}\\",\\"session\\":\\"\${SESSION}\\""
if [ -n "$NOTIFICATION_TYPE" ]; then
  PAYLOAD="\${PAYLOAD},\\"notificationType\\":\\"\${NOTIFICATION_TYPE}\\""
fi
if [ -n "$SOURCE" ]; then
  PAYLOAD="\${PAYLOAD},\\"source\\":\\"\${SOURCE}\\""
fi
PAYLOAD="\${PAYLOAD}}"

post_hook "/api/status/hook" "$PAYLOAD"

# A tab created before tab tokens has no PMUX_TAB_ID (story 36). At a session
# start, Claude hands this hook a file whose exports reach every later Bash
# command; ask for the tab's hook-time identity with the pane's own workspace
# token and the exact pane's session, and write it there. Never verified.
if [ "$EVENT" = "session-start" ] && [ -n "$PORT" ] && [ -z "\${PMUX_TAB_ID:-}" ] && [ -n "\${PMUX_TOKEN:-}" ] \\
  && [ -n "\${CLAUDE_ENV_FILE:-}" ] && [ -n "\${TMUX_PANE:-}" ]; then
  PANE_SESSION=$($HOOK_TIMEOUT tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null) || PANE_SESSION=""
  if [ -n "$PANE_SESSION" ]; then
    IDENT=$(curl -s --max-time 2 -X POST -H 'Content-Type: application/json' -H @/dev/fd/3 \\
      -d "{\\"session\\":\\"\${PANE_SESSION}\\"}" "http://localhost:\${PORT}/api/cli/tab-identity" 2>/dev/null 3<<HOOK_HEADERS
x-pmux-token: \${PMUX_TOKEN}
HOOK_HEADERS
)
    ID_TAB=$(printf '%s' "$IDENT" | sed -n 's/.*"tabId"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]*\\)".*/\\1/p')
    ID_WS=$(printf '%s' "$IDENT" | sed -n 's/.*"workspaceId"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9_-]*\\)".*/\\1/p')
    ID_TOKEN=$(printf '%s' "$IDENT" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\\([0-9a-f]\\{64\\}\\)".*/\\1/p')
    if [ -n "$ID_TAB" ] && [ -n "$ID_WS" ] && [ -n "$ID_TOKEN" ]; then
      # Guarded: a session the server recreates carries its own launch identity, which wins
      # over a stale env file sourced again on resume.
      printf '[ -n "\${PMUX_TAB_ID:-}" ] || { export PMUX_TAB_ID=%s; export PMUX_WORKSPACE_ID=%s; export PMUX_TAB_TOKEN=%s; }\\n' "$ID_TAB" "$ID_WS" "$ID_TOKEN" >> "$CLAUDE_ENV_FILE"
    fi
  fi
fi
exit 0
`;

export const CODEX_HOOK_SCRIPT_CONTENT = `#!/usr/bin/env bash
set -u
${PROLOGUE}
GENERATION="\${PURPLEMUX_CODEX_GENERATION:-}"
SPOOL_SKIP_EVENT="PreToolUse"

${SPOOL_FUNCTIONS}

BODY=$(cat)
post_hook "/api/status/hook?provider=codex&tmuxSession=\${SESSION}&generation=\${GENERATION}" "$BODY"
exit 0
`;

/**
 * Grok Build pipes the hook payload as JSON on stdin. The body is forwarded
 * verbatim and the route reads its camelCase fields — `hookEventName` included,
 * so the event needs no query parameter of its own.
 *
 * The POST is detached and time-boxed: a `Stop` hook runs on the turn's
 * critical path, `PostToolUse` fires on every mutating tool call, and neither
 * may wait on the round trip. Always exits 0, because a non-zero exit from a
 * `Stop` hook would block grok from finishing its turn.
 */
export const GROK_HOOK_SCRIPT_CONTENT = `#!/bin/sh
${PROLOGUE}
[ -n "$SESSION" ] || exit 0

${SPOOL_FUNCTIONS}

BODY=$(cat)
[ -z "$BODY" ] && BODY='{}'

( exec </dev/null >/dev/null 2>&1; post_hook "/api/status/hook?provider=grok&tmuxSession=\${SESSION}" "$BODY" ) &
exit 0
`;

/**
 * The Claude hook of a REMOTE tab (ADR-0022, slice b), installed on the remote
 * host beside the hooks.json that names it. It posts the raw hook JSON to this
 * server's callback URL (`PMUX_URL`) with the tab's own token
 * (`PMUX_TAB_TOKEN`), both from the pane's environment; the server reads the
 * session id and transcript path from the body. An event no server answers
 * spools beside the script, and the server pulls that spool over ssh. The
 * event name is one fixed word from hooks.json; anything else exits.
 */
export const REMOTE_HOOK_SCRIPT_CONTENT = `#!/bin/sh
EVENT="\${1:-}"
AT=$(date +%s%N 2>/dev/null)
case "$AT" in *[!0-9]*) AT="" ;; esac
if [ \${#AT} -eq 19 ]; then AT="\${AT%??????}"; else AT=$(( $(date +%s) * 1000 )); fi
PORT=""
TOKEN="\${PMUX_TAB_TOKEN:-}"
HOOK_BASE_URL="\${PMUX_URL:-}"
HOOK_SPOOL_DIR="$(cd "$(dirname "$0")" && pwd)/${HOOK_SPOOL_DIRNAME}"
SPOOL_SKIP_EVENT=""
HOOK_TIMEOUT=""
command -v timeout >/dev/null 2>&1 && HOOK_TIMEOUT="timeout ${HOOK_TMUX_TIMEOUT_SECONDS}"
SESSION=$($HOOK_TIMEOUT tmux display-message -p '#{session_name}' 2>/dev/null) || SESSION=""

${SPOOL_FUNCTIONS}

case "$EVENT" in
  session-start|prompt-submit|notification|stop|pre-compact|post-compact|post-tool) ;;
  *) exit 0 ;;
esac
case "$SESSION" in pt-*) ;; *) exit 0 ;; esac
BODY=$(cat)
[ -n "$BODY" ] || BODY='{}'
TARGET="/api/status/hook?remote=claude&event=\${EVENT}&session=\${SESSION}"
if [ "$EVENT" = "post-tool" ]; then
  ( exec </dev/null >/dev/null 2>&1; post_hook "\${TARGET}&kind=tool" "$BODY" ) &
  exit 0
fi
post_hook "$TARGET" "$BODY"
exit 0
`;

export interface IHookScriptFile {
  name: string;
  content: string;
  mode: number;
}

export const HOOK_SCRIPT_FILES: readonly IHookScriptFile[] = [
  { name: 'status-hook.sh', content: HOOK_SCRIPT_CONTENT, mode: 0o755 },
  { name: 'statusline.sh', content: STATUSLINE_SCRIPT_CONTENT, mode: 0o755 },
  { name: 'codex-hook.sh', content: CODEX_HOOK_SCRIPT_CONTENT, mode: 0o700 },
  { name: 'grok-hook.sh', content: GROK_HOOK_SCRIPT_CONTENT, mode: 0o700 },
];

/**
 * Replace a script in one rename. `sh` reads a script as it runs it, so a hook
 * that starts during a plain rewrite can execute half of the old file and half
 * of the new one. Returns whether the file changed.
 */
export const writeScriptAtomic = async (target: string, content: string, mode: number): Promise<boolean> => {
  try {
    if ((await fs.readFile(target, 'utf-8')) === content) return false;
  } catch {
    // absent or unreadable: write it
  }
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmp, content, { mode });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  return true;
};
