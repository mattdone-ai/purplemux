# tmux-based Terminal Management and Process Detection

PT uses tmux as its terminal backend. It runs on a dedicated socket (`purple`) and config (`src/config/tmux.conf`) isolated from the user's `~/.tmux.conf`.

---

## Architecture

```
Browser (xterm.js)
  │
  │  WebSocket (/api/terminal)
  ▼
terminal-server.ts
  │
  │  node-pty (tmux attach-session)
  ▼
tmux socket (purple)
  │
  ├─ pt-{wsId}-{paneId}-{tabId}   session 1
  ├─ pt-{wsId}-{paneId}-{tabId}   session 2
  └─ ...
```

- **Socket name**: `purple` (`-L purple`). Fully isolated from the system tmux.
- **Session naming**: `pt-{workspaceId}-{paneId}-{tabId}` format
- **Config file**: `src/config/tmux.conf` (prefix disabled, status bar off, mouse on)

---

## tmux Settings (`src/config/tmux.conf`)

| Setting | Value | Purpose |
| --- | --- | --- |
| `prefix` | None | Every key passes through directly to the shell |
| `status` | off | Hide tmux UI (xterm.js does the rendering) |
| `set-titles` | on | Forward titles to the outer terminal |
| `set-titles-string` | `#{pane_current_command}\|#{pane_current_path}` | Send the foreground process and CWD separated by a pipe |
| `status-interval` | 2 | Refresh the title every 2 seconds |
| `allow-passthrough` | on | Allow OSC sequence passthrough |
| `mouse` | on | Mouse scroll → enter copy-mode |
| `history-limit` | 5000 | Scrollback buffer size |

---

## tmux Command Wrapper (`src/lib/tmux.ts`)

All tmux invocations go through `tmux.ts`. Do not call tmux directly via `child_process`.

### Session Management

| Function | tmux command | Purpose |
| --- | --- | --- |
| `listSessions()` | `tmux -L purple ls -F '#{session_name}'` | List sessions with the `pt-` prefix |
| `createSession(name, cols, rows, cwd)` | `tmux -L purple new-session -d -s {name} -x {cols} -y {rows}` | Create a background session |
| `killSession(name)` | SIGTERM → `kill-session` → recheck → SIGKILL fallback | End a session (process group level) |
| `hasSession(name)` | `tmux -L purple has-session -t {name}` | Check whether a session exists |
| `cleanDeadSessions()` | `listSessions` + `hasSession` loop | Clean up dead sessions |
| `scanSessions()` | Called at server start | Scan and clean existing sessions |

### Information Lookup

| Function | tmux command | Returns |
| --- | --- | --- |
| `getSessionCwd(session)` | `display-message -p '#{pane_current_path}'` | Current working directory |
| `getSessionPanePid(session)` | `display-message -p '#{pane_pid}'` | The pane's shell PID |
| `getPaneCurrentCommand(session)` | `list-panes -F '#{pane_current_command}'` | Foreground process name |
| `getAllPanesInfo()` | `list-panes -a -F '#{session_name}\t#{pane_current_command}\t#{pane_pid}'` | All sessions' processes/PIDs at once |
| `checkTerminalProcess(session)` | `getPaneCurrentCommand` + SAFE_SHELLS check | Determine whether the foreground is a shell (safe pre-resume check) |

### Input Sending

| Function | tmux command | Purpose |
| --- | --- | --- |
| `sendKeys(session, command)` | `copy-mode -q` → `send-keys {command} Enter` | Send a command to the session (resume, etc.) |
| `exitCopyMode(session)` | `copy-mode -q` | Leave copy-mode |

---

## Terminal Connection (`src/lib/terminal-server.ts`)

WebSocket endpoint: `/api/terminal?session={name}&clientId={id}`.

### Binary Protocol

Defined in `src/lib/terminal-protocol.ts` and imported by `terminal-server.ts`.

| Message type | Code | Direction | Description |
| --- | --- | --- | --- |
| `MSG_STDIN` | `0x00` | client → server | Key input |
| `MSG_STDOUT` | `0x01` | server → client | Terminal output |
| `MSG_RESIZE` | `0x02` | client → server | Terminal resize (cols: u16, rows: u16) |
| `MSG_HEARTBEAT` | `0x03` | both | Connection keep-alive (30s interval, 90s timeout) |
| `MSG_KILL_SESSION` | `0x04` | client → server | Request session termination |
| `MSG_WEB_STDIN` | `0x05` | client → server | Web input (delivered after copy-mode exit) |

### Connection Flow

