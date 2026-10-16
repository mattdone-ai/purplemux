# Claude CLI Work-State Detection

The chat input availability notice distinguishes terminal connectivity from
agent work state. A disconnected terminal shows `Connecting...`; a connected
terminal with disabled input shows the provider's inactive-session message.
It does not show a connection spinner solely because `cliState` is inactive.
This is a presentation rule; it does not change the work-state transitions below.

System that detects the in-progress state of the Claude CLI on the server, broadcasts it to the client over WebSocket, and reflects it in the UI indicators.

**Core principle**: `cliState` has a **single source of truth — hook events** (real Claude Code hooks + one hook-equivalent synthesized on the server from the JSONL interrupt marker). All transitions go through `deriveStateFromEvent`, and seq is monotonic per tab. The previous multi-source heuristics (JSONL-driven promotion, pane capture, client-side local derivation) have otherwise been removed; JSONL is only consulted for the synthetic `interrupt` event and for metadata (snippet, currentAction).

---

## State Definitions

### Agent Process State (`agentProcess: boolean | null`)

Determines whether the agent CLI process (Claude, Codex, …) is running inside a tmux pane. Managed independently from `cliState` and detected from two paths (terminal WS and timeline WS).

| Value | Meaning |
| --- | --- |
| `null` | Not yet detected (initial value) |
| `true` | Agent process is running |
| `false` | No agent process |

A separate `agentInstalled: boolean` field (default `true`) gates the entire UI; if `false`, a "Claude not installed" screen is shown.

Two detection paths:

| Path | Trigger | Server check | Sets value |
| --- | --- | --- | --- |
| Terminal WS `onTitleChange` | tmux title change | `/api/check-claude` → `isClaudeRunning()` | `true` / `false` |
| Timeline WS | Session file change | `detectActiveSession()` | `true` / `false` |

Both paths write to the same `agentProcess` field; the `agentProcessCheckedAt` server timestamp prevents stale updates.

The server-side `detectActiveSession` still uses its own `TSessionDetectionStatus` type internally; the client-facing mapping is: `running`/`starting` → `true`, `not-running` → `false`, `not-installed` → `agentInstalled = false`.

### CLI Work State (`TCliState`)

State of the work in progress inside the Claude CLI. Only changed by deterministic derivation from hook events.

| State | Meaning | Trigger |
| --- | --- | --- |
| `busy` | Processing a user request | `prompt-submit` hook |
| `idle` | Response complete + acknowledged by user | `session-start` hook, synthetic `interrupt` event, or `dismissTab` |
| `ready-for-review` | Response complete, awaiting user ack | `stop` hook |
| `needs-input` | Permission prompt / awaiting user input | `notification` hook |
| `unknown` | Was `busy` before a server restart, recovery not finished | Awaiting `resolveUnknown` |
| `inactive` | Initial state when the Claude process is not running | Default on tab creation |
| `cancelled` | User is deleting the tab | Client-only local state |

### Transition Rules (`deriveStateFromEvent`)

Pure function. `src/lib/status-manager.ts`:

```ts
export const deriveStateFromEvent = (event: ILastEvent | null, fallback: TCliState): TCliState => {
  if (!event) return fallback;
  switch (event.name) {
    case 'session-start': return 'idle';
    case 'prompt-submit': return 'busy';
    case 'notification':  return 'needs-input';
    case 'stop':          return 'ready-for-review';
    case 'interrupt':     return 'idle';
  }
};
```

`'interrupt'` is the only event name that does not correspond to a real Claude Code hook. Claude CLI does not fire any hook when the user presses Esc mid-stream, so the JSONL watcher synthesizes one on the server when it sees a `[Request interrupted by user]` entry (see "Synthetic Interrupt Event").

**Exception**: if `prevState === 'cancelled'`, the state stays `cancelled` even when a hook arrives.

**`inactive` handling**: it is just a default value, not a non-overwritable state. Even when a new tab starts in `inactive`, the first `session-start` hook promotes it to `idle`. (Previously both `inactive` and `cancelled` blocked transitions, which caused a bug where "start new conversation" would be stuck on `Creating new conversation...`. The `inactive` block was removed for that reason.)

### Releasing `ready-for-review`

The `ready-for-review → idle` transition only happens through the **`dismissTab` action**:

- The user focuses the tab (auto-dismiss)
- An explicit dismiss from the notification sheet

Hooks and the JSONL watcher do not cause this transition.

### Releasing `needs-input` (User Selection Ack)

When the user selects an option on a permission prompt, Claude resumes work but does not fire a `prompt-submit` hook. Therefore the `needs-input → busy` transition cannot be detected from hooks alone, so the client sends an explicit ack.

**Flow**:

1. `PermissionPromptItem.handleSelect` — after `sendSelection` succeeds, sends a `status:ack-notification` WS message with the current `lastEvent.seq`
2. `StatusManager.ackNotificationInput(tabId, seq)`:
   - If `cliState !== 'needs-input'`, ignore
   - If `lastEvent.name !== 'notification'` or `lastEvent.seq !== seq`, ignore (a newer hook has already arrived)
   - Otherwise: `applyCliState(busy)` + `persistToLayout` + `broadcastUpdate`

**Meaning of the seq guard**: if another hook (consecutive `notification` or `stop`) arrives before the ack does, `entry.lastEvent.seq` increments and no longer matches the ack → ignored. Since the server has already moved to a newer state, the late ack cannot overwrite it (race protection).

`eventSeq` is not incremented — this is a client action, not a hook event. The next real hook will arrive with a value larger than the current seq and be processed normally.

### Tab Display State (`TTabDisplayStatus`)

`selectTabDisplayStatus(tabs, tabId)` maps `cliState` to a UI display value:

| cliState | Display state | UI indicator |
| --- | --- | --- |
| `busy` | `busy` | Spinner |
| `ready-for-review` | `ready-for-review` | Purple dot (pulse) |
| `needs-input` | `needs-input` | Amber dot (pulse) |
| `unknown` | `unknown` | Gray dot (static) |
| `idle` | `idle` | None |
| `inactive` | `idle` | None |
| `cancelled` | (component-specific) | — |

### Fleet status (ADR-0023)

Mission Control's fleet status panel reads the same entries server-side (`getAllForClient()` plus `fleetFacts(tabId)`, which
returns the transcript path and whether the watchdog's `stuck` nudge went out for the current busy stretch). It refines
`busy` into `working` and `waiting` (the `turnEnd` of the latest stop), and `ready-for-review` / `idle` into `ended` when
that stop carried an end line. It changes no state. To keep that true across a restart, `persistTurnEnd` writes an
end-line (`turn-marker`) stop to `ITab.watchdogTurnEnd` as well as a markerless one, and `applyRestoredStop` gives it
back to a tab restored `ready-for-review`, or `idle` when its `dismissedAt` is newer than the stop, in the same agent
session; it sends no nudge.

