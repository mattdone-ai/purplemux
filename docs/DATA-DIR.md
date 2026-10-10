# `~/.purplemux/` Settings Directory

All persistent state (settings, layouts, session history, caches) lives under `~/.purplemux/`. See [CLAUDE.md §15](../CLAUDE.md) — memory/variables and `localStorage` are not used.

File permissions are `0600` for anything containing a secret (config, tokens, layouts, VAPID keys, lock file). Writes go through a `tmpFile → rename` pattern plus a `withLock` promise queue (in-process) to avoid interleaved writes.

---

## Directory Layout

```
~/.purplemux/
├── config.json              # app config (auth, theme, locale, …)
├── workspaces.json          # workspace list + sidebar state
├── workspaces/
│   └── {wsId}/
│       ├── layout.json           # pane/tab tree
│       ├── message-history.json  # per-workspace input history
│       ├── claude-prompt.md      # --append-system-prompt-file content
│       ├── standups.json         # orchestrator standup ticks (latest + history)
│       ├── burndown.json         # latest published epic burndown (Scrum Master)
│       ├── claude-home/          # per-workspace CLAUDE_CONFIG_DIR
│       └── grok-home/            # per-workspace GROK_HOME
├── hooks.json               # Claude Code hook + statusline config (generated)
├── status-hook.sh           # hook → POST /api/status/hook (generated, 0755)
├── codex-hook.sh            # Codex hook → POST /api/status/hook?provider=codex (generated, 0700)
├── grok-hook.sh             # Grok hook → POST /api/status/hook?provider=grok (generated, 0700)
├── statusline.sh            # statusline → POST /api/status/statusline (generated, 0755)
├── rate-limits.json         # latest statusline JSON written by statusline.sh
├── session-history.json     # completed Claude session log (cross-workspace)
├── quick-prompts.json       # custom quick prompts + disabled builtins
├── sidebar-items.json       # custom sidebar items + disabled builtins
├── vapid-keys.json          # Web Push VAPID keypair (generated)
├── push-subscriptions.json  # Web Push endpoints + FCM device registrations
├── orchestrator-presence.json # durable missing-owner notification episode latches
├── cli-token                # CLI auth token (generated)
├── port                     # current server port (hook scripts read it)
├── hook-spool/              # hook events no server answered (0700; ADR-0020)
│   ├── {epochMs}-{pid}-{rand}.json
│   ├── .floors.json         # each tab's hook floor {tabId: epochMs}, saved by the server (≤ 1 write / 5 s)
│   └── bad/                 # unreplayable files and rollback-<stamp>/ set-asides (pruned after 7 days)
├── pmux.lock                # single-instance lock {pid, port, startedAt}
├── logs/                    # pino-roll log files
│   └── purplemux.YYYY-MM-DD.N.log
├── uploads/                 # images attached via web input bar
│   └── {wsId}/{tabId}/{ts}-{rand}-{name}.{ext}
└── stats/                   # Claude usage statistics
    ├── cache.json
    ├── uptime-cache.json
    └── daily-reports/
        └── YYYY-MM-DD.json
```

---

## Top-level Files

### `config.json` — `src/lib/config-store.ts`

App-wide settings. `authPassword` is scrypt-hashed (`scrypt:{salt}:{hash}`); deleting the file resets onboarding.

| Key | Meaning |
| --- | --- |
| `authPassword` | scrypt hash of the login password |
| `authSecret` | HMAC secret for session tokens (32 bytes hex) |
| `appTheme` | `light` / `dark` |
| `terminalTheme` | `{ light, dark }` xterm.js theme names |
| `customCSS` | User-injected CSS string |
| `locale` | `en` / `ko` / `ja` / … |
| `fontSize` | `small` / `normal` / `large` |
| `notificationsEnabled` | System/web-push notification toggle |
| `dangerouslySkipPermissions` | Pass `--dangerously-skip-permissions` to Claude |
| `editorUrl` / `editorPreset` | External editor (e.g. code-server, VS Code) |
| `networkAccess` | `localhost` / `network` — server bind scope |
| `systemResourcesEnabled` | CPU/memory stats display toggle |
| `updatedAt` | ISO timestamp |

