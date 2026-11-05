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
│       ├── claude-prompt.md      # --append-system-prompt-file content, with the active standing orders
│       ├── standing-orders.md    # the workspace's standing orders SO-<n> (ADR-0041; 0600)
│       ├── spec-queue.md         # product rules the curator filed from owner messages, by message id (ADR-0042; 0600)
│       ├── standups.json         # orchestrator standup ticks (latest + history)
│       ├── burndown.json         # latest published epic burndown (Scrum Master)
│       ├── flow.json             # latest published pipeline flow + server history (ADR-0026)
│       ├── board-goal.json       # the board's goal, `purplemux board goal set` (ADR-0034 §10)
│       ├── liveness.json         # the tabs' liveness probes and background jobs (0600)
│       ├── codex-prompt.md       # Codex developer_instructions content
│       ├── claude-home/          # per-workspace CLAUDE_CONFIG_DIR
│       └── grok-home/            # per-workspace GROK_HOME
├── hooks.json               # Claude Code hook + statusline config (generated)
├── status-hook.sh           # hook → POST /api/status/hook (generated, 0755)
├── codex-hook.sh            # Codex hook → POST /api/status/hook?provider=codex (generated, 0700)
├── grok-hook.sh             # Grok hook → POST /api/status/hook?provider=grok (generated, 0700)
├── statusline.sh            # statusline → POST /api/status/statusline (generated, 0755)
├── bin/
│   ├── evaluator-sql        # an evaluator tab's one read-only SQL probe (generated, 0755; ADR-0040)
│   ├── evaluator-chrome-mcp # an evaluator tab's chrome-devtools MCP launcher (generated, 0755; ADR-0040)
│   └── evaluator-mcp-filter.cjs # drops the client's MCP roots for that launcher (generated, 0644; ADR-0040)
├── evaluator/               # evaluator screenshots and files, one {tabId}/ per tab, outside every repository (ADR-0040)
├── rate-limits.json         # latest statusline JSON written by statusline.sh
├── session-history.json     # completed Claude session log (cross-workspace)
├── session-tabs.json        # agent session → tab bindings for spend (ADR-0030; 0600)
├── quick-prompts.json       # custom quick prompts + disabled builtins
├── sidebar-items.json       # custom sidebar items + disabled builtins
├── vapid-keys.json          # Web Push VAPID keypair (generated)
├── push-subscriptions.json  # Web Push endpoints + FCM device registrations
├── orchestrator-presence.json # durable missing-owner notification episode latches
├── owner-grants.json        # the owner grant (ADR-0029; 0600; never written to grants.json)
├── grants.json              # drive grants (ADR-0014; 0600)
├── leases.json              # held leases (ADR-0011; 0600)
├── notes.json               # coordinator notes (ADR-0013; 0600)
├── watches.json             # harness watches (ADR-0015; 0600)
├── standing-orders.md       # the fleet's standing orders SO-<n>, seeded with the W8 orders (ADR-0041; 0600)
├── standing-orders-seq.json # the highest SO-<n> ever handed out, so no id is reused (ADR-0041; 0600)
├── inbox.json               # server notices queued or held for tabs (ADR-0012; 0600)
├── fleet-config.json        # fleet config keys, versions and history (ADR-0019; 0600)
├── deploy-announcements.json # deploy announcements and their recipients, 7 days (ADR-0017; 0600; coordination `deploys` reads the last 24 h)
├── tab-tokens.json          # per-tab CLI tokens (0600)
├── workspace-tokens.json    # per-workspace CLI tokens (0600)
├── mission-control.sqlite   # Mission Control and portfolio database: runs, items, answers, deliveries, events (0600; WAL)
├── ledger.sqlite            # work-item ledger: events, items, wait intervals, rollups, tab events and turns, experiments (ADR-0033; 0600; WAL)
├── curator/                 # the local curator (ADR-0038; 0700): state.json (kodit anchor, per-version shadow clocks, task states),
│   └── eval/                #   labelled sets {task}.json (ids, labels, times, twin locators; no text), {task}.shadow.json,
│                            #   {task}.queue.json, match-standing-order.orders.json, spot-check.{task}.json (N -> id),
│                            #   results/{task}.json (held-out counts) and results/{task}.{train|all}.json,
│                            #   reshape-question.json (MC item ids), results/reshape-question{,.judge}.json (0600)
├── ledger-tokens.json       # SHA-256 of each ledger producer token: scope ledger:emit on one workspace (ADR-0033; 0600)
├── ledger-tokens/           # producer token files the CLI writes: {wsId}/{producer}.json (0700 dir, 0600 files)
├── ledger-spool/            # events `ledger emit` could not deliver: {producer}.jsonl, {producer}.rejected.jsonl, lock dirs (0700)
├── audit/
│   └── coordination.jsonl   # coordination audit lines: leases, notes, grants, deploys, restarts (0600; rotated at 10 MiB, 3 kept)
├── session-stats/           # per-session statusline usage {sessionId}.json (0600)
├── cli-token                # CLI auth token (generated)
├── port                     # current server port (hook scripts read it)
├── hook-spool/              # hook events no server answered (0700; ADR-0020)
│   ├── {epochMs}-{pid}-{rand}.json
│   ├── .floors.json         # each tab's hook floor {tabId: epochMs}, saved by the server (≤ 1 write / 5 s)
│   └── bad/                 # unreplayable files and rollback-<stamp>/ set-asides (pruned after 7 days)
├── pmux.lock                # single-instance lock {pid, port, startedAt}
├── remote-transcripts/      # local copies of remote tabs' Claude transcripts (0700; ADR-0022)
│   └── {tabId}/{sessionId}.jsonl, mirror.json
├── logs/                    # pino-roll log files
│   └── purplemux.YYYY-MM-DD.N.log
├── uploads/                 # images attached via web input bar
│   └── {wsId}/{tabId}/{ts}-{rand}-{name}.{ext}
└── stats/                   # Claude usage statistics
    ├── cache.json
    ├── spend-index.json     # spend read model index (ADR-0030; 0600)
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