### Session View (`TSessionView`)

Stored directly in the tab state (not derived). Decides which screen the Claude panel shows.

| State | Meaning | Enter condition | Exit condition |
| --- | --- | --- | --- |
| `session-list` | Browsing past sessions | Default. Also entered when `agentProcess` transitions `true → false` while in `timeline` | User clicks new/resume → `check` |
| `check` | Terminal preparation + agent start | User action (new conversation, resume, mode switch) | `agentProcess` becomes `true` → auto-transition to `timeline` |
| `timeline` | Active conversation | Auto from `check` when `agentProcess = true`. Also set directly on initial load if `agentProcess = true` | `agentProcess` transitions `true → false` → auto-transition to `session-list` |

The auto-transitions are handled inside `setAgentProcess`: when `agentProcess` becomes `true` and `sessionView` is `'check'` or `'session-list'`, it flips to `'timeline'`; when `agentProcess` transitions **`true → false`** (agent was confirmed running and then exited) and `sessionView === 'timeline'`, it flips to `'session-list'`. A `null → false` transition does **not** flip, so a freshly opened resume tab stays on `'check'` during initial shell detection until the actual agent process comes up. Additionally, `useTimeline` no longer infers `agentProcess = true` from `timeline:init` alone (JSONL existence ≠ process running) — the store's `agentProcess` is driven by `timeline:session-changed` (`reason='session-waiting'`, only sent when the server confirms a running agent) and by the terminal `onTitleChange` → `/api/check-claude` path.

Gates (checked before the view switch):
- `agentInstalled === false` → not-installed screen
- `agentProcess === null && view !== 'check'` → loading spinner

---

## Tab Store (`useTabStore`)

A Zustand store that manages all tab state as `Record<tabId, ITabState>`.

### Key Fields

| Field | Type | Source | Purpose |
| --- | --- | --- | --- |
| `terminalConnected` | `boolean` | Terminal WS | Whether input is allowed |
| `agentProcess` | `boolean \| null` | Terminal/Timeline WS | Process presence (`null` = not yet detected) |
| `agentProcessCheckedAt` | `number` | Server timestamp | Prevent stale updates |
| `agentInstalled` | `boolean` | Timeline WS | Gate for "not installed" screen |
| `sessionView` | `TSessionView` | User action / auto-transition | Which screen to show |
| `cliState` | `TCliState` | Server WS (`status:update` / hook derivation) | Work state, tab indicator |
| `lastEvent` | `ILastEvent \| null` | Server WS (`status:hook-event`) | Track event order, trigger PermissionPrompt re-fetch |
| `eventSeq` | `number` | Server WS | Monotonic counter to prevent reordering |
| `isTimelineLoading` | `boolean` | Timeline WS init received | Whether timeline data is still loading |
| `compactingSince` | `number \| null` | `pre-compact`/`post-compact` hooks | Drives the timeline compacting indicator |

### Write Paths

| Path | Action | Notes |
| --- | --- | --- |
| Server sync (`status:sync`) | `syncAllFromServer` | Initial load, `cancelled` protected |
| Server update (`status:update`) | `updateFromServer` | Metadata + cliState, `cancelled` protected, **stale seq preserves cliState/busySince/readyForReviewAt/dismissedAt** |
| Server event (`status:hook-event`) | `applyHookEvent` | Updates only `lastEvent`/`eventSeq`, prevents seq reordering |
| User dismiss | `dismissTab` | Local immediate `ready-for-review → idle` + WS `status:tab-dismissed` |
| User tab delete | `cancelTab` | `cliState = 'cancelled'`, local only |

**The client never propagates `cliState` back to the server.** The legacy `notifyCliState` / `status:cli-state` paths have been removed.

### Stale Seq Guard in `updateFromServer`

When `status:update` arrives with `update.eventSeq < existing.eventSeq`, the broadcast is a metadata-only message that was queued behind a newer seq-bearing event. In that case `updateFromServer` preserves `cliState`, `busySince`, `readyForReviewAt`, and `dismissedAt` from the existing state and merges only the non-state metadata fields. This prevents a late `busy` metadata broadcast from clobbering an `idle` state that a higher-seq `interrupt` (or any future event) already set.

### `isCliIdle()` Helper

Both `idle` and `ready-for-review` mean "waiting for work", so:

```ts
export const isCliIdle = (cliState: TCliState): boolean =>
  cliState === 'idle' || cliState === 'ready-for-review';
```

Used in: `WebInputBar` input mode, restart-complete detection, dismiss-on-focus.

---

## Claude Code Hook System

Uses Claude Code's [Hook](https://docs.anthropic.com/en/docs/claude-code/hooks) feature to receive Claude's work state immediately.

### Hook Settings

`ensureHookSettings()` runs at server startup and creates `~/.purplemux/hooks.json`.

| File | Purpose |
| --- | --- |
| `~/.purplemux/hooks.json` | Hook event → shell script mapping |
| `~/.purplemux/status-hook.sh` | Script that POSTs to the server |
| `~/.purplemux/port` | Current server port (referenced by the script) |

### Hook Event Mapping

| Claude Code Hook | Sent event | Result |
| --- | --- | --- |
| `SessionStart` | `session-start` | → `idle`; with `source: compact` (an auto-compaction mid-turn, L30) no change and no nudge |
| `UserPromptSubmit` | `prompt-submit` | → `busy` |
| `Notification` | `notification` | → `needs-input` (filtered by notificationType) |
| `Stop` | `stop` | → `ready-for-review` |
| `StopFailure` | `stop` | → `ready-for-review` |
| `PreCompact` | `pre-compact` | → `compactingSince = now` (cliState unchanged) |
| `PostCompact` | `post-compact` | → `compactingSince = null` (cliState unchanged) |
| _(synthesized by JSONL watcher)_ | `interrupt` | → `idle` (see below) |

`pre-compact`/`post-compact` do not touch `cliState`/`eventSeq`/`lastEvent`; they only set the separate `compactingSince` field. That value drives the timeline-view's compacting indicator (60s window). To handle a missing `post-compact`, the server auto-clears it via a `COMPACT_STALE_MS = 60s` timer.

### Notification Filtering (`INPUT_REQUESTING_NOTIFICATION_TYPES`)

Claude's `Notification` hook fires at many moments, but only cases that need user input should transition to `needs-input`. The whitelist in `status-manager.ts`:

```ts
const INPUT_REQUESTING_NOTIFICATION_TYPES = new Set(['permission_prompt', 'worker_permission_prompt']);
```

The hook script parses `notification_type` from the stdin JSON and includes it in the payload, so the server ignores types that are not in the whitelist (e.g. idle notifications) without transitioning state.

### Hook Script

`~/.purplemux/status-hook.sh` is generated from `HOOK_SCRIPT_CONTENT` in `hook-scripts.ts`. Core behavior:

- Looks up the session name with `tmux display-message` (so the server knows which tab)
- If `event === 'notification'`, parses `notification_type` from stdin JSON and includes it in the payload
- POSTs `{ event, session, notificationType?, source? }` to `/api/status/hook` via `curl` (`source` is SessionStart's, a plain word only)
- When no server answers, writes the event to `~/.purplemux/hook-spool/` with the time the hook fired (see "Hook Spool" below)

### Synthetic Interrupt Event

Claude CLI aborts a streaming turn locally when the user presses Esc and writes `[Request interrupted by user]` into the transcript JSONL without firing any hook (`query.ts:createUserInterruptionMessage`). To recover `busy → idle` without leaving the tab stuck, `onJsonlFileChange` synthesizes a hook-equivalent `interrupt` event:

1. `scanLines` sets `interrupted: true` when the last non-sidechain user entry's first content block starts with `[Request interrupted by user` (see `INTERRUPT_PREFIX`). This naturally handles the "user typed a new prompt right after Esc" case — the new user entry becomes the last match and suppresses the synthesis.
2. `onJsonlFileChange` fires `updateTabFromHook(tmuxSession, 'interrupt')` when **all** of the following hold:
   - `entry.cliState === 'busy'`
   - `scan.lastEntryTs > entry.lastInterruptTs` (dedup: new interrupt line, not a previously processed one)
   - `scan.lastEntryTs > entry.lastEvent.at` (race guard: no real hook arrived after the interrupt was written)
3. `updateTabFromHook` goes through the usual path — bump `eventSeq`, broadcast `status:hook-event`, apply `deriveStateFromEvent → 'idle'`, `persistToLayout`, `status:update`. Push notifications are skipped because only `ready-for-review`/`needs-input` trigger push.

The `lastEvent.at` comparison protects against a narrow race: `prompt-submit` hook POST arriving at the server before the JSONL FS event fires for the interrupt line. Without the guard, the synthetic interrupt could fire after `prompt-submit` was already processed and drag the state back to `idle`.

After transitioning to `idle`, `applyCliState` stops the JSONL watcher (idle is not a watched state). It will be restarted by the next `prompt-submit` hook.

### Grok Hook Mapping

Grok Build reaches the same endpoint with `?provider=grok`, and its payload is translated by
`src/lib/providers/grok/hook-payload.ts`. The envelope's keys are camelCase (`hookEventName`,
`sessionId`, `notificationType`, `toolResult`) while the `hookEventName` VALUE is snake_case
(`session_start`, `stop_cancelled`); the translator normalises both spellings.

| grok hook | Sent event | Result |
| --- | --- | --- |
| `SessionStart` | `session-start` | → `idle`, and publishes session info (`sessionId`, `cwd`) |
| `UserPromptSubmit` | `prompt-submit` | → `busy`; the prompt becomes `lastUserMessage` + the tab summary |
| `Stop` | `stop` | → `ready-for-review` |
| `StopFailure` | `stop` | → `ready-for-review` |
| `StopCancelled` | `interrupt` | → `idle` |
| `SessionEnd` | `interrupt` | → `idle` |
| `PreCompact` | `pre-compact` | → `compactingSince = now` (cliState unchanged) |
| `PostCompact` | `post-compact` | → `compactingSince = null` (cliState unchanged) |
| `PostToolUse` | _(no state event)_ | feeds `handleToolActivity`, like Claude's `post-tool` |
| `Notification` `permission_prompt` | `notification` | → `needs-input`, **except always-approve / `bypassPermissions` / yolo** (auto-resolve with `wait_ms: 0`; treating those as a wait stranded the tab for the rest of the turn) |
| `Notification` `idle_prompt` / `task_complete` | `stop`, **only while the tab is busy** | → `ready-for-review` |

Three rules are specific to grok and are deliberate:

- **`StopCancelled` runs INSTEAD of `Stop`** when a turn ends without completing — a user interrupt,
  a declined permission prompt, the turn limit, or a no-progress bail-out — so it is the interrupt
  signal, not a second stop.
- **`idle_prompt` is a backstop, not a turn end.** grok fires it about a minute after a session
  settles, after interrupted and errored turns too, and it is the only report for the turns that
  produce none of the three stop events. Settling on it unconditionally would drag a tab the user has
  since re-prompted back out of `busy`, so `shouldEmitGrokHookEvent` only lets it through while the
  tab is still `busy`.
- **A subagent's events are dropped.** Every event that can fire inside a subagent carries
  `subagentType`, and a background subagent outlives the parent turn; reporting its stop would settle
  the tab while the session is still working.

purplemux registers no blocking `Stop` gate, so grok's `Stop` fire is a genuine turn end rather than
a continuation round.

Codex's TUI-ready detector (`checkCodexTuiReady`) is **not** applied to grok, and neither is the
Claude fallback below: grok's composer marker (`[›❯>]`) also matches a bare `>` line, and no real grok
pane is pinned yet (story 30 F8).

Claude readiness fallback (story 17, L8): a `claude-code` tab that stays `inactive` for more than 8 s
(`READINESS_PROBE_AFTER_MS`) while its agent process runs gets one pane capture per poll. The clock
runs only while the agent runs, restarts on every launch (`markAgentLaunch`), and also waits 8 s past
`lastResumeOrStartedAt`; launch polls at 9.5 s and 12 s reach it without the interval poll. The
capture is the pane at its own size with escapes (no resize). If it shows an empty composer and no
option list (`paneShowsEmptyComposer`, the check the inbox runs, with the dim suggestion or
placeholder removed), and the tab is still `inactive` with no event since the probe began, the poll
fires a synthetic `session-start` and logs `readiness: pane-probe`. A trust prompt (`❯ No, exit`) and
the first-run picker (`❯ 2. Dark mode`) stay `inactive`. Fixtures: `tests/fixtures/panes/`. A fresh
Claude's composer placeholder (`Try "…"`) is dim, so a capture without escapes reads it as typed text.

A session id the poll detects (`detectActiveSession`) is persisted to the layout when no hook bound
one, so `tab status` and `tab list` show it after a restart. The poll may move a binding it wrote
itself (a `/clear` with no hooks), never one a hook or a launch set.

### Agent Tab Hooks (Reference)

Normal tabs go through the shell script above, but **agent tabs / brain sessions** use `type: 'http'` hooks generated by `buildAgentTabHookSettings` / `buildAgentBrainHookSettings`, which POST directly to `/api/agent-rpc/{agentId}/...` (only `Stop` / `StopFailure`). They are separate from the StatusManager path and are out of scope here.

### Hook API Endpoint