```
1. Receive WebSocket connection
2. If clientId is duplicate, replace the existing connection
3. Manage at most 32 connections (when exceeded, drop the oldest)
4. tmux attach-session (via node-pty)
5. pty.onData → WebSocket MSG_STDOUT
6. WebSocket MSG_STDIN → pty.write
7. Backpressure: bufferedAmount > 1MB → pty.pause, < 256KB → pty.resume
8. pty.onExit → cleanup (distinguish detach vs session exit)
```

---

## Title-based Process Detection (Client)

tmux emits the title in the format `"#{pane_current_command}|#{pane_current_path}"`, which the browser receives via the xterm.js `onTitleChange` event.

### `src/lib/tab-title.ts`

| Function | Example input | Output | Purpose |
| --- | --- | --- | --- |
| `parseCurrentCommand(raw)` | `"claude\|/home/user"` | `"claude"` | Extract the part before the pipe (process name) |
| `isShellProcess(raw)` | `"zsh\|/home/user"` | `true` | Whether it is a shell (zsh/bash/fish/sh) |
| `formatTabTitle(raw)` | `"zsh\|/home/user/project"` | `"project"` | Tab display name (directory if a shell, otherwise process name) |

### Where It's Used

```
xterm.js onTitleChange
  → pane-container.tsx / mobile-surface-view.tsx
    ├─ formatTabTitle(title)      → update tab metadata
    ├─ isShellProcess(title)      → record shell-state
    └─ fetchAndUpdateCwd()        → sync CWD
```

---

## Process Detection (Server — `src/lib/session-detection.ts`)

Server-side logic for detecting Claude CLI session state.

### Process Tree Walk

```
tmux pane (shell PID)
  └─ child processes (pgrep -P {panePid})
      └─ claude process (verified via ps -p {pid} -o args=)
```

### `detectActiveSession(panePid)` Decision Flow

```
~/.claude directory exists?
├─ NO → { status: 'not-installed' }
└─ YES
    └─ pgrep -P {panePid} → list of child PIDs
        ├─ no children → { status: 'none' }
        └─ has children
            ├─ [primary] match against PIDs in {home}/sessions/*.json,
            │   for every candidate claude home (see below)
            │   └─ ps -p {pid} -o args= → confirm 'claude' is in the args
            │       ├─ matched → { status: 'active', sessionId, jsonlPath, ... }
            │       └─ mismatch → delete the PID file (stale cleanup)
            │
            └─ [fallback] match `claude --resume {uuid}` pattern in ps args
                └─ lsof -a -p {pid} -d cwd -Fn → look up CWD
                    └─ { status: 'active', sessionId, jsonlPath, ... }
```

### Claude CLI Directories Referenced

Workspace panes run claude with `CLAUDE_CONFIG_DIR` set to the workspace's own
claude-home (see [DATA-DIR.md](./DATA-DIR.md)), so detection scans every
candidate home: `~/.claude` plus each
`~/.purplemux/workspaces/{wsId}/claude-home`. Session PID files name their
process, so the pid match keeps cross-workspace confusion impossible.

| Path | Contents |
| --- | --- |
| `{home}/` | A candidate claude home (`~/.claude` or a workspace claude-home) |
| `{home}/sessions/` | Active session PID files (`{pid}.json`) |
| `{home}/projects/{projectName}/` | Session JSONL files (`{sessionId}.jsonl`) |

PID file format:
```json
{
  "pid": 12345,
  "sessionId": "abc-def-...",
  "cwd": "/Users/user/project",
  "startedAt": 1711100000
}
```

### Process Watching (`watchSessionsDir`)

Combines polling and `fs.watch` to detect session changes in real time:

| Watch target | Method | Interval / condition |
| --- | --- | --- |
| Every candidate `{home}/sessions/` directory | `fs.watch` | 200ms debounce |
| Active Claude PID liveness | `ps -p {pid}` polling | 10s interval |
| Candidate home set (new/removed claude-homes, first claude run) | Watch reconciliation | 60s interval |

When a change is detected, `detectActiveSession` is re-run and the result is delivered to the callback.

---

## System Commands Used

| Command | Caller | Purpose |
| --- | --- | --- |
| `tmux -L purple ...` | `tmux.ts` | Session management, info, key send |
| `pgrep -P {pid}` | `session-detection.ts` | List child PIDs |
| `ps -p {pid}` | `session-detection.ts` | Check process existence/args |
| `ps -p {pid} -o args=` | `session-detection.ts` | Inspect args (claude or not) |
| `lsof -a -p {pid} -d cwd -Fn` | `session-detection.ts` | Process CWD lookup (fallback) |

---

## WebSocket Endpoints