### `bin/evaluator-sql`, `bin/evaluator-chrome-mcp`, `bin/evaluator-mcp-filter.cjs`, `evaluator/` — `src/lib/tab-role.ts`

Written (one rename each, only when the content differs) whenever an evaluator tab's launch command is built ([ADR-0040](adr/0040-evaluator-tab-role.md)). `evaluator-sql` runs one statement through the user-space psql 18 at `~/.local/lib/pg-client` (outside `~/.purplemux`), with a scrubbed environment, `-X`, `-d service=$PGSERVICE` (the tab's `--pg-service`) and a read-only transaction. It refuses a second argument, a backslash, a second statement, a missing or bad `PGSERVICE`, and a missing psql. `evaluator-chrome-mcp` starts the pinned `chrome-devtools-mcp` on `~/.local/bin/headless-chrome` through `evaluator-mcp-filter.cjs`, which removes the client's `roots` capability so claude's working directory (the repository) is not a file root. It takes the tab's preview URL pattern as its one argument (`--allowedUrlPattern`) and refuses to start without it or on a headless Chrome under 149. Its only file roots are `evaluator/{tabId}/` and `evaluator/{tabId}/tmp/` (its `TMPDIR`), which it creates; nothing prunes them, so screenshots outlive the tab.

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

### `session-tabs.json` — `src/lib/spend/session-tabs-store.ts`

