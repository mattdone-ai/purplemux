# purplemux agent orchestration runbook

How to run an epic with a Fable orchestrator delegating to worker agents
(Opus 4.8 claude-code tabs, Codex codex-cli tabs, grok grok-cli tabs) inside purplemux, without
things silently stalling.

Fork basis: `subicura/purplemux` (installed 0.4.5).

## Built-in orchestration (UI) — preferred

The fork now has orchestration built into the app; no CLI or scripts needed:

1. **Start**: pane **+** menu → **Start orchestration…** (crown icon). Describe
   the epic/goal, optionally pick an orchestrator model and edit the kickoff
   template, hit Start. purplemux creates the orchestrator tab, launches
   claude, waits for it to boot, and injects the kickoff prompt automatically.
2. **Watchdog**: runs inside the purplemux server (no external process). On
   every worker state change — `needs-input`, `ready-for-review`, turn ended,
   agent died, or busy >10 min with no jsonl activity — it pastes a
   `[orchestrator-watchdog]` nudge into the orchestrator tab, waking it.
   Nudges are debounced (30s per tab+kind) and stuck alerts fire once per
   busy episode.
3. **Designate manually**: right-click any claude/codex tab → *Set as
   orchestrator* (crown badge appears on the tab). Same menu removes the role.
4. **Visibility**: the notification panel (bell) shows a *Watchdog activity*
   section with recent nudges (click to jump to the worker tab); tab strip
   shows per-tab state dots and the crown on the orchestrator.
5. **WIP cap**: the one cap on work in progress is the per-workspace agent-tab
   cap (ADR-0027): fleet config `tabs.cap-per-workspace` (default 8), overridden
   by `tabs.cap-per-workspace.<workspaceId>`. An agent `tab create` at the cap
   exits 3 `wip-cap`; `purplemux tab count -w WS` prints `<count> <cap>`, and
   repository hooks read that instead of counting tmux sessions.

Settings persist per workspace in `workspaces.json` under `orchestration:
{ enabled, orchestratorTabId, revision, kickoffTemplate }`. API: `PATCH
/api/workspace/:id` (orchestration object), `POST /api/workspace/:id/orchestrate`,
`GET /api/workspace/:id/orchestration`.

Mapping writes and Start carry the revision displayed by the UI. A conflict refreshes state and requires a new explicit action. Replacing an incumbent requires human confirmation and leaves its process running. Local agents use `purplemux orchestration recover -w WS TAB` only when the mapping is vacant or its incumbent is positively absent; a launch-verified incumbent can use `handoff`. Unknown or pending runtime refuses recovery. A committed change of the coordinator moves the open Mission Control runs of the workspace to the new coordinator at the next binding generation (audit event `run.rebound`); the new coordinator reads its run and generation with `purplemux mission bootstrap -w WS`. Keep orchestration enabled while waiting for human input and post `state: "awaiting-human"`; idle heartbeats pause. Clear/off is permitted only when fresh evidence confirms all work finished.

Everything below drives the same server watchdog from a plain shell instead of
the UI (e.g. driving purplemux from outside the app): the kickoff's
`purplemux orchestration on` is what the UI's Start does.

## How purplemux actually tracks agents (why things stall today)

purplemux installs Claude Code hooks (`~/.purplemux/hooks.json` → `status-hook.sh`)
and a Codex notify hook (`codex-hook.sh`). Those feed `POST /api/status/hook`,
which drives a per-tab **`cliState`** you can read any time:

| cliState | Meaning |
|---|---|
| `busy` | Agent is mid-turn, working |
| `needs-input` | Agent asked a question / hit a permission prompt — **it will sit forever until someone answers** |
| `ready-for-review` | Agent finished its turn — **it will sit forever until someone reads the result and sends the next task** |
| `inactive` | CLI exited (codex) |
| `unknown` | State lost (e.g. after crash); server has a recovery path but don't rely on it |

So "things just sit there" is almost always one of:
1. a worker in `needs-input` that nobody answered,
2. a worker in `ready-for-review` that the orchestrator never read,
3. the **orchestrator itself** ended its turn (or asked *you* a question) and
   nothing ever woke it again.

The fix for all three is the server's watchdog, with no model in the wake-up
path: on every transition it **sends a nudge message into the orchestrator
tab**. A nudge is a new user turn, so the orchestrator wakes up, reads it, and
acts. It nudges only while orchestration is enabled for the workspace with an
orchestrator tab named: step 3 of the kickoff below turns it on. There is no
process to start.

## Kickoff (step by step)

