import type { NextApiRequest, NextApiResponse } from 'next';
import { resolveCliScope } from '@/lib/workspace-token';

const GUIDE = `# purplemux CLI HTTP API

All endpoints require header \`x-pmux-token: <token>\` — \`PMUX_TAB_TOKEN\` when set,
else \`PMUX_TOKEN\`.

## Workspace scope

Agent tokens may mutate tabs and workspace configuration only in their own workspace. Peer
entries and legacy drive grants allow authorized reads only. A human-saved Scrum Master
selection also gives its exact current launch-verified manager tab reads in the selected
workspaces. The global CLI token
is not human identity and cannot mutate these surfaces. Foreign requests go through
coordinator notes; use authenticated local human controls for human actions.
An unscoped \`GET /api/cli/tabs\` lists only workspaces the caller may read.

## Caller identity

Every tab created by the server also carries \`PMUX_TAB_TOKEN\`, \`PMUX_TAB_ID\` (the
tab's layout id) and \`PMUX_WORKSPACE_ID\`. The tab token grants the same own-workspace
authority and names the calling tab for selected Scrum Master reads: verified (identity
"launch") for a token the server bound when it created the session. A Claude tab
created before tab tokens takes a hook-time token at its next session start
(identity "hook", never verified; see POST /api/cli/tab-identity). A tab token
stops working when its tab closes.

Tabs created before tab tokens existed have only \`PMUX_TOKEN\`. For them, send
header \`x-pmux-session: <tmux session name>\` and the server names the tab
UNVERIFIED — only when that session belongs to a tab of the token's own workspace;
any other value is ignored. \`bin/cli.js\` sends it automatically inside tmux. The
global token (\`~/.purplemux/cli-token\`) resolves to \`admin\`, never to a tab: any
process of this user can read it, so it is not evidence of a human.

Each workspace also gets its own agent session store — \`CLAUDE_CONFIG_DIR\` for
Claude, \`GROK_HOME\` for Grok — so several workspaces can share one project root
without sharing conversation history or resume lists.

## Errors and exit codes

An error body is { "error": "...", "code"?: "..." }. "error" is the human-readable text and
is kept for compatibility; "code" is the machine-readable class. HTTP statuses are unchanged.
Branch on "code" (or on the CLI's exit code), never on the "error" text. The CLI maps each code
to an exit code through one table:

  exit  meaning                                  codes                                       retry?
     0  success                                  —                                           —
     1  unexpected error                         unmapped code, 5xx, gh-unavailable,        investigate
                                                 outcome-unknown (a write lost its
                                                 connection: check the state first)
     2  usage error                              bad or missing argument; lease-policy,     fix the command
                                                 watch-invalid, reports-to-invalid,
                                                 note-too-large, note-invalid,
                                                 config-invalid, note-target-missing,
                                                 deploy-invalid
     3  conflict / refused by state              forbidden, lease-held, lease-held-by-other, after the state changes
                                                 watch-cap, inbox-not-held, caller-unresolved,
                                                 grant-tab-unverified, grant-password-invalid,
                                                 grant-locked, config-version-conflict,
                                                 note-cap
     4  target gone (permanent)                  tab-not-found, session-not-running,        NEVER
                                                 target-changed
     5  not ready yet                            readiness-timeout                          yes, bounded
     6  server unreachable                       connection refused, no port configured,    yes, bounded
                                                 a read interrupted; routes-absent (404     (routes-absent:
                                                 without JSON: no such route — an older     no, until the
                                                 server, a foreign one, or a malformed id)  cause is fixed)
     7  not found                                lease-not-found, note-not-found,           —
                                                 watch-not-found, inbox-not-found,
                                                 deploy-not-found, config-not-found

The CLI writes the code and its class to stderr, e.g.
  error: tab-not-found (permanent — the tab is closed; do not retry) — Tab not found

## Leases

One host-wide register of held resources (ADR-0011). A name is \`<kind>:<resource>\`, lower
case: \`merge:<owner>/<repo>\`, \`dev-deploy:<owner>/<repo>\`, \`dev-write:<env>\`,
\`deploy:<service>\` (admin token or the workspace's enabled orchestrator tab only),
\`epic:<slug>\` (no expiry by default, \`none\` allowed, at most 7 d), \`num:<owner>/<repo>:<adr|migration>:<nnnn>\` (requires an
epic; survives the tab), or any other kind (30 m default, 24 h max). A lease dies with its tab,
by TTL, or 10 min after its agent goes inactive; \`num\` leases outlive the tab and end by TTL,
release, release-epic or break.
Any valid token may list and check; a mutation needs a tab (tab token, or PMUX_TOKEN plus
x-pmux-session) or the admin token — otherwise \`caller-unresolved\` (403).

A lease view: { name, kind, resource, holder: { workspaceId, workspaceName, tabId, tabName,
verified, identity, admin }, epic, note, acquiredAt, renewedAt, expiresAt, ttlSeconds, survivesTab,
ageSeconds, expiresInSeconds, holderState: live|agent-gone|closed|admin }.

GET /api/cli/leases?prefix=&mine=1
  Response: { "leases": [lease view, ...] }

GET /api/cli/leases/check?name=NAME
  Exact name only (a prefix would also match merge:x/y-z). 200 for any well-formed name
  (a malformed one is 400 lease-policy):
  { "held": bool, "mine": bool, "lease": lease view | null }. The CLI prints it and exits
  0 (you hold it), 3 (another holds it) or 7 (nobody holds it). Exit 3 with nothing on stdout is
  a refusal (forbidden), not a holder; an acquire's exit 3 is a holder only when the stderr code
  is lease-held.

POST /api/cli/leases/acquire   { "name", "ttlSeconds"?: number | null, "epic"?, "note"? }
  Response: { "lease": view, "outcome": "acquired" | "renewed" } (re-acquire by the holder renews)
  Errors: lease-held 409 (+ lease, holder), lease-policy 400, caller-unresolved 403,
  forbidden 403 (deploy: needs the admin token or the workspace's enabled orchestrator tab)

POST /api/cli/leases/renew     { "name", "ttlSeconds"? }  → { "lease": view }
POST /api/cli/leases/release   { "name" }                 → { "released": true }
  Errors: lease-not-found 404, lease-held-by-other 409 (+ lease, holder)

POST /api/cli/leases/break     { "name", "reason" }       → { "broken": view }   admin token only
POST /api/cli/leases/release-epic { "epic", "kind"? }     → { "released": [names] }
  The epic:<slug> holder or admin releases every claim; a tab of a claiming workspace releases
  its own workspace's claims; nothing to release answers []. Errors: forbidden 403.

An unreadable lease store answers 500 \`lease-store-unreadable\`: nothing is known about who holds
what, so treat it as a refusal.

## Workspaces

GET /api/cli/workspaces
  Response: { "workspaces": [{ "id": "...", "name": "...", "directories": [...] }] }

GET /api/cli/workspaces/<workspaceId>/directories
  Response: { "workspaceId", "name", "directories": [...] }

PATCH /api/cli/workspaces/<workspaceId>/directories
  Body: { "directories": ["/abs/path", ...] }   non-empty; replaces the whole list
  Repoint a workspace at different directories. directories[0] is the PRIMARY: it is
  the cwd for new tabs and it keys the claude/codex chat store, so it must be unique
  across workspaces (409 if another workspace already claims it). Later entries are
  navigation shortcuts and may overlap freely. Paths must be absolute and must exist
  (400 otherwise) — they are resolved on the server, not against your cwd.
  Existing tabs keep the cwd their tmux session was created with; only tabs created
  after the change land in the new primary directory.
  Response: { "workspaceId", "name", "directories": [...] }

## Tabs

GET /api/cli/grants
  Legacy portfolio grants retain read access for their verified grantee tab until expiry or revocation.
  They never authorize foreign input, tab creation/closure, browser evaluation, or settings changes.
  Grant administration remains in the authenticated human UI. No CLI token proves human identity.

POST /api/cli/tab-identity  { session }
  Story 36: the Claude SessionStart hook of a tab created before tab tokens asks for a hook-time
  identity with the pane's WORKSPACE token (403 for the admin token or a tab token), for a live tab
  of that workspace (404 otherwise), a Claude tab only (409 tab-identity-unsupported otherwise).
  Mint-only: 409 tab-has-launch-identity for a tab with a launch token. Answers { tabId, workspaceId, token, identity: "hook" }; the hook writes the exports to
  $CLAUDE_ENV_FILE. A hook token resolves identity "hook", never verified.

GET /api/cli/tabs?workspaceId=WS
  List tabs. Without workspaceId, lists tabs across all workspaces. Each tab carries identity:
  launch (token bound at launch), hook (taken at a Claude SessionStart and used at least once,
  story 36) or none (no tab token yet: a hook token that was minted but never presented shows none).
  Response: { "tabs": [{ "tabId", "workspaceId", "name", "sessionName", "panelType", "agentProviderId", "agentSessionId",
    "cliState", "lastEvent", "busySince", "reportsTo", "identity", "host"? }] }
  "host" is present only on a remote tab (ADR-0022): the ssh alias whose tmux runs it.
  cliState / lastEvent ({ name, at, seq }) / busySince are the live status (null when unknown).
  A busy tab whose lastEvent is "stop" waits only on open background work (WAITING, ADR-0018:
  a turn that ended with no marker line while its own background shells, agents or registered
  jobs run sends no nudge).

POST /api/cli/tabs
  Body: { "workspaceId": "WS", "name"?: "...", "panelType"?: "terminal" | "claude-code" | "codex-cli" | "grok-cli" | "agent-sessions" | "web-browser" | "diff",
          "model"?: "...", "reasoning"?: "...", "launch"?: boolean, "reportsTo"?: "tab-...", "host"?: "HOST", "cwd"?: "/abs/dir" }
  Invalid panelType returns HTTP 400 with validPanelTypes.
  "host" runs the tab's tmux on that host over ssh (ADR-0022). It must be listed in fleet config
  remote.hosts, else 400 { "code": "remote-host-invalid" }; terminal and claude-code tabs run remote,
  codex-cli and grok-cli do not: 400 { "code": "remote-type-unsupported" } (both CLI exit 2). A host that does not answer
  over ssh is 503 { "code": "remote-host-unreachable", "host" } (exit 6). The pane gets
  PMUX_TAB_ID, PMUX_WORKSPACE_ID, PMUX_URL (this server) and its own tab token, never the
  workspace token. A remote claude-code tab's hooks, transcript and CLI reach this server, so
  status, result, send, close and the watchdog work as for a local tab; status serves "host".
  "cwd" is the tab's start directory, an absolute path that must exist on the tab's host,
  else 400 { "code": "cwd-missing" } (exit 2).
  "reportsTo" names a live tab of the SAME workspace that receives this tab's watchdog nudges
  ahead of the workspace orchestrator; anything else is 400 { "code": "reports-to-invalid" }
  (CLI exit 2). It is cleared when that tab closes.
  Creates a tab in the first pane of the workspace. Agent tabs (claude-code / codex-cli / grok-cli)
  auto-launch their CLI with purplemux hooks wired, so the tab reports cliState and can
  receive prompts via send immediately. "model" sets the agent model (claude --model /
  grok -m / codex --model). "reasoning" sets the effort — claude-code: "low" | "medium" |
  "high" | "xhigh" | "max" (claude --effort; omitted = the launching user's GLOBAL default,
  so an orchestrator spawning workers should always pin it to the intended tier); grok-cli:
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" (grok --effort);
  codex-cli: "minimal" | "low" | "medium" | "high" (model_reasoning_effort). "launch": false
  keeps the old bare-shell behavior.
  Response: { "tabId", "workspaceId", "paneId", "sessionName", "name", "panelType", "agentProviderId", "agentSessionId", "launched", "host"? }

GET /api/cli/tabs/<tabId>?workspaceId=WS
  Tab info.
  Response: { "tabId", "workspaceId", "paneId", "name", "sessionName", "panelType", "agentProviderId", "agentSessionId", "reportsTo" }

PATCH /api/cli/tabs/<tabId>?workspaceId=WS
  Body: { "reportsTo": "tab-..." | null } — on its own. Sets or clears the nudge target (same rules
  as create; a tab cannot report to itself). Response: { "tabId", "workspaceId", "reportsTo" }
  Body: { "agentLaunchConfig": { "model"?, "effort"? } | null } — pins for future launches.

DELETE /api/cli/tabs/<tabId>?workspaceId=WS[&keepProcesses=1]
  Close the tab: reap its processes, kill its tmux session, remove it from the layout.
  Reaped (Linux, ADR-0016): every descendant of the pane and every process of the server's user
  whose environment holds exactly PMUX_TAB_ID=<tabId> — which survives &, disown, nohup and
  setsid. SIGTERM, up to 3 s, then SIGKILL. keepProcesses=1 signals only the pane's process group.
  Response: { "ok": boolean, "reaper": "linux" | "unavailable", "envMarker": "present" | "absent" | "unknown",
              "killed": [{ "pid", "comm", "args" }], "survivors": [...] } — ok false means the layout kept
  the tab; the CLI then exits 1 (close-not-confirmed) instead of printing ok. Every kill is audited
  in ~/.purplemux/audit/coordination.jsonl.

POST /api/cli/tabs/<tabId>/send?workspaceId=WS
  Body: { "content": "...", "waitMs"?: 0..600000 }
  Send text to the tab and press Enter. Typed into Claude Code, bracketed paste elsewhere.
  For an agent tab (claude-code / codex-cli / grok-cli) the send waits until the tab can
  accept a turn, up to waitMs (default 60000). A booting agent swallows the Enter after a
  paste, so sending into one reports success over an agent that never starts. waitMs: 0
  answers with the current state instead of waiting. Terminal and browser tabs are ungated.
  Response: { "status": "sent", "submitted": boolean, "cliState": string | null }
  404 { "error": "Tab not found", "code": "tab-not-found" }
  409 { "error": "agent-not-ready", "code", "tabId", "cliState", "detail": "readiness-timeout" | "session-not-running", "waitedMs"? }
    — nothing was pasted, so a later Enter cannot submit a half-forgotten prompt.
  409 { "error": "agent-target-changed", "code": "target-changed", "tabId" } — the tab was replaced.
  tab-not-found, session-not-running and target-changed are permanent (CLI exit 4): never
  retry them. readiness-timeout is retryable (CLI exit 5), a bounded number of times.

GET /api/cli/tabs/<tabId>/status?workspaceId=WS
  Response: { "tabId", "workspaceId", "alive", "command", "cliState", "agentProviderId", "agentSessionId", "claudeSessionId",
              "probes": [...], "backgroundJobs": [...], "turnEnd": {...} | null, "identity" }
  probes/backgroundJobs are the tab's registered liveness watch (see "Liveness watch"),
  so an idle tab that is HOLDING dead background work is distinguishable from an idle
  tab that is done.
  turnEnd is how the watchdog classified the last stop (null before the first stop): "kind"
  (turn-marker, waiting, ready-for-review, ...). A waiting or ready-for-review stop carries
  "openBackgroundTasks" (Claude only: its shells, async subagents and monitors, including
  shells its subagents started; null when a Claude ledger could not be read, and null on a
  Codex or Grok ready-for-review stop, which has no ledger — read null there as "not tracked")
  and "liveRegisteredJobs" (jobs whose pid was alive AT THAT STOP; "backgroundJobs" above is live)
  and "armedWatches" (purplemux watches the tab owned); a ready-for-review stop also carries
  "transcript" (false: no transcript was read). A turn-marker stop carries "marker" and no counts.

GET /api/cli/tabs/<tabId>/result?workspaceId=WS[&suggestions=0 | &raw=1]
  Capture the current pane content (escapes stripped). On the agent's composer line and below,
  text the agent renders DIM — a prompt suggestion, never typed by anyone — reads
  "[suggestion] <text>". suggestions=0 drops it; raw=1 returns the escapes untouched.
  Response: { "content": "...", "suggestion": "<the composer suggestion>" | null }

## Liveness watch

Watchers for DELEGATED WORK, not tab state. A tab that is idle while its background
job is dead looks identical to an idle healthy tab; the built-in watchdog only sees
pane/turn state. Register a probe (progress freshness) and/or a background pid
(process death) at dispatch time for any long-running job. Events fire an
orchestrator nudge (STALLED / LIVENESS PROBE FAILING / BACKGROUND JOB COMPLETED /
BACKGROUND JOB FAILED / BACKGROUND JOB EXITED with unknown status — sent to the
tab's live reportsTo tab, else the workspace's orchestrator tab, else the registering
tab itself; a job registered with "notify": "self" always wakes the registering tab). Stalls, probe failures, failed jobs, and unknown-status exits also send
a push alert to the human. Registrations persist across server restarts and are dropped
when the tab closes.

POST /api/cli/tabs/<tabId>/probe?workspaceId=WS
  Body: { "command": "...", "stalenessThresholdS": 60..604800, "intervalS"?: 30..604800 (default 60), "label"?: "default" }
  Requires the workspace's OWN token (registration executes a command server-side).
  The watchdog runs command every intervalS (bounded below by the status poll, ~30-60s);
  the LAST NON-EMPTY line of its stdout must consist entirely of a finite,
  nonnegative numeric seconds-since-last-progress value (e.g. a
  SELECT now()-max(finished_at) or a stat of a progress file). Exit 0 + a number =
  measured; age > stalenessThresholdS = STALLED (re-alerts every further threshold of
  silence). Nonzero exit, timeout (15s), or non-numeric output = probe failure; 3
  consecutive failures fire LIVENESS PROBE FAILING — a broken probe is not a green light.
  Same tabId+label upserts.
  Response: { "tabId", "workspaceId", "probe" }

GET /api/cli/tabs/<tabId>/probe?workspaceId=WS
  Response: { "probes": [{ "label", "command", "stalenessThresholdS", "intervalS",
              "lastRunAt", "lastAgeS", "stale", "consecutiveFailures", "lastError" }] }

DELETE /api/cli/tabs/<tabId>/probe?workspaceId=WS[&label=L]
  Remove probes (all for the tab, or one label). Do this when the job completes.
  Response: { "removed": n }

POST /api/cli/tabs/<tabId>/bg?workspaceId=WS
  Body: { "pid": N, "label"?: "...", "stderrFile"?: "/abs/path", "exitCodeFile"?: "/abs/path",
          "notify"?: "self" | "orchestrator" }
  "notify": "self" sends the outcome nudge to this tab (a worker waking on its own gate);
  the default is the routing above. While the pid is alive, a turn end with no marker line
  is WAITING and sends no nudge, and while the tab waits on that stop it is never reported
  "possibly stalled" (a tab busy mid-turn keeps the staleness rule). A pid that
  exits (or turns zombie) reports once, on the next watchdog pass, before its tab's stall is judged.
  Watch a background pid. A strict integer read from exitCodeFile classifies exit 0 as
  BACKGROUND JOB COMPLETED and nonzero as BACKGROUND JOB FAILED. If the file is missing
  or malformed after a short grace, BACKGROUND JOB EXITED fires with unknown status;
  inspect artifacts and logs before deciding whether it succeeded or failed. Nudges
  include the stderr tail (last ~10 lines of stderrFile) when available. Launch
  pattern that captures both:  ( cmd 2>/tmp/job.err; echo $? > /tmp/job.exit ) & — then
  register the subshell pid. The registration is one-shot: only that pid is dropped
  after its outcome; probe registrations on the tab remain active.
  Response: { "tabId", "workspaceId", "job" }

GET /api/cli/tabs/<tabId>/bg?workspaceId=WS
  Response: { "backgroundJobs": [{ "pid", "label", "alive", "registeredAt", "ageS" }] }

DELETE /api/cli/tabs/<tabId>/bg?workspaceId=WS[&pid=N]
  Stop watching (all for the tab, or one pid).
  Response: { "removed": n }

## Inbox (ADR-0012)

Server-originated notices — notes, watch firings, deploy announcements, Mission Control
answers, API-error resumes — reach an agent's composer only through the inbox. Each is one
line rendered from a fixed per-kind template: "[purplemux <kind> <id>] <ids, times, counts>
— <pull command>". No caller text is ever typed; read subjects with the pull command.
Delivery waits for an agent at its prompt (idle, ready-for-review, or WAITING per ADR-0018)
with an empty composer and no prompt or option list on screen. A refusal backs off
10 s → 30 s → 2 min → 5 min; a tab that becomes ready is tried on the next 2 s tick. After
30 refusals or 24 h the item is "held"; a paste that throws or strands in the composer is
"held" at once and never retried blind. A note, watch or deploy item held after 30 refusals is
probed again every 5 min, and sooner when its tab ends a turn, until 24 h after it was queued. It
stays first in its tab's queue, so notices behind it arrive in order. Closing the target tab drops
its queued and held items. Delivered, dropped and held items are kept 7 days.

GET /api/cli/inbox?workspaceId=WS[&all=1]
  Read scope. Queued and held items targeting WS's tabs; all=1 adds delivered and dropped.
  Response: { "workspaceId", "items": [{ "id", "kind", "targetWorkspaceId", "targetTabId", "dedupeKey",
    "line", "state", "attempts", "lastRefusal", "notBefore", "createdAt", "deliveredAt", "heldReason",
    "droppedReason", "expiresAt", "transitionAt", ... }] }

POST /api/cli/inbox/<id>/retry
  The target workspace's own token, the workspace that sent the note the item carries, or the
  admin token. Re-queues a held item once, with a fresh refusal budget. 404 { "code":
  "inbox-not-found" } (CLI exit 7) for an unknown id AND for any other workspace's item;
  409 { "code": "inbox-not-held" } (CLI exit 3) when the item is not held, or when a newer
  notice with its key is already queued for that tab.

## Notes (ADR-0013)

A note is a body the recipient pulls. A same-workspace --to-epic note routes directly to the live
epic holder. A cross-workspace note routes to the enabled, live orchestrator of the holder's
workspace; --to-workspace uses that workspace's orchestrator too. Cross-workspace and unresolved
epic sends require the verified current source orchestrator. Admission is persisted across source
orchestrator handover. With no target orchestrator the note is "undeliverable" with a reason and
never falls back to a worker. The recipient's tab
receives only the inbox's fixed line "[purplemux note n-…] from <ws>/<tab> at <time> — purplemux note
show n-…, then purplemux note ack n-…"; the subject and body are never typed. If that tab closes
before the line is delivered, the note re-routes. One reminder reaches the recipient 30 min after
the line reached its composer, and one notice reaches the sender's tab (if live) at 60 min; no
more. A note unacked or undeliverable for 14 days expires (one notice to a live sender); acked and
expired notes are pruned 14 days later. At turn start, run \`note list --open --to-me\`.

A routed note reads state "pending" while its notice waits in the inbox, "held" while the inbox
holds it, and "delivered" only after the notice reached a composer (deliveredAt, also
receipt.composerDeliveredAt, is then non-null). Each authorized response includes this
note's receipt: routing status/reason, authorized sender/recipient, and its own notice state,
last refusal, held reason, and composer delivery time. It never includes the recipient's inbox.
Queued notices are revalidated immediately before paste; terminal, legacy-policy-blocked, or stale
recipient notices are dropped.

POST /api/cli/notes
  Any resolved caller. Body: { "toEpic"? , "toWorkspace"? (exactly one), "subject" (≤ 120, control
  characters removed), "body" (≤ 16 KiB UTF-8), "fromEpic"? (only the holder of epic:<slug>) }.
  Response: { "note": INoteView }. 413 note-too-large (exit 2), 400 note-target-missing / note-invalid
  (exit 2), 403 forbidden (exit 3) for a fromEpic the caller does not hold or a cross-workspace
  sender that is not the verified current source orchestrator.

GET /api/cli/notes[?open=1][&toMe=1][&fromMe=1][&epic=SLUG]
  Notes the caller's workspace sent or receives (admin: all), without bodies.
  Response: { "notes": [{ "id", "from", "to", "subject", "state", "deliveredTo", "routedAt",
    "deliveredAt", "ackedAt", "ackedBy", "ackComment", "bodyBytes", "receipt", ... }] }

GET /api/cli/notes/<id>
  The recipient workspace, the sender workspace, or admin. Response: { "note", "body" }.
  404 note-not-found (exit 7); 403 forbidden (exit 3).

POST /api/cli/notes/<id>/ack
  Same-workspace notes: the recipient workspace. Cross-workspace and legacy unknown-source notes:
  the verified currently routed recipient coordinator. Body: { "comment"? (≤ 500) }.
  Response: { "note" } in state "acked". 404 note-not-found (exit 7); 403 forbidden (exit 3),
  also for a note that is not delivered.

## Harness watches (ADR-0015)

A watch is a one-shot subscription owned by the calling tab. The server evaluates it and sends
the owner ONE inbox line when the condition holds, then deletes it; it dies with its tab.
  pr OWNER/REPO#N    --until merged | closed | head-moved | checks-settled
  ref OWNER/REPO@REF --until moved
  lease NAME         --until free   (no unexpired record: an acquire would succeed)
GitHub reads use the server's own gh, every intervalS (default 120, 60-3600); a lease watch is
evaluated on each lease release and every pass. A watch expires after ttlSeconds (default 24 h,
max 7 d) with one notice. Three failed reads in a row send one "failing" notice carrying a
server token (http-404, http-403, timeout, auth, gh-missing, other); watch list shows the error
text; after that notice the watch reads less often (2x, 4x, up to 8x its interval). A merged
watch on a PR closed without a merge reports CLOSED. Host caps: 60 GitHub watches and 2,000 GitHub
requests/h in all (a checks-settled watch reads 3 times per check) — 409 watch-cap, CLI exit 3; a
tab holds at most 30 watches.
Lines: "[purplemux watch w-…] OWNER/REPO#N is MERGED (sha) — watch cleared", "… head moved a -> b",
"… checks settled at sha: G green, R red", "… moved a -> b", "NAME is free", "… is failing:
<token> …", "… expired without <until>". The label is shown by list, never typed.

POST /api/cli/watches   { "kind", "target", "until", "ttlSeconds"?, "intervalS"?, "label"? (≤ 80) }
  The calling tab owns it (a caller with no tab: 403 caller-unresolved, exit 3). 400 watch-invalid
  (exit 2), also for a PR or ref gh cannot find; 503 gh-unavailable (exit 1). Response: { "watch" }.
GET /api/cli/watches[?workspaceId=WS]
  The caller's own workspace (admin: any, or all). Response: { "watches": [{ ...watch, "owner":
  "live"|"closed"|"unknown", "ageSeconds", "expiresInSeconds", "failures", "lastError" }] }.
DELETE /api/cli/watches/<id>
  The owner tab or admin (else 403). 404 watch-not-found (exit 7). Response: { "removed" }.

## Fleet config (ADR-0019)

Versioned string values that tools read at call time, so changing one needs no message to
anyone: no broadcast, no nudge, no inbox notice. Every change is audited to
~/.purplemux/audit/coordination.jsonl. Keys match ^[a-z][a-z0-9.-]{1,63}$; values are one
line of text, at most 256 characters, parsed by the reader. Writes need the admin token or the
tab that is its workspace's enabled orchestrator (cooperative authority, not a boundary).

Keys in use:
  gate.slots   The host gate slot cap. skills gate.sh reads it after --slots and
               $GATE_HOST_SLOTS, before its default 3 (story 25). Change it with
               \`purplemux config set gate.slots <n>\` and tell nobody.
  watchdog.idle-nudge-minutes
               The quiet window, in minutes (0, 1440], decimals allowed, after a stop with no end
               line and nothing live before the one "idle without an end line" nudge (L49). Read
               by every status poll; unset or invalid means 15.
  watchdog.wait-backstop-hours
               Hours (0, 168], decimals allowed, a tab may wait on a live registered job or armed
               watch before its one "has been WAITING" nudge. Unset or invalid means 4.

GET /api/cli/fleet-config
  Any valid scope. Response: { "values": { "<key>": { "value", "version", "setAt", "setBy": { "workspaceId", "tabId", "admin" } } } }
GET /api/cli/fleet-config?key=KEY
  Response: { "key", "value", "version", "setAt", "setBy" }; 404 { "code": "config-not-found" } (CLI exit 7) when unset.
GET /api/cli/fleet-config?history=1[&key=KEY]
  The last 200 changes, oldest first: { "history": [{ "key", "oldValue", "newValue", "version", "at", "by" }] }.
  An unset shows as newValue null.
PUT /api/cli/fleet-config/KEY   { "value": "6", "expectedVersion"?: 4 }
  Response: { "key", "version", "value": { "value", "version", "setAt", "setBy" }, "changed" }. Setting the value a key already holds changes
  nothing (no version, no audit line). 400 config-invalid (exit 2); 403 forbidden (exit 3);
  409 config-version-conflict (exit 3) when expectedVersion is not the stored version (0 = never set).
DELETE /api/cli/fleet-config/KEY   { "expectedVersion"?: 5 }
  Same authority. Response: { "key", "version", "unset": { change } }. 404 config-not-found (exit 7) when unset. The version keeps counting, so a key
  set again never repeats a version.

## Deploy announce (story 13, ADR-0017)

The one broadcast path before a restart. It queues the inbox's fixed deploy line for every
workspace's enabled orchestrator tab and every live holder of a tab-bound lease (once per tab;
a tab confirmed closed and the announcing tab are left out):
  "[purplemux deploy d-…] purplemux restarts at ~<time> (in N min) — details: purplemux deploy
  status d-…; reach a checkpoint; tabs survive, in-flight hook events do not"
The reason is stored and shown by status; it is never typed. Records are pruned 7 days after
creation.

POST /api/cli/deploy/announce   { "inMinutes": 1-60, "reason": "≤ 120 chars", "exceptTabIds"?: ["tab-…"] }
  The admin token or the deploy:purplemux holder; else 403 forbidden (CLI exit 3).
  400 deploy-invalid (exit 2). Response: { "id", "reason", "inMinutes", "createdAt", "restartAt",
  "by", "recipients": [{ "workspaceId", "tabId", "reasons", "itemId" }] }.
GET /api/cli/deploy/status?id=d-…
  A recipient's workspace, the announcer's workspace, the deploy:purplemux holder or admin
  (else 403). 404 deploy-not-found (exit 7). Response: the record, each recipient with
  "state" (queued | delivered | held | dropped | pruned) and "cliState".
POST /api/cli/deploy/withdraw   { "id": "d-…" }
  The announcer's authority (admin or the deploy:purplemux holder). Takes back the notices still
  waiting (queued or held) once the deploy is over: { "id", "withdrawn": n }. deploy-live.sh calls it
  whatever its verdict. An announce whose record cannot be written takes back its notices itself.

## Orchestration

GET /api/cli/workspaces/<workspaceId>/orchestration
  Response: { "orchestration": { "enabled", "orchestratorTabId", "revision", "kickoffTemplate"? }, "nudges": [...] }

PATCH /api/cli/workspaces/<workspaceId>/orchestration
  Body: { "expectedRevision": number, "mode"?: "update" | "recover" | "handoff",
          "enabled"?: boolean, "orchestratorTabId"?: string | null, "kickoffTemplate"?: string | null }
  Read the current revision, then submit one PATCH. Missing precondition: 428; malformed: 400;
  stale revision: 409 orchestration-conflict with current orchestration. Never retry a conflict
  automatically. Legacy mappings read as revision 0; each semantic change increments once.
  An own-workspace caller may explicitly recover a vacant or positively dead incumbent to a
  live local agent. Live, pending or unknown incumbent state refuses recovery. A missing legacy
  session binding is unknown. Only the launch-verified incumbent can hand off a live mapping.
  The human UI can explicitly replace after confirmation; it uses cookie, same origin and CAS,
  and leaves the former process running. Global tokens, peers and grants confer no mutation right.
  CLI: orchestration recover -w WS TAB; orchestration handoff -w WS TAB; on aliases recover.
  A committed change of the coordinator tab moves each open Mission Control run of the workspace
  to the new coordinator at the next binding generation (see "Orchestrator rebind" below).
  Clear/off requires fresh complete work evidence: no active epic lease, agent work or background
  job, no unfinished standup, and no unknown observations. awaiting-human retains ownership and
  pauses idle heartbeats. A tab's live reportsTo still overrides the coordinator nudge target.

  Turn ends (ADR-0018): a worker whose last line starts with DONE:, BLOCKED:, NEEDS-DECISION:,
  READY-TO-MERGE: or CHECKPOINTED: produces "[orchestrator-watchdog] worker <tab> (<name>) ended: <line>
  — read with: purplemux tab result -w <ws> <tab>" (up to 5 READY-TO-MERGE lines ride along).
  No marker and open background work (the agent's own tasks, a live tab bg job, or an armed
  purplemux watch the tab owns) → WAITING, no nudge. Otherwise no nudge at once: if the tab stays
  on that stop for the idle window (fleet config watchdog.idle-nudge-minutes, default 15) with
  nothing live, ONE "[orchestrator-watchdog] worker <tab> (<name>) is idle without an end line"
  nudge follows (the status poll derives it from the recorded stop, so a server restart keeps
  it). A newer prompt, stop, permission request or session start, a close, or a job or watch
  registered meanwhile voids it; Claude's idle_prompt notification does not. A tab WAITING on a
  live job or armed watch for watchdog.wait-backstop-hours (default 4) gets ONE "has been
  WAITING" nudge naming the job or watch, per waiting stop. A tab closed through tab close /
  DELETE raises no INACTIVE and no job-exit nudge. The same episode (hook event, job pid) of the
  same class from the same tab to the same recipient within 60 s is nudged once.
  A turn that ended on a provider API error is resumed ONCE through the inbox with no nudge;
  a second failure (or a held resume) sends "API ERROR". A usage-limit halt is never typed
  into and sends one "HALTED by a usage limit" nudge.

## Standup ticks

POST /api/cli/workspaces/<workspaceId>/standup
  Body: { "state": "on-track" | "at-risk" | "blocked" | "awaiting-human" | "done",
          "headline": "<one line: where things stand>",
          "items"?: [{ "label", "status": "done" | "active" | "blocked" | "todo", "note"? }],
          "blockers"?: [{ "what", "needs": "<the exact input that clears it>" }],
          "needsHuman"?: boolean, "next"?: ["<upcoming step>"] }
  Orchestrators post one after every nudge they handle and on every heartbeat. The
  latest tick renders in the workspace sidebar — it is how the human reads progress,
  blockers, and whether they are needed, without opening any pane. "state" and
  "headline" are required; everything else may be omitted.

GET /api/cli/workspaces/<workspaceId>/standup
  Response: { "latest": { ... } | null, "history": [...] }

## Epic burndown

POST /api/cli/workspaces/<workspaceId>/burndown        (purplemux burndown publish -w WS --json @FILE)
  Body: the Scrum Master generator's burndown.json:
        { "generated_at": "<ISO-8601 UTC, not in the future>",
          "epics": [{ "slug", "name", "stories", "unpointed", "total", "burned", "remaining", "pct",
                      "in_progress", "blocked", "done_events": [{ "at", "points" }], "undated_burned" }],
          "history": [{ "at", "slug", "total", "burned", "remaining", "pct", "stories", "unpointed" }] }
  Own workspace only. Counts and points are non-negative integers; pct is 0..100; burned +
  remaining = total; done_events points + undated_burned = burned; slugs are unique. A refusal
  (400 invalid-burndown) names the field, what it saw and what it expected; nothing is stored.
  Unknown fields are dropped. At most 100 epics; history keeps the newest 2000 rows by "at"
  (the CLI trims before sending); the stored snapshot is at most 1 MiB (413 otherwise).
  Each publish replaces the previous one. The portfolio board renders the burndown of the
  selected Scrum Master's workspace and marks it stale 2 h after "generated_at".

GET /api/cli/workspaces/<workspaceId>/burndown         (purplemux burndown show -w WS)
  Response: { "burndown": { "workspaceId", "receivedAt", "snapshot": { ... } } | null }

## Portfolio board

GET /api/cli/portfolio?workspaces=WS1,WS2
  The current launch-verified Scrum Master may read 1..100 workspaces from the human-saved
  scope. The query may narrow that scope, never expand it. Ordinary own-workspace reads
  remain available even if the portfolio scope does not include that workspace.
  The response gives coverage for each requested workspace; blocker records and shared
  dependency aggregates include only workspaces with current coordinators. Removing a
  workspace or replacing the manager in the saved scope takes effect on the next read.
  Open blockers are always included. Resolved blockers are paged 100 at a time; follow
  resolvedNextCursor with &resolvedBefore=<cursor> to read older history. Actions and
  milestones are limited to the latest entries used by the board for visible blockers.
  Work commands in other workspaces still go through their configured orchestrators.

POST /api/cli/portfolio/events
  Only the launch-verified current orchestrator of the report's workspace, with the
  current Mission Control run binding generation, may report, apply, or resolve.
  \`purplemux portfolio report -w WS --json '{...}'\` submits one blocker report:
  {"eventId":"evt-1","schemaVersion":1,"workspaceId":"WS","runId":"RUN","bindingGeneration":1,
   "sourceKey":"stable-blocker-key","revision":0,"producerAt":1700000000000,
   "resourceKey":"lease:merge:owner/repo","kind":"lease","watchId":"w-...",
   "watchHead":null,"outcome":"Ship release","priority":90,"stage":"implemented",
   "owner":"orchestrator","cause":"Merge lease held","evidence":"reported observation",
   "nextAction":"Wait for lease release","decisionOwner":"orchestrator",
   "checkpointAt":1700000300000,"capacity":{"host":"host-a","measuredReason":"lease held",
   "limit":"1","use":"1","holder":"tab-holder","clearingCondition":"lease free"}}
  Stable sourceKey preserves the first-blocked age across task renames and coordinator
  replacement. Revisions begin at 0 and increment by one. Event IDs replay only identical
  content. A newer revision needs a new watch ID. For PR/ref watches, watchHead must equal
  the immutable watch baseline SHA; a changed head cannot clear the old blocker. Capacity
  details are required for worker-limit, build-slots, memory, disk-reservation and lease.
  Pre-upgrade blockers with multiple revisions have incomplete watch history. They remain
  readable and accept unwatched edits, but a new watch binding requires an explicit linked
  migration; changing sourceKey silently would lose the blocker history.
  Reported stage/evidence are claims, not verified milestones. A matching green CI, merged
  PR, moved ref or free lease watch clears only its linked dependency. It does not verify
  deployment or the release. No arbitrary prose resolves a blocker.

  \`purplemux portfolio applied -w WS --json '{...}'\` records that the current owner
  applied a routed decision (separate from note acknowledgement):
  {"schemaVersion":1,"workspaceId":"WS","runId":"RUN","bindingGeneration":1,
   "impactId":"pb-...","noteId":"n-...","eventId":"apply-1","expectedRevision":0}

  \`purplemux portfolio resolved -w WS --json '{...}'\` records capacity clearance only
  for an unwatched worker-limit, build-slots, memory, or disk-reservation blocker:
  {"schemaVersion":1,"type":"resolved","workspaceId":"WS","runId":"RUN",
   "bindingGeneration":1,"impactId":"pb-...","eventId":"resolve-1",
   "expectedRevision":0,"observedAt":1700000300000,
   "evidence":{"host":"host-a","measuredReason":"slot available","limit":"4",
   "use":"3","holder":null,"clearingCondition":"one free slot",
   "reference":"host-signals:sample-123"}}
  The coordinator claim is identified as such. It clears only this dependency, never
  a release milestone; stale revisions and reused event IDs are refused.

The human Mission Control portfolio board uses an authenticated session and same-origin
checks to select scope, acknowledge a blocker, route decisions through NotesService,
and confirm merged/deployed/verified release milestones with cited evidence. Human notes carry the
session subject and human admission, never a manufactured orchestrator identity.
The target orchestrator receives the ordinary durable note and inbox receipt. A missed
checkpoint sends one deduplicated local coordinator note; watch proof wakes each affected
coordinator once through the existing watch notice or a deduplicated note.

## Mission Control

GET /api/cli/mission-control?workspaceId=WS
  Returns the workspace-scoped durable Mission Control snapshot, including answers
  and delivery status. The response also includes humanInboxPolicy with the count and
  ordinary-turn guidance for legacy candidates that still need orchestrator review.
  Read access follows the existing workspace/allowedPeers rules.

POST /api/cli/mission-control/events?workspaceId=WS
  Requires WS's own workspace token; the global token and allowedPeers cannot write.
  Body: { "events": [TMissionProducerEvent, ...] } (1..25 events, one atomic transaction)
  Response: { "events": [IMissionEvent, ...], "cursor": N, "replayed": boolean,
              "humanInboxPolicy": { "version": 1, "legacyReviewPending": N, "guidance"?: string } }

  Start a run:
  {"events":[{"eventId":"evt-start-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1",
    "expectedRevision":0,"producerAt":1700000000000,"bindingGeneration":0,"type":"run.started",
    "payload":{"objective":"Ship Mission Control","tabId":"tab-orchestrator"}}]}

  Record a workspace issue (the run binding generation must still be current):
  {"events":[{"eventId":"evt-question-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1",
    "expectedRevision":0,"producerAt":1700000000001,"bindingGeneration":1,"type":"attention.opened",
    "payload":{"itemId":"question-1","kind":"question","title":"Choose rollout","context":"Pick one option",
      "storyIds":[],"options":[{"id":"gradual","label":"Gradual"}],"recommendation":"gradual",
      "blockingScope":"story","canContinue":true}}]}

  Ordinary attention creates a durable candidate. Workers route blockers to the
  orchestrator. The configured orchestrator checks existing instructions, authority,
  evidence, and delegated handling. Routine setup, coordination, already-granted
  permissions, and parked-work choices remain workspace issues.

  Escalate the same item only when a human-exclusive need remains:
  {"events":[{"eventId":"evt-question-review-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1",
    "expectedRevision":1,"producerAt":1700000000002,"bindingGeneration":1,"type":"attention.updated",
    "payload":{"itemId":"question-1","kind":"question","title":"Choose rollout","context":"Pick one option",
      "storyIds":[],"options":[{"id":"gradual","label":"Gradual"}],"recommendation":"gradual",
      "blockingScope":"story","canContinue":true,"humanReview":{"humanNeed":"decision",
        "humanReason":"Choose the acceptable product rollout risk.",
        "handling":"Existing rollout guidance does not choose product risk tolerance.",
        "reviewerTabId":"tab-orchestrator"}}}]}

  To record workspace handling without human escalation, send humanReview with
  humanNeed "none", handling, and reviewerTabId. Review is a process assertion checked
  against server-owned configuration and the current binding; it is not authenticated
  orchestrator authorship. Reuse the item ID and report transitions, not unchanged issues.

  Update progress by supplying the current run revision, or update/resolve an attention item
  by supplying that item's current revision. Resolution requires the saved answer to have been
  acknowledged first. Event IDs are stable idempotency keys: identical retries replay; changed
  content under the same ID returns 409.

  Update an attention item:
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-question-update-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":1,"producerAt":1700000000002,"bindingGeneration":1,"type":"attention.updated","payload":{"itemId":"question-1","kind":"question","title":"Choose rollout","context":"Choose the production rollout strategy","storyIds":[],"options":[{"id":"gradual","label":"Gradual"}],"recommendation":"gradual","blockingScope":"story","canContinue":true}}]}'

  Resolve an acknowledged attention item:
  purplemux mission events -w WS --json '{"events":[{"eventId":"evt-question-resolve-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1","expectedRevision":2,"producerAt":1700000000004,"bindingGeneration":1,"type":"attention.resolved","payload":{"itemId":"question-1","resolution":"Applied the gradual rollout"}}]}'

  Acknowledge an answer:
  {"events":[{"eventId":"evt-ack-1","schemaVersion":1,"workspaceId":"WS","runId":"run-1",
    "expectedRevision":2,"producerAt":1700000000002,"bindingGeneration":1,"type":"answer.acknowledged",
    "payload":{"answerId":"ANSWER_ID"}}]}

  Orchestrator rebind (server-authored, never sent by a producer):
  A handoff, recovery or human replacement of the workspace orchestrator moves each open bound
  run to the new orchestrator's live identity: binding.generation and the run revision each
  increase by 1, and the run's event log gains one "run.rebound" event with payload
  { "cause": "handoff" | "recover" | "replace" | "heal", "previousBinding", "binding",
    "actor": "system:orchestration" }. "heal" is the same rebind applied at server start to a
  run whose bound tab left the workspace. Events from the previous generation then return 409
  (stale or unbound orchestrator generation). The new orchestrator reads its run ID, revision
  and binding generation with \`purplemux mission bootstrap -w WS\` or the snapshot, and uses
  them on its next event. The rebind waits until the new orchestrator's agent session is
  known; until then the run keeps its previous binding. Repeating the handoff or recovery for
  the orchestrator already in place changes no revision and re-asserts the binding of a run
  left on another tab; when the run is already bound it changes nothing. Answers not yet
  delivered follow the run to the new orchestrator; an answer whose paste was in flight stays
  held and is read with \`purplemux mission answers -w WS\`. An unbound provisional run is
  still bound by run.resumed.
  Clients must treat an event type they do not know as an opaque audit row.

CLI equivalents:
  purplemux mission snapshot -w WS
  purplemux mission bootstrap -w WS
  purplemux mission events -w WS --json '{"events":[...]}'
  purplemux mission answers -w WS [--run RUN] [--all]
  purplemux mission ack -w WS --run RUN --answer ANSWER --generation N --revision N --event-id EVENT --producer-at MS
  By default answers returns only current answered items whose delivery is not acknowledged,
  including the current item revision and run binding generation. --all includes history.
  Both forms forward humanInboxPolicy so ordinary turns can review pending legacy candidates.
  Reuse the exact event ID and producer timestamp after a lost response; changing either is a conflict.

## Web-browser tabs

These endpoints only work when the tab's panelType is "web-browser" and the webview
has attached (dom-ready has fired at least once). Electron runtime required;
503 is returned in headless/remote mode.

GET /api/cli/tabs/<tabId>/browser/url?workspaceId=WS
  Current URL + title of the webview.
  Response: { "tabId", "url", "title" }

GET /api/cli/tabs/<tabId>/browser/screenshot?workspaceId=WS[&full=1][&format=base64]
  PNG screenshot. Default returns image/png; format=base64 returns { base64 } JSON.
  full=1 captures beyond the viewport.

GET /api/cli/tabs/<tabId>/browser/console?workspaceId=WS[&since=MS][&level=LEVEL]
  Ring buffer (last 500 entries) of console messages, Log entries, and exceptions.
  Response: { "tabId", "entries": [{ "level", "text", "ts", "source"?, "url"?, "line"? }] }

GET /api/cli/tabs/<tabId>/browser/network?workspaceId=WS[&since=MS][&method=M][&url=SUBSTR][&status=CODE]
  Ring buffer (last 500 requests).
  Response: { "tabId", "entries": [{ "requestId", "method", "url", "status"?, "mimeType"?,
                                     "resourceType"?, "error"?, "ts", "endedAt"? }] }

GET /api/cli/tabs/<tabId>/browser/network?workspaceId=WS&requestId=RID
  Fetch response body for one request (cached after first call).
  Response: { "tabId", "requestId", "body" }

POST /api/cli/tabs/<tabId>/browser/eval?workspaceId=WS
  Body: { "expression": "..." }
  Evaluates the expression in the webview via CDP Runtime.evaluate
  (returnByValue, awaitPromise, 10s timeout).
  Response: { "tabId", "value" }
`;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Any valid CLI scope: the guide is documentation, and the agents that most
  // need it hold a workspace token, not the global one.
  if (!resolveCliScope(req, { response: res })) {
    return res.status(403).json({ error: 'Forbidden', code: 'forbidden' });
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  return res.status(200).send(GUIDE);
};

export default handler;