`/api/status/hook` — requires `x-pmux-token` header (same CLI token as `/api/cli/*`). Pure forward: emits the raw payload onto the per-provider EventEmitter (`globalThis.__ptClaudeHookEvents` for Claude, `globalThis.__ptCodexHookEvents` for Codex). The provider observer (attached per tab via `IAgentProvider.attachWorkStateObserver`) is the sole listener — it translates the payload, applies any provider-specific meta side effects, and forwards a `TAgentWorkStateEvent` to `StatusManager.handleObserverEvent`, which dispatches into `updateTabFromHook`. If `event` is `poll` or `session` is missing on the Claude path, the endpoint triggers a full poll directly.

### Processing Flow (`updateTabFromHook`)

```
hook received
  │
  ├─ look up tabId/entry (return if missing)
  ├─ check event whitelist (session-start/prompt-submit/notification/stop)
  │
  ├─ entry.eventSeq += 1
  ├─ entry.lastEvent = { name, at: Date.now(), seq }
  ├─ broadcast status:hook-event (seq + name + at)
  │
  ├─ newState = deriveStateFromEvent(entry.lastEvent, prevState)
  │   (if prevState === 'cancelled', stays the same)
  │
  └─ if prevState !== newState:
      ├─ applyCliState(tabId, entry, newState)
      ├─ persistToLayout(entry)
      └─ broadcast status:update
```

After a `stop` event, `refreshSnippet` asynchronously reads the final JSONL state and broadcasts `currentAction` / `lastAssistantSnippet` (with a 500ms delay).

### Event Shadowing (`status:hook-event`)

`status:hook-event` is **always** broadcast even if `cliState` doesn't change (e.g. consecutive `notification` while already in `needs-input`). The client only applies it in `applyHookEvent` when `event.seq > prev.eventSeq`, preventing reordering.

`PermissionPromptItem` subscribes to `lastEvent.seq` as a `useEffect` dep so that consecutive permission prompts auto-refetch new options:

```
Consecutive permission prompts:
prompt-submit → lastEvent{name:'prompt-submit', seq:1} → busy
notification  → lastEvent{name:'notification', seq:2}  → needs-input
user selection
notification  → lastEvent{name:'notification', seq:3}  → needs-input (same cliState, seq++)
stop          → lastEvent{name:'stop', seq:4}          → ready-for-review
```

### Hook Spool (ADR-0020)

The route's handler is `dispatchHook` (`src/lib/hook-dispatch.ts`). A live POST calls it without
`replayedAt`; `drainHookSpool` (`src/lib/hook-spool.ts`) calls it with each spooled event's time.
`init` does not drain, and a drain is a no-op until `init`'s scan has built the tabs and while a
rescan rebuilds them (the files wait). `server.ts` calls `startBootHookSpoolDrains()` once the
server listens and has written its port file, never awaited: one drain at once, one 5 s later.
Both wait for a scan in flight (a rescan) instead of skipping it.
`bootHookSpoolDrained()` settles when the first one has finished; the inbox skips its ticks until
then, at most 10 s (`startInbox({ firstTickAfter })`). Every `poll()` starts a drain too and never
awaits it; one drain runs at a time and yields every 50 files. Files apply oldest first and are
deleted when applied; unreadable ones, replays that throw, and replays not finished within
`HOOK_REPLAY_EVENT_TIMEOUT_MS` (5 s) move to `hook-spool/bad/` once. A drain that found files logs
one `hook spool drain:` line (applied, stale, timed out, bad, duration).
Files past `HOOK_REPLAY_WINDOW_MS` (1 h) and metadata-only files (body over 256 KiB) are deleted
without dispatch. A replayed Codex hook passes `withReplayedCodexHookGeneration`: the recorded
active generation and the launch the status manager tracks (`codexLaunchLifecycle`), with no process
proof and no target lock, and it never holds the generation. A replayed legacy Codex hook (no
generation) is skipped; a skipped replay is recorded by `recordSkippedReplay` as a stale one.

`replayedAt` threads through `handleProviderEvent`, `updateTabFromHook`, `applyAgentHookMeta` and
`handleToolActivity`:

- `hookFloors` (`HookFloorStore`, `src/lib/hook-floors.ts`) holds each tab's floor: the latest
  applied hook STATE event time (live: receipt time; replayed: `at`), or a restored watchdog stop's
  `at`. Metadata patches are ordered against it but never raise it. It is saved in
  `hook-spool/.floors.json` (temporary file + rename, at most once per 5 s, and on shutdown, which
  `gracefulStatusShutdown` awaits), never in the layout, and sends no sync message. `init` loads it
  before the scan and drops the floors of tabs that no longer exist.
- A replayed event older than the floor, or past the replay window, is recorded in
  `getHookHistory(tabId)` with `stale: true` and changes nothing: no `lastEvent`, no `cliState`,
  no metadata, no broadcast.
- Otherwise it applies like a live event, dated at `at`: `lastEvent.at`, `lastResumeOrStartedAt`,
  `compactingSince`, and a stop's `turnEnd.at`, so the turn end is classified and nudged as it
  would have been and the idle clock counts from the real stop.
- Tool activity replays into the signal engine whatever the tab's latest event (it is history, not
  state), unless it is past the replay window.

---

## Server Restart Policy

The only state that can be lost across a server restart is `busy` (Claude might fire `stop`/`notification` while the server is down). All other states have "the ball in the user's court", so no automatic transitions occur and the persisted value can stay as-is.

`StatusManager.scanAll` reads the persisted `cliState` from the layout:

| Persisted cliState | After restart | Follow-up |
| --- | --- | --- |
| `busy` | **`unknown`** | `resolveUnknown` scheduled immediately |
| `needs-input` | unchanged | JSONL watcher started |
| Others | unchanged | — |

### `resolveUnknown` — Background Recovery for Unknown Tabs

For tabs converted to `unknown` from `busy`, only definitive signals are used to promote:

1. **Claude process check** — `isClaudeRunning(panePid)` fails → confirm `idle` (silent, no push)
2. **JSONL tail check** — `checkJsonlIdle` returns `idle && !stale && lastAssistantSnippet` → confirm `ready-for-review` (silent)
3. **Otherwise** → keep `unknown`, wait for the next hook

**Pane capture is not used.** A previous permission prompt left in the scrollback could be misread as the current one.

JSONL watcher is also started in the `unknown` state — it does not change `cliState`, but `currentAction` / `lastAssistantMessage` metadata keep updating.

### Busy Stuck Safety Net

If a `busy` state lasts longer than `BUSY_STUCK_MS` (**10 minutes**) and the agent process has died, silently recover to `idle`. Performed inside the metadata poll loop. Designed to handle dropped `stop` hooks (e.g. SIGKILL).

### Agent-Gone Inactive Guard (F1/F2)

For agent tabs in any active state (`busy` / `idle` / `needs-input` / `ready-for-review`), the metadata poll silently transitions to `inactive` only when **all** of the following hold:

1. The agent process is not running for the pane (`provider.isAgentRunning(panePid)` returns `false`).
2. **F1 — recent-launch grace fails**: `lastResumeOrStartedAt` is undefined or older than 5 seconds. The stamp is refreshed by auto-resume `sendKeysSeparated`, the synthetic and real `session-start` hooks, and any other path that calls `StatusManager.markAgentLaunch`. This blocks the brief boot window where the Rust binary (e.g. Codex) has spawned but the process tree has not yet caught up.
3. **F2 — pane title is shell-style**: the title looks like `<cmd>|<path>` (i.e. tmux's `set-titles-string` default) or is empty. Agent CLIs override this to their own format, so a non-shell title is treated as "agent still owns the pane" and skips the transition. This blocks the false negative when an agent forks a transient child mid-poll.

Together these guards keep the `cliState` stable through the boot/fork windows that previously caused indicator ping-pong, while still recognizing a clean exit (`/quit`, `/exit`) within one poll cycle.

---

## JSONL Watcher (Metadata Only)

For tabs in `busy` / `needs-input` / `unknown` / `ready-for-review`, an `fs.watch` is set on the JSONL file and `checkJsonlIdle` is called on file changes.

| Trigger | Action |
| --- | --- |
| Start | Entering `busy`/`needs-input`/`unknown`, or discovering/rebinding that state's JSONL path during a hook or metadata poll. Codex immediately ingests the latest quota event when the watch binds. |
| Process | Updates only `currentAction`, `lastAssistantMessage`, reset signals → broadcast `status:update` |
| Release | Transition to `idle`/`inactive`, tab deletion, shutdown |

**Key**: the JSONL watcher normally touches only metadata. The one exception is the synthetic `interrupt` event (see "Synthetic Interrupt Event") — it is the only path where the JSONL watcher drives a `cliState` transition, and it does so by going through the standard `updateTabFromHook` pipeline rather than bypassing it. There used to be an automatic `busy → ready-for-review` promotion path, but that was removed; only the `stop` hook triggers `ready-for-review`.

---

## Metadata Poll

A **metadata-only** poll that does not touch `cliState`.

### Cadence

| Tab count | Interval |
| --- | --- |
| 1–10 | 30s |
| 11–20 | 45s |
| 21+ | 60s |

### Cost per poll

| Operation | Count |
| --- | --- |
| `tmux list-panes -a` | 1 (single batch) |
| Filesystem reads (workspace/layout JSON) | workspace count + α |
| Process check (`pgrep`/`ps`) | only for tabs caught by the busy stuck check |
| JSONL tail read | 1 per newly discovered tab (existing tabs go through the watcher path) |

### What Each Poll Does

- New tab found → `readTabMetadata` loads initial metadata + creates entry
  - Persisted `cliState === 'busy'` → converted to `'unknown'` + `resolveUnknown` scheduled
- Existing tab → updates process/ports/title/summary (cliState untouched)
- Busy stuck check → 10 minutes elapsed + Claude process dead → silent `idle`
- Deleted tabs → cleanup + `broadcastRemove`

Removing the `cliState` decision and the `hasPermissionPrompt` check has reduced poll cost by roughly 80% compared to pre-Phase 1.

---

## Data Flow

```
[Claude Code Hook]
  ~/.purplemux/status-hook.sh
  └─ curl POST /api/status/hook
     │
     ▼
[/api/status/hook] (x-pmux-token required)
  └─ globalThis.__pt<Provider>HookEvents.emit('hook', ...)
     │
     ▼
[Provider observer] (attached per tab via attachWorkStateObserver)
  ├─ filter by tmuxSession
  ├─ apply provider-specific meta (codex applyCodexHookMeta)
  └─ translate → emit(TAgentWorkStateEvent)
     │
     ▼
[StatusManager.handleObserverEvent → updateTabFromHook]
     │
     ├─ entry.eventSeq++
     ├─ entry.lastEvent = { name, at, seq }
     ├─ broadcast status:hook-event
     ├─ deriveStateFromEvent → newState
     └─ if prevState !== newState:
         ├─ applyCliState (idempotent guard + push notification)
         ├─ persistToLayout (layout JSON)
         └─ broadcast status:update
             │
             ▼
[JSONL Watcher] (parallel)
  Watches only busy/needs-input/unknown/ready-for-review tabs
  On file change: checkJsonlIdle → updates currentAction/lastAssistantSnippet
  └─ broadcast status:update (cliState unchanged)
             │
             ▼
[Metadata Poll] (parallel, 30–60s)
  - Detect new / removed tabs
  - Update process/ports/summary
  - Busy stuck safety net
  - Persisted busy → unknown conversion + resolveUnknown
             │
             ▼
[Status WebSocket] /api/status
  Server → client: status:sync / status:update / status:hook-event
  Client → server: status:tab-dismissed / status:ack-notification / status:request-sync
             │
             ▼
[Zustand store] useTabStore
  syncAllFromServer / updateFromServer (metadata + cliState)
  applyHookEvent (lastEvent/eventSeq, prevents seq reordering)
  dismissTab / cancelTab (local actions)
             │
             ▼
[UI components]
  TabStatusIndicator         tab-bar indicator
  WorkspaceStatusIndicator   sidebar workspace
  PermissionPromptItem       timeline, re-fetched via lastEvent.seq
  NotificationSheet          notification sheet
  Bell icon                  sidebar + app header
  useBrowserTitle            browser tab title
```

### Status WS Keepalive (`?keepalive=long`)

Every `/api/status` connection gets its own heartbeat timer. The query string of the upgrade
request picks the profile:

| Query | Ping interval | Timeout | Client |
| --- | --- | --- | --- |
| _(none)_ | 30s | 90s | the web app, and anything that does not ask |
| `?keepalive=long` | 240s | 600s | the mobile alerts service, which holds the socket around the clock |

A phone on the tailnet pays a radio wakeup for every ping, so the long profile trades
dead-connection detection latency for battery. An unknown or empty value (`?keepalive=turbo`,
`?keepalive=`) falls back to the default profile instead of failing the handshake, so a client
may send the parameter without knowing whether the server understands it.

**Pings pace idle only.** `status:sync`, `status:update`, `status:hook-event`,
`session-history:*` and `notification:alert` are written to the socket the moment they are
produced, in both profiles — the heartbeat never buffers or defers a frame. A long keepalive
therefore does not delay an alert.

A connection is closed with `1001 Heartbeat timeout` on the first tick after its timeout
elapses with no pong. Pong is answered by the WebSocket implementation (`ws`, and every
browser), so no client code takes part. The profile is resolved once, inside
`handleStatusConnection`, which is why one long-keepalive client cannot change the cadence of
any other connection.

Constants live in `src/lib/status-keepalive.ts`.

### Terminal WS Path (Process Detection, Independent of cliState)

```
tmux title change → onTitleChange
  ├─ formatTabTitle → updates tab display name
  └─ fetch /api/check-claude
      └─ isClaudeRunning(panePid)
          └─ setAgentProcess(tabId, true | false)
              (auto-transitions: check→timeline on true, timeline→session-list on false)
```

### Timeline WS Path (Sessions + Entries)

```
Timeline WS connects → server runs detectActiveSession
  ├─ session-changed → reflected in agentProcess
  ├─ timeline:init → entries received, isTimelineLoading = false
  └─ timeline:append → entries appended
      └─ useTimeline.onSync callback
          ├─ setAgentProcess(tabId, true | false)
          ├─ setAgentInstalled(tabId, false) (if not-installed)
          └─ setTimelineLoading(tabId, loading)
```

`useTimeline` **no longer derives `cliState` locally** (the old `deriveCliState` was removed). The timeline WS handles only metadata (entries, summaries); `cliState` is updated solely via the hook path.

---

## Logging Configuration

### Global Level

```bash
LOG_LEVEL=debug pnpm dev      # all groups
```

### Per-module Level

The `LOG_LEVELS` env var splits levels per group. `createLogger(name)` applies the group's level to a child logger.

```bash
# Trace only the Claude Code hook behavior in debug
LOG_LEVELS=hooks=debug pnpm dev

# Multiple groups at once
LOG_LEVELS=hooks=debug,status=warn pnpm dev
```

Main groups:

| Group | Source | Debugging target |
| --- | --- | --- |
| `hooks` | `api/status/hook.ts`, `status-manager.ts` (`hookLog`) | Hook receive/process/transition |
| `status` | `status-manager.ts` (`log`) | Poll, JSONL watcher, broadcast |
| `tmux` | `lib/tmux.ts` | tmux command execution |

With `hooks=debug` you see, for example:

- `[hooks] received { event, session }` — hook endpoint received
- `[hooks] no tabId for session` / `no entry for tab` — failure cases
- `[hooks] processed { tabId, event, seq, prevState, newState, transition }` — processing result

### How It Works

`src/lib/logger.ts` parses `LOG_LEVELS`, sets the root logger's level to the minimum across groups, then `createLogger(name)` applies each group's level to its child logger. Pino requires the root to be open down to the lowest level for child filtering to work.

---

## Related Files

### Types

| File | Description |
| --- | --- |
| `src/types/status.ts` | `ITabStatusEntry`, `ILastEvent`, `TEventName`, `TTabDisplayStatus`, WebSocket messages |
| `src/types/timeline.ts` | `TCliState`, `TSessionDetectionStatus` (server-only) |

### Server

| File | Description |
| --- | --- |
| `src/lib/status-manager.ts` | `deriveStateFromEvent`, `updateTabFromHook`, `applyCliState`, `resolveUnknown`, `readTabMetadata`, busy stuck safety net, metadata poll, JSONL watcher |
| `src/lib/status-server.ts` | `/api/status` WebSocket handler, per-connection heartbeat |
| `src/lib/status-keepalive.ts` | Keepalive profiles for `/api/status` (`?keepalive=long`) |
| `src/lib/hook-settings.ts` | Hook settings file generation, script management |
| `src/lib/hook-scripts.ts` | Hook script templates, atomic script writes |
| `src/lib/hook-scripts-install.ts` | `installHookScripts` (the directory installer; no Next route imports it, ADR-0020) |
| `src/lib/hook-dispatch.ts` | `dispatchHook`: the hook route's handler, shared by live POSTs and spool replay |
| `src/lib/hook-spool.ts` | `drainHookSpool`: replays `~/.purplemux/hook-spool/` in time order |
| `src/pages/api/status/hook.ts` | Hook API endpoint (x-pmux-token required) |
| `src/lib/session-detection.ts` | `detectActiveSession`, `isClaudeRunning` |
| `src/pages/api/check-claude.ts` | Claude process detection API |
| `src/lib/layout-store.ts` | `updateTabCliStatus`, etc. (layout JSON writes) |
| `src/lib/logger.ts` | `LOG_LEVELS` parsing + per-group pino child |

### Client

| File | Description |
| --- | --- |
| `src/hooks/use-tab-store.ts` | Zustand tab store, `applyHookEvent`, `selectTabDisplayStatus` |
| `src/hooks/use-agent-status.ts` | Status WebSocket, `status:hook-event` / `status:update` / `standup:update` handling, `dismissTab` |
| `src/hooks/use-standup-store.ts` | Zustand standup store (latest tick per workspace) |
| `src/hooks/use-timeline.ts` | Timeline WS data (no cliState derivation) |
| `src/hooks/use-web-input.ts` | Input mode decision (`unknown` allows input) |
| `src/hooks/use-native-notification.ts` | Desktop native notifications |
| `src/hooks/use-browser-title.ts` | Browser title attention count |

### UI Components

| File | Role |
| --- | --- |
| `src/components/features/workspace/tab-status-indicator.tsx` | Tab-bar indicator |
| `src/components/features/workspace/workspace-status-indicator.tsx` | Sidebar workspace dot |
| `src/components/features/mobile/mobile-workspace-tab-bar.tsx` | Mobile tab bar |
| `src/components/features/timeline/permission-prompt-item.tsx` | Permission prompt UI (`lastEvent.seq` subscriber) |
| `src/components/features/workspace/notification-sheet.tsx` | Notification sheet + `useNotificationCount` |
| `src/components/features/workspace/workspace-standup.tsx` | Sidebar standup chip + popover panel |

---

## Standup Ticks

Orchestrators post a structured "standup tick" per workspace — a mini-standup answering
"where are things at, are we progressing, any blockers, am I needed" without opening a pane.

### Data flow

```
orchestrator tab
  purplemux standup report -w WS --json '{...}'
    → POST /api/cli/workspaces/{wsId}/standup   (authorizeWorkspace: own-workspace token suffices)
    → parseStandupReport (src/lib/standup.ts — clamps text, drops malformed rows)
    → StatusManager.reportStandup
        ├─ standups map (in-memory, keyed by wsId, newest-at wins)
        ├─ standup-store.addStandup → ~/.purplemux/workspaces/{wsId}/standups.json (history, cap 50)
        └─ broadcast { type: 'standup:update', standup }
             → use-agent-status.ts → useStandupStore
             → workspace-standup.tsx (sidebar chip + popover)
```

`status:sync` carries `standups` (latest per workspace) so a fresh client starts populated;
`StatusManager.init` hydrates the map from disk so ticks survive a server restart.

### When ticks are posted

The kickoff template (`DEFAULT_KICKOFF_TEMPLATE`) instructs the orchestrator to post one
after every nudge it handles, and the idle keeper heartbeat asks for one on every beat —
each heartbeat is thereby a standup tick. A final tick (state `done` or `awaiting-human`)
is requested before `orchestration off`.

### Shape

`IWorkspaceStandup` (`src/types/status.ts`): `state` (`on-track | at-risk | blocked |
awaiting-human | done`), `headline`, `items[]` (`label`, `status: done | active | blocked |
todo`, `note?`), `blockers[]` (`what`, `needs` — the exact input that clears it),
`needsHuman`, `next[]`. The sidebar chip shows the state dot, done-count, and headline;
ticks older than `STANDUP_STALE_MS` (20 min) render as stale.

## Orchestrator Coverage

Every status poll checks whether a workspace with remaining work has a usable
designated orchestrator. Remaining-work evidence comes from active `epic:`
leases, a latest standup whose state is not `done`, active agent tabs, and live
registered background jobs. Registered job owners are checked even when their
tabs are no longer in the current layout; their liveness still goes through the
existing PID-aware manager. Confirmed-live owner IDs are retained when a
different job lookup is rejected or cannot account for its registered PID; the
same result also carries incomplete evidence, so known work stays red while the
partial read remains visible. An idle agent is not completion evidence. An empty
workspace, or a `done` standup with no conflicting work evidence, needs no
orchestrator.

The designation is usable when orchestration is enabled and its agent tab has a
known live work state, including `idle` and `needs-input`. A missing, disabled,
closed, or inactive designation beside confirmed remaining work creates a red
`Orchestrator coverage` row in Mission Control's existing Coordination panel
and dispatches one `orchestrator-missing` alert for that episode. The monitor
does not select a worker, change orchestration settings, or release leases.
Confirmed recovery (or confirmed completion) rearms the alert; repeated polls
and uncertain owner reads do not. A positively usable designated owner rearms
the missing-owner episode even when work evidence remains amber. Episode
latches are atomically persisted in
`~/.purplemux/orchestrator-presence.json`, so an unchanged missing condition does
not alert again after a server restart. Presence refreshes are single-flight
from evidence collection through dispatch, preventing an older overlapping
scan from applying after a newer one.

Unreadable or structurally invalid leases, standups, layouts, background-job
state, or unknown incumbent liveness produce an amber `uncertain` row instead
of a green result, even when another source proves remaining work and the
incumbent is live. A live
coordinator waiting for a human answer remains the incumbent. The monitor is a
`globalThis.__ptOrchestratorPresenceMonitor` singleton so the custom server and
Next.js coordination route see the same snapshot and refresh guard. A corrupt
episode-latch file appears as an unavailable Coordination section and is never
silently replaced.

## Notification System

### Notification Sheet (`NotificationSheet`)

Shown as a Sheet when the Bell icon is clicked. Four sections: in-progress (`busy`), awaiting input (`needs-input`), review (`ready-for-review`), done (`done`).

The done section shows tabs that were acknowledged via `dismissTab` (have a `dismissedAt` value and `cliState` is `idle`/`inactive`), excluding the currently active tab, sorted by recency. When new work starts on such a tab, `dismissedAt` is reset and the tab leaves the list.

### Count Aggregation Scope

The `useNotificationCount` hook walks all tabs and aggregates `busy` / `needs-input` / `ready-for-review`. The currently active tab is included, so the sidebar, app header, and notification sheet share the same count and the number does not drop just because you opened the tab.

### `unknown` Handling

Tabs in `unknown` are **excluded** from both attention and busy counts. This is intentional, so the indeterminate state right after a restart does not raise a notification. Only the sidebar badge shows quietly as a gray dot.

### Alert Policy (`src/lib/alert-policy.ts`)

One predicate decides every alert, for every channel — web push, the `/api/status` socket, the Electron native notification (`use-native-notification.ts`) and the in-app toast (`use-toast-notification.ts`). `alert-policy.ts` is browser-safe, so the hooks import the same function the server calls.

```ts
shouldAlert({ id: tabId }, workspace, config)
```

| `alertsOrchestratorOnly` | Workspace | Result |
| --- | --- | --- |
| `true` (default) | orchestrated | only the orchestrator tab alerts |
| `true` | not orchestrated | nothing alerts |
| `false` | orchestrated | orchestrator alerts, workers stay muted |
| `false` | not orchestrated | every agent tab alerts (the pre-dispatcher rule) |

`alertsOrchestratorOnly` is a `config.json` key (`ALERTS_ORCHESTRATOR_ONLY_DEFAULT`), toggled in Settings → Notifications.

The status-socket `notification:alert` consumer is intentionally limited to
`orchestrator-missing`, which has no tab-state transition to drive an existing
subscriber. Completion toasts remain owned by `use-toast-notification.ts`, so
their enable flag, focused-tab suppression, duration, action, and deduplication
remain unchanged and no second warning toast is created.

### Alert Kinds

| Kind | Title | Fired from |
| --- | --- | --- |
| `needs-input` | Input Required | `applyCliState` → `needs-input` |
| `review` | Task Complete | `applyCliState` → `ready-for-review` |
| `standup-needs-human` | Standup Needs You | `reportStandup` when `needsHuman` (or state `blocked`/`awaiting-human`); addressed to the orchestrator tab, body is the headline |
| `orchestrator-stalled` | Orchestrator Stalled | `runOrchestratorKeeper` on the `ORCH_MAX_HEARTBEATS` beat, once per stall episode |
| `orchestrator-missing` | Orchestrator Missing | the coverage monitor finds confirmed remaining work with a missing, disabled, closed, or inactive designation; once per episode |

The idempotent guard at the top of `applyCliState` (`prevState === newState`) blocks duplicate calls, so callers don't have to track state.

"Silent" paths such as `resolveUnknown` / `dismissTab` / busy-stuck safety net / server restart recovery suppress the alert by passing `{ silent: true }`.

### NotificationDispatcher (`src/lib/notification-dispatcher.ts`)

`getNotificationDispatcher()` (registry on `globalThis.__ptNotificationDispatcher`) fans one alert out to every registered channel. `getStatusManager()` registers the two defaults plus `fcm` when it is configured; a failing channel is logged and never blocks the others. Each dispatch stamps the alert with an `id` and a monotonic `seq`.

- **`status-socket`** — broadcasts `{ type: 'notification:alert', alert }` to every `/api/status` client. Always broadcast; clients decide what to show. The web client ignores unknown frame types, so this is safe for older clients.
- **`web-push`** — sends the VAPID payload. Visibility is checked **per subscription**: a subscription bound to a `deviceId` is muted only when that device reports visible (`POST /api/push/visibility`), so a focused desktop no longer mutes the phone. Unbound legacy rows keep the old global gate. `404`/`410` reap the subscription.

- **`fcm`** — POSTs a **data-only** FCM HTTP v1 message per registration (`src/lib/fcm-channel.ts`), so the app renders the alert itself and keeps its kinds, actions and deep link; an FCM `notification` block would be rendered by Play services instead and is never sent. `data` carries the whole `notification:alert` payload as strings, plus `agentSessionId` / `workspaceDir` when the dispatch had them. `android.priority` is `high` for `needs-input` and `normal` otherwise. The visibility gate is the Web Push gate. An `UNREGISTERED` or `INVALID_ARGUMENT` response reaps the token, as `404`/`410` reap a Web Push endpoint — **except** when the error carries a `google.rpc.BadRequest` detail (`fieldViolations`). FCM answers `INVALID_ARGUMENT` both for a dead registration and for a message it cannot parse, and only the second carries field violations; reaping on our own malformed message would unsubscribe every device on the first dispatch. That case reaps nothing and logs at `error` with the offending field paths. Registered only when `FCM_SERVICE_ACCOUNT_PATH` names a readable service-account key file — otherwise one log line and no channel (ADR-011). Access tokens are minted from that key with a JWT-bearer grant (`src/lib/fcm-auth.ts`, `jose`) and cached until expiry.

The socket `notification:alert` broadcast is untouched by the FCM channel: foreground banners still come from `status-socket`, and `fcm` covers the backgrounded phone.

The push payload keeps its existing shape and adds `kind`, `isOrchestrator`, `alertId`, and `agentSessionId`. `claudeSessionId` stays as-is for `public/sw.js` back-compat.


## Codex launch policy and observed model

Agent tabs can persist `agentLaunchConfig` (`model`, `effort`) in the workspace layout.
CLI creation and explicit policy updates validate the values. Automatic, timeline,
and browser resumes carry the saved policy; old tabs with no policy remain unpinned.
Updating policy does not change a running Codex process. The next resume applies it.

`purplemux tab status` exposes `modelStatus`: requested settings, latest recorded
settings, last recorded turn, and `unpinned`, `unknown`, `match`, or `mismatch`.
Observations come from the bound Codex session JSONL (`turn_context` and
`thread_settings_applied`), including source and timestamp. Launch arguments and
global defaults are never represented as current model evidence. Missing or
foreign session evidence is unknown; a known contradictory field is a mismatch.
Unknown includes an explicit reason: scanning, awaiting the first turn, unavailable
or contradictory session identity, missing observation, an unverified legacy
lifecycle, a pending/held launch, or a dead/non-Codex runtime.
The reader validates the head session identity, then searches backward from the
newest records with a 4 MiB per-poll budget. Its cached cursor continues bounded
scans and subsequent appends without rereading a large history; replaced and
truncated logs invalidate the cache.

The watchdog reports each model mismatch episode once, including an orchestrator
mismatch. Every automated delivery path, plus CLI create/send/steer, holds both a
known mismatch and an established, scanning, unavailable, or dead unknown state on
either the target or workspace orchestrator. A newly booted TUI can lack turn
metadata until its first prompt. Managed launches persist a server-issued generation
before terminal submission; a launcher receipt activates it only after the server
verifies the exact wrapper, Codex child lineage, process births, tab identity, and
prior-process exit. Pending and failed generations remain unknown and cannot bind a
resume session. Resumed JSONL reads begin at that generation's recorded byte boundary,
so historical turns cannot establish its model.

Only the final delivery call can atomically consume a verified generation's one-shot
bootstrap allowance. The irreversible claim is stored in the separate server-owned
`codexLaunchRuntime`, while public `agentLaunchConfig` continues to contain only
desired `model` and `effort`. Status reads, policy PATCH, matching observations,
concurrent sends, and a service restart cannot grant or reopen the claim. Legacy tabs
may still compare valid bound observations, but missing legacy metadata never creates
an allowance. Existing untagged hooks remain compatible only while no managed
generation exists and their non-null session/path binding plus observed model still
match; this path never creates runtime proof or an allowance. An explicit managed
mode switch changes only terminal or agent-session surfaces to Codex in the same
atomic mutation that prepares its generation. The guard
does not inject `/model` commands or kill a turn. Human terminal input remains
available to correct settings.

## Background job outcomes

A registered PID exit is an outcome to verify, not necessarily a crash:

- `bg-completed`: a complete integer exit file reports zero. Verify artifacts and
  continue; do not repeat the job. No failure push is sent.
- `bg-failed`: a complete integer exit file reports nonzero. Diagnose before a
  justified retry.
- `bg-exited-unknown`: no valid exit code after the bounded two-second grace
  period. Inspect supervisor logs, child processes and verdict artifacts; do not
  infer failure or restart automatically.

Each PID registration emits one outcome. Separate jobs finishing on the same tab
are not collapsed by a per-tab debounce. Historical `bg-died` records still render.
Finishing one job does not clear unrelated freshness probes: the owner clears its
completed task probe explicitly. Probe stdout must end in a complete finite,
nonnegative number of seconds; labelled text and negative/NaN/infinite ages fail
as probe errors instead of producing spurious huge stall durations.
# Mission Control observations and delivery

Mission Control reads the existing StatusManager snapshot after the custom server initializes it. API imports never call `StatusManager.init()`, so the Next.js module graph cannot start a second poller, keeper, watcher, or notification channel. Discovery combines persisted workspace layouts, actual provider processes, current session identities, live CLI state, and bounded standup history. It does not inspect an epic board or crawl transcripts.

Only agent panels contribute agent observations. A live busy worker makes its workspace active even when the configured orchestrator is idle. An idle tab does not prove active work or completion. Recent explicit waits can classify a workspace as waiting; missing or unreadable evidence remains unknown. Repeated identical standups do not advance `lastProgressAt`, and a `done` standup remains provisional until the agent emits an explicit Mission Control completion event. Ordinary attention and standup blockers remain workspace candidates. They enter Needs you only after the configured orchestrator records the exact human-exclusive need against the current binding. Legacy unanswered opens are reclassified for that review without losing their item IDs, contents, or saved web drafts.

Answer and bootstrap delivery uses the same orchestration mapping and provider lifecycle lock as other automated prompts. Inside that lock it rechecks the exact workspace, tab, provider session, Mission Control generation, and Codex launch generation, verifies the provider process is live, rejects native/interactive prompts, and requires an empty composer. It never sends to a shell. Known pre-send readiness refusals remain queued until the target is ready, with the retry delay capped at one minute. The store records `dispatching` and increments attempts before terminal I/O; a restart or uncertain paste outcome moves the job to `held` instead of automatically pasting a second time. A successful paste records `submitted`; only an explicit agent acknowledgement records `acknowledged`.

### Coordinator recovery and human waits

Coordinator presence remains diagnostic. It never changes the mapping, resumes an agent, releases a lease, or acknowledges a note. Explicit recovery reads strict current tmux and provider observations: present, absent, or unknown. Process errors, ambiguous sessions, pending launches and a configured incumbent missing from the layout are unknown. Cached `inactive` status is not death evidence. A launch remains pending until an accepted session-start or existing readiness confirmation; elapsed time cannot prove absence.

An `awaiting-human` standup pauses idle coordinator heartbeats without disabling orchestration. Clear/off uses the shared work-state classifier with fresh lease, standup, layout, runtime and registered-background-process evidence. It requires complete work and no incomplete evidence. An idle agent alone is not completion; a done standup does not override active agents, epic leases, or live background work.