```bash
# In a plain shell, the CLI reads the port and the selected workspace token
# from ~/.purplemux. Do not export the global cli-token as PMUX_TOKEN.
# Inside a tab, keep its injected credentials and operate in its own workspace.

# 1. Pick the workspace (create it in the UI if needed; one per epic)
purplemux workspaces

# 2. Create the orchestrator tab (Fable — your Claude Code default)
purplemux tab create -w WS_ID -n orchestrator -t claude-code
# note the tabId it prints, e.g. tab-Abc123

# 3. Enable orchestration with that tab as orchestrator: until this, the server's
#    watchdog nudges nobody (it reads the revision, then patches it)
purplemux orchestration on -w WS_ID ORCH_TAB_ID

# 4. Send the orchestrator its kickoff prompt (template below)
purplemux tab send -w WS_ID ORCH_TAB_ID "$(cat kickoff-prompt.md)"
```

The CLI's credential precedence: injected tab token, injected workspace token,
then the selected workspace token on disk for an unscoped shell.

Watch progress any time:

```bash
watch -n 5 ~/code/ai-server/orchestration/pmux-board.sh -w WS_ID
```

## Orchestrator kickoff prompt template

Fill in the ALL-CAPS parts and send as the first message. The two things that
make this robust: the orchestrator gets the **full purplemux API up front**
(so it never flails), and it is told its loop is **event-driven off
`[orchestrator-watchdog]` nudges** (so it never needs to busy-wait or "remember" to check).

```
You are the ORCHESTRATOR for epic EPIC_NAME. You delegate all implementation
to worker agents in purplemux tabs; you never implement stories yourself.

## Environment
Keep the injected PMUX_TAB_TOKEN and PMUX_TOKEN unchanged. The tab token takes
precedence and confines commands to this workspace. The CLI reads the local port.
Do not export the global cli-token; it cannot authorize workspace mutations.
Workspace: WS_ID. Your own tab: ORCH_TAB_ID (never send to yourself).

purplemux commands you use:
- purplemux tab create -w WS_ID -n story-NN -t claude-code -m MODEL -r EFFORT
  (or -t codex-cli, -t grok-cli; every worker carries explicit -m and -r)
- purplemux tab send -w WS_ID TAB_ID "message"                (waits until the tab can accept
  a turn, then submits with Enter; fails with agent-not-ready and pastes nothing if it cannot)
- purplemux tab status -w WS_ID TAB_ID                        (JSON incl. cliState)
- purplemux tab result -w WS_ID TAB_ID                        (capture pane text)
- purplemux tab close -w WS_ID TAB_ID

## Spawning a worker
1. Create the tab (name it story-NN) with its model and effort pinned by -m and -r.
2. Send ONE self-contained brief: story goal, exact file paths, acceptance
   criteria, commands to run for verification, and this output protocol:
   "Work autonomously. Make reasonable assumptions and note them instead of
   asking, except for destructive/irreversible actions. When finished, end
   with a line 'DONE: <one-line summary>'. If truly blocked, end with
   'BLOCKED: <single specific question>' and stop."
3. Record TAB_ID -> story in your tracking table.

## Event loop (this is your whole job)
purplemux's watchdog sends you '[orchestrator-watchdog] ...' messages. On each one:
- NEEDS INPUT  -> tab result to read the question/prompt in full, answer it
  yourself from epic context via tab send. Only escalate to the human if it is
  a real product/scope decision; then say so in your reply and continue other work.
- READY FOR REVIEW -> tab result, check for DONE:/BLOCKED:, run the story's
  verification commands yourself (or spawn a reviewer tab), then either accept
  (update status, close tab or assign next story) or send concrete fix-up
  instructions to the same tab.
- STALLED (busy >10 min) -> tab result to see what it's doing. If genuinely
  working (long build/tests), note it and wait. If looping/hung: send Escape
  via tmux (tmux send-keys -t SESSION_NAME Escape), then re-prompt with a
  tighter instruction; if that fails, close the tab and respawn with an
  amended brief that includes what went wrong.
- DEAD/INACTIVE -> respawn the tab and re-issue the story with prior progress noted.
After handling every nudge, update STATUS_FILE (story -> state, tab, last event)
and end your turn. Do not busy-wait; the watchdog will wake you.

## Rules
- The workspace's WIP cap bounds concurrent workers: purplemux tab count -w WS_ID
  prints "<count> <cap>", and tab create exits 3 wip-cap at the cap. One story per worker tab.
- Each story runs in its own git worktree: WORKTREE_PATTERN.
- Never assume a worker's state — always capture the pane before acting.
- Every reply you produce must end with the current status table so the human
  can read progress from your tab at a glance.

Epic context: EPIC_CONTEXT_PATHS (status file: STATUS_FILE).
Begin: read the epic status, then spawn workers for the first stories, up to the cap.
```