Which tab ran which agent session, for the spend read model (ADR-0030). `{version: 1, bindings:
{"<provider>:<sessionId>": {workspaceId, tabId, tabName?, firstSeenAt, lastSeenAt}}}`, mode 0600, written by
tmp + rename under one lock. Both session-id writers in `src/lib/layout-store.ts`,
`updateTabAgentSessionId` and `updateTabAgentState` (the status manager's hook, launch and poll saves),
record each non-null session after their layout write (a failure is logged and never fails the hook path); the spend indexer seeds it once per boot
from `session-history.json` and every layout's current session ids. `tabName` is the tab's name at the
newest sighting that named one: a sighting under a new name is written even inside the hourly touch interval, and a
sighting without a name keeps the stored one. It names the seat of a tab closed since (harness-flow-loop 04). A session moves to another tab
only on a newer sighting. Bindings last seen before the spend floor (today − 91, UTC) are pruned. A malformed file is refused, never
read as empty or overwritten: spend then attributes no usage to a tab and says why. While the file is
refused, the hook path reads it at most once every 60 s and logs one warning per read, with the path
and the reason. Once the 60 s pass, the next hook save after a repair (or after the file is moved
aside) records again, with no restart. Deleting it loses
the tab attribution of past sessions (their usage stays in its workspace, unattributed per tab).

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

### `owner-grants.json` — `src/lib/grant-store.ts`

Owner grants (ADR-0029): one launch-verified tab reads every workspace and sends notes with
admission `owner`. Same record shape as the drive grants in `grants.json` (`capability: "owner"`,
`workspaces: ["*"]`), read by the same store module with the file as a parameter, but its own
cache and its own lock. Written only by `POST /api/grants` (web session, this server's Origin and
the purplemux password), mode 0600, tmp + rename. At most one grant is active at a time. A release
that predates owner grants never reads this file, and an owner grant never touches `grants.json`,
whose older parser refuses the whole file on one non-`drive` record. A malformed or unreadable
file is refused, never read as empty: no owner grant is honoured, owner grant changes answer 500
`grant-store-unreadable` naming the file, and drive grants keep working. The grant listings
(`GET /api/grants`, `GET /api/cli/grants`, the coordination `grants` section) still list the
readable file's grants and name the refused file in `refused`; an unreadable `grants.json` is
treated the same way. Only both files refused fails the listing (500). Ended grants stay listed 7
days, then the minute sweep prunes them, as in `grants.json`.

### Coordination stores

Each store below is one JSON file, written whole: a tmp file at mode 0600, then a rename. Except for
`workspace-tokens.json`, one promise-chain lock on `globalThis` serializes the writes of each store. If the file is absent, the store is empty. Unless the table says
otherwise, a malformed file is refused, never read as empty: the feature answers an error that names the file until
someone repairs the file or moves it aside.

| File | Owner module | Shape | Retention, and a malformed file |
| --- | --- | --- | --- |
| `grants.json` | `src/lib/grant-store.ts` | `{ grants: IGrant[] }`, drive grants (ADR-0014) | ended grants kept 7 days; malformed: no drive grant is honoured |
| `leases.json` | `src/lib/lease-store.ts` | `{ leases: ILease[] }` (ADR-0011) | a lease ends with its tab, its TTL or a release; malformed: every lease call refused |
| `notes.json` | `src/lib/notes-store.ts` | `{ notes: INote[] }` (ADR-0013) | an open note expires after 14 days; an acked or expired note is pruned 14 days after its last state change |
| `watches.json` | `src/lib/watch-store.ts` | `{ watches: IWatch[] }` (ADR-0015) | a watch ends by its TTL (default 24 h, at most 7 days) |
| `inbox.json` | `src/lib/inbox-store.ts` | `{ items: IInboxItem[] }` (ADR-0012) | an item that is not `queued` is pruned 7 days after its last state change |
| `fleet-config.json` | `src/lib/fleet-config-store.ts` | `{ values: {key: {value, version, setAt, setBy}}, versions: {key: n}, history: change[] }` (ADR-0019) | history keeps the last 200 changes; malformed: every key read refused |
| `deploy-announcements.json` | `src/lib/deploy-announce.ts` | `{ announcements: IDeployAnnouncement[] }` (ADR-0017) | kept 7 days |
| `tab-tokens.json` | `src/lib/tab-token.ts` | `{ [tabId]: { token, workspaceId, sessionName, createdAt, origin?, injectedAt?, presentedAt? } }` | a token ends with its tab; malformed: moved to `tab-tokens.json.unreadable-<ms>` and the server starts empty |
| `workspace-tokens.json` | `src/lib/workspace-token.ts` | `{ [workspaceId]: token }` | written synchronously (tmp + rename) with no lock; read once per process (`globalThis.__ptWorkspaceTokens`); malformed or unreadable: read as empty, and a workspace gets a new token |

The types are in `src/types/{grant,lease,note,watch,inbox,fleet-config,deploy}.ts`. The fleet config keys in use are
listed in the api-guide ("Keys in use").

### `mission-control.sqlite` — `src/lib/mission-control-store.ts`, `src/lib/portfolio-store.ts`

The Mission Control database (better-sqlite3, WAL, so `-wal` and `-shm` files sit beside it). `mission-control-store.ts`
sets the file to 0600 when it opens it and owns the versioned schema (`SCHEMA_VERSION` 4): `runs`, `attention_items`,
`answers`, `deliveries`, `events`, `bootstrap`, `bootstrap_entries`. A newer schema version is refused, never read.
Unversioned side tables are created with `CREATE TABLE IF NOT EXISTS` and carry no foreign key, so a schema-4 release
rolled back onto the file still opens it and ignores them:

- `mission_item_openers` — the tab that opened each item (ADR-0023).
- `mission_auto_answers` — one row per bookkeeping auto-answer (ADR-0031): `answer_id` (primary key), `item_id`,
  `workspace_id`, `rule`, `rule_version`, `applied_option_id`, `at`, `note`. Written in the answer's transaction. The
  rule's answers are also audit lines (`attention-auto-answer`) in `audit/coordination.jsonl`.
- `mission_item_changes` — one row per `attention.updated` (ADR-0037): `item_id` and `revision` (primary key),
  `workspace_id`, `changes_json` (what the revision changed and whether it is compatible), `at`. The answer route reads
  it to accept an answer made on an older compatible revision.
- `mission_answer_suggestions` — an owner message the curator read as an answer (ADR-0042): `item_id` and `entry_id`
  (primary key), `workspace_id`, `span` (the curator's quote, null when withheld), `at`. Served on the item as
  `suggestedAnswers`; never an answer, and the item's revision does not move.
- the `portfolio_*` tables, added by `portfolio-store.ts`, which opens the same file (selection, impacts, events, watch
  uses, watch history unknown, actions, wakes, escalations, milestones).

Not regeneratable: deleting the file loses every run, attention item, answer history and portfolio selection.

### `ledger.sqlite` — `src/lib/ledger-store.ts`

The work-item ledger (ADR-0033; better-sqlite3, WAL, 0600, `user_version` 1; a newer version is refused). A separate
file from `mission-control.sqlite`, so the high-volume feed never couples to the attention store's schema version.
Tables: `events` (append-only; `event_key`, 12 bytes of SHA-256 over the workspace, the producer and its `event_id`, is unique, so a replayed batch or spool is skipped), `items`
(the projection per `(workspace_id, item_key)`), `intervals` (one row per finished wait, written in the transaction of
the event that ends it), `rollups_daily` (per UTC day, item type and reason), `tab_events` (ADR-0035: every nudge, notice, tab send and digest
a tab was sent, with its wake class, its source tab, a flag's rule, and when and in which digest it was delivered; read
with `purplemux events show`), `tab_turns` (story 15, ADR-0035 §7: one row per finished turn of an agent tab, its start
when seen and its acting tool calls; with `tab_events` the input of `purplemux effects show`), `experiments` (ADR-HFL-03), `landings` (one row per range landing the projection applied,
written in the event's transaction; created and filled once from the stored events on the first open of a ledger
without it; harness-flow-loop 04) and `ledger_meta` (rollup progress, each workspace's longest interval, when the first
turn was recorded). A daily job,
10 min after boot and then every 24 h, rolls up every day not yet rolled and every day a newly finished wait covers,
then deletes events, intervals and landings older than 92 days, tab events and tab turns older than 30 days, items closed before
then, and rollups older than 400 days, in chunks of 5,000 rows. Not regeneratable: the events are the record.

`ledger-tokens.json` (`src/lib/ledger-token.ts`) keeps `{ version: 1, tokens: [{ hash, workspaceId, producer,
issuedAt }] }`; the token itself is never stored. Issuing a producer again replaces its entry. The CLI writes the token
to `ledger-tokens/{wsId}/{producer}.json` (or `--out`) and spools undelivered events per producer in `ledger-spool/`;
the next `ledger emit` sends the spool first, and an event the server refuses moves alone to
`{producer}.rejected.jsonl`. `{producer}.drain.lock/` (one drainer, refreshed every batch, stale after 60 s) and
`{producer}.jsonl.lock/` (every change to the spool file, stale after 10 s) are lock directories.

### `curator/` — `src/lib/curator-store.ts`

The local curator (ADR-0038). `state.json`: `{ version: 1, liveSince, tasks: { <task>: { state, promotedAt,
promotedPromptVersion, shadowSince: { <promptVersion>: ms } } }, kodit, rateLimitMs }`. `liveSince` (the first start
of a server carrying the client) anchors the kodit window; each prompt version's 72 h shadow clock is its own first
live call. `eval/<task>.json` holds `{ task, labelledBy, labelledAt, items: [{ id, label, at?, alt? }] }` and never
message text: an id is `<wsId>/<historyEntryId>` (an owner message, read from `message-history.json`, else from `alt`,
its transcript twin `{ ref: <ws>/<session>/<userUuid>, start, length, mode: raw | collapsed, sha }`, a 16-hex
sha256), `<wsId>/<sessionId>/<assistantUuid>` (a turn ending, read from the Claude transcript) or `<wsId>/mc/<itemId>`
(an agent's ask in `mission-control.sqlite`). `at` is the source time; an unreadable item older than 30 days has aged
out. The held-out 30% is a hash of the id, so no split is stored. `eval/<task>.shadow.json` holds `{ rows: [{ id,
promptVersion, predicted, outcome, at }] }`, the predictions of labelled shadow calls; `eval/<task>.queue.json` the
label queue (ids and predictions, plus `excluded`: ids a pass marked no permission ask; the CLI shows ids only). `eval/results/<task>.json` is the latest held-out
evaluation (per-class counts, no per-id prediction); `results/<task>.train.json` and `.all.json` keep the rows of training ids only.
`eval/spot-check.<task>.json` maps the owner's spot-check numbers to ids, written only after the item exists. Every
curator call is also a `tab_events` row (class `log`, kind `curator`) in `ledger.sqlite`; each routing decision once a
task routes is one more (kind `curator-route`, ids and actions only, ADR-0042). `eval/reshape-question.json` holds `{
task, builtBy, builtAt, items: [{ id: <wsId>/mc/<itemId>, at }] }` (`scripts/curator/reshape-set.ts`, read-only on
`mission-control.sqlite`); `results/reshape-question.json` the last reshape evaluation (ids, labels, defect field
names, each draft's sha256, never its text) and `results/reshape-question.judge.json` the judge's verdicts bound to that
run, written only by `curator judge-import`. Regeneratable except the labelled sets and the shadow evidence, which are
labelling passes' output.

### `audit/coordination.jsonl` — `src/lib/coordination-audit.ts`

The coordination audit log: one JSON line per transition, `{ at: ISO-8601, event, … }` (for example `lease-acquire`,
`tab-reap`, `tab-restart`, `tab-over-cap`). The directory is 0700 and the file 0600. Lines are appended under one lock
(`globalThis.__ptCoordinationAuditLock`). At 10 MiB the file rotates to `coordination.jsonl.1`, and the server keeps 3
old files. An audit write that fails is logged and never fails the action it records.
A `lease-release` line names the lease, the `reason` (`released`, `broken`, `expired`, …), the `holder`, and `by`: the
releasing tab or admin token (`{workspaceId, tabId, verified, identity, admin}`), `{human: <session subject>}` when a
human session breaks the lease from Mission Control (ADR-0029 §8), or `null` for a server-made release. A break adds
`breakReason` (at most 500 code points).

The lines added by epic `purplemux-flow` (architecture §4.11):

- `tab-over-cap` (ADR-0027): an orchestrator made an agent tab over the WIP cap. `workspaceId`, `tabId` (the new tab),
  `count`, `cap`, the caller's `reason`, and `by` (`{workspaceId, tabId, verified, identity}`).
- `tab-restart` (ADR-0028): one line per `tab restart`. `workspaceId`, `tabId`, `by` (`{kind: 'agent', workspaceId,
  tabId, identity}` or `{kind: 'human', actor}`), `clear`, `interrupt`, `outcome` (`restarted`, `not-confirmed`,
  `failed`), and when known `resumed`, `reaped`, `abandoned` and `error`.
- `owner-read` (ADR-0029): an owner-grant tab read another workspace. `grantId`, `grantee`, `workspaceId`; at most one
  line per grant and workspace per hour (`OWNER_READ_AUDIT_MS`).
- `owner-note` (ADR-0029 §5): one line per note sent under an owner grant. `grantId`, `noteId`, `from`
  (`{workspaceId, tabId}`), `to`.
- `attention-auto-answer` (ADR-0031): one line per bookkeeping auto-answer. `itemId`, `workspaceId`, `rule`,
  `ruleVersion`, `optionId`, `ageMs` (the item's age when the rule answered it).
- `lease-release` with `by: {human: …}` and `breakReason`: a human lease break (ADR-0029 §8), above.

### `session-stats/{sessionId}.json` — `src/lib/session-stats.ts`

The latest statusline figures of one Claude session (`ISessionStats` in `src/types/timeline.ts`: tokens, cost,
context window, model). `POST /api/status/statusline` merges each statusline into the file, at mode 0600, tmp + rename.
The timeline reads it. At boot the server deletes the files whose session transcript no longer exists. These files are
regeneratable.

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

A tab that `tab restart` relaunched carries `lastRestartAt` (Unix ms, ADR-0028); the fleet row reads it as `restartedAt`. Older releases ignore the field. Each restart also appends one `tab-restart` line to `~/.purplemux/audit/coordination.jsonl`.

See [TMUX.md](./TMUX.md) for how tabs map to tmux sessions and [STATUS.md](./STATUS.md) for the state fields.

### `message-history.json` — `src/lib/message-history-store.ts`

Per-workspace input history for Claude tabs. Capped at 500 entries. Locks are keyed by `wsId` so parallel workspace writes do not block each other.
Each entry is `{ id, message, sentAt, tabId }`: `tabId` is the tab the input sent to (null, or absent before story 36,
when the sender named none). A re-send of the same text keeps the entry's first id and takes the new `sentAt` and
`tabId`, so a reference `<wsId>/<id>` holds. `purplemux owner messages -w WS [--since ISO]` lists it (ADR-0042 note).

### `claude-prompt.md` — `src/lib/claude-prompt.ts`

The `--append-system-prompt-file` content passed to every Claude tab in the workspace. Regenerated whenever the workspace is created, renamed, or its directories change, before every Claude launch (tab create, restart, resume), and when a standing order changes. Contains workspace ID + CLI quick-reference + the active standing orders (ADR-0041).

### `workspaces/{wsId}/spec-queue.md` — `src/lib/spec-queue.ts`

Product rules the owner stated in chat, filed by the curator once `classify-owner-message` routes in that workspace
(ADR-0042; ADR-HFL-05 decision 7). A header, then one block per message: `## <historyEntryId>`, `- at: <UTC>`,
`- source: owner message <ws>/<id>`, and the message as a blockquote. Appends go through one host lock; a repeated id is
left as it is. Read by hand and by the next slice contract (ADR-HFL-07). Not regeneratable.

### `standing-orders.md` — `src/lib/standing-orders-store.ts`

The owner's standing orders (ADR-0041), one file for the fleet (`~/.purplemux/standing-orders.md`) and one per
workspace. Each `## SO-<n>` block carries `text`, `source` (the owner message and its UTC date), `scope`, `check` (a
hook or test, or `prose`), `state` (`active` or `struck`), `added`, and `struck` once struck. Ids are unique across
every file. The active orders of the fleet and the workspace are written into `claude-prompt.md`; together they may
take at most 8 KB there. A missing fleet file is created with the W8 seed orders; a missing workspace file holds
none; a file in another layout (or empty, or without its `# Standing orders:` header) is refused, never read as empty. The seed is
written under the host lock, every write is tmp + rename with a name of its own, and `standing-orders-seq.json`
(`{ "high": n }`) keeps the highest id ever handed out, so an id is never reused even when its workspace directory
is removed. Written with `purplemux so add|strike`.

### `standups.json` — `src/lib/standup-store.ts`

Orchestrator standup ticks, newest first, capped at 50. The latest tick renders in the
workspace sidebar; `StatusManager` hydrates from this file on boot so "where are things
at" survives a server restart. See STATUS.md → Standup Ticks for the full flow.

### `board-goal.json` — `src/lib/board-goal-store.ts`

The workspace's goal (`{ label, items, setAt, setBy }`, mode 0600), written by `purplemux board goal set` and removed
by `board goal clear`. The constraint finder reads it on each tick and forecasts the on-track line from it. A file that
does not hold a goal is an error the tick logs; it is never read as "no goal set" by the store.

### `burndown.json` — `src/lib/burndown-store.ts`

The latest epic burndown the workspace published with `purplemux burndown publish`
(`{ workspaceId, receivedAt, snapshot }`, mode 0600). Each publish replaces the file; the
snapshot is validated by `src/lib/burndown.ts`, history keeps the newest 2000 rows, and the
file is at most 1 MiB. The portfolio board reads the selected Scrum Master's workspace file
through `GET /api/mission-control/burndown`. A file that does not validate is reported as a
storage error, never read as "nothing published".

### `flow.json` — `src/lib/flow-store.ts`

The latest pipeline snapshot the workspace published with `purplemux flow publish`, plus the
history the server keeps for it (`{ workspaceId, receivedAt, snapshot, history }`, mode 0600,
ADR-0026). The snapshot is validated by `src/lib/flow.ts`. Each publish replaces the snapshot and
appends one history row the server derives from it; history keeps the newest 2000 rows and the
file at most 4 MiB, the oldest rows dropped first. Writes are serialized per workspace
(`globalThis.__ptFlowLocks`); parsed records are cached by mtime and size
(`globalThis.__ptFlowReadCache`). A file that does not parse or re-validate is reported as a
storage error (`flow-unreadable`), never read as "no flow published". The next publish keeps it aside
as `flow.json.corrupt-<receivedAt>` (a hard link, kept for inspection, never read again), then
replaces `flow.json` and starts a fresh history. Read through `GET /api/cli/workspaces/{wsId}/flow` and `GET /api/mission-control/flow`.

### `liveness.json` — `src/lib/liveness-store.ts`

The workspace's liveness probes and background jobs: `{ probes: ILivenessProbe[], jobs: IBackgroundJob[] }`
(`src/types/liveness.ts`), mode 0600, tmp + rename, one lock per workspace (`globalThis.__ptLivenessLocks`).
`purplemux tab probe set` and `tab bg add` write it; the watchdog reads it. The orchestrator-presence monitor and the orchestration
work-state check read it strictly: a malformed file is unknown evidence, never "no jobs". The other readers log the
error and read it as empty.

### `codex-prompt.md` — `src/lib/providers/codex/prompt.ts`

The Codex counterpart of `claude-prompt.md`: the workspace ID and the CLI quick reference. A Codex launch passes the
content as `-c developer_instructions=…`. Rewritten only when the content changes; written with the default mode.

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
| `cache.json` | `IStatsFileCache` — per-day aggregates (messages, sessions, tool calls, hourly counts, per-model token usage). Cache version `3` (`CACHE_VERSION` in `stats-cache.ts`). Main transcripts only: subagent transcripts are not counted here. |
| `spend-index.json` | The spend read model's index (`src/lib/spend/spend-index.ts`, version 1, 0600, tmp + rename). Per transcript: `size`, `mtimeMs`, `ino`, the byte `offset` after the last complete line, the last 256 message ids, and usage buckets per UTC day, model, session and UTC 5-minute `slot` (harness-flow-loop 04; a live entry indexed before slots, without `slotted: true`, is read again from 0 once, and a gone one keeps its day buckets with no slot); Codex and Grok sessions keep one usage figure. Covers the main transcripts, the subagent transcripts (any `.jsonl` below `<project>/<sessionId>/subagents/`), `~/.codex/sessions` and every grok home. Built in the background (first pass 120 s after boot, newest file first, one file at a time; rescan every 5 min; written at most every 60 s and at the end of a pass). A transcript that leaves the disk (`ENOENT`/`ENOTDIR` on its own stat; any other error changes nothing) keeps its entry with `goneAt` set and its usage, until its days pass the spend floor (today − 91, UTC); a path that comes back is read again from 0. So this file is **not** purely regeneratable: deleting it loses the usage of transcripts already deleted (at most 92 days). A damaged file is moved to `spend-index.json.corrupt-<ms>` and rebuilt from the transcripts still on disk; until the rebuild ends spend reports `indexing`. |
| `uptime-cache.json` | Per-day uptime/active-minutes roll-up. |
| `daily-reports/{date}.json` | AI-generated daily brief (`IDailyReportDay`) keyed by `YYYY-MM-DD`. |

All files here except `spend-index.json` are regeneratable — deleting them just triggers a recompute on the next stats request.

---

## Deleting to Reset

| To reset… | Delete |
| --- | --- |
| Login password (onboarding again) | `config.json` |
| All workspaces and tabs | `workspaces.json` + `workspaces/` |
| A single workspace's layout | `workspaces/{wsId}/layout.json` (it will be recreated as a default pane) |
| Usage statistics | `stats/` (also drops the spend usage of transcripts already deleted) |
| Push subscriptions (Web Push + FCM) | `push-subscriptions.json` |
| Stuck "already running" | `pmux.lock` (only if no purplemux process is alive) |

`hooks.json`, `status-hook.sh`, `codex-hook.sh`, `grok-hook.sh`, `statusline.sh`, `port`, `cli-token`, `vapid-keys.json` are auto-regenerated on the next startup.

Deleting `$GROK_HOME/hooks/purplemux.json` is safe — it is regenerated on the next startup, and it is
the only file in that directory purplemux owns. Deleting a workspace `grok-home/` discards that
workspace's grok session history; the shared credentials and configuration it links to are untouched.

Coordinator settings in `workspaces.json` include an optional legacy `orchestration.revision`. Reads expose absent revision as zero; only a successful semantic mapping/config change persists the next safe integer. Unknown future settings survive updates. Recovery never writes a separate identity sidecar or converts missing layout identity into proof of death.