Electron additionally stores `server` (`local`/`remote` mode + `remoteUrl`) and `windowState` (position, size, fullscreen) in this file — see `electron/main.ts`.

### `workspaces.json` — `src/lib/workspace-store.ts`

Workspace index and sidebar state. Per-workspace tab/pane tree lives under `workspaces/{wsId}/layout.json`.

```jsonc
{
  "workspaces": [
    { "id": "ws-MMKl07", "name": "purplemux", "directories": ["/path"], "order": 0 }
  ],
  "activeWorkspaceId": "ws-MMKl07",
  "sidebarCollapsed": false,
  "sidebarWidth": 285,
  "updatedAt": "2026-04-18T15:31:48.741Z"
}
```

Legacy migrations: `tabs.json` → `layout.json` → `workspaces/{wsId}/layout.json`. Parse failures copy the file to `.json.bak` and start fresh.

### `hooks.json` — `src/lib/hook-settings.ts`

Claude Code `--settings` file. Regenerated on server startup from `buildHookSettings()`; overwrites are skipped when content matches.

Hooks mapped to `status-hook.sh`:

| Event | Arg |
| --- | --- |
| `SessionStart` | `session-start` |
| `UserPromptSubmit` | `prompt-submit` |
| `Notification` | `notification` |
| `Stop` / `StopFailure` | `stop` |
| `PreCompact` | `pre-compact` |
| `PostCompact` | `post-compact` |

Plus `statusLine.command = sh "~/.purplemux/statusline.sh"`.

See [STATUS.md](./STATUS.md) for the full status-detection flow.

### `status-hook.sh`, `codex-hook.sh`, `grok-hook.sh`, `statusline.sh`

Auto-generated from `HOOK_SCRIPT_CONTENT`, `CODEX_HOOK_SCRIPT_CONTENT` and `GROK_HOOK_SCRIPT_CONTENT` (`hook-scripts.ts`) and `STATUSLINE_SCRIPT_CONTENT` (`statusline-script.ts`), each replaced in one rename. All of them:

1. Read `port` and `cli-token` from `~/.purplemux/`
2. `POST` to the local server with `x-pmux-token` header
3. Exit 0 whatever the answer

When no server answers (no port or token file, a refused or never-finished connect, or a 5xx), the three hook scripts write the event to `hook-spool/` instead of dropping it; `statusline.sh` does not. Codex `PreToolUse` is never spooled, and a body over 256 KiB is spooled as metadata only. The next server replays the spool in time order once it listens and on every poll, ordered against each tab's hook floor, saved in `hook-spool/.floors.json` (never the layout). Contract: [ADR-0020](adr/0020-hook-spool-across-restarts.md). `scripts/install-hook-scripts.sh` renders the four scripts from a checkout's own templates (`deploy-live.sh` runs it before a restart).

`grok-hook.sh` reads Grok Build's payload from **stdin** (grok pipes the event JSON to the hook process; the keys are camelCase and the `hookEventName` VALUE is snake_case), forwards it verbatim, and also passes `GROK_HOOK_EVENT` — which grok injects into every hook process — as a query parameter so an empty stdin still reports. It time-boxes the request with `curl --max-time 2`, backgrounds it, and always exits 0: `Stop` runs on the turn's critical path and a non-zero exit there would block grok from finishing.

Do not edit these by hand — they are rewritten on startup when content differs.

### `workspaces/{wsId}/grok-home/` and `$GROK_HOME/hooks/purplemux.json`

Grok Build reads `GROK_HOME` instead of `~/.grok` when it is set, so each workspace pane launches
with its own store (`src/lib/grok-home.ts`, ADR-0005). Inside a workspace grok home:

- **private, real directories:** `sessions/`, `hooks/`, `logs/` — this is the isolation.
- **symlinks back to `~/.grok`:** `auth.json`, `config.toml`, `managed_config.toml`,
  `requirements.toml`, `pager.toml`, `lsp.json`, `trusted_folders.toml`, `mcp_credentials.json`,
  `skills/`, `commands/`, `rules/`, `memory/`, `agents/`, `plugins/`, `workflows/`. Credentials and
  configuration stay common, so a workspace tab never asks the user to sign in again. An entry the
  install does not have is skipped.

Ad-hoc tabs (no workspace) run against the real `~/.grok`.

purplemux owns exactly one file in each grok home: `hooks/purplemux.json`, written at mode 0600 in
the Claude Code hooks JSON format. Grok merges every `*.json` in that directory, so a hook the user
wrote alongside it is never touched. The file is rewritten when its content changes — on server boot
for every existing home, and again at pane launch for a workspace created after boot.

Registered events: `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `StopCancelled`,
`Notification` (matcher `permission_prompt|idle_prompt|task_complete`), `PreCompact`, `PostCompact`,
`SessionEnd`, `PostToolUse` (matcher `Edit|Write|MultiEdit|Bash|search_replace|run_terminal_command`
— grok's matcher is a regular expression and keeps the Claude tool names it aliases, so both
spellings fire).

purplemux never writes `~/.grok/config.toml`.

grok's transcripts are JSONL: `$GROK_HOME/sessions/<url-encoded cwd>/<session-id>/updates.jsonl`,
the authoritative ACP session-update stream. purplemux reads it and never writes to a grok store.

### `rate-limits.json`

Claude CLI writes its statusline JSON via stdin → `statusline.sh` → `POST /api/status/statusline` → server persists here. Watched by `rate-limits-watcher.ts` (debounced 500 ms); updates drive the rate-limit UI. Schema: `ts`, `model`, `five_hour`, `seven_day`, `context`, `cost`.

### `session-history.json` — `src/lib/session-history.ts`

Cross-workspace log of completed Claude sessions (max 200 entries, version 1). Keyed by `IHistoryEntry` (prompt, result, duration, tool usage, touched files).

### `quick-prompts.json`, `sidebar-items.json` — `src/lib/{quick-prompts,sidebar-items}-store.ts`

User customizations layered on top of built-in lists. Structure:

```json
{ "custom": [...], "disabledBuiltinIds": [...], "order": [...] }
```

Built-ins (`BUILTIN_PROMPTS`, `BUILTIN_ITEMS`) are defined in code; the disk file only records overrides and ordering.

### `vapid-keys.json`, `push-subscriptions.json`

Web Push state. VAPID keypair is generated on first run (`vapid-keys.ts`) and cached in memory. Subscriptions are managed per-browser via `push-subscriptions.ts`.

`push-subscriptions.json` is an array of records:

```json
[
  {
    "subscription": { "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } },
    "deviceId": "kQ9…",
    "label": "Pixel",
    "createdAt": 1755300000000
  }
]
```

`deviceId` is the browser's `purplemux-device-id` (localStorage, sent by `use-web-push.ts` with the subscription). It is what makes the push visibility gate per-device — a focused desktop no longer mutes the phone. Rows written before this wrapper existed are bare `PushSubscription` objects; `normalizeSubscriptionRecords` wraps them on read with `createdAt: 0` and no `deviceId`, and an unbound row keeps the old "any focused window mutes push" gate until that browser re-subscribes.

#### Record kinds

The same file holds both channels' registrations, told apart by a `kind` discriminant:

| `kind` | Written by | Identifier | Read by |
| --- | --- | --- | --- |
| absent | `POST /api/push/subscribe` with a `PushSubscription` | `subscription.endpoint` | `web-push` channel |
| `"fcm"` | `POST /api/push/subscribe` with `{kind:'fcm', token, deviceId, label?}` | `token` | `fcm` channel |

```json
[
  { "kind": "fcm", "token": "eyJ…", "deviceId": "kQ9…", "label": "Pixel", "createdAt": 1755300000000 }
]
```

A Web Push row carries **no** `kind` — rows written before FCM existed round-trip unchanged, and `getSubscriptionRecords()` / `getFcmSubscriptionRecords()` each read only their own kind. `DELETE` takes `{endpoint}` for a Web Push row, `{token}` for one FCM registration, or `{deviceId}` for every FCM registration of one device. `GET` returns `devices` (endpoints) and `fcmDevices`; the FCM listing carries the device binding but never the token, which is a send credential.

### `orchestrator-presence.json`

The coverage monitor persists only the workspace IDs whose current missing-owner
episode has already claimed its notification. This keeps repeat watchdog ticks
and server restarts at-most-once per episode. An uncertain read, an omitted
workspace, or a restart does not clear a latch; only confirmed recovery or
confirmed completion does. The file is strict-read and atomically replaced, so
damage pauses notification transitions instead of becoming an empty state.
Lease and liveness files are also read through strict diagnostic views for this
monitor; their normal mutation/API compatibility paths are unchanged.

### FCM service account (outside `~/.purplemux`)

The `fcm` channel is off unless `FCM_SERVICE_ACCOUNT_PATH` points at a Firebase service-account JSON key file. The path is read once at startup; absent or unreadable means the channel is not registered and nothing else changes. The file lives wherever the operator puts it — purplemux never copies it into `~/.purplemux` and never logs its contents.

### `cli-token`, `port`

Shared handshake between the server and any CLI/hook that needs to reach it:

- `cli-token` — 32-byte hex token (`randomBytes(32)`), compared with `timingSafeEqual` in `cli-token.ts`. Read by `bin/cli.js` and all hook scripts via the `x-pmux-token` header.
- `port` — plain-text current port, written by `ensureHookSettings(port)` at startup.

### `pmux.lock` — `src/lib/lock.ts`

Single-instance guard. Contains `{pid, port, startedAt}`. On startup:

1. Attempt `open(LOCK_FILE, 'wx')` — if successful, we own it.
2. If it exists, read the PID. Dead PID → reclaim. Alive but `GET /api/health` does not reply `{ app: 'purplemux' }` → reclaim.
3. Alive + healthy → abort with "already running".

Released on `process.on('exit')`.

---

## Per-workspace Directory (`workspaces/{wsId}/`)

### `layout.json` — `src/lib/layout-store.ts`

Recursive pane/tab tree. Leaf `pane` nodes hold `tabs[]`; `split` nodes hold `children[]` with `ratio`. Each tab carries its `sessionName` (`pt-{wsId}-{paneId}-{tabId}`), cached `cliState`, `claudeSessionId`, and the last resume command.

See [TMUX.md](./TMUX.md) for how tabs map to tmux sessions and [STATUS.md](./STATUS.md) for the state fields.

### `message-history.json` — `src/lib/message-history-store.ts`

Per-workspace input history for Claude tabs. Capped at 500 entries. Locks are keyed by `wsId` so parallel workspace writes do not block each other.

### `claude-prompt.md` — `src/lib/claude-prompt.ts`

The `--append-system-prompt-file` content passed to every Claude tab in the workspace. Regenerated whenever the workspace is created, renamed, or its directories change. Contains workspace ID + CLI quick-reference.

### `standups.json` — `src/lib/standup-store.ts`

Orchestrator standup ticks, newest first, capped at 50. The latest tick renders in the
workspace sidebar; `StatusManager` hydrates from this file on boot so "where are things
at" survives a server restart. See STATUS.md → Standup Ticks for the full flow.

### `burndown.json` — `src/lib/burndown-store.ts`

The latest epic burndown the workspace published with `purplemux burndown publish`
(`{ workspaceId, receivedAt, snapshot }`, mode 0600). Each publish replaces the file; the
snapshot is validated by `src/lib/burndown.ts`, history keeps the newest 2000 rows, and the
file is at most 1 MiB. The portfolio board reads the selected Scrum Master's workspace file
through `GET /api/mission-control/burndown`. A file that does not validate is reported as a
storage error, never read as "nothing published".

### `claude-home/` — `src/lib/workspace-home.ts`

The workspace's private `CLAUDE_CONFIG_DIR`, set on every pane at launch (`src/lib/tmux.ts`). `projects/` and `sessions/` are real per-workspace directories — this is what keeps conversation history and resume lists separate for workspaces sharing one project root — while credentials, settings, commands, hooks, rules and plugins are symlinks back into `~/.claude`, recreated on each launch. Session detection, session lists, and timeline jsonl resolution all resolve against this directory for workspace panes (`~/.claude` remains the home for non-workspace sessions).

---

## `logs/`

Pino-roll output. One file per UTC day with numeric suffix when size is exceeded:

```
purplemux.2026-04-19.1.log
```

Root level defaults to `info`; override with `LOG_LEVEL=debug` or per-group with `LOG_LEVELS=hooks=debug,status=warn,tmux=trace`. See `src/lib/logger.ts`.

---

## `uploads/` — `src/lib/uploads-store.ts`

Images attached via the chat input bar (drag/drop, paste, paperclip). Saved as `{timestamp}-{rand}-{name}.{ext}` under `{wsId}/{tabId}/` so paths can be passed to the running Claude CLI.

- Allowed MIME types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`
- Max size: 10 MB
- Files are written with `0600` permissions
- Auto-cleanup on server start removes anything older than 24 hours
- Manual cleanup: Settings → System → Attached Images → Clean now (or `POST /api/uploads/cleanup` with `{ "mode": "all" | "expired" }`)

---

## `stats/`

Claude usage statistics cache. Derived from `{home}/projects/**/*.jsonl` across every claude home (`~/.claude` plus each workspace `claude-home/`) — purplemux only reads those directories. Each transcript lives in exactly one home, so the union cannot double-count.

| File | Contents |
| --- | --- |
| `cache.json` | `IStatsFileCache` — per-day aggregates (messages, sessions, tool calls, hourly counts, per-model token usage). Cache version `1`. |
| `uptime-cache.json` | Per-day uptime/active-minutes roll-up. |
| `daily-reports/{date}.json` | AI-generated daily brief (`IDailyReportDay`) keyed by `YYYY-MM-DD`. |

All files here are regeneratable — deleting them just triggers a recompute on the next stats request.

---

## Deleting to Reset

| To reset… | Delete |
| --- | --- |
| Login password (onboarding again) | `config.json` |
| All workspaces and tabs | `workspaces.json` + `workspaces/` |
| A single workspace's layout | `workspaces/{wsId}/layout.json` (it will be recreated as a default pane) |
| Usage statistics | `stats/` |
| Push subscriptions (Web Push + FCM) | `push-subscriptions.json` |
| Stuck "already running" | `pmux.lock` (only if no purplemux process is alive) |

`hooks.json`, `status-hook.sh`, `codex-hook.sh`, `grok-hook.sh`, `statusline.sh`, `port`, `cli-token`, `vapid-keys.json` are auto-regenerated on the next startup.

Deleting `$GROK_HOME/hooks/purplemux.json` is safe — it is regenerated on the next startup, and it is
the only file in that directory purplemux owns. Deleting a workspace `grok-home/` discards that
workspace's grok session history; the shared credentials and configuration it links to are untouched.

Coordinator settings in `workspaces.json` include an optional legacy `orchestration.revision`. Reads expose absent revision as zero; only a successful semantic mapping/config change persists the next safe integer. Unknown future settings survive updates. Recovery never writes a separate identity sidecar or converts missing layout identity into proof of death.