| Path | Handler | Purpose |
| --- | --- | --- |
| `/api/terminal` | `terminal-server.ts` | Terminal I/O (binary protocol) |
| `/api/timeline` | `timeline-server.ts` | Claude session timeline (JSONL watcher) |
| `/api/status` | `status-server.ts` | Whole-tab status indicator |
| `/api/sync` | `sync-server.ts` | Cross-client sync |

All WebSocket connections are authenticated via NextAuth JWT in `server.ts` before the handshake.

---

## Server Startup Sequence (`server.ts`)

```
1. initAuthCredentials()        Initialize auth credentials
2. scanSessions()               Scan/clean existing tmux sessions
3. applyConfig()                Apply tmux.conf
4. initWorkspaceStore()         Load workspace store
5. autoResumeOnStartup()        Auto-resume processing
6. getStatusManager().init()    Start status polling
7. app.prepare()                Prepare Next.js
8. server.listen()              Start HTTP + WebSocket server
```

---

## Remote Tabs (ADR-0022)

A tab with `host` set runs its tmux session on that host. The server stays the one control plane; only tmux moves.

| Concern | Local tab | Remote tab |
| --- | --- | --- |
| Socket | `-L purple` | `ssh <host> tmux -L pmux-<origin hostname>` (never the remote's own `purple`) |
| Config | `src/config/tmux.conf` | the same file, pushed to `$HOME/.purplemux-remote/<origin>/tmux.conf` at each create |
| Routing | — | `session-host.ts` maps the session name to its host (layout `ITab.host`, cached on `globalThis`); every `tmux.ts` function asks it |
| Attach | `tmux attach-session` under node-pty | `ssh -tt <host> tmux … attach-session` under node-pty |
| Pane pid | real | never returned: `getSessionPanePid` → null, `getAllPanesInfo` → `pid: 0` + `host` |
| `getSessionCwd` | the pane's directory | null: the path names the remote tree, not this one |
| Close | local reaper (ADR-0016) | `REMOTE_REAP_SCRIPT` over `ssh … sh -s`, `reaper: 'remote'`; an ssh failure throws `RemoteHostError` |
| Close of a pane or workspace | tabs in order | every remote host asked first; remote tabs closed first, outside the layout and store locks; a silent host refuses the whole close |
| Session presence | `hasSession` | `sessionPresence`: only tmux's own answer is `absent`; ssh failing is `unknown` (503 on send, status, result, restart) |
| Attach ends | 1000 only when tmux says the session is gone and no restart is open; 4002 while the tab restarts; else 4001 | 1000 only when tmux says the session is gone and no restart is open; 4002 while the tab restarts; else 4001 (the client retries) |
| Agent hooks (claude-code) | `~/.purplemux/status-hook.sh` to localhost | the kit's `status-hook.sh` on the host posts to `PMUX_URL` with the tab token; spools beside itself |
| Transcript | read where Claude writes it | copied to `~/.purplemux/remote-transcripts/` by bounded ssh reads before each hook and stop read |
| Agent process proof | local `/proc` walk | `REMOTE_PROVIDER_SCRIPT` on the host (`observeRemoteProviderProcess`) |

ssh runs with `BatchMode=yes`, `ConnectTimeout=5` and no ControlMaster (one connection per call, about 90 ms from Node). The registry is fleet config `remote.hosts` (comma-separated ssh aliases).

---

## Tab Restart (ADR-0028)

`purplemux tab restart` (`POST /api/cli/tabs/{tabId}/restart`, cookie twin `POST /api/tabs/{tabId}/restart`) gives a tab a fresh agent process under the same tab id and the same session name. One service, `restartTab` in `src/lib/tab-restart.ts`, runs it:

1. `withAgentDispatchLock` takes the workspace mapping read guard and the tab's dispatch lock once; no dispatch types into the session while it restarts, and nothing inside takes the read guard again (the lease is not re-entrant).
2. A busy tab (`cliState` busy, or a pending `orchestrationActivity` launch or turn) is refused with `tab-busy` unless `--interrupt`.
3. A remote tab's host is probed first (`hasSessionOrUnreachable`); a silent host kills nothing.
4. `emitTabRestart({restartId, phase: 'restarting'})` (`src/lib/tab-lifecycle.ts`) opens the restart: the StatusManager retires the watchdog checks and takes the tab's registered background jobs. No `tab-closing` or `tab-closed` fires.
5. While the restart is open, the terminal server closes an attach that ends with 4002 `Tab restarting` (never 1000, which makes the web client close the tab) and refuses a connect with 4002 before any probe or attach. The web client re-attaches every second, up to 120 tries.
6. `killSession(name, {tabId})` reaps the ADR-0016 process set. A survivor, a session still present, or a failure after the kill stops the restart (`restart-not-confirmed`).
7. `restartTabSessionUnguarded` recreates the session with no command; `createSession` keeps a launch token and replaces a hook token (`ensureTabToken`). A lost cwd starts the agent fresh (`resumeSkipped: 'cwd-lost'`).
8. `launchAgentInTab` (`src/lib/agent-launch.ts`, shared with tab create and auto-resume) builds and types the launch from the tab's persisted settings: resume where the provider has a session id and the tab is local, else fresh; Codex through its managed launch, confirmed after the lock is released.
9. The tab gains `lastRestartAt`; one `tab-restart` audit line; then, from a `finally`, exactly one `restarted` or `failed` with the same `restartId` closes the restart and restores the checks (a `failed` gives the jobs back).

The existing route `POST /api/layout/pane/{p}/tabs/{t}` still recreates only a dead session. It takes the tab's target lock inside its read guard, so it waits for a restart instead of recreating the session between the reap and its confirmation.

---

## Counting tabs from a repo hook

The harness enforces one WIP cap: the per-workspace agent-tab cap (ADR-0027), fleet config `tabs.cap-per-workspace` (default 8), which `tabs.cap-per-workspace.<workspaceId>` overrides for one workspace (ADR-0039 §8). A repository hook that limits parallel agents reads that cap and keeps no number of its own. It must count the tabs of its workspace. Obey three rules:

1. **purplemux runs tmux on its own socket, `-L purple`** (`TMUX_SOCKET` in `src/lib/tmux.ts`). A hook that runs `tmux ls` without `-L purple` reads the user's own tmux server. That server does not hold the purplemux tabs, so the count is wrong. A count of `tmux -L purple ls` is also wrong: it holds the sessions of every workspace and of every tab type.
2. **Use `purplemux tab count -w WS`** (ADR-0027). It prints `<count> <cap>`: the agent tabs (`claude-code`, `codex-cli`, `grok-cli`) of workspace `WS`, and the WIP cap. `--json` adds `capSource` and `overCap`. Inside a tab, `WS` is `$PMUX_WORKSPACE_ID`. The server counts under the layout lock, the same count that refuses a create at the cap. The exit codes are in the api-guide (`GET /api/cli/workspaces/<WS>/tab-count`).
3. **A remote tab does not run on this host** (ADR-0022). Its session is on `ssh <host> tmux -L pmux-<origin>`. `<origin>` is the host name of the purplemux server, made safe by `originName` in `src/lib/remote-host.ts`: lower case, each run of characters outside `[a-z0-9-]` replaced by one `-`, leading and trailing `-` removed, at most 40 characters, and `origin` when nothing is left. No local tmux command sees the session. `tab count` counts it.

```bash
out=$(purplemux tab count -w "$PMUX_WORKSPACE_ID")
status=$?
if [ "$status" -ne 0 ]; then
  echo "tab count failed (exit $status); not limiting" >&2
  exit 0
fi
read -r count cap <<< "$out"
[ "$count" -lt "$cap" ] || { echo "WIP cap: $count of $cap agent tabs" >&2; exit 2; }
```

If the CLI fails, the hook decides its own policy from the exit code (ADR-0016). The example reports the exit code and lets the action continue, because a hook that blocks on a server outage stops every tab.

---

## Related Files

| File | Description |
| --- | --- |
| `src/config/tmux.conf` | tmux config (purple socket only) |
| `src/lib/tmux.ts` | tmux command wrapper |
| `src/lib/tab-restart.ts` | `tab restart`: reap, recreate and relaunch under the same tab id (ADR-0028) |
| `src/lib/agent-launch.ts` | the one agent launcher for tab create, auto-resume and tab restart |
| `src/lib/terminal-server.ts` | Terminal WebSocket handler (node-pty) |
| `src/lib/terminal-protocol.ts` | Terminal binary protocol constants and encoders |
| `src/lib/session-detection.ts` | Claude session detection (`detectActiveSession`, `watchSessionsDir`) |
| `src/lib/tab-title.ts` | Client-side title parsing (`parseCurrentCommand`, `isShellProcess`, `formatTabTitle`) |
| `src/lib/timeline-server.ts` | Timeline WebSocket handler (JSONL watcher) |
| `src/lib/status-manager.ts` | Status polling engine |
| `src/lib/status-server.ts` | Status WebSocket handler |
| `src/hooks/use-terminal.ts` | xterm.js hook (`onTitleChange` event) |
| `server.ts` | Server initialization and WebSocket routing |