## Stall playbook (symptom → action)

| Symptom | Detection | Action |
|---|---|---|
| Worker asked a question | `cliState=needs-input`, watch nudges | Orchestrator reads pane, answers via `tab send` |
| Worker finished, nothing happens | `cliState=ready-for-review` | Orchestrator reviews + assigns next work |
| Worker spinning >10 min | watch "STALLED" nudge | Capture pane; wait / Escape+re-prompt / kill+respawn |
| Worker CLI crashed | `alive=false` / `inactive` | Respawn tab, re-issue story |
| Worker idle but its background job is dead | registered liveness probe → "work is STALLED" nudge + push alert | Wake the worker with the evidence; restart the job or escalate |
| Background pid exited | registered bg watch → "BACKGROUND JOB DIED" nudge with exit code + stderr tail | Restart + re-register the new pid, or mark the task blocked |
| Probe itself keeps erroring | "LIVENESS PROBE FAILING" nudge after 3 consecutive failures | Fix the probe or its environment — a broken probe is not a green light |
| Orchestrator asked the human | orchestrator tab shows question; watch keeps nudging so other stories still advance | Answer in the orchestrator tab; it merges your answer next turn |
| Orchestrator went quiet | any next watch nudge re-wakes it | Nothing to do — that's the watchdog's job |

## Liveness watch — probes for delegated background work

Every watcher above watches **tab state** (turns, idleness, process liveness).
None of them can see a background job a worker launched: a tab that is
idle-holding while its drain/build/load is dead looks identical to an idle
healthy tab. That gap once cost 7 silent hours — every ping during the stall
window looked normal because milestone- and idleness-watchers are silent during
both success-in-progress and total failure.

The fix is the **two-watcher rule**: at dispatch of any long-running delegated
job, arm BOTH:

1. **Worker-side bounded supervisor** — the worker restarts its own job on
   death; N deaths in a window means systematic: stop restarting and report.
2. **Watchdog-side liveness probe** — registered via the CLI, survives the
   worker dying with its work (which has happened; the worker's watcher died
   with the workload):

```bash
# Probe: the command's last stdout line prints seconds-since-last-progress.
purplemux tab probe set -w WS TAB --cmd \
  'psql -tA -c "select extract(epoch from now()-max(finished_at))::int from runs"' \
  --stale-after 900 --interval 300 --label drain

# Background pid watch: death notifies with exit code + stderr tail.
( long-job 2>/tmp/job.err; echo $? >/tmp/job.exit ) & echo $!
purplemux tab bg add -w WS TAB --pid <that pid> --stderr /tmp/job.err --exit-file /tmp/job.exit
```

Firings deliver an orchestrator nudge (or a nudge to the registering tab itself
when the workspace has no orchestrator) **and a push alert to the human** —
an escalation that only lands in a log is not an escalation. `purplemux tab
status` shows registered probes and jobs with age/staleness, so idle-done and
idle-holding-dead-work are distinguishable at a glance. Clear registrations
(`tab probe clear`, `tab bg remove`) when the job completes.

Corollary: **a progress number without a freshness stamp is not a progress
number.** Probes exist to compute `now - last_progress` mechanically, because
two humans-in-the-loop each had the stall in hand and did not compare it to the
wall clock.

## Preventing stalls at the source

Most `needs-input` events are **missing context in the brief**. The template's
worker protocol ("assume + note instead of asking", `DONE:`/`BLOCKED:` output
contract) removes ~90% of them. Also already in your config:
`dangerouslySkipPermissions: true` — Claude tabs won't stall on permission
prompts (fine on a dedicated box; it's why the worktree-per-story isolation
matters).

Optional: set `notificationsEnabled: true` in `~/.purplemux/config.json` to
get desktop notifications on needs-input.

## Visibility cheat-sheet

- `pmux-board.sh -w WS` (or under `watch -n 5`) — every tab, its cliState, and
  the last line it printed.
- **agent-sessions tab**: `purplemux tab create -w WS -t agent-sessions` — the
  built-in UI dashboard over all agent sessions in the app.
- The app's timeline (WebSocket `/api/timeline`) shows a live activity feed;
  `~/.purplemux/session-history.json` keeps prompt→result pairs per session.
- `purplemux tab result -w WS TAB_ID` — snapshot any pane from anywhere
  (works over Tailscale: `networkAccess: "tailscale"` is already set).
- Server logs: `~/.purplemux/logs/`; run with `LOG_LEVELS=hooks=debug` when
  debugging state tracking.
- Orchestrator tab itself: the template makes it end every reply with the
  status table, so it doubles as the epic dashboard.
